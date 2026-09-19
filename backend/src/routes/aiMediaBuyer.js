// AI Media Buyer — HTTP surface. Lives inside "🧠 AI Intelligence" and is
// mounted at /api/ai-media-buyer. Same auth tier as /api/ai-intelligence
// (requireRole ADMIN|MANAGER) for reads and analysis; EXECUTION and SETTINGS
// are ADMIN-only — an executable action against a live ad account is at
// least as sensitive as the system-config page.
//
// The mandatory pipeline (Meta → snapshot → deterministic engines → Claude
// text → recommendation → validation → owner approval → revalidation →
// Meta write → audit → outcome eval) is enforced in the services; these
// handlers are thin.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';
import { getConnection } from '../services/metaAuth.js';
import { getAmbSettings, saveAmbSettings, AMB_DEFAULT_SETTINGS } from '../services/amb/settings.js';
import { runSnapshotSync, getSyncStatus } from '../services/amb/snapshotSync.js';
import { resolveWindow } from '../services/amb/metricsEngine.js';
import { buildHierarchy } from '../services/amb/hierarchyAnalysis.js';
import { detectWinners } from '../services/amb/winnerDetection.js';
import { generateRecommendations, getCurrentRecommendations, serializeRec } from '../services/amb/recommendationEngine.js';
import { approveAndExecute, previewExecution, rejectRecommendation, applyEdit, listExecutionHistory } from '../services/amb/executor.js';
import { runOutcomeEvaluation } from '../services/amb/outcomeEval.js';
import { listAlerts, markAlertsRead, markAllAlertsRead } from '../services/amb/alerts.js';
import * as products from '../services/amb/ambProducts.js';
import * as mapping from '../services/amb/mapping.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

/** Resolves the selected ad account id, or throws a clean 400. */
async function requireAdAccount() {
  const c = await getConnection();
  if (!c || c.status !== 'CONNECTED' || !c.selected_ad_account_id) {
    const e = new Error('اربط حساب Meta Ads واختار Ad Account الأول.');
    e.status = 400;
    throw e;
  }
  return c.selected_ad_account_id;
}
function windowFrom(req) {
  return resolveWindow(String(req.query.window || 'today'));
}

// ---------------------------------------------------------------------------
// Overview + Sync
// ---------------------------------------------------------------------------
router.get('/overview', asyncRoute(async (req, res) => {
  const { getOverview } = await import('../services/amb/overview.js');
  res.json(await getOverview({ windowName: req.query.window }));
}));

router.get('/sync/status', asyncRoute(async (req, res) => res.json(await getSyncStatus())));

router.post('/sync/run', asyncRoute(async (req, res) => {
  const result = await runSnapshotSync({ trigger: 'MANUAL' });
  res.json(result);
}));

// Command-center widgets (all deterministic).
router.get('/health', asyncRoute(async (req, res) => {
  const { getHealthScore } = await import('../services/amb/commandCenter.js');
  res.json(await getHealthScore({ windowName: req.query.window }));
}));
router.get('/needs-attention', asyncRoute(async (req, res) => {
  const { getNeedsAttention } = await import('../services/amb/commandCenter.js');
  res.json(await getNeedsAttention({ windowName: req.query.window }));
}));
router.get('/autopilot-readiness', asyncRoute(async (req, res) => {
  const { getAutopilotReadiness } = await import('../services/amb/commandCenter.js');
  res.json(await getAutopilotReadiness());
}));

// Creative analysis — run a bounded batch (cache-first) + coverage.
router.post('/creative-analysis/run', asyncRoute(async (req, res) => {
  const { analyzeAccountCreatives } = await import('../services/amb/creativeAnalysis.js');
  res.json(await analyzeAccountCreatives({ maxNew: Number(req.body?.max) || 25 }));
}));
router.get('/creative-analysis/coverage', asyncRoute(async (req, res) => {
  const { creativeAnalysisCoverage } = await import('../services/amb/creativeAnalysis.js');
  res.json(await creativeAnalysisCoverage());
}));

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
router.get('/products', asyncRoute(async (req, res) => res.json(await products.listProducts())));

router.get('/catalog-products', asyncRoute(async (req, res) => {
  const rows = await prisma.product.findMany({ where: { active: true }, select: { id: true, product_name: true, sku: true, product_cost: true, selling_price: true }, orderBy: { product_name: 'asc' } });
  res.json(rows);
}));

// Preloaded once by the dashboard: { [ambProductId]: {hasImage, source} } — no data URIs, no N+1.
router.get('/product-images', asyncRoute(async (req, res) => res.json(await products.getProductImageMap())));

