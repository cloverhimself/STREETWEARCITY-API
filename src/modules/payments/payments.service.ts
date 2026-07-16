import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { HttpError } from "../../utils/http-error";
import { getActivePaymentProvider } from "./provider.registry";

// Creates the payment record as PENDING first, then calls the provider. The
// database row exists before any external call is made, so a crash or timeout
// mid-call never leaves an order with no payment trail at all.
export async function initializePaymentForOrder(orderId: string, amount: number, customerEmail: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const provider = getActivePaymentProvider();
  const idempotencyKey = `order_${order.id}`;

  const existing = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;

  const payment = await prisma.payment.create({
    data: { orderId: order.id, provider: provider.name, idempotencyKey, amount, currency: "NGN", status: "PENDING" },
  });

  const initialized = await provider.initialize({ orderId: order.id, amount, currency: "NGN", idempotencyKey, customerEmail });

  return prisma.payment.update({
    where: { id: payment.id },
    data: { providerRef: initialized.providerRef, status: "PROCESSING" },
  });
}

// The one function both the webhook handler and the polling fallback call.
// Idempotent: replaying the same verified event twice is a no-op.
export async function reconcilePaymentStatus(providerRef: string, status: "verified" | "pending" | "failed") {
  const payment = await prisma.payment.findFirst({ where: { providerRef } });
  if (!payment) {
    logger.warn({ providerRef }, "Received status for unknown payment reference");
    return null;
  }

  if (payment.status === "COMPLETED" || payment.status === "FAILED") {
    return payment; // already settled, nothing to do
  }

  if (status === "verified") {
    return prisma.payment.update({ where: { id: payment.id }, data: { status: "COMPLETED" } });
  }
  if (status === "failed") {
    return prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED", failureReason: "Provider reported failure" } });
  }
  return prisma.payment.update({ where: { id: payment.id }, data: { status: "PROCESSING" } });
}

export async function getPaymentStatusForOrder(orderId: string) {
  const payment = await prisma.payment.findUnique({ where: { orderId } });
  if (!payment) throw HttpError.notFound("No payment found for this order");
  return payment;
}
