import { Router } from "express";
import { authGuard } from "../../middleware/auth-guard";
import { requirePermission } from "../../middleware/rbac-guard";
import { HttpError } from "../../utils/http-error";
import { ok } from "../../utils/api-response";
import { createCoupon, deleteCoupon, listCoupons, previewCoupon, updateCoupon } from "./coupons.service";
import { couponPreviewSchema, createCouponSchema, updateCouponSchema } from "./coupons.validators";

export const couponsRouter = Router();

// Public — a shopper needs to see the discount before committing to
// checkout, same reasoning as /cart/validate being unauthenticated. The
// per-customer usage limit is only authoritative at redemption time inside
// createOrder, where the requester is always known.
couponsRouter.post("/preview", async (req, res) => {
  const { code, subtotal } = couponPreviewSchema.parse(req.body);
  return ok(res, await previewCoupon(code, subtotal));
});

couponsRouter.get("/", authGuard, requirePermission("coupons.manage"), async (_req, res) => {
  return ok(res, await listCoupons());
});

couponsRouter.post("/", authGuard, requirePermission("coupons.manage"), async (req, res) => {
  if (!req.user) throw HttpError.unauthorized();
  const input = createCouponSchema.parse(req.body);
  return ok(res, await createCoupon(input, req.user.sub), 201);
});

couponsRouter.patch("/:id", authGuard, requirePermission("coupons.manage"), async (req, res) => {
  if (!req.user) throw HttpError.unauthorized();
  const input = updateCouponSchema.parse(req.body);
  return ok(res, await updateCoupon(req.params.id as string, input, req.user.sub));
});

couponsRouter.delete("/:id", authGuard, requirePermission("coupons.manage"), async (req, res) => {
  if (!req.user) throw HttpError.unauthorized();
  await deleteCoupon(req.params.id as string, req.user.sub);
  return ok(res, { deleted: true });
});