// One image per distinct product (browser-cached). Resolves: AmbProduct.image_url
// → latest ProductResearchSearch.product_image (data URI) → 404 (card shows placeholder).
router.get('/products/:id/image', asyncRoute(async (req, res) => {
  const r = await products.resolveProductImage(req.params.id);
  if (r.redirect) return res.redirect(302, r.redirect);
  if (r.data) {
    res.set('Content-Type', r.contentType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(r.data);
  }
  res.status(404).end();
}));

router.post('/products', asyncRoute(async (req, res) => res.status(201).json(await products.createProduct(req.body || {}, req.user.id))));

router.post('/products/from-catalog/:productId', asyncRoute(async (req, res) => {
  res.status(201).json(await products.createFromCatalogProduct(req.params.productId, req.user.id));
}));

router.get('/products/:id', asyncRoute(async (req, res) => res.json(await products.productDashboard(req.params.id, { windowName: req.query.window }))));

router.patch('/products/:id', asyncRoute(async (req, res) => res.json(await products.updateProduct(req.params.id, req.body || {}))));

router.delete('/products/:id', requireRole('ADMIN'), asyncRoute(async (req, res) => res.json(await products.deleteProduct(req.params.id))));

// ---------------------------------------------------------------------------
// Smart Decision Center Phase 3 — Creative / Hook / Angle / Copy
// Intelligence, scoped to one product (keyed by AmbProduct.id, matching
// GET /products/:id above). The Product-level output PMC (and later the
// Smart Decision Center) can read for "أفضل كرياتيف / أفضل Hook / أفضل زاوية
// بيع / أفضل بوست / أفضل Headline" instead of recomputing its own grouping.
// Analysis only — no AI, no Scale/Pause recommendation, no Meta write.
// ---------------------------------------------------------------------------
router.get('/products/:id/creative-intel', asyncRoute(async (req, res) => {
  const { creativeIntelForProduct } = await import('../services/amb/creativeIntel.js');
  const connection = await getConnection();
  if (!connection?.selected_ad_account_id) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'اربط حساب Meta Ads واختار حساب إعلاني الأول.' });
  const settings = await getAmbSettings();
  res.json(await creativeIntelForProduct({
    adAccountId: connection.selected_ad_account_id,
    windowName: req.query.window,
    settings,
    ambProductId: Number(req.params.id),
    compareToPrior: req.query.compareToPrior !== '0',
  }));
}));

// ---------------------------------------------------------------------------
// Smart Decision Center Phase 4 — Audience / Segment Intelligence. Keyed by
// the real catalog Product.id (matches the Phase 2 dataset, since
// governorate COD truth is store-scoped by Product.store_id — never
// AmbProduct.id here). Analysis only.
// ---------------------------------------------------------------------------
router.get('/product-segments/:productId', asyncRoute(async (req, res) => {
  const { segmentIntelForProduct } = await import('../services/amb/segmentIntel.js');
  const product = await prisma.product.findUnique({ where: { id: Number(req.params.productId) }, select: { store_id: true } });
  if (!product) return res.status(404).json({ error: 'المنتج غير موجود.' });
  const connection = await getConnection();
  const settings = await getAmbSettings();
  res.json(await segmentIntelForProduct({
    productId: Number(req.params.productId),
    storeId: product.store_id || null,
    adAccountId: connection?.selected_ad_account_id || null,
    windowName: req.query.window,
    settings,
  }));
}));

// ---------------------------------------------------------------------------
// Smart Decision Center Phase 2 — Unified Product Performance dataset.
// Keyed by the real catalog Product.id (NOT AmbProduct.id — see
// productPerformance.js's own header for why). The single source of truth
// PMC and the future Smart Decision Center both read instead of each
// recomputing their own Meta+EasyOrders join. Strictly read-only data, no
// AI, no Meta writes.
// ---------------------------------------------------------------------------
router.get('/product-performance/:productId', asyncRoute(async (req, res) => {
  const { getProductPerformance } = await import('../services/amb/productPerformance.js');
  res.json(await getProductPerformance({ productId: req.params.productId, windowName: req.query.window, from: req.query.from, to: req.query.to }));
}));

// Smart Decision Center Phase 5 — Full Funnel Diagnosis. Analysis only.
router.get('/product-diagnosis/:productId', asyncRoute(async (req, res) => {
  const { getProductDiagnosis } = await import('../services/amb/productPerformance.js');
  const settings = await getAmbSettings();
  res.json(await getProductDiagnosis({ productId: req.params.productId, windowName: req.query.window, settings }));
}));

// Smart Decision Center Phase 6 — Final Product Decision Package. Combines
// Phases 2-5. GET previews without persisting; POST persists as an
// AmbRecommendation (level=product) for the Smart Decision Center UI
// (Phase 7) to read. No AI, no Meta write.
router.get('/product-decision/:productId', asyncRoute(async (req, res) => {
  const { buildProductDecisionPackage } = await import('../services/amb/productDecision.js');
  const connection = await getConnection();
  const settings = await getAmbSettings();
  res.json(await buildProductDecisionPackage({ productId: req.params.productId, windowName: req.query.window, settings, adAccountId: connection?.selected_ad_account_id || null }));
}));
router.post('/product-decision/:productId', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { buildProductDecisionPackage, persistProductDecision } = await import('../services/amb/productDecision.js');
  const connection = await getConnection();
  const settings = await getAmbSettings();
  const adAccountId = connection?.selected_ad_account_id || null;
  const pkg = await buildProductDecisionPackage({ productId: req.params.productId, windowName: req.query.window, settings, adAccountId });
  const saved = await persistProductDecision({ pkg, adAccountId, batchId: req.body?.batchId });
  res.status(201).json({ package: pkg, recommendation: saved });
}));

