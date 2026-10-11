// 💰 BUDGET CHANGE — the ONE place that understands a Meta budget (CBO campaign budget · ABO ad-set budgets), validates a change, and shows its money impact. 2026-10-12.
// Every path that raises or lowers a budget (manual operation, owner approval of a prepared decision, the automation engine, the budget bridge) uses these helpers so they cannot disagree:
//   · the LIVE structure comes from Meta (campaign + its ad sets), never from the synced copy;   · CBO → the campaign's own daily budget;  ABO → ONE explicitly chosen ad set, never the others;
//   · LIFETIME budgets, missing budgets and unknown structures are refused with an exact reason;   · the executor's own bounds (±ambMaxBudgetIncreasePct per action, increase cooldown, daily cumulative cap) are mirrored
//     here so the owner hears about them BEFORE confirming (the executor still enforces them);   · Meta minimum / maximum daily budget are configurable limits (limits.automation.metaMinDailyBudget / metaMaxDailyBudget);
//   · caps (campaign / product / account / the product policy's Daily Spend Cap) are checked on increases and the result is shown as before → after.
import { prisma } from '../../prisma.js';
import { currencyFactor } from './snapshotSync.js';

const MS_H = 3_600_000;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const DELIVERING = new Set(['ACTIVE', 'IN_PROCESS', 'WITH_ISSUES', 'LEARNING', 'LEARNING_LIMITED']);
const DEAD = new Set(['DELETED', 'ARCHIVED']);
const round = (v) => Math.round(Number(v));

/** Meta entity (campaign or ad set) → { budgetType, budget (major units) } */
export function classifyBudget(raw, currency = 'EGP') {
  const f = currencyFactor(currency); const d = num(raw?.daily_budget), l = num(raw?.lifetime_budget);
  if (d != null && d > 0) return { budgetType: 'DAILY', budget: d / f };
  if (l != null && l > 0) return { budgetType: 'LIFETIME', budget: l / f };
  return { budgetType: null, budget: null };
}
const statusOf = (raw) => ({ status: raw?.status || null, effective: raw?.effective_status || raw?.status || null });

/** Pure: can THIS entity take a budget change right now? → { ok, reason?, ack? } (ack = a warning the owner must acknowledge by name) */
export function entityEligibility({ entity, campaign, level }) {
  if (!entity) return { ok: false, reason: 'ENTITY_NOT_FOUND', message: 'الكيان مش موجود في الحملة.' };
  if (entity.budgetType === 'LIFETIME') return { ok: false, reason: 'LIFETIME_BUDGET', message: 'الميزانية Lifetime مش يومية — التعديل بالنسبة للميزانيات اليومية فقط.' };
  if (entity.budgetType !== 'DAILY' || !(entity.budget > 0)) return { ok: false, reason: level === 'adset' ? 'NO_BUDGET' : 'BUDGET_UNKNOWN', message: level === 'adset' ? 'الـAd Set ملوش ميزانية يومية.' : 'الحملة ملهاش ميزانية يومية معروفة.' };
  if (DEAD.has(entity.status) || DEAD.has(entity.effective)) return { ok: false, reason: 'ENTITY_DELETED', message: 'الكيان محذوف/مؤرشف.' };
  if (level === 'adset') {
    if (entity.status === 'PAUSED') return { ok: true, ack: 'ADSET_PAUSED', message: 'الـAd Set موقوف — التغيير هيسري عند تشغيله، ومفيش صرف دلوقتي.' };
    if (campaign && !DELIVERING.has(campaign.effective) && campaign.status !== 'ACTIVE') return { ok: true, ack: 'CAMPAIGN_NOT_ACTIVE', message: 'الحملة موقوفة — التغيير هيسري عند تشغيلها.' };
    if (!DELIVERING.has(entity.effective) && entity.effective === 'CAMPAIGN_PAUSED') return { ok: true, ack: 'CAMPAIGN_NOT_ACTIVE', message: 'الحملة موقوفة — التغيير هيسري عند تشغيلها.' };
  } else if (campaign && campaign.status !== 'ACTIVE') return { ok: true, ack: 'CAMPAIGN_NOT_ACTIVE', message: 'الحملة موقوفة — التغيير هيسري عند تشغيلها.' };
  return { ok: true };
}

