import crypto from "node:crypto";
import { env } from "../../../../lib/env";
import { HttpError } from "../../../../utils/http-error";
import type { InitializePaymentInput, InitializePaymentResult, PaymentProvider, VerifyPaymentResult, WebhookEvent } from "../../provider.interface";

// NOTE FOR WHOEVER WIRES THIS UP FOR REAL:
// Bachs's public API reference wasn't reachable while scaffolding this (docs
// portal returned 403, and their npm SDK `@bachs/sdk` is published as a
// v0.0.1 "coming soon" placeholder with no implementation yet). The request/
// response field names below are best-effort based on how Bachs describes
// itself (checkout.create sessions, webhook-based confirmation) and standard
// REST payment-provider conventions, NOT a verified API contract. Confirm the
// endpoint paths, field names, and the webhook signature header against the
// Bachs dashboard/docs before this touches real money.
const BACHS_API_BASE = "https://api.bachs.io/v1";

function bachsHeaders() {
  if (!env.BACHS_SECRET_KEY) throw new Error("BACHS_SECRET_KEY is not set");
  return {
    Authorization: `Bearer ${env.BACHS_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

export const bachsProvider: PaymentProvider = {
  name: "bachs",
  webhookSignatureHeader: "x-bachs-signature",

  async initialize(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    const res = await fetch(`${BACHS_API_BASE}/checkout/sessions`, {
      method: "POST",
      headers: bachsHeaders(),
      body: JSON.stringify({
        amount: input.amount,
        currency: input.currency,
        reference: input.idempotencyKey,
        customer_email: input.customerEmail,
        metadata: { orderId: input.orderId },
      }),
    });

    if (!res.ok) throw HttpError.badRequest(`Bachs checkout initialization failed (${res.status})`);
    const body = (await res.json()) as { id: string; checkout_url: string };

    return { providerRef: body.id, redirectUrl: body.checkout_url };
  },

  async verify(providerRef: string): Promise<VerifyPaymentResult> {
    const res = await fetch(`${BACHS_API_BASE}/checkout/sessions/${providerRef}`, {
      headers: bachsHeaders(),
    });

    if (!res.ok) throw HttpError.badRequest(`Bachs verification failed (${res.status})`);
    const body = (await res.json()) as { id: string; status: string; amount: number; currency: string };

    const status = body.status === "paid" ? "verified" : body.status === "failed" ? "failed" : "pending";
    return { status, providerRef: body.id, amount: body.amount, currency: body.currency };
  },

  parseWebhook(rawBody: Buffer, signatureHeader: string | undefined): WebhookEvent {
    if (!env.BACHS_WEBHOOK_SECRET) throw new Error("BACHS_WEBHOOK_SECRET is not set");
    if (!signatureHeader) throw HttpError.unauthorized("Missing webhook signature");

    const expected = crypto.createHmac("sha256", env.BACHS_WEBHOOK_SECRET).update(rawBody).digest("hex");
    const provided = Buffer.from(signatureHeader);
    const match = provided.length === expected.length && crypto.timingSafeEqual(provided, Buffer.from(expected));
    if (!match) throw HttpError.unauthorized("Invalid webhook signature");

    const payload = JSON.parse(rawBody.toString("utf8")) as { id?: string; data: { id: string; status: string; amount: number; currency: string } };
    const status = payload.data.status === "paid" ? "verified" : payload.data.status === "failed" ? "failed" : "pending";

    return { eventId: payload.id ?? `${payload.data.id}:${payload.data.status}`, providerRef: payload.data.id, status, amount: payload.data.amount, currency: payload.data.currency, rawPayload: payload };
  },
};