// Phase 7 — the Smart Decision Center inbox + its per-card actions. رفض
// reuses the EXISTING generic rejectRecommendation() (executor.js) as-is —
// a plain status flip, zero execution risk regardless of level. موافقة is
// approval-ONLY (never executes — see productDecision.js's own comment on
// why the existing approveAndExecute() correctly refuses a draft action).
router.get('/decision-center', asyncRoute(async (req, res) => {
  const { listDecisionCenter } = await import('../services/amb/productDecision.js');
  res.json(await listDecisionCenter());
}));
router.post('/decision-center/:id/approve', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { approveProductDecision } = await import('../services/amb/productDecision.js');
  res.json(await approveProductDecision({ recId: req.params.id, userId: req.user.id }));
}));
router.post('/decision-center/:id/reject', asyncRoute(async (req, res) => {
  res.json(await rejectRecommendation({ recId: req.params.id, userId: req.user.id }));
}));
router.patch('/decision-center/:id', asyncRoute(async (req, res) => {
  const { editProductDecision } = await import('../services/amb/productDecision.js');
  res.json(await editProductDecision({ recId: req.params.id, patch: req.body || {}, userId: req.user.id }));
}));
// Phase 8 — the mandatory pre-execution plan preview. Read-only: builds and
// returns the exact concrete plan (which real Meta objects, what change)
// WITHOUT sending anything to Meta. The actual execute endpoint requires a
// second, explicit confirmation and is intentionally more restrictive —
// see productDecisionExecution.js's own header for the safety boundary.
router.get('/decision-center/:id/execution-plan', asyncRoute(async (req, res) => {
  const { buildExecutionPlan } = await import('../services/amb/productDecisionExecution.js');
  res.json(await buildExecutionPlan({ recId: req.params.id }));
}));
router.post('/decision-center/:id/execute', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { executeApprovedDecision } = await import('../services/amb/productDecisionExecution.js');
  res.json(await executeApprovedDecision({ recId: req.params.id, userId: req.user.id, confirmRealExecution: req.body?.confirmRealExecution === true }));
}));
// Phase 9 — Experiment Measurement. Mirrors the existing /outcomes/run
// scheduler-tick shape exactly, scoped to product-level decisions only —
// the pre-existing /outcomes/run above keeps owning every campaign/ad/adset
// checkpoint, this never touches those.
router.post('/product-experiments/run', asyncRoute(async (req, res) => {
  const { evaluateProductExperiments } = await import('../services/amb/productExperiment.js');
  res.json(await evaluateProductExperiments());
}));
router.get('/decision-center/:id/experiment', asyncRoute(async (req, res) => {
  const { getProductExperiment } = await import('../services/amb/productExperiment.js');
  res.json(await getProductExperiment({ recId: req.params.id }));
}));
// Phase 10 — Product Learning Memory. Reuses PMC's existing pmc_learning/
// pmc_memory tables as-is (see productLearning.js) — a pure read view plus
// the PROVEN/PROMISING/REJECTED/STALE presentation-layer reconciliation.
router.get('/products/:productId/learning-memory', asyncRoute(async (req, res) => {
  const { getProductLearningMemory } = await import('../services/amb/productLearning.js');
  res.json(await getProductLearningMemory({ productId: req.params.productId }));
}));

// ---------------------------------------------------------------------------
// Campaign ↔ Product mapping
// ---------------------------------------------------------------------------
router.get('/mapping', asyncRoute(async (req, res) => {
  const adAccountId = await requireAdAccount();
  res.json(await mapping.mappingOverview({ adAccountId }));
}));

router.post('/mapping', asyncRoute(async (req, res) => {
  const adAccountId = await requireAdAccount();
  const { campaignId, campaignName, ambProductId, status, matchSource, matchConfidence, aiReason } = req.body || {};
  if (!campaignId || !ambProductId) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'campaignId و ambProductId مطلوبين.' });
  res.json(await mapping.setMapping({ adAccountId, campaignId, campaignName, ambProductId, status, matchSource, matchConfidence, aiReason, userId: req.user.id }));
}));

router.delete('/mapping/:campaignId', asyncRoute(async (req, res) => {
  const adAccountId = await requireAdAccount();
  res.json(await mapping.removeMapping({ adAccountId, campaignId: req.params.campaignId }));
}));

// ---------------------------------------------------------------------------
// Hierarchy (Campaign Analysis page) + Winners
// ---------------------------------------------------------------------------
router.get('/hierarchy', asyncRoute(async (req, res) => {
  const adAccountId = await requireAdAccount();
  const settings = await getAmbSettings();
  res.json(await buildHierarchy({ adAccountId, window: windowFrom(req), settings }));
}));

router.get('/winners', asyncRoute(async (req, res) => {
  const adAccountId = await requireAdAccount();
  const settings = await getAmbSettings();
  res.json(await detectWinners({ adAccountId, window: windowFrom(req), settings }));
}));

// ---------------------------------------------------------------------------
// AI Suggested Decisions — Winner → Scale (this section only)
// ---------------------------------------------------------------------------
router.get('/scale/winners', asyncRoute(async (req, res) => {
  const { listScaleWinners } = await import('../services/amb/scaleWinners.js');
  res.json(await listScaleWinners({ windowName: String(req.query.window || 'today'), includeResolved: req.query.includeResolved === '1' }));
}));

router.post('/scale/reject', asyncRoute(async (req, res) => {
  const { rejectScaleWinner } = await import('../services/amb/scaleWinners.js');
  const { sourceCampaignId, sourceCampaignName, productName, windowLabel } = req.body || {};
  res.json(await rejectScaleWinner({ sourceCampaignId, sourceCampaignName, productName, windowLabel, userId: req.user.id }));
}));

