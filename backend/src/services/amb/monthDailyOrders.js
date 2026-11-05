// «نظرة سريعة» → "كل يوم جاب كام أوردر": for ONE calendar month, the orders (Meta-reported purchases) of EVERY ad account, day by day, and for each day
// which PRODUCTS they came from. READ ONLY, from the synced campaign snapshots — the same numbers (and the same product attribution) as the accounts card and its
// products modal, so the day totals can never disagree with them. Product links: LAUNCH / MAPPING only; unlinked campaigns group by name family for DISPLAY (source:'NAME').
import { logger } from '../../logger.js';
import { loadSnapshots, latestPerDayPerEntity, aggregateRows, todayISO } from './metricsEngine.js';
import { listViewAccounts } from './viewAccounts.js';
import { loadCampaignLinks, groupCampaigns } from './accountProductsToday.js';

const r2 = (n) => Math.round(n * 100) / 100;
const CONCURRENCY = 4;
const CACHE_MS = 2 * 60_000;
const cache = new Map(); // month -> { at, data }

export const validMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
export function daysInMonth(month) { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/**
 * Pure: per-account day rows -> the month document. `perAccount` = [{ id, name, days: Map<date, Map<key, group>> }] where each group is
 * { key, name, source, spend, orders, campaigns } (what groupCampaigns returns). Products merge across accounts by key (same linked product = ONE row).
 */
export function buildMonthDoc({ month, today, perAccount }) {
  const n = daysInMonth(month);
  const days = [];
  let totalOrders = 0, totalSpend = 0;
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
    days.push({
      date, day: d, future,
      hasData: all.length > 0,
      orders, spend: r2(spend), cpa: orders > 0 ? r2(spend / orders) : null,
      products: products.map((p) => ({ ...p, orderShare: orderShare(p) })),
      noOrders: noOrders.map((p) => ({ key: p.key, name: p.name, source: p.source, spend: p.spend, campaigns: p.campaigns })),
    });
    totalOrders += orders; totalSpend += spend;
  }
  const dataDays = days.filter((d) => d.hasData);
  const best = dataDays.reduce((b, d) => (!b || d.orders > b.orders ? d : b), null);
  return {
    month,
    days,
    total: { orders: totalOrders, spend: r2(totalSpend), cpa: totalOrders > 0 ? r2(totalSpend / totalOrders) : null },
    avgPerDay: dataDays.length ? r2(totalOrders / dataDays.length) : null,
    bestDay: best && best.orders > 0 ? { date: best.date, day: best.day, orders: best.orders } : null,
    daysWithData: dataDays.length,
    note: 'الأوردرات = مشتريات Meta (Purchases) لكل الحسابات، من آخر مزامنة (كل 15 دقيقة). المنتج = من الربط بالرفع/الربط اليدوي؛ «بالاسم» = تجميع حملات متشابهة.',
  };
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
  const data = { ...buildMonthDoc({ month: mon, today, perAccount }), accounts: accounts.length, today };
  cache.set(mon, { at: Date.now(), data });
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return data;
}

