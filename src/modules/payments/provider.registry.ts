import { env } from "../../lib/env";
import { bachsProvider } from "./providers/bachs/bachs.provider";
import { paystackProvider } from "./providers/paystack/paystack.provider";
import type { PaymentProvider } from "./provider.interface";

// Add new providers here as they're built, then flip PAYMENT_PROVIDER in env
// to switch. Nothing outside this file needs to know which provider is active.
const providers: Record<string, PaymentProvider> = {
  bachs: bachsProvider,
  paystack: paystackProvider,
};

export function getActivePaymentProvider(): PaymentProvider {
  const provider = providers[env.PAYMENT_PROVIDER];
  if (!provider) throw new Error(`Unknown payment provider: ${env.PAYMENT_PROVIDER}`);
  return provider;
}
