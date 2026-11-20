// «ذاكرة المنتج» — what the system has learned from EVERY past test of one product, for the AI Smart Targeting of the launch wizard.
// READ ONLY. Everything here is derived from real data that already exists: the product's campaigns (the launch chain + owner-confirmed mappings — never a name look-alike), their synced Meta snapshots (campaign / ad set / ad level),
// the ad sets' real targeting (our own launch jobs first, else Meta's read-only «ad set targeting»), and the product's real buyer segments. Nothing is invented and nothing is attributed without evidence:
//   • a verdict needs a real sample (purchases) — a low CPA on a handful of purchases is «عينة صغيرة», never a winner;
//   • an ad set with several interests is judged AS A SET — its result is never credited to one interest;
//   • a past Smart-Targeting test is judged like any other test, so every new test teaches the next one.
// The learning log (settings row `ssm:<productId>`) only remembers WHEN a verdict became final; the numbers are always recomputed from the data.
import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { loadSnapshots, latestPerDayPerEntity, aggregateRows, todayISO, addDaysISO } from './metricsEngine.js';

export const MEMORY_VERSION = 'product-memory-2026-11-v1';
export const WINDOWS = [7, 14, 30, 60, 90];
export const RULES = { minPurchases: 5, winMargin: 0.85, lossMargin: 1.3, lossSpendMult: 2.5, strategyMargin: 0.85, highPurchases: 20, mediumPurchases: 10 };
const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const KEY = (id) => `ssm:${id}`;

// ───────────── targeting of an ad set (Meta's shape → ours) ─────────────
export function parseTargeting(t) {
  if (!t || typeof t !== 'object') return null;
  const interests = []; const seen = new Set();
  const add = (list) => { for (const i of Array.isArray(list) ? list : []) { const id = String(i?.id ?? ''); if (!id || seen.has(id)) continue; seen.add(id); interests.push({ id, name: clean(i?.name) || id }); } };
  for (const fs of Array.isArray(t.flexible_spec) ? t.flexible_spec : []) add(fs?.interests);
  add(t.interests);
  const genders = Array.isArray(t.genders) && t.genders.length === 1 ? (t.genders[0] === 1 ? 'MALE' : t.genders[0] === 2 ? 'FEMALE' : 'ALL') : 'ALL';
  const ageMin = Number.isInteger(t.age_min) ? t.age_min : 18; const ageMax = Number.isInteger(t.age_max) ? t.age_max : 65;
  const regions = (t.geo_locations?.regions || []).length + (t.geo_locations?.cities || []).length;
  const adv = t.targeting_automation?.advantage_audience;
  const restrictsAgeGender = genders !== 'ALL' || ageMin > 18 || ageMax < 65;
  const type = interests.length ? 'INTERESTS' : restrictsAgeGender ? 'AGE_GENDER' : 'BROAD';
  return { type, ageMin, ageMax, genders, interests, regions, advantage: adv === 0 || adv === 1 ? adv : null };
}
const TYPE_AR = { BROAD: 'Broad (واسع)', INTERESTS: 'اهتمامات', AGE_GENDER: 'سن/نوع محدد' };

