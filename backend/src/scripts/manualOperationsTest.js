// 🧪 MANUAL MODE — a real manual operation with live preflight + an exact confirmation contract, through the real executor against a local Meta MOCK (all four operations, negatives, idempotency).
//   node src/scripts/manualOperationsTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
process.env.OPERATOR_ALLOW_META_WRITES = 'true'; process.env.DAILY_PLAN_DISABLE_ALERTS = '1';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 1200) : ''}`); } };
const world = { entities: new Map(), log: [] };
const setEntity = (id, o) => world.entities.set(id, { id, name: `mock ${id}`, status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '30000', objective: 'OUTCOME_SALES', ...o });
const writes = (id) => world.log.filter((r) => r.method === 'POST' && r.id === id); const allWrites = () => world.log.filter((r) => r.method === 'POST');
const server = http.createServer((req, res) => { const url = new URL(req.url, 'http://x'); const id = url.pathname.split('/').filter(Boolean)[1]; let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => { const body = Object.fromEntries(new URLSearchParams(raw)); delete body.access_token; world.log.push({ method: req.method, id, body }); const send = (c, j) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); }; const e = world.entities.get(id);
    if (req.method === 'GET') return e ? send(200, e) : (/^(act_|__optest_acc)/.test(id || '') ? send(200, { id, name: 'acc', currency: 'EGP', account_status: 1 }) : send(404, { error: { message: 'Unsupported get request (mock)', code: 100 } }));
    if (!e) return send(404, { error: { message: 'Unsupported post request (mock)', code: 100 } }); if (body.status) { e.status = body.status; e.effective_status = body.status; } if (body.daily_budget) e.daily_budget = String(body.daily_budget); return send(200, { success: true }); }); });
await new Promise((rs) => server.listen(0, '127.0.0.1', rs)); process.env.META_GRAPH_MOCK = '1'; process.env.META_GRAPH_MOCK_URL = `http://127.0.0.1:${server.address().port}`;
const { prisma } = await imp('../prisma.js'); const MO = await imp('../services/amb/manualOperations.js');
const T = '__optest_mo2_'; const ADMIN = { id: 1, role: 'ADMIN', status: 'ACTIVE' }; const MANAGER = { id: 9999, role: 'MANAGER', status: 'ACTIVE' };
const OFF = { open: false, pause: false, budgetIncrease: false, budgetDecrease: false };
const cfg = (perm = {}, o = {}) => ({ mode: 'OFF', emergency_stop: false, writesLocked: false, limits: { recentPurchaseProtectionHours: 3, manualOverrideCooldownHours: 24 }, execPermissions: { ...OFF, ...perm }, ...o });
const D = (c, extra = {}) => ({ user: ADMIN, config: c, conflicts: async () => [], caps: async () => ({ ok: true, violations: [] }), identity: async (id) => ({ campaignId: id, productId: 880201, productName: 'fixture', storeId: 'trendy-storeee', verified: true }), productState: async () => ({ stock: 'IN_STOCK', automatic: false }), ...extra });
const pre = (op, id, c, extra = {}, args = {}) => MO.manualPreflight({ campaignId: id, operation: op, userId: 1, deps: D(c, extra), ...args });
const exe = (op, id, p, c, extra = {}, args = {}) => MO.manualExecute({ campaignId: id, operation: op, confirm: p.confirm, userId: 1, deps: D(c, extra), ...args });
const rej = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const cleanup = async () => { const ds = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { startsWith: T } }, select: { id: true, amb_recommendation_id: true } }); const rec = ds.map((d) => d.amb_recommendation_id).filter(Boolean); await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ campaign_id: { startsWith: T } }, { decision_id: { in: ds.map((d) => d.id) } }] } }); await prisma.ambAction.deleteMany({ where: { OR: [{ entity_id: { startsWith: T } }, { recommendation_id: { in: rec } }] } }); await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { startsWith: T } } }); await prisma.ambRecommendation.deleteMany({ where: { OR: [{ id: { in: rec } }, { entity_id: { startsWith: T } }] } }); await prisma.ambAlert.deleteMany({ where: { entity_id: { startsWith: T } } }).catch(() => {}); };

