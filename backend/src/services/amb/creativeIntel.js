// Smart Decision Center Phase 3 — Creative / Hook / Angle / Copy
// Intelligence, SCOPED to one product's real running ads. Reuses AI Media
// Buyer's existing account-wide winner-detection machinery exactly as
// productMarketingWinnerIntel.js already does for hook/angle
// (buildHierarchy / groupByCreativeLabel / creativeLabelIndex /
// scopedAdsForProduct) — never a second Meta call, never a second
// creative-analysis pipeline, never a parallel hierarchy walk.
//
// The one genuinely new piece: creative-level grouping resolves through the
// STABLE Media Library identity (MediaLibraryAsset, via
// MediaLibraryCreativeRef keyed by ad_account_id+creative_id) rather than a
// raw per-account Meta creative_id or a wizard C1/C2 slot label — neither of
// which is stable across launches/accounts (see Phase 1's own header
// comment on AmbLaunchVideoAsset.slot_key). Primary Text / Headline
// candidates are grouped the same way, off the resolved asset's own
// sample_body/sample_title.
//
// Classification (WINNER/GOOD/TESTING/WEAK/FATIGUED/INSUFFICIENT_DATA) is
// evidence-gated: a low CPA from a tiny sample can never outrank a real
// INSUFFICIENT_DATA verdict, and FATIGUE is only ever raised from a real
// prior-window CTR decline — the exact same "never one signal alone"
// discipline computeDiagnosis() already applies to account-level fatigue.
//
// Strictly analysis: no AI call, no Scale/Pause recommendation, no Meta
// write anywhere in this file.
import { prisma } from '../../prisma.js';
import { buildHierarchy } from './hierarchyAnalysis.js';
import { creativeLabelIndex } from './creativeAnalysis.js';
import { groupByCreativeLabel, NAME_HOOK_RULES, NAME_ANGLE_RULES } from './winnerDetection.js';
import { scopedAdsForProduct } from './productMarketingWinnerIntel.js';
import { dataSufficiencyOf } from './productMarketingScoring.js';
import { resolveWindow, addDaysISO } from './metricsEngine.js';

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

/**
 * Resolves each ad's raw per-account Meta creative_id to its STABLE
 * cross-launch Media Library identity. An ad whose creative hasn't been
 * registered in the Media Library yet (sync/publish lag) is never dropped —
 * it just keeps its raw creative_id as a fallback grouping key, tagged
 * UNRESOLVED, so it still counts toward the account-wide picture honestly.
 */
async function mediaLibraryIndex(adAccountId, creativeIds) {
  if (!creativeIds.length) return new Map();
  const refs = await prisma.mediaLibraryCreativeRef.findMany({
    where: { ad_account_id: adAccountId, creative_id: { in: creativeIds } },
    select: { creative_id: true, asset: { select: { id: true, asset_name: true, sample_body: true, sample_title: true, thumbnail_url: true, primary_format: true } } },
  });
  const map = new Map();
  for (const r of refs) map.set(r.creative_id, r.asset);
  return map;
}

/** Generic ad grouping by an arbitrary key — the same aggregate shape groupByCreativeLabel() produces, so classifyCandidate() never needs two code paths. Exported for direct testing of the "C1 is not globally unique, group by the real stable key" guarantee without needing a real buildHierarchy() call. */
export function groupAdsByKey(ads, keyFn) {
  const groups = new Map();
  let keyedAds = 0, unkeyedAds = 0;
  for (const ad of ads) {
    const k = keyFn(ad);
    if (!k) { unkeyedAds++; continue; }
    keyedAds++;
    if (!groups.has(k.id)) groups.set(k.id, { id: k.id, label: k.label, meta: k.meta || {}, adIds: new Set(), campaignIds: new Set(), spend: 0, purchases: 0, clicks: 0, impressions: 0 });
    const g = groups.get(k.id);
    const m = ad.metrics || {};
    g.adIds.add(ad.id);
    if (ad.campaignId) g.campaignIds.add(ad.campaignId);
    g.spend += m.spend || 0; g.purchases += m.purchases || 0; g.clicks += m.clicks || 0; g.impressions += m.impressions || 0;
  }
  const rows = [...groups.values()].map((g) => ({
    id: g.id, label: g.label, meta: g.meta,
    adCount: g.adIds.size, campaignCount: g.campaignIds.size,
    spend: g.spend, purchases: g.purchases,
    cpa: g.purchases > 0 ? g.spend / g.purchases : null,
    ctr: g.impressions > 0 ? (g.clicks / g.impressions) * 100 : null,
    cpc: g.clicks > 0 ? g.spend / g.clicks : null,
    impressions: g.impressions || null,
    conversionRate: g.clicks > 0 ? (g.purchases / g.clicks) * 100 : null,
    dataSufficiency: dataSufficiencyOf({ spend: g.spend, purchases: g.purchases }),
  })).sort((a, b) => (a.cpa === null) - (b.cpa === null) || (a.cpa - b.cpa));
  return { rows, keyedAds, unkeyedAds };
}