// ───────────── verdicts (small samples never win) ─────────────
/** @returns {{ verdict: 'WIN'|'LOSS'|'NEUTRAL'|'INCONCLUSIVE', confidence: 'HIGH'|'MEDIUM'|'LOW', why: string }} */
export function verdictFor(stats, baselineCpa, rules = RULES) {
  const p = stats?.purchases || 0; const spend = stats?.spend || 0; const cpa = stats?.cpa ?? null;
  if (!baselineCpa) return { verdict: 'INCONCLUSIVE', confidence: 'LOW', why: 'مفيش CPA مرجعي للمنتج (لسه معندوش مشتريات كفاية) فمينفعش نحكم.' };
  if (p >= rules.minPurchases && cpa != null) {
    const conf = p >= rules.highPurchases ? 'HIGH' : p >= rules.mediumPurchases ? 'MEDIUM' : 'LOW';
    if (cpa <= baselineCpa * rules.winMargin) return { verdict: 'WIN', confidence: conf, why: `CPA ${r2(cpa)} ج أقل من متوسط المنتج ${r2(baselineCpa)} ج بعد ${p} مشتريات.` };
    if (cpa >= baselineCpa * rules.lossMargin) return { verdict: 'LOSS', confidence: conf, why: `CPA ${r2(cpa)} ج أعلى من متوسط المنتج ${r2(baselineCpa)} ج بعد ${p} مشتريات.` };
    return { verdict: 'NEUTRAL', confidence: conf, why: `CPA ${r2(cpa)} ج قريب من متوسط المنتج ${r2(baselineCpa)} ج.` };
  }
  if (p === 0 && spend >= baselineCpa * rules.lossSpendMult) return { verdict: 'LOSS', confidence: 'MEDIUM', why: `صرف ${r2(spend)} ج (أكتر من ${rules.lossSpendMult}× متوسط CPA المنتج) من غير ولا مشتريات.` };
  return { verdict: 'INCONCLUSIVE', confidence: 'LOW', why: `عينة صغيرة (${p} مشتريات وصرف ${r2(spend)} ج) — مش كفاية للحكم.` };
}

const sumAgg = (aggs) => { let spend = 0, purchases = 0, revenue = 0, hasRev = false; for (const a of aggs) { if (!a) continue; spend += a.spend || 0; purchases += a.purchases || 0; if (a.revenue != null) { revenue += a.revenue; hasRev = true; } } return { spend: r2(spend), purchases, cpa: purchases > 0 ? r2(spend / purchases) : null, roas: hasRev && spend > 0 ? r2(revenue / spend) : null }; };

/** Per-entity day maps → totals over a date range. rowsByEntity: Map<id, Map<date,row>> */
function entityTotals(byEntity, from, to) {
  const out = new Map();
  for (const [id, days] of byEntity.entries()) { const rows = [...days.entries()].filter(([d]) => d >= from && d <= to).map(([, r]) => r); const a = aggregateRows(rows); if (a) out.set(id, a); }
  return out;
}

// ───────────── the memory ─────────────
/**
 * ONLY this product's campaigns, ONLY the columns the maths needs (never actions_json): the account-wide loader reads every campaign / ad set of the account × 90 days × every 15-minute snapshot —
 * on a big account that is millions of rows and was slow enough to drop the request («Failed to fetch»). `level` = campaign | adset.
 */
