import { Router } from "express";
import { authGuard } from "../../middleware/auth-guard";
import { requirePermission } from "../../middleware/rbac-guard";
import { HttpError } from "../../utils/http-error";
import { ok } from "../../utils/api-response";
import { createProduct, deleteProduct, getProduct, listProducts, updateProduct } from "./products.service";
import { createProductSchema, updateProductSchema } from "./products.validators";

export const productsRouter = Router();

productsRouter.get("/", async (_req, res) => {
  return ok(res, await listProducts());
});

productsRouter.get("/:id", async (req, res) => {
  return ok(res, await getProduct(req.params.id as string));
});

productsRouter.post("/", authGuard, requirePermission("products.create"), async (req, res) => {
  if (!req.user) throw HttpError.unauthorized();
  const input = createProductSchema.parse(req.body);
  return ok(res, await createProduct(input, req.user.sub), 201);
});

productsRouter.patch("/:id", authGuard, requirePermission("products.edit"), async (req, res) => {
  if (!req.user) throw HttpError.unauthorized();
  const input = updateProductSchema.parse(req.body);
  return ok(res, await updateProduct(req.params.id as string, input, req.user.sub));
});

productsRouter.delete("/:id", authGuard, requirePermission("products.delete"), async (req, res) => {
  if (!req.user) throw HttpError.unauthorized();
  await deleteProduct(req.params.id as string, req.user.sub);
  return ok(res, { deleted: true });
});
