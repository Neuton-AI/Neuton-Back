import { enqueueMediaJob, getMediaQueue, QUEUE_NAME } from '../src/lib/queue.js';

/** Verifies the Redis/BullMQ link on its own, without touching R2 or Gemini. */

async function main() {
  const shopId = '00000000-0000-0000-0000-00000000ff02';
  console.log('--- Redis/BullMQ ---');

  const queue = getMediaQueue();
  const counts = await queue.getJobCounts('wait', 'active', 'completed', 'failed');
  console.log(`queue "${QUEUE_NAME}" existing counts: ${JSON.stringify(counts)}`);

  const queued = await enqueueMediaJob({
    shopId,
    uploadedBy: null,
    kind: 'receipt',
    storagePath: `${shopId}/receipts/redis-only-check.png`,
    contentType: 'image/png',
    originalFilename: 'redis-only-check.png',
  });

  if (!queued.queued) throw new Error(`enqueue failed: ${queued.reason ?? 'unknown reason'}`);
  console.log(`ok   enqueued job ${queued.jobId}`);

  const job = await queue.getJob(queued.jobId!);
  if (!job) throw new Error(`job ${queued.jobId} not retrievable from Redis`);
  const state = await job.getState();
  console.log(`ok   fetched from Redis: name="${job.name}" state="${state}"`);
  console.log(`     payload: ${JSON.stringify(job.data)}`);

  const after = await queue.getJobCounts('wait', 'active', 'completed', 'failed');
  console.log(`     counts after enqueue: ${JSON.stringify(after)}`);

  await job.remove();
  console.log('ok   job removed');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\nREDIS CHECK FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
