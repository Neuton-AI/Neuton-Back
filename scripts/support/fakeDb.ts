/**
 * A stand-in for the Drizzle client.
 *
 * Drizzle's query builder is chainable and resolves when awaited, so the double
 * records every statement, then answers from a per-table FIFO of scripted rows.
 * Calls are keyed by `op:table` rather than by position, which keeps a test
 * readable and survives a query moving within the same function.
 *
 * `transaction` hands the double back to its callback, matching Drizzle's
 * behaviour, and calls are tagged with whether they were issued inside a
 * transaction so a test can assert on that without asserting on *which* handle
 * was used.
 */
import * as schema from '../../src/db/schema/index.js';

export type DbOperation = 'select' | 'insert' | 'update' | 'delete';

export interface RecordedCall {
  op: DbOperation;
  table: string;
  /** Payload passed to `.values(...)`. */
  values?: unknown;
  /** Payload passed to `.set(...)`. */
  set?: Record<string, unknown>;
  /** Payload passed to `.limit(...)`, when the statement used one. */
  limit?: number;
  inTransaction: boolean;
}

export type FakeResponses = Record<string, unknown[]>;

const TABLE_NAMES = new Map<object, string>();
for (const [exportName, value] of Object.entries(schema)) {
  if (value !== null && typeof value === 'object') {
    TABLE_NAMES.set(value as object, exportName);
  }
}

export function tableName(table: unknown): string {
  if (table !== null && typeof table === 'object') {
    const name = TABLE_NAMES.get(table as object);
    if (name) return name;
  }
  throw new Error(`fakeDb: unknown table ${String(table)}`);
}

export class FakeQuery<T = unknown> implements PromiseLike<T> {
  private payload?: unknown;
  private patch?: Record<string, unknown>;
  private rowLimit?: number;

  constructor(
    private readonly db: FakeDb,
    private readonly op: DbOperation,
    private table: string,
  ) {}

  from(table: unknown): this {
    this.table = tableName(table);
    return this;
  }

  where(): this {
    return this;
  }

  orderBy(): this {
    return this;
  }

  groupBy(): this {
    return this;
  }

  innerJoin(): this {
    return this;
  }

  limit(count: number): this {
    this.rowLimit = count;
    return this;
  }

  returning(): this {
    return this;
  }

  values(payload: unknown): this {
    this.payload = payload;
    return this;
  }

  set(patch: Record<string, unknown>): this {
    this.patch = patch;
    return this;
  }

  then<A, B>(
    onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    let result: Promise<T>;
    try {
      result = Promise.resolve(this.db.settle({
        op: this.op,
        table: this.table,
        values: this.payload,
        set: this.patch,
        limit: this.rowLimit,
      }) as T);
    } catch (error) {
      result = Promise.reject(error);
    }
    return result.then(onFulfilled, onRejected);
  }
}

export class FakeDb {
  readonly calls: RecordedCall[] = [];
  /** Number of times `transaction` was entered. */
  transactionCount = 0;

  private readonly queues = new Map<string, unknown[]>();
  private readonly failures = new Map<string, Error>();
  private depth = 0;

  constructor(responses: FakeResponses = {}) {
    for (const [key, rows] of Object.entries(responses)) {
      this.queues.set(key, [...rows]);
    }
  }

  /** Seeds an extra scripted result for a later statement on the same table. */
  push(op: DbOperation, table: string, rows: unknown): this {
    const key = `${op}:${table}`;
    this.queues.set(key, [...(this.queues.get(key) ?? []), rows]);
    return this;
  }

  /** Makes the statement reject, standing in for a database error. */
  failOn(op: DbOperation, table: string, error: Error): this {
    this.failures.set(`${op}:${table}`, error);
    return this;
  }

  select(_fields?: unknown): FakeQuery {
    return new FakeQuery(this, 'select', '');
  }

  insert(table: unknown): FakeQuery {
    return new FakeQuery(this, 'insert', tableName(table));
  }

  update(table: unknown): FakeQuery {
    return new FakeQuery(this, 'update', tableName(table));
  }

  delete(table: unknown): FakeQuery {
    return new FakeQuery(this, 'delete', tableName(table));
  }

  async transaction<T>(run: (tx: FakeDb) => Promise<T>): Promise<T> {
    this.transactionCount++;
    this.depth++;
    try {
      return await run(this);
    } finally {
      this.depth--;
    }
  }

  settle(call: Omit<RecordedCall, 'inTransaction'>): unknown {
    const recorded: RecordedCall = { ...call, inTransaction: this.depth > 0 };
    this.calls.push(recorded);
    const key = `${recorded.op}:${recorded.table}`;
    const failure = this.failures.get(key);
    if (failure) throw failure;
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return [];
    return queue.shift();
  }

  /** Every recorded statement against one table, in issue order. */
  callsTo(op: DbOperation, table: string): RecordedCall[] {
    return this.calls.filter((call) => call.op === op && call.table === table);
  }

  /** `op:table` for every statement, in issue order. Pins the query *count* too. */
  callSequence(): string[] {
    return this.calls.map((call) => `${call.op}:${call.table}`);
  }

  /**
   * The single recorded statement, failing loudly when there is not exactly one.
   * @throws {Error} when the statement did not happen exactly once.
   */
  onlyCallTo(op: DbOperation, table: string): RecordedCall {
    const matches = this.callsTo(op, table);
    if (matches.length !== 1) {
      throw new Error(
        `fakeDb: expected exactly one ${op} on ${table}, saw ${matches.length}`,
      );
    }
    return matches[0] as RecordedCall;
  }
}