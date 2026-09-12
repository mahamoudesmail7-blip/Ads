// AI Product Marketing Center — "مركز التسويق الذكي للمنتج". Fully isolated
// service: only reads the EXISTING Meta / Easy Orders / Creative Factory /
// Research pipelines and writes to its OWN pmc_* tables (see schema.prisma).
// Never touches AmbProduct, AmbCloneBatch, CfProduct, or any Meta entity.
//
// Data flow (per the spec):
//   Product Source -> Product Lock -> Product Understanding -> Meta
//   Performance -> Easy Orders Quality -> Audience/Location Intelligence ->
//   Angle Discovery -> Creative Intelligence -> AI Recommendations ->
//   User Approval -> Creative Factory handoff -> Learning Memory.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection, getDecryptedToken } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { resolveWindow } from './metricsEngine.js';
import { buildHierarchy } from './hierarchyAnalysis.js';
import { productDashboard } from './ambProducts.js';
import { codCountsForProduct, codCountsByGovernorate, observedRatesForProduct } from './codOrders.js';
import { getEasyOrdersProducts } from './easyOrdersProducts.js';
import { analyzeProductImage } from '../productIdentityVision.js';
import { computeOpportunityScore, computeDiagnosis, rankLocations } from './productMarketingScoring.js';
import * as PMAI from './productMarketingAI.js';

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }
function j(v, d = null) { try { return v ? JSON.parse(v) : d; } catch { return d; } }
const WINDOWS = ['today', 'yesterday', 'last3', 'last7'];

// ---------------------------------------------------------------------------
// §1 — Product source, lock, understanding
// ---------------------------------------------------------------------------

/** Searchable Easy Orders picker — filters the existing cached catalogue by name (substring, case/space-insensitive). */
export async function searchEasyOrdersProducts(query) {
  const list = await getEasyOrdersProducts();
  const q = String(query || '').trim().toLowerCase();
  const filtered = q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
  return filtered.slice(0, 30).map((p) => ({ id: p.id, name: p.name, slug: p.slug, thumb: p.thumb, price: p.price ?? null }));
}

async function findInternalProductByName(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  return prisma.product.findFirst({ where: { product_name: { equals: n, mode: 'insensitive' } } });
}

/** Option A — lock a profile onto a real Easy Orders product. The EO image becomes the one true reference; never swapped, never re-guessed. */
export async function lockFromEasyOrders({ eoProductId, userId }) {
  const list = await getEasyOrdersProducts();
  const eo = list.find((p) => String(p.id) === String(eoProductId));
  if (!eo) throw bad('منتج Easy Orders غير موجود — حاول تبحث تاني.', 404);

  const product = await findInternalProductByName(eo.name);
  const confirmed = [{ label: 'اسم المنتج (Easy Orders)', value: eo.name }];
  const potential = [];
  const unconfirmed = [];
  if (product) {
    confirmed.push({ label: 'رقم المنتج الداخلي', value: String(product.id) });
    if (product.category) confirmed.push({ label: 'الفئة', value: product.category });
    else unconfirmed.push({ label: 'الفئة' });
    if (product.selling_price) confirmed.push({ label: 'سعر البيع المسجّل', value: String(product.selling_price) });
  } else {
    unconfirmed.push({ label: 'مطابقة مع كتالوج المنتجات الداخلي — منتج جديد أو الاسم مختلف' });
  }
  if (eo.price) potential.push({ label: 'السعر (Easy Orders)', value: String(eo.price), confidence: 60 });
  else unconfirmed.push({ label: 'السعر' });

  const row = await prisma.productMarketingProfile.create({
    data: {
      product_id: product?.id || null,
      source: 'EASY_ORDERS',
      locked_name: eo.name,
      easy_orders_product_id: String(eo.id),
      easy_orders_slug: eo.slug || null,
      selling_price: eo.price || product?.selling_price || null,
      primary_image_url: eo.thumb,
      confirmed_traits_json: JSON.stringify(confirmed),
      potential_traits_json: JSON.stringify(potential),
      unconfirmed_traits_json: JSON.stringify(unconfirmed),
      locked_by_id: userId || null,
    },
  });
  return serializeProfile(row);
}

