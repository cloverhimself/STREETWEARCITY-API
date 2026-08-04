ALTER TABLE "payments"
  ADD COLUMN "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextReconcileAt" TIMESTAMP(3),
  ADD COLUMN "lastReconciledAt" TIMESTAMP(3);
CREATE INDEX "payments_reconciliation_idx" ON "payments"("status", "nextReconcileAt");
