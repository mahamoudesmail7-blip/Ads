// AI Operator V2 — the campaign center QUERY (read-only). ONE source of campaign rows for every table of the new UI: filtering, search, sorting, pagination and the six «views» all run HERE, on the server;
// the browser only ever receives one page (never the whole campaign list). Same sources as the existing campaign board (synced Meta snapshots + saved settings) — it never calls Meta and never writes.
//   • periods: today · yesterday · last3/7/14/30/60/90 · custom (Cairo calendar days, inclusive, «today» = day 1) + the previous period of the SAME length for comparison
//   • numbers are honest: no purchases → CPA is null (never 0); no revenue → ROAS null; a campaign whose data is old is flagged (dataFresh=false), never shown as if it were fresh
//   • the views are filters over the SAME rows, driven by what the existing engines already decided (open decisions, today's plan items, the saved zero-spend limit) — nothing here invents a new rule
import { prisma } from '../../prisma.js';
import { getAmbSettings } from './settings.js';
import { getSyncStatus } from './snapshotSync.js';
import { entityWindowMetrics } from './metricsEngine.js';
import { listCampaignsFromSnapshots, buildCampaignProductIndex } from './operatorContext.js';
import { loadCampaignTags, listExceptions, exceptionsFor } from './operatorStore.js';
import { getBudgetPolicy } from './budgetOptimizer.js';
import { activePolicyFromLimits } from './productPolicy.js';
import { zonesFor } from './campaignBoard.js';
import { cairoDate, addDays } from './dailyPlanTime.js';
import { getZeroSpendPolicy, classifyWinner } from './zeroSpendCheck.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const bad = (message, code = 'BAD_REQUEST', status = 400) => { const e = new Error(message); e.status = status; e.code = code; return e; };
const round = (v, d = 0) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
const cpaOf = (spend, orders) => (Number(orders) > 0 ? Math.round(Number(spend) / Number(orders)) : null);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// periods
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const PERIOD_KEYS = ['today', 'yesterday', 'last3', 'last7', 'last14', 'last30', 'last60', 'last90', 'custom'];
export const PERIOD_LABEL = { today: 'اليوم', yesterday: 'أمس', last3: 'آخر 3 أيام', last7: 'آخر 7 أيام', last14: 'آخر 14 يوم', last30: 'آخر 30 يوم', last60: 'آخر 60 يوم', last90: 'آخر 90 يوم', custom: 'فترة مخصصة' };
const DAYS_OF = { last3: 3, last7: 7, last14: 14, last30: 30, last60: 60, last90: 90 };
const ISO = /^\d{4}-\d{2}-\d{2}$/; const diffDays = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);
/** → { key, label, from, to, days, prev:{from,to} }.  The default period is the last 7 days. */
export function resolvePeriod({ key = 'last7', from = null, to = null } = {}, today) {
  if (!PERIOD_KEYS.includes(key)) throw bad(`الفترة غير معروفة: ${key}`);
  let f, t;
  if (key === 'today') { f = t = today; } else if (key === 'yesterday') { f = t = addDays(today, -1); } else if (key === 'custom') {
    if (!ISO.test(String(from)) || !ISO.test(String(to))) throw bad('الفترة المخصصة محتاجة تاريخ من وإلى بصيغة YYYY-MM-DD.');
    if (from > to) throw bad('تاريخ البداية بعد تاريخ النهاية.'); if (to > today) throw bad('تاريخ النهاية في المستقبل.'); if (diffDays(from, to) > 365) throw bad('أقصى فترة مخصصة 366 يوم.'); f = from; t = to;
  } else { f = addDays(today, -(DAYS_OF[key] - 1)); t = today; }
  const days = diffDays(f, t) + 1;
  return { key, label: PERIOD_LABEL[key], from: f, to: t, days, prev: { from: addDays(f, -days), to: addDays(f, -1) } };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// fields (the ONLY fields a filter / sort / saved view may name — anything else is refused)
// ---------------------------------------------------------------------------------------------------------------------------------------------
const MULTI = 'multi', NUM = 'num', TEXT = 'text';
export const FIELDS = {
  account: { t: MULTI, label: 'الحساب الإعلاني', get: (r) => r.adAccountId }, store: { t: MULTI, label: 'المتجر', get: (r) => r.storeId }, product: { t: MULTI, label: 'المنتج', get: (r) => (r.productId == null ? null : String(r.productId)) },
  name: { t: TEXT, label: 'الاسم / ID', get: (r) => `${r.name || ''} ${r.campaignId}` }, status: { t: MULTI, label: 'حالة الحملة', get: (r) => r.status }, budgetLevel: { t: MULTI, label: 'نوع الميزانية', get: (r) => r.budgetLevel },
  budget: { t: NUM, label: 'الميزانية اليومية', get: (r) => r.budget }, spendToday: { t: NUM, label: 'صرف اليوم', get: (r) => r.today.spend }, ordersToday: { t: NUM, label: 'أوردرات اليوم', get: (r) => r.today.orders }, cpaToday: { t: NUM, label: 'CPA اليوم', get: (r) => r.today.cpa },
  spendPeriod: { t: NUM, label: 'صرف الفترة', get: (r) => r.period.spend }, ordersPeriod: { t: NUM, label: 'أوردرات الفترة', get: (r) => r.period.orders }, cpaPeriod: { t: NUM, label: 'CPA الفترة', get: (r) => r.period.cpa }, roas: { t: NUM, label: 'ROAS', get: (r) => r.period.roas },
  cpa3: { t: NUM, label: 'CPA آخر 3 أيام', get: (r) => r.cpa.d3 }, cpa7: { t: NUM, label: 'CPA آخر 7 أيام', get: (r) => r.cpa.d7 }, cpa14: { t: NUM, label: 'CPA آخر 14 يوم', get: (r) => r.cpa.d14 }, cpa30: { t: NUM, label: 'CPA آخر 30 يوم', get: (r) => r.cpa.d30 }, cpa60: { t: NUM, label: 'CPA آخر 60 يوم', get: (r) => r.cpa.d60 },
  dataAgeMin: { t: NUM, label: 'عمر آخر مزامنة (دقيقة)', get: (r) => r.dataAgeMin }, lastActiveDays: { t: NUM, label: 'أيام منذ آخر صرف فعلي', get: (r) => r.lastActiveDaysAgo }, lastPausedDays: { t: NUM, label: 'أيام منذ آخر إيقاف', get: (r) => r.lastPause?.daysAgo ?? null },
  lastBudgetChangeDays: { t: NUM, label: 'أيام منذ آخر تعديل ميزانية', get: (r) => r.lastBudgetChange?.daysAgo ?? null }, pauseReason: { t: TEXT, label: 'سبب آخر إيقاف', get: (r) => r.lastPause?.reason ?? null },
  winner: { t: MULTI, label: 'تصنيف Winner', get: (r) => r.winner.status }, approval: { t: MULTI, label: 'حالة الموافقة', get: (r) => r.approval.code }, eligibility: { t: MULTI, label: 'الأهلية (من خطة اليوم)', get: (r) => r.eligibility },
  linked: { t: MULTI, label: 'الربط بالمنتج', get: (r) => (r.linked ? 'LINKED' : 'UNLINKED') }, guard: { t: MULTI, label: 'محمية / مستثناة', get: (r) => (r.protectedC ? 'PROTECTED' : r.excluded ? 'EXCLUDED' : 'NORMAL') }, dataFresh: { t: MULTI, label: 'حداثة البيانات', get: (r) => (r.dataFresh ? 'FRESH' : 'STALE') },
};
export const SORT_KEYS = ['name', 'status', 'budget', 'spendToday', 'ordersToday', 'cpaToday', 'spendPeriod', 'ordersPeriod', 'cpaPeriod', 'roas', 'cpa3', 'cpa7', 'cpa14', 'cpa30', 'cpa60', 'dataAgeMin', 'lastActiveDays', 'lastPausedDays', 'lastBudgetChangeDays'];
const OPS = ['gte', 'lte', 'gt', 'lt', 'eq', 'between', 'in', 'contains'];
const VIEWS = ['all', 'open', 'pause', 'up', 'down', 'review'];
export const VIEW_LABEL = { all: 'كل الحملات', open: 'جاهزة للفتح', pause: 'مرشحة للإيقاف', up: 'فرص زيادة ميزانية', down: 'فرص تقليل ميزانية', review: 'تحتاج مراجعة' };

/** validates + normalises a filter list; refuses unknown fields / operators / absurd sizes (a saved view and a request go through the SAME check) */
export function sanitizeConds(conds) {
  if (conds == null) return []; if (!Array.isArray(conds) || conds.length > 25) throw bad('الفلاتر لازم تكون قائمة (حد أقصى 25 شرط).');
  return conds.map((c, i) => {
    const f = FIELDS[c?.f]; if (!f) throw bad(`حقل الفلتر ${i + 1} غير معروف: ${c?.f}`);
    if (f.t === MULTI) { const v = Array.isArray(c.v) ? c.v.map((x) => String(x).slice(0, 120)).slice(0, 100) : []; return { f: c.f, op: 'in', v }; }
    if (f.t === TEXT) return { f: c.f, op: 'contains', v: String(c.v ?? '').slice(0, 100) };
    const op = OPS.includes(c.op) && c.op !== 'in' && c.op !== 'contains' ? c.op : 'gte'; const arr = Array.isArray(c.v) ? c.v : [c.v];
    const nums = arr.slice(0, 2).map((x) => (x === '' || x == null ? null : Number(x))); if (nums.some((x) => x != null && !Number.isFinite(x))) throw bad(`قيمة الفلتر ${i + 1} لازم تكون رقم.`);
    return { f: c.f, op, v: nums };
  });
}
function condOk(row, c) {
  const f = FIELDS[c.f]; const val = f.get(row);
  if (f.t === MULTI) return !c.v.length || (val != null && c.v.includes(String(val)));
  if (f.t === TEXT) return !c.v || String(val ?? '').toLowerCase().includes(c.v.toLowerCase());
  if (val == null) return false; const [a, b] = c.v; // a missing number NEVER matches a numeric condition (it is not 0)
  switch (c.op) { case 'between': return (a == null || val >= a) && (b == null || val <= b); case 'gte': return a != null && val >= a; case 'lte': return a != null && val <= a; case 'gt': return a != null && val > a; case 'lt': return a != null && val < a; case 'eq': return a != null && val === a; default: return true; }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the rows
// ---------------------------------------------------------------------------------------------------------------------------------------------
const CACHE = new Map(); const CACHE_MS = 20_000;
export const __clearQueryCache = () => CACHE.clear();
const pct = (a, b) => (a == null || b == null || b === 0 ? null : Math.round(((a - b) / b) * 100));
const slim = (m) => { if (!m) return { spend: 0, orders: null, cpa: null, revenue: null, roas: null }; const spend = round(m.spend, 2) ?? 0; const orders = m.purchases == null ? null : Number(m.purchases); const revenue = m.revenue == null ? null : round(m.revenue, 2); return { spend, orders, cpa: cpaOf(spend, orders), revenue, roas: revenue != null && spend > 0 ? round(revenue / spend, 2) : null }; };
const hist = (m) => ({ orders: m ? Number(m.purchases ?? 0) : 0, spend: m ? round(m.spend, 2) ?? 0 : 0, cpa: m && Number(m.purchases) > 0 ? Math.round(Number(m.spend) / Number(m.purchases)) : null });

async function accountRows({ adAccountId, today, period, compare, now, ctx }) {
  const campaigns = (await listCampaignsFromSnapshots({ adAccountId, days: 90 })).filter((c) => ['ACTIVE', 'PAUSED'].includes(c.status));
  if (!campaigns.length) return [];
  const ids = campaigns.map((c) => c.id); const ranges = {};
  const addR = (k, from, to) => { ranges[k] = { from, to }; };
  addR('today', today, today); addR('period', period.from, period.to); if (compare) addR('prev', period.prev.from, period.prev.to);
  for (const [k, n] of [['d3', 3], ['d7', 7], ['d14', 14], ['d30', 30], ['d60', 60]]) addR(k, addDays(today, -(n - 1)), today);
  const mem = new Map(); const maps = {};
  for (const [k, r] of Object.entries(ranges)) { const key = `${r.from}|${r.to}`; if (!mem.has(key)) mem.set(key, await entityWindowMetrics({ level: 'campaign', from: r.from, to: r.to, adAccountId }, { force: !!ctx.force })); maps[k] = mem.get(key); }
  const prodIndex = await buildCampaignProductIndex({ adAccountId }); const tags = await loadCampaignTags(adAccountId); const exceptions = await listExceptions({ now });
  const ambIds = [...new Set([...prodIndex.values()].map((v) => v.ambProductId).filter(Boolean))];
  const ambs = ambIds.length ? await prisma.$queryRawUnsafe('select ap.id as amb_id, p.id as product_id, p.product_name, p.store_id from amb_products ap join products p on p.id = ap.product_id where ap.id = any($1::int[])', ambIds) : [];
  const ambBy = new Map(ambs.map((a) => [a.amb_id, a]));
  const adsetRows = await prisma.$queryRawUnsafe("select campaign_id, sum(adset_budget) filter (where adset_status = 'ACTIVE') as b, count(distinct adset_id)::int as n from (select distinct on (adset_id) campaign_id, adset_id, adset_budget, adset_status from meta_performance_snapshots where level = 'adset' and campaign_id = any($1::text[]) order by adset_id, snapshot_at desc) t group by campaign_id", ids);
  const adsetBy = new Map(adsetRows.map((r) => [r.campaign_id, { budget: Number(r.b || 0) || null, n: r.n }]));
  const lastActive = await prisma.$queryRawUnsafe("select campaign_id, max(date_start) as d from meta_performance_snapshots where level = 'campaign' and ad_account_id = $1 and spend > 0 and campaign_id = any($2::text[]) group by campaign_id", adAccountId, ids);
  const lastActiveBy = new Map(lastActive.map((r) => [r.campaign_id, r.d]));
  const actions = await prisma.$queryRawUnsafe("select distinct on (campaign_id, action_type) campaign_id, action_type, executed_at, ai_reason from amb_actions where campaign_id = any($1::text[]) and execution_status in ('EXECUTED','VERIFIED') and action_type in ('PAUSE','RESUME','INCREASE_BUDGET','DECREASE_BUDGET') order by campaign_id, action_type, executed_at desc nulls last", ids);
  const actBy = new Map(); for (const a of actions) { if (!actBy.has(a.campaign_id)) actBy.set(a.campaign_id, {}); actBy.get(a.campaign_id)[a.action_type] = a; }
  const decs = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { in: ids }, status: { in: ['SHADOW', 'PREPARED', 'APPROVED', 'BLOCKED', 'EXECUTING'] }, created_at: { gte: new Date(now.getTime() - 48 * 3_600_000) } }, orderBy: { id: 'desc' }, select: { id: true, campaign_id: true, action: true, status: true, rule_name: true } });
  const decBy = new Map(); for (const d of decs) if (!decBy.has(d.campaign_id)) decBy.set(d.campaign_id, d);
  const planItems = await prisma.ambDailyPlanItem.findMany({ where: { campaign_id: { in: ids }, plan: { plan_date: today, status: { in: ['PREPARED', 'APPROVED', 'RUNNING'] } } }, select: { campaign_id: true, eligibility: true, selected: true, status: true, plan: { select: { id: true, type: true, version: true } } } });
  const planBy = new Map(); for (const it of planItems) { const cur = planBy.get(it.campaign_id); if (!cur || it.plan.version > cur.plan.version) planBy.set(it.campaign_id, it); }
  const raw = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' }, select: { limits_json: true } }).catch(() => null); const rawLimits = j(raw?.limits_json, {}) || {};
  const intervalMs = (Number(ctx.settings.ambSyncIntervalMinutes) || 15) * 60_000; const freshMs = intervalMs * 4;
  const limitCache = ctx.limitCache; const zs = ctx.zeroSpend;
  const out = [];
  for (const c of campaigns) {
    const px = prodIndex.get(c.id); const amb = px ? ambBy.get(px.ambProductId) : null; const t = tags.get(c.id)?.tag || null;
    const excTypes = exceptionsFor({ exceptions, storeId: amb?.store_id ?? null, productId: amb?.product_id ?? null, campaignId: c.id, tag: t }).flatMap((e) => e.types || []);
    const cbo = Number(c.budget) > 0; const ab = adsetBy.get(c.id); const pol = amb ? activePolicyFromLimits(rawLimits, amb.store_id, amb.product_id) : null;
    const m = (k) => maps[k]?.get(c.id); const today_ = slim(m('today')); const period_ = slim(m('period')); const prev_ = compare ? slim(m('prev')) : null;
    const ageMin = Math.max(0, Math.round((now.getTime() - new Date(c.lastSeenAt).getTime()) / 60_000)); const dataFresh = ageMin * 60_000 <= freshMs;
    const linked = !!amb && !!px?.verified;
    // Winner is never judged on CPA alone: 7d AND 30d orders + the product's profit limit + fresh data (the SAME classifier the zero-spend policy uses; anything missing → UNKNOWN)
    let winner = { status: 'UNKNOWN', code: 'NOT_LINKED', reason: 'الحملة مش مربوطة بمنتج متأكد منه.' };
    if (linked) { const limit = (await ctx.profitLimit(amb.product_id)) ?? zs.winnerFallbackCpa ?? null; const w = classifyWinner({ h3: hist(m('d3')), h7: hist(m('d7')), h30: hist(m('d30')), limit, policy: zs, dataOk: dataFresh }); winner = { status: w.status, code: w.code, reason: w.reason }; }
    const dec = decBy.get(c.id) || null; const plan = planBy.get(c.id) || null; const acts = actBy.get(c.id) || {};
    const daysAgo = (d) => (d ? Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 86_400_000)) : null);
    const pauseA = acts.PAUSE || null; const incA = acts.INCREASE_BUDGET || null, decA = acts.DECREASE_BUDGET || null; const bud = incA && decA ? (new Date(incA.executed_at) > new Date(decA.executed_at) ? incA : decA) : incA || decA;
    const approval = dec ? ({ PREPARED: ['READY_FOR_REVIEW', 'جاهز للمراجعة'], APPROVED: ['APPROVED', 'معتمد'], BLOCKED: ['BLOCKED', 'ممنوع'], EXECUTING: ['APPROVED', 'قيد التنفيذ'], SHADOW: ['CANDIDATE', 'مرشح (محاكاة)'] }[dec.status] || ['CANDIDATE', 'مرشح']) : plan?.selected ? ['READY_FOR_REVIEW', 'مختارة في خطة اليوم'] : plan ? ['CANDIDATE', 'مرشحة في خطة اليوم'] : ['NONE', '—'];
    const la = lastActiveBy.get(c.id) || null;
    out.push({
      key: `${adAccountId}:${c.id}`, campaignId: c.id, name: (c.name || '').trim(), adAccountId, storeId: amb?.store_id ?? null, productId: amb?.product_id ?? null, productName: amb?.product_name ?? null, linked, mappingVerified: !!px?.verified,
      status: c.status, budget: cbo ? Number(c.budget) : ab?.budget ?? null, budgetLevel: cbo ? 'CBO' : ab?.budget ? 'ABO' : null, adsets: ab?.n ?? null,
      today: today_, period: period_, prev: prev_, compare: prev_ ? { spendPct: pct(period_.spend, prev_.spend), ordersPct: pct(period_.orders, prev_.orders), cpaPct: pct(period_.cpa, prev_.cpa) } : null,
      cpa: { d3: cpaOf(hist(m('d3')).spend, hist(m('d3')).orders), d7: cpaOf(hist(m('d7')).spend, hist(m('d7')).orders), d14: cpaOf(hist(m('d14')).spend, hist(m('d14')).orders), d30: cpaOf(hist(m('d30')).spend, hist(m('d30')).orders), d60: cpaOf(hist(m('d60')).spend, hist(m('d60')).orders) },
      zones: zonesFor(ctx.globalBudget, pol), winner, protectedC: excTypes.some((x) => ['NO_AUTOMATION', 'NO_AUTO_STOP'].includes(x)) || zs.protectedCampaignIds.includes(String(c.id)), excluded: excTypes.length > 0 || zs.excludeCampaignIds.includes(String(c.id)), exceptions: excTypes, tag: t,
      pendingDecision: dec ? { id: dec.id, action: dec.action, status: dec.status, rule: dec.rule_name } : null, planItem: plan ? { planId: plan.plan.id, type: plan.plan.type, eligibility: plan.eligibility, selected: plan.selected, status: plan.status } : null,
      approval: { code: approval[0], label: approval[1] }, eligibility: plan?.eligibility || 'NOT_EVALUATED',
      lastSeenAt: c.lastSeenAt, dataAgeMin: ageMin, dataFresh, lastActiveDate: la, lastActiveDaysAgo: la ? Math.max(0, diffDays(la, today)) : null,
      lastPause: pauseA ? { at: pauseA.executed_at, daysAgo: daysAgo(pauseA.executed_at), reason: pauseA.ai_reason || null } : null, lastBudgetChange: bud ? { at: bud.executed_at, action: bud.action_type, daysAgo: daysAgo(bud.executed_at), reason: bud.ai_reason || null } : null,
    });
  }
  return out;
}

