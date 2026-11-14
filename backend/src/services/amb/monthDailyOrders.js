// «نظرة سريعة» → "كل يوم جاب كام أوردر": for ONE calendar month, the orders (Meta-reported purchases) of EVERY ad account, day by day, and for each day
// which PRODUCTS they came from. READ ONLY, from the synced campaign snapshots — the same numbers (and the same product attribution) as the accounts card and its
// products modal, so the day totals can never disagree with them. Product links: LAUNCH / MAPPING only; unlinked campaigns group by name family for DISPLAY (source:'NAME').
import { logger } from '../../logger.js';
import { loadSnapshots, latestPerDayPerEntity, aggregateRows, todayISO } from './metricsEngine.js';
import { listViewAccounts } from './viewAccounts.js';
import { loadCampaignLinks, groupCampaigns } from './accountProductsToday.js';
import { prisma } from '../../prisma.js';

const r2 = (n) => Math.round(n * 100) / 100;
const CONCURRENCY = 4;
const CACHE_MS = 2 * 60_000;
const cache = new Map(); // month -> { at, data }

export const validMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
export function daysInMonth(month) { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

const normName = (n) => `n:${String(n || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
/** Which Meta row a REAL product belongs to: the product link (p:<id>) first, else the same normalised name (campaigns grouped only by name), else its own p:<id> key. */
const matchMetaKey = (a, keys) => { const byLink = `p:${a.id}`; if (keys.has(byLink)) return byLink; const byName = normName(a.name); return keys.has(byName) ? byName : byLink; };

/**
 * Pure: the WHOLE month in one view — every product with its Meta purchases / spend / cost per order, the REAL store orders next to it, and which ad accounts they came from;
 * plus per-account totals. Same inputs as buildMonthDoc; future days never count.
 */
export function buildMonthSummary({ month, today, perAccount, actual = new Map() }) {
  const inMonth = (date) => date.startsWith(`${month}-`) && date <= today;
  const prods = new Map(); // key -> row
  const accs = new Map(); // id -> row
  const row = (key, name, source) => { if (!prods.has(key)) prods.set(key, { key, name, source, orders: 0, spend: 0, topSpend: -1, activeDays: new Set(), accounts: new Map(), actualOrders: 0, delivered: 0, returned: 0, hasMeta: false }); return prods.get(key); };
  for (const acc of perAccount) {
    const a = accs.get(acc.id) || { id: acc.id, name: (acc.name || acc.id).trim(), orders: 0, spend: 0, products: new Set(), activeDays: new Set() };
    accs.set(acc.id, a);
    for (const [date, groups] of acc.days) {
      if (!inMonth(date)) continue;
      for (const g of groups.values()) {
        const p = row(g.key, g.name, g.source); p.hasMeta = true;
        p.orders += g.orders; p.spend += g.spend; if (g.orders > 0) p.activeDays.add(date);
        if (g.spend > p.topSpend) { p.topSpend = g.spend; p.name = g.name; }
        const pa = p.accounts.get(acc.id) || { id: acc.id, name: a.name, orders: 0, spend: 0 };
        pa.orders += g.orders; pa.spend += g.spend; p.accounts.set(acc.id, pa);
        a.orders += g.orders; a.spend += g.spend; a.products.add(g.key); if (g.orders > 0) a.activeDays.add(date);
      }
    }
  }
  const metaKeys = new Set(prods.keys());
  let storeOrders = 0, delivered = 0, returned = 0; const storeDays = new Set();
  const realById = new Map(); // product id -> merged real numbers over the month
  for (const [date, list] of actual) {
    if (!inMonth(date)) continue;
    for (const a of list) {
      if (!(a.orders > 0)) continue;
      const cur = realById.get(a.id) || { id: a.id, name: a.name, orders: 0, delivered: 0, returned: 0 };
      cur.orders += a.orders; cur.delivered += a.delivered || 0; cur.returned += a.returned || 0; realById.set(a.id, cur);
      storeOrders += a.orders; delivered += a.delivered || 0; returned += a.returned || 0; storeDays.add(date);
    }
  }
  for (const a of realById.values()) {
    const p = row(matchMetaKey(a, metaKeys), a.name, 'STORE');
    p.actualOrders += a.orders; p.delivered += a.delivered; p.returned += a.returned; p.storeName = a.name;
  }
  const metaOrders = [...accs.values()].reduce((s, a) => s + a.orders, 0);
  const spend = [...accs.values()].reduce((s, a) => s + a.spend, 0);
  const products = [...prods.values()].map((p) => ({
    key: p.key, name: p.storeName || p.name, source: p.hasMeta ? p.source : 'STORE',
    metaOrders: p.hasMeta ? p.orders : null, spend: r2(p.spend), cpa: p.orders > 0 ? r2(p.spend / p.orders) : null,
    actualOrders: p.actualOrders, delivered: p.delivered, returned: p.returned, activeDays: p.activeDays.size,
    realCpa: p.actualOrders > 0 && p.spend > 0 ? r2(p.spend / p.actualOrders) : null,
    share: 0,
    accounts: [...p.accounts.values()].map((x) => ({ id: x.id, name: x.name, orders: x.orders, spend: r2(x.spend), cpa: x.orders > 0 ? r2(x.spend / x.orders) : null })).sort((x, y) => y.orders - x.orders || y.spend - x.spend),
  }));
  const withOrders = products.filter((p) => (p.metaOrders || 0) > 0 || p.actualOrders > 0).sort((x, y) => Math.max(y.metaOrders || 0, y.actualOrders) - Math.max(x.metaOrders || 0, x.actualOrders) || y.actualOrders - x.actualOrders || x.name.localeCompare(y.name));
  const topMax = withOrders.reduce((m, p) => Math.max(m, p.metaOrders || 0, p.actualOrders), 0);
  for (const p of withOrders) p.share = topMax > 0 ? r2((Math.max(p.metaOrders || 0, p.actualOrders) / topMax) * 100) : 0;
  const noOrders = products.filter((p) => !((p.metaOrders || 0) > 0 || p.actualOrders > 0) && p.spend > 0).sort((x, y) => y.spend - x.spend).map((p) => ({ key: p.key, name: p.name, source: p.source, spend: p.spend }));
  const accounts = [...accs.values()].map((a) => ({ id: a.id, name: a.name, orders: a.orders, spend: r2(a.spend), cpa: a.orders > 0 ? r2(a.spend / a.orders) : null, products: a.products.size, activeDays: a.activeDays.size, share: metaOrders > 0 ? r2((a.orders / metaOrders) * 100) : 0 })).filter((a) => a.orders > 0 || a.spend > 0).sort((x, y) => y.orders - x.orders || y.spend - x.spend);
  return {
    totals: { storeOrders, delivered, returned, metaOrders, spend: r2(spend), cpa: metaOrders > 0 ? r2(spend / metaOrders) : null, realCpa: storeOrders > 0 && spend > 0 ? r2(spend / storeOrders) : null, storeDays: storeDays.size, products: withOrders.length },
    accounts, products: withOrders, noOrders,
  };
}

/**
 * Pure: per-account day rows -> the month document. `perAccount` = [{ id, name, days: Map<date, Map<key, group>> }] where each group is
 * { key, name, source, spend, orders, campaigns } (what groupCampaigns returns). Products merge across accounts by key (same linked product = ONE row).
 * `actual` = Map<date, [{ id, name, orders, delivered, returned }]> — the REAL store orders (DailyOrder: Easy Orders / manual), shown next to the Meta purchases of the same day.
 */
export function buildMonthDoc({ month, today, perAccount, actual = new Map() }) {
  const n = daysInMonth(month);
  const days = [];
  let totalOrders = 0, totalSpend = 0, totalActual = 0;
  for (let d = 1; d <= n; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const future = date > today;
    const merged = new Map();
    for (const acc of perAccount) {
      const groups = acc.days.get(date);
      if (!groups) continue;
      for (const g of groups.values()) {
        const cur = merged.get(g.key) || { key: g.key, name: g.name, source: g.source, orders: 0, spend: 0, campaigns: 0, accounts: [], topSpend: -1 };
        cur.orders += g.orders; cur.spend += g.spend; cur.campaigns += g.campaigns;
        cur.accounts.push({ id: acc.id, name: (acc.name || acc.id).trim(), orders: g.orders, spend: r2(g.spend) });
        if (g.spend > cur.topSpend) { cur.topSpend = g.spend; cur.name = g.name; } // the label used by the account that spends most on it
        merged.set(g.key, cur);
      }
    }
    const all = [...merged.values()].map((p) => ({
      key: p.key, name: p.name, source: p.source, campaigns: p.campaigns,
      orders: p.orders, spend: r2(p.spend), cpa: p.orders > 0 ? r2(p.spend / p.orders) : null,
      accounts: p.accounts.sort((a, b) => b.orders - a.orders || b.spend - a.spend),
    }));
    const products = all.filter((p) => p.orders > 0).sort((a, b) => b.orders - a.orders || a.cpa - b.cpa || a.name.localeCompare(b.name));
    const noOrders = all.filter((p) => p.orders === 0 && p.spend > 0).sort((a, b) => b.spend - a.spend);
    const orders = products.reduce((s, p) => s + p.orders, 0);
    const spend = all.reduce((s, p) => s + p.spend, 0);
    const orderShare = (p) => (orders > 0 ? r2((p.orders / orders) * 100) : 0);
    const actualRows = (future ? [] : (actual.get(date) || [])).filter((a) => a.orders > 0).sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name));
    const actualOrders = actualRows.reduce((s, a) => s + a.orders, 0);
    // a real product matches its Meta row by the product link (p:<id>) — or, for campaigns grouped only by name, by the same normalised name (n:<name>)
    const metaKeyOf = (a) => matchMetaKey(a, new Set(all.map((p) => p.key)));
    const actualByKey = new Map(actualRows.map((a) => [metaKeyOf(a), a]));
    days.push({
      date, day: d, future,
      hasData: all.length > 0,
      orders, spend: r2(spend), cpa: orders > 0 ? r2(spend / orders) : null,
      products: products.map((p) => ({ ...p, orderShare: orderShare(p), actualOrders: actualByKey.has(p.key) ? actualByKey.get(p.key).orders : null })),
      actualOrders,
      actualDelivered: actualRows.reduce((s, a) => s + (a.delivered || 0), 0),
      actualReturned: actualRows.reduce((s, a) => s + (a.returned || 0), 0),
      actualProducts: actualRows.map((a) => ({ id: a.id, name: a.name, orders: a.orders, delivered: a.delivered || 0, returned: a.returned || 0, metaOrders: (products.find((p) => p.key === metaKeyOf(a)) || {}).orders ?? null, spend: (all.find((p) => p.key === metaKeyOf(a)) || {}).spend ?? null })),
      noOrders: noOrders.map((p) => ({ key: p.key, name: p.name, source: p.source, spend: p.spend, campaigns: p.campaigns })),
    });
    totalOrders += orders; totalSpend += spend; totalActual += actualOrders;
  }
  const dataDays = days.filter((d) => d.hasData);
  const best = dataDays.reduce((b, d) => (!b || d.orders > b.orders ? d : b), null);
  const actualDays = days.filter((d) => !d.future && d.actualOrders > 0);
  const bestActual = actualDays.reduce((b, d) => (!b || d.actualOrders > b.actualOrders ? d : b), null);
  return {
    month,
    days,
    total: { orders: totalOrders, spend: r2(totalSpend), cpa: totalOrders > 0 ? r2(totalSpend / totalOrders) : null },
    avgPerDay: dataDays.length ? r2(totalOrders / dataDays.length) : null,
    actual: { total: totalActual, avgPerDay: actualDays.length ? r2(totalActual / actualDays.length) : null, bestDay: bestActual ? { date: bestActual.date, day: bestActual.day, orders: bestActual.actualOrders } : null, daysWithData: actualDays.length },
    bestDay: best && best.orders > 0 ? { date: best.date, day: best.day, orders: best.orders } : null,
    daysWithData: dataDays.length,
    note: 'العمود البرتقالي = مشتريات Meta (Purchases) لكل الحسابات، والأزرق = أوردرات المتجر الفعلية (Easy Orders) نفس اليوم. مشتريات Meta، من آخر مزامنة (كل 15 دقيقة). المنتج = من الربط بالرفع/الربط اليدوي؛ «بالاسم» = تجميع حملات متشابهة.',
  };
}

/** The REAL store orders of the month, per day and product (DailyOrder — what the dashboard counts). Demo rows never count. Read only. */
async function actualMonth(from, to) {
  const rows = await prisma.dailyOrder.findMany({ where: { date: { gte: from, lte: to }, is_demo: false }, select: { date: true, product_id: true, orders_count: true, delivered_count: true, returned_count: true, product: { select: { product_name: true } } } });
  const byDay = new Map();
  for (const r of rows) {
    if (!(r.orders_count > 0)) continue;
    if (!byDay.has(r.date)) byDay.set(r.date, []);
    byDay.get(r.date).push({ id: r.product_id, name: r.product?.product_name || `منتج ${r.product_id}`, orders: r.orders_count, delivered: r.delivered_count || 0, returned: r.returned_count || 0 });
  }
  return byDay;
}

async function accountMonth(acc, from, to) {
  const rows = await loadSnapshots({ level: 'campaign', from, to, adAccountId: acc.id });
  const byCampaign = latestPerDayPerEntity(rows, 'campaign');
  const perDay = new Map(); // date -> camps[]
  const ids = [];
  for (const [campaignId, dayMap] of byCampaign.entries()) {
    for (const [date, row] of dayMap.entries()) {
      const m = aggregateRows([row]);
      if (!m) continue;
      const spend = m.spend || 0, orders = m.purchases || 0;
      if (spend <= 0 && orders <= 0) continue;
      if (!perDay.has(date)) perDay.set(date, []);
      perDay.get(date).push({ campaignId, name: m.campaignName || m.name || row.campaign_name || campaignId, spend, orders });
      ids.push(campaignId);
    }
  }
  const link = await loadCampaignLinks(acc.id, [...new Set(ids)]);
  const days = new Map();
  for (const [date, camps] of perDay.entries()) days.set(date, groupCampaigns(camps, link));
  return { id: acc.id, name: acc.name, days };
}

/** @param {{ month?: string, force?: boolean }} p  month = YYYY-MM (default: this month, Cairo) */
export async function getMonthDailyOrders({ month = null, force = false } = {}) {
  const today = todayISO();
  const mon = validMonth(month) ? String(month) : today.slice(0, 7);
  const hit = cache.get(mon);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const from = `${mon}-01`;
  const last = `${mon}-${String(daysInMonth(mon)).padStart(2, '0')}`;
  const to = last < today ? last : today;
  const accounts = (await listViewAccounts()).accounts;
  const perAccount = [];
  if (from <= to) {
    for (let i = 0; i < accounts.length; i += CONCURRENCY) {
      const chunk = accounts.slice(i, i + CONCURRENCY);
      const res = await Promise.all(chunk.map((a) => accountMonth(a, from, to).catch((err) => { logger.warn('[monthDailyOrders] account failed', { adAccountId: a.id, message: err.message }); return null; })));
      for (const r of res) if (r) perAccount.push(r); // one account failing never hides the others
    }
  }
  const actual = await actualMonth(from, last < today ? last : today).catch((err) => { logger.warn('[monthDailyOrders] actual orders failed', { message: err.message }); return new Map(); });
  const data = { ...buildMonthDoc({ month: mon, today, perAccount, actual }), summary: buildMonthSummary({ month: mon, today, perAccount, actual }), accounts: accounts.length, today };
  cache.set(mon, { at: Date.now(), data });
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return data;
}

