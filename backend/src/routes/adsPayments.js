// Ads Payment Center — mounted at /api/ads-payments. Every route checks ITS OWN permission (view / extract / pay / bulkPay / manageMethods / reports) — ADMIN and the owner have all of them,
// a MANAGER gets view + extract + reports until the owner grants more. Money moves (pay / bulk pay / methods) are never implied by a role other than ADMIN.
// Nothing here writes to Meta. The provider layer says plainly when a function «needs a connection» and the screen falls back to manual registration.
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';
import * as S from '../services/amb/payments/store.js';
import * as E from '../services/amb/payments/engine.js';
import * as R from '../services/amb/payments/reports.js';
import { providerStatus } from '../services/amb/payments/providers.js';
import { PERMS, STATUS, STATUS_LABEL, QUICK_AMOUNTS, PRESET_LABEL, bad } from '../services/amb/payments/spec.js';
import { todayISO } from '../services/amb/metricsEngine.js';

const router = Router();
router.use(requireAuth);

const can = (perm) => asyncRoute(async (req, _res, next) => { req.perms = await S.permsFor(req.user); if (!req.perms[perm]) throw bad('مفيش عندك صلاحية للقسم ده.', 403, { error: 'FORBIDDEN' }); next(); });
const view = can('view');
const body = (req) => req.body || {};
const ctx = async () => { const codes = await S.allCodes(); return { codes, accounts: await E.accountsList({ codes }) }; }; // every screen needs both: the codes are read ONCE and shared
const periodOf = (q) => R.resolvePeriod({ preset: q.preset || 'month', from: q.from, to: q.to });

async function fundsFor(accounts) {
  const out = {};
  await Promise.all(accounts.filter((a) => !a.removed).map(async (a) => {
    try { out[a.id] = await Promise.race([E.deps.getFunds(a.id), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3500))]); } catch (e) { out[a.id] = { available: null, display: null, error: String(e.message || e).slice(0, 80) }; }
  }));
  return out;
}

router.get('/status', view, asyncRoute(async (req, res) => {
  const [cfg, monitor, methods] = await Promise.all([S.getConfig(), S.getMonitorState(), S.listMethods()]);
  res.json({ perms: req.perms, providers: providerStatus(), monitor, config: { alertAfterMin: cfg.alertAfterMin, monitorEveryMin: cfg.monitorEveryMin, minAmountEgp: cfg.minAmountEgp, maxAmountEgp: cfg.maxAmountEgp }, quickAmounts: QUICK_AMOUNTS, presets: PRESET_LABEL, methods: methods.map((m) => ({ id: m.id, label: m.label, type: m.type, active: m.active })), now: new Date().toISOString() });
}));

// ---- the overview (everything the home screen shows, in one round trip)
router.get('/overview', view, asyncRoute(async (req, res) => {
  const p = periodOf(req.query); const now = Date.now();
  const allCodes = await S.allCodes(); const [accounts, cfg, monitor, methods] = await Promise.all([E.accountsList({ codes: allCodes }), S.getConfig(), S.getMonitorState(), S.listMethods()]);
  const codes = req.query.account ? allCodes.filter((c) => c.accountId === req.query.account) : allCodes; // the header's account filter narrows every figure below
  const nm = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const funds = await fundsFor(accounts);
  const report = R.computeReport(codes, p, { names: nm });
  const monthP = R.resolvePeriod({ preset: 'month' });
  const forecast = await R.buildForecast({ codes, accounts, funds, cfg, now });
  const alerts = R.buildAlerts({ codes, accounts, forecast, monitor, methods, cfg, now });
  const today = todayISO(new Date(now)); const todayStart = R.resolvePeriod({ preset: 'today' }, now);
  const log = codes.filter((c) => OPEN.has(c.status) || (new Date(c.extractedAt).getTime() >= todayStart.fromMs) || (c.payment?.paidAt && new Date(c.payment.paidAt).getTime() >= todayStart.fromMs) || (c.credit?.at && new Date(c.credit.at).getTime() >= todayStart.fromMs))
    .sort((a, b) => String(b.extractedAt).localeCompare(String(a.extractedAt))).slice(0, 40).map((c) => R.codeRow(c, { names: nm, now }));
  res.json({
    period: report.period, comparison: R.periodComparison(codes, p), report,
    accounts: R.accountCards(codes, accounts, p, { funds, now }),
    series: R.movementSeries(codes, monthP, 'week'), seriesPeriod: { from: monthP.from, to: monthP.to, label: monthP.label },
    month: { label: monthP.label, report: R.computeReport(codes, monthP) },
    alerts: alerts.slice(0, 12), alertsTotal: alerts.length,
    log, today, lastCodes: [...codes].sort((a, b) => String(b.extractedAt).localeCompare(String(a.extractedAt))).slice(0, 5).map((c) => R.codeRow(c, { names: nm, now })),
    providers: providerStatus(), perms: req.perms, quickAmounts: QUICK_AMOUNTS, methods: methods.filter((m) => m.active).map((m) => ({ id: m.id, label: m.label, type: m.type, balanceEgp: m.balanceEgp, feePct: m.feePct, feeFixed: m.feeFixed })),
    batches: await E.listBatchViews().then((b) => b.filter((x) => x.status === 'RUNNING' || x.status === 'INTERRUPTED' || x.status === 'STOPPED_UNCERTAIN' || x.status === 'STOPPED')),
  });
}));
const OPEN = new Set(['UNPAID', 'PAYING', 'PAID', 'UNCERTAIN', 'REVIEW', 'PAY_FAILED']);

