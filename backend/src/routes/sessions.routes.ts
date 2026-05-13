/**
 * POST /sessions
 *
 * Creates a recording session for the authenticated user.
 *
 * Middleware chain (order matters):
 *   authMiddleware         → populates req.user from JWT
 *   userRateLimiter(10)    → 10 req/min per user_id
 *   validateBody(schema)   → zod schema enforces request shape
 *   handler                → calls the service, shapes the response
 *
 * `user_id` is taken from the JWT, never from the body.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError, UnauthorizedError } from '../errors/AppError.js';
import { authMiddleware } from '../middleware/auth.js';
import { userRateLimiter } from '../middleware/rateLimit.js';
import { validateBody } from '../middleware/validate.js';
import {
  createSessionSchema,
  type CreateSessionInput,
} from '../schemas/sessions.schema.js';
import {
  createSession,
  completeSession,
  getOwnedSession,
  type SessionRow,
} from '../services/sessions.service.js';
import { listChunksForSession } from '../services/chunks.service.js';
import { getDestinationWithSecretForUser } from '../services/destinations.service.js';
import { downloadFile, withDriveRetry } from '../services/drive.service.js';
import { downloadChunk as webdavDownloadChunk } from '../adapters/webdav.adapter.js';
import { tryGenerateManifest } from '../services/manifest.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.post(
  '/',
  authMiddleware,
  userRateLimiter(10),
  validateBody(createSessionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    const reqId = req.reqId;
    try {
      if (!req.user) throw new UnauthorizedError();

      logger.info({ reqId, userId: req.user.id }, 'REQ_HANDLER_START');
      const input = req.body as CreateSessionInput;
      const session = await createSession(req.user.id, input, reqId);

      res.status(201).json({
        session_id: session.id,
        status: session.status,
        mode: session.mode,
        destination_type: session.destination_type,
        created_at: session.created_at,
      });
      logger.info(
        { reqId, session_id: session.id, status: 201 },
        'REQ_RESPONSE_SENT',
      );
    } catch (err) {
      logger.error(
        { reqId, err: err instanceof Error ? err.message : String(err) },
        'REQ_HANDLER_ERROR',
      );
      next(err);
    }
  },
);

router.get(
  '/:id',
  authMiddleware,
  userRateLimiter(60),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const sessionId = req.params.id as string;
      const session = await getOwnedSession(req.user.id, sessionId);

      res.status(200).json({
        session_id: session.id,
        status: session.status,
        mode: session.mode,
        destination_type: session.destination_type,
        chunk_count: session.chunk_count,
        created_at: session.created_at,
        completed_at: session.completed_at,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/:id/chunks',
  authMiddleware,
  userRateLimiter(60),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const sessionId = req.params.id as string;
      const chunks = await listChunksForSession(req.user.id, sessionId);

      res.status(200).json({ chunks });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:id/complete',
  authMiddleware,
  userRateLimiter(10),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const sessionId = req.params.id as string;

      const result = await completeSession(req.user.id, sessionId);

      // Best-effort cross-device manifest. `tryGenerateManifest` never
      // throws — the defensive try/catch here is a seatbelt against a
      // future bug in the service. Whatever happens inside, the client
      // gets the same 200 OK + completion payload it received before
      // this line existed. See `services/manifest.service.ts`.
      try {
        await tryGenerateManifest(req.user.id, sessionId, result);
      } catch (err) {
        logger.warn(
          {
            op: 'manifest.generate',
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          },
          'GC_MANIFEST_UNEXPECTED_THROW',
        );
      }

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /sessions/:id/chunks/:index/download
 *
 * Streams the bytes of a single uploaded chunk back to the caller. This
 * is the read-side counterpart of the upload pipeline (POST
 * /destinations/drive/chunks): the client never gets a Drive access
 * token, the backend proxies the download.
 *
 * Steps:
 *   1. Ownership: `listChunksForSession` already enforces it (collapsed
 *      404 if the session does not belong to the caller).
 *   2. Look up the chunk row by chunk_index in the returned list.
 *      Reusing the existing service avoids touching chunks.service.ts.
 *   3. Require status='uploaded' AND a non-null remote_reference. Any
 *      other state means the bytes were never persisted to Drive.
 *   4. Resolve the user's Drive destination + mint a fresh access_token
 *      via `getAccessToken(refresh_token)` (refresh handled inside).
 *   5. `downloadFile` fetches the bytes from Drive.
 *   6. Stream raw bytes back with Content-Type=application/octet-stream
 *      and X-Chunk-Hash so the client can verify sha256 locally.
 *
 * The response shape matches what the export client in
 * mobile/src/api/export.ts already expects (see `downloadChunk` there).
 * No content negotiation, no JSON envelope.
 */