/**
 * LIVE structure of a campaign's budget. deps (tests): readCampaign(id) / readAdsets(id) returning raw Graph objects, currency.
 * Returns { campaign, level: 'CBO'|'ABO'|'UNKNOWN'|'LIFETIME'|'INCONSISTENT', entities[], adsets[], totals }.
 */
export async function readBudgetStructure({ campaignId, deps = {} }) {
  let currency = deps.currency || 'EGP', rawC, rawA;
  if (deps.readCampaign) { rawC = await deps.readCampaign(campaignId); rawA = await deps.readAdsets(campaignId); }
  else {
    const [G, MA] = await Promise.all([import('../metaGraphClient.js'), import('../metaAuth.js')]); const token = await MA.getDecryptedToken(); const conn = await MA.getConnection();
    try { currency = (await G.getAdAccountInfo(token, conn?.selected_ad_account_id))?.currency || 'EGP'; } catch { /* EGP */ }
    rawC = await G.getEntity(token, campaignId, 'id,name,status,effective_status,daily_budget,lifetime_budget'); rawA = await G.getCampaignAdSetsLive(token, campaignId);
  }
  const campaign = { id: rawC.id, name: rawC.name || null, ...statusOf(rawC), ...classifyBudget(rawC, currency) };
  const adsets = (rawA || []).map((a) => ({ id: a.id, name: a.name || null, ...statusOf(a), ...classifyBudget(a, currency) }));
  const adsetsWithBudget = adsets.filter((a) => a.budgetType != null);
  let level = 'UNKNOWN';
  if (campaign.budgetType === 'DAILY') level = adsetsWithBudget.length ? 'INCONSISTENT' : 'CBO';
  else if (campaign.budgetType === 'LIFETIME') level = 'LIFETIME';
  else if (adsetsWithBudget.length) level = 'ABO';
  const level_ = level === 'CBO' ? 'campaign' : level === 'ABO' ? 'adset' : null;
  const entities = level === 'CBO' ? [{ ...campaign, level: 'campaign', eligibility: entityEligibility({ entity: campaign, campaign, level: 'campaign' }) }]
    : level === 'ABO' ? adsets.map((a) => ({ ...a, level: 'adset', eligibility: entityEligibility({ entity: a, campaign, level: 'adset' }) })) : [];
  const dailyOf = (list) => list.filter((a) => a.budgetType === 'DAILY').reduce((t, a) => t + a.budget, 0);
  return { campaign, level, entityLevel: level_, entities, adsets, currency, totals: { campaignBudget: campaign.budget ?? null, adsetsAll: dailyOf(adsets), adsetsDelivering: dailyOf(adsets.filter((a) => DELIVERING.has(a.effective))) },
    issues: level === 'UNKNOWN' ? [{ code: 'BUDGET_UNKNOWN', message: 'مفيش ميزانية يومية على الحملة ولا على أي Ad Set — الميزانية غير معروفة.' }] : level === 'INCONSISTENT' ? [{ code: 'BUDGET_ON_BOTH_LEVELS', message: 'ميزانية على الحملة وعلى Ad Sets في نفس الوقت — بيانات غير متسقة، مفيش تخمين.' }] : level === 'LIFETIME' ? [{ code: 'LIFETIME_BUDGET', message: 'ميزانية Lifetime — مش مدعومة في التعديل بالنسبة.' }] : [] };
}

/** The limits every path respects. settings = ambSettings, config = operator config. */
export function budgetLimits({ settings = {}, config = {} } = {}) {
  const a = config.limits?.automation || {};
  return { maxChangePct: num(settings.ambMaxBudgetIncreasePct) ?? 20, maxDailyIncreasePct: num(settings.ambMaxDailyBudgetIncreasePct) ?? 50, scalingCooldownHours: num(settings.ambScalingCooldownHours) ?? 24, minDaily: num(a.metaMinDailyBudget), maxDaily: num(a.metaMaxDailyBudget) ?? 1_000_000 };
}

