// Product Marketing Intelligence — real Meta-attributed audience/geography/
// platform breakdown data (Phase A). Every number here comes straight from
// Meta's own Insights API `breakdowns` parameter, scoped to this product's
// CONFIRMED (AmbProductCampaignMap.status === 'MAPPED') campaigns only —
// never a guess, never inferred from Easy Orders/customer data, never a
// literal customer identity. Meta does not expose real customer records via
// this endpoint; it reports AD PERFORMANCE aggregated by the audience
// segment Meta itself served the ad to, which is why every field here must
// be labeled "Meta-attributed audience performance" wherever it is shown,
// never presented as confirmed demographic fact about a real buyer.
//
// On-demand only (own route, like Market Gaps/AI Strategist/Competitors) —
// never part of computeSnapshot()'s own compute path, so a slow/rejected
// Meta breakdown call can never block or slow down the main analysis.
// Cached in the SAME pmc_snapshots row (audience_breakdown_json) keyed by
// (profile, window) — recomputed only on an explicit "تحديث" (force), same
// convention as Market Gaps/Strategist, so PMC never hammers Meta on a
// plain tab open.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection, getDecryptedToken } from '../metaAuth.js';
import { resolveWindow } from './metricsEngine.js';
import { resolveEffectiveProductId } from './productMarketing.js';
import { getInsightsBreakdown, pickPurchases } from '../metaGraphClient.js';

function j(v, d = null) { try { return v ? JSON.parse(v) : d; } catch { return d; } }
function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

const WINDOWS = ['today', 'yesterday', 'last3', 'last7', 'last14', 'last30', 'last90'];

// Combos attempted against the LIVE account, in this order. Meta's own real
// combination restrictions are deliberately NOT hard-coded — every combo is
// actually requested and its exact accepted/rejected outcome recorded (see
// classifyError below), per the instruction to never guess at what Meta
// supports. A rejected combo falls back to its single dimensions.
const AGE_GENDER = { key: 'age,gender', dims: ['age', 'gender'] };
const AGE_ONLY = { key: 'age', dims: ['age'] };
const GENDER_ONLY = { key: 'gender', dims: ['gender'] };
const COUNTRY = { key: 'country', dims: ['country'] };
const REGION = { key: 'region', dims: ['region'] };
const PLATFORM_PLACEMENT = { key: 'publisher_platform,platform_position', dims: ['publisher_platform', 'platform_position'] };
const PLATFORM_ONLY = { key: 'publisher_platform', dims: ['publisher_platform'] };
const PLACEMENT_ONLY = { key: 'platform_position', dims: ['platform_position'] };

export function classifyError(res) {
  const code = Number(res.code);
  const msg = String(res.message || '');
  if ([4, 17, 32, 613, 80004].includes(code) || /request limit|rate limit|too many calls/i.test(msg)) return 'RATE_LIMITED';
  if ([190, 102, 200, 10].includes(code) || /permission|access token|authoriz/i.test(msg)) return 'PERMISSION';
  if (code === 100 || /not (a )?valid|cannot be (used|combined)|not support(ed)?|incompatib|breakdown/i.test(msg)) return 'UNSUPPORTED_COMBO';
  return 'ERROR';
}

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

/** Pure — real purchases + purchase value from one breakdown row's actions/action_values, same priority list every other Meta metric in this app already uses (pickPurchases). */
export function rowMetrics(row) {
  const spend = Number(row.spend) || 0;
  const impressions = Number(row.impressions) || 0;
  const reach = row.reach != null ? Number(row.reach) : null;
  const clicks = Number(row.clicks) || 0;
  const ctr = row.ctr != null ? Number(row.ctr) : null;
  const cpc = row.cpc != null ? Number(row.cpc) : null;
  const pk = pickPurchases(row.actions);
  const purchases = pk.value || 0;
  const pvMap = new Map((row.action_values || []).map((a) => [a.action_type, Number(a.value) || 0]));
  const purchaseValue = pk.actionType ? (pvMap.get(pk.actionType) ?? 0) : 0;
  return { spend, impressions, reach, clicks, ctr, cpc, purchases, purchaseValue };
}

async function attemptCombo({ token, adAccountId, campaignIds, dateFrom, dateTo, combo }) {
  const res = await getInsightsBreakdown(token, adAccountId, { breakdowns: combo.dims, campaignIds, dateFrom, dateTo });
  if (!res.ok) {
    const kind = classifyError(res);
    logger.info('[MetaAudienceBreakdown] combo rejected', { combo: combo.key, kind, message: res.message });
    return { status: kind === 'UNSUPPORTED_COMBO' ? 'UNSUPPORTED' : (kind === 'PERMISSION' ? 'PERMISSION_DENIED' : 'ERROR'), reason: res.message, code: res.code ?? null, subcode: res.subcode ?? null, rows: [] };
  }
  if (!res.rows.length) return { status: 'EMPTY', reason: 'مفيش بيانات حقيقية لهذا التقسيم في الفترة المحددة.', rows: [] };
  const rows = res.rows.map((r) => ({ dims: Object.fromEntries(combo.dims.map((d) => [d, r[d] ?? null])), ...rowMetrics(r) }));
  return { status: 'AVAILABLE', reason: null, rows };
}

