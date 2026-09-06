// AI Media Buyer — notifications. A thin wrapper over the amb_alerts table.
// dedupeKey stops a still-true live condition (e.g. "campaign X over max
// CPA") from creating a fresh alert every 15-minute cycle: the same key
// upserts instead of inserting. Passing no dedupeKey always inserts.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';

/**
 * @param {{severity:'CRITICAL'|'OPPORTUNITY'|'WARNING'|'INFO', category:string, title:string, message:string, adAccountId?:string, level?:string, entityId?:string, entityName?:string, campaignId?:string, recommendationId?:number, dedupeKey?:string}} a
 */
export async function raiseAlert(a) {
  try {
    const data = {
      severity: a.severity,
      category: a.category || 'GENERIC',
      title: a.title,
      message: a.message,
      ad_account_id: a.adAccountId || null,
      level: a.level || null,
      entity_id: a.entityId || null,
      entity_name: a.entityName || null,
      campaign_id: a.campaignId || null,
      recommendation_id: a.recommendationId || null,
      dedupe_key: a.dedupeKey || null,
    };
    if (a.dedupeKey) {
      return await prisma.ambAlert.upsert({
        where: { dedupe_key: a.dedupeKey },
        create: data,
        update: { severity: data.severity, title: data.title, message: data.message, created_at: new Date(), read: false },
      });
    }
    return await prisma.ambAlert.create({ data });
  } catch (err) {
    // An alert failing to persist must never break the feature that raised it.
    logger.error('AMB raiseAlert failed', { message: err.message });
    return null;
  }
}

export async function listAlerts({ unreadOnly = false, limit = 50 } = {}) {
  return prisma.ambAlert.findMany({
    where: unreadOnly ? { read: false } : {},
    orderBy: { created_at: 'desc' },
    take: Math.min(limit, 200),
  });
}

export async function markAlertsRead(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return { count: 0 };
  return prisma.ambAlert.updateMany({ where: { id: { in: ids.map(Number) } }, data: { read: true } });
}

export async function markAllAlertsRead() {
  return prisma.ambAlert.updateMany({ where: { read: false }, data: { read: true } });
}
