// «نظرة سريعة» → "كسبان ولا خسران؟": ONE product over ONE period (last 3 / 7 / 30 days / everything we have) across EVERY ad account it runs in:
// spend, orders (Meta purchases), cost per order, a day-by-day series, a per-account split, and — when the product's economics are known — an estimated profit / loss.
// READ ONLY. Spend / orders come from our synced campaign snapshots (verified against Meta Ads Manager to the cent). Which campaigns belong to the product: the system's own links
// (launch wizard + owner/clone mapping) PLUS the unlinked campaigns of the same name family in every account — the rules, and the owner's tick / untick, live in productCampaignSet.js.
// A campaign family with no linked product can be picked on its own. Display only: nothing is persisted, nothing feeds a decision.
//
// PROFIT (honest about its assumptions — never a number invented from missing inputs):
//   contribution per Meta purchase  = deliveredShare × (sellingPrice − productCost − packaging − shipping − other)  −  returnedShare × rtoCost
//   estimated profit                = purchases × contribution − spend
//   deliveredShare = confirmation × delivery when BOTH rates are set on the product; otherwise 100 % (flagged ASSUMED_100,
//   the UI lets the owner change it). Without a selling price AND a cost > 0 the verdict is UNKNOWN (an unset cost is 0 in the data model — treating that as "free" would invent a profit).
import { prisma } from '../../prisma.js';
import { resolveWindow, todayISO, addDaysISO } from './metricsEngine.js';
import { selectCampaigns, groupFamilies, familyOwnership, familyOf, sameProductKey, OWN_SHARE_MIN } from './productCampaignSet.js';
import { effectiveSellingPrice, baseOperationalCost } from './productEconomics.js';
import { getAmbSettings } from './settings.js';
import { listViewAccounts } from './viewAccounts.js';
import { getDecryptedToken } from '../metaAuth.js';
import { getCampaignDailyInsights, getCampaignFirstSpendDate, getCampaignsWithDelivery } from '../metaGraphClient.js';
import { cachedMetaFetch } from '../metaAssetCache.js';

// HISTORY: our own snapshots only start when each account was first synced (Ahmed Samy 18 Oct, the others later). For the days BEFORE that, the product's campaigns are read straight from Meta
// (read only, filtered to the product's campaigns, cached 30 min, hard timeouts; for «all», campaigns that only ran back then are first found by one aggregated read per account) and merged in — nothing is written to our tables, so no decision input of the Operator changes.
const HISTORY_FLOOR = '2025-01-01';
const HISTORY_TTL_MS = 30 * 60_000;
async function defaultFetchHistory({ adAccountId, campaignIds, from, to }) {
  const token = await getDecryptedToken();
  const ids = campaignIds.slice().sort();
  let start = from;
  if (from === HISTORY_FLOOR) { // "everything": find where the spend really starts instead of reading 20 months of nothing
    const first = await cachedMetaFetch(`prodFirst:${adAccountId}:${from}:${to}:${ids.join(',')}`, () => getCampaignFirstSpendDate(token, adAccountId, ids, from, to), { ttlMs: HISTORY_TTL_MS });
    if (!first) return [];
    start = first < from ? from : first;
  }
  if (start > to) return [];
  return cachedMetaFetch(`prodHistory:${adAccountId}:${start}:${to}:${ids.join(',')}`, () => getCampaignDailyInsights(token, adAccountId, ids, start, to), { ttlMs: HISTORY_TTL_MS });
}

const DISCOVER_TTL_MS = 6 * 3600_000;
const SERIES_MAX_DAYS = 400;
async function defaultDiscover({ adAccountId, from, to }) {
  const token = await getDecryptedToken();
  return cachedMetaFetch(`prodDiscover:${adAccountId}:${from}:${to}`, () => getCampaignsWithDelivery(token, adAccountId, from, to), { ttlMs: DISCOVER_TTL_MS });
}

