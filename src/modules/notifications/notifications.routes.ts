import { Router } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/auth-guard";
import { ok } from "../../utils/api-response";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "./notifications.service";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  unreadOnly: z.enum(["true", "false"]).transform((value) => value === "true").default(false),
});

export const notificationsRouter = Router();
notificationsRouter.use(authGuard);

notificationsRouter.get("/", async (req, res) => ok(res, await listNotifications(req.user!.sub, querySchema.parse(req.query))));
notificationsRouter.patch("/read-all", async (req, res) => ok(res, await markAllNotificationsRead(req.user!.sub)));
notificationsRouter.patch("/:id/read", async (req, res) => ok(res, await markNotificationRead(req.user!.sub, String(req.params.id))));
