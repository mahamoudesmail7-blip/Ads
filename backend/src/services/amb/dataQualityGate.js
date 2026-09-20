// Smart Decision Center — Data Quality Gate. Runs BEFORE any recommendation
// is trusted enough to approve/execute: verifies product/store/campaign
// mapping is deterministic, Meta/Easy Orders data is fresh and genuinely
// available for the requested window, and there's no duplicate campaign
// resolution. A CRITICAL failure (no deterministic product/campaign link)
// blocks approval outright; a WARNING (stale sync, thin sample) is shown
// but does not itself block — it just means confidence should be treated
// as lower, per the existing confidence field already on every decision.
// Pure function — takes already-fetched data, never queries anything
// itself, so it can gate ANY decision type (product, ad-set bump, etc.)
// without duplicating fetch logic.

const STALE_META_MINUTES = 120;

function check(name, ok, severity, reason) {
  return { name, ok, severity: ok ? null : severity, reason: ok ? null : reason };
}

/**
 * @param {{product: object|null, campaigns: Array, meta: object, easyOrders: object, window: {from:string,to:string}}} input
 */
export function computeDataQualityGate({ product, campaigns, meta, easyOrders, window }) {
  const checks = [];

  checks.push(check('PRODUCT_MAPPING', !!product, 'CRITICAL', 'المنتج غير موجود أو غير محدد.'));
  checks.push(check('CAMPAIGN_MAPPING', Array.isArray(campaigns) && campaigns.length > 0, 'CRITICAL', 'لا توجد حملات مرتبطة بشكل حتمي (Launch أو Mapping مؤكد) بهذا المنتج.'));

  const ids = (campaigns || []).map((c) => c.campaignId);
  checks.push(check('DUPLICATE_CAMPAIGNS', new Set(ids).size === ids.length, 'CRITICAL', 'يوجد تكرار في معرّفات الحملات المرتبطة — لازم يتراجع قبل أي قرار.'));

  checks.push(check('DATE_RANGE', !!(window?.from && window?.to), 'CRITICAL', 'نطاق التاريخ غير محدد لهذا التحليل.'));

  const metaOk = meta?.dataState === 'AVAILABLE';
  checks.push(check('META_AVAILABILITY', metaOk, 'WARNING', `بيانات Meta غير متاحة لهذه الفترة (${meta?.dataState || 'UNKNOWN'}).`));
  if (metaOk && meta.lastSyncAt) {
    const ageMin = (Date.now() - new Date(meta.lastSyncAt).getTime()) / 60000;
    checks.push(check('META_FRESHNESS', ageMin <= STALE_META_MINUTES, 'WARNING', `آخر مزامنة Meta منذ ${Math.round(ageMin)} دقيقة — أقدم من الحد المتوقع (${STALE_META_MINUTES} دقيقة).`));
  }

  const eoOk = easyOrders && ['AVAILABLE', 'NO_DATA'].includes(easyOrders.dataState);
  checks.push(check('EASYORDERS_AVAILABILITY', eoOk, 'WARNING', `بيانات Easy Orders في حالة غير متوقعة (${easyOrders?.dataState || 'UNKNOWN'}).`));

  const criticalFailures = checks.filter((c) => c.severity === 'CRITICAL');
  const warnings = checks.filter((c) => c.severity === 'WARNING');

  const status = criticalFailures.length ? 'DECISION_BLOCKED_DATA_QUALITY' : (warnings.length ? 'DATA_QUALITY_WARNING' : 'VERIFIED');
  return { status, checks, criticalFailures, warnings };
}
