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
  "coupons.manage",
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

// Same 14 products the frontend used to hardcode in src/lib/data.ts, migrated
// into real rows so local dev and production both start with a real catalog
// instead of an empty one. Images are real Cloudinary URLs (uploaded from the
// original bundled /uploads/*.jpg files), not local paths — a fresh seed run
// no longer depends on those static files existing on whatever's serving it.
const SIZE_LISTS: Record<string, string[]> = {
  CLOTHING: ["XS", "S", "M", "L", "XL", "XXL"],
  ADJUSTABLE: ["One Size (Adjustable)"],
  FITTED: ["7", "7 1/8", "7 1/4", "7 3/8", "7 1/2", "7 5/8"],
  WAIST: ["28", "30", "32", "34", "36", "38"],
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

const PRODUCTS_SEED = [
  { sku: "SWC-BN-001", name: "Rosewild Camo Beanie", category: "Headwear", sizeType: "ADJUSTABLE", price: 38, compareAtPrice: null, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864254/streetwarecity/products/dsdj0hlyw4cxqxyf8hiz.jpg", colors: [{ name: "Rose Camo", hex: "#e39fc2" }], stock: 14, description: "Brushed knit beanie in an all-over rose camo jacquard with tonal wing graphic. Deep rib fold for a lived-in fit.", details: "100% acrylic knit\nOne size, stretch fit\nHand wash cold" },
  { sku: "SWC-BN-002", name: "Rosewild Camo Beanie, Reserve", category: "Headwear", sizeType: "ADJUSTABLE", price: 42, compareAtPrice: 48, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864254/streetwarecity/products/dsdj0hlyw4cxqxyf8hiz.jpg", colors: [{ name: "Rose Camo", hex: "#e39fc2" }, { name: "Blackout", hex: "#1a1a1a" }], stock: 3, description: "Limited reserve run of our rose camo beanie with reinforced cuff stitching.", details: "100% acrylic knit\nOne size, stretch fit\nLimited reserve run" },
  { sku: "SWC-CD-003", name: "Ranger Cadet Cap", category: "Headwear", sizeType: "ADJUSTABLE", price: 46, compareAtPrice: null, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864257/streetwarecity/products/qlk5vwmgs1twqeycodyx.jpg", colors: [{ name: "Woodland", hex: "#5b6b45" }], stock: 22, description: "Structured six-panel cadet cap in ripstop woodland camo with adjustable back strap.", details: "Cotton ripstop shell\nAdjustable D-ring strap\nSpot clean only" },
  { sku: "SWC-FT-004", name: "Blackout Fitted 59FIFTY", category: "Headwear", sizeType: "FITTED", price: 52, compareAtPrice: null, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864268/streetwarecity/products/xm2jzmhzkguuaihw1xhe.jpg", colors: [{ name: "Blackout", hex: "#111111" }], stock: 30, description: "Flat-brim fitted cap in structured wool blend with embroidered eyes graphic.", details: "Wool blend shell\nFitted, non-adjustable\nDry clean only" },
  { sku: "SWC-FT-005", name: "Blackout Fitted 59FIFTY, OG", category: "Headwear", sizeType: "FITTED", price: 56, compareAtPrice: null, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864268/streetwarecity/products/xm2jzmhzkguuaihw1xhe.jpg", colors: [{ name: "Blackout", hex: "#111111" }, { name: "Grey Pop", hex: "#8d8d8d" }], stock: 16, description: "OG colorway of our signature fitted with grey embroidery pop.", details: "Wool blend shell\nFitted, non-adjustable\nDry clean only" },
  { sku: "SWC-JR-006", name: "Royals Mesh Jersey", category: "Tops", sizeType: "CLOTHING", price: 88, compareAtPrice: 110, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864270/streetwarecity/products/s9xelpopadr3uqusbmqn.jpg", colors: [{ name: "Black/White", hex: "#111111" }], stock: 18, description: "Oversized football-cut mesh jersey with embroidered crest and floral sleeve patches.", details: "100% polyester mesh\nOversized fit\nMachine wash cold" },
  { sku: "SWC-JR-007", name: "Web 52 Mesh Jersey", category: "Tops", sizeType: "CLOTHING", price: 95, compareAtPrice: null, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864271/streetwarecity/products/jkvwygntibg5f9d0xbzq.jpg", colors: [{ name: "White", hex: "#f5f5f3" }], stock: 9, description: "Archive mesh jersey pull with printed web graphics and bold varsity numbering. Verified authentic.", details: "100% polyester mesh\nTrue to size\nVerified authentic" },
  { sku: "SWC-CT-008", name: "Lil Syna Graphic Crop Tee", category: "Tops", sizeType: "CLOTHING", price: 54, compareAtPrice: null, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864259/streetwarecity/products/bx1iyyn3zoabedenpqpf.jpg", colors: [{ name: "Black", hex: "#111111" }], stock: 20, description: "Cropped tee with contrast rhinestone stitching and spray-paint style graphic.", details: "100% cotton jersey\nCropped fit\nMachine wash cold" },
  { sku: "SWC-CT-009", name: "Nine Lives Graffiti Crop Tee", category: "Tops", sizeType: "CLOTHING", price: 50, compareAtPrice: 58, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864260/streetwarecity/products/qdmtwkmytccjeb9klhkd.jpg", colors: [{ name: "White", hex: "#f5f5f3" }], stock: 0, description: "Boxy crop tee with hand-style graffiti graphic and pastel airbrush detailing.", details: "100% cotton jersey\nBoxy fit\nMachine wash cold" },
  { sku: "SWC-DJ-010", name: "Cross Wash Baggy Jeans", category: "Bottoms", sizeType: "WAIST", price: 120, compareAtPrice: null, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864264/streetwarecity/products/kud2kpspo4wchzhqosqu.jpg", colors: [{ name: "Rinse Indigo", hex: "#2b3550" }], stock: 26, description: "Heavyweight baggy denim with curved seam construction and tonal embroidery.", details: "14oz rigid denim\nBaggy fit, tapered hem\nMachine wash cold" },
  { sku: "SWC-DJ-011", name: "Cross Wash Baggy Jeans, Rinse", category: "Bottoms", sizeType: "WAIST", price: 125, compareAtPrice: null, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864264/streetwarecity/products/kud2kpspo4wchzhqosqu.jpg", colors: [{ name: "Rinse Indigo", hex: "#2b3550" }, { name: "Raw Black", hex: "#101010" }], stock: 11, description: "Rinse-wash colorway of our signature baggy denim, same curved-seam construction.", details: "14oz rigid denim\nBaggy fit\nMachine wash cold" },
  { sku: "SWC-DJ-012", name: "Dragon Embroidered Baggy Jeans", category: "Bottoms", sizeType: "WAIST", price: 148, compareAtPrice: 170, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864265/streetwarecity/products/fw1ruxsqiowhcogladlv.jpg", colors: [{ name: "Jet Black", hex: "#0c0c0c" }], stock: 4, description: "Black baggy denim finished with a multicolor dragon embroidery at the hip.", details: "13oz rigid denim\nBaggy fit\nMachine wash cold" },
  { sku: "SWC-DS-013", name: "Denim Genes Baggy Shorts", category: "Bottoms", sizeType: "WAIST", price: 78, compareAtPrice: null, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864267/streetwarecity/products/p0ayfmf3nj5jz4uklvbu.jpg", colors: [{ name: "Jet Black", hex: "#0c0c0c" }], stock: 19, description: "Knee-length denim shorts with contrast stitching and woven back patch.", details: "12oz rigid denim\nRelaxed fit\nMachine wash cold" },
  { sku: "SWC-DS-014", name: "Denim Genes Baggy Shorts, Stone", category: "Bottoms", sizeType: "WAIST", price: 82, compareAtPrice: null, image: "https://res.cloudinary.com/htec4rnl/image/upload/v1785864267/streetwarecity/products/p0ayfmf3nj5jz4uklvbu.jpg", colors: [{ name: "Jet Black", hex: "#0c0c0c" }, { name: "Stone Grey", hex: "#77726b" }], stock: 13, description: "Stone-toned colorway of our baggy denim short with the same relaxed cut.", details: "12oz rigid denim\nRelaxed fit\nMachine wash cold" },
];

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

  for (const p of PRODUCTS_SEED) {
    const existing = await prisma.product.findUnique({ where: { sku: p.sku } });
    if (existing) continue; // idempotent — don't touch a product an admin may have since edited

    const category = await prisma.category.findUniqueOrThrow({ where: { name: p.category } });
    const sizes = SIZE_LISTS[p.sizeType];
    const variants = p.colors.flatMap((color) =>
      sizes.map((size) => ({
        color: color.name,
        colorHex: color.hex,
        size,
        sku: `${p.sku}-${slugify(color.name)}-${slugify(size)}`.toUpperCase(),
        inventory: { create: { totalQuantity: p.stock, reservedQuantity: 0 } },
      }))
    );

    await prisma.product.create({
      data: {
        sku: p.sku,
        name: p.name,
        description: p.description,
        details: p.details,
        price: p.price,
        compareAtPrice: p.compareAtPrice ?? undefined,
        sizeType: p.sizeType as "CLOTHING" | "ADJUSTABLE" | "FITTED" | "WAIST",
        categoryId: category.id,
        images: { create: [{ url: p.image, position: 0 }] },
        variants: { create: variants },
      },
    });
  }

  console.log("Seed complete: roles, permissions, categories, a super_admin login, and the product catalog are in place.");
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
