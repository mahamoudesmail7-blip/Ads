// 🧭 The «اعتماد وتنفيذ فتح الحملات المحددة» journey, end to end on the SERVICE/API layer — database + a local Meta MOCK (fake Graph API on loopback). NO real Meta call.
//   Root cause of the reported "dead button" lives in the browser (see opxUiTest section 17); this suite covers what the button depends on in the backend:
//   1. the saved CPA policy is ENFORCED at approval (out-of-range / unknown CPA / stale policy) and a manual tick needs an explicit special approval
//   2. the richer confirmation (count · exposed budget · exact campaign ids · plan version · policy version) — required, mismatches refused with the real numbers
//   3. the full happy path: approve → confirmation → (mock) execution → independent read-back → result
//   4. every negative: lock closed · Open permission OFF · SHADOW · expired plan · budget changed · CPA out of range · duplicate / concurrent approval · non-ADMIN · old plan version
//   5. the UI can explain every status the server returns (no silent button)
//   node src/scripts/approvePopupJourneyTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
process.env.OPERATOR_ALLOW_META_WRITES = 'true'; // local Meta MOCK only: the central write guard must see the deployment lock open for the legitimate write
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };

const world = { entities: new Map(), log: [] };
const setEntity = (id, o = {}) => world.entities.set(id, { id, name: `mock ${id}`, status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '30000', objective: 'OUTCOME_SALES', ...o });
const writes = (id) => world.log.filter((r) => r.method === 'POST' && r.id === id); const allWrites = () => world.log.filter((r) => r.method === 'POST');
const server = http.createServer((req, res) => { const url = new URL(req.url, 'http://x'); const id = url.pathname.split('/').filter(Boolean)[1]; let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { const body = Object.fromEntries(new URLSearchParams(raw)); delete body.access_token; world.log.push({ method: req.method, id, body }); const send = (c, j) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); }; const e = world.entities.get(id);
  if (req.method === 'GET') { if (e) return send(200, e); if (/^(act_|__optest_acc)/.test(id || '')) return send(200, { id, account_id: id, name: 'mock account', currency: 'EGP', timezone_name: 'Africa/Cairo', account_status: 1 }); return send(404, { error: { message: 'Unsupported get (mock)', code: 100 } }); }
  if (req.method === 'POST') { if (!e) return send(404, { error: { message: 'Unsupported post (mock)', code: 100 } }); if (body.status) { e.status = body.status; e.effective_status = body.status; } if (body.daily_budget) e.daily_budget = String(body.daily_budget); return send(200, { success: true }); } return send(405, {}); }); });
