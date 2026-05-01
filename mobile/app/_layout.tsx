import { useEffect } from 'react';
import { Stack } from 'expo-router';

import { env } from '@/config/env';
import { pingHealth } from '@/api/health';

export default function RootLayout() {
  // Boot-time diagnostics. Runs ONCE on app mount.
  //
  //   - ENV STARTUP confirms which apiUrl ended up baked into the
  //     bundle (the env module also logged ENV LOAD / ENV READY at
  //     import time; this line is the user-visible "the app started
  //     and is pointing at X" marker).
  //   - HEALTH probe is a fire-and-forget GET /health. Logs API OK on
  //     success, API UNREACHABLE on any throw. Independent of auth.
  useEffect(() => {
    console.log('ENV STARTUP', { apiUrl: env.apiUrl });
    pingHealth()
      .then((res) => {
        console.log('API OK', { apiUrl: env.apiUrl, status: res.status });
      })
      .catch((err) => {
        console.log('API UNREACHABLE', {
          apiUrl: env.apiUrl,
          err: err instanceof Error ? err.message : String(err),
        });
      });
  }, []);

  return <Stack />;
}
