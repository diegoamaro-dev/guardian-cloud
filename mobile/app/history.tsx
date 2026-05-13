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

import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { router, Stack, useFocusEffect } from 'expo-router';

import { listSessionChunks } from '@/api/export';
import {
  type HistoryEntry,
  type SessionMode,
  type SessionStatusSummary,
  deriveSessionStatus,
  readHistory,
} from '@/api/history';

interface Row {
  entry: HistoryEntry;
  /** null = still loading; summary = resolved (incl. 'unknown' on fetch fail). */
  summary: SessionStatusSummary | null;
  /**
   * Number of chunks still in `status='pending'` server-side. Used
   * by `statusBadge` to distinguish "in progress" (Subiendo) from
   * "final partial result" (Protección parcial) — same backend
   * `partial` status, two very different things to a human.
   * `null` while loading.
   */
  pendingCount: number | null;
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

/**
 * Maps the backend-derived `SessionStatusSummary` + the live pending
 * count to a single human-readable badge. Six possible labels, no
 * technical vocabulary, no chunk counters.
 *
 * Decision table:
 *   loading (summary === null)                → "Cargando…"
 *   unknown (fetch failed)                    → "Sin conexión"
 *   empty (backend returned [])               → "Sin grabación"
 *   complete (everything uploaded)            → "Protegido"
 *   failed + pending > 0                      → "Subiendo" (starting,
 *                                                nothing uploaded yet)
 *   failed + pending === 0                    → "Error" (every chunk
 *                                                attempted, none ok)
 *   partial + pending > 0 + failed === 0      → "Subiendo" (still
 *                                                progressing, no
 *                                                permanent failures)
 *   partial otherwise                         → "Protección parcial"
 *                                                (final result has
 *                                                gaps or failures)
 *
 * Lives in this file because it is presentation only. The underlying
 * `deriveSessionStatus` logic in `@/api/history` is NOT changed —
 * we only collapse its output to user-facing copy.
 */
function statusBadge(
  summary: SessionStatusSummary | null,
  pendingCount: number | null,
): {
  label: string;
  color: string;
  bg: string;
} {
  if (summary === null) {
    return { label: 'Cargando…', color: '#8b949e', bg: '#161b22' };
  }
  switch (summary.status) {
    case 'unknown':
      return { label: 'Sin conexión', color: '#f85149', bg: '#2d0d12' };
    case 'empty':
      return { label: 'Sin grabación', color: '#8b949e', bg: '#161b22' };
    case 'complete':
      return { label: 'Protegido', color: '#56d364', bg: '#0a2a14' };
    case 'failed': {
      // `failed` in backend semantics means uploaded === 0. That can
      // happen because every chunk truly failed (Error) OR because
      // every chunk is still pending (Subiendo). The pending count
      // is the only thing that lets the UI tell them apart.
      const stillTrying = (pendingCount ?? 0) > 0;
      return stillTrying
        ? { label: 'Subiendo', color: '#58a6ff', bg: '#0c1e3a' }
        : { label: 'Error', color: '#f85149', bg: '#2d0d12' };
    }
    case 'partial': {
      const stillTrying =
        (pendingCount ?? 0) > 0 && summary.failed === 0;
      return stillTrying
        ? { label: 'Subiendo', color: '#58a6ff', bg: '#0c1e3a' }
        : { label: 'Protección parcial', color: '#e3b341', bg: '#2d1f06' };
    }
  }
}

/** Icon + human label for the recording mode. Emoji-only — no asset
 *  dependency, no native font. Width difference between 🎤 and 🎥 is
 *  negligible on Android system font stacks, so the row layout stays
 *  consistent. */
function modeBadge(mode: SessionMode): { icon: string; label: string } {
  return mode === 'video'
    ? { icon: '🎥', label: 'Vídeo' }
    : { icon: '🎤', label: 'Audio' };
}

export default function HistoryScreen() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    const entries = await readHistory();
    // Initialise with `summary: null` so the FlatList renders
    // immediately with a "Cargando…" state per row instead of a blank
    // screen while we fetch.
    const initial: Row[] = entries.map((entry) => ({
      entry,
      summary: null,
      pendingCount: null,
    }));
    setRows(initial);

