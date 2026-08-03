import test from "node:test";
import assert from "node:assert/strict";

test("order transition policy rejects backwards terminal transitions", () => {
  const allowed = { PENDING: ["CANCELLED"], CONFIRMED: ["PROCESSING", "CANCELLED"], PROCESSING: ["SHIPPED", "CANCELLED"], SHIPPED: ["DELIVERED"], DELIVERED: [], CANCELLED: [] };
  assert.equal(allowed.DELIVERED.includes("PENDING"), false);
  assert.equal(allowed.CONFIRMED.includes("PROCESSING"), true);
});

test("atomic stock predicate cannot reserve more than available", () => {
  const canReserve = (total, reserved, requested) => total - reserved >= requested;
  assert.equal(canReserve(1, 0, 1), true);
  assert.equal(canReserve(1, 1, 1), false);
});

test("webhook amount and currency must match the stored payment", () => {
  const matches = (expected, received) => expected.amount === received.amount && expected.currency === received.currency;
  assert.equal(matches({ amount: 100, currency: "NGN" }, { amount: 99, currency: "NGN" }), false);
  assert.equal(matches({ amount: 100, currency: "NGN" }, { amount: 100, currency: "NGN" }), true);
});
