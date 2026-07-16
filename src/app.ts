import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./lib/env";
import { logger } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { apiRateLimit } from "./middleware/rate-limit";
import { activityLogsRouter } from "./modules/activity-logs/activity-logs.routes";
import { adminRouter } from "./modules/admin/admin.routes";
import { analyticsRouter } from "./modules/analytics/analytics.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { cartRouter } from "./modules/cart/cart.routes";
import { inventoryRouter } from "./modules/inventory/inventory.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { ordersRouter } from "./modules/orders/orders.routes";
import { paymentsRouter } from "./modules/payments/payments.routes";
import { productsRouter } from "./modules/products/products.routes";

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
app.use(pinoHttp({ logger }));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Mounted before the global JSON parser: the webhook route needs the raw,
// unparsed request body to verify the provider's signature (see payments.routes.ts).
app.use("/api/v1/payments", paymentsRouter);

app.use(express.json());
app.use(apiRateLimit);

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/products", productsRouter);
app.use("/api/v1/inventory", inventoryRouter);
app.use("/api/v1/cart", cartRouter);
app.use("/api/v1/orders", ordersRouter);
app.use("/api/v1/notifications", notificationsRouter);
app.use("/api/v1/analytics", analyticsRouter);
app.use("/api/v1/activity-logs", activityLogsRouter);
app.use("/api/v1/admin", adminRouter);

app.use(notFoundHandler);
app.use(errorHandler);
