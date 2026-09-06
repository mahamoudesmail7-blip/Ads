// AI Media Buyer — Campaign → Product mapping. Manual first; AI-assisted
// suggestions are offered but NEVER auto-applied to an uncertain product
// (same confidence-gated philosophy as services/adsImport.js). A campaign is:
//   MAPPED     — a human confirmed it / entered it manually
//   SUGGESTED  — an AI-assisted guess awaiting confirmation
//   UNMAPPED   — no row yet
import { prisma } from '../../prisma.js';
import { mapProductByName } from '../../../../js/product-mapping.js';

/** Distinct campaigns seen in recent snapshots for an ad account, with their spend so the UI can prioritise mapping the ones that matter. */
export async function recentCampaigns({ adAccountId, sinceDays = 7 }) {
  const from = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);
  const groups = await prisma.metaPerformanceSnapshot.groupBy({
    by: ['campaign_id', 'campaign_name'],
    where: { level: 'campaign', ad_account_id: adAccountId, date_start: { gte: from } },
    _sum: { spend: true },
  });
  return groups
    .filter((g) => g.campaign_id)
    .map((g) => ({ campaignId: g.campaign_id, campaignName: g.campaign_name, spend: g._sum.spend || 0 }))
    .sort((a, b) => b.spend - a.spend);
}

/**
 * Full mapping state for an ad account: every recent campaign tagged
 * mapped / suggested / unmapped, plus AI-assisted product guesses (by
 * fuzzy name match against AmbProduct names) for the unmapped ones.
 */
export async function mappingOverview({ adAccountId }) {
  const [campaigns, existing, ambProducts] = await Promise.all([
    recentCampaigns({ adAccountId }),
    prisma.ambProductCampaignMap.findMany({ where: { ad_account_id: adAccountId } }),
    prisma.ambProduct.findMany({ where: { active: true } }),
  ]);
  const byCampaign = new Map(existing.map((m) => [m.campaign_id, m]));
  const productList = ambProducts.map((p) => ({ id: p.id, product_name: p.product_name, sku: null }));

  const mapped = [];
  const suggested = [];
  const unmapped = [];
  for (const c of campaigns) {
    const row = byCampaign.get(c.campaignId);
    if (row && row.status === 'MAPPED') {
      mapped.push({ ...c, ambProductId: row.amb_product_id, matchSource: row.match_source });
      continue;
    }
    if (row && row.status === 'SUGGESTED') {
      suggested.push({ ...c, ambProductId: row.amb_product_id, matchConfidence: row.match_confidence, aiReason: row.ai_reason });
      continue;
    }
    // Unmapped — try a fuzzy suggestion but do not persist it.
    const guess = mapProductByName(c.campaignName || '', productList, 0.6);
    unmapped.push({
      ...c,
      suggestion: guess.productId
        ? { ambProductId: guess.productId, productName: ambProducts.find((p) => p.id === guess.productId)?.product_name || null, confidence: guess.confidence, method: guess.method }
        : null,
    });
  }
  return { mapped, suggested, unmapped, counts: { mapped: mapped.length, suggested: suggested.length, unmapped: unmapped.length } };
}

/** Manual (or confirm-a-suggestion) mapping. status defaults to MAPPED. */
export async function setMapping({ adAccountId, campaignId, campaignName, ambProductId, status = 'MAPPED', matchSource = 'MANUAL', matchConfidence = null, aiReason = null, userId = null }) {
  const product = await prisma.ambProduct.findUnique({ where: { id: Number(ambProductId) } });
  if (!product) { const e = new Error('المنتج ده مش موجود في AI Media Buyer.'); e.status = 404; throw e; }
  return prisma.ambProductCampaignMap.upsert({
    where: { ad_account_id_campaign_id: { ad_account_id: adAccountId, campaign_id: String(campaignId) } },
    create: { ad_account_id: adAccountId, campaign_id: String(campaignId), campaign_name: campaignName || null, amb_product_id: product.id, status, match_source: matchSource, match_confidence: matchConfidence, ai_reason: aiReason, created_by_id: userId },
    update: { amb_product_id: product.id, campaign_name: campaignName || undefined, status, match_source: matchSource, match_confidence: matchConfidence, ai_reason: aiReason },
  });
}

export async function removeMapping({ adAccountId, campaignId }) {
  return prisma.ambProductCampaignMap.deleteMany({ where: { ad_account_id: adAccountId, campaign_id: String(campaignId) } });
}

/** Map<campaignId, {ambProductId, productName}> for MAPPED campaigns only — the join every analysis layer uses. */
export async function mappedCampaignIndex({ adAccountId }) {
  const rows = await prisma.ambProductCampaignMap.findMany({
    where: { ad_account_id: adAccountId, status: 'MAPPED' },
    include: { amb_product: { select: { id: true, product_name: true } } },
  });
  const map = new Map();
  for (const r of rows) map.set(r.campaign_id, { ambProductId: r.amb_product_id, productName: r.amb_product?.product_name || null });
  return map;
}
