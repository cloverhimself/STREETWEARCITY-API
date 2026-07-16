import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { ok } from "../../utils/api-response";

export const productsRouter = Router();

// Minimal read endpoint so the storefront has something real to hit while the
// rest of this module (create/edit/delete, variants, images) is built out.
productsRouter.get("/", async (_req, res) => {
  const products = await prisma.product.findMany({
    where: { deletedAt: null, isActive: true },
    include: { images: true, variants: { include: { inventory: true } }, category: true },
  });
  return ok(res, products);
});
