# Backend API and Interface Design Audit

Date: 22 October 2026  
Repository: `Neuton-Back`  
Reviewed commit: `3e11cffd990f17e5d70a6fb7cf27484ac103cbb7`  
Standard: `.agents/skills/api-and-interface-design/SKILL.md` in the parent workspace

## Verdict

**The backend partially follows the skill, but does not yet meet its full verification checklist.** Its strongest areas are shared error handling, Zod request validation, partial-update semantics, domain-specific route grouping, and durable retry protection for grouped uploads. The largest gaps are explicit output contracts, consistent pagination, validation of model responses, and retry safety outside the newer synchronization/upload flows.

There are also concrete behavior defects: string query flags such as `includeInactive=false` evaluate to true; stock adjustments can partially apply and then apply again on retry; and order verification can overwrite a concurrent cancellation. These deserve attention before cosmetic naming changes.

This report contains **13 findings: 4 high priority, 6 medium priority, and 3 low priority**. High priority means a plausible data-integrity, isolation, or processing failure that should be addressed first; it does not mean every finding has been reproduced against production. Evidence and verification limits are stated individually.

## Scope and method

- Read all five route modules, application registration, authentication and synchronization plugins, environment parsing, error handling, and relevant database schemas/migrations.
- Traced upload creation/completion, queue identity and worker completion protection, receipt verification, recipe costing, and Gemini extraction boundaries.
- Reviewed relevant tests and existing recipe/synchronization documentation.
- Inventoried 44 explicit HTTP registrations: 42 in domain route files, one synchronization route, and `/health`. Automatically generated HEAD/OPTIONS routes are excluded.
- Ran both TypeScript checks and nine focused test files: **82 tests passed, zero failed or skipped**.
- Ran local probes for boolean coercion and real `buildApp` error responses.

The audit assessed source and local behavior. It did not call live providers, mutate an application database, apply migrations, or verify production database privileges. Tests were launched from `Neuton-Back/Temp` so the backend root `.env` was not automatically loaded; test bootstrap supplied missing configuration with placeholders. No application code was changed.

The skill's TypeScript examples are assessed as design principles, not a requirement to copy every sample literally. Offset pagination can satisfy pagination, and an explicitly documented domain command can reasonably use POST. Historical development order cannot be proven from a source snapshot, so “contract first” is assessed through the committed contract artifacts available today.

## Skill compliance matrix

| Skill requirement | Assessment | Evidence / qualification |
| --- | --- | --- |
| Typed input and output schemas for every endpoint | Partial | Request Zod schemas are widespread; public response DTOs/schemas and route reply contracts are largely absent. F5. |
| One consistent error format | Mostly aligned | Shared `{ error: { code, message, details?, traceId? } }`; database constraint classification and 404 correlation remain inconsistent. F8, F12. |
| Validate external input at boundaries | Partial | Request/config parsing is strong; model JSON is cast before adequate structural checks. F3. Related-resource ownership is inconsistent. F4. |
| Avoid repeated internal shape validation | Mostly aligned | No broad pattern of redundant Zod parsing between already-typed utilities was found. Some domain invariants are checked in services, appropriately. |
| Paginate collection endpoints | Partial | Orders and receipts support bounded limit/offset; catalog collections and sync discovery remain unbounded. F6. |
| Prefer additive optional evolution | Mixed / history not fully audited | Optional sync headers preserve ordinary requests, but committed docs describe removed routes/fields requiring coordinated releases. F10. |
| Predictable naming | Partial | Mostly plural resource routes and camelCase fields; snake_case query exception, lowercase enums, and mixed boolean conventions remain. F11. |
| Commit API documentation or types alongside implementation | Partial | Useful domain documents exist; no complete HTTP contract or OpenAPI specification was found. F5. |
| Mutations honor a retry key or document unsafe retries | Partial | Strong grouped upload and optional sync support; ordinary create/delta operations lack a complete retry contract. F1, F7. |
| Claim retry identity atomically | Aligned in reviewed protected paths | Upload insert uses uniqueness; sync serializes with a transaction advisory lock and has a composite primary key. Do not misclassify its locked SELECT/INSERT as an unguarded race. |
| Reject the same identity with different payloads | Aligned in reviewed protected paths | Upload metadata comparison and sync JSONB request/user comparison reject mismatches. |
| Deliberate in-flight duplicate behavior | Partial | Upload claims/row locks and sync advisory locks serialize callers; sync waits have no explicit API-level bound/status contract. F7. |
| Retention outlives every replay path | Partially demonstrated | Sync mutation rows have no TTL and survive until shop deletion; grouped uploads persist processed state. No complete retention/replay policy across legacy processing was found. F7. |
| Discriminated unions for variants | Improvement opportunity | Media jobs and overloaded upload requests allow invalid combinations of kind and optional fields. F9. |
| Separate input from output | Partial | Request schemas differ from DB models, but responses commonly expose full DB rows. F5. |
| Branded IDs | Not observed | UUID validation exists; internal shop/user/recipe IDs remain interchangeable strings. Optional improvement under F9. |
| One-Version Rule | Broadly aligned | One HTTP prefix, `/api/v1`, and extension through optional headers; no parallel v2 API was found. Legacy/grouped upload branches still add contract complexity. |