export async function loadProductSnapshots({ level, campaignIds, from, to }) {
  const idCol = Prisma.raw(level === 'adset' ? '"adset_id"' : '"campaign_id"'); const out = [];
  for (let i = 0; i < campaignIds.length; i += 150) {
    const ids = campaignIds.slice(i, i + 150);
    out.push(...await prisma.$queryRaw`
      SELECT DISTINCT ON (${idCol}, date_start)
        snapshot_at, ad_account_id, level, date_start, date_stop, campaign_id, campaign_name, campaign_status, campaign_budget, campaign_budget_type,
        adset_id, adset_name, adset_status, adset_budget, adset_budget_type, spend, impressions, reach, frequency, clicks, meta_purchases, meta_revenue, results, result_indicator, landing_page_views
      FROM "meta_performance_snapshots"
      WHERE level = ${level} AND date_start >= ${from} AND date_start <= ${to} AND campaign_id IN (${Prisma.join(ids)}) AND ${idCol} IS NOT NULL
      ORDER BY ${idCol} ASC, date_start ASC, snapshot_at DESC`);
  }
  return out;
}
async function defaultCampaigns(productId) { const m = await import('./productPerformance.js'); return m.resolveProductCampaigns(productId); }
async function defaultJobs(productId) {
  const jobs = await prisma.ambLaunchJob.findMany({ where: { product_id: productId }, select: { job_id: true, created_at: true, config_json: true, campaigns: { select: { name: true, meta_campaign_id: true } } }, orderBy: { created_at: 'asc' } });
  return jobs.map((j) => { let t = null; try { t = JSON.parse(j.config_json || '{}').targeting || null; } catch { /* none */ } return { jobId: j.job_id, createdAt: j.created_at, targeting: t, campaigns: j.campaigns.filter((c) => c.meta_campaign_id).map((c) => ({ id: String(c.meta_campaign_id), name: c.name })) }; });
}
/** Read-only: the real targeting of every ad set of the given campaigns, cached 6 h (only used for ad sets our own launch jobs do not describe). */
async function defaultAdSetTargeting(campaignIds) {
  const out = new Map(); if (!campaignIds.length) return out;
  const { graphList } = await import('../metaGraphClient.js'); const { getDecryptedToken } = await import('../metaAuth.js'); const C = await import('../aiGateway/cache.js');
  let token; try { token = await getDecryptedToken(); } catch { return out; }
  for (const cid of campaignIds.slice(0, 40)) {
    const key = C.requestHash({ feature: 'meta.adset-targeting', promptVersion: 'v1', parts: { cid } });
    try {
      let list = await C.cacheGet(key);
      if (!Array.isArray(list)) { list = (await graphList(`/${cid}/adsets`, { fields: 'id,name,targeting' }, token)).map((a) => ({ id: String(a.id), targeting: a.targeting || null })); await C.cacheSet({ cacheKey: key, feature: 'meta.adset-targeting', promptVersion: 'v1', data: list, ttlMs: 6 * 3_600_000 }); }
      for (const a of list) out.set(a.id, a.targeting);
    } catch (e) { logger.warn('[productMemory] ad set targeting unavailable', { campaign: cid, message: e.message }); }
  }
  return out;
}
async function defaultJournal(productId) { try { const row = await prisma.settings.findUnique({ where: { id: KEY(productId) } }); const v = JSON.parse(row?.data || '{}'); return { events: Array.isArray(v.events) ? v.events : [], final: v.final && typeof v.final === 'object' ? v.final : {} }; } catch { return { events: [], final: {} }; } }
async function saveJournal(productId, j) { const data = JSON.stringify({ events: j.events.slice(-60), final: j.final }); await prisma.settings.upsert({ where: { id: KEY(productId) }, create: { id: KEY(productId), data }, update: { data } }); }

/**
 * @param {number} productId
 * @param {{ deps?: object, persist?: boolean }} o   deps (tests): campaigns, jobs, snapshots(level,from,to,account), adSetTargeting, journal, saveJournal, real, today, name
 */
