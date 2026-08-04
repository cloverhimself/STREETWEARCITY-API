import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { HttpError } from "../../utils/http-error";

export async function releaseExpiredReservations() {
  const expired = await prisma.stockReservation.findMany({ where: { status: "ACTIVE", expiresAt: { lt: new Date() } } });
  for (const reservation of expired) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.stockReservation.updateMany({ where: { id: reservation.id, status: "ACTIVE" }, data: { status: "EXPIRED" } });
      if (claimed.count !== 1) return;
      await tx.$executeRaw`UPDATE "inventory" SET "reservedQuantity" = "reservedQuantity" - ${reservation.quantity}, "updatedAt" = NOW() WHERE "variantId" = ${reservation.variantId} AND "reservedQuantity" >= ${reservation.quantity}`;
    });
  }
  if (expired.length > 0) logger.info({ count: expired.length }, "Released expired stock reservations");
  return expired.length;
}

export async function listLowStock(input: { threshold: number; page: number; pageSize: number }) {
  const offset = (input.page - 1) * input.pageSize;
  const rows = await prisma.$queryRaw<Array<{ inventoryId: string; variantId: string; productId: string; productName: string; productSku: string; color: string; size: string; totalQuantity: number; reservedQuantity: number; availableQuantity: number }>>`
    SELECT i.id AS "inventoryId", i."variantId", p.id AS "productId", p.name AS "productName", p.sku AS "productSku",
           v.color, v.size, i."totalQuantity", i."reservedQuantity",
           i."totalQuantity" - i."reservedQuantity" AS "availableQuantity"
    FROM "inventory" i
    JOIN "product_variants" v ON v.id = i."variantId"
    JOIN "products" p ON p.id = v."productId"
    WHERE p."isActive" = true AND p."deletedAt" IS NULL
      AND i."totalQuantity" - i."reservedQuantity" <= ${input.threshold}
    ORDER BY "availableQuantity" ASC, i."updatedAt" ASC
    LIMIT ${input.pageSize} OFFSET ${offset}
  `;
  const countRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "inventory" i
    JOIN "product_variants" v ON v.id = i."variantId"
    JOIN "products" p ON p.id = v."productId"
    WHERE p."isActive" = true AND p."deletedAt" IS NULL
      AND i."totalQuantity" - i."reservedQuantity" <= ${input.threshold}
  `;
  const total = Number(countRows[0]?.count ?? 0);
  return {
    items: rows,
    pagination: { page: input.page, pageSize: input.pageSize, total, totalPages: Math.ceil(total / input.pageSize) },
    threshold: input.threshold,
  };
}

export async function restockVariant(variantId: string, quantity: number, actorUserId: string) {
  const result = await prisma.$transaction(async (tx) => {
    const inventory = await tx.inventory.findUnique({ where: { variantId }, include: { variant: { include: { product: { select: { id: true, name: true, sku: true } } } } } });
    if (!inventory) throw HttpError.notFound("Inventory variant not found");
    const updated = await tx.inventory.update({ where: { id: inventory.id }, data: { totalQuantity: { increment: quantity } } });
    await tx.inventoryLog.create({ data: { inventoryId: inventory.id, delta: quantity, reason: "restock", actorUserId } });
    return { inventory: updated, variant: inventory.variant };
  });
  return {
    inventoryId: result.inventory.id,
    variantId,
    productId: result.variant.product.id,
    productName: result.variant.product.name,
    productSku: result.variant.product.sku,
    totalQuantity: result.inventory.totalQuantity,
    reservedQuantity: result.inventory.reservedQuantity,
    availableQuantity: result.inventory.totalQuantity - result.inventory.reservedQuantity,
    restockedBy: actorUserId,
  };
}
