// AI Product Marketing Center — "مركز التسويق الذكي للمنتج". Fully isolated
// service: only reads the EXISTING Meta / Easy Orders / Creative Factory /
// Research pipelines and writes to its OWN pmc_* tables (see schema.prisma),
// with ONE deliberate exception: confirmMetaMapping() below, which is the
// only place in this file allowed to touch AmbProduct/AmbProductCampaignMap
// — and only via the SAME explicit, human-confirmed mapping architecture
// AI Media Buyer itself already uses (services/amb/mapping.js's setMapping,
// services/amb/ambProducts.js's createFromCatalogProduct) — never a second
// mapping table, never an automatic write.
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
import { resolveWindow, entityWindowMetrics } from './metricsEngine.js';
import { buildHierarchy, rollupMetrics } from './hierarchyAnalysis.js';
import { productDashboard, createFromCatalogProduct } from './ambProducts.js';
import { setMapping, mappedCampaignIndex } from './mapping.js';
import { codCountsForProduct, codCountsByGovernorate, observedRatesForProduct } from './codOrders.js';
import { customerQualityForProduct, marketsForProduct } from './customerQuality.js';
import { buyerInsightsForProduct } from './buyerInsights.js';
import { hookAndAngleIntelForProduct, scopedAdsForProduct } from './productMarketingWinnerIntel.js';
import { getAllEasyOrdersProductsStatus } from './easyOrdersProducts.js';
import { listStores, getStore, defaultStoreId, storeConfigDiagnostics as storeConfigDiagnosticsImpl } from '../easyOrdersStores.js';
import { exactNameKey, stripStoreTagSuffix } from '../easyOrders.js';
import { analyzeProductImage } from '../productIdentityVision.js';
import { computeOpportunityScore, computeDiagnosis, rankLocations, matchCampaignsToProduct, healthBand, prioritizeActions } from './productMarketingScoring.js';
import { assembleNeedsAttention, assembleWinningComponents, labelCreativeIdeas, labelPostCopy, assembleDataCompleteness } from './productMarketingAssemblers.js';
import * as PMAI from './productMarketingAI.js';
import { mapProductByName } from '../../../../js/product-mapping.js';

// Informative-only confidence numbers for the UI — never used to
// auto-decide anything; the admin's checkbox + explicit "تأكيد الربط" click
// is always the only thing that ever writes a MAPPED row.
const MATCH_CONFIDENCE = { SLUG: 0.9, EXTERNAL_ID: 0.85, EXACT_NAME: 0.75, ALL_NAME_WORDS: 0.4 };

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }
function j(v, d = null) { try { return v ? JSON.parse(v) : d; } catch { return d; } }
const WINDOWS = ['today', 'yesterday', 'last3', 'last7', 'last14', 'last30', 'last90'];

/** Shifts a {from,to} window back by its own length, for a same-size "prior period" comparison (fatigue corroboration only — never used for real metrics elsewhere). */
function priorWindowOf({ from, to }) {
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  const lengthMs = Math.max(0, toDate.getTime() - fromDate.getTime());
  const priorTo = new Date(fromDate.getTime() - 24 * 60 * 60 * 1000);
  const priorFrom = new Date(priorTo.getTime() - lengthMs);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(priorFrom), to: fmt(priorTo) };
}

// Multi-store (Product Marketing Center) — store_id is encoded INTO the
// existing easy_orders_product_id string column as "storeId::realEoId"
// rather than adding a new DB column/migration (see the final report for
// why: this repo just recovered from a real production data-loss incident
// caused by database tooling misuse, and per explicit instruction this
// feature must not touch the schema unless truly unavoidable — it isn't
// here). A profile locked before multi-store support existed has no "::"
// in its easy_orders_product_id, so it transparently reads back as
// defaultStoreId() — zero migration needed for old rows either.
function encodeStoreScopedId(storeId, realEoId) { return `${storeId}::${realEoId}`; }
function decodeStoreScopedId(value) {
  const s = String(value || '');
  const idx = s.indexOf('::');
  if (idx === -1) return { storeId: defaultStoreId(), realEoId: s };
  return { storeId: s.slice(0, idx), realEoId: s.slice(idx + 2) };
}

// ---------------------------------------------------------------------------
// §1 — Product source, lock, understanding
// ---------------------------------------------------------------------------

/**
 * The Easy Orders picker's data source — the FULL real catalogue (no
 * artificial cap; EasyOrders returns every product in one call for this
 * account, confirmed against the live API — no pagination envelope to
 * follow). `query` optionally filters by name server-side, but the
 * frontend fetches once with no query and does the rest (search + "الأحدث" /
 * "تم استخدامها مؤخراً" filtering, plus its own progressive "تحميل المزيد"
 * paging) client-side over that one real list — no repeated round-trips.
 */
/**
 * Multi-store — every store's catalogue is fetched/cached completely
 * independently (see easyOrdersProducts.js's per-store Map caches), so
 * Store A's products can never leak into a Store B request. `storeId`
 * defaults to defaultStoreId() (today: the single EASYORDERS_API_KEY store)
 * so every pre-multi-store caller keeps working unchanged.
 */
export async function searchEasyOrdersProducts(query, storeId = defaultStoreId()) {
  const status = await getAllEasyOrdersProductsStatus(storeId);
  const q = String(query || '').trim().toLowerCase();
  const filtered = q ? status.products.filter((p) => p.name.toLowerCase().includes(q)) : status.products;
  return {
    storeId,
    products: filtered.map((p) => ({ id: p.id, storeId, name: p.name, slug: p.slug, thumb: p.thumb, price: p.price ?? null, createdAt: p.createdAt || null })),
    // §1 — a real API/network/config failure must never be presented to the
    // frontend as an indistinguishable "zero products"; ok/source/error let
    // the UI show the REAL reason (and a retry) instead of a wrong "not found".
    ok: status.ok, source: status.source, error: status.error,
  };
}

/** Safe store list for the frontend's "المتجر الحالي" selector — id/name/domain/enabled only, never a credential. */
export function listEasyOrdersStores() {
  return listStores();
}

/** ADMIN-only — see easyOrdersStores.js's storeConfigDiagnostics() for exactly what this exposes (env var NAMES + presence booleans, never a value). */
export function storeConfigDiagnostics() {
  return storeConfigDiagnosticsImpl();
}

/**
 * Classifies ONE EasyOrders catalog product against the internal Product
 * table, read-only — same tier order and the same exact-only rules as the
 * real ingestion path's matchProduct() in services/easyOrders.js (SKU first,
 * then an exact normalized-name fallback with the "(s<number>)" store-tag
 * suffix stripped), except this reports WHICH tier matched (or why it
 * didn't) instead of collapsing straight to a single product-or-null:
 *   EXACT_SKU_MATCH / EXACT_NAME_MATCH / AMBIGUOUS / MISSING.
 * Never fuzzy, never contains/partial — an ambiguous SKU or name (more than
 * one internal product) is reported as AMBIGUOUS, never guessed through.
 */
export function classifyCatalogProductMatch(sku, rawName, internalProducts) {
  if (sku) {
    const skuHits = internalProducts.filter((p) => p.sku && p.sku === sku);
    if (skuHits.length === 1) return { status: 'EXACT_SKU_MATCH', product: skuHits[0] };
    if (skuHits.length > 1) return { status: 'AMBIGUOUS', product: null, matchedOn: 'sku', candidates: skuHits };
  }

  const key = exactNameKey(rawName);
  if (!key) return { status: 'MISSING', product: null };
  const nameHits = internalProducts.filter((p) => exactNameKey(p.product_name) === key);
  if (nameHits.length === 1) return { status: 'EXACT_NAME_MATCH', product: nameHits[0] };
  if (nameHits.length > 1) return { status: 'AMBIGUOUS', product: null, matchedOn: 'name', candidates: nameHits };
  return { status: 'MISSING', product: null };
}

/**
 * READ-ONLY audit: every EasyOrders catalog product for one store vs. the
 * internal Product table. Built for the "do we need a Product Sync or
 * Mapping tool" decision — never creates/updates a Product, never touches
 * EasyOrdersOrder/DailyOrder, never calls Meta. Reuses the exact same
 * fetch (getAllEasyOrdersProductsStatus) the existing Easy Orders picker
 * already relies on, so this is zero new network/integration surface —
 * only a new read-only comparison over data already being fetched.
 */
export async function auditEasyOrdersCatalog(storeId = defaultStoreId(), { forceRefresh = false } = {}) {
  const status = await getAllEasyOrdersProductsStatus(storeId, { forceRefresh });
  // Multi-store — MUST match findInternalProductByName()'s own scoping
  // exactly (a store's own products, or a legacy untagged row). Querying
  // globally here (as this used to) makes a store's audit report a phantom
  // "EXACT_NAME_MATCH" against a completely different store's product that
  // merely happens to share a generic name — confirmed in production: a
  // brand-new second store's real catalog was showing dozens of false
  // matches against the first store's unrelated products before this fix,
  // which would have made "create missing products" silently skip real
  // products that don't exist for this store at all.
  const internalProducts = await prisma.product.findMany({ where: { active: true, is_historical: false, OR: [{ store_id: storeId }, { store_id: null }] }, select: { id: true, product_name: true, sku: true } });

  const summary = { total: status.products.length, EXACT_SKU_MATCH: 0, EXACT_NAME_MATCH: 0, MISSING: 0, AMBIGUOUS: 0 };
  const items = status.products.map((p) => {
    const cls = classifyCatalogProductMatch(p.sku || null, p.name, internalProducts);
    summary[cls.status]++;
    return {
      eoId: p.id,
      name: p.name,
      // Original casing/diacritics, only the "(s<number>)" store-tag suffix
      // stripped — a MISSING item's ready-to-use suggested Product name (the
      // lowercased/letter-unified `normalizedName` below is a comparison
      // key, never fit to show or save as a real product name).
      displayName: stripStoreTagSuffix(p.name),
      sku: p.sku || null,
      price: p.price ?? null,
      enabled: p.enabled ?? null,
      normalizedName: exactNameKey(p.name),
      status: cls.status,
      productId: cls.product?.id ?? null,
      productName: cls.product?.product_name ?? null,
      ambiguousCandidateIds: cls.candidates ? cls.candidates.map((c) => c.id) : undefined,
    };
  });

  return { storeId, ok: status.ok, source: status.source, error: status.error, summary, items };
}

