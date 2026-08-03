// Every payment provider (Bachs today, anything else later) implements this
// contract. Business logic talks to `PaymentProvider`, never to a specific
// provider's SDK directly, so swapping providers means adding a new folder
// under providers/ and flipping PAYMENT_PROVIDER in env, not rewriting checkout.

export interface InitializePaymentInput {
  orderId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  customerEmail: string;
}

export interface InitializePaymentResult {
  providerRef: string;
  // Where the client should be sent to complete payment (hosted checkout page).
  redirectUrl: string;
}

export type VerifiedPaymentStatus = "verified" | "pending" | "failed";

export interface VerifyPaymentResult {
  status: VerifiedPaymentStatus;
  providerRef: string;
  amount: number;
  currency: string;
}

export interface WebhookEvent {
  providerRef: string;
  status: VerifiedPaymentStatus;
  rawPayload: unknown;
}

export interface PaymentProvider {
  readonly name: string;

  // Lowercase request header the provider signs its webhook with (e.g.
  // "x-paystack-signature"), so the route can extract it generically instead
  // of hardcoding one provider's header name.
  readonly webhookSignatureHeader: string;

  initialize(input: InitializePaymentInput): Promise<InitializePaymentResult>;

  verify(providerRef: string): Promise<VerifyPaymentResult>;

  // Validates the webhook signature and normalizes the payload. Throws if the
  // signature doesn't check out — callers must never process an unverified event.
  parseWebhook(rawBody: Buffer, signatureHeader: string | undefined): WebhookEvent;
}
