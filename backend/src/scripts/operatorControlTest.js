// 🤖 AI Operator — GLOBAL CONTROL acceptance: Autopilot permission toggles, AUTO_ACTION_DISABLED guard, MANUAL/SHADOW/APPROVAL/AUTOPILOT transitions,
// owner-confirmed price override. NO Meta call: the executor is an injected spy and the deployment write-lock is asserted closed.
//   node src/scripts/operatorControlTest.js
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const retryDb = async (fn) => { for (let i = 0; i < 10; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
if (!process.env.JWT_SECRET) { console.log('JWT_SECRET missing'); process.exit(2); }
const { prisma } = await imp('../prisma.js');
const S = await imp('../services/amb/operatorStore.js');
const G = await imp('../services/amb/operatorGuards.js');
const A = await imp('../services/amb/operatorAutoActions.js');
const C = await imp('../services/amb/operatorControl.js');
const P = await imp('../services/amb/productPriceResolver.js');
const AP = await imp('../services/amb/advisorPlan.js');
const E = await imp('../services/amb/operatorEngine.js');
const SCH = await imp('../services/amb/operatorScheduler.js');
const SET = await imp('../services/amb/settings.js');
const { default: operatorRoutes } = await imp('../routes/operator.js');
const { errorHandler } = await imp('../middleware/errorHandler.js');

const T = '__optest_';
const t0 = new Date();
const created = { users: [], decisions: [] };
const origCfg = await S.getOperatorConfig();
const origAuto = A.autoActionsState(await SET.getAmbSettings());
const origOverrides = JSON.parse(JSON.stringify(origCfg.limits.productOverrides || {}));
const counts0 = { recs: await prisma.ambRecommendation.count(), actions: await prisma.ambAction.count() };
const NOW = new Date();
const baseCfg = { mode: 'AUTOPILOT', emergency_stop: false, limits: JSON.parse(JSON.stringify(S.DEFAULT_LIMITS)), cooldowns: { ...S.DEFAULT_COOLDOWNS }, schedule: { mode: 'ALWAYS', ranges: [], tzOffsetHours: 3 } };
const allOn = { ambMinSpendBeforeDecision: 150, ambMinPurchasesBeforeScaling: 5, ambAllowAutoPause: true, ambAllowAutoOpen: true, ambAllowAutoScale: true, ambAllowAutoBudgetIncrease: true, ambAllowAutoBudgetDecrease: true, ambMaxBudgetIncreasePct: 20, ambMaxAutoExecutionAmount: 500 };
const mkCtx = (o = {}) => ({ storeId: 'trendy-storeee', campaign: { id: 'c1', status: 'ACTIVE', budget: 200, tag: null, testing: null, firstSeenAt: new Date(NOW.getTime() - 200 * 3_600_000).toISOString() }, metrics: { spend: 600, purchases: 10 }, product: { id: 1, mappingVerified: true }, dq: { gate: 'OK', overall: 'RECONCILED', statusTrust: { state: 'OK' } }, stock: { status: 'SAFE', currentStock: 100, daysRemaining: 30 }, econ: { complete: true, profitState: 'PROFITABLE', hardStopCpa: 200 }, exceptions: [], recent: { lastByAction: {}, todayCount: 0 }, metaConnected: true, metaStale: false, advisor: { scalePlanPresent: true, stage: 'SCALE', scaleBlockers: [] }, incidents: [], ...o });
const mkDec = (o = {}) => ({ action: 'PAUSE', params: {}, ruleMode: 'AUTOPILOT', confidence: 'HIGH', needs: {}, ruleMinSpend: 150, cooldownHours: 12, ...o });
const run = (dec, ctx, cfg = baseCfg, set = allOn) => G.evaluateGuards({ decision: dec, ctx, config: cfg, settings: set, counters: {}, now: NOW });
const codes = (g) => g.blocks.map((b) => b.code);
const scaleDec = () => mkDec({ action: 'SCALE_UP', params: { pct: 15, fromBudget: 200, toBudget: 230 }, needs: { profit: true, stock: true } });
const without = (k) => ({ ...allOn, [k]: false });

try {
  // ===================================================================================================================
  console.log('\n1. toggle table (pure)');
  ok('five toggles exist with the requested names', JSON.stringify(A.AUTO_ACTION_KEYS) === JSON.stringify(['pause', 'open', 'scale', 'budgetIncrease', 'budgetReduce']) && A.AUTO_ACTIONS.map((t) => t.label).join('|') === 'Auto Pause|Auto Open|Auto Scale|Auto Budget Increase|Auto Budget Reduce');
  ok('every toggle defaults OFF in the AMB settings', A.AUTO_ACTIONS.every((t) => SET.AMB_DEFAULT_SETTINGS[t.setting] === false));
  ok('state: only an explicit true counts as ON', A.autoActionsState({ ambAllowAutoPause: 'true', ambAllowAutoOpen: 1, ambAllowAutoScale: true }).pause === false && A.autoActionsState({ ambAllowAutoScale: true }).scale === true && Object.values(A.autoActionsState({})).every((v) => v === false));
  ok('PAUSE needs pause; OPEN needs open; SCALE_UP needs scale AND budgetIncrease; SCALE_DOWN needs budgetReduce', JSON.stringify(A.togglesRequiredFor('PAUSE')) === '["pause"]' && JSON.stringify(A.togglesRequiredFor('OPEN')) === '["open"]' && JSON.stringify(A.togglesRequiredFor('SCALE_UP')) === '["scale","budgetIncrease"]' && JSON.stringify(A.togglesRequiredFor('SCALE_DOWN')) === '["budgetReduce"]' && A.togglesRequiredFor('PREPARE_TEST').length === 0);

  // ===================================================================================================================
  console.log('\n2. AUTO_ACTION_DISABLED guard (AUTOPILOT only)');
  const noScalePlan = { advisor: { scalePlanPresent: false, stage: 'NEEDS_FIX', scaleBlockers: [] } }; // the Advisor does not see a scale plan => a PAUSE / REDUCE does not conflict with it
  let g = run(mkDec(), mkCtx(noScalePlan));
  ok('all toggles ON + clean PAUSE => AUTO', g.wouldBe === 'AUTO' && g.canAutoExecute && !codes(g).includes('AUTO_ACTION_DISABLED'), JSON.stringify(codes(g)));
  g = run(mkDec(), mkCtx(noScalePlan), baseCfg, without('ambAllowAutoPause'));
  ok('Auto Pause OFF => PAUSE downgraded to approval (not AUTO, not executed, not dropped)', codes(g).includes('AUTO_ACTION_DISABLED') && g.wouldBe === 'PREPARED' && !g.canAutoExecute && g.canExecute && g.blocks.find((b) => b.code === 'AUTO_ACTION_DISABLED').severity === 'DOWNGRADE');
  g = run(mkDec({ action: 'OPEN', needs: { profit: true, stock: true } }), mkCtx({ campaign: { id: 'c1', status: 'PAUSED', budget: 200 } }), baseCfg, without('ambAllowAutoOpen'));
  ok('Auto Open OFF => OPEN downgraded', codes(g).includes('AUTO_ACTION_DISABLED') && !g.canAutoExecute, JSON.stringify(codes(g)));
  g = run(scaleDec(), mkCtx(), baseCfg, without('ambAllowAutoScale'));
  ok('Auto Scale OFF (budget increase ON) => SCALE_UP downgraded; detail names the missing toggle', codes(g).includes('AUTO_ACTION_DISABLED') && !g.canAutoExecute && /scale/.test(g.blocks.find((b) => b.code === 'AUTO_ACTION_DISABLED').detail), JSON.stringify(codes(g)));
  g = run(scaleDec(), mkCtx(), baseCfg, without('ambAllowAutoBudgetIncrease'));
  ok('Auto Budget Increase OFF (scale ON) => SCALE_UP downgraded', codes(g).includes('AUTO_ACTION_DISABLED') && !g.canAutoExecute && /budgetIncrease/.test(g.blocks.find((b) => b.code === 'AUTO_ACTION_DISABLED').detail));
  g = run(scaleDec(), mkCtx());
  ok('both Scale + Budget Increase ON => no toggle block', !codes(g).includes('AUTO_ACTION_DISABLED'), JSON.stringify(codes(g)));
  g = run(mkDec({ action: 'SCALE_DOWN', params: { pct: 20, fromBudget: 200, toBudget: 160 } }), mkCtx(noScalePlan), baseCfg, without('ambAllowAutoBudgetDecrease'));
  ok('Auto Budget Reduce OFF => SCALE_DOWN downgraded', codes(g).includes('AUTO_ACTION_DISABLED') && !g.canAutoExecute);
  g = run(mkDec({ action: 'SCALE_DOWN', params: { pct: 20, fromBudget: 200, toBudget: 160 } }), mkCtx(noScalePlan), baseCfg, { ...allOn, ambAllowAutoBudgetIncrease: false, ambAllowAutoScale: false });
  ok('Budget Reduce is independent of Scale / Budget Increase', !codes(g).includes('AUTO_ACTION_DISABLED') && g.canAutoExecute, JSON.stringify(codes(g)));
  const allOff = { ...allOn, ambAllowAutoPause: false, ambAllowAutoOpen: false, ambAllowAutoScale: false, ambAllowAutoBudgetIncrease: false, ambAllowAutoBudgetDecrease: false };
  ok('all OFF (the default) => NO action can auto-execute in AUTOPILOT', ['PAUSE', 'OPEN', 'SCALE_UP', 'SCALE_DOWN'].every((a) => { const gg = run(mkDec({ action: a, params: { pct: 10, fromBudget: 200, toBudget: 220 }, needs: {} }), mkCtx({ campaign: { id: 'c1', status: a === 'OPEN' ? 'PAUSED' : 'ACTIVE', budget: 200 } }), baseCfg, allOff); return !gg.canAutoExecute; }));
  g = run(mkDec(), mkCtx(), { ...baseCfg, mode: 'APPROVAL' }, allOff);
  ok('APPROVAL mode: toggles are irrelevant (a human approves) — no AUTO_ACTION_DISABLED', !codes(g).includes('AUTO_ACTION_DISABLED') && g.wouldBe === 'PREPARED');
  g = run(mkDec({ ruleMode: 'SHADOW' }), mkCtx(), { ...baseCfg, mode: 'SHADOW' }, allOff);
  ok('SHADOW mode: toggles irrelevant, nothing executes', !codes(g).includes('AUTO_ACTION_DISABLED') && g.wouldBe === 'SHADOW' && !g.canExecute);
  g = run(mkDec(), mkCtx(), { ...baseCfg, emergency_stop: true }, allOn);
  ok('Emergency Stop beats ON toggles (primary block, nothing executes)', g.primary.code === 'EMERGENCY_STOP' && !g.canExecute && !g.canAutoExecute);
  g = run(mkDec(), mkCtx(), { ...baseCfg, mode: 'OFF' }, allOn);
  ok('MANUAL (OFF) beats ON toggles', codes(g).includes('MODE_OFF') && !g.canExecute && !g.canAutoExecute);
  g = run(mkDec(), mkCtx(), { ...baseCfg, writesLocked: true }, allOn);
  ok('deployment write-lock beats ON toggles', codes(g).includes('META_WRITES_LOCKED') && !g.canExecute);

  // ===================================================================================================================
  console.log('\n3. control strip (pure)');
  const st = (mode, o = {}, set = allOn, locked = false) => C.buildControlStatus({ config: { mode, emergency_stop: false, ...o }, settings: set, writesLocked: locked });
  ok('mode vocabulary: OFF is shown as MANUAL; SHADOW/APPROVAL/AUTOPILOT with their icons', st('OFF').modeLabel === 'MANUAL' && st('OFF').icon === '🔴' && st('SHADOW').icon === '👁' && st('APPROVAL').icon === '🟡' && st('AUTOPILOT').icon === '🟢');
  ok('strip carries Pause/Open/Scale/Budget permissions', JSON.stringify(Object.keys(st('AUTOPILOT').permissions)) === '["pause","open","scale","budget"]' && st('AUTOPILOT').permissions.pause === true && st('AUTOPILOT', {}, { ambAllowAutoPause: true }).permissions.open === false);
  ok('Scale permission needs BOTH Scale and Budget Increase', st('AUTOPILOT', {}, { ambAllowAutoScale: true }).permissions.scale === false && st('AUTOPILOT').permissions.scale === true);
  ok('a toggle is "effective" only in AUTOPILOT, with no Emergency Stop and an open write-lock', st('AUTOPILOT').toggles.every((t) => t.effective) && st('SHADOW').toggles.every((t) => !t.effective) && st('AUTOPILOT', {}, allOn, true).toggles.every((t) => !t.effective) && st('AUTOPILOT', { emergency_stop: true }).toggles.every((t) => !t.effective));
  ok('Emergency Stop shows 🛑 and says so', st('AUTOPILOT', { emergency_stop: true }).icon === '🛑' && /الطوارئ/.test(st('AUTOPILOT', { emergency_stop: true }).summary_ar));
  ok('autopilotCanExecute is false in SHADOW / when locked / when every toggle is OFF', !st('SHADOW').autopilotCanExecute && !st('AUTOPILOT', {}, allOn, true).autopilotCanExecute && !st('AUTOPILOT', {}, {}).autopilotCanExecute && st('AUTOPILOT').autopilotCanExecute);

  // ===================================================================================================================
  console.log('\n4. owner-confirmed price override (pure resolver)');
  const prodH = { product_name: 'كاب الليزر لتحفيز نمو الشعر', selling_price: 3000 };
  const cat = P.indexStoreCatalog([{ id: 'u1', name: 'كاب الليزر لتحفيز نمو الشعر (s109)', slug: 'Hair-Cap', price: 4500 }]);
  const oc = { value: 3000, by: 7, at: '2026-10-06T00:00:00.000Z', source: 'USER_CONFIRMED' };
  let pr = P.resolveSellingPrice({ product: prodH, ambProduct: { actual_selling_price: 3000 }, storeCatalog: cat });
  ok('without the override: 3000 vs Easy Orders 4500 => CONFLICT', pr.status === 'CONFLICT');
  pr = P.resolveSellingPrice({ product: prodH, ambProduct: { actual_selling_price: 3000 }, storeCatalog: cat, ownerConfirmed: oc });
  ok('with the override: VERIFIED, source OWNER_CONFIRMED, user/time/source kept, the 4500 reported (never edited)', pr.status === 'VERIFIED' && pr.value === 3000 && pr.source === 'OWNER_CONFIRMED' && pr.ownerConfirmed.by === 7 && pr.ownerConfirmed.at === oc.at && pr.ownerConfirmed.source === 'USER_CONFIRMED' && pr.overriddenStoreCatalogPrice === 4500, JSON.stringify(pr));
  pr = P.resolveSellingPrice({ product: prodH, ambProduct: { actual_selling_price: 3200 }, storeCatalog: cat, ownerConfirmed: oc });
  ok('stale confirmation (AMB price changed since) is IGNORED => CONFLICT again', pr.status === 'CONFLICT' && pr.source === null);
  pr = P.resolveSellingPrice({ product: { ...prodH, selling_price: 3300 }, ambProduct: { actual_selling_price: 3000 }, storeCatalog: cat, ownerConfirmed: oc });
  ok('stale confirmation (catalogue Product price differs) is IGNORED', pr.status === 'CONFLICT');
  pr = P.resolveSellingPrice({ product: { product_name: 'منتج آخر', selling_price: 3000 }, ambProduct: { actual_selling_price: 3000 }, storeCatalog: P.indexStoreCatalog([{ id: 'u2', name: 'منتج آخر', price: 4500 }]) });
  ok('another product (no confirmation) keeps its CONFLICT — the override is per product', pr.status === 'CONFLICT');
  ok('a non-positive confirmation is ignored', P.resolveSellingPrice({ product: prodH, ambProduct: { actual_selling_price: 3000 }, storeCatalog: cat, ownerConfirmed: { value: 0 } }).status === 'CONFLICT');

  // ===================================================================================================================
  console.log('\n5. stored override: who/when/source, per product, clearing keeps the rest');
  const PID = 987654321; // not a real product: only the override map is touched
  const owner = await S.setOwnerConfirmedPrice({ productId: PID, value: 3000, userId: null, note: `${T}note` });
  const cfg1 = await S.getOperatorConfig();
  ok('ownerPrice saved with value + at + source USER_CONFIRMED', owner.ownerPrice.value === 3000 && owner.ownerPrice.source === 'USER_CONFIRMED' && !!owner.ownerPrice.at && S.ownerPriceOf(cfg1, PID).value === 3000);
  ok('another product has no ownerPrice', S.ownerPriceOf(cfg1, PID + 1) === null);
  let bad = null; try { await S.setOwnerConfirmedPrice({ productId: PID, value: -5 }); } catch (e) { bad = e; }
  ok('negative / zero price rejected (400)', bad && bad.status === 400);
  await S.setProductProvenance({ productId: PID, fields: { current_stock: { source: 'USER_CONFIRMED', kind: 'MANUAL_SNAPSHOT', asOf: '2026-10-06' }, minimum_stock: { source: 'USER_CONFIGURED', temporary: true } } });
  await S.setProductOverride({ productId: PID, zeroOrder: { mode: 'TARGET_CPA_MULTIPLE', multiple: 3, minCampaignAgeHours: 24, attributionGraceHours: 6, recentPurchaseHours: 3 } });
  let ov = (await S.getOperatorConfig()).limits.productOverrides[String(PID)];
  ok('zero-order, owner price and provenance live side by side', ov.zeroOrder.multiple === 3 && ov.ownerPrice.value === 3000 && ov.provenance.current_stock.source === 'USER_CONFIRMED' && ov.provenance.minimum_stock.temporary === true && !!ov.provenance.minimum_stock.at);
  await S.setProductOverride({ productId: PID, zeroOrder: null });
  ov = (await S.getOperatorConfig()).limits.productOverrides[String(PID)];
  ok('clearing zero-order leaves the owner price + provenance', !ov.zeroOrder && ov.ownerPrice.value === 3000 && !!ov.provenance);
  await S.setOwnerConfirmedPrice({ productId: PID, value: null });
  ov = (await S.getOperatorConfig()).limits.productOverrides[String(PID)];
  ok('clearing the owner price keeps provenance', !ov.ownerPrice && !!ov.provenance);

  // ===================================================================================================================
  console.log('\n6. routes: toggles are ADMIN-only, validated, audited — and never execute');
  const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api/operator', operatorRoutes); app.use(errorHandler);
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/operator`;
  const call = async (method, path, body, token) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `token=${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ } return { status: r.status, json }; };
  const mkUser = async (role, tag) => { const u = await prisma.user.create({ data: { email: `${T}ctl_${tag}_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}${tag}`, role, status: 'ACTIVE', permissions: '{}' } }); created.users.push(u.id); return { user: u, token: jwt.sign({ id: u.id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' }) }; };
  const admin = await mkUser('ADMIN', 'admin'), manager = await mkUser('MANAGER', 'mgr');
  await S.setOperatorMode({ mode: 'SHADOW' }); await S.setEmergencyStop({ on: false });
  let r = await call('GET', '/control', undefined, manager.token);
  ok('MANAGER can read the control strip: SHADOW, write-lock closed', r.status === 200 && r.json.mode === 'SHADOW' && r.json.modeLabel === 'SHADOW' && r.json.writesLocked === true && r.json.toggles.length === 5, JSON.stringify(r.json).slice(0, 200));
  r = await call('PUT', '/auto-actions', { pause: true }, manager.token);
  ok('MANAGER cannot change a toggle (403)', r.status === 403);
  r = await call('PUT', '/auto-actions', { turbo: true }, admin.token);
  ok('unknown toggle => 400', r.status === 400);
  r = await call('PUT', '/auto-actions', { pause: 'yes' }, admin.token);
  ok('non-boolean => 400', r.status === 400);
  r = await call('PUT', '/auto-actions', {}, admin.token);
  ok('empty body => 400', r.status === 400);
  r = await call('PUT', '/auto-actions', { pause: true, scale: true }, admin.token);
  ok('ADMIN turns Auto Pause + Auto Scale ON: reported + persisted + audited', r.status === 200 && r.json.changed.pause?.to === true && r.json.changed.scale?.to === true && r.json.status.toggles.find((t) => t.key === 'pause').on === true && (await SET.getAmbSettings()).ambAllowAutoPause === true && (await prisma.aiAuditLog.count({ where: { kind: 'OPERATOR_AUTO_ACTIONS', actor_id: admin.user.id } })) >= 1, JSON.stringify(r.json).slice(0, 200));
  ok('...but in SHADOW nothing is effective and Autopilot cannot execute', r.json.status.toggles.every((t) => !t.effective) && r.json.status.autopilotCanExecute === false && r.json.status.writesLocked === true);
  ok('/overview carries the same strip', (await call('GET', '/overview', undefined, admin.token)).json.control?.toggles?.length === 5);
  r = await call('PUT', '/auto-actions', { pause: false, scale: false }, admin.token);
  ok('toggles turn back OFF', r.json.status.toggles.every((t) => t.on === false));

  // ===================================================================================================================
  console.log('\n7. mode transitions (no Meta write, no rollback)');
  ok('precondition: write-lock closed', S.metaWritesLocked() === true);
  for (const m of ['APPROVAL', 'SHADOW', 'MANUAL', 'SHADOW']) { const c = await S.setOperatorMode({ mode: m, userId: admin.user.id }); ok(`mode -> ${m} stored as ${m === 'MANUAL' ? 'OFF' : m}`, c.mode === (m === 'MANUAL' ? 'OFF' : m)); }
  bad = null; try { await S.setOperatorMode({ mode: 'AUTOPILOT', userId: admin.user.id }); } catch (e) { bad = e; }
  ok('AUTOPILOT still needs explicit confirmation + the activation gate (refused here)', bad && [400, 409].includes(bad.status));
  const mkDecRow = async (o = {}) => { const d = await prisma.ambOperatorDecision.create({ data: { decision_key: `${T}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, store_id: `${T}storeA`, ad_account_id: `${T}acc`, campaign_id: `${T}cc`, campaign_name: `${T}ctl campaign`, action: 'SCALE_DOWN', rule_name: `${T}rollback`, mode_at_decision: 'APPROVAL', status: 'PREPARED', confidence: 'HIGH', params_json: JSON.stringify({ rollbackOf: 1, fromBudget: 230, toBudget: 200, pct: 13, window: 'today' }), evidence_json: '{}', why_json: JSON.stringify({ what: 'x', why: 'y' }), ...o } }); created.decisions.push(d.id); return d; };
  const qd = await mkDecRow(); const qd2 = await mkDecRow({ action: 'PAUSE', params_json: JSON.stringify({ window: 'today' }) });
  const spy = { calls: 0 }; const deps = { approveAndExecute: async () => { spy.calls++; return { ok: true }; } };
  await S.setOperatorMode({ mode: 'APPROVAL', userId: admin.user.id });
  const before = await prisma.ambOperatorDecision.count({ where: { status: { in: ['PREPARED', 'APPROVED'] } } });
  await S.setOperatorMode({ mode: 'MANUAL', userId: admin.user.id });
  const ev = await prisma.ambOperatorEvent.findFirst({ where: { kind: 'MODE_CHANGE', actor_id: admin.user.id, note: { contains: 'APPROVAL -> OFF' } }, orderBy: { id: 'desc' } });
  ok('entering MANUAL records the queued decisions it HELD (no rollback, no campaign/budget change)', ev && /held queued decisions: \d+/.test(ev.note) && JSON.parse(ev.data_json).rollback === false && JSON.parse(ev.data_json).heldQueued === before, ev?.note);
  let rr = await E.executeDecision({ decisionId: qd.id, source: 'USER', userId: admin.user.id, deps });
  ok('MANUAL: a queued decision cannot be executed even when the owner approves it (blocked, executor not reached)', rr.ok === false && rr.executed === false && spy.calls === 0 && /OFF|AI Operator/.test(rr.message), rr.message);
  rr = await E.executeDecision({ decisionId: qd2.id, source: 'AUTOPILOT', deps });
  ok('MANUAL: the autopilot path cannot execute either', rr.ok === false && rr.executed === false && spy.calls === 0, rr.message);
  const decCount = () => prisma.ambOperatorDecision.count({ where: { created_at: { gte: t0 }, NOT: { store_id: { startsWith: T } } } });
  const dec0 = await decCount();
  const tick = await SCH.runOperatorTick({ deps });
  ok('MANUAL: the scheduler tick evaluates nothing, prepares no rollback and creates no decision (it only records manual changes)', tick.skipped === 'MODE_OFF' && tick.monitoringOnly === true && tick.evaluated === undefined && tick.postScale === undefined && (await decCount()) === dec0, JSON.stringify(tick).slice(0, 200));
  ok('MANUAL: nothing was rolled back or executed — decisions are held, not deleted', (await prisma.ambOperatorDecision.count({ where: { id: { in: [qd.id, qd2.id] }, status: 'EXECUTED' } })) === 0);
  await S.setOperatorMode({ mode: 'SHADOW', userId: admin.user.id });
  await S.setEmergencyStop({ on: true, reason: `${T}stop`, userId: admin.user.id });
  const qd3 = await mkDecRow({ action: 'PAUSE', params_json: JSON.stringify({ window: 'today' }) });
  rr = await E.executeDecision({ decisionId: qd3.id, source: 'USER', userId: admin.user.id, deps });
  ok('Emergency Stop is checked FIRST and blocks even a USER execution', rr.executed === false && /الطوارئ/.test(rr.message) && spy.calls === 0, rr.message);
  await S.setEmergencyStop({ on: false, userId: admin.user.id });
  ok('no Meta write path was reachable: executor spy never called, zero recommendations/actions created', spy.calls === 0 && (await prisma.ambRecommendation.count()) === counts0.recs && (await prisma.ambAction.count()) === counts0.actions);
  server.close();

  // ===================================================================================================================
  console.log('\n8. Smart Advisor honours the product OWN Target CPA (bug found in the Hair Cap pilot)');
  const gs = { ambDefaultTargetCpa: 120, ambAdvisorStopCpaMultiplier: 1.5, ambMinSpendBeforeDecision: 150 };
  ok('no explicit Target => the SAME settings object comes back (no other product changes)', AP.effectiveAdvisorSettings({ settings: gs }) === gs && AP.effectiveAdvisorSettings({ settings: gs, targetCpa: null, hardStopCpa: 200 }) === gs && AP.effectiveAdvisorSettings({ settings: gs, targetCpa: 0 }) === gs);
  const eff = AP.effectiveAdvisorSettings({ settings: gs, targetCpa: 150, hardStopCpa: 200 });
  ok('explicit Target 150 replaces the global 120; the global object is not mutated', eff.ambDefaultTargetCpa === 150 && gs.ambDefaultTargetCpa === 120);
  ok('with a Hard Stop, the recovery stop line equals the Hard Stop (150 x multiplier = 200), not Target x 1.5', Math.abs(150 * eff.ambAdvisorStopCpaMultiplier - 200) < 1e-9);
  ok('without a Hard Stop the stop multiplier is left as configured; a Hard Stop below Target is ignored', AP.effectiveAdvisorSettings({ settings: gs, targetCpa: 150 }).ambAdvisorStopCpaMultiplier === 1.5 && AP.effectiveAdvisorSettings({ settings: gs, targetCpa: 150, hardStopCpa: 100 }).ambAdvisorStopCpaMultiplier === 1.5);
} catch (e) { fail++; console.log('  ✗ test crashed —', e.stack || e.message); }
finally {
  try {
    await retryDb(() => prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { mode: origCfg.mode, emergency_stop: origCfg.emergency_stop, emergency_reason: origCfg.emergency_reason, emergency_at: origCfg.emergency_at, limits_json: origCfg.limitsConfigured ? JSON.stringify({ ...origCfg.limits, productOverrides: origOverrides }) : null } }));
    await retryDb(() => SET.saveAmbSettings(Object.fromEntries(A.AUTO_ACTIONS.map((t) => [t.setting, origAuto[t.key]]))));
    const decIds = (await retryDb(() => prisma.ambOperatorDecision.findMany({ where: { OR: [{ store_id: { startsWith: T } }, { decision_key: { startsWith: T } }] }, select: { id: true } }))).map((x) => x.id);
    await retryDb(() => prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ decision_id: { in: decIds } }, { campaign_id: { startsWith: T } }, { actor_id: { in: created.users } }] } }));
    await retryDb(() => prisma.ambOperatorDecision.deleteMany({ where: { id: { in: decIds } } }));
    await retryDb(() => prisma.aiAuditLog.deleteMany({ where: { actor_id: { in: created.users } } }));
    await retryDb(() => prisma.aiAuditLog.deleteMany({ where: { kind: { startsWith: 'OPERATOR_' }, actor_id: null, created_at: { gte: t0 } } }));
    await retryDb(() => prisma.ambOperatorEvent.deleteMany({ where: { actor_id: null, created_at: { gte: t0 }, kind: { in: ['MODE_CHANGE', 'EMERGENCY_STOP', 'NOTE'] } } }));
    await retryDb(() => prisma.user.deleteMany({ where: { id: { in: created.users } } }));
    const c2 = await S.getOperatorConfig(); const a2 = A.autoActionsState(await SET.getAmbSettings());
    ok('cleanup: config, overrides and toggles restored; fixtures removed', c2.mode === origCfg.mode && c2.emergency_stop === origCfg.emergency_stop && JSON.stringify(c2.limits.productOverrides || {}) === JSON.stringify(origOverrides) && JSON.stringify(a2) === JSON.stringify(origAuto) && (await prisma.user.count({ where: { email: { startsWith: T } } })) === 0 && (await prisma.ambOperatorDecision.count({ where: { store_id: { startsWith: T } } })) === 0);
  } catch (e) { fail++; console.log('  ✗ cleanup failed —', e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
