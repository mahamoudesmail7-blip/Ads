// 🤖 AI Operator — CAMPAIGN → PRODUCT evidence resolver. One place that gathers every deterministic signal the system already holds and decides how
// strong it is. It NEVER produces VERIFIED: the only paths to VERIFIED stay (a) an explicit human/legacy MAPPED row, (b) a launch job (the system
// created the campaign for that product). Everything found here is at most SUGGESTED, ranked, and goes to ONE review queue.
//
// Evidence (strongest first):
//   URL_SLUG      campaign -> its ads' creatives -> media-library creative refs -> landing URL (/products/<slug>) -> the store's Easy Orders catalogue
//                 (slug) -> that product's name -> exactly ONE AMB product in the same store. Every ad that carries a URL must agree.
//   PRODUCT_KEY   an explicit Product Key (owner-set on the product) appears in the campaign name.
//   SIBLING_PREFIX the campaign name prefix (text before " _ " / " - ") is used by >= 2 already-VERIFIED campaigns of exactly ONE product.
//   NAME_SIMILARITY weak token overlap (>= 2 shared words) — shown, never persisted.
// A candidate with two different products among STRONG signals is AMBIGUOUS (goes to review, nothing is persisted).
import { prisma } from '../../prisma.js';
import { normalizeName, mapProductByName } from '../../../../js/product-mapping.js';
import { loadStoreCatalogProducts, catalogKey } from './productPriceResolver.js';