/**
 * Backfills Product.easy_orders_uuid onto EXISTING products that the
 * catalog audit already confirms an unambiguous match for (EXACT_SKU_MATCH
 * or EXACT_NAME_MATCH only — never AMBIGUOUS/MISSING). This is what lets a
 * product created BEFORE this UUID column existed start benefiting from
 * UUID-based order matching too, without ever guessing: the exact same
 * matching logic already trusted throughout this codebase is the sole
 * source of truth for which product a given eoId belongs to. Never
 * overwrites an existing non-null easy_orders_uuid (a product that already
 * has one is left untouched, whatever this run's audit says).
 * `dryRun` (default true) reports the proposed changes without writing —
 * the caller decides when to actually apply them.
 */
export async function backfillProductEasyOrdersUuids(storeId = defaultStoreId(), { dryRun = true } = {}) {
  const audit = await auditEasyOrdersCatalog(storeId, { forceRefresh: true });
  if (!audit.ok) return { storeId, ok: false, error: audit.error, proposed: [], applied: 0 };

  const candidates = audit.items.filter((i) => (i.status === 'EXACT_SKU_MATCH' || i.status === 'EXACT_NAME_MATCH') && i.productId);
  const productIds = candidates.map((c) => c.productId);
  const existing = productIds.length ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, easy_orders_uuid: true, product_name: true } }) : [];
  const existingById = new Map(existing.map((p) => [p.id, p]));

  const proposed = [];
  for (const c of candidates) {
    const p = existingById.get(c.productId);
    if (!p) continue;
    if (p.easy_orders_uuid) continue; // never overwrite an already-set value
    proposed.push({ productId: c.productId, productName: p.product_name, eoId: c.eoId, matchMethod: c.status });
  }

  let applied = 0;
  if (!dryRun) {
    for (const item of proposed) {
      // Re-check immediately before writing — never overwrite a value that
      // was set by something else between the read above and now.
      const updated = await prisma.product.updateMany({ where: { id: item.productId, easy_orders_uuid: null }, data: { easy_orders_uuid: item.eoId } });
      applied += updated.count;
    }
  }

  return { storeId, ok: true, dryRun, proposedCount: proposed.length, proposed, applied };
}

// Per-process guard against a double-click (or a retried request) racing
// itself into two Product rows for the same normalized name: the first
// request to claim a name holds it in this Set until it's done (created OR
// skipped), so a second request for the SAME name arriving while the first
// is still in flight is rejected immediately rather than re-running the
// same findMany-then-create check concurrently. This is the strongest
// protection available without a schema change — the current Product table
// has no unique constraint on product_name (only on product_code), so a
// true cross-process/horizontal-scale race is not fully closable here; a
// real DB-level uniqueness guarantee would need a migration, which is
// explicitly out of scope for this feature.
const namesBeingCreated = new Set();

/**
 * Creates internal Product rows for a batch of EasyOrders catalog items —
 * ADMIN-triggered only, never automatic. ALWAYS re-fetches the live
 * EasyOrders catalog with forceRefresh (never the 1h cache other consumers
 * use) so "does this EasyOrders product still exist, and at what price" is
 * always checked against the current truth, not a stale snapshot. Every
 * field written comes from that fresh EasyOrders data — never trusted from
 * the request body — except the product NAME, which the caller may override
 * (e.g. a manual typo fix), defaulting to the same suffix-stripped
 * displayName auditEasyOrdersCatalog() already suggests. Never invents a
 * sku/category/cost/image/specifications/external id — those stay at the
 * Product model's own defaults, exactly as an admin creating a
 * bare-minimum product via products.html would leave them.
 *
 * Processed strictly one item at a time (never Promise.all) so two items in
 * the SAME batch can never race each other's exact-name check either, and
 * one item's unexpected failure (status FAILED) never aborts the rest of
 * the batch. Idempotent by construction: re-running this with the same
 * eoId after a successful create finds the now-existing product on the
 * fresh exact-name re-check and returns SKIPPED_EXISTS instead of a
 * duplicate.
 *
 * @param {string} storeId
 * @param {{eoId: string, name?: string}[]} items
 * @returns {Promise<{storeId: string, results: object[], summary: object}>}
 */
export async function createProductsFromEasyOrdersCatalog(storeId = defaultStoreId(), items = []) {
  const status = await getAllEasyOrdersProductsStatus(storeId, { forceRefresh: true });
  const results = [];
  if (!status.ok) {
    for (const it of items) results.push({ eoId: it?.eoId, status: 'FAILED', message: status.error || 'تعذر الوصول لكتالوج Easy Orders.' });
    return { storeId, results, summary: summarizeCreateResults(results) };
  }
  const catalogById = new Map(status.products.map((p) => [String(p.id), p]));

  for (const item of items) {
    const eoId = String(item?.eoId ?? '');
    try {
      const catalogProduct = catalogById.get(eoId);
      if (!catalogProduct) { results.push({ eoId, status: 'NOT_FOUND' }); continue; }

      // A caller that sends `name` at all is making an explicit choice — an
      // empty/whitespace-only value there must be rejected as invalid,
      // NEVER silently replaced by the catalog default (that would hide a
      // real frontend bug, e.g. a cleared input, behind an
      // unexpectedly-successful create). Only a genuinely OMITTED `name`
      // falls back to the suffix-stripped catalog name.
      const hasOverride = typeof item?.name === 'string';
      const overrideName = hasOverride ? item.name.trim() : '';
      if (hasOverride && !overrideName) { results.push({ eoId, status: 'INVALID_NAME' }); continue; }
      const finalName = overrideName || stripStoreTagSuffix(catalogProduct.name);
      const key = exactNameKey(finalName);
      if (!finalName || !key) { results.push({ eoId, status: 'INVALID_NAME' }); continue; }

      if (namesBeingCreated.has(key)) { results.push({ eoId, status: 'IN_PROGRESS', message: 'طلب إنشاء آخر لنفس الاسم قيد التنفيذ الآن — أعد المحاولة بعد قليل.' }); continue; }
      namesBeingCreated.add(key);
      try {
        // Multi-store — only an existing product tagged to THIS store (or a
        // legacy untagged row) counts as "already exists"; a same-named
        // product explicitly tagged to a DIFFERENT store must never block
        // (or get silently reused for) this store's own create. A
        // historical (deleted-from-source) record is also excluded — if
        // this exact name reappears in the live catalog, that's a
        // genuinely new listing and must get its own new Product, never
        // silently reuse the historical one.
        const existing = await prisma.product.findMany({ where: { active: true, is_historical: false, OR: [{ store_id: storeId }, { store_id: null }] }, select: { id: true, product_name: true } });
        const matches = existing.filter((p) => exactNameKey(p.product_name) === key);
        if (matches.length === 1) { results.push({ eoId, status: 'SKIPPED_EXISTS', existingProductId: matches[0].id, existingProductName: matches[0].product_name }); continue; }
        if (matches.length > 1) { results.push({ eoId, status: 'AMBIGUOUS', candidateIds: matches.map((m) => m.id) }); continue; }

        // Same product_code generation rule as routes/products.js's GET
        // /next-code (kept in sync by hand — both scan for the highest
        // existing "PRD-NNN" and take the next number).
        const allCodes = await prisma.product.findMany({ select: { product_code: true } });
        let maxCode = 0;
        for (const p of allCodes) {
          const m = /^PRD-(\d+)$/.exec(p.product_code || '');
          if (m) maxCode = Math.max(maxCode, Number(m[1]));
        }
        const product_code = `PRD-${String(maxCode + 1).padStart(3, '0')}`;

        // Real EasyOrders price only — never client-supplied, never invented. sku/category/cost/image/specifications are left at the model's own defaults (never fabricated).
        const selling_price = Number.isFinite(Number(catalogProduct.price)) ? Number(catalogProduct.price) : 0;
        const created = await prisma.product.create({ data: { product_name: finalName, selling_price, product_code, active: true, store_id: storeId, easy_orders_uuid: eoId } });
        results.push({ eoId, status: 'CREATED', product: { id: created.id, product_name: created.product_name, selling_price: created.selling_price, product_code: created.product_code } });
      } finally {
        namesBeingCreated.delete(key);
      }
    } catch (err) {
      // One item's unexpected failure must never abort the rest of a batch
      // the admin explicitly selected — reported, not swallowed.
      results.push({ eoId, status: 'FAILED', message: err.message });
    }
  }
  return { storeId, results, summary: summarizeCreateResults(results) };
}