## Detailed findings

### F1 — High: Stock adjustments are neither atomic as a batch nor safe to retry

**Skill:** Retry safety, consistent failure semantics, explicit mutation contracts.

**Evidence:** `src/routes/catalog.ts:793–835`, especially the independent UPDATE loop beginning at line 818. `src/plugins/documentSync.ts:29–39` does not select `/inventory/adjust` for sync deduplication.

The endpoint applies each `deltaQuantity` independently. There is no encompassing transaction or durable request identity. If the first update succeeds and a later update fails, the response can be a server error even though stock has changed. Retrying the same request applies successful earlier deltas again. A fully successful response lost in transit has the same replay problem. IDs outside the shop are silently skipped, and duplicate IDs within a batch are applied repeatedly.

**Example:** Starting with stock 10, `{ deltaQuantity: 5 }` changes it to 15. A retry after a lost response changes it to 20. With two items, failure on the second write leaves a partially completed batch.

**Recommendation:** Model a stock adjustment batch as a durable resource or mutation with a client-stable identity, payload comparison, and unique claim. Apply all accepted adjustments and record the response in one transaction. Specify whether unknown/foreign IDs reject the entire batch or produce explicit per-item results, and whether duplicate IDs are rejected or combined.

**Verification:** Source-confirmed execution path; no live stock was modified. Add a transaction rollback test, same-key replay test, changed-payload test, and concurrent duplicate test against a disposable database.

### F2 — High: Order verification can overwrite concurrent cancellation

**Skill:** Intentional observable behavior and stable state-transition contracts.

**Evidence:** `src/routes/orders.ts:386–414` reads the status, checks it in JavaScript, then updates by order/shop ID without a status predicate or row lock. Cancellation locks the row at `src/routes/orders.ts:440–459`.

The promised lifecycle makes cancelled orders terminal. However, an ordinary verification can read `processing`, a cancellation can commit `cancelled`, and verification can then write `delivered`. This revives a cancelled order and can change whether analytics counts it as a sale. Optional sync serialization does not protect requests that omit the sync headers.

**Recommendation:** Make the transition atomic using an UPDATE conditional on the expected status (and non-deleted state), or perform the status read and update under a row lock in one transaction. Return a documented conflict when the state changed. Audit only a transition that actually occurred.

**Verification:** Source-confirmed race schedule, not reproduced against a live database. Existing sequential tests in `scripts/orders.test.ts` cover already-cancelled orders, but do not establish concurrent correctness. Add a two-connection verification/cancellation race test.

### F3 — High: Gemini JSON is trusted as a TypeScript type before structural validation

**Skill:** Always validate third-party responses before business logic.

**Evidence:** `src/lib/gemini.ts:245–250`, `324–348`, and `373–405`.

`parseJson<T>` returns `JSON.parse(...) as T`. The provider's requested `responseSchema` is not a local runtime guarantee. Receipt extraction immediately calls `raw.items.map`, calculates a unit price by dividing unvalidated raw fields, and copies `item.baseUnit` directly into a typed output.

- `{}`, `null`, `{ items: null }`, or `{ items: [null] }` can fail after the model call has been accepted as successful.
- Zero quantity can produce non-finite unit prices; currency-formatted values are divided before the existing `asNumber` normalization is applied.
- An arbitrary `baseUnit` string can cross the boundary despite the declared unit type.
- Structural failures occurring after `runStructured` returns are outside its model-fallback attempt, so they do not take the same fallback path as unusable JSON.