/** Sums per-row metrics grouped by ONE dimension key out of a (possibly multi-dimension) row set — e.g. collapse an age×gender table down to just age. */
export function aggregateBy(rows, dim) {
  const map = new Map();
  for (const r of rows) {
    const key = r.dims[dim] ?? 'unknown';
    if (!map.has(key)) map.set(key, { value: key, spend: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0, reachSamples: [] });
    const a = map.get(key);
    a.spend += r.spend; a.impressions += r.impressions; a.clicks += r.clicks;
    a.purchases += r.purchases; a.purchaseValue += r.purchaseValue;
    if (r.reach != null) a.reachSamples.push(r.reach);
  }
  return [...map.values()].map((a) => ({
    value: a.value, spend: round2(a.spend), impressions: a.impressions, clicks: a.clicks,
    purchases: a.purchases, purchaseValue: round2(a.purchaseValue),
    ctr: a.impressions ? round2((a.clicks / a.impressions) * 100) : null,
    cpc: a.clicks ? round2(a.spend / a.clicks) : null,
    cpa: a.purchases ? round2(a.spend / a.purchases) : null,
    // Meta explicitly documents reach as non-summable across breakdown rows or days — only ever reported for a single already-atomic row, never added across several.
    reach: a.reachSamples.length === 1 ? a.reachSamples[0] : null,
  })).sort((x, y) => y.purchases - x.purchases || y.spend - x.spend);
}

const EMPTY_UNAVAILABLE = (reason) => ({ available: false, reason });

/**
 * The reusable core: real Meta age/gender/region/platform breakdown for an
 * EXPLICIT set of campaign ids + ad account, for any caller that has
 * already resolved those the way it needs to (PMC via
 * AmbProductCampaignMap, Smart Decision Center Phase 4 via Phase 2's own
 * campaign resolution) — never a second Meta-breakdown implementation.
 * Exported so Phase 4's segment intelligence can reuse it directly without
 * requiring a ProductMarketingProfile to exist first.
 */
export async function fetchAudienceBreakdown({ adAccountId, campaignIds, window }) {
  if (!adAccountId) return EMPTY_UNAVAILABLE('لا يوجد حساب إعلانات Meta متصل حاليًا.');
  if (!campaignIds?.length) return EMPTY_UNAVAILABLE('لا توجد حملات Meta مؤكدة لهذا المنتج — تقسيمات الجمهور تُحسب فقط على حملات حقيقية، أبدًا على تخمين.');

  let token;
  try { token = await getDecryptedToken(); } catch (e) { return EMPTY_UNAVAILABLE(e.message); }

  const dateFrom = window.from, dateTo = window.to;
  const call = (combo) => attemptCombo({ token, adAccountId, campaignIds, dateFrom, dateTo, combo });

  const combos = {};
  let ageGenderRows = null;
  combos[AGE_GENDER.key] = await call(AGE_GENDER);
  if (combos[AGE_GENDER.key].status === 'AVAILABLE') {
    ageGenderRows = combos[AGE_GENDER.key].rows;
  } else if (combos[AGE_GENDER.key].status === 'UNSUPPORTED') {
    combos[AGE_ONLY.key] = await call(AGE_ONLY);
    combos[GENDER_ONLY.key] = await call(GENDER_ONLY);
  }

  combos[COUNTRY.key] = await call(COUNTRY);
  combos[REGION.key] = await call(REGION);

  let platformPlacementRows = null;
  combos[PLATFORM_PLACEMENT.key] = await call(PLATFORM_PLACEMENT);
  if (combos[PLATFORM_PLACEMENT.key].status === 'AVAILABLE') {
    platformPlacementRows = combos[PLATFORM_PLACEMENT.key].rows;
  } else if (combos[PLATFORM_PLACEMENT.key].status === 'UNSUPPORTED') {
    combos[PLATFORM_ONLY.key] = await call(PLATFORM_ONLY);
    combos[PLACEMENT_ONLY.key] = await call(PLACEMENT_ONLY);
  }

  const age = ageGenderRows ? aggregateBy(ageGenderRows, 'age')
    : (combos[AGE_ONLY.key]?.status === 'AVAILABLE' ? aggregateBy(combos[AGE_ONLY.key].rows, 'age') : []);
  const gender = ageGenderRows ? aggregateBy(ageGenderRows, 'gender')
    : (combos[GENDER_ONLY.key]?.status === 'AVAILABLE' ? aggregateBy(combos[GENDER_ONLY.key].rows, 'gender') : []);
  const country = combos[COUNTRY.key]?.status === 'AVAILABLE' ? aggregateBy(combos[COUNTRY.key].rows, 'country') : [];
  const region = combos[REGION.key]?.status === 'AVAILABLE' ? aggregateBy(combos[REGION.key].rows, 'region') : [];
  const platform = platformPlacementRows ? aggregateBy(platformPlacementRows, 'publisher_platform')
    : (combos[PLATFORM_ONLY.key]?.status === 'AVAILABLE' ? aggregateBy(combos[PLATFORM_ONLY.key].rows, 'publisher_platform') : []);
  const placement = platformPlacementRows ? platformPlacementRows.map((r) => ({ ...r.dims, ...r }))
    : (combos[PLACEMENT_ONLY.key]?.status === 'AVAILABLE' ? aggregateBy(combos[PLACEMENT_ONLY.key].rows, 'platform_position') : []);

  const totalPurchases = [...age, ...gender].reduce((s, r) => s + (r.purchases || 0), 0) || Math.max(
    country.reduce((s, r) => s + (r.purchases || 0), 0),
    platform.reduce((s, r) => s + (r.purchases || 0), 0),
  );
  const sampleWarning = totalPurchases > 0 && totalPurchases < 10
    ? `عيّنة صغيرة جدًا (${totalPurchases} مشترى فقط في هذه الفترة) — أي فرق بين الشرائح هنا قد يكون صدفة، مش نمط حقيقي.`
    : (totalPurchases === 0 ? 'لا توجد مشتريات مسجّلة على Meta في هذه الفترة لهذا التقسيم — الأرقام (صرف/كليكات) حقيقية لكن بدون إشارة تحويل يُبنى عليها قرار.' : null);

  const anyAvailable = Object.values(combos).some((c) => c.status === 'AVAILABLE');
  return {
    available: anyAvailable,
    reason: anyAvailable ? null : 'Meta رفضت كل تقسيمات الجمهور المتاحة لهذا الحساب/الفترة — شوف كل تقسيم في combos للسبب الدقيق.',
    generatedAt: new Date().toISOString(),
    windowLabel: window.label,
    adAccountId,
    campaignIds,
    combos,
    age, gender, country, region, platform, placement,
    sampleWarning,
  };
}

