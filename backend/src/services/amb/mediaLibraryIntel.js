// AI Media Buyer — MEDIA ASSET LIBRARY × AI Intelligence.
//
// Deterministic winner/loser detection over the deduplicated creative
// library, aggregating each asset's performance across EVERY ad / account it
// runs in. A winner is NEVER decided on CPA alone — it must clear the same
// data-sufficiency + profitability gates the rest of AI Media Buyer uses
// (ambMinSpendBeforeDecision, ambMinPurchasesBeforeScaling,
// ambScaleCpaBetterPct, product net-profit ≥ 0 when COD data exists).
//
// The winner-scaling plan reuses the EXISTING Campaign Clone & Schedule
// engine verbatim: it builds a normal (unapproved) clone batch from the
// campaigns already running the winning asset. Nothing is created on Meta
// before the owner's APPROVE & SCHEDULE on that batch.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { resolveWindow } from './metricsEngine.js';
import { getAmbSettings } from './settings.js';
import { assetPerformance, assetProfit } from './mediaLibrary.js';
import { createBatch } from './cloneEngine.js';

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function j(v, d) { try { return v ? JSON.parse(v) : d; } catch { return d; } }

function dataSufficiency(perf, gate) {
  if (perf.spend >= gate.minSpend * 2 && (perf.purchases || 0) >= gate.minPurchases) return 'STRONG';
  if (perf.spend >= gate.minSpend && (perf.purchases || 0) >= Math.max(1, Math.round(gate.minPurchases / 2))) return 'MODERATE';
  return 'WEAK';
}

function serialize(s) {
  return {
    assetId: s.asset.id,
    name: s.asset.asset_name || `Creative ${s.asset.id}`,
    format: s.asset.primary_format,
    thumbnailUrl: s.asset.thumbnail_url || null,
    productId: s.asset.amb_product_id || null,
    productName: s.asset.amb_product?.product_name || null,
    hook: s.asset.hook || null,
    sellingAngle: s.asset.selling_angle || null,
    accounts: s.accounts,
    accountCount: s.accounts.length,
    performance: s.perf,
    byAccount: s.byAccount,
    profit: s.profit,
    dataSufficiency: s.dataSuff,
    confidence: { STRONG: 'HIGH', MODERATE: 'MEDIUM', WEAK: 'LOW' }[s.dataSuff],
    reason: s.reason || null,
  };
}

