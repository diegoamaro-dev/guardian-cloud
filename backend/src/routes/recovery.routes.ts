/**
 * GET /recovery/manifests
 *
 * Cross-device discovery endpoint. Lists session manifests this app
 * uploaded to the authenticated user's Google Drive and returns a
 * UI-friendly projection. Reconstruction / export from manifest is a
 * separate concern (COMMIT 3).
 *
 * Middleware chain:
 *   authMiddleware       — populates req.user from JWT
 *   userRateLimiter(10)  — bounded; discovery is on-demand, not a hot path
 *   handler              — delegates to `listDriveManifests`
 *
 * Failure shape:
 *   The endpoint NEVER returns 4xx/5xx for "Drive not connected" — the
 *   service surfaces that as `drive_not_connected: true` so the mobile
 *   UI can render a guided empty state instead of an error toast.
 *
 * Isolation: zero coupling to GC_QUEUE, the upload worker, chunking,
 * recovery, export, background service, AudioEngine, sessions/chunks
 * services, or anything mobile-side.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';

import { AppError, UnauthorizedError } from '../errors/AppError.js';
import { authMiddleware } from '../middleware/auth.js';
import { userRateLimiter } from '../middleware/rateLimit.js';
import {
  downloadManifestChunk,
  getManifestByFileId,
  listDriveManifests,
} from '../services/recovery.service.js';

const router = Router();

router.get(
  '/manifests',
  authMiddleware,
  userRateLimiter(10),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();
      const result = await listDriveManifests(req.user.id);
      res.status(200).json(result);
    } catch (err) {
      // `listDriveManifests` is documented as never-throwing, but the
      // route stays defensive: any unexpected throw goes through the
      // standard error pipeline (uniform error shape, no leak of
      // service-layer internals to the client).
      next(err);
    }
  },
);

/**
 * Drive `file_id` shape: alphanumeric plus `-` and `_`, typically ~33
 * chars. Reject anything else BEFORE touching Drive so a malformed URL
 * cannot be used as a probe / SSRF vector. The route layer is the only
 * place that sees the raw URL segment — the service then trusts it.
 */
const DRIVE_FILE_ID_REGEX = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * GET /recovery/manifests/:manifest_file_id
 *
 * Returns the full manifest (including chunks[]) the discovery endpoint
 * surfaced as `manifest_file_id`. Used by the mobile recovery export
 * screen to enumerate chunks before driving downloads.
 *
 * Errors:
 *   400 INVALID_MANIFEST_FILE_ID   — URL shape rejected upfront
 *   503 DRIVE_NOT_CONNECTED        — user has no connected Drive
 *   404 MANIFEST_NOT_FOUND         — Drive deleted the file
 *   404 MANIFEST_INVALID           — schema check failed / corrupt JSON
 *   502 DRIVE_API_FAILED           — anything else from Drive
 */
router.get(
  '/manifests/:manifest_file_id',
  authMiddleware,
  userRateLimiter(20),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();
      const manifestFileId = req.params.manifest_file_id ?? '';
      if (!DRIVE_FILE_ID_REGEX.test(manifestFileId)) {
        throw new AppError(
          400,
          'INVALID_MANIFEST_FILE_ID',
          'Invalid manifest file id',
        );
      }
      const manifest = await getManifestByFileId(req.user.id, manifestFileId);
      res.status(200).json(manifest);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /recovery/chunks/:manifest_file_id/:chunk_index/download
 *
 * Streams the bytes of one chunk referenced by a manifest. The client
 * reads sha256 from `X-Chunk-Hash` and recomputes locally — identical
 * verification model to `/sessions/:id/chunks/:idx/download`.
 *
 * Errors:
 *   400 INVALID_MANIFEST_FILE_ID
 *   400 INVALID_CHUNK_INDEX
 *   503 DRIVE_NOT_CONNECTED
 *   404 MANIFEST_NOT_FOUND
 *   404 MANIFEST_INVALID
 *   404 CHUNK_INDEX_NOT_IN_MANIFEST
 *   404 CHUNK_FILE_NOT_FOUND
 *   502 DRIVE_API_FAILED
 */
router.get(
  '/chunks/:manifest_file_id/:chunk_index/download',
  authMiddleware,
  userRateLimiter(60),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const manifestFileId = req.params.manifest_file_id ?? '';
      if (!DRIVE_FILE_ID_REGEX.test(manifestFileId)) {
        throw new AppError(
          400,
          'INVALID_MANIFEST_FILE_ID',
          'Invalid manifest file id',
        );
      }

      const chunkIndexRaw = req.params.chunk_index ?? '';
      const chunkIndex = Number.parseInt(chunkIndexRaw, 10);
      if (
        !Number.isInteger(chunkIndex) ||
        chunkIndex < 0 ||
        String(chunkIndex) !== chunkIndexRaw
      ) {
        throw new AppError(
          400,
          'INVALID_CHUNK_INDEX',
          'Invalid chunk index',
        );
      }

      const { bytes, hash } = await downloadManifestChunk(
        req.user.id,
        manifestFileId,
        chunkIndex,
      );

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', bytes.length.toString());
      res.setHeader('X-Chunk-Hash', hash);
      // Cache-Control: chunks are immutable bytes addressable by
      // file_name; the same `file_id` always returns the same bytes
      // until the user deletes the file in Drive. Short max-age is
      // safe and helps if the client retries mid-export.
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.status(200).send(bytes);
    } catch (err) {
      next(err);
    }
  },
);

export { router as recoveryRouter };