/**
 * Evidence-gated classification for one Creative/Hook/Angle/Copy candidate.
 * Never WINNER from a low CPA alone — sample-size and spend gates are
 * checked FIRST, before any ratio-based reasoning can even run. `priorRow`
 * (same shape, from the equal-length window immediately before this one) is
 * optional; FATIGUED is only ever reached with a real prior-window CTR
 * decline, matching computeDiagnosis()'s "never one signal alone" rule.
 */
/** Same OBSERVATION-vs-WINNER-CLASSIFICATION split as segmentIntel.js's metaSignalStrength — never hidden behind INSUFFICIENT_DATA/TESTING. */
function creativeSignalStrength(spend, purchases, minPurchases) {
  if (purchases >= minPurchases) return null;
  if (purchases >= 1) return purchases === 1 ? 'OBSERVED' : 'EARLY_SIGNAL';
  return spend > 0 ? 'EXPOSED_NO_CONVERSION' : 'NO_SIGNAL';
}

export function classifyCandidate(row, { targetCpa = 120, minSpend = 150, minPurchases = 5, priorRow = null } = {}) {
  const spend = row.spend || 0;
  const purchases = row.purchases || 0;
  const cpa = row.cpa;
  const ctr = row.ctr;
  const parts = [`صرف ${Math.round(spend)} ج`, `${purchases} شراء`];
  if (ctr != null) parts.push(`CTR ${ctr.toFixed(2)}%`);
  if (cpa != null) parts.push(`CPA ${Math.round(cpa)} ج`);
  const base = parts.join(' · ');
  const signalStrength = creativeSignalStrength(spend, purchases, minPurchases);

  // Gate 1 — sample too small for ANY judgement. Checked before CPA/ratio
  // logic can run at all, so a tiny-spend lucky CPA can never look like a
  // WINNER (explicit requirement). signalStrength above still reports the
  // real OBSERVED/EARLY_SIGNAL/EXPOSED_NO_CONVERSION from this row's own
  // real spend/purchases — only the WINNER verdict is withheld here.
  if (spend < minSpend * 0.3 || purchases < 1) {
    return { classification: 'INSUFFICIENT_DATA', confidence: 'LOW', sampleSize: purchases, signalStrength, evidence: `${base} — عينة صغيرة جدًا (أقل من ${Math.round(minSpend * 0.3)} ج صرف أو مفيش مشتريات) — أي حكم هنا غير موثوق.` };
  }
  if (row.dataSufficiency === 'WEAK') {
    return { classification: 'INSUFFICIENT_DATA', confidence: 'LOW', sampleSize: purchases, signalStrength, evidence: `${base} — أقل من الحد الأدنى الموثوق (${minSpend} ج صرف / ${minPurchases} شراء).` };
  }

  // Gate 2 — fatigue: a real, corroborated decline vs the prior window.
  if (priorRow && priorRow.ctr != null && ctr != null && priorRow.dataSufficiency !== 'WEAK' && ctr < priorRow.ctr * 0.85) {
    const decline = Math.round((1 - ctr / priorRow.ctr) * 100);
    return { classification: 'FATIGUED', confidence: row.dataSufficiency === 'STRONG' ? 'HIGH' : 'MEDIUM', sampleSize: purchases, signalStrength, evidence: `${base} — CTR انخفض ${decline}% عن الفترة السابقة (${priorRow.ctr.toFixed(2)}% ← ${ctr.toFixed(2)}%) — إشارة إجهاد كرياتيف حقيقية.` };
  }

  if (cpa == null) {
    return { classification: 'TESTING', confidence: 'LOW', sampleSize: purchases, signalStrength, evidence: `${base} — لسه مفيش مشتريات كفاية لحساب CPA موثوق.` };
  }

  const ratio = targetCpa / cpa; // >1 = cheaper than target = better
  // High attention, weak qualified traffic — explicit pattern the user asked to detect.
  const highCtrWeakConv = ctr != null && ctr >= 1.5 && ratio < 0.85;

  if (row.dataSufficiency === 'STRONG' && ratio >= 1.15 && purchases >= minPurchases) {
    return { classification: 'WINNER', confidence: 'HIGH', sampleSize: purchases, signalStrength, evidence: `${base} — أرخص من الهدف (${targetCpa} ج) بـ${Math.round((ratio - 1) * 100)}%، بعينة قوية (${purchases} شراء، ${Math.round(spend)} ج صرف).` };
  }
  if (highCtrWeakConv) {
    return { classification: 'WEAK', confidence: row.dataSufficiency === 'STRONG' ? 'MEDIUM' : 'LOW', sampleSize: purchases, signalStrength, evidence: `${base} — CTR قوي (بيوقف الناس ويجذب الانتباه) لكن معدل التحويل ضعيف (CPA ${Math.round(cpa)} ج مقابل هدف ${targetCpa} ج) — بيجذب مشاهدين مش بالضرورة عملاء مؤهلين.` };
  }
  if (ratio >= 1.0 && purchases >= Math.max(1, Math.round(minPurchases * 0.5))) {
    return { classification: 'GOOD', confidence: row.dataSufficiency === 'STRONG' ? 'HIGH' : 'MEDIUM', sampleSize: purchases, signalStrength, evidence: `${base} — قريب من هدف الـCPA (${targetCpa} ج) بعينة معقولة، لسه مش بالقوة الكافية لتصنيف WINNER.` };
  }
  if (ratio >= 0.8) {
    return { classification: 'TESTING', confidence: 'MEDIUM', sampleSize: purchases, signalStrength, evidence: `${base} — أداء متوسط، محتاج مزيد من البيانات/الوقت قبل حكم نهائي.` };
  }
  return { classification: 'WEAK', confidence: row.dataSufficiency === 'STRONG' ? 'MEDIUM' : 'LOW', sampleSize: purchases, signalStrength, evidence: `${base} — أعلى من هدف الـCPA (${targetCpa} ج) بشكل واضح.` };
}

