import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

// Releases checkout holds nobody ever paid for. Without this, an abandoned
// cart would lock stock forever (see SRS edge case: eternal reservations) —
// the reservation itself already carries a TTL, this is what actually acts
// on it once that TTL passes.
export async function releaseExpiredReservations() {
  const expired = await prisma.stockReservation.findMany({
    where: { status: "active", expiresAt: { lt: new Date() } },
  });

  for (const reservation of expired) {
    await prisma.$transaction([
      prisma.inventory.update({
        where: { variantId: reservation.variantId },
        data: { reservedQuantity: { decrement: reservation.quantity } },
      }),
      prisma.stockReservation.update({ where: { id: reservation.id }, data: { status: "expired" } }),
    ]);
  }

  if (expired.length > 0) {
    logger.info({ count: expired.length }, "Released expired stock reservations");
  }
  return expired.length;
}
