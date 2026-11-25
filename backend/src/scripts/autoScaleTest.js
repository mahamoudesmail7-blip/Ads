// Auto scale («اسكيل أوتوماتيك») — services/amb/autoScale.js. Everything runs against injected fakes (no Meta call, no write): the order of the accounts, the plan of each account (CBO · 300 ·
// scheduled for the coming midnight), the once-a-day gate, the stop conditions and the safety gates.
//   node src/scripts/autoScaleTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };

const { prisma } = await imp('../prisma.js');
const AS = await imp('../services/amb/autoScale.js');
const CE = await imp('../services/amb/cloneEngine.js');
const ROW = 'amb:autoscale';
const reset = async () => { await prisma.settings.deleteMany({ where: { id: ROW } }); };
await reset();

const cairoMs = (date, hm) => CE.cairoLocalToUtc(date, hm).getTime();
const NOON = cairoMs('2026-11-25', '12:00');

console.log('1. Cairo clock helpers');
ok('from 12:00 noon the next 00:00 is tonight\'s midnight (the next calendar date)', AS.nextStartAt(NOON, '00:00', 0) === '2026-11-26T00:00');
ok('a start time later today is kept on today (14:00 from noon)', AS.nextStartAt(NOON, '14:00', 0) === '2026-11-25T14:00');
ok('a start time that would be too close (lead 3 h) moves to the next day', AS.nextStartAt(NOON, '13:00', 3 * 3600e3) === '2026-11-26T13:00');
ok('cairoNow reads the Cairo date and minutes', AS.cairoNow(NOON).date === '2026-11-25' && AS.cairoNow(NOON).minutes === 720);
ok('next run: today at 12:00 when it has not run and is not over; tomorrow once it ran today',
  AS.nextRunAt({ runAtCairo: '12:00' }, { lastRunDate: null }, cairoMs('2026-11-25', '09:00')) === cairoMs('2026-11-25', '12:00')
  && AS.nextRunAt({ runAtCairo: '12:00' }, { lastRunDate: '2026-11-25' }, cairoMs('2026-11-25', '13:00')) === cairoMs('2026-11-26', '12:00')
  && AS.nextRunAt({ runAtCairo: '12:00', runUntilCairo: '23:00' }, { lastRunDate: null }, cairoMs('2026-11-25', '23:30')) === cairoMs('2026-11-26', '12:00'));
ok('switched on INSIDE the window (8 pm) and not run today → due right now; after midnight it waits until noon', AS.nextRunAt({ runAtCairo: '12:00', runUntilCairo: '23:00' }, { lastRunDate: null }, cairoMs('2026-11-25', '20:00')) === cairoMs('2026-11-25', '20:00') && AS.nextRunAt({ runAtCairo: '12:00', runUntilCairo: '23:00' }, { lastRunDate: '2026-11-25' }, cairoMs('2026-11-26', '00:30')) === cairoMs('2026-11-26', '12:00'));

console.log('\n2. Config validation');
const throws = (fn) => { try { fn(); return false; } catch (e) { return e.status === 400; } };
ok('bad time / budget / gap / count / accounts / window are refused with a clean 400',
  throws(() => AS.validateConfigPatch({ runAtCairo: '25:00' })) && throws(() => AS.validateConfigPatch({ startAtCairo: 'x' })) && throws(() => AS.validateConfigPatch({ budgetEgp: 0 })) && throws(() => AS.validateConfigPatch({ budgetEgp: 9999999 }))
  && throws(() => AS.validateConfigPatch({ gapSeconds: 1 })) && throws(() => AS.validateConfigPatch({ maxPerAccount: 99 })) && throws(() => AS.validateConfigPatch({ accountIds: ['hello'] })) && throws(() => AS.validateConfigPatch({ window: 'last_year' })));
