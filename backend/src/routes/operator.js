// 🤖 AI Operator — HTTP surface, mounted at /api/operator (a section INSIDE the AI Media Buyer module).
// Reads: ADMIN|MANAGER. Anything that changes behaviour or can reach Meta (mode, limits, rules, approve/execute, rollback, exceptions,
// product economics) is ADMIN-only. Emergency Stop is deliberately open to MANAGER too: stopping must never need more privilege than running.
// The handlers are thin — every rule lives in services/amb/operator*.js, and Meta is only ever written by the existing executor.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';
import { getConnection } from '../services/metaAuth.js';
import { getAmbSettings } from '../services/amb/settings.js';
import * as store from '../services/amb/operatorStore.js';
import { validateRule, detectRuleConflicts, parseArabicRule, FIELDS, OPS_FOR, PRECEDENCE, ACTIONS, ACTION_LABEL_AR, RULE_MODES, WINDOW_KEYS, WINDOW_LABEL_AR } from '../services/amb/operatorRules.js';
import { evaluateOperator, approveDecision, rejectDecision, snoozeDecision, prepareRollback } from '../services/amb/operatorEngine.js';
import { listCampaignsFromSnapshots, clearOperatorFactsCache } from '../services/amb/operatorContext.js';
import { operatorOverview, listDecisions, shadowReport, shapeDecision } from '../services/amb/operatorReports.js';
import { interpretCommand } from '../services/amb/operatorCommand.js';
import { getOperatorSchedulerStatus, runOperatorTick } from '../services/amb/operatorScheduler.js';
import * as readiness from '../services/amb/operatorReadiness.js';
import { buildIntegrationAudit, autoFixIntegration } from '../services/amb/operatorIntegration.js';
import * as setupGrid from '../services/amb/operatorSetupGrid.js';
import { listTemplates, instantiateTemplate } from '../services/amb/operatorTemplates.js';
import { performanceReport, executedWithOutcomes, operatorHealth, ruleAuditLog, whatWillHappen, bulkApprove, dailyBrief, notifyEmergencyStop } from '../services/amb/operatorOps.js';
import { decisionEvents } from '../services/amb/operatorReports.js';
import { retryFailedDecision } from '../services/amb/operatorEngine.js';
import { LIFECYCLE, LIFECYCLE_LABEL_AR } from '../services/amb/operatorDecision.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));
const ADMIN = requireRole('ADMIN');

async function adAccountId() {
  const c = await getConnection();
  return c && c.status === 'CONNECTED' ? c.selected_ad_account_id || null : null;
}

// ---- end-to-end integration audit / Completion Center (read-only; cached 2 minutes because it reads every source) ----------
let integrationCache = null;
router.get('/integration', asyncRoute(async (req, res) => {
  const heavy = req.query.heavy === '1';
  if (!req.query.fresh && integrationCache && integrationCache.heavy >= heavy && Date.now() - integrationCache.at < 120_000) return res.json({ ...integrationCache.value, cached: true });
  const value = await buildIntegrationAudit({ heavy });
  integrationCache = { at: Date.now(), heavy, value };
  res.json(value);
}));
// closes ONLY the AUTO_FIXABLE gaps: Smart Advisor plan versions + SUGGESTED (never VERIFIED) mappings. No economics/stock/Meta/Easy Orders write.
router.post('/integration/autofix', ADMIN, asyncRoute(async (req, res) => { const r = await autoFixIntegration({ userId: req.user.id }); integrationCache = null; res.json(r); }));
// ---- Setup Grid: every product in one editable table (validate / preview / apply write through the canonical savers; Shadow is read-only) -------------
router.get('/setup-grid', asyncRoute(async (req, res) => res.json(await setupGrid.buildSetupGrid())));
router.post('/setup-grid/validate', asyncRoute(async (req, res) => res.json(await setupGrid.validateGrid({ changes: req.body?.changes }))));
router.post('/setup-grid/preview', asyncRoute(async (req, res) => res.json(await setupGrid.previewGrid({ changes: req.body?.changes }))));
router.post('/setup-grid/apply', ADMIN, asyncRoute(async (req, res) => { const r = await setupGrid.applyGrid({ changes: req.body?.changes, skipInvalid: !!req.body?.skipInvalid, userId: req.user.id }); integrationCache = null; clearOperatorFactsCache(); res.json(r); }));
router.post('/setup-grid/recompute', asyncRoute(async (req, res) => res.json({ readiness: await setupGrid.recomputeReadiness({ productIds: req.body?.productIds }) })));
router.post('/setup-grid/shadow', asyncRoute(async (req, res) => res.json(await setupGrid.shadowForProducts({ productIds: req.body?.productIds }))));
router.put('/products/:productId/zero-order', ADMIN, asyncRoute(async (req, res) => {
  const r = await store.setProductOverride({ productId: req.params.productId, zeroOrder: req.body?.zeroOrder ?? null, userId: req.user.id });
  integrationCache = null; clearOperatorFactsCache(); res.status(r?.ok === false ? 400 : 200).json(r);
}));

