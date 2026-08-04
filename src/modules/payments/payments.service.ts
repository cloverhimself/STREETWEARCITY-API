import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { moneyMatches } from "../../lib/money";
import { sendOrderStatusEmail } from "../../lib/sendbyte";
import { HttpError } from "../../utils/http-error";
import { getActivePaymentProvider } from "./provider.registry";
import type { WebhookEvent } from "./provider.interface";
import type { Prisma } from "@prisma/client";

export async function ingestWebhookEvent(provider: string, event: WebhookEvent) {
  const payment = await prisma.payment.findFirst({ where: { provider, OR: [{ providerRef: event.providerRef }, { idempotencyKey: event.providerRef }] } });
  const mismatch = payment ? !moneyMatches(payment.amount, event.amount) || payment.currency !== event.currency : false;
  await prisma.paymentWebhookEvent.createMany({
    data: [{
      provider,
      providerEventId: event.eventId,
      paymentId: payment?.id,
      payload: event.rawPayload as Prisma.InputJsonValue,
      normalizedEvent: event as unknown as Prisma.InputJsonValue,
      processingStatus: mismatch ? "REJECTED" : "PENDING",
      processingError: mismatch ? "Payment amount or currency mismatch" : payment ? null : "Unknown payment reference",
    }],
    skipDuplicates: true,
  });
  return prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider, providerEventId: event.eventId } } });
}

export async function processWebhookEvent(eventId: string) {
  const claimed = await prisma.paymentWebhookEvent.updateMany({ where: { id: eventId, processingStatus: "PENDING" }, data: { processingStatus: "PROCESSING", processingError: null } });
  if (claimed.count !== 1) return false;
  const stored = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
  const event = stored.normalizedEvent as unknown as WebhookEvent;
  try {
    const payment = await prisma.payment.findFirst({ where: { provider: stored.provider, OR: [{ providerRef: event.providerRef }, { idempotencyKey: event.providerRef }] } });
    if (!payment) {
      await prisma.paymentWebhookEvent.update({ where: { id: eventId }, data: { processingStatus: "PENDING", processingError: "Unknown payment reference" } });
      return false;
    }
    if (!moneyMatches(payment.amount, event.amount) || payment.currency !== event.currency) {
      await prisma.paymentWebhookEvent.update({ where: { id: eventId }, data: { paymentId: payment.id, processingStatus: "REJECTED", processingError: "Payment amount or currency mismatch", processedAt: new Date() } });
      return false;
    }
    if (!stored.paymentId) await prisma.paymentWebhookEvent.update({ where: { id: eventId }, data: { paymentId: payment.id } });
    await reconcilePaymentStatus(stored.provider, event, true);
    await prisma.paymentWebhookEvent.update({ where: { id: eventId }, data: { processingStatus: "PROCESSED", processingError: null, processedAt: new Date() } });
    return true;
  } catch (error) {
    await prisma.paymentWebhookEvent.update({ where: { id: eventId }, data: { processingStatus: "PENDING", processingError: error instanceof Error ? error.message : "Webhook processing failed" } });
    logger.error({ err: error, eventId }, "Webhook processing failed");
    return false;
  }
}

export async function processPendingWebhookEvents(limit = 50) {
  await prisma.paymentWebhookEvent.updateMany({ where: { processingStatus: "PROCESSING", createdAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } }, data: { processingStatus: "PENDING", processingError: "Recovered abandoned processing claim" } });
  const events = await prisma.paymentWebhookEvent.findMany({ where: { processingStatus: "PENDING" }, orderBy: { createdAt: "asc" }, take: limit, select: { id: true } });
  let processed = 0;
  for (const event of events) if (await processWebhookEvent(event.id)) processed += 1;
  return { scanned: events.length, processed };
}

