import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { HttpError } from "../../utils/http-error";
import { getActivePaymentProvider } from "./provider.registry";
import type { WebhookEvent } from "./provider.interface";
import type { Prisma } from "@prisma/client";

// Creates the payment record as PENDING first, then calls the provider. The
// database row exists before any external call is made, so a crash or timeout
// mid-call never leaves an order with no payment trail at all.
export async function initializePaymentForOrder(orderId: string, amount: number, customerEmail: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const provider = getActivePaymentProvider();
  const idempotencyKey = `order_${order.id}`;

  const existing = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (existing && existing.providerRef) return { payment: existing, redirectUrl: null };
  if (existing) {
    const initialized = await provider.initialize({ orderId: order.id, amount, currency: "NGN", idempotencyKey, customerEmail });
    const updated = await prisma.payment.update({ where: { id: existing.id }, data: { providerRef: initialized.providerRef, status: "PROCESSING", failureReason: null } });
    return { payment: updated, redirectUrl: initialized.redirectUrl };
  }

  const payment = await prisma.payment.create({
    data: { orderId: order.id, provider: provider.name, idempotencyKey, amount, currency: "NGN", status: "PENDING" },
  });

  const initialized = await provider.initialize({ orderId: order.id, amount, currency: "NGN", idempotencyKey, customerEmail });

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { providerRef: initialized.providerRef, status: "PROCESSING" },
  });

  return { payment: updated, redirectUrl: initialized.redirectUrl };
}

// The one function both the webhook handler and the polling fallback call.
// Idempotent: replaying the same verified event twice is a no-op. Beyond
// flipping the payment's own status, this is also where stock actually
// changes hands: a reservation is a hold, not a sale — inventory is only
// truly spent once a payment is confirmed, and released immediately (not
// just left to expire) the moment a payment is known to have failed.
export async function reconcilePaymentStatus(provider: string, event: WebhookEvent) {
  const payment = await prisma.payment.findFirst({ where: { provider, providerRef: event.providerRef } });
  if (!payment) {
    logger.warn({ providerRef: event.providerRef }, "Received status for unknown payment reference");
    return null;
  }

  if (Number(payment.amount) !== event.amount || payment.currency !== event.currency) {
    logger.error({ paymentId: payment.id, expectedAmount: Number(payment.amount), receivedAmount: event.amount, expectedCurrency: payment.currency, receivedCurrency: event.currency }, "Payment webhook amount/currency mismatch");
    throw HttpError.badRequest("Payment amount or currency mismatch");
  }
  const recorded = await prisma.paymentWebhookEvent.createMany({ data: [{ provider, providerEventId: event.eventId, paymentId: payment.id, payload: event.rawPayload as Prisma.InputJsonValue }], skipDuplicates: true });
  if (recorded.count === 0) return payment;

  if (event.status === "verified") {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({ where: { id: payment.id, status: { notIn: ["COMPLETED", "FAILED", "REFUNDED"] } }, data: { status: "COMPLETED" } });
      if (updated.count !== 1) return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      await tx.order.update({ where: { id: payment.orderId }, data: { status: "CONFIRMED" } });

      const reservations = await tx.stockReservation.findMany({ where: { orderId: payment.orderId, status: "ACTIVE" } });
      for (const reservation of reservations) {
        await tx.inventory.update({
          where: { variantId: reservation.variantId },
          data: { totalQuantity: { decrement: reservation.quantity }, reservedQuantity: { decrement: reservation.quantity } },
        });
        await tx.stockReservation.update({ where: { id: reservation.id }, data: { status: "CONSUMED" } });
        const inventory = await tx.inventory.findUniqueOrThrow({ where: { variantId: reservation.variantId } });
        await tx.inventoryLog.create({
          data: { inventoryId: inventory.id, delta: -reservation.quantity, reason: "sale", actorUserId: null },
        });
      }
      return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    });
  }

  if (event.status === "failed") {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({ where: { id: payment.id, status: { notIn: ["COMPLETED", "FAILED", "REFUNDED"] } }, data: { status: "FAILED", failureReason: "Provider reported failure" } });
      if (updated.count !== 1) return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });

      const reservations = await tx.stockReservation.findMany({ where: { orderId: payment.orderId, status: "ACTIVE" } });
      for (const reservation of reservations) {
        await tx.inventory.update({ where: { variantId: reservation.variantId }, data: { reservedQuantity: { decrement: reservation.quantity } } });
        await tx.stockReservation.update({ where: { id: reservation.id }, data: { status: "RELEASED" } });
      }
      return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    });
  }

  return prisma.payment.update({ where: { id: payment.id }, data: { status: "PROCESSING" } });
}

export async function getPaymentStatusForOrder(orderId: string, requester: { sub: string; permissions: string[] }) {
  const payment = await prisma.payment.findFirst({ where: { orderId, order: requester.permissions.includes("orders.view") ? undefined : { userId: requester.sub } } });
  if (!payment) throw HttpError.notFound("No payment found for this order");
  return payment;
}
