// metaSync.js — pulls real Insights from the Meta Marketing API and writes
// them into the EXACT same AdsDailyMetric shape the CSV-upload path
// (adsImport.js / routes/adsIntelligence.js POST /uploads/:id/process)
// already produces. This is deliberate: campaignAnalysis.js,
// decisionEngine.js, productAnalysis.js, and aiActionPlan.js all read
// AdsDailyMetric with no idea where a row came from — so a real API sync
// makes the whole AI Intelligence pipeline "real" with zero changes to any
// analysis file.
import { prisma } from '../prisma.js';
import { getDecryptedToken, getConnection, markSynced } from './metaAuth.js';
import { getInsights } from './metaGraphClient.js';
import { matchCampaignToProduct } from './adsImport.js';

// Meta's UI "Results" column is objective-dependent — the API has no single
// "results" field. For this app's real use case (COD e-commerce, campaigns
// almost always optimized toward purchases), prefer a purchase-type action
// when present; otherwise fall back to whichever action_type has the
// highest count, honestly labelled via result_indicator either way. Never
// silently mislabels one action type as another.
const PURCHASE_ACTION_TYPES = new Set([
  'omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase', 'onsite_web_app_purchase', 'onsite_conversion.purchase',
]);

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Picks the "results" figure + which action_type it actually came from, from Meta's raw `actions`/`action_values`/`cost_per_action_type` arrays. */
function extractResults(row) {
  const actions = row.actions || [];
  const purchaseAction = actions.find((a) => PURCHASE_ACTION_TYPES.has(a.action_type));
  const chosen = purchaseAction || [...actions].sort((a, b) => Number(b.value) - Number(a.value))[0] || null;
  if (!chosen) return { results: null, resultIndicator: null, revenue: null, costPerResult: null };

  const actionValues = row.action_values || [];
  const valueEntry = actionValues.find((a) => a.action_type === chosen.action_type);
  const costEntry = (row.cost_per_action_type || []).find((a) => a.action_type === chosen.action_type);

  return {
    results: toNum(chosen.value),
    resultIndicator: chosen.action_type,
    revenue: valueEntry ? toNum(valueEntry.value) : null,
    costPerResult: costEntry ? toNum(costEntry.value) : null,
  };
}

/**
 * @param {{dateFrom: string, dateTo: string, triggeredById: number}} params
 * @returns {Promise<{rowsSynced: number, dateFrom: string, dateTo: string, uploadId: number}>}
 */
export async function runSync({ dateFrom, dateTo, triggeredById }) {
  const connection = await getConnection();
  if (!connection || connection.status !== 'CONNECTED') throw new Error('مفيش حساب Meta Ads متصل دلوقتي.');
  if (!connection.selected_ad_account_id) throw new Error('لازم تختار Ad Account الأول قبل المزامنة.');

  const token = await getDecryptedToken();
  const adAccountId = connection.selected_ad_account_id;

  const insightRows = await getInsights(token, adAccountId, dateFrom, dateTo);

  const products = await prisma.product.findMany({ select: { id: true, product_name: true, sku: true } });
  const matchCache = new Map();

  const metricRows = insightRows.map((row) => {
    const { results, resultIndicator, revenue, costPerResult } = extractResults(row);
    const campaignName = row.campaign_name || null;
    if (!matchCache.has(campaignName)) matchCache.set(campaignName, matchCampaignToProduct(campaignName, products));
    const match = matchCache.get(campaignName);

    return {
      date: row.date_start,
      campaign_id: row.campaign_id || null,
      campaign_name: campaignName,
      adset_id: row.adset_id || null,
      adset_name: row.adset_name || null,
      ad_id: row.ad_id || null,
      ad_name: row.ad_name || null,
      spend: toNum(row.spend) ?? 0,
      impressions: toNum(row.impressions),
      reach: toNum(row.reach),
      frequency: toNum(row.frequency),
      clicks: toNum(row.clicks),
      ctr: toNum(row.ctr),
      cpc: toNum(row.cpc),
      cpm: toNum(row.cpm),
      meta_purchases: PURCHASE_ACTION_TYPES.has(resultIndicator) ? Math.round(results ?? 0) : null,
      meta_revenue: revenue,
      meta_roas: row.purchase_roas?.[0]?.value ? toNum(row.purchase_roas[0].value) : null,
      results: results !== null ? Math.round(results) : null,
      cost_per_result: costPerResult,
      result_indicator: resultIndicator,
      campaign_delivery: null, // Insights doesn't carry effective_status — never fabricated; active-filtering falls back to spend>0 for these rows
      matched_product_id: match.productId,
      match_confidence: match.confidence,
      match_method: match.method,
    };
  });

  const upload = await prisma.adsUpload.create({
    data: {
      filename: `Meta API Sync ${dateFrom}..${dateTo}`,
      file_type: 'meta_api',
      status: 'PROCESSED',
      row_count: metricRows.length,
      uploaded_by_id: triggeredById || null,
      processed_at: new Date(),
    },
  });

  // Same "re-sync replaces, never duplicates" rule already established for
  // CSV re-uploads this session — API data is the authoritative real source
  // for any date it covers, regardless of whether older rows for that date
  // came from a CSV or an earlier sync.
  const distinctDates = [...new Set(metricRows.map((r) => r.date).filter(Boolean))];
  if (distinctDates.length > 0) {
    await prisma.adsDailyMetric.deleteMany({ where: { date: { in: distinctDates } } });
  }
  if (metricRows.length > 0) {
    await prisma.adsDailyMetric.createMany({ data: metricRows.map((r) => ({ ...r, upload_id: upload.id })) });
  }

  await markSynced();

  return { rowsSynced: metricRows.length, dateFrom, dateTo, uploadId: upload.id };
}
