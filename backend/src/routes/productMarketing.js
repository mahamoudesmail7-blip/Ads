// AI Product Marketing Center — "مركز التسويق الذكي للمنتج". Mounted at
// /api/product-marketing. Fully additive/isolated module — same auth tier as
// AI Media Buyer (ADMIN|MANAGER read/analyze; ADMIN for decisions). Never
// writes to Meta: every handler here is read/analyze/decide-a-recommendation
// only. See services/amb/productMarketing.js for the real logic.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import * as PM from '../services/amb/productMarketing.js';
import * as PMT from '../services/amb/productMarketingTests.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

function idParam(v) { const n = Number(v); if (!Number.isInteger(n) || n <= 0) { const e = new Error('مُعرّف غير صالح.'); e.status = 400; throw e; } return n; }

// ---- Multi-store (§1/§2) — safe metadata only, NEVER a credential ----
router.get('/stores', asyncRoute(async (req, res) => res.json({ stores: PM.listEasyOrdersStores() })));

// ---- ADMIN-only diagnostic: which Railway env var NAME each store's key/
// secret reads from, and whether it's currently non-empty — NEVER the value
// itself. Exists so an admin can be told exactly which Railway variable to
// check/fix without anyone (including Claude) ever seeing the real key. ----
router.get('/stores/diagnostics', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  res.json({ stores: PM.storeConfigDiagnostics() });
}));

// ---- Read-only catalog-vs-internal-Product audit (decide Sync vs Mapping) ----
// ADMIN only (stricter than this router's default ADMIN|MANAGER) — this is a
// diagnostic tool, not a normal PMC workflow surface. Never creates/updates
// a Product, never touches an order, never calls Meta.
// `force_refresh=true` bypasses the shared 1h Easy-Orders-catalog cache for
// THIS call only (still refills it with the fresh result) — the Catalog
// Sync page always passes it so a product just added on Easy Orders shows
// up immediately; every other caller of this same endpoint (e.g. the PMC
// nav badge) omits it and keeps the normal cached behavior unchanged.
router.get('/easy-orders/catalog-audit', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  res.json(await PM.auditEasyOrdersCatalog(req.query.store_id || undefined, { forceRefresh: req.query.force_refresh === 'true' }));
}));

// ---- Create internal Products for MISSING catalog items — ADMIN only, ----
// ---- explicit per-item action, never automatic. ----
router.post('/easy-orders/catalog-audit/create', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) { const e = new Error('لا يوجد أي منتج محدد للإنشاء.'); e.status = 400; throw e; }
  if (items.length > 100) { const e = new Error('حد أقصى 100 منتج في الطلب الواحد.'); e.status = 400; throw e; }
  const safeItems = items.map((it) => ({ eoId: it?.eoId, name: typeof it?.name === 'string' ? it.name : undefined }));
  res.json(await PM.createProductsFromEasyOrdersCatalog(req.body?.store_id || undefined, safeItems));
}));

// ---- Backfill Product.easy_orders_uuid onto already-matched EXISTING ----
// ---- products — ADMIN only, dry-run by default. Never guesses: only ----
// ---- the same EXACT_SKU_MATCH/EXACT_NAME_MATCH the audit above already ----
// ---- trusts. Pass apply=true to actually write (still never overwrites ----
// ---- a product that already has a UUID recorded). ----
router.post('/easy-orders/backfill-uuids', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  res.json(await PM.backfillProductEasyOrdersUuids(req.body?.store_id || undefined, { dryRun: req.body?.apply !== true }));
}));

// ---- Product source / lock ----
router.get('/easy-orders/search', asyncRoute(async (req, res) => {
  // §1 — the service now returns {products, ok, source, error} so a real
  // EasyOrders API/network/config failure is never indistinguishable from
  // a genuinely empty catalogue — passed straight through, not re-wrapped.
  // storeId is optional — omitting it keeps every pre-multi-store caller
  // working exactly as before (resolves to the one default store).
  res.json(await PM.searchEasyOrdersProducts(req.query.q, req.query.store_id || undefined));
}));
router.post('/profiles/from-easy-orders', asyncRoute(async (req, res) => {
  res.status(201).json(await PM.lockFromEasyOrders({ eoProductId: req.body?.eoProductId, storeId: req.body?.storeId || undefined, userId: req.user.id }));
}));
router.post('/profiles/from-images', asyncRoute(async (req, res) => {
  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  res.status(201).json(await PM.lockFromImages({ images, userId: req.user.id }));
}));
router.get('/profiles', asyncRoute(async (req, res) => res.json({ profiles: await PM.listProfiles() })));
router.get('/profiles/:id', asyncRoute(async (req, res) => res.json(await PM.getProfile(idParam(req.params.id)))));
router.get('/profiles/:id/images/:imageId', asyncRoute(async (req, res) => {
  const dataUrl = await PM.getProfileImage(idParam(req.params.id), idParam(req.params.imageId));
  const [, mime, b64] = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl) || [];
  res.set('Content-Type', mime || 'image/png').set('Cache-Control', 'private, max-age=300').send(Buffer.from(b64 || '', 'base64'));
}));

