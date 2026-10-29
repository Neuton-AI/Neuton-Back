# Spec: Live, complete document synchronization

Status: Implemented on feature/183-native-document-sync; local verification in SYNC-183-VERIFICATION.md.
Product issue: https://github.com/Neuton-AI/Neuton-Back/issues/183
Architecture decision tracking: https://github.com/Neuton-AI/Neuton-Back/issues/186
Selected approach: native PostgreSQL events plus full document-version comparison.

## Objective and confirmed intent

Shop users trust an open screen to reflect committed document changes without navigation,
refocus, or manual refresh. Update complete receipt, recipe, and order data, including
processing states, derived recipe costing, creation, deletion, and list membership.
Target visible updates within roughly 1–2 seconds of commit under normal connected
conditions. Offline and suspended browsers catch up automatically on reconnect/resume.
This is one end-to-end synchronization capability across backend and frontend.

Preserve immediate local edits and durable offline upload/mutation queues. Update fields
the user has not edited; retain their changes and flag competing edits to the same field.
Background sync requires no popup, browser notification permission, or success toast.
Conflicts are shown inline and remain available until resolved.

## Current implementation and affected structure

- Backend: NestJS, TypeScript, Drizzle/PostgreSQL, Supabase; BullMQ workers also write data.
- `src/modules/sync/{contracts,sync.controller,sync.service,sync.persistence}.ts`:
  current authenticated metadata comparison and idempotent mutation handling.
- `drizzle/0028_document_sync.sql`: document versions, tombstones and recipe dependency triggers.
- Backend tests live in `scripts/*.test.ts`; new migrations follow the existing journal conventions.
- Frontend sibling repository `Neuton-Front`: React 18, React Query 5, Supabase client,
  IndexedDB and Vitest. `src/features/sync/` owns local storage and synchronization.
- `documentsApi.ts` reads local documents, filters lists by status, and starts sync on reads.
- `engine.ts` compares shop metadata and protects queued writes. `types.ts` currently lacks
  a server base snapshot and explicit field conflict representation.
- Editors and processing queries must be audited: replacing a query cache alone does not
  update an editor's independent form state safely.

## Required behavior

1. Subscribe to shop-scoped committed-change hints, then catch up; buffer hints during
   bootstrap and drain again afterward so no subscription/bootstrap window loses changes.
2. Events trigger authoritative API reads. They are not authoritative document payloads.
   Coalesce bursts; duplicates, reordering and lost events must be harmless.
3. On startup, reconnect, resume, event-stream recovery and coalesced change hints, compare
   local/server document IDs and versions using the existing comparison flow. Download
   only changed complete documents; include deletion markers and dependency invalidations.
   Full metadata comparison is an accepted cost; periodic server polling is not the primary trigger.
4. Persist received documents safely in IndexedDB. Failed downloads/persistence leave
   documents eligible for retry on the next comparison. Do not advance a local server
   revision until its data is safely persisted. No durable catch-up cursor is required.
5. Make new/deleted documents and status-filtered lists visible without navigation.
   Refresh affected query views after persistence; prevent read/invalidation/refetch loops.
6. Serialize catch-up per scope across tabs and retain a dirty signal when a hint arrives
   during an active run. An in-flight run cannot swallow the final event.
7. Reconnect, startup and resume trigger catch-up. Document any low-frequency repair
   reconciliation as recovery only. Back off on errors without dropping pending work.
8. Dispose subscriptions and cancel/ignore old asynchronous results on logout, shop or
   account change and unmount. Token renewal must keep authorization current.
9. Replace processing server polling only once equivalent event coverage is verified.

## Edit protection and conflicts

Maintain the last authoritative base, current local draft, and incoming server value.
For each editable field: adopt incoming changes when the local value equals its base;
keep local changes when the server value equals its base; accept identical simultaneous
changes; otherwise retain the local value and record base/local/server conflict values.
Server-controlled status and derived fields refresh without becoming editable mutations.

Array rows need stable identity. Treat collections lacking stable identity as one conflict
unit rather than merging by index. Distinguish missing fields from explicit null values.
Remote deletion while dirty is a document-level conflict; retain a recoverable local copy
and do not silently resurrect it. Choosing local/server values must use the current server
revision and existing idempotency guarantees; queued writes must not blindly overwrite a
newer server value. Preserve editor drafts as well as already queued mutations.

## Native events and provider portability

Use PostgreSQL triggers on `document_versions` to call `pg_notify` for inserts/updates,
including tombstones and derived-cost invalidations. Notifications contain only a minimal
shop identifier, not document contents. They are delivered after commit; rolled-back
writes must produce no visible event. Existing document/dependency triggers remain the
source of coverage for backend, worker and direct database writes.

Each backend instance holds a dedicated PostgreSQL session running `LISTEN`. Use a direct
or session-pooled connection; transaction pooling cannot preserve LISTEN session state.
Keep listener configuration separate from the ordinary query pool. Reconnect with backoff;
after LISTEN is successfully restored, tell all attached browsers to reconcile, because
notifications during listener downtime are lost. Each instance listens and forwards to its
own connected browsers; do not distribute notifications through a competing-consumer queue.