/** the six views — filters over the SAME rows, built from what the existing engines already produced */
export function viewOf(row, zeroLimit, zeroCmp = 'GT') {
  const zeroToday = row.status === 'ACTIVE' && row.today.orders === 0 && row.today.spend != null && (zeroCmp === 'GTE' ? row.today.spend >= zeroLimit : row.today.spend > zeroLimit); const d = row.pendingDecision;
  const v = new Set(['all']);
  if (row.status === 'PAUSED' && ((row.period.orders ?? 0) > 0 || row.planItem?.type === 'OPEN' || d?.action === 'OPEN')) v.add('open');
  if (row.status === 'ACTIVE' && (zeroToday || d?.action === 'PAUSE' || row.planItem?.type === 'PAUSE')) v.add('pause');
  if (d?.action === 'SCALE_UP') v.add('up'); if (d?.action === 'SCALE_DOWN') v.add('down');
  if (!row.dataFresh || !row.linked || d?.status === 'BLOCKED' || (v.size > 1 && (row.protectedC || row.excluded))) v.add('review');
  return v;
}

async function loadContext({ now }) {
  const settings = await getAmbSettings(); const zeroSpend = await getZeroSpendPolicy(); const globalBudget = await getBudgetPolicy().catch(() => null); const limitCache = new Map();
  const profitLimit = async (productId) => { if (limitCache.has(productId)) return limitCache.get(productId); let v = null; try { const RD = await import('./operatorReadiness.js'); const p = await RD.getProductProfile({ productId }).catch(() => null); v = p ? (p.economics.maxCpa.value ?? p.economics.targetCpa.value ?? null) : null; } catch { v = null; } limitCache.set(productId, v); return v; };
  return { settings, zeroSpend, globalBudget, limitCache, profitLimit };
}

