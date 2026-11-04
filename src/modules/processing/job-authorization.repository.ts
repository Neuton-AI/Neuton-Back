import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ShopTransaction } from '../../db/types.js';
import { queryRows } from '../../db/query-rows.js';
import type { PersistedProcessingJob } from './contracts.js';
import { conflict } from '../../lib/errors.js';

/** Submission uses the same capability and transaction as upload acceptance. */
export class JobAuthorizationRepository {
  async register(scope: ShopTransaction, uploadId: string, correlationId: string): Promise<PersistedProcessingJob> {
    await scope.database.execute(sql`select set_config('neuton.trace_id',${correlationId.slice(0, 128)},true)`);
    let row: { job_id: string | null } | undefined;
    try {
      [row] = await queryRows(scope.database,
        sql`select app_private.register_job(${uploadId}::uuid) as job_id`,
        z.object({ job_id: z.string().regex(/^upload-[0-9a-f-]{36}$/i).nullable() }));
    } catch (error) {
      let cause = error;
      for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
        if ('code' in cause && cause.code === '55000') throw conflict('Document is no longer available for processing');
        cause = 'cause' in cause ? cause.cause : undefined;
      }
      throw error;
    }
    if (!row || row.job_id !== `upload-${uploadId}`) {
      throw conflict('This document can no longer be submitted; create a new upload');
    }
    return { jobId: row.job_id };
  }
}
