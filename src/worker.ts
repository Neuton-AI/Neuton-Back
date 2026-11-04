import { pathToFileURL } from 'node:url';
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { createWorkerDatabase } from './db/worker-client.js';
import { createRedisConnection, QUEUE_NAME, getMediaQueue, enqueueMediaJobOn, closeMediaQueue } from './lib/queue.js';
import { env } from './env.js';
import { workerLogger, loggerFactory } from './lib/logger/index.js';
import { geminiCircuitBreaker, CircuitOpenError } from './lib/circuitBreaker.js';
import { isPermanentError, publicFailureMessage } from './lib/jobErrors.js';
import { DocumentProcessingService, defaultWorkerServices, hydratedJob, type WorkerDeps } from './modules/processing/processing.service.js';
import type { PersistedProcessingJob } from './modules/processing/contracts.js';
import { withJobTransaction } from './db/job-context.js';
import { queryRows } from './db/query-rows.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
export { processReceipt, processRecipe, processOrderDocument, loadDocumentInput,
  findOrCreateInventoryItem, recordTerminalFailure, type WorkerDeps } from './modules/processing/processing.service.js';

export function persistedJobId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || !('jobId' in payload) || typeof payload.jobId !== 'string') return null;
  return /^upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.jobId) ? payload.jobId : null;
}

export async function runJob(data: unknown, job: Pick<Job, 'id' | 'updateProgress'>, deps: WorkerDeps): Promise<void> {
  const jobId = persistedJobId(data);
  if (!jobId) throw new UnrecoverableError('Persisted job ID is required; legacy upload jobs are not supported');
  if (!geminiCircuitBreaker.canExecute()) throw new CircuitOpenError(env.CIRCUIT_BREAKER_RESET_MS);
  const service = new DocumentProcessingService(deps);
  try {
    const completed = await service.run({ jobId }, job);
    if (completed) geminiCircuitBreaker.recordSuccess();
  } catch (error) {
    if (!(error instanceof CircuitOpenError) && !isPermanentError(error)) geminiCircuitBreaker.recordFailure();
    const timedOut = error instanceof Error && /deadline exceeded/i.test(error.message);
    if (isPermanentError(error) || timedOut) {
      await service.fail(jobId, error);
      throw new UnrecoverableError(publicFailureMessage(error));
    }
    throw error;
  }
}

/** Fixed IDs recover the SQL-commit/Redis-publication crash window. */
export class JobPublicationDispatcher {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private readonly deps: Pick<WorkerDeps, 'db'>, private readonly publish = async (data: ReturnType<typeof hydratedJob>) =>
    enqueueMediaJobOn(getMediaQueue(), data)) {}
  drain() {
    if (this.stopped) return Promise.resolve();
    if (!this.running) this.running = this.run().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async run() {
    const jobs = await queryRows(this.deps.db, sql`select * from app_private.pending_job_publications(20)`, z.object({ job_id: z.string() }));
    for (const job of jobs) {
      if (this.stopped) return;
      const data = await withJobTransaction(this.deps.db, job.job_id, async scope => hydratedJob(scope), false);
      if (!data) continue;
      const publication = await this.publish(data);
      if (!publication.queued) continue;
      await withJobTransaction(this.deps.db, job.job_id, async scope => {
        await scope.database.execute(sql`select app_private.mark_job_published(${scope.jobId}::text)`);
      }, false);
    }
  }
  start() {
    if (this.timer || this.stopped) return;
    const tick = () => { void this.drain().catch(() => workerLogger.error({ event: 'job_publication_failed' }, 'job publication will retry')); };
    this.timer = setInterval(tick, 5000); this.timer.unref(); tick();
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.running; }
}

function startWorker() {
  const pool = createWorkerDatabase();
  const deps: WorkerDeps = { db: pool.database, ...defaultWorkerServices };
  const redis = createRedisConnection();
  const worker = new Worker<PersistedProcessingJob>(QUEUE_NAME, job => runJob(job.data, job, deps), {
    connection: redis, concurrency: env.RECEIPT_WORKER_CONCURRENCY, lockDuration: env.JOB_LOCK_DURATION_MS,
  });
  const publications = new JobPublicationDispatcher(deps);
  const failures = new Set<Promise<unknown>>();
  worker.on('failed', (job, error) => {
    workerLogger.error({ jobId: job?.id, errorType: error.constructor.name }, 'job failed');
    if (!job || error instanceof UnrecoverableError || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const jobId = persistedJobId(job.data);
    if (!jobId) return;
    const failure = new DocumentProcessingService(deps).fail(jobId, error).catch(() => {
      workerLogger.error({ event: 'terminal_failure_unavailable', jobId }, 'could not record terminal failure');
    }).finally(() => failures.delete(failure));
    failures.add(failure);
  });
  worker.on('error', error => workerLogger.error({ errorType: error.constructor.name }, 'worker error'));
  publications.start();
  workerLogger.info({ queue: QUEUE_NAME, concurrency: env.RECEIPT_WORKER_CONCURRENCY }, 'neuton vision worker ready');
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 15000); timer.unref();
    try {
      await publications.stop(); await worker.close(); await Promise.allSettled(failures);
      await closeMediaQueue(); await redis.quit(); await pool.close(); await loggerFactory.shutdown();
      clearTimeout(timer); process.exit(0);
    } catch { process.exit(1); }
  };
  process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
}
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) startWorker();
