import { Router } from "express";

// TODO(next phase): in-app notification list/read endpoints, plus an order
// confirmation email via lib/sendbyte.ts (verify-email and reset-password are
// already wired up in auth.service.ts).
export const notificationsRouter = Router();