const CLASS_RANK = { WINNER: 5, GOOD: 4, TESTING: 3, WEAK: 2, FATIGUED: 1, INSUFFICIENT_DATA: 0 };
export const NO_WINNER_MSG = 'لا يوجد فائز مؤكد حتى الآن';

/** Best candidate = highest-ranked classification (WINNER beats GOOD beats everything else), tie-broken by lowest CPA. Only WINNER/GOOD are ever eligible — matches "do not call something a winner merely because it has the lowest CPA" by construction. Exported for direct testing. */
export function pickBest(classifiedRows) {
  const eligible = classifiedRows.filter((r) => r.classification === 'WINNER' || r.classification === 'GOOD');
  if (!eligible.length) return null;
  eligible.sort((a, b) => CLASS_RANK[b.classification] - CLASS_RANK[a.classification] || (a.cpa ?? Infinity) - (b.cpa ?? Infinity));
  return eligible[0];
}

function classifyRows(rows, gate, priorByKey) {
  return rows.map((r) => ({ ...r, ...classifyCandidate(r, { ...gate, priorRow: priorByKey?.get(r.id || r.label) || null }) }));
}

/**
 * The Phase 3 dataset for one product: real per-candidate evidence for
 * Creative / Hook / Selling Angle / Primary Text / Headline, plus the
 * strongest observed Creative+Hook+Angle combination, each independently
 * classified with full evidence. Optionally compares against the
 * immediately-preceding equal-length window to detect real fatigue.
 * @param {{adAccountId:string, windowName?:string, settings:object, ambProductId:number, compareToPrior?:boolean}} params
 */
