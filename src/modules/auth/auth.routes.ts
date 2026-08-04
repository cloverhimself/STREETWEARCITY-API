import { Router } from "express";
import { authGuard } from "../../middleware/auth-guard";
import { authRateLimit } from "../../middleware/rate-limit";
import { HttpError } from "../../utils/http-error";
import { ok } from "../../utils/api-response";
import { clearAuthCookies, mintCsrfCookie, requireCookieRefreshToken, requireCsrf, setAuthCookies } from "../../lib/auth-cookies";
import { getCurrentUser, login, refreshTokens, register, requestPasswordReset, resetPassword, revokeRefreshToken, verifyEmail } from "./auth.service";
import { loginSchema, registerSchema, requestPasswordResetSchema, resetPasswordSchema, verifyEmailSchema } from "./auth.validators";

export const authRouter = Router();

authRouter.use(authRateLimit);

authRouter.post("/register", async (req, res) => {
  const input = registerSchema.parse(req.body);
  const { user } = await register(input);
  return ok(res, { id: user.id, email: user.email }, 201);
});

authRouter.post("/verify-email", async (req, res) => {
  const { email, code } = verifyEmailSchema.parse(req.body);
  await verifyEmail(email, code);
  return ok(res, { verified: true });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const { user, tokens } = await login(email, password);
  const csrfToken = setAuthCookies(res, tokens.refreshToken);
  return ok(res, { user: { id: user.id, email: user.email }, accessToken: tokens.accessToken, roles: tokens.roles, permissions: tokens.permissions, csrfToken });
});

// Session bootstrap only: proves that the browser still holds a refresh
// cookie and mints a readable CSRF token. It deliberately does not call the
// auth service, rotate the refresh token, or touch RefreshSession state.
authRouter.get("/csrf", (req, res) => {
  requireCookieRefreshToken(req);
  return ok(res, { csrfToken: mintCsrfCookie(res) });
});

authRouter.post("/refresh", async (req, res) => {
  requireCsrf(req);
  const refreshToken = requireCookieRefreshToken(req);
  const { user, tokens } = await refreshTokens(refreshToken);
  const csrfToken = setAuthCookies(res, tokens.refreshToken);
  return ok(res, { user: { id: user.id, email: user.email }, accessToken: tokens.accessToken, roles: tokens.roles, permissions: tokens.permissions, csrfToken });
});

authRouter.post("/logout", async (req, res) => {
  requireCsrf(req);
  await revokeRefreshToken(requireCookieRefreshToken(req));
  clearAuthCookies(res);
  return ok(res, { loggedOut: true });
});

authRouter.get("/me", authGuard, async (req, res) => {
  if (!req.user) throw HttpError.unauthorized();
  const user = await getCurrentUser(req.user.sub);
  return ok(res, { id: user.id, email: user.email, profile: user.profile, roles: user.roles, emailVerified: !!user.emailVerifiedAt });
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
