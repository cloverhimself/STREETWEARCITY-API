import { Router } from "express";
import { authGuard } from "../../middleware/auth-guard";
import { requirePermission } from "../../middleware/rbac-guard";
import { HttpError } from "../../utils/http-error";
import { ok } from "../../utils/api-response";
import { createOrder, getOrder, listOrdersForUser, updateOrderStatus } from "./orders.service";
import { createOrderSchema, updateOrderStatusSchema } from "./orders.validators";

export const ordersRouter = Router();

ordersRouter.use(authGuard);

ordersRouter.post("/", async (req, res) => {
  if (!req.user) throw HttpError.unauthorized();
  const input = createOrderSchema.parse(req.body);
  const result = await createOrder(req.user.sub, input);
  return ok(res, result, 201);
});

ordersRouter.get("/", async (req, res) => {
  if (!req.user) throw HttpError.unauthorized();
  return ok(res, await listOrdersForUser(req.user.sub));
});

ordersRouter.get("/:id", async (req, res) => {
  if (!req.user) throw HttpError.unauthorized();
  return ok(res, await getOrder(req.params.id as string, { id: req.user.sub, permissions: req.user.permissions }));
});

ordersRouter.patch("/:id/status", requirePermission("orders.update"), async (req, res) => {
  if (!req.user) throw HttpError.unauthorized();
  const { status } = updateOrderStatusSchema.parse(req.body);
  return ok(res, await updateOrderStatus(req.params.id as string, status, req.user.sub));
});
