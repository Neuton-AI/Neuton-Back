# Separate inventory and recipe modules

Status: Accepted
Date: 2026-11-02

## Context

The combined catalog service owned stock management, recipe editing and
costing, and categories. Recipe-specific manual products and barcode prices
also lived in inventory persistence. A change to either domain required
understanding the combined service and its shared dependency injection.

## Decision

Use independent `InventoryModule`, `RecipeModule`, and `CategoriesModule`
registrations in `AppModule`. Each owns its controller, service, persistence,
validation schemas, DTOs, and database injection token.

Inventory owns stock reads, CRUD, and idempotent adjustments. Recipes own
recipe lifecycle, ingredients, costing, manual products, barcode prices,
and deletion. Categories remain available to both domains through their own
endpoints and existing foreign keys. Neither inventory nor recipes imports
the other's controller, service, persistence, or contracts.

Keep the existing database schema, ingredient links, shared link validation,
unit conversion, and inventory adjustment helpers. Database transaction types
live under `src/db`; best-effort audit writing lives under `src/lib`.
Recipe sync mutations continue binding persistence to the supplied transaction
and defer audit/log effects until commit. Category transaction binding retains
the same post-commit logging behavior.

## Alternatives considered

- Retaining a catalog facade would leave a second owner of both domains and
  require consumers to choose between combined and domain-specific services.
- Putting category endpoints in recipes would make recipes own a concept also
  used by inventory.
- Splitting database tables or duplicating pricing/conversion helpers adds
  migration work without improving application ownership.

## Consequences and validation

Existing HTTP paths, response envelopes, validation, permissions, tenant
scoping, inventory idempotency, and recipe sync semantics remain unchanged.
There is no database migration or frontend change.

`scripts/feature-modules.test.ts` mounts each production module independently
and checks its routes and authentication. Existing HTTP, costing, inventory,
and sync tests exercise the application composition. Run `npm run verify`
for both typechecks, the full test suite, and the production build; tests
requiring optional external services retain their existing environment gates.

Board ticket: [Separate inventory and recipes](https://github.com/orgs/Neuton-AI/projects/1?pane=issue&itemId=291226822).
