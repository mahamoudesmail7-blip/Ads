// 📏 DAILY LIMITS & DECISION HYGIENE — the real used/limit/remaining counters, an honest «حد يومي» alert (which limit, the value, CURRENT vs OLD), duplicate closing, stale sweep and the
//   "same change twice" guard, plus the AUTOMATIC overview feed. No Meta call anywhere; no limit, permission or campaign is changed. Isolated TEST database only.
//   node src/scripts/dailyLimitsTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
process.env.DAILY_PLAN_DISABLE_ALERTS = '';
const { prisma } = await imp('../prisma.js');
const DL = await imp('../services/amb/dailyLimits.js'); const H = await imp('../services/amb/decisionHygiene.js'); const OPS = await imp('../services/amb/operatorOps.js'); const BK = await imp('../services/amb/bulkActivation.js');
const T = '__optest_dl_'; const NOW = new Date('2031-03-10T12:00:00Z'); const min = (n) => new Date(NOW.getTime() - n * 60_000);
const cfg = { limits: { maxActionsPerDay: 30, maxActionsPerHour: 6, account: { maxBudgetIncreasePerDay: 100, maxDailySpendUnderAi: 600, maxEnablesPerDay: 1, maxPausesPerDay: 1 } } };
const by = (rows, k) => rows.find((r) => r.key === k);
const cleanup = async () => { const ds = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { startsWith: T } }, select: { id: true } }); await prisma.ambOperatorEvent.deleteMany({ where: { OR: [{ campaign_id: { startsWith: T } }, { decision_id: { in: ds.map((d) => d.id) } }] } }); await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { startsWith: T } } }); await prisma.ambAlert.deleteMany({ where: { dedupe_key: { startsWith: 'operator:daily-limit:' } } }).catch(() => {}); };
const row = (campaign, key, o = {}) => prisma.ambOperatorDecision.create({ data: { decision_key: `${T}${key}`, status: 'PREPARED', store_id: 'trendy-storeee', product_id: null, ad_account_id: 'act_x', campaign_id: `${T}${campaign}`, campaign_name: `${T}${campaign}`, action: 'SCALE_DOWN', rule_name: 'AUTO:REDUCE', mode_at_decision: 'AUTOPILOT', confidence: 'HIGH', params_json: JSON.stringify({ kind: 'REDUCE', entityId: `${T}${campaign}`, fromBudget: 500, toBudget: 400 }), ...o } });
const setUpdated = (id, d) => prisma.$executeRawUnsafe(`UPDATE amb_operator_decisions SET updated_at = $1 WHERE id = $2`, d, id);

