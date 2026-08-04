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
let drainTestEmailOutbox: typeof import("../src/lib/sendbyte").drainTestEmailOutbox;
let createOrder: typeof import("../src/modules/orders/orders.service").createOrder;
let initializePaymentForOrder: typeof import("../src/modules/payments/payments.service").initializePaymentForOrder;
let reconcilePaymentStatus: typeof import("../src/modules/payments/payments.service").reconcilePaymentStatus;
let reconcilePendingPayments: typeof import("../src/modules/payments/payments.service").reconcilePendingPayments;
let releaseExpiredReservations: typeof import("../src/modules/inventory/inventory.service").releaseExpiredReservations;
let paystackProvider: typeof import("../src/modules/payments/providers/paystack/paystack.provider").paystackProvider;
let toMinorUnits: typeof import("../src/lib/money").toMinorUnits;
let fromMinorUnits: typeof import("../src/lib/money").fromMinorUnits;
let minorUnitsToDecimal: typeof import("../src/lib/money").minorUnitsToDecimal;
let moneyMatches: typeof import("../src/lib/money").moneyMatches;
let listLowStock: typeof import("../src/modules/inventory/inventory.service").listLowStock;
let restockVariant: typeof import("../src/modules/inventory/inventory.service").restockVariant;
let listActivityLogs: typeof import("../src/modules/activity-logs/activity-logs.service").listActivityLogs;
let listNotifications: typeof import("../src/modules/notifications/notifications.service").listNotifications;
let markNotificationRead: typeof import("../src/modules/notifications/notifications.service").markNotificationRead;
let markAllNotificationsRead: typeof import("../src/modules/notifications/notifications.service").markAllNotificationsRead;
let updateOrderStatus: typeof import("../src/modules/orders/orders.service").updateOrderStatus;
let revenueAnalytics: typeof import("../src/modules/analytics/analytics.service").revenueAnalytics;
let orderTrends: typeof import("../src/modules/analytics/analytics.service").orderTrends;
let topCustomers: typeof import("../src/modules/analytics/analytics.service").topCustomers;
let bestSellers: typeof import("../src/modules/analytics/analytics.service").bestSellers;
let inviteStaff: typeof import("../src/modules/admin/admin.service").inviteStaff;
let listStaff: typeof import("../src/modules/admin/admin.service").listStaff;
let changeStaffRole: typeof import("../src/modules/admin/admin.service").changeStaffRole;
let removeStaff: typeof import("../src/modules/admin/admin.service").removeStaff;
let resetPassword: typeof import("../src/modules/auth/auth.service").resetPassword;
let requirePermission: typeof import("../src/middleware/rbac-guard").requirePermission;

