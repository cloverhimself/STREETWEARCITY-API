import { Router } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/auth-guard";
import { requirePermission } from "../../middleware/rbac-guard";
import { ok } from "../../utils/api-response";
import { listCustomers } from "./customers.service";

const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) });
export const customersRouter = Router();
customersRouter.get("/", authGuard, requirePermission("customers.view"), async (req, res) => ok(res, await listCustomers(pageSchema.parse(req.query))));
