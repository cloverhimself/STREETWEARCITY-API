import { prisma } from "../../lib/prisma";
import { fromMinorUnits, toMinorUnits } from "../../lib/money";

export async function listCustomers(input: { page: number; pageSize: number }) {
  const offset = (input.page - 1) * input.pageSize;
  const rows = await prisma.$queryRaw<Array<{ id: string; email: string; firstName: string | null; lastName: string | null; orders: bigint; spent: string; joined: Date }>>`
    SELECT u.id, u.email, pr."firstName", pr."lastName", COUNT(DISTINCT o.id)::bigint AS orders,
           COALESCE(SUM(CASE WHEN pay.status = 'COMPLETED' THEN o.total ELSE 0 END), 0)::text AS spent,
           u."createdAt" AS joined
    FROM "users" u
    JOIN "user_roles" ur ON ur."userId" = u.id
    JOIN "roles" r ON r.id = ur."roleId" AND r.name = 'customer'
    LEFT JOIN "profiles" pr ON pr."userId" = u.id
    LEFT JOIN "orders" o ON o."userId" = u.id
    LEFT JOIN "payments" pay ON pay."orderId" = o.id
    WHERE u."deletedAt" IS NULL
    GROUP BY u.id, u.email, pr."firstName", pr."lastName"
    ORDER BY u."createdAt" DESC
    LIMIT ${input.pageSize} OFFSET ${offset}
  `;
  const countRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "users" u
    JOIN "user_roles" ur ON ur."userId" = u.id
    JOIN "roles" r ON r.id = ur."roleId" AND r.name = 'customer'
    WHERE u."deletedAt" IS NULL
  `;
  const total = Number(countRows[0]?.count ?? 0);
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email,
      email: row.email,
      orders: Number(row.orders),
      spent: fromMinorUnits(toMinorUnits(row.spent)),
      joined: row.joined.toISOString(),
    })),
    pagination: { page: input.page, pageSize: input.pageSize, total, totalPages: Math.ceil(total / input.pageSize) },
  };
}
