import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger";
import { HttpError } from "../utils/http-error";
import { fail } from "../utils/api-response";

// Express 5 forwards rejected promises from async handlers here automatically,
// so route handlers don't need their own try/catch just to call next(err).
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return fail(res, 400, "Validation failed: " + err.issues.map((i) => i.message).join(", "));
  }

  if (err instanceof HttpError) {
    if (err.status >= 500) logger.error({ err, path: req.path }, err.message);
    return fail(res, err.status, err.message);
  }

  logger.error({ err, path: req.path }, "Unhandled error");
  return fail(res, 500, "Internal server error");
}

export function notFoundHandler(req: Request, res: Response) {
  return fail(res, 404, `No route for ${req.method} ${req.path}`);
}