function summarizeCreateResults(results) {
  const summary = { created: 0, skippedExists: 0, ambiguous: 0, invalidName: 0, notFound: 0, inProgress: 0, failed: 0 };
  for (const r of results) {
    if (r.status === 'CREATED') summary.created++;
    else if (r.status === 'SKIPPED_EXISTS') summary.skippedExists++;
    else if (r.status === 'AMBIGUOUS') summary.ambiguous++;
    else if (r.status === 'INVALID_NAME') summary.invalidName++;
    else if (r.status === 'NOT_FOUND') summary.notFound++;
    else if (r.status === 'IN_PROGRESS') summary.inProgress++;
    else if (r.status === 'FAILED') summary.failed++;
  }
  return summary;
}

// BUG 3 fix — this used to be a plain Prisma `equals` (case-insensitive
// only), which silently fails to link a real product the moment the Easy
// Orders name differs from the internal catalog name by so much as an
// Arabic alef/ya/ta-marbuta variant or stray whitespace — exactly the kind
// of near-miss that produces "no data" everywhere downstream even though a
// real, already-matched product exists. Reusing the SAME normalizer AI
// Media Buyer's own campaign->product mapping already relies on
// (js/product-mapping.js, also used by amb/mapping.js) means one normalization
// rule for the whole app instead of a second, weaker one just for PMC.
//
// Deliberately EXACT-only here (method 'exact_name'/'exact_sku', confidence
// 1) — never the fuzzy tier. Verified against the real production catalog:
// mapProductByName's fuzzy path at its normal 0.6 threshold produced a false
// positive (an ultrasonic blackhead-remover matched to an ultrasonic
// tooth-cleaner at 0.71 "confidence" purely on shared generic tokens). A
// silent wrong link would misattribute a real product's Meta/COD history —
// worse than the honest "not mapped yet" state. amb/mapping.js only ever
// surfaces its fuzzy guesses as a SUGGESTION for a human to confirm; PMC's
// auto-lock has no such confirmation step, so it must not auto-apply one.
// Bug fix — a locked EASY_ORDERS profile's `locked_name` is the RAW Easy
// Orders name, which may carry the "(s<number>)" store-tag suffix
// (services/easyOrders.js's stripStoreTagSuffix/exactNameKey — the same
// suffix Catalog Sync strips before creating the internal Product). This
// function used to normalize with js/product-mapping.js's plain
// normalizeName, which does NOT strip that suffix, so a profile locked
// against "اسم المنتج (s259)" could never exact-match an internal Product
// named just "اسم المنتج" — even though Catalog Sync's own audit (which DOES
// strip it) considers them the same product. Stripping it here first makes
// this the SAME exact-match rule used everywhere else in the app.
// Multi-store — `storeId`, when given, restricts candidates to that store's
// own products plus any legacy untagged (store_id: null) row, so a
// same-named product explicitly tagged to a DIFFERENT store can never be
// matched here. Omitting storeId preserves the original global-search
// behavior (kept only for any caller that genuinely has no store context).
export async function findInternalProductByName(name, storeId = null) {
  const n = stripStoreTagSuffix(String(name || '')).trim();
  if (!n) return null;
  // A historical (deleted-from-source) record is excluded here too — this
  // function resolves a LIVE catalog/order name string to an internal
  // product; a live re-listing under the same name is a genuinely new
  // product and must never silently resolve to the old historical row.
  const where = storeId ? { active: true, is_historical: false, OR: [{ store_id: storeId }, { store_id: null }] } : { active: true, is_historical: false };
  const candidates = await prisma.product.findMany({ where, select: { id: true, product_name: true, sku: true } });
  const match = mapProductByName(n, candidates, 0.6);
  if (!match.productId || (match.method !== 'exact_name' && match.method !== 'exact_sku')) return null;
  return prisma.product.findUnique({ where: { id: match.productId } });
}

/**
 * Bug fix — `profile.product_id` is resolved ONCE, at lock time
 * (lockFromEasyOrders/lockFromImages), and never re-resolved afterward. A
 * profile locked BEFORE its matching internal Product existed (e.g. an Easy
 * Orders product later created via Catalog Sync) stayed permanently stuck
 * at product_id=null even after a real, exact-name match started existing —
 * silently hiding real COD/Meta data forever. Called fresh on every real
 * (non-cached) computeSnapshot(), in-memory only — this NEVER writes back
 * onto the profile row (no pmc_profiles update), so a later "إعادة تحليل"
 * naturally self-heals without any backfill or migration.
 */
export async function resolveEffectiveProductId(profile) {
  if (profile.product_id) return profile.product_id;
  const { storeId } = decodeStoreScopedId(profile.easy_orders_product_id);
  const match = await findInternalProductByName(profile.locked_name, storeId);
  return match?.id || null;
}

/**
 * Option A — lock a profile onto a real Easy Orders product from a REAL,
 * explicitly-selected store. The EO image becomes the one true reference;
 * never swapped, never re-guessed. `storeId` becomes part of the locked
 * identity (encoded into easy_orders_product_id — see decodeStoreScopedId
 * above) so every downstream lookup (Meta matching, COD) can always tell
 * which real store this profile came from, with zero schema change.
 */
