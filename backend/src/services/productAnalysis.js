// Product-first aggregation — AI Intelligence Phase 2. Turns active-filtered
// AdsDailyMetric rows into "entities": campaigns mapped to a product are
// grouped and weighted-summed under that product (via aggregateMetrics from
// campaignAnalysis.js — spend/results totals, never an average of CPAs);
// unmapped campaigns become standalone entities so ads analysis is never
// blocked on product mapping (explicit user rule). Every entity also carries
// its internal campaign breakdown (for the "protect the good campaign, stop
// the bad one" drill-down) and an ad-level breakdown when ad_name is present
// in the source data — this export's real data has none, so that breakdown
// legitimately comes back null and the UI must say why, never fake it.
import { aggregateMetrics, aggregateByCampaign } from './campaignAnalysis.js';

/** A row counts toward the main dashboard only if it shows real current activity — spend, or an explicit "active" delivery status. Historical/inactive rows are never deleted, just excluded here. */
export function isRelevantRow(row) {
  return (row.spend || 0) > 0 || row.campaign_delivery === 'active';
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const key = keyFn(r) || '(بدون اسم)';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

/** Ad-level breakdown reusing aggregateByCampaign's grouping (same trick as campaign-detail's relatedAds) — null when the source data has no ad_name column, so the UI can say why instead of showing an empty table. */
function buildAdBreakdown(rows) {
  const withAd = rows.filter((r) => r.ad_name);
  if (withAd.length === 0) return null;
  return aggregateByCampaign(withAd.map((r) => ({ ...r, campaign_name: r.ad_name })));
}

/**
 * @param {object[]} rows AdsDailyMetric rows, already filtered to isRelevantRow
 * @param {object[]} products Product.findMany() result (needs id + product_name)
 * @returns {object[]} entities: {entityType: 'product'|'campaign', entityKey, entityName, campaigns, adBreakdown, ...aggregateMetrics}
 */
export function buildEntities(rows, products) {
  const productById = new Map(products.map((p) => [p.id, p]));
  const byProduct = new Map();
  const unmapped = [];

  for (const r of rows) {
    if (r.matched_product_id && productById.has(r.matched_product_id)) {
      if (!byProduct.has(r.matched_product_id)) byProduct.set(r.matched_product_id, []);
      byProduct.get(r.matched_product_id).push(r);
    } else {
      unmapped.push(r);
    }
  }

  const entities = [];

  for (const [productId, prodRows] of byProduct.entries()) {
    const product = productById.get(productId);
    const campaigns = aggregateByCampaign(prodRows).sort((a, b) => (a.cpa === null) - (b.cpa === null) || a.cpa - b.cpa);
    entities.push({
      entityType: 'product',
      entityKey: String(productId),
      entityName: product.product_name,
      campaigns,
      adBreakdown: buildAdBreakdown(prodRows),
      ...aggregateMetrics(prodRows),
    });
  }

  const byCampaignName = groupBy(unmapped, (r) => r.campaign_name);
  for (const [name, campRows] of byCampaignName.entries()) {
    entities.push({
      entityType: 'campaign',
      entityKey: name,
      entityName: name,
      campaigns: null, // a standalone campaign has no product-level breakdown to drill into
      adBreakdown: buildAdBreakdown(campRows),
      delivery: campRows.find((r) => r.campaign_delivery)?.campaign_delivery || null,
      ...aggregateMetrics(campRows),
    });
  }

  return entities;
}