// ---- overview / config -----------------------------------------------------------------------------------------------
router.get('/overview', asyncRoute(async (req, res) => {
  const acc = await adAccountId();
  const monitored = acc ? (await listCampaignsFromSnapshots({ adAccountId: acc })).filter((c) => ['ACTIVE', 'PAUSED'].includes(c.status)).length : null;
  res.json({ ...(await operatorOverview({ monitored })), writesLocked: store.metaWritesLocked(), scheduler: getOperatorSchedulerStatus(), connected: !!acc });
}));
router.get('/config', asyncRoute(async (req, res) => {
  const [config, settings] = await Promise.all([store.getOperatorConfig(), getAmbSettings()]);
  res.json({
    config, allowlist: { OPEN: !!settings.ambAllowAutoOpen, PAUSE: !!settings.ambAllowAutoPause, SCALE_UP: !!settings.ambAllowAutoBudgetIncrease, SCALE_DOWN: !!settings.ambAllowAutoBudgetDecrease },
    gate: await store.autopilotGate(), attestKeys: store.ATTEST_KEYS,
    meta: { lifecycle: LIFECYCLE, lifecycleLabels: LIFECYCLE_LABEL_AR, modes: store.OPERATOR_MODES, ruleModes: RULE_MODES, actions: ACTIONS, actionLabels: ACTION_LABEL_AR, windows: WINDOW_KEYS, windowLabels: WINDOW_LABEL_AR, fields: FIELDS, opsFor: OPS_FOR, precedence: PRECEDENCE, tags: store.CAMPAIGN_TAGS, defaults: { limits: store.DEFAULT_LIMITS, cooldowns: store.DEFAULT_COOLDOWNS } },
  });
}));
router.put('/mode', ADMIN, asyncRoute(async (req, res) => res.json(await store.setOperatorMode({ mode: req.body?.mode, userId: req.user.id, confirmAutopilot: req.body?.confirmAutopilot === true }))));
router.post('/emergency-stop', asyncRoute(async (req, res) => { const reason = req.body?.reason || null; const out = await store.setEmergencyStop({ on: true, reason, userId: req.user.id }); await notifyEmergencyStop({ on: true, reason }); res.json(out); }));
router.delete('/emergency-stop', ADMIN, asyncRoute(async (req, res) => res.json(await store.setEmergencyStop({ on: false, userId: req.user.id }))));
router.put('/limits', ADMIN, asyncRoute(async (req, res) => res.json(await store.updateOperatorLimits({ limits: req.body?.limits, cooldowns: req.body?.cooldowns, schedule: req.body?.schedule, storeLimits: req.body?.storeLimits, userId: req.user.id }))));

