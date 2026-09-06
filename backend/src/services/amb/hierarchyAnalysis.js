// AI Media Buyer — hierarchical analysis (spec "ANALYSIS HIERARCHY"):
// PRODUCT → CAMPAIGN → AD SET → AD → CREATIVE, every level scored on its
// OWN metrics, never just the campaign average. DETERMINISTIC — this is
// the structured input Claude later narrates, it never invents a number
// or a status here.
//
// Status colours (spec): GREEN winner/profitable · YELLOW monitor/optimize
// · RED loss/stop-candidate · BLUE scale-opportunity · GRAY need-more-data.
import { entityWindowMetrics } from './metricsEngine.js';
import { economicsSummary } from './productEconomics.js';
import { mappedCampaignIndex } from './mapping.js';
import { prisma } from '../../prisma.js';

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

/**
 * Deterministic per-node status. `econ` is economicsSummary(product) when
 * the node belongs to a mapped product, else null (falls back to default
 * target CPA from settings). Multi-signal — a single bad ratio never
 * instant-fails a node (spec "STOP LOGIC").
 */
export function nodeStatus(m, econ, s) {
  const spend = m.spend || 0;
  const purchases = m.purchases || 0;
  const cpa = m.cpa;
  const target = n(econ?.targetCpa) ?? n(s.ambDefaultTargetCpa) ?? 120;
  const warning = n(econ?.warningCpa) ?? target * 1.15;
  const max = n(econ?.maxCpa) ?? n(econ?.codBreakEvenCpa) ?? n(econ?.breakEvenCpa) ?? target * 1.5;
  const noPurchaseStop = target * (n(s.ambNoPurchaseStopMultiplier) ?? 2);
  const minSpend = n(s.ambMinSpendBeforeDecision) ?? 150;
  const scaleCpa = target * (1 - (n(s.ambScaleCpaBetterPct) ?? 10) / 100);
  const minPurch = n(s.ambMinPurchasesBeforeScaling) ?? 5;
  const reasons = [];

  if (spend < minSpend && purchases === 0) {
    return { color: 'GRAY', verdict: 'NEED_MORE_DATA', reasons: [`الصرف لسه ${Math.round(spend)} جنيه من غير نتائج — أقل من حد القرار (${minSpend} جنيه).`] };
  }
  if (purchases === 0) {
    if (spend >= noPurchaseStop) return { color: 'RED', verdict: 'STOP_CANDIDATE', reasons: [`صرف ${Math.round(spend)} جنيه (≥ ${Math.round(noPurchaseStop)} = هدف CPA ×${s.ambNoPurchaseStopMultiplier}) من غير أي شراء.`] };
    if (spend >= target) return { color: 'YELLOW', verdict: 'WATCH', reasons: [`صرف ${Math.round(spend)} جنيه (≥ هدف CPA ${Math.round(target)}) من غير شراء لسه — تحت المراقبة.`] };
    return { color: 'GRAY', verdict: 'NEED_MORE_DATA', reasons: [`صرف ${Math.round(spend)} جنيه من غير شراء — لسه بدري على قرار.`] };
  }

  if (cpa !== null && cpa > max) { reasons.push(`CPA ${cpa.toFixed(1)} جنيه فوق الحد الأقصى المسموح (${Math.round(max)} جنيه).`); return { color: 'RED', verdict: 'LOSS', reasons }; }
  if (cpa !== null && cpa > warning) { reasons.push(`CPA ${cpa.toFixed(1)} جنيه فوق حد التحذير (${Math.round(warning)} جنيه) وتحت الحد الأقصى.`); return { color: 'YELLOW', verdict: 'OPTIMIZE', reasons }; }

  if (cpa !== null && cpa <= scaleCpa && purchases >= minPurch && m.dataSufficiency !== 'WEAK') {
    reasons.push(`CPA ${cpa.toFixed(1)} جنيه أقل من الهدف (${Math.round(target)}) بـ${Math.round((1 - cpa / target) * 100)}% مع ${purchases} شراء وبيانات ${m.dataSufficiency === 'STRONG' ? 'قوية' : 'كافية'}.`);
    return { color: 'BLUE', verdict: 'SCALE_OPPORTUNITY', reasons };
  }
  reasons.push(cpa !== null ? `CPA ${cpa.toFixed(1)} جنيه داخل النطاق الصحي (هدف ${Math.round(target)} جنيه).` : `فيه ${purchases} شراء بصرف ${Math.round(spend)} جنيه.`);
  return { color: 'GREEN', verdict: 'HEALTHY', reasons };
}

/** Sum a set of child aggregates into a parent aggregate, recomputing ratios from the summed base (never averaging CPAs). */
export function rollupMetrics(children) {
  if (!children.length) return null;
  let spend = 0, impressions = 0, clicks = 0, purchases = 0, revenue = 0;
  let hasImpr = false, hasClicks = false, hasPurch = false, hasRev = false;
  for (const c of children) {
    spend += c.spend || 0;
    if (c.impressions != null) { impressions += c.impressions; hasImpr = true; }
    if (c.clicks != null) { clicks += c.clicks; hasClicks = true; }
    if (c.purchases != null) { purchases += c.purchases; hasPurch = true; }
    if (c.revenue != null) { revenue += c.revenue; hasRev = true; }
  }
  return {
    spend,
    impressions: hasImpr ? impressions : null,
    clicks: hasClicks ? clicks : null,
    purchases: hasPurch ? purchases : null,
    revenue: hasRev ? revenue : null,
    cpa: hasPurch && purchases > 0 ? spend / purchases : null,
    ctr: hasClicks && hasImpr && impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: hasClicks && clicks > 0 ? spend / clicks : null,
    cpm: hasImpr && impressions > 0 ? (spend / impressions) * 1000 : null,
    roas: hasRev && spend > 0 ? revenue / spend : null,
    conversionRate: hasClicks && hasPurch && clicks > 0 ? (purchases / clicks) * 100 : null,
    dataSufficiency: spend >= 300 && purchases >= 5 ? 'STRONG' : spend >= 150 ? 'MODERATE' : 'WEAK',
  };
}