const BUCKET_HIGH = 70; const BUCKET_MID = 40;
/** Option B — analyze uploaded image(s) with the EXISTING vision pipeline, then bucket every field by its own confidence into مؤكدة / محتملة / غير معروفة. Never invents a feature. */
export async function lockFromImages({ images, userId }) {
  if (!Array.isArray(images) || !images.length) throw bad('محتاج صورة واحدة على الأقل.');
  const primary = images[0];
  const { profile } = await analyzeProductImage(primary.imageBase64, primary.imageMediaType).then((r) => ({ profile: r.profile }));

  const confirmed = []; const potential = []; const unconfirmed = [];
  const bucket = (label, value, confidence) => {
    if (!value) { unconfirmed.push({ label }); return; }
    if (confidence >= BUCKET_HIGH) confirmed.push({ label, value });
    else if (confidence >= BUCKET_MID) potential.push({ label, value, confidence });
    else unconfirmed.push({ label });
  };
  bucket('اسم المنتج', profile.mainProductName, profile.mainProductNameConfidence);
  bucket('الفئة', profile.productCategory, profile.categoryConfidence);
  bucket('البراند', profile.brand, profile.brandConfidence);
  bucket('الموديل', profile.model, profile.modelConfidence);
  if (profile.distinctiveFeatures?.length) confirmed.push({ label: 'ملامح مميزة', value: profile.distinctiveFeatures.join('، ') });
  else unconfirmed.push({ label: 'ملامح مميزة' });
  if (profile.visualFingerprint?.mainColors?.length) confirmed.push({ label: 'الألوان', value: profile.visualFingerprint.mainColors.join('، ') });
  if (profile.multipleProductsDetected) unconfirmed.push({ label: 'أكتر من منتج ظاهر في الصورة — التحليل ركّز على الأبرز بصريًا' });
  if (profile.imageQualityIssues?.length) unconfirmed.push({ label: `جودة الصورة: ${profile.imageQualityIssues.join('، ')}` });

  const lockedName = profile.mainProductName || 'منتج بدون اسم مؤكد';
  const product = profile.mainProductNameConfidence >= BUCKET_HIGH ? await findInternalProductByName(lockedName) : null;

  const row = await prisma.productMarketingProfile.create({
    data: {
      product_id: product?.id || null,
      source: 'MANUAL_UPLOAD',
      locked_name: lockedName,
      selling_price: product?.selling_price || null,
      primary_image_url: null, // served via /images/:profileId/:imageIndex below
      confirmed_traits_json: JSON.stringify(confirmed),
      potential_traits_json: JSON.stringify(potential),
      unconfirmed_traits_json: JSON.stringify(unconfirmed),
      vision_profile_json: JSON.stringify(profile),
      locked_by_id: userId || null,
      images: { create: images.map((img, i) => ({ data_url: `data:${img.imageMediaType};base64,${img.imageBase64}`, sort_order: i })) },
    },
    include: { images: { orderBy: { sort_order: 'asc' }, select: { id: true } } },
  });
  return serializeProfile(row, { imageIds: row.images.map((i) => i.id) });
}

export async function getProfile(id) {
  const row = await prisma.productMarketingProfile.findUnique({ where: { id: Number(id) }, include: { images: { orderBy: { sort_order: 'asc' }, select: { id: true } } } });
  if (!row) throw bad('البروفايل غير موجود.', 404);
  return serializeProfile(row, { imageIds: row.images.map((i) => i.id) });
}

export async function listProfiles({ limit = 20 } = {}) {
  const rows = await prisma.productMarketingProfile.findMany({ orderBy: { created_at: 'desc' }, take: Math.min(limit, 50) });
  return rows.map((r) => serializeProfile(r));
}

