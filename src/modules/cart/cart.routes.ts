import { Router } from "express";

// TODO(next phase): cart lines are client-held (matches the current frontend
// prototype); this module's job is checkout — turning a cart into a
// StockReservation + Order, with the atomic race-condition handling described
// in ARCHITECTURE.md.
export const cartRouter = Router();
