# Use NestJS with Express

Status: Accepted
Date: 2026-10-22 (decision); recorded retrospectively on 2026-11-03

## Context

The backend API audit prompted a discussion about explicit DTOs and business
boundaries. Some responses exposed database row shapes; substantial route
handlers mixed business operations with persistence. Sync reused HTTP handlers
by wrapping them and intercepting replies, and dependencies travelled through
request decorations, including recipe operations using `receiptsDeps`.

Payments, coupons, and MCP were planned. These would need shared, authorized
business operations across HTTP, workers, and additional transports. The concern
was the cost of maintaining application structure as those capabilities grew.
Fastify could support them; we had not exceeded its capabilities.

## Decision

Adopt NestJS with Express, organized into feature modules containing contracts,
application services, persistence, and transport adapters. Controllers validate
inputs and resolve actor/tenant context; services own business operations and
authorization; persistence owns database access. Workers, sync, and future MCP
tools call services instead of HTTP handlers. Explicit response mapping keeps
database changes from silently changing public contracts.

The discussion reached this decision in three steps:

1. **DTOs first.** We proposed request/response contracts and small explicit
   mappers, with orders as the reference slice. The initial proposal used global
   contracts/services/presenters directories; the growth discussion refined it
   into feature-owned modules.
2. **NestJS for structure.** When asked whether we had outgrown Fastify, the
   recommendation was NestJS with Fastify underneath. Nest supplied standard
   modules, dependency injection, guards, and controllers. The owner emphasized
   that migration was affordable now and staying with an unsuitable structure
   would cost more later, especially after adding payments.
3. **Express for maintenance.** We clarified that Express is Nest's default HTTP
   adapter, while Fastify is an alternative. After comparing them, the initial
   recommendation still favored Fastify, with moderate confidence. The owner
   explicitly chose Express: “we dont care about the extra overhead, we prefer
   smoother migrations and maintenance.” This set the final target for #178.

## Alternatives considered

| Option | Benefit discussed | Why we chose otherwise |
| --- | --- | --- |
| Keep standalone Fastify and impose our own layers | Capable framework; retain existing infrastructure | We preferred a framework providing repeatable application conventions as the product grew. |
| NestJS with Fastify | Same Nest architecture, lower HTTP overhead, potential reuse of plugins, hooks, logging, and HTTP tests | We prioritized the conventional Nest integration path and maintenance over performance headroom. |
| NestJS with Express | Default Nest ecosystem path and broad middleware compatibility | Selected; accepted replacing Fastify-specific infrastructure and potentially higher HTTP overhead. |

No application benchmark established a performance need, and no required
integration had been identified that forced Express. Webhooks, presigned R2
uploads, coupons, and MCP were discussed as compatible with either approach;
they informed the architecture but did not determine the HTTP adapter.

## Consequences and validation

The intended benefit is clearer ownership and reusable operations before adding
more business capabilities. Nest does not itself guarantee tenant isolation,
transaction safety, payment deduplication, or coupon concurrency; those still
require explicit policies and tests. PostgreSQL, Drizzle, BullMQ, Supabase auth,
and R2 were retained as part of this decision.

We proposed proving the boundaries with order creation/verification, including
authentication, tenant context, DTOs, and transactions, then migrating in phases
before removing Fastify. The migration merged on 2026-10-23 through
[PR #179](https://github.com/Neuton-AI/Neuton-Back/pull/179).

Sources: the DTO, framework, and adapter exchanges in the chat **Audit backend
API design** (2026-10-22; chat ID `01a16053-e3d0-73a0-a6c2-cff17c156660`),
[migration issue #178](https://github.com/Neuton-AI/Neuton-Back/issues/178), and
the historical implementation record at `e18485f:docs/nestjs-migration.md`.
This ADR records the original rationale; the later
[inventory/recipe separation decision](0001-separate-inventory-recipes.md)
refines module ownership.