try {
  await cleanup();
  console.log('\n1. Preflight is READ-ONLY and tells the truth');
  const a = `${T}a`; setEntity(a, { status: 'PAUSED', effective_status: 'PAUSED' });
  let p = await pre('OPEN', a, cfg({ open: true }));
  ok('open preflight: live PAUSED → ACTIVE, expected Meta change, exposure = the campaign budget, can execute', p.current.status === 'PAUSED' && p.proposed.status === 'ACTIVE' && p.expectedMetaChange === 'status: PAUSED → ACTIVE' && p.exposureDelta === 300 && p.canExecute === true, JSON.stringify(p).slice(0, 300));
  ok('…and it wrote NOTHING to Meta', allWrites().length === 0);
  p = await pre('OPEN', a, cfg({ open: false })); ok('permission OFF: preflight still answers, but canExecute=false with the EXACT reason (PERMISSION_OFF)', p.canExecute === false && p.executeBlockedBy.code === 'PERMISSION_OFF' && /صلاحية/.test(p.executeBlockedBy.message));
  p = await pre('OPEN', a, cfg({ open: true }, { writesLocked: true })); ok('deployment lock closed → blocked with META_WRITES_LOCKED', p.executeBlockedBy.code === 'META_WRITES_LOCKED');
  p = await pre('OPEN', a, cfg({ open: true }, { emergency_stop: true })); ok('Emergency Stop → blocked with EMERGENCY_STOP', p.executeBlockedBy.code === 'EMERGENCY_STOP');
  p = await pre('OPEN', a, cfg({ open: true }, { mode: 'SHADOW' })); ok('SHADOW → simulation only (canExecute true but nothing will be written)', p.simulation === true && /محاكاة/.test(p.note));
  p = await pre('PAUSE', a, cfg({ pause: true })); ok('pausing an already-paused campaign is a blocker (ALREADY_PAUSED)', p.blockers[0]?.code === 'ALREADY_PAUSED' && p.canExecute === false);
  setEntity(`${T}b`, {}); p = await pre('INCREASE', `${T}b`, cfg({ budgetIncrease: true }), {}, { toBudget: 250 }); ok('an "increase" that is not larger is refused (NOT_AN_INCREASE)', p.blockers[0]?.code === 'NOT_AN_INCREASE');
  p = await pre('INCREASE', `${T}b`, cfg({ budgetIncrease: true }), { caps: async () => ({ ok: false, violations: [{ label: 'الحساب', cap: 100, after: 400 }] }) }, { toBudget: 360 }); ok('budget caps are enforced on manual increases (BUDGET_CAP)', p.blockers.some((x) => x.code === 'BUDGET_CAP'));
  p = await pre('OPEN', a, cfg({ open: true }), { conflicts: async () => [{ code: 'CONFLICT_OPEN_AND_PAUSE', detail: 'خطة إيقاف معتمدة' }] }); ok('a conflicting approved plan blocks it', p.blockers[0]?.code === 'CONFLICT_OPEN_AND_PAUSE');
  ok('only an ADMIN may even preview', (await rej(() => MO.manualPreflight({ campaignId: a, operation: 'OPEN', userId: 9999, deps: { ...D(cfg({ open: true })), user: MANAGER } })))?.status === 403);
  ok('Meta unreadable → 502 META_UNAVAILABLE, never a guess', (await rej(() => pre('OPEN', a, cfg({ open: true }), { readEntity: async () => { throw new Error('boom'); } })))?.code === 'META_UNAVAILABLE');

  console.log('\n2. The confirmation contract');
  const c1 = `${T}c1`; setEntity(c1, { status: 'PAUSED', effective_status: 'PAUSED' }); const g = cfg({ open: true });
  const pc = await pre('OPEN', c1, g);
  ok('no confirmation → 400 CONFIRM_REQUIRED', (await rej(() => MO.manualExecute({ campaignId: c1, operation: 'OPEN', userId: 1, deps: D(g) })))?.code === 'CONFIRM_REQUIRED');
  ok('a forged / edited confirmation → CONFIRM_INVALID', (await rej(() => exe('OPEN', c1, { confirm: { ...pc.confirm, toBudget: 99999 } }, g)))?.code === 'CONFIRM_INVALID');
  ok('a confirmation for ANOTHER campaign → CONFIRM_MISMATCH', (await rej(() => exe('OPEN', a, pc, g)))?.code === 'CONFIRM_MISMATCH');
  ok('an expired confirmation → CONFIRM_EXPIRED', (await rej(() => exe('OPEN', c1, pc, g, {}, { now: new Date(Date.now() + 11 * 60_000) })))?.code === 'CONFIRM_EXPIRED');
  world.entities.get(c1).status = 'ACTIVE'; world.entities.get(c1).effective_status = 'ACTIVE';
  const sc = await rej(() => exe('OPEN', c1, pc, g)); ok('Meta moved since the preview (campaign already ACTIVE) → refused, nothing sent', ['STATE_CHANGED', 'ALREADY_ACTIVE'].includes(sc?.code) && writes(c1).length === 0, sc?.code);
  world.entities.get(c1).status = 'PAUSED'; world.entities.get(c1).effective_status = 'PAUSED';
  const pw = await pre('OPEN', c1, g, { productState: async () => ({ stock: 'OUT_OF_STOCK' }) }); ok('out of stock → a warning that REQUIRES acknowledgement', pw.requiresAck.includes('STOCK_OUT'));
  ok('…without the acknowledgement → ACK_REQUIRED, nothing sent', (await rej(() => exe('OPEN', c1, pw, g, { productState: async () => ({ stock: 'OUT_OF_STOCK' }) })))?.code === 'ACK_REQUIRED' && writes(c1).length === 0);

  console.log('\n3. All four operations, executed manually (MANUAL mode = stored OFF) through the real executor');
  const ops = [['OPEN', `${T}o_open`, { status: 'PAUSED', effective_status: 'PAUSED' }, { open: true }, {}, (e) => e.status === 'ACTIVE'], ['PAUSE', `${T}o_pause`, {}, { pause: true }, {}, (e) => e.status === 'PAUSED'], ['INCREASE', `${T}o_up`, {}, { budgetIncrease: true }, { toBudget: 360 }, (e) => e.daily_budget === '36000'], ['REDUCE', `${T}o_down`, {}, { budgetDecrease: true }, { toBudget: 240 }, (e) => e.daily_budget === '24000']];
  for (const [op, id, ent, perm, args, check] of ops) {
    setEntity(id, ent); const c = cfg(perm); const pr = await pre(op, id, c, {}, args);
    const other = cfg({ ...Object.fromEntries(Object.keys(OFF).map((k) => [k, !perm[k]])) }); const refused = await rej(() => exe(op, id, pr, other, {}, args));
    ok(`${op}: with ITS permission OFF (the others ON) the confirmation is refused at the gate, ZERO writes`, refused?.code === 'PERMISSION_OFF' && writes(id).length === 0, refused?.code);
    const r = await exe(op, id, pr, c, {}, args); const d = await prisma.ambOperatorDecision.findFirst({ where: { campaign_id: id }, orderBy: { id: 'desc' } }); const act = await prisma.ambAction.findFirst({ where: { entity_id: id }, orderBy: { id: 'desc' } });
    ok(`${op}: ONE write, Meta (mock) really changed, independent read-back VERIFIED`, r.ok && r.verified && writes(id).length === 1 && check(world.entities.get(id)) && d.status === 'VERIFIED', JSON.stringify(r).slice(0, 1000));
    ok(`${op}: history row — executed by the ADMIN, approval APPROVED (human), mode OFF(MANUAL), reason names the manual operation`, act?.executed_by_id === 1 && act.approval_status === 'APPROVED' && /يدوي|APPROVED|MANUAL/i.test(act.ai_reason || '') && d.approved_by_id === 1);
    const dup = await exe(op, id, pr, c, {}, args); ok(`${op}: submitting the same confirmation again is idempotent (no second write)`, dup.duplicate === true && writes(id).length === 1);
  }

  console.log('\n4. SHADOW records a simulation and sends nothing');
  { const s = `${T}s1`; setEntity(s); const c = cfg({ pause: true }, { mode: 'SHADOW' }); const pr = await pre('PAUSE', s, c); const w0 = allWrites().length; const r = await exe('PAUSE', s, pr, c);
    ok('SHADOW: a SHADOW decision row, simulated:true, ZERO new requests', r.simulated === true && allWrites().length === w0 && (await prisma.ambOperatorDecision.findFirst({ where: { campaign_id: s } })).status === 'SHADOW'); }
} finally { try { await cleanup(); } catch (e) { console.log('cleanup failed', e.message); } server.close(); }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
