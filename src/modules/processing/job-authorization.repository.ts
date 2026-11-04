import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ShopTransaction } from '../../db/types.js';
import { queryRows } from '../../db/query-rows.js';
import type { PersistedProcessingJob } from './contracts.js';

/** Submission uses the same capability and transaction as upload acceptance. */
export class JobAuthorizationRepository {
  async register(scope: ShopTransaction, uploadId: string, correlationId: string): Promise<PersistedProcessingJob> {
    await scope.database.execute(sql`select set_config('neuton.trace_id',${correlationId.slice(0, 128)},true)`);
    const [row] = await queryRows(scope.database,
      sql`select app_private.register_job(${uploadId}::uuid) as job_id`,
      z.object({ job_id: z.string().regex(/^upload-[0-9a-f-]{36}$/i) }),
    );
    if (!row || row.job_id !== `upload-${uploadId}`) {
      throw new Error('Unable to persist job authorization');
    }
    return { jobId: row.job_id };
  }
}