    // Fetch each row's real status in parallel. If any single fetch
    // fails, that row gets summary={status:'unknown'} via deriveSessionStatus(null).
    // We never throw out of this map — partial UI is better than no UI.
    const results = await Promise.all(
      entries.map(async (entry) => {
        try {
          const chunks = await listSessionChunks(entry.session_id);
          // Raw `pending` count, kept alongside the derived summary so
          // `statusBadge` can tell "Subiendo" apart from "Protección
          // parcial" / "Error" without changing `deriveSessionStatus`.
          const pendingCount = chunks.filter(
            (c) => c.status === 'pending',
          ).length;
          return {
            entry,
            summary: deriveSessionStatus(chunks),
            pendingCount,
          };
        } catch {
          return {
            entry,
            summary: deriveSessionStatus(null),
            pendingCount: null,
          };
        }
      }),
    );
    setRows(results);
  }

  // Reload on every focus, not just mount. The detail screen lets the
  // user edit a session title; this guarantees the new label shows up
  // the next time the user lands back on the list, without requiring a
  // manual pull-to-refresh. Cheap: read of AsyncStorage + N parallel
  // `listSessionChunks` calls already gated by the existing per-row
  // try/catch.
  useFocusEffect(
    useCallback(() => {
      load();
    }, []),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#0d1117', padding: 16, paddingTop: 48 }}>
      {/* Hide Expo Router's default header so the screen renders only
          the Guardian Cloud custom dark header below. The native bar
          is what previously provided the back affordance; we replace
          it with the same `← Volver` Pressable settings.tsx uses so
          the user is never stranded without a visible back. Same
          technique as the home route. */}
      <Stack.Screen options={{ headerShown: false }} />
      <Pressable
        onPress={() => router.back()}
        style={{ marginBottom: 16, alignSelf: 'flex-start' }}
        hitSlop={12}
      >
        <Text style={{ color: '#8b949e', fontSize: 14 }}>← Volver</Text>
      </Pressable>
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
  const badge = statusBadge(row.summary, row.pendingCount);
  const mode = modeBadge(row.entry.mode);
  // Trim defensively at render time so a stale entry stored before
  // the trim guarantee in `updateHistoryEntryTitle` cannot leak
  // surrounding whitespace into the row.
  const title = (row.entry.title ?? '').trim();
  const navigate = () => router.push(`/session/${row.entry.session_id}`);

  return (
    <Pressable
      onPress={navigate}
      style={{
        backgroundColor: '#161b22',
        borderWidth: 1,
        borderColor: '#30363d',
        borderRadius: 10,
        padding: 16,
      }}
    >
      {/* Header row: mode icon + label on the left, status badge
          aligned right. The two halves never wrap because the title
          and timestamp live on their own lines below. */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ fontSize: 18, marginRight: 8 }}>{mode.icon}</Text>
          <Text
            style={{ color: '#c9d1d9', fontSize: 14, fontWeight: '600' }}
          >
            {mode.label}
          </Text>
        </View>

        <View
          style={{
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 999,
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

      {/* Optional title — only rendered when the user has set one.
          Trimmed empty string collapses to "no title" so we never
          show a blank line. */}
      {title.length > 0 && (
        <Text
          style={{
            color: '#c9d1d9',
            fontSize: 15,
            fontWeight: '500',
            marginTop: 10,
          }}
          numberOfLines={2}
        >
          {title}
        </Text>
      )}

      {/* Timestamp — sits below the title (or below the header when
          there is no title). Dimmer than the title to avoid competing
          with it visually. */}
      <Text
        style={{
          color: '#8b949e',
          fontSize: 12,
          marginTop: title.length > 0 ? 4 : 10,
        }}
      >
        {formatTimestamp(row.entry.created_at)}
      </Text>

      {/* Export CTA. Tapping it navigates to the detail screen which
          already owns the export flow (progress, result, share, and
          integrity verdict). Intentionally NOT a direct trigger —
          the detail screen's UI is the right place for that
          interaction.

          React Native's `Pressable` does NOT bubble events to the
          outer `Pressable`, so a tap on this button does not also
          trigger the row-level `navigate`. Touches outside this
          button still hit the outer Pressable and navigate. */}
      <Pressable
        onPress={navigate}
        style={{
          marginTop: 14,
          alignSelf: 'flex-start',
          paddingVertical: 10,
          paddingHorizontal: 16,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: '#30363d',
          backgroundColor: '#21262d',
        }}
        hitSlop={6}
      >
        <Text style={{ color: '#c9d1d9', fontSize: 13, fontWeight: '600' }}>
          Exportar
        </Text>
      </Pressable>
    </Pressable>
  );
}