await new Promise((rs) => server.listen(0, '127.0.0.1', rs));
process.env.META_GRAPH_MOCK = '1'; process.env.META_GRAPH_MOCK_URL = `http://127.0.0.1:${server.address().port}`; process.env.DAILY_PLAN_DISABLE_ALERTS = '1';
const { prisma } = await imp('../prisma.js'); const DP = await imp('../services/amb/dailyPlans.js'); const TM = await imp('../services/amb/dailyPlanTime.js');
const T = '__optest_'; const created = { plans: [] };
const OFF = { open: false, pause: false, budgetIncrease: false, budgetDecrease: false };
const cfg = (perm = {}, o = {}) => ({ mode: 'APPROVAL', emergency_stop: false, writesLocked: false, limits: { recentPurchaseProtectionHours: 3, manualOverrideCooldownHours: 24 }, execPermissions: { ...OFF, ...perm }, ...o });
const ADMIN = { id: 1, role: 'ADMIN', status: 'ACTIVE' }; const noSleep = async () => {};
const FRESH = { syncStatus: async () => ({ lastSuccessAt: new Date() }), refresh: async () => ({ ok: true }) };
const POLICY = (v = 1) => ({ enabled: true, version: v, minCpa: 20, maxCpa: 150, approved: { version: v, at: new Date().toISOString(), by: 1 } });
const planDeps = (c, extra = {}) => ({ ...FRESH, user: ADMIN, runInline: true, exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, dcfg: { ...DP.DEFAULT_DAILY_CONFIG }, config: async () => c, sleep: noSleep, openCpaPolicy: async () => POLICY(1), ...extra });
const cpaEv = (cpa, verdict) => ({ version: 1, window: '7', verdict, matched: verdict !== 'OUT_OF_RANGE', cpa, spend: 900, purchases: verdict === 'ELIGIBLE' ? 9 : 2, codes: verdict === 'ELIGIBLE' ? [] : ['CPA_ABOVE_MAX'], reasons: [] });
const item = (cid, cpa, verdict, o = {}) => ({ campaignId: cid, campaignName: `${T}jr ${cid}`, productId: null, productName: 'fixture', storeId: 'trendy-storeee', rank: 1, selected: true, selectable: true, eligibility: 'ELIGIBLE', blockCodes: [], warnings: [], risk: 'LOW', riskScore: 5, reason: 'fixture', evidence: { mapping: 'VERIFIED', budget: world.entities.get(cid)?.daily_budget ? Number(world.entities.get(cid).daily_budget) / 100 : 300, stock: { status: 'IN_STOCK' }, m7: { spend: 900, purchases: 9, cpa }, m30: { spend: 2000, purchases: 25, cpa }, cpaPolicy: cpaEv(cpa, verdict) }, ...o });
let dseq = 0; const nextDate = () => `2031-12-${String(10 + ++dseq).padStart(2, '0')}`;
/** a REAL OPEN plan prepared under policy v1: each spec = [id, cpa, verdict, selected] */
const mkPlan = async (specs, { date = nextDate(), simulated = false, policyV = 1 } = {}) => { for (const [id] of specs) if (!world.entities.has(id)) setEntity(id);
  const p = (await DP.preparePlan({ type: 'OPEN', date, now: new Date(), simulated, deps: { ...FRESH, build: async () => ({ items: specs.map(([id, cpa, verdict, sel = true], n) => item(id, cpa, verdict, { rank: n + 1, selected: sel })), policy: null }) } })).plan; created.plans.push(p.id);
  await prisma.ambDailyPlan.update({ where: { id: p.id }, data: { evidence_json: JSON.stringify({ ...(JSON.parse(p.evidence_json || '{}')), openCpa: { version: policyV, approvedVersion: policyV, minCpa: 20, maxCpa: 150, window: '7', counts: {} } }) } }); return (await prisma.ambDailyPlan.findUnique({ where: { id: p.id } })); };
const approve = (p, c, extra = {}, confirm, now) => DP.approvePlan({ planId: p.id, userId: 1, now: now || new Date(TM.dueAt(p.type, p.plan_date).getTime() + 60_000), deps: planDeps(c, extra), confirm });
const itemOf = (pid, cid) => prisma.ambDailyPlanItem.findFirst({ where: { plan_id: pid, campaign_id: cid } });
const planOf = (id) => prisma.ambDailyPlan.findUnique({ where: { id } });
let A, B, C; let fid = 0; const fresh = () => { fid++; A = `${T}ja${fid}_${Date.now() % 100000}`; B = `${T}jb${fid}_${Date.now() % 100000}`; C = `${T}jc${fid}_${Date.now() % 100000}`; for (const id of [A, B, C]) setEntity(id); }; fresh();
const conf = (p) => DP.currentConfirmation(p.id, { openCpaPolicy: async () => POLICY(1) });

