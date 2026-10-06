// 🤖 AI Operator — LANDING-PAGE EVIDENCE for campaign → product mapping, with an explicit EVIDENCE HIERARCHY and CONFLICT detection.
//
//   Tier 1  explicit verified mapping (a human decision)
//   Tier 2  launch product identity (the system created the campaign for that product) — strongest when the landing page AGREES
//   Tier 3  verified landing page: the page's OWN embedded identity (Easy Orders store_id + product uuid) proves store + product
//   Tier 4  Product Key / name-prefix suggestion (never VERIFIED on its own)
//
//   * Two pieces of STRONG evidence (tier 1-3, or a verified clone-lineage counterpart) that name different products => CONFLICT. A conflict is persisted as
//     a SUGGESTED row with match_source LANDING_CONFLICT; the mapping center shows CONFLICT and the Operator treats the campaign as NOT verified (no automation).
//   * A tier-4 suggestion that disagrees with a PROVEN landing page => CONFLICT as well.
//   * A landing page is only evidence when it is PROVEN to belong to one of OUR stores: the page's embedded product uuid must be the uuid the store's own
//     Easy Orders catalogue lists for that slug. A domain is never trusted by itself (e.g. a *.myeasyorders.com sub-domain of ANOTHER store proves nothing).
//   * Reads only: Meta GET (ads → creative / page post link) and a public storefront GET. It never writes to Meta or Easy Orders.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection, getDecryptedToken } from '../metaAuth.js';
import * as G from '../metaGraphClient.js';
import { extractCreativeContent } from './mediaLibrary.js';
import { setMapping } from './mapping.js';
import { createFromCatalogProduct } from './ambProducts.js';
import { addException, listExceptions } from './operatorStore.js';
import { resolveCampaignEvidence } from './operatorMappingResolver.js';

export const TIERS = { EXPLICIT: 1, LAUNCH: 2, LANDING_VERIFIED: 3, KEY_OR_SIBLING: 4 };
// page identity / proof / fetching live in landingProof.js (shared with the Launch Wizard validation); re-exported here for existing callers
export { slugFromLandingUrl, extractPageIdentity, provePage, fetchLandingPage } from './landingProof.js';
import { provePage, fetchLandingPage, loadLandingCatalogues } from './landingProof.js';

// =====================================================================================================================
// pure: the evidence hierarchy
// =====================================================================================================================
/**
 * claims (Product ids, null when absent):
 *   explicit  — a human-verified mapping (tier 1)
 *   launch    — product the system launched the campaign for (tier 2)
 *   landing   — { productId, proven } the landing page's product; only `proven` counts as evidence
 *   lineage   — products of VERIFIED campaigns this one was cloned from / to
 *   keyOrSibling — product suggested by Product Key / name prefix (tier 4)
 * Returns { state: VERIFIED|SUGGESTED|CONFLICT|UNMAPPED, tier, productId, basis, conflicts[], warnings[] }.
 */
