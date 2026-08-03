import type { OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../utils/http-error";
import { resolveCartLines, type CartLineInput } from "../cart/cart.service";
import { initializePaymentForOrder } from "../payments/payments.service";
import type { createOrderSchema } from "./orders.validators";
import type { z } from "zod";

const RESERVATION_TTL_MS = 15 * 60 * 1000;

const orderInclude = {
  shippingAddress: true,
  payment: true,
  items: {
    include: {
      product: { select: { id: true, name: true, images: { take: 1, orderBy: { position: "asc" as const } } } },
      variant: { select: { color: true, size: true } },
    },
  },
} satisfies Prisma.OrderInclude;

function mapOrder(order: Prisma.OrderGetPayload<{ include: typeof orderInclude }>) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    subtotal: Number(order.subtotal),
    deliveryFee: Number(order.deliveryFee),
    discount: Number(order.discount),
    total: Number(order.total),
    notes: order.notes,
    createdAt: order.createdAt.toISOString(),
    shippingAddress: {
      firstName: order.shippingAddress.firstName,
      lastName: order.shippingAddress.lastName,
      phone: order.shippingAddress.phone,
      line1: order.shippingAddress.line1,
      line2: order.shippingAddress.line2,
      city: order.shippingAddress.city,
      state: order.shippingAddress.state,
      zip: order.shippingAddress.zip,
    },
    items: order.items.map((it) => ({
      productId: it.productId,
      productName: it.product.name,
      image: it.product.images[0]?.url ?? "",
      color: it.variant.color,
      size: it.variant.size,
      quantity: it.quantity,
      unitPrice: Number(it.unitPrice),
      lineTotal: Number(it.unitPrice) * it.quantity,
    })),
    payment: order.payment ? { status: order.payment.status, provider: order.payment.provider } : null,
  };
}

function deliveryFeeFor(method: string, subtotal: number): number {
  if (method === "express") return 18;
  if (method === "pickup") return 0;
  return subtotal > 150 ? 0 : 9;
}

function generateOrderNumber(): string {
  return "SWC-" + Math.floor(10000 + Math.random() * 89999);
}

export async function createOrder(userId: string, input: z.infer<typeof createOrderSchema>) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const resolved = await resolveCartLines(input.items as CartLineInput[]);
  const bad = resolved.filter((l) => l.issue !== null);
  if (bad.length > 0) {
    const detail = bad.map((l) => `${l.productName || l.productId} (${l.issue === "not_found" ? "no longer available" : "insufficient stock"})`).join(", ");
    throw HttpError.badRequest(`Some items in your cart changed: ${detail}`);
  }

  const subtotal = resolved.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);
  const deliveryFee = deliveryFeeFor(input.deliveryMethod, subtotal);
  // Matches the storefront's existing demo coupon behavior (any non-empty code = 10% off) —
  // there's no real promotions system yet, this just keeps the total customers see in the
  // cart drawer consistent with what actually gets charged.
  const discount = input.couponCode?.trim() ? subtotal * 0.1 : 0;
  const total = Math.max(0, subtotal + deliveryFee - discount);

  const orderId = await prisma.$transaction(async (tx) => {
    const address = await tx.address.create({
      data: {
        userId,
        label: "Checkout",
        firstName: input.shipping.first,
        lastName: input.shipping.last,
        phone: input.shipping.phone,
        line1: input.shipping.address,
        city: input.shipping.city,
        state: input.shipping.state,
        zip: input.shipping.zip,
      },
    });

    const order = await tx.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        userId,
        status: "PENDING",
        subtotal,
        deliveryFee,
        discount,
        total,
        shippingAddressId: address.id,
        notes: input.notes,
        items: {
          create: resolved.map((l) => ({
            productId: l.productId,
            variantId: l.variantId as string,
            quantity: l.qty,
            unitPrice: l.unitPrice,
          })),
        },
      },
    });

    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
    for (const line of resolved) {
      await tx.stockReservation.create({
        data: { variantId: line.variantId as string, orderId: order.id, quantity: line.qty, status: "active", expiresAt },
      });
      await tx.inventory.update({
        where: { variantId: line.variantId as string },
        data: { reservedQuantity: { increment: line.qty } },
      });
    }

    return order.id;
  });

  let paymentError: string | null = null;
  let redirectUrl: string | null = null;
  try {
    const initialized = await initializePaymentForOrder(orderId, total, user.email);
    redirectUrl = initialized.redirectUrl;
  } catch (err) {
    // The order and its reservation stay committed regardless — business
    // processing and money movement are separate concerns. A failed payment
    // kickoff (e.g. the provider isn't configured yet) doesn't erase the order.
    paymentError = err instanceof Error ? err.message : "Payment could not be started";
  }

  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
  return { order: mapOrder(order), paymentError, redirectUrl };
}

export async function listOrdersForUser(userId: string) {
  const orders = await prisma.order.findMany({ where: { userId }, include: orderInclude, orderBy: { createdAt: "desc" } });
  return orders.map(mapOrder);
}

export async function getOrder(orderId: string, requester: { id: string; permissions: string[] }) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) throw HttpError.notFound("Order not found");
  if (order.userId !== requester.id && !requester.permissions.includes("orders.view")) {
    throw HttpError.forbidden();
  }
  return mapOrder(order);
}

export async function updateOrderStatus(orderId: string, status: OrderStatus, actorUserId: string) {
  const existing = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const order = await prisma.order.update({
    where: { id: orderId },
    data: { status },
    include: orderInclude,
  });
  await prisma.activityLog.create({
    data: { actorUserId, action: "order.status_updated", resourceType: "order", resourceId: orderId, oldValue: { status: existing.status }, newValue: { status } },
  });
  return mapOrder(order);
}