// ---- decisions -------------------------------------------------------------------------------------------------------
router.get('/decisions', asyncRoute(async (req, res) => {
  const { bucket, status, action, store: st, limit } = req.query;
  res.json({ decisions: await listDecisions({ bucket: bucket || 'today', status: status || null, action: action || null, store: st || null, limit }) });
}));
router.get('/decisions/:id', asyncRoute(async (req, res) => {
  const row = await prisma.ambOperatorDecision.findUnique({ where: { id: Number(req.params.id) } });
  if (!row) return res.status(404).json({ error: 'القرار غير موجود.' });
  res.json({ decision: shapeDecision(row) });
}));
router.post('/decisions/:id/approve', ADMIN, asyncRoute(async (req, res) => res.json(await approveDecision({ decisionId: req.params.id, userId: req.user.id }))));
router.post('/decisions/:id/reject', ADMIN, asyncRoute(async (req, res) => res.json(await rejectDecision({ decisionId: req.params.id, userId: req.user.id, reason: req.body?.reason || null }))));
router.post('/decisions/:id/snooze', ADMIN, asyncRoute(async (req, res) => res.json(await snoozeDecision({ decisionId: req.params.id, hours: req.body?.hours }))));
router.post('/decisions/:id/rollback', ADMIN, asyncRoute(async (req, res) => res.json({ rollback: shapeDecision(await prepareRollback({ decisionId: req.params.id, reason: req.body?.reason || 'MANUAL' })) })));

// ---- evaluation ------------------------------------------------------------------------------------------------------
/** Runs one evaluation pass now. persist=false (default) is a pure preview. Persisting never executes in SHADOW/APPROVAL. */
router.post('/evaluate', ADMIN, asyncRoute(async (req, res) => {
  const persist = req.body?.persist === true;
  if (req.body?.refresh === true) clearOperatorFactsCache();
  const r = await evaluateOperator({ persist, autoExecute: persist });
  res.json({ ...r, candidates: r.candidates.slice(0, 300) });
}));
router.post('/tick', ADMIN, asyncRoute(async (req, res) => res.json(await runOperatorTick())));
router.get('/shadow-report', asyncRoute(async (req, res) => res.json(await shadowReport({ days: Math.min(Number(req.query.days) || 7, 60) }))));

async function legacySummary() { return {}; } // kept so older clients reading summary.blockedByCode keep working

// ---- rules -----------------------------------------------------------------------------------------------------------
router.get('/rules', asyncRoute(async (req, res) => { const rules = await store.listRules(); res.json({ rules, conflicts: detectRuleConflicts(rules) }); }));
router.post('/rules/validate', asyncRoute(async (req, res) => res.json({ validation: validateRule(req.body?.rule), conflicts: detectRuleConflicts([...(await store.listRules()), { ...(req.body?.rule || {}), id: -1, enabled: true }]).filter((c) => c.a === -1 || c.b === -1) })));
router.post('/rules/parse', asyncRoute(async (req, res) => {
  const p = parseArabicRule(req.body?.text);
  res.json({ ...p, validation: p.rule ? validateRule(p.rule) : null, requiresConfirmation: true });
}));
/** Simulation: evaluates a DRAFT (or saved) rule against the live world with persist=false — zero writes. */
router.post('/rules/simulate', asyncRoute(async (req, res) => {
  const draft = req.body?.rule;
  const v = validateRule(draft);
  if (!v.ok) return res.status(400).json({ error: 'القاعدة فيها أخطاء.', validation: v });
  const r = await whatWillHappen({ rules: [{ ...draft, id: draft.id ?? -1, enabled: true, priority: draft.priority ?? 100, cooldown_hours: draft.cooldown_hours ?? 24, mode: draft.mode || 'SHADOW' }] });
  res.json({ ...r, summary: { ...r.summary, ...(await legacySummary(draft)) } });
}));
router.post('/rules', ADMIN, asyncRoute(async (req, res) => {
  const out = await store.saveRule({ rule: req.body?.rule, userId: req.user.id });
  res.status(out.ok ? 201 : 400).json(out.ok ? out : { ...out, error: 'INVALID_RULE', message: out.validation?.errors?.[0]?.message || 'القاعدة فيها أخطاء.' });
}));
router.put('/rules/:id', ADMIN, asyncRoute(async (req, res) => {
  const out = await store.saveRule({ id: req.params.id, rule: req.body?.rule, userId: req.user.id });
  res.status(out.ok ? 200 : 400).json(out.ok ? out : { ...out, error: 'INVALID_RULE', message: out.validation?.errors?.[0]?.message || 'القاعدة فيها أخطاء.' });
}));
router.post('/rules/:id/enabled', ADMIN, asyncRoute(async (req, res) => {
  const out = await store.setRuleEnabled({ id: req.params.id, enabled: req.body?.enabled === true, userId: req.user.id });
  res.status(out.ok ? 200 : 400).json(out.ok ? out : { ...out, error: 'INVALID_RULE', message: out.validation?.errors?.[0]?.message || 'القاعدة فيها أخطاء.' });
}));
router.delete('/rules/:id', ADMIN, asyncRoute(async (req, res) => res.json(await store.deleteRule({ id: req.params.id, userId: req.user.id }))));

