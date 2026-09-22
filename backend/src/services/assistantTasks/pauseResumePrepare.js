// AI Media Buyer Operator — the one genuinely-new (but tiny) piece of
// business logic in Slice 1: no standalone "pause/resume this entity now"
// function exists outside the rule engine's own scheduled batch runs. This
// finds-or-creates a PENDING AmbRecommendation mirroring
// budgetBumpOrchestrator.js's persistBumpRecommendation() shape exactly, so
// it flows through the SAME approve → executor.js pipeline untouched. No
// Meta write happens here.
import { prisma } from '../../prisma.js';
import { getConnection, getDecryptedToken } from '../metaAuth.js';
import { getEntityLive } from '../metaGraphClient.js';

const KIND_TO_ACTION = { PAUSE: { decision: 'PAUSE_LOSER', actionType: 'PAUSE', targetStatus: 'PAUSED', requiredCurrent: 'ACTIVE' },
  RESUME: { decision: 'RESUME', actionType: 'RESUME', targetStatus: 'ACTIVE', requiredCurrent: 'PAUSED' } };

/** Real, current status/name — never assumed. PAUSE only from ACTIVE, RESUME only from PAUSED (the rule engine re-checks this again, live, at approve time — this is just an honest, fast pre-check so the chat doesn't propose an impossible action). */
export async function checkEntityForPauseResume({ entityId, kind }) {
  const cfg = KIND_TO_ACTION[kind];
  if (!cfg) { const e = new Error(`نوع إجراء غير معروف: ${kind}`); e.status = 400; throw e; }
  const connection = await getConnection();
  if (!connection || connection.status !== 'CONNECTED' || !connection.selected_ad_account_id) {
    const e = new Error('مفيش اتصال Meta Ads صالح.'); e.status = 400; throw e;
  }
  const token = await getDecryptedToken();
  const live = await getEntityLive(token, entityId);
  if (!live) { const e = new Error('العنصر مش موجود أو مفيش صلاحية وصول له.'); e.status = 404; throw e; }
  const effective = live.effectiveStatus || live.status;
  if (effective !== cfg.requiredCurrent) {
    const e = new Error(
      kind === 'PAUSE' ? `${live.name || entityId} مش نشط حاليًا (الحالة: ${effective}) — مفيش حاجة توقفها.`
        : `${live.name || entityId} مش موقوف حاليًا (الحالة: ${effective}) — مفيش حاجة تستأنفها.`
    );
    e.status = 409;
    throw e;
  }
  return { connection, live, cfg };
}

/** Reuses an existing PENDING rec for this entity+action if one exists (dedupe); otherwise creates one, mirroring persistBumpRecommendation()'s exact field shape. */
export async function findOrCreatePauseResumeRecommendation({ entityId, entityType, kind, live, adAccountId }) {
  const cfg = KIND_TO_ACTION[kind];
  const existing = await prisma.ambRecommendation.findFirst({
    where: { entity_id: entityId, action_type: cfg.actionType, status: 'PENDING' },
    orderBy: { created_at: 'desc' },
  });
  if (existing) return existing;

  return prisma.ambRecommendation.create({
    data: {
      batch_id: `assistant-${kind.toLowerCase()}-${Date.now()}`,
      ad_account_id: adAccountId,
      level: entityType || 'adset',
      entity_id: entityId,
      entity_name: live.name || entityId,
      campaign_id: entityType === 'campaign' ? entityId : null,
      adset_id: entityType === 'adset' ? entityId : null,
      ad_id: entityType === 'ad' ? entityId : null,
      decision: cfg.decision,
      action_type: cfg.actionType,
      executable: true,
      current_metrics_json: JSON.stringify({}),
      reason: 'إيقاف/استئناف يدوي من المساعد عبر الشات',
      reason_facts_json: JSON.stringify({ rule: 'ASSISTANT_MANUAL', kind }),
      confidence: 'HIGH', risk_level: 'LOW', priority: 'P1', data_sufficiency: 'STRONG',
      source: 'FALLBACK', status: 'PENDING',
    },
  });
}