// ---- the codes log
router.get('/codes', view, asyncRoute(async (req, res) => {
  const q = req.query; const now = Date.now(); const { accounts, codes: all } = await ctx(); const nm = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  let rows = all.map((c) => R.codeRow(c, { names: nm, now }));
  if (q.bucket) { const set = { unpaid: ['UNPAID', 'PAY_FAILED'], pending: ['PAYING', 'PAID', 'UNCERTAIN', 'REVIEW'], credited: ['CREDITED'], expired: ['EXPIRED'], open: [...OPEN] }[q.bucket]; if (set) rows = rows.filter((r) => set.includes(r.status)); }
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.account) rows = rows.filter((r) => r.accountId === q.account);
  if (q.user) rows = rows.filter((r) => (r.paidBy || r.extractedBy) === q.user);
  if (q.method) rows = rows.filter((r) => r.methodLabel === q.method);
  if (q.q) { const t = String(q.q).trim().toLowerCase(); rows = rows.filter((r) => [r.code, r.accountName, r.txnRef, r.accountId].some((x) => String(x || '').toLowerCase().includes(t))); }
  if (q.from && q.to) { const p = R.resolvePeriod({ preset: 'custom', from: q.from, to: q.to }); const on = String(q.dateField || 'extracted'); const f = { extracted: 'extractedAt', paid: 'paidAt', credited: 'creditedAt' }[on] || 'extractedAt'; rows = rows.filter((r) => r[f] && new Date(r[f]).getTime() >= p.fromMs && new Date(r[f]).getTime() < p.toMs); }
  rows.sort((a, b) => String(b.extractedAt).localeCompare(String(a.extractedAt)));
  const total = rows.length; const offset = Math.max(0, Number(q.offset) || 0); const limit = Math.min(300, Math.max(1, Number(q.limit) || 100));
  res.json({ total, rows: rows.slice(offset, offset + limit), statuses: STATUS_LABEL, filters: { users: [...new Set(all.flatMap((c) => [c.extractedBy?.name, c.payment?.paidBy?.name]).filter(Boolean))], methods: [...new Set(all.map((c) => c.payment?.methodLabel).filter(Boolean))] } });
}));
router.get('/codes/:id', view, asyncRoute(async (req, res) => {
  const c = await S.getCode(req.params.id); if (!c) return res.status(404).json({ error: 'NOT_FOUND', message: 'الكود مش موجود.' });
  const nm = Object.fromEntries((await E.accountsList({ codes: [c] })).map((a) => [a.id, a.name]));
  res.json({ row: R.codeRow(c, { names: nm }), events: c.events || [], attempts: c.payment?.attempts || [], audit: await S.listAudit({ codeId: c.id, limit: 50 }), expiresAt: c.expiresAt, job: c.jobId ? await S.getJob(c.jobId) : null });
}));

