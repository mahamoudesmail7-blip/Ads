// 🧹 DECISION HYGIENE — keeps the AUTOMATIC queue honest and a change from ever being applied twice. No Meta call, no limit, no permission: it only closes decisions that no longer mean anything.
//
//   · supersedeOlder    a newer decision for the SAME campaign + action + rule closes the older open ones (EXPIRED, SUPERSEDED_BY:<id>) — the cooldown bucket gives every window a new key, so without this the same
//                       "reduce Selicon 500→400" piles up as several PREPARED rows.
//   · sweepStale        an open AUTO decision the engine did not produce in this full tick (the campaign was paused, the product left AUTOMATIC, the numbers moved) or a zero-spend decision of a past day is EXPIRED
//                       (NO_LONGER_APPLICABLE / DECISION_DAY_PASSED) instead of waiting in «الموافقات» for ever. Execution never trusts an old row anyway (executeAutoDecision re-evaluates on Meta LIVE first).
//   · findAlreadyApplied  the same change already executed by ANOTHER decision → the second one must not be sent (idempotency across duplicate rows and rule families).
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { acctWhere } from './acctFilter.js';

const MS_H = 3_600_000;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const OPEN_STATUSES = ['PREPARED', 'BLOCKED', 'SHADOW'];
export const ENGINE_KINDS = ['INCREASE', 'REDUCE', 'STOCK_OUT', 'ZERO_ORDER', 'HIGH_CPA']; // the kinds evaluateAutomation() produces on every full tick (DAILY_ZERO_SPEND / MANUAL_* have their own lifecycle)
const isManual = (ruleName) => String(ruleName || '').startsWith('AUTO:MANUAL');
const event = async (data) => { try { await prisma.ambOperatorEvent.create({ data }); } catch (e) { logger.warn('[hygiene] event write failed', { message: e.message }); } };

async function expireRows(rows, error, actorNote) {
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const r = await prisma.ambOperatorDecision.updateMany({ where: { id: { in: ids }, status: { in: OPEN_STATUSES } }, data: { status: 'EXPIRED', error, error_category: 'GUARD' } });
  for (const row of rows) await event({ decision_id: row.id, kind: 'TRANSITION', from_status: row.status, to_status: 'EXPIRED', actor: 'SYSTEM', note: actorNote || error, campaign_id: row.campaign_id });
  return r.count;
}

/** Close the older open decisions that a newer one replaces. Returns how many were closed. */
export async function supersedeOlder({ keepId, campaignId, action, ruleName }) {
  if (!keepId || !campaignId || !action || !ruleName || isManual(ruleName)) return 0;
  const older = await prisma.ambOperatorDecision.findMany({ where: { id: { lt: Number(keepId) }, campaign_id: campaignId, action, rule_name: ruleName, status: { in: OPEN_STATUSES } }, select: { id: true, status: true, campaign_id: true } });
  return expireRows(older, `SUPERSEDED_BY:${keepId}`, `SUPERSEDED_BY:${keepId}`);
}

/**
 * After a FULL evaluation: `seenKeys` = the decision_key of every candidate this tick produced. Open engine decisions that were not produced are stale; open zero-spend decisions of an earlier Cairo day are stale.
 * `today` = the Cairo date (YYYY-MM-DD). Returns { expired, superseded }.
 */
export async function sweepStale({ seenKeys, today, adAccountId = null }) {
  const seen = seenKeys instanceof Set ? seenKeys : new Set(seenKeys || []);
  const acct = adAccountId ? { ad_account_id: adAccountId } : await acctWhere(); // a sweep after one account's full evaluation must not close another account's open decisions
  const engine = await prisma.ambOperatorDecision.findMany({ where: { ...acct, status: { in: OPEN_STATUSES }, rule_name: { in: ENGINE_KINDS.map((k) => `AUTO:${k}`) } }, select: { id: true, status: true, decision_key: true, campaign_id: true } });
  const stale = engine.filter((r) => !seen.has(r.decision_key));
  let expired = await expireRows(stale, 'NO_LONGER_APPLICABLE', 'NO_LONGER_APPLICABLE');
  if (today) {
    const zs = await prisma.ambOperatorDecision.findMany({ where: { ...acct, status: { in: OPEN_STATUSES }, rule_name: 'AUTO:DAILY_ZERO_SPEND' }, select: { id: true, status: true, campaign_id: true, evidence_json: true } });
    const past = zs.filter((r) => { const d = j(r.evidence_json, {})?.zeroSpend?.date; return d && d < today; });
    expired += await expireRows(past, 'DECISION_DAY_PASSED', 'DECISION_DAY_PASSED');
  }
  return { expired };
}

/**
 * Has ANOTHER decision already applied (or is applying) this very change? Budget: same campaign + action + target budget within 24h. Pause: any pause of the campaign within 2h.
 * Returns the other row or null. (The live re-evaluation already refuses a stale budget; this is the explicit idempotency guard across duplicate rows and rule families.)
 */
export async function findAlreadyApplied({ row, params = {}, now = new Date() }) {
  if (!row?.campaign_id || !row.action) return null;
  const isPause = row.action === 'PAUSE'; const since = new Date(now.getTime() - (isPause ? 2 : 24) * MS_H);
  const others = await prisma.ambOperatorDecision.findMany({ where: { id: { not: row.id }, campaign_id: row.campaign_id, action: row.action, status: { in: ['EXECUTING', 'EXECUTED', 'VERIFIED', 'UNCERTAIN'] }, updated_at: { gte: since } }, orderBy: { id: 'desc' }, select: { id: true, rule_name: true, params_json: true, status: true } });
  if (isPause) return others[0] || null;
  for (const o of others) { const op = j(o.params_json, {}) || {}; if (op.toBudget != null && params.toBudget != null && Math.abs(Number(op.toBudget) - Number(params.toBudget)) < 0.5 && String(op.entityId || '') === String(params.entityId || '')) return o; }
  return null;
}
