/**
 * /destinations routes.
 *
 * Implements the Phase 3 "integración inicial con Google Drive" slice.
 *
 * Endpoints (spec: API_SPEC.md §Destinos):
 *   POST /destinations/drive/connect
 *     Two-step body discriminated by `action`:
 *       - action=start    → returns { auth_url, state? }
 *       - action=exchange → exchanges the authorisation `code` for tokens,
 *                            creates the GuardianCloud folder in the user's
 *                            Drive, and upserts a `destinations` row.
 *   POST /destinations
 *     Generic save. Phase 1 only accepts `type: 'drive'` and only updates
 *     display-level fields (folder_id / account_email). The OAuth flow
 *     above is the authoritative path to obtain a refresh_token.
 *   GET /destinations
 *     Lists the caller's destinations (no secrets).
 *   POST /destinations/drive/test-upload
 *     Internal proof-of-plumbing route used by the Settings screen to
 *     validate end-to-end connectivity. Uploads a tiny "hello" text
 *     file into the GuardianCloud folder and returns the Drive file id
 *     — satisfying the MVP acceptance criterion: "subir al menos un
 *     archivo real". Safe: ownership gated by the JWT and rate-limited
 *     like any other destinations write.
 *
 * Middleware chain (order matters — mirrors /sessions and /chunks):
 *   authMiddleware          → populates req.user from JWT
 *   userRateLimiter(10|60)  → same budgets as sibling routes
 *   validateBody(schema)    → zod enforces shape (connect/upsert only)
 *
 * We never return `refresh_token` in any response. The service layer
 * projects to `PublicDestination` before it crosses the wire.
 */
import { env } from '../config/env.js';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';

import { AppError, UnauthorizedError } from '../errors/AppError.js';
import { authMiddleware } from '../middleware/auth.js';
import { userRateLimiter } from '../middleware/rateLimit.js';
import { validateBody } from '../middleware/validate.js';
import { supabase } from '../config/supabase.js';
import {
  driveConnectSchema,
  upsertDestinationSchema,
  type DriveConnectInput,
  type UpsertDestinationInput,
} from '../schemas/destinations.schema.js';
import {
  buildAuthUrl,
  ensureRootFolder,
  exchangeCodeForTokens,
  findFileByName,
  getAccessToken,
  getUserInfo,
  ROOT_FOLDER_NAME,
  uploadFile,
} from '../services/drive.service.js';
import {
  getDestinationForUser,
  getDestinationWithSecretForUser,
  listDestinationsForUser,
  toPublic,
  upsertDestination,
} from '../services/destinations.service.js';
import { getOwnedSession } from '../services/sessions.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /destinations — list the caller's destinations.
 */
