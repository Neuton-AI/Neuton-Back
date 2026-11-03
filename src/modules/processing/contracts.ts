/** Queue-independent progress/correlation port used by document application services. */
export interface ProcessingJob {
  id?: string;
  updateProgress(value: number): Promise<unknown>;
}

/** Queue payload for the new worker: identity/permissions come from PostgreSQL. */
export interface PersistedProcessingJob {
  jobId: string;
}

export type { JobTransaction } from '../../db/job-context.js';