The backend exposes an authenticated, shop-authorized SSE endpoint. The frontend uses
a fetch-based SSE client compatible with existing authorization headers; do not put tokens
in URLs. Events have an application-owned shape (ready/reconcile/document-change), with
no provider SDK types in the public contract. Heartbeats detect broken connections; they
do not query document versions. Ready/reconnect signals trigger full version comparison.

Separate the native PostgreSQL listener adapter from application event distribution, SSE
authorization/lifecycle, and the frontend synchronization scheduler. Keep interfaces small:
the listener reports shop invalidations and connection recovery; the distributor forwards
them to authorized sessions. PostgreSQL host changes require configuration changes, not
rewriting sync logic. A future non-PostgreSQL source replaces the listener adapter while
preserving the app event/API contracts; database triggers would need an equivalent there.

Do not depend on Supabase Realtime, its channels, replication publications, extensions,
or provider-specific SQL for sync. Existing authentication can remain as-is; this requirement
decouples synchronization transport from the database hosting and realtime provider.

## Version comparison and recovery contract

Reuse the authenticated `POST /api/v1/sync/check` comparison contract where practical.
Compare current document metadata, then fetch only changed authoritative documents.
Keep server-confirmed revisions distinct from draft timestamps so local edits cannot hide
remote changes. A fetched payload and its revision must describe the same server snapshot.
Never regress an already applied newer server snapshot or overwrite dirty fields.

Full comparisons avoid commit-order cursor assumptions: a late commit is discovered by
its event or a later recovery comparison. Subscribe before bootstrap comparison, retain
a dirty flag during work, and repeat if an event arrived while comparing/downloading.
An SSE ready response must follow active database-listener readiness. On listener failure,
mark the stream unavailable or emit a recovery signal once restored; never silently claim
a healthy stream across an unobserved gap.

No per-edit history, durable event log, sequence checkpoint, or replay cursor is added.
Maintain only current per-document metadata and deletion markers, as the existing model
does. Retain tombstones for offline clients; do not prune them without an explicit safe
rebuild protocol. Large-shop comparison must respect the current 20,000-item request cap:
chunk local metadata and deduplicate discoveries across chunks, or extend the comparison
protocol with bounded paging; never silently truncate or label incomplete results complete.
Any pagination must remain safe under concurrent writes and cannot infer deletion from a
single partial page. Local cache rebuild preserves drafts, queues, uploads and conflicts.

## Security and boundaries

- Always authorize SSE and comparison against current shop membership; scope local state
  to account/shop. Revalidate long-lived subscriptions on session expiry/membership changes;
  a channel name or event payload is not authorization. Bound comparison inputs.
- Always retain existing role restrictions, durable queues, error tracking and retry receipts.
- Never expose another shop's events/data, log document payloads/tokens, overwrite dirty
  data, weaken tests, or apply a production migration during local implementation.
- Selected transport: native LISTEN/NOTIFY through backend SSE. Full version comparison
  replaces the earlier incremental catch-up requirement in #183; no change-history storage.
- Excludes browser notifications, general notification infrastructure, unrelated inventory
  offline support, and guaranteed delivery to a disconnected device within two seconds.

## Commands and code style

Run in `Neuton-Back`: `npm run verify`; migration checks: `npm run db:validate`.
Run in `Neuton-Front`: `npm run verify`.
Development: backend `npm run dev` and `npm run dev:worker`; frontend `npm run dev`.
Use existing TypeScript conventions, Zod validation, injected backend services and
frontend scope helpers. Example existing boundary style:

```ts
return this.sync.check(actor, checkSchema.parse(body).documents);
```

## Validation and acceptance

- Backend tests: membership/role isolation, expiry/revocation, listener reconnect recovery,
  multi-instance fan-out, bounded comparisons, concurrent writes, rollback/no phantom events,
  deletes and dependency invalidations. Exercise native events on standard PostgreSQL
  without Supabase services; mock adapters only for unit-level transport tests.
- Frontend Vitest/fake-indexeddb: failed persistence retry, duplicate/reordered bursts,
  event-during-run, bootstrap races, reconnect, rebuild, token renewal, scope switches,
  cross-tab coordination and missed events during backend listener downtime.
- Merge/editor tests: untouched fields update, dirty fields survive, same-field conflicts,
  identical edits, stable-row collections, remote delete and offline reload/retry.
- Run existing offline/upload/conflict regressions and both repository verification suites.
- Real browser: two authenticated sessions in one shop; leave B idle while A edits and a
  worker changes pending/processing/unverified/failure states. Observe complete data and
  list membership within the target; repeat offline/reconnect and with a dirty editor.
- Verify with network traces that comparisons are triggered by events/lifecycle recovery,
  not periodic server polling, and only changed document payloads download. Test another shop cannot
  subscribe/fetch and old scopes cannot publish into the active view.
- Record measured commit-to-visible latency, environment, native listener/SSE setup,
  recovery, fallback and rollback. Unit tests alone do not establish end-to-end freshness.

## Selected decision and rollout checks

The user selected native PostgreSQL notifications plus version comparison, with sync
independent of Supabase. #186 tracks this architecture decision. Before rollout verify
session-capable database connectivity, proxy SSE buffering/timeouts, membership revocation
and large-shop comparison behavior. Deploy the backend and migration before the frontend.
