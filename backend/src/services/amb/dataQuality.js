// Data Reconciliation / Data Quality layer (2026-10-01) — a PERMANENT,
// store-scoped diagnostic surfacing exactly what the Smart-EarCleaner audit
// found by hand, for EVERY product, automatically: whether Meta campaign
// purchases, Meta age/gender/region breakdown purchases, and Easy Orders all
// agree, whether the Meta campaign mapping itself is healthy, and whether
// anything shown is stale. Never a second analytics pipeline — every number
// here is read from the SAME already-synced sources every other AMB view
// reads from (MetaPerformanceSnapshot via entityWindowMetrics, the cached
// audience_breakdown_json, EasyOrdersOrder) — this module only JUDGES them.
//
// Five distinct states, never conflated (the explicit ask that started
// this): a bucket is exactly one of OK / ZERO / UNKNOWN / UNAVAILABLE /
// STALE / MAPPING_ERROR — "Meta genuinely reported 0" and "we don't know"
// must never render as the same thing, and a breakdown Meta itself doesn't
// support for this account must never be scored as a failure.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection } from '../metaAuth.js';
import { resolveProductCampaigns } from './productPerformance.js';
import { entityWindowMetrics, resolveWindow } from './metricsEngine.js';
import { getSyncStatus } from './snapshotSync.js';
import { verifyProductStoreScope } from './storeScope.js';
import { getStoreStatusTrust } from '../easyOrdersStatus.js';

function j(v, d = null) { try { return v ? JSON.parse(v) : d; } catch { return d; } }

// A cached breakdown older than this is treated as STALE even if its
// campaignIds still match the current mapping — Meta purchase attribution
// keeps landing for hours after spend happens, so "freshly computed right
// after launch" can legitimately still be behind reality.
const BREAKDOWN_STALE_MS = 24 * 60 * 60 * 1000;

function sumPurchases(rows) { return (rows || []).reduce((s, r) => s + (r.purchases || 0), 0); }

/**
 * Judges ONE already-computed breakdown dimension (age / gender / region)
 * against the campaign-level truth. `combo` is the raw combos[key] entry
 * metaAudienceBreakdown.js stored (status: AVAILABLE/EMPTY/UNSUPPORTED/
 * PERMISSION_DENIED/ERROR), `rows` is the already-aggregated age/gender/
 * region array from the same cached result.
 */
function judgeBreakdown({ combo, rows, campaignPurchases, isStale }) {
  if (!combo) return { status: 'UNKNOWN', reason: 'لم يتم تجربة هذا التقسيم بعد.', purchases: null, reconciled: null };
  if (combo.status === 'UNSUPPORTED' || combo.status === 'PERMISSION_DENIED') {
    return { status: 'UNAVAILABLE', reason: combo.reason || 'Meta لا توفر هذا التقسيم لهذا الحساب — ليس خطأ في النظام.', purchases: null, reconciled: null };
  }
  if (combo.status === 'ERROR') {
    return { status: 'UNKNOWN', reason: combo.reason || 'تعذّر تنفيذ الطلب وقت الحساب.', purchases: null, reconciled: null };
  }
  if (combo.status === 'EMPTY' || !rows?.length) {
    return { status: 'UNKNOWN', reason: 'مفيش صفوف حقيقية رجعت من Meta لهذا التقسيم في هذه الفترة.', purchases: null, reconciled: null };
  }
  const purchases = sumPurchases(rows);
  if (isStale) {
    return { status: 'STALE', reason: `آخر حساب لهذا التقسيم أقدم من ${Math.round(BREAKDOWN_STALE_MS / 3_600_000)} ساعة — قد لا يعكس حملات أو مشتريات حديثة.`, purchases, reconciled: null };
  }
  if (campaignPurchases == null) {
    return { status: 'UNKNOWN', reason: 'عدد مشتريات الحملة نفسه غير متاح للمقارنة.', purchases, reconciled: null };
  }
  // Real, observed Meta behavior (region breakdown, 2026-10-01 audit): Meta
  // can return a fully AVAILABLE combo with real spend/reach on every row,
  // yet report literally ZERO purchase-type actions anywhere in it, even
  // while the same campaigns clearly have real purchases at the campaign
  // level — Meta's own purchase attribution frequently doesn't resolve at
  // finer breakdown granularity (region especially). That is Meta's own
  // reporting gap, not a reconciliation failure — scored UNAVAILABLE, never
  // MISMATCH, exactly matching the explicit "don't require region to match
  // if Meta doesn't actually provide it" instruction. A genuine double-zero
  // (campaign also 0) still reconciles as a real, confident OK below.
  if (purchases === 0 && campaignPurchases > 0) {
    return { status: 'UNAVAILABLE', reason: `Meta أرجعت بيانات صرف ووصول حقيقية لهذا التقسيم لكن بدون أي نشاط شراء منسوب إطلاقًا، رغم وجود ${campaignPurchases} مشترى حقيقي على مستوى الحملة لنفس الفترة — الأغلب إن Meta لا تُسند المشتريات لهذا التقسيم بدقة لهذا الحساب، مش أن المشتريات صفر فعليًا.`, purchases, reconciled: null };
  }
  const reconciled = purchases === campaignPurchases;
  return {
    status: reconciled ? 'OK' : 'MISMATCH',
    reason: reconciled ? null : `مجموع التقسيم (${purchases}) لا يطابق إجمالي الحملة (${campaignPurchases}).`,
    purchases, reconciled,
  };
}