export async function getProductMemory(productId, { deps = {}, persist = false } = {}) {
  const today = deps.today || todayISO(); const from90 = addDaysISO(today, -89);
  const campaigns = await (deps.campaigns || defaultCampaigns)(productId);
  const cIds = new Set(campaigns.map((c) => String(c.campaignId)));
  const accounts = [...new Set(campaigns.map((c) => c.adAccountId).filter(Boolean))];
  const jobs = await (deps.jobs || defaultJobs)(productId).catch(() => []);
  const empty = { version: MEMORY_VERSION, productId, hasHistory: false, tests: 0, windows: {}, audienceTypes: {}, adSets: [], interests: [], smartTests: [], demographics: null, learnings: [], journal: [], summary: 'المنتج ده لسه معندوش حملات سابقة في السيستم — الاقتراح مبني على فهم المنتج مش على نتائج.', limits: [], baseline: null };
  if (!cIds.size) return empty;

  // 1) real numbers: campaign + ad set level, last 90 days, product campaigns only
  const campRows = []; const adsetRows = [];
  if (deps.snapshots) { // injected (tests): per account, as before
    for (const acc of accounts) {
      try { campRows.push(...(await deps.snapshots('campaign', from90, today, acc)).filter((r) => cIds.has(String(r.campaign_id)))); } catch (e) { logger.warn('[productMemory] campaign snapshots failed', { message: e.message }); }
      try { adsetRows.push(...(await deps.snapshots('adset', from90, today, acc)).filter((r) => cIds.has(String(r.campaign_id)))); } catch (e) { logger.warn('[productMemory] ad set snapshots failed', { message: e.message }); }
    }
  } else {
    const ids = [...cIds];
    try { campRows.push(...await loadProductSnapshots({ level: 'campaign', campaignIds: ids, from: from90, to: today })); } catch (e) { logger.warn('[productMemory] campaign snapshots failed', { message: e.message }); }
    try { adsetRows.push(...await loadProductSnapshots({ level: 'adset', campaignIds: ids, from: from90, to: today })); } catch (e) { logger.warn('[productMemory] ad set snapshots failed', { message: e.message }); }
  }
  const campDay = latestPerDayPerEntity(campRows, 'campaign'); const adsetDay = latestPerDayPerEntity(adsetRows, 'adset');
  const windows = {}; for (const w of WINDOWS) { const f = addDaysISO(today, -(w - 1)); windows[`w${w}`] = { days: w, ...sumAgg([...entityTotals(campDay, f, today).values()]) }; }
  const total90 = windows.w90; const baseline = total90.cpa; // the product's own CPA over 90 days = the yardstick every test is judged against
  const campTotals = entityTotals(campDay, from90, today); const tests = [...campTotals.values()].filter((a) => a.spend > 0).length;
  if (!tests) return { ...empty, productId, summary: 'المنتج ليه حملات مربوطة بس لسه مفيش صرف مسجّل في آخر 90 يوم — مفيش نتايج نتعلم منها.' };

  // 2) the targeting of each ad set: our own launch jobs first, else Meta (read only)
  const jobByCampaign = new Map(); for (const j of jobs) for (const c of j.campaigns) jobByCampaign.set(c.id, j);
  const adsetTotals = entityTotals(adsetDay, from90, today);
  const needMeta = [...new Set([...adsetTotals.values()].filter((a) => { const j = jobByCampaign.get(String(a.campaignId)); return !(j?.targeting && ['CUSTOM', 'SMART', 'BROAD'].includes(j.targeting.mode)); }).map((a) => String(a.campaignId)))];
  const metaTargeting = needMeta.length ? await (deps.adSetTargeting || defaultAdSetTargeting)(needMeta).catch(() => new Map()) : new Map();
  const adSets = [];
  for (const [id, a] of adsetTotals.entries()) {
    if (!(a.spend > 0)) continue;
    const job = jobByCampaign.get(String(a.campaignId)); let targeting = null; let source = null; let smart = false;
    if (job?.targeting && ['CUSTOM', 'SMART'].includes(job.targeting.mode)) { targeting = parseTargeting({ age_min: job.targeting.ageMin, age_max: job.targeting.ageMax, genders: job.targeting.genders === 'MALE' ? [1] : job.targeting.genders === 'FEMALE' ? [2] : [], flexible_spec: job.targeting.interests?.length ? [{ interests: job.targeting.interests }] : [], geo_locations: { regions: job.targeting.geoRegions || [] } }); source = 'WIZARD'; smart = job.targeting.mode === 'SMART' || job.targeting.smart === true; }
    else if (job?.targeting?.mode === 'BROAD' || (job && !job.targeting)) { targeting = parseTargeting({}); source = 'WIZARD'; }
    else if (metaTargeting.has(String(id))) { targeting = parseTargeting(metaTargeting.get(String(id))); source = 'META'; }
    const v = verdictFor(a, baseline);
    adSets.push({ id: String(id), name: a.adsetName || a.name || String(id), campaignId: String(a.campaignId), campaignName: a.campaignName || null, targetingKnown: !!targeting, type: targeting?.type || null, targeting, source, smart, spend: r2(a.spend), purchases: a.purchases || 0, cpa: r2(a.cpa), roas: r2(a.roas), budget: a.budget ?? null, ...v });
  }
  adSets.sort((x, y) => y.spend - x.spend);

  // 3) audience types, interests (judged as sets), smart tests
  const audienceTypes = {};
  for (const type of ['BROAD', 'INTERESTS', 'AGE_GENDER']) {
    const list = adSets.filter((s) => s.type === type); if (!list.length) continue;
    const t = sumAgg(list.map((s) => ({ spend: s.spend, purchases: s.purchases, revenue: s.roas != null ? s.roas * s.spend : null })));
    audienceTypes[type] = { ...t, adSets: list.length, label: TYPE_AR[type], ...verdictFor(t, baseline), wins: list.filter((s) => s.verdict === 'WIN').length, losses: list.filter((s) => s.verdict === 'LOSS').length };
  }
  const interestMap = new Map();
  for (const s of adSets) {
    if (s.type !== 'INTERESTS') continue; const group = s.targeting.interests.length > 1;
    for (const i of s.targeting.interests) { const e = interestMap.get(i.id) || { id: i.id, name: i.name, sets: 0, spend: 0, purchases: 0, verdicts: [], attribution: 'SINGLE' }; e.sets += 1; e.spend += s.spend; e.purchases += s.purchases; e.verdicts.push(s.verdict); if (group) e.attribution = 'GROUP'; interestMap.set(i.id, e); }
  }
  const interests = [...interestMap.values()].map((e) => ({ id: e.id, name: e.name, sets: e.sets, spend: r2(e.spend), purchases: e.purchases, attribution: e.attribution, verdict: e.attribution === 'SINGLE' ? (e.verdicts.includes('WIN') ? 'WIN' : e.verdicts.includes('LOSS') ? 'LOSS' : 'INCONCLUSIVE') : 'GROUP' }));
  const smartTests = adSets.filter((s) => s.smart).map(({ id, name, verdict, confidence, why, spend, purchases, cpa }) => ({ id, name, verdict, confidence, why, spend, purchases, cpa }));

  // 4) the learning log (when a verdict first became final), and Arabic learnings from the real numbers only
  const journal = await (deps.journal || defaultJournal)(productId); const events = [...journal.events]; const final = { ...journal.final }; let changed = false;
  for (const s of adSets) if (['WIN', 'LOSS'].includes(s.verdict) && s.confidence !== 'LOW' && final[s.id] !== s.verdict) { final[s.id] = s.verdict; events.push({ at: new Date().toISOString(), adsetId: s.id, verdict: s.verdict, text: `${s.smart ? 'تيست Smart Targeting' : 'تيست'} «${s.name}»: ${s.verdict === 'WIN' ? 'رابح' : 'خاسر'} — ${s.why}` }); changed = true; }
  if (persist && changed) await (deps.saveJournal || saveJournal)(productId, { events, final }).catch((e) => logger.warn('[productMemory] journal not saved', { message: e.message }));
  const mem = { version: MEMORY_VERSION, productId, hasHistory: true, tests, baseline: r2(baseline), windows, audienceTypes, adSets: adSets.slice(0, 30), adSetsTotal: adSets.length, interests, smartTests, demographics: null, journal: events.slice(-12), limits: [] };
  const unknown = adSets.filter((s) => !s.targetingKnown).length; if (unknown) mem.limits.push(`${unknown} Ad Set مقدرتش أعرف استهدافها من Meta (مش متاحة/اتحذفت) فمش داخلة في مقارنة النوع.`);
  mem.limits.push('نتايج Meta بتتعرض لكل Ad Set مش لكل اهتمام: لو الـAd Set فيه أكتر من اهتمام، النتيجة بتتنسب للمجموعة كلها ومش لاهتمام واحد.');
  mem.learnings = buildLearnings(mem); mem.summary = buildSummary(mem);
  return mem;
}

