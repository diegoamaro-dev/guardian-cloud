/**
 * Chunks service.
 *
 * Registers chunk metadata. Does NOT accept binary payloads — Phase 1 tracks
 * only metadata. Binary goes to the user's destination (Drive/NAS/S3) and the
 * client reports back here with hash, size and status.
 *
 * Correctness rules enforced here:
 *
 *   1. Session ownership:
 *      Session must exist AND belong to the authenticated user. "Doesn't
 *      exist" and "not yours" are collapsed into 404 SESSION_NOT_FOUND on
 *      purpose — we don't want an attacker to enumerate other users'
 *      session IDs by observing different error codes.
 *
 *   2. Session state:
 *      Chunks can only be registered while the session is `active`. If the
 *      session is `completed` or `failed` we reject with 409
 *      SESSION_NOT_ACTIVE. No grace window — a late chunk is a bug, not a
 *      feature. (Decision ratified with user.)
 *
 *   3. Idempotency (two layers):
 *        a) DB: UNIQUE(session_id, chunk_index) collapses duplicate writes
 *           into a single row regardless of what the app does.
 *        b) App: on unique-violation we re-read the existing row and
 *           reconcile. Same hash → treat as replay/update and return 200.
 *           Different hash → reject (content is immutable per index).
 *
 *   4. State transitions:
 *        - pending → uploaded : allowed
 *        - pending → failed   : allowed
 *        - failed  → pending  : allowed (retry)
 *        - failed  → uploaded : allowed (retry succeeded)
 *        - uploaded → anything: rejected. `uploaded` is terminal.
 *        - same → same        : treated as idempotent no-op (200).
 *
 * Supabase error code `23505` is the Postgres unique-violation SQLSTATE.
 */

import { AppError } from '../errors/AppError.js';
import { logger } from '../utils/logger.js';
import { supabase } from '../config/supabase.js';

export type ChunkStatus = 'pending' | 'uploaded' | 'failed';

export interface CreateChunkInput {
  session_id: string;
  chunk_index: number;
  hash: string;
  size: number;
  status: ChunkStatus;
  remote_reference?: string | null;
}

export interface ChunkRow {
  id: string;
  session_id: string;
  chunk_index: number;
  hash: string;
  size: number;
  status: ChunkStatus;
  remote_reference: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegisterChunkResult extends ChunkRow {
  idempotent_replay?: boolean;
}

interface SessionRow {
  id: string;
  user_id: string;
  status: 'active' | 'completed' | 'failed';
}

function isValidSha256(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}

function assertValidInput(input: CreateChunkInput): void {
  if (!input.session_id) {
    throw new AppError(400, 'INVALID_SESSION_ID', 'Invalid session id');
  }

  if (!Number.isInteger(input.chunk_index) || input.chunk_index < 0) {
    throw new AppError(400, 'INVALID_CHUNK_INDEX', 'Invalid chunk index');
  }

  if (!isValidSha256(input.hash)) {
    throw new AppError(400, 'INVALID_HASH', 'Invalid hash');
  }

  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > 20 * 1024 * 1024) {
    throw new AppError(400, 'INVALID_SIZE', 'Invalid size');
  }

  if (!['pending', 'uploaded', 'failed'].includes(input.status)) {
    throw new AppError(400, 'INVALID_STATUS', 'Invalid status');
  }
}

async function getOwnedSession(userId: string, sessionId: string): Promise<SessionRow> {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, user_id, status')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error(
      {
        op: 'getOwnedSession',
        userId,
        sessionId,
        supabase_error: {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      },
      'sessions.select failed',
    );

    throw new AppError(500, 'SESSION_LOOKUP_FAILED', 'Failed to lookup session');
  }

  if (!data) {
    throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
  }

  return data as SessionRow;
}

async function insertChunk(input: CreateChunkInput): Promise<ChunkRow> {
  const { data, error } = await supabase
    .from('chunks')
    .insert({
      session_id: input.session_id,
      chunk_index: input.chunk_index,
      hash: input.hash,
      size: input.size,
      status: input.status,
      remote_reference: input.remote_reference ?? null,
    })
    .select('*')
    .single();

  logger.info(
    {
      op: 'insertChunk',
      session_id: input.session_id,
      chunk_index: input.chunk_index,
      has_data: !!data,
      has_error: !!error,
    },
    'chunks.insert result',
  );

  if (error) {
    // 23505 = unique_violation on uniq_session_chunk. This is the EXPECTED
    // path when a client retries a chunk that was already registered (see
    // `createChunk` — it catches this and routes to the update path). Do
    // NOT log as error; that would turn every routine retry into a noisy
    // event and drown real DB failures. Use debug for observability.
    if ((error as { code?: string }).code === '23505') {
      logger.debug(
        {
          op: 'insertChunk',
          session_id: input.session_id,
          chunk_index: input.chunk_index,
        },
        'chunks.insert unique_violation (expected — retry will update)',
      );
    } else {
      logger.error(
        {
          op: 'insertChunk',
          session_id: input.session_id,
          chunk_index: input.chunk_index,
          supabase_error: {
            code: error.code,
            message: error.message,
            details: error.details,
            hint: error.hint,
          },
        },
        'chunks.insert failed',
      );
    }

    throw error;
  }

  if (!data) {
    throw new AppError(500, 'CHUNK_CREATE_FAILED', 'Insert returned null');
  }

  return data as ChunkRow;
}

