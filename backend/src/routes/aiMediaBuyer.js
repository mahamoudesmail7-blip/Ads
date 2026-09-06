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
// Settings — ADMIN only for writes.
// ---------------------------------------------------------------------------
router.get('/settings', asyncRoute(async (req, res) => res.json({ settings: await getAmbSettings(), defaults: AMB_DEFAULT_SETTINGS })));
router.put('/settings', requireRole('ADMIN'), asyncRoute(async (req, res) => res.json({ settings: await saveAmbSettings(req.body || {}) })));

export default router;