/** PMC's own entry point: resolves campaign ids the PMC way (CONFIRMED AmbProductCampaignMap rows for this profile's product), then defers to the shared fetchAudienceBreakdown() core above. */
async function buildResult({ profile, win }) {
  const window = resolveWindow(win);
  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id || null;
  if (!adAccountId) return EMPTY_UNAVAILABLE('لا يوجد حساب إعلانات Meta متصل حاليًا.');

  const effectiveProductId = await resolveEffectiveProductId(profile);
  if (!effectiveProductId) return EMPTY_UNAVAILABLE('المنتج لسه مش مربوط بمنتج حقيقي في الكتالوج.');

  const ambProduct = await prisma.ambProduct.findUnique({ where: { product_id: effectiveProductId } });
  if (!ambProduct) return EMPTY_UNAVAILABLE('لا يوجد ربط Meta لهذا المنتج بعد — لازم تأكيد ربط حملة واحدة على الأقل أولاً.');

  const mapped = await prisma.ambProductCampaignMap.findMany({ where: { amb_product_id: ambProduct.id, status: 'MAPPED' }, select: { campaign_id: true } });
  const campaignIds = mapped.map((m) => m.campaign_id);
  if (!campaignIds.length) return EMPTY_UNAVAILABLE('لا توجد حملات Meta مؤكدة (مربوطة يدويًا) لهذا المنتج — تقسيمات الجمهور تُحسب فقط على الحملات المؤكدة، أبدًا على تخمين.');

  return fetchAudienceBreakdown({ adAccountId, campaignIds, window });
}

export async function computeAudienceBreakdown({ profileId, windowName = 'last7', force = false } = {}) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  const win = WINDOWS.includes(windowName) ? windowName : 'last7';

  const existing = await prisma.productMarketingSnapshot.findUnique({ where: { profile_id_window_name: { profile_id: profile.id, window_name: win } } });
  if (!existing) throw bad('لازم تحلل المنتج أولاً قبل جلب بيانات الجمهور من Meta.', 400);
  if (!force) {
    const cached = j(existing.audience_breakdown_json, null);
    if (cached) return cached;
  }

  const result = await buildResult({ profile, win }).catch((e) => {
    logger.error('[MetaAudienceBreakdown] buildResult failed', { message: e.message });
    return EMPTY_UNAVAILABLE(e.message || 'تعذّر جلب بيانات الجمهور من Meta.');
  });
  await prisma.productMarketingSnapshot.update({ where: { id: existing.id }, data: { audience_breakdown_json: JSON.stringify(result) } });
  return result;
}
