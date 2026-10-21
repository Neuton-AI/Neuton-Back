# API/interface alignment — #172

Tasks tracked in [GitHub #172](https://github.com/Neuton-AI/Neuton-Back/issues/172). The audit report is the specification; preserve existing client wire contracts while fixing defects.

## Ordered phases

1. Correctness: atomic/replay-safe stock batches, atomic order transitions, validated model responses, and tenant-owned category/inventory links. Verify rollback, concurrent duplicates, payload mismatch, transition races, malformed model output, and two-tenant rejection.
2. Boundary/cleanup: explicit boolean query parsing and durable post-commit object deletion. Verify false/invalid query flags and outer transaction rollback.
3. Contracts: explicit service inputs/outputs and public response schemas, retaining serialized fields/types. Verify representative HTTP contracts and typechecks.
4. Collections: additive pagination and batched recipe costing; coordinated sync chunking without losing tombstones. Verify stable page boundaries and complete sync traversal.
5. Retry policy: document every mutation, fill non-idempotent create/legacy gaps, define in-flight waits and retention. Verify retry/unknown outcome behavior.
6. Error/docs: classify known conflicts, normalize correlation, generate API docs and compatibility checks. Verify stable error codes and contract diffs.
7. Naming: additive aliases and documented exceptions; no breaking enum/field renames. Verify old/new inputs and response compatibility.

Each phase depends on the previous phase. Within phase 1, each independent correctness fix is a separately tested slice. Run focused regression tests per slice and repository verification at checkpoints. Real database tests must use an explicitly configured disposable local database. Never migrate the developer's configured database.

## Decisions and risks

- Existing callers may omit retry identities. Keep old requests accepted but document unsafe retries; accept a durable client key for retry-safe stock changes.
- Retain retry receipts until the shop is deleted, matching the existing durable synchronization model.
- Tenant ownership checks belong in the shared write boundary, under locks so concurrent deletes cannot invalidate validation before the write.
- Keep this ticket's branch separate from the previously audited branch; base is local `origin/main`, matching the audited commit.
- Do not claim phase completion until its tests and verification pass. Database migrations are delivered as forward-only files; production application is outside this task.

## Progress

- [x] Ticket #172 created; branch `fix/B/n172-api-interface-alignment` opened.
- [ ] Phase 1
- [ ] Phase 2
- [ ] Phase 3
- [ ] Phase 4
- [ ] Phase 5
- [ ] Phase 6
- [ ] Phase 7
