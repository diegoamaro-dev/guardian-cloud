/**
 * History screen.
 *
 * Lists past sessions the user has created on this device. Source of
 * the LIST: local index in AsyncStorage (see src/api/history.ts) — the
 * backend has no GET /sessions endpoint and the upload queue is reaped
 * on completion, so a client-side index is the only enumeration source.
 *
 * Source of per-row STATUS: live `GET /sessions/:id/chunks` per row.
 * No optimistic counters; if the chunks request fails, the row shows
 * status='unknown' rather than guessing.
 *
 * The screen is read-only. Tapping a row navigates to the existing
 * session detail at `/session/[id]` for export. No mutation of any
 * recording / queue / Drive state happens here.
 */

import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';

import { listSessionChunks } from '@/api/export';
import {
  type HistoryEntry,
  type SessionStatusSummary,
  deriveSessionStatus,
  readHistory,
} from '@/api/history';

interface Row {
  entry: HistoryEntry;
  /** null = still loading; summary = resolved (incl. 'unknown' on fetch fail). */
  summary: SessionStatusSummary | null;
}

function formatTimestamp(iso: string): string {
  // dd MMM YYYY · HH:mm in local time. Falls back to the raw string if
  // the input cannot be parsed (defensive — index entries should always
  // be valid ISO).
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const datePart = d.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const timePart = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${datePart} · ${timePart}`;
}

function statusBadge(summary: SessionStatusSummary | null): {
  label: string;
  color: string;
  bg: string;
} {
  // null = the chunks fetch hasn't started/finished yet for this row.
  // Distinct from `status === 'unknown'` (fetch finished but failed)
  // and from `status === 'empty'` (fetch succeeded with []).
  if (summary === null) {
    return { label: 'Cargando…', color: '#8b949e', bg: '#161b22' };
  }
  switch (summary.status) {
    case 'complete':
      return { label: 'Completa', color: '#56d364', bg: '#0a2a14' };
    case 'partial':
      return { label: 'Parcial', color: '#e3b341', bg: '#2d1f06' };
    case 'failed':
      return { label: 'Fallida', color: '#f85149', bg: '#2d0d12' };
    case 'empty':
      return { label: 'Sin chunks', color: '#8b949e', bg: '#161b22' };
    case 'unknown':
      return { label: 'Error de conexión', color: '#f85149', bg: '#2d0d12' };
  }
}

export default function HistoryScreen() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    const entries = await readHistory();
    // Initialise with `summary: null` so the FlatList renders
    // immediately with a "Cargando…" state per row instead of a blank
    // screen while we fetch.
    const initial: Row[] = entries.map((entry) => ({ entry, summary: null }));
    setRows(initial);

    // Fetch each row's real status in parallel. If any single fetch
    // fails, that row gets summary={status:'unknown'} via deriveSessionStatus(null).
    // We never throw out of this map — partial UI is better than no UI.
    const results = await Promise.all(
      entries.map(async (entry) => {
        try {
          const chunks = await listSessionChunks(entry.session_id);
          return { entry, summary: deriveSessionStatus(chunks) };
        } catch {
          return { entry, summary: deriveSessionStatus(null) };
        }
      }),
    );
    setRows(results);
  }

  useEffect(() => {
    load();
  }, []);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#0d1117', padding: 16 }}>
      <Text
        style={{
          color: '#c9d1d9',
          fontSize: 22,
          fontWeight: '700',
          marginBottom: 16,
        }}
      >
        Historial
      </Text>

      {rows === null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <ActivityIndicator color="#c9d1d9" />
          <Text style={{ color: '#c9d1d9', marginLeft: 10 }}>Cargando…</Text>
        </View>
      ) : rows.length === 0 ? (
        <Text style={{ color: '#8b949e', fontSize: 13 }}>
          Aún no hay sesiones grabadas en este dispositivo.
        </Text>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.entry.session_id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#c9d1d9"
            />
          }
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          renderItem={({ item }) => <HistoryRow row={item} />}
        />
      )}
    </View>
  );
}

function HistoryRow({ row }: { row: Row }) {
  const badge = statusBadge(row.summary);
  // The counter line is auxiliary detail — the badge already carries
  // the truthful state. Only render the X / Y counter when chunks
  // actually exist; for loading / empty / unknown states the badge
  // alone says everything that's known. No more "Sin chunks
  // registrados" generic fallback that conflicted with "Sin datos".
  const counter =
    row.summary && row.summary.total > 0
      ? `${row.summary.uploaded} / ${row.summary.total} chunks`
      : null;

  return (
    <Pressable
      onPress={() => router.push(`/session/${row.entry.session_id}`)}
      style={{
        backgroundColor: '#161b22',
        borderWidth: 1,
        borderColor: '#30363d',
        borderRadius: 8,
        padding: 12,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
        }}
      >
        <View style={{ flex: 1, paddingRight: 8 }}>
          <Text style={{ color: '#c9d1d9', fontSize: 13, fontWeight: '600' }}>
            {formatTimestamp(row.entry.created_at)}
          </Text>
          <Text style={{ color: '#8b949e', fontSize: 11, marginTop: 4 }}>
            Modo: {row.entry.mode}
          </Text>
          {counter !== null && (
            <Text style={{ color: '#8b949e', fontSize: 11, marginTop: 2 }}>
              {counter}
            </Text>
          )}
        </View>

        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: badge.color,
            backgroundColor: badge.bg,
          }}
        >
          <Text
            style={{ color: badge.color, fontSize: 11, fontWeight: '600' }}
          >
            {badge.label}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}