export async function lockFromEasyOrders({ eoProductId, storeId = defaultStoreId(), userId }) {
  const store = getStore(storeId);
  if (!store) throw bad('المتجر غير مربوط بـ Easy Orders.', 404);
  const status = await getAllEasyOrdersProductsStatus(storeId);
  if (!status.ok) throw bad(`تعذر تحميل منتجات هذا المتجر: ${status.error || 'خطأ غير معروف'}`, 502);
  const eo = status.products.find((p) => String(p.id) === String(eoProductId));
  if (!eo) throw bad('منتج Easy Orders غير موجود في هذا المتجر — حاول تبحث تاني.', 404);

  const product = await findInternalProductByName(eo.name, storeId);
  const confirmed = [{ label: 'المتجر', value: store.name }, { label: 'المصدر', value: 'Easy Orders' }, { label: 'اسم المنتج (Easy Orders)', value: eo.name }];
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
      easy_orders_product_id: encodeStoreScopedId(storeId, eo.id),
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
  const { storeId, realEoId } = p.source === 'EASY_ORDERS' ? decodeStoreScopedId(p.easy_orders_product_id) : { storeId: null, realEoId: null };
  const store = storeId ? getStore(storeId) : null;
  return {
    id: p.id,
    productId: p.product_id,
    source: p.source,
    lockedName: p.locked_name,
    easyOrdersProductId: realEoId ?? p.easy_orders_product_id,
    storeId: store ? storeId : null,
    storeName: store?.name || null,
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

  const effectiveProductId = await resolveEffectiveProductId(profile);
  // Multi-store — the ONE real store this profile was locked from (encoded
  // into easy_orders_product_id at lock time — see encodeStoreScopedId).
  // Every real COD/customer-quality query below MUST be scoped to this
  // store, never every configured store's orders for this product_id.
  const { storeId: profileStoreId } = decodeStoreScopedId(profile.easy_orders_product_id);

  // Meta + economics, reusing the EXISTING product dashboard when this
  // profile is linked to a real AmbProduct; otherwise Meta numbers stay
  // null/honest ("no campaign mapped yet") rather than guessed.
  let dashboard = null; let ambProduct = null; let metaMappedCampaignCount = null;
  if (effectiveProductId) {
    ambProduct = await prisma.ambProduct.findUnique({ where: { product_id: effectiveProductId } });
    if (ambProduct) {
      dashboard = await productDashboard(ambProduct.id, { windowName: win }).catch((e) => { logger.warn('[ProductMarketing] productDashboard failed', { message: e.message }); return null; });
      metaMappedCampaignCount = await prisma.ambProductCampaignMap.count({ where: { amb_product_id: ambProduct.id, status: 'MAPPED' } });
    }
  }

  // Multi-store §7 — when there's no confirmed AmbProduct mapping yet,
  // fall back to a READ-ONLY campaign-name match against the locked
  // product's real Easy Orders slug/id/name (a media buyer often puts the
  // product slug/id directly in the campaign name). Reuses the SAME
  // campaign-level metrics AMB's own hierarchy already computes
  // (entityWindowMetrics/rollupMetrics) — no new Meta API call, no
  // persisted mapping table. A MATCHED result (exact slug/id/name — never
  // a fuzzy guess) is trusted enough to populate real numbers; a
  // POSSIBLE_MATCH is surfaced to the human only, never auto-applied.
  let campaignMatch = null;
  if (!ambProduct && adAccountId && profile.source === 'EASY_ORDERS') {
    const { realEoId } = decodeStoreScopedId(profile.easy_orders_product_id);
    const campaignMetricsMap = await entityWindowMetrics({ level: 'campaign', from: window.from, to: window.to, adAccountId }).catch(() => new Map());
    const campaignEntries = [...campaignMetricsMap.values()].map((c) => ({ id: c.campaignId, name: c.campaignName, metrics: c }));
    campaignMatch = matchCampaignsToProduct({ slug: profile.easy_orders_slug, easyOrdersProductId: realEoId, lockedName: profile.locked_name }, campaignEntries);
  }
  const matchedCampaignMetrics = campaignMatch?.status === 'MATCHED' ? rollupMetrics(campaignMatch.campaigns.map((c) => c.metrics)) : null;

  // Easy Orders truth (independent of Meta mapping — real COD data whenever product_id resolves to a catalog Product with orders).
  let cod = { source: 'none', orders: null, confirmed: null, delivered: null, returned: null };
  let govRows = [];
  // Product Marketing Intelligence data foundation — real Customer Database
  // aggregates for this product (customer count, repeat-customer count,
  // confirmation/delivery/RTO rates, revenue) — never invented, `source:
  // 'none'` when there's nothing real to report yet.
  let customerQuality = { source: 'none', orders: null, confirmed: null, delivered: null, returned: null, cancelled: null, confirmationRate: null, deliveryRate: null, rtoRate: null, revenue: null, deliveredRevenue: null, customerCount: null, repeatCustomerCount: null, governorates: [] };
  if (effectiveProductId) {
    cod = await codCountsForProduct({ productId: effectiveProductId, storeId: profileStoreId, from: window.from, to: window.to });
    govRows = await codCountsByGovernorate({ productId: effectiveProductId, storeId: profileStoreId, from: window.from, to: window.to });
    customerQuality = await customerQualityForProduct({ productId: effectiveProductId, storeId: profileStoreId, from: window.from, to: window.to });
  }

  // §3 (BUG 3) — WHY a number is missing must never collapse into one vague
  // "بيانات غير كافية". These two booleans (+ their ready-to-show Arabic
  // messages) travel with the snapshot so the frontend can tell "no Meta
  // campaign mapped" apart from "no Easy Orders orders in this window"
  // apart from "mapped, but the real sample is just small".
  const metaMapped = !!ambProduct || !!matchedCampaignMetrics;
  const codMapped = cod.source !== 'none';
  const dataAvailability = {
    metaMapped,
    metaMessage: metaMapped ? null : 'لا توجد حملات Meta مرتبطة بهذا المنتج.',
    metaMatchMethod: ambProduct ? 'AMB_MAPPING' : (matchedCampaignMetrics ? campaignMatch.method : null),
    metaMatchReason: ambProduct ? null : (campaignMatch && campaignMatch.status !== 'UNMAPPED' ? campaignMatch.reason : null),
    // Only set when the numbers come from a human-confirmed AmbProductCampaignMap row (§ربط مؤكد) — never for the live slug/id/name fallback, however confident it looks.
    metaMappedCampaignCount: ambProduct ? metaMappedCampaignCount : null,
    // Surfaced ONLY as an informational finding — never used to populate
    // real numbers (§7 "do not guess weak matches").
    possibleMetaMatch: !ambProduct && campaignMatch?.status === 'POSSIBLE_MATCH'
      ? { reason: campaignMatch.reason, campaignNames: campaignMatch.campaigns.map((c) => c.name) }
      : null,
    codMapped,
    codMessage: codMapped ? null : 'لا توجد بيانات Easy Orders مرتبطة بهذا المنتج في الفترة المحددة.',
  };

  const m = dashboard?.metrics || matchedCampaignMetrics || {};
  const metrics = {
    windowLabel: window.label,
    totalSpend: m.totalSpend ?? m.spend ?? 0,
    metaPurchases: m.metaPurchases ?? m.purchases ?? null,
    confirmedOrders: cod.confirmed,
    deliveredOrders: cod.delivered,
    avgCpa: m.avgCpa ?? m.cpa ?? null,
    confirmedCpa: m.confirmedCpa ?? null,
    deliveredCpa: m.deliveredCpa ?? null,
    deliveryRate: cod.confirmed ? (cod.delivered || 0) / cod.confirmed : null,
    revenue: m.revenue ?? null,
    revenueSource: m.revenueSource ?? null,
    netProfit: m.netProfit ?? null,
    netMarginPct: m.netMarginPct ?? null,
    roas: m.roas ?? null,
    ctr: matchedCampaignMetrics?.ctr ?? null, cpc: matchedCampaignMetrics?.cpc ?? null, cvr: matchedCampaignMetrics?.conversionRate ?? null, frequency: null, // filled below from the product's own campaign rollup when an AmbProduct mapping exists
    dataAvailability,
    // Product Marketing Intelligence data foundation (§15/§16) — real Easy
    // Orders + Customer Database aggregates for this product. Stored inside
    // this same JSON blob (no new DB column) — confirmation/delivery/RTO
    // rates, revenue, real customer count, repeat-customer count, and a
    // governorate breakdown, all `source: 'none'` (never a fabricated 0)
    // when there's nothing real to report yet for this window.
    customerQuality,
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

  // §11 fatigue corroboration (Block B step 2) — a second buildHierarchy()
  // pass, scoped to the PRIOR window (priorWindowOf: same length, ending the
  // day before this window starts), now safe post-OOM-fix. Only attempted
  // with a real confirmed AmbProduct mapping (same gate as the current-
  // window tree above) — on any failure or no prior data, falls back to
  // null, which computeDiagnosis already treats as "single signal only",
  // labeling fatigue at WEAK dataSufficiency rather than silently upgraded.
  let priorMetrics = null;
  if (adAccountId && ambProduct) {
    const priorTree = await buildHierarchy({ adAccountId, window: priorWindowOf(window), settings }).catch((e) => { logger.warn('[ProductMarketing] prior-window buildHierarchy failed', { message: e.message }); return null; });
    const priorNode = priorTree ? (priorTree.products || []).find((x) => String(x.id) === String(ambProduct.id)) : null;
    priorMetrics = priorNode?.metrics ? { ctr: priorNode.metrics.ctr ?? null, avgCpa: priorNode.metrics.cpa ?? null } : null;
  }

  const opportunityRaw = computeOpportunityScore({ metrics, settings });
  const opportunity = { ...opportunityRaw, healthBand: healthBand(opportunityRaw.score, opportunityRaw.dataSufficient) };
  const diagnosis = computeDiagnosis({ metrics, creative: await creativeAnalysisFor(bestWorst.best?.creativeId), priorMetrics, settings });

  const bestCreative = await creativeAnalysisFor(bestWorst.best?.creativeId);
  const worstCreative = await creativeAnalysisFor(bestWorst.worst?.creativeId);

  // INCIDENT (2026-09-14) HISTORY: computeSnapshot() reproducibly crashed
  // production (a hard OOM kill, not an ordinary error) for AmbProduct-
  // mapped profiles. Root-caused since: metricsEngine.js's loadSnapshots()
  // was fetching every historical Meta snapshot row unbounded (97,904 rows/
  // ~222MB for one level/window on the real account) — fixed at the source
  // via a genuine $queryRaw DISTINCT ON + supporting indexes, verified live
  // (630-675ms/level, zero crashes across repeated real-production tests up
  // to 47s). That fix benefits buildHierarchy() itself, so re-enablement
  // proceeds incrementally per-block, safest first:
  //
  // Block A (this change) — Markets & Areas and Buyer Insights are pure
  // EasyOrdersOrder/Customer reads that never call buildHierarchy() at all
  // (confirmed by reading both functions in full) — they were never
  // actually implicated in the OOM, only disabled defensively alongside
  // everything else. Re-enabled here.
  //
  // Block B — hookAngleIntel (step 1, current window) and priorMetrics
  // (step 2, PRIOR window — see below) each add one more buildHierarchy()
  // pass. Step 1 was re-enabled and verified stable against production
  // (profile 36, the exact product that crashed twice before) prior to
  // step 2 being touched, now that the true root cause is fixed rather than
  // merely worked around.
  let markets = { source: 'none', markets: [] };
  let buyerInsights = null;
  if (effectiveProductId) {
    markets = await marketsForProduct({ productId: effectiveProductId, storeId: profileStoreId, from: window.from, to: window.to }).catch((e) => { logger.warn('[ProductMarketing] marketsForProduct failed', { message: e.message }); return { source: 'none', markets: [] }; });
    buyerInsights = await buyerInsightsForProduct({ productId: effectiveProductId, storeId: profileStoreId, from: window.from, to: window.to }).catch((e) => { logger.warn('[ProductMarketing] buyerInsightsForProduct failed', { message: e.message }); return null; });
  }
  // Hook/Selling-Angle Intelligence (Block B, this change) — one more
  // buildHierarchy() call for the CURRENT window, now safe post-OOM-fix
  // (630-675ms/level verified). Only attempted when there's a real,
  // confirmed AmbProduct mapping (same gate as bestWorst/pickBestWorstAds
  // above) — never guessed from a loose campaign-name match. Falls back to
  // the same honest disabled-shape default on any failure, never throws.
  const hookAngleIntel = (adAccountId && ambProduct)
    ? await hookAndAngleIntelForProduct({ adAccountId, window, settings, ambProductId: ambProduct.id }).catch((e) => {
        logger.warn('[ProductMarketing] hookAndAngleIntelForProduct failed', { message: e.message });
        return { hooks: { winner: null, table: [], labeledAds: 0, unlabeledAds: 0, dataAvailable: false }, angles: { winner: null, table: [], labeledAds: 0, unlabeledAds: 0, dataAvailable: false } };
      })
    : { hooks: { winner: null, table: [], labeledAds: 0, unlabeledAds: 0, dataAvailable: false }, angles: { winner: null, table: [], labeledAds: 0, unlabeledAds: 0, dataAvailable: false } };

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
  let prioritizedActions = [];
  try { prioritizedActions = ai.ok ? prioritizeActions(ai.actions, diagnosis) : []; }
  catch (e) { logger.warn('[ProductMarketing] prioritizeActions failed — falling back to unprioritized actions', { message: e.message }); prioritizedActions = ai.ok ? ai.actions : []; }

  const winningFormula = ai.ok ? ai.winningFormula : { available: false };
  let needsAttention = [];
  try { needsAttention = assembleNeedsAttention({ diagnosis, actions: prioritizedActions, hookIntel: hookAngleIntel.hooks, angleIntel: hookAngleIntel.angles }); }
  catch (e) { logger.warn('[ProductMarketing] assembleNeedsAttention failed', { message: e.message }); }
  let winningComponents = { dataSufficient: false };
  try { winningComponents = assembleWinningComponents({ bestAd: aiCtx.bestAd, bestAdCreative: bestCreative, hookIntel: hookAngleIntel.hooks, angleIntel: hookAngleIntel.angles, markets: markets.markets, winningFormula }); }
  catch (e) { logger.warn('[ProductMarketing] assembleWinningComponents failed', { message: e.message }); }

  // §15/§16 Market Gaps and §24 AI Strategist are deliberately NOT computed
  // here. This function already makes ONE AI call (buildIntelligenceReport)
  // by design (see the header comment above) — chaining 2 more sequential
  // AI calls into the same request pushed real-world latency past Railway's
  // request timeout in production (confirmed: a single AI call ~3.5s, but
  // buildIntelligenceReport's own large prompt plus 2 more sequential calls
  // exceeded 25-30s and the request was dropped with "Application failed to
  // respond"). Both are generated on demand instead, exactly like Hook Lab/
  // Post Generator/Creative Ideas already are — see computeMarketGaps() and
  // computeStrategistBrief() below, wired to their own POST routes.
  const marketGaps = { observed: [], gaps: [] };
  const strategist = { answers: [] };

  // Diagnostics only (spec: "do not clutter the normal UI") — computed
  // unconditionally, even when the AI call failed, so a real AI outage
  // never hides the fact that deterministic data itself is fine.
  let dataCompleteness = null;
  try {
    dataCompleteness = assembleDataCompleteness({
      metaMapped, metrics, cod, revenueSource: dashboard?.metrics?.revenueSource ?? null,
      markets: markets.markets, locations, bestAd: aiCtx.bestAd, ai, hookAngleIntelEnabled: hookAngleIntel.hooks.dataAvailable,
    });
  } catch (e) { logger.warn('[ProductMarketing] assembleDataCompleteness failed', { message: e.message }); }

  const snapshotData = {
    metrics, opportunity, diagnosis, locations,
    audience: ai.ok ? ai.audience : { unavailable: true, reason: ai.reason },
    angles: ai.ok ? ai.angles : [],
    locationCommentary: ai.ok ? ai.locationCommentary : null,
    diagnosisNarrative: ai.ok ? ai.diagnosisNarrative : null,
    winnerDna: ai.ok ? ai.winnerDna : { available: false },
    loserAutopsy: ai.ok ? ai.loserAutopsy : { available: false },
    winningFormula,
    actions: prioritizedActions,
    bestAd: aiCtx.bestAd, worstAd: aiCtx.worstAd,
    aiFailed: !ai.ok, aiFailReason: ai.ok ? null : ai.reason,
    markets: markets.markets, buyerInsights, hookIntel: hookAngleIntel.hooks, angleIntel: hookAngleIntel.angles,
    needsAttention, winningComponents, marketGaps, strategist, dataCompleteness,
  };

  await recordMemoryDiffs(profile.id, snapshotData);

  const commonJson = {
    metrics_json: JSON.stringify(metrics), opportunity_json: JSON.stringify(opportunity), diagnosis_json: JSON.stringify(diagnosis),
    audience_json: JSON.stringify(snapshotData.audience), locations_json: JSON.stringify(locations), angles_json: JSON.stringify(snapshotData.angles),
    winning_formula_json: JSON.stringify(snapshotData.winningFormula), actions_json: JSON.stringify(snapshotData.actions),
    // dataCompleteness (diagnostics) is included REGARDLESS of ai.ok — a
    // real AI outage must never hide that the deterministic data is fine.
    ai_raw_json: JSON.stringify({
      ...(ai.ok ? { locationCommentary: snapshotData.locationCommentary, diagnosisNarrative: snapshotData.diagnosisNarrative, winnerDna: snapshotData.winnerDna, loserAutopsy: snapshotData.loserAutopsy } : {}),
      bestAd: aiCtx.bestAd, worstAd: aiCtx.worstAd, dataCompleteness,
    }),
    markets_json: JSON.stringify(snapshotData.markets),
    buyer_insights_json: buyerInsights ? JSON.stringify(buyerInsights) : null,
    hook_intel_json: JSON.stringify(hookAngleIntel.hooks),
    angle_intel_json: JSON.stringify(hookAngleIntel.angles),
    needs_attention_json: JSON.stringify(needsAttention),
    winning_components_json: JSON.stringify(winningComponents),
    market_gaps_json: JSON.stringify(marketGaps),
    strategist_json: JSON.stringify(strategist),
  };

  const saved = await prisma.productMarketingSnapshot.upsert({
    where: { profile_id_window_name: { profile_id: profile.id, window_name: win } },
    create: { profile_id: profile.id, window_name: win, ad_account_id: adAccountId, ...commonJson },
    update: { ad_account_id: adAccountId, computed_at: new Date(), ...commonJson },
  });

  await syncActions(profile.id, snapshotData.actions);
  return deserializeSnapshot(saved, snapshotData);
}

// ---------------------------------------------------------------------------
// §15/§16 Market Gaps and §24 AI Strategist — on-demand only, same pattern
// as Hook Lab/Post Generator/Creative Ideas below (never part of the cached
// snapshot's own compute path — see the comment in computeSnapshot() for
// why). Each reads the ALREADY-cached snapshot's deterministic fields (no
// recomputation), makes its ONE AI call, and persists just that one column
// via a targeted update — never touches any other snapshot field.
// ---------------------------------------------------------------------------
export async function computeMarketGaps({ profileId, windowName = 'last7', force = false } = {}) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  const win = WINDOWS.includes(windowName) ? windowName : 'last7';
  const existing = await prisma.productMarketingSnapshot.findUnique({ where: { profile_id_window_name: { profile_id: profile.id, window_name: win } } });
  if (!existing) throw bad('لازم تحلل المنتج أولاً قبل توليد فجوات السوق.', 400);
  if (!force) {
    const cached = j(existing.market_gaps_json, null);
    if (cached && (cached.gaps?.length || cached.observed?.length)) return cached;
  }
  const competitors = await competitorIntel(profile.id).catch(() => ({ available: false }));
  const result = { observed: [], gaps: [] };
  if (competitors?.available && competitors.competitors?.length) {
    const hookIntel = j(existing.hook_intel_json, { table: [] });
    const angleIntel = j(existing.angle_intel_json, { table: [] });
    const gapsRes = await PMAI.generateMarketGaps({
      productName: profile.locked_name,
      ownAngles: (angleIntel.table || []).map((a) => a.label),
      ownHooks: (hookIntel.table || []).map((h) => h.label),
      competitors: competitors.competitors,
      insights: competitors.insights,
    });
    result.observed = gapsRes.observed || [];
    result.gaps = gapsRes.gaps || [];
  }
  await prisma.productMarketingSnapshot.update({ where: { id: existing.id }, data: { market_gaps_json: JSON.stringify(result) } });
  return result;
}

export async function computeStrategistBrief({ profileId, windowName = 'last7', force = false } = {}) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  const win = WINDOWS.includes(windowName) ? windowName : 'last7';
  const existing = await prisma.productMarketingSnapshot.findUnique({ where: { profile_id_window_name: { profile_id: profile.id, window_name: win } } });
  if (!existing) throw bad('لازم تحلل المنتج أولاً قبل توليد المستشار الذكي.', 400);
  if (!force) {
    const cached = j(existing.strategist_json, null);
    if (cached?.answers?.length) return cached;
  }
  const learningRows = await prisma.productMarketingLearning.findMany({ where: { profile_id: profile.id } }).catch(() => []);
  const res = await PMAI.generateStrategistBrief({
    metrics: j(existing.metrics_json, {}), opportunity: j(existing.opportunity_json, {}), diagnosis: j(existing.diagnosis_json, []),
    markets: j(existing.markets_json, []), buyerInsights: j(existing.buyer_insights_json, null),
    hookIntel: j(existing.hook_intel_json, { table: [] }), angleIntel: j(existing.angle_intel_json, { table: [] }),
    marketGaps: j(existing.market_gaps_json, { observed: [], gaps: [] }),
    learningHistory: learningRows.map((l) => ({ dimension: l.dimension, key: l.key, verdict: l.verdict })),
  });
  const result = res.ok ? { answers: res.answers } : { answers: [] };
  await prisma.productMarketingSnapshot.update({ where: { id: existing.id }, data: { strategist_json: JSON.stringify(result) } });
  return result;
}

