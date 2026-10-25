// 🎯 Automation SCOPE — the one place that answers «does this policy apply to this product / store / campaign today?» for Open, Pause and Budget automation alike. Pure helpers + one exposure reader.
//   include lists (all optional): when a list is non-empty the entity MUST be in it (lists of different kinds combine with AND); exclude lists always win over includes.
//   days: Cairo weekday numbers 0=Sunday … 6=Saturday; empty/null = every day.
//   exposure: the total DAILY budget of every ACTIVE campaign of the ad account (the money that can be spent today). A cap limits what an opening may add on top of it.
import { loadBudgetStructureFromSnapshots, discoverBudgetEntities } from './budgetOptimizer.js';

export const SCOPE_KINDS = ['Products', 'Stores', 'Campaigns'];
export const emptyScope = () => ({ includeProducts: [], excludeProducts: [], includeStores: [], excludeStores: [], includeCampaigns: [], excludeCampaigns: [] });
const list = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].sort() : []);
export function normalizeScope(raw) { const r = raw || {}; const o = emptyScope(); for (const k of Object.keys(o)) o[k] = list(r[k]); return o; }
export function validateScope(scope, label = '') {
  const e = []; const L = (m) => `${label}${m}`;
  for (const kind of SCOPE_KINDS) { const inc = scope[`include${kind}`], exc = scope[`exclude${kind}`]; const both = inc.filter((x) => exc.includes(x)); if (both.length) e.push(L(`${{ Products: 'المنتج', Stores: 'المتجر', Campaigns: 'الحملة' }[kind]} موجود في التضمين والاستبعاد معًا: ${both.slice(0, 5).join('، ')}.`)); }
  for (const k of Object.keys(scope)) if (scope[k].length > 500) e.push(L(`القائمة ${k} أطول من 500 عنصر.`));
  return e;
}
export function normalizeDays(raw) { if (!Array.isArray(raw)) return null; const d = [...new Set(raw.map(Number))].filter((x) => Number.isInteger(x) && x >= 0 && x <= 6).sort(); return d.length ? d : null; }
export const validDays = (raw) => raw == null || (Array.isArray(raw) && raw.every((x) => Number.isInteger(Number(x)) && Number(x) >= 0 && Number(x) <= 6));
/** null = in scope; otherwise the reason code. Pure. */
export function scopeVerdict(scope, { productId = null, storeId = null, campaignId = null } = {}) {
  const s = scope || emptyScope(); const p = productId == null ? null : String(productId), st = storeId == null ? null : String(storeId), c = campaignId == null ? null : String(campaignId);
  if ((p && s.excludeProducts.includes(p)) || (st && s.excludeStores.includes(st)) || (c && s.excludeCampaigns.includes(c))) return 'EXCLUDED_BY_POLICY';
  if ((s.includeProducts.length && !(p && s.includeProducts.includes(p))) || (s.includeStores.length && !(st && s.includeStores.includes(st))) || (s.includeCampaigns.length && !(c && s.includeCampaigns.includes(c)))) return 'OUT_OF_SCOPE';
  return null;
}
/** Auto-enrolment (owner decision 2026-10-25): a product whose ACTIVE policy is AUTOMATIC enters the policy's scope WITHOUT being typed into includeProducts — the product list is waived for it.
 *  Everything else still applies: excludeProducts/Stores/Campaigns always win, and includeStores / includeCampaigns (when set) still have to match. autoEnroll=false (policy flag) restores the strict include list. Pure. */
export function effectiveScope(scope, { autoEnroll = true, automatic = false } = {}) {
  if (!autoEnroll || !automatic || !scope || !(scope.includeProducts || []).length) return scope;
  return { ...scope, includeProducts: [] };
}
export const scopeIsEmpty = (scope) => !scope || Object.values(scope).every((l) => !l.length);
export const weekdayAllowed = (days, weekday) => !days || !days.length || days.includes(weekday);
export function describeScope(scope) {
  const s = scope || emptyScope(); const parts = []; const n = (k, label) => { if (s[k].length) parts.push(`${label}: ${s[k].length}`); };
  n('includeProducts', 'منتجات مضمّنة'); n('excludeProducts', 'منتجات مستبعدة'); n('includeStores', 'متاجر مضمّنة'); n('excludeStores', 'متاجر مستبعدة'); n('includeCampaigns', 'حملات مضمّنة'); n('excludeCampaigns', 'حملات مستبعدة');
  return parts.length ? parts.join(' · ') : 'كل المنتجات والمتاجر والحملات';
}

/**
 * Pure: walks `rows` in priority order and marks the ones whose daily budget would push the total (already-active exposure `base` + everything accepted before them) above `cap`.
 * rows: [{ key, budget, eligible }]; returns Set(key) of the rows REFUSED by the cap and the exposure that would result from the accepted ones. A row with an unknown budget is refused (fail closed).
 */
export function applyExposureCap(rows, { cap, base = 0 }) {
  const refused = new Set(); if (cap == null) return { refused, exposure: base, accepted: rows.filter((r) => r.eligible).length };
  let total = Number(base) || 0, accepted = 0;
  for (const r of rows) { if (!r.eligible) continue; const b = Number(r.budget); if (!Number.isFinite(b) || b <= 0 || total + b > cap + 0.0001) { refused.add(r.key); continue; } total += b; accepted++; }
  return { refused, exposure: total, accepted };
}

/** The total DAILY budget currently running on the ad account (ACTIVE campaigns, ABO ad sets or CBO campaign budget) from the synced Meta structure. deps.structure for tests. */
export async function activeExposure({ adAccountId, now = new Date(), deps = {} }) {
  const structure = deps.structure || await loadBudgetStructureFromSnapshots({ adAccountId, now });
  let total = 0, count = 0; const by = new Map();
  for (const [id, s] of structure) { if (s.campaign?.status !== 'ACTIVE') continue; const d = discoverBudgetEntities(s); const b = (d.entities || []).reduce((t, e) => t + (Number(e.budget) || 0), 0); if (b > 0) { total += b; count++; by.set(id, b); } }
  return { total: Math.round(total * 100) / 100, count, byCampaign: by, source: deps.structure ? 'INJECTED' : 'META_SYNC_SNAPSHOT' };
}
