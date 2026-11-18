-- The additive orderPricing projection changes recipe snapshots even when no
-- recipe row changed. Pull existing active snapshots through normal sync once.
-- Preserve future client revisions, tombstones, and all financial records.
UPDATE document_versions
SET updated_at = greatest(updated_at + 1,
  floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
WHERE kind = 'recipe' AND NOT deleted;
