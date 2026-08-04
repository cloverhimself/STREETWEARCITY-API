import { Router } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/auth-guard";
import { requirePermission } from "../../middleware/rbac-guard";
import { ok } from "../../utils/api-response";
import { bestSellers, orderTrends, revenueAnalytics, topCustomers } from "./analytics.service";

const rangeSchema = z.object({ from: z.coerce.date().default(() => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)), to: z.coerce.date().default(() => new Date()), interval: z.enum(["day", "week", "month"]).default("day") });
const rankingSchema = z.object({ from: z.coerce.date().default(() => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)), to: z.coerce.date().default(() => new Date()), limit: z.coerce.number().int().min(1).max(100).default(10) });

export const analyticsRouter = Router();
analyticsRouter.use(authGuard, requirePermission("analytics.view"));
analyticsRouter.get("/revenue", async (req, res) => ok(res, await revenueAnalytics(rangeSchema.parse(req.query))));
analyticsRouter.get("/orders", async (req, res) => ok(res, await orderTrends(rangeSchema.parse(req.query))));
analyticsRouter.get("/top-customers", async (req, res) => ok(res, await topCustomers(rankingSchema.parse(req.query))));
analyticsRouter.get("/best-sellers", async (req, res) => ok(res, await bestSellers(rankingSchema.parse(req.query))));
