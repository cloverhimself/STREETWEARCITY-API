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
    auth/           # register, login, verify-email, password reset, refresh, /me — fully implemented
    products/       # full CRUD, variant/inventory generation from color+sizeType — fully implemented
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

`modules/*` marked "scaffolded, not implemented" have a router file with a comment describing what belongs there and are already mounted in `app.ts` under `/api/v1/<module>` — the wiring works end to end, the business logic inside doesn't exist yet. `auth`, `payments`, and now `products` are the modules built out for real, as reference implementations for the pattern the rest should follow (controller stays thin, service holds the logic, Zod validates at the route boundary).

## Products: the frontend/database shape gap

The frontend's `Product` type is flat (one `image`, one `stock` number, `colors` without per-color sizing). The database is properly normalized: a `Product` has many `ProductVariant`s (one row per color × size combination), each with its own `Inventory`. `products.service.ts#mapProduct` is where that gap gets bridged for every read — `stock` is `sum(variant.totalQuantity - variant.reservedQuantity)` across all variants (available, not total, same "never oversell" rule as the rest of the schema), `colors` is deduplicated across variants, and `badge` is computed (`"Low Stock"` under 6 available, `"New"` within 14 days of `createdAt`, otherwise `null` — `"Bestseller"` is never set because there's no sales data yet to justify it).

**Known simplification**: the admin product form collects one flat stock number, not per-size stock, so `products.service.ts#createProduct` gives every generated variant (every color × every size for that `sizeType`) the same starting quantity. A `sizeType: "clothing"` product with 2 colors and a stock of 10 ends up with 12 variants at 10 units each (120 total), not 10 units total. Real per-variant stock entry is follow-up work, not this pass's scope.

**Known simplification**: `updateProduct` replaces the entire variant set (delete + recreate) whenever colors, sizeType, or stock change, rather than diffing. Safe today because no real order ever references a variant yet. Once `orders`/`cart` are built, this needs a real migration strategy — you can't delete a `ProductVariant` an `OrderItem` or `StockReservation` points at.

