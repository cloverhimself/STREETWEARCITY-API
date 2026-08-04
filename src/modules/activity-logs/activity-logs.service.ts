import { prisma } from "../../lib/prisma";

export interface ActivityLogQuery {
  page: number;
  pageSize: number;
  action?: string;
  resourceType?: string;
  actorUserId?: string;
  from?: Date;
  to?: Date;
}

export async function listActivityLogs(query: ActivityLogQuery) {
  const where = {
    ...(query.action ? { action: query.action } : {}),
    ...(query.resourceType ? { resourceType: query.resourceType } : {}),
    ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
    ...((query.from || query.to) ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.activityLog.findMany({ where, include: { actor: { select: { id: true, email: true, profile: true } } }, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.activityLog.count({ where }),
  ]);
  return {
    items: items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
    pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) },
  };
}