/** every row the user may see, for the period (cached ~20 s per account-set + period) */
export async function buildRows({ accounts, period, compare = false, now = new Date(), noCache = false }) {
  const today = cairoDate(now); const key = JSON.stringify([[...accounts].sort(), period.from, period.to, !!compare]);
  const hit = CACHE.get(key); if (!noCache && hit && now.getTime() - hit.at < CACHE_MS) return hit.value;
  const ctx = await loadContext({ now }); ctx.force = !!noCache; const rows = []; // noCache = a fresh read of the metrics too (selection snapshots, review previews and exports must see the CURRENT numbers)
  for (const a of accounts) rows.push(...await accountRows({ adAccountId: a, today, period, compare, now, ctx }));
  const sync = await getSyncStatus().catch(() => null);
  const value = { rows, today, sync: sync ? { lastSuccessAt: sync.lastSuccessAt || null, intervalMinutes: sync.intervalMinutes || null } : null, zero: { limit: ctx.zeroSpend.limit, comparison: ctx.zeroSpend.comparison, version: ctx.zeroSpend.version, approved: !!ctx.zeroSpend.approved }, builtAt: now.toISOString() };
  CACHE.set(key, { at: now.getTime(), value }); return value;
}

/** validates the request body into a normalised query */
export function normalizeQuery(body = {}, access, today) {
  const b = body || {}; const period = resolvePeriod({ key: b.period?.key ?? b.period ?? 'last7', from: b.period?.from ?? b.from ?? null, to: b.period?.to ?? b.to ?? null }, today);
  const view = b.view == null ? 'all' : String(b.view); if (!VIEWS.includes(view)) throw bad(`العرض غير معروف: ${view}`);
  const logic = b.logic === 'OR' ? 'OR' : 'AND'; const conds = sanitizeConds(b.conds); const search = String(b.search ?? '').trim().slice(0, 100);
  const sortKey = b.sort?.k ?? 'spendPeriod'; if (!SORT_KEYS.includes(sortKey)) throw bad(`الترتيب غير مدعوم: ${sortKey}`); const dir = Number(b.sort?.d) === 1 ? 1 : -1;
  const pageSize = Math.min(200, Math.max(5, Math.floor(Number(b.pageSize) || 25))); const page = Math.max(1, Math.floor(Number(b.page) || 1));
  let accounts = access.accounts;
  if (b.accounts != null) { if (!Array.isArray(b.accounts)) throw bad('accounts لازم تكون قائمة.'); const want = b.accounts.map(String); const denied = want.filter((a) => !access.accounts.includes(a)); if (denied.length) throw bad('حساب إعلاني خارج نطاق صلاحيتك.', 'ACCOUNT_FORBIDDEN', 403); accounts = want.length ? want : access.accounts; }
  return { period, compare: b.compare === true, view, logic, conds, search, sort: { k: sortKey, d: dir }, page, pageSize, accounts };
}

