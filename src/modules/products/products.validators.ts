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

// Zod v4 doesn't allow .partial() on a schema that already has a refinement
// attached, so the plain object shape is kept separate and create/update
// each apply their own refinement on top of the shape they need (full vs.
// partial).
const productFieldsSchema = z.object({
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
});

function checkUniqueVariants(input: { variants?: { color: string; size: string }[] }, context: z.RefinementCtx) {
  const keys = input.variants?.map((variant) => `${variant.color.toLowerCase()}\0${variant.size.toLowerCase()}`) ?? [];
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", message: "Variant color and size combinations must be unique", path: ["variants"] });
  }
}

export const createProductSchema = productFieldsSchema.superRefine((input, context) => {
  if (!input.variants && (input.stock === undefined || !input.colors)) {
    context.addIssue({ code: "custom", message: "Provide variants, or provide colors and stock" });
  }
  checkUniqueVariants(input, context);
});

// A partial update doesn't require variants/colors+stock to be present at
// all (you might only be renaming the product) — only the uniqueness check
// still applies, and only when variants are actually part of this update.
export const updateProductSchema = productFieldsSchema.partial().superRefine(checkUniqueVariants);
