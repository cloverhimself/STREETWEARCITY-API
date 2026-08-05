import type { Coupon, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { fromMinorUnits, toMinorUnits } from "../../lib/money";
import { HttpError } from "../../utils/http-error";
import type { z } from "zod";
import type { createCouponSchema, updateCouponSchema } from "./coupons.validators";

function mapCoupon(coupon: Coupon) {
  return {
    id: coupon.id,
    code: coupon.code,
    description: coupon.description,
    discountType: coupon.discountType,
    discountValue: Number(coupon.discountValue),
    minOrderAmount: coupon.minOrderAmount !== null ? Number(coupon.minOrderAmount) : null,
    maxDiscountAmount: coupon.maxDiscountAmount !== null ? Number(coupon.maxDiscountAmount) : null,
    usageLimit: coupon.usageLimit,
    usageLimitPerCustomer: coupon.usageLimitPerCustomer,
    timesUsed: coupon.timesUsed,
    isActive: coupon.isActive,
    startsAt: coupon.startsAt ? coupon.startsAt.toISOString() : null,
    expiresAt: coupon.expiresAt ? coupon.expiresAt.toISOString() : null,
    createdAt: coupon.createdAt.toISOString(),
  };
}

function assertPercentRange(discountType: "PERCENT" | "FIXED", discountValue: number) {
  if (discountType === "PERCENT" && discountValue > 100) {
    throw HttpError.badRequest("Percent discount cannot exceed 100");
  }
}

export async function listCoupons() {
  const coupons = await prisma.coupon.findMany({ orderBy: { createdAt: "desc" } });
  return coupons.map(mapCoupon);
}

export async function createCoupon(input: z.infer<typeof createCouponSchema>, actorUserId: string) {
  const code = input.code.toUpperCase();
  assertPercentRange(input.discountType, input.discountValue);

  const existing = await prisma.coupon.findUnique({ where: { code } });
  if (existing) throw HttpError.conflict("A coupon with this code already exists");

  const coupon = await prisma.coupon.create({
    data: {
      code,
      description: input.description,
      discountType: input.discountType,
      discountValue: input.discountValue,
      minOrderAmount: input.minOrderAmount,
      maxDiscountAmount: input.maxDiscountAmount,
      usageLimit: input.usageLimit,
      usageLimitPerCustomer: input.usageLimitPerCustomer,
      isActive: input.isActive,
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
    },
  });

  await prisma.activityLog.create({
    data: { actorUserId, action: "coupon.created", resourceType: "coupon", resourceId: coupon.id, newValue: { code: coupon.code } },
  });

  return mapCoupon(coupon);
}

export async function updateCoupon(id: string, input: z.infer<typeof updateCouponSchema>, actorUserId: string) {
  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) throw HttpError.notFound("Coupon not found");

  const nextType = input.discountType ?? existing.discountType;
  const nextValue = input.discountValue !== undefined ? input.discountValue : Number(existing.discountValue);
  assertPercentRange(nextType, nextValue);

  let code = existing.code;
  if (input.code) {
    code = input.code.toUpperCase();
    if (code !== existing.code) {
      const clash = await prisma.coupon.findUnique({ where: { code } });
      if (clash) throw HttpError.conflict("A coupon with this code already exists");
    }
  }

  const coupon = await prisma.coupon.update({
    where: { id },
    data: {
      code,
      description: input.description,
      discountType: input.discountType,
      discountValue: input.discountValue,
      minOrderAmount: input.minOrderAmount,
      maxDiscountAmount: input.maxDiscountAmount,
      usageLimit: input.usageLimit,
      usageLimitPerCustomer: input.usageLimitPerCustomer,
      isActive: input.isActive,
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
    },
  });

  await prisma.activityLog.create({
    data: { actorUserId, action: "coupon.updated", resourceType: "coupon", resourceId: coupon.id, oldValue: { code: existing.code }, newValue: { code: coupon.code } },
  });

  return mapCoupon(coupon);
}

export async function deleteCoupon(id: string, actorUserId: string) {
  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) throw HttpError.notFound("Coupon not found");

  const used = await prisma.couponRedemption.count({ where: { couponId: id } });
  if (used > 0) {
    // Orders already reference this coupon — deactivate instead of deleting
    // so their history stays intact.
    await prisma.coupon.update({ where: { id }, data: { isActive: false } });
  } else {
    await prisma.coupon.delete({ where: { id } });
  }

  await prisma.activityLog.create({
    data: { actorUserId, action: "coupon.deleted", resourceType: "coupon", resourceId: id, oldValue: { code: existing.code } },
  });
}

export interface CouponEvaluation {
  couponId: string;
  code: string;
  usageLimit: number | null;
  discountMinor: number;
}

// Shared by the public preview endpoint and the authoritative redemption
// step inside createOrder — both must agree on the same discount math.
// Accepts either the base client (preview) or a transaction client
// (redemption), so redemption reads happen inside the same transaction that
// later claims the usage slot.
export async function evaluateCoupon(
  client: Prisma.TransactionClient,
  rawCode: string,
  subtotalMinor: number,
  userId?: string
): Promise<CouponEvaluation> {
  const code = rawCode.trim().toUpperCase();
  const coupon = await client.coupon.findUnique({ where: { code } });
  if (!coupon || !coupon.isActive) throw HttpError.badRequest("Coupon code is invalid or no longer active");

  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) throw HttpError.badRequest("This coupon isn't active yet");
  if (coupon.expiresAt && coupon.expiresAt < now) throw HttpError.badRequest("This coupon has expired");

  const minOrderMinor = coupon.minOrderAmount ? toMinorUnits(coupon.minOrderAmount) : 0;
  if (subtotalMinor < minOrderMinor) {
    throw HttpError.badRequest(`This coupon requires a minimum order of ${fromMinorUnits(minOrderMinor)}`);
  }

  if (coupon.usageLimit !== null && coupon.timesUsed >= coupon.usageLimit) {
    throw HttpError.badRequest("This coupon has reached its usage limit");
  }

  if (userId && coupon.usageLimitPerCustomer !== null) {
    const used = await client.couponRedemption.count({ where: { couponId: coupon.id, userId } });
    if (used >= coupon.usageLimitPerCustomer) {
      throw HttpError.badRequest("You've already used this coupon the maximum number of times");
    }
  }

  let discountMinor =
    coupon.discountType === "PERCENT"
      ? Math.round((subtotalMinor * Number(coupon.discountValue)) / 100)
      : toMinorUnits(coupon.discountValue);
  if (coupon.maxDiscountAmount !== null) discountMinor = Math.min(discountMinor, toMinorUnits(coupon.maxDiscountAmount));
  discountMinor = Math.min(discountMinor, subtotalMinor);

  return { couponId: coupon.id, code: coupon.code, usageLimit: coupon.usageLimit, discountMinor };
}

export async function previewCoupon(code: string, subtotal: number) {
  const evaluation = await evaluateCoupon(prisma, code, toMinorUnits(subtotal));
  return { code: evaluation.code, discount: fromMinorUnits(evaluation.discountMinor) };
}