router.get(
  '/',
  authMiddleware,
  userRateLimiter(60),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();
      const list = await listDestinationsForUser(req.user.id);
      res.status(200).json({ destinations: list });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /destinations — generic save (Phase 1: drive only).
 */
router.post(
  '/',
  authMiddleware,
  userRateLimiter(10),
  validateBody(upsertDestinationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const input = req.body as UpsertDestinationInput;

      const updated = await upsertDestination(req.user.id, input.type, {
        folder_id: input.config?.folder_id,
        account_email: input.config?.account_email,
      });

      res.status(200).json({ destination: toPublic(updated) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /destinations/drive/connect — two-step OAuth.
 *
 * Step 1 (action=start):
 *   Builds a Google consent URL with the narrow `drive.file` scope and
 *   returns it. The client opens this URL in a browser/custom tab.
 *
 * Step 2 (action=exchange):
 *   Accepts the `code` Google redirected back with, exchanges it for a
 *   refresh_token, ensures `/GuardianCloud` exists, and persists the
 *   destination row. Returns the public view of the destination.
 */
router.post(
  '/drive/connect',
  authMiddleware,
  userRateLimiter(10),
  validateBody(driveConnectSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const input = req.body as DriveConnectInput;

      if (input.action === 'start') {
  console.log('GC_DEBUG_REDIRECT_ENV', env.GOOGLE_REDIRECT_URI);
  console.log('GC_DEBUG_REDIRECT_INPUT', input.redirect_uri);

  const authUrl = buildAuthUrl(input.state, env.GOOGLE_REDIRECT_URI!);

  console.log('GC_DEBUG_AUTH_URL', authUrl);

  res.status(200).json({ auth_url: authUrl, state: input.state ?? null });
  return;
}
      // action === 'exchange'
const tokens = await exchangeCodeForTokens(
  input.code,
  env.GOOGLE_REDIRECT_URI!,
);

      // Without offline access + consent prompt we can't reliably get a
      // refresh_token — but the library asks for both. If Google still
      // returns nothing (e.g. a replayed code), fail cleanly.
      if (!tokens.refresh_token) {
        logger.warn(
          { op: 'drive.connect.exchange', userId: req.user.id },
          'Google returned no refresh_token (possible replay or missing offline consent)',
        );
        throw new AppError(
          400,
          'DRIVE_NO_REFRESH_TOKEN',
          'Google did not return a refresh token. Please reconnect from scratch.',
        );
      }

      const info = await getUserInfo(tokens.access_token);
      const folderId = await ensureRootFolder(tokens.access_token, ROOT_FOLDER_NAME);

      const saved = await upsertDestination(req.user.id, 'drive', {
        status: 'connected',
        refresh_token: tokens.refresh_token,
        folder_id: folderId,
        account_email: info.email ?? null,
      });

      res.status(200).json({ destination: toPublic(saved) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /destinations/drive/test-upload — one-shot proof-of-plumbing.
 *
 * Uploads a tiny text file to the user's `/GuardianCloud` folder. This
 * is the MVP acceptance handshake: after `connect`, the Settings screen
 * calls this and a real file appears in Drive. Not used on the recording
 * path; chunks.service.ts is untouched by this route.
 *
 * Body is intentionally empty — we generate a deterministic "hello"
 * payload server-side so the test is reproducible and the client needs
 * zero payload logic.
 */
router.post(
  '/drive/test-upload',
  authMiddleware,
  userRateLimiter(10),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const dest = await getDestinationWithSecretForUser(req.user.id, 'drive');
      if (!dest || !dest.refresh_token) {
        throw new AppError(
          409,
          'DRIVE_NOT_CONNECTED',
          'No connected Google Drive destination for this user',
        );
      }

      const accessToken = await getAccessToken(dest.refresh_token);

      // If the stored folder went missing (user deleted it by hand), we
      // transparently recreate it. Without this, the first test-upload
      // after such a deletion would fail — breaking the user's ability
      // to re-prove the connection.
      const folderId = dest.folder_id ?? (await ensureRootFolder(accessToken));
      if (!dest.folder_id) {
        await upsertDestination(req.user.id, 'drive', { folder_id: folderId });
      }

      const fileName = `guardian-cloud-test-${new Date()
        .toISOString()
        .replace(/[:.]/g, '-')}.txt`;
      const payload = Buffer.from(
        `Guardian Cloud test upload\nuser_id=${req.user.id}\nts=${new Date().toISOString()}\n`,
        'utf8',
      );

      const result = await uploadFile(
        accessToken,
        folderId,
        fileName,
        payload,
        'text/plain; charset=utf-8',
      );

      res.status(200).json({
        ok: true,
        remote_reference: result.file_id,
        file: result,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /destinations/drive/chunks — proxy upload of a single chunk's bytes
 * to the user's Google Drive `/GuardianCloud` folder.
 *
 * Why this exists (MVP, temporary):
 *   chunks.service.ts registers chunk METADATA only. Binary has to reach
 *   the user's destination. Rather than expose Drive access tokens to the
 *   client, the backend proxies the bytes. Refresh/access tokens never
 *   leave the server. This route does NOT become storage — it forwards
 *   and forgets. The authoritative chunk row is still created via
 *   POST /chunks, with `remote_reference` populated from this response.
 *
 * Contract:
 *   headers:
 *     Authorization:  Bearer <supabase-jwt>
 *     Content-Type:   application/octet-stream
 *     X-Session-Id:   uuid of an ACTIVE session owned by the caller
 *     X-Chunk-Index:  non-negative integer
 *     X-Hash:         lowercase hex sha256 of the body
 *   body: raw bytes (<= 25 MB)
 *
 * Response 200: { remote_reference: string, dedup: 'db' | 'drive' | null }
 *
 * Dedupe (two layers — both required to survive app-kill between Drive
 * upload and POST /chunks):
 *   1. DB layer: if a chunks row already exists for (session_id,
 *      chunk_index) with the same hash and a non-null remote_reference,
 *      return it. Handles: Drive upload succeeded → POST /chunks
 *      succeeded → client retried anyway.
 *   2. Drive layer: deterministic filename
 *        {session_id}_{NNNNNN}_{hash12}.chunk
 *      inside the user's /GuardianCloud folder. A files.list by exact
 *      name short-circuits an upload if the Drive file exists but the
 *      DB row does NOT. Handles: Drive upload succeeded → app killed
 *      before POST /chunks.
 *
 * We deliberately do NOT create or touch chunks rows here. That keeps
 * chunks.service.ts completely untouched; POST /chunks remains the only
 * writer of that table.
 *
 * Integrity guardrail: we recompute sha256 of the raw body and compare
 * against X-Hash. Mismatch → 400 without touching Drive. This blocks a
 * buggy client from persisting a chunks row whose remote_reference
 * points at a file whose bytes differ from the declared hash.
 */
const RAW_CHUNK_LIMIT_BYTES = 25 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[a-f0-9]{64}$/;

/**
 * Read-only helper: look up the remote_reference for an existing chunk
 * row, but ONLY if its hash matches `hash`. A different hash for the
 * same (session_id, chunk_index) is a client bug (content is immutable
 * per index) — we surface it downstream via POST /chunks, not here. A
 * null remote_reference means "metadata exists but bytes aren't in
 * Drive yet" → we re-upload.
 *
 * Note: this reads the `chunks` table directly instead of going through
 * chunks.service.ts, to honour the rule that chunks.service remains
 * untouched by this MVP addition.
 */
async function findExistingChunkRemoteReference(
  sessionId: string,
  chunkIndex: number,
  hash: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('chunks')
    .select('hash, remote_reference')
    .eq('session_id', sessionId)
    .eq('chunk_index', chunkIndex)
    .maybeSingle();

  if (error) {
    logger.error(
      {
        op: 'findExistingChunkRemoteReference',
        sessionId,
        chunkIndex,
        supabase_error: {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      },
      'chunks.select for dedup failed',
    );
    throw new AppError(500, 'CHUNK_LOOKUP_FAILED', 'Failed to lookup existing chunk');
  }
  if (!data) return null;
  const row = data as { hash: string; remote_reference: string | null };
  if (row.hash !== hash) return null;
  if (!row.remote_reference) return null;
  return row.remote_reference;
}

router.post(
  '/drive/chunks',
  authMiddleware,
  userRateLimiter(600),
  // Body parser is LOCAL to this route: the global express.json cap of
  // 64kb would reject real chunk bodies, and raw() only fires when the
  // Content-Type matches — so JSON routes remain unaffected.
  express.raw({ limit: RAW_CHUNK_LIMIT_BYTES, type: 'application/octet-stream' }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      // --- 1) Headers
      const sessionId = (req.header('x-session-id') ?? '').trim();
      const chunkIndexRaw = (req.header('x-chunk-index') ?? '').trim();
      const hash = (req.header('x-hash') ?? '').trim().toLowerCase();

      if (!UUID_RE.test(sessionId)) {
        throw new AppError(400, 'INVALID_HEADERS', 'X-Session-Id missing or not a UUID');
      }
      const chunkIndex = Number.parseInt(chunkIndexRaw, 10);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        throw new AppError(400, 'INVALID_HEADERS', 'X-Chunk-Index missing or invalid');
      }
      if (!HEX64_RE.test(hash)) {
        throw new AppError(400, 'INVALID_HEADERS', 'X-Hash missing or invalid');
      }

      // --- 2) Body
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new AppError(
          400,
          'EMPTY_BODY',
          'Empty or non-binary body (Content-Type must be application/octet-stream)',
        );
      }
      if (body.length > RAW_CHUNK_LIMIT_BYTES) {
        throw new AppError(413, 'BODY_TOO_LARGE', 'Chunk body exceeds size limit');
      }

      // --- 3) Integrity guardrail — body must match the claimed hash.
      const actualHash = createHash('sha256').update(body).digest('hex');
      if (actualHash !== hash) {
        logger.warn(
          {
            op: 'drive.chunks.upload',
            sessionId,
            chunkIndex,
            claimed: hash,
            actual: actualHash,
            size: body.length,
          },
          'X-Hash does not match body sha256',
        );
        throw new AppError(400, 'HASH_MISMATCH', 'Body sha256 does not match X-Hash');
      }

      // --- 4) Session ownership + active state.
      // Mirrors chunks.service: collapse "not yours" and "doesn't exist"
      // into 404 so we don't leak which UUIDs belong to other users.
      const session = await getOwnedSession(req.user.id, sessionId);
      if (session.status !== 'active') {
        throw new AppError(409, 'SESSION_NOT_ACTIVE', 'Session is not active');
      }

      // --- 5) Layer 1 dedupe — DB already has the chunk row.
      const existingRef = await findExistingChunkRemoteReference(
        sessionId,
        chunkIndex,
        hash,
      );
      if (existingRef) {
        logger.info(
          { op: 'drive.chunks.upload', sessionId, chunkIndex, dedup: 'db' },
          'chunk dedup via DB row',
        );
        res.status(200).json({ remote_reference: existingRef, dedup: 'db' });
        return;
      }

      // --- 6) Drive handshake.
      const dest = await getDestinationWithSecretForUser(req.user.id, 'drive');
      if (!dest || !dest.refresh_token) {
        throw new AppError(
          409,
          'DRIVE_NOT_CONNECTED',
          'No connected Google Drive destination for this user',
        );
      }

      const accessToken = await getAccessToken(dest.refresh_token);

      // Self-heal: if the stored folder is missing (user deleted it by
      // hand), recreate and persist. Same pattern as /drive/test-upload.
      const folderId = dest.folder_id ?? (await ensureRootFolder(accessToken));
      if (!dest.folder_id) {
        await upsertDestination(req.user.id, 'drive', { folder_id: folderId });
      }

      // --- 7) Deterministic filename — part of the idempotency contract.
      // Full path in Drive: /GuardianCloud/{session_id}_{NNNNNN}_{hash12}.chunk
      const paddedIndex = String(chunkIndex).padStart(6, '0');
      const shortHash = hash.slice(0, 12);
      const fileName = `${sessionId}_${paddedIndex}_${shortHash}.chunk`;

      // --- 8) Layer 2 dedupe — same filename already exists in Drive.
      const existingInDrive = await findFileByName(accessToken, folderId, fileName);
      if (existingInDrive) {
        logger.info(
          { op: 'drive.chunks.upload', sessionId, chunkIndex, dedup: 'drive' },
          'chunk dedup via Drive name',
        );
        res.status(200).json({ remote_reference: existingInDrive, dedup: 'drive' });
        return;
      }

      // --- 9) Actual upload.
      const result = await uploadFile(
        accessToken,
        folderId,
        fileName,
        body,
        'application/octet-stream',
      );

      logger.info(
        {
          op: 'drive.chunks.upload',
          sessionId,
          chunkIndex,
          size: body.length,
          file_id: result.file_id,
        },
        'chunk uploaded to Drive',
      );

      res.status(200).json({ remote_reference: result.file_id, dedup: null });
    } catch (err) {
      next(err);
    }
  },
);

// Defensive 404 for sibling drive sub-routes we haven't built yet, so a
// typo on the client doesn't cascade into the generic 404 middleware
// with misleading wording.
router.all('/drive/:rest', (req: Request, _res: Response, next: NextFunction) => {
  next(new AppError(404, 'NOT_FOUND', `No such drive route: ${req.params.rest}`));
});

// Swallow unexpected zod misuse at the router level rather than bubble
// a vague 500 up to the global handler. This only triggers if a caller
// sends a body that typechecks against neither start nor exchange AND
// bypasses validateBody (should be unreachable).
router.use(
  (err: unknown, _req: Request, _res: Response, next: NextFunction) => {
    if (err instanceof z.ZodError) {
      next(new AppError(400, 'INVALID_BODY', err.issues[0]?.message ?? 'Invalid body'));
      return;
    }
    next(err);
  },
);

/**
 * GET /auth/drive/callback — Google OAuth redirect landing page.
 *
 * Google redirects the user's browser here after they accept the Drive
 * consent screen. The backend's only job is to hand the `code` + `state`
 * pair back to the mobile app via a custom-scheme deep link; the actual
 * token exchange is still driven by the mobile client calling
 * POST /destinations/drive/connect {action:'exchange'} with that code.
 *
 * Lives in the same file as /drive/connect so the OAuth-related
 * handlers stay co-located. Exported as its own Router (not mounted on
 * `router` above) because Google's registered redirect_uri is
 * `/auth/drive/callback` at the ROOT of the backend, not under the
 * `/destinations` mount prefix where /drive/connect lives. Mounted at
 * `/` from app.ts.
 */
const oauthCallbackRouter = Router();

oauthCallbackRouter.get('/auth/drive/callback', (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';

  if (!code) {
    res.status(400).send('Missing OAuth code');
    return;
  }

  const deepLink =
    `guardiancloud://oauth/drive?code=${encodeURIComponent(code)}` +
    `&state=${encodeURIComponent(state)}`;

  res.status(200).send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="font-family: -apple-system, Roboto, sans-serif; padding: 24px; text-align: center;">
        <script>
          window.location.href = "${deepLink}";
        </script>
        <p>Abriendo Guardian Cloud&hellip;</p>
        <p style="font-size: 14px; color: #555;">Si no se abre automáticamente, pulsa el enlace:</p>
        <p>
          <a href="${deepLink}" style="font-size: 16px; font-weight: 600;">Abrir Guardian Cloud</a>
        </p>
      </body>
    </html>
  `);
});

// re-export for app.ts
export { router as destinationsRouter, oauthCallbackRouter };

// One-shot helper the Settings screen MAY use indirectly via GET /destinations
// to check whether the current user has a connected Drive destination.
// Kept here so the routes file is the single place that imports both the
// Supabase service and the Google Drive service.
export { getDestinationForUser };