/**
 * Reproduce the deterministic upload-side path so we can verify, at
 * download time, that a NAS chunk's `remote_reference` still belongs to
 * the user's CURRENTLY-connected NAS.
 *
 * Source of truth for the format: `webdav.adapter.ts:uploadChunk`
 *   const url = `${dirSession}/${chunkIndex}.chunk`;
 *   dirSession = `${base}/GuardianCloud/${sessionId}`
 *   base       = `${host}${basePath}` (basePath optional, trailing `/`
 *                  stripped on both)
 *
 * If a row's `remote_reference` does not begin with this exact prefix
 * for the connected destination, refuse the download. That's the SSRF
 * mitigation: we never fetch a URL outside the user's own NAS even if
 * a row in `chunks` was tampered with.
 *
 * Trailing slash included so `prefix.startsWith` cannot be satisfied by
 * a same-prefix-but-different-session URL.
 */
function buildExpectedNasPrefix(
  dest: { webdav_url: string | null; webdav_base_path: string | null },
  sessionId: string,
): string {
  // Caller MUST have already verified `webdav_url` is non-null (the
  // route does this check before calling). The defensive `?? ''` keeps
  // the function total: if some future caller forgets the check the
  // result will be `/GuardianCloud/<id>/` which can never match a real
  // remote_reference, so the prefix check would still refuse the
  // download — fail-closed by construction.
  const host = (dest.webdav_url ?? '').replace(/\/$/, '');
  const base = dest.webdav_base_path
    ? `${host}${dest.webdav_base_path.replace(/\/$/, '')}`
    : host;
  return `${base}/GuardianCloud/${sessionId}/`;
}

/**
 * Defensive log helper: extract just the origin (scheme://host[:port])
 * from a URL string. Used in `NAS_REF_PREFIX_MISMATCH` warnings so the
 * operator can see WHERE a tampered reference points without dumping
 * the full path. Falls back to '<unparseable>' on parse failure rather
 * than throwing — logging must never break a request handler.
 */
function safeOriginOf(maybeUrl: string): string {
  try {
    return new URL(maybeUrl).origin;
  } catch {
    return '<unparseable>';
  }
}

