// 🧪 «صلاحيات التنفيذ»: four independent OFF-by-default switches, ADMIN + explicit confirm + audit, gates wired into the daily plan and the budget bridge, and NO way around the Meta write-lock.
// No Meta call anywhere. The real operator config row is restored at the end.
//   node src/scripts/executionPermissionsTest.js
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
const { prisma } = await imp('../prisma.js');
const EP = await imp('../services/amb/executionPermissions.js'); const S = await imp('../services/amb/operatorStore.js'); const DP = await imp('../services/amb/dailyPlans.js'); const BX = await imp('../services/amb/budgetExecution.js'); const PR = await imp('../services/amb/productionReadiness.js');
const { getAmbSettings } = await imp('../services/amb/settings.js');
const { default: operatorRoutes } = await imp('../routes/operator.js'); const { errorHandler } = await imp('../middleware/errorHandler.js');
const T = '__optest_'; const users = [];
const raw0 = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } });
const sanitizeLimits = (lj) => { const o = JSON.parse(lj || '{}'); if (o.dailyPlan) { o.dailyPlan.halted = false; } return lj == null ? lj : JSON.stringify(o); }; // another suite may have a transient halted=true when this one snapshots the real config — never restore that

const before = { mode: raw0.mode, emergency: raw0.emergency_stop, settings: await getAmbSettings() };
const ALL_OFF = { open: false, pause: false, budgetIncrease: false, budgetDecrease: false };
const ADMIN = { id: 0, role: 'ADMIN', status: 'ACTIVE' };
const mkUser = async (role, tag) => { const u = await prisma.user.create({ data: { email: `${T}ep_${tag}_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}ep ${tag}`, role, status: 'ACTIVE', permissions: '{}' } }); users.push(u.id); return u; };
const reset = () => prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: sanitizeLimits(raw0.limits_json) } });
try {
  const admin = await mkUser('ADMIN', 'admin'), mgr = await mkUser('MANAGER', 'mgr');
  await reset();

  console.log('\n1. Defaults — every permission is OFF');
  let st = await EP.getExecutionPermissions({});
  ok('four keys, all OFF on a system where nobody switched anything', JSON.stringify(st.permissions) === JSON.stringify(ALL_OFF) && EP.PERMISSION_KEYS.length === 4, JSON.stringify(st.permissions));
  ok('the lock state is reported (write-lock, mode, emergency)', typeof st.lock.writesLocked === 'boolean' && typeof st.lock.mode === 'string');
  ok('real config exposes the same strict flags', JSON.stringify((await S.getOperatorConfig()).execPermissions) === JSON.stringify(ALL_OFF));
  ok('a non-boolean junk value in storage never counts as ON', await (async () => { const lim = JSON.parse(raw0.limits_json || '{}'); await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...lim, execPermissions: { open: 'true', pause: 1, budgetIncrease: 'yes', budgetDecrease: {} } }) } }); const r = JSON.stringify((await S.getOperatorConfig()).execPermissions) === JSON.stringify(ALL_OFF); await reset(); return r; })());

  console.log('\n2. Changing one — ADMIN + explicit confirmation + audit');
  let e1 = null; try { await EP.setExecutionPermission({ key: 'open', on: true, confirm: true, userId: mgr.id }); } catch (e) { e1 = e; } ok('MANAGER cannot change a permission (403)', e1?.status === 403);
  let e2 = null; try { await EP.setExecutionPermission({ key: 'open', on: true, userId: admin.id }); } catch (e) { e2 = e; } ok('without the explicit confirmation → refused (CONFIRM_REQUIRED)', e2?.code === 'CONFIRM_REQUIRED' && (await EP.getExecutionPermissions({})).permissions.open === false);
  let e3 = null; try { await EP.setExecutionPermission({ key: 'autopilot', on: true, confirm: true, userId: admin.id }); } catch (e) { e3 = e; } ok('unknown key refused (400) — Autopilot is not a switch here', e3?.status === 400);
  let e4 = null; try { await EP.setExecutionPermission({ key: 'open', on: 'yes', confirm: true, userId: admin.id }); } catch (e) { e4 = e; } ok('non-boolean value refused', e4?.status === 400);
  const r1 = await EP.setExecutionPermission({ key: 'open', on: true, confirm: true, userId: admin.id });
  ok('ADMIN + confirm turns ONLY «open» ON', r1.changed && JSON.stringify(r1.permissions) === JSON.stringify({ ...ALL_OFF, open: true }));
  const cfgNow = await S.getOperatorConfig();
  ok('the config reflects it; pause / increase / decrease stay OFF', cfgNow.execPermissions.open === true && !cfgNow.execPermissions.pause && !cfgNow.execPermissions.budgetIncrease && !cfgNow.execPermissions.budgetDecrease);
  ok('audited twice: AiAuditLog + operator event with from→to', (await prisma.aiAuditLog.count({ where: { kind: 'OPERATOR_EXEC_PERMISSION', actor_id: admin.id } })) === 1 && (await prisma.ambOperatorEvent.count({ where: { kind: 'PERMISSION_CHANGE', actor_id: admin.id } })) === 1);
  ok('same value again is a no-op (no extra audit)', (await EP.setExecutionPermission({ key: 'open', on: true, confirm: true, userId: admin.id })).changed === false && (await prisma.aiAuditLog.count({ where: { kind: 'OPERATOR_EXEC_PERMISSION', actor_id: admin.id } })) === 1);
  await EP.setExecutionPermission({ key: 'budgetDecrease', on: true, confirm: true, userId: admin.id });
  st = await EP.getExecutionPermissions({}); ok('switches are independent: open + budgetDecrease ON, the rest OFF, history lists both', st.permissions.open && st.permissions.budgetDecrease && !st.permissions.pause && !st.permissions.budgetIncrease && st.history.filter((h) => h.actorId === admin.id).length === 2 && st.last.open?.on === true);

  console.log('\n3. NO way around the Meta lock / mode / toggles');
  const after = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } });
  const nowSettings = await getAmbSettings();
  ok('mode and Emergency Stop untouched', after.mode === before.mode && after.emergency_stop === before.emergency);
  ok('the five Auto toggles untouched', ['ambAllowAutoOpen', 'ambAllowAutoPause', 'ambAllowAutoScale', 'ambAllowAutoBudgetIncrease', 'ambAllowAutoBudgetDecrease'].every((k) => nowSettings[k] === before.settings[k]));
  ok('the deployment write-lock is still evaluated from the environment only', (await S.getOperatorConfig()).writesLocked === (process.env.OPERATOR_ALLOW_META_WRITES !== 'true'));
  const src = fs.readFileSync(join(__dirname, '../services/amb/executionPermissions.js'), 'utf8');
  ok('the module never assigns OPERATOR_ALLOW_META_WRITES, never sets the mode, never calls Meta', !/process\.env\.OPERATOR_ALLOW_META_WRITES\s*=/.test(src) && !/setOperatorMode|metaGraphClient|approveAndExecute|setEntity|graphPost/.test(src));
  const dcfg = await DP.getDailyPlanConfig(); ok('the legacy daily-plan flags are READ-ONLY mirrors of the switches', dcfg.allowOpen === true && dcfg.allowPause === false);
  await DP.setDailyPlanConfig({ patch: { allowPause: true, allowOpen: false, halted: false }, userId: admin.id });
  const dcfg2 = await DP.getDailyPlanConfig(); ok('trying to grant a permission through the old daily-plan config is ignored', dcfg2.allowPause === false && dcfg2.allowOpen === true);
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...JSON.parse((await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } })).limits_json), dailyPlan: undefined }) } });

  console.log('\n4. Gates: daily plan + budget bridge honour the switches');
  const cfgG = (o = {}, perms = ALL_OFF) => ({ mode: 'APPROVAL', emergency_stop: false, writesLocked: false, execPermissions: perms, ...o });
  const dc = { allowOpen: true, allowPause: true, halted: false };
  ok('OPEN plan with all gates open but «open» OFF → TYPE_NOT_ALLOWED', DP.executionGate({ config: cfgG(), dcfg: dc, type: 'OPEN', simulatedPlan: false }).blocked?.code === 'TYPE_NOT_ALLOWED');
  ok('«open» ON → OPEN plan can go LIVE', DP.executionGate({ config: cfgG({}, { ...ALL_OFF, open: true }), dcfg: dc, type: 'OPEN', simulatedPlan: false }).mode === 'LIVE');
  ok('«open» ON does NOT permit a PAUSE plan', DP.executionGate({ config: cfgG({}, { ...ALL_OFF, open: true }), dcfg: dc, type: 'PAUSE', simulatedPlan: false }).blocked?.code === 'TYPE_NOT_ALLOWED');
  ok('«pause» ON permits PAUSE but not OPEN', DP.executionGate({ config: cfgG({}, { ...ALL_OFF, pause: true }), dcfg: dc, type: 'PAUSE', simulatedPlan: false }).mode === 'LIVE' && DP.executionGate({ config: cfgG({}, { ...ALL_OFF, pause: true }), dcfg: dc, type: 'OPEN', simulatedPlan: false }).blocked?.code === 'TYPE_NOT_ALLOWED');
  ok('the Meta write-lock still wins over an ON permission', DP.executionGate({ config: cfgG({ writesLocked: true }, { ...ALL_OFF, open: true }), dcfg: dc, type: 'OPEN', simulatedPlan: false }).blocked?.code === 'META_WRITES_LOCKED');
  ok('SHADOW still means simulation even with the permission ON', DP.executionGate({ config: cfgG({ mode: 'SHADOW' }, { ...ALL_OFF, open: true }), dcfg: dc, type: 'OPEN', simulatedPlan: false }).mode === 'SIMULATION');
  ok('budget bridge: SCALE_DOWN needs «budgetDecrease»', BX.configBlock(cfgG(), 'SCALE_DOWN')?.code === 'PERMISSION_OFF' && BX.configBlock(cfgG({}, { ...ALL_OFF, budgetDecrease: true }), 'SCALE_DOWN') === null);
  ok('budget bridge: SCALE_UP needs «budgetIncrease» (decrease does not grant it)', BX.configBlock(cfgG({}, { ...ALL_OFF, budgetDecrease: true }), 'SCALE_UP')?.code === 'PERMISSION_OFF' && BX.configBlock(cfgG({}, { ...ALL_OFF, budgetIncrease: true }), 'SCALE_UP') === null);
  ok('budget bridge: lock / mode errors still come first', BX.configBlock(cfgG({ writesLocked: true }, { ...ALL_OFF, budgetDecrease: true }), 'SCALE_DOWN')?.code === 'META_WRITES_LOCKED' && BX.configBlock(cfgG({ mode: 'SHADOW' }, { ...ALL_OFF, budgetDecrease: true }), 'SCALE_DOWN')?.code === 'MODE_NOT_APPROVAL');
  const rep = await PR.buildProductionReadiness({ deps: { config: cfgG({ mode: 'SHADOW', writesLocked: true }), settings: {}, dcfg: { ...DP.DEFAULT_DAILY_CONFIG }, policy: { enabled: false }, executed: [], todayPlans: [], schedulerStarted: false, approvedDecision: 0, advisorPlans: 0, inventoryProducts: 0 } });
  ok('the readiness dashboard lists each closed switch as a gate', rep.functions.find((f) => f.key === 'CAMPAIGN_OPEN').gates.some((g) => /فتح الحملات/.test(g)) && rep.functions.find((f) => f.key === 'BUDGET_REDUCE').gates.some((g) => /تقليل الميزانية/.test(g)) && rep.functions.find((f) => f.key === 'BUDGET_INCREASE').gates.some((g) => /زيادة الميزانية/.test(g)));

  console.log('\n5. HTTP surface');
  const tok = (u, role) => jwt.sign({ id: u.id, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api/operator', operatorRoutes); app.use(errorHandler);
  const server = await new Promise((rs) => { const s = app.listen(0, '127.0.0.1', () => rs(s)); }); const base = `http://127.0.0.1:${server.address().port}/api/operator`;
  const call = async (method, path, body, u, role) => { const x = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(u ? { Cookie: `token=${tok(u, role)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); let json = null; try { json = await x.json(); } catch { /* */ } return { status: x.status, json }; };
  try {
    ok('unauthenticated → 401', (await call('GET', '/execution-permissions')).status === 401);
    const g = await call('GET', '/execution-permissions', undefined, mgr, 'MANAGER'); ok('MANAGER can read', g.status === 200 && g.json.permissions && g.json.lock);
    ok('MANAGER cannot change (403)', (await call('PUT', '/execution-permissions/pause', { on: true, confirm: true }, mgr, 'MANAGER')).status === 403);
    ok('ADMIN without confirm → 400', (await call('PUT', '/execution-permissions/pause', { on: true }, admin, 'ADMIN')).status === 400);
    ok('ADMIN unknown key → 400', (await call('PUT', '/execution-permissions/autopilot', { on: true, confirm: true }, admin, 'ADMIN')).status === 400);
    const ok1 = await call('PUT', '/execution-permissions/pause', { on: true, confirm: true }, admin, 'ADMIN'); ok('ADMIN + confirm → 200 and only «pause» changes', ok1.status === 200 && ok1.json.permissions.pause === true);
    ok('ADMIN switches it back OFF', (await call('PUT', '/execution-permissions/pause', { on: false, confirm: true }, admin, 'ADMIN')).json.permissions.pause === false);
  } finally { server.close(); }
  const routeSrc = fs.readFileSync(join(__dirname, '../routes/operator.js'), 'utf8');
  ok('the mutating route is ADMIN-guarded in source', /router\.put\('\/execution-permissions\/:key', ADMIN,/.test(routeSrc));
} catch (e) {
  fail++; console.log('  ✗ UNEXPECTED', e.stack || e.message);
} finally {
  await reset().catch(() => {});
  await prisma.aiAuditLog.deleteMany({ where: { kind: 'OPERATOR_EXEC_PERMISSION', actor_id: { in: users } } }).catch(() => {});
  await prisma.ambOperatorEvent.deleteMany({ where: { kind: 'PERMISSION_CHANGE', actor_id: { in: users } } }).catch(() => {});
  await prisma.aiAuditLog.deleteMany({ where: { kind: 'DAILY_PLAN_CONFIG', actor_id: { in: users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  const restored = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } });
  console.log(`\nSAFETY: operator config restored exactly: ${restored.limits_json === sanitizeLimits(raw0.limits_json) && restored.mode === raw0.mode} | Meta calls in this test = 0`);
  console.log(`\n${fail === 0 ? '✅' : '❌'} executionPermissionsTest: ${pass} passed, ${fail} failed`);
  await prisma.$disconnect(); process.exit(fail ? 1 : 0);
}