// ---- extraction
router.post('/extract/warnings', can('extract'), asyncRoute(async (req, res) => res.json(await E.extractWarnings({ accountId: body(req).accountId, amountEgp: body(req).amountEgp }))));
router.post('/extract', can('extract'), asyncRoute(async (req, res) => res.json(await E.extractCode(req.user, body(req)))));
router.post('/register', can('extract'), asyncRoute(async (req, res) => res.json({ code: await E.registerManualCode(req.user, body(req)) })));
router.post('/jobs/:id/resolve', can('extract'), asyncRoute(async (req, res) => res.json(await E.resolveJob(req.user, req.params.id, body(req)))));
router.post('/bulk-extract/preview', can('extract'), asyncRoute(async (req, res) => res.json(await E.previewBulkExtract(req.user, body(req)))));
router.post('/bulk-extract', can('extract'), asyncRoute(async (req, res) => res.status(202).json(await E.startBulkExtract(req.user, body(req)))));
router.get('/batches', view, asyncRoute(async (_req, res) => res.json({ batches: await E.listBatchViews() })));
router.get('/batches/:id', view, asyncRoute(async (req, res) => { const b = await E.getBatchView(req.params.id); if (!b) return res.status(404).json({ error: 'NOT_FOUND', message: 'الدفعة مش موجودة.' }); res.json(b); }));
router.post('/batches/:id/resume', view, asyncRoute(async (req, res) => { const b = await S.getBatch(req.params.id); if (!b) throw bad('الدفعة مش موجودة.', 404); res.json(b.type === 'PAY' ? await E.resumePayBatch(req.user, b.id) : await E.resumeExtractBatch(req.user, b.id)); }));

// ---- payment
router.post('/codes/:id/quote', can('view'), asyncRoute(async (req, res) => res.json(await E.quotePay(req.user, req.params.id, body(req).methodId))));
router.post('/codes/:id/pay', can('pay'), asyncRoute(async (req, res) => res.json({ code: await E.payCode(req.user, req.params.id, body(req)) })));
router.post('/codes/:id/manual-payment', can('pay'), asyncRoute(async (req, res) => res.json({ code: await E.recordManualPayment(req.user, req.params.id, body(req)) })));
router.post('/codes/:id/reconcile', can('pay'), asyncRoute(async (req, res) => res.json({ code: await E.reconcilePayment(req.user, req.params.id, body(req)) })));
router.post('/codes/:id/credit', view, asyncRoute(async (req, res) => res.json({ code: await E.confirmCredit(req.user, req.params.id, body(req)) })));
router.post('/codes/:id/cancel', view, asyncRoute(async (req, res) => res.json({ code: await E.cancelCode(req.user, req.params.id, body(req)) })));
router.post('/codes/:id/review', view, asyncRoute(async (req, res) => res.json({ code: await E.flagReview(req.user, req.params.id, body(req)) })));
router.post('/bulk-pay/preview', can('bulkPay'), asyncRoute(async (req, res) => res.json(await E.previewBulkPay(req.user, body(req)))));
router.post('/bulk-pay', can('bulkPay'), asyncRoute(async (req, res) => res.status(202).json(await E.startBulkPay(req.user, body(req)))));

// ---- payment methods (no credentials are ever stored here)
router.get('/methods', view, asyncRoute(async (_req, res) => res.json({ methods: await S.listMethods(), types: S.METHOD_TYPES, providers: providerStatus() })));
router.post('/methods', can('manageMethods'), asyncRoute(async (req, res) => { const m = await S.upsertMethod(body(req), { userId: req.user.id }); await S.audit({ actor: { id: req.user.id, name: req.user.name }, action: 'METHOD_SAVED', target: { type: 'method', id: m.id }, detail: { label: m.label, type: m.type } }); res.json({ method: m }); }));
router.delete('/methods/:id', can('manageMethods'), asyncRoute(async (req, res) => { const r = await S.removeMethod(req.params.id); await S.audit({ actor: { id: req.user.id, name: req.user.name }, action: 'METHOD_REMOVED', target: { type: 'method', id: req.params.id } }); res.json(r); }));

// ---- ad accounts
router.get('/accounts', view, asyncRoute(async (req, res) => {
  const p = periodOf(req.query); const { accounts, codes } = await ctx(); const funds = await fundsFor(accounts);
  res.json({ period: { from: p.from, to: p.to, label: p.label }, accounts: R.accountCards(codes, accounts, p, { funds }) });
}));
router.get('/accounts/:id', view, asyncRoute(async (req, res) => {
  const p = periodOf(req.query); const now = Date.now(); const { accounts, codes: every } = await ctx(); const a = accounts.find((x) => x.id === req.params.id); if (!a) throw bad('الحساب مش موجود.', 404);
  const codes = every.filter((c) => c.accountId === a.id); const funds = await fundsFor([a]);
  const nm = { [a.id]: a.name };
  res.json({ account: R.accountCards(codes, [a], p, { funds, now })[0], report: R.computeReport(codes, p, { names: nm }), codes: codes.sort((x, y) => String(y.extractedAt).localeCompare(String(x.extractedAt))).slice(0, 200).map((c) => R.codeRow(c, { names: nm, now })), series: R.movementSeries(codes, p.days > 35 ? R.resolvePeriod({ preset: 'last30' }) : p, 'day') });
}));

