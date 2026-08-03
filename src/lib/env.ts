import "dotenv/config";
import { z } from "zod";

const baseEnvSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("30d"),

  PAYMENT_PROVIDER: z.enum(["paystack", "bachs"]).default("paystack"),
  BACHS_SECRET_KEY: z.string().optional(),
  BACHS_PUBLIC_KEY: z.string().optional(),
  BACHS_WEBHOOK_SECRET: z.string().optional(),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),

  SENDBYTE_API_KEY: z.string().optional(),
  SENDBYTE_FROM_EMAIL: z.string().optional(),

  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  CLIENT_ORIGIN: z.string().default("http://localhost:3000"),
});

const envSchema = baseEnvSchema.superRefine((value, ctx) => {
  const requireValue = (key: keyof typeof value, enabled = true) => {
    if (enabled && !value[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required for this configuration` });
  };
  requireValue("PAYSTACK_SECRET_KEY", value.PAYMENT_PROVIDER === "paystack");
  requireValue("BACHS_SECRET_KEY", value.PAYMENT_PROVIDER === "bachs");
  requireValue("BACHS_WEBHOOK_SECRET", value.PAYMENT_PROVIDER === "bachs");
  if (value.NODE_ENV === "production") {
    requireValue("SENDBYTE_API_KEY");
    requireValue("SENDBYTE_FROM_EMAIL");
    requireValue("CLOUDINARY_CLOUD_NAME");
    requireValue("CLOUDINARY_API_KEY");
    requireValue("CLOUDINARY_API_SECRET");
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", z.treeifyError(parsed.error));
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
