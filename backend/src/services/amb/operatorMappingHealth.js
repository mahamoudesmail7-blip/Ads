// 🤖 AI Operator — MAPPING HEALTH REPORT, by CAMPAIGN FAMILY (not just rows).
// States: VERIFIED / SUGGESTED / UNMAPPED / CONFLICT / EXTERNAL_STORE (landing page proven to belong to an Easy Orders store we do not own).
// A family = the campaigns that share a naming stem ("Selicon _ scale - 4", "Selicon _ scale - 8" => "selicon"). The report shows, per family, how its
// campaigns split across states and which products they are verified to — a family verified to MORE THAN ONE product is flagged, because one product
// per family is the normal shape and anything else deserves a human look. Read-only.
import { mappingCenter } from './operatorReadiness.js';
import { getConnection } from '../metaAuth.js';

const BIDI = /[‎‏‪-‮⁦-⁩]/g;
/** "‎Selicon _ scale - 4 - Scale" -> "selicon";  "Hair-Cap - Ci -Gi" -> "hair-cap";  "Smart-Bag-Scale-ABO" -> "smart-bag". Pure. */
export function familyKeyOf(name) {
  const t = String(name || '').replace(BIDI, '').trim().toLowerCase();
  if (!t) return '(بدون اسم)';
  const first = t.split(/\s+[_–—-]\s+|\s*_\s+|-(?:scale|scael|new|test)|-(?:cbo|abo|vo|ci)(?![a-z])/i)[0].trim();
  return (first.replace(/[\s_-]+$/g, '') || t).slice(0, 40);
}

/** Pure: turns mapping-center rows (+ external-store campaign ids) into the family report. */
export function buildFamilyReport(rows, { externalIds = new Set() } = {}) {
  const fams = new Map();
  const counts = { VERIFIED: 0, SUGGESTED: 0, UNMAPPED: 0, CONFLICT: 0, EXTERNAL_STORE: 0 };
  for (const r of rows) {
    const state = externalIds.has(r.campaignId) ? 'EXTERNAL_STORE' : r.state;
    if (!(state in counts)) continue;
    counts[state]++;
    const key = familyKeyOf(r.campaignName);
    const f = fams.get(key) || { family: key, total: 0, VERIFIED: 0, SUGGESTED: 0, UNMAPPED: 0, CONFLICT: 0, EXTERNAL_STORE: 0, spend7d: 0, products: new Map(), campaigns: [] };
    f.total++; f[state]++; f.spend7d += Number(r.spend7d) || 0;
    if (state === 'VERIFIED' && r.product) f.products.set(r.product.productId ?? r.product.ambProductId, r.product.name);
    f.campaigns.push({ id: r.campaignId, name: r.campaignName, state, source: r.source, product: r.product?.name || r.suggestion?.productName || null });
    fams.set(key, f);
  }
  const families = [...fams.values()].map((f) => {
    const products = [...f.products.entries()].map(([id, name]) => ({ id, name }));
    const flags = [];
    if (f.CONFLICT) flags.push('HAS_CONFLICT'); if (f.EXTERNAL_STORE) flags.push('HAS_EXTERNAL_STORE'); if (products.length > 1) flags.push('MULTI_PRODUCT');
    if (f.UNMAPPED) flags.push('HAS_UNMAPPED'); if (f.SUGGESTED) flags.push('HAS_SUGGESTED');
    const health = f.total === f.VERIFIED && products.length <= 1 ? 'HEALTHY' : f.CONFLICT || f.EXTERNAL_STORE || products.length > 1 ? 'NEEDS_DECISION' : 'INCOMPLETE';
    return { ...f, products, flags, health, spend7d: Math.round(f.spend7d) };
  }).sort((a, b) => ({ NEEDS_DECISION: 0, INCOMPLETE: 1, HEALTHY: 2 }[a.health] - { NEEDS_DECISION: 0, INCOMPLETE: 1, HEALTHY: 2 }[b.health]) || b.spend7d - a.spend7d);
  const hc = { HEALTHY: 0, INCOMPLETE: 0, NEEDS_DECISION: 0 }; for (const f of families) hc[f.health]++;
  return { counts, total: rows.length, families, familyCounts: { total: families.length, ...hc } };
}

/** Live report for the connected ad account. External-store campaigns = those carrying an EXTERNAL_STORE automation exception (set by the landing analysis). */
export async function mappingHealthReport({ adAccountId = null } = {}) {
  const acc = adAccountId || (await getConnection())?.selected_ad_account_id;
  if (!acc) return { connected: false, counts: {}, families: [] };
  const mc = await mappingCenter({ adAccountId: acc });
  const externalIds = new Set(mc.rows.filter((r) => r.state === 'EXTERNAL_STORE').map((r) => r.campaignId));
  return { connected: true, adAccountId: acc, ...buildFamilyReport(mc.rows, { externalIds }), generatedAt: new Date().toISOString() };
}