// Executes a real (PAUSED) clone via the existing engine — ADMIN only, and
// only after the owner approved the exact config in the UI.
router.post('/scale/execute', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { executeScale } = await import('../services/amb/scaleWinners.js');
  const { sourceCampaignId, budgetMode, campaignBudgetEgp, selectedAdIds, adSets, budgetEgp, startMode, startAt, window } = req.body || {};
  res.status(201).json(await executeScale({
    sourceCampaignId, budgetMode, campaignBudgetEgp, selectedAdIds, adSets, budgetEgp,
    startMode, startAt, windowName: window || 'today', userId: req.user.id,
  }));
}));

// ---------------------------------------------------------------------------
// AI Action Plan (recommendations)
// ---------------------------------------------------------------------------
router.get('/recommendations', asyncRoute(async (req, res) => res.json(await getCurrentRecommendations())));

// Reconcile PENDING recs against current Meta state on demand (also runs
// automatically after every sync). Resolves the ones already satisfied
// out-of-band (e.g. an owner paused the campaign in Ads Manager).
router.post('/recommendations/reconcile', asyncRoute(async (req, res) => {
  const adAccountId = await requireAdAccount();
  const { reconcilePendingRecommendations } = await import('../services/amb/reconcile.js');
  res.json(await reconcilePendingRecommendations({ adAccountId }));
}));

router.post('/recommendations/generate', asyncRoute(async (req, res) => {
  await requireAdAccount();
  const result = await generateRecommendations({ windowName: req.body?.window || null, triggeredById: req.user.id });
  if (!result.ok) return res.status(400).json({ error: 'GENERATE_FAILED', message: result.error === 'NOT_CONNECTED' ? 'مفيش اتصال Meta Ads.' : result.error });
  res.json(result);
}));

router.get('/recommendations/:id', asyncRoute(async (req, res) => {
  const r = await prisma.ambRecommendation.findUnique({ where: { id: Number(req.params.id) }, include: { actions: { include: { results: true } } } });
  if (!r) return res.status(404).json({ error: 'NOT_FOUND', message: 'التوصية مش موجودة.' });
  res.json({ ...serializeRec(r), actions: r.actions.map((a) => ({ id: a.id, status: a.execution_status, at: a.created_at, executedAt: a.executed_at, metaError: a.meta_error })) });
}));

router.patch('/recommendations/:id', asyncRoute(async (req, res) => {
  res.json(await applyEdit({ recId: req.params.id, patch: req.body || {}, userId: req.user.id }));
}));

router.post('/recommendations/:id/reject', asyncRoute(async (req, res) => {
  res.json(await rejectRecommendation({ recId: req.params.id, userId: req.user.id }));
}));

// Dry-run — verifies the full write path (live entity + revalidation +
// planned Meta request) WITHOUT sending anything. Safe for any authed user.
router.get('/recommendations/:id/dry-run', asyncRoute(async (req, res) => {
  res.json(await previewExecution({ recId: req.params.id }));
}));

// Execution — ADMIN only (owner approval tier).
router.post('/recommendations/:id/approve', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const result = await approveAndExecute({ recId: req.params.id, userId: req.user.id, mode: 'APPROVAL' });
  res.status(result.ok ? 200 : 409).json(result);
}));

// ---------------------------------------------------------------------------
// Execution History + Outcomes
// ---------------------------------------------------------------------------
router.get('/execution-history', asyncRoute(async (req, res) => {
  res.json(await listExecutionHistory({ limit: Number(req.query.limit) || 50 }));
}));

router.post('/outcomes/run', asyncRoute(async (req, res) => res.json(await runOutcomeEvaluation())));

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
router.get('/alerts', asyncRoute(async (req, res) => {
  res.json(await listAlerts({ unreadOnly: req.query.unreadOnly === 'true', limit: Number(req.query.limit) || 50 }));
}));
router.post('/alerts/read', asyncRoute(async (req, res) => res.json(await markAlertsRead(req.body?.ids || []))));
router.post('/alerts/read-all', asyncRoute(async (req, res) => res.json(await markAllAlertsRead())));

// ---------------------------------------------------------------------------
// Campaign Clone & Schedule — copy user-selected campaigns from ONE source ad
// account into one or more destination accounts (PAUSED), then a scheduler
// activates them at the chosen time. Reads/preview: ADMIN|MANAGER. Anything
// that creates on Meta (batch create / approve / resume / cancel): ADMIN,
// same tier as recommendation execution.
// ---------------------------------------------------------------------------
router.get('/clone/accounts', asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  res.json(await clone.listCloneAccounts());
}));

router.get('/clone/campaigns', asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  res.json(await clone.listSourceCampaigns({
    accountId: String(req.query.accountId || ''),
    datePreset: req.query.datePreset ? String(req.query.datePreset) : undefined,
    since: req.query.since ? String(req.query.since) : undefined,
    until: req.query.until ? String(req.query.until) : undefined,
  }));
}));

// "مطابقة مع Meta" — ADMIN debug: for one source campaign, the exact date
// range / timezone / attribution / raw purchase action + raw Meta values the
// clone table is using, plus every purchase-type breakdown so the owner can
// line it up against Ads Manager.
router.get('/clone/campaign-meta-match', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  res.json(await clone.campaignMetaMatch({
    accountId: String(req.query.accountId || ''),
    campaignId: String(req.query.campaignId || ''),
    datePreset: req.query.datePreset ? String(req.query.datePreset) : undefined,
    since: req.query.since ? String(req.query.since) : undefined,
    until: req.query.until ? String(req.query.until) : undefined,
  }));
}));

