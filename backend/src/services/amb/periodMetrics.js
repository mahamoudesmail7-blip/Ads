// Read-only helpers for the operator workspaces: campaign metrics over ANY date window (7 / 30 / 90 days or a custom range) and product images. Nothing here writes or calls Meta.
// Metrics come from the append-only snapshot table: the LAST snapshot of each (campaign, day) is that day's final figure, so a day is never double-counted.
import { prisma } from '../../prisma.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (s) => YMD.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const MAX_RANGE_DAYS = 366;

/** validates a window; returns {from,to,days} or throws a 400 */
export function parseWindow({ from, to, days, today = new Date().toISOString().slice(0, 10) }) {
  const bad = (m) => { const e = new Error(m); e.status = 400; return e; };
  if (days != null && days !== '') { const n = Number(days); if (!Number.isInteger(n) || n < 1 || n > MAX_RANGE_DAYS) throw bad(`عدد الأيام لازم يكون بين 1 و${MAX_RANGE_DAYS}.`); const f = new Date(`${today}T00:00:00Z`); f.setUTCDate(f.getUTCDate() - (n - 1)); return { from: f.toISOString().slice(0, 10), to: today, days: n }; }
  if (!isRealDate(String(from)) || !isRealDate(String(to))) throw bad('التواريخ لازم تكون بصيغة YYYY-MM-DD وصالحة.');
  if (from > to) throw bad('تاريخ البداية لازم يكون قبل أو يساوي تاريخ النهاية.');
  if (to > today) throw bad('تاريخ النهاية لا يمكن أن يكون في المستقبل.');
  const n = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (n > MAX_RANGE_DAYS) throw bad(`الفترة أطول من ${MAX_RANGE_DAYS} يوم.`);
  return { from, to, days: n };
}

export async function campaignWindowMetrics({ campaignIds, from, to }) {
  const ids = [...new Set((campaignIds || []).map(String).filter(Boolean))].slice(0, 300); if (!ids.length) return {};
  const rows = await prisma.$queryRawUnsafe(`with latest as (select distinct on (campaign_id, date_start) campaign_id, date_start, spend, meta_purchases from meta_performance_snapshots where level = 'campaign' and date_start between $1 and $2 and campaign_id = any($3::text[]) order by campaign_id, date_start, snapshot_at desc)
    select campaign_id, sum(spend) as spend, sum(meta_purchases) as purchases, count(*)::int as days from latest group by campaign_id`, from, to, ids);
  const out = Object.fromEntries(ids.map((id) => [id, { spend: 0, purchases: 0, cpa: null, days: 0 }]));
  for (const r of rows) { const spend = Number(r.spend || 0), purchases = Number(r.purchases || 0); out[r.campaign_id] = { spend: Math.round(spend), purchases, cpa: purchases > 0 ? Math.round(spend / purchases) : null, days: r.days }; }
  return out;
}

/** AmbProduct.image_url (cached from the store's catalogue) by Product id. Missing = no entry: the UI shows an initial-letter fallback. */
export async function productImages(productIds) {
  const ids = [...new Set((productIds || []).map(Number).filter(Number.isInteger))].slice(0, 300); if (!ids.length) return {};
  const rows = await prisma.ambProduct.findMany({ where: { product_id: { in: ids }, image_url: { not: null } }, select: { product_id: true, image_url: true } });
  const ok = (u) => /^https?:\/\//i.test(String(u || '')) || String(u || '').startsWith('/');
  return Object.fromEntries(rows.filter((r) => ok(r.image_url)).map((r) => [r.product_id, r.image_url]));
}