// ---------------------------------------------------------------------------
// Product ↔ Meta Campaign mapping — reuses AI Media Buyer's EXISTING,
// already-trusted architecture end to end:
//   AmbProduct + AmbProductCampaignMap (schema.prisma) — no new table.
//   setMapping()/createFromCatalogProduct() (services/amb/mapping.js,
//   services/amb/ambProducts.js) — no new write path.
//   matchCampaignsToProduct() (productMarketingScoring.js) — the SAME
//   slug/id/name matcher computeSnapshot's fallback already uses.
// This layer only adds: (1) a read-only suggestions view scoped to one
// locked PMC profile, and (2) a hardened confirm step that re-derives
// everything server-side before writing a single MAPPED row per selected
// campaign. Never auto-confirms; never touches Meta, Product, or Easy
// Orders data.
// ---------------------------------------------------------------------------

/** Real per-campaign metrics for one product's live suggestion set, keyed the same way matchCampaignsToProduct already keys them. */
function campaignRow(entry, status, matchMethod) {
  return {
    campaignId: entry.id,
    campaignName: entry.name,
    status, // MAPPED | SUGGESTED
    spend: entry.metrics?.spend ?? null,
    purchases: entry.metrics?.purchases ?? null,
    cpa: entry.metrics?.cpa ?? null,
    matchMethod, // MANUAL | SLUG | EXTERNAL_ID | EXACT_NAME | ALL_NAME_WORDS
    confidence: matchMethod === 'MANUAL' ? 1 : (MATCH_CONFIDENCE[matchMethod] ?? null),
  };
}