router.post('/clone/preview', asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  const { sourceAccountId, destinationAccountIds, campaignIds, scheduleLocalTime, destinationPageId, recreateBoosted } = req.body || {};
  res.json(await clone.buildPreview({ sourceAccountId, destinationAccountIds, campaignIds, scheduleLocalTime, destinationPageId, recreateBoosted }));
}));

// READ-ONLY creative reconstruction analysis (dry run) — per-ad transfer
// mode + identity/pixel mapping needs + media plan + readiness. No writes.
router.post('/clone/analyze', asyncRoute(async (req, res) => {
  const { analyzeClone } = await import('../services/amb/cloneAnalysis.js');
  const { sourceAccountId, destinationAccountIds, campaignIds, destinationPageId, destinationInstagramId, identityMap, pixelMap } = req.body || {};
  res.json(await analyzeClone({ sourceAccountId, destinationAccountIds, campaignIds, destinationPageId, destinationInstagramId, identityMap, pixelMap }));
}));

// Facebook Pages + Instagram professional accounts a destination ad account can post as.
router.get('/clone/identities', asyncRoute(async (req, res) => {
  const { getDecryptedToken } = await import('../services/metaAuth.js');
  const { getAccountIdentities } = await import('../services/metaGraphClient.js');
  const accountId = String(req.query.accountId || '');
  if (!accountId) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'accountId مطلوب.' });
  let token;
  try { token = await getDecryptedToken(); } catch (e) { return res.status(400).json({ error: 'NOT_CONNECTED', message: e.message }); }
  res.json(await getAccountIdentities(token, accountId));
}));

// Facebook pages the connected user can see (for the destination-page override on a clone).
router.get('/clone/pages', asyncRoute(async (req, res) => {
  const { getDecryptedToken } = await import('../services/metaAuth.js');
  const { graphGetQuiet, graphListQuiet } = await import('../services/metaGraphClient.js');
  let token;
  try { token = await getDecryptedToken(); } catch (e) { return res.status(400).json({ error: 'NOT_CONNECTED', message: e.message }); }
  const own = (await graphGetQuiet('/me/accounts', { fields: 'id,name,username', limit: 200 }, token))?.data || [];
  const acct = req.query.accountId ? await graphGetQuiet(`/${req.query.accountId}`, { fields: 'business{owned_pages.limit(200){id,name},client_pages.limit(200){id,name}}' }, token) : null;
  const viaBiz = [...(acct?.business?.owned_pages?.data || []), ...(acct?.business?.client_pages?.data || [])];
  const byId = new Map();
  for (const p of [...own, ...viaBiz]) byId.set(p.id, { id: p.id, name: p.name || p.username || p.id });
  res.json({ pages: [...byId.values()] });
}));

router.get('/clone/batches', asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  res.json(await clone.listBatches({ limit: Number(req.query.limit) || 25 }));
}));

router.get('/clone/batches/:batchId', asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  res.json(await clone.getBatch(req.params.batchId));
}));

router.post('/clone/batches', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  const { batchId, sourceAccountId, destinationAccountIds, campaignIds, scheduleLocalTime, executionMode, startAt, nativeSchedule, destinationPageId, destinationInstagramId, identityMap, pixelMap, allowPageOnlyIg, copyValidAdsOnly, recreateBoosted } = req.body || {};
  res.status(201).json(await clone.createBatch({ batchId, sourceAccountId, destinationAccountIds, campaignIds, scheduleLocalTime, executionMode, startAt, nativeSchedule: nativeSchedule === true, destinationPageId, destinationInstagramId, identityMap, pixelMap, allowPageOnlyIg, copyValidAdsOnly, recreateBoosted, userId: req.user.id }));
}));

router.post('/clone/batches/:batchId/copy-valid-only', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  res.json(await clone.setBatchCopyValidOnly({ batchId: req.params.batchId, copyValidAdsOnly: req.body?.copyValidAdsOnly !== false, userId: req.user.id }));
}));

// Supply a destination URL for one ad that came back NEEDS_INPUT (URL not
// recoverable from Meta). Reuses the existing Campaign/Ad Set; retries only
// that creative + ad. { sourceAdId, url, resume? }
router.post('/clone/batches/:batchId/ad-url', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  res.json(await clone.setBatchAdUrl({ batchId: req.params.batchId, sourceAdId: req.body?.sourceAdId, url: req.body?.url, resume: req.body?.resume !== false, userId: req.user.id }));
}));

router.post('/clone/batches/:batchId/approve', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  res.json(await clone.approveBatch({ batchId: req.params.batchId, userId: req.user.id }));
}));

router.post('/clone/batches/:batchId/resume', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  res.json(await clone.resumeBatch({ batchId: req.params.batchId, userId: req.user.id }));
}));

router.post('/clone/batches/:batchId/cancel', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  res.json(await clone.cancelBatch({ batchId: req.params.batchId, userId: req.user.id }));
}));

// Re-fetch every created object from Meta and diff it against the source
// (never trusts the POST response). MATCH / WARNING / MISMATCH per field.
router.get('/clone/batches/:batchId/verify', asyncRoute(async (req, res) => {
  const { verifyBatch } = await import('../services/amb/cloneVerify.js');
  res.json(await verifyBatch(req.params.batchId));
}));
router.get('/clone/jobs/:jobId/verify', asyncRoute(async (req, res) => {
  const { verifyJob } = await import('../services/amb/cloneVerify.js');
  res.json(await verifyJob(req.params.jobId));
}));

