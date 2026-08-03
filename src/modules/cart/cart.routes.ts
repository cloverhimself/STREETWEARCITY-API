import { Router } from "express";
import { ok } from "../../utils/api-response";
import { resolveCartLines } from "./cart.service";
import { validateCartSchema } from "./cart.validators";

export const cartRouter = Router();

// Public — a shopper doesn't need to be logged in to see whether their cart
// still matches real prices/stock before heading into checkout.
cartRouter.post("/validate", async (req, res) => {
  const input = validateCartSchema.parse(req.body);
  const lines = await resolveCartLines(input.items);
  return ok(res, { lines, hasIssues: lines.some((l) => l.issue !== null) });
});