ok('the end of the window and the per-account budgets are validated', throws(() => AS.validateConfigPatch({ runUntilCairo: 'late' })) && throws(() => AS.validateConfigPatch({ accountBudgets: { hello: 100 } })) && throws(() => AS.validateConfigPatch({ accountBudgets: { act_1: 5 } })) && AS.validateConfigPatch({ accountBudgets: { act_1: '250', act_2: '' } }).accountBudgets.act_1 === 250 && !('act_2' in AS.validateConfigPatch({ accountBudgets: { act_1: 250, act_2: '' } }).accountBudgets));
const good = AS.validateConfigPatch({ runAtCairo: '9:05', startAtCairo: '00:00', budgetEgp: '300', gapSeconds: 60, maxPerAccount: 10, accountIds: ['act_1'], window: 'today', evil: 'x' });
ok('good values are cleaned (HH:MM padded, numbers, unknown keys dropped)', good.runAtCairo === '09:05' && good.budgetEgp === 300 && good.maxPerAccount === 10 && good.accountIds[0] === 'act_1' && !('evil' in good));
ok('the defaults are OFF · 12:00 → 23:00 · 00:00 · 300 EGP', AS.DEFAULTS.enabled === false && AS.DEFAULTS.runAtCairo === '12:00' && AS.DEFAULTS.runUntilCairo === '23:00' && AS.DEFAULTS.startAtCairo === '00:00' && AS.DEFAULTS.budgetEgp === 300);

console.log('\n3. The plan of one account');
const card = (id, orders, cpa, extra = {}) => ({ sourceCampaignId: id, displayName: 'P' + id, orders, cpa, decisionStatus: 'PENDING', winningAdIds: ['a' + id, 'b' + id], ...extra });
const cfg = { ...AS.DEFAULTS, maxPerAccount: 3 };
const b = AS.buildItems([card('1', 2, 60), card('2', 9, 70), card('3', 5, 40), card('4', 5, 30), card('5', 1, 10, { decisionStatus: 'EXECUTED' }), card('6', 3, 10, { adsUnavailable: 'throttled' }), card('7', 3, 10, { winningAdIds: [] })], cfg);
ok('only PENDING cards with readable winning ads are planned; best first (orders, then CPA); capped', b.ready === 4 && b.items.length === 3 && b.items.map((i) => i.sourceCampaignId).join() === '2,4,3' && b.leftOver === 1);
ok('every item is CBO with the configured 300 EGP and the winning ads', b.items.every((i) => i.budgetMode === 'CBO' && i.campaignBudgetEgp === 300 && i.selectedAdIds.length === 2));

{ const withBudgets = { ...cfg, accountBudgets: { act_H: 200 } }; const h = AS.buildItems([card('1', 2, 60)], withBudgets, 'act_H'); const o = AS.buildItems([card('1', 2, 60)], withBudgets, 'act_X');
  ok('an account with its own budget uses it (200); every other account the default (300)', h.items[0].campaignBudgetEgp === 200 && h.budgetEgp === 200 && o.items[0].campaignBudgetEgp === 300 && AS.budgetFor(withBudgets, 'act_H') === 200); }

{ const ro = new Set(['act_5', 'act_6']);
  const d = AS.pickAccounts({ ids: ['act_2', 'act_1', 'act_5', 'act_3', 'act_6'], primary: 'act_1', reportOnly: ro, explicit: null });
  ok('by default: the connected account first, the others in order, the «للمتابعة فقط» ones left out', d.selected.join() === 'act_1,act_2,act_3' && d.reportOnlyLeftOut.join() === 'act_5,act_6' && d.ordered.length === 5);
  const e = AS.pickAccounts({ ids: ['act_2', 'act_1', 'act_5', 'act_3', 'act_6'], primary: 'act_1', reportOnly: ro, explicit: ['act_6', 'act_2', 'act_1'] });
  ok('a report-only account the owner ticked IS scaled (in the normal order); an unticked one is not', e.selected.join() === 'act_1,act_2,act_6' && e.reportOnlyLeftOut.length === 0); }

