import { Router } from "express";
import multer from "multer";
import { authGuard } from "../../middleware/auth-guard";
import { requirePermission } from "../../middleware/rbac-guard";
import { uploadProductImage } from "../../lib/cloudinary";
import { HttpError } from "../../utils/http-error";
import { ok } from "../../utils/api-response";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Only image uploads are allowed"));
    cb(null, true);
  },
});

export const uploadsRouter = Router();

// Product images only for now — gated on the same permission that lets an
// admin create a product in the first place.
uploadsRouter.post("/product-image", authGuard, requirePermission("products.create"), upload.single("image"), async (req, res) => {
  if (!req.file) throw HttpError.badRequest("No image file provided (expected multipart field 'image')");
  const { url } = await uploadProductImage(req.file.buffer);
  return ok(res, { url }, 201);
});
