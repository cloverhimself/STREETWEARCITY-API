ALTER TABLE "payments"
ADD COLUMN "authorizationUrl" TEXT,
ADD COLUMN "initializationError" TEXT,
ADD COLUMN "lastInitializationAt" TIMESTAMP(3);

CREATE TYPE "WebhookProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'REJECTED');

ALTER TABLE "payment_webhook_events"
ADD COLUMN "normalizedEvent" JSONB,
ADD COLUMN "processingStatus" "WebhookProcessingStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "processingError" TEXT,
ADD COLUMN "processedAt" TIMESTAMP(3);

CREATE TABLE "checkout_attempts" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "orderId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "checkout_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "checkout_attempts_orderId_key" ON "checkout_attempts"("orderId");
CREATE UNIQUE INDEX "checkout_attempts_userId_key_key" ON "checkout_attempts"("userId", "key");
