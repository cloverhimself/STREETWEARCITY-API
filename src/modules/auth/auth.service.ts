import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { signAccessToken } from "../../lib/jwt";
import { sendPasswordResetEmail, sendVerificationEmail } from "../../lib/sendbyte";
import { HttpError } from "../../utils/http-error";

const SALT_ROUNDS = 12;
const EMAIL_VERIFICATION_TTL_MS = 15 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const verificationCode = () => crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();

async function resolvePermissions(userId: string) {
  const userRoles = await prisma.userRole.findMany({ where: { userId }, include: { role: { include: { permissions: { include: { permission: true } } } } } });
  return {
    roles: userRoles.map((ur) => ur.role.name),
    permissions: [...new Set(userRoles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission.key)))],
  };
}

async function issueAccess(userId: string) {
  const authorization = await resolvePermissions(userId);
  return { accessToken: signAccessToken({ sub: userId, ...authorization }), ...authorization };
}

async function createRefreshSession(userId: string, familyId = crypto.randomUUID()) {
  const token = crypto.randomBytes(48).toString("hex");
  await prisma.refreshSession.create({ data: { userId, familyId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) } });
  return token;
}

async function issueSession(userId: string) {
  return { ...(await issueAccess(userId)), refreshToken: await createRefreshSession(userId) };
}

export async function register(input: { email: string; password: string; firstName: string; lastName: string }) {
  if (await prisma.user.findUnique({ where: { email: input.email } })) throw HttpError.conflict("An account with this email already exists");
  const customerRole = await prisma.role.findUnique({ where: { name: "customer" } });
  if (!customerRole) throw new Error("Base 'customer' role is missing — run the seed script");
  const user = await prisma.user.create({ data: { email: input.email, passwordHash: await bcrypt.hash(input.password, SALT_ROUNDS), profile: { create: { firstName: input.firstName, lastName: input.lastName } }, roles: { create: { roleId: customerRole.id } }, wishlist: { create: {} } } });
  const code = verificationCode();
  await prisma.verificationToken.create({ data: { userId: user.id, tokenHash: hashToken(`${user.email.toLowerCase()}:${code}`), type: "EMAIL_VERIFICATION", expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS) } });
  await sendVerificationEmail(user.email, code);
  return { user };
}

export async function verifyEmail(email: string, code: string) {
  const record = await prisma.verificationToken.findUnique({ where: { tokenHash: hashToken(`${email.toLowerCase()}:${code.toUpperCase()}`) } });
  if (!record || record.type !== "EMAIL_VERIFICATION" || record.usedAt || record.expiresAt < new Date()) throw HttpError.badRequest("Verification code is invalid, expired, or already used");
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
    prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.deletedAt || !(await bcrypt.compare(password, user.passwordHash))) throw HttpError.unauthorized("Invalid email or password");
  if (!user.emailVerifiedAt) throw HttpError.forbidden("Please verify your email before signing in");
  return { user, tokens: await issueSession(user.id) };
}

export async function refreshTokens(refreshToken: string) {
  const tokenHash = hashToken(refreshToken);
  const session = await prisma.refreshSession.findUnique({ where: { tokenHash } });
  if (!session || session.expiresAt < new Date()) throw HttpError.unauthorized("Invalid or expired refresh token");
  if (session.revokedAt || session.rotatedAt) {
    await prisma.refreshSession.updateMany({ where: { familyId: session.familyId }, data: { revokedAt: new Date() } });
    throw HttpError.unauthorized("Refresh token reuse detected");
  }
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || user.deletedAt) throw HttpError.unauthorized("Invalid or expired refresh token");
  if (!user.emailVerifiedAt) throw HttpError.forbidden("Please verify your email before signing in");
  const nextToken = crypto.randomBytes(48).toString("hex");
  const nextHash = hashToken(nextToken);
  await prisma.$transaction([
    prisma.refreshSession.update({ where: { id: session.id }, data: { rotatedAt: new Date(), replacedByHash: nextHash, lastUsedAt: new Date() } }),
    prisma.refreshSession.create({ data: { userId: user.id, familyId: session.familyId, tokenHash: nextHash, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) } }),
  ]);
  return { user, tokens: { ...(await issueAccess(user.id)), refreshToken: nextToken } };
}

export async function revokeRefreshToken(refreshToken: string) {
  await prisma.refreshSession.updateMany({ where: { tokenHash: hashToken(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true, roles: { include: { role: true } } } });
  return { ...user, roles: user.roles.map((r) => r.role.name) };
}

export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;
  const token = crypto.randomBytes(32).toString("hex");
  await prisma.verificationToken.create({ data: { userId: user.id, tokenHash: hashToken(token), type: "PASSWORD_RESET", expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS) } });
  await sendPasswordResetEmail(user.email, token);
  return token;
}

export async function resetPassword(token: string, newPassword: string) {
  const record = await prisma.verificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.type !== "PASSWORD_RESET" || record.usedAt || record.expiresAt < new Date()) throw HttpError.badRequest("Reset link is invalid or expired");
  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await bcrypt.hash(newPassword, SALT_ROUNDS) } }),
    prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: now } }),
    prisma.refreshSession.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: now } }),
  ]);
}