// ---- reports
router.get('/report', can('reports'), asyncRoute(async (req, res) => {
  const p = periodOf(req.query); const gran = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : (p.days <= 31 ? 'day' : p.days <= 120 ? 'week' : 'month');
  const { accounts, codes } = await ctx(); const nm = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const prev = R.resolvePeriod({ preset: 'custom', from: p.prev.from, to: p.prev.to });
  const monthNow = R.resolvePeriod({ preset: 'month' }); const lastM = R.resolvePeriod({ preset: 'lastMonth' });
  res.json({ report: R.computeReport(codes, p, { names: nm }), previous: R.computeReport(codes, prev, { names: nm }), comparison: R.periodComparison(codes, p), series: R.movementSeries(codes, p, gran), granularity: gran,
    spend: await R.spendVsPayments(codes, accounts.filter((a) => !a.removed), p),
    monthOverMonth: { current: R.computeReport(codes, monthNow, { names: nm }).payments, previous: R.computeReport(codes, lastM, { names: nm }).payments, currentLabel: monthNow.label, previousLabel: lastM.label } });
}));
router.get('/report.xlsx', can('reports'), asyncRoute(async (req, res) => {
  const p = periodOf(req.query); const { accounts, codes } = await ctx(); const nm = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const rows = codes.filter((c) => R.computeReport([c], p).extracted.count || R.computeReport([c], p).payments.count || R.computeReport([c], p).credited.count).map((c) => R.codeRow(c, { names: nm }));
  const buf = await R.buildWorkbook({ rows, report: R.computeReport(codes, p, { names: nm }), period: p });
  await S.audit({ actor: { id: req.user.id, name: req.user.name }, action: 'REPORT_EXPORTED', detail: { from: p.from, to: p.to, rows: rows.length } });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="ads-payments-${p.from}_${p.to}.xlsx"`); res.send(Buffer.from(buf));
}));
router.get('/forecast', view, asyncRoute(async (_req, res) => {
  const [{ accounts, codes }, cfg] = await Promise.all([ctx(), S.getConfig()]);
  res.json(await R.buildForecast({ codes, accounts, funds: await fundsFor(accounts), cfg }));
}));
router.get('/alerts', view, asyncRoute(async (_req, res) => {
  const [{ accounts, codes }, cfg, monitor, methods] = await Promise.all([ctx(), S.getConfig(), S.getMonitorState(), S.listMethods()]);
  const forecast = await R.buildForecast({ codes, accounts, funds: await fundsFor(accounts), cfg });
  res.json({ alerts: R.buildAlerts({ codes, accounts, forecast, monitor, methods, cfg }), alertAfterMin: cfg.alertAfterMin });
}));

// ---- closing
router.get('/closings', can('reports'), asyncRoute(async (req, res) => res.json({ closings: (await S.listClosings(req.query.kind === 'month' ? 'month' : 'day')).map(({ paidCodeIds, ...c }) => c) })));
router.get('/closings/:key', can('reports'), asyncRoute(async (req, res) => { const c = await S.getClosing(req.params.key); if (!c) throw bad('التقفيل مش موجود.', 404); res.json({ closing: c, late: R.lateAdjustments(await S.allCodes(), c) }); }));
router.post('/closings/run', can('reports'), asyncRoute(async (_req, res) => res.json(await R.runClosings())));
router.post('/monitor/run', can('reports'), asyncRoute(async (_req, res) => { const r = await E.monitorTick(); await R.runClosings().catch(() => null); res.json(r); }));

// ---- settings / grants / audit / capabilities
router.get('/settings', can('view'), asyncRoute(async (req, res) => {
  const cfg = await S.getConfig(); const isAdmin = req.user.role === 'ADMIN' || req.user.is_owner;
  const out = { config: cfg, perms: req.perms, permLabels: PERMS, isAdmin, accounts: (await E.accountsList()).map((a) => ({ id: a.id, name: a.name })) };
  if (isAdmin) { const users = await prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true, email: true, role: true } }); const grants = await S.getGrants(); out.users = await Promise.all(users.map(async (u) => ({ ...u, perms: await S.permsFor({ ...u }), granted: grants[String(u.id)] || null, dailyLimitEgp: cfg.dailyLimits[String(u.id)] ?? null }))); }
  res.json(out);
}));
const adminOnly = asyncRoute(async (req, _res, next) => { if (!(req.user.role === 'ADMIN' || req.user.is_owner)) throw bad('الإعدادات لمدير النظام فقط.', 403, { error: 'FORBIDDEN' }); next(); });
router.put('/settings', adminOnly, asyncRoute(async (req, res) => { const cfg = await S.saveConfig(body(req)); await S.audit({ actor: { id: req.user.id, name: req.user.name }, action: 'SETTINGS_SAVED', detail: Object.keys(body(req)) }); res.json({ config: cfg }); }));
router.put('/permissions/:userId', adminOnly, asyncRoute(async (req, res) => { const p = await S.setUserPerms(req.params.userId, body(req).perms); await S.audit({ actor: { id: req.user.id, name: req.user.name }, action: 'PERMISSIONS_SAVED', target: { type: 'user', id: req.params.userId }, detail: p }); res.json({ perms: p }); }));
router.get('/audit', can('reports'), asyncRoute(async (req, res) => res.json({ audit: await S.listAudit({ limit: Math.min(300, Number(req.query.limit) || 100) }) })));

router.get('/capabilities', view, asyncRoute(async (_req, res) => {
  const pr = providerStatus();
  res.json({ checkedAt: '2026-11-25', providers: pr, items: [
    { q: 'هل استخراج أكواد فوري لشحن حسابات Meta متاح رسميًا؟', a: pr.simulation ? 'محاكاة فقط (قاعدة اختبار).' : 'لا — مفيش Endpoint في Marketing API بيطلّع كود فوري. الكود بيتولّد من واجهة Ads Manager (الفوترة ← إضافة أموال ← فوري).', state: pr.extract.available && !pr.simulation ? 'YES' : 'NEEDS_CONNECTION' },
    { q: 'هل صلاحيات حساباتك الحالية تسمح بذلك؟', a: 'صلاحيات الربط الحالية (ads_read · ads_management · business_management · صفحات/إنستجرام) كفاية لقراءة الحساب ورصيده وإدارة الإعلانات — لكن مفيش صلاحية (scope) في Meta بتطلّع كود فوري لشحن الحساب لأن الوظيفة نفسها مش مفتوحة في الـAPI. وتطبيقك حاليًا على مستوى «development_access» (أقل مستوى حصص). أي صلاحية إضافية محتاجة موافقة Meta مش مجرد طلب من جهتنا.', state: 'NO' },
    { q: 'هل الدفع المباشر متاح؟', a: 'لا — واجهات فوري الرسمية (FawryPay) مخصصة لتحصيل التاجر لحسابه، مش لسداد كود صادر من Meta. سداد أكواد طرف تالت محتاج عقد/صلاحية من فوري.', state: pr.pay.available && !pr.simulation ? 'YES' : 'NEEDS_CONNECTION' },
    { q: 'هل يمكن الاستعلام عن حالة كل كود؟', a: 'للكود الصادر من Meta: مفيش استعلام رسمي متاح لنا. المتاح: حالة الدفع اللي بنسجلها (من المزود لو اتربط، أو تأكيد بشري بدليل).', state: 'NEEDS_CONNECTION' },
    { q: 'هل يمكن التحقق من التسميع لكل عملية؟', a: 'مش تلقائيًا بدقة: رصيد الحساب بيتقرأ من Meta لكن زيادته مش إثبات لكود معيّن (الإنفاق بيحركه كمان). السيستم بيسجلها «دليل مساعد» والتأكيد بيتم من Ads Manager ← الفوترة ← المعاملات بدليل مسجّل باسم الشخص.', state: 'NEEDS_CONNECTION' },
    { q: 'هل محتاج تعاقد أو صلاحيات إضافية مع فوري؟', a: 'نعم لأي استخراج/سداد آلي: (1) تأكيد من Meta (partner/support) إن فيه قناة رسمية لأكواد الشحن، (2) اتفاق مع فوري أو مزود دفع معتمد لسداد أكواد خارجية والاستعلام عنها. وقت ما يتوفروا، بيتركّبوا كـAdapter من غير تغيير الشاشة.', state: 'NEEDS_CONNECTION' },
    { q: 'الفرق بين كود تحصيل تاجر وكود شحن Meta', a: 'كود التاجر (PayAtFawry reference) بيتعمل لتحصيل فلوس لصالح التاجر. كود شحن Meta بيصدر من Meta لصالح حسابك الإعلاني — وظيفتين مختلفتين ومش بيتبدلوا ببعض.', state: 'INFO' },
  ], manual: ['سجّل الكود اللي طلعته من Ads Manager (تسجيل كود).', 'ادفعه من فوري/محفظتك ثم سجّل رقم العملية والإيصال (تسجيل دفع).', 'أكّد التسميع بعد ما يظهر في Ads Manager (تأكيد التسميع) — بدليل.'] });
}));

export default router;