export function classifyCampaignEvidence({ explicit = null, existing = null, launch = null, landing = null, lineage = [], keyOrSibling = null }) {
  const strong = [];
  if (explicit) strong.push({ kind: 'EXPLICIT', tier: 1, productId: explicit });
  if (existing) strong.push({ kind: 'EXISTING_MAPPING', tier: 3, productId: existing });
  if (launch) strong.push({ kind: 'LAUNCH', tier: 2, productId: launch });
  if (landing?.proven && landing.productId) strong.push({ kind: 'LANDING_PROVEN', tier: 3, productId: landing.productId });
  for (const l of lineage || []) if (l) strong.push({ kind: 'LINEAGE', tier: 3, productId: l });
  const weak = keyOrSibling ? [{ kind: 'KEY_OR_SIBLING', tier: 4, productId: keyOrSibling }] : [];
  const warnings = [];
  if (landing && !landing.proven && landing.productId) warnings.push(`رابط الهبوط بيشاور على منتج بس الصفحة مش مثبوت إنها تبع متجرنا (${landing.reason || 'UNPROVEN'})`);
  // a human's explicit mapping outranks everything except the system's own launch record: landing/lineage/suggestions that differ from it are warnings, not conflicts
  const humanFirst = explicit ? strong.filter((c) => ['EXPLICIT', 'LAUNCH'].includes(c.kind)) : strong;
  if (explicit) { for (const c of strong) if (!['EXPLICIT', 'LAUNCH'].includes(c.kind) && c.productId !== explicit) warnings.push(`${c.kind} بيشاور على منتج تاني (#${c.productId}) — الربط اليدوي أقوى`); }
  const distinct = [...new Set([...humanFirst, ...(explicit ? [] : weak.filter(() => landing?.proven))].map((c) => c.productId))];
  if (distinct.length > 1) {
    return { state: 'CONFLICT', tier: null, productId: null, basis: null, conflicts: [...strong, ...(landing?.proven ? weak : [])].map((c) => ({ kind: c.kind, productId: c.productId })), warnings };
  }
  if (explicit) return { state: 'VERIFIED', tier: 1, productId: explicit, basis: 'EXPLICIT_MAPPING', conflicts: [], warnings };
  if (!launch && !(landing?.proven && landing.productId) && existing) return { state: 'VERIFIED', tier: 3, productId: existing, basis: 'EXISTING_MAPPING', conflicts: [], warnings };
  if (launch) return { state: 'VERIFIED', tier: 2, productId: launch, basis: landing?.proven && landing.productId === launch ? 'LAUNCH_AND_LANDING_AGREE' : 'LAUNCH_ONLY', conflicts: [], warnings };
  if (landing?.proven && landing.productId) return { state: 'VERIFIED', tier: 3, productId: landing.productId, basis: 'LANDING_PAGE_VERIFIED', conflicts: [], warnings };
  if (lineage?.length) return { state: 'SUGGESTED', tier: 4, productId: lineage[0], basis: 'CLONE_LINEAGE', conflicts: [], warnings };
  if (weak.length) return { state: 'SUGGESTED', tier: 4, productId: keyOrSibling, basis: 'KEY_OR_SIBLING', conflicts: [], warnings };
  return { state: 'UNMAPPED', tier: null, productId: null, basis: null, conflicts: [], warnings };
}

/** A persisted LANDING_CONFLICT row is STICKY: only a human decision (a MANUAL mapping) can clear it — a re-run of the analysis must never flip it to VERIFIED. */
export const isPersistedConflict = (row) => !!row && row.match_source === 'LANDING_CONFLICT';

// =====================================================================================================================
// I/O: Meta links + storefront pages (cached, bounded)
// =====================================================================================================================
function linksOfCreative(cr) {
  const out = new Set(); if (!cr) return out;
  try { extractCreativeContent(cr).links.forEach((l) => out.add(l)); } catch { /* */ }
  const oss = cr.object_story_spec || {};
  for (const v of [oss.link_data?.call_to_action?.value?.link, oss.video_data?.call_to_action?.value?.link, oss.photo_data?.call_to_action?.value?.link]) if (v) out.add(String(v));
  for (const ch of oss.link_data?.child_attachments || []) if (ch.link) out.add(String(ch.link));
  return out;
}
/** Landing links of one campaign: the creative's own link, else the link of the Page post the ad boosts. Meta GET only. */
export async function collectCampaignLinks(token, campaignId) {
  // Meta occasionally answers with an empty page under load: an empty answer is retried (a campaign with no ads/links is only believed after 3 tries)
  let last = { ads: 0, links: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await collectCampaignLinksOnce(token, campaignId);
    last = r; if (r.links.length) return r;
    await new Promise((x) => setTimeout(x, 2500 * (attempt + 1)));
  }
  return last;
}
async function collectCampaignLinksOnce(token, campaignId) {
  const ads = await G.graphList(`/${campaignId}/ads`, { fields: 'id,creative{id,object_story_spec,asset_feed_spec,link_url,effective_object_story_id,object_story_id}', limit: 50 }, token);
  const links = new Set(); for (const ad of ads) for (const l of linksOfCreative(ad.creative)) links.add(l.split('?')[0]);
  if (!links.size) {
    const stories = [...new Set(ads.map((a) => a.creative?.effective_object_story_id || a.creative?.object_story_id).filter(Boolean))].slice(0, 6);
    for (const st of stories) { const c = await G.getPagePostContent(token, st).catch(() => null); const l = c?.cleanLink || c?.link; if (l) links.add(l.split('?')[0]); }
  }
  return { ads: ads.length, links: [...links] };
}
// =====================================================================================================================
// the analysis (dry-run by default)
// =====================================================================================================================
/**
 * Scope: every campaign that is not a human-verified mapping (UNMAPPED / SUGGESTED / CONFLICT, plus campaigns verified only by a launch job or an earlier
 * landing proof — those are re-checked for disagreement). apply=true writes ONLY amb_product_campaign_map rows:
 *   VERIFIED (tier 3, nothing else disagrees) -> MAPPED / LANDING_URL      CONFLICT -> SUGGESTED / LANDING_CONFLICT (+ evidence JSON)
 * An AMB record is created only with createAmb=true (and only from the catalogue's existing values). Nothing else is written anywhere.
 */
