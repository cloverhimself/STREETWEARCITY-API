import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for integration tests");

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET ||= "abcdefghijklmnopqrstuvwxyz123456";
process.env.JWT_REFRESH_SECRET ||= "zyxwvutsrqponmlkjihgfedcba654321";
process.env.PAYMENT_PROVIDER = "paystack";
process.env.PAYSTACK_SECRET_KEY = "test_key";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
let login: typeof import("../src/modules/auth/auth.service").login;
let refreshTokens: typeof import("../src/modules/auth/auth.service").refreshTokens;
let register: typeof import("../src/modules/auth/auth.service").register;
let verifyEmail: typeof import("../src/modules/auth/auth.service").verifyEmail;
let requestPasswordReset: typeof import("../src/modules/auth/auth.service").requestPasswordReset;
let resetPassword: typeof import("../src/modules/auth/auth.service").resetPassword;
let drainTestEmailOutbox: typeof import("../src/lib/sendbyte").drainTestEmailOutbox;
let createOrder: typeof import("../src/modules/orders/orders.service").createOrder;
let initializePaymentForOrder: typeof import("../src/modules/payments/payments.service").initializePaymentForOrder;
let reconcilePaymentStatus: typeof import("../src/modules/payments/payments.service").reconcilePaymentStatus;
let reconcilePendingPayments: typeof import("../src/modules/payments/payments.service").reconcilePendingPayments;
let releaseExpiredReservations: typeof import("../src/modules/inventory/inventory.service").releaseExpiredReservations;
let paystackProvider: typeof import("../src/modules/payments/providers/paystack/paystack.provider").paystackProvider;
let requirePermission: typeof import("../src/middleware/rbac-guard").requirePermission;

test.before(async () => {
  ({ login, refreshTokens, register, verifyEmail, requestPasswordReset, resetPassword } = await import("../src/modules/auth/auth.service"));
  ({ drainTestEmailOutbox } = await import("../src/lib/sendbyte"));
  ({ createOrder } = await import("../src/modules/orders/orders.service"));
  ({ initializePaymentForOrder, reconcilePaymentStatus, reconcilePendingPayments } = await import("../src/modules/payments/payments.service"));
  ({ releaseExpiredReservations } = await import("../src/modules/inventory/inventory.service"));
  ({ paystackProvider } = await import("../src/modules/payments/providers/paystack/paystack.provider"));
  ({ requirePermission } = await import("../src/middleware/rbac-guard"));
});

async function makeUser(email: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: "customer" } });
  return prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash("TestPassword123!", 4),
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Test", lastName: "User" } },
      roles: { create: { roleId: role.id } },
      wishlist: { create: {} },
    },
  });
}

async function makePendingOrder(emailPrefix: string, amount = 75) {
  const user = await makeUser(`${emailPrefix}-${crypto.randomUUID()}@test.local`);
  const address = await prisma.address.create({ data: { userId: user.id, label: "Test", firstName: "Test", lastName: "User", phone: "08000000000", line1: "1 Test Road", city: "Lagos", state: "Lagos", zip: "100001" } });
  const order = await prisma.order.create({ data: { orderNumber: `TEST-${crypto.randomUUID()}`, userId: user.id, subtotal: amount, deliveryFee: 0, total: amount, shippingAddressId: address.id } });
  return { user, order };
}

test("registration sends an alphanumeric code that verifies exactly once", async () => {
  drainTestEmailOutbox();
  const email = `verify-${crypto.randomUUID()}@test.local`;
  const { user } = await register({ email, password: "TestPassword123!", firstName: "Verify", lastName: "User" });

  assert.equal(user.emailVerifiedAt, null);
  await assert.rejects(() => login(email, "TestPassword123!"), /verify your email/i);

  const messages = drainTestEmailOutbox();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, email);
  const code = messages[0].html.match(/letter-spacing:6px[^>]*>([A-Z0-9]{6})</)?.[1];
  assert.match(code ?? "", /^[A-Z0-9]{6}$/);

  await assert.rejects(() => verifyEmail(email, "ZZZZZZ"), /invalid, expired, or already used/i);
  await verifyEmail(email.toUpperCase(), code!.toLowerCase());
  const verified = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.ok(verified.emailVerifiedAt);
  await login(email, "TestPassword123!");
  await assert.rejects(() => verifyEmail(email, code!), /invalid, expired, or already used/i);
});