// Creates the payment record as PENDING first, then calls the provider. The
// database row exists before any external call is made, so a crash or timeout
// mid-call never leaves an order with no payment trail at all.
export async function initializePaymentForOrder(orderId: string, amount: number, customerEmail: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const provider = getActivePaymentProvider();
  const idempotencyKey = `order_${order.id}`;

  const existing = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (existing && existing.providerRef) return { payment: existing, redirectUrl: existing.authorizationUrl };
  if (existing) {
    try {
      const verified = await provider.verify(idempotencyKey);
      await reconcilePaymentStatus(provider.name, { eventId: `initialization-recovery:${idempotencyKey}:${verified.status}`, providerRef: verified.providerRef, status: verified.status, amount: verified.amount, currency: verified.currency, rawPayload: { source: "initialization-recovery", result: verified } });
      const recovered = await prisma.payment.findUniqueOrThrow({ where: { id: existing.id } });
      return { payment: recovered, redirectUrl: recovered.authorizationUrl };
    } catch {
      try {
        const initialized = await provider.initialize({ orderId: order.id, amount, currency: "NGN", idempotencyKey, customerEmail });
        const updated = await prisma.payment.update({ where: { id: existing.id }, data: { providerRef: initialized.providerRef, authorizationUrl: initialized.redirectUrl, status: "PROCESSING", failureReason: null, initializationError: null, lastInitializationAt: new Date() } });
        return { payment: updated, redirectUrl: initialized.redirectUrl };
      } catch (error) {
        await prisma.payment.update({ where: { id: existing.id }, data: { initializationError: error instanceof Error ? error.message : "Payment initialization failed", lastInitializationAt: new Date() } });
        throw error;
      }
    }
  }

  const payment = await prisma.payment.create({
    data: { orderId: order.id, provider: provider.name, idempotencyKey, amount, currency: "NGN", status: "PENDING" },
  });

  let initialized;
  try {
    initialized = await provider.initialize({ orderId: order.id, amount, currency: "NGN", idempotencyKey, customerEmail });
  } catch (error) {
    await prisma.payment.update({ where: { id: payment.id }, data: { initializationError: error instanceof Error ? error.message : "Payment initialization failed", lastInitializationAt: new Date() } });
    throw error;
  }

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { providerRef: initialized.providerRef, authorizationUrl: initialized.redirectUrl, status: "PROCESSING", lastInitializationAt: new Date() },
  });

  return { payment: updated, redirectUrl: initialized.redirectUrl };
}

// The one function both the webhook handler and the polling fallback call.
// Idempotent: replaying the same verified event twice is a no-op. Beyond
// flipping the payment's own status, this is also where stock actually
// changes hands: a reservation is a hold, not a sale — inventory is only
// truly spent once a payment is confirmed, and released immediately (not
// just left to expire) the moment a payment is known to have failed.
export async function reconcilePaymentStatus(provider: string, event: WebhookEvent, eventAlreadyRecorded = false) {
  const payment = await prisma.payment.findFirst({ where: { provider, OR: [{ providerRef: event.providerRef }, { idempotencyKey: event.providerRef }] } });
  if (!payment) {
    logger.warn({ providerRef: event.providerRef }, "Received status for unknown payment reference");
    return null;
  }

  if (!moneyMatches(payment.amount, event.amount) || payment.currency !== event.currency) {
    logger.error({ paymentId: payment.id, expectedAmount: Number(payment.amount), receivedAmount: event.amount, expectedCurrency: payment.currency, receivedCurrency: event.currency }, "Payment webhook amount/currency mismatch");
    throw HttpError.badRequest("Payment amount or currency mismatch");
  }
  if (!payment.providerRef) await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: event.providerRef } });
  if (event.status === "verified") {
    const settled = await prisma.$transaction(async (tx) => {
      if (!eventAlreadyRecorded) {
        const recorded = await tx.paymentWebhookEvent.createMany({ data: [{ provider, providerEventId: event.eventId, paymentId: payment.id, payload: event.rawPayload as Prisma.InputJsonValue, normalizedEvent: event as unknown as Prisma.InputJsonValue, processingStatus: "PROCESSED", processedAt: new Date() }], skipDuplicates: true });
        if (recorded.count === 0) return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      }
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
      const order = await tx.order.update({ where: { id: payment.orderId }, data: { status: "CONFIRMED" }, include: { user: { select: { email: true } } } });
      await tx.notification.create({ data: { userId: order.userId, title: "Order confirmed", body: `Payment confirmed for order ${order.orderNumber}.` } });
      return { payment: await tx.payment.findUniqueOrThrow({ where: { id: payment.id } }), email: order.user.email, orderNumber: order.orderNumber };
    });
    if ("email" in settled) await sendOrderStatusEmail(settled.email, { orderNumber: settled.orderNumber, status: "CONFIRMED" });
    return "payment" in settled ? settled.payment : settled;
  }

  if (event.status === "failed") {
    return prisma.$transaction(async (tx) => {
      if (!eventAlreadyRecorded) {
        const recorded = await tx.paymentWebhookEvent.createMany({ data: [{ provider, providerEventId: event.eventId, paymentId: payment.id, payload: event.rawPayload as Prisma.InputJsonValue, normalizedEvent: event as unknown as Prisma.InputJsonValue, processingStatus: "PROCESSED", processedAt: new Date() }], skipDuplicates: true });
        if (recorded.count === 0) return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      }
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
    if (!eventAlreadyRecorded) {
      const recorded = await tx.paymentWebhookEvent.createMany({ data: [{ provider, providerEventId: event.eventId, paymentId: payment.id, payload: event.rawPayload as Prisma.InputJsonValue, normalizedEvent: event as unknown as Prisma.InputJsonValue, processingStatus: "PROCESSED", processedAt: new Date() }], skipDuplicates: true });
      if (recorded.count === 0) return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    }
    return tx.payment.update({ where: { id: payment.id }, data: { status: "PROCESSING" } });
  });
}