export async function getProfileImage(profileId, imageId) {
  const img = await prisma.productMarketingImage.findFirst({ where: { id: Number(imageId), profile_id: Number(profileId) } });
  if (!img) throw bad('الصورة غير موجودة.', 404);
  return img.data_url;
}

function serializeProfile(p, extra = {}) {
  return {
    id: p.id,
    productId: p.product_id,
    source: p.source,
    lockedName: p.locked_name,
    easyOrdersProductId: p.easy_orders_product_id,
    sellingPrice: p.selling_price,
    primaryImageUrl: p.primary_image_url || (extra.imageIds?.[0] ? `/api/product-marketing/profiles/${p.id}/images/${extra.imageIds[0]}` : null),
    confirmedTraits: j(p.confirmed_traits_json, []),
    potentialTraits: j(p.potential_traits_json, []),
    unconfirmedTraits: j(p.unconfirmed_traits_json, []),
    imageIds: extra.imageIds || [],
    createdAt: p.created_at,
  };
}

// ---------------------------------------------------------------------------
// §5/§7/§9/§10/§13/§14/§20/§21 — the cached snapshot ("brain" output).
// ---------------------------------------------------------------------------

/** Best AND worst ad/creative for one AmbProduct within a window — the raw material for Winner DNA / Loser Autopsy. Reads the SAME hierarchy tree productDashboard builds (no new Meta calls beyond what AMB already makes). */
async function pickBestWorstAds({ adAccountId, window, settings, ambProductId }) {
  const tree = await buildHierarchy({ adAccountId, window, settings });
  const node = (tree.products || []).find((x) => String(x.id) === String(ambProductId));
  if (!node) return { best: null, worst: null };
  const allAdsets = (node.children || []);
  const allAds = allAdsets.flatMap((as) => (as.children || []).map((ad) => ({ ...ad, adsetName: as.name })));
  const withSignal = allAds.filter((a) => a.metrics && a.metrics.cpa !== null && (a.metrics.purchases || 0) > 0);
  if (!withSignal.length) return { best: null, worst: null };
  const sorted = [...withSignal].sort((a, b) => a.metrics.cpa - b.metrics.cpa);
  const slim = (x) => ({ id: x.id, name: x.name, creativeId: x.creativeId || null, cpa: x.metrics.cpa, purchases: x.metrics.purchases, spend: x.metrics.spend, ctr: x.metrics.ctr, frequency: x.metrics.frequency });
  return { best: slim(sorted[0]), worst: sorted.length > 1 ? slim(sorted[sorted.length - 1]) : null };
}

async function creativeAnalysisFor(creativeId) {
  if (!creativeId) return null;
  const row = await prisma.ambCreativeAnalysis.findFirst({ where: { creative_id: String(creativeId) } });
  if (!row) return null;
  return {
    hook: row.hook, sellingAngle: row.selling_angle, problem: row.problem, mainBenefit: row.main_benefit,
    audience: row.audience, offer: row.offer, cta: row.cta, creativeType: row.creative_type,
  };
}