// Live Meta review + delivery picture for one cloned job (for the "حالة مراجعة
// Meta" panel on a scheduled clone). Read-only, polls Meta on demand.
router.get('/clone/jobs/:jobId/meta-status', asyncRoute(async (req, res) => {
  const clone = await import('../services/amb/cloneEngine.js');
  res.json(await clone.getCloneJobMetaStatus(req.params.jobId));
}));

// ---------------------------------------------------------------------------
// ADVANCED CAMPAIGN SCHEDULING — per copied campaign. Reads: ADMIN|MANAGER.
// Anything that arms or triggers a Meta write (create / approve / edit /
// cancel / run-now / pause-now): ADMIN. The server-side scheduler executes at
// the approved times with a live Meta revalidation; the browser is never in
// the loop.
// ---------------------------------------------------------------------------
router.get('/schedules', asyncRoute(async (req, res) => {
  const s = await import('../services/amb/campaignSchedule.js');
  res.json(await s.listSchedules({
    batchId: req.query.batchId || undefined,
    status: req.query.status || undefined,
    cloneJobId: req.query.cloneJobId || undefined,
    includeTerminal: req.query.includeTerminal !== 'false',
    limit: Number(req.query.limit) || 100,
  }));
}));

router.get('/schedules/:id', asyncRoute(async (req, res) => {
  const s = await import('../services/amb/campaignSchedule.js');
  res.json(await s.getSchedule(req.params.id));
}));

router.post('/schedules', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const s = await import('../services/amb/campaignSchedule.js');
  const { cloneJobId, mode, timezone, startDate, startTime, endDate, endTime } = req.body || {};
  res.status(201).json(await s.createSchedule({ cloneJobId, mode, timezone, startDate, startTime, endDate, endTime, userId: req.user.id }));
}));

router.post('/schedules/:id/approve', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const s = await import('../services/amb/campaignSchedule.js');
  res.json(await s.approveSchedule({ id: req.params.id, userId: req.user.id }));
}));

router.patch('/schedules/:id', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const s = await import('../services/amb/campaignSchedule.js');
  const { mode, timezone, startDate, startTime, endDate, endTime, removeEnd } = req.body || {};
  res.json(await s.editSchedule({ id: req.params.id, mode, timezone, startDate, startTime, endDate, endTime, removeEnd, userId: req.user.id }));
}));

router.post('/schedules/:id/cancel', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const s = await import('../services/amb/campaignSchedule.js');
  res.json(await s.cancelSchedule({ id: req.params.id, userId: req.user.id }));
}));

router.post('/schedules/:id/run-now', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const s = await import('../services/amb/campaignSchedule.js');
  res.json(await s.runNowSchedule({ id: req.params.id, userId: req.user.id }));
}));

router.post('/schedules/:id/pause-now', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const s = await import('../services/amb/campaignSchedule.js');
  res.json(await s.pauseNowSchedule({ id: req.params.id, userId: req.user.id }));
}));

// ---------------------------------------------------------------------------
// Media Asset Library — one deduplicated catalogue of every creative running
// across the connected Meta ad accounts. Discovery is automatic (piggy-backs
// the sync) + on-demand per account. Reads / corrections / scan:
// ADMIN|MANAGER. Winner-scaling (creates an unapproved Clone & Schedule
// batch): ADMIN, same tier as clone creation.
// ---------------------------------------------------------------------------
router.get('/media-library', asyncRoute(async (req, res) => {
  const ml = await import('../services/amb/mediaLibrary.js');
  res.json(await ml.listAssets({
    productId: req.query.productId, accountId: req.query.accountId, format: req.query.format,
    q: req.query.q, windowName: req.query.window,
  }));
}));

router.get('/media-library/intel', asyncRoute(async (req, res) => {
  const { mediaLibraryIntel } = await import('../services/amb/mediaLibraryIntel.js');
  res.json(await mediaLibraryIntel({ windowName: req.query.window }));
}));

router.get('/media-library/assets/:id', asyncRoute(async (req, res) => {
  const ml = await import('../services/amb/mediaLibrary.js');
  res.json(await ml.getAssetDetail({ assetId: req.params.id, windowName: req.query.window }));
}));

router.patch('/media-library/assets/:id', asyncRoute(async (req, res) => {
  const ml = await import('../services/amb/mediaLibrary.js');
  res.json(await ml.updateAsset({ assetId: req.params.id, patch: req.body || {}, userId: req.user.id }));
}));

router.post('/media-library/scan', asyncRoute(async (req, res) => {
  const ml = await import('../services/amb/mediaLibrary.js');
  const { getDecryptedToken } = await import('../services/metaAuth.js');
  const accountId = String(req.body?.accountId || '');
  if (!accountId) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'accountId مطلوب.' });
  let token;
  try { token = await getDecryptedToken(); } catch (e) { return res.status(400).json({ error: 'NOT_CONNECTED', message: e.message }); }
  res.json(await ml.syncMediaLibraryForAccount({ adAccountId: accountId, token, maxNew: Number(req.body?.max) || 60 }));
}));

router.post('/media-library/assets/:id/scaling-plan', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { buildScalingPlan } = await import('../services/amb/mediaLibraryIntel.js');
  const { destinationAccountIds, scheduleLocalTime, destinationPageId, recreateBoosted, window } = req.body || {};
  res.status(201).json(await buildScalingPlan({ assetId: req.params.id, destinationAccountIds, scheduleLocalTime, destinationPageId, recreateBoosted, windowName: window, userId: req.user.id }));
}));