/** Executed budget changes on this entity in the last 24h + the owner's own recent edits (Manual Override). Injectable for tests. */
export async function loadRecentBudgetChanges({ entityId, campaignId, now = new Date(), deps = {} }) {
  if (deps.recent) return deps.recent;
  const since = new Date(now.getTime() - 24 * MS_H);
  const acts = await prisma.ambAction.findMany({ where: { entity_id: entityId, action_type: { in: ['INCREASE_BUDGET', 'DECREASE_BUDGET'] }, execution_status: 'EXECUTED', executed_at: { gte: since } }, orderBy: { executed_at: 'desc' }, select: { action_type: true, executed_at: true, old_value_json: true, new_value_json: true } });
  const changes = acts.map((a) => ({ at: a.executed_at, action: a.action_type === 'INCREASE_BUDGET' ? 'SCALE_UP' : 'SCALE_DOWN', from: j(a.old_value_json, {})?.budget ?? null, to: j(a.new_value_json, {})?.budget ?? null }));
  const mo = await prisma.ambOperatorEvent.findMany({ where: { kind: 'MANUAL_OVERRIDE', campaign_id: campaignId, created_at: { gte: new Date(now.getTime() - 24 * MS_H) } }, select: { created_at: true, data_json: true } });
  const owner = mo.map((e) => ({ at: e.created_at, ...(j(e.data_json, {}) || {}) })).filter((d) => !d.entityId || d.entityId === entityId);
  return { changes, ownerEdits: owner };
}

/**
 * PURE validation of one change. Returns { ok, blockers[{code,message}], warnings[{code,message}], ack[codes], from, to, deltaPct, delta }.
 * `recent` = loadRecentBudgetChanges(); `limits` = budgetLimits().
 */
