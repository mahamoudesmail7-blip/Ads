// Product Marketing Intelligence — §9/§10 Hook Intelligence + Selling Angle
// Intelligence, SCOPED to one product's real running ads. Reuses AI Media
// Buyer's existing account-wide winner-detection machinery
// (buildHierarchy/groupByCreativeLabel/creativeLabelIndex) — never a second
// Meta call, never a second creative-analysis pipeline. The only new logic
// here is scoping the ad set to one product's mapped campaign tree.
import { buildHierarchy } from './hierarchyAnalysis.js';
import { creativeLabelIndex } from './creativeAnalysis.js';
import { groupByCreativeLabel, NAME_HOOK_RULES, NAME_ANGLE_RULES } from './winnerDetection.js';
import { bandCreativeLabel } from './productMarketingScoring.js';

/**
 * Pure — flattens one product's campaign/adset/ad tree (from an existing
 * buildHierarchy() result) into the same ad-row shape winnerDetection.js's
 * own flatten() produces, so groupByCreativeLabel() needs no fork.
 */
export function scopedAdsForProduct(tree, ambProductId) {
  const product = (tree?.products || []).find((p) => String(p.id) === String(ambProductId));
  if (!product) return [];
  const ads = [];
  for (const c of product.children || []) {
    for (const as of c.children || []) {
      for (const ad of as.children || []) {
        ads.push({ ...ad, productName: product.name, ambProductId: Number(product.id), campaignName: c.name, adsetName: as.name });
      }
    }
  }
  return ads;
}

const EMPTY_INTEL = { winner: null, table: [], labeledAds: 0, unlabeledAds: 0, dataAvailable: false };

/**
 * @param {{adAccountId:string, window:{from,to}, settings:object, ambProductId:number}} params
 * @returns {{hooks:{winner,table,labeledAds,unlabeledAds,dataAvailable}, angles:{...same shape}}}
 */
export async function hookAndAngleIntelForProduct({ adAccountId, window, settings, ambProductId }) {
  if (!ambProductId) return { hooks: EMPTY_INTEL, angles: EMPTY_INTEL };

  const tree = await buildHierarchy({ adAccountId, window, settings });
  const ads = scopedAdsForProduct(tree, ambProductId);
  if (!ads.length) return { hooks: EMPTY_INTEL, angles: EMPTY_INTEL };

  const creativeIds = [...new Set(ads.map((a) => a.creativeId).filter(Boolean))];
  const labelIdx = await creativeLabelIndex(creativeIds);
  const gate = {
    minSpend: Number(settings?.ambMinSpendBeforeDecision) || 150,
    minPurchases: Number(settings?.ambMinPurchasesBeforeScaling) || 5,
  };
  const targetCpa = Number(settings?.ambDefaultTargetCpa) || 120;

  const bandTable = (raw) => ({
    winner: raw.winner,
    table: raw.table.map((row) => ({ ...row, band: bandCreativeLabel(row, { targetCpa, minSpend: gate.minSpend, minPurchases: gate.minPurchases }) })),
    labeledAds: raw.labeledAds,
    unlabeledAds: raw.unlabeledAds,
    dataAvailable: true,
  });

  const hooksRaw = groupByCreativeLabel(ads, labelIdx, { field: 'hook', nameRules: NAME_HOOK_RULES, ...gate });
  const anglesRaw = groupByCreativeLabel(ads, labelIdx, { field: 'angle', nameRules: NAME_ANGLE_RULES, ...gate });

  return { hooks: bandTable(hooksRaw), angles: bandTable(anglesRaw) };
}
