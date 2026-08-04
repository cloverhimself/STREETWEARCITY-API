import { z } from "zod";

const colorSchema = z.object({
  name: z.string().min(1),
  hex: z.string().min(1),
});

const variantSchema = z.object({
  color: z.string().min(1),
  colorHex: z.string().min(1),
  size: z.string().min(1),
  stock: z.number().int().min(0),
});

export const createProductSchema = z.object({
  name: z.string().min(1),
  category: z.enum(["Headwear", "Tops", "Bottoms"]),
  sizeType: z.enum(["clothing", "adjustable", "fitted", "waist"]),
  price: z.number().positive(),
  compareAtPrice: z.number().positive().optional(),
  stock: z.number().int().min(0).optional(),
  colors: z.array(colorSchema).min(1, "At least one color is required").optional(),
  variants: z.array(variantSchema).min(1, "At least one variant is required").optional(),
  images: z.array(z.string().min(1)).default([]),
  description: z.string().optional(),
  details: z.string().optional(),
}).superRefine((input, context) => {
  if (!input.variants && (input.stock === undefined || !input.colors)) {
    context.addIssue({ code: "custom", message: "Provide variants, or provide colors and stock" });
  }

  const keys = input.variants?.map((variant) => `${variant.color.toLowerCase()}\0${variant.size.toLowerCase()}`) ?? [];
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", message: "Variant color and size combinations must be unique", path: ["variants"] });
  }
});

export const updateProductSchema = createProductSchema.partial();