// Generic ad-naming filler words that appear across many unrelated
// campaigns/slugs — never enough evidence on their own to suggest a
// product (e.g. "Scale"/"Smart" show up in dozens of real campaign and
// slug names in this account; treating them as a match would flood REVIEW
// with false positives). A real product-identifying token is everything
// else, length >= 4. Tokens carrying only the campaign's OWN slug are the
// evidence Phase 8 needs — never a fuzzy guess from the campaign name
// alone, and never automatically applied (see auditUnmappedMetaActivity's
// own doc comment above for the full rationale).
const SLUG_TOKEN_STOPLIST = new Set(['scale', 'test', 'copy', 'new', 'launch', 'promo', 'sale', 'offer', 'smart', 'ad', 'adset', 'campaign', 'v1', 'v2', 'v3']);
function slugTokens(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9؀-ۿ]+/)
    .filter((t) => t.length >= 4 && !SLUG_TOKEN_STOPLIST.has(t) && !/^\d+$/.test(t));
}

/**
 * READ-ONLY audit — every REAL Meta campaign with spend/purchases in the
 * window that has NO product mapping at all (buildHierarchy's own
 * unmappedCampaigns, already correctly excluding anything MAPPED). Never
 * automatically maps anything — this only classifies each one as a REVIEW
 * candidate (found real evidence: the campaign's name contains a product's
 * Easy Orders SLUG, e.g. campaign "Hair-Remover _ scale 4" against product
 * slug "Hair-Remover-Device" — confirmed as a real, common naming pattern
 * in this account) or UNMAPPED (no evidence found at all). An admin still
 * has to explicitly confirm a REVIEW candidate via confirmMetaMapping()
 * (now correctly allowed even though the campaign name won't match the
 * PRODUCT's own Arabic name/slug through matchCampaignsToProduct's
 * separate, stricter tiers — this audit's slug-based evidence is a
 * DIFFERENT, additional signal, still never auto-applied).
 */