/**
 * Full tree for an ad account + window.
 * @returns {{window, accountAvg, products:[...], unmappedCampaigns:[...]}}
 * Each node: { level, id, name, status, metrics, budget?, budgetType?, children? }
 */
export async function buildHierarchy({ adAccountId, window, settings }) {
  const { from, to } = window;
  const opts = { minSpend: n(settings.ambMinSpendBeforeDecision) ?? 150, minPurchases: n(settings.ambMinPurchasesBeforeScaling) ?? 5 };

  const [campMap, campMetrics, adsetMetrics, adMetrics, ambProducts] = await Promise.all([
    mappedCampaignIndex({ adAccountId }),
    entityWindowMetrics({ level: 'campaign', from, to, adAccountId }, opts),
    entityWindowMetrics({ level: 'adset', from, to, adAccountId }, opts),
    entityWindowMetrics({ level: 'ad', from, to, adAccountId }, opts),
    prisma.ambProduct.findMany({ where: { active: true } }),
  ]);
  const econByProductId = new Map(ambProducts.map((p) => [p.id, economicsSummary(p)]));

  const adsetsByCampaign = groupByField([...adsetMetrics.values()], 'campaignId');
  const adsByAdset = groupByField([...adMetrics.values()], 'adsetId');

  const accountAvg = rollupMetrics([...campMetrics.values()]);

  // Build campaign nodes with nested adset → ad → creative.
  function campaignNode(cm, econ) {
    const adsets = (adsetsByCampaign.get(cm.entityId) || []).map((am) => {
      const ads = (adsByAdset.get(am.entityId) || []).map((adm) => ({
        level: 'ad', id: adm.entityId, name: adm.name || adm.adName || adm.entityId,
        creativeId: adm.creativeId || null,
        status: nodeStatus(adm, econ, settings),
        metrics: stripMetrics(adm),
      }));
      const creatives = buildCreatives(ads, econ, settings);
      return {
        level: 'adset', id: am.entityId, name: am.name || am.adsetName || am.entityId,
        budget: am.budgetLevel === 'adset' ? am.budget : null, budgetType: am.budgetLevel === 'adset' ? am.budgetType : null,
        status: nodeStatus(am, econ, settings), metrics: stripMetrics(am),
        children: ads, creatives,
      };
    });
    return {
      level: 'campaign', id: cm.entityId, name: cm.name || cm.campaignName || cm.entityId,
      budget: cm.budgetLevel === 'campaign' ? cm.budget : null, budgetType: cm.budgetLevel === 'campaign' ? cm.budgetType : null,
      status: nodeStatus(cm, econ, settings), metrics: stripMetrics(cm),
      children: adsets,
    };
  }

  const products = [];
  for (const p of ambProducts) {
    const myCampaignIds = [...campMap.entries()].filter(([, v]) => v.ambProductId === p.id).map(([cid]) => cid);
    const myCampMetrics = myCampaignIds.map((cid) => campMetrics.get(cid)).filter(Boolean);
    if (myCampMetrics.length === 0) continue;
    const econ = econByProductId.get(p.id);
    const campaignNodes = myCampMetrics.map((cm) => campaignNode(cm, econ));
    const roll = rollupMetrics(myCampMetrics);
    products.push({
      level: 'product', id: String(p.id), name: p.product_name,
      economics: econ,
      status: nodeStatus(roll || {}, econ, settings),
      metrics: roll,
      children: campaignNodes,
    });
  }

  // Unmapped campaigns → standalone entities (never blocked on mapping).
  const mappedIds = new Set([...campMap.keys()]);
  const unmappedCampaigns = [...campMetrics.values()]
    .filter((cm) => !mappedIds.has(cm.entityId))
    .map((cm) => campaignNode(cm, null));

  return { window, accountAvg, products, unmappedCampaigns };
}

function stripMetrics(m) {
  return {
    spend: m.spend ?? 0, impressions: m.impressions ?? null, clicks: m.clicks ?? null,
    purchases: m.purchases ?? null, revenue: m.revenue ?? null, results: m.results ?? null,
    cpa: m.cpa ?? null, ctr: m.ctr ?? null, cpc: m.cpc ?? null, cpm: m.cpm ?? null,
    roas: m.roas ?? null, conversionRate: m.conversionRate ?? null, frequency: m.frequency ?? null,
    dataSufficiency: m.dataSufficiency || 'WEAK', metaStatus: m.status || null,
  };
}

function groupByField(arr, field) {
  const map = new Map();
  for (const x of arr) {
    const k = x[field];
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return map;
}

/** Group an adset's ad nodes by creative_id and score each creative cluster on its combined metrics. */
function buildCreatives(adNodes, econ, settings) {
  const byCreative = new Map();
  for (const ad of adNodes) {
    const k = ad.creativeId || `nocreative:${ad.id}`;
    if (!byCreative.has(k)) byCreative.set(k, []);
    byCreative.get(k).push(ad);
  }
  return [...byCreative.entries()].map(([creativeId, ads]) => {
    const roll = rollupMetrics(ads.map((a) => a.metrics));
    return {
      level: 'creative', id: creativeId, name: creativeId.startsWith('nocreative:') ? '(بدون كرييتف معرّف)' : creativeId,
      adCount: ads.length, adIds: ads.map((a) => a.id),
      status: nodeStatus(roll || {}, econ, settings), metrics: roll,
    };
  });
}