Recipe/order extraction has more defensive normalization, which is good, but still lacks a complete locally enforced shape/domain contract.

**Recommendation:** Parse provider JSON as `unknown`; validate and normalize it inside each model attempt, before accepting the response. Compute derived prices only from validated finite values with an explicit zero/unknown policy. Convert invalid provider output into the established unusable-response path. Preserve the useful text sanitization and normalization already present.

**Verification:** Source-confirmed. `scripts/gemini.test.ts` tests `asNumber`, not the complete receipt response boundary. Add mocked provider cases for missing/null arrays, null elements, invalid enums, formatted numbers, zero denominators, and model fallback after schema failure.

### F4 — High: Related-resource ownership validation differs across recipe write paths

**Skill:** Validate semantic input at the system boundary and make interfaces hard to misuse.

**Evidence:** `src/routes/catalog.ts:34–44`, `270–310`, `378–385`, and `724–742`; `src/db/schema/catalog.ts:70–75` and `128–137`; `src/routes/catalog.ts:135–150` joins inventory by ID. The RLS policies in `drizzle/0001_auth_and_rls.sql:203–225` check the row's own shop membership.

Recipe PATCH explicitly checks that referenced inventory IDs belong to the active shop. Recipe creation and ingredient replacement during verification do not perform the equivalent check. Category IDs are also UUID-validated without the same-shop ownership check on the reviewed recipe/inventory write paths. The declared foreign keys link IDs, without enforcing equality of the two rows' shop IDs.

This leaves an inconsistent semantic boundary. If a caller supplies a valid ID from another shop and the server database role permits it, a cross-shop relationship can be saved. Costing joins may then expose the linked inventory name, stock quantity, or cost. A row's own `shopId` passing membership policy does not itself prove that all referenced rows belong to that shop.

**Recommendation:** Use one service operation for validating and saving recipe links across create, PATCH, and verify. Validate category ownership as well. Consider composite tenant-aware constraints where appropriate, and scope related-table joins defensively.

**Verification:** Missing application checks and schema limitations are source-confirmed. Cross-tenant exploitation was **not** tested, and actual exposure depends on deployed database privileges/policies. Verify with two tenants in a disposable database, rather than assuming enabled RLS closes the relationship gap.

### F5 — Medium: Public outputs are inferred from implementation and database rows

**Skill:** Contract first, input/output separation, avoid leaking implementation details, Hyrum's Law.

**Evidence:** Full-row responses/spreads at `src/routes/shops.ts:139–146`, `src/routes/catalog.ts:250–267`, `328–348`, and `src/routes/receipts.ts:315–351`. `costRecipe` accepts `typeof recipes.$inferSelect` at `src/routes/catalog.ts:110–116`. No HTTP `schema.response`, route `Reply` contracts, complete OpenAPI artifact, or shared HTTP-contract package was found in the reviewed source/docs.

The request schemas provide a useful foundation, but output shapes are mostly whatever a query or handler returns. Adding a database column can make it public through `.select()` and object spread without an explicit interface decision. Database decimals are commonly strings, while derived values can be numbers or formatted strings; those representations need explicit per-field contracts. Documentation already describes some decimal semantics, but not the whole API.

Different endpoints may reasonably return different resources or summaries. The issue is that those differences and their wire types are not centrally specified or enforced—not that every success response must use the same envelope.

**Recommendation:** Introduce explicit request and response DTOs/schemas per resource, with serializers that select public fields. Declare ISO timestamp, decimal, nullable, and omitted-field semantics. Generate API documentation from those contracts, and cover representative serialized responses with contract tests. Keep ORM insert/select types inside persistence boundaries.

**Verification:** Repository-wide searches and route reads. This shows missing explicit artifacts, not proof that implementation historically preceded design.

### F6 — Medium: Catalog collections lack pagination; recipes amplify this with per-row queries

**Skill:** Paginate list endpoints from the start.

**Evidence:** `src/routes/catalog.ts:214–222`, `236–267`, `541–575`, `755–789`; `src/plugins/documentSync.ts:137–158`; `src/routes/orders.ts:143–186`; `src/routes/receipts.ts:294–324`.

