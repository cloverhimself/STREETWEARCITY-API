import { Router } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/auth-guard";
import { requirePermission } from "../../middleware/rbac-guard";
import { ok } from "../../utils/api-response";
import { listLowStock, restockVariant } from "./inventory.service";

const lowStockQuery = z.object({
  threshold: z.coerce.number().int().min(0).max(1000).default(5),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const restockBody = z.object({
  quantity: z.number().int().positive().max(1_000_000),
});

export const inventoryRouter = Router();

inventoryRouter.use(authGuard);

inventoryRouter.get("/low-stock", requirePermission("inventory.view"), async (req, res) => {
  const { threshold, page, pageSize } = lowStockQuery.parse(req.query);
  return ok(res, await listLowStock({ threshold, page, pageSize }));
});

inventoryRouter.post("/:variantId/restock", requirePermission("inventory.update"), async (req, res) => {
  const { quantity } = restockBody.parse(req.body);
  const variantId = String(req.params.variantId);
  return ok(res, await restockVariant(variantId, quantity, req.user!.sub));
});
