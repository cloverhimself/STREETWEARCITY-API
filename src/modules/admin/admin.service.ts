import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { sendStaffInviteEmail } from "../../lib/sendbyte";
import { HttpError } from "../../utils/http-error";

const INVITE_TTL_MS = 30 * 60 * 1000;
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export async function listStaff(input: { page: number; pageSize: number }) {
  const where = { deletedAt: null, roles: { some: { role: { name: { not: "customer" } } } } };
  const [users, total] = await Promise.all([
    prisma.user.findMany({ where, include: { profile: true, roles: { include: { role: true } } }, orderBy: { createdAt: "desc" }, skip: (input.page - 1) * input.pageSize, take: input.pageSize }),
    prisma.user.count({ where }),
  ]);
  return { items: users.map((user) => ({ id: user.id, email: user.email, profile: user.profile, roles: user.roles.map((entry) => entry.role.name), emailVerified: !!user.emailVerifiedAt, createdAt: user.createdAt.toISOString() })), pagination: { ...input, total, totalPages: Math.ceil(total / input.pageSize) } };
}

export async function listAssignableRoles() {
  return prisma.role.findMany({ where: { name: { not: "customer" } }, select: { id: true, name: true, description: true, permissions: { select: { permission: { select: { key: true } } } } }, orderBy: { name: "asc" } });
}

export async function inviteStaff(input: { email: string; firstName: string; lastName: string; role: string }, actorUserId: string) {
  const email = input.email.toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) throw HttpError.conflict("An account with this email already exists");
  const role = await prisma.role.findUnique({ where: { name: input.role } });
  if (!role || role.name === "customer") throw HttpError.badRequest("Invalid staff role");
  const token = crypto.randomBytes(32).toString("hex");
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({ data: { email, passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12), emailVerifiedAt: new Date(), profile: { create: { firstName: input.firstName, lastName: input.lastName } }, roles: { create: { roleId: role.id } } } });
    await tx.verificationToken.create({ data: { userId: created.id, tokenHash: hashToken(token), type: "PASSWORD_RESET", expiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
    await tx.activityLog.create({ data: { actorUserId, action: "admin.invited", resourceType: "user", resourceId: created.id, newValue: { email, role: role.name } } });
    return created;
  });
  await sendStaffInviteEmail(email, token, role.name);
  return { id: user.id, email: user.email, role: role.name };
}

export async function changeStaffRole(userId: string, roleName: string, actorUserId: string) {
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role || role.name === "customer") throw HttpError.badRequest("Invalid staff role");
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } } } });
  if (!user || user.deletedAt) throw HttpError.notFound("Staff user not found");
  const oldRoles = user.roles.map((entry) => entry.role.name);
  if (!oldRoles.some((name) => name !== "customer")) throw HttpError.notFound("Staff user not found");
  if (oldRoles.includes("super_admin") && roleName !== "super_admin") await assertAnotherSuperAdmin(userId);
  await prisma.$transaction([
    prisma.userRole.deleteMany({ where: { userId } }),
    prisma.userRole.create({ data: { userId, roleId: role.id } }),
    prisma.activityLog.create({ data: { actorUserId, action: "admin.role_updated", resourceType: "user", resourceId: userId, oldValue: { roles: oldRoles }, newValue: { roles: [role.name] } } }),
  ]);
  return { id: user.id, email: user.email, roles: [role.name] };
}

export async function removeStaff(userId: string, actorUserId: string) {
  if (userId === actorUserId) throw HttpError.conflict("You cannot remove your own staff account");
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } } } });
  if (!user || user.deletedAt || !user.roles.some((entry) => entry.role.name !== "customer")) throw HttpError.notFound("Staff user not found");
  if (user.roles.some((entry) => entry.role.name === "super_admin")) await assertAnotherSuperAdmin(userId);
  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { deletedAt: now } }),
    prisma.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.activityLog.create({ data: { actorUserId, action: "admin.removed", resourceType: "user", resourceId: userId, oldValue: { email: user.email, roles: user.roles.map((entry) => entry.role.name) } } }),
  ]);
  return { removed: true };
}

async function assertAnotherSuperAdmin(excludedUserId: string) {
  const count = await prisma.user.count({ where: { id: { not: excludedUserId }, deletedAt: null, roles: { some: { role: { name: "super_admin" } } } } });
  if (count < 1) throw HttpError.conflict("At least one active super admin must remain");
}
