# Streetwear City API — Architecture

Running architecture document for the backend. Update this whenever a module's shape changes — this is the source of truth for how the pieces fit together, not just what exists.

## Stack

- **Runtime**: Node.js, TypeScript
- **Framework**: Express 5
- **Database**: plain PostgreSQL (no Supabase) via Prisma ORM 7, using the `@prisma/adapter-pg` driver adapter
- **Auth**: JWT (short-lived access token + longer-lived refresh token), bcryptjs for password hashing
- **Validation**: Zod at every API boundary
- **Logging**: Pino (`pino-http` per-request logs, pretty-printed outside production)
- **Payments**: provider-agnostic — Bachs is the active provider, swappable without touching business logic (see below)
- **Email/SMS**: SendByte (not yet wired — see `notifications` module)

This is a separate service from the `streetwarecity` Next.js frontend. They talk over a REST API (`/api/v1/...`), not shared server code.

## Why Prisma 7's config looks different

Prisma 7 moved the database connection string out of `schema.prisma` entirely. `schema.prisma` now only describes data shape; `prisma.config.ts` holds the connection info for the CLI (migrate, studio, seed), and `src/lib/prisma.ts` constructs the runtime `PrismaClient` with a `@prisma/adapter-pg` driver adapter built from `DATABASE_URL`. If you're used to older Prisma versions, this is the biggest surprise — don't add `url = env("DATABASE_URL")` back into the datasource block, it's deliberately not there.

## Folder structure

```
src/
  modules/
    auth/           # register, login, verify-email, password reset — fully implemented
    products/       # catalog reads — minimal, CRUD pending
    inventory/       # stock, reservations, inventory logs — scaffolded, not implemented
    cart/             # checkout/reservation flow — scaffolded, not implemented
    orders/           # order lifecycle — scaffolded, not implemented
    payments/
      provider.interface.ts     # the PaymentProvider contract every provider implements
      provider.registry.ts       # picks the active provider from PAYMENT_PROVIDER env var
      providers/bachs/           # first (and currently only) implementation
      payments.service.ts        # state machine: create PENDING payment -> call provider -> webhook settles it
      payments.routes.ts         # POST /webhook (raw body, signature-verified), GET /orders/:id/status (polling fallback)
    notifications/    # in-app + SendByte email/SMS — scaffolded, not implemented
    analytics/        # revenue/orders/customers aggregations — scaffolded, not implemented
    activity-logs/    # admin audit trail reads — scaffolded, not implemented
    admin/            # staff invite/role management — scaffolded, not implemented
  lib/
    env.ts          # Zod-validated process.env, the only place that reads it directly
    logger.ts       # Pino instance
    prisma.ts       # PrismaClient singleton (adapter-based, see above)
    jwt.ts          # sign/verify access + refresh tokens
  middleware/
    auth-guard.ts      # requires a valid access token, attaches req.user
    rbac-guard.ts       # requirePermission("products.create") — checks the token's resolved permission set
    rate-limit.ts       # general + tighter auth-specific limiter
    error-handler.ts    # single place that turns thrown errors into the API's response envelope
  utils/
    http-error.ts     # HttpError.notFound() etc. — thrown, not returned, from anywhere in a request
    api-response.ts   # ok()/fail() — every endpoint responds through these two functions
  app.ts             # Express app wiring: middleware order, route mounting
  server.ts          # entry point
prisma/
  schema.prisma      # data model
  seed.ts            # baseline roles, permissions, categories
```

`modules/*` marked "scaffolded, not implemented" have a router file with a comment describing what belongs there and are already mounted in `app.ts` under `/api/v1/<module>` — the wiring works end to end, the business logic inside doesn't exist yet. `auth` and `payments` are the two modules built out for real, as reference implementations for the pattern the rest should follow (controller stays thin, service holds the logic, Zod validates at the route boundary).

## RBAC model

