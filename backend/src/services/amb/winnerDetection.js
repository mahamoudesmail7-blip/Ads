// AI Media Buyer — Winner Detection (upgraded). DETERMINISTIC ranking with a
// full metric panel + an explicit "why" for every winner, at every level:
//   product · campaign · ad set · ad · creative · hook · selling angle ·
//   offer · audience angle
//
// Hook / angle / offer / audience labels come from the REAL creative
// analysis (services/amb/creativeAnalysis.js — Graph-API creative text +
// deterministic-first + one Claude call), NOT just the ad name. Ad-name
// keyword rules are only a last-resort fallback for creatives with no
// analyzed label. Coverage is reported: Analyzed / Not Analyzed /
// Insufficient Data. Labels are never invented.
import { prisma } from '../../prisma.js';
import { buildHierarchy } from './hierarchyAnalysis.js';
import { creativeLabelIndex, creativeAnalysisCoverage } from './creativeAnalysis.js';
import { economicsSummary, netProfitBundle } from './productEconomics.js';
import { codCountsForProduct } from './codOrders.js';

const NAME_HOOK_RULES = [
  { label: 'سؤال', re: /(\?|؟|هل |ليه |إزاي|ازاي|ايه )/ },
  { label: 'مشكلة/وجع', re: /(وجع|ألم|الم|بتعاني|تعبت|زهقت|مشكلة|بيوجع)/ },
  { label: 'قبل/بعد', re: /(قبل.?بعد|before.?after|النتيجة|الفرق)/i },
  { label: 'عرض/خصم', re: /(خصم|عرض|أوفر|offer|discount|%|مجان|هدية|free)/i },
  { label: 'دليل اجتماعي', re: /(تجربة|رأي|reviews?|شهاد|عملاء|آراء)/i },
  { label: 'استعجال', re: /(دلوقتي|النهاردة|آخر|الكمية|limited|now)/i },
];
const NAME_ANGLE_RULES = [
  { label: 'راحة/سهولة', re: /(راحة|مريح|سهل|بساطة|بدون مجهود)/i },
  { label: 'أمان/حماية', re: /(أمان|حماية|آمن|خطر)/i },
  { label: 'توفير', re: /(يوفر|توفير|أرخص|وفر)/i },
  { label: 'جودة', re: /(جودة|خامة|متين|أصلي|ضمان)/i },
  { label: 'صحة', re: /(صحة|صحي|طبي|العظام|الرقبة|الظهر)/i },
];
function nameLabel(name, rules) {
  const t = String(name || '');
  for (const r of rules) if (r.re.test(t)) return r.label;
  return null;
}

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

const MIN_PURCH_BY_LEVEL = (mp) => ({
  product: mp, campaign: Math.max(2, Math.round(mp * 0.6)), adset: Math.max(1, Math.round(mp * 0.4)), ad: 1, creative: 1,
});

function flatten(tree) {
  const products = tree.products || [];
  const campaigns = [], adsets = [], ads = [], creatives = [];
  const walk = (c, productName, ambProductId, econ) => {
    campaigns.push({ ...c, productName, ambProductId, econ });
    for (const as of c.children || []) {
      adsets.push({ ...as, productName, ambProductId, econ, campaignName: c.name });
      for (const ad of as.children || []) ads.push({ ...ad, productName, ambProductId, econ, campaignName: c.name, adsetName: as.name });
      for (const cr of as.creatives || []) creatives.push({ ...cr, productName, ambProductId, econ, campaignName: c.name, adsetName: as.name });
    }
  };
  for (const p of products) for (const c of p.children || []) walk(c, p.name, Number(p.id), p.economics);
  for (const c of tree.unmappedCampaigns || []) walk(c, null, null, null);
  return { products, campaigns, adsets, ads, creatives };
}

function suffToConf(s) { return { STRONG: 'HIGH', MODERATE: 'MEDIUM', WEAK: 'LOW' }[s] || 'LOW'; }