// ---- exceptions / tags / product economics ---------------------------------------------------------------------------
router.get('/exceptions', asyncRoute(async (req, res) => res.json({ exceptions: await store.listExceptions({}), types: store.EXCEPTION_TYPES, scopes: store.SCOPE_TYPES })));
router.post('/exceptions', ADMIN, asyncRoute(async (req, res) => {
  const b = req.body || {};
  res.status(201).json({ exception: await store.addException({ storeId: b.storeId || null, scopeType: b.scopeType, scopeId: b.scopeId, scopeLabel: b.scopeLabel || null, types: b.types, reason: b.reason || null, ttlHours: b.ttlHours ?? null, userId: req.user.id }) });
}));
router.delete('/exceptions/:id', ADMIN, asyncRoute(async (req, res) => res.json(await store.removeException({ id: req.params.id, userId: req.user.id }))));
router.get('/campaigns', asyncRoute(async (req, res) => {
  const acc = await adAccountId();
  if (!acc) return res.json({ campaigns: [], connected: false });
  const [list, tags] = await Promise.all([listCampaignsFromSnapshots({ adAccountId: acc }), store.loadCampaignTags(acc)]);
  res.json({ connected: true, campaigns: list.filter((c) => ['ACTIVE', 'PAUSED'].includes(c.status)).map((c) => ({ ...c, tag: tags.get(c.id)?.tag || null, testing: tags.get(c.id)?.testing || null })) });
}));
router.put('/campaigns/:id/tag', ADMIN, asyncRoute(async (req, res) => {
  const acc = await adAccountId();
  if (!acc) return res.status(400).json({ error: 'اربط حساب Meta الأول.' });
  const b = req.body || {};
  res.json({ tag: await store.setCampaignTag({ adAccountId: acc, campaignId: req.params.id, storeId: b.storeId || null, productId: b.productId ?? null, tag: b.tag ?? null, testing: b.testing || null, userId: req.user.id }) });
}));
router.get('/product-config/:productId', asyncRoute(async (req, res) => {
  const p = await prisma.product.findUnique({ where: { id: Number(req.params.productId) }, select: { id: true, store_id: true, product_name: true, selling_price: true, product_cost: true, shipping_cost: true, packaging_cost: true, other_cost: true } });
  if (!p) return res.status(404).json({ error: 'المنتج غير موجود.' });
  res.json({ product: p, config: await store.getProductConfig(p.id, p.store_id) });
}));
router.put('/product-config/:productId', ADMIN, asyncRoute(async (req, res) => {
  const p = await prisma.product.findUnique({ where: { id: Number(req.params.productId) }, select: { id: true, store_id: true } });
  if (!p) return res.status(404).json({ error: 'المنتج غير موجود.' });
  res.json({ config: await store.upsertProductConfig({ productId: p.id, storeId: p.store_id, patch: req.body || {}, userId: req.user.id }) });
}));

