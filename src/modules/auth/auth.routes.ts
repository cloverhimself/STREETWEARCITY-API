import { Router } from "express";
import { authRateLimit } from "../../middleware/rate-limit";
import { ok } from "../../utils/api-response";
import { login, register, requestPasswordReset, resetPassword, verifyEmail } from "./auth.service";
import { loginSchema, registerSchema, requestPasswordResetSchema, resetPasswordSchema, verifyEmailSchema } from "./auth.validators";

export const authRouter = Router();

authRouter.use(authRateLimit);

authRouter.post("/register", async (req, res) => {
  const input = registerSchema.parse(req.body);
  const { user } = await register(input);
  return ok(res, { id: user.id, email: user.email }, 201);
});

authRouter.post("/verify-email", async (req, res) => {
  const { token } = verifyEmailSchema.parse(req.body);
  await verifyEmail(token);
  return ok(res, { verified: true });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const { user, tokens } = await login(email, password);
  return ok(res, { user: { id: user.id, email: user.email }, ...tokens });
});

authRouter.post("/request-password-reset", async (req, res) => {
  const { email } = requestPasswordResetSchema.parse(req.body);
  await requestPasswordReset(email);
  // Same response whether or not the account exists — see auth.service.ts.
  return ok(res, { message: "If that account exists, a reset link has been sent" });
});

authRouter.post("/reset-password", async (req, res) => {
  const { token, password } = resetPasswordSchema.parse(req.body);
  await resetPassword(token, password);
  return ok(res, { reset: true });
});
