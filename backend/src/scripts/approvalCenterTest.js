// 🧪 Approval Center + Daily AI Brief + status bar + rule-decision permission gate. No Meta call. Disposable __optest_ fixtures; the real config is never changed.
//   node src/scripts/approvalCenterTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
if (!process.env.JWT_SECRET) { console.log('JWT_SECRET missing'); process.exit(2); }
const { prisma } = await imp('../prisma.js'); const AC = await imp('../services/amb/approvalCenter.js'); const BR = await imp('../services/amb/operatorBrief.js'); const OPS = await imp('../services/amb/operatorOps.js'); const EN = await imp('../services/amb/operatorEngine.js'); const S = await imp('../services/amb/operatorStore.js');
const { default: operatorRoutes } = await imp('../routes/operator.js'); const { errorHandler } = await imp('../middleware/errorHandler.js');
const T = '__optest_'; const users = []; const decisions = [];
const c0 = { actions: await prisma.ambAction.count() };
const cfg = (o = {}, perm = {}) => ({ mode: 'APPROVAL', emergency_stop: false, writesLocked: false, execPermissions: { open: true, pause: true, budgetIncrease: true, budgetDecrease: true, ...perm }, ...o });
const shaped = (o = {}) => ({ id: 1, status: 'PREPARED', campaignId: 'c1', campaignName: 'Camp 1', productName: 'Prod', action: 'PAUSE', actionLabel: 'إيقاف', params: {}, blocks: [], warnings: [], confidence: 'HIGH', why: { why: 'سبب' }, ruleName: 'R', isBudgetDecision: false, metrics: { budget: 200 }, ...o });
const mkUser = async (role, tag) => { const u = await prisma.user.create({ data: { email: `${T}ac_${tag}_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}ac ${tag}`, role, status: 'ACTIVE', permissions: '{}' } }); users.push(u.id); return u; };
let seq = 0;
const mkDec = async (o = {}) => { const n = ++seq; const d = await prisma.ambOperatorDecision.create({ data: { decision_key: `${T}ac${n}-${Date.now()}`, status: o.status || 'PREPARED', store_id: 'trendy-storeee', product_id: null, ad_account_id: `${T}acc`, campaign_id: `${T}ac_c${n}`, campaign_name: `${T}ac camp ${n}`, action: o.action || 'SCALE_DOWN', rule_id: o.rule_id ?? null, rule_name: o.rule_name || 'DYNAMIC_BUDGET:DYN_REDUCE', mode_at_decision: 'APPROVAL', confidence: 'HIGH', blocked_codes_json: JSON.stringify(o.blocked || []), evidence_json: '{}', why_json: '{}', params_json: JSON.stringify({ pct: 20, fromBudget: o.from ?? 300, toBudget: o.to ?? 240, level: 'campaign', entityId: `${T}ac_e${n}` }), before_json: '{}' } }); decisions.push(d.id); return d; };
try {
  const admin = await mkUser('ADMIN', 'a'), mgr = await mkUser('MANAGER', 'm');

  console.log('\n1. Gate verdict per action (would an approval reach Meta?)');
  ok('all open → executable', AC.gateOf(cfg(), 'PAUSE').executableNow === true);
  ok('lock closed / SHADOW / emergency / permission OFF each block and are named', AC.gateOf(cfg({ writesLocked: true }), 'PAUSE').reasons.some((r) => /مقفولة على مستوى النشر/.test(r)) && AC.gateOf(cfg({ mode: 'SHADOW' }), 'PAUSE').reasons.some((r) => /SHADOW/.test(r)) && AC.gateOf(cfg({ emergency_stop: true }), 'PAUSE').reasons.some((r) => /Emergency/.test(r)) && AC.gateOf(cfg({}, { pause: false }), 'PAUSE').reasons.some((r) => /إيقاف الحملات/.test(r)));
  ok('each action needs ITS permission: PAUSE ok with only «pause»; budget-down needs «budgetDecrease»', AC.gateOf(cfg({}, { open: false, budgetIncrease: false, budgetDecrease: false }), 'PAUSE').executableNow && !AC.gateOf(cfg({}, { budgetDecrease: false }), 'SCALE_DOWN').executableNow && !AC.gateOf(cfg({}, { budgetIncrease: false }), 'SCALE_UP').executableNow);

  console.log('\n2. One list — Campaign | Product | Action | Before | After | Reason | Risk | Confidence');
  const decs = [
    shaped({ id: 1, action: 'SCALE_DOWN', isBudgetDecision: true, params: { fromBudget: 300, toBudget: 240 } }),
    shaped({ id: 2, action: 'PAUSE', campaignName: 'P', blocks: [{ code: 'MAPPING_NOT_VERIFIED', severity: 'BLOCK' }] }),
    shaped({ id: 3, action: 'OPEN', confidence: 'LOW' }),
    shaped({ id: 4, action: 'SCALE_UP', isBudgetDecision: true, params: { fromBudget: 300, toBudget: 360 }, warnings: [{ code: 'A' }, { code: 'B' }] }),
    shaped({ id: 5, status: 'SHADOW', action: 'PAUSE' }),
  ];
  const lst = await AC.listApprovals({ deps: { config: cfg({ writesLocked: true }), decisions: decs, plans: [{ id: 9, plan_key: 'OPEN|2031-01-01|T-x', type: 'OPEN', plan_date: '2031-01-01', data_state: 'FRESH', items: [{ selected: true, evidence_json: '{"budget":600}' }, { selected: true, evidence_json: '{"budget":200}' }, { selected: false, evidence_json: '{"budget":999}' }] }] } });
  const by = Object.fromEntries(lst.decisions.map((d) => [d.id, d]));
  ok('only PREPARED/SNOOZED decisions are listed (a SHADOW one is not an approval)', lst.decisions.length === 4 && !by[5]);
  ok('budget reduce: before 300 → after 240; exposed budget = the new budget', by[1].before.value === 300 && by[1].after.value === 240 && by[1].exposedBudget === 240);
  ok('pause: ACTIVE → PAUSED; open: PAUSED → ACTIVE', by[2].before.value === 'ACTIVE' && by[2].after.value === 'PAUSED' && by[3].before.value === 'PAUSED' && by[3].after.value === 'ACTIVE');
  ok('risk: a hard block → HIGH; LOW confidence or 2+ warnings → MEDIUM; clean → LOW', by[2].risk === 'HIGH' && by[3].risk === 'MEDIUM' && by[4].risk === 'MEDIUM' && AC.riskOf(shaped()) === 'LOW');
  ok('bulk-eligible = PREPARED + (PAUSE | reduce) + no hard block only (not open, not increase, not blocked)', by[1].bulkEligible && !by[2].bulkEligible && !by[3].bulkEligible && !by[4].bulkEligible);
  ok('every row says whether approving would really execute (lock closed → not now, with the reason)', lst.decisions.every((d) => d.execution.executableNow === false && d.execution.reasons.length) && lst.gate.writesLocked === true);
  ok('plans: selected count + exposed budget of the SELECTED campaigns only (600+200); independent flag from the key', lst.plans[0].selected === 2 && lst.plans[0].total === 3 && lst.plans[0].exposedBudget === 800 && lst.plans[0].independent === true);
  ok('totals add up', lst.totals.pendingDecisions === 4 && lst.totals.pendingPlans === 1 && lst.totals.bulkEligible === 1);

  console.log('\n3. Bulk approval — preview, confirmation, snapshot, spacing');
  const a = await mkDec({ from: 300, to: 240 }), b = await mkDec({ from: 500, to: 400 }), c = await mkDec({ action: 'SCALE_UP', from: 300, to: 360 }), blockedD = await mkDec({ blocked: [{ code: 'X', severity: 'BLOCK' }] }), done = await mkDec({ status: 'VERIFIED' });
  const pv = await AC.bulkPreview({ ids: [a.id, b.id], deps: { config: cfg() } });
  ok('two homogeneous clean reductions: preview ok, count 2, exposed budget = 240 + 400', pv.ok && pv.count === 2 && pv.exposedBudget === 640 && pv.items.length === 2, JSON.stringify(pv.blockers));
  ok('mixed actions refused', (await AC.bulkPreview({ ids: [a.id, c.id], deps: { config: cfg() } })).blockers.some((x) => /متجانسة|منخفضة المخاطر/.test(x)));
  ok('a decision with a hard block is refused', (await AC.bulkPreview({ ids: [a.id, blockedD.id], deps: { config: cfg() } })).blockers.some((x) => /موانع/.test(x)));
  ok('a non-PREPARED decision is refused', (await AC.bulkPreview({ ids: [a.id, done.id], deps: { config: cfg() } })).blockers.some((x) => /مش جاهزة/.test(x)));
  ok('an increase is never bulk-approvable', (await AC.bulkPreview({ ids: [c.id], deps: { config: cfg() } })).blockers.some((x) => /منخفضة المخاطر/.test(x)));
  ok('more than 10 refused; empty refused', (await AC.bulkPreview({ ids: Array.from({ length: 11 }, (_, i) => i + 1), deps: { config: cfg(), rows: [] } })).blockers.some((x) => /10/.test(x)) && (await AC.bulkPreview({ ids: [] })).ok === false);
  ok('while the Meta write-lock is closed (or the permission is OFF) the bulk is refused up front with the reason', (await AC.bulkPreview({ ids: [a.id, b.id], deps: { config: cfg({ writesLocked: true }) } })).blockers.some((x) => /مقفولة على مستوى النشر/.test(x)) && (await AC.bulkPreview({ ids: [a.id, b.id], deps: { config: cfg({}, { budgetDecrease: false }) } })).blockers.some((x) => /تقليل الميزانية/.test(x)));
  const sleeps = []; const before = await prisma.ambOperatorEvent.count({ where: { kind: 'BULK_APPROVAL_SNAPSHOT' } });
  const r = await OPS.bulkApprove({ decisionIds: [a.id, b.id], confirmedIds: [a.id, b.id], userId: admin.id, deps: { sleep: async (ms) => { sleeps.push(ms); }, approveAndExecute: async () => ({ ok: false, aborted: true }) } });
  ok('bulk approval saves a SNAPSHOT of exactly these decisions + budgets', (await prisma.ambOperatorEvent.count({ where: { kind: 'BULK_APPROVAL_SNAPSHOT' } })) === before + 1 && JSON.parse((await prisma.ambOperatorEvent.findFirst({ where: { kind: 'BULK_APPROVAL_SNAPSHOT' }, orderBy: { id: 'desc' } })).data_json).items.length === 2);
  ok('items are processed one by one with a ≥3s spacing between them', sleeps.length === 1 && sleeps[0] >= 3000 && r.results.length === 2, JSON.stringify(sleeps));
  ok('each item went through the official approve path (re-validated on its own) — here refused by the real gates, nothing executed', r.results.every((x) => x.executed === false) && (await prisma.ambAction.count()) === c0.actions);
  await prisma.ambOperatorEvent.deleteMany({ where: { kind: 'BULK_APPROVAL_SNAPSHOT', actor_id: admin.id } });

  console.log('\n4. HTTP surface');
  const tok = (u, role) => jwt.sign({ id: u.id, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api/operator', operatorRoutes); app.use(errorHandler);
  const server = await new Promise((rs) => { const s = app.listen(0, '127.0.0.1', () => rs(s)); }); const base = `http://127.0.0.1:${server.address().port}/api/operator`;
  const call = async (method, path, body, u, role) => { const x = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(u ? { Cookie: `token=${tok(u, role)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); let json = null; try { json = await x.json(); } catch { /* */ } return { status: x.status, json }; };
  try {
    ok('unauthenticated → 401', (await call('GET', '/approvals')).status === 401);
    const g = await call('GET', '/approvals', undefined, mgr, 'MANAGER'); ok('MANAGER can read the approvals list', g.status === 200 && Array.isArray(g.json.decisions) && g.json.gate);
    ok('MANAGER cannot preview/execute a bulk approval (403)', (await call('POST', '/approvals/bulk-preview', { decisionIds: [a.id] }, mgr, 'MANAGER')).status === 403 && (await call('POST', '/approvals/bulk', { decisionIds: [a.id] }, mgr, 'MANAGER')).status === 403);
    const bad = await call('POST', '/approvals/bulk', { decisionIds: [a.id, b.id], confirm: { count: 1, exposedBudget: 1 } }, admin, 'ADMIN');
    ok('ADMIN bulk without the right confirmation (or while the real gate is closed) → refused, nothing executed, decisions stay PREPARED', [400, 409].includes(bad.status) && (await prisma.ambOperatorDecision.findUnique({ where: { id: a.id } })).status === 'PREPARED' && (await prisma.ambAction.count()) === c0.actions, JSON.stringify(bad.json).slice(0, 200));
    ok('status-bar numbers', (await call('GET', '/status-bar', undefined, mgr, 'MANAGER')).json.pendingApprovals >= 0);
  } finally { server.close(); }

  console.log('\n5. Rule-based decisions need their own permission too');
  ok('permissionGate: OFF → message naming the switch; ON → null; unknown action / no permissions object (stub) → null', EN.permissionGate({ execPermissions: { pause: false } }, 'PAUSE')?.includes('إيقاف الحملات') && EN.permissionGate({ execPermissions: { pause: true } }, 'PAUSE') === null && EN.permissionGate({ execPermissions: { pause: false } }, 'PREPARE_TEST') === null && EN.permissionGate({}, 'PAUSE') === null);
  ok('the engine keeps such a decision PREPARED (not BLOCKED) when only the permission is off', /permissionKeep/.test(fs.readFileSync(join(__dirname, '../services/amb/operatorEngine.js'), 'utf8')));

  console.log('\n6. Daily AI Brief — every number states its source and period');
  const now = new Date('2031-04-01T10:00:00Z');
  const brief = BR.composeBrief({ now, kpis: { spend: 12000, metaPurchases: 100, avgCpa: 120 }, freshness: { metaLastSuccessSyncAt: new Date('2031-04-01T09:50:00Z') }, window: { from: '2031-04-01', to: '2031-04-01' },
    campaignsLast3: [{ name: 'good', spend: 900, purchases: 12, cpa: 75 }, { name: 'ok', spend: 700, purchases: 5, cpa: 140 }, { name: 'one', spend: 50, purchases: 1, cpa: 50 }, { name: 'bad', spend: 600, purchases: 0, cpa: null }, { name: 'dear', spend: 500, purchases: 2, cpa: 250 }],
    decisions: [{ action: 'SCALE_UP' }, { action: 'PAUSE' }, { action: 'PAUSE' }, { action: 'SCALE_DOWN' }], executed: [{ type: 'DECREASE_BUDGET', name: 'x', at: now, verified: true }], pendingDecisions: 3, pendingPlans: 1, alerts: [{ severity: 'CRITICAL', title: 't', at: now }], activeCampaigns: 46 });
  ok('12 items, EACH with a source and a period', brief.items.length === 12 && brief.items.every((i) => i.source && i.window && i.label));
  ok('activeCampaigns / spend / purchases / avgCpa carry the real numbers', brief.items.find((i) => i.key === 'activeCampaigns').value === 46 && brief.items.find((i) => i.key === 'spend').value === 12000 && brief.items.find((i) => i.key === 'purchases').value === 100 && brief.items.find((i) => i.key === 'avgCpa').value === 120);
  ok('purchases are labelled Meta Pixel purchases — never delivered orders', /Pixel/.test(brief.items.find((i) => i.key === 'purchases').label) && /مش أوردرات مسلّمة|≠ أوردرات/.test(brief.caveat + brief.items.find((i) => i.key === 'purchases').label));
  ok('best campaigns: lowest CPA with 3+ orders only (a single order never qualifies)', brief.items.find((i) => i.key === 'bestCampaigns').value.map((x) => x.campaign).join() === 'good,ok');
  ok('worst campaigns: spend ≥200 with zero orders or CPA > 200, most spend first', brief.items.find((i) => i.key === 'worstCampaigns').value.map((x) => x.campaign).join() === 'bad,dear');
  ok('opportunities / pause / reduce counts and the pending approvals', brief.items.find((i) => i.key === 'scaleOpportunities').value === 1 && brief.items.find((i) => i.key === 'pauseDecisions').value === 2 && brief.items.find((i) => i.key === 'reduceDecisions').value === 1 && brief.items.find((i) => i.key === 'awaitingApproval').value.decisions === 3 && brief.items.find((i) => i.key === 'awaitingApproval').value.plans === 1);
  const empty = BR.composeBrief({ now, kpis: null, freshness: null, window: null, campaignsLast3: [], decisions: [], executed: [], pendingDecisions: 0, pendingPlans: 0, alerts: [], activeCampaigns: null });
  ok('with no data it does not invent numbers (nulls / empty lists), sources still shown', empty.items.find((i) => i.key === 'spend').value === null && empty.items.every((i) => i.source && i.window));
  const stat = await AC.statusBar({ deps: { activeCampaigns: 7 } }); ok('status bar: active campaigns, pending approvals, scheduled plans, important alerts', stat.activeCampaigns === 7 && ['pendingApprovals', 'scheduledPlans', 'importantAlerts'].every((k) => typeof stat[k] === 'number'));
  const srcs = ['approvalCenter.js', 'operatorBrief.js'].map((f) => fs.readFileSync(join(__dirname, '../services/amb', f), 'utf8'));
  ok('neither module can execute anything: no executor / Meta client imports', srcs.every((s) => !/executor|metaGraphClient|approveAndExecute|setEntity|graphPost/.test(s.split('\n').filter((l) => /^\s*import\b/.test(l) || /await import\(/.test(l)).join(' '))));
} catch (e) {
  fail++; console.log('  ✗ UNEXPECTED', e.stack || e.message);
} finally {
  await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ decision_id: { in: decisions } }, { actor_id: { in: users } }, { campaign_id: { startsWith: T } }] } }).catch(() => {});
  await prisma.ambOperatorDecision.deleteMany({ where: { OR: [{ id: { in: decisions } }, { campaign_id: { startsWith: T } }] } }).catch(() => {});
  await prisma.ambAlert.deleteMany({ where: { OR: [{ entity_id: { startsWith: T } }, { campaign_id: { startsWith: T } }, { title: { contains: T } }, { message: { contains: T } }, { ad_account_id: `${T}acc` }] } }).catch(() => {});
  await prisma.aiAuditLog.deleteMany({ where: { actor_id: { in: users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  console.log(`\nSAFETY: actions ${c0.actions} -> ${await prisma.ambAction.count()} | Meta calls in this test = 0 | fixtures removed`);
  console.log(`\n${fail === 0 ? '✅' : '❌'} approvalCenterTest: ${pass} passed, ${fail} failed`);
  await prisma.$disconnect(); process.exit(fail ? 1 : 0);
}
