import { z } from "zod";

const colorSchema = z.object({
  name: z.string().min(1),
  hex: z.string().min(1),
});

export const createProductSchema = z.object({
  name: z.string().min(1),
  category: z.enum(["Headwear", "Tops", "Bottoms"]),
  sizeType: z.enum(["clothing", "adjustable", "fitted", "waist"]),
  price: z.number().positive(),
  compareAtPrice: z.number().positive().optional(),
  stock: z.number().int().min(0),
  colors: z.array(colorSchema).min(1, "At least one color is required"),
  images: z.array(z.string().min(1)).default([]),
  description: z.string().optional(),
  details: z.string().optional(),
});

export const updateProductSchema = createProductSchema.partial();