export async function mediaLibraryIntel({ windowName } = {}) {
  const window = resolveWindow(windowName || 'last7');
  const settings = await getAmbSettings();
  const gate = {
    minSpend: Number(settings.ambMinSpendBeforeDecision) || 150,
    minPurchases: Number(settings.ambMinPurchasesBeforeScaling) || 5,
  };
  const target = Number(settings.ambDefaultTargetCpa) || 120;
  const scaleCpa = target * (1 - (Number(settings.ambScaleCpaBetterPct) || 10) / 100);

  const assets = await prisma.mediaLibraryAsset.findMany({
    include: { amb_product: { select: { id: true, product_name: true, target_cpa: true } }, refs: { select: { ad_account_id: true, creative_id: true } } },
  });

  const scored = [];
  for (const a of assets) {
    const creativeIds = a.refs.map((r) => r.creative_id);
    if (!creativeIds.length) continue;
    const perf = await assetPerformance({ creativeIds, from: window.from, to: window.to });
    if (!perf.total || (perf.total.spend || 0) <= 0) continue;
    const profit = await assetProfit({ ambProductId: a.amb_product_id, spend: perf.total.spend, from: window.from, to: window.to });
    const accounts = perf.byAccount.filter((x) => (x.spend || 0) > 0).map((x) => x.adAccountId);
    scored.push({ asset: a, perf: perf.total, byAccount: perf.byAccount, profit, accounts, dataSuff: dataSufficiency(perf.total, gate) });
  }

  const tgtFor = (s) => n(s.asset.amb_product?.target_cpa) ?? target;
  const isWinner = (s) => {
    if (s.dataSuff === 'WEAK') return false;
    if (s.perf.cpa == null || (s.perf.purchases || 0) < gate.minPurchases) return false;
    const t = tgtFor(s);
    if (s.perf.cpa > t * (1 - (Number(settings.ambScaleCpaBetterPct) || 10) / 100)) return false;
    if (s.profit.netProfit != null && s.profit.netProfit <= 0) return false; // profitability gate when COD data exists
    return true;
  };
  const isLoser = (s) => {
    if ((s.perf.spend || 0) < gate.minSpend) return false;
    if ((s.perf.purchases || 0) === 0) return true;
    if (s.profit.netProfit != null && s.profit.netProfit < 0) return true;
    if (s.perf.cpa != null && s.perf.cpa > tgtFor(s) * 1.5) return true;
    return false;
  };

  const winReason = (s) => {
    const bits = [`CPA ${s.perf.cpa.toFixed(1)} ج مقابل هدف ${Math.round(tgtFor(s))} ج`, `${s.perf.purchases} شراء بصرف ${Math.round(s.perf.spend)} ج`];
    if (s.profit.netProfit != null) bits.push(`صافي ربح ${Math.round(s.profit.netProfit)} ج (اقتصاديات المنتج)`);
    if (s.perf.roas != null) bits.push(`ROAS ${s.perf.roas.toFixed(1)}×`);
    bits.push(`كفاية بيانات ${s.dataSuff === 'STRONG' ? 'قوية' : 'كافية'}`);
    if (s.accounts.length > 1) bits.push(`رابح في ${s.accounts.length} حسابات`);
    return bits.join(' · ');
  };
  const loseReason = (s) => {
    if ((s.perf.purchases || 0) === 0) return `صرف ${Math.round(s.perf.spend)} ج من غير أي شراء.`;
    if (s.profit.netProfit != null && s.profit.netProfit < 0) return `صافي ربح سالب (${Math.round(s.profit.netProfit)} ج) بصرف ${Math.round(s.perf.spend)} ج.`;
    return `CPA ${s.perf.cpa?.toFixed(1)} ج فوق ضعف الهدف (${Math.round(tgtFor(s))} ج).`;
  };

  const winners = scored.filter(isWinner).map((s) => ({ ...s, reason: winReason(s) })).sort((a, b) => a.perf.cpa - b.perf.cpa);
  const losers = scored.filter(isLoser).map((s) => ({ ...s, reason: loseReason(s) })).sort((a, b) => (b.perf.spend || 0) - (a.perf.spend || 0));

  // Best creative per product (lowest CPA among that product's winners, else its best-scoring scored asset with MODERATE+ data).
  const byProduct = new Map();
  for (const s of scored) {
    if (!s.asset.amb_product_id) continue;
    const cur = byProduct.get(s.asset.amb_product_id);
    const better = !cur
      || (isWinner(s) && !isWinner(cur))
      || (isWinner(s) === isWinner(cur) && s.perf.cpa != null && (cur.perf.cpa == null || s.perf.cpa < cur.perf.cpa));
    if (better) byProduct.set(s.asset.amb_product_id, s);
  }
  const bestPerProduct = [...byProduct.values()]
    .filter((s) => s.dataSuff !== 'WEAK' && s.perf.cpa != null)
    .map((s) => ({ ...serialize({ ...s, reason: winReason(s) }), isWinner: isWinner(s) }));

  // Best creative across multiple ad accounts.
  const crossAccount = winners.filter((s) => s.accounts.length >= 2).map(serialize);

  // Winning hook / angle — group scored assets by label, aggregate, gate on data + a real gap.
  const groupBy = (field) => {
    const g = new Map();
    for (const s of scored) {
      const label = (s.asset[field] || '').trim();
      if (!label) continue;
      if (!g.has(label)) g.set(label, { label, spend: 0, purchases: 0, clicks: 0, impressions: 0, assets: 0 });
      const x = g.get(label);
      x.spend += s.perf.spend || 0; x.purchases += s.perf.purchases || 0;
      x.clicks += s.perf.clicks || 0; x.impressions += s.perf.impressions || 0; x.assets++;
    }
    const rows = [...g.values()].map((x) => ({
      label: x.label, assets: x.assets, spend: x.spend, purchases: x.purchases,
      cpa: x.purchases > 0 ? x.spend / x.purchases : null,
      ctr: x.impressions > 0 ? (x.clicks / x.impressions) * 100 : null,
      dataSufficiency: dataSufficiency(x, gate),
    })).sort((a, b) => (a.cpa == null) - (b.cpa == null) || (a.cpa - b.cpa));
    const elig = rows.filter((r) => r.spend >= gate.minSpend && r.purchases >= Math.max(1, Math.round(gate.minPurchases / 2)) && r.cpa != null && r.dataSufficiency !== 'WEAK');
    let winner = null;
    if (elig.length) {
      const w = elig[0], second = elig[1];
      const gap = second?.cpa ? (second.cpa - w.cpa) / second.cpa : 1;
      winner = { ...w, why: `أقل CPA (${w.cpa.toFixed(1)} ج)${second ? ` مقابل «${second.label}» (${second.cpa.toFixed(1)} ج، فرق ${Math.round(gap * 100)}%)` : ''} عبر ${w.assets} كرياتيف.` };
    }
    return { winner, table: rows };
  };

  return {
    window,
    thresholds: { targetCpa: target, scaleCpa, minSpend: gate.minSpend, minPurchases: gate.minPurchases },
    counts: { assets: assets.length, scored: scored.length, winners: winners.length, losers: losers.length },
    winners: winners.map((s) => serialize(s)),
    losers: losers.map((s) => serialize(s)),
    bestPerProduct,
    crossAccount,
    winningHook: groupBy('hook'),
    winningAngle: groupBy('selling_angle'),
  };
}