// ---- Snapshot ("the brain") ----
router.get('/profiles/:id/snapshot', asyncRoute(async (req, res) => {
  const snap = await PM.getSnapshot({ profileId: idParam(req.params.id), windowName: req.query.window });
  res.json({ snapshot: snap, stale: !snap });
}));
router.post('/profiles/:id/analyze', asyncRoute(async (req, res) => {
  res.json(await PM.computeSnapshot({ profileId: idParam(req.params.id), windowName: req.body?.window, force: req.body?.force === true }));
}));

// ---- Phase 10 — classify every synced product in one store's real ----
// ---- data-pipeline health. ADMIN only, read-only. ----
router.get('/pipeline-health', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  res.json(await PM.classifyAllProducts({ storeId: req.query.store_id || undefined, windowName: req.query.window || undefined }));
}));

// ---- Unmapped Meta activity audit — ADMIN only. Never maps anything ----
// ---- automatically; only classifies real spend/purchase campaigns as ----
// ---- REVIEW (slug evidence found) or UNMAPPED (no evidence). ----
router.get('/meta/unmapped-audit', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  res.json(await PM.auditUnmappedMetaActivity({ windowName: req.query.window || undefined }));
}));

// ---- Product ↔ Meta Campaign mapping (read-only suggestions + a hardened, ADMIN-only confirm) ----
router.get('/profiles/:id/meta-mapping', asyncRoute(async (req, res) => {
  res.json(await PM.getMetaMappingSuggestions({ profileId: idParam(req.params.id) }));
}));
router.post('/profiles/:id/meta-mapping/confirm', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const campaignIds = Array.isArray(req.body?.campaignIds) ? req.body.campaignIds : [];
  res.json(await PM.confirmMetaMapping({ profileId: idParam(req.params.id), campaignIds, userId: req.user.id }));
}));

// ---- Memory (§22) ----
router.get('/profiles/:id/memory', asyncRoute(async (req, res) => res.json({ entries: await PM.getMemory(idParam(req.params.id)) })));

// ---- AI Actions (§21) ----
router.get('/profiles/:id/actions', asyncRoute(async (req, res) => res.json({ actions: await PM.listActions(idParam(req.params.id)) })));
router.post('/actions/:actionId/decide', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  res.json(await PM.decideAction({ actionId: idParam(req.params.actionId), status: req.body?.status, note: req.body?.note, userId: req.user.id }));
}));

// ---- Hook Lab / Post Generator / Creative Ideas / Test Pack (§15–17, §24) — on demand only ----
router.post('/profiles/:id/hooks', asyncRoute(async (req, res) => {
  res.json(await PM.hookLab({ profileId: idParam(req.params.id), angle: req.body?.angle, category: req.body?.category, count: req.body?.count }));
}));
router.post('/profiles/:id/posts', asyncRoute(async (req, res) => {
  res.json(await PM.postGenerator({ profileId: idParam(req.params.id), angle: req.body?.angle, tone: req.body?.tone }));
}));
router.post('/profiles/:id/creative-ideas', asyncRoute(async (req, res) => {
  res.json(await PM.creativeIdeas({ profileId: idParam(req.params.id), angle: req.body?.angle, count: req.body?.count }));
}));
router.post('/profiles/:id/test-pack', asyncRoute(async (req, res) => {
  res.json(await PM.testPack({ profileId: idParam(req.params.id), angle: req.body?.angle }));
}));

// ---- Creative Factory handoff (§17 button) — read-only readiness check; the actual send re-uses the Creative Factory UI/API as-is ----
router.get('/profiles/:id/creative-factory-readiness', asyncRoute(async (req, res) => {
  res.json(await PM.creativeFactoryReadiness(idParam(req.params.id)));
}));

// ---- Competitor Intelligence (§18) — read-only reuse of Product Research data ----
router.get('/profiles/:id/competitors', asyncRoute(async (req, res) => res.json(await PM.competitorIntel(idParam(req.params.id)))));

