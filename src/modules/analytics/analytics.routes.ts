import { Router } from "express";

// TODO(next phase): revenue/orders/customers/best-sellers aggregations for
// the admin analytics view — read-heavy, so these should hit indexed queries
// or a summary table rather than aggregating raw orders on every request.
export const analyticsRouter = Router();
