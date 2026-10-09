// 🧪 «الفتح حسب تكلفة الأوردر CPA»: a SAVED, VERSIONED policy (not a display filter). Eligibility rules, reasons per campaign, saving ≠ enabling, manual un-ticks survive, a policy change cancels / re-evaluates
// approved plans (never executes), restart, SHADOW simulation, and the DORMANT automatic path behind every gate — all on a mock (no Meta call anywhere). Disposable fixtures: plans dated 2031-06-xx, ids prefixed "__optest_".
//   node src/scripts/openCpaPolicyTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
process.env.DAILY_PLAN_ALLOW_TEST_CLOCK = '1'; process.env.DAILY_PLAN_DISABLE_ALERTS = '1';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const TM = await imp('../services/amb/dailyPlanTime.js'); const DP = await imp('../services/amb/dailyPlans.js'); const OC = await imp('../services/amb/openCpaPolicy.js');
const T = '__optest_'; const ADMIN_ID = (await prisma.user.findFirst({ where: { role: 'ADMIN', status: 'ACTIVE' } }))?.id ?? 1;
const ADMIN = { id: ADMIN_ID, role: 'ADMIN', status: 'ACTIVE' }; const MANAGER = { id: 9999, role: 'MANAGER', status: 'ACTIVE' };
const cfg0 = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const limits0 = cfg0.limits_json;
const c0 = { actions: await prisma.ambAction.count() };
const FRESH = { syncStatus: async () => ({ lastSuccessAt: new Date() }), refresh: async () => ({ ok: true }) };
const STALE = { syncStatus: async () => ({ lastSuccessAt: new Date(Date.now() - 5 * 3_600_000) }), refresh: async () => ({ ok: false, error: 'META_DOWN' }) };
const dcfg0 = await DP.getDailyPlanConfig(); const DC_OFF = { ...dcfg0, halted: false, scheduledExecution: { enabled: false } }; const DC_ON = { ...dcfg0, halted: false, scheduledExecution: { enabled: true } };
const cfgOf = (o = {}) => ({ mode: 'SHADOW', emergency_stop: false, writesLocked: true, execPermissions: { open: false, pause: false, budgetIncrease: false, budgetDecrease: false }, limits: {}, ...o });
const noSleep = async () => {};
let execCalls = 0;
const stubExec = async ({ recId, mode }) => { execCalls++; const rec = await prisma.ambRecommendation.findUnique({ where: { id: recId } }); const a = await prisma.ambAction.create({ data: { recommendation_id: rec.id, mode, action_type: rec.action_type, ad_account_id: rec.ad_account_id, level: rec.level, entity_id: rec.entity_id, entity_name: rec.entity_name, campaign_id: rec.campaign_id, ai_reason: rec.reason, approval_status: 'APPROVED', execution_status: 'EXECUTED', executed_by_id: null, executed_at: new Date(), meta_request_json: JSON.stringify({ id: rec.entity_id }), verify_json: JSON.stringify({ verified: true }) } }); await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'EXECUTED' } }); return { ok: true, actionId: a.id }; };
const readPaused = async (id) => ({ id, status: 'PAUSED', budget: 300 });
const D0 = { ...FRESH, user: ADMIN, runInline: true, exceptions: async () => [], lastPurchase: async () => null, mappingState: async () => null, sleep: noSleep };
const planIds = [];
const mkItem = (name, o = {}) => ({ campaignId: `${T}${name}`, campaignName: `${T}${name}`, productId: null, productName: 'fixture', storeId: 'trendy-storeee', rank: 1, selected: false, selectable: true, eligibility: 'ELIGIBLE', blockCodes: [], warnings: [], risk: 'LOW', riskScore: 10, reason: 'fixture', evidence: { mapping: 'VERIFIED', budget: 300, budgetLevel: 'CBO', status: 'PAUSED', stock: { status: 'IN_STOCK' } }, ...o });
// 10 campaigns: spend/purchases of the policy window
const FX = [
  ['A_ok', { spend: 1000, purchases: 10 }], ['B_low', { spend: 400, purchases: 10 }], ['C_noorders', { spend: 300, purchases: 0 }], ['D_sample', { spend: 200, purchases: 2 }], ['E_guard', { spend: 1000, purchases: 10 }],
  ['F_special', { spend: 1000, purchases: 10 }], ['G_ok2', { spend: 1200, purchases: 12 }], ['H_edge', { spend: 1500, purchases: 10 }], ['I_high', { spend: 1510, purchases: 10 }], ['J_edge_low', { spend: 500, purchases: 10 }],
];
const metricsMap = () => new Map(FX.map(([n, m]) => [`${T}${n}`, m]));
const itemsFx = () => FX.map(([n], i) => mkItem(n, { rank: i + 1, ...(n === 'E_guard' ? { eligibility: 'BLOCKED', selectable: false, blockCodes: ['MANUAL_OVERRIDE_COOLDOWN'] } : {}), ...(n === 'F_special' ? { eligibility: 'NEEDS_SPECIAL_APPROVAL' } : {}) }));
const baseDay = '2031-06-'; let dayN = 0; const nextDate = () => `${baseDay}${String(++dayN).padStart(2, '0')}`;
const mkPlan = async ({ date, simulated = true, items = itemsFx(), openCpa = null, userId = null, now = new Date() }) => { const p = (await DP.preparePlan({ type: 'OPEN', date, now, simulated, userId, deps: { ...FRESH, build: async () => ({ items, policy: null, openCpa }) } })).plan; planIds.push(p.id); return p; };
const get = (id) => prisma.ambDailyPlan.findUnique({ where: { id }, include: { items: { orderBy: { rank: 'asc' } } } });
const sel = async (id) => (await get(id)).items.filter((i) => i.selected).map((i) => i.campaign_id.replace(T, '')).sort();
const save = (patch) => OC.saveOpenCpaPolicy({ patch, userId: ADMIN_ID, deps: { user: ADMIN } });
const resetPolicy = async () => { const r = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const l = JSON.parse(r.limits_json || '{}'); delete l.openCpa; await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify(l) } }); };
// a previous run that was killed (e.g. a Neon connection stall) may have left its disposable plans behind — start from a clean slate
{ const old = await prisma.ambDailyPlan.findMany({ where: { plan_date: { startsWith: '2031-06-' } }, select: { id: true } }); const oldIds = old.map((p) => p.id);
  if (oldIds.length) { const rs = await prisma.ambRecommendation.findMany({ where: { batch_id: { in: oldIds.map((id) => `daily-plan-${id}`) } }, select: { id: true } }); await prisma.ambActionResult.deleteMany({ where: { action: { recommendation_id: { in: rs.map((r) => r.id) } } } }).catch(() => {}); await prisma.ambAction.deleteMany({ where: { recommendation_id: { in: rs.map((r) => r.id) } } }).catch(() => {}); await prisma.ambRecommendation.deleteMany({ where: { id: { in: rs.map((r) => r.id) } } }).catch(() => {}); await prisma.ambDailyPlan.deleteMany({ where: { id: { in: oldIds } } }).catch(() => {}); }
  await prisma.ambOperatorDecision.deleteMany({ where: { decision_key: { startsWith: '__optest_' } } }).catch(() => {}); }
