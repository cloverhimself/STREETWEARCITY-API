import crypto from "node:crypto";
import type { Request, Response } from "express";
import { env } from "./env";
import { HttpError } from "../utils/http-error";

export const REFRESH_COOKIE = "swc_refresh";
export const CSRF_COOKIE = "swc_csrf";

function parseCookies(req: Request): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")).filter((pair) => pair.length === 2).map(([key, value]) => [key, decodeURIComponent(value)]));
}

// The web app and API are deployed on different origins. Production therefore
// needs SameSite=None so browsers send the refresh cookie cross-origin;
// Secure is mandatory for None. CSRF validation remains required because
// SameSite=None permits cross-site cookie attachment by design.
const sameSite = env.NODE_ENV === "production" ? "None" : "Lax";
const common = { secure: env.NODE_ENV === "production", sameSite, path: "/api/v1/auth" };

export function mintCsrfCookie(res: Response) {
  const csrfToken = crypto.randomBytes(32).toString("hex");
  const maxAge = 30 * 24 * 60 * 60;
  const secure = common.secure ? "; Secure" : "";
  res.append("Set-Cookie", `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; Max-Age=${maxAge}; Path=${common.path}; SameSite=${sameSite}${secure}`);
  return csrfToken;
}

export function setAuthCookies(res: Response, refreshToken: string) {
  const maxAge = 30 * 24 * 60 * 60;
  const secure = common.secure ? "; Secure" : "";
  res.append("Set-Cookie", `${REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}; Max-Age=${maxAge}; Path=${common.path}; HttpOnly; SameSite=${sameSite}${secure}`);
  return mintCsrfCookie(res);
}

export function clearAuthCookies(res: Response) {
  const secure = common.secure ? "; Secure" : "";
  res.append("Set-Cookie", `${REFRESH_COOKIE}=; Max-Age=0; Path=${common.path}; HttpOnly; SameSite=${sameSite}${secure}`);
  res.append("Set-Cookie", `${CSRF_COOKIE}=; Max-Age=0; Path=${common.path}; SameSite=${sameSite}${secure}`);
}

export function requireCookieRefreshToken(req: Request): string {
  const token = parseCookies(req)[REFRESH_COOKIE];
  if (!token) throw HttpError.unauthorized("Missing refresh token");
  return token;
}

export function requireCsrf(req: Request) {
  const cookie = parseCookies(req)[CSRF_COOKIE];
  const header = req.headers["x-csrf-token"];
  if (!cookie || typeof header !== "string" || cookie.length !== header.length || !crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) {
    throw HttpError.forbidden("Invalid CSRF token");
  }
}
