import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { authGuard } from "../../middleware/auth-guard";
import { requirePermission } from "../../middleware/rbac-guard";
import { ok } from "../../utils/api-response";
import { getActivePaymentProvider } from "./provider.registry";
import { getPaymentOperationsSummary, getPaymentStatusForOrder, ingestWebhookEvent, processWebhookEvent } from "./payments.service";

export const paymentsRouter = Router();
const paymentStatusRateLimit = rateLimit({ windowMs: 60 * 1000, limit: 60, keyGenerator: (req) => req.user!.sub, standardHeaders: true, legacyHeaders: false });

// Raw body is required here (not the global JSON parser) because signature
// verification hashes the exact bytes the provider sent.
paymentsRouter.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const provider = getActivePaymentProvider();
  const signature = req.headers[provider.webhookSignatureHeader];
  const event = provider.parseWebhook(req.body, Array.isArray(signature) ? signature[0] : signature);
  const stored = await ingestWebhookEvent(provider.name, event);
  setImmediate(() => void processWebhookEvent(stored.id));
  return ok(res, { received: true });
});

// Fallback for when a webhook is delayed or dropped, per the "never rely on a
// single delivery mechanism" rule — the client can poll this after redirect.
paymentsRouter.get("/orders/:orderId/status", authGuard, paymentStatusRateLimit, async (req, res) => {
  const payment = await getPaymentStatusForOrder(req.params.orderId as string, req.user!);
  return ok(res, { status: payment.status, provider: payment.provider });
});

paymentsRouter.get("/operations/summary", authGuard, requirePermission("payments.view"), async (_req, res) => {
  return ok(res, await getPaymentOperationsSummary());
});
