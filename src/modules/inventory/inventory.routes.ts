import { Router } from "express";

// TODO(next phase): list low-stock variants, restock endpoint (writes an
// InventoryLog row per change), and the stock-reservation TTL sweep job.
export const inventoryRouter = Router();
