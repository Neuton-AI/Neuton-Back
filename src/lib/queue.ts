import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../env.js';
import type { PersistedProcessingJob } from '../modules/processing/contracts.js';
import type { UploadSource } from '../db/schema/uploads.js';

export const QUEUE_NAME = 'neuton-media';

/** Workers reconnect; publishers fail within a bounded connection/retry budget. */
export function createRedisConnection(purpose: 'worker' | 'producer' = 'worker'): Redis {
  return new Redis(env.UPSTASH_REDIS_URL, {
    maxRetriesPerRequest: purpose === 'worker' ? null : 1,
    connectTimeout: 5000,
    retryStrategy: attempt => {
      if (purpose === 'worker') return Math.min(attempt * 50, 2000);
      if (attempt >= 2) return null;
      return 100;
    },
    enableReadyCheck: false,
    lazyConnect: true,
    tls: env.UPSTASH_REDIS_URL.startsWith('rediss://') ? {} : undefined,
  });
}

export type MediaKind = 'receipt' | 'recipe' | 'product' | 'order';

export interface MediaJobData {
  /** Persisted authority identifier; other fields are transitional dispatch hints. */
  jobId?: string;
  uploadId?: string;
  sources?: UploadSource[];
  shopId: string;
  uploadedBy: string | null;
  kind: MediaKind;
  storagePath: string | null;
  contentType: string;
  originalFilename: string | null;
  /** Present for `kind === 'order'`: the order row being auto-filled. */
  orderId?: string;
  /** Correlation id of the API request that enqueued this job (issue #99). */
  traceId?: string;
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 3_000 },
  removeOnComplete: { age: 60 * 60 * 24, count: 1_000 },
  removeOnFail: { age: 60 * 60 * 24 * 7 },
};

let queue: Queue<PersistedProcessingJob> | null = null;
let queueRedis: Redis | undefined;

export function getMediaQueue(): Queue<PersistedProcessingJob> {
  if (queueRedis?.status === 'end') {
    void queue?.close().catch(() => undefined);
    queue = null; queueRedis = undefined;
  }
  if (!queue) {
    queueRedis = createRedisConnection('producer');
    queue = new Queue<PersistedProcessingJob>(QUEUE_NAME, {
      connection: queueRedis,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    // Publication callers report failures with bounded context; driver error
    // events must not escape as unhandled errors or expose connection details.
    queue.on('error', () => {});
  }
  return queue;
}

export async function closeMediaQueue() {
  await queue?.close();
  queueRedis?.disconnect();
  queue = null; queueRedis = undefined;
}

export interface EnqueueResult {
  queued: boolean;
  jobId: string | null;
  reason?: string;
}

/** Stable group IDs make dispatch retries safe, including retrying a retained failed job. */
export async function enqueueMediaJobOn(
  mediaQueue: Pick<Queue<PersistedProcessingJob>, 'getJob' | 'add'>,
  data: MediaJobData,
): Promise<EnqueueResult> {
  if (!data.uploadId) throw new Error('Grouped uploadId is required for media jobs');
  const jobId = data.jobId ?? `upload-${data.uploadId}`;
  if (jobId !== `upload-${data.uploadId}`) throw new Error('Job identity does not match its upload');
  const existing = await mediaQueue.getJob(jobId);
  if (existing) {
    if (await existing.getState() === 'failed') await existing.retry();
    return { queued: true, jobId: String(existing.id) };
  }
  const job = await mediaQueue.add('document', { jobId }, { jobId });
  return { queued: true, jobId: String(job.id) };
}

export async function enqueueMediaJob(data: MediaJobData): Promise<EnqueueResult> {
  if (!data.uploadId) throw new Error('Grouped uploadId is required for media jobs');
  try {
    return await enqueueMediaJobOn(getMediaQueue(), data);
  } catch (error) {
    if (env.QUEUE_OPTIONAL) {
      return { queued: false, jobId: null, reason: 'queue unavailable' };
    }
    throw error;
  }
}