const STRONG = new Set(['URL_SLUG', 'PRODUCT_KEY', 'SIBLING_PREFIX']);
/** "Hair-Cap _ scale 2" -> "hair-cap";  "Smart-Bag-NewTest-AI" -> null (no separator => no reliable prefix). Pure. */
export function campaignPrefix(name) {
  const t = String(name || '').trim();
  const m = t.match(/^(.+?)\s+[_–—-]\s+/) || t.match(/^(.+?)\s*_\s+/);
  if (!m) return null;
  const p = normalizeName(m[1]);
  return p.length >= 3 ? p : null;
}
/** "https://www.x.com/products/Fire-Radio?utm=1" -> "Fire-Radio". Pure. */
export function slugFromUrl(url) {
  try { const u = new URL(url); const m = u.pathname.match(/\/products?\/([^/?#]+)/i); return m ? decodeURIComponent(m[1]).trim() : null; } catch { return null; }
}

/** Pure ranking of one campaign's evidence list => decision. evidence = [{type, ambProductId, detail}] */
export function decideFromEvidence(evidence) {
  const byProduct = new Map();
  for (const e of evidence) { const r = byProduct.get(e.ambProductId) || { ambProductId: e.ambProductId, evidence: [], strong: false }; r.evidence.push(e); if (STRONG.has(e.type)) r.strong = true; byProduct.set(e.ambProductId, r); }
  const cands = [...byProduct.values()];
  const strong = cands.filter((c) => c.strong);
  if (strong.length > 1) return { decision: 'AMBIGUOUS', candidates: cands };
  if (strong.length === 1) return { decision: 'SUGGEST_STRONG', candidates: cands, pick: strong[0] };
  if (cands.length === 1) return { decision: 'SUGGEST_WEAK', candidates: cands, pick: cands[0] };
  if (cands.length > 1) return { decision: 'AMBIGUOUS', candidates: cands };
  return { decision: 'NO_EVIDENCE', candidates: [] };
}

/**
 * Evidence for the given campaigns ({id,name}). Reads only: mapping rows, launch jobs, owner product keys, synced ad snapshots, media-library refs,
 * and the cached store catalogues. `unmappedOnly` skips campaigns that already have a MAPPED row or a launch-job link.
 */
export async function resolveCampaignEvidence({ adAccountId, campaigns, ambProducts = null }) {
  const ambs = ambProducts || await prisma.ambProduct.findMany({ where: { active: true }, select: { id: true, product_name: true, product_id: true } });
  const productIds = ambs.map((a) => a.product_id).filter(Boolean);
  const products = new Map((await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, product_name: true, store_id: true } })).map((p) => [p.id, p]));
  const ambByProductId = new Map(ambs.filter((a) => a.product_id).map((a) => [a.product_id, a]));
  const maps = await prisma.ambProductCampaignMap.findMany({ where: { ad_account_id: adAccountId }, select: { campaign_id: true, amb_product_id: true, status: true, campaign_name: true } });
  const launched = await prisma.ambLaunchCampaign.findMany({ where: { meta_campaign_id: { not: null }, job: { ad_account_id: adAccountId, product_id: { not: null } } }, select: { meta_campaign_id: true } });
  const verifiedIds = new Set([...maps.filter((m) => m.status === 'MAPPED').map((m) => m.campaign_id), ...launched.map((l) => l.meta_campaign_id)]);
  const nameById = new Map(campaigns.map((c) => [c.id, c.name]));

  // sibling prefixes learned from VERIFIED campaigns
  const prefixProducts = new Map(); // prefix -> Map(ambProductId -> n)
  for (const m of maps.filter((x) => x.status === 'MAPPED')) {
    const nm = nameById.get(m.campaign_id) || m.campaign_name; const pre = campaignPrefix(nm); if (!pre) continue;
    const mm = prefixProducts.get(pre) || new Map(); mm.set(m.amb_product_id, (mm.get(m.amb_product_id) || 0) + 1); prefixProducts.set(pre, mm);
  }
  // owner-set Product Keys
  const keyRows = await prisma.ambOperatorProductConfig.findMany({ where: { product_key: { not: null } }, select: { product_id: true, product_key: true } });
  const keys = keyRows.map((k) => ({ key: normalizeName(k.product_key), raw: k.product_key, amb: ambByProductId.get(k.product_id) })).filter((k) => k.key && k.amb);

  // URL evidence: ads -> creatives -> media-library refs -> landing URL slug -> store catalogue slug -> product
  const target = campaigns.filter((c) => !verifiedIds.has(c.id));
  const adRows = target.length ? await prisma.metaPerformanceSnapshot.findMany({ where: { ad_account_id: adAccountId, level: 'ad', campaign_id: { in: target.map((c) => c.id) }, creative_id: { not: null } }, distinct: ['campaign_id', 'creative_id'], select: { campaign_id: true, creative_id: true } }) : [];
  const creativeIds = [...new Set(adRows.map((r) => r.creative_id))];
  const refs = creativeIds.length ? await prisma.mediaLibraryCreativeRef.findMany({ where: { creative_id: { in: creativeIds } }, select: { creative_id: true, asset_id: true } }) : [];
  const assets = refs.length ? new Map((await prisma.mediaLibraryAsset.findMany({ where: { id: { in: [...new Set(refs.map((r) => r.asset_id))] }, sample_link_url: { not: null } }, select: { id: true, sample_link_url: true } })).map((a) => [a.id, a.sample_link_url])) : new Map();
  const slugsByCreative = new Map();
  for (const r of refs) { const u = assets.get(r.asset_id); const sl = u ? slugFromUrl(u) : null; if (sl) { const set = slugsByCreative.get(r.creative_id) || new Set(); set.add(sl.toLowerCase()); slugsByCreative.set(r.creative_id, set); } }
  const stores = [...new Set([...products.values()].map((p) => p.store_id).filter(Boolean))];
  const slugIndex = new Map(); // slug -> [{store, name}]
  if (slugsByCreative.size) for (const st of stores) { const list = await loadStoreCatalogProducts(st); for (const p of list || []) if (p.slug) { const k = String(p.slug).toLowerCase(); slugIndex.set(k, [...(slugIndex.get(k) || []), { store: st, name: p.name }]); } }
  const productByStoreKey = new Map(); // `${store}|${catalogKey}` -> [amb]
  for (const a of ambs) { const p = products.get(a.product_id); if (!p) continue; const k = `${p.store_id}|${catalogKey(p.product_name)}`; productByStoreKey.set(k, [...(productByStoreKey.get(k) || []), a]); }

  const out = new Map();
  for (const c of target) {
    const ev = [];
    const nm = normalizeName(c.name || '');
    // URL_SLUG: every creative of the campaign that has a URL must resolve to the SAME single product
    const creatives = adRows.filter((r) => r.campaign_id === c.id).map((r) => r.creative_id);
    const urlProducts = new Set(); let urlCreatives = 0, unresolved = 0;
    for (const cr of creatives) {
      const slugs = slugsByCreative.get(cr); if (!slugs) continue; urlCreatives++;
      for (const sl of slugs) {
        const hits = slugIndex.get(sl) || [];
        const resolved = hits.length === 1 ? (productByStoreKey.get(`${hits[0].store}|${catalogKey(hits[0].name)}`) || []) : [];
        if (resolved.length === 1) urlProducts.add(resolved[0].id); else unresolved++;
      }
    }
    if (urlCreatives > 0 && unresolved === 0 && urlProducts.size === 1) { const id = [...urlProducts][0]; ev.push({ type: 'URL_SLUG', ambProductId: id, detail: `رابط الصفحة في ${urlCreatives} كرييتف بيطابق منتج واحد في كتالوج المتجر` }); }
    else if (urlProducts.size > 1) for (const id of urlProducts) ev.push({ type: 'URL_SLUG', ambProductId: id, detail: 'روابط كرييتفات الحملة بتشاور على أكتر من منتج' });
    // PRODUCT_KEY
    for (const k of keys) if (nm.includes(k.key)) ev.push({ type: 'PRODUCT_KEY', ambProductId: k.amb.id, detail: `Product Key "${k.raw}" في اسم الحملة` });
    // SIBLING_PREFIX
    const pre = campaignPrefix(c.name); const sib = pre ? prefixProducts.get(pre) : null;
    if (sib && sib.size === 1) { const [[pid, n]] = [...sib.entries()]; if (n >= 2) ev.push({ type: 'SIBLING_PREFIX', ambProductId: pid, detail: `البادئة "${pre}" مستخدمة في ${n} حملات VERIFIED لنفس المنتج` }); }
    else if (sib && sib.size > 1) for (const [pid, n] of sib) ev.push({ type: 'SIBLING_PREFIX', ambProductId: pid, detail: `البادئة "${pre}" مستخدمة لأكتر من منتج (${n} حملات)` });
    // NAME_SIMILARITY (weak): >= 2 shared words
    if (!ev.length) {
      const g = mapProductByName(c.name || '', ambs.map((a) => ({ id: a.id, product_name: a.product_name, sku: null })), 0.6);
      if (g.productId) { const pn = normalizeName(ambs.find((a) => a.id === g.productId)?.product_name || '').split(' '); const shared = nm.split(' ').filter((t) => t.length > 1 && pn.includes(t)).length; if (shared >= 2) ev.push({ type: 'NAME_SIMILARITY', ambProductId: g.productId, detail: `تشابه أسماء (${shared} كلمات مشتركة) — اقتراح ضعيف`, confidence: Math.round(g.confidence * 100) / 100 }); }
    }
    out.set(c.id, { ...decideFromEvidence(ev), evidence: ev, prefix: pre });
  }
  return out;
}

/**
 * Persist STRONG suggestions (never weak, never ambiguous) as SUGGESTED rows. An existing MAPPED row is never touched; an existing SUGGESTED row for
 * the same product is left as is. Returns counts. Writes only amb_product_campaign_map rows with status SUGGESTED.
 */
export async function persistStrongSuggestions({ adAccountId, campaigns, userId = null }) {
  const evidence = await resolveCampaignEvidence({ adAccountId, campaigns });
  const existing = new Map((await prisma.ambProductCampaignMap.findMany({ where: { ad_account_id: adAccountId } })).map((m) => [m.campaign_id, m]));
  let created = 0, updated = 0, skipped = 0;
  for (const c of campaigns) {
    const r = evidence.get(c.id); if (!r || r.decision !== 'SUGGEST_STRONG') continue;
    const cur = existing.get(c.id);
    if (cur && cur.status === 'MAPPED') { skipped++; continue; }
    if (cur && cur.status === 'SUGGESTED' && cur.amb_product_id === r.pick.ambProductId) { skipped++; continue; }
    const reason = r.pick.evidence.map((e) => `${e.type}: ${e.detail}`).join(' | ').slice(0, 480);
    const data = { amb_product_id: r.pick.ambProductId, campaign_name: c.name || null, status: 'SUGGESTED', match_source: 'AI_SUGGESTED', match_confidence: 0.9, ai_reason: reason };
    if (cur) { await prisma.ambProductCampaignMap.update({ where: { id: cur.id }, data }); updated++; }
    else { await prisma.ambProductCampaignMap.create({ data: { ad_account_id: adAccountId, campaign_id: c.id, created_by_id: userId, ...data } }); created++; }
  }
  return { created, updated, skipped, evaluated: campaigns.length };
}