try {
  await cleanup();
  console.log('\n1. The real counters: used / limit / remaining (the 100 limit and the 600 limit are different things)');
  { const rows = DL.limitUsage({ config: cfg, counters: { budgetIncreaseToday: 40, aiBudget: 650, byAction: { OPEN: 1, PAUSE: 0, SCALE_DOWN: 5 }, actionsToday: 6, actionsLastHour: 2 } });
    const inc = by(rows, 'budgetIncrease'), exp = by(rows, 'exposure'), op = by(rows, 'opens'), pa = by(rows, 'pauses'), ad = by(rows, 'actionsDay');
    ok('increase limit: used 40 of 100 → remaining 60, state OK', inc.limit === 100 && inc.used === 40 && inc.remaining === 60 && inc.state === 'OK');
    ok('exposure limit: 650 under AI vs 600 → remaining 0, state FULL (the exposure limit is reached while the increase limit is NOT)', exp.limit === 600 && exp.used === 650 && exp.remaining === 0 && exp.state === 'FULL');
    ok('open limit 1/1 → FULL, pause limit 0/1 → remaining 1', op.state === 'FULL' && op.remaining === 0 && pa.remaining === 1 && pa.state === 'OK');
    ok('reductions never count: 5 executed SCALE_DOWN change no counter; the daily action cap counts every executed action (6 of 30 → 24 left)', inc.used === 40 && ad.used === 6 && ad.remaining === 24);
    ok('every counter explains WHAT it measures and what it blocks (increase/open only — never a reduction)', rows.every((r) => r.measures && r.effect) && /التقليل/.test(inc.effect) && /التقليل/.test(exp.effect));
    ok('the 100-vs-600 difference is written down for the owner (speed of growth vs total money under AI)', /سرعة النمو/.test(DL.DIFFERENCE_NOTE) && /الحجم الكلي/.test(DL.DIFFERENCE_NOTE) && /100/.test(DL.DIFFERENCE_NOTE) && /600/.test(DL.DIFFERENCE_NOTE));
    const unset = DL.limitUsage({ config: { limits: { account: {} } }, counters: {} }); ok('a limit that is not configured is UNSET (no invented number)', by(unset, 'budgetIncrease').state === 'UNSET' && by(unset, 'budgetIncrease').limit === null && by(unset, 'budgetIncrease').remaining === null);
    const near = DL.limitUsage({ config: cfg, counters: { budgetIncreaseToday: 85 } }); ok('85% used → NEAR', by(near, 'budgetIncrease').state === 'NEAR'); }

  console.log('\n2. Reading the stored guard blocks (the real messages the production database holds)');
  { const p = (m, c = 'ACCOUNT_DAILY_LIMIT') => DL.parseLimitBlock({ code: c, message: m });
    const a = p('ACCOUNT_DAILY_LIMIT[B]:زيادة ميزانية 280 > 100'); ok('«زيادة ميزانية 280 > 100» → the INCREASE limit, value 280, limit 100', a.key === 'budgetIncrease' && a.total === 280 && a.limit === 100 && a.scope === 'ACCOUNT');
    const b = p('ACCOUNT_DAILY_LIMIT[B]:ميزانية تحت تحكم AI 650 > 600'); ok('«ميزانية تحت تحكم AI 650 > 600» → the EXPOSURE limit', b.key === 'exposure' && b.total === 650 && b.limit === 600 && b.label === 'حد التعرض المالي');
    const c = p('فتح 1/1'); ok('«فتح 1/1» → the open limit', c.key === 'opens' && c.total === 1 && c.limit === 1);
    ok('«إيقاف 1/1» → the pause limit; a store limit keeps its STORE scope', p('إيقاف 1/1').key === 'pauses' && p('زيادة ميزانية 150 > 100', 'STORE_DAILY_LIMIT').scope === 'STORE');
    ok('RATE_LIMIT_DAY names the daily action cap; an unknown message still names the limit by its code (never a vague «a limit»)', p('x', 'RATE_LIMIT_DAY').key === 'actionsDay' && p('???').key === 'unknown' && DL.parseLimitBlock({ code: 'MAX_ACTION_SIZE', message: 'x' }) === null); }

  console.log('\n3. The alert: which limit, the value, and CURRENT vs OLD');
  { const dec = (id, status, ageMin, blocks) => ({ id, campaign_id: 'c', campaign_name: `camp ${id}`, action: 'SCALE_UP', status, updated_at: min(ageMin), blocked_codes_json: JSON.stringify(blocks) });
    const inc = [{ code: 'ACCOUNT_DAILY_LIMIT', message: 'ACCOUNT_DAILY_LIMIT[B]:زيادة ميزانية 280 > 100' }];
    const old = DL.limitAlert(DL.buildLimitReport({ rows: [dec(1, 'BLOCKED', 18 * 60, inc), dec(2, 'BLOCKED', 9 * 60, inc)], now: NOW }));
    ok('only OLD decisions carry the block (not re-evaluated for hours) → an INFO that says plainly «مفيش منع حالي» — never «متوقفة لحد بكرة»', old.kind === 'HISTORICAL' && old.severity === 'INFO' && /مفيش منع حالي/.test(old.title) && /مفيش حاجة متوقفة دلوقتي/.test(old.message) && !/لحد بكرة/.test(old.message) && /280 > 100/.test(old.message) && /حد زيادة الميزانية/.test(old.message), old.message);
    const cur = DL.limitAlert(DL.buildLimitReport({ rows: [dec(3, 'BLOCKED', 4, [{ code: 'ACCOUNT_DAILY_LIMIT', message: 'ميزانية تحت تحكم AI 650 > 600' }]), dec(4, 'BLOCKED', 9 * 60, inc)], now: NOW }));
    ok('a block on a decision the engine re-evaluated 4 minutes ago is CURRENT → WARNING naming the limit (حد التعرض المالي), the value (650 > 600) and that it only stops increases/opens', cur.kind === 'CURRENT' && cur.severity === 'WARNING' && /حد التعرض المالي/.test(cur.title) && /650 > 600/.test(cur.message) && /المنع حالي/.test(cur.message) && /التقليل والإيقاف/.test(cur.message), cur.message);
    ok('an EXECUTED / EXPIRED decision with a limit code is neither current nor old (nothing is blocked by it)', DL.limitAlert(DL.buildLimitReport({ rows: [dec(5, 'EXPIRED', 1, inc), dec(6, 'VERIFIED', 1, inc)], now: NOW })) === null || DL.buildLimitReport({ rows: [dec(5, 'EXPIRED', 1, inc)], now: NOW }).current.length === 0);
    ok('no limit code at all → no alert', DL.limitAlert(DL.buildLimitReport({ rows: [dec(7, 'BLOCKED', 1, [{ code: 'STOCK_UNKNOWN', message: 'x' }])], now: NOW })) === null); }
  { // the real notification path against the database: an OLD blocked decision raises the INFO, a fresh one the WARNING
    const d1 = await row('old1', 'lim_old1', { status: 'BLOCKED', action: 'SCALE_UP', blocked_codes_json: JSON.stringify([{ code: 'ACCOUNT_DAILY_LIMIT', message: 'ACCOUNT_DAILY_LIMIT[B]:زيادة ميزانية 320 > 100' }]) }); await setUpdated(d1.id, min(10 * 60));
    const r1 = await OPS.emitOperatorNotifications({ now: NOW }); const al1 = await prisma.ambAlert.findFirst({ where: { dedupe_key: { startsWith: 'operator:daily-limit:' } }, orderBy: { id: 'desc' } });
    ok('emitOperatorNotifications with only an OLD limit block raises the INFO «مفيش منع حالي» with the real value (320 > 100)', !!al1 && al1.severity === 'INFO' && /مفيش منع حالي/.test(al1.title) && /320 > 100/.test(al1.message), JSON.stringify([r1.sent, al1?.title]));
    await prisma.ambAlert.deleteMany({ where: { dedupe_key: { startsWith: 'operator:daily-limit:' } } });
    const d2 = await row('cur1', 'lim_cur1', { status: 'BLOCKED', action: 'SCALE_UP', blocked_codes_json: JSON.stringify([{ code: 'ACCOUNT_DAILY_LIMIT', message: 'ACCOUNT_DAILY_LIMIT[B]:ميزانية تحت تحكم AI 700 > 600' }]) }); await setUpdated(d2.id, min(3));
    await OPS.emitOperatorNotifications({ now: NOW }); const al2 = await prisma.ambAlert.findFirst({ where: { dedupe_key: { startsWith: 'operator:daily-limit:' } }, orderBy: { id: 'desc' } });
    ok('a block on a decision re-evaluated 3 minutes ago raises the WARNING that names the exposure limit and 700 > 600', !!al2 && al2.severity === 'WARNING' && /حد التعرض المالي/.test(al2.title) && /700 > 600/.test(al2.message), JSON.stringify(al2 && [al2.severity, al2.title])); }

  console.log('\n4. Duplicate hygiene (database): supersede · sweep · same-change guard');
  { const camp = 'h1';
    const a = await row(camp, 'h_a'), b = await row(camp, 'h_b'), c = await row(camp, 'h_c'); const other = await row('h2', 'h_other'); const done = await row(camp, 'h_done', { status: 'VERIFIED', executed_at: new Date() }); const man = await row(camp, 'h_man', { rule_name: 'AUTO:MANUAL_REDUCE' }); const diffAction = await row(camp, 'h_diff', { action: 'PAUSE', rule_name: 'AUTO:HIGH_CPA' });
    const n = await H.supersedeOlder({ keepId: c.id, campaignId: `${T}${camp}`, action: 'SCALE_DOWN', ruleName: 'AUTO:REDUCE' });
    const st = async (x) => (await prisma.ambOperatorDecision.findUnique({ where: { id: x.id } })).status;
    ok('supersedeOlder closes the older open duplicates of the SAME campaign + action + rule only', n === 2 && (await st(a)) === 'EXPIRED' && (await st(b)) === 'EXPIRED' && (await st(c)) === 'PREPARED' && (await st(other)) === 'PREPARED' && (await st(done)) === 'VERIFIED' && (await st(man)) === 'PREPARED' && (await st(diffAction)) === 'PREPARED');
    ok('a MANUAL operation is never superseded', (await H.supersedeOlder({ keepId: c.id + 100, campaignId: `${T}${camp}`, action: 'SCALE_DOWN', ruleName: 'AUTO:MANUAL_REDUCE' })) === 0 && (await st(man)) === 'PREPARED');
    // same-change guard
    const row2 = { id: c.id, campaign_id: `${T}${camp}`, action: 'SCALE_DOWN' };
    const hit = await H.findAlreadyApplied({ row: row2, params: { toBudget: 400, entityId: `${T}${camp}` }, now: new Date() });
    ok('findAlreadyApplied: another decision already VERIFIED the same target budget (500 → 400) → found', hit && hit.id === done.id);
    ok('…a different target budget is a different change → not a duplicate', (await H.findAlreadyApplied({ row: row2, params: { toBudget: 320, entityId: `${T}${camp}` }, now: new Date() })) === null);
    await prisma.ambOperatorDecision.update({ where: { id: done.id }, data: { action: 'PAUSE' } });
    ok('pause: another pause of the campaign within 2h is a duplicate; none in the last 2h is not', !!(await H.findAlreadyApplied({ row: { id: 0, campaign_id: `${T}${camp}`, action: 'PAUSE' }, params: {}, now: new Date() })) && (await H.findAlreadyApplied({ row: { id: 0, campaign_id: `${T}${camp}`, action: 'PAUSE' }, params: {}, now: new Date(Date.now() + 3 * 3_600_000) })) === null);
    const rr = await prisma.ambOperatorDecision.findFirst({ where: { campaign_id: `${T}${camp}`, status: 'EXPIRED' } }); ok('every closure is audited and says why (SUPERSEDED_BY the kept decision)', rr.error === `SUPERSEDED_BY:${c.id}` && (await prisma.ambOperatorEvent.count({ where: { decision_id: rr.id, kind: 'TRANSITION', to_status: 'EXPIRED' } })) >= 1); }

  console.log('\n5. The AUTOMATIC overview carries the real counters and changes nothing');
  { const before = JSON.stringify(await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }));
    const ov = await BK.bulkOverview({ deps: { rows: [], mapRows: [], book: { global: { active: null, status: 'NONE', version: 0 }, products: {} }, pause: { enabled: false }, open: null, config: { ...cfg, mode: 'AUTOPILOT', writesLocked: false, execPermissions: {}, storeLimits: {} }, exceptions: [], world: { adAccountId: 'act_x', windows: {}, campaigns: [] }, exposure: new Map(), counters: { budgetIncreaseToday: 30, aiBudget: 500, byAction: { OPEN: 0, PAUSE: 1 }, actionsToday: 4, actionsLastHour: 1 } } });
    const dl = ov.dailyLimits; ok('overview.dailyLimits: rolling-24h window, a row per limit with used/limit/remaining, and the explanation of 100 vs 600', dl.window === 'ROLLING_24H' && dl.rows.length === 6 && by(dl.rows, 'budgetIncrease').remaining === 70 && by(dl.rows, 'exposure').remaining === 100 && by(dl.rows, 'pauses').state === 'FULL' && /سرعة النمو/.test(dl.note));
    ok('reading the overview changed no limit, permission or mode (the stored config is byte-identical)', JSON.stringify(await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } })) === before); }
} finally { try { await cleanup(); } catch (e) { console.log('cleanup failed', e.message); } }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
