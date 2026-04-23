/**
 * Vitest global setup.
 *
 * Sets environment variables BEFORE any `src/` module is imported. The env
 * module in `src/config/env.ts` exits the process on invalid config, so we
 * have to satisfy its zod schema here.
 *
 * dotenv (imported by env.ts) does not override values already set in
 * process.env, so these stay in effect even if a real .env exists.
 */

process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.LOG_LEVEL = 'fatal'; // silence pino during tests
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-padding-xxxxxx';
process.env.MAX_CHUNK_SIZE_BYTES = String(20 * 1024 * 1024);
