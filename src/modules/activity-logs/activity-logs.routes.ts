import { Router } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/auth-guard";
import { requirePermission } from "../../middleware/rbac-guard";
import { ok } from "../../utils/api-response";
import { listActivityLogs } from "./activity-logs.service";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().min(1).optional(),
  resourceType: z.string().min(1).optional(),
  actorUserId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const activityLogsRouter = Router();

activityLogsRouter.get("/", authGuard, requirePermission("logs.view"), async (req, res) => {
  return ok(res, await listActivityLogs(querySchema.parse(req.query)));
});