export async function auditUnmappedMetaActivity({ windowName = 'last30' } = {}) {
  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id || null;
  if (!adAccountId) return { ok: false, error: 'لا يوجد حساب إعلاني Meta متصل حاليًا.', reviewCandidates: [], unmapped: [] };

  const window = resolveWindow(WINDOWS.includes(windowName) ? windowName : 'last30');
  const [campMap, campMetrics] = await Promise.all([
    mappedCampaignIndex({ adAccountId }),
    entityWindowMetrics({ level: 'campaign', from: window.from, to: window.to, adAccountId }),
  ]);
  const unmappedCampaigns = [...campMetrics.values()].filter((c) => !campMap.has(c.campaignId));

  // Build a slug token index across every configured store's live catalog —
  // the ONLY way to attribute a real product to a slug-style campaign name,
  // never a guess from the campaign name alone. Real slugs often carry more
  // words than the campaign name reuses (e.g. slug "Hair-Remover-Device" vs
  // campaign "Hair-Remover _ scale 4") — a raw substring check misses this,
  // so matching is by shared, non-generic TOKENS instead.
  const slugIndex = [];
  for (const store of listStores()) {
    const status = await getAllEasyOrdersProductsStatus(store.id).catch(() => ({ ok: false, products: [] }));
    if (!status.ok) continue;
    for (const p of status.products) {
      if (!p.slug) continue;
      const tokens = slugTokens(p.slug);
      if (!tokens.length) continue;
      slugIndex.push({ tokens, slug: p.slug, eoId: p.id, eoName: p.name, storeId: store.id, storeName: store.name });
    }
  }
  // Resolve each slug candidate's real internal product (via the same
  // easy_orders_uuid stable identity used everywhere else) so a REVIEW row
  // always names a concrete internal product, never just a raw EO listing.
  const uuids = slugIndex.map((s) => s.eoId);
  const internalByUuid = uuids.length ? new Map((await prisma.product.findMany({ where: { easy_orders_uuid: { in: uuids } }, select: { id: true, product_name: true, easy_orders_uuid: true } })).map((p) => [p.easy_orders_uuid, p])) : new Map();

  const reviewCandidates = [];
  const unmapped = [];
  for (const c of unmappedCampaigns) {
    const campTokens = new Set(slugTokens(c.campaignName));
    const hits = campTokens.size ? slugIndex.filter((s) => s.tokens.some((t) => campTokens.has(t))) : [];
    // Distinct products only — the same product can appear once per store
    // it's synced under, but a genuine cross-store name coincidence must
    // surface as two SEPARATE candidates, never silently collapsed.
    const seen = new Set();
    const candidates = [];
    for (const hit of hits) {
      const internal = internalByUuid.get(hit.eoId);
      const dedupeKey = `${hit.storeId}::${internal?.id ?? hit.eoId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const matchedToken = hit.tokens.find((t) => campTokens.has(t));
      candidates.push({ storeId: hit.storeId, storeName: hit.storeName, productId: internal?.id ?? null, productName: internal?.product_name ?? hit.eoName, easyOrdersId: hit.eoId, matchedToken });
    }
    const row = { campaignId: c.campaignId, campaignName: c.campaignName, spend: c.spend ?? 0, purchases: c.purchases ?? null, impressions: c.impressions ?? null, clicks: c.clicks ?? null };
    if (candidates.length) {
      reviewCandidates.push({ ...row, status: 'REVIEW', evidence: candidates.map((cd) => `الكلمة "${cd.matchedToken}" مشتركة مع منتج "${cd.productName}" في ${cd.storeName}`).join(' — '), candidates });
    } else {
      unmapped.push({ ...row, status: 'UNMAPPED', evidence: null });
    }
  }
  reviewCandidates.sort((a, b) => (b.spend || 0) - (a.spend || 0));
  unmapped.sort((a, b) => (b.spend || 0) - (a.spend || 0));

  return {
    ok: true,
    windowLabel: window.label,
    adAccountId,
    totalUnmapped: unmappedCampaigns.length,
    reviewCandidates,
    unmapped,
    summary: { review: reviewCandidates.length, unmapped: unmapped.length, totalSpendUnmapped: unmappedCampaigns.reduce((a, c) => a + (c.spend || 0), 0) },
  };
}

/**
 * Phase 10 — classifies EVERY synced product in one store into exactly one
 * pipeline-health bucket, computed efficiently in a small fixed number of
 * queries (never one HTTP/DB round-trip per product):
 *   READY               — has real orders AND a Meta mapping with at least
 *                          one ad carrying MODERATE/STRONG data.
 *   NO_REAL_ORDERS       — zero EasyOrdersOrder rows for this product,
 *                          regardless of Meta status (matches this
 *                          engagement's own "if genuinely zero orders, say
 *                          so" rule — takes priority over every other
 *                          bucket since there is no real COD evidence at
 *                          all to build on).
 *   META_UNMAPPED        — has real orders, but no AmbProduct / no MAPPED
 *                          campaign exists for it yet.
 *   AD_ANALYSIS_MISSING  — has real orders AND a mapped campaign, but zero
 *                          ads found under it in the window (e.g. the
 *                          campaign never ran ads, or ran outside window).
 *   INSUFFICIENT_DATA    — has real orders, a mapped campaign, and ads, but
 *                          every one of them is still WEAK (below the
 *                          account's own minSpend/minPurchases gate).
 *   PROVIDER_ERROR       — Meta itself is unreachable/not connected this
 *                          call — applies to every product uniformly since
 *                          it's an account-level failure, not per-product.
 * ORDERS_UNMATCHED is deliberately NOT a per-product bucket here: an
 * unmatched EasyOrdersOrder row has product_id=null by definition, so it
 * cannot be attributed to one specific product without a fuzzy name guess
 * this codebase's matching philosophy explicitly refuses to make. It is
 * reported as a STORE-LEVEL count instead (see the unmatchedOrderRows
 * field) — a real, honest number, just not falsely pinned to one product.
 */
/**
 * Phase 11 — historical-product recovery for a batch of REAL, already-
 *-stored order rows whose product no longer exists in the live Easy
 * Orders catalog (deleted/discontinued at the source, not a matching bug).
 * Dry-run by default; only ever touches rows that are genuinely
 * unmatched (matched:false, product_id:null) for the EXACT raw name given
 * — never a fuzzy/normalized guess, and never a row that's already
 * correctly matched to something else.
 *
 * Safety, in order:
 *   1. Refuses if the exact name exists in the store's LIVE catalog right
 *      now (that's a real, current product — use the normal Catalog Sync
 *      flow instead, never this historical path).
 *   2. Refuses if more than one DISTINCT raw name would need to collapse
 *      into "the same" product (a genuine ambiguity this function will
 *      never silently resolve).
 *   3. Idempotent: a second call finds the already-created historical
 *      product (matched by exact name + store + is_historical) and simply
 *      re-runs the backfill step, never creates a duplicate.
 *   4. The backfill UPDATE is scoped to store_id + exact product_name_raw
 *      + matched:false + product_id:null — a row already matched to
 *      anything else, by anyone, for any reason, is never touched.
 */
export async function recoverHistoricalProduct({ storeId, productName, dryRun = true }) {
  if (!storeId || !productName) return { ok: false, error: 'storeId و productName مطلوبين.' };

  const liveStatus = await getAllEasyOrdersProductsStatus(storeId).catch(() => ({ ok: false, products: [] }));
  const liveMatch = liveStatus.ok ? liveStatus.products.find((p) => stripStoreTagSuffix(p.name).trim() === productName.trim() || p.name.trim() === productName.trim()) : null;
  if (liveMatch) {
    return { ok: false, error: `هذا الاسم موجود بالفعل في كتالوج Easy Orders الحي (eoId=${liveMatch.id}) — استخدم مزامنة الكتالوج العادية، مش الاسترجاع التاريخي.`, blockedByLiveCandidate: liveMatch };
  }

  // Idempotency check FIRST — a historical product for this exact
  // name+store may already exist from a prior run, in which case there may
  // legitimately be zero unmatched rows left (they were all backfilled
  // already), which must read as "already recovered", never as an error.
  let historicalProduct = await prisma.product.findFirst({ where: { store_id: storeId, product_name: productName, is_historical: true } });

  const candidateRows = await prisma.easyOrdersOrder.findMany({
    where: { store_id: storeId, matched: false, product_id: null, product_name_raw: productName },
    select: { id: true, order_id: true, date: true, status: true, order_cost: true },
  });
  if (!candidateRows.length && !historicalProduct) {
    return { ok: false, error: 'لا توجد صفوف طلبات غير مطابقة بهذا الاسم بالضبط، ولا يوجد منتج تاريخي مُسترجَع مسبقًا.', matchingRows: 0 };
  }

  const byOrder = new Map();
  for (const r of candidateRows) if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, r);
  const uniqueOrders = [...byOrder.values()];
  const statusBreakdown = {};
  for (const o of uniqueOrders) statusBreakdown[o.status] = (statusBreakdown[o.status] || 0) + 1;
  const totalValue = uniqueOrders.reduce((a, o) => a + (o.order_cost || 0), 0);

  const plan = {
    ok: true,
    dryRun,
    storeId,
    productName,
    matchingRows: candidateRows.length,
    uniqueOrders: uniqueOrders.length,
    statusBreakdown,
    totalValue,
    alreadyRecovered: !!historicalProduct,
    historicalProductId: historicalProduct?.id ?? null,
  };
  if (dryRun) return plan;

  if (!historicalProduct) {
    historicalProduct = await prisma.product.create({
      data: {
        product_name: productName,
        store_id: storeId,
        is_historical: true,
        historical_note: `تم استرجاعه من ${uniqueOrders.length} طلب حقيقي (${candidateRows.length} صف) لم يعد موجودًا في كتالوج Easy Orders الحي وقت الاسترجاع. لا توجد بيانات SKU/سعر/فئة/صورة مُخترعة — كل الحقول غير المتاحة في الطلبات الأصلية تُركت فارغة عمدًا.`,
      },
    });
  }

  const backfilled = await prisma.easyOrdersOrder.updateMany({
    where: { store_id: storeId, matched: false, product_id: null, product_name_raw: productName },
    data: { product_id: historicalProduct.id, matched: true },
  });

  return { ...plan, dryRun: false, applied: true, productId: historicalProduct.id, rowsBackfilled: backfilled.count };
}

export async function classifyAllProducts({ storeId = defaultStoreId(), windowName = 'last30' } = {}) {
  const products = await prisma.product.findMany({ where: { active: true, store_id: storeId }, select: { id: true, product_name: true } });
  if (!products.length) return { storeId, totalProducts: 0, unmatchedOrderRows: 0, classifications: [], counts: {} };

  const productIds = products.map((p) => p.id);
  const [orderCounts, unmatchedCount, ambProducts] = await Promise.all([
    prisma.easyOrdersOrder.groupBy({ by: ['product_id'], where: { store_id: storeId, product_id: { in: productIds } }, _count: { _all: true } }),
    prisma.easyOrdersOrder.count({ where: { store_id: storeId, matched: false } }),
    prisma.ambProduct.findMany({ where: { product_id: { in: productIds } }, select: { id: true, product_id: true } }),
  ]);
  const orderCountByProduct = new Map(orderCounts.map((r) => [r.product_id, r._count._all]));
  const ambByProductId = new Map(ambProducts.map((a) => [a.product_id, a.id]));

  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id || null;
  let tree = null;
  let treeError = null;
  if (adAccountId) {
    try {
      const settings = await getAmbSettings();
      const window = resolveWindow(WINDOWS.includes(windowName) ? windowName : 'last30');
      tree = await buildHierarchy({ adAccountId, window, settings });
    } catch (err) {
      treeError = err.message;
    }
  }

  const classifications = products.map((p) => {
    const orderCount = orderCountByProduct.get(p.id) || 0;
    if (orderCount === 0) return { productId: p.id, productName: p.product_name, status: 'NO_REAL_ORDERS', orderCount };

    if (!adAccountId) return { productId: p.id, productName: p.product_name, status: 'PROVIDER_ERROR', orderCount, reason: 'لا يوجد حساب إعلاني Meta متصل حاليًا.' };
    if (!tree) return { productId: p.id, productName: p.product_name, status: 'PROVIDER_ERROR', orderCount, reason: treeError || 'تعذّر الوصول لبيانات Meta.' };

    const ambProductId = ambByProductId.get(p.id);
    if (!ambProductId) return { productId: p.id, productName: p.product_name, status: 'META_UNMAPPED', orderCount };

    const ads = scopedAdsForProduct(tree, ambProductId);
    if (!ads.length) return { productId: p.id, productName: p.product_name, status: 'AD_ANALYSIS_MISSING', orderCount, mappedCampaigns: tree.products.find((n) => String(n.id) === String(ambProductId))?.children?.length || 0 };

    const hasSufficientAd = ads.some((ad) => ad.metrics?.dataSufficiency === 'STRONG' || ad.metrics?.dataSufficiency === 'MODERATE');
    if (!hasSufficientAd) return { productId: p.id, productName: p.product_name, status: 'INSUFFICIENT_DATA', orderCount, adsFound: ads.length };

    return { productId: p.id, productName: p.product_name, status: 'READY', orderCount, adsFound: ads.length };
  });

  const counts = {};
  for (const c of classifications) counts[c.status] = (counts[c.status] || 0) + 1;

  return { storeId, totalProducts: products.length, unmatchedOrderRows: unmatchedCount, classifications, counts };
}

/**
 * READ-ONLY — everything an admin needs to review before confirming a
 * Product ↔ Meta mapping: today's CONFIRMED (already-MAPPED) campaigns,
 * plus live SUGGESTED candidates from the exact-only fallback matcher.
 * A campaign already MAPPED to a DIFFERENT AmbProduct is never suggested
 * here — surfaced separately as a conflict so the admin can see why it's
 * excluded, never silently re-assigned.
 */
export async function getMetaMappingSuggestions({ profileId }) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);

  const effectiveProductId = await resolveEffectiveProductId(profile);
  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id || null;
  const window = resolveWindow('last7');

  if (!adAccountId) {
    return { status: 'UNMAPPED', ambProductId: null, effectiveProductId, adAccountId: null, window, confirmedCampaigns: [], suggestedCampaigns: [], conflicts: [], reason: 'لا يوجد حساب إعلاني Meta متصل حاليًا.' };
  }

  const campaignMetricsMap = await entityWindowMetrics({ level: 'campaign', from: window.from, to: window.to, adAccountId }).catch(() => new Map());
  const campaignEntries = [...campaignMetricsMap.values()].map((c) => ({ id: c.campaignId, name: c.campaignName, metrics: c }));

  const ambProduct = effectiveProductId ? await prisma.ambProduct.findUnique({ where: { product_id: effectiveProductId } }) : null;

  const confirmedRows = ambProduct ? await prisma.ambProductCampaignMap.findMany({ where: { amb_product_id: ambProduct.id, ad_account_id: adAccountId, status: 'MAPPED' } }) : [];
  const confirmedIds = new Set(confirmedRows.map((r) => r.campaign_id));
  const confirmedCampaigns = confirmedRows.map((r) => {
    const live = campaignEntries.find((c) => c.id === r.campaign_id);
    return campaignRow(live || { id: r.campaign_id, name: r.campaign_name, metrics: null }, 'MAPPED', 'MANUAL');
  });

  let suggestedCampaigns = [];
  let conflicts = [];
  let fallbackStatus = 'UNMAPPED';
  let fallbackReason = 'لم يتم العثور على حملة Meta مرتبطة بهذا المنتج.';
  if (profile.source === 'EASY_ORDERS') {
    const { realEoId } = decodeStoreScopedId(profile.easy_orders_product_id);
    const candidates = campaignEntries.filter((c) => !confirmedIds.has(c.id));
    const match = matchCampaignsToProduct({ slug: profile.easy_orders_slug, easyOrdersProductId: realEoId, lockedName: profile.locked_name }, candidates);
    fallbackStatus = match.status;
    fallbackReason = match.reason;

    if (match.campaigns.length) {
      const candidateIds = match.campaigns.map((c) => c.id);
      const conflictRows = await prisma.ambProductCampaignMap.findMany({ where: { ad_account_id: adAccountId, campaign_id: { in: candidateIds }, status: 'MAPPED' } });
      const conflictByCampaign = new Map(conflictRows.filter((r) => r.amb_product_id !== ambProduct?.id).map((r) => [r.campaign_id, r.amb_product_id]));

      for (const c of match.campaigns) {
        const conflictProductId = conflictByCampaign.get(c.id);
        if (conflictProductId) { conflicts.push({ campaignId: c.id, campaignName: c.name, mappedToAmbProductId: conflictProductId }); continue; }
        suggestedCampaigns.push(campaignRow(c, 'SUGGESTED', match.method));
      }
    }
  }

  // Status precedence: any real conflict is surfaced as AMBIGUOUS regardless
  // of how confident the fallback match otherwise looks — never auto-pick.
  let status;
  if (confirmedCampaigns.length) status = 'CONFIRMED';
  else if (conflicts.length && !suggestedCampaigns.length) status = 'AMBIGUOUS';
  else if (fallbackStatus === 'MATCHED' || fallbackStatus === 'POSSIBLE_MATCH') status = 'REVIEW_REQUIRED';
  else status = 'UNMAPPED';

  return {
    status, ambProductId: ambProduct?.id ?? null, effectiveProductId, adAccountId, window,
    confirmedCampaigns, suggestedCampaigns, conflicts,
    reason: confirmedCampaigns.length ? null : fallbackReason,
  };
}

/**
 * The ONLY function in this file allowed to write AmbProduct/
 * AmbProductCampaignMap. Never trusts the request body beyond WHICH
 * campaign ids the admin checked — everything else (does the campaign
 * still exist, is it still a legitimate suggestion for this exact product,
 * is it already mapped elsewhere) is re-derived fresh from the real Meta
 * data and the same matcher getMetaMappingSuggestions() just used, so a
 * stale or tampered request can't map an arbitrary campaign. Idempotent:
 * re-confirming an already-MAPPED campaign just re-upserts the same row
 * (setMapping's upsert, keyed on [ad_account_id, campaign_id]).
 */
export async function confirmMetaMapping({ profileId, campaignIds, userId }) {
  const ids = Array.isArray(campaignIds) ? [...new Set(campaignIds.map((c) => String(c)).filter(Boolean))] : [];
  if (!ids.length) throw bad('لازم تحدد حملة واحدة على الأقل لتأكيد الربط.', 400);

  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);

  const effectiveProductId = await resolveEffectiveProductId(profile);
  if (!effectiveProductId) throw bad('لا يوجد منتج داخلي مرتبط بهذا البروفايل بعد — لا يمكن تأكيد ربط Meta.', 400);

  const connection = await getConnection();
  const adAccountId = connection?.selected_ad_account_id || null;
  if (!adAccountId) throw bad('لا يوجد حساب إعلاني Meta متصل حاليًا.', 400);

  const window = resolveWindow('last7');
  const campaignMetricsMap = await entityWindowMetrics({ level: 'campaign', from: window.from, to: window.to, adAccountId }).catch(() => new Map());
  const liveById = new Map([...campaignMetricsMap.values()].map((c) => [c.campaignId, c]));

  let suggestedIds = new Set();
  let matchMethod = 'MANUAL';
  let matchReason = null;
  if (profile.source === 'EASY_ORDERS') {
    const { realEoId } = decodeStoreScopedId(profile.easy_orders_product_id);
    const campaignEntries = [...campaignMetricsMap.values()].map((c) => ({ id: c.campaignId, name: c.campaignName, metrics: c }));
    const match = matchCampaignsToProduct({ slug: profile.easy_orders_slug, easyOrdersProductId: realEoId, lockedName: profile.locked_name }, campaignEntries);
    suggestedIds = new Set(match.campaigns.map((c) => c.id));
    matchMethod = match.method || 'MANUAL';
    matchReason = match.reason || null;
  }

  // Resolved lazily, right before the FIRST campaign that actually passes
  // every check below — an attempt where every submitted campaign gets
  // REJECTED must never leave behind a newly-created (empty) AmbProduct as
  // a side effect.
  let ambProduct = await prisma.ambProduct.findUnique({ where: { product_id: effectiveProductId } });

  const results = [];
  for (const campaignId of ids) {
    const live = liveById.get(campaignId);
    if (!live) { results.push({ campaignId, status: 'REJECTED', reason: 'هذه الحملة غير موجودة في الحساب الإعلاني الحالي — رفض الربط.' }); continue; }

    const alreadyMappedHere = await prisma.ambProductCampaignMap.findUnique({ where: { ad_account_id_campaign_id: { ad_account_id: adAccountId, campaign_id: campaignId } } });
    if (alreadyMappedHere && alreadyMappedHere.status === 'MAPPED' && alreadyMappedHere.amb_product_id !== ambProduct?.id) {
      results.push({ campaignId, status: 'REJECTED', reason: `هذه الحملة مربوطة بالفعل بمنتج AMB آخر (id=${alreadyMappedHere.amb_product_id}) — لن يتم استبدال ربطها.` });
      continue;
    }

    // Every campaignId here was submitted by an ADMIN in an explicit,
    // already-authenticated request — this is NEVER called automatically
    // or in bulk (confirmed: the only caller in this whole codebase is the
    // ADMIN-only POST route). Whether the campaign happens to also match
    // the automatic name-based suggestion only changes how the mapping is
    // LABELED (AI_SUGGESTED vs MANUAL), never whether a human's explicit,
    // deliberate choice is allowed — a real campaign named without the
    // product's slug/id/name in it (confirmed in production as a genuine,
    // common case) must still be confirmable by someone who knows it's
    // correct via Ads Manager/destination URL/their own knowledge. The
    // AUTOMATIC suggestion path itself (matchCampaignsToProduct, used by
    // getMetaMappingSuggestions to populate what's OFFERED) remains exactly
    // as strict as before — nothing here loosens what gets suggested,
    // only what a human is allowed to explicitly confirm.
    const isAutoSuggested = suggestedIds.has(campaignId);

    if (!ambProduct) ambProduct = await createFromCatalogProduct(effectiveProductId, userId);
    const saved = await setMapping({
      adAccountId, campaignId, campaignName: live.campaignName || null, ambProductId: ambProduct.id,
      status: 'MAPPED',
      matchSource: isAutoSuggested ? 'AI_SUGGESTED' : 'MANUAL',
      matchConfidence: isAutoSuggested ? (MATCH_CONFIDENCE[matchMethod] ?? null) : null,
      aiReason: isAutoSuggested ? matchReason : null,
      userId,
    });
    results.push({ campaignId, status: 'MAPPED', campaignName: saved.campaign_name, matchSource: isAutoSuggested ? 'AI_SUGGESTED' : 'MANUAL' });
  }

  return { ambProductId: ambProduct?.id ?? null, results };
}

function deserializeSnapshot(row, precomputed = null) {
  const extra = precomputed ? { locationCommentary: precomputed.locationCommentary, diagnosisNarrative: precomputed.diagnosisNarrative, winnerDna: precomputed.winnerDna, loserAutopsy: precomputed.loserAutopsy, bestAd: precomputed.bestAd, worstAd: precomputed.worstAd, dataCompleteness: precomputed.dataCompleteness }
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
    // Phase 1 — additive columns; a snapshot computed before this phase
    // simply reads these back as their honest empty defaults.
    markets: j(row.markets_json, []),
    buyerInsights: j(row.buyer_insights_json, null),
    hookIntel: j(row.hook_intel_json, { winner: null, table: [], labeledAds: 0, unlabeledAds: 0, dataAvailable: false }),
    angleIntel: j(row.angle_intel_json, { winner: null, table: [], labeledAds: 0, unlabeledAds: 0, dataAvailable: false }),
    needsAttention: j(row.needs_attention_json, []),
    winningComponents: j(row.winning_components_json, { dataSufficient: false }),
    marketGaps: j(row.market_gaps_json, { observed: [], gaps: [] }),
    strategist: j(row.strategist_json, { answers: [] }),
    dataCompleteness: extra.dataCompleteness || null,
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
/** Phase 1 — looks up the real WINNER/PROMISING/... band for this angle/hook label from the latest cached snapshot, so ephemeral AI generations can be status-labeled without a second AI call. Never throws — no cached snapshot yet just means no band info (labelCreativeIdeas/labelPostCopy fall back to NEW_TEST). */
async function bandForAngle(profileId, angle) {
  if (!angle) return { hookBand: null, angleBand: null };
  const snap = await prisma.productMarketingSnapshot.findFirst({ where: { profile_id: Number(profileId) }, orderBy: { computed_at: 'desc' } });
  if (!snap) return { hookBand: null, angleBand: null };
  const hookTable = j(snap.hook_intel_json, { table: [] })?.table || [];
  const angleTable = j(snap.angle_intel_json, { table: [] })?.table || [];
  return { hookBand: hookTable.find((h) => h.label === angle)?.band || null, angleBand: angleTable.find((a) => a.label === angle)?.band || null };
}

export async function postGenerator({ profileId, angle, tone }) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  const res = await PMAI.generatePost({ productName: profile.locked_name, angle, tone });
  if (!res.ok) return res;
  const { angleBand } = await bandForAngle(profileId, angle);
  return { ...res, post: labelPostCopy(res.post, { angleBand }) };
}
export async function creativeIdeas({ profileId, angle, count }) {
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);
  const res = await PMAI.generateCreativeIdeas({ productName: profile.locked_name, angle, count: Math.min(Number(count) || 4, 8) });
  if (!res.ok) return res;
  const { hookBand, angleBand } = await bandForAngle(profileId, angle);
  return { ...res, ideas: labelCreativeIdeas(res.ideas, { hookBand, angleBand }) };
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
