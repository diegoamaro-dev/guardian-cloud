/**
 * Process entrypoint.
 *
 * - Builds the Express app.
 * - Starts the HTTP listener on the configured port.
 * - Wires SIGTERM/SIGINT to a graceful shutdown so Docker can stop the
 *   container cleanly without dropping an in-flight request.
 */

import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

const app = createApp();

// Bind explicitly to 0.0.0.0 (all IPv4 interfaces) so the Android emulator
// can reach us at 10.0.2.2:PORT. Node's default (no host arg) is `::` which
// on Windows often does NOT accept IPv4 NAT connections from the emulator,
// causing the client fetch to hang before any Express middleware runs and
// therefore no REQ_INCOMING log appears. Leave this explicit.
const server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info(
    { port: env.PORT, host: '0.0.0.0', env: env.NODE_ENV },
    'guardian-cloud-backend listening',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down');
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error during server.close');
      process.exit(1);
    }
    process.exit(0);
  });
  // Hard-stop after 10s to avoid hanging forever on a stuck connection.
  setTimeout(() => {
    logger.warn('Forcing exit after shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — exiting');
  process.exit(1);
});
