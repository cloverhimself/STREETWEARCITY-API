import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Dev-only seeded admin login, so there's something to sign into /admin with
// locally. Override via env for anything beyond a local machine.
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || "admin@streetwearcity.com";
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";

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

  const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { name: "super_admin" } });
  const passwordHash = await bcrypt.hash(SEED_ADMIN_PASSWORD, 12);
  const adminUser = await prisma.user.upsert({
    where: { email: SEED_ADMIN_EMAIL },
    update: {},
    create: {
      email: SEED_ADMIN_EMAIL,
      passwordHash,
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Admin", lastName: "User" } },
    },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: adminUser.id, roleId: superAdminRole.id } },
    update: {},
    create: { userId: adminUser.id, roleId: superAdminRole.id },
  });

  console.log("Seed complete: roles, permissions, categories, and a super_admin login are in place.");
  console.log(`  Admin login: ${SEED_ADMIN_EMAIL} / ${SEED_ADMIN_PASSWORD} (dev only — override via SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
