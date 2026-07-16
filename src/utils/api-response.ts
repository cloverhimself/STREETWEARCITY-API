import type { Response } from "express";

// Every endpoint responds through these two helpers so clients always see the
// same envelope shape, success or failure, instead of ad hoc response bodies.

export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ success: true, data });
}

export function fail(res: Response, status: number, message: string) {
  return res.status(status).json({ success: false, error: { message } });
}