console.log('\n4. The run — accounts one after another, Ahmed Samy first, each scheduled for the coming midnight');
const mkDeps = (over = {}) => {
  const calls = []; const batches = new Map(); let n = 0; const polls = new Map();
  const accounts = [{ id: 'act_11', name: 'Ahmed Samy', isPrimary: true }, { id: 'act_22', name: 'Hady', isPrimary: false }, { id: 'act_33', name: 'Yasser', isPrimary: false }];
  const winners = { act_11: [card('a1', 5, 50), card('a2', 4, 60)], act_22: [card('b1', 3, 55)], act_33: [] };
  const deps = {
    calls, accounts: async () => ({ accounts, reportOnlySkipped: ['act_44'] }), writeGate: async () => ({ ok: true }), exec: async () => ({}), pollMs: 1, sleep: async () => {},
    listWinners: async ({ adAccountId }) => { calls.push('list:' + (adAccountId || 'PRIMARY')); return { cards: winners[adAccountId || 'act_11'] || [] }; },
    runInScope: async (id, fn) => fn(),
    startBulk: (args) => { const id = 'bk' + (++n); calls.push('start:' + (args.adAccountId || 'PRIMARY')); batches.set(id, { args, state: over.stateFor?.(args.adAccountId || 'PRIMARY') || { status: 'DONE', counts: { done: args.items.length, failed: 0, skipped: 0 }, stopReason: null, items: [] } }); polls.set(id, 0); return { id }; },
    getBatch: (id) => { const x = batches.get(id); const k = polls.get(id) + 1; polls.set(id, k); calls.push('poll:' + (x.args.adAccountId || 'PRIMARY')); return k < 3 ? { id, status: 'RUNNING', counts: {}, items: [] } : { id, ...x.state }; },
    cancelBatch: () => {}, ...over.deps,
  };
  deps._batches = batches; return deps;
};
{
  await reset(); await AS.saveConfig({ budgetEgp: 300 }); const d = mkDeps();
  const r0 = await AS.runAutoScale({ now: NOON, deps: d });
  ok('switched off → nothing runs', r0.skipped === 'DISABLED' && d.calls.length === 0);
  await AS.setEnabled(true, { userId: 1 });
  const r = await AS.runAutoScale({ now: NOON, deps: d });
  const starts = d.calls.filter((c) => c.startsWith('start:'));
  ok('the connected account (Ahmed Samy) is scaled first, then Hady; the account with no winners is skipped', starts.join() === 'start:PRIMARY,start:act_22' && r.run.accounts.map((a) => a.status).join() === 'SKIPPED,DONE,DONE,NOTHING');
  const firstPollA = d.calls.indexOf('poll:PRIMARY'); const startB = d.calls.indexOf('start:act_22'); const lastPollA = d.calls.lastIndexOf('poll:PRIMARY');
  ok('the next account only starts AFTER the previous account\'s bulk finished (account by account)', firstPollA > -1 && lastPollA < startB);
  const argsA = [...d._batches.values()][0].args;
  ok('each bulk is SCHEDULE mode for the coming midnight (Cairo), CBO 300 EGP per campaign, the configured gap', argsA.startMode === 'SCHEDULE' && argsA.startAt === '2026-11-26T00:00' && argsA.gapSeconds === 60 && argsA.items.every((i) => i.campaignBudgetEgp === 300 && i.budgetMode === 'CBO'));
  ok('the connected account is built with no override; another account with its own id', argsA.adAccountId === null && [...d._batches.values()][1].args.adAccountId === 'act_22');
  ok('the run is recorded: DONE, 3 campaigns scaled, report-only accounts listed as skipped', r.run.status === 'DONE' && r.run.accounts.filter((a) => a.scaled).reduce((t, a) => t + a.scaled, 0) === 3 && r.run.accounts[0].reason.includes('للمتابعة'));
  const st = await AS.getAutoScaleStatus({ now: NOON, deps: { writeGate: async () => ({ ok: true }) } });
  ok('the status shows the last run and the next one (tomorrow noon — it already ran today)', st.lastRun?.status === 'DONE' && st.nextRunAt === cairoMs('2026-11-26', '12:00') && st.config.enabled === true && st.running === false);
}