export async function analyzeLandingEvidence({ adAccountId = null, apply = false, createAmb = false, includeHumanVerified = false, userId = null, maxCampaigns = 400, excludeCampaignIds = new Set(), onlyCampaignIds = null, deps = {} } = {}) {
  const t0 = Date.now();
  const acc = adAccountId || (await getConnection())?.selected_ad_account_id;
  if (!acc) { const e = new Error('اربط حساب Meta الأول.'); e.status = 400; throw e; }
  const token = deps.token || await getDecryptedToken();
  const rd = await import('./operatorReadiness.js');
  const mc = await rd.mappingCenter({ adAccountId: acc });
  const maps = await prisma.ambProductCampaignMap.findMany({ where: { ad_account_id: acc }, include: { amb_product: { select: { id: true, product_id: true, product_name: true } } } });
  const mapBy = new Map(maps.map((m) => [m.campaign_id, m]));
  const launched = await prisma.ambLaunchCampaign.findMany({ where: { meta_campaign_id: { not: null }, job: { ad_account_id: acc, product_id: { not: null } } }, select: { meta_campaign_id: true, website_url: true, job: { select: { product_id: true, config_json: true } } } });
  const launchBy = new Map(launched.map((l) => [l.meta_campaign_id, l.job.product_id]));
  // launch jobs created under the mandatory pre-launch validation carry VERIFIED landing evidence (page identity -> store + product): launch product + verified landing agree
  const launchEvidence = new Map();
  for (const l of launched) { try { const ev = JSON.parse(l.job.config_json || '{}').landingValidation; const url = String(l.website_url || '').split('?')[0]; const hit = ev?.ok && !ev.bypassed ? (ev.results || []).find((x) => x.url === url && x.status === 'VERIFIED' && x.productId === l.job.product_id) : null; if (hit) launchEvidence.set(l.meta_campaign_id, { productId: hit.productId, store: hit.store, url, proven: true }); } catch { /* */ } }
  const ambs = await prisma.ambProduct.findMany({ select: { id: true, product_id: true } });
  const ambByProduct = new Map(ambs.filter((a) => a.product_id).map((a) => [a.product_id, a.id])); const productByAmb = new Map(ambs.map((a) => [a.id, a.product_id]));
  const clones = await prisma.ambCloneJob.findMany({ select: { source_campaign_id: true, destination_campaign_id: true } });
  const rel = new Map(); for (const c of clones) if (c.destination_campaign_id) { (rel.get(c.destination_campaign_id) || rel.set(c.destination_campaign_id, []).get(c.destination_campaign_id)).push(c.source_campaign_id); (rel.get(c.source_campaign_id) || rel.set(c.source_campaign_id, []).get(c.source_campaign_id)).push(c.destination_campaign_id); }
  const verifiedProductOf = (cid) => { const m = mapBy.get(cid); if (m && m.status === 'MAPPED' && m.match_source !== 'LANDING_URL') return m.amb_product?.product_id ?? null; return launchBy.get(cid) ?? null; };
  const { catalogues, dbByUuid } = deps.catalogues || await loadLandingCatalogues();
  const evidence = await resolveCampaignEvidence({ adAccountId: acc, campaigns: mc.rows.map((r) => ({ id: r.campaignId, name: r.campaignName })) });

  const scope = mc.rows.filter((r) => {
    const m = mapBy.get(r.campaignId);
    const humanVerified = m && m.status === 'MAPPED' && m.match_source === 'MANUAL';
    return (!humanVerified || (includeHumanVerified && onlyCampaignIds)) && !excludeCampaignIds.has(r.campaignId) && (!onlyCampaignIds || onlyCampaignIds.has(r.campaignId));
  }).slice(0, maxCampaigns);
  const results = []; const proofs = new Map();
  for (const r of scope) {
    const m = mapBy.get(r.campaignId);
    const savedProof = launchEvidence.get(r.campaignId);
    let linkInfo; try { linkInfo = savedProof ? { ads: 0, links: [] } : await (deps.collectLinks ? deps.collectLinks(r.campaignId) : collectCampaignLinks(token, r.campaignId)); } catch (e) { results.push({ campaignId: r.campaignId, name: r.campaignName, state: 'ERROR', reason: String(e.message).slice(0, 120) }); continue; }
    const landingProducts = new Set(); const unproven = []; const pageNotes = [];
    for (const url of linkInfo.links) {
      let pr = proofs.get(url);
      if (!pr) { const page = await (deps.fetchPage ? deps.fetchPage(url) : fetchLandingPage(url)); pr = provePage({ url, page, catalogues }); proofs.set(url, pr); }
      if (!pr.proven) { unproven.push(pr.reason); continue; }
      const p = dbByUuid[pr.store]?.get(pr.eoProductId);
      if (!p) { unproven.push('EO_PRODUCT_NOT_IN_PRODUCT_MASTER'); continue; }
      landingProducts.add(JSON.stringify({ id: p.id, name: p.product_name, store: pr.store, url }));
    }
    const lp = [...landingProducts].map((x) => JSON.parse(x)); const distinctLanding = [...new Set(lp.map((x) => x.id))];
    let landing = null;
    if (savedProof) landing = { productId: savedProof.productId, proven: true, store: savedProof.store, url: savedProof.url, name: null, reason: null };
    else if (distinctLanding.length === 1 && !unproven.length) landing = { productId: distinctLanding[0], proven: true, name: lp[0].name, store: lp[0].store, url: lp[0].url };
    else if (distinctLanding.length === 1) landing = { productId: distinctLanding[0], proven: false, reason: 'MIXED_PROVEN_AND_UNPROVEN_LINKS(' + [...new Set(unproven)].join(',') + ')', name: lp[0].name, store: lp[0].store };
    else if (distinctLanding.length > 1) landing = { productId: null, proven: false, reason: 'LINKS_POINT_TO_DIFFERENT_PRODUCTS' };
    else if (linkInfo.links.length) landing = { productId: null, proven: false, reason: [...new Set(unproven)].join(',') || 'NO_PROOF' };
    const externalStore = !!landing && !landing.proven && landing.reason === 'PAGE_BELONGS_TO_A_STORE_WE_DO_NOT_OWN';
    const ev = evidence.get(r.campaignId); const sibling = ev?.pick?.evidence?.some((e) => ['SIBLING_PREFIX', 'PRODUCT_KEY'].includes(e.type)) ? productByAmb.get(ev.pick.ambProductId) : null;
    const lineage = (rel.get(r.campaignId) || []).map(verifiedProductOf).filter(Boolean);
    const explicitMap = m && m.status === 'MAPPED' && m.match_source === 'MANUAL' ? m.amb_product?.product_id : null;
    const existingMap = m && m.status === 'MAPPED' && ['AUTO_SLUG_MATCH', 'AI_SUGGESTED'].includes(m.match_source) ? m.amb_product?.product_id : null;
    const decision = isPersistedConflict(m) ? { state: 'CONFLICT', tier: null, productId: null, basis: 'PERSISTED_CONFLICT', conflicts: (() => { try { return JSON.parse(m.ai_reason || '{}').conflicts || []; } catch { return []; } })(), warnings: [] } : classifyCampaignEvidence({ explicit: explicitMap, existing: existingMap, launch: launchBy.get(r.campaignId) ?? null, landing, lineage, keyOrSibling: sibling });
    results.push({ campaignId: r.campaignId, name: r.campaignName, currentState: r.state, externalStore, pageStoreIds: [...new Set(linkInfo.links.map((u) => proofs.get(u)?.eoStoreIds || []).flat())], links: linkInfo.links.length, landing: landing && { productId: landing.productId, proven: landing.proven, name: landing.name || null, store: landing.store || null, reason: landing.reason || null }, ...decision, launchProduct: launchBy.get(r.campaignId) ?? null, siblingProduct: sibling, hasAmb: decision.productId ? ambByProduct.has(decision.productId) : null });
  }
  const applied = { verified: 0, conflicts: 0, suggested: 0, ambCreated: 0, externalFlagged: 0, skipped: [] };
  if (apply) {
    const existingExt = new Set((await listExceptions({})).filter((e) => e.scope_type === 'CAMPAIGN' && String(e.reason || '').startsWith('EXTERNAL_STORE')).map((e) => e.scope_id));
    for (const d of results) {
      if (d.state === 'ERROR') continue;
      // landing page proven to belong to a store we do NOT own: protective NO_AUTOMATION exception (reason EXTERNAL_STORE). Never links, never edits an existing mapping.
      if (d.externalStore && !existingExt.has(d.campaignId)) { await addException({ scopeType: 'CAMPAIGN', scopeId: d.campaignId, scopeLabel: d.name, types: ['NO_AUTOMATION'], reason: `EXTERNAL_STORE: صفحة الهبوط تابعة لمتجر Easy Orders مش بتاعنا (${(d.pageStoreIds || []).join(', ') || 'store غير معروف'})`, userId }); applied.externalFlagged++; existingExt.add(d.campaignId); }
      if (d.externalStore) continue;
      const m = mapBy.get(d.campaignId);
      const humanVerified = m && m.status === 'MAPPED' && m.match_source === 'MANUAL';
      if (humanVerified) continue;
      if (d.state === 'CONFLICT' && d.basis === 'PERSISTED_CONFLICT') continue; // sticky: never rewritten by a re-run
      if (d.state === 'CONFLICT') {
        const cand = d.conflicts.map((c) => `${c.kind}:#${c.productId}`).join(' ≠ ');
        const ordered = [...d.conflicts].sort((a, b) => (a.kind === 'LANDING_PROVEN' ? 0 : 1) - (b.kind === 'LANDING_PROVEN' ? 0 : 1));
        const withAmb = ordered.find((c) => ambByProduct.has(c.productId)); const ambId = withAmb ? ambByProduct.get(withAmb.productId) : null;
        if (!ambId) { applied.skipped.push({ campaignId: d.campaignId, why: 'NO_AMB_FOR_ANY_CONFLICT_CANDIDATE' }); continue; }
        await setMapping({ adAccountId: acc, campaignId: d.campaignId, campaignName: d.name, ambProductId: ambId, status: 'SUGGESTED', matchSource: 'LANDING_CONFLICT', matchConfidence: 0, aiReason: JSON.stringify({ kind: 'LANDING_CONFLICT', conflicts: d.conflicts, landing: d.landing && { productId: d.landing.productId, store: d.landing.store, url: d.landing.url }, previous: m ? { status: m.status, source: m.match_source, ambProductId: m.amb_product_id, productId: m.amb_product?.product_id ?? null } : null, launchProduct: d.launchProduct }).slice(0, 480), userId });
        applied.conflicts++; continue;
      }
      if (d.state === 'VERIFIED' && d.basis === 'LANDING_PAGE_VERIFIED') {
        let ambId = ambByProduct.get(d.productId);
        if (!ambId && createAmb) { const rec = await createFromCatalogProduct(d.productId, userId); ambId = rec.id; ambByProduct.set(d.productId, ambId); applied.ambCreated++; }
        if (!ambId) { applied.skipped.push({ campaignId: d.campaignId, why: 'NEEDS_AMB_RECORD' }); continue; }
        await setMapping({ adAccountId: acc, campaignId: d.campaignId, campaignName: d.name, ambProductId: ambId, status: 'MAPPED', matchSource: 'LANDING_URL', matchConfidence: 1, aiReason: `LANDING_PAGE_VERIFIED: ${d.landing?.store} / ${d.landing?.url || ''}`.slice(0, 480), userId });
        applied.verified++; continue;
      }
      if (d.state === 'SUGGESTED' && d.landing?.productId && !d.landing.proven && !m) { // a landing page that points at a product but is not proven to be OUR page: a suggestion, never VERIFIED
        const ambId = ambByProduct.get(d.landing.productId); if (!ambId) continue;
        await setMapping({ adAccountId: acc, campaignId: d.campaignId, campaignName: d.name, ambProductId: ambId, status: 'SUGGESTED', matchSource: 'LANDING_UNPROVEN', matchConfidence: 0.5, aiReason: `LANDING_UNPROVEN: ${d.landing.reason}`.slice(0, 480), userId });
        applied.suggested++;
      }
    }
  }
  const summary = {}; for (const d of results) { const k = `${d.state}${d.basis ? ':' + d.basis : ''}`; summary[k] = (summary[k] || 0) + 1; }
  logger.info('[operatorLandingAnalysis] done', { apply, scope: results.length, ms: Date.now() - t0 });
  return { apply, createAmb, scope: results.length, summary, applied, ms: Date.now() - t0, results, readOnlyExceptMappingRows: true };
}