/** The main compute — gathers every REAL number, asks Claude ONCE to interpret them, validates the answer, diffs it against the last snapshot (self-learning memory), and caches the result. Never runs on a plain page open — only on first view of a window or an explicit refresh. */
export async function computeSnapshot({ profileId, windowName = 'last7', force = false } = {}) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  const win = WINDOWS.includes(windowName) ? windowName : 'last7';

  if (!force) {
    const cached = await prisma.productMarketingSnapshot.findUnique({ where: { profile_id_window_name: { profile_id: profile.id, window_name: win } } });
    if (cached) return deserializeSnapshot(cached);
  }

  const settings = await getAmbSettings();
  const window = resolveWindow(win);
  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id || null;

  // Meta + economics, reusing the EXISTING product dashboard when this
  // profile is linked to a real AmbProduct; otherwise Meta numbers stay
  // null/honest ("no campaign mapped yet") rather than guessed.
  let dashboard = null; let ambProduct = null;
  if (profile.product_id) {
    ambProduct = await prisma.ambProduct.findUnique({ where: { product_id: profile.product_id } });
    if (ambProduct) dashboard = await productDashboard(ambProduct.id, { windowName: win }).catch((e) => { logger.warn('[ProductMarketing] productDashboard failed', { message: e.message }); return null; });
  }

  // Easy Orders truth (independent of Meta mapping — real COD data whenever product_id resolves to a catalog Product with orders).
  let cod = { source: 'none', orders: null, confirmed: null, delivered: null, returned: null };
  let govRows = [];
  if (profile.product_id) {
    cod = await codCountsForProduct({ productId: profile.product_id, from: window.from, to: window.to });
    govRows = await codCountsByGovernorate({ productId: profile.product_id, from: window.from, to: window.to });
  }

  const m = dashboard?.metrics || {};
  const metrics = {
    windowLabel: window.label,
    totalSpend: m.totalSpend ?? 0,
    metaPurchases: m.metaPurchases ?? null,
    confirmedOrders: cod.confirmed,
    deliveredOrders: cod.delivered,
    avgCpa: m.avgCpa ?? null,
    confirmedCpa: m.confirmedCpa ?? null,
    deliveredCpa: m.deliveredCpa ?? null,
    deliveryRate: cod.confirmed ? (cod.delivered || 0) / cod.confirmed : null,
    netProfit: m.netProfit ?? null,
    netMarginPct: m.netMarginPct ?? null,
    roas: m.roas ?? null,
    ctr: null, cpc: null, cvr: null, frequency: null, // filled below from the product's own campaign rollup when a Meta mapping exists
  };
  let bestWorst = { best: null, worst: null };
  if (adAccountId && ambProduct) {
    const tree = await buildHierarchy({ adAccountId, window, settings }).catch(() => null);
    const node = tree ? (tree.products || []).find((x) => String(x.id) === String(ambProduct.id)) : null;
    if (node?.metrics) {
      metrics.ctr = node.metrics.ctr; metrics.cpc = node.metrics.cpc; metrics.cvr = node.metrics.conversionRate; metrics.frequency = node.metrics.frequency;
    }
    bestWorst = await pickBestWorstAds({ adAccountId, window, settings, ambProductId: ambProduct.id }).catch(() => ({ best: null, worst: null }));
  }

  const locations = rankLocations(govRows);
  const opportunity = computeOpportunityScore({ metrics, settings });
  const diagnosis = computeDiagnosis({ metrics, creative: await creativeAnalysisFor(bestWorst.best?.creativeId), settings });

  const bestCreative = await creativeAnalysisFor(bestWorst.best?.creativeId);
  const worstCreative = await creativeAnalysisFor(bestWorst.worst?.creativeId);

  const aiCtx = {
    productName: profile.locked_name,
    confirmedTraits: j(profile.confirmed_traits_json, []),
    potentialTraits: j(profile.potential_traits_json, []),
    metrics,
    opportunityScore: opportunity,
    diagnosis,
    topLocations: locations.slice(0, 8).map((l) => ({ government: l.government, orders: l.orders, confirmed: l.confirmed, delivered: l.delivered, deliveryRate: l.deliveryRate })),
    bestAd: bestWorst.best ? { ...bestWorst.best, analysis: bestCreative } : null,
    worstAd: bestWorst.worst ? { ...bestWorst.worst, analysis: worstCreative } : null,
    dataSufficient: opportunity.dataSufficient,
  };

  const ai = await PMAI.buildIntelligenceReport(aiCtx);

  const snapshotData = {
    metrics, opportunity, diagnosis, locations,
    audience: ai.ok ? ai.audience : { unavailable: true, reason: ai.reason },
    angles: ai.ok ? ai.angles : [],
    locationCommentary: ai.ok ? ai.locationCommentary : null,
    diagnosisNarrative: ai.ok ? ai.diagnosisNarrative : null,
    winnerDna: ai.ok ? ai.winnerDna : { available: false },
    loserAutopsy: ai.ok ? ai.loserAutopsy : { available: false },
    winningFormula: ai.ok ? ai.winningFormula : { available: false },
    actions: ai.ok ? ai.actions : [],
    bestAd: aiCtx.bestAd, worstAd: aiCtx.worstAd,
    aiFailed: !ai.ok, aiFailReason: ai.ok ? null : ai.reason,
  };

  await recordMemoryDiffs(profile.id, snapshotData);

  const saved = await prisma.productMarketingSnapshot.upsert({
    where: { profile_id_window_name: { profile_id: profile.id, window_name: win } },
    create: {
      profile_id: profile.id, window_name: win, ad_account_id: adAccountId,
      metrics_json: JSON.stringify(metrics), opportunity_json: JSON.stringify(opportunity), diagnosis_json: JSON.stringify(diagnosis),
      audience_json: JSON.stringify(snapshotData.audience), locations_json: JSON.stringify(locations), angles_json: JSON.stringify(snapshotData.angles),
      winning_formula_json: JSON.stringify(snapshotData.winningFormula), actions_json: JSON.stringify(snapshotData.actions),
      ai_raw_json: ai.ok ? JSON.stringify({ locationCommentary: snapshotData.locationCommentary, diagnosisNarrative: snapshotData.diagnosisNarrative, winnerDna: snapshotData.winnerDna, loserAutopsy: snapshotData.loserAutopsy, bestAd: aiCtx.bestAd, worstAd: aiCtx.worstAd }) : null,
    },
    update: {
      ad_account_id: adAccountId,
      metrics_json: JSON.stringify(metrics), opportunity_json: JSON.stringify(opportunity), diagnosis_json: JSON.stringify(diagnosis),
      audience_json: JSON.stringify(snapshotData.audience), locations_json: JSON.stringify(locations), angles_json: JSON.stringify(snapshotData.angles),
      winning_formula_json: JSON.stringify(snapshotData.winningFormula), actions_json: JSON.stringify(snapshotData.actions),
      ai_raw_json: ai.ok ? JSON.stringify({ locationCommentary: snapshotData.locationCommentary, diagnosisNarrative: snapshotData.diagnosisNarrative, winnerDna: snapshotData.winnerDna, loserAutopsy: snapshotData.loserAutopsy, bestAd: aiCtx.bestAd, worstAd: aiCtx.worstAd }) : null,
      computed_at: new Date(),
    },
  });

  await syncActions(profile.id, snapshotData.actions);
  return deserializeSnapshot(saved, snapshotData);
}

