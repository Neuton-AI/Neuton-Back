import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { sql } from 'drizzle-orm';
import { currentShop, currentUser } from './auth.js';
import { compareDocuments, type DocumentMeta } from '../lib/documentSync.js';
import { conflict } from '../lib/errors.js';
import { defaultReceiptsDeps } from '../routes/receipts.js';
import { defaultOrdersDeps } from '../routes/orders.js';

const metaSchema = z.object({
  kind: z.enum(['receipt', 'recipe', 'order']),
  id: z.string().uuid(),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deleted: z.boolean().optional(),
});
const versionSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

/** Register before domain routes. Reuse their guards, validation and transactions. */
export function registerDocumentSync(app: FastifyInstance) {
  app.addHook('onRoute', (route) => {
    const method = Array.isArray(route.method) ? route.method[0] : route.method;
    const match = route.url.match(
      /\/(receipts|recipes|orders)\/:id(?:\/verify)?$/,
    );
    const createOrder = method === 'POST' && route.url.endsWith('/orders');
    if (
      (!match && !createOrder) ||
      !method ||
      !['POST', 'PATCH', 'DELETE'].includes(method)
    )
      return;
    const handler = route.handler;
    route.handler = async function (request, reply) {
      const mutationId = request.headers['x-sync-id'];
      // Existing clients keep their original contracts.
      if (!mutationId) return handler.call(this, request, reply);
      const id = z.string().uuid().parse(mutationId);
      const version = versionSchema.parse(request.headers['x-sync-version']);
      const shop = currentShop(request);
      const user = currentUser(request);
      const kind =
        match?.[1] === 'receipts'
          ? 'receipt'
          : match?.[1] === 'recipes'
            ? 'recipe'
            : 'order';
      const documentId = createOrder
        ? null
        : z
            .string()
            .uuid()
            .parse((request.params as { id: string }).id);
      const signature = JSON.stringify({
        path: request.url,
        method,
        body: request.body ?? null,
        version,
      });
      const mutationEffects: Array<() => Promise<void>> = [];
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${shop.id}, 161))`,
        );
        const previous = await tx.execute(
          sql`select *, request = ${signature}::jsonb as matches from document_mutations where shop_id=${shop.id}::uuid and id=${id}::uuid`,
        );
        if (previous[0]) {
          if (previous[0].user_id !== user.id || !previous[0].matches)
            throw conflict('Sync request ID was already used');
          return {
            status: Number(previous[0].status),
            body: previous[0].response,
          };
        }
        if (documentId) {
          // Domain row lock also serializes worker and ordinary online edits.
          const table =
            kind === 'receipt'
              ? 'receipts'
              : kind === 'recipe'
                ? 'recipes'
                : 'orders';
          await tx.execute(
            sql`select id from ${sql.identifier(table)} where shop_id=${shop.id}::uuid and id=${documentId}::uuid for update`,
          );
          const rows = await tx.execute(
            sql`select * from document_versions where shop_id=${shop.id}::uuid and kind=${kind} and id=${documentId}::uuid`,
          );
          if (
            !rows[0] ||
            rows[0].deleted ||
            Number(rows[0].updated_at) >= version
          ) {
            return { status: 200, body: { syncConflict: true } };
          }
        }
        await tx.execute(
          sql`select set_config('neuton.sync_version', ${String(version)}, true)`,
        );
        await tx.execute(
          sql`select set_config('neuton.sync_document_id', ${documentId ?? ''}, true)`,
        );
        request.receiptsDeps = {
          ...defaultReceiptsDeps,
          db: tx as unknown as typeof db,
        };
        request.ordersDeps = {
          ...defaultOrdersDeps,
          db: tx as unknown as typeof db,
          transaction: { db: tx, afterCommit: (effect) => { mutationEffects.push(effect); } },
        };
        request.receiptTransaction = { db: tx, afterCommit: effect => { mutationEffects.push(effect); } };
        request.catalogTransaction = { db: tx, afterCommit: effect => { mutationEffects.push(effect); } };
        // Delay sending until the business transaction and retry receipt commit together.
        let status = 200;
        let sent: unknown;
        const bufferedReply = Object.create(reply) as FastifyReply;
        // FastifyReply is thenable. Returning this buffer from an async
        // create handler must not wait for the real response before commit.
        Object.defineProperty(bufferedReply, 'then', { value: undefined });
        bufferedReply.code = (code: number) => {
          status = code;
          return bufferedReply;
        };
        bufferedReply.send = (body: unknown) => {
          sent = body;
          return bufferedReply;
        };
        const returned = await handler.call(this, request, bufferedReply);
        const body = sent ?? returned ?? null;
        await tx.execute(sql`insert into document_mutations(shop_id,id,user_id,request,response,status)
          values (${shop.id}::uuid,${id}::uuid,${user.id}::uuid,${signature}::jsonb,${JSON.stringify(body)}::jsonb,${status})`);
        return { status, body };
      });
      // The retry receipt can still fail after the domain handler returns.
      // Publish success effects only after that outer transaction commits.
      for (const effect of mutationEffects) await effect();
      return reply.code(result.status).send(result.body);
    };
  });

  app.post(
    '/api/v1/sync/check',
    { preHandler: [app.authenticate, app.resolveShop] },
    async (request: FastifyRequest) => {
      const { documents } = z
        .object({ documents: z.array(metaSchema).max(20000) })
        .parse(request.body);
      const rows = await db.execute(
        sql`select kind,id,updated_at,deleted from document_versions where shop_id=${currentShop(request).id}::uuid`,
      );
      const server = rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        updatedAt: Number(row.updated_at),
        deleted: row.deleted,
      })) as DocumentMeta[];
      return compareDocuments(documents, server);
    },
  );
}
