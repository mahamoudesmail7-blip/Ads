// AI Creative Factory — CreativeLearningService (scaffold).
//
// Every generated asset already has a stable Creative ID (cf_assets.uuid).
// This layer records the link between that ID and a real Meta ad + its
// imported performance (cf_performance_links), then aggregates by dimension
// (hook / angle / style / concept / format) into cf_learning_insights with an
// EXPLICIT sample size + confidence. It never claims causation from weak
// data: below MIN_SAMPLE the verdict is always "بيانات غير كافية".
import { prisma } from '../../prisma.js';

const MIN_SAMPLE = 5; // below this we never state a winner

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------
/** Manually (or later, auto) link a Creative ID to a Meta ad + its metrics. */
export async function linkPerformance({ assetUuid, metaAdId, adAccountId = null, metaCreativeId = null, campaignName = null, adsetName = null, adName = null, metrics = {}, linkedBy = 'MANUAL' }) {
  if (!assetUuid) { const e = new Error('assetUuid مطلوب.'); e.status = 400; throw e; }
  const asset = await prisma.cfAsset.findUnique({ where: { uuid: assetUuid } });
  const m = metrics || {};
  const row = await prisma.cfPerformanceLink.upsert({
    where: { asset_uuid_meta_ad_id: { asset_uuid: assetUuid, meta_ad_id: metaAdId || '' } },
    create: {
      asset_uuid: assetUuid, asset_id: asset?.id || null, ad_account_id: adAccountId,
      meta_ad_id: metaAdId || null, meta_creative_id: metaCreativeId, campaign_name: campaignName,
      adset_name: adsetName, ad_name: adName, linked_by: linkedBy,
      spend: num(m.spend), impressions: int(m.impressions), clicks: int(m.clicks), ctr: num(m.ctr),
      cpc: num(m.cpc), purchases: int(m.purchases), cpa: num(m.cpa), cvr: num(m.cvr), roas: num(m.roas),
      revenue: num(m.revenue), sample_size: int(m.sampleSize), last_synced_at: new Date(),
    },
    update: {
      ad_account_id: adAccountId, meta_creative_id: metaCreativeId, campaign_name: campaignName,
      adset_name: adsetName, ad_name: adName,
      spend: num(m.spend), impressions: int(m.impressions), clicks: int(m.clicks), ctr: num(m.ctr),
      cpc: num(m.cpc), purchases: int(m.purchases), cpa: num(m.cpa), cvr: num(m.cvr), roas: num(m.roas),
      revenue: num(m.revenue), sample_size: int(m.sampleSize), last_synced_at: new Date(),
    },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
export async function recomputeInsights() {
  const links = await prisma.cfPerformanceLink.findMany();
  if (!links.length) return { dimensions: 0, insights: 0, note: 'لا توجد بيانات أداء مربوطة بعد.' };

  // Map asset uuid -> { angle, hook, style, concept, format }
  const uuids = [...new Set(links.map((l) => l.asset_uuid))];
  const assets = await prisma.cfAsset.findMany({
    where: { uuid: { in: uuids } },
    include: { project_item: { include: { project: true, copy: true } } },
  });
  const dimByUuid = new Map();
  for (const a of assets) {
    const it = a.project_item;
    dimByUuid.set(a.uuid, {
      HOOK: it?.copy?.hook || it?.headline || null,
      ANGLE: it?.angle || null,
      STYLE: it?.project?.style_preset || null,
      CONCEPT: it?.purpose || null,
      FORMAT: it?.project?.project_type || null,
    });
  }

  const buckets = new Map(); // `${dim}::${key}` -> arrays
  for (const l of links) {
    const dims = dimByUuid.get(l.asset_uuid);
    if (!dims) continue;
    for (const [dim, key] of Object.entries(dims)) {
      if (!key) continue;
      const id = `${dim}::${key}`;
      if (!buckets.has(id)) buckets.set(id, { dim, key, cpa: [], roas: [], ctr: [], purchases: 0, spend: 0, n: 0 });
      const b = buckets.get(id);
      if (l.cpa != null) b.cpa.push(l.cpa);
      if (l.roas != null) b.roas.push(l.roas);
      if (l.ctr != null) b.ctr.push(l.ctr);
      b.purchases += l.purchases || 0;
      b.spend += l.spend || 0;
      b.n += 1;
    }
  }

  let written = 0;
  for (const b of buckets.values()) {
    const avg = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null);
    const sample = b.n;
    const confidence = Math.min(95, Math.round((sample / (sample + 8)) * 100)); // simple shrinkage, never 100
    const enough = sample >= MIN_SAMPLE;
    const verdict = !enough
      ? 'بيانات غير كافية — لسه بدري نحكم.'
      : `مبني على ${sample} كرياتيف مربوط بأداء حقيقي.`;
    await prisma.cfLearningInsight.upsert({
      where: { dimension_key: { dimension: b.dim, key: b.key } },
      create: { dimension: b.dim, key: b.key, sample_size: sample, confidence, avg_cpa: avg(b.cpa), avg_roas: avg(b.roas), avg_ctr: avg(b.ctr), win_rate: null, verdict, evidence_json: JSON.stringify({ spend: b.spend, purchases: b.purchases }) },
      update: { sample_size: sample, confidence, avg_cpa: avg(b.cpa), avg_roas: avg(b.roas), avg_ctr: avg(b.ctr), verdict, evidence_json: JSON.stringify({ spend: b.spend, purchases: b.purchases }), computed_at: new Date() },
    });
    written++;
  }
  return { dimensions: new Set([...buckets.values()].map((b) => b.dim)).size, insights: written };
}

export async function getInsights() {
  const rows = await prisma.cfLearningInsight.findMany({ orderBy: [{ dimension: 'asc' }, { sample_size: 'desc' }] });
  const byDim = {};
  for (const r of rows) {
    (byDim[r.dimension] ||= []).push({
      key: r.key, sampleSize: r.sample_size, confidence: r.confidence,
      avgCpa: r.avg_cpa, avgRoas: r.avg_roas, avgCtr: r.avg_ctr, verdict: r.verdict, computedAt: r.computed_at,
    });
  }
  const linkCount = await prisma.cfPerformanceLink.count();
  return { minSample: MIN_SAMPLE, linkedCreatives: linkCount, dimensions: byDim };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function int(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null; }
