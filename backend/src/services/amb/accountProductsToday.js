// «نظرة سريعة» → click an ad account → what every PRODUCT cost / brought today on THAT account (orders, spend, cost per order), best first.
// READ ONLY, from the synced campaign snapshots (the same numbers as the accounts card). Which product a campaign belongs to comes from the system's own links ONLY:
//   · LAUNCH  — the campaign was created by the launch wizard for a product (AmbLaunchCampaign → job.product_id): deterministic;
//   · MAPPING — the owner / the clone lineage mapped it (AmbProductCampaignMap, status MAPPED).
// A campaign with neither link is NOT attributed to a product by the system. For DISPLAY ONLY it is grouped with the campaigns that share the same name family
// ("Nail-clipper - Test 2" + "nail-clipper-Test 4" → "Nail-clipper") and the row is flagged source:'NAME' so the screen says "grouped by name, not linked".
// That grouping is never persisted and never feeds a decision (the standing rule: name matching stays out of every decision path).
import { prisma } from '../../prisma.js';
import { loadSnapshots, latestPerDayPerEntity, aggregateRows, todayISO } from './metricsEngine.js';
import { listViewAccounts } from './viewAccounts.js';

const CUT = /(?:^|[\s_\-–—]+)(test|scale|talbq|talabq|talbaq|mix|carousel|ph|copy|new)(?![a-z])/i;

/** The family a campaign name belongs to: the text before the first "test / scale / talbq …" marker, without trailing numbers / separators. Pure. */
export function nameFamily(campaignName) {
  const raw = String(campaignName || '').replace(/[‎‏]/g, '').trim();
  if (!raw) return { key: '', label: '' };
  const m = CUT.exec(raw);
  let s = m && m.index > 0 ? raw.slice(0, m.index) : raw;
  s = s.replace(/[\s_\-–—\d/]+$/g, '').trim();
  if (!s) s = raw;
  return { key: s.toLowerCase().replace(/\s+/g, ' '), label: s };
}

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {{ adAccountId: string, date?: string }} p
 * @returns {Promise<{ date, account, products: object[], noOrders: object[], totals: object }>}
 */
export async function getAccountProductsToday({ adAccountId, date = null }) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : todayISO();
  const rows = await loadSnapshots({ level: 'campaign', from: day, to: day, adAccountId });
  const byCampaign = latestPerDayPerEntity(rows, 'campaign');

  const camps = [];
  for (const [campaignId, days] of byCampaign.entries()) {
    const m = aggregateRows([...days.values()]);
    if (!m) continue;
    const spend = m.spend || 0, orders = m.purchases || 0;
    if (spend <= 0 && orders <= 0) continue;
    camps.push({ campaignId, name: m.campaignName || m.name || campaignId, spend, orders });
  }
  const ids = camps.map((c) => c.campaignId);

  const [launched, mapped] = ids.length ? await Promise.all([
    prisma.ambLaunchCampaign.findMany({ where: { meta_campaign_id: { in: ids }, job: { product_id: { not: null }, ad_account_id: adAccountId } }, select: { meta_campaign_id: true, job: { select: { product_id: true, product: { select: { product_name: true } } } } } }),
    prisma.ambProductCampaignMap.findMany({ where: { ad_account_id: adAccountId, campaign_id: { in: ids }, status: 'MAPPED' }, select: { campaign_id: true, amb_product: { select: { id: true, product_id: true, product_name: true, product: { select: { product_name: true } } } } } }),
  ]) : [[], []];
  const link = new Map(); // campaignId -> { key, name, source }
  for (const l of mapped) { const p = l.amb_product; link.set(l.campaign_id, { key: p.product_id ? `p:${p.product_id}` : `a:${p.id}`, name: p.product?.product_name || p.product_name, source: 'MAPPING' }); }
  for (const l of launched) { const j = l.job; link.set(l.meta_campaign_id, { key: `p:${j.product_id}`, name: j.product?.product_name || `منتج ${j.product_id}`, source: 'LAUNCH' }); } // the launch wizard's own link wins

  const groups = new Map();
  for (const c of camps) {
    let g = link.get(c.campaignId);
    if (!g) { const f = nameFamily(c.name); g = { key: `n:${f.key || c.campaignId}`, name: f.label || c.name, source: 'NAME' }; }
    const cur = groups.get(g.key) || { key: g.key, name: g.name, source: g.source, spend: 0, orders: 0, campaigns: 0, topSpend: -1 };
    cur.spend += c.spend; cur.orders += c.orders; cur.campaigns += 1;
    if (g.source === 'NAME' && c.spend > cur.topSpend) { cur.topSpend = c.spend; cur.name = g.name; } // the label of the biggest campaign of the family
    groups.set(g.key, cur);
  }

  let totalSpend = 0, totalOrders = 0;
  for (const g of groups.values()) { totalSpend += g.spend; totalOrders += g.orders; }
  const list = [...groups.values()].map((g) => ({
    key: g.key, name: g.name, source: g.source, campaigns: g.campaigns,
    spend: r2(g.spend), orders: g.orders, cpa: g.orders > 0 ? r2(g.spend / g.orders) : null,
    orderShare: totalOrders > 0 ? r2((g.orders / totalOrders) * 100) : 0,
  }));
  const products = list.filter((g) => g.orders > 0).sort((a, b) => b.orders - a.orders || b.spend - a.spend || a.name.localeCompare(b.name));
  const noOrders = list.filter((g) => g.orders === 0 && g.spend > 0).sort((a, b) => b.spend - a.spend);

  const acc = (await listViewAccounts()).accounts.find((a) => a.id === adAccountId);
  return {
    date: day,
    account: { id: adAccountId, name: acc?.name || adAccountId },
    products, noOrders,
    totals: { spend: r2(totalSpend), orders: totalOrders, cpa: totalOrders > 0 ? r2(totalSpend / totalOrders) : null },
  };
}
