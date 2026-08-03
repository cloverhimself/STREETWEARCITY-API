import jwt from "jsonwebtoken";
import { env } from "./env";

export interface AccessTokenPayload {
  sub: string;
  roles: string[];
  // Resolved from role_permissions at login time and carried in the token so
  // every request doesn't need a join back to the database to authorize itself.
  permissions: string[];
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"] });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions["expiresIn"], algorithm: "HS256" });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): { sub: string; exp: number } {
  return jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ["HS256"] }) as { sub: string; exp: number };
}