// ───────────── what it learned, in plain Arabic — numbers from the data only ─────────────
export function buildLearnings(m) {
  const L = []; const w = m.windows;
  const pw = (k, label) => (w[k]?.purchases ? `${label}: صرف ${w[k].spend} ج · ${w[k].purchases} مشتريات · CPA ${w[k].cpa} ج` : null);
  const lines = [pw('w7', 'آخر 7 أيام'), pw('w30', 'آخر 30 يوم'), pw('w90', 'آخر 90 يوم')].filter(Boolean);
  if (lines.length) L.push({ text: lines.join(' | '), confidence: m.windows.w90.purchases >= RULES.highPurchases ? 'HIGH' : m.windows.w90.purchases >= RULES.mediumPurchases ? 'MEDIUM' : 'LOW' });
  const t = m.audienceTypes;
  for (const k of ['BROAD', 'INTERESTS', 'AGE_GENDER']) if (t[k]) L.push({ text: `${t[k].label}: ${t[k].adSets} Ad Set — صرف ${t[k].spend} ج، ${t[k].purchases} مشتريات${t[k].cpa != null ? `، CPA ${t[k].cpa} ج` : ''} (${t[k].wins} رابح · ${t[k].losses} خاسر).`, confidence: t[k].confidence });
  if (t.BROAD?.cpa != null && t.INTERESTS?.cpa != null && t.BROAD.purchases >= RULES.minPurchases && t.INTERESTS.purchases >= RULES.minPurchases) { const better = t.INTERESTS.cpa <= t.BROAD.cpa * RULES.strategyMargin ? 'الاهتمامات' : t.BROAD.cpa <= t.INTERESTS.cpa * RULES.strategyMargin ? 'Broad' : null; L.push({ text: better ? `${better} أحسن في بيانات المنتج (CPA ${better === 'Broad' ? t.BROAD.cpa : t.INTERESTS.cpa} ج مقابل ${better === 'Broad' ? t.INTERESTS.cpa : t.BROAD.cpa} ج).` : `Broad والاهتمامات نتيجتهم قريبة (CPA ${t.BROAD.cpa} ج مقابل ${t.INTERESTS.cpa} ج) — مفيش فرق واضح.`, confidence: 'MEDIUM' }); }
  const wins = m.adSets.filter((s) => s.verdict === 'WIN'); const losses = m.adSets.filter((s) => s.verdict === 'LOSS'); const small = m.adSets.filter((s) => s.verdict === 'INCONCLUSIVE').length;
  if (wins.length) L.push({ text: `الـAd Sets الرابحة (${wins.length}): ${wins.slice(0, 3).map((s) => `«${s.name}» CPA ${s.cpa} ج بعد ${s.purchases} مشتريات`).join(' · ')}.`, confidence: wins.some((s) => s.confidence !== 'LOW') ? 'MEDIUM' : 'LOW' });
  if (losses.length) L.push({ text: `الخاسرة (${losses.length}): ${losses.slice(0, 3).map((s) => `«${s.name}» ${s.why}`).join(' · ')}`, confidence: 'MEDIUM' });
  if (small) L.push({ text: `${small} Ad Set لسه عينتهم صغيرة فمش بنحكم عليهم (محتاجين ${RULES.minPurchases} مشتريات على الأقل).`, confidence: 'LOW' });
  const tested = m.interests.filter((i) => i.attribution === 'SINGLE'); if (m.interests.length) L.push({ text: `اتجرّب ${m.interests.length} اهتمام (${tested.length} منهم في Ad Set لوحده يتحكم عليه، والباقي جوه مجموعات فنتيجتها للمجموعة مش للاهتمام).`, confidence: 'LOW' });
  if (m.smartTests.length) { const sw = m.smartTests.filter((s) => s.verdict === 'WIN').length, sl = m.smartTests.filter((s) => s.verdict === 'LOSS').length; L.push({ text: `توصيات Smart Targeting السابقة: ${m.smartTests.length} Ad Set (${sw} رابح · ${sl} خاسر · ${m.smartTests.length - sw - sl} لسه محتاج وقت/عينة).`, confidence: 'MEDIUM' }); }
  const bw = wins.map((s) => s.budget).filter((x) => x != null), bl = losses.map((s) => s.budget).filter((x) => x != null); const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  if (bw.length >= 2 && bl.length >= 2) L.push({ text: `الميزانية: الرابحة غالبًا حوالي ${r2(med(bw))} ج واليوم، والخاسرة حوالي ${r2(med(bl))} ج (ملاحظة مش دليل سببي).`, confidence: 'LOW' });
  return L;
}
export function buildSummary(m) {
  const w90 = m.windows.w90; const parts = [`المنتج ده اتعمله ${m.tests} حملة في آخر 90 يوم (صرف ${w90.spend} ج، ${w90.purchases} مشتريات${w90.cpa != null ? `، CPA ${w90.cpa} ج` : ''}).`];
  const wins = m.adSets.filter((s) => s.verdict === 'WIN'); const losses = m.adSets.filter((s) => s.verdict === 'LOSS');
  if (wins.length) parts.push(`أحسن أداء ظهر في «${wins.sort((a, b) => a.cpa - b.cpa)[0].name}» (CPA ${wins[0].cpa} ج).`);
  if (losses.length) parts.push(`${losses.length} Ad Set صرفت من غير نتيجة كفاية.`);
  if (!wins.length && !losses.length) parts.push('لسه مفيش Ad Set عينتها كفاية نحكم رابحة ولا خاسرة.');
  return parts.join(' ');
}