function deserializeSnapshot(row, precomputed = null) {
  const extra = precomputed ? { locationCommentary: precomputed.locationCommentary, diagnosisNarrative: precomputed.diagnosisNarrative, winnerDna: precomputed.winnerDna, loserAutopsy: precomputed.loserAutopsy, bestAd: precomputed.bestAd, worstAd: precomputed.worstAd }
    : (j(row.ai_raw_json, {}) || {});
  return {
    profileId: row.profile_id,
    windowName: row.window_name,
    computedAt: row.computed_at,
    metrics: j(row.metrics_json, {}),
    opportunity: j(row.opportunity_json, {}),
    diagnosis: j(row.diagnosis_json, []),
    audience: j(row.audience_json, {}),
    locations: j(row.locations_json, []),
    angles: j(row.angles_json, []),
    winningFormula: j(row.winning_formula_json, { available: false }),
    actions: j(row.actions_json, []),
    locationCommentary: extra.locationCommentary || null,
    diagnosisNarrative: extra.diagnosisNarrative || null,
    winnerDna: extra.winnerDna || { available: false },
    loserAutopsy: extra.loserAutopsy || { available: false },
    bestAd: extra.bestAd || null,
    worstAd: extra.worstAd || null,
  };
}

export async function getSnapshot({ profileId, windowName = 'last7' } = {}) {
  const win = WINDOWS.includes(windowName) ? windowName : 'last7';
  const row = await prisma.productMarketingSnapshot.findUnique({ where: { profile_id_window_name: { profile_id: Number(profileId), window_name: win } } });
  if (!row) return null;
  return deserializeSnapshot(row);
}