// ---- command center --------------------------------------------------------------------------------------------------
router.post('/command', asyncRoute(async (req, res) => res.json(await interpretCommand(req.body?.text))));

// =====================================================================================================================
// Setup layer: readiness, product profile, mapping center, bulk setup, wizard (spec 56–63, 117)
// =====================================================================================================================
router.get('/readiness', asyncRoute(async (req, res) => res.json({ products: await readiness.readinessList({ heavy: req.query.heavy === '1' }) })));
router.get('/global-readiness', asyncRoute(async (req, res) => res.json(await readiness.globalReadiness({ heavy: req.query.heavy === '1', adAccountId: await adAccountId() }))));
router.get('/wizard', asyncRoute(async (req, res) => res.json(await readiness.setupWizard({ adAccountId: await adAccountId(), heavy: req.query.heavy === '1' }))));
router.get('/products/:productId/profile', asyncRoute(async (req, res) => res.json(await readiness.getProductProfile({ productId: req.params.productId, heavy: req.query.heavy === '1' }))));
router.put('/products/:productId/profile', ADMIN, asyncRoute(async (req, res) => res.json(await readiness.saveProductProfile({ productId: req.params.productId, patch: req.body || {}, userId: req.user.id }))));

router.get('/mapping', asyncRoute(async (req, res) => res.json(await readiness.mappingCenter({ adAccountId: await adAccountId() }))));
router.post('/mapping/confirm', ADMIN, asyncRoute(async (req, res) => {
  const acc = await adAccountId(); if (!acc) return res.status(400).json({ error: 'NO_META', message: 'اربط حساب Meta الأول.' });
  const b = req.body || {}; if (!b.campaignId || !b.ambProductId) return res.status(400).json({ error: 'BAD_REQUEST', message: 'campaignId و ambProductId مطلوبين.' });
  await readiness.confirmMapping({ adAccountId: acc, campaignId: String(b.campaignId), campaignName: b.campaignName || null, ambProductId: b.ambProductId, userId: req.user.id });
  res.json({ ok: true });
}));
router.delete('/mapping/:campaignId', ADMIN, asyncRoute(async (req, res) => { const acc = await adAccountId(); if (!acc) return res.status(400).json({ error: 'NO_META', message: 'اربط حساب Meta الأول.' }); res.json(await readiness.unmapCampaign({ adAccountId: acc, campaignId: req.params.campaignId, userId: req.user.id })); }));
router.post('/mapping/exclude', ADMIN, asyncRoute(async (req, res) => { const b = req.body || {}; if (!b.campaignId) return res.status(400).json({ error: 'BAD_REQUEST', message: 'campaignId مطلوب.' }); res.json(await readiness.excludeCampaign({ campaignId: String(b.campaignId), campaignName: b.campaignName || null, exclude: b.exclude !== false, reason: b.reason || null, userId: req.user.id })); }));
router.post('/mapping/confirm-family', ADMIN, asyncRoute(async (req, res) => {
  const acc = await adAccountId(); if (!acc) return res.status(400).json({ error: 'NO_META', message: 'اربط حساب Meta الأول.' });
  const b = req.body || {}; if (!Array.isArray(b.campaignIds) || !b.campaignIds.length || !b.ambProductId) return res.status(400).json({ error: 'BAD_REQUEST', message: 'campaignIds و ambProductId مطلوبين.' });
  const r = await readiness.confirmFamily({ adAccountId: acc, campaignIds: b.campaignIds.map(String), ambProductId: b.ambProductId, userId: req.user.id });
  integrationCache = null; res.status(r.ok === false ? 400 : 200).json(r);
}));
router.post('/mapping/suggest', ADMIN, asyncRoute(async (req, res) => { const acc = await adAccountId(); if (!acc) return res.status(400).json({ error: 'NO_META', message: 'اربط حساب Meta الأول.' }); res.json(await readiness.persistDeterministicSuggestions({ adAccountId: acc, userId: req.user.id })); }));

