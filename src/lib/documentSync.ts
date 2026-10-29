export type DocumentMeta = {
  kind: 'receipt' | 'recipe' | 'order';
  id: string;
  updatedAt: number;
  deleted?: boolean;
  baseUpdatedAt?: number;
};

const key = (document: DocumentMeta) => `${document.kind}:${document.id}`;

/** Tombstones win over offline edits: deleted domain records cannot be recreated by a patch. */
export function compareDocuments(
  local: DocumentMeta[],
  server: DocumentMeta[],
) {
  const localById = new Map(local.map((document) => [key(document), document]));
  const serverById = new Map(
    server.map((document) => [key(document), document]),
  );
  const toPush: DocumentMeta[] = [];
  const toPull: DocumentMeta[] = [];
  for (const remote of server) {
    const own = localById.get(key(remote));
    if (
      !own ||
      (remote.deleted && !own.deleted) ||
      (own.baseUpdatedAt !== undefined && remote.updatedAt !== own.baseUpdatedAt) ||
      remote.updatedAt > own.updatedAt
    )
      toPull.push(remote);
    else if (own.updatedAt > remote.updatedAt && !remote.deleted)
      toPush.push(own);
  }
  for (const own of local) {
    if (!serverById.has(key(own)) && !own.deleted)
      toPull.push({ ...own, deleted: true });
  }
  return { toPush, toPull };
}