/**
 * The recommendation the memory supports. Strategy: compare Broad vs Interests only when BOTH have a real sample; otherwise run both (the missing one as the experiment).
 * @returns {{ strategy: {mode, reason, confidence}, adSetsPlan: object[], proven: object[], avoid: object[] }}
 */
export function recommendFromMemory(m) {
  if (!m?.hasHistory) return null;
  const t = m.audienceTypes; const b = t.BROAD, i = t.INTERESTS; const ev = (x) => x && x.purchases >= RULES.minPurchases && x.cpa != null;
  let mode = 'BOTH', reason, confidence = 'LOW';
  if (ev(b) && ev(i)) {
    if (i.cpa <= b.cpa * RULES.strategyMargin) { mode = 'INTERESTS'; reason = `الاهتمامات جابت CPA ${i.cpa} ج مقابل ${b.cpa} ج لـ Broad.`; confidence = 'MEDIUM'; }
    else if (b.cpa <= i.cpa * RULES.strategyMargin) { mode = 'BROAD'; reason = `Broad جاب CPA ${b.cpa} ج مقابل ${i.cpa} ج للاهتمامات.`; confidence = 'MEDIUM'; }
    else { mode = 'BOTH'; reason = `Broad والاهتمامات نتيجتهم قريبة (CPA ${b.cpa} ج مقابل ${i.cpa} ج) — جرّب الاتنين مع بعض.`; confidence = 'MEDIUM'; }
  } else if (ev(b) && !i) { mode = 'BOTH'; reason = `جرّبت Broad بس (CPA ${b.cpa} ج) ومجرّبتش اهتمامات — جرّب اهتمامات جنب Broad للمقارنة.`; }
  else if (ev(i) && !b) { mode = 'BOTH'; reason = `جرّبت اهتمامات بس (CPA ${i.cpa} ج) ومجرّبتش Broad — اعمل Ad Set واسع للمقارنة.`; }
  else reason = 'مفيش نوع جمهور عينته كفاية نفضّله على التاني — جرّب الاتنين وخلّي السيستم يتعلم.';
  const proven = m.adSets.filter((s) => s.type === 'INTERESTS' && s.verdict === 'WIN').sort((x, y) => x.cpa - y.cpa);
  const avoid = m.interests.filter((x) => x.attribution === 'SINGLE' && x.verdict === 'LOSS');
  const adSetsPlan = [];
  if (mode !== 'INTERESTS') adSetsPlan.push({ type: 'BROAD', label: 'Ad Set واسع (Broad) للمقارنة', note: mode === 'BROAD' ? 'الأنسب للمنتج حسب بياناتك.' : 'عشان تعرف لو الاهتمامات بتفرق فعلًا.' });
  if (mode !== 'BROAD') adSetsPlan.push({ type: 'INTERESTS', label: proven.length ? 'اهتمامات: الجمهور اللي نجح قبل كده + اهتمامات قريبة جديدة' : 'اهتمامات جديدة للتيست', note: proven.length ? `الجمهور الرابح: «${proven[0].name}» (CPA ${proven[0].cpa} ج، ${proven[0].purchases} مشتريات).` : 'مفيش جمهور اهتمامات رابح لسه — دي تجربة.' });
  return { strategy: { mode, reason, confidence }, adSetsPlan, proven, avoid };
}