export function validateBudgetChange({ structure, entityId, operation, toBudget = null, pct = null, limits, recent = { changes: [], ownerEdits: [] }, now = new Date() }) {
  const blockers = [], warnings = [], ack = [];
  const B = (code, message) => blockers.push({ code, message });
  if (!['INCREASE', 'REDUCE'].includes(operation)) B('BAD_OPERATION', 'العملية لازم زيادة أو تقليل.');
  if (structure.level === 'UNKNOWN' || structure.level === 'LIFETIME' || structure.level === 'INCONSISTENT') { for (const i of structure.issues) B(i.code, i.message); return { ok: false, blockers, warnings, ack, from: null, to: null }; }
  if (!entityId && structure.level === 'CBO') entityId = structure.campaign.id; // CBO: the campaign itself is the only budget holder
  const ent = structure.entities.find((e) => e.id === entityId);
  if (!entityId) { B('SELECT_ADSET', structure.level === 'ABO' ? 'الحملة ABO — اختار الـAd Set اللي هتغيّر ميزانيته (الباقي مش هيتغيّر).' : 'اختار الكيان.'); return { ok: false, blockers, warnings, ack, from: null, to: null }; }
  if (!ent) { B('ENTITY_NOT_IN_CAMPAIGN', structure.level === 'CBO' ? 'الحملة CBO — التعديل على ميزانية الحملة نفسها، مش على Ad Set.' : 'الـAd Set ده مش تابع للحملة دي (أو مش عليه ميزانية).'); return { ok: false, blockers, warnings, ack, from: null, to: null }; }
  if (!ent.eligibility.ok) { B(ent.eligibility.reason, ent.eligibility.message); return { ok: false, blockers, warnings, ack, from: ent.budget ?? null, to: null }; }
  if (ent.eligibility.ack) { ack.push(ent.eligibility.ack); warnings.push({ code: ent.eligibility.ack, message: ent.eligibility.message }); }
  const from = ent.budget; const sign = operation === 'INCREASE' ? 1 : -1;
  let to = toBudget != null ? round(toBudget) : pct != null ? round(from * (1 + sign * Number(pct) / 100)) : null;
  if (to == null || !Number.isFinite(to)) { B('TARGET_BUDGET_REQUIRED', 'حدّد الميزانية الجديدة (رقم) أو نسبة التغيير.'); return { ok: false, blockers, warnings, ack, from, to: null }; }
  if (!(to > 0)) B('BUDGET_NOT_POSITIVE', 'الميزانية الجديدة لازم تكون أكبر من صفر (للإيقاف استخدم «إيقاف»).');
  if (to === from) B('NO_CHANGE', `الميزانية الجديدة ${to} نفس الحالية.`);
  else if (operation === 'INCREASE' && to < from) B('NOT_AN_INCREASE', `الميزانية الجديدة ${to} أقل من الحالية ${from} — ده تقليل.`);
  else if (operation === 'REDUCE' && to > from) B('NOT_A_REDUCTION', `الميزانية الجديدة ${to} أكبر من الحالية ${from} — ده زيادة.`);
  const delta = to - from, deltaPct = from > 0 ? (delta / from) * 100 : null;
  if (deltaPct != null && Math.abs(deltaPct) > limits.maxChangePct + 0.5) B('CHANGE_PCT_TOO_LARGE', `التغيير ${Math.round(Math.abs(deltaPct))}% أكبر من الحد المسموح للأكشن الواحد (${limits.maxChangePct}%) — اعمل على خطوات.`);
  if (limits.minDaily != null && to < limits.minDaily) B('META_MIN_BUDGET', `الميزانية الجديدة ${to} أقل من الحد الأدنى المسموح (${limits.minDaily}).`);
  if (limits.maxDaily != null && to > limits.maxDaily) B('META_MAX_BUDGET', `الميزانية الجديدة ${to} أعلى من الحد الأقصى المسموح (${limits.maxDaily}).`);
  if (operation === 'INCREASE') {
    const lastUp = (recent.changes || []).find((c) => c.action === 'SCALE_UP');
    if (lastUp && now.getTime() - new Date(lastUp.at).getTime() < limits.scalingCooldownHours * MS_H) B('SCALING_COOLDOWN', `فيه زيادة على نفس العنصر من ${Math.round((now.getTime() - new Date(lastUp.at).getTime()) / MS_H)} ساعة — لازم ${limits.scalingCooldownHours} ساعة بين الزيادات.`);
    let cum = deltaPct || 0; for (const c of recent.changes || []) if (c.from && c.to) cum += ((c.to - c.from) / c.from) * 100;
    if (cum > limits.maxDailyIncreasePct + 0.5) B('DAILY_SCALE_CAP', `إجمالي زيادة الميزانية اليوم على العنصر هيوصل ${Math.round(cum)}% (الحد ${limits.maxDailyIncreasePct}%).`);
  }
  const lastAny = (recent.changes || [])[0];
  if (lastAny && !blockers.some((b) => b.code === 'SCALING_COOLDOWN')) { warnings.push({ code: 'RECENT_BUDGET_CHANGE', message: `اتغيّرت ميزانية العنصر ده من ${Math.round((now.getTime() - new Date(lastAny.at).getTime()) / MS_H)} ساعة (${lastAny.from}→${lastAny.to}) — التغيير المتتابع بيصعّب قراءة الأثر.` }); ack.push('RECENT_BUDGET_CHANGE'); }
  if ((recent.ownerEdits || []).length) { warnings.push({ code: 'MANUAL_OVERRIDE_RECENT', message: 'اتعمل تعديل يدوي على الميزانية من Meta خلال آخر 24 ساعة (Manual Override).' }); ack.push('MANUAL_OVERRIDE_RECENT'); }
  return { ok: blockers.length === 0, blockers, warnings, ack: [...new Set(ack)], from, to, delta, deltaPct: deltaPct == null ? null : Math.round(deltaPct * 10) / 10, entity: { id: ent.id, name: ent.name, level: ent.level, status: ent.status, effective: ent.effective } };
}

/** Pure: money impact — this entity, the ABO total (all ad sets / delivering ad sets), and the caps before → after. */
export function budgetImpact({ structure, entityId, from, to, caps = null, totals = null, productCap = null }) {
  const delta = to - from; const out = { before: from, after: to, delta, pct: from > 0 ? Math.round((delta / from) * 1000) / 10 : null };
  if (structure.level === 'ABO') {
    const sibs = structure.adsets.filter((a) => a.id !== entityId && a.budgetType === 'DAILY'); const sum = (l) => l.reduce((t, a) => t + a.budget, 0);
    out.abo = { adsetsTotalBefore: structure.totals.adsetsAll, adsetsTotalAfter: structure.totals.adsetsAll + delta, deliveringBefore: structure.totals.adsetsDelivering, deliveringAfter: structure.totals.adsetsDelivering + (DELIVERING.has(structure.adsets.find((a) => a.id === entityId)?.effective) ? delta : 0), untouched: sibs.map((a) => ({ id: a.id, name: a.name, status: a.status, budget: a.budget })), untouchedTotal: sum(sibs) };
  }
  if (caps && delta > 0) { out.caps = {}; for (const k of ['campaign', 'product', 'account']) { const cap = k === 'product' && productCap != null ? productCap : caps[k]; if (cap == null) { out.caps[k] = { cap: null }; continue; } const cur = totals?.[k]; out.caps[k] = { cap, current: cur == null ? null : Math.round(cur), after: cur == null ? null : Math.round(cur + delta), ok: cur == null ? null : cur + delta <= cap }; } }
  return out;
}

