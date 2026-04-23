/**
 * Sessions service.
 *
 * Thin wrapper around the Supabase client. Keeps SQL/query details out of
 * the route layer and gives us a single place to add logging/metrics later.
 *
 * Contract:
 *   - `createSession` always binds `user_id` to the authenticated caller.
 *     The route MUST pass the id from `req.user.id`, never from the body.
 */

import { AppError } from '../errors/AppError.js';
import { logger } from '../utils/logger.js';
import { supabase } from '../config/supabase.js';

export type SessionMode = 'audio' | 'video';
export type SessionStatus = 'active' | 'completed' | 'failed';

export interface CreateSessionInput {
  mode: SessionMode;
  destination_type: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  mode: SessionMode;
  destination_type: string;
  status: SessionStatus;
  chunk_count: number;
  created_at: string;
  completed_at: string | null;
  updated_at?: string;
}

export interface CompleteSessionResult {
  session_id: string;
  status: 'completed';
  completed_at: string;
  chunk_count: number;
}

/**
 * Hard cap on the Supabase REST insert. `@supabase/supabase-js` has no
 * built-in timeout, so an unreachable / paused PostgREST will hang forever.
 * This bounds it so we emit a deterministic REQ_DB_TIMEOUT log line and
 * return 500 to the client instead of letting the request dangle.
 */
const DB_TIMEOUT_MS = 8000;

export async function createSession(
  userId: string,
  input: CreateSessionInput,
  reqId?: string,
): Promise<SessionRow> {
  const startMs = Date.now();
  logger.info({ reqId, userId, op: 'createSession' }, 'REQ_DB_START');

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `supabase.sessions.insert timeout after ${DB_TIMEOUT_MS}ms (check backend host's outbound HTTPS to SUPABASE_URL / PostgREST)`,
          ),
        ),
      DB_TIMEOUT_MS,
    );
  });

  let result: Awaited<ReturnType<typeof runInsert>>;
  try {
    result = await Promise.race([runInsert(userId, input), timeoutPromise]);
  } catch (err) {
    const duration_ms = Date.now() - startMs;
    logger.error(
      {
        reqId,
        op: 'createSession',
        userId,
        duration_ms,
        reason: err instanceof Error ? err.message : String(err),
      },
      'REQ_DB_TIMEOUT',
    );
    throw new AppError(
      500,
      'SESSION_CREATE_FAILED',
      'Failed to create session',
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  const { data, error } = result;
  const duration_ms = Date.now() - startMs;

  if (error || !data) {
    logger.error(
      {
        reqId,
        op: 'createSession',
        userId,
        input,
        duration_ms,
        supabase_error: error
          ? {
              code: error.code,
              message: error.message,
              details: error.details,
              hint: error.hint,
            }
          : null,
      },
      'REQ_DB_FAIL',
    );

    throw new AppError(500, 'SESSION_CREATE_FAILED', 'Failed to create session');
  }

  logger.info(
    { reqId, userId, duration_ms, session_id: (data as SessionRow).id },
    'REQ_DB_OK',
  );
  return data as SessionRow;
}

function runInsert(userId: string, input: CreateSessionInput) {
  return supabase
    .from('sessions')
    .insert({
      user_id: userId,
      mode: input.mode,
      destination_type: input.destination_type,
      status: 'active',
    })
    .select('*')
    .single();
}

export async function getOwnedSession(
  userId: string,
  sessionId: string,
): Promise<SessionRow> {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
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

export async function completeSession(
  userId: string,
  sessionId: string,
): Promise<CompleteSessionResult> {
  const session = await getOwnedSession(userId, sessionId);

  if (session.status === 'completed') {
    throw new AppError(409, 'SESSION_ALREADY_COMPLETED', 'Session already completed');
  }

  if (session.status !== 'active') {
    throw new AppError(409, 'SESSION_NOT_ACTIVE', 'Session is not active');
  }

  const { count, error: countError } = await supabase
    .from('chunks')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId);

  if (countError) {
    logger.error(
      {
        op: 'completeSession.countChunks',
        userId,
        sessionId,
        supabase_error: {
          code: countError.code,
          message: countError.message,
          details: countError.details,
          hint: countError.hint,
        },
      },
      'chunks.count failed',
    );

    throw new AppError(500, 'SESSION_COMPLETE_FAILED', 'Failed to complete session');
  }

  const chunkCount = count ?? 0;
  const completedAt = new Date().toISOString();

  const { data, error } = await supabase
    .from('sessions')
    .update({
      status: 'completed',
      completed_at: completedAt,
      chunk_count: chunkCount,
    })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .select('*')
    .single();

  if (error || !data) {
    logger.error(
      {
        op: 'completeSession.update',
        userId,
        sessionId,
        chunkCount,
        supabase_error: error
          ? {
              code: error.code,
              message: error.message,
              details: error.details,
              hint: error.hint,
            }
          : null,
      },
      'sessions.update complete failed',
    );

    throw new AppError(500, 'SESSION_COMPLETE_FAILED', 'Failed to complete session');
  }

  return {
    session_id: data.id,
    status: 'completed',
    completed_at: data.completed_at,
    chunk_count: data.chunk_count,
  };
}