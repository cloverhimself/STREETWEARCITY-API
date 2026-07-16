import { Router } from "express";

// TODO(next phase): create order (server-recalculated pricing, never trust
// client totals), list/detail for the account order-history views, and the
// admin status-transition endpoints (Pending -> Confirmed -> Processing ->
// Shipped -> Delivered / Cancelled).
export const ordersRouter = Router();
