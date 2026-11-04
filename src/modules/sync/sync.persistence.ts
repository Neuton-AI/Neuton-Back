import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { DocumentMeta } from '../../lib/documentSync.js';
import type { SyncMutation } from './contracts.js';
import { conflict } from '../../lib/errors.js';
import type { ActorContext } from '../identity/contracts.js';
import type { ShopTransaction } from '../../db/types.js';
import { withShopTransaction } from '../../db/tenant-context.js';
import { requireActorRole } from '../identity/authorization.js';
import { queryRows } from '../../db/query-rows.js';
import { z } from 'zod';
export const SYNC_DATABASE = Symbol('SYNC_DATABASE');
export type SyncTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];
@Injectable()
export class SyncPersistence {
  constructor(@Inject(SYNC_DATABASE) readonly database: Database) { }
  async version(shopId: string, kind: DocumentMeta['kind'], id: string): Promise<number | undefined> {
    const rows = await this.database.execute(sql`select updated_at from document_versions where shop_id=${shopId}::uuid and kind=${kind} and id=${id}::uuid`);
    return rows[0] ? Number(rows[0].updated_at) : undefined;
  }
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
    currentActor: ActorContext,
    input: SyncMutation & { id: string; parsedVersion: number },
    operation: (tx: ShopTransaction) => Promise<unknown>,
  ) {
    const signature = JSON.stringify({
      path: input.path,
      method: input.method,
      body: input.body ?? null,
      version: input.parsedVersion,
      ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
    });
    return withShopTransaction(this.database, currentActor.session, currentActor.shop.id, async scope => {
      requireActorRole({ ...currentActor, role: scope.role }, input.allowedRoles ?? ['owner', 'admin']);
      const tx = scope.database;
      const actor = { shopId: scope.shopId, userId: scope.userId };
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${actor.shopId},161))`,
      );
      const previous = await queryRows(tx,
        sql`select *, request=${signature}::jsonb as matches from document_mutations where shop_id=${actor.shopId}::uuid and id=${input.id}::uuid`,
        z.object({ user_id: z.string(), matches: z.boolean(), status: z.number(), response: z.unknown() }),
      );
      if (previous[0]) {
        if (previous[0].user_id !== actor.userId || !previous[0].matches) {
          throw conflict('Sync request ID was already used');
        }
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
        const versions = await queryRows(tx,
          sql`select * from document_versions where shop_id=${actor.shopId}::uuid and kind=${input.kind} and id=${input.documentId}::uuid`,
          z.object({ updated_at: z.coerce.number().int(), deleted: z.boolean() }),
        );
        if (
          !versions[0] ||
          versions[0].deleted ||
          (input.baseVersion !== undefined && Number(versions[0].updated_at) !== input.baseVersion) ||
          Number(versions[0].updated_at) >= input.parsedVersion
        ) {
          return { status: 200, body: { syncConflict: true } };
        }
      }
      await tx.execute(
        sql`select set_config('neuton.sync_version',${String(input.parsedVersion)},true)`,
      );
      await tx.execute(
        sql`select set_config('neuton.sync_document_id',${input.documentId ?? ''},true)`,
      );
      const body = await operation(scope);
      await tx.execute(
        sql`insert into document_mutations(shop_id,id,user_id,request,response,status) values (${actor.shopId}::uuid,${input.id}::uuid,${actor.userId}::uuid,${signature}::jsonb,${JSON.stringify(body)}::jsonb,${input.status})`,
      );
      return { status: input.status, body };
    });
  }
}
