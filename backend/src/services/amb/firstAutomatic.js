// «أول تنفيذ تلقائي» — every AUTOMATIC execution is logged with its REASON and the ACTUAL result read back from Meta (an AmbOperatorEvent, kind AUTOMATIC_EXECUTION), and the FIRST one of each kind
// (open · pause · budget increase · budget decrease) raises its own prominent alert so the owner sees it the moment the automation first touches a real campaign. Never throws: a failing alert must not break the execution that raised it.
import { prisma } from '../../prisma.js';
import { raiseAlert } from './alerts.js';

export const FIRST_KIND_AR = Object.freeze({ OPEN: 'فتح', PAUSE: 'إيقاف', INCREASE: 'زيادة ميزانية', DECREASE: 'تخفيض ميزانية' });
export const kindOfDecision = (action) => ({ PAUSE: 'PAUSE', SCALE_UP: 'INCREASE', SCALE_DOWN: 'DECREASE', OPEN: 'OPEN', RESUME: 'OPEN' }[action] || null);
export const firstKey = (kind) => `operator:first:${kind}`;
const money = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : String(Math.round(Number(v))));

/** @returns {{logged:boolean, first:boolean}} verified: true = Meta's independent read-back confirmed it · false = request sent but NOT confirmed · null = unknown */
export async function recordAutomaticExecution({ kind, campaignId, campaignName, productName = null, reason = '', before = null, after = null, verified = null, ambActionId = null, decisionId = null, planId = null, adAccountId = null } = {}) {
  const out = { logged: false, first: false };
  try {
    if (!FIRST_KIND_AR[kind]) return out;
    const label = FIRST_KIND_AR[kind]; const result = verified === true ? 'اتأكد من قراءة Meta ✅' : verified === false ? 'الطلب اتبعت لكن قراءة Meta ما أكدتش ⚠️ (راجع الحملة)' : 'نتيجة Meta غير معروفة ⚠️';
    const change = kind === 'PAUSE' ? 'الحملة اتوقفت' : kind === 'OPEN' ? 'الحملة اتفتحت' : `الميزانية اليومية ${money(before)} → ${money(after)} ج`;
    const note = `AUTOMATIC ${label}: ${campaignName || campaignId} — ${change} — ${result}${reason ? ` — السبب: ${reason}` : ''}`.slice(0, 480);
    await prisma.ambOperatorEvent.create({ data: { kind: 'AUTOMATIC_EXECUTION', actor: 'SYSTEM', campaign_id: campaignId ? String(campaignId) : null, note, data_json: JSON.stringify({ kind, label, campaignId, campaignName, productName, reason, before, after, verified, ambActionId, decisionId, planId }).slice(0, 3500) } });
    out.logged = true;
    const seen = await prisma.ambAlert.findUnique({ where: { dedupe_key: firstKey(kind) }, select: { id: true } }).catch(() => null);
    if (!seen) {
      await raiseAlert({ severity: 'WARNING', category: 'OPERATOR', title: `🔔 أول ${label} تلقائي على Meta — ${campaignName || campaignId}`, message: `${change}. النتيجة الفعلية: ${result}.${reason ? ` السبب: ${reason}.` : ''} ده أول ${label} بينفّذه الـAUTOMATIC بنفسه — راجع «سجل التنفيذ».`.slice(0, 480), adAccountId, entityId: campaignId ? String(campaignId) : null, dedupeKey: firstKey(kind) });
      out.first = true;
    }
  } catch { /* never break the execution */ }
  return out;
}
