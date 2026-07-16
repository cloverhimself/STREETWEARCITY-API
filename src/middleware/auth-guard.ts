import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, type AccessTokenPayload } from "../lib/jwt";
import { HttpError } from "../utils/http-error";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

export function authGuard(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw HttpError.unauthorized("Missing bearer token");

  try {
    req.user = verifyAccessToken(header.slice("Bearer ".length));
    next();
  } catch {
    throw HttpError.unauthorized("Invalid or expired token");
  }
}
