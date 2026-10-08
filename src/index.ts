import { buildApp } from './app.js';
import { env } from './env.js';
import { loggerFactory } from './lib/logger/index.js';

const app = await buildApp();

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`Neuton API listening on :${env.PORT}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  // Flushes the Loki worker's last ~5s batch — without this the lines the
  // shutdown itself logs never reach Loki (issue #99 DOD).
  await loggerFactory.shutdown();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
