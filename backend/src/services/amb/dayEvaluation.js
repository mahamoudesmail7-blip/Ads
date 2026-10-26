// 📅 DAY-BASED EVALUATION — AUTOPILOT judges a campaign by TODAY's performance, not by a 3 / 7 day average (owner decision 2026-10-26).
//   · the evaluation day starts at 00:00 Africa/Cairo; a campaign that is (re)opened later starts its evaluation at the moment it was opened
//   · last 3 / 7 / 30 days are for ANALYSIS and protections only (Winner, 7-day confirmation of a reduction) — never the trigger of a pause / reduction / increase
//   · until there is enough TIME + SPEND + ORDERS (per the product policy) the campaign is in OBSERVATION: no pause, no reduction, no increase
//   · what stays URGENT and keeps its own window: spend with no orders (zero-order stop), stock-out, loss limits
// Pure helpers + one read-only loader. Nothing here writes anything or calls Meta.
import { prisma } from '../../prisma.js';
import { cairoDate, dueAtTime } from './dailyPlanTime.js';

export const MS_H = 3_600_000;
/** Defaults (code only — the owner can override them in the dynamic-budget policy under `observation`). */
export const OBSERVATION_DEFAULT = Object.freeze({ minHours: 3, minSpend: 100 });
/** The LAST active campaign of a product is never paused for a high CPA on a thin sample: it needs a clearly severe, well-sampled breach. */
export const LAST_ACTIVE_SEVERE_FACTOR = 1.5;
export const LAST_ACTIVE_SEVERE_SAMPLE_FACTOR = 2;

/** The instant the current Cairo day started (00:00 Cairo → UTC, DST-aware). */
export const dayStartUtc = (now = new Date()) => dueAtTime(cairoDate(now), '00:00');
/** Evaluation start of one campaign = the later of «Cairo midnight» and «the moment it was last (re)opened today». */
export function evaluationStart({ now = new Date(), activationAt = null } = {}) {
  const ds = dayStartUtc(now); if (!activationAt) return ds; const a = new Date(activationAt);
  return Number.isFinite(a.getTime()) && a > ds && a <= now ? a : ds;
}
export const hoursSince = (start, now = new Date()) => Math.max(0, (now.getTime() - new Date(start).getTime()) / MS_H);

/**
 * Is there enough evidence to act on a CPA-driven decision? evidence = {spend, purchases, hours}. Returns {ok, missing[], need}. Pure.
 * minPurchases comes from the PRODUCT policy (budget.minPurchases); minHours / minSpend from the observation policy.
 */
export function observationStatus({ evidence, obs = OBSERVATION_DEFAULT, minPurchases = 2 } = {}) {
  const o = { ...OBSERVATION_DEFAULT, ...(obs || {}) }; const e = evidence || {}; const missing = [];
  const hours = e.hours ?? 0, spend = e.spend ?? 0, purchases = e.purchases ?? 0;
  if (hours < o.minHours) missing.push({ code: 'TIME', have: Math.round(hours * 10) / 10, need: o.minHours, ar: `الوقت ${Math.round(hours * 10) / 10}س من ${o.minHours}س` });
  if (spend < o.minSpend) missing.push({ code: 'SPEND', have: Math.round(spend), need: o.minSpend, ar: `الصرف ${Math.round(spend)} من ${o.minSpend}` });
  if (purchases < minPurchases) missing.push({ code: 'ORDERS', have: purchases, need: minPurchases, ar: `الأوردرات ${purchases} من ${minPurchases}` });
  return { ok: missing.length === 0, missing, need: { hours: o.minHours, spend: o.minSpend, purchases: minPurchases } };
}

/**
 * The latest activation (open / resume) of each campaign TODAY, from what the system itself recorded: executed RESUME actions, executed OPEN decisions and verified daily-plan opens.
 * Returns Map(campaignId -> Date). A campaign opened by hand in Ads Manager is not recorded here (its evaluation then simply starts at midnight).
 */
export async function loadActivationTimes({ campaignIds, now = new Date() }) {
  const out = new Map(); if (!campaignIds?.length) return out; const since = dayStartUtc(now);
  const keep = (id, at) => { if (!at) return; const cur = out.get(id); if (!cur || at > cur) out.set(id, at); };
  const acts = await prisma.ambAction.findMany({ where: { entity_id: { in: campaignIds }, action_type: 'RESUME', execution_status: 'EXECUTED', executed_at: { gte: since } }, select: { entity_id: true, executed_at: true } }).catch(() => []);
  for (const a of acts) keep(a.entity_id, a.executed_at);
  const ds = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { in: campaignIds }, action: 'OPEN', status: { in: ['EXECUTED', 'VERIFIED'] }, executed_at: { gte: since } }, select: { campaign_id: true, executed_at: true } }).catch(() => []);
  for (const d of ds) keep(d.campaign_id, d.executed_at);
  const items = await prisma.ambDailyPlanItem.findMany({ where: { campaign_id: { in: campaignIds }, status: 'VERIFIED', status_at: { gte: since }, plan: { type: 'OPEN', simulated: false } }, select: { campaign_id: true, status_at: true } }).catch(() => []);
  for (const i of items) keep(i.campaign_id, i.status_at);
  return out;
}
