import crypto from "node:crypto";
import { env } from "../../../../lib/env";
import { fromMinorUnits, toMinorUnits } from "../../../../lib/money";
import { HttpError } from "../../../../utils/http-error";
import type { InitializePaymentInput, InitializePaymentResult, PaymentProvider, VerifyPaymentResult, WebhookEvent } from "../../provider.interface";

// Paystack's documented REST API (https://paystack.com/docs/api) — unlike
// Bachs, this is a real, publicly verifiable contract. Amounts are in the
// smallest currency unit (kobo for NGN), so every amount crossing this
// boundary is multiplied/divided by 100 right here — nothing outside this
// file needs to know that.
const PAYSTACK_API_BASE = "https://api.paystack.co";

function paystackHeaders() {
  if (!env.PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is not set");
  return {
    Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

interface PaystackInitializeResponse {
  status: boolean;
  message: string;
  data: { authorization_url: string; access_code: string; reference: string };
}

interface PaystackVerifyResponse {
  status: boolean;
  message: string;
  data: { reference: string; status: "success" | "failed" | "abandoned"; amount: number; currency: string };
}

interface PaystackWebhookPayload {
  id?: number;
  event: string;
  data: { id?: number; reference: string; status: "success" | "failed" | "abandoned"; amount: number; currency: string };
}

function mapStatus(status: "success" | "failed" | "abandoned"): "verified" | "pending" | "failed" {
  if (status === "success") return "verified";
  if (status === "abandoned") return "pending";
  return "failed";
}

export const paystackProvider: PaymentProvider = {
  name: "paystack",
  webhookSignatureHeader: "x-paystack-signature",

  async initialize(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    const res = await fetch(`${PAYSTACK_API_BASE}/transaction/initialize`, {
      method: "POST",
      headers: paystackHeaders(),
      body: JSON.stringify({
        email: input.customerEmail,
        amount: toMinorUnits(input.amount),
        currency: input.currency,
        reference: input.idempotencyKey,
        metadata: { orderId: input.orderId },
      }),
    });

    const body = (await res.json()) as PaystackInitializeResponse;
    if (!res.ok || !body.status) throw HttpError.badRequest(`Paystack initialization failed: ${body.message ?? res.status}`);

    return { providerRef: body.data.reference, redirectUrl: body.data.authorization_url };
  },

  async verify(providerRef: string): Promise<VerifyPaymentResult> {
    const res = await fetch(`${PAYSTACK_API_BASE}/transaction/verify/${encodeURIComponent(providerRef)}`, {
      headers: paystackHeaders(),
    });

    const body = (await res.json()) as PaystackVerifyResponse;
    if (!res.ok || !body.status) throw HttpError.badRequest(`Paystack verification failed: ${body.message ?? res.status}`);

    return {
      status: mapStatus(body.data.status),
      providerRef: body.data.reference,
      amount: fromMinorUnits(body.data.amount),
      currency: body.data.currency,
    };
  },

  parseWebhook(rawBody: Buffer, signatureHeader: string | undefined): WebhookEvent {
    if (!env.PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is not set");
    if (!signatureHeader) throw HttpError.unauthorized("Missing webhook signature");

    // Paystack signs with the secret key itself (no separate webhook secret) —
    // HMAC-SHA512 of the raw body, hex-encoded, in the x-paystack-signature header.
    const expected = crypto.createHmac("sha512", env.PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
    const provided = Buffer.from(signatureHeader);
    const match = provided.length === expected.length && crypto.timingSafeEqual(provided, Buffer.from(expected));
    if (!match) throw HttpError.unauthorized("Invalid webhook signature");

    const payload = JSON.parse(rawBody.toString("utf8")) as PaystackWebhookPayload;
    return { eventId: String(payload.data.id ?? payload.id ?? `${payload.event}:${payload.data.reference}:${payload.data.status}`), providerRef: payload.data.reference, status: mapStatus(payload.data.status), amount: fromMinorUnits(payload.data.amount), currency: payload.data.currency, rawPayload: payload };
  },
};
