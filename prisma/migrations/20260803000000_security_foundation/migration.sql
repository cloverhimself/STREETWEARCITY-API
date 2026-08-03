CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');

ALTER TABLE "stock_reservations"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "ReservationStatus" USING UPPER("status")::"ReservationStatus",
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

CREATE TABLE "refresh_sessions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "rotatedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "replacedByHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "refresh_sessions_tokenHash_key" ON "refresh_sessions"("tokenHash");
CREATE INDEX "refresh_sessions_userId_idx" ON "refresh_sessions"("userId");
CREATE INDEX "refresh_sessions_familyId_idx" ON "refresh_sessions"("familyId");
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "payment_webhook_events" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "paymentId" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_webhook_events_provider_providerEventId_key" ON "payment_webhook_events"("provider", "providerEventId");
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "payments_provider_providerRef_key" ON "payments"("provider", "providerRef");
CREATE INDEX "stock_reservations_status_expiresAt_idx" ON "stock_reservations"("status", "expiresAt");

ALTER TABLE "inventory" ADD CONSTRAINT "inventory_nonnegative_check" CHECK ("totalQuantity" >= 0 AND "reservedQuantity" >= 0 AND "reservedQuantity" <= "totalQuantity");
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_quantity_positive_check" CHECK ("quantity" > 0);
ALTER TABLE "products" ADD CONSTRAINT "products_price_positive_check" CHECK ("price" > 0 AND ("compareAtPrice" IS NULL OR "compareAtPrice" > 0));
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_positive_check" CHECK ("quantity" > 0 AND "unitPrice" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive_check" CHECK ("amount" > 0);