/**
 * Every campaign we know across every account: id -> { id, accountId, name } (latest name), cached for a few minutes.
 * The snapshot table holds millions of rows, so this HOPS the (ad_account_id, level, campaign_id, date_start, snapshot_at) index — one probe per account and per campaign —
 * instead of reading and sorting every row (which took ~20 s).
 */
async function loadDirectory({ force = false } = {}) {
  const rows = await cachedMetaFetch('prodDirectory', () => prisma.$queryRaw`
    WITH RECURSIVE accts AS (
      SELECT min(ad_account_id) AS acct FROM "meta_performance_snapshots"
      UNION ALL
      SELECT (SELECT min(s.ad_account_id) FROM "meta_performance_snapshots" s WHERE s.ad_account_id > a.acct) FROM accts a WHERE a.acct IS NOT NULL
    ), camps AS (
      SELECT a.acct, (SELECT s.campaign_id FROM "meta_performance_snapshots" s WHERE s.ad_account_id = a.acct AND s.level = 'campaign' AND s.campaign_id IS NOT NULL ORDER BY s.campaign_id LIMIT 1) AS cid
      FROM accts a WHERE a.acct IS NOT NULL
      UNION ALL
      SELECT c.acct, (SELECT s.campaign_id FROM "meta_performance_snapshots" s WHERE s.ad_account_id = c.acct AND s.level = 'campaign' AND s.campaign_id > c.cid ORDER BY s.campaign_id LIMIT 1)
      FROM camps c WHERE c.cid IS NOT NULL
    )
    SELECT c.cid AS campaign_id, c.acct AS ad_account_id, l.campaign_name
    FROM camps c CROSS JOIN LATERAL (
      SELECT s.campaign_name FROM "meta_performance_snapshots" s
      WHERE s.ad_account_id = c.acct AND s.level = 'campaign' AND s.campaign_id = c.cid
      ORDER BY s.date_start DESC, s.snapshot_at DESC LIMIT 1
    ) l
    WHERE c.cid IS NOT NULL
  `, { ttlMs: 10 * 60_000, force });
  return new Map(rows.map((r) => [r.campaign_id, { id: r.campaign_id, accountId: r.ad_account_id, name: r.campaign_name || r.campaign_id }]));
}

/** The latest synced row of each picked campaign and day — one indexed read for all accounts (never every campaign of every account). */
function loadCampaignDays(ids, from, to) {
  if (!ids.length) return Promise.resolve([]);
  return prisma.$queryRaw`
    SELECT DISTINCT ON (campaign_id, date_start) campaign_id, date_start, spend, meta_purchases
    FROM "meta_performance_snapshots"
    WHERE level = 'campaign' AND campaign_id = ANY(${ids}) AND date_start >= ${from} AND date_start <= ${to}
    ORDER BY campaign_id, date_start, snapshot_at DESC
  `;
}