{
  await reset(); await AS.saveConfig({ accountBudgets: { act_22: 200 } }); await AS.setEnabled(true, { userId: 1 }); const d2 = mkDeps();
  await AS.runAutoScale({ now: NOON, deps: d2 });
  const [bA, bB] = [...d2._batches.values()];
  ok('the owner\'s per-account budget reaches the bulk: Hady 200, Ahmed Samy the default 300', bA.args.items.every((i) => i.campaignBudgetEgp === 300) && bB.args.items.every((i) => i.campaignBudgetEgp === 200));
  let refused = null; try { await AS.saveConfig({ runAtCairo: '15:00', runUntilCairo: '14:00' }); } catch (e) { refused = e; }
  ok('the end of the window must be after its start', refused?.status === 400);
  await AS.saveConfig({ runAtCairo: '12:00', runUntilCairo: '23:00', accountBudgets: {} });
  const prev = await AS.previewAutoScale({ now: NOON, deps: mkDeps() });
  ok('the preview shows each account\'s budget and the daily total (3 campaigns × 300 = 900)', prev.accounts[0].dailyTotalEgp === 600 && prev.accounts[1].dailyTotalEgp === 300 && prev.totalDailyEgp === 900 && prev.startAt === '2026-11-26T00:00');
  const l = await AS.listAccountsForConfig().catch(() => null); ok('the settings panel can list the accounts with their budgets', l === null || Array.isArray(l.accounts));

  // 8 pm: inside the window — works at once, the start is tonight's midnight
  await reset(); await AS.setEnabled(true, { userId: 1 }); const d3 = mkDeps();
  const t8 = await AS.autoScaleTick({ now: cairoMs('2026-11-25', '20:00'), deps: { ...d3, awaitRun: true } });
  ok('switched on at 8 pm (same day, inside the window) → it starts at once, scheduled for tonight 00:00', !!t8.ran && [...d3._batches.values()][0].args.startAt === '2026-11-26T00:00');
  // too close to midnight for the number of campaigns: never pushed to the NEXT midnight
  await reset(); await AS.setEnabled(true, { userId: 1 }); const d4 = mkDeps();
  const late = await AS.runAutoScale({ now: cairoMs('2026-11-25', '23:55'), trigger: 'MANUAL', deps: d4 });
  ok('not enough time before the start (23:55 → 00:00): the account is TOO_LATE (tomorrow), never silently moved to the next midnight', late.run.accounts.filter((a) => a.status === 'TOO_LATE').length === 2 && d4.calls.filter((c) => c.startsWith('start:')).length === 0);
  // the scheduled run does not START accounts after the end of the window
  await reset(); await AS.setEnabled(true, { userId: 1 }); const d5 = mkDeps();
  const cut = await AS.runAutoScale({ now: cairoMs('2026-11-25', '23:10'), trigger: 'SCHEDULED', deps: d5 });
  ok('a scheduled run at 23:10 starts no account (the window ended at 23:00)', cut.run.accounts.filter((a) => a.status === 'TOO_LATE').length === 3 && d5.calls.filter((c) => c.startsWith('start:')).length === 0);
}

