import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../env.js';
import type { UploadSource } from '../db/schema/uploads.js';

export const QUEUE_NAME = 'neuton-media';

/**
 * Upstash requires TLS and forbids the blocking/`maxRetriesPerRequest` patterns
 * BullMQ needs, so connection options are explicit here.
 */
export function createRedisConnection(): Redis {
  return new Redis(env.UPSTASH_REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    tls: env.UPSTASH_REDIS_URL.startsWith('rediss://') ? {} : undefined,
  });
}

export type MediaKind = 'receipt' | 'recipe' | 'product' | 'order';

export interface MediaJobData {
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

let queue: Queue<MediaJobData> | null = null;
let queueUnavailable = false;

export function getMediaQueue(): Queue<MediaJobData> {
  if (!queue) {
    queue = new Queue<MediaJobData>(QUEUE_NAME, {
      connection: createRedisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return queue;
}

export interface EnqueueResult {
  queued: boolean;
  jobId: string | null;
  reason?: string;
}

/** Stable group IDs make dispatch retries safe, including retrying a retained failed job. */
export async function enqueueMediaJobOn(
  mediaQueue: Pick<Queue<MediaJobData>, 'getJob' | 'add'>,
  data: MediaJobData,
): Promise<EnqueueResult> {
  if (data.uploadId) {
    const existing = await mediaQueue.getJob(`upload-${data.uploadId}`);
    if (existing) {
      if (await existing.getState() === 'failed') await existing.retry();
      return { queued: true, jobId: String(existing.id) };
    }
  }
  const job = await mediaQueue.add(data.kind, data, data.uploadId ? { jobId: `upload-${data.uploadId}` } : {});
  return { queued: true, jobId: String(job.id) };
}

export async function enqueueMediaJob(data: MediaJobData): Promise<EnqueueResult> {
  if (queueUnavailable && !data.uploadId) {
    return { queued: false, jobId: null, reason: 'queue disabled' };
  }
  try {
    return await enqueueMediaJobOn(getMediaQueue(), data);
  } catch (error) {
    if (env.QUEUE_OPTIONAL) {
      if (!data.uploadId) queueUnavailable = true;
      return { queued: false, jobId: null, reason: 'queue unavailable' };
    }
    throw error;
  }
}