/** The system's own campaign → product links (the launch wizard wins over the owner / clone mapping). Linked campaigns that have no snapshot yet are added to the directory. */
async function loadLinks(directory) {
  const [mapped, launched] = await Promise.all([
    prisma.ambProductCampaignMap.findMany({ where: { status: 'MAPPED' }, select: { campaign_id: true, campaign_name: true, ad_account_id: true, amb_product: { select: { product_id: true, product_name: true, product: { select: { product_name: true } } } } } }),
    prisma.ambLaunchCampaign.findMany({ where: { meta_campaign_id: { not: null }, job: { product_id: { not: null } } }, select: { meta_campaign_id: true, name: true, job: { select: { product_id: true, ad_account_id: true, product: { select: { product_name: true } } } } } }),
  ]);
  const links = new Map();
  const add = (campaignId, accountId, campaignName, productId, productName) => {
    links.set(campaignId, { productKey: sameProductKey(productName), productName: String(productName).trim(), productId });
    if (!directory.has(campaignId)) directory.set(campaignId, { id: campaignId, accountId, name: campaignName || campaignId });
  };
  for (const m of mapped) { const p = m.amb_product; if (p.product_id) add(m.campaign_id, m.ad_account_id, m.campaign_name, p.product_id, p.product?.product_name || p.product_name); }
  for (const l of launched) add(l.meta_campaign_id, l.job.ad_account_id, l.name, l.job.product_id, l.job.product?.product_name || `منتج ${l.job.product_id}`);
  return links;
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export const PROFIT_PERIODS = ['last3', 'last7', 'last30', 'all'];
const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Products the selector offers: every catalog product that has at least one campaign linked to it (launch wizard or MAPPED), one row per product NAME, name-sorted. */
export async function listProfitProducts() {
  const [mapped, launched] = await Promise.all([
    prisma.ambProduct.findMany({ where: { active: true, product_id: { not: null }, campaign_maps: { some: { status: 'MAPPED' } } }, select: { product_id: true, product_name: true, product: { select: { product_name: true } }, _count: { select: { campaign_maps: true } } } }),
    prisma.ambLaunchJob.findMany({ where: { product_id: { not: null } }, distinct: ['product_id'], select: { product_id: true, product: { select: { product_name: true } } } }),
  ]);
  const byId = new Map();
  for (const m of mapped) byId.set(m.product_id, { productId: m.product_id, name: m.product?.product_name || m.product_name, campaigns: m._count.campaign_maps, via: ['MAPPING'] });
  for (const l of launched) {
    const cur = byId.get(l.product_id);
    if (cur) cur.via.push('LAUNCH');
    else byId.set(l.product_id, { productId: l.product_id, name: l.product?.product_name || `منتج ${l.product_id}`, campaigns: null, via: ['LAUNCH'] });
  }
  const byName = new Map(); // two catalog rows with one name are one entry: the row with the most linked campaigns represents it
  for (const p of [...byId.values()].sort((a, b) => (b.campaigns || 0) - (a.campaigns || 0) || a.productId - b.productId)) {
    const k = sameProductKey(p.name);
    if (!byName.has(k)) byName.set(k, { ...p, ids: [p.productId] }); else byName.get(k).ids.push(p.productId);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

/** Campaign name families that no listed product already covers, so the owner can find ANY product he advertises (most campaigns first). */
export async function listProfitFamilies({ deps = {} } = {}) {
  const directory = await loadDirectory({ force: !!deps.freshDirectory });
  const links = await loadLinks(directory);
  const out = [];
  for (const f of groupFamilies([...directory.values()]).values()) {
    const owners = new Set(f.campaigns.map((c) => links.get(c.id)?.productKey).filter(Boolean));
    if ([...owners].some((k) => familyOwnership(f, links, k).share >= OWN_SHARE_MIN)) continue; // reached by picking that product
    out.push({ key: f.key, name: f.label, campaigns: f.campaigns.length, accounts: f.accounts.size });
  }
  return out.sort((a, b) => b.campaigns - a.campaigns || a.name.localeCompare(b.name, 'ar'));
}

function windowFor(period, firstDate) {
  const today = todayISO();
  if (period === 'all') return { from: firstDate || today, to: today };
  const w = resolveWindow(period);
  return { from: w.from, to: w.to };
}

/** Economics → the numbers the verdict needs, or { available:false, reason }. Pure (the AmbProduct row and the Easy Orders rates are passed in). */
export function buildEconomics(amb) {
  if (!amb) return { available: false, reason: 'المنتج ده مالوش بيانات اقتصادية (سعر وتكلفة) في السيستم.' };
  const sellingPrice = effectiveSellingPrice(amb);
  const unitCost = baseOperationalCost(amb);
  if (sellingPrice === null || !(sellingPrice > 0)) return { available: false, reason: 'سعر بيع المنتج مش متسجّل.' };
  if (unitCost === null || !(num(amb.product_cost) > 0)) return { available: false, reason: 'تكلفة المنتج مش متسجّلة (ظاهرة صفر).' };

  const c = num(amb.confirmation_rate), d = num(amb.delivery_rate);
  let rates = null, source = 'ASSUMED_100';
  if (c !== null && d !== null) { rates = { c, d }; source = 'PRODUCT_RATES' ; }
  const deliveredShare = rates ? rates.c * rates.d : 1;
  const returnedShare = rates ? rates.c * (1 - rates.d) : 0;
  const rto = num(amb.rto_cost) ?? 0;
  const grossPerDelivered = sellingPrice - unitCost;
  const contribution = deliveredShare * grossPerDelivered - returnedShare * rto;
  return { available: true, sellingPrice: r2(sellingPrice), unitCost: r2(unitCost), grossPerDelivered: r2(grossPerDelivered), rtoCost: r2(rto), deliveredShare: r2(deliveredShare), deliveredShareSource: source, contributionPerOrder: r2(contribution), breakEvenCpa: r2(contribution) };
}

/** Verdict from the estimated profit: a +/- 2 % of spend (min 50 EGP) band is "break-even". Pure. */
export function verdictFor({ estimatedProfit, spend }) {
  if (!(spend > 0) && estimatedProfit === 0) return 'NO_DATA'; // nothing ran in the period: not a break-even, just no activity
  if (estimatedProfit === null) return 'UNKNOWN';
  const band = Math.max(50, 0.02 * (spend || 0));
  if (estimatedProfit > band) return 'WIN';
  if (estimatedProfit < -band) return 'LOSS';
  return 'BREAKEVEN';
}

/**
 * @param {{ productId?: number, family?: string, period?: 'last3'|'last7'|'last30'|'all', include?: string[], exclude?: string[] }} p
 *   productId = a product was picked; family = a campaign name family was picked; include / exclude = the families the owner ticked / unticked.
 */
export async function getProductProfit({ productId, family = null, period = 'last7', include = [], exclude = [], deps = {} }) {
  const fetchHistory = deps.fetchHistory || defaultFetchHistory;
  const discover = deps.discover || (deps.fetchHistory ? async () => [] : defaultDiscover);
  const familyKey = family ? familyOf(family).key || String(family) : null;
  const pid = familyKey ? null : Number(productId);
  if (!familyKey && (!Number.isInteger(pid) || pid <= 0)) { const e = new Error('لازم تختار منتج.'); e.status = 400; throw e; }
  if (!PROFIT_PERIODS.includes(period)) { const e = new Error('الفترة لازم تكون آخر 3 أيام / 7 / 30 / كل الفترة.'); e.status = 400; throw e; }
  const product = familyKey ? null : await prisma.product.findUnique({ where: { id: pid }, select: { id: true, product_name: true } });
  if (!familyKey && !product) { const e = new Error('المنتج غير موجود.'); e.status = 404; throw e; }
  const ownKey = product ? sameProductKey(product.product_name) : null;

  const force = !!deps.freshDirectory;
  const [directory, viewAccounts, firstRows] = await Promise.all([
    loadDirectory({ force }),
    cachedMetaFetch('prodAccounts', listViewAccounts, { ttlMs: 5 * 60_000, force }),
    cachedMetaFetch('prodFirstByAccount', () => prisma.metaPerformanceSnapshot.groupBy({ by: ['ad_account_id'], where: { level: 'campaign' }, _min: { date_start: true } }), { ttlMs: 10 * 60_000, force }),
  ]);
  const links = await loadLinks(directory);
  const names = new Map(viewAccounts.accounts.map((a) => [a.id, (a.name || a.id).trim()]));
  const firstByAccount = new Map(firstRows.map((g) => [g.ad_account_id, g._min.date_start]));
  const historyIncomplete = new Set();

  // "all": campaigns that only ran BEFORE an account's first snapshot are not in the directory — find them first so their names can be matched
  if (period === 'all') {
    await inBatches([...new Set([...names.keys(), ...firstByAccount.keys()])], 4, async (adAccountId) => {
      const first = firstByAccount.get(adAccountId);
      const to = first ? addDaysISO(first, -1) : todayISO();
      if (to < HISTORY_FLOOR) return;
      try {
        for (const c of await discover({ adAccountId, from: HISTORY_FLOOR, to })) {
          if (!directory.has(c.campaign_id)) directory.set(c.campaign_id, { id: c.campaign_id, accountId: adAccountId, name: c.campaign_name || c.campaign_id });
        }
      } catch { historyIncomplete.add(names.get(adAccountId) || adAccountId); }
    });
  }

  const sel = selectCampaigns({ directory: [...directory.values()], links, ownKey, familyKey, include, exclude });
  if (familyKey && !sel.families.some((f) => f.key === familyKey)) { const e = new Error('مفيش حملات بالاسم ده.'); e.status = 404; throw e; }
  const ids = new Set(sel.campaigns.map((c) => c.id));
  const byAccount = new Map();
  for (const c of sel.campaigns) { if (!byAccount.has(c.accountId)) byAccount.set(c.accountId, new Set()); byAccount.get(c.accountId).add(c.id); }
  const perCampaign = new Map(sel.campaigns.map((c) => [c.id, { id: c.id, name: c.name, accountId: c.accountId, account: names.get(c.accountId) || c.accountId, via: c.via, spend: 0, orders: 0 }]));

  let firstDate = null;
  if (ids.size) {
    const agg = await prisma.metaPerformanceSnapshot.aggregate({ _min: { date_start: true }, where: { level: 'campaign', campaign_id: { in: [...ids] } } });
    firstDate = agg._min.date_start || null; // the earliest day we hold data for this product (snapshots only exist since each account's first sync)
  }
  const win = windowFor(period, firstDate);

  const daily = new Map(); // date -> { spend, orders }
  const accounts = [];
  let spend = 0, orders = 0, historyDays = 0, earliest = null;
  const note = (d) => { if (!earliest || d < earliest) earliest = d; };
  const synced = new Map(); // campaign_id -> its synced day rows in the window
  for (const r of await loadCampaignDays([...ids], win.from, win.to)) { if (!synced.has(r.campaign_id)) synced.set(r.campaign_id, []); synced.get(r.campaign_id).push(r); }
  await inBatches([...byAccount.entries()], 4, async ([adAccountId, set]) => {
    let aSpend = 0, aOrders = 0; const aCamps = new Set();
    const count = (campaignId, date, s, o) => {
      aSpend += s; aOrders += o; if (s > 0 || o > 0) aCamps.add(campaignId);
      const c = perCampaign.get(campaignId); if (c) { c.spend += s; c.orders += o; }
      const d = daily.get(date) || { spend: 0, orders: 0 }; d.spend += s; d.orders += o; daily.set(date, d); note(date);
    };
    for (const id of set) for (const r of synced.get(id) || []) count(id, r.date_start, Number(r.spend) || 0, Number(r.meta_purchases) || 0);
    // the days before this account's first snapshot: straight from Meta
    const acctFirst = firstByAccount.get(adAccountId);
    const histTo = acctFirst ? addDaysISO(acctFirst, -1) : win.to;
    const histFrom = period === 'all' ? HISTORY_FLOOR : win.from;
    const histEnd = histTo < win.to ? histTo : win.to;
    if (histFrom <= histEnd) {
      try {
        const hist = await fetchHistory({ adAccountId, campaignIds: [...set], from: histFrom, to: histEnd });
        for (const h of hist) {
          if (!set.has(h.campaign_id) || h.date_start < histFrom || h.date_start > histEnd) continue;
          count(h.campaign_id, h.date_start, Number(h.spend) || 0, Number(h.purchases) || 0); historyDays += 1;
        }
      } catch { historyIncomplete.add(names.get(adAccountId) || adAccountId); }
    }
    spend += aSpend; orders += aOrders;
    if (aSpend > 0 || aOrders > 0) accounts.push({ id: adAccountId, name: names.get(adAccountId) || adAccountId, spend: r2(aSpend), orders: aOrders, cpa: aOrders > 0 ? r2(aSpend / aOrders) : null, campaigns: aCamps.size });
  });
  accounts.sort((a, b) => b.orders - a.orders || b.spend - a.spend);
  const campaignList = [...perCampaign.values()].filter((c) => c.spend > 0 || c.orders > 0).sort((a, b) => b.orders - a.orders || b.spend - a.spend)
    .map((c) => ({ ...c, spend: r2(c.spend), cpa: c.orders > 0 ? r2(c.spend / c.orders) : null }));

  // "all" = everything we now hold (history included): the window starts at the earliest day that has data
  if (period === 'all' && earliest && earliest < win.from) win.from = earliest;
  // a day-by-day series with no holes (a day without data is a real zero only AFTER the first day we have data)
  const series = [];
  const oldest = addDaysISO(win.to, -(SERIES_MAX_DAYS - 1)); // a very long «all»: the totals cover everything, the chart keeps the most recent days
  for (let d = win.from > oldest ? win.from : oldest; d <= win.to; d = addDaysISO(d, 1)) {
    const v = daily.get(d) || { spend: 0, orders: 0 };
    series.push({ date: d, spend: r2(v.spend), orders: v.orders, cpa: v.orders > 0 ? r2(v.spend / v.orders) : null, hasData: !!daily.get(d) });
  }
  const windowDays = Math.round((Date.parse(`${win.to}T00:00:00Z`) - Date.parse(`${win.from}T00:00:00Z`)) / 86_400_000) + 1;

  // economics: the picked product's row, else a same-named catalog row that has them; a picked name family has none
  const ECON = { product_id: true, product_cost: true, pricing_multiplier: true, suggested_selling_price: true, actual_selling_price: true, packaging_cost: true, shipping_cost: true, other_cost: true, rto_cost: true, confirmation_rate: true, delivery_rate: true };
  const sameIds = ownKey ? [...new Set([pid, ...[...links.values()].filter((l) => l.productKey === ownKey).map((l) => l.productId)])] : [];
  const [ambRows, settings] = await Promise.all([
    sameIds.length ? prisma.ambProduct.findMany({ where: { product_id: { in: sameIds } }, select: ECON }) : [],
    getAmbSettings(),
  ]);
  ambRows.sort((a, b) => (a.product_id === pid ? -1 : b.product_id === pid ? 1 : a.product_id - b.product_id));
  const usable = ambRows.find((r) => buildEconomics(r).available) || ambRows[0] || null;
  const economics = familyKey ? { available: false, reason: 'ده اسم حملات مش منتج مسجّل — اكتب السعر والتكلفة' } : buildEconomics(usable);
  const estimatedProfit = economics.available ? r2(orders * economics.contributionPerOrder - spend) : null;
  const cpa = orders > 0 ? r2(spend / orders) : null;
  const ceiling = Number(settings.ambTopProductsMaxCpa) || 150;

  return {
    productId: pid, family: familyKey, name: product ? product.product_name : sel.families.find((f) => f.key === familyKey).label, period, window: { ...win, days: windowDays },
    dataStart: earliest || firstDate,
    linkedCampaigns: sel.campaigns.filter((c) => c.via === 'LINK').length, namedCampaigns: sel.campaigns.filter((c) => c.via === 'NAME').length,
    families: sel.families, campaigns: campaignList,
    history: { historyDays, incomplete: [...historyIncomplete] },
    totals: { spend: r2(spend), orders, cpa },
    accounts, daily: series,
    economics,
    profit: { estimated: estimatedProfit, verdict: verdictFor({ estimatedProfit, spend }) },
    cpaCeiling: { value: ceiling, ok: cpa === null ? null : cpa <= ceiling },
  };
}
