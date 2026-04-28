/**
 * Local session-history index.
 *
 * Why this module exists:
 *   The backend has no `GET /sessions` listing endpoint, and the
 *   in-flight queue (`test.pending_retry`) is reaped as soon as a
 *   session completes. So nothing on the device knows which sessions
 *   the user has created in the past — the History screen would have
 *   nothing to enumerate.
 *
 *   This module maintains a small append-only index in AsyncStorage
 *   keyed by `history.sessions`. The index stores only the IDENTIFYING
 *   metadata of each session (session_id, created_at, mode). The REAL
 *   per-session state (uploaded / total / failed counts) is fetched
 *   live via `listSessionChunks(sessionId)` from `./export.ts` — that
 *   stays the source of truth. The index is never used to fake status.
 *
 * Trade-offs (acknowledged, NOT ignored):
 *   - Reinstall / cache wipe → empty history. Backend still has the
 *     data; a future GET /sessions endpoint would enrich this.
 *   - Sessions created on a different device do not appear.
 *   - FIFO cap at MAX_HISTORY_ENTRIES so storage doesn't grow forever.
 *
 * This file deliberately does NOT touch:
 *   - the upload queue (PENDING_RETRY_KEY)
 *   - the recording / chunking pipeline
 *   - any backend endpoint
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { type ChunkMeta } from './export';

const HISTORY_KEY = 'history.sessions';
const MAX_HISTORY_ENTRIES = 50;

export type SessionMode = 'audio' | 'video';

export interface HistoryEntry {
  session_id: string;
  /** ISO-8601 timestamp captured client-side at append time. */
  created_at: string;
  mode: SessionMode;
}

/**
 * Append one entry to the front of the persisted history list. If the
 * same session_id is already present (e.g. retry scenarios), it is
 * dropped first so the new entry replaces it without duplication.
 *
 * Best-effort: any storage failure is logged and swallowed. The caller
 * (recording flow) MUST NOT have its state machine affected by a
 * history-write hiccup.
 */
export async function appendHistoryEntry(entry: HistoryEntry): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    let list: HistoryEntry[] = [];
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed as HistoryEntry[];
      } catch {
        // Corrupt JSON: start over rather than crash the recording flow.
        list = [];
      }
    }
    const deduped = list.filter((e) => e.session_id !== entry.session_id);
    const next = [entry, ...deduped].slice(0, MAX_HISTORY_ENTRIES);
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch (err) {
    // Swallow — never block recording on a side observation.
    // eslint-disable-next-line no-console
    console.log('HISTORY appendHistoryEntry failed', err);
  }
}

/**
 * Read the persisted index. Returns newest-first by insertion order
 * (same order as appended). Returns [] on any read/parse failure so
 * the History screen always renders something.
 */
export async function readHistory(): Promise<HistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as HistoryEntry[];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('HISTORY readHistory failed', err);
    return [];
  }
}

export type SessionStatus =
  | 'complete'
  | 'partial'
  | 'failed'
  | 'empty'
  | 'unknown';

export interface SessionStatusSummary {
  status: SessionStatus;
  total: number;
  uploaded: number;
  failed: number;
  driveCount: number;
}

/**
 * Apply the user-spec rules to a chunk list:
 *   COMPLETE — total > 0 && uploaded === total && no unresolved errors
 *   PARTIAL  — uploaded > 0 && uploaded < total
 *   FAILED   — total > 0 && uploaded === 0 (with or without `failed`)
 *   EMPTY    — backend returned an empty chunks array (total === 0)
 *   UNKNOWN  — chunks list could not be fetched at all (network/API
 *              error). Distinct from EMPTY: EMPTY is a confirmed-zero
 *              answer from the backend; UNKNOWN means we never got an
 *              answer at all. The UI must surface this difference so
 *              the user is not misled by a generic "Sin datos".
 *
 * "unresolved errors" = any chunk with status === 'failed' (permanent
 * failure recorded server-side). Pending/uploading do NOT count as
 * errors — they may still resolve. driveCount tells the UI how many
 * chunks have actually landed in Drive.
 */
export function deriveSessionStatus(
  chunks: ChunkMeta[] | null,
): SessionStatusSummary {
  if (chunks === null) {
    return {
      status: 'unknown',
      total: 0,
      uploaded: 0,
      failed: 0,
      driveCount: 0,
    };
  }
  const total = chunks.length;
  const uploaded = chunks.filter((c) => c.status === 'uploaded').length;
  const failed = chunks.filter((c) => c.status === 'failed').length;
  const driveCount = chunks.filter(
    (c) => c.status === 'uploaded' && !!c.remote_reference,
  ).length;

  let status: SessionStatus;
  if (total === 0) {
    // Backend explicitly returned []. Different semantics from a fetch
    // failure: the call succeeded, the answer is "no chunks recorded".
    status = 'empty';
  } else if (uploaded === total && failed === 0) {
    status = 'complete';
  } else if (uploaded === 0) {
    status = 'failed';
  } else {
    // 0 < uploaded < total, OR uploaded > 0 with some `failed` mixed in.
    status = 'partial';
  }

  return { status, total, uploaded, failed, driveCount };
}