Permissions are composed, not hardcoded (SRS §5). `Role` and `Permission` are separate tables joined by `RolePermission`; a user gets roles via `UserRole`. At login, `auth.service.ts` resolves the logged-in user's permission set once and embeds it in the JWT access token, so authorization checks (`requirePermission("orders.update")`) don't need a database round trip on every request — only login (and refresh) touches the roles/permissions tables. `prisma/seed.ts` seeds the baseline roles from the SRS: `super_admin`, `product_manager`, `inventory_manager`, `order_manager`, `finance_manager`, `customer_support`, plus `customer` for regular shoppers.

## Payments: how the provider swap actually works

Nothing outside `modules/payments/` should ever import a provider SDK directly. The flow:

1. `payments.service.ts#initializePaymentForOrder` creates a `Payment` row as `PENDING` **before** calling the provider — so a crash mid-call never leaves an order with no payment record at all.
2. It calls `getActivePaymentProvider()` (reads `PAYMENT_PROVIDER` from env, currently `bachs`) and calls `.initialize()` on whatever that resolves to. Status moves to `PROCESSING`.
3. The provider's synchronous response is **not** treated as confirmation — only a verified webhook (or the polling fallback) moves a payment to `COMPLETED`.
4. `payments.routes.ts`'s `/webhook` route is mounted before the global JSON body parser and uses `express.raw()` specifically, because signature verification needs the exact bytes the provider sent, not a re-serialized JSON object.
5. `payments.service.ts#reconcilePaymentStatus` is idempotent — if a payment is already `COMPLETED` or `FAILED`, replaying the same webhook event is a no-op. Providers retry webhook delivery; this is expected, not a bug to guard against with hacks.

To add a second provider: implement `PaymentProvider` in `modules/payments/providers/<name>/`, register it in `provider.registry.ts`, add its secret keys to `.env.example`. Nothing else changes.

**Known gap**: the Bachs provider implementation (`providers/bachs/bachs.provider.ts`) is written against best-effort assumptions about Bachs's REST API shape — their docs portal returned 403 while this was scaffolded, and their official `@bachs/sdk` npm package is currently a `0.0.1` placeholder with no implementation. The endpoint paths, field names, and webhook signature header in that file need to be confirmed against Bachs's actual dashboard/docs before any real transaction runs through it.

## Inventory & reservations

`Inventory.totalQuantity` and `Inventory.reservedQuantity` are tracked separately; available stock is `total - reserved`, computed at query time rather than stored, so it can't drift out of sync. `StockReservation` rows hold a variant's stock during checkout with an `expiresAt` TTL — the reservation sweep job that releases expired holds back to available stock is not yet built (see `inventory` module TODO). Every stock change, restock or reservation-release alike, should write an `InventoryLog` row; nothing adjusts `Inventory.totalQuantity` directly without one.

## Running locally

```bash
cp .env.example .env        # fill in DATABASE_URL and the JWT secrets at minimum
npm install
npm run prisma:migrate      # creates the database schema
npm run seed                # baseline roles, permissions, categories
npm run dev                 # tsx watch, http://localhost:4000
```

`GET /health` is unauthenticated and doesn't touch the database — use it to confirm the process is up before debugging anything else.

## Known gaps / not yet true

- ESLint isn't configured yet: `typescript-eslint` doesn't support the installed TypeScript 7 as a peer dependency at time of writing. `npm run typecheck` (plain `tsc --noEmit`) is the current correctness check.
- No automated tests yet.
- No CI pipeline yet.
- `cart`, `orders`, `inventory`, `notifications`, `analytics`, `activity-logs`, `admin` modules are routing-wired but have no business logic — see the TODO comment at the top of each `*.routes.ts`.
- No stock-reservation TTL sweep job yet (see Inventory section above).

## Changelog

- **Phase 2 scaffold**: project structure, Prisma schema (full SRS §7 table list plus reservations/verification tokens), `auth` and `payments` modules implemented, remaining modules scaffolded and mounted, this document.