// ---------------------------------------------------------------------------
// Winner scaling → a normal (unapproved) Clone & Schedule batch
// ---------------------------------------------------------------------------
/**
 * Build a scaling plan for a winning asset: pick the source account where it
 * spends most, find the campaigns running it there, and create a PENDING
 * Clone & Schedule batch to the chosen destination accounts. Nothing is sent
 * to Meta — the owner reviews + approves that batch through the existing flow.
 */
export async function buildScalingPlan({ assetId, destinationAccountIds, scheduleLocalTime, destinationPageId = null, recreateBoosted = false, windowName, userId }) {
  const dests = [...new Set((destinationAccountIds || []).filter(Boolean))];
  if (!dests.length) { const e = new Error('اختر حساب وجهة واحد على الأقل.'); e.status = 400; throw e; }

  const asset = await prisma.mediaLibraryAsset.findUnique({ where: { id: Number(assetId) }, include: { refs: true } });
  if (!asset) { const e = new Error('الكرياتيف مش موجود في المكتبة.'); e.status = 404; throw e; }

  const window = resolveWindow(windowName || 'last7');
  const perf = await assetPerformance({ creativeIds: asset.refs.map((r) => r.creative_id), from: window.from, to: window.to });
  const ranked = [...perf.byAccount].sort((a, b) => (b.spend || 0) - (a.spend || 0));
  const sourceAccountId = ranked[0]?.adAccountId
    || asset.refs.map((r) => r.ad_account_id).find((id) => !dests.includes(id))
    || asset.refs[0]?.ad_account_id;
  if (!sourceAccountId) { const e = new Error('مفيش حساب مصدر معروف لهذا الكرياتيف.'); e.status = 400; throw e; }
  if (dests.includes(sourceAccountId)) { const e = new Error('حساب المصدر ضمن حسابات الوجهة — استبعده.'); e.status = 400; throw e; }

  // Source campaigns = the campaigns that ran this asset's creatives in the
  // source account within the window (from snapshots).
  const srcCreativeIds = asset.refs.filter((r) => r.ad_account_id === sourceAccountId).map((r) => r.creative_id);
  const rows = await prisma.metaPerformanceSnapshot.groupBy({
    by: ['campaign_id', 'campaign_name'],
    where: { level: 'ad', ad_account_id: sourceAccountId, creative_id: { in: srcCreativeIds.length ? srcCreativeIds : ['__none__'] }, date_start: { gte: window.from, lte: window.to } },
    _sum: { spend: true },
  });
  const campaignIds = rows.filter((r) => r.campaign_id).sort((a, b) => (b._sum.spend || 0) - (a._sum.spend || 0)).map((r) => r.campaign_id);
  if (!campaignIds.length) { const e = new Error('مفيش حملات معروفة في حساب المصدر تشغّل هذا الكرياتيف خلال الفترة — زامن الحساب الأول.'); e.status = 400; throw e; }

  const batch = await createBatch({
    batchId: crypto.randomUUID(),
    sourceAccountId,
    destinationAccountIds: dests,
    campaignIds,
    scheduleLocalTime,
    destinationPageId,
    recreateBoosted,
    userId,
  });

  const reason = `كرياتيف رابح — CPA ${perf.total.cpa != null ? perf.total.cpa.toFixed(1) : '—'} ج، ${perf.total.purchases || 0} شراء بصرف ${Math.round(perf.total.spend)} ج عبر ${perf.byAccount.length} حساب.`;
  const scaling = await prisma.mediaLibraryScaling.create({
    data: {
      asset_id: asset.id,
      source_ad_account_id: sourceAccountId,
      source_campaign_ids_json: JSON.stringify(campaignIds),
      destination_account_ids_json: JSON.stringify(dests),
      clone_batch_id: batch.batchId,
      status: 'BATCH_CREATED',
      reason,
      created_by_id: userId || null,
    },
  });
  logger.info('AMB media library scaling plan created', { assetId: asset.id, batchId: batch.batchId, sourceAccountId, campaigns: campaignIds.length, dests: dests.length });
  return { scalingId: scaling.id, sourceAccountId, campaignIds, batch };
}