/** Full metric panel + why, for a winner node. `productAgg` gives product-level delivered CPA / net profit context when the node belongs to a mapped product. */
function panelFor(node, gate, productAgg) {
  const m = node.metrics || {};
  const target = n(node.econ?.targetCpa) ?? null;
  const why = [];
  if (m.cpa !== null) why.push(`CPA ${m.cpa.toFixed(1)} ج${target ? ` مقابل هدف ${Math.round(target)} ج (${Math.round((1 - m.cpa / target) * 100)}% أفضل)` : ''}`);
  why.push(`${m.purchases} شراء بصرف ${Math.round(m.spend)} ج`);
  if (m.roas !== null) why.push(`ROAS ${m.roas.toFixed(1)}×`);
  if (m.dataSufficiency) why.push(`كفاية بيانات ${{ STRONG: 'قوية', MODERATE: 'كافية', WEAK: 'ضعيفة' }[m.dataSufficiency]}`);
  return {
    id: node.id, name: node.name, level: node.level,
    productName: node.productName || null, campaignName: node.campaignName || null, adsetName: node.adsetName || null,
    spend: m.spend ?? null, purchases: m.purchases ?? null,
    cpa: m.cpa ?? null,
    deliveredCpa: productAgg?.deliveredCpa ?? null,
    deliveredCpaScope: productAgg?.deliveredCpa != null ? 'على مستوى المنتج' : null,
    ctr: m.ctr ?? null, cpc: m.cpc ?? null, conversionRate: m.conversionRate ?? null, roas: m.roas ?? null,
    netProfit: productAgg?.netProfit ?? null,
    netProfitScope: productAgg?.netProfit != null ? 'على مستوى المنتج' : null,
    dataSufficiency: m.dataSufficiency || 'WEAK',
    confidence: suffToConf(m.dataSufficiency),
    statusColor: node.status?.color || null,
    why: why.join(' · '),
  };
}

function pickWinner(nodes, gate) {
  if (!nodes.length) return null;
  const level = nodes[0].level;
  const purchBar = MIN_PURCH_BY_LEVEL(gate.minPurchases)[level] ?? gate.minPurchases;
  const spendBar = ['ad', 'creative'].includes(level) ? Math.max(50, gate.minSpend * 0.3) : gate.minSpend;
  const elig = nodes.filter((x) => {
    const m = x.metrics || {};
    return (m.spend || 0) >= spendBar && (m.purchases || 0) >= purchBar && x.status?.color !== 'RED' && m.cpa !== null;
  });
  elig.sort((a, b) => (a.metrics.cpa - b.metrics.cpa) || ((b.metrics.purchases || 0) - (a.metrics.purchases || 0)));
  return elig[0] || null;
}

/** Group ads by a label taken from creative analysis first, ad-name rules second. */
function groupByCreativeLabel(ads, labelIdx, { field, nameRules, minSpend, minPurchases }) {
  const groups = new Map();
  let labeledAds = 0, unlabeledAds = 0;
  for (const ad of ads) {
    const ca = ad.creativeId ? labelIdx.get(ad.creativeId) : null;
    let label = null, source = null;
    if (ca && ca.status === 'ANALYZED') {
      if (field === 'hook') label = ca.hook || (JSON.parse(ca.hook_types_json || '[]')[0] || null);
      else if (field === 'angle') label = ca.selling_angle;
      else if (field === 'offer') label = ca.offer;
      else if (field === 'audience') label = ca.audience;
      if (label) source = 'CREATIVE_ANALYSIS';
    }
    if (!label && nameRules) { label = nameLabel(ad.name, nameRules) || nameLabel(ad.adsetName, nameRules); if (label) source = 'NAME_RULE'; }
    if (!label) { unlabeledAds++; continue; }
    labeledAds++;
    const key = label.slice(0, 80);
    if (!groups.has(key)) groups.set(key, { label: key, source, ads: [], spend: 0, purchases: 0, clicks: 0, impressions: 0 });
    const g = groups.get(key);
    const m = ad.metrics || {};
    g.ads.push(ad.id);
    g.spend += m.spend || 0; g.purchases += m.purchases || 0; g.clicks += m.clicks || 0; g.impressions += m.impressions || 0;
    if (source === 'CREATIVE_ANALYSIS' && g.source === 'NAME_RULE') g.source = 'CREATIVE_ANALYSIS';
  }
  const rows = [...groups.values()].map((g) => ({
    label: g.label, source: g.source, adCount: g.ads.length,
    spend: g.spend, purchases: g.purchases,
    cpa: g.purchases > 0 ? g.spend / g.purchases : null,
    ctr: g.impressions > 0 ? (g.clicks / g.impressions) * 100 : null,
    conversionRate: g.clicks > 0 ? (g.purchases / g.clicks) * 100 : null,
    dataSufficiency: g.spend >= minSpend * 2 && g.purchases >= minPurchases ? 'STRONG' : g.spend >= minSpend ? 'MODERATE' : 'WEAK',
  })).sort((a, b) => (a.cpa === null) - (b.cpa === null) || (a.cpa - b.cpa));

  // A winner needs adequate data sufficiency AND a real gap over #2.
  const eligible = rows.filter((r) => r.spend >= minSpend && r.purchases >= Math.max(1, Math.round(minPurchases * 0.5)) && r.cpa !== null && r.dataSufficiency !== 'WEAK');
  let winner = null;
  if (eligible.length >= 1) {
    const w = eligible[0];
    const second = eligible[1];
    const gap = second && second.cpa ? (second.cpa - w.cpa) / second.cpa : 1;
    winner = { ...w, why: `أقل CPA (${w.cpa.toFixed(1)} ج)${second ? ` مقابل ${second.label} (${second.cpa.toFixed(1)} ج، فرق ${Math.round(gap * 100)}%)` : ''} بـ${w.purchases} شراء و CTR ${w.ctr ? w.ctr.toFixed(1) + '%' : '—'} وكفاية بيانات ${w.dataSufficiency === 'STRONG' ? 'قوية' : 'كافية'}.` };
  }
  return { winner, table: rows, labeledAds, unlabeledAds };
}

