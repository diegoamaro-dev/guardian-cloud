import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Rate limiters are module-scoped; running test files in parallel is
    // fine, but within a file we run sequentially to avoid hitting the
    // per-user quota by accident.
    fileParallelism: true,
  },
});