await resetPolicy();
try {
  console.log('\n1. Eligibility of ONE campaign (pure) — range, sample, freshness, guards, manual un-tick');
  {
    const P = OC.normalizeOpenCpa({ minCpa: 50, maxCpa: 150, window: '7', minPurchases: 5, maxDataAgeMin: 30 }); const ev = (m, item = {}, extra = {}) => OC.evaluateCampaign({ policy: P, item: { eligibility: 'ELIGIBLE', selectable: true, blockCodes: [], evidence: {}, ...item }, metrics: m, ...extra });
    ok('CPA inside the range with enough orders → ELIGIBLE (100)', ev({ spend: 1000, purchases: 10 }).verdict === 'ELIGIBLE' && ev({ spend: 1000, purchases: 10 }).cpa === 100);
    ok('the range is INCLUSIVE: exactly 50 and exactly 150 match', ev({ spend: 500, purchases: 10 }).eligible && ev({ spend: 1500, purchases: 10 }).eligible);
    ok('151 and 49 are out of range with the right reason', ev({ spend: 1510, purchases: 10 }).codes.includes('CPA_ABOVE_MAX') && ev({ spend: 490, purchases: 10 }).codes.includes('CPA_BELOW_MIN'));
    ok('no purchases → CPA unknown (null, never 0): not matched, not eligible', ev({ spend: 300, purchases: 0 }).cpa === null && ev({ spend: 300, purchases: 0 }).verdict === 'UNKNOWN_CPA' && !ev({ spend: 300, purchases: 0 }).matched);
    ok('a perfect CPA from a weak sample (2 orders < 5) is matched but EXCLUDED (SAMPLE_TOO_SMALL)', ev({ spend: 200, purchases: 2 }).matched && ev({ spend: 200, purchases: 2 }).verdict === 'EXCLUDED' && ev({ spend: 200, purchases: 2 }).codes.includes('SAMPLE_TOO_SMALL'));
    ok('stale Meta data (older than the policy limit) excludes everything', ev({ spend: 1000, purchases: 10 }, {}, { dataAgeMin: 45 }).codes.includes('DATA_STALE') && !ev({ spend: 1000, purchases: 10 }, {}, { dataAgeMin: 45 }).eligible);
    ok('a Safety-Guard-blocked campaign is excluded even when its CPA fits (the policy never overrides a guard)', ev({ spend: 1000, purchases: 10 }, { eligibility: 'BLOCKED', selectable: false, blockCodes: ['STOCK_OUT'] }).codes.includes('GUARD_BLOCKED') && ev({ spend: 1000, purchases: 10 }, { eligibility: 'BLOCKED', selectable: false, blockCodes: ['STOCK_OUT'] }).guardCodes[0] === 'STOCK_OUT');
    ok('a manually-paused campaign needs a SPECIAL approval — not eligible by itself', ev({ spend: 1000, purchases: 10 }, { eligibility: 'NEEDS_SPECIAL_APPROVAL' }).codes.includes('NEEDS_SPECIAL_APPROVAL'));
    ok('a campaign the owner unticked stays out (USER_DESELECTED) unless it is explicitly re-selected', ev({ spend: 1000, purchases: 10 }, { evidence: { userDeselected: { at: 'x' } } }).codes.includes('USER_DESELECTED') && ev({ spend: 1000, purchases: 10 }, { evidence: { userDeselected: { at: 'x' } } }, { reselect: true }).eligible);
    ok('missing metrics (campaign unseen in the window) → unknown CPA', ev(null).verdict === 'UNKNOWN_CPA');
    const rows = FX.map(([n, m]) => ({ eval: OC.evaluateCampaign({ policy: P, item: { eligibility: n === 'E_guard' ? 'BLOCKED' : n === 'F_special' ? 'NEEDS_SPECIAL_APPROVAL' : 'ELIGIBLE', selectable: n !== 'E_guard', blockCodes: [], evidence: {} }, metrics: m }) })); const s = OC.summarizeEvaluations(rows);
    ok('counts: matched = in range (incl. weak/blocked), eligible = passed everything, excluded = matched − eligible', s.matched === 7 && s.eligible === 4 && s.excluded === 3 && s.outOfRange === 2 && s.unknownCpa === 1, JSON.stringify(s));
    ok('window ranges are Cairo-day, inclusive, today = day 1', JSON.stringify(OC.windowRangeFor({ window: '7' }, '2026-10-09')) === JSON.stringify({ from: '2026-10-03', to: '2026-10-09', days: 7 }) && OC.windowRangeFor({ window: 'today' }, '2026-10-09').from === '2026-10-09' && OC.windowRangeFor({ window: '90' }, '2026-10-09').from === '2026-07-12' && OC.windowRangeFor({ window: 'custom', from: '2026-10-01', to: '2026-10-05' }, '2026-10-09').days === 5);
  }

  console.log('\n2. The policy is SAVED + VERSIONED (not a temporary filter); saving ≠ enabling');
  {
    const p0 = await OC.getOpenCpaPolicy(); ok('nothing is assumed: no range, disabled, version 0', p0.minCpa === null && p0.maxCpa === null && p0.enabled === false && p0.version === 0);
    let e1 = null; try { await save({ minCpa: 150, maxCpa: 50 }); } catch (e) { e1 = e; } ok('min > max is refused (400) and nothing is saved', e1?.status === 400 && (await OC.getOpenCpaPolicy()).version === 0);
    let e2 = null; try { await save({ minCpa: -5, maxCpa: 100 }); } catch (e) { e2 = e; } ok('negative / text limits are refused', e2?.status === 400);
    let e3 = null; try { await save({ minCpa: 10, maxCpa: 100, window: 'custom', from: '2031-01-10', to: '2031-01-01' }); } catch (e) { e3 = e; } ok('an inverted custom range is refused', e3?.status === 400);
    let e4 = null; try { await save({ minCpa: 10, maxCpa: 100, window: 'custom', from: '2020-01-01', to: '2031-01-01' }); } catch (e) { e4 = e; } ok('a custom range in the future / over 366 days is refused', e4?.status === 400);
    let e5 = null; try { await OC.saveOpenCpaPolicy({ patch: { minCpa: 50, maxCpa: 150 }, userId: 9999, deps: { user: MANAGER } }); } catch (e) { e5 = e; } ok('only an ADMIN can save the policy (403)', e5?.status === 403);
    const s1 = await save({ minCpa: 50, maxCpa: 150, window: '7' }); ok('saved as version 1 — persisted in the operator config, NOT enabled', s1.policy.version === 1 && s1.policy.enabled === false && s1.policy.approved === null);
    const again = await save({ minCpa: 50, maxCpa: 150, window: '7' }); ok('saving the same values creates no new version', again.changed === false && (await OC.getOpenCpaPolicy()).version === 1);
    let e6 = null; try { await OC.setOpenCpaEnabled({ enabled: true, userId: ADMIN_ID, deps: { user: ADMIN } }); } catch (e) { e6 = e; } ok('enabling needs an explicit confirm', e6?.code === 'CONFIRM_REQUIRED');
    let e7 = null; try { await OC.setOpenCpaEnabled({ enabled: true, confirm: true, userId: 9999, deps: { user: MANAGER } }); } catch (e) { e7 = e; } ok('only an ADMIN can enable (403)', e7?.status === 403);
    await resetPolicy(); let e8 = null; try { await OC.setOpenCpaEnabled({ enabled: true, confirm: true, userId: ADMIN_ID, deps: { user: ADMIN } }); } catch (e) { e8 = e; } ok('enabling without a complete range is refused (the system never invents a range)', e8?.code === 'INVALID_POLICY');
    await save({ minCpa: 50, maxCpa: 150, window: '7' }); const en = await OC.setOpenCpaEnabled({ enabled: true, confirm: true, userId: ADMIN_ID, deps: { user: ADMIN } });
    ok('enabled with confirm: the approved version is recorded (v1) — no campaign was opened by the switch', en.policy.enabled && en.policy.approved.version === 1 && (await prisma.ambAction.count()) === c0.actions);
    const s2 = await save({ minCpa: 20, maxCpa: 200, window: '30' });
    ok('tomorrow 50–150 → 20–200 (30 days) is a NEW version v2; the old one is kept in the history', s2.policy.version === 2 && s2.policy.minCpa === 20 && s2.policy.history.at(-1).version === 1 && s2.policy.history.at(-1).minCpa === 50);
    ok('saving a new version does not switch the rule off, but the AUTOMATIC approval stays on v1 until the owner approves v2', s2.policy.enabled === true && s2.policy.approved.version === 1);
    const re = await OC.setOpenCpaEnabled({ enabled: true, confirm: true, userId: ADMIN_ID, deps: { user: ADMIN } }); ok('re-approving the current version is explicit (v2)', re.changed && re.policy.approved.version === 2);
    await save({ minCpa: 50, maxCpa: 150, window: '7' }); await OC.setOpenCpaEnabled({ enabled: false, confirm: true, userId: ADMIN_ID, deps: { user: ADMIN } }); const off = await OC.getOpenCpaPolicy(); ok('disabling clears the approval; the limits stay saved (v3, 50–150)', off.enabled === false && off.approved === null && off.minCpa === 50 && off.version === 3);
    ok('every change left an audit trail', (await prisma.aiAuditLog.count({ where: { kind: { startsWith: 'OPEN_CPA_POLICY' } } })) >= 5);
  }

  console.log('\n3. Applying the policy to an OPEN plan: «تجهيز الحملات المطابقة»');
  await save({ minCpa: 50, maxCpa: 150, window: '7' }); // v4 (disabled) — preparing manually works with a complete range
  const d3 = nextDate(); const p3 = await mkPlan({ date: d3 }); const dep3 = { ...D0, openCpaMetrics: metricsMap() };
  ok('before preparing nothing is selected (the plan was built with no policy)', (await sel(p3.id)).length === 0);
  const ov0 = await DP.getOpenCpaOverview({ now: new Date(), simulated: true, deps: { ...dep3, syncStatus: FRESH.syncStatus } });
  ok('the overview is a LIVE preview that persists nothing', (await sel(p3.id)).length === 0 && ov0.policy.version === (await OC.getOpenCpaPolicy()).version);
  let eM = null; try { await DP.prepareOpenCpaMatches({ planId: p3.id, userId: 9999, now: new Date(), simulated: true, deps: { ...dep3, user: MANAGER } }); } catch (e) { eM = e; } ok('only an ADMIN can prepare (403)', eM?.status === 403);
  const now3 = new Date(TM.dueAt('OPEN', d3).getTime() + 60_000);
  const st = await DP.prepareOpenCpaMatches({ planId: p3.id, userId: ADMIN_ID, now: now3, simulated: true, deps: { ...dep3, ...STALE, user: ADMIN } });
  ok('stale Meta data → prepare REFUSES (decisions only from fresh data); nothing changed', st.ok === false && st.status === 'STALE_DATA' && (await sel(p3.id)).length === 0);
  const r3 = await DP.prepareOpenCpaMatches({ planId: p3.id, userId: ADMIN_ID, now: now3, simulated: true, deps: { ...dep3, user: ADMIN } });
  ok('prepared from the fresh data: eligible campaigns (A, G, H, J) are ticked — the policy range is inclusive', JSON.stringify(await sel(p3.id)) === JSON.stringify(['A_ok', 'G_ok2', 'H_edge', 'J_edge_low']), JSON.stringify(await sel(p3.id)));
  ok('counts: 7 matched, 4 eligible, 3 excluded (weak sample, guard, special approval)', r3.counts.matched === 7 && r3.counts.eligible === 4 && r3.counts.excluded === 3 && r3.counts.outOfRange === 2 && r3.counts.unknownCpa === 1, JSON.stringify(r3.counts));
  const why = (n) => r3.rows.find((r) => r.campaignId === `${T}${n}`);
  ok('every excluded campaign shows WHY: weak sample / guard code / special approval', why('D_sample').codes.includes('SAMPLE_TOO_SMALL') && why('E_guard').codes.includes('GUARD_BLOCKED') && why('E_guard').guardCodes.includes('MANUAL_OVERRIDE_COOLDOWN') && why('F_special').codes.includes('NEEDS_SPECIAL_APPROVAL'));
  ok('out-of-range and unknown-CPA campaigns are explained too (low / high / no orders)', why('B_low').codes.includes('CPA_BELOW_MIN') && why('I_high').codes.includes('CPA_ABOVE_MAX') && why('C_noorders').codes.includes('CPA_UNKNOWN') && why('C_noorders').cpa === null);
  const g3 = await get(p3.id); const ev = (n) => JSON.parse(g3.items.find((i) => i.campaign_id === `${T}${n}`).evidence_json);
  ok('each item stores its verdict + the policy version (evidence.cpaPolicy) and the plan stores the policy snapshot', ev('A_ok').cpaPolicy.verdict === 'ELIGIBLE' && ev('A_ok').cpaPolicy.version === (await OC.getOpenCpaPolicy()).version && JSON.parse(g3.evidence_json).openCpa.minCpa === 50 && JSON.parse(g3.evidence_json).openCpa.counts.eligible === 4);
  ok('the plan is still PREPARED at version 1 — preparing only SELECTS, nothing executed', g3.status === 'PREPARED' && g3.version === 1 && (await prisma.ambAction.count()) === c0.actions);

  console.log('\n4. Manual changes are respected (un-ticks survive a re-prepare)');
  await DP.updateSelection({ planId: p3.id, selections: { [`${T}G_ok2`]: false }, userId: ADMIN_ID });
  ok('unticking G is saved and marked as the owner\'s decision', JSON.stringify(await sel(p3.id)) === JSON.stringify(['A_ok', 'H_edge', 'J_edge_low']) && JSON.parse((await get(p3.id)).items.find((i) => i.campaign_id === `${T}G_ok2`).evidence_json).userDeselected?.by === ADMIN_ID);
  const r4 = await DP.prepareOpenCpaMatches({ planId: p3.id, userId: ADMIN_ID, now: now3, simulated: true, deps: { ...dep3, user: ADMIN } });
  ok('re-preparing does NOT re-tick G (it stays excluded with USER_DESELECTED)', !(await sel(p3.id)).includes('G_ok2') && r4.rows.find((r) => r.campaignId === `${T}G_ok2`).codes.includes('USER_DESELECTED') && r4.counts.eligible === 3, JSON.stringify(r4.counts));
  let eR = null; try { await DP.prepareOpenCpaMatches({ planId: p3.id, userId: ADMIN_ID, reselect: [`${T}G_ok2`], now: now3, simulated: true, deps: { ...dep3, user: ADMIN } }); } catch (e) { eR = e; } ok('re-selecting an un-ticked campaign needs an explicit special approval (400)', eR?.code === 'SPECIAL_APPROVAL_REQUIRED' && !(await sel(p3.id)).includes('G_ok2'));
  await DP.prepareOpenCpaMatches({ planId: p3.id, userId: ADMIN_ID, reselect: [`${T}G_ok2`], confirmSpecial: true, now: now3, simulated: true, deps: { ...dep3, user: ADMIN } });
  ok('with the special approval it is ticked again and the mark is cleared', (await sel(p3.id)).includes('G_ok2') && !JSON.parse((await get(p3.id)).items.find((i) => i.campaign_id === `${T}G_ok2`).evidence_json).userDeselected);
  await DP.updateSelection({ planId: p3.id, selections: { [`${T}G_ok2`]: false }, userId: ADMIN_ID });
  let eS = null; try { await DP.updateSelection({ planId: p3.id, selections: { [`${T}F_special`]: true }, userId: ADMIN_ID }); } catch (e) { eS = e; } ok('a campaign that needs a special approval cannot be ticked without it (existing rule still holds)', eS?.code === 'SPECIAL_APPROVAL_REQUIRED');
  let eB = null; try { await DP.updateSelection({ planId: p3.id, selections: { [`${T}E_guard`]: true }, userId: ADMIN_ID }); } catch (e) { eB = e; } ok('a guard-blocked campaign can never be ticked (the policy sits below the Safety Guards)', eB?.status === 400);

  console.log('\n5. A policy change while a plan is waiting');
  const flagged = await DP.getOpenCpaOverview({ now: now3, simulated: true, deps: { ...dep3, syncStatus: FRESH.syncStatus } }); ok('a PREPARED plan is flagged "prepared under the previous version" after a change is NOT saved yet — same version → not stale', flagged.plan.stale === false);
  await save({ minCpa: 20, maxCpa: 200, window: '7' }); const rc1 = await DP.reconcileOpenCpaPlans({ userId: ADMIN_ID, now: now3, simulated: true, deps: dep3 });
  const flagged2 = await DP.getOpenCpaOverview({ now: now3, simulated: true, deps: { ...dep3, syncStatus: FRESH.syncStatus } });
  ok('after saving 20–200 the PREPARED plan is flagged stale (re-prepare needed) — and untouched', flagged2.plan.stale === true && rc1.flagged.includes(p3.id) && rc1.superseded.length === 0 && (await get(p3.id)).status === 'PREPARED' && (await get(p3.id)).version === 1);
  const r5 = await DP.prepareOpenCpaMatches({ planId: p3.id, userId: ADMIN_ID, now: now3, simulated: true, deps: { ...dep3, user: ADMIN } });
  ok('re-preparing under the new range updates the same version in place (v1) — now B (40), C is still unknown, I (151) is in', (await get(p3.id)).version === 1 && (await sel(p3.id)).includes('B_low') && (await sel(p3.id)).includes('I_high') && !(await sel(p3.id)).includes('C_noorders') && !(await sel(p3.id)).includes('G_ok2'), JSON.stringify(await sel(p3.id)));

  console.log('\n6. APPROVED plan + policy change → the old version is cancelled, a NEW one needs approval (no surprise execution)');
  const d6 = nextDate(); const p6 = await mkPlan({ date: d6 }); const early = new Date(TM.dueAt('OPEN', d6).getTime() - 2 * 3_600_000);
  await save({ minCpa: 50, maxCpa: 150, window: '7' });
  await DP.prepareOpenCpaMatches({ planId: p6.id, userId: ADMIN_ID, now: early, simulated: true, deps: { ...dep3, user: ADMIN } });
  await DP.updateSelection({ planId: p6.id, selections: { [`${T}A_ok`]: false }, userId: ADMIN_ID });
  const ap6 = await DP.approvePlan({ planId: p6.id, userId: ADMIN_ID, now: early, deps: { ...D0, user: ADMIN, dcfg: DC_ON, config: async () => cfgOf(), openCpaMetrics: metricsMap() } });
  ok('approved ahead of time (scheduled) — not running', ap6.ok && ap6.status === 'APPROVED' && ap6.scheduled === true && (await get(p6.id)).status === 'APPROVED');
  await save({ minCpa: 20, maxCpa: 200, window: '7' });
  const dueDay6 = new Date(TM.dueAt('OPEN', d6).getTime() + 60_000); const rc6 = await DP.reconcileOpenCpaPlans({ userId: ADMIN_ID, now: dueDay6, simulated: true, deps: dep3 });
  const old6 = await get(p6.id); const next6 = await prisma.ambDailyPlan.findFirst({ where: { plan_key: p6.plan_key }, orderBy: { version: 'desc' }, include: { items: true } }); planIds.push(next6.id);
  ok('the approved version is SUPERSEDED and a NEW PREPARED version (v2) needs a fresh approval', old6.status === 'SUPERSEDED' && next6.version === 2 && next6.status === 'PREPARED' && next6.approved_by_id === null && rc6.superseded.length === 1);
  ok('the new version is re-evaluated under the new range (B 40 is now in) but the owner\'s manual un-tick of A is kept', next6.items.find((i) => i.campaign_id === `${T}B_low`).selected === true && next6.items.find((i) => i.campaign_id === `${T}A_ok`).selected === false);
  const runOld = await DP.runPlanExecution({ planId: p6.id, userId: ADMIN_ID, now: new Date(TM.dueAt('OPEN', d6).getTime() + 60_000), deps: { ...D0, dcfg: DC_ON, config: async () => cfgOf(), readEntity: readPaused, approveAndExecute: stubExec } });
  ok('the superseded version can never run', runOld.skipped === 'NOT_CLAIMED' && execCalls === 0);
  ok('the new plan version has the policy snapshot v of the current policy', JSON.parse(next6.evidence_json).openCpa.version === (await OC.getOpenCpaPolicy()).version);
  // a RUNNING / COMPLETED plan is never touched
  const d6b = nextDate(); const p6b = await mkPlan({ date: d6b }); const nowB = new Date(TM.dueAt('OPEN', d6b).getTime() + 60_000); await save({ minCpa: 50, maxCpa: 150, window: '7' });
  await DP.prepareOpenCpaMatches({ planId: p6b.id, userId: ADMIN_ID, now: nowB, simulated: true, deps: { ...dep3, user: ADMIN } });
  await DP.approvePlan({ planId: p6b.id, userId: ADMIN_ID, now: nowB, deps: { ...D0, user: ADMIN, dcfg: DC_OFF, config: async () => cfgOf(), readEntity: readPaused, approveAndExecute: stubExec, openCpaMetrics: metricsMap() } });
  const done6b = await get(p6b.id); await save({ minCpa: 10, maxCpa: 300, window: '7' }); const rc6b = await DP.reconcileOpenCpaPlans({ userId: ADMIN_ID, now: nowB, simulated: true, deps: dep3 });
  ok('a plan that already ran (COMPLETED) is never changed by a policy edit', done6b.status === 'COMPLETED' && (await get(p6b.id)).status === 'COMPLETED' && !rc6b.superseded.some((x) => x.from === p6b.id));

  console.log('\n7. SHADOW simulates only; APPROVAL waits for the owner; nothing opens on its own');
  const d7 = nextDate(); const p7 = await mkPlan({ date: d7 }); const now7 = new Date(TM.dueAt('OPEN', d7).getTime() + 60_000); await save({ minCpa: 50, maxCpa: 150, window: '7' });
  await DP.prepareOpenCpaMatches({ planId: p7.id, userId: ADMIN_ID, now: now7, simulated: true, deps: { ...dep3, user: ADMIN } });
  ok('APPROVAL: a prepared plan WAITS (PREPARED, nothing executed) until the owner approves', (await get(p7.id)).status === 'PREPARED' && execCalls === 0);
  const before7 = execCalls; await DP.approvePlan({ planId: p7.id, userId: ADMIN_ID, now: now7, deps: { ...D0, user: ADMIN, dcfg: DC_OFF, config: async () => cfgOf({ mode: 'SHADOW' }), readEntity: readPaused, approveAndExecute: stubExec, openCpaMetrics: metricsMap() } });
  const it7 = await prisma.ambDailyPlanItem.findMany({ where: { plan_id: p7.id, selected: true } });
  ok('SHADOW: the approved plan is a SIMULATION — every selected campaign ends SIMULATED, no executor call, no Meta write', it7.length === 4 && it7.every((i) => i.status === 'SIMULATED') && execCalls === before7);

  console.log('\n8. AUTOMATIC is DORMANT behind every gate (mock executor)');
  const d8 = nextDate(); const now8 = new Date(TM.dueAt('OPEN', d8).getTime() + 30 * 60_000);
  await save({ minCpa: 50, maxCpa: 150, window: '7' }); await OC.setOpenCpaEnabled({ enabled: true, confirm: true, userId: ADMIN_ID, deps: { user: ADMIN } }); const pol8 = await OC.getOpenCpaPolicy();
  const p8 = await mkPlan({ date: d8, simulated: false, now: now8, openCpa: { version: pol8.version } });
  await DP.prepareOpenCpaMatches({ planId: p8.id, userId: ADMIN_ID, now: now8, simulated: false, deps: { ...dep3, user: ADMIN } });
  const ALL = { config: async () => cfgOf({ mode: 'AUTOPILOT', writesLocked: false, execPermissions: { open: true, pause: false, budgetIncrease: false, budgetDecrease: false } }), dcfg: DC_ON, autopilotGate: async () => ({ ok: true }) };
  const run = (over = {}, extra = {}) => DP.runOpenCpaAutomatic({ now: now8, deps: { ...D0, ...ALL, ...over, ...extra, readEntity: readPaused, approveAndExecute: stubExec } });
  const gates = [
    ['MODE_NOT_AUTOMATIC', { config: async () => cfgOf({ mode: 'APPROVAL', writesLocked: false, execPermissions: { open: true } }) }], ['MODE_NOT_AUTOMATIC (SHADOW)', { config: async () => cfgOf({ mode: 'SHADOW', writesLocked: false, execPermissions: { open: true } }) }],
    ['EMERGENCY_STOP', { config: async () => cfgOf({ mode: 'AUTOPILOT', writesLocked: false, emergency_stop: true, execPermissions: { open: true } }) }], ['META_WRITES_LOCKED', { config: async () => cfgOf({ mode: 'AUTOPILOT', writesLocked: true, execPermissions: { open: true } }) }],
    ['OPEN_PERMISSION_OFF', { config: async () => cfgOf({ mode: 'AUTOPILOT', writesLocked: false, execPermissions: { open: false } }) }], ['SCHEDULED_EXECUTION_OFF', { dcfg: DC_OFF }], ['QUEUE_HALTED', { dcfg: { ...DC_ON, halted: true } }], ['AUTOPILOT_GATE_NOT_READY', { autopilotGate: async () => ({ ok: false }) }],
  ];
  for (const [code, over] of gates) { const r = await run(over); ok(`gate «${code}» closed → nothing runs`, r.ran === false && r.why.some((w) => code.startsWith(w)) && execCalls === before7, JSON.stringify(r)); }
  await save({ minCpa: 50, maxCpa: 151, window: '7' }); const r8a = await run(); ok('a NEW policy version (not yet approved by the owner) → AUTOMATIC does not run', r8a.ran === false && r8a.why.includes('POLICY_NOT_APPROVED_AT_CURRENT_VERSION') && execCalls === before7);
  await OC.setOpenCpaEnabled({ enabled: true, confirm: true, userId: ADMIN_ID, deps: { user: ADMIN } }); const r8b = await run(); ok('approved at the current version but the plan was prepared under the OLD version → skipped', r8b.ran === true && r8b.plans[0]?.skipped === 'PLAN_NOT_PREPARED_UNDER_CURRENT_POLICY' && execCalls === before7, JSON.stringify(r8b));
  await DP.prepareOpenCpaMatches({ planId: p8.id, userId: ADMIN_ID, now: now8, simulated: false, deps: { ...dep3, user: ADMIN } });
  const r8c = await run({}, { ...STALE }); ok('stale Meta data → skipped, nothing runs', r8c.ran === true && r8c.plans[0]?.skipped === 'STALE_DATA' && execCalls === before7, JSON.stringify(r8c));
  await DP.updateSelection({ planId: p8.id, selections: { [`${T}H_edge`]: false }, userId: ADMIN_ID });
  const r8 = await run(); const fin8 = await get(p8.id);
  ok('all gates open: ONLY the eligible, still-ticked campaigns run (A, G, I, J) — the owner\'s un-ticked H does not', r8.ran === true && execCalls === before7 + 4 && fin8.status === 'COMPLETED', JSON.stringify([r8, execCalls - before7, fin8.status]));
  ok('the plan records that it ran under AUTOMATIC with the approving owner and live revalidation per campaign', fin8.approval_mode === 'AUTOPILOT' && fin8.execution_mode === 'LIVE' && fin8.approved_by_id === ADMIN_ID && fin8.items.filter((i) => i.selected).every((i) => i.status === 'VERIFIED'));
  ok('guard-blocked / special-approval / weak-sample / out-of-range campaigns were never executed', fin8.items.filter((i) => !i.selected).every((i) => !i.status || i.status === 'PENDING'));
  const again8 = await run(); ok('running again does nothing (the plan is COMPLETED — no repeat)', execCalls === before7 + 4 && !(again8.plans || []).some((x) => x.executed));

  console.log('\n9. Restart: nothing lives in memory');
  await save({ minCpa: 50, maxCpa: 150, window: '7' });
  const polR = await OC.getOpenCpaPolicy(); const g9 = await get(p3.id);
  ok('the policy and its history are read back from the database after a restart', polR.minCpa === 50 && polR.version >= 8 && polR.history.length >= 5);
  ok('the plan keeps its policy snapshot and the owner\'s un-tick marks', JSON.parse(g9.evidence_json).openCpa && g9.items.some((i) => JSON.parse(i.evidence_json).userDeselected));
  const nowT = new Date(TM.dueAt('OPEN', '2031-06-28').getTime() + 60_000); const t1 = await DP.ensureDuePlans({ now: nowT, simulated: true, deps: { ...FRESH, build: async () => ({ items: itemsFx(), policy: null }) } }); const t2 = await DP.ensureDuePlans({ now: nowT, simulated: true, deps: { ...FRESH, build: async () => ({ items: itemsFx(), policy: null }) } });
  for (const x of t1.prepared) planIds.push(x.planId);
  ok('a scheduler tick after a restart is idempotent: one plan for the day, never two', t1.prepared.filter((p) => p.type === 'OPEN').length === 1 && t2.prepared.filter((p) => p.type === 'OPEN' && !p.surfacedOnly).length === 0);
  ok('no Action was created by the whole suite except the mock executor\'s', (await prisma.ambAction.count()) - c0.actions === execCalls);
} finally {
  const ids = [...new Set(planIds)]; const extra = await prisma.ambDailyPlan.findMany({ where: { plan_date: { startsWith: '2031-06-' } }, select: { id: true } }); const all = [...new Set([...ids, ...extra.map((p) => p.id)])];
  const recs = await prisma.ambRecommendation.findMany({ where: { batch_id: { in: all.map((id) => `daily-plan-${id}`) } }, select: { id: true } });
  await prisma.ambActionResult.deleteMany({ where: { action: { recommendation_id: { in: recs.map((r) => r.id) } } } }).catch(() => {}); await prisma.ambAction.deleteMany({ where: { recommendation_id: { in: recs.map((r) => r.id) } } }).catch(() => {}); await prisma.ambRecommendation.deleteMany({ where: { id: { in: recs.map((r) => r.id) } } }).catch(() => {});
  for (const id of all) await prisma.ambOperatorEvent.deleteMany({ where: { data_json: { contains: `"planId":${id},` } } }).catch(() => {});
  await prisma.ambOperatorEvent.deleteMany({ where: { campaign_id: { startsWith: T } } }).catch(() => {}); await prisma.ambDailyPlan.deleteMany({ where: { id: { in: all } } }).catch(() => {});
  await prisma.ambOperatorEvent.deleteMany({ where: { kind: { startsWith: 'OPEN_CPA_POLICY' } } }).catch(() => {}); await prisma.aiAuditLog.deleteMany({ where: { kind: { startsWith: 'OPEN_CPA_POLICY' } } }).catch(() => {});
  await prisma.ambAlert.deleteMany({ where: { dedupe_key: { startsWith: 'dailyplan:' }, AND: [{ dedupe_key: { contains: '2031-' } }] } }).catch(() => {});
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } }).catch(() => {}); await prisma.$disconnect();
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