export async function creativeIntelForProduct({ adAccountId, windowName, settings, ambProductId, compareToPrior = true }) {
  const window = resolveWindow(windowName || 'last30');
  const gate = {
    targetCpa: Number(settings?.ambDefaultTargetCpa) || 120,
    minSpend: Number(settings?.ambMinSpendBeforeDecision) || 150,
    minPurchases: Number(settings?.ambMinPurchasesBeforeScaling) || 5,
  };

  const tree = await buildHierarchy({ adAccountId, window, settings });
  const ads = scopedAdsForProduct(tree, ambProductId);
  const empty = { table: [], best: null, bestNote: NO_WINNER_MSG, coverage: { keyedAds: 0, unkeyedAds: 0 } };
  if (!ads.length) {
    return { window, dataAvailable: false, creative: empty, hooks: empty, angles: empty, primaryTexts: empty, headlines: empty, combinations: empty };
  }

  const creativeIds = [...new Set(ads.map((a) => a.creativeId).filter(Boolean))];
  const [labelIdx, assetIdx] = await Promise.all([
    creativeLabelIndex(creativeIds),
    mediaLibraryIndex(adAccountId, creativeIds),
  ]);

  // Optional prior window, SAME length, immediately before this one — the
  // only source FATIGUED is ever allowed to come from (never one signal).
  let priorAdsShaped = null;
  if (compareToPrior) {
    const spanDays = (new Date(window.to) - new Date(window.from)) / 86_400_000;
    const priorTo = addDaysISO(window.from, -1);
    const priorFrom = addDaysISO(priorTo, -Math.round(spanDays));
    try {
      const priorTree = await buildHierarchy({ adAccountId, window: { from: priorFrom, to: priorTo }, settings });
      priorAdsShaped = scopedAdsForProduct(priorTree, ambProductId);
    } catch { priorAdsShaped = null; } // best-effort only — a failed prior lookup just disables fatigue detection, never breaks the main dataset
  }

  const keyFns = {
    creative: (ad) => {
      const asset = ad.creativeId ? assetIdx.get(ad.creativeId) : null;
      const id = asset ? `asset:${asset.id}` : ad.creativeId ? `raw:${ad.creativeId}` : null;
      if (!id) return null;
      return { id, label: asset?.asset_name || ad.name || id, meta: { resolvedVia: asset ? 'MEDIA_LIBRARY' : 'UNRESOLVED', thumbnailUrl: asset?.thumbnail_url || null, format: asset?.primary_format || null } };
    },
    primaryText: (ad) => {
      const asset = ad.creativeId ? assetIdx.get(ad.creativeId) : null;
      if (!asset?.sample_body) return null;
      return { id: `body:${asset.sample_body.slice(0, 120)}`, label: asset.sample_body.slice(0, 200), meta: { resolvedVia: 'MEDIA_LIBRARY' } };
    },
    headline: (ad) => {
      const asset = ad.creativeId ? assetIdx.get(ad.creativeId) : null;
      if (!asset?.sample_title) return null;
      return { id: `title:${asset.sample_title.slice(0, 120)}`, label: asset.sample_title.slice(0, 200), meta: { resolvedVia: 'MEDIA_LIBRARY' } };
    },
    combo: (ad) => {
      const asset = ad.creativeId ? assetIdx.get(ad.creativeId) : null;
      const ca = ad.creativeId ? labelIdx.get(ad.creativeId) : null;
      const hook = ca?.status === 'ANALYZED' ? (ca.hook || (JSON.parse(ca.hook_types_json || '[]')[0] || null)) : null;
      const angle = ca?.status === 'ANALYZED' ? ca.selling_angle : null;
      if (!asset && !hook && !angle) return null;
      const creativeKey = asset ? `asset:${asset.id}` : ad.creativeId ? `raw:${ad.creativeId}` : 'no-creative';
      const id = `${creativeKey}|${hook || '-'}|${angle || '-'}`;
      const label = `${asset?.asset_name || creativeKey}${hook ? ' + Hook: ' + hook : ''}${angle ? ' + زاوية: ' + angle : ''}`;
      return { id, label, meta: { creativeId: creativeKey, hook, angle } };
    },
  };

  function buildDimension(rowsResult, priorRowsResult) {
    const priorByKey = priorRowsResult ? new Map(priorRowsResult.rows.map((r) => [r.id || r.label, r])) : null;
    const classified = classifyRows(rowsResult.rows, gate, priorByKey);
    const best = pickBest(classified);
    // topObserved: the real leader by raw purchases right now — a pure
    // OBSERVATION callout, NEVER a winner claim. winnerStatus is explicit
    // about whether this same row also independently proved itself above.
    const withPurchases = classified.filter((r) => (r.purchases || 0) > 0);
    const topObserved = withPurchases.length
      ? (() => {
          const top = [...withPurchases].sort((a, b) => (b.purchases || 0) - (a.purchases || 0))[0];
          return { label: top.label, purchases: top.purchases, signalStrength: top.signalStrength, winnerStatus: top.classification === 'WINNER' ? 'PROVEN_WINNER' : 'NOT_PROVEN_YET' };
        })()
      : null;
    return { table: classified, best, bestNote: best ? null : NO_WINNER_MSG, topObserved, coverage: { keyedAds: rowsResult.keyedAds, unkeyedAds: rowsResult.unkeyedAds } };
  }

  const creativeRows = groupAdsByKey(ads, keyFns.creative);
  const primaryTextRows = groupAdsByKey(ads, keyFns.primaryText);
  const headlineRows = groupAdsByKey(ads, keyFns.headline);
  const comboRows = groupAdsByKey(ads, keyFns.combo);
  const hooksRaw = groupByCreativeLabel(ads, labelIdx, { field: 'hook', nameRules: NAME_HOOK_RULES, minSpend: gate.minSpend, minPurchases: gate.minPurchases });
  const anglesRaw = groupByCreativeLabel(ads, labelIdx, { field: 'angle', nameRules: NAME_ANGLE_RULES, minSpend: gate.minSpend, minPurchases: gate.minPurchases });

  let priorCreative = null, priorHooks = null, priorAngles = null, priorPrimaryTexts = null, priorHeadlines = null;
  if (priorAdsShaped && priorAdsShaped.length) {
    const priorCreativeIds = [...new Set(priorAdsShaped.map((a) => a.creativeId).filter(Boolean))];
    const [priorLabelIdx, priorAssetIdx] = await Promise.all([creativeLabelIndex(priorCreativeIds), mediaLibraryIndex(adAccountId, priorCreativeIds)]);
    const priorKeyFns = {
      creative: (ad) => { const asset = ad.creativeId ? priorAssetIdx.get(ad.creativeId) : null; const id = asset ? `asset:${asset.id}` : ad.creativeId ? `raw:${ad.creativeId}` : null; return id ? { id, label: asset?.asset_name || ad.name || id } : null; },
      primaryText: (ad) => { const asset = ad.creativeId ? priorAssetIdx.get(ad.creativeId) : null; return asset?.sample_body ? { id: `body:${asset.sample_body.slice(0, 120)}`, label: asset.sample_body.slice(0, 200) } : null; },
      headline: (ad) => { const asset = ad.creativeId ? priorAssetIdx.get(ad.creativeId) : null; return asset?.sample_title ? { id: `title:${asset.sample_title.slice(0, 120)}`, label: asset.sample_title.slice(0, 200) } : null; },
    };
    priorCreative = groupAdsByKey(priorAdsShaped, priorKeyFns.creative);
    priorPrimaryTexts = groupAdsByKey(priorAdsShaped, priorKeyFns.primaryText);
    priorHeadlines = groupAdsByKey(priorAdsShaped, priorKeyFns.headline);
    priorHooks = { rows: groupByCreativeLabel(priorAdsShaped, priorLabelIdx, { field: 'hook', nameRules: NAME_HOOK_RULES, minSpend: gate.minSpend, minPurchases: gate.minPurchases }).table.map((r) => ({ ...r, id: r.label })) };
    priorAngles = { rows: groupByCreativeLabel(priorAdsShaped, priorLabelIdx, { field: 'angle', nameRules: NAME_ANGLE_RULES, minSpend: gate.minSpend, minPurchases: gate.minPurchases }).table.map((r) => ({ ...r, id: r.label })) };
  }

  return {
    window,
    dataAvailable: true,
    creative: buildDimension(creativeRows, priorCreative),
    hooks: buildDimension({ rows: hooksRaw.table.map((r) => ({ ...r, id: r.label })), keyedAds: hooksRaw.labeledAds, unkeyedAds: hooksRaw.unlabeledAds }, priorHooks),
    angles: buildDimension({ rows: anglesRaw.table.map((r) => ({ ...r, id: r.label })), keyedAds: anglesRaw.labeledAds, unkeyedAds: anglesRaw.unlabeledAds }, priorAngles),
    primaryTexts: buildDimension(primaryTextRows, priorPrimaryTexts),
    headlines: buildDimension(headlineRows, priorHeadlines),
    combinations: buildDimension(comboRows, null), // fatigue comparison not meaningful at the combo granularity (too sparse) — classification still fully evidence-gated
  };
}