Categories, recipes, inventory, and orderable recipes return all matching rows. The recipe list invokes a separate costing query per recipe. The orderable list additionally reloads each recipe before costing it. Sync check caps the submitted documents at 20,000 but reads all server metadata for the shop and may return an unbounded set of changes.

Orders already offer bounded limit/offset plus total count. Receipts offer bounded limit/offset but no total/continuation metadata. Recent orders is a deliberately bounded dashboard summary; it does not need to be treated as a full collection endpoint.

**Recommendation:** Add a shared pagination contract to full collection endpoints with stable ordering/tie-breakers and documented continuation metadata. Batch ingredient/cost reads within each page. Define a paged or chunked sync protocol that still preserves deletion and comparison correctness; do not simply truncate server metadata.

**Verification:** Source-confirmed query structure; no performance benchmark was performed. Existing offset pagination is credited and is not incorrectly classified as absent.

### F7 — Medium: Retry guarantees are strong in selected paths but incomplete as an API-wide contract

**Skill:** Durable intent identity, atomic claims, payload matching, unknown outcomes, explicit retention/in-flight behavior.

**Evidence:** `src/plugins/documentSync.ts:29–133`; `src/db/schema/sync.ts:36–50`; `src/lib/mediaUploads.ts:95–188`; `src/lib/queue.ts:45–49`, `78–91`; `src/worker.ts:715–731`; ordinary creates in `src/routes/shops.ts:82`, `catalog.ts:224`, `270`, `578`, and `orders.ts:280`; legacy completion at `src/routes/receipts.ts:153–256`.

What is done well:

- Grouped upload creation claims a stable client request ID with a unique insert and compares kind, order ID, and source metadata before reuse.
- Grouped completion records readiness before dispatch, reuses a stable queue job ID, and the worker records processed state with business writes under a row lock/transaction.
- Sync retries serialize through a shop advisory transaction lock, compare request/user identity, and commit the business change and stored response together. The primary key supplies an additional uniqueness guarantee.
- Sync mutation records have no time-based expiry in the reviewed schema. There is no evidence of a too-short TTL there.

Remaining gaps:

- Without optional sync headers, order creation can create another order on retry. Several other creates also lack replay identities; a uniqueness violation on a duplicate name is not a replayed successful response.
- The legacy upload completion branch does not supply a grouped upload identity and therefore does not get the same durable worker deduplication guarantee.
- There is no complete endpoint-by-endpoint safe/unsafe retry policy. `/uploads/complete` saying to call it after a successful PUT does not define retry behavior after an unknown POST outcome.
- Sync in-flight callers wait behind a shop-wide lock, with no explicit bounded API-level wait or documented pending/409 alternative.
- Queue completed-job retention is one day (also count-limited), and failed jobs are retained seven days. Those numbers alone are not a dedupe guarantee. Grouped uploads have durable `processedAt` protection; legacy jobs need a separate replay analysis.

**Recommendation:** Document retry behavior for every mutating operation and prioritize durable identity on non-idempotent creates/deltas. Reuse the established mechanisms where their scope fits. Publish in-flight/timeout behavior and retention rules covering database records, queue removal, failed-job replay, and manual redispatch. Do not add a header that is silently ignored or an arbitrary TTL without this analysis.

**Verification:** Static trace plus passing upload/queue tests. Real sync concurrency/rollback tests require `SYNC_TEST_DATABASE_URL`; they were not run.

### F8 — Medium: Expected database conflicts become generic 500 errors

**Skill:** Consistent HTTP and machine-readable error semantics.

**Evidence:** `src/lib/errorHandler.ts:40–81`; unique category names at `src/db/schema/catalog.ts:27–28`; category insert at `src/routes/catalog.ts:224–233`; explicit duplicate handling in `src/routes/catalog.ts:435–439` provides a contrasting good example.

The shared error handler correctly maps Zod errors, AppErrors, framework 4xx errors, transient database failures, and unexpected failures. It does not classify ordinary unique/FK constraint errors. Creating a duplicate category therefore reaches the unexpected-error branch rather than a predictable 409. A syntactically valid but nonexistent related ID can similarly become a 500 instead of a deliberate domain error.

The body envelope is consistent in these cases; the semantic classification is not. Generic 500 redaction is good and should be retained.