// ---------------------------------------------------------------------------
// Campaign Launch Builder ("رفع الكامبين") — Phase B: job/state persistence
// only, zero Meta writes. Creates BRAND NEW campaigns from scratch (unlike
// /clone/* above, which copies an existing one) — see launchBuilder.js and
// schema.prisma's AmbLaunchJob comment for the full rationale. Reads are
// ADMIN|MANAGER (the router-level gate above already covers this); anything
// that creates/cancels a job is ADMIN-only, matching the tiering used by
// /clone/batches and /scale/execute above.
// ---------------------------------------------------------------------------
// Phase C — read-only Meta discovery for the wizard. Reuses the exact same
// metaGraphClient.js helpers /clone/accounts and /clone/identities already
// call, through the same metaAuth.js connection. No write of any kind.
router.get('/launch/discovery/ad-accounts', asyncRoute(async (req, res) => {
  const launch = await import('../services/amb/launchBuilder.js');
  res.json(await launch.discoverLaunchAdAccounts());
}));
router.get('/launch/discovery/account-assets', asyncRoute(async (req, res) => {
  const launch = await import('../services/amb/launchBuilder.js');
  const adAccountId = String(req.query.adAccountId || '');
  if (!adAccountId) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'adAccountId مطلوب.' });
  res.json(await launch.getLaunchAccountAssets(adAccountId));
}));

// Smart Decision Center Phase 1 — Step 1 "المنتج": Store -> Product, the
// deterministic root-entity chain's starting point. Plain DB reads, zero
// Meta calls.
router.get('/launch/stores', asyncRoute(async (req, res) => {
  const launch = await import('../services/amb/launchBuilder.js');
  res.json({ stores: await launch.listLaunchStores() });
}));
router.get('/launch/products', asyncRoute(async (req, res) => {
  const launch = await import('../services/amb/launchBuilder.js');
  const storeId = req.query.storeId ? String(req.query.storeId) : null;
  res.json({ products: await launch.listLaunchableProducts({ storeId }) });
}));

router.get('/launch/jobs', asyncRoute(async (req, res) => {
  const launch = await import('../services/amb/launchBuilder.js');
  res.json({ jobs: await launch.listJobs({ limit: req.query.limit, cursor: req.query.cursor }) });
}));
router.get('/launch/jobs/:jobId', asyncRoute(async (req, res) => {
  const launch = await import('../services/amb/launchBuilder.js');
  const job = await launch.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'طلب الرفع غير موجود.' });
  res.json(job);
}));
router.post('/launch/jobs', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const launch = await import('../services/amb/launchBuilder.js');
  const { jobId, ...input } = req.body || {};
  const job = await launch.createDraftJob({ jobId, userId: req.user.id, input });
  res.status(201).json(job);
}));
// Bare-minimum job shell, created as soon as the wizard reaches the videos
// step, so uploads have a real job_id to attach to before the rest of the
// wizard (budget/pixel/campaigns) is filled in. The SAME jobId is reused by
// POST /launch/jobs above once the owner reaches Review — see createDraftJob().
router.post('/launch/jobs/:jobId/start', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const launch = await import('../services/amb/launchBuilder.js');
  const { adAccountId, adAccountName, productId } = req.body || {};
  res.status(201).json(await launch.startLaunchJob({ jobId: req.params.jobId, userId: req.user.id, adAccountId, adAccountName, productId }));
}));
router.post('/launch/jobs/:jobId/cancel', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const launch = await import('../services/amb/launchBuilder.js');
  res.json(await launch.cancelJob(req.params.jobId, req.user.id));
}));

