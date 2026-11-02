// «نظرة سريعة» → "كسبان ولا خسران؟": ONE product over ONE period (last 3 / 7 / 30 days / everything we have) across EVERY ad account it runs in:
// spend, orders (Meta purchases), cost per order, a day-by-day series, a per-account split, and — when the product's economics are known — an estimated profit / loss.
// READ ONLY. Spend / orders come from our synced campaign snapshots (verified against Meta Ads Manager to the cent). Which campaigns belong to the product = the system's own links only
// (launch wizard + owner/clone mapping, services/amb/productPerformance.resolveProductCampaigns) — never a name guess.
//
// PROFIT (honest about its assumptions — never a number invented from missing inputs):
//   contribution per Meta purchase  = deliveredShare × (sellingPrice − productCost − packaging − shipping − other)  −  returnedShare × rtoCost
//   estimated profit                = purchases × contribution − spend
//   deliveredShare = confirmation × delivery when BOTH rates are set on the product; otherwise 100 % (flagged ASSUMED_100,
//   the UI lets the owner change it). Without a selling price AND a cost > 0 the verdict is UNKNOWN (an unset cost is 0 in the data model — treating that as "free" would invent a profit).
import { prisma } from '../../prisma.js';
import { loadSnapshots, resolveWindow, todayISO, addDaysISO } from './metricsEngine.js';
import { resolveProductCampaigns } from './productPerformance.js';
import { effectiveSellingPrice, baseOperationalCost } from './productEconomics.js';
import { getAmbSettings } from './settings.js';
import { listViewAccounts } from './viewAccounts.js';

export const PROFIT_PERIODS = ['last3', 'last7', 'last30', 'all'];
const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Products the selector offers: every catalog product that has at least one campaign linked to it (launch wizard or MAPPED), name-sorted. */
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
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
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
 * @param {{ productId: number, period?: 'last3'|'last7'|'last30'|'all' }} p
 */
export async function getProductProfit({ productId, period = 'last7' }) {
  const pid = Number(productId);
  if (!Number.isInteger(pid) || pid <= 0) { const e = new Error('لازم تختار منتج.'); e.status = 400; throw e; }
  if (!PROFIT_PERIODS.includes(period)) { const e = new Error('الفترة لازم تكون آخر 3 أيام / 7 / 30 / كل الفترة.'); e.status = 400; throw e; }
  const product = await prisma.product.findUnique({ where: { id: pid }, select: { id: true, product_name: true } });
  if (!product) { const e = new Error('المنتج غير موجود.'); e.status = 404; throw e; }

  const camps = await resolveProductCampaigns(pid, { force: true });
  const ids = new Set(camps.map((c) => c.campaignId));
  const byAccount = new Map();
  for (const c of camps) { if (!byAccount.has(c.adAccountId)) byAccount.set(c.adAccountId, new Set()); byAccount.get(c.adAccountId).add(c.campaignId); }

  let firstDate = null;
  if (ids.size) {
    const agg = await prisma.metaPerformanceSnapshot.aggregate({ _min: { date_start: true }, where: { level: 'campaign', campaign_id: { in: [...ids] } } });
    firstDate = agg._min.date_start || null; // the earliest day we hold data for this product (snapshots only exist since each account's first sync)
  }
  const win = windowFor(period, firstDate);
  const names = new Map((await listViewAccounts()).accounts.map((a) => [a.id, (a.name || a.id).trim()]));

  const daily = new Map(); // date -> { spend, orders }
  const accounts = [];
  let spend = 0, orders = 0;
  for (const [adAccountId, set] of byAccount.entries()) {
    const rows = ids.size ? await loadSnapshots({ level: 'campaign', from: win.from, to: win.to, adAccountId }) : [];
    let aSpend = 0, aOrders = 0; const aCamps = new Set();
    for (const r of rows) {
      if (!set.has(r.campaign_id)) continue;
      const s = Number(r.spend) || 0, o = Number(r.meta_purchases) || 0;
      aSpend += s; aOrders += o; if (s > 0 || o > 0) aCamps.add(r.campaign_id);
      const d = daily.get(r.date_start) || { spend: 0, orders: 0 }; d.spend += s; d.orders += o; daily.set(r.date_start, d);
    }
    spend += aSpend; orders += aOrders;
    if (aSpend > 0 || aOrders > 0) accounts.push({ id: adAccountId, name: names.get(adAccountId) || adAccountId, spend: r2(aSpend), orders: aOrders, cpa: aOrders > 0 ? r2(aSpend / aOrders) : null, campaigns: aCamps.size });
  }
  accounts.sort((a, b) => b.spend - a.spend);

  // a day-by-day series with no holes (a day without data is a real zero only AFTER the first day we have data)
  const series = [];
  for (let d = win.from; d <= win.to; d = addDaysISO(d, 1)) {
    const v = daily.get(d) || { spend: 0, orders: 0 };
    series.push({ date: d, spend: r2(v.spend), orders: v.orders, cpa: v.orders > 0 ? r2(v.spend / v.orders) : null, hasData: !!daily.get(d) });
    if (series.length > 400) break;
  }

  // economics + (trusted) Easy Orders figures
  const [amb, settings] = await Promise.all([
    prisma.ambProduct.findUnique({ where: { product_id: pid }, select: { product_cost: true, pricing_multiplier: true, suggested_selling_price: true, actual_selling_price: true, packaging_cost: true, shipping_cost: true, other_cost: true, rto_cost: true, confirmation_rate: true, delivery_rate: true } }),
    getAmbSettings(),
  ]);
  const economics = buildEconomics(amb);
  const estimatedProfit = economics.available ? r2(orders * economics.contributionPerOrder - spend) : null;
  const cpa = orders > 0 ? r2(spend / orders) : null;
  const ceiling = Number(settings.ambTopProductsMaxCpa) || 150;

  return {
    productId: pid, name: product.product_name, period, window: { ...win, days: series.length },
    dataStart: firstDate, linkedCampaigns: ids.size,
    totals: { spend: r2(spend), orders, cpa },
    accounts, daily: series,
    economics,
    profit: { estimated: estimatedProfit, verdict: verdictFor({ estimatedProfit, spend }) },
    cpaCeiling: { value: ceiling, ok: cpa === null ? null : cpa <= ceiling },
  };
}