**Images stay URL-based, not uploaded**: Railway's filesystem is ephemeral (wiped on every redeploy) and no cloud storage provider is configured yet, so there's nowhere durable to put an uploaded file. The admin form takes an image URL directly (same interaction pattern as the color-chip list) rather than a file picker — it references already-hosted images (the seeded catalog uses `streetwarecity`'s bundled `/uploads/*.jpg` files). Real upload-to-cloud-storage is follow-up work once a provider (S3/R2/Cloudinary/etc.) is picked.

`prisma/seed.ts` seeds the same 14 products the frontend used to hardcode in `src/lib/data.ts`, through the same variant-generation shape `createProduct` uses, so local dev and production both start with a real, working catalog instead of an empty one.

## RBAC model

Permissions are composed, not hardcoded (SRS §5). `Role` and `Permission` are separate tables joined by `RolePermission`; a user gets roles via `UserRole`. At login (and again on `/auth/refresh`, in case roles changed since the last token) `auth.service.ts` resolves the logged-in user's permission set and embeds it in the JWT access token, so authorization checks (`requirePermission("orders.update")`) don't need a database round trip on every request. `prisma/seed.ts` seeds the baseline roles from the SRS — `super_admin`, `product_manager`, `inventory_manager`, `order_manager`, `finance_manager`, `customer_support`, plus `customer` for regular shoppers — and also seeds one `super_admin` login (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` in env, defaults to `admin@streetwearcity.com` / `ChangeMe123!`), dev-only, so there's something to sign into `/admin` with locally.

The frontend gates its own `/admin` route by checking the login response's `permissions` array is non-empty — a plain `customer` login (zero permissions) is rejected client-side with an error, not just hidden. That check lives in `streetwarecity/src/components/admin/useAdmin.ts`'s `submitAdminLogin`.

## Payments: how the provider swap actually works

Nothing outside `modules/payments/` should ever import a provider SDK directly. The flow:

1. `payments.service.ts#initializePaymentForOrder` creates a `Payment` row as `PENDING` **before** calling the provider — so a crash mid-call never leaves an order with no payment record at all.
2. It calls `getActivePaymentProvider()` (reads `PAYMENT_PROVIDER` from env, currently `bachs`) and calls `.initialize()` on whatever that resolves to. Status moves to `PROCESSING`.
3. The provider's synchronous response is **not** treated as confirmation — only a verified webhook (or the polling fallback) moves a payment to `COMPLETED`.
4. `payments.routes.ts`'s `/webhook` route is mounted before the global JSON body parser and uses `express.raw()` specifically, because signature verification needs the exact bytes the provider sent, not a re-serialized JSON object.
5. `payments.service.ts#reconcilePaymentStatus` is idempotent — if a payment is already `COMPLETED` or `FAILED`, replaying the same webhook event is a no-op. Providers retry webhook delivery; this is expected, not a bug to guard against with hacks.

To add a second provider: implement `PaymentProvider` in `modules/payments/providers/<name>/`, register it in `provider.registry.ts`, add its secret keys to `.env.example`. Nothing else changes.

**Known gap**: the Bachs provider implementation (`providers/bachs/bachs.provider.ts`) is written against best-effort assumptions about Bachs's REST API shape — their docs portal returned 403 while this was scaffolded, and their official `@bachs/sdk` npm package is currently a `0.0.1` placeholder with no implementation. The endpoint paths, field names, and webhook signature header in that file need to be confirmed against Bachs's actual dashboard/docs before any real transaction runs through it.

## Frontend integration

`streetwarecity` (the Next.js frontend) talks to this API through a single wrapper, `src/lib/api.ts`'s `apiFetch`, which reads `NEXT_PUBLIC_API_URL` (`.env.local`, defaults to `http://localhost:4000/api/v1`), attaches the stored access token as a bearer header, parses this API's `{success, data}` / `{success, error}` envelope into a typed result or a thrown `ApiError`, and on a `401` tries exactly one silent refresh via `/auth/refresh` before giving up and clearing the stored session. Tokens live in `localStorage` under `swc:tokens`, shared between the storefront (`useStorefront.ts`) and the admin app (`useAdmin.ts`) since they're both the same Next.js origin.

The frontend's auth modal only implements what this API actually supports: link-based email verification and password reset (`/verify-email` and `/reset-password` pages, not inline codes), matching `auth.service.ts`'s token-hash design. Register does not log the user in — it ends in a "check your email" state, consistent with `emailVerifiedAt` gating nothing server-side yet but existing as the intended checkpoint.

## Deployment

Hosted on **Railway** (`streetwarecity-api` project, `Clover's Projects` workspace) — an Express service plus a managed Postgres, both in the same Railway project so `DATABASE_URL` resolves via Railway's internal network (`${{Postgres.DATABASE_URL}}`) rather than being hand-entered. Public URL: `https://streetwarecity-api-production.up.railway.app`.

Railway builds with its default builder (Railpack) — `railway.json` deliberately does **not** pin `"builder": "NIXPACKS"`; that pin caused every build to fail with zero detected providers on this account (Railway has moved off Nixpacks as the default). If builds start failing with an empty provider list again, check whether `railway.json`'s `build` key crept back in.

`railway.json`'s `deploy.startCommand` runs `npm run start:prod`, i.e. `prisma migrate deploy && node dist/server.js` — every deploy applies any pending migrations before the server starts. `prisma migrate deploy` is safe to re-run (no-ops when nothing's pending), so this doesn't need a separate release-step mechanism.

Seeding production (roles/permissions/categories/admin login) can't go through `railway run` — that wrapper hung indefinitely in at least one environment for reasons that weren't tracked down. Instead, run the seed script directly against Postgres's `DATABASE_PUBLIC_URL` (get it via `railway variable list --service Postgres --json`, it's the public-proxy connection string, not the internal `postgres.railway.internal` one which only resolves from inside Railway's network):

```bash
DATABASE_URL="<DATABASE_PUBLIC_URL>" SEED_ADMIN_EMAIL="..." SEED_ADMIN_PASSWORD="..." npx tsx prisma/seed.ts
```

**CORS is locked to a single origin** (`CLIENT_ORIGIN` = the Vercel production URL). Vercel preview-deployment URLs (per-branch/per-PR) will get CORS-blocked until this is generalized to a pattern match or an allow-list — known gap, not fixed yet, low priority until preview environments actually matter.

Frontend side: Vercel's `NEXT_PUBLIC_API_URL` must be set to `https://streetwarecity-api-production.up.railway.app/api/v1` (Production environment) for the deployed frontend to reach this backend at all — it isn't picked up automatically from anywhere, it's a separate manual step in the Vercel project's environment variable settings.

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
- No actual email/SMS delivery yet — `auth.service.ts` generates verification/reset tokens but only logs an "integration point" comment where SendByte would send them. Locally, get the token by reading it off the service function's return value or the database.
- No real file upload for product images (URL-referenced only) and no per-variant stock entry — both noted in the Products section above.
- `updateProduct`'s delete-and-recreate variant strategy will need to change once `orders`/`cart` exist and real `OrderItem`/`StockReservation` rows can reference a variant.

## Changelog

- **Phase 2 scaffold**: project structure, Prisma schema (full SRS §7 table list plus reservations/verification tokens), `auth` and `payments` modules implemented, remaining modules scaffolded and mounted, this document.
- **Auth wiring**: added `/auth/refresh` and `/auth/me`; seeded a dev `super_admin` login; frontend (`streetwarecity`) now calls this API for real instead of mock state — register/login/verify-email/reset-password/logout on the storefront, and a real permission-gated login on `/admin`. Verified end to end against a local Postgres instance, including a real browser session (Playwright) for both the customer and admin flows.
- **First production deploy**: live on Railway with a managed Postgres, migrations applied automatically on deploy via the start command, production seeded with fresh secrets and a generated (not default) admin password. See the Deployment section above.
- **Products wired end-to-end**: full CRUD (`products.service.ts`), variant/inventory generation from color × sizeType, the 14-product mock catalog migrated into the seed script, and both the storefront (real shop grid, PDP with a real multi-image gallery instead of the old fake crop-position trick) and admin (real create/edit/delete, URL-based image input instead of the old non-functional blob-URL file picker) wired to the real API. Verified end to end with a real browser session covering the shop grid, a PDP, and admin product creation.
