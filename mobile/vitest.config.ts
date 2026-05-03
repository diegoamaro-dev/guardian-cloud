import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    // Mirror tsconfig.json's `@/*` → `src/*` so imports inside the
    // module under test (e.g. `import { ApiError } from '@/api/client'`)
    // resolve correctly under vitest.
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // The mobile bundle pulls in heavy native modules (expo-camera,
    // expo-av, react-native-background-actions, etc.). We mock the
    // narrow set we actually need per test file via vi.mock(); the
    // shared heavy mocks live in tests/setup.ts.
    fileParallelism: true,
  },
});