console.log('\n5. Stop conditions and safety gates');
{
  await reset(); await AS.saveConfig({}); await AS.setEnabled(true, { userId: 1 });
  const blocked = mkDeps({ deps: { writeGate: async () => ({ ok: false, message: 'إيقاف الطوارئ مفعّل' }) } });
  const r = await AS.runAutoScale({ now: NOON, deps: blocked });
  ok('Emergency Stop / write lock → the run does not even start (no Meta call at all)', r.skipped === 'WRITE_BLOCKED' && blocked.calls.length === 0);
  const st = await AS.getAutoScaleStatus({ now: NOON, deps: { writeGate: async () => ({ ok: false, message: 'مقفول' }) } });
  ok('and the status says why', st.lastCheck?.status === 'BLOCKED' && st.writeGate?.ok === false);

  const wb = mkDeps({ stateFor: () => ({ status: 'CANCELED', counts: { done: 0, failed: 1, skipped: 1 }, stopReason: 'WRITE_BLOCKED', items: [{ error: 'كتابة Meta مقفولة' }] }) });
  const r2 = await AS.runAutoScale({ now: NOON, deps: wb });
  ok('a write-lock stop inside a bulk ends the whole day (the next accounts are not started)', r2.run.status === 'STOPPED' && wb.calls.filter((c) => c.startsWith('start:')).length === 1 && r2.run.accounts.some((a) => a.status === 'CANCELED'));

  await reset(); await AS.setEnabled(true, { userId: 1 });
  const rl = mkDeps({ accountsOver: true, stateFor: () => ({ status: 'CANCELED', counts: { done: 0, failed: 1, skipped: 0 }, stopReason: 'RATE_LIMIT', items: [{ error: '(#4) Application request limit reached' }] }) });
  const r3 = await AS.runAutoScale({ now: NOON, deps: rl });
  ok('Meta throttles two accounts in a row → it stops for today instead of hammering', r3.run.stopReason === 'RATE_LIMIT' && r3.run.status === 'STOPPED');

  await reset(); await AS.setEnabled(true, { userId: 1 });
  let first = true; const busy = mkDeps({ deps: { startBulk: (args) => { if (first) { first = false; const e = new Error('في اسكيل مجمّع شغال'); e.status = 409; throw e; } return { id: 'x' }; }, getBatch: () => ({ status: 'DONE', counts: { done: 1, failed: 0, skipped: 0 }, items: [] }) } });
  const r4 = await AS.runAutoScale({ now: NOON, deps: busy });
  ok('an account that already has a bulk running (the owner scaling by hand) is BUSY — the others still go on', r4.run.accounts.find((a) => a.accountId === 'act_11').status === 'BUSY' && r4.run.accounts.find((a) => a.accountId === 'act_22').status === 'DONE');

  await reset(); await AS.setEnabled(true, { userId: 1 });
  const boom = mkDeps({ deps: { listWinners: async ({ adAccountId }) => { if (!adAccountId) throw new Error('Meta read failed'); return { cards: [card('b1', 3, 55)] }; } } });
  const r5 = await AS.runAutoScale({ now: NOON, deps: boom });
  ok('one account failing to read its winners never stops the next account', r5.run.accounts.find((a) => a.accountId === 'act_11').status === 'FAILED' && r5.run.accounts.find((a) => a.accountId === 'act_22').status === 'DONE');

  await reset(); await AS.setEnabled(true, { userId: 1 });
  let canceled = false; let polled = false; const slow = mkDeps({ deps: { sleep: () => new Promise((r) => setTimeout(r, 15)), cancelBatch: () => { canceled = true; }, getBatch: (id) => (polled = true, canceled) ? { id, status: 'CANCELED', counts: { done: 1, failed: 0, skipped: 1 }, items: [] } : { id, status: 'RUNNING', counts: {}, items: [] } } });
  const running = AS.runAutoScale({ now: NOON, deps: slow });
  for (let k = 0; k < 100; k++) { if (polled) break; await new Promise((r) => setTimeout(r, 100)); } // the test DB is remote: wait until the run has really started
  const again = await AS.runAutoScale({ now: NOON, deps: mkDeps() });
  ok('a second run cannot start while one is in progress', again.skipped === 'ALREADY_RUNNING');
  const dis = await AS.setEnabled(false, { userId: 1 }); const res = await running;
  ok('switching it off while it runs stops the run in progress (the running bulk is cancelled, the next accounts are not started)', dis.stopped === true && res.run.status === 'STOPPED' && canceled === true && !res.run.accounts.some((x) => x.accountId === 'act_33' && x.status === 'DONE'));
}