/**
 * Full preview of ONE change (no writes): live structure + validation + caps + impact. Used by the manual flow and by the pre-write checks of the other paths.
 * deps (tests): readCampaign/readAdsets/currency/recent/caps/totals/settings/config/productCap/identity.
 */
export async function previewBudgetChange({ campaignId, entityId = null, operation, toBudget = null, pct = null, now = new Date(), deps = {} }) {
  const structure = await readBudgetStructure({ campaignId, deps });
  const [{ getAmbSettings }, { getOperatorConfig }] = await Promise.all([import('./settings.js'), import('./operatorStore.js')]);
  const settings = deps.settings || await getAmbSettings(); const config = deps.config ? (typeof deps.config === 'function' ? await deps.config() : deps.config) : await getOperatorConfig();
  const limits = budgetLimits({ settings, config });
  const eid = entityId || (structure.level === 'CBO' ? campaignId : null);
  const recent = eid ? await loadRecentBudgetChanges({ entityId: eid, campaignId, now, deps }) : { changes: [], ownerEdits: [] };
  const v = validateBudgetChange({ structure, entityId: eid, operation, toBudget, pct, limits, recent, now });
  let impact = null, capCheck = null;
  if (v.from != null && v.to != null) {
    if (operation === 'INCREASE' && v.ok) {
      const { checkBudgetCaps } = await import('./budgetCaps.js'); const { dailyCapFromLimits } = await import('./productPolicy.js');
      const idn = deps.identity ? await deps.identity(campaignId) : await import('./integration.js').then((m) => m.campaignIdentity(campaignId)).catch(() => null);
      const productCap = dailyCapFromLimits(config.limits, idn?.storeId, idn?.productId, campaignId);
      capCheck = await checkBudgetCaps({ action: 'SCALE_UP', delta: v.delta, adAccountId: deps.adAccountId || (await (await import('../metaAuth.js')).getConnection().catch(() => null))?.selected_ad_account_id, campaignId, productId: idn?.productId ?? null, productCapOverride: productCap, now, deps: deps.capsDeps || {} });
      for (const x of capCheck.violations) v.blockers.push({ code: 'BUDGET_CAP', message: `الزيادة هتتجاوز حدّ ${x.label}: ${x.after} > ${x.cap}` });
      v.ok = v.blockers.length === 0; impact = budgetImpact({ structure, entityId: eid, from: v.from, to: v.to, caps: capCheck.caps, totals: capCheck.totals, productCap });
    } else impact = budgetImpact({ structure, entityId: eid, from: v.from, to: v.to });
  }
  return { structure, entityId: eid, validation: v, impact, limits, capCheck, ok: v.ok };
}

/** Shared pre-write bounds check for the paths that already hold a proposal (owner approval / automation): same rules, no structure read. */
export function checkProposalBounds({ operation, from, to, limits, recent = { changes: [] }, now = new Date() }) {
  const fake = { level: 'CBO', issues: [], entities: [{ id: 'x', level: 'campaign', budgetType: 'DAILY', budget: from, status: 'ACTIVE', effective: 'ACTIVE', eligibility: { ok: true } }], adsets: [], totals: {} };
  const v = validateBudgetChange({ structure: fake, entityId: 'x', operation, toBudget: to, limits, recent, now });
  return { ok: v.ok, blockers: v.blockers };
}

/** The pre-write bounds check used by the owner-approval bridge and the automation engine (they hold a proposal and re-read the structure themselves): % per action, Meta min / max, increase cooldown, daily cumulative cap. */
export async function preWriteBounds({ operation, from, to, entityId, campaignId, config, now = new Date(), deps = {} }) {
  const settings = deps.settings || await (await import('./settings.js')).getAmbSettings();
  const limits = budgetLimits({ settings, config }); const recent = await loadRecentBudgetChanges({ entityId, campaignId, now, deps });
  return { ...checkProposalBounds({ operation, from, to, limits, recent, now }), limits };
}
