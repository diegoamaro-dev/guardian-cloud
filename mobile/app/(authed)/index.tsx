/**
 * Authenticated home (brick 1 validation surface).
 *
 * Intentionally boring:
 *   - shows the signed-in user's email
 *   - "Ping backend" button → GET /health with the Bearer token
 *   - "Sign out"
 *
 * This is the single screen we need to validate brick 1: if the ping
 * returns 200 against a live backend while we're signed in, the whole
 * stack (Expo Dev Client → env → Supabase auth → API client → backend)
 * is wired correctly.
 *
 * UI polish comes MUCH later. Don't touch it here.
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '@/auth/store';
import { pingHealth, type HealthResponse } from '@/api/health';
import { ApiError } from '@/api/client';

type PingState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; payload: HealthResponse }
  | { kind: 'error'; message: string; code?: string; status?: number };

export default function AuthedHome() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);

  const [ping, setPing] = useState<PingState>({ kind: 'idle' });

  async function onPing() {
    setPing({ kind: 'loading' });
    try {
      const payload = await pingHealth();
      setPing({ kind: 'ok', payload });
    } catch (e) {
      if (e instanceof ApiError) {
        const next: PingState = {
          kind: 'error',
          message: e.message,
          status: e.status,
        };
        if (e.code !== undefined) next.code = e.code;
        setPing(next);
      } else {
        setPing({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Guardian Cloud</Text>
        <Text style={styles.subtitle}>
          Signed in as {user?.email ?? user?.id ?? 'unknown'}
        </Text>

        <Pressable
          onPress={onPing}
          disabled={ping.kind === 'loading'}
          style={({ pressed }) => [
            styles.button,
            ping.kind === 'loading' && styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}
        >
          {ping.kind === 'loading' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Ping backend (/health)</Text>
          )}
        </Pressable>

        <View style={styles.resultBox}>
          <Text style={styles.resultLabel}>Result</Text>
          <Text style={styles.resultBody}>{renderPing(ping)}</Text>
        </View>

        <Pressable
          onPress={() => void signOut()}
          style={({ pressed }) => [
            styles.signOutButton,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function renderPing(state: PingState): string {
  switch (state.kind) {
    case 'idle':
      return 'Not pinged yet.';
    case 'loading':
      return 'Pinging…';
    case 'ok':
      return `OK — ${JSON.stringify(state.payload)}`;
    case 'error':
      return (
        `FAIL` +
        (state.status ? ` (HTTP ${state.status})` : '') +
        (state.code ? ` [${state.code}]` : '') +
        `\n${state.message}`
      );
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: {
    padding: 24,
    gap: 16,
  },
  title: { fontSize: 24, fontWeight: '600' },
  subtitle: { fontSize: 14, color: '#555' },
  button: {
    backgroundColor: '#111',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 24,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  resultBox: {
    backgroundColor: '#f4f4f4',
    borderRadius: 8,
    padding: 12,
  },
  resultLabel: { fontSize: 12, color: '#666', marginBottom: 4 },
  resultBody: { fontSize: 14 },
  signOutButton: {
    marginTop: 32,
    paddingVertical: 12,
    alignItems: 'center',
  },
  signOutText: { color: '#900', fontSize: 14 },
});
