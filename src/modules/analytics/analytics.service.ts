import { prisma } from "../../lib/prisma";
import { fromMinorUnits, toMinorUnits } from "../../lib/money";

export type AnalyticsInterval = "day" | "week" | "month";

const intervalSql = { day: "day", week: "week", month: "month" } as const;

export async function revenueAnalytics(input: { from: Date; to: Date; interval: AnalyticsInterval }) {
  const unit = intervalSql[input.interval];
  const rows = await prisma.$queryRawUnsafe<Array<{ period: Date; revenue: string; orders: bigint }>>(
    `SELECT date_trunc($1, o."createdAt") AS period, COALESCE(SUM(o.total), 0)::text AS revenue, COUNT(*)::bigint AS orders
     FROM "orders" o
     JOIN "payments" p ON p."orderId" = o.id
     WHERE p.status = 'COMPLETED' AND o."createdAt" >= $2 AND o."createdAt" <= $3
     GROUP BY period ORDER BY period ASC`, unit, input.from, input.to
  );
  return rows.map((row) => ({ period: row.period.toISOString(), revenue: fromMinorUnits(toMinorUnits(row.revenue)), orders: Number(row.orders) }));
}

export async function orderTrends(input: { from: Date; to: Date; interval: AnalyticsInterval }) {
  const unit = intervalSql[input.interval];
  const rows = await prisma.$queryRawUnsafe<Array<{ period: Date; status: string; count: bigint }>>(
    `SELECT date_trunc($1, "createdAt") AS period, status::text, COUNT(*)::bigint AS count
     FROM "orders" WHERE "createdAt" >= $2 AND "createdAt" <= $3
     GROUP BY period, status ORDER BY period ASC, status ASC`, unit, input.from, input.to
  );
  return rows.map((row) => ({ period: row.period.toISOString(), status: row.status, count: Number(row.count) }));
}

export async function topCustomers(input: { from: Date; to: Date; limit: number }) {
  const rows = await prisma.$queryRaw<Array<{ userId: string; email: string; firstName: string | null; lastName: string | null; orders: bigint; spent: string }>>`
    SELECT u.id AS "userId", u.email, pr."firstName", pr."lastName", COUNT(o.id)::bigint AS orders, COALESCE(SUM(o.total), 0)::text AS spent
    FROM "orders" o JOIN "payments" pay ON pay."orderId" = o.id AND pay.status = 'COMPLETED'
    JOIN "users" u ON u.id = o."userId" LEFT JOIN "profiles" pr ON pr."userId" = u.id
    WHERE o."createdAt" >= ${input.from} AND o."createdAt" <= ${input.to}
    GROUP BY u.id, u.email, pr."firstName", pr."lastName"
    ORDER BY SUM(o.total) DESC, COUNT(o.id) DESC LIMIT ${input.limit}
  `;
  return rows.map((row) => ({ ...row, orders: Number(row.orders), spent: fromMinorUnits(toMinorUnits(row.spent)) }));
}

export async function bestSellers(input: { from: Date; to: Date; limit: number }) {
  const rows = await prisma.$queryRaw<Array<{ productId: string; name: string; sku: string; unitsSold: bigint; revenue: string }>>`
    SELECT p.id AS "productId", p.name, p.sku, SUM(oi.quantity)::bigint AS "unitsSold",
           SUM(oi."unitPrice" * oi.quantity)::text AS revenue
    FROM "order_items" oi JOIN "orders" o ON o.id = oi."orderId"
    JOIN "payments" pay ON pay."orderId" = o.id AND pay.status = 'COMPLETED'
    JOIN "products" p ON p.id = oi."productId"
    WHERE o."createdAt" >= ${input.from} AND o."createdAt" <= ${input.to}
    GROUP BY p.id, p.name, p.sku ORDER BY SUM(oi.quantity) DESC, SUM(oi."unitPrice" * oi.quantity) DESC LIMIT ${input.limit}
  `;
  return rows.map((row) => ({ ...row, unitsSold: Number(row.unitsSold), revenue: fromMinorUnits(toMinorUnits(row.revenue)) }));
}