function filterRows(rows, q, zero, { withView = true } = {}) {
  const s = q.search.toLowerCase();
  return rows.filter((r) => (!withView || viewOf(r, zero.limit, zero.comparison).has(q.view)) && (!s || `${r.name} ${r.campaignId}`.toLowerCase().includes(s)) && (!q.conds.length || (q.logic === 'AND' ? q.conds.every((c) => condOk(r, c)) : q.conds.some((c) => condOk(r, c)))));
}
function sortRows(rows, { k, d }) {
  const get = k === 'name' ? (r) => r.name.toLowerCase() : k === 'status' ? (r) => r.status : (r) => FIELDS[k]?.get(r) ?? null;
  return [...rows].sort((a, b) => { const x = get(a), y = get(b); if (x == null && y == null) return a.campaignId < b.campaignId ? -1 : 1; if (x == null) return 1; if (y == null) return -1; const c = x > y ? 1 : x < y ? -1 : 0; return c ? c * d : (a.campaignId < b.campaignId ? -1 : 1); });
}

/** the page the screen asks for. NEVER returns more than `pageSize` rows. */
export async function queryCampaigns({ access, body, now = new Date(), noCache = false }) {
  const today = cairoDate(now); const q = normalizeQuery(body, access, today);
  const built = await buildRows({ accounts: q.accounts, period: q.period, compare: q.compare, now, noCache });
  const matched = sortRows(filterRows(built.rows, q, built.zero), q.sort); const total = matched.length; const pages = Math.max(1, Math.ceil(total / q.pageSize)); const page = Math.min(q.page, pages);
  const withoutView = filterRows(built.rows, q, built.zero, { withView: false });
  const inView = (v) => withoutView.filter((r) => viewOf(r, built.zero.limit, built.zero.comparison).has(v)); const viewCounts = Object.fromEntries(VIEWS.map((v) => [v, inView(v).length]));
  const viewExposure = Object.fromEntries(VIEWS.map((v) => [v, Math.round(inView(v).reduce((t, r) => t + (r.budget || 0), 0))]));
  const known = matched.filter((r) => r.period.orders != null); const spendAll = matched.reduce((t, r) => t + (r.period.spend || 0), 0); const ordersAll = known.length ? known.reduce((t, r) => t + r.period.orders, 0) : null; const revKnown = matched.filter((r) => r.period.revenue != null); const revenue = revKnown.length ? revKnown.reduce((t, r) => t + r.period.revenue, 0) : null; const spendRev = revKnown.reduce((t, r) => t + r.period.spend, 0);
  const summary = { campaigns: total, active: matched.filter((r) => r.status === 'ACTIVE').length, paused: matched.filter((r) => r.status === 'PAUSED').length, spend: Math.round(spendAll), orders: ordersAll, cpa: cpaOf(spendAll, ordersAll), revenue: revenue == null ? null : Math.round(revenue), roas: revenue != null && spendRev > 0 ? round(revenue / spendRev, 2) : null };
  const uniq = (fn) => [...new Map(built.rows.map((r) => [fn(r)?.id, fn(r)]).filter(([k]) => k != null)).values()];
  const stale = built.rows.filter((r) => !r.dataFresh).length; const lastSeen = built.rows.length ? built.rows.reduce((t, r) => (new Date(r.lastSeenAt) < t ? new Date(r.lastSeenAt) : t), new Date(built.rows[0].lastSeenAt)) : null;
  return {
    period: { key: q.period.key, label: q.period.label, from: q.period.from, to: q.period.to, days: q.period.days, prev: q.compare ? q.period.prev : null }, compare: q.compare, view: q.view, logic: q.logic, conds: q.conds, search: q.search, sort: q.sort,
    page, pageSize: q.pageSize, pages, total, rows: matched.slice((page - 1) * q.pageSize, page * q.pageSize), viewCounts, viewExposure, summary,
    facets: { accounts: q.accounts, stores: uniq((r) => (r.storeId ? { id: r.storeId, name: r.storeId } : null)), products: uniq((r) => (r.productId != null ? { id: String(r.productId), name: r.productName } : null)) },
    freshness: { generatedAt: built.builtAt, lastSyncAt: built.sync?.lastSuccessAt || null, oldestCampaignSeenAt: lastSeen, staleCampaigns: stale },
    attribution: { orders: 'META_PURCHASES', note: 'الأوردرات = مشتريات Meta (إسناد الإعلانات). الإيراد وROAS من Meta ومش بيانات ربح فعلي.' }, zeroSpendLimit: built.zero,
  };
}

/** ALL matching rows (ids + fingerprints) for a selection snapshot — still produced server-side, never sent to the browser as rows */
export async function matchingRows({ access, body, now = new Date(), noCache = false }) {
  const today = cairoDate(now); const q = normalizeQuery(body, access, today); const built = await buildRows({ accounts: q.accounts, period: q.period, compare: q.compare, now, noCache });
  return { q, built, rows: sortRows(filterRows(built.rows, q, built.zero), q.sort) };
}
export const fingerprint = (r) => `${r.status}|${r.budget ?? ''}|${r.today.spend}|${r.today.orders ?? ''}|${r.period.spend}|${r.period.orders ?? ''}|${r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : ''}|${r.pendingDecision?.id ?? ''}`;