// ---- Phase 1 Intelligence & Strategy layer — thin slices of the ONE ----
// ---- already-cached snapshot (see computeSnapshot()); no extra AI/DB ----
// ---- cost per call. 404 with `stale: true` when no snapshot exists yet ----
// ---- (mirrors GET /profiles/:id/snapshot's own contract). ----
function snapshotSlice(field) {
  return asyncRoute(async (req, res) => {
    const snap = await PM.getSnapshot({ profileId: idParam(req.params.id), windowName: req.query.window });
    if (!snap) return res.json({ stale: true, [field]: null });
    res.json({ stale: false, [field]: snap[field] });
  });
}
router.get('/profiles/:id/markets', snapshotSlice('markets'));
router.get('/profiles/:id/buyer-insights', snapshotSlice('buyerInsights'));
router.get('/profiles/:id/winner-intel', asyncRoute(async (req, res) => {
  const snap = await PM.getSnapshot({ profileId: idParam(req.params.id), windowName: req.query.window });
  if (!snap) return res.json({ stale: true, hooks: null, angles: null });
  res.json({ stale: false, hooks: snap.hookIntel, angles: snap.angleIntel });
}));
router.get('/profiles/:id/needs-attention', snapshotSlice('needsAttention'));

// ---- Market Gaps / AI Strategist — on demand only (own AI call each, ----
// ---- NOT part of /analyze's compute — see computeSnapshot()'s comment). ----
router.get('/profiles/:id/market-gaps', snapshotSlice('marketGaps'));
router.post('/profiles/:id/market-gaps', asyncRoute(async (req, res) => {
  res.json(await PM.computeMarketGaps({ profileId: idParam(req.params.id), windowName: req.body?.window, force: req.body?.force === true }));
}));
router.get('/profiles/:id/strategist', snapshotSlice('strategist'));
router.post('/profiles/:id/strategist', asyncRoute(async (req, res) => {
  res.json(await PM.computeStrategistBrief({ profileId: idParam(req.params.id), windowName: req.body?.window, force: req.body?.force === true }));
}));

// ---- Testing Lab + Marketing Memory (§17-20) — serialized to camelCase for the frontend, same convention as routes/customers.js ----
function serializeTestResult(r) {
  return {
    id: r.id, windowFrom: r.window_from, windowTo: r.window_to, spend: r.spend, metaPurchases: r.meta_purchases,
    orders: r.orders, confirmedOrders: r.confirmed_orders, deliveredOrders: r.delivered_orders, ctr: r.ctr, cpc: r.cpc,
    cpa: r.cpa, deliveredCpa: r.delivered_cpa, roas: r.roas, revenue: r.revenue, netProfit: r.net_profit,
    classification: r.classification, whatDidWeLearn: r.what_did_we_learn, whatNext: r.what_next, createdAt: r.created_at,
  };
}
function serializeTest(t) {
  return {
    id: t.id, testType: t.test_type, hypothesis: t.hypothesis, variable: t.variable, control: t.control, variation: t.variation,
    recommendedBudget: t.recommended_budget, minDataRequirement: t.min_data_requirement, successMetric: t.success_metric,
    stopCondition: t.stop_condition, expectedLearning: t.expected_learning, priority: t.priority, status: t.status,
    createdAt: t.created_at, updatedAt: t.updated_at,
    results: Array.isArray(t.results) ? t.results.map(serializeTestResult) : [],
  };
}
router.get('/profiles/:id/tests', asyncRoute(async (req, res) => {
  const tests = await PMT.listTests(idParam(req.params.id), { status: req.query.status });
  res.json({ tests: tests.map(serializeTest) });
}));
router.post('/profiles/:id/tests', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const test = await PMT.createTest({
    profileId: idParam(req.params.id), testType: b.testType, hypothesis: b.hypothesis, variable: b.variable,
    control: b.control, variation: b.variation, recommendedBudget: b.recommendedBudget, minDataRequirement: b.minDataRequirement,
    successMetric: b.successMetric, stopCondition: b.stopCondition, expectedLearning: b.expectedLearning, priority: b.priority,
    userId: req.user.id,
  });
  res.status(201).json(serializeTest({ ...test, results: [] }));
}));
router.post('/profiles/:id/tests/:testId/status', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const test = await PMT.updateTestStatus({ testId: idParam(req.params.testId), status: req.body?.status, userId: req.user.id });
  res.json(serializeTest({ ...test, results: [] }));
}));
router.post('/profiles/:id/tests/:testId/results', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const result = await PMT.recordTestResult({
    testId: idParam(req.params.testId), window: b.window, metrics: b.metrics || {},
    controlValue: b.controlValue, whatDidWeLearn: b.whatDidWeLearn, whatNext: b.whatNext,
  });
  res.status(201).json(serializeTestResult(result));
}));
router.get('/profiles/:id/learning', asyncRoute(async (req, res) => {
  const rows = await PMT.listLearning(idParam(req.params.id));
  res.json({ learning: rows.map((l) => ({ id: l.id, dimension: l.dimension, key: l.key, verdict: l.verdict, sampleSize: l.sample_size, evidence: l.evidence_json ? JSON.parse(l.evidence_json) : null, computedAt: l.computed_at })) });
}));

export default router;
