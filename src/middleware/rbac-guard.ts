import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/http-error";

// Usage: router.post("/", authGuard, requirePermission("products.create"), handler)
// Permissions are checked against the token's resolved permission set (see jwt.ts),
// never against a hardcoded role name, per the SRS permission-based RBAC model.
export function requirePermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw HttpError.unauthorized();
    if (!req.user.permissions.includes(permission)) {
      throw HttpError.forbidden(`Missing permission: ${permission}`);
    }
    next();
  };
}
