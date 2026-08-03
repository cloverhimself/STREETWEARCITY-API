import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

// Releases checkout holds nobody ever paid for. Without this, an abandoned
// cart would lock stock forever (see SRS edge case: eternal reservations) —
// the reservation itself already carries a TTL, this is what actually acts
// on it once that TTL passes.
export async function releaseExpiredReservations() {
  const expired = await prisma.stockReservation.findMany({
    where: { status: "ACTIVE", expiresAt: { lt: new Date() } },
  });

  for (const reservation of expired) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.stockReservation.updateMany({ where: { id: reservation.id, status: "ACTIVE" }, data: { status: "EXPIRED" } });
      if (claimed.count !== 1) return;
      await tx.$executeRaw`UPDATE "inventory" SET "reservedQuantity" = "reservedQuantity" - ${reservation.quantity}, "updatedAt" = NOW() WHERE "variantId" = ${reservation.variantId} AND "reservedQuantity" >= ${reservation.quantity}`;
    });
  }

  if (expired.length > 0) {
    logger.info({ count: expired.length }, "Released expired stock reservations");
  }
  return expired.length;
}
