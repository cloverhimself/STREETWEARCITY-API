import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Permission keys, from the SRS permission system (section 5).
const PERMISSIONS = [
  "products.create",
  "products.edit",
  "products.delete",
  "inventory.view",
  "inventory.update",
  "orders.view",
  "orders.update",
  "payments.view",
  "customers.view",
  "analytics.view",
  "logs.view",
  "admins.manage",
  "settings.manage",
] as const;

// Roles, from the SRS user roles (section 4). "customer" isn't in that list
// explicitly but every registered shopper needs a role to hang permissions off.
const ROLES: Record<string, readonly string[]> = {
  customer: [],
  super_admin: PERMISSIONS,
  product_manager: ["products.create", "products.edit", "products.delete", "inventory.view", "inventory.update"],
  inventory_manager: ["inventory.view", "inventory.update"],
  order_manager: ["orders.view", "orders.update"],
  finance_manager: ["payments.view", "analytics.view"],
  customer_support: ["orders.view", "customers.view"],
};

const CATEGORIES = ["Headwear", "Tops", "Bottoms"];

async function main() {
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  }

  for (const [roleName, permissionKeys] of Object.entries(ROLES)) {
    const role = await prisma.role.upsert({ where: { name: roleName }, update: {}, create: { name: roleName } });
    for (const key of permissionKeys) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }

  for (const name of CATEGORIES) {
    await prisma.category.upsert({ where: { name }, update: {}, create: { name } });
  }

  console.log("Seed complete: roles, permissions, and categories are in place.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