**Recommendation:** Translate known constraint failures into stable domain codes/statuses at the owning service boundary, or through a constrained shared mapper. Keep unknown constraints as internal errors. Avoid exposing SQL, table/constraint names, or raw provider error messages. Password updates currently pass `updateError.message` directly to `badRequest` at `src/routes/shops.ts:267`; map known provider failures to application-owned codes/messages there too.

**Verification:** Source-confirmed mapping gap; no duplicate was inserted into an application database. Add tests for duplicate category/recipe/inventory names and invalid related IDs.

### F9 — Medium: Synchronization depends on route internals rather than explicit application-service contracts

**Skill:** Stable module interfaces, explicit variant types, input/output separation.

**Evidence:** `src/plugins/documentSync.ts:29–133`; `src/lib/queue.ts:27–40`; `src/routes/catalog.ts:110–116`, `355`, `687`; `src/routes/receipts.ts:64–85`; `src/routes/orders.ts:61–77`.

The sync plugin selects routes by URL regex, imports dependency defaults from route modules, injects database transactions through request decorations, casts transaction objects to the root DB type, and intercepts handler replies through `Object.create(reply)`. Recipe writes use a decoration named `receiptsDeps`. These mechanisms work with the current handlers but make route naming, reply method usage, and handler return style implicit internal interfaces.

There is a concrete transaction-boundary consequence: synchronized receipt/recipe deletion runs the existing handler inside the outer sync transaction. That handler deletes R2 objects after its inner business transaction/savepoint, before the outer mutation-record insert and commit. If the outer transaction later fails, database deletion can roll back after the external object is already removed. See `src/routes/receipts.ts:373–416`, `src/routes/catalog.ts:500–527`, and the mutation insert at `src/plugins/documentSync.ts:128`.

The media job interface also allows `kind: 'order'` without `orderId`, since kind and optional fields are independent. The upload boundary later rejects this for grouped requests, rather than making the invalid combination unrepresentable internally.

**Recommendation:** Extract typed domain operations accepting an explicit transaction-capable context and returning typed results. Have ordinary HTTP and sync adapters call those operations. Schedule external cleanup through a durable post-commit outbox. Define discriminated job/upload variants for order targets and grouped versus legacy sources. Consider branded IDs at service interfaces after the larger boundary issues are addressed.

**Verification:** Source-confirmed coupling and rollback ordering; no R2 objects were deleted. Existing upload/route tests do not establish safe outer-transaction rollback for external cleanup. Add an injected outer-commit/mutation-insert failure test and assert no premature cleanup.

### F10 — Low: Compatibility is documented as coordinated replacement, not a consumer deprecation contract

**Skill:** Prefer additive evolution, Hyrum's Law, plan deprecation at design time.

**Evidence:** `README.md:12–15` describes removal of generic verification/order-status routes. `docs/recipe-field-contract.md` describes renamed/removed fields and requires coordinated backend/frontend deployment with old runtimes paused.

These documents are candid and useful, but they describe coordinated breaking changes. They do not define an overlap window, consumer inventory, retirement notice, or contract-diff gate. The snapshot alone cannot establish whether those releases broke any real consumer or were safe pre-release migrations.

**Recommendation:** For future public changes, use additive fields/aliases and one canonical implementation during a documented transition, then retire old behavior after consumer migration evidence. Record intentional breaking exceptions and deployment constraints. Avoid introducing a parallel API version merely to rename fields.

**Verification:** Documentation evidence; no historical client compatibility test or complete Git-history audit was performed.

### F11 — Low: Naming diverges from the skill in several observable places

**Skill:** Predictable camelCase fields/queries, plural resource nouns, prefixed booleans, UPPER_SNAKE enum values.

**Evidence:** `src/routes/shops.ts:279–281` accepts `distance_km`; `src/db/schema/enums.ts` defines lowercase statuses/roles; `src/routes/catalog.ts:180–206` returns `costComplete`, `inStock`, and `linked`; routes include `/inventory/adjust`, `/sync/check`, and `/:id/verify`.

Most fields and resource routes are already consistent. Some command routes are intentional domain operations and are documented in README, so their presence is a convention deviation rather than proof of a broken design. The snake_case query parameter is a clearer inconsistency. Lowercase enums and existing boolean names differ from the requested skill even if consistently used within a domain.

