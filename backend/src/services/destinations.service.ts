/**
 * Destinations service.
 *
 * Thin wrapper around the `destinations` table. Kept deliberately narrow:
 *   - get the current destination for a (user, type) pair
 *   - upsert one (OAuth connect or generic config save)
 *   - list destinations for a user
 *
 * Never returns `refresh_token` in public-facing payloads — the route
 * layer is responsible for picking the safe fields. Internal callers
 * (drive.service.ts) use `getDestinationWithSecretForUser` to reach the
 * refresh_token when minting access tokens.
 */

import { AppError } from '../errors/AppError.js';
import { logger } from '../utils/logger.js';
import { supabase } from '../config/supabase.js';

export type DestinationType = 'drive';
export type DestinationStatus = 'connected' | 'revoked' | 'error';

export interface DestinationRow {
  id: string;
  user_id: string;
  type: DestinationType;
  status: DestinationStatus;
  refresh_token: string | null;
  folder_id: string | null;
  account_email: string | null;
  created_at: string;
  updated_at: string;
}

/** Safe, client-facing projection (no secrets). */
export interface PublicDestination {
  id: string;
  type: DestinationType;
  status: DestinationStatus;
  folder_id: string | null;
  account_email: string | null;
  created_at: string;
  updated_at: string;
}

export function toPublic(row: DestinationRow): PublicDestination {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    folder_id: row.folder_id,
    account_email: row.account_email,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getDestinationForUser(
  userId: string,
  type: DestinationType,
): Promise<DestinationRow | null> {
  const { data, error } = await supabase
    .from('destinations')
    .select('*')
    .eq('user_id', userId)
    .eq('type', type)
    .maybeSingle();

  if (error) {
    logger.error(
      {
        op: 'getDestinationForUser',
        userId,
        type,
        supabase_error: {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      },
      'destinations.select failed',
    );
    throw new AppError(500, 'DESTINATION_LOOKUP_FAILED', 'Failed to lookup destination');
  }

  return (data as DestinationRow | null) ?? null;
}

/** Same as `getDestinationForUser` but for internal callers that need the
 *  refresh_token. Never expose the result of this to the client. */
export async function getDestinationWithSecretForUser(
  userId: string,
  type: DestinationType,
): Promise<DestinationRow | null> {
  return getDestinationForUser(userId, type);
}

export async function listDestinationsForUser(
  userId: string,
): Promise<PublicDestination[]> {
  const { data, error } = await supabase
    .from('destinations')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error(
      {
        op: 'listDestinationsForUser',
        userId,
        supabase_error: {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
        },
      },
      'destinations.list failed',
    );
    throw new AppError(500, 'DESTINATION_LIST_FAILED', 'Failed to list destinations');
  }

  return (data ?? []).map((r) => toPublic(r as DestinationRow));
}

export interface UpsertDestinationFields {
  status?: DestinationStatus;
  refresh_token?: string | null;
  folder_id?: string | null;
  account_email?: string | null;
}

/**
 * Insert or update the single row for (user_id, type). Because the table
 * has `UNIQUE(user_id, type)`, using Supabase `upsert` with `onConflict`
 * collapses retries into the same row deterministically. Fields not
 * passed stay as they were (we do a read-modify-write rather than
 * overwriting with nulls).
 */
export async function upsertDestination(
  userId: string,
  type: DestinationType,
  fields: UpsertDestinationFields,
): Promise<DestinationRow> {
  const existing = await getDestinationForUser(userId, type);

  const next = {
    user_id: userId,
    type,
    status: fields.status ?? existing?.status ?? 'connected',
    refresh_token:
      fields.refresh_token !== undefined
        ? fields.refresh_token
        : existing?.refresh_token ?? null,
    folder_id:
      fields.folder_id !== undefined
        ? fields.folder_id
        : existing?.folder_id ?? null,
    account_email:
      fields.account_email !== undefined
        ? fields.account_email
        : existing?.account_email ?? null,
  };

  const { data, error } = await supabase
    .from('destinations')
    .upsert(next, { onConflict: 'user_id,type' })
    .select('*')
    .single();

  if (error || !data) {
    logger.error(
      {
        op: 'upsertDestination',
        userId,
        type,
        supabase_error: error
          ? {
              code: error.code,
              message: error.message,
              details: error.details,
              hint: error.hint,
            }
          : null,
      },
      'destinations.upsert failed',
    );
    throw new AppError(500, 'DESTINATION_SAVE_FAILED', 'Failed to save destination');
  }

  return data as DestinationRow;
}