export async function reconcilePendingPayments(limit = 25) {
  const provider = getActivePaymentProvider();
  const payments = await prisma.payment.findMany({
    where: {
      provider: provider.name,
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
    if (claimed.count !== 1) continue;
    const reference = payment.providerRef ?? payment.idempotencyKey;

    try {
      const result = await provider.verify(reference);
      await reconcilePaymentStatus(provider.name, {
        eventId: `poll:${reference}:${result.status}:${result.amount}:${result.currency}`,
        providerRef: result.providerRef,
        status: result.status,
        amount: result.amount,
        currency: result.currency,
        rawPayload: { source: "reconciliation", result },
      });
      processed += 1;
    } catch (err) {
      logger.error({ err, paymentId: payment.id, providerRef: reference }, "Payment reconciliation failed");
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
  const [nonTerminal, failed24h, webhook24h, mismatch24h, uncertainInitialization, unlinkedWebhooks, pendingWebhooks] = await Promise.all([
    prisma.payment.findMany({ where: { status: { in: ["PENDING", "PROCESSING"] } }, select: { status: true, reconcileAttempts: true, nextReconcileAt: true, createdAt: true } }),
    prisma.payment.count({ where: { status: "FAILED", updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
    prisma.paymentWebhookEvent.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
    prisma.paymentWebhookEvent.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, processingStatus: "REJECTED" } }),
    prisma.payment.count({ where: { status: "PENDING", providerRef: null, initializationError: { not: null } } }),
    prisma.paymentWebhookEvent.count({ where: { paymentId: null } }),
    prisma.paymentWebhookEvent.count({ where: { processingStatus: { in: ["PENDING", "PROCESSING"] }, createdAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } } }),
  ]);
  const overdue = nonTerminal.filter((payment) => payment.nextReconcileAt !== null && payment.nextReconcileAt <= now).length;
  const highRetry = nonTerminal.filter((payment) => payment.reconcileAttempts >= 5).length;
  return {
    generatedAt: now.toISOString(),
    payments: { pending: nonTerminal.filter((payment) => payment.status === "PENDING").length, processing: nonTerminal.filter((payment) => payment.status === "PROCESSING").length, overdue, highRetry, failedLast24h: failed24h, uncertainInitialization },
    webhooks: { receivedLast24h: webhook24h, mismatchesLast24h: mismatch24h, unlinked: unlinkedWebhooks, stuck: pendingWebhooks },
    alerts: { overduePayments: overdue > 0, repeatedReconciliationFailures: highRetry > 0, failedPaymentsLast24h: failed24h > 0, webhookMismatchesLast24h: mismatch24h > 0, uncertainInitialization: uncertainInitialization > 0, unlinkedWebhooks: unlinkedWebhooks > 0, stuckWebhookProcessing: pendingWebhooks > 0 },
  };
}
