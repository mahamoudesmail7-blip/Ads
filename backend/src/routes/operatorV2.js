// AI Operator V2 — read-only campaign center API + per-user saved views + selection snapshots + the bulk REVIEW preview.
// Mounted at /api/operator-v2. NOTHING here writes to Meta, creates a plan, a decision or an execution, or changes a policy / permission / mode (the only rows written are the user's own saved views and selection snapshots).
// Access is decided on the SERVER (services/amb/operatorV2Access.js): ADMIN / MANAGER see every known ad account; an EMPLOYEE reads only with an explicit grant ("operator.view" + "operator.accounts") and only those accounts.
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { v2Access, requireCapability } from '../services/amb/operatorV2Access.js';
import { queryCampaigns, FIELDS, PERIOD_KEYS, PERIOD_LABEL, VIEW_LABEL, SORT_KEYS } from '../services/amb/campaignQuery.js';
import { createSnapshot, snapshotSummary } from '../services/amb/campaignSelection.js';
import { reviewPreview } from '../services/amb/campaignReview.js';
import { createBulkPlan } from '../services/amb/campaignPlanBridge.js';
import { listGrantUsers, setGrants } from '../services/amb/operatorV2Grants.js';
import { exportCampaignsCsv } from '../services/amb/campaignExport.js';
import { buildHome } from '../services/amb/operatorHome.js';
import { listViews, createView, updateView, deleteView, duplicateView, COLUMN_KEYS } from '../services/amb/operatorSavedViews.js';

const router = Router();
router.use(requireAuth, v2Access());

router.get('/me', asyncRoute(async (req, res) => res.json({ level: req.v2.level, accounts: req.v2.accounts, stores: req.v2.stores, capabilities: req.v2.capabilities, periods: PERIOD_KEYS.map((k) => ({ key: k, label: PERIOD_LABEL[k] })), views: Object.entries(VIEW_LABEL).map(([key, label]) => ({ key, label })), fields: Object.entries(FIELDS).map(([key, f]) => ({ key, type: f.t, label: f.label })), sortKeys: SORT_KEYS, columns: COLUMN_KEYS })));
router.get('/home', asyncRoute(async (req, res) => res.json(await buildHome({ user: req.user, access: req.v2, query: { period: req.query.period, from: req.query.from, to: req.query.to, compare: req.query.compare === '1' } }))));
router.post('/campaigns/query', asyncRoute(async (req, res) => res.json(await queryCampaigns({ access: req.v2, body: req.body }))));
router.post('/campaigns/snapshot', asyncRoute(async (req, res) => res.json(await createSnapshot({ user: req.user, access: req.v2, body: req.body }))));
router.get('/campaigns/snapshot/:id', asyncRoute(async (req, res) => res.json(await snapshotSummary({ id: req.params.id, user: req.user, access: req.v2 }))));
router.post('/campaigns/review-preview', requireCapability('reviewActions'), asyncRoute(async (req, res) => res.json(await reviewPreview({ user: req.user, access: req.v2, body: req.body }))));
// creating a DRAFT (a PREPARED plan / PREPARED budget decisions in the existing system). Needs the prepareDrafts capability; never approves or executes anything.
router.post('/campaigns/create-plan', requireCapability('prepareDrafts'), asyncRoute(async (req, res) => res.json(await createBulkPlan({ user: req.user, access: req.v2, body: req.body }))));
// the admin screen: which employee sees which accounts / stores and may review / prepare drafts (ADMIN only — never approve / execute)
router.get('/admin/users', requireCapability('managePolicies'), asyncRoute(async (req, res) => res.json(await listGrantUsers())));
router.put('/admin/users/:id/grants', requireCapability('managePolicies'), asyncRoute(async (req, res) => res.json(await setGrants({ admin: req.user, targetId: req.params.id, body: req.body }))));
router.post('/campaigns/export', asyncRoute(async (req, res) => {
  const r = await exportCampaignsCsv({ access: req.v2, body: req.body });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`); res.setHeader('X-Row-Count', String(r.count)); res.send(r.csv);
}));
router.get('/views', asyncRoute(async (req, res) => res.json({ views: await listViews({ user: req.user }) })));
router.post('/views', asyncRoute(async (req, res) => res.json(await createView({ user: req.user, name: req.body?.name, config: req.body?.config, shared: req.body?.shared === true, sharedMinRole: req.body?.sharedMinRole }))));
router.put('/views/:id', asyncRoute(async (req, res) => res.json(await updateView({ user: req.user, id: req.params.id, name: req.body?.name, config: req.body?.config, shared: req.body?.shared, sharedMinRole: req.body?.sharedMinRole }))));
router.delete('/views/:id', asyncRoute(async (req, res) => res.json(await deleteView({ user: req.user, id: req.params.id }))));
router.post('/views/:id/duplicate', asyncRoute(async (req, res) => res.json(await duplicateView({ user: req.user, id: req.params.id }))));

// the new code can be deployed BEFORE its migration ran: a missing table / column of the two V2 tables is a clear, retryable 503 (the rest of V2 — query, home, export — never touches them)
router.use((err, req, res, next) => {
  const missing = (err?.code === 'P2021' || err?.code === 'P2022') && /amb_operator_(saved_views|selection_snapshots)|AmbOperator(SavedView|SelectionSnapshot)/i.test(`${err?.meta?.table || ''} ${err?.meta?.modelName || ''} ${err?.message || ''}`);
  if (!missing) return next(err);
  res.status(503).json({ error: 'V2_TABLES_MISSING', message: 'جداول الفلاتر المحفوظة / تحديد الحملات لسه ما اتفعّلتش على قاعدة البيانات دي (الـ Migration ما اتطبّقش). باقي الشاشة شغّال.' });
});

export default router;
