import { prisma } from "../../lib/prisma";
import { HttpError } from "../../utils/http-error";

export async function listNotifications(userId: string, input: { page: number; pageSize: number; unreadOnly: boolean }) {
  const where = { userId, ...(input.unreadOnly ? { readAt: null } : {}) };
  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, skip: (input.page - 1) * input.pageSize, take: input.pageSize }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return {
    items: items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString(), readAt: item.readAt?.toISOString() ?? null })),
    unreadCount: unread,
    pagination: { page: input.page, pageSize: input.pageSize, total, totalPages: Math.ceil(total / input.pageSize) },
  };
}

export async function markNotificationRead(userId: string, notificationId: string) {
  const updated = await prisma.notification.updateMany({ where: { id: notificationId, userId }, data: { readAt: new Date() } });
  if (updated.count !== 1) throw HttpError.notFound("Notification not found");
  return prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
}

export async function markAllNotificationsRead(userId: string) {
  const updated = await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return { updated: updated.count };
}
