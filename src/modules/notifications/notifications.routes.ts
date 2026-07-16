import { Router } from "express";

// TODO(next phase): in-app notification list/read endpoints, plus a SendByte
// client for the actual email/SMS delivery (order confirmations, the
// verify-email and reset-password links auth.service.ts already generates).
export const notificationsRouter = Router();