**Recommendation:** Write down the chosen project conventions. Use camelCase for new query parameters and aliases for existing names when migration is worthwhile. Do not uppercase existing enum values or rename established response fields in place merely to match the skill. Treat those names as consumer contracts.

**Verification:** Static inspection. Severity is low because compatibility and correctness take precedence over cosmetic uniformity.

### F12 — Low: Unknown-route errors omit the ordinary trace correlation fields

**Skill:** Consistent error semantics and intentional public behavior.

**Evidence:** `src/app.ts:79–84` sends its own 404 body; `src/lib/errorHandler.ts:40–43`, `88–103` add correlation data for handled errors.

With the same `x-trace-id: audit-probe` request header:

| Request | Status | Body `error.traceId` | Response `X-Trace-Id` |
| --- | --- | --- | --- |
| `GET /api/v1/receipts` without credentials | 401 | `audit-probe` | `audit-probe` |
| `GET /api/v1/does-not-exist` | 404 | Absent | Absent |

The core `{ error: { code, message } }` shape is preserved. This is a narrower inconsistency in correlation guarantees, and contradicts the nearby claim that every error body includes trace correlation.

**Recommendation:** Reuse the shared envelope/correlation helper in the not-found handler and test both the body and header.

**Verification:** Reproduced through the actual `buildApp` with local Fastify injection.

### F13 — Medium: Boolean query strings use truthiness rather than their stated values

**Skill:** Validate external input at boundaries and preserve predictable filtering semantics. This is a concrete behavior defect and should be fixed early alongside collection/filter boundary work.

`src/routes/catalog.ts:241–242` and `546–547` use `z.coerce.boolean()`. Query values arrive as strings; JavaScript truthiness makes any nonempty string true.

| Input string | Actual parsed boolean |
| --- | --- |
| `false` | `true` |
| `true` | `true` |
| `0` | `true` |
| `1` | `true` |
| Empty string | `false` |

Consequently, `GET /recipes?includeUnverified=false` includes unverified records, `includeInactive=false` includes inactive records, and `GET /inventory?lowStockOnly=false` still applies the low-stock filter. This changes observable filtering semantics.

Use an explicit string-to-boolean boundary schema with documented accepted spellings, preserving booleans for internal typed calls where needed. Add route-level cases for omitted/true/false/invalid input. The table above was reproduced with the locally installed Zod version and the same schema expression; full authenticated database queries were not executed.

## Endpoint inventory and coverage

All domain endpoints below use `/api/v1`. “Reviewed” means source inspected; it does not imply every endpoint was executed against a real database.

| Module | Explicit registrations | Contract observations |
| --- | --- | --- |
| `shops.ts` | `GET /session`; `POST /shops`; `GET, PATCH /shop`; `GET, PATCH /profile`; `POST /profile/password`; `GET /shop/delivery-preview` | 8 routes. Zod mutation inputs; explicit identity context; DB-shaped outputs; snake_case distance query; no complete retry declaration. |
| `catalog.ts` | `GET, POST /categories`; `GET, POST /recipes`; `GET, PATCH, DELETE /recipes/:id`; `POST /recipes/:id/manual-product`; `POST /recipes/:id/barcode-price`; `GET, POST /inventory`; `PATCH, DELETE /inventory/:id`; `POST /recipes/:id/verify`; `GET /recipes/orderable`; `POST /inventory/adjust` | 16 routes. Strong request parsing/PATCH checks in places; output/pagination/ownership/retry inconsistencies. |
| `receipts.ts` | `POST /uploads/presign`; `POST /uploads/complete`; `POST /receipts/:id/verify`; `GET /receipts`; `GET, DELETE /receipts/:id`; `GET /receipts/:id/status`; `GET /receipts/queue/pending-count`; `POST /uploads/download-url` | 9 routes. Bounded receipt list; authorization around downloads; grouped and legacy upload contracts share routes. |
| `orders.ts` | `GET, POST /orders`; `GET, DELETE /orders/:id`; `POST /orders/quote`; `POST /orders/:id/verify` | 6 routes. Bounded list with total, positive integer quantities, snapshotted line names and atomic number allocation; transition race remains. |
| `analytics.ts` | `GET /analytics/dashboard`; `GET /analytics/recent-orders`; `GET /analytics/inventory-value` | 3 routes. Explicit period validation, bounded recent summary and aggregate endpoints. Aggregates do not require collection pagination. |
| `documentSync.ts` | `POST /sync/check` | 1 route plus wrappers around selected mutations. Explicit metadata schema, but no paged discovery response. |
| `app.ts` | `GET /health` | 1 route outside the API prefix. Simple stable response. |

