import { buildApp } from './app.js';
import { env } from './env.js';
import { loggerFactory, apiLogger } from './lib/logger/index.js';
import { db, sql as connection } from './db/client.js';
import { deleteObject } from './lib/storage.js';
import { StorageCleanupDispatcher } from './lib/storageCleanup.js';
const app = await buildApp();
const cleanup = new StorageCleanupDispatcher({
  db,
  deleteObject,
  log: apiLogger,
});
try {
  await app.listen(env.PORT, '0.0.0.0');
  apiLogger.info(
    { event: 'api_started', port: env.PORT },
    'Neuton API listening',
  );
  cleanup.start();
} catch {
  apiLogger.error({ event: 'api_start_failed' }, 'API startup failed');
  await app.close().catch(() => {});
  process.exit(1);
}
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  apiLogger.info({ event: 'api_shutdown', signal }, 'API shutting down');
  const timer = setTimeout(() => process.exit(1), 15000);
  timer.unref();
  try {
    await app.close();
    await cleanup.stop();
    await connection.end({ timeout: 5 });
    await loggerFactory.shutdown();
    clearTimeout(timer);
    process.exit(0);
  } catch {
    process.exit(1);
  }
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