/**
 * @returns {{window, coverage, winners:{...panels}, hooks, angles, offers, audiences}}
 */
export async function detectWinners({ adAccountId, window, settings }) {
  const tree = await buildHierarchy({ adAccountId, window, settings });
  const flat = flatten(tree);
  const gate = {
    minSpend: Number(settings.ambMinSpendBeforeDecision) || 150,
    minPurchases: Number(settings.ambMinPurchasesBeforeScaling) || 5,
  };

  // Product-level aggregates (delivered CPA + net profit) for the winner panels.
  const productAggById = new Map();
  for (const p of tree.products || []) {
    const prod = await prisma.ambProduct.findUnique({ where: { id: Number(p.id) } });
    if (!prod) continue;
    const cod = prod.product_id ? await codCountsForProduct({ productId: prod.product_id, from: window.from, to: window.to }) : { delivered: null, returned: null };
    const spend = p.metrics?.spend || 0;
    const bundle = netProfitBundle(prod, { adSpend: spend, deliveredOrders: cod.delivered, returnedOrders: cod.returned });
    productAggById.set(Number(p.id), {
      deliveredCpa: cod.delivered ? spend / cod.delivered : null,
      netProfit: bundle.netProfit,
    });
  }
  const aggFor = (node) => (node?.ambProductId ? productAggById.get(node.ambProductId) : null);

  const creativeIds = [...new Set(flat.ads.map((a) => a.creativeId).filter(Boolean))];
  const labelIdx = await creativeLabelIndex(creativeIds);
  const coverage = await creativeAnalysisCoverage();

  const hooks = groupByCreativeLabel(flat.ads, labelIdx, { field: 'hook', nameRules: NAME_HOOK_RULES, ...gate });
  const angles = groupByCreativeLabel(flat.ads, labelIdx, { field: 'angle', nameRules: NAME_ANGLE_RULES, ...gate });
  const offers = groupByCreativeLabel(flat.ads, labelIdx, { field: 'offer', nameRules: null, ...gate });
  const audiences = groupByCreativeLabel(flat.ads, labelIdx, { field: 'audience', nameRules: null, ...gate });

  const wProduct = pickWinner(flat.products, gate);
  const wCampaign = pickWinner(flat.campaigns, gate);
  const wAdset = pickWinner(flat.adsets, gate);
  const wAd = pickWinner(flat.ads, gate);
  const wCreative = pickWinner(flat.creatives, gate);

  return {
    window,
    coverage: {
      analyzed: coverage.analyzed,
      notAnalyzed: coverage.notAnalyzed,
      insufficientData: coverage.insufficient,
      total: coverage.total,
    },
    winners: {
      product: wProduct ? panelFor(wProduct, gate, aggFor(wProduct)) : null,
      campaign: wCampaign ? panelFor(wCampaign, gate, aggFor(wCampaign)) : null,
      adset: wAdset ? panelFor(wAdset, gate, aggFor(wAdset)) : null,
      ad: wAd ? panelFor(wAd, gate, aggFor(wAd)) : null,
      creative: wCreative ? panelFor(wCreative, gate, aggFor(wCreative)) : null,
      hook: hooks.winner,
      sellingAngle: angles.winner,
      offer: offers.winner,
      audienceAngle: audiences.winner,
    },
    hooks: { winner: hooks.winner, table: hooks.table, labeledAds: hooks.labeledAds, unlabeledAds: hooks.unlabeledAds },
    angles: { winner: angles.winner, table: angles.table, labeledAds: angles.labeledAds, unlabeledAds: angles.unlabeledAds },
    offers: { winner: offers.winner, table: offers.table },
    audiences: { winner: audiences.winner, table: audiences.table },
  };
}