router.get(
  '/:id/chunks/:index/download',
  authMiddleware,
  userRateLimiter(60),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const sessionId = req.params.id as string;
      const indexRaw = req.params.index as string;
      const chunkIndex = Number.parseInt(indexRaw, 10);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        throw new AppError(400, 'INVALID_CHUNK_INDEX', 'Invalid chunk index');
      }

      // Ownership + chunk metadata in one call. `listChunksForSession`
      // throws 404 SESSION_NOT_FOUND on either "not yours" or "doesn't
      // exist" — same collapsed semantics as the rest of the API.
      const chunks = await listChunksForSession(req.user.id, sessionId);
      const chunk = chunks.find((c) => c.chunk_index === chunkIndex);
      if (!chunk) {
        throw new AppError(404, 'CHUNK_NOT_FOUND', 'Chunk not found');
      }
      if (chunk.status !== 'uploaded' || !chunk.remote_reference) {
        throw new AppError(
          409,
          'CHUNK_NOT_UPLOADED',
          'Chunk is not in uploaded state or has no remote reference',
        );
      }

      // Per-session destination is the canonical source of truth for
      // WHICH backend proxy to use. We do an extra row read here (one
      // .select on `sessions`) rather than encoding the decision in the
      // chunk row, because:
      //   - chunks.remote_reference is opaque ("Drive file id" vs
      //     "WebDAV URL"); inferring the storage type from its shape
      //     would be fragile.
      //   - sessions.destination_type is set at GRABAR time (see the
      //     mobile pinning fix) so it always matches where this
      //     session's chunks were physically uploaded.
      // `getOwnedSession` re-runs the ownership check; cheap and
      // defensive even though `listChunksForSession` already did it.
      const session: SessionRow = await getOwnedSession(req.user.id, sessionId);

      let bytes: Buffer;
      if (session.destination_type === 'nas') {
        // === NAS branch (WebDAV proxy) ===
        const dest = await getDestinationWithSecretForUser(req.user.id, 'nas');
        if (
          !dest ||
          dest.status !== 'connected' ||
          !dest.webdav_url ||
          !dest.webdav_username ||
          !dest.webdav_password_encrypted
        ) {
          throw new AppError(
            409,
            'NAS_NOT_CONNECTED',
            'No connected NAS destination for this user',
          );
        }

        // SSRF / DB-tampering guard. The upload adapter constructed
        // remote_reference deterministically as
        //   `${host}${basePath}/GuardianCloud/${sessionId}/{idx}.chunk`
        // (see webdav.adapter.ts: ROOT_DIR + dirSession + url). If the
        // current value does NOT begin with that prefix — derived live
        // from the user's CURRENTLY-connected NAS — the row is either
        // tampered with or points at a NAS the user has since
        // disconnected. Either way: refuse rather than blindly fetch
        // an arbitrary URL with the user's NAS credentials.
        const expectedPrefix = buildExpectedNasPrefix(dest, sessionId);
        if (!chunk.remote_reference.startsWith(expectedPrefix)) {
          logger.warn(
            {
              op: 'sessions.chunks.download',
              session_id: sessionId,
              chunk_index: chunkIndex,
              expected_prefix: expectedPrefix,
              // Log the host portion of the reference only — never the
              // full URL with any auth-bearing query (we don't use auth
              // in URLs, but be conservative).
              ref_origin: safeOriginOf(chunk.remote_reference),
              reason: 'remote_reference_outside_expected_nas_base',
            },
            'NAS_REF_PREFIX_MISMATCH',
          );
          throw new AppError(
            409,
            'NAS_REF_PREFIX_MISMATCH',
            'NAS chunk reference does not match the user\'s connected NAS',
          );
        }

        const result = await webdavDownloadChunk({
          url: chunk.remote_reference,
          destination: {
            username: dest.webdav_username,
            encryptedPassword: dest.webdav_password_encrypted,
          },
        });
        bytes = result.bytes;
      } else {
        // === Drive branch (legacy + 'drive'; behaviour byte-identical
        // to the pre-NAS-export version of this handler) ===
        const dest = await getDestinationWithSecretForUser(req.user.id, 'drive');
        if (!dest || !dest.refresh_token) {
          throw new AppError(
            409,
            'DRIVE_NOT_CONNECTED',
            'No connected Google Drive destination for this user',
          );
        }
        // Capture into a local so TypeScript keeps the non-null narrowing
        // from the `!chunk.remote_reference` guard above through the
        // closure (object-property narrowing is not preserved across an
        // async arrow body).
        const remoteReference = chunk.remote_reference;
        // Token via cache, plus a single retry-after-401 in case the
        // cached access_token has been invalidated server-side. Same
        // semantics as POST /destinations/drive/chunks; behaviour
        // outside the rare 401 case is byte-identical to the previous
        // uncached path.
        bytes = await withDriveRetry(dest.refresh_token, async (accessToken) =>
          downloadFile(accessToken, remoteReference),
        );
      }

      logger.info(
        {
          op: 'sessions.chunks.download',
          session_id: sessionId,
          chunk_index: chunkIndex,
          destination_type: session.destination_type,
          size: bytes.length,
        },
        'chunk download served',
      );

      res.status(200);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Chunk-Hash', chunk.hash);
      res.setHeader('Content-Length', bytes.length.toString());
      res.end(bytes);
    } catch (err) {
      next(err);
    }
  },
);

export { router as sessionsRouter };