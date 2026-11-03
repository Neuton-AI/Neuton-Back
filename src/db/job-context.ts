import type { DatabaseTransaction } from './types.js';
import type { UserProcessingOperation } from './schema/jobs.js';
import type { UploadSource } from './schema/uploads.js';

const JOB_CAPABILITY: unique symbol = Symbol('VerifiedJobTransaction');

/** Constructed only after the worker resolves and locks persisted authorization. */
export interface JobTransaction {
  readonly [JOB_CAPABILITY]: true;
  readonly database: DatabaseTransaction;
  readonly jobId: string;
  readonly shopId: string;
  readonly requestingUserId: string;
  readonly uploadId: string;
  readonly resourceKind: 'receipt' | 'recipe' | 'order' | 'upload';
  readonly resourceId: string;
  readonly operation: UserProcessingOperation;
  readonly sources: readonly UploadSource[];
}