async function readExistingChunk(sessionId: string, chunkIndex: number): Promise<ChunkRow> {
  const { data, error } = await supabase
    .from('chunks')
    .select('*')
    .eq('session_id', sessionId)
    .eq('chunk_index', chunkIndex)
    .single();

  if (error || !data) {
    logger.error(
      {
        op: 'readExistingChunk',
        session_id: sessionId,
        chunk_index: chunkIndex,
        supabase_error: error
          ? {
              code: error.code,
              message: error.message,
              details: error.details,
              hint: error.hint,
            }
          : null,
      },
      'chunks.select existing failed',
    );

    throw new AppError(500, 'CHUNK_READ_FAILED', 'Failed to read existing chunk');
  }

  return data as ChunkRow;
}

function canTransitionChunkStatus(current: ChunkStatus, next: ChunkStatus): boolean {
  if (current === 'uploaded') {
    return next === 'uploaded';
  }

  if (current === 'pending') {
    return next === 'pending' || next === 'failed' || next === 'uploaded';
  }

  if (current === 'failed') {
    return next === 'failed' || next === 'pending' || next === 'uploaded';
  }

  return false;
}

async function updateExistingChunk(
  existing: ChunkRow,
  input: CreateChunkInput,
): Promise<RegisterChunkResult> {
  if (existing.hash !== input.hash) {
    throw new AppError(409, 'CHUNK_HASH_MISMATCH', 'Hash mismatch');
  }

  if (!canTransitionChunkStatus(existing.status, input.status)) {
    throw new AppError(409, 'CHUNK_TERMINAL', 'Chunk is already terminal');
  }

  const nextRemoteReference = input.remote_reference ?? existing.remote_reference ?? null;

  const noChanges =
    existing.status === input.status &&
    existing.size === input.size &&
    existing.remote_reference === nextRemoteReference;

  if (noChanges) {
    return {
      ...existing,
      idempotent_replay: true,
    };
  }

  const { data, error } = await supabase
    .from('chunks')
    .update({
      status: input.status,
      size: input.size,
      remote_reference: nextRemoteReference,
    })
    .eq('id', existing.id)
    .select('*')
    .single();

  if (error || !data) {
    logger.error(
      {
        op: 'updateExistingChunk',
        chunk_id: existing.id,
        session_id: existing.session_id,
        chunk_index: existing.chunk_index,
        supabase_error: error
          ? {
              code: error.code,
              message: error.message,
              details: error.details,
              hint: error.hint,
            }
          : null,
      },
      'chunks.update failed',
    );

    throw new AppError(500, 'CHUNK_UPDATE_FAILED', 'Failed to update existing chunk');
  }

  return {
    ...(data as ChunkRow),
    idempotent_replay: false,
  };
}

export async function createChunk(input: CreateChunkInput): Promise<RegisterChunkResult> {
  try {
    const inserted = await insertChunk(input);
    return {
      ...inserted,
      idempotent_replay: false,
    };
  } catch (err) {
    const maybePgError = err as { code?: string };

    // unique(session_id, chunk_index) — a row for this identity already
    // exists. This is the retry/idempotency path; make it explicit and
    // observable at info level so operators can see it in logs without
    // having to grep for a raw SQLSTATE.
    if (maybePgError?.code === '23505') {
      logger.info(
        {
          op: 'createChunk',
          session_id: input.session_id,
          chunk_index: input.chunk_index,
        },
        'chunk already exists — routing to update path (retry)',
      );

      const existing = await readExistingChunk(input.session_id, input.chunk_index);
      return await updateExistingChunk(existing, input);
    }

    if (err instanceof AppError) {
      throw err;
    }

    logger.error(
      {
        op: 'createChunk',
        session_id: input.session_id,
        chunk_index: input.chunk_index,
        err,
      },
      'chunks.create unexpected failure',
    );

    throw new AppError(500, 'CHUNK_CREATE_FAILED', 'Failed to register chunk');
  }
}

export async function registerChunk(
  userId: string,
  input: CreateChunkInput,
): Promise<RegisterChunkResult> {
  assertValidInput(input);

  const session = await getOwnedSession(userId, input.session_id);

  if (session.status !== 'active') {
    throw new AppError(409, 'SESSION_NOT_ACTIVE', 'Session is not active');
  }

  return await createChunk(input);
}

export async function listChunksForSession(
  userId: string,
  sessionId: string,
): Promise<ChunkRow[]> {
  // Ownership check. Throws 404 SESSION_NOT_FOUND if the session doesn't
  // exist OR doesn't belong to the caller (collapsed on purpose).
  await getOwnedSession(userId, sessionId);

  const { data, error } = await supabase
    .from('chunks')
    .select('*')
    .eq('session_id', sessionId)
    .order('chunk_index', { ascending: true });

  if (error) {
    logger.error(
      {
        op: 'listChunksForSession',
        userId,
        sessionId,
        supabase_error: {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      },
      'chunks.select list failed',
    );

    throw new AppError(500, 'CHUNK_LIST_FAILED', 'Failed to list chunks');
  }

  return (data ?? []) as ChunkRow[];
}