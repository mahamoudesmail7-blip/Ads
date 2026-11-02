// «نظرة سريعة» → the best products across EVERY ad account for the day: the most orders, but only products whose cost per order is good.
// "Good" = cost per order <= settings.ambTopProductsMaxCpa (default 150 EGP, the same ceiling as the owner's open-by-CPA policy) with at least settings.ambTopProductsMinOrders (default 3)
// orders, so one lucky order never makes a "best product". READ ONLY: it merges accountProductsToday per account (same numbers as the account modal).
// A product is merged across accounts by its key: the same linked product (p:<id>) in two accounts becomes ONE row; unlinked name families (n:<family>) merge by name and stay flagged
// source:'NAME' (display grouping only — never persisted, never a decision input).
import { getAmbSettings } from './settings.js';
import { listViewAccounts } from './viewAccounts.js';
import { getAccountProductsToday } from './accountProductsToday.js';
import { todayISO } from './metricsEngine.js';

const r2 = (n) => Math.round(n * 100) / 100;
const CONCURRENCY = 5;

/**
 * @param {{ date?: string, maxCpa?: number, minOrders?: number, limit?: number }} [p]
 * @returns {Promise<{ date, criteria, products: object[], accounts: number }>}
 */
export async function getTopProductsToday({ date = null, maxCpa = null, minOrders = null, limit = 20 } = {}) {
  const settings = await getAmbSettings();
  const ceiling = Number(maxCpa ?? settings.ambTopProductsMaxCpa) || 150;
  const floor = Number(minOrders ?? settings.ambTopProductsMinOrders) || 3;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : todayISO();
  const accounts = (await listViewAccounts()).accounts;

  const results = [];
  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const chunk = accounts.slice(i, i + CONCURRENCY);
    results.push(...await Promise.all(chunk.map(async (a) => {
      try { return { a, r: await getAccountProductsToday({ adAccountId: a.id, date: day }) }; } catch { return { a, r: null }; } // one account failing never hides the rest
    })));
  }

  const merged = new Map();
  for (const { a, r } of results) {
    if (!r) continue;
    for (const p of r.products) {
      const cur = merged.get(p.key) || { key: p.key, name: p.name, source: p.source, orders: 0, spend: 0, campaigns: 0, accounts: [], topSpend: -1 };
      cur.orders += p.orders; cur.spend += p.spend; cur.campaigns += p.campaigns;
      cur.accounts.push({ id: a.id, name: (a.name || a.id).trim(), orders: p.orders, spend: r2(p.spend), cpa: p.cpa });
      if (p.spend > cur.topSpend) { cur.topSpend = p.spend; cur.name = p.name; } // the label used by the account that spends most on it
      merged.set(p.key, cur);
    }
  }

  const products = [...merged.values()]
    .map((p) => ({ key: p.key, name: p.name, source: p.source, orders: p.orders, spend: r2(p.spend), cpa: p.orders > 0 ? r2(p.spend / p.orders) : null, campaigns: p.campaigns, accounts: p.accounts.sort((x, y) => y.orders - x.orders) }))
    .filter((p) => p.orders >= floor && p.cpa !== null && p.cpa <= ceiling)
    .sort((x, y) => y.orders - x.orders || x.cpa - y.cpa || y.spend - x.spend)
    .slice(0, limit);

  return { date: day, criteria: { maxCpa: ceiling, minOrders: floor }, products, accounts: accounts.length };
}