// ---------------------------------------------------------------------------
// §22 — Self-learning marketing memory. Never a silent overwrite: every time
// the TOP audience segment / TOP location / TOP angle changes vs the
// previous snapshot, log {previous, new, evidence}.
// ---------------------------------------------------------------------------
async function recordMemoryDiffs(profileId, next) {
  const last = await prisma.productMarketingSnapshot.findFirst({ where: { profile_id: profileId }, orderBy: { computed_at: 'desc' } });
  if (!last) return; // first-ever snapshot — nothing to diff against
  const prevAudience = j(last.audience_json, {});
  const prevLocations = j(last.locations_json, []);

  const prevTopGender = prevAudience?.gender?.value || null;
  const nextTopGender = next.audience?.gender?.value || null;
  if (prevTopGender && nextTopGender && prevTopGender !== nextTopGender) {
    await prisma.productMarketingMemoryEntry.create({
      data: { profile_id: profileId, field: 'audience_gender', previous_json: JSON.stringify(prevAudience.gender), new_json: JSON.stringify(next.audience.gender), evidence: next.audience.gender?.evidence || 'دليل جديد من الأداء الحالي' },
    });
  }
  const prevTopGov = prevLocations?.[0]?.government || null;
  const nextTopGov = next.locations?.[0]?.government || null;
  if (prevTopGov && nextTopGov && prevTopGov !== nextTopGov) {
    await prisma.productMarketingMemoryEntry.create({
      data: { profile_id: profileId, field: 'top_location', previous_json: JSON.stringify(prevLocations[0]), new_json: JSON.stringify(next.locations[0]), evidence: `${nextTopGov}: ${next.locations[0].delivered} طلب مُستلم مقابل ${prevLocations[0].delivered} في ${prevTopGov} سابقًا.` },
    });
  }
}

export async function getMemory(profileId) {
  const rows = await prisma.productMarketingMemoryEntry.findMany({ where: { profile_id: Number(profileId) }, orderBy: { created_at: 'desc' }, take: 50 });
  return rows.map((r) => ({ id: r.id, field: r.field, previous: j(r.previous_json), new: j(r.new_json), evidence: r.evidence, createdAt: r.created_at }));
}

// ---------------------------------------------------------------------------
// §21 — AI Actions approval log. Deciding here NEVER writes to Meta itself.
// ---------------------------------------------------------------------------
async function syncActions(profileId, actions) {
  for (const a of actions || []) {
    const existing = await prisma.productMarketingActionLog.findFirst({ where: { profile_id: profileId, action_key: a.actionKey, status: 'PENDING' } });
    if (existing) continue; // don't spam duplicates of a still-pending action across refreshes
    await prisma.productMarketingActionLog.create({
      data: { profile_id: profileId, action_key: a.actionKey, title: a.title, reason: a.reason, confidence: a.confidence, source: a.source },
    });
  }
}
export async function listActions(profileId) {
  const rows = await prisma.productMarketingActionLog.findMany({ where: { profile_id: Number(profileId) }, orderBy: { created_at: 'desc' }, take: 30 });
  return rows.map((r) => ({ id: r.id, actionKey: r.action_key, title: r.title, reason: r.reason, confidence: r.confidence, source: r.source, status: r.status, note: r.note, decidedAt: r.decided_at }));
}
export async function decideAction({ actionId, status, note, userId }) {
  if (!['APPROVED', 'MODIFIED', 'REJECTED'].includes(status)) throw bad('قرار غير معروف.');
  const row = await prisma.productMarketingActionLog.update({ where: { id: Number(actionId) }, data: { status, note: note || null, decided_by_id: userId || null, decided_at: new Date() } });
  return { id: row.id, status: row.status };
}