test("Paystack webhook signatures accept only the exact signed raw body", async () => {
  const payload = JSON.stringify({ event: "charge.success", data: { id: 123, reference: "ref-signature", status: "success", amount: 7_500, currency: "NGN" } });
  const signature = crypto.createHmac("sha512", "test_key").update(Buffer.from(payload)).digest("hex");
  const event = paystackProvider.parseWebhook(Buffer.from(payload), signature);
  assert.deepEqual({ providerRef: event.providerRef, status: event.status, amount: event.amount, currency: event.currency }, { providerRef: "ref-signature", status: "verified", amount: 75, currency: "NGN" });
  assert.throws(() => paystackProvider.parseWebhook(Buffer.from(payload), `${signature.slice(0, -1)}0`), /Invalid webhook signature/i);
  assert.throws(() => paystackProvider.parseWebhook(Buffer.from(payload), undefined), /Missing webhook signature/i);
  assert.throws(() => paystackProvider.parseWebhook(Buffer.from(`${payload} `), signature), /Invalid webhook signature/i);
});

test("expired verification codes are rejected without activating the account", async () => {
  drainTestEmailOutbox();
  const email = `expired-${crypto.randomUUID()}@test.local`;
  const { user } = await register({ email, password: "TestPassword123!", firstName: "Expired", lastName: "User" });
  const messages = drainTestEmailOutbox();
  const code = messages[0]?.html.match(/letter-spacing:6px[^>]*>([A-Z0-9]{6})</)?.[1];
  assert.match(code ?? "", /^[A-Z0-9]{6}$/);

  await prisma.verificationToken.updateMany({ where: { userId: user.id, type: "EMAIL_VERIFICATION" }, data: { expiresAt: new Date(Date.now() - 1_000) } });
  await assert.rejects(() => verifyEmail(email, code!), /invalid, expired, or already used/i);
  const unverified = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(unverified.emailVerifiedAt, null);
});

test("refresh token rotation detects reuse and revokes the token family", async () => {
  const email = `refresh-${crypto.randomUUID()}@test.local`;
  await makeUser(email);
  const first = await login(email, "TestPassword123!");
  const rotated = await refreshTokens(first.tokens.refreshToken);
  await assert.rejects(() => refreshTokens(first.tokens.refreshToken), /reuse detected/);
  await assert.rejects(() => refreshTokens(rotated.tokens.refreshToken), /reuse detected|Invalid or expired/);
});

test("password reset revokes every active session and the reset token is single-use", async () => {
  drainTestEmailOutbox();
  const email = `reset-${crypto.randomUUID()}@test.local`;
  await makeUser(email);
  const sessionA = await login(email, "TestPassword123!");
  const sessionB = await login(email, "TestPassword123!");

  const returnedToken = await requestPasswordReset(email);
  const messages = drainTestEmailOutbox();
  assert.equal(messages.length, 1);
  const emailedToken = messages[0].html.match(/reset-password\?token=([a-f0-9]{64})/)?.[1];
  assert.equal(emailedToken, returnedToken);

  await resetPassword(emailedToken!, "NewTestPassword456!");
  await assert.rejects(() => refreshTokens(sessionA.tokens.refreshToken), /reuse detected|Invalid or expired/i);
  await assert.rejects(() => refreshTokens(sessionB.tokens.refreshToken), /reuse detected|Invalid or expired/i);
  const revokedSessions = await prisma.refreshSession.findMany({ where: { user: { email } } });
  assert.equal(revokedSessions.length, 2);
  assert.ok(revokedSessions.every((session) => session.revokedAt));
  await assert.rejects(() => login(email, "TestPassword123!"), /Invalid email or password/i);
  await login(email, "NewTestPassword456!");
  await assert.rejects(() => resetPassword(emailedToken!, "AnotherPassword789!"), /invalid or expired/i);
});

