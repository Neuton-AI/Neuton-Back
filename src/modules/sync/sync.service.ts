import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { compareDocuments, type DocumentMeta } from '../../lib/documentSync.js';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { SyncPersistence, type SyncTransaction } from './sync.persistence.js';
import { syncVersionSchema, type SyncMutation } from './contracts.js';
export type CommitEffect = (effect: () => Promise<void>) => void;
@Injectable()
export class SyncService {
  constructor(
    @Inject(SyncPersistence) private readonly persistence: SyncPersistence,
  ) {}
  async check(actor: ActorContext, documents: DocumentMeta[]) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return compareDocuments(
      documents,
      await this.persistence.documents(actor.shop.id),
    );
  }
  async mutate<T>(
    actor: ActorContext,
    input: SyncMutation,
    operation: (tx?: SyncTransaction, afterCommit?: CommitEffect) => Promise<T>,
  ): Promise<{ status: number; body: unknown }> {
    requireActorRole(actor, input.allowedRoles ?? ['owner', 'admin']);
    if (input.mutationId === undefined)
      return { status: input.status, body: await operation() };
    const id = z.string().uuid().parse(input.mutationId),
      parsedVersion = syncVersionSchema.parse(input.version);
    const effects: Array<() => Promise<void>> = [];
    const result = await this.persistence.mutate(
      { shopId: actor.shop.id, userId: actor.user.id },
      { ...input, id, parsedVersion },
      (tx) =>
        operation(tx, (effect) => {
          effects.push(effect);
        }),
    );
    for (const effect of effects) {
      try {
        await effect();
      } catch {
        actor.log.error(
          { event: 'sync_commit_effect_failed' },
          'post-commit effect failed',
        );
      }
    }
    actor.log.info(
      { event: 'sync_mutation_completed', kind: input.kind, mutationId: id },
      'sync mutation completed',
    );
    return result;
  }
}