/**
 * The reusable core — ONE product, already known to belong to `storeId`.
 * Callable from the PMC route, the global audit script, AND the AI tool
 * gate (get_data_quality / the pre-flight check other tools call before
 * trusting age/gender/geo evidence) — never a second implementation.
 */
export async function computeProductDataQuality({ productId, storeId, windowName = 'today' }) {
  const pid = Number(productId);
  const scope = await verifyProductStoreScope({ productId: pid, storeId });
  if (!scope.ok) return { ok: false, code: scope.code, reason: scope.reason };

  const product = await prisma.product.findUnique({ where: { id: pid }, select: { id: true, product_name: true, store_id: true } });
  const ambProduct = await prisma.ambProduct.findUnique({ where: { product_id: pid } });

  const mappingErrors = [];
  if (!ambProduct) {
    return {
      ok: true, productId: pid, productName: product?.product_name || null, storeId,
      mapping: { status: 'MAPPING_ERROR', reason: 'لا يوجد ربط Meta لهذا المنتج بعد (مفيش AmbProduct).', includedCampaignIds: [] },
      campaignPurchases: { status: 'MAPPING_ERROR', value: null },
      age: { status: 'MAPPING_ERROR', reason: null, purchases: null, reconciled: null },
      gender: { status: 'MAPPING_ERROR', reason: null, purchases: null, reconciled: null },
      region: { status: 'MAPPING_ERROR', reason: null, purchases: null, reconciled: null },
      easyOrders: { total: 0, mapped: 0, unmapped: 0, lastSyncAt: null, statusTrust: await getStoreStatusTrust(storeId || null).catch(() => null) },
      freshness: { metaLastSyncAt: null, breakdownGeneratedAt: null },
      overallStatus: 'MAPPING_ERROR',
      discrepancies: ['لا يوجد ربط Meta (AmbProduct) لهذا المنتج.'],
    };
  }

  const mapped = await prisma.ambProductCampaignMap.findMany({ where: { amb_product_id: ambProduct.id, status: 'MAPPED' }, select: { campaign_id: true } });
  const mappedIds = new Set(mapped.map((m) => m.campaign_id));
  const resolved = await resolveProductCampaigns(pid).catch(() => []);
  const resolvedIds = new Set(resolved.map((r) => r.campaignId));

  // A real, previously-invisible class of mismatch: Live Campaign
  // Intelligence/Scale Center resolve a WIDER campaign set (Launch-wizard
  // campaigns unioned with MAPPED ones) than the Audience/Governorate
  // breakdown (MAPPED-only) — two different views of "this product's
  // campaigns" that can legitimately disagree. Surfaced, never silently
  // picked one as "the" truth.
  const onlyInWiderSet = [...resolvedIds].filter((id) => !mappedIds.has(id));
  if (!mappedIds.size) {
    mappingErrors.push('لا توجد حملات Meta مؤكدة (MAPPED) لهذا المنتج — تقسيمات الجمهور لن تُحسب.');
  }
  if (onlyInWiderSet.length) {
    mappingErrors.push(`${onlyInWiderSet.length} حملة مرتبطة عبر الإطلاق (Launch) لكن غير مؤكدة (MAPPED) بعد — غير مُضمّنة في تحليل الجمهور.`);
  }

  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id || null;
  const window = resolveWindow(windowName);

  // Campaign-level purchases — from already-synced MetaPerformanceSnapshot,
  // never a fresh Meta call (same source every other AMB view reads).
  let campaignPurchases = null;
  let campaignPurchasesStatus = 'UNKNOWN';
  if (!adAccountId) {
    campaignPurchasesStatus = 'UNAVAILABLE';
  } else if (mappedIds.size) {
    try {
      const metricsMap = await entityWindowMetrics({ level: 'campaign', from: window.from, to: window.to, adAccountId });
      let sum = 0; let anyFound = false;
      for (const id of mappedIds) { const m = metricsMap.get(id); if (m) { anyFound = true; sum += m.purchases || 0; } }
      campaignPurchases = anyFound ? sum : null;
      campaignPurchasesStatus = anyFound ? 'OK' : 'UNKNOWN';
    } catch (err) {
      logger.warn('[dataQuality] entityWindowMetrics failed', { productId: pid, message: err.message });
      campaignPurchasesStatus = 'UNKNOWN';
    }
  } else {
    campaignPurchasesStatus = 'MAPPING_ERROR';
  }

  // The cached audience breakdown — the MOST RECENTLY UPDATED profile for
  // this product is treated as canonical (a product can have several
  // historical PMC profiles; this mirrors which one a user would actually
  // be looking at). Never force-recomputed here — a global audit must never
  // hammer Meta for every product; staleness is judged and reported
  // honestly instead.
  const profile = await prisma.productMarketingProfile.findFirst({ where: { product_id: pid }, orderBy: { updated_at: 'desc' }, select: { id: true } });
  let breakdown = null;
  let breakdownGeneratedAt = null;
  if (profile) {
    const snap = await prisma.productMarketingSnapshot.findUnique({ where: { profile_id_window_name: { profile_id: profile.id, window_name: windowName } }, select: { audience_breakdown_json: true } });
    breakdown = j(snap?.audience_breakdown_json, null);
    breakdownGeneratedAt = breakdown?.generatedAt || null;
  }

  const isStale = breakdownGeneratedAt ? (Date.now() - new Date(breakdownGeneratedAt).getTime() > BREAKDOWN_STALE_MS) : false;
  // Defense-in-depth beyond the age check: if the cached breakdown's own
  // campaignIds no longer match the CURRENT mapped set (e.g. the 2026-10-01
  // invalidation-on-confirm fix somehow didn't fire, or a campaign was
  // un-mapped since), that is its own staleness signal regardless of age.
  const cachedCampaignIds = new Set(breakdown?.campaignIds || []);
  const campaignSetChanged = breakdown ? (cachedCampaignIds.size !== mappedIds.size || [...mappedIds].some((id) => !cachedCampaignIds.has(id))) : false;
  const breakdownStale = isStale || campaignSetChanged;

  const age = !ambProduct ? { status: 'MAPPING_ERROR', reason: null, purchases: null, reconciled: null }
    : !breakdown ? { status: 'UNKNOWN', reason: 'لم يُحسب تقسيم جمهور بعد لهذا المنتج.', purchases: null, reconciled: null }
    : judgeBreakdown({ combo: breakdown.combos?.['age,gender'] || breakdown.combos?.age, rows: breakdown.age, campaignPurchases, isStale: breakdownStale });
  const gender = !ambProduct ? { status: 'MAPPING_ERROR', reason: null, purchases: null, reconciled: null }
    : !breakdown ? { status: 'UNKNOWN', reason: 'لم يُحسب تقسيم جمهور بعد لهذا المنتج.', purchases: null, reconciled: null }
    : judgeBreakdown({ combo: breakdown.combos?.['age,gender'] || breakdown.combos?.gender, rows: breakdown.gender, campaignPurchases, isStale: breakdownStale });
  const region = !ambProduct ? { status: 'MAPPING_ERROR', reason: null, purchases: null, reconciled: null }
    : !breakdown ? { status: 'UNKNOWN', reason: 'لم يُحسب تقسيم جمهور بعد لهذا المنتج.', purchases: null, reconciled: null }
    : judgeBreakdown({ combo: breakdown.combos?.region, rows: breakdown.region, campaignPurchases, isStale: breakdownStale });

  // Easy Orders — "mapped" means usable for governorate/COD analysis (has a
  // real customer_government on the order), never a fabricated Meta-ad
  // linkage (Easy Orders carries no campaign/ad/creative id at all — see
  // schema.prisma's own documented comment on EasyOrdersOrder.tracking_json).
  const eoWhere = { product_id: pid, ...(storeId ? { store_id: storeId } : {}) };
  const [eoTotal, eoMapped, eoLast] = await Promise.all([
    prisma.easyOrdersOrder.count({ where: eoWhere }),
    prisma.easyOrdersOrder.count({ where: { ...eoWhere, customer_government: { not: null } } }),
    prisma.easyOrdersOrder.aggregate({ where: eoWhere, _max: { updated_at: true } }),
  ]);
  const statusTrust = await getStoreStatusTrust(storeId || null).catch(() => null);
  const easyOrders = { total: eoTotal, mapped: eoMapped, unmapped: eoTotal - eoMapped, lastSyncAt: eoLast._max.updated_at || null, statusTrust };

  const syncStatus = await getSyncStatus().catch(() => null);

  const discrepancies = [...mappingErrors];
  for (const [label, d] of [['العمر', age], ['الجنس', gender], ['المنطقة', region]]) {
    if (d.status === 'MISMATCH') discrepancies.push(`تضارب حقيقي: مشتريات تقسيم ${label} لا تطابق مشتريات الحملة.`);
  }
  if (campaignPurchasesStatus === 'UNAVAILABLE') discrepancies.push('لا يوجد حساب إعلانات Meta متصل — تعذّر حساب مشتريات الحملة.');

  // Overall status precedence — a real MISMATCH/MAPPING_ERROR always wins
  // over a benign UNAVAILABLE/UNKNOWN, which always wins over a clean OK.
  // STALE is a WARNING, never a hard failure (the data may still be right).
  const dims = [age, gender, region];
  let overallStatus;
  if (campaignPurchasesStatus === 'MAPPING_ERROR' || mappingErrors.some((m) => m.includes('لا توجد حملات'))) overallStatus = 'MAPPING_ERROR';
  else if (dims.some((d) => d.status === 'MISMATCH')) overallStatus = 'PURCHASE_RECONCILIATION_ERROR';
  else if (dims.some((d) => d.status === 'STALE')) overallStatus = 'STALE';
  else if (onlyInWiderSet.length || campaignPurchasesStatus === 'UNKNOWN' || dims.every((d) => d.status === 'UNKNOWN')) overallStatus = 'WARNING';
  else overallStatus = 'RECONCILED';

  return {
    ok: true, productId: pid, productName: product?.product_name || null, storeId,
    mapping: { status: mappedIds.size ? 'OK' : 'MAPPING_ERROR', ambProductId: ambProduct.id, includedCampaignIds: [...mappedIds], widerSetExtra: onlyInWiderSet },
    campaignPurchases: { status: campaignPurchasesStatus, value: campaignPurchases },
    age, gender, region,
    easyOrders,
    freshness: { metaLastSyncAt: syncStatus?.lastSuccessAt || null, breakdownGeneratedAt, breakdownStale },
    overallStatus,
    discrepancies,
    windowName,
  };
}

/** PMC's own entry point — resolves productId/storeId from a profile, the way every other PMC route does. */
export async function computeDataQualityForProfile({ profileId, storeId, windowName = 'today' }) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) return { ok: false, code: 'NOT_FOUND', reason: 'البروفايل غير موجود.' };
  if (!profile.product_id) return { ok: true, productId: null, overallStatus: 'MAPPING_ERROR', discrepancies: ['المنتج لسه مش مربوط بمنتج حقيقي في الكتالوج.'] };
  return computeProductDataQuality({ productId: profile.product_id, storeId, windowName });
}