test("seeded roles resolve to the documented authorization matrix", async () => {
  const matrix: Record<string, string[]> = {
    customer: [],
    super_admin: ["products.create", "products.edit", "products.delete", "inventory.view", "inventory.update", "orders.view", "orders.update", "payments.view", "customers.view", "analytics.view", "logs.view", "admins.manage", "settings.manage"],
    product_manager: ["products.create", "products.edit", "products.delete", "inventory.view", "inventory.update"],
    inventory_manager: ["inventory.view", "inventory.update"],
    order_manager: ["orders.view", "orders.update"],
    finance_manager: ["payments.view", "analytics.view"],
    customer_support: ["orders.view", "customers.view"],
  };

  for (const [roleName, expectedPermissions] of Object.entries(matrix)) {
    const email = `rbac-${roleName}-${crypto.randomUUID()}@test.local`;
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    const user = await makeUser(email);
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

    const session = await login(email, "TestPassword123!");
    assert.deepEqual([...session.tokens.permissions].sort(), [...expectedPermissions].sort(), `${roleName} permissions`);

    for (const permission of Object.values(matrix).flat()) {
      const middleware = requirePermission(permission);
      let allowed = false;
      const request = { user: { sub: user.id, roles: session.tokens.roles, permissions: session.tokens.permissions } };
      const invoke = () => middleware(request as never, {} as never, () => { allowed = true; });
      if (expectedPermissions.includes(permission)) {
        invoke();
        assert.equal(allowed, true, `${roleName} should allow ${permission}`);
      } else {
        assert.throws(invoke, new RegExp(`Missing permission: ${permission.replace(".", "\\.")}`));
      }
    }
  }
});

test("two simultaneous checkouts cannot both reserve the final unit", async () => {
  const [userA, userB] = await Promise.all([makeUser(`stock-a-${crypto.randomUUID()}@test.local`), makeUser(`stock-b-${crypto.randomUUID()}@test.local`)]);
  const category = await prisma.category.findUniqueOrThrow({ where: { name: "Headwear" } });
  const product = await prisma.product.create({
    data: {
      sku: `RACE-${crypto.randomUUID()}`,
      name: "Concurrency Test Product",
      price: 100,
      sizeType: "ADJUSTABLE",
      categoryId: category.id,
      variants: { create: [{ color: "Black", colorHex: "#000000", size: "One Size", sku: `RACE-V-${crypto.randomUUID()}`, inventory: { create: { totalQuantity: 1 } } }] },
    },
    include: { variants: true },
  });
  const input = {
    items: [{ productId: product.id, color: "Black", size: "One Size", qty: 1 }],
    shipping: { first: "Test", last: "User", address: "1 Test Road", city: "Lagos", state: "Lagos", zip: "100001", phone: "08000000000" },
    deliveryMethod: "pickup" as const,
  };
  const results = await Promise.allSettled([createOrder(userA.id, input), createOrder(userB.id, input)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId: product.variants[0].id } });
  assert.equal(inventory.reservedQuantity, 1);
  assert.equal(inventory.totalQuantity, 1);
});

