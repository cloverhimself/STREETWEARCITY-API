import { app } from "./app";
import { env } from "./lib/env";
import { logger } from "./lib/logger";
import { releaseExpiredReservations } from "./modules/inventory/inventory.service";

const RESERVATION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

app.listen(env.PORT, () => {
  logger.info(`streetwarecity-api listening on port ${env.PORT} (${env.NODE_ENV})`);
});

// No queue system exists at this scale — a plain interval is enough to keep
// abandoned checkouts from locking stock forever (see the SRS "eternal
// reservations" edge case in the inventory module).
setInterval(() => {
  releaseExpiredReservations().catch((err) => logger.error({ err }, "Stock reservation sweep failed"));
}, RESERVATION_SWEEP_INTERVAL_MS);