// Phase E — real video upload. Deliberately a raw binary POST (Content-Type
// is the video's own mime type, never JSON/multipart) so the body reaches
// this handler as an untouched stream — express.json() above only engages
// for application/json and leaves every other content-type alone. Metadata
// travels via headers since there's no form encoding to carry it. Streams
// straight through to Meta's resumable upload (launchVideoUpload.js) —
// never buffers the whole file, never lets the access token reach the
// browser. Response is newline-delimited JSON so the frontend can read
// live progress as it polls-free-streams; if that ever proves unreliable
// across browsers, the /progress GET below is the fallback the frontend
// already polls independently.
router.post('/launch/jobs/:jobId/videos/:slotKey', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { jobId, slotKey } = req.params;
  const originalFilename = decodeURIComponent(req.get('X-Filename') || slotKey);
  const contentHash = req.get('X-Content-Hash') || null;
  const fileSize = Number(req.get('Content-Length'));
  const mimeType = req.get('Content-Type') || null;
  const durationHeader = Number(req.get('X-Duration-Seconds'));
  const durationSeconds = Number.isFinite(durationHeader) && durationHeader > 0 ? durationHeader : null;

  const launch = await import('../services/amb/launchBuilder.js');
  const videoUpload = await import('../services/amb/launchVideoUpload.js');

  if (!Number.isFinite(fileSize) || fileSize <= 0) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'حجم الملف غير معروف — أعد المحاولة.' });
  const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId } });
  if (!job) return res.status(404).json({ error: 'NOT_FOUND', message: 'طلب الرفع غير موجود.' });

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  const { row: videoRow, duplicateOfSlotKey } = await launch.registerVideoSlot({ jobId, slotKey, originalFilename, contentHash, sizeBytes: fileSize, mimeType, durationSeconds });

  // Idempotent short-circuit — already uploaded (e.g. a refreshed page retrying the same slot).
  if (videoRow.status === 'UPLOADED' && videoRow.meta_video_id) {
    send({ type: 'done', videoId: videoRow.meta_video_id, reused: true });
    return res.end();
  }

  // Same file already uploaded under a different slot in this job — reuse its Meta video_id, never re-upload the identical bytes.
  if (duplicateOfSlotKey) {
    const dup = await prisma.ambLaunchVideoAsset.findUnique({ where: { job_id_slot_key: { job_id: jobId, slot_key: duplicateOfSlotKey } } });
    if (dup?.status === 'UPLOADED' && dup.meta_video_id) {
      await launch.markVideoResult({ jobId, slotKey, status: 'UPLOADED', metaVideoId: dup.meta_video_id });
      send({ type: 'done', videoId: dup.meta_video_id, reused: true, dedupedFrom: duplicateOfSlotKey });
      return res.end();
    }
  }

  let token;
  try {
    token = await videoUpload.requireLaunchToken();
  } catch (e) {
    await launch.markVideoResult({ jobId, slotKey, status: 'FAILED', error: e.message }).catch(() => {});
    send({ type: 'error', message: e.message });
    return res.end();
  }

  await launch.markVideoResult({ jobId, slotKey, status: 'UPLOADING' }).catch(() => {});
  try {
    const { videoId } = await videoUpload.streamUploadVideoToMeta({
      req, adAccountId: job.ad_account_id, fileSize, token, jobId, slotKey,
    });
    await launch.markVideoResult({ jobId, slotKey, status: 'UPLOADED', metaVideoId: videoId });
    send({ type: 'done', videoId });
  } catch (err) {
    await launch.markVideoResult({ jobId, slotKey, status: 'FAILED', error: err.metaError?.message || err.message }).catch(() => {});
    send({ type: 'error', message: err.metaError?.message || err.message });
  }
  res.end();
}));

// Lightweight polling fallback for live progress — the main POST above
// already streams progress inline, but a proxy or an older browser may
// buffer that response; this GET reads the same in-memory tracker directly.
router.get('/launch/jobs/:jobId/videos/:slotKey/progress', asyncRoute(async (req, res) => {
  const videoUpload = await import('../services/amb/launchVideoUpload.js');
  res.json(videoUpload.getUploadProgress(req.params.jobId, req.params.slotKey) || { bytesSent: 0, totalBytes: 0 });
}));

// Phase F — the FIRST real Meta write. Deliberately narrow: exactly one
// Campaign -> one Ad Set -> one Creative (reusing an already-uploaded real
// video) -> one Ad, everything created PAUSED. ADMIN-only, and gated
// behind explicit owner approval in the UI before this is ever called —
// this is not part of any automatic flow.
router.post('/launch/jobs/:jobId/publish-test', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const publish = await import('../services/amb/launchPublish.js');
  const { campaignIndex, videoSlotKey } = req.body || {};
  res.json(await publish.publishSingleTestItem({ jobId: req.params.jobId, campaignIndex: Number.isFinite(Number(campaignIndex)) ? Number(campaignIndex) : 0, videoSlotKey }));
}));

// Phase G — the real bulk publish queue's explicit start/resume entry
// point. Re-validates everything server-side before flipping the job to
// PUBLISHING; does NOT create anything on Meta itself — the durable
// scheduler tick (launchScheduler.js) picks PUBLISHING jobs up on its own
// next tick, so this returns immediately. Idempotent: calling it again on
// an already-PUBLISHING or already-COMPLETE job is a safe no-op, so a
// double-click or a retried request never starts a second run.
router.post('/launch/jobs/:jobId/publish', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const publish = await import('../services/amb/launchPublish.js');
  res.json(await publish.startLaunchQueue({ jobId: req.params.jobId, userId: req.user.id }));
}));

// Live progress for the queue UI — per-campaign status plus real ad-set/ad
// counts, computed fresh from amb_launch_object_map on every call (never
// cached), so a browser refresh always reflects the true persisted state.
router.get('/launch/jobs/:jobId/queue-status', asyncRoute(async (req, res) => {
  const publish = await import('../services/amb/launchPublish.js');
  const progress = await publish.getQueueProgress(req.params.jobId);
  if (!progress) return res.status(404).json({ error: 'NOT_FOUND', message: 'طلب الرفع غير موجود.' });
  res.json(progress);
}));

// "إعادة المحاولة الآن" — a safe scheduling nudge only (clears a pending
// bounded-backoff wait so the next 30s tick acts immediately); creates
// nothing itself and refuses when the campaign is genuinely parked
// ACTION_REQUIRED (a human decision, not a timer, is what's blocking it).
router.post('/launch/jobs/:jobId/campaigns/:campaignIndex/retry-now', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const publish = await import('../services/amb/launchPublish.js');
  res.json(await publish.retryLaunchCampaignNow({ jobId: req.params.jobId, campaignIndex: Number(req.params.campaignIndex) }));
}));

// ---------------------------------------------------------------------------
// Settings — ADMIN only for writes.
// ---------------------------------------------------------------------------
router.get('/settings', asyncRoute(async (req, res) => res.json({ settings: await getAmbSettings(), defaults: AMB_DEFAULT_SETTINGS })));
router.put('/settings', requireRole('ADMIN'), asyncRoute(async (req, res) => res.json({ settings: await saveAmbSettings(req.body || {}) })));

export default router;