test("replayed verified webhook fulfills inventory exactly once", async () => {
  const user = await makeUser(`payment-${crypto.randomUUID()}@test.local`);
  const category = await prisma.category.findUniqueOrThrow({ where: { name: "Headwear" } });
  const product = await prisma.product.create({
    data: { sku: `PAY-${crypto.randomUUID()}`, name: "Payment Test Product", price: 75, sizeType: "ADJUSTABLE", categoryId: category.id,
      variants: { create: [{ color: "Blue", colorHex: "#0000ff", size: "One Size", sku: `PAY-V-${crypto.randomUUID()}`, inventory: { create: { totalQuantity: 1, reservedQuantity: 1 } } }] } },
    include: { variants: { include: { inventory: true } } },
  });
  const address = await prisma.address.create({ data: { userId: user.id, label: "Test", firstName: "Test", lastName: "User", phone: "08000000000", line1: "1 Test Road", city: "Lagos", state: "Lagos", zip: "100001" } });
  const order = await prisma.order.create({ data: { orderNumber: `TEST-${crypto.randomUUID()}`, userId: user.id, subtotal: 75, deliveryFee: 0, total: 75, shippingAddressId: address.id,
    items: { create: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1, unitPrice: 75 }] } } });
  await prisma.stockReservation.create({ data: { variantId: product.variants[0].id, orderId: order.id, quantity: 1, status: "ACTIVE", expiresAt: new Date(Date.now() + 60_000) } });
  const payment = await prisma.payment.create({ data: { orderId: order.id, provider: "paystack", providerRef: `ref-${crypto.randomUUID()}`, idempotencyKey: `key-${crypto.randomUUID()}`, amount: 75, currency: "NGN", status: "PROCESSING" } });
  const event = { eventId: `evt-${crypto.randomUUID()}`, providerRef: payment.providerRef!, status: "verified" as const, amount: 75, currency: "NGN", rawPayload: { test: true } };
  await Promise.all([reconcilePaymentStatus("paystack", event), reconcilePaymentStatus("paystack", event)]);
  const inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId: product.variants[0].id } });
  assert.deepEqual({ total: inventory.totalQuantity, reserved: inventory.reservedQuantity }, { total: 0, reserved: 0 });
  assert.equal(await prisma.inventoryLog.count({ where: { inventoryId: product.variants[0].inventory!.id, reason: "sale" } }), 1);
});

test("payment amount or currency mismatch changes no payment, order, reservation, or inventory state", async () => {
  const user = await makeUser(`mismatch-${crypto.randomUUID()}@test.local`);
  const category = await prisma.category.findUniqueOrThrow({ where: { name: "Headwear" } });
  const product = await prisma.product.create({
    data: { sku: `MISMATCH-${crypto.randomUUID()}`, name: "Mismatch Test Product", price: 75, sizeType: "ADJUSTABLE", categoryId: category.id,
      variants: { create: [{ color: "Red", colorHex: "#ff0000", size: "One Size", sku: `MISMATCH-V-${crypto.randomUUID()}`, inventory: { create: { totalQuantity: 1, reservedQuantity: 1 } } }] } },
    include: { variants: { include: { inventory: true } } },
  });
  const address = await prisma.address.create({ data: { userId: user.id, label: "Test", firstName: "Test", lastName: "User", phone: "08000000000", line1: "1 Test Road", city: "Lagos", state: "Lagos", zip: "100001" } });
  const order = await prisma.order.create({ data: { orderNumber: `TEST-${crypto.randomUUID()}`, userId: user.id, subtotal: 75, deliveryFee: 0, total: 75, shippingAddressId: address.id,
    items: { create: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1, unitPrice: 75 }] } } });
  const reservation = await prisma.stockReservation.create({ data: { variantId: product.variants[0].id, orderId: order.id, quantity: 1, status: "ACTIVE", expiresAt: new Date(Date.now() + 60_000) } });
  const payment = await prisma.payment.create({ data: { orderId: order.id, provider: "paystack", providerRef: `ref-${crypto.randomUUID()}`, idempotencyKey: `key-${crypto.randomUUID()}`, amount: 75, currency: "NGN", status: "PROCESSING" } });

  for (const event of [
    { eventId: `amount-${crypto.randomUUID()}`, providerRef: payment.providerRef!, status: "verified" as const, amount: 74.99, currency: "NGN", rawPayload: { mismatch: "amount" } },
    { eventId: `currency-${crypto.randomUUID()}`, providerRef: payment.providerRef!, status: "verified" as const, amount: 75, currency: "USD", rawPayload: { mismatch: "currency" } },
  ]) {
    await assert.rejects(() => reconcilePaymentStatus("paystack", event), /amount or currency mismatch/i);
  }

  const [storedPayment, storedOrder, storedReservation, inventory, eventCount, saleCount] = await Promise.all([
    prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
    prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    prisma.stockReservation.findUniqueOrThrow({ where: { id: reservation.id } }),
    prisma.inventory.findUniqueOrThrow({ where: { variantId: product.variants[0].id } }),
    prisma.paymentWebhookEvent.count({ where: { paymentId: payment.id } }),
    prisma.inventoryLog.count({ where: { inventoryId: product.variants[0].inventory!.id, reason: "sale" } }),
  ]);
  assert.equal(storedPayment.status, "PROCESSING");
  assert.equal(storedOrder.status, "PENDING");
  assert.equal(storedReservation.status, "ACTIVE");
  assert.deepEqual({ total: inventory.totalQuantity, reserved: inventory.reservedQuantity }, { total: 1, reserved: 1 });
  assert.equal(eventCount, 0);
  assert.equal(saleCount, 0);
});