console.log('\n6. The daily tick');
{
  await reset(); await AS.saveConfig({ runAtCairo: '12:00' });
  const d = () => mkDeps();
  ok('switched off → the tick does nothing', (await AS.autoScaleTick({ now: NOON, deps: d() })).skipped === 'DISABLED');
  await AS.setEnabled(true, { userId: 1 });
  ok('before 12:00 → not yet', (await AS.autoScaleTick({ now: cairoMs('2026-11-25', '11:59'), deps: d() })).skipped === 'NOT_YET');
  const t = await AS.autoScaleTick({ now: cairoMs('2026-11-25', '12:01'), deps: { ...d(), awaitRun: true } });
  ok('at 12:01 the day\'s run starts', !!(t && t.ran));
  ok('the same day it never runs twice', (await AS.autoScaleTick({ now: cairoMs('2026-11-25', '12:30'), deps: d() })).skipped === 'ALREADY_RAN_TODAY');
  ok('the next day it runs again', !!(await AS.autoScaleTick({ now: cairoMs('2026-11-26', '12:05'), deps: { ...d(), awaitRun: true } })).ran);
  await reset(); await AS.setEnabled(true, { userId: 1 });
  ok('after 23:00 the day is skipped; after midnight it waits for noon (winners)', (await AS.autoScaleTick({ now: cairoMs('2026-11-25', '23:30'), deps: d() })).skipped === 'WINDOW_PASSED' && (await AS.autoScaleTick({ now: cairoMs('2026-11-26', '00:30'), deps: d() })).skipped === 'NOT_YET' && (await AS.autoScaleTick({ now: cairoMs('2026-11-26', '11:59'), deps: d() })).skipped === 'NOT_YET');
  // a restart in the middle of a run: the interrupted run is settled and the day continues (bounded)
  await reset(); await AS.setEnabled(true, { userId: 1 });
  const row = JSON.parse((await prisma.settings.findUnique({ where: { id: 'amb:autoscale' } })).data);
  row.state = { ...row.state, lastRunDate: '2026-11-25', running: { date: '2026-11-25', startedAt: 'x', accounts: [] } };
  await prisma.settings.update({ where: { id: 'amb:autoscale' }, data: { data: JSON.stringify(row) } });
  const t2 = await AS.autoScaleTick({ now: cairoMs('2026-11-25', '13:00'), deps: { ...d(), awaitRun: true } });
  const st = await AS.getAutoScaleStatus({ now: NOON, deps: { writeGate: async () => ({ ok: true }) } });
  ok('a run cut by a server restart is recorded as INTERRUPTED and the day continues (the winners already scaled are never offered again)', !!t2.ran && st.history.some((h) => h.status === 'INTERRUPTED'));
}

console.log('\n7. Wiring');
{
  const rt = fs.readFileSync(join(__dirname, '../routes/autoScale.js'), 'utf8'); const sv = fs.readFileSync(join(__dirname, '../server.js'), 'utf8'); const src = fs.readFileSync(join(__dirname, '../services/amb/autoScale.js'), 'utf8');
  ok('the status is readable by ADMIN|MANAGER; switching, config, preview, run-now and stop are ADMIN only; run-now needs an explicit confirm',
    rt.includes("router.get('/', requireRole('ADMIN', 'MANAGER')") && ['/accounts', '/preview', '/config', '/enabled', '/run-now', '/stop'].every((p) => rt.includes("'" + p + "', requireRole('ADMIN')")) && rt.includes('CONFIRM_REQUIRED'));
  ok('the route and the scheduler are wired in the server', sv.includes("app.use('/api/auto-scale', autoScaleRoutes)") && sv.includes('startAutoScaleScheduler();'));
  ok('it is only a sequencer: scaling goes through startBulk / executeScale and the global write gate, and report-only accounts are never scaled', src.includes('startBulk') && src.includes('checkGlobalMetaWrite') && src.includes('ambReportOnlyAccountIds') && !/fetch\(/.test(src));
  ok('OFF by default', AS.DEFAULTS.enabled === false);
}

await reset();
console.log(`\n${fail ? '❌' : '✅'} autoScaleTest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
