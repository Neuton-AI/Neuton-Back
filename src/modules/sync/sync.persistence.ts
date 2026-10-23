import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { db, type Database } from '../../db/client.js';
import type { DocumentMeta } from '../../lib/documentSync.js';
import type { SyncMutation } from './contracts.js';
import { conflict } from '../../lib/errors.js';
export const SYNC_DATABASE = Symbol('SYNC_DATABASE');
export type SyncTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];
@Injectable()
export class SyncPersistence {
  constructor(@Inject(SYNC_DATABASE) readonly database: Database = db) {}
  async documents(shopId: string): Promise<DocumentMeta[]> {
    const rows = await this.database.execute(
      sql`select kind,id,updated_at,deleted from document_versions where shop_id=${shopId}::uuid`,
    );
    return rows.map((row) => ({
      kind: row.kind as DocumentMeta['kind'],
      id: String(row.id),
      updatedAt: Number(row.updated_at),
      deleted: Boolean(row.deleted),
    }));
  }
  async mutate(
    actor: { shopId: string; userId: string },
    input: SyncMutation & { id: string; parsedVersion: number },
    operation: (tx: SyncTransaction) => Promise<unknown>,
  ) {
    const signature = JSON.stringify({
      path: input.path,
      method: input.method,
      body: input.body ?? null,
      version: input.parsedVersion,
    });
    return this.database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${actor.shopId},161))`,
      );
      const previous = await tx.execute(
        sql`select *, request=${signature}::jsonb as matches from document_mutations where shop_id=${actor.shopId}::uuid and id=${input.id}::uuid`,
      );
      if (previous[0]) {
        if (previous[0].user_id !== actor.userId || !previous[0].matches)
          throw conflict('Sync request ID was already used');
        return {
          status: Number(previous[0].status),
          body: previous[0].response,
        };
      }
      if (input.documentId) {
        const table = {
          receipt: 'receipts',
          recipe: 'recipes',
          order: 'orders',
        }[input.kind];
        await tx.execute(
          sql`select id from ${sql.identifier(table)} where shop_id=${actor.shopId}::uuid and id=${input.documentId}::uuid for update`,
        );
        const versions = await tx.execute(
          sql`select * from document_versions where shop_id=${actor.shopId}::uuid and kind=${input.kind} and id=${input.documentId}::uuid`,
        );
        if (
          !versions[0] ||
          versions[0].deleted ||
          Number(versions[0].updated_at) >= input.parsedVersion
        )
          return { status: 200, body: { syncConflict: true } };
      }
      await tx.execute(
        sql`select set_config('neuton.sync_version',${String(input.parsedVersion)},true)`,
      );
      await tx.execute(
        sql`select set_config('neuton.sync_document_id',${input.documentId ?? ''},true)`,
      );
      const body = await operation(tx);
      await tx.execute(
        sql`insert into document_mutations(shop_id,id,user_id,request,response,status) values (${actor.shopId}::uuid,${input.id}::uuid,${actor.userId}::uuid,${signature}::jsonb,${JSON.stringify(body)}::jsonb,${input.status})`,
      );
      return { status: input.status, body };
    });
  }
}