// ---------------------------------------------------------------------------
// §15/§16/§17/§24 — on-demand generation (never part of the cached snapshot compute).
// ---------------------------------------------------------------------------
export async function hookLab({ profileId, angle, category, count }) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  const n = [5, 10, 20].includes(Number(count)) ? Number(count) : 10;
  return PMAI.generateHooks({ productName: profile.locked_name, angle, category, count: n });
}
export async function postGenerator({ profileId, angle, tone }) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  return PMAI.generatePost({ productName: profile.locked_name, angle, tone });
}
export async function creativeIdeas({ profileId, angle, count }) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  return PMAI.generateCreativeIdeas({ productName: profile.locked_name, angle, count: Math.min(Number(count) || 4, 8) });
}
/** §24 one-click test pack — composes the smaller generators into one bundle. */
export async function testPack({ profileId, angle }) {
  const [hooks, post, ideas] = await Promise.all([
    hookLab({ profileId, angle, count: 5 }),
    postGenerator({ profileId, angle, tone: 'مباشر' }),
    creativeIdeas({ profileId, angle, count: 3 }),
  ]);
  return { hooks: hooks.ok ? hooks.hooks : [], post: post.ok ? post.post : null, ideas: ideas.ok ? ideas.ideas : [] };
}

// ---------------------------------------------------------------------------
// §17 button — "إرسال إلى مصنع الإعلانات". Reuses the EXISTING Creative
// Factory validation as-is; never force-creates a project the real
// pipeline wouldn't otherwise accept.
// ---------------------------------------------------------------------------
export async function creativeFactoryReadiness(profileId) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  if (!profile.product_id) return { ready: false, reason: 'المنتج لسه مش مربوط بمنتج حقيقي في الكتالوج.' };
  const cf = await prisma.cfProduct.findUnique({ where: { product_id: profile.product_id }, include: { _count: { select: { reference_images: true } } } });
  if (!cf) return { ready: false, reason: 'المنتج لسه معملوش ملف في مصنع الإعلانات.', cfProductId: null };
  const { getEffectiveThresholds } = await import('../creativeFactory/thresholds.js');
  const th = await getEffectiveThresholds();
  if (cf._count.reference_images < th.minReferenceImages) {
    return { ready: false, reason: `محتاج على الأقل ${th.minReferenceImages} صور مرجعية في مصنع الإعلانات أولاً (عنده ${cf._count.reference_images}).`, cfProductId: cf.id };
  }
  return { ready: true, cfProductId: cf.id };
}

// ---------------------------------------------------------------------------
// §18 — Competitor Intelligence. READ-ONLY reuse of the existing Product
// Research data for this catalog product; never a second scraper/search.
// ---------------------------------------------------------------------------
export async function competitorIntel(profileId) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  if (!profile.product_id) return { available: false, reason: 'المنتج لسه مش مربوط بمنتج حقيقي — البحث عن المنافسين يحتاج منتج من الكتالوج.' };
  const competitors = await prisma.productResearchCompetitor.findMany({ where: { product_id: profile.product_id }, orderBy: { last_seen: 'desc' }, take: 20 });
  if (!competitors.length) return { available: false, reason: 'لسه معملتش بحث عن المنافسين لهذا المنتج — استخدم صفحة "البحث عن المنتجات".' };
  const search = await prisma.productResearchSearch.findFirst({ where: { product_id: profile.product_id }, orderBy: { created_at: 'desc' } });
  const insight = search ? await prisma.productResearchInsight.findUnique({ where: { search_id: search.id } }) : null;
  return {
    available: true,
    competitors: competitors.map((c) => ({ platform: c.platform, accountName: c.account_name, accountUrl: c.account_url, country: c.country, followerCount: c.follower_count })),
    insights: insight ? j(insight.insights_json, null) : null,
  };
}
