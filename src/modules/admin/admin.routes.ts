import { Router } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/auth-guard";
import { requirePermission } from "../../middleware/rbac-guard";
import { ok } from "../../utils/api-response";
import { changeStaffRole, inviteStaff, listAssignableRoles, listStaff, removeStaff } from "./admin.service";

const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });
const inviteSchema = z.object({ email: z.email(), firstName: z.string().min(1), lastName: z.string().min(1), role: z.string().min(1) });
const roleSchema = z.object({ role: z.string().min(1) });

export const adminRouter = Router();
adminRouter.use(authGuard, requirePermission("admins.manage"));
adminRouter.get("/staff", async (req, res) => ok(res, await listStaff(pageSchema.parse(req.query))));
adminRouter.get("/roles", async (_req, res) => ok(res, await listAssignableRoles()));
adminRouter.post("/staff/invite", async (req, res) => ok(res, await inviteStaff(inviteSchema.parse(req.body), req.user!.sub), 201));
adminRouter.patch("/staff/:id/role", async (req, res) => ok(res, await changeStaffRole(String(req.params.id), roleSchema.parse(req.body).role, req.user!.sub)));
adminRouter.delete("/staff/:id", async (req, res) => ok(res, await removeStaff(String(req.params.id), req.user!.sub)));