test.before(async () => {
  ({ login, refreshTokens, register, verifyEmail, requestPasswordReset, resetPassword } = await import("../src/modules/auth/auth.service"));
  ({ drainTestEmailOutbox } = await import("../src/lib/sendbyte"));
  ({ createOrder, updateOrderStatus } = await import("../src/modules/orders/orders.service"));
  ({ initializePaymentForOrder, reconcilePaymentStatus, reconcilePendingPayments } = await import("../src/modules/payments/payments.service"));
  ({ releaseExpiredReservations, listLowStock, restockVariant } = await import("../src/modules/inventory/inventory.service"));
  ({ paystackProvider } = await import("../src/modules/payments/providers/paystack/paystack.provider"));
  ({ toMinorUnits, fromMinorUnits, minorUnitsToDecimal, moneyMatches } = await import("../src/lib/money"));
  ({ listActivityLogs } = await import("../src/modules/activity-logs/activity-logs.service"));
  ({ listNotifications, markNotificationRead, markAllNotificationsRead } = await import("../src/modules/notifications/notifications.service"));
  ({ revenueAnalytics, orderTrends, topCustomers, bestSellers } = await import("../src/modules/analytics/analytics.service"));
  ({ inviteStaff, listStaff, changeStaffRole, removeStaff } = await import("../src/modules/admin/admin.service"));
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

test("money helpers round once at the minor-unit boundary", () => {
  assert.equal(toMinorUnits("0.10"), 10);
  assert.equal(toMinorUnits("0.105"), 11);
  assert.equal(toMinorUnits("10.004"), 1_000);
  assert.equal(toMinorUnits("10.005"), 1_001);
  assert.equal(toMinorUnits("-1.005"), -101);
  assert.equal(fromMinorUnits(12_345), 123.45);
  assert.equal(minorUnitsToDecimal(12_345), "123.45");
  assert.equal(minorUnitsToDecimal(-5), "-0.05");
  assert.equal(moneyMatches("75.00", 75), true);
  assert.equal(moneyMatches("74.999", 75), true);
  assert.equal(moneyMatches("74.994", 75), false);
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

test("order creation revalidates current database prices and stores exact totals", async () => {
  const user = await makeUser(`price-${crypto.randomUUID()}@test.local`);
  const category = await prisma.category.findUniqueOrThrow({ where: { name: "Headwear" } });
  const product = await prisma.product.create({
    data: {
      sku: `PRICE-${crypto.randomUUID()}`,
      name: "Price Revalidation Product",
      price: "19.99",
      sizeType: "ADJUSTABLE",
      categoryId: category.id,
      variants: { create: [{ color: "Black", colorHex: "#000000", size: "One Size", sku: `PRICE-V-${crypto.randomUUID()}`, inventory: { create: { totalQuantity: 5 } } }] },
    },
  });
  await prisma.product.update({ where: { id: product.id }, data: { price: "21.37" } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { amount: number; reference: string };
    assert.equal(body.amount, 7_311);
    return new Response(JSON.stringify({ status: true, message: "Authorization URL created", data: { authorization_url: "https://checkout.test/price", access_code: "access", reference: body.reference } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = await createOrder(user.id, {
      items: [{ productId: product.id, color: "Black", size: "One Size", qty: 3 }],
      shipping: { first: "Price", last: "Test", address: "1 Test Road", city: "Lagos", state: "Lagos", zip: "100001", phone: "08000000000" },
      deliveryMethod: "standard",
    });
    assert.deepEqual({ subtotal: result.order.subtotal, deliveryFee: result.order.deliveryFee, discount: result.order.discount, total: result.order.total }, { subtotal: 64.11, deliveryFee: 9, discount: 0, total: 73.11 });
    assert.deepEqual(result.order.items.map((item) => ({ unitPrice: item.unitPrice, lineTotal: item.lineTotal, quantity: item.quantity })), [{ unitPrice: 21.37, lineTotal: 64.11, quantity: 3 }]);
    assert.equal(result.redirectUrl, "https://checkout.test/price");

    const stored = await prisma.order.findUniqueOrThrow({ where: { id: result.order.id }, include: { items: true, reservations: true, payment: true } });
    assert.deepEqual({ subtotal: stored.subtotal.toString(), deliveryFee: stored.deliveryFee.toString(), total: stored.total.toString(), unitPrice: stored.items[0].unitPrice.toString() }, { subtotal: "64.11", deliveryFee: "9", total: "73.11", unitPrice: "21.37" });
    assert.equal(stored.reservations.length, 1);
    assert.equal(stored.reservations[0].quantity, 3);
    assert.equal(stored.reservations[0].status, "ACTIVE");
    assert.equal(stored.payment?.amount.toString(), "73.11");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("order creation rolls back every write when a later reservation fails", async () => {
  const user = await makeUser(`rollback-${crypto.randomUUID()}@test.local`);
  const category = await prisma.category.findUniqueOrThrow({ where: { name: "Headwear" } });
  const product = await prisma.product.create({
    data: {
      sku: `ROLLBACK-${crypto.randomUUID()}`,
      name: "Rollback Test Product",
      price: "30.00",
      sizeType: "ADJUSTABLE",
      categoryId: category.id,
      variants: { create: [{ color: "White", colorHex: "#ffffff", size: "One Size", sku: `ROLLBACK-V-${crypto.randomUUID()}`, inventory: { create: { totalQuantity: 1 } } }] },
    },
    include: { variants: true },
  });
  const before = await Promise.all([
    prisma.address.count({ where: { userId: user.id } }),
    prisma.order.count({ where: { userId: user.id } }),
    prisma.stockReservation.count({ where: { variantId: product.variants[0].id } }),
  ]);
  const input = {
    items: [
      { productId: product.id, color: "White", size: "One Size", qty: 1 },
      { productId: product.id, color: "White", size: "One Size", qty: 1 },
    ],
    shipping: { first: "Rollback", last: "Test", address: "1 Test Road", city: "Lagos", state: "Lagos", zip: "100001", phone: "08000000000" },
    deliveryMethod: "pickup" as const,
  };

  await assert.rejects(() => createOrder(user.id, input), /Insufficient stock/i);
  const after = await Promise.all([
    prisma.address.count({ where: { userId: user.id } }),
    prisma.order.count({ where: { userId: user.id } }),
    prisma.stockReservation.count({ where: { variantId: product.variants[0].id } }),
  ]);
  assert.deepEqual(after, before);
  const inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId: product.variants[0].id } });
  assert.deepEqual({ total: inventory.totalQuantity, reserved: inventory.reservedQuantity }, { total: 1, reserved: 0 });
});

test("low-stock listing uses available quantity and paginates active variants", async () => {
  const category = await prisma.category.findUniqueOrThrow({ where: { name: "Headwear" } });
  const suffix = crypto.randomUUID();
  const product = await prisma.product.create({
    data: {
      sku: `LOW-${suffix}`,
      name: `Low Stock ${suffix}`,
      price: "10.00",
      sizeType: "ADJUSTABLE",
      categoryId: category.id,
      variants: { create: [
        { color: "Low", colorHex: "#111111", size: "One Size", sku: `LOW-A-${suffix}`, inventory: { create: { totalQuantity: 7, reservedQuantity: 3 } } },
        { color: "Healthy", colorHex: "#222222", size: "One Size", sku: `LOW-B-${suffix}`, inventory: { create: { totalQuantity: 10, reservedQuantity: 1 } } },
      ] },
    },
    include: { variants: true },
  });

  const result = await listLowStock({ threshold: 4, page: 1, pageSize: 100_000 });
  const ownRows = result.items.filter((item) => item.productName === `Low Stock ${suffix}`);
  assert.equal(ownRows.length, 1);
  assert.deepEqual({ color: ownRows[0].color, total: ownRows[0].totalQuantity, reserved: ownRows[0].reservedQuantity, available: ownRows[0].availableQuantity }, { color: "Low", total: 7, reserved: 3, available: 4 });
  assert.ok(result.pagination.total >= 1);
});

test("restocking increments total stock without touching reservations and writes an actor log", async () => {
  const actor = await makeUser(`restock-actor-${crypto.randomUUID()}@test.local`);
  const category = await prisma.category.findUniqueOrThrow({ where: { name: "Headwear" } });
  const product = await prisma.product.create({
    data: {
      sku: `RESTOCK-${crypto.randomUUID()}`,
      name: "Restock Test Product",
      price: "25.00",
      sizeType: "ADJUSTABLE",
      categoryId: category.id,
      variants: { create: [{ color: "Black", colorHex: "#000000", size: "One Size", sku: `RESTOCK-V-${crypto.randomUUID()}`, inventory: { create: { totalQuantity: 5, reservedQuantity: 2 } } }] },
    },
    include: { variants: { include: { inventory: true } } },
  });

  const result = await restockVariant(product.variants[0].id, 8, actor.id);
  assert.deepEqual({ total: result.totalQuantity, reserved: result.reservedQuantity, available: result.availableQuantity, actor: result.restockedBy }, { total: 13, reserved: 2, available: 11, actor: actor.id });
  const logs = await prisma.inventoryLog.findMany({ where: { inventoryId: product.variants[0].inventory!.id, reason: "restock" } });
  assert.equal(logs.length, 1);
  assert.deepEqual({ delta: logs[0].delta, actorUserId: logs[0].actorUserId }, { delta: 8, actorUserId: actor.id });
});

test("activity logs filter and paginate newest-first with actor context", async () => {
  const actor = await makeUser(`logs-actor-${crypto.randomUUID()}@test.local`);
  const marker = crypto.randomUUID();
  const older = await prisma.activityLog.create({ data: { actorUserId: actor.id, action: `product.updated.${marker}`, resourceType: "product", resourceId: "older", oldValue: { name: "Old" }, newValue: { name: "New" }, createdAt: new Date(Date.now() - 2_000) } });
  const newer = await prisma.activityLog.create({ data: { actorUserId: actor.id, action: `product.updated.${marker}`, resourceType: "product", resourceId: "newer", createdAt: new Date(Date.now() - 1_000) } });
  await prisma.activityLog.create({ data: { actorUserId: actor.id, action: `order.status.${marker}`, resourceType: "order", resourceId: "unrelated" } });

  const pageOne = await listActivityLogs({ action: `product.updated.${marker}`, resourceType: "product", actorUserId: actor.id, page: 1, pageSize: 1 });
  assert.deepEqual(pageOne.pagination, { page: 1, pageSize: 1, total: 2, totalPages: 2 });
  assert.equal(pageOne.items[0].id, newer.id);
  assert.equal(pageOne.items[0].actor?.email, actor.email);
  assert.equal(pageOne.items[0].actor?.profile?.firstName, "Test");

  const pageTwo = await listActivityLogs({ action: `product.updated.${marker}`, resourceType: "product", actorUserId: actor.id, page: 2, pageSize: 1 });
  assert.equal(pageTwo.items[0].id, older.id);
  const ranged = await listActivityLogs({ page: 1, pageSize: 10, from: new Date(Date.now() - 1_500), to: new Date() });
  assert.equal(ranged.items.some((item) => item.id === older.id), false);
  assert.equal(ranged.items.some((item) => item.id === newer.id), true);
});

test("activity-log reads require logs.view permission", async () => {
  const middleware = requirePermission("logs.view");
  const customerRequest = { user: { sub: crypto.randomUUID(), roles: ["customer"], permissions: [] } };
  assert.throws(() => middleware(customerRequest as never, {} as never, () => undefined), /Missing permission: logs\.view/);
  let allowed = false;
  const adminRequest = { user: { sub: crypto.randomUUID(), roles: ["super_admin"], permissions: ["logs.view"] } };
  middleware(adminRequest as never, {} as never, () => { allowed = true; });
  assert.equal(allowed, true);
});

test("order status notifications are idempotent, delivered by email, and user-scoped", async () => {
  drainTestEmailOutbox();
  const customer = await makeUser(`notify-customer-${crypto.randomUUID()}@test.local`);
  const other = await makeUser(`notify-other-${crypto.randomUUID()}@test.local`);
  const actor = await makeUser(`notify-actor-${crypto.randomUUID()}@test.local`);
  const category = await prisma.category.findUniqueOrThrow({ where: { name: "Headwear" } });
  const product = await prisma.product.create({
    data: { sku: `NOTIFY-${crypto.randomUUID()}`, name: "Notification Product", price: 40, sizeType: "ADJUSTABLE", categoryId: category.id,
      variants: { create: [{ color: "Black", colorHex: "#000", size: "One Size", sku: `NOTIFY-V-${crypto.randomUUID()}`, inventory: { create: { totalQuantity: 1, reservedQuantity: 1 } } }] } },
    include: { variants: true },
  });
  const address = await prisma.address.create({ data: { userId: customer.id, label: "Test", firstName: "Test", lastName: "User", phone: "08000000000", line1: "1 Test Road", city: "Lagos", state: "Lagos", zip: "100001" } });
  const order = await prisma.order.create({ data: { orderNumber: `NOTIFY-${crypto.randomUUID()}`, userId: customer.id, subtotal: 40, deliveryFee: 0, total: 40, shippingAddressId: address.id,
    items: { create: [{ productId: product.id, variantId: product.variants[0].id, quantity: 1, unitPrice: 40 }] } } });
  await prisma.stockReservation.create({ data: { variantId: product.variants[0].id, orderId: order.id, quantity: 1, status: "ACTIVE", expiresAt: new Date(Date.now() + 60_000) } });
  const payment = await prisma.payment.create({ data: { orderId: order.id, provider: "paystack", providerRef: `notify-ref-${crypto.randomUUID()}`, idempotencyKey: `notify-key-${crypto.randomUUID()}`, amount: 40, currency: "NGN", status: "PROCESSING" } });
  const event = { eventId: `notify-event-${crypto.randomUUID()}`, providerRef: payment.providerRef!, status: "verified" as const, amount: 40, currency: "NGN", rawPayload: { notify: true } };

  await reconcilePaymentStatus("paystack", event);
  await reconcilePaymentStatus("paystack", event);
  let messages = drainTestEmailOutbox();
  assert.equal(messages.length, 1);
  assert.match(messages[0].subject, /confirmed/i);
  assert.equal(await prisma.notification.count({ where: { userId: customer.id, title: "Order confirmed" } }), 1);

  await updateOrderStatus(order.id, "PROCESSING", actor.id);
  await updateOrderStatus(order.id, "SHIPPED", actor.id);
  await updateOrderStatus(order.id, "DELIVERED", actor.id);
  messages = drainTestEmailOutbox();
  assert.equal(messages.length, 2);
  assert.match(messages[0].subject, /shipped/i);
  assert.match(messages[1].subject, /delivered/i);

  const unread = await listNotifications(customer.id, { page: 1, pageSize: 10, unreadOnly: true });
  assert.equal(unread.unreadCount, 3);
  assert.equal(unread.items.length, 3);
  await assert.rejects(() => markNotificationRead(other.id, unread.items[0].id), /Notification not found/);
  const read = await markNotificationRead(customer.id, unread.items[0].id);
  assert.ok(read.readAt);
  const marked = await markAllNotificationsRead(customer.id);
  assert.equal(marked.updated, 2);
  const final = await listNotifications(customer.id, { page: 1, pageSize: 10, unreadOnly: true });
  assert.equal(final.unreadCount, 0);
  assert.equal(final.items.length, 0);
});

test("analytics aggregate only completed payments and rank customers and products", async () => {
  const [customerA, customerB] = await Promise.all([makeUser(`analytics-a-${crypto.randomUUID()}@test.local`), makeUser(`analytics-b-${crypto.randomUUID()}@test.local`)]);
  const category = await prisma.category.findUniqueOrThrow({ where: { name: "Headwear" } });
  const suffix = crypto.randomUUID();
  const products = await Promise.all([
    prisma.product.create({ data: { sku: `AN-A-${suffix}`, name: "Analytics Bestseller", price: 25, sizeType: "ADJUSTABLE", categoryId: category.id, variants: { create: [{ color: "Black", colorHex: "#000", size: "One Size", sku: `AN-A-V-${suffix}`, inventory: { create: { totalQuantity: 20 } } }] } }, include: { variants: true } }),
    prisma.product.create({ data: { sku: `AN-B-${suffix}`, name: "Analytics Runner Up", price: 40, sizeType: "ADJUSTABLE", categoryId: category.id, variants: { create: [{ color: "Blue", colorHex: "#00f", size: "One Size", sku: `AN-B-V-${suffix}`, inventory: { create: { totalQuantity: 20 } } }] } }, include: { variants: true } }),
  ]);
  const createAnalyticsOrder = async (userId: string, number: string, status: "COMPLETED" | "PROCESSING", items: Array<{ product: typeof products[number]; qty: number; price: number }>, total: number, createdAt: Date) => {
    const address = await prisma.address.create({ data: { userId, label: "Analytics", firstName: "Test", lastName: "User", phone: "08000000000", line1: "1 Test Road", city: "Lagos", state: "Lagos", zip: "100001" } });
    const order = await prisma.order.create({ data: { orderNumber: number, userId, status: status === "COMPLETED" ? "CONFIRMED" : "PENDING", subtotal: total, deliveryFee: 0, total, shippingAddressId: address.id, createdAt,
      items: { create: items.map((item) => ({ productId: item.product.id, variantId: item.product.variants[0].id, quantity: item.qty, unitPrice: item.price })) } } });
    await prisma.payment.create({ data: { orderId: order.id, provider: "paystack", providerRef: `an-${crypto.randomUUID()}`, idempotencyKey: `an-key-${crypto.randomUUID()}`, status, amount: total, currency: "NGN" } });
    return order;
  };
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await createAnalyticsOrder(customerA.id, `ANA-${crypto.randomUUID()}`, "COMPLETED", [{ product: products[0], qty: 3, price: 25 }], 75, now);
  await createAnalyticsOrder(customerB.id, `ANB-${crypto.randomUUID()}`, "COMPLETED", [{ product: products[1], qty: 1, price: 40 }], 40, now);
  await createAnalyticsOrder(customerB.id, `ANC-${crypto.randomUUID()}`, "PROCESSING", [{ product: products[1], qty: 10, price: 40 }], 400, now);

  const markerSkus = new Set(products.map((product) => product.sku));
  const revenue = await revenueAnalytics({ from: start, to: new Date(now.getTime() + 1_000), interval: "day" });
  assert.ok(revenue.some((row) => row.revenue >= 115 && row.orders >= 2));
  const trends = await orderTrends({ from: start, to: new Date(now.getTime() + 1_000), interval: "day" });
  assert.ok(trends.some((row) => row.status === "CONFIRMED" && row.count >= 2));
  assert.ok(trends.some((row) => row.status === "PENDING" && row.count >= 1));
  const customers = await topCustomers({ from: start, to: new Date(now.getTime() + 1_000), limit: 100 });
  const ownCustomers = customers.filter((row) => row.userId === customerA.id || row.userId === customerB.id);
  assert.deepEqual(ownCustomers.map((row) => ({ userId: row.userId, spent: row.spent })), [{ userId: customerA.id, spent: 75 }, { userId: customerB.id, spent: 40 }]);
  const sellers = await bestSellers({ from: start, to: new Date(now.getTime() + 1_000), limit: 100 });
  const ownSellers = sellers.filter((row) => markerSkus.has(row.sku));
  assert.deepEqual(ownSellers.map((row) => ({ name: row.name, unitsSold: row.unitsSold, revenue: row.revenue })), [{ name: "Analytics Bestseller", unitsSold: 3, revenue: 75 }, { name: "Analytics Runner Up", unitsSold: 1, revenue: 40 }]);
});

test("analytics reads require analytics.view permission", () => {
  const middleware = requirePermission("analytics.view");
  assert.throws(() => middleware({ user: { sub: crypto.randomUUID(), roles: ["customer"], permissions: [] } } as never, {} as never, () => undefined), /Missing permission: analytics\.view/);
  let allowed = false;
  middleware({ user: { sub: crypto.randomUUID(), roles: ["finance_manager"], permissions: ["analytics.view"] } } as never, {} as never, () => { allowed = true; });
  assert.equal(allowed, true);
});

test("staff invite lifecycle uses a single-use password link, roles, audit logs, and safety guards", async () => {
  drainTestEmailOutbox();
  const actor = await makeUser(`staff-admin-${crypto.randomUUID()}@test.local`);
  const invitedEmail = `invited-${crypto.randomUUID()}@test.local`;
  const invited = await inviteStaff({ email: invitedEmail, firstName: "Invited", lastName: "Staff", role: "product_manager" }, actor.id);
  assert.equal(invited.email, invitedEmail);
  const inviteMessages = drainTestEmailOutbox();
  assert.equal(inviteMessages.length, 1);
  assert.match(inviteMessages[0].subject, /invited/i);
  const token = inviteMessages[0].html.match(/reset-password\?token=([a-f0-9]{64})/)?.[1];
  assert.match(token ?? "", /^[a-f0-9]{64}$/);

  const listed = await listStaff({ page: 1, pageSize: 100 });
  const listedInvite = listed.items.find((item) => item.id === invited.id);
  assert.deepEqual({ email: listedInvite?.email, roles: listedInvite?.roles, verified: listedInvite?.emailVerified }, { email: invitedEmail, roles: ["product_manager"], verified: true });
  await resetPassword(token!, "InvitedPassword123!");
  await login(invitedEmail, "InvitedPassword123!");
  await assert.rejects(() => resetPassword(token!, "AnotherPassword456!"), /invalid or expired/i);

  const changed = await changeStaffRole(invited.id, "inventory_manager", actor.id);
  assert.deepEqual(changed.roles, ["inventory_manager"]);
  const roleLog = await prisma.activityLog.findFirstOrThrow({ where: { action: "admin.role_updated", resourceId: invited.id }, orderBy: { createdAt: "desc" } });
  assert.deepEqual(roleLog.newValue, { roles: ["inventory_manager"] });
  await assert.rejects(() => removeStaff(actor.id, actor.id), /cannot remove your own/i);
  await removeStaff(invited.id, actor.id);
  const removed = await prisma.user.findUniqueOrThrow({ where: { id: invited.id } });
  assert.ok(removed.deletedAt);
  assert.equal((await listStaff({ page: 1, pageSize: 100 })).items.some((item) => item.id === invited.id), false);

  const superA = await makeUser(`super-a-${crypto.randomUUID()}@test.local`);
  const superB = await makeUser(`super-b-${crypto.randomUUID()}@test.local`);
  const superRole = await prisma.role.findUniqueOrThrow({ where: { name: "super_admin" } });
  const inventoryRole = await prisma.role.findUniqueOrThrow({ where: { name: "inventory_manager" } });
  const existingSupers = await prisma.userRole.findMany({ where: { roleId: superRole.id, userId: { notIn: [superA.id, superB.id] } } });
  for (const existing of existingSupers) {
    await prisma.userRole.deleteMany({ where: { userId: existing.userId } });
    await prisma.userRole.create({ data: { userId: existing.userId, roleId: inventoryRole.id } });
  }
  await prisma.userRole.deleteMany({ where: { userId: superA.id } });
  await prisma.userRole.deleteMany({ where: { userId: superB.id } });
  await prisma.userRole.createMany({ data: [{ userId: superA.id, roleId: superRole.id }, { userId: superB.id, roleId: superRole.id }] });
  await changeStaffRole(superA.id, "inventory_manager", actor.id);
  await changeStaffRole(superA.id, "super_admin", actor.id);
  await removeStaff(superB.id, actor.id);
  await assert.rejects(() => removeStaff(superA.id, actor.id), /super admin/i);
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
