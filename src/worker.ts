import { pathToFileURL } from 'node:url';
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { sql as sqlClient } from './db/client.js';
import {
  createRedisConnection,
  QUEUE_NAME,
  type MediaJobData,
} from './lib/queue.js';
import { env } from './env.js';
import { workerLogger, loggerFactory } from './lib/logger/index.js';
import {
  geminiCircuitBreaker,
  CircuitOpenError,
} from './lib/circuitBreaker.js';
import { isPermanentError, publicFailureMessage } from './lib/jobErrors.js';
import {
  DocumentProcessingService,
  defaultWorkerDeps,
  type WorkerDeps,
  recordTerminalFailure,
} from './modules/processing/processing.service.js';
export {
  processReceipt,
  processRecipe,
  processOrderDocument,
  loadDocumentInput,
  findOrCreateInventoryItem,
  recordTerminalFailure,
  defaultWorkerDeps,
  type WorkerDeps,
} from './modules/processing/processing.service.js';
function jobLogContext(data: MediaJobData, job: Job<MediaJobData>) {
  return {
    entryPoint: 'worker',
    requestId: job.id,
    jobId: job.id,
    kind: data.kind,
    shopId: data.shopId,
    userId: data.uploadedBy ?? undefined,
    traceId: data.traceId,
  };
}

/**
 * Routes a job to its handler and translates failures into BullMQ semantics.
 * Permanent errors stop the retry schedule and surface a shop-safe message.
 * Also enforces an overall processing deadline and respects the circuit breaker.
 */
export async function runJob(
  data: MediaJobData,
  job: Job<MediaJobData>,
  deps: WorkerDeps = defaultWorkerDeps,
): Promise<void> {
  const jobLogger = workerLogger.child(jobLogContext(data, job));
  if (!data.uploadId)
    throw new UnrecoverableError('Legacy upload jobs are no longer supported');
  if (!['receipt', 'recipe', 'product', 'order'].includes(data.kind))
    throw new UnrecoverableError(`Unsupported job kind: ${String(data.kind)}`);
  jobLogger.info('job started');

  // Check circuit breaker before starting
  if (!geminiCircuitBreaker.canExecute()) {
    const status = geminiCircuitBreaker.getStatus();
    jobLogger.warn(
      { circuitState: status.state, failureCount: status.failureCount },
      'circuit breaker open, failing fast',
    );
    throw new CircuitOpenError(env.CIRCUIT_BREAKER_RESET_MS);
  }

  // Overall deadline for the entire job (including retries within the job)
  const deadline = Date.now() + env.RECEIPT_PROCESSING_TIMEOUT_MS;
  const checkDeadline = () => {
    if (Date.now() > deadline) {
      throw new Error(
        `Job exceeded overall processing deadline of ${env.RECEIPT_PROCESSING_TIMEOUT_MS}ms`,
      );
    }
  };

  try {
    checkDeadline();
    await new DocumentProcessingService(deps).run(data, job);
    // Record success for circuit breaker
    geminiCircuitBreaker.recordSuccess();
  } catch (error) {
    // Record failure for circuit breaker (but not for permanent errors or circuit open)
    if (!(error instanceof CircuitOpenError) && !isPermanentError(error)) {
      geminiCircuitBreaker.recordFailure();
    }

    // Billing/auth/malformed-payload errors will not resolve on retry, so
    // drop them straight to failed instead of spending the backoff schedule.
    if (isPermanentError(error)) {
      await recordTerminalFailure(deps, data, error);
      throw new UnrecoverableError(publicFailureMessage(error));
    }

    // Processing deadline exceeded - treat as permanent failure to avoid retries
    if (error instanceof Error && error.message.includes('deadline exceeded')) {
      await recordTerminalFailure(deps, data, error);
      throw new UnrecoverableError(publicFailureMessage(error));
    }
    throw error;
  }

  jobLogger.info('job completed');
}

/**
 * Importing this module must not boot a worker: the test suite imports it to
 * exercise the handlers above, and a stray worker would hold a Redis
 * connection and the event loop open.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

function startWorker(): void {
  const worker = new Worker<MediaJobData>(
    QUEUE_NAME,
    (job) => runJob(job.data, job),
    {
      connection: createRedisConnection(),
      concurrency: env.RECEIPT_WORKER_CONCURRENCY,
      /** Duration of the lock for the job in milliseconds. If the lock is lost, the job will be moved back to wait. */
      lockDuration: env.JOB_LOCK_DURATION_MS,
    },
  );

  worker.on('completed', (job) =>
    workerLogger.info(
      { jobId: job.id, traceId: job.data.traceId, shopId: job.data.shopId },
      'job done',
    ),
  );
  worker.on('failed', (job, error) => {
    workerLogger.error(
      {
        jobId: job?.id,
        errorType: error.constructor.name,
        traceId: job?.data.traceId,
        shopId: job?.data.shopId,
      },
      'job failed',
    );
    // Covers transient errors that ran out of attempts, so the receipt row does
    // not stay on "processing" with no explanation.
    if (
      job &&
      (error instanceof UnrecoverableError || error instanceof CircuitOpenError)
    )
      return;
    if (!job) return;
    void recordTerminalFailure(defaultWorkerDeps, job.data, error);
  });
  worker.on('error', (error) =>
    workerLogger.error({ errorType: error.constructor.name }, 'worker error'),
  );

  workerLogger.info(
    { queue: QUEUE_NAME, concurrency: env.RECEIPT_WORKER_CONCURRENCY },
    'neuton vision worker ready',
  );

  const shutdown = async (signal: string) => {
    workerLogger.info(`${signal} received, closing worker`);
    await worker.close();
    await sqlClient.end({ timeout: 5 }).catch(() => {});
    // Flushes the Loki worker's last batch before the process exits (issue #99).
    await loggerFactory.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (isEntrypoint()) {
  startWorker();
}
