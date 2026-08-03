import { z } from "zod";
import { cartLineSchema } from "../cart/cart.validators";

export const createOrderSchema = z.object({
  items: z.array(cartLineSchema).min(1, "Cart is empty"),
  shipping: z.object({
    first: z.string().min(1),
    last: z.string().min(1),
    address: z.string().min(1),
    city: z.string().min(1),
    state: z.string().min(1),
    zip: z.string().min(1),
    phone: z.string().min(1),
  }),
  deliveryMethod: z.enum(["standard", "express", "pickup"]),
  notes: z.string().optional(),
  couponCode: z.string().optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]),
});
