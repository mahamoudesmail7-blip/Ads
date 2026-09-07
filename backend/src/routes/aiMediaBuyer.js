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
  res.json(await clone.listSourceCampaigns({ accountId: String(req.query.accountId || '') }));
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
  const { batchId, sourceAccountId, destinationAccountIds, campaignIds, scheduleLocalTime, destinationPageId, destinationInstagramId, identityMap, pixelMap, allowPageOnlyIg, copyValidAdsOnly, recreateBoosted } = req.body || {};
  res.status(201).json(await clone.createBatch({ batchId, sourceAccountId, destinationAccountIds, campaignIds, scheduleLocalTime, destinationPageId, destinationInstagramId, identityMap, pixelMap, allowPageOnlyIg, copyValidAdsOnly, recreateBoosted, userId: req.user.id }));
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
// Settings — ADMIN only for writes.
// ---------------------------------------------------------------------------
router.get('/settings', asyncRoute(async (req, res) => res.json({ settings: await getAmbSettings(), defaults: AMB_DEFAULT_SETTINGS })));
router.put('/settings', requireRole('ADMIN'), asyncRoute(async (req, res) => res.json({ settings: await saveAmbSettings(req.body || {}) })));

export default router;
