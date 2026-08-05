import { z } from "zod";

// Zod v4 doesn't allow .partial() on a schema that already has a refinement
// attached (see products.validators.ts), so the plain shape stays separate
// and create/update each apply their own refinement.
const couponFieldsSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3)
    .max(30)
    .regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, hyphens, or underscores only"),
  description: z.string().max(200).optional(),
  discountType: z.enum(["PERCENT", "FIXED"]),
  discountValue: z.number().positive(),
  minOrderAmount: z.number().nonnegative().optional(),
  maxDiscountAmount: z.number().positive().optional(),
  usageLimit: z.number().int().positive().optional(),
  usageLimitPerCustomer: z.number().int().positive().optional(),
  isActive: z.boolean().default(true),
  startsAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
});

function checkPercentRange(input: { discountType?: "PERCENT" | "FIXED"; discountValue?: number }, context: z.RefinementCtx) {
  if (input.discountType === "PERCENT" && input.discountValue !== undefined && input.discountValue > 100) {
    context.addIssue({ code: "custom", message: "Percent discount cannot exceed 100", path: ["discountValue"] });
  }
}

export const createCouponSchema = couponFieldsSchema.superRefine(checkPercentRange);
export const updateCouponSchema = couponFieldsSchema.partial().superRefine(checkPercentRange);

export const couponPreviewSchema = z.object({
  code: z.string().trim().min(1),
  subtotal: z.number().positive(),
});
