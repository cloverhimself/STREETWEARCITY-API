import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../lib/jwt";
import { HttpError } from "../../utils/http-error";

const SALT_ROUNDS = 12;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function resolvePermissions(userId: string): Promise<{ roles: string[]; permissions: string[] }> {
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });

  const roles = userRoles.map((ur) => ur.role.name);
  const permissions = [...new Set(userRoles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission.key)))];
  return { roles, permissions };
}

async function issueTokens(userId: string) {
  const { roles, permissions } = await resolvePermissions(userId);
  return {
    accessToken: signAccessToken({ sub: userId, roles, permissions }),
    refreshToken: signRefreshToken(userId),
    roles,
    permissions,
  };
}

export async function register(input: { email: string; password: string; firstName: string; lastName: string }) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw HttpError.conflict("An account with this email already exists");

  const customerRole = await prisma.role.findUnique({ where: { name: "customer" } });
  if (!customerRole) throw new Error("Base 'customer' role is missing — run the seed script");

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      profile: { create: { firstName: input.firstName, lastName: input.lastName } },
      roles: { create: { roleId: customerRole.id } },
      wishlist: { create: {} },
    },
  });

  const token = crypto.randomBytes(32).toString("hex");
  await prisma.verificationToken.create({
    data: { userId: user.id, tokenHash: hashToken(token), type: "EMAIL_VERIFICATION", expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS) },
  });

  // Integration point: send `token` via the notifications module (SendByte) as a /verify-email?token= link.
  return { user, emailVerificationToken: token };
}

export async function verifyEmail(token: string) {
  const record = await prisma.verificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.type !== "EMAIL_VERIFICATION" || record.usedAt || record.expiresAt < new Date()) {
    throw HttpError.badRequest("Verification link is invalid or expired");
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
    prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw HttpError.unauthorized("Invalid email or password");
  }
  if (user.deletedAt) throw HttpError.unauthorized("Invalid email or password");

  return { user, tokens: await issueTokens(user.id) };
}

export async function refreshTokens(refreshToken: string) {
  let userId: string;
  try {
    userId = verifyRefreshToken(refreshToken).sub;
  } catch {
    throw HttpError.unauthorized("Invalid or expired refresh token");
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt) throw HttpError.unauthorized("Invalid or expired refresh token");

  // Permissions are re-resolved rather than copied from the old token, in case
  // the user's roles changed since it was issued.
  return { user, tokens: await issueTokens(user.id) };
}

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { profile: true, roles: { include: { role: true } } },
  });
  return { ...user, roles: user.roles.map((r) => r.role.name) };
}

export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  // Always behave the same whether or not the account exists, so this endpoint
  // can't be used to enumerate registered emails.
  if (!user) return;

  const token = crypto.randomBytes(32).toString("hex");
  await prisma.verificationToken.create({
    data: { userId: user.id, tokenHash: hashToken(token), type: "PASSWORD_RESET", expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS) },
  });

  // Integration point: send `token` via the notifications module (SendByte) as a /reset-password?token= link.
  return token;
}

export async function resetPassword(token: string, newPassword: string) {
  const record = await prisma.verificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.type !== "PASSWORD_RESET" || record.usedAt || record.expiresAt < new Date()) {
    throw HttpError.badRequest("Reset link is invalid or expired");
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);
}
