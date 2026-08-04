import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { moneyMatches } from "../../lib/money";
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

  if (!moneyMatches(payment.amount, event.amount) || payment.currency !== event.currency) {
    logger.error({ paymentId: payment.id, expectedAmount: Number(payment.amount), receivedAmount: event.amount, expectedCurrency: payment.currency, receivedCurrency: event.currency }, "Payment webhook amount/currency mismatch");
    throw HttpError.badRequest("Payment amount or currency mismatch");
  }
  if (event.status === "verified") {
    return prisma.$transaction(async (tx) => {
      const recorded = await tx.paymentWebhookEvent.createMany({ data: [{ provider, providerEventId: event.eventId, paymentId: payment.id, payload: event.rawPayload as Prisma.InputJsonValue }], skipDuplicates: true });
      if (recorded.count === 0) return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const updated = await tx.payment.updateMany({ where: { id: payment.id, status: { notIn: ["COMPLETED", "FAILED", "REFUNDED"] } }, data: { status: "COMPLETED" } });
      if (updated.count !== 1) return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });

      const reservations = await tx.stockReservation.findMany({ where: { orderId: payment.orderId } });
      const claimed = await tx.stockReservation.updateMany({ where: { orderId: payment.orderId, status: "ACTIVE" }, data: { status: "CONSUMED" } });
      if (reservations.length === 0 || claimed.count !== reservations.length) {
        throw HttpError.conflict("Payment succeeded after its stock reservation was released or expired");
      }
      for (const reservation of reservations) {
        await tx.inventory.update({
          where: { variantId: reservation.variantId },
          data: { totalQuantity: { decrement: reservation.quantity }, reservedQuantity: { decrement: reservation.quantity } },
        });
        const inventory = await tx.inventory.findUniqueOrThrow({ where: { variantId: reservation.variantId } });
        await tx.inventoryLog.create({
          data: { inventoryId: inventory.id, delta: -reservation.quantity, reason: "sale", actorUserId: null },
        });
      }
      await tx.order.update({ where: { id: payment.orderId }, data: { status: "CONFIRMED" } });
      return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    });
  }

  if (event.status === "failed") {
    return prisma.$transaction(async (tx) => {
      const recorded = await tx.paymentWebhookEvent.createMany({ data: [{ provider, providerEventId: event.eventId, paymentId: payment.id, payload: event.rawPayload as Prisma.InputJsonValue }], skipDuplicates: true });
      if (recorded.count === 0) return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
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

  return prisma.$transaction(async (tx) => {
    const recorded = await tx.paymentWebhookEvent.createMany({ data: [{ provider, providerEventId: event.eventId, paymentId: payment.id, payload: event.rawPayload as Prisma.InputJsonValue }], skipDuplicates: true });
    if (recorded.count === 0) return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    return tx.payment.update({ where: { id: payment.id }, data: { status: "PROCESSING" } });
  });
}

export async function reconcilePendingPayments(limit = 25) {
  const provider = getActivePaymentProvider();
  const payments = await prisma.payment.findMany({
    where: {
      provider: provider.name,
      providerRef: { not: null },
      status: { in: ["PROCESSING", "PENDING"] },
      OR: [{ nextReconcileAt: null }, { nextReconcileAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let processed = 0;
  for (const payment of payments) {
    const claimed = await prisma.payment.updateMany({
      where: { id: payment.id, status: { in: ["PROCESSING", "PENDING"] }, OR: [{ nextReconcileAt: null }, { nextReconcileAt: { lte: new Date() } }] },
      data: { lastReconciledAt: new Date(), reconcileAttempts: { increment: 1 }, nextReconcileAt: new Date(Date.now() + backoffMs(payment.reconcileAttempts + 1)) },
    });
    if (claimed.count !== 1 || !payment.providerRef) continue;

    try {
      const result = await provider.verify(payment.providerRef);
      await reconcilePaymentStatus(provider.name, {
        eventId: `poll:${payment.providerRef}:${result.status}:${result.amount}:${result.currency}`,
        providerRef: result.providerRef,
        status: result.status,
        amount: result.amount,
        currency: result.currency,
        rawPayload: { source: "reconciliation", result },
      });
      processed += 1;
    } catch (err) {
      logger.error({ err, paymentId: payment.id, providerRef: payment.providerRef }, "Payment reconciliation failed");
    }
  }
  return { scanned: payments.length, processed };
}

function backoffMs(attempt: number) {
  return Math.min(60 * 60 * 1000, 2_000 * 2 ** Math.min(attempt - 1, 8));
}

export async function getPaymentStatusForOrder(orderId: string, requester: { sub: string; permissions: string[] }) {
  const payment = await prisma.payment.findFirst({ where: { orderId, order: requester.permissions.includes("orders.view") ? undefined : { userId: requester.sub } } });
  if (!payment) throw HttpError.notFound("No payment found for this order");
  return payment;
}

export async function getPaymentOperationsSummary() {
  const now = new Date();
  const [nonTerminal, failed24h, webhook24h, mismatch24h] = await Promise.all([
    prisma.payment.findMany({ where: { status: { in: ["PENDING", "PROCESSING"] } }, select: { status: true, reconcileAttempts: true, nextReconcileAt: true, createdAt: true } }),
    prisma.payment.count({ where: { status: "FAILED", updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
    prisma.paymentWebhookEvent.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
    prisma.paymentWebhookEvent.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, payload: { path: ["mismatch"], equals: true } } }),
  ]);
  const overdue = nonTerminal.filter((payment) => payment.nextReconcileAt !== null && payment.nextReconcileAt <= now).length;
  const highRetry = nonTerminal.filter((payment) => payment.reconcileAttempts >= 5).length;
  return {
    generatedAt: now.toISOString(),
    payments: { pending: nonTerminal.filter((payment) => payment.status === "PENDING").length, processing: nonTerminal.filter((payment) => payment.status === "PROCESSING").length, overdue, highRetry, failedLast24h: failed24h },
    webhooks: { receivedLast24h: webhook24h, mismatchesLast24h: mismatch24h },
    alerts: { overduePayments: overdue > 0, repeatedReconciliationFailures: highRetry > 0, failedPaymentsLast24h: failed24h > 0, webhookMismatchesLast24h: mismatch24h > 0 },
  };
}