## Positive patterns worth retaining

1. **Central error translation is registered before routes.** This protects real route contexts, not just synthetic probes. The error-handler regression tests exercise the real application.
2. **Configuration is parsed at startup.** `src/env.ts:15–137` establishes required configuration and types before normal service use. This follows the boundary-validation principle.
3. **Request schemas handle domain constraints.** Examples include ordered recipe steps, exclusive ingredient price sources, upload byte/source limits, UUID parameters, and whole-unit order quantities.
4. **PATCH distinguishes omitted fields from explicit null.** Recipe, inventory, shop, and profile paths largely preserve unspecified fields rather than resetting them to create defaults.
5. **Authorization is reusable and separate from bodies.** Authenticate/shop/role guards provide clear request context. Domain writes generally restrict ownership explicitly.
6. **Receipt verification is transactionally guarded.** `src/lib/verifyReceipt.ts:79–88` locks the receipt and rejects already-verified requests, preventing repeated inventory application. A 409 is different from replaying the original response, but the core stock protection is present.
7. **Order numbering and historical names are deliberate contracts.** A transaction allocates the per-shop number; saved line names preserve history across recipe renames. This is good handling of observable behavior.
8. **Grouped upload processing addresses crash/redelivery risk.** Stable IDs, durable readiness, source metadata checks, and transactionally stored processed state are substantially stronger than merely accepting a retry header.
9. **External feed conversion has meaningful validation.** `src/lib/supermarket/productConversion.ts:5–41` rejects invalid numbers, unknown conversions, overflow, and rounded-to-zero measurements. The third-party validation finding should not be generalized into a claim that all integrations lack checks.
10. **Committed domain documentation explains non-obvious semantics.** Recipe null/unresolved costing, sync conflicts, tombstones, and deployment prerequisites are documented alongside implementation.

## Recommended implementation order

1. Fix stock batch atomicity/replay, order transition concurrency, model-response validation, and tenant-aware link validation. Include disposable-database tests for concurrent/ownership behavior.
2. Fix boolean query parsing and route external cleanup through a post-commit durable mechanism.
3. Define application-service contracts and explicit public response schemas, starting with orders, receipts, and recipe costing. Preserve current serialized behavior during extraction.
4. Add catalog pagination and batch costing reads; define sync chunking as a protocol change with client coordination.
5. Publish an endpoint retry matrix and fill the unsafe create/legacy upload gaps. State retention and in-flight duplicate rules explicitly.
6. Normalize expected conflict handling; add compatibility checks and documentation generation.
7. Address naming through additive aliases or explicit conventions, after correctness fixes.

## Verification record and limits

Executed successfully:

```text
npm run typecheck
npm run typecheck:test
```

Focused tests were executed from `Neuton-Back/Temp`:

```text
node --import ../node_modules/tsx/dist/loader.mjs --test \
  ../scripts/error-handler.test.ts \
  ../scripts/transient-db-errors.test.ts \
  ../scripts/queue.test.ts \
  ../scripts/media-uploads.test.ts \
  ../scripts/document-sync.test.ts \
  ../scripts/orders.test.ts \
  ../scripts/catalog.test.ts \
  ../scripts/gemini.test.ts \
  ../scripts/supermarket-client.test.ts

82 tests; 82 passed; 0 failed; 0 skipped.
```

The multiline command above uses shell-neutral visual continuation; on PowerShell run it on one line or replace continuation markers with backticks.

Additional local probes verified Zod boolean coercion and injected 401/404 responses through `buildApp`. They did not modify source files.

Not executed: the full test suite, production build output generation, real PostgreSQL concurrency/rollback/isolation tests, real Redis redelivery, live Gemini responses, R2 deletion, or migration application. In particular, `scripts/document-sync.integration.test.ts` requires an explicitly configured migrated disposable database. Passing the focused tests and typechecks does not prove the concurrency and tenant invariants identified above.

No fixes, commits, deployment, or application-data changes were made as part of this audit. The deliverable is this report.