test("failed payment initialization leaves one durable row that retries idempotently", async () => {
  const { user, order } = await makePendingOrder("initialize-retry", 125);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body)) as { reference: string; amount: number; currency: string; email: string; metadata: { orderId: string } };
    assert.deepEqual(request, { reference: `order_${order.id}`, amount: 12_500, currency: "NGN", email: user.email, metadata: { orderId: order.id } });
    if (calls === 1) return new Response(JSON.stringify({ status: false, message: "temporary provider failure" }), { status: 503, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ status: true, message: "Authorization URL created", data: { authorization_url: "https://checkout.test/retry", access_code: "access", reference: request.reference } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    await assert.rejects(() => initializePaymentForOrder(order.id, 125, user.email), /temporary provider failure/i);
    const pending = await prisma.payment.findMany({ where: { orderId: order.id } });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "PENDING");
    assert.equal(pending[0].providerRef, null);
    assert.equal(pending[0].idempotencyKey, `order_${order.id}`);

    const retried = await initializePaymentForOrder(order.id, 125, user.email);
    assert.equal(retried.redirectUrl, "https://checkout.test/retry");
    assert.equal(retried.payment.id, pending[0].id);
    assert.equal(retried.payment.providerRef, `order_${order.id}`);
    assert.equal(retried.payment.status, "PROCESSING");
    assert.equal(await prisma.payment.count({ where: { orderId: order.id } }), 1);

    const repeated = await initializePaymentForOrder(order.id, 125, user.email);
    assert.equal(repeated.payment.id, pending[0].id);
    assert.equal(repeated.redirectUrl, null);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent reconciliation workers claim a payment exactly once", async () => {
  await prisma.payment.updateMany({ where: { status: { in: ["PENDING", "PROCESSING"] } }, data: { nextReconcileAt: new Date(Date.now() + 60_000) } });
  const { order } = await makePendingOrder("reconcile-race", 90);
  const providerRef = `reconcile-${crypto.randomUUID()}`;
  const payment = await prisma.payment.create({ data: { orderId: order.id, provider: "paystack", providerRef, idempotencyKey: `key-${crypto.randomUUID()}`, amount: 90, currency: "NGN", status: "PROCESSING", nextReconcileAt: new Date(Date.now() - 1_000) } });
  const originalFetch = globalThis.fetch;
  let verifyCalls = 0;
  globalThis.fetch = async () => {
    verifyCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return new Response(JSON.stringify({ status: true, message: "Verified", data: { reference: providerRef, status: "abandoned", amount: 9_000, currency: "NGN" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const results = await Promise.all([reconcilePendingPayments(1), reconcilePendingPayments(1)]);
    assert.equal(verifyCalls, 1);
    assert.equal(results.reduce((sum, result) => sum + result.processed, 0), 1);
    const stored = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    assert.equal(stored.reconcileAttempts, 1);
    assert.ok(stored.lastReconciledAt);
    assert.ok(stored.nextReconcileAt && stored.nextReconcileAt > new Date());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reservation expiry and payment success cannot both win", async () => {
  const user = await makeUser(`expiry-payment-${crypto.randomUUID()}@test.local`);
  const category = await prisma.category.findUniqueOrThrow({ where: { name: "Headwear" } });
  const product = await prisma.product.create({
    data: { sku: `EXPIRY-${crypto.randomUUID()}`, name: "Expiry Race Product", price: 60, sizeType: "ADJUSTABLE", categoryId: category.id,
      variants: { create: [{ color: "Green", colorHex: "#00aa00", size: "One Size", sku: `EXPIRY-V-${crypto.randomUUID()}`, inventory: { create: { totalQuantity: 1, reservedQuantity: 1 } } }] } },
    include: { variants: { include: { inventory: true } } },
  });
  const address = await prisma.address.create({ data: { userId: user.id, label: "Test", firstName: "Test", lastName: "User", phone: "08000000000", line1: "1 Test Road", city: "Lagos", state: "Lagos", zip: "100001" } });
  const order = await prisma.order.create({ data: { orderNumber: `TEST-${crypto.randomUUID()}`, userId: user.id, subtotal: 60, deliveryFee: 0, total: 60, shippingAddressId: address.id,
    items: { create: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1, unitPrice: 60 }] } } });
  const reservation = await prisma.stockReservation.create({ data: { variantId: product.variants[0].id, orderId: order.id, quantity: 1, status: "ACTIVE", expiresAt: new Date(Date.now() - 1_000) } });
  const payment = await prisma.payment.create({ data: { orderId: order.id, provider: "paystack", providerRef: `ref-${crypto.randomUUID()}`, idempotencyKey: `key-${crypto.randomUUID()}`, amount: 60, currency: "NGN", status: "PROCESSING" } });
  const event = { eventId: `evt-${crypto.randomUUID()}`, providerRef: payment.providerRef!, status: "verified" as const, amount: 60, currency: "NGN", rawPayload: { race: true } };

  await Promise.allSettled([releaseExpiredReservations(), reconcilePaymentStatus("paystack", event)]);

  const [storedPayment, storedOrder, storedReservation, inventory, saleCount] = await Promise.all([
    prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
    prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    prisma.stockReservation.findUniqueOrThrow({ where: { id: reservation.id } }),
    prisma.inventory.findUniqueOrThrow({ where: { variantId: product.variants[0].id } }),
    prisma.inventoryLog.count({ where: { inventoryId: product.variants[0].inventory!.id, reason: "sale" } }),
  ]);
  const paymentWon = storedPayment.status === "COMPLETED";
  if (paymentWon) {
    assert.equal(storedOrder.status, "CONFIRMED");
    assert.equal(storedReservation.status, "CONSUMED");
    assert.deepEqual({ total: inventory.totalQuantity, reserved: inventory.reservedQuantity, sales: saleCount }, { total: 0, reserved: 0, sales: 1 });
  } else {
    assert.equal(storedPayment.status, "PROCESSING");
    assert.equal(storedOrder.status, "PENDING");
    assert.equal(storedReservation.status, "EXPIRED");
    assert.deepEqual({ total: inventory.totalQuantity, reserved: inventory.reservedQuantity, sales: saleCount }, { total: 1, reserved: 0, sales: 0 });
  }
});

test.after(async () => prisma.$disconnect());
