import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../utils/http-error";
import { fromDbSizeType, sizesFor, toDbSizeType } from "./size-type";
import type { createProductSchema, updateProductSchema } from "./products.validators";
import type { z } from "zod";

const LOW_STOCK_THRESHOLD = 6;
const NEW_PRODUCT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const productInclude = {
  images: { orderBy: { position: "asc" as const } },
  variants: { include: { inventory: true } },
  category: true,
} satisfies Prisma.ProductInclude;

type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function generateSku(name: string): string {
  return `${slugify(name).slice(0, 24)}-${crypto.randomBytes(3).toString("hex")}`.toUpperCase();
}

function mapProduct(product: ProductWithRelations) {
  const availableStock = product.variants.reduce((sum, v) => sum + (v.inventory ? v.inventory.totalQuantity - v.inventory.reservedQuantity : 0), 0);
  const colors = [...new Map(product.variants.map((v) => [v.color, { name: v.color, hex: v.colorHex }])).values()];
  const images = product.images.map((i) => i.url);
  const isNew = Date.now() - product.createdAt.getTime() < NEW_PRODUCT_WINDOW_MS;
  const badge = availableStock < LOW_STOCK_THRESHOLD ? "Low Stock" : isNew ? "New" : null;

  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    category: product.category.name,
    sizeType: fromDbSizeType(product.sizeType),
    price: Number(product.price),
    compareAt: product.compareAtPrice ? Number(product.compareAtPrice) : null,
    image: images[0] ?? null,
    images,
    colors,
    badge,
    rating: 0,
    reviewCount: 0,
    stock: availableStock,
    description: product.description ?? "",
    details: product.details ?? "",
  };
}

async function findProductOrThrow(id: string) {
  const product = await prisma.product.findFirst({ where: { id, deletedAt: null }, include: productInclude });
  if (!product) throw HttpError.notFound("Product not found");
  return product;
}

export async function listProducts() {
  const products = await prisma.product.findMany({ where: { deletedAt: null, isActive: true }, include: productInclude });
  return products.map(mapProduct);
}

export async function getProduct(id: string) {
  const product = await findProductOrThrow(id);
  return mapProduct(product);
}

async function resolveCategoryId(name: string): Promise<string> {
  const category = await prisma.category.findUnique({ where: { name } });
  if (!category) throw HttpError.badRequest(`Unknown category: ${name}`);
  return category.id;
}

function buildVariantData(productSku: string, sizeType: string, colors: { name: string; hex: string }[], stock: number) {
  const sizes = sizesFor(toDbSizeType(sizeType));
  return colors.flatMap((color) =>
    sizes.map((size) => ({
      color: color.name,
      colorHex: color.hex,
      size,
      sku: `${productSku}-${slugify(color.name)}-${slugify(size)}`.toUpperCase(),
      inventory: { create: { totalQuantity: stock, reservedQuantity: 0 } },
    }))
  );
}

export async function createProduct(input: z.infer<typeof createProductSchema>, actorUserId: string) {
  const categoryId = await resolveCategoryId(input.category);
  const sku = generateSku(input.name);

  const product = await prisma.product.create({
    data: {
      sku,
      name: input.name,
      description: input.description,
      details: input.details,
      price: input.price,
      compareAtPrice: input.compareAtPrice,
      sizeType: toDbSizeType(input.sizeType),
      categoryId,
      images: { create: input.images.map((url, position) => ({ url, position })) },
      variants: { create: buildVariantData(sku, input.sizeType, input.colors, input.stock) },
    },
    include: productInclude,
  });

  await prisma.activityLog.create({
    data: { actorUserId, action: "product.created", resourceType: "product", resourceId: product.id, newValue: { name: product.name, sku: product.sku } },
  });

  return mapProduct(product);
}

export async function updateProduct(id: string, input: z.infer<typeof updateProductSchema>, actorUserId: string) {
  const existing = await findProductOrThrow(id);

  const categoryId = input.category ? await resolveCategoryId(input.category) : undefined;
  const variantsChanged = input.colors !== undefined || input.sizeType !== undefined || input.stock !== undefined;

  const product = await prisma.$transaction(async (tx) => {
    if (variantsChanged) {
      // No orders reference variants yet at this stage of the project, so a
      // full replace is safe. Once real order history exists this needs a
      // real migration strategy instead of delete-and-recreate.
      await tx.productVariant.deleteMany({ where: { productId: id } });
    }

    return tx.product.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        details: input.details,
        price: input.price,
        compareAtPrice: input.compareAtPrice,
        sizeType: input.sizeType ? toDbSizeType(input.sizeType) : undefined,
        categoryId,
        images: input.images ? { deleteMany: {}, create: input.images.map((url, position) => ({ url, position })) } : undefined,
        variants: variantsChanged
          ? {
              create: buildVariantData(
                existing.sku,
                input.sizeType ?? fromDbSizeType(existing.sizeType),
                input.colors ?? existing.variants.map((v) => ({ name: v.color, hex: v.colorHex })),
                input.stock ?? existing.variants[0]?.inventory?.totalQuantity ?? 0
              ),
            }
          : undefined,
      },
      include: productInclude,
    });
  });

  await prisma.activityLog.create({
    data: { actorUserId, action: "product.updated", resourceType: "product", resourceId: product.id, oldValue: { name: existing.name }, newValue: { name: product.name } },
  });

  return mapProduct(product);
}

export async function deleteProduct(id: string, actorUserId: string) {
  const existing = await findProductOrThrow(id);
  await prisma.product.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
  await prisma.activityLog.create({
    data: { actorUserId, action: "product.deleted", resourceType: "product", resourceId: id, oldValue: { name: existing.name } },
  });
}

// Cart lines identify a variant by color+size, not variantId (the frontend
// never learns variant IDs — it only knows products, colors, and sizes).
export async function findVariant(productId: string, color: string, size: string) {
  return prisma.productVariant.findFirst({
    where: { productId, color, size, product: { deletedAt: null } },
    include: { inventory: true, product: { select: { id: true, name: true, price: true } } },
  });
}