router.get('/import/template', asyncRoute(async (req, res) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="operator-product-setup.csv"'); res.send('\uFEFF' + await readiness.bulkSetupTemplate()); }));
router.post('/import/preview', ADMIN, asyncRoute(async (req, res) => res.json(await readiness.previewBulkSetup({ csv: req.body?.csv }))));
router.post('/import/apply', ADMIN, asyncRoute(async (req, res) => res.json(await readiness.applyBulkSetup({ csv: req.body?.csv, skipInvalid: req.body?.skipInvalid === true, userId: req.user.id }))));

// =====================================================================================================================
// Rules: templates, dry run, audit
// =====================================================================================================================
router.get('/templates', asyncRoute(async (req, res) => res.json({ templates: listTemplates() })));
router.post('/templates/:key/instantiate', asyncRoute(async (req, res) => res.json(instantiateTemplate(req.params.key, req.body?.params || {}))));
router.post('/rules/:id/dry-run', asyncRoute(async (req, res) => {
  const rule = (await store.listRules()).find((r) => r.id === Number(req.params.id));
  if (!rule) return res.status(404).json({ error: 'NOT_FOUND', message: 'القاعدة غير موجودة.' });
  res.json(await whatWillHappen({ rules: [{ ...rule, enabled: true }] }));
}));
router.get('/audit', asyncRoute(async (req, res) => res.json({ entries: await ruleAuditLog({ ruleId: req.query.ruleId ?? null, limit: Number(req.query.limit) || 100 }) })));

// =====================================================================================================================
// Decisions: events, retry, bulk approval; operations: what-will-happen, health, performance, brief, Autopilot gate
// =====================================================================================================================
router.get('/decisions/:id/events', asyncRoute(async (req, res) => res.json({ events: await decisionEvents(req.params.id) })));
router.post('/decisions/:id/retry', ADMIN, asyncRoute(async (req, res) => res.json(await retryFailedDecision({ decisionId: req.params.id, userId: req.user.id }))));
router.post('/decisions/bulk-approve', ADMIN, asyncRoute(async (req, res) => res.json(await bulkApprove({ decisionIds: req.body?.decisionIds, confirmedIds: req.body?.confirmedIds, userId: req.user.id }))));
router.post('/what-will-happen', asyncRoute(async (req, res) => res.json(await whatWillHappen({}))));
router.get('/health', asyncRoute(async (req, res) => res.json(await operatorHealth({ scheduler: getOperatorSchedulerStatus() }))));
router.get('/performance', asyncRoute(async (req, res) => res.json({ ...(await performanceReport({ days: Math.min(Number(req.query.days) || 30, 180) })), executed: await executedWithOutcomes({ days: Math.min(Number(req.query.days) || 14, 90) }) })));
router.get('/brief', asyncRoute(async (req, res) => res.json(await dailyBrief({ adAccountId: await adAccountId() }))));
router.get('/autopilot-gate', asyncRoute(async (req, res) => res.json({ gate: await store.autopilotGate(), attestKeys: store.ATTEST_KEYS })));
router.post('/autopilot-gate/attest', ADMIN, asyncRoute(async (req, res) => { await store.attestAutopilot({ keys: req.body?.keys, userId: req.user.id }); res.json({ gate: await store.autopilotGate() }); }));
router.delete('/autopilot-gate/attest', ADMIN, asyncRoute(async (req, res) => { await store.revokeAttestations({ userId: req.user.id }); res.json({ gate: await store.autopilotGate() }); }));

export default router;
