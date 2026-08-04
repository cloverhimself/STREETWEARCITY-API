# Streetwear City API — Architecture

Current technical source of truth for the Phase 1 backend. Update this document whenever deployment, module ownership, security boundaries, or major workflows change.

## System overview

Streetwear City is split into two repositories:

- `streetwarecity`: Next.js storefront and admin application.
- `streetwarecity-api`: Express/TypeScript REST API backed by PostgreSQL through Prisma.

Production is hosted on Pxxl:

- Frontend: `https://streetwarecity.pxxl.pro`
- API: `https://streetwarecity-api.pxxl.pro`
- Database: Pxxl-managed PostgreSQL

The API also integrates with Cloudinary for product images, SendByte for transactional email, and Paystack for payments. Bachs remains in the provider registry as dormant legacy code; Paystack is the active provider.

## Runtime and conventions

- Node.js and TypeScript
- Express 5
- PostgreSQL with Prisma 7 and `@prisma/adapter-pg`
- Zod validation at route boundaries
- Pino structured logging and `pino-http`
- JWT access tokens plus opaque rotating refresh tokens
- Permission-based RBAC
- Integer minor-unit money arithmetic at calculation/provider boundaries

Prisma 7 keeps the CLI connection string in `prisma.config.ts`. Runtime construction is in `src/lib/prisma.ts`; do not add a connection URL to the datasource block in `schema.prisma`.

Every API response uses one envelope:

```json
{ "success": true, "data": {} }
```

or:

```json
{ "success": false, "error": { "message": "..." } }
```

Routes parse and authorize requests, services own business logic and database access, and the global error handler shapes failures.

## Module status

Implemented:

- `auth`: registration, six-character email verification, login, refresh rotation/reuse detection, logout, `/me`, password reset, and session revocation.
- `products`: product CRUD, variant generation, catalog mapping, and inventory-aware availability.
- `cart`: live product/variant/price/stock validation.
- `orders`: server-priced checkout, atomic stock reservations, order history, ownership checks, and guarded lifecycle transitions.
- `payments`: Paystack initialization, signed webhook parsing, idempotent settlement, provider polling/reconciliation, payment-status reads, and operations summary.
- `analytics`: permission-gated live PostgreSQL revenue, order-trend, top-customer, and best-seller aggregations.
- `uploads`: permission-gated Cloudinary product-image upload.
- `inventory`: low-stock pagination, audited restocking, and expired reservation release.

Still deliberately incomplete:

- External monitoring/alert delivery and provider settlement-export reconciliation are not implemented for Phase 1; the authenticated operations summary and structured logs expose drift indicators.

## Authentication and authorization

Passwords use bcryptjs with 12 rounds. Registration creates a customer role, profile, wishlist, and a hashed six-character verification code that expires after 15 minutes. Verification codes are never stored in plaintext.

Login is blocked until email verification. Successful login returns a short-lived access token; the refresh token is stored in an HttpOnly cookie. The browser receives a separate readable CSRF token and must send it on refresh/logout requests.

Refresh sessions are persisted in `refresh_sessions`, rotated on use, grouped into token families, and fully revoked when reuse is detected. Password reset consumes a hashed single-use token and revokes every active refresh session for that user.

Authorization is permission-based. `requirePermission("products.create")` checks permissions embedded in the access token. Permissions are re-resolved from PostgreSQL whenever a new access token is issued, so role changes take effect on refresh.

## Orders, inventory, and money

The client submits product ID, color, size, and quantity—never authoritative prices or totals. Order creation resolves every line against PostgreSQL, calculates in integer kobo through `src/lib/money.ts`, and writes fixed two-decimal values to Prisma `Decimal` fields.

Checkout creates an order and stock reservations in one database transaction. Inventory uses:

```text
available = totalQuantity - reservedQuantity
```

Reservation acquisition uses an atomic SQL predicate, preventing concurrent last-unit overselling. A five-minute background sweep marks expired active reservations as `EXPIRED` and decrements reserved stock.

The admin product form accepts stock per generated color/size variant. Product updates reconcile variants in place; referenced removals are retired instead of deleting order, reservation, inventory, or log history.

## Payment lifecycle

The active provider is Paystack. Provider-specific kobo conversion and API details stay inside `providers/paystack`.

Payment initialization:

1. Claims a durable checkout attempt by user/key/request hash before creating order state; exact retries return the original order.
2. Creates one durable `PENDING` payment with `order_<orderId>` as its idempotency key.
3. Calls Paystack initialization and stores the authorization URL/error.
4. If the response is lost, deterministic reference verification (`order_<orderId>`) recovers the payment without a second initialization call.
5. A retry reuses the same database row and reference; initialization response alone never confirms an order.

Settlement occurs only from verified provider evidence: a signed webhook or reconciliation polling result. Webhook signatures are HMAC-SHA512 over the exact raw request body.

Signature-valid webhook ingestion is durable before acknowledgement. A recoverable in-process worker claims pending events and performs settlement; unknown references and rejected amount/currency mismatches remain retained evidence. Verified settlement is atomic: payment transition, claiming every stock reservation, inventory deduction, sale logs, and order confirmation commit together. If expiry or another process already claimed a reservation, settlement rolls back instead of producing a paid order without stock.

`reconcilePendingPayments` runs every minute, conditionally claims eligible payments, polls Paystack, and uses bounded exponential backoff. Duplicate webhook and polling events are idempotent through the unique provider-event record and terminal-state guards.

Staff with `payments.view` can read `GET /api/v1/payments/operations/summary` for pending, processing, overdue, high-retry, failure, and webhook-alert signals.

## Deployment

Pxxl configuration is in `pxxl.toml`. The install command includes dev dependencies because TypeScript and type packages are required during build even when `NODE_ENV=production`.

Production starts with:

```bash
npm run start:prod
```

which runs `prisma migrate deploy` before starting `dist/server.js`. Runtime secrets are stored in Pxxl and mirrored locally in gitignored `.env.pxxl`; they are not bundled into deployment archives.

As of 2026-08-04, commit `eb99053` and later verified work are waiting for deployment because Pxxl confirmed its CLI/management gateway is temporarily down. The currently served API remains healthy but is an older release.

## Verification and CI

GitHub Actions provisions PostgreSQL 17, installs dependencies, validates Prisma, applies all migrations, seeds data, typechecks, runs unit and PostgreSQL integration tests, and builds the API.

The 29-test disposable-PostgreSQL integration suite proves registration/verification, login gating, refresh reuse, password-reset revocation, the full seeded RBAC matrix, current-price checkout, durable checkout replay/conflict handling, transaction rollback, concurrent stock reservation, signed webhooks, durable unknown/mismatch retention, webhook replay, initialization-timeout recovery, reconciliation-worker claiming, and reservation-expiry/payment-settlement races.

## Current Phase 1 gaps

- Complete one real Paystack test-mode order through the deployed API once Pxxl deployment access returns.
- Add external alert delivery and settlement-export reconciliation if operational scale or provider access makes them necessary.
