import { buildApp } from './app.js';
import { env } from './env.js';
import { loggerFactory, apiLogger } from './lib/logger/index.js';
import { sql as connection } from './db/client.js';
import { createCleanupDatabase } from './db/cleanup-client.js';
import { closeMediaQueue } from './lib/queue.js';
import { deleteObject } from './lib/storage.js';
import { StorageCleanupDispatcher } from './lib/storageCleanup.js';
import { AuthCleanupDispatcher } from './modules/auth/auth-cleanup.js';
const app = await buildApp();
const cleanupPool = createCleanupDatabase();
const authCleanup = new AuthCleanupDispatcher(cleanupPool.database, apiLogger);
const cleanup = new StorageCleanupDispatcher({
  db: cleanupPool.database,
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
  authCleanup.start();
} catch {
  apiLogger.error({ event: 'api_start_failed' }, 'API startup failed');
  await app.close().catch(() => {});
  await cleanup.stop();
  await authCleanup.stop();
  await cleanupPool.close();
  await closeMediaQueue();
  await connection.end({ timeout: 5 });
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
    await authCleanup.stop();
    await cleanupPool.close();
    await closeMediaQueue();
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
