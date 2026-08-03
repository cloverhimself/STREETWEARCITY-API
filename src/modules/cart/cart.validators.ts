import { z } from "zod";

export const cartLineSchema = z.object({
  productId: z.string().min(1),
  color: z.string().min(1),
  size: z.string().min(1),
  qty: z.number().int().positive(),
});

export const validateCartSchema = z.object({
  items: z.array(cartLineSchema).min(1, "Cart is empty"),
});