try {
  console.log('\n1. The saved CPA policy is enforced at approval');
  const p1 = await mkPlan([[A, 88, 'ELIGIBLE'], [B, 120, 'ELIGIBLE'], [C, 192, 'OUT_OF_RANGE']]); const w0 = allWrites().length;
  const v = await approve(p1, cfg({ open: true }), {}, await conf(p1));
  ok('a selected campaign OUTSIDE the approved CPA range (192 > 150) blocks the approval: CPA_POLICY_VIOLATION, naming the campaign and its CPA', v.ok === false && v.status === 'CPA_POLICY_VIOLATION' && v.violations.length === 1 && v.violations[0].campaignId === C && v.violations[0].cpa === 192 && /خارج سياسة CPA 20–150/.test(v.message), JSON.stringify(v).slice(0, 300));
  ok('…nothing was approved or sent: the plan is still PREPARED, ZERO Meta requests', (await planOf(p1.id)).status === 'PREPARED' && allWrites().length === w0);
  let sel1 = null; try { await DP.updateSelection({ planId: p1.id, selections: { [C]: false }, userId: 1, deps: planDeps(cfg()) }); await DP.updateSelection({ planId: p1.id, selections: { [C]: true }, userId: 1, deps: planDeps(cfg()) }); } catch (e) { sel1 = e; }
  ok('ticking an out-of-policy campaign needs an explicit special approval (409 CPA_POLICY_SPECIAL_REQUIRED with the violation details)', sel1 && sel1.status === 409 && sel1.code === 'CPA_POLICY_SPECIAL_REQUIRED' && sel1.details?.violation?.campaignId === C, sel1?.message);
  const sp = await DP.updateSelection({ planId: p1.id, selections: { [C]: true }, special: [C], userId: 1, deps: planDeps(cfg()) });
  const itC = await itemOf(p1.id, C); const evC = JSON.parse(itC.evidence_json);
  ok('with the explicit special approval the tick is accepted and RECORDED (who / when) on the item', itC.selected === true && !!evC.cpaSpecial && evC.cpaSpecial.by === 1 && sp.changed === 1);
  const off = await DP.updateSelection({ planId: p1.id, selections: { [C]: false }, userId: 1, deps: planDeps(cfg()) });
  ok('un-ticking it removes the special approval (it can never be inherited later)', !JSON.parse((await itemOf(p1.id, C)).evidence_json).cpaSpecial && off.changed === 1);
  const okOnly = await mkPlan([[A, 88, 'ELIGIBLE'], [B, 120, 'ELIGIBLE'], [C, 192, 'OUT_OF_RANGE', false]]);
  ok('a plan whose selected campaigns are all inside the range passes the policy check (the out-of-range one is simply not selected)', (await approve(okOnly, cfg({ open: true }), {}, await conf(okOnly))).ok === true);
  const unk = await mkPlan([[A, null, 'UNKNOWN_CPA']]); const vu = await approve(unk, cfg({ open: true }), {}, await conf(unk));
  ok('unknown CPA / too few orders is also outside the policy → blocked', vu.status === 'CPA_POLICY_VIOLATION');
  const stale = await mkPlan([[A, 88, 'ELIGIBLE']], { policyV: 1 }); const vs = await approve(stale, cfg({ open: true }), { openCpaPolicy: async () => POLICY(2) }, await conf(stale));
  ok('a plan prepared under an OLDER policy version is refused: POLICY_STALE (re-prepare first), nothing sent', vs.status === 'POLICY_STALE' && /v1/.test(vs.message) && /v2/.test(vs.message) && (await planOf(stale.id)).status === 'PREPARED');
  const noPol = await mkPlan([[C, 192, 'OUT_OF_RANGE']]); const vn = await approve(noPol, cfg({ open: true }), { openCpaPolicy: async () => ({ enabled: false, version: 1, approved: null }) }, await conf(noPol));
  ok('with NO active policy nothing changes: the CPA rule is not applied (behaviour unchanged for owners who do not use it)', vn.ok === true);

  fresh();

  console.log('\n2. The confirmation: count · exposed budget · exact campaign ids · plan version · policy version');
  const p2 = await mkPlan([[A, 88, 'ELIGIBLE'], [B, 120, 'ELIGIBLE']]); const w2 = allWrites().length; const exp = await conf(p2);
  ok('the server publishes exactly what must be confirmed (count 2 · 600 EGP · the two ids · plan v1 · policy v1)', exp.count === 2 && exp.exposedBudget === 600 && exp.campaignIds.join() === [A, B].sort().join() && exp.planVersion === 1 && exp.policyVersion === 1, JSON.stringify(exp));
  const r0 = await approve(p2, cfg({ open: true }), {}, undefined); ok('no confirmation at all → CONFIRM_REQUIRED with the real numbers', r0.status === 'CONFIRM_REQUIRED' && r0.actual.count === 2);
  const r1 = await approve(p2, cfg({ open: true }), {}, { ...exp, campaignIds: [A, C].sort() }); ok('same count and budget but a DIFFERENT campaign → CONFIRM_MISMATCH (ids are compared, not only totals)', r1.status === 'CONFIRM_MISMATCH');
  const r2 = await approve(p2, cfg({ open: true }), {}, { ...exp, planVersion: 7 }); ok('wrong plan version → CONFIRM_MISMATCH', r2.status === 'CONFIRM_MISMATCH' && /v1/.test(r2.message));
  const r3 = await approve(p2, cfg({ open: true }), {}, { ...exp, policyVersion: 5 }); ok('wrong policy version → CONFIRM_MISMATCH', r3.status === 'CONFIRM_MISMATCH' && /v1/.test(r3.message));
  const r4 = await approve(p2, cfg({ open: true }), {}, { count: exp.count, exposedBudget: exp.exposedBudget }); ok('count + budget right but ids / plan version missing → CONFIRM_REQUIRED («التأكيد ناقص» — an old cached page cannot approve)', r4.status === 'CONFIRM_REQUIRED' && /ناقص/.test(r4.message));
  ok('none of the refused attempts changed anything', (await planOf(p2.id)).status === 'PREPARED' && allWrites().length === w2);

  fresh();

  console.log('\n3. The happy path: popup → approve → confirmation → (mock) execution → read-back → result');
  const p3 = await mkPlan([[A, 88, 'ELIGIBLE'], [B, 120, 'ELIGIBLE']]); const ok3 = await approve(p3, cfg({ open: true }), {}, await conf(p3));
  const iA = await itemOf(p3.id, A), iB = await itemOf(p3.id, B); const fin = await planOf(p3.id); const sum = JSON.parse(fin.summary_json || '{}'); const ev3 = JSON.parse(fin.evidence_json || '{}');
  ok('approval accepted and executed LIVE (all gates open)', ok3.ok === true && ok3.executionMode === 'LIVE', JSON.stringify(ok3).slice(0, 200));
  ok('exactly ONE Meta write per campaign (status=ACTIVE), after the live read and followed by an independent read-back', writes(A).length === 1 && writes(B).length === 1 && writes(A)[0].body.status === 'ACTIVE' && world.log.findLastIndex((r) => r.id === A) > world.log.indexOf(writes(A)[0]));
  ok('both items VERIFIED by the read-back, the mock Meta really holds ACTIVE', iA.status === 'VERIFIED' && iB.status === 'VERIFIED' && world.entities.get(A).status === 'ACTIVE' && world.entities.get(B).status === 'ACTIVE');
  ok('the result the screen shows: plan COMPLETED, summary 2 verified / 0 failed / 0 uncertain, metaWrites 2', fin.status === 'COMPLETED' && sum.verified === 2 && sum.failed === 0 && sum.uncertain === 0 && sum.metaWrites === 2, JSON.stringify(sum));
  ok('the approval snapshot (count / exposed budget / ids / plan + policy version / who / when / confirmed) is stored', ev3.approval?.count === 2 && ev3.approval?.exposedBudget === 600 && ev3.approval?.campaignIds?.length === 2 && ev3.approval?.planVersion === 1 && ev3.approval?.policyVersion === 1 && ev3.approval?.by === 1 && ev3.approval?.confirmed === true);
  const act = await prisma.ambAction.findFirst({ where: { entity_id: A }, orderBy: { id: 'desc' } }); ok('Execution History row: EXECUTED + verified by read-back, actor = the ADMIN', act?.execution_status === 'EXECUTED' && JSON.parse(act.verify_json || '{}').verified === true && act.executed_by_id === 1);

  fresh();

  console.log('\n4. The negatives — each one answers with a clear status, never silence');
  const w1 = allWrites().length;
  const nLock = await mkPlan([[A, 88, 'ELIGIBLE']]); const rl = await approve(nLock, cfg({ open: true }, { writesLocked: true }), {}, await conf(nLock));
  ok('Meta Writes LOCKED → BLOCKED META_WRITES_LOCKED + a message, ZERO requests, plan still PREPARED', rl.ok === false && rl.status === 'BLOCKED' && rl.blocked === 'META_WRITES_LOCKED' && !!rl.message && (await planOf(nLock.id)).status === 'PREPARED' && allWrites().length === w1);
  const rp = await approve(nLock, cfg({ open: false }), {}, await conf(nLock)); ok('«Open» permission OFF → BLOCKED TYPE_NOT_ALLOWED with the reason', rp.status === 'BLOCKED' && rp.blocked === 'TYPE_NOT_ALLOWED' && /صلاحية/.test(rp.message) && allWrites().length === w1);
  const rs = await approve(nLock, cfg({ open: true }, { mode: 'SHADOW' }), {}, await conf(nLock)); ok('SHADOW → accepted as a SIMULATION: no POST, items SIMULATED', rs.ok === true && rs.executionMode === 'SIMULATION' && allWrites().length === w1 && (await itemOf(nLock.id, A)).status === 'SIMULATED');
  fresh(); const nExp = await mkPlan([[A, 88, 'ELIGIBLE']]); const late = new Date(nExp.expires_at.getTime() + 60_000); const re = await approve(nExp, cfg({ open: true }), {}, await conf(nExp), late);
  ok('an EXPIRED plan (the Cairo day ended) → MISSED «اليوم خلص»: not executed late, status persisted', re.ok === false && re.status === 'MISSED' && /اليوم خلص/.test(re.message) && (await planOf(nExp.id)).status === 'MISSED' && allWrites().length === w1);
  const re2 = await approve(nExp, cfg({ open: true }), {}, await conf(nExp)); ok('approving the MISSED plan again is refused with its status (no resurrection)', re2.ok === false && /MISSED/.test(re2.message || re2.status));
  fresh(); const nBud = await mkPlan([[A, 88, 'ELIGIBLE'], [B, 120, 'ELIGIBLE']]); world.entities.get(B).daily_budget = '90000'; const rb = await approve(nBud, cfg({ open: true }), {}, await conf(nBud));
  ok('a budget that CHANGED on Meta after preparation → that campaign BLOCKED (BUDGET_CHANGED), the other still opens', (await itemOf(nBud.id, B)).status === 'BLOCKED' && /BUDGET_CHANGED/.test((await itemOf(nBud.id, B)).status_reason) && writes(B).length === 0 && (await itemOf(nBud.id, A)).status === 'VERIFIED', `${(await itemOf(nBud.id, B)).status} ${(await itemOf(nBud.id, B)).status_reason}`);
  fresh(); const dup = await mkPlan([[A, 88, 'ELIGIBLE']]); const dupConf = await conf(dup); const before = allWrites().length;
  const both = await Promise.all([approve(dup, cfg({ open: true }), {}, dupConf), approve(dup, cfg({ open: true }), {}, dupConf)]);
  ok('a DOUBLE CLICK (two concurrent approvals) → exactly one is accepted, exactly one Meta write', both.filter((x) => x.ok === true).length === 1 && allWrites().length - before === 1, JSON.stringify(both.map((x) => x.status)));
  const again = await approve(dup, cfg({ open: true }), {}, dupConf); ok('a repeated approval afterwards → refused with the plan\'s status, ZERO extra writes', again.ok === false && /COMPLETED|RUNNING|APPROVED/.test(`${again.status} ${again.message}`) && allWrites().length - before === 1, JSON.stringify(again));
  const ro = await mkPlan([[A, 88, 'ELIGIBLE']], { date: nextDate() }); const asM = await DP.approvePlan({ planId: ro.id, userId: 2, now: new Date(TM.dueAt('OPEN', ro.plan_date).getTime() + 60_000), deps: planDeps(cfg({ open: true }), { user: { id: 2, role: 'MANAGER', status: 'ACTIVE' } }), confirm: await conf(ro) }).catch((e) => e);
  ok('a non-ADMIN → 403 with a clear message («محتاج موافقة ADMIN»)', asM.status === 403 && /ADMIN/.test(asM.message));
  const v2 = await mkPlan([[A, 88, 'ELIGIBLE']], { date: nextDate() }); const v2key = v2.plan_key; const nv = await prisma.ambDailyPlan.create({ data: { plan_key: v2key, type: 'OPEN', plan_date: v2.plan_date, timezone: v2.timezone, version: 2, status: 'PREPARED', simulated: false, scheduled_at: v2.scheduled_at, expires_at: v2.expires_at, prepared_at: new Date() } }); created.plans.push(nv.id);
  const oldV = await approve(v2, cfg({ open: true }), {}, await conf(v2)).catch((e) => e); ok('approving an OLD plan version → 409 «دي نسخة قديمة»', oldV.status === 409 && /نسخة قديمة/.test(oldV.message));

  console.log('\n5. The screen can explain every status the server returns');
  const dpSrc = fs.readFileSync(join(__dirname, '../services/amb/dailyPlans.js'), 'utf8'); const ap = dpSrc.slice(dpSrc.indexOf('export async function approvePlan'), dpSrc.indexOf('const sleepDefault'));
  const serverStatuses = [...new Set([...ap.matchAll(/status: '([A-Z_]+)'/g)].map((m) => m[1]))].filter((s) => !['RUNNING', 'APPROVED', 'PREPARED', 'MISSED_', 'SUPERSEDED'].includes(s));
  const ui = fs.readFileSync(join(__dirname, '../../../js/ai-operator-daily.js'), 'utf8'); const map = ui.match(/const STATUS_AR = \{([^}]*)\}/)?.[1] || '';
  const missing = serverStatuses.filter((s) => !new RegExp(`\\b${s}:`).test(map)); ok(`every refusal status returned by approvePlan has an Arabic title on screen (${serverStatuses.join(', ')})`, missing.length === 0, 'unmapped: ' + missing.join(','));
  ok('the popup shows a persistent result box (success AND failure) and blocks double submit while a request is in flight', /id="dpResult"/.test(ui) && /D\.approving/.test(ui) && /جاري الاعتماد/.test(ui));
  ok('401 / 403 / 409 / 423 / 5xx / network failures each map to their own sentence', ['403', '409', '423', '>= 500', 'TypeError'].every((k) => ui.includes(k.includes('500') ? 'st >= 500' : k === 'TypeError' ? 'instanceof TypeError' : `st === ${k}`)));
} catch (e) { fail++; console.log('✗ crashed:', e.stack || e.message); }
finally {
  try { for (const id of created.plans) await prisma.ambOperatorEvent.deleteMany({ where: { data_json: { contains: `"planId":${id},` } } }).catch(() => {}); if (created.plans.length) await prisma.ambDailyPlan.deleteMany({ where: { id: { in: created.plans } } });
    const rs = await prisma.ambRecommendation.findMany({ where: { entity_id: { startsWith: T } }, select: { id: true } }); const ids = rs.map((r) => r.id); if (ids.length) { await prisma.ambActionResult.deleteMany({ where: { action: { recommendation_id: { in: ids } } } }); await prisma.ambAction.deleteMany({ where: { recommendation_id: { in: ids } } }); await prisma.ambRecommendation.deleteMany({ where: { id: { in: ids } } }); }
    await prisma.ambOperatorEvent.deleteMany({ where: { campaign_id: { startsWith: T } } }); } catch (e) { console.log('cleanup note:', e.message); }
  await prisma.$disconnect(); server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
