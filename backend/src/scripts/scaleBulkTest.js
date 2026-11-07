// 🧪 Bulk Scale — the sequencer around executeScale (mocked): validation, one-at-a-time order, gap between campaigns, per-item failure isolation, cancel, no overlap.
//   node src/scripts/scaleBulkTest.js
import './_testGuard.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const SB = await import(pathToFileURL(join(__dirname, '../services/amb/scaleBulk.js')).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitDone = async (id) => { for (let i = 0; i < 200; i++) { const b = SB.getBatch(id); if (b && b.status !== 'RUNNING') return b; await wait(5); } return SB.getBatch(id); };

const cbo = (id, extra = {}) => ({ sourceCampaignId: id, label: `camp ${id}`, budgetMode: 'CBO', selectedAdIds: ['a1', 'a2'], campaignBudgetEgp: 300, ...extra });
const abo = (id) => ({ sourceCampaignId: id, label: `camp ${id}`, budgetMode: 'ABO', adSets: [{ dailyBudgetEgp: 150, selectedAdIds: ['a1'] }] });

console.log('\n1. validation (nothing starts when anything is wrong)');
SB._resetForTests();
let calls = 0; const exec = async () => { calls++; return {}; };
ok('empty selection rejected', throws(() => SB.startBulk({ items: [] }, { exec })) !== null);
ok('more than the max rejected', throws(() => SB.startBulk({ items: Array.from({ length: SB.MAX_ITEMS + 1 }, (_, i) => cbo(String(i))) }, { exec })) !== null);
ok('duplicate campaign rejected', throws(() => SB.startBulk({ items: [cbo('1'), cbo('1')] }, { exec }))?.message.includes('متكرر'));
ok('CBO without budget rejected', throws(() => SB.startBulk({ items: [cbo('1', { campaignBudgetEgp: 0 })] }, { exec }))?.message.includes('ميزانية'));
ok('CBO without ads rejected', throws(() => SB.startBulk({ items: [cbo('1', { selectedAdIds: [] })] }, { exec }))?.message.includes('إعلانًا'));
ok('ABO slot without budget rejected', throws(() => SB.startBulk({ items: [{ ...abo('1'), adSets: [{ dailyBudgetEgp: 0, selectedAdIds: ['a'] }] }] }, { exec })) !== null);
ok('missing budget mode rejected', throws(() => SB.startBulk({ items: [{ sourceCampaignId: '1' }] }, { exec })) !== null);
ok('gap below the minimum rejected', throws(() => SB.startBulk({ items: [cbo('1')], gapSeconds: 5 }, { exec })) !== null);
ok('one bad campaign among good ones → the whole request is rejected, exec never called', throws(() => SB.startBulk({ items: [cbo('1'), cbo('2', { campaignBudgetEgp: -1 })] }, { exec })) !== null && calls === 0);

console.log('\n2. schedule must leave room for the last campaign');
const now = Date.UTC(2026, 10, 7, 10, 0, 0);
const toUtc = (d, t) => { const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return new Date(Date.UTC(y, m - 1, dd, h - 2, mi)); };
ok('start time too soon for 3 campaigns × 60s → rejected', throws(() => SB.startBulk({ items: [cbo('1'), cbo('2'), cbo('3')], startMode: 'SCHEDULE', startAt: '2026-11-07T12:02' }, { exec, now: () => now, toUtc }))?.message.includes('قريب'));
ok('invalid date rejected', throws(() => SB.startBulk({ items: [cbo('1')], startMode: 'SCHEDULE', startAt: 'x' }, { exec, now: () => now, toUtc })) !== null);
SB._resetForTests();
const sched = SB.startBulk({ items: [cbo('1'), cbo('2')], startMode: 'SCHEDULE', startAt: '2026-11-08T00:00', gapSeconds: 30 }, { exec: async () => ({}), now: () => now, toUtc, sleep: async () => {} });
ok('a far enough schedule is accepted', sched.status === 'RUNNING' && sched.startMode === 'SCHEDULE');
await waitDone(sched.id);

console.log('\n3. runs one at a time, in order, with the gap between them');
SB._resetForTests();
const log = []; let running = 0; let maxRunning = 0; const sleeps = [];
const exec3 = async (a) => { running++; maxRunning = Math.max(maxRunning, running); log.push(a.sourceCampaignId); await wait(5); running--; return { scaleCampaignName: `${a.sourceCampaignId} - Scale`, adSetsCreated: 1, adsCreated: 2, decisionId: Number(a.sourceCampaignId) }; };
const b3 = SB.startBulk({ items: [cbo('1'), abo('2'), cbo('3')], gapSeconds: 60 }, { exec: exec3, sleep: async (ms) => { sleeps.push(ms); } });
ok('returns immediately as RUNNING (does not block on Meta)', b3.status === 'RUNNING' && b3.counts.total === 3);
const d3 = await waitDone(b3.id);
ok('all three done, in the selected order', d3.status === 'DONE' && log.join(',') === '1,2,3' && d3.counts.done === 3);
ok('never two at the same time', maxRunning === 1);
ok('a 60s wait between campaigns (2 waits for 3 campaigns, none after the last)', sleeps.length === 2 && sleeps.every((ms) => ms === 60000));
ok('the result of each is kept', d3.items[1].result?.scaleCampaignName === '2 - Scale' && d3.items[0].result.adsCreated === 2);

console.log('\n4. exec receives exactly the approved config (budget mode, budget, ads, start mode, account)');
SB._resetForTests();
const seen = [];
const b4 = SB.startBulk({ items: [cbo('1', { campaignBudgetEgp: 450, selectedAdIds: ['x', 'x', 'y'] }), abo('2')], startMode: 'RUN_NOW', windowName: 'today', userId: 7, adAccountId: 'act_9' }, { exec: async (a) => { seen.push(a); return {}; }, sleep: async () => {} });
await waitDone(b4.id);
ok('CBO args', seen[0].budgetMode === 'CBO' && seen[0].campaignBudgetEgp === 450 && seen[0].selectedAdIds.join() === 'x,y' && seen[0].startMode === 'RUN_NOW' && seen[0].userId === 7 && seen[0].adAccountId === 'act_9');
ok('ABO args', seen[1].budgetMode === 'ABO' && seen[1].adSets[0].dailyBudgetEgp === 150 && seen[1].selectedAdIds === undefined);

console.log('\n5. one failure never stops the rest');
SB._resetForTests();
const b5 = SB.startBulk({ items: [cbo('1'), cbo('2'), cbo('3')] }, { exec: async (a) => { if (a.sourceCampaignId === '2') throw new Error('Meta rejected'); return {}; }, sleep: async () => {} });
const d5 = await waitDone(b5.id);
ok('1 and 3 done, 2 failed with its reason', d5.items[0].status === 'DONE' && d5.items[1].status === 'FAILED' && d5.items[1].error === 'Meta rejected' && d5.items[2].status === 'DONE');
ok('the batch finishes (DONE) with counts', d5.status === 'DONE' && d5.counts.failed === 1 && d5.counts.done === 2);

console.log('\n6. a second bulk cannot start while one is running; it can after');
SB._resetForTests();
let release; const gate = new Promise((r) => { release = r; });
const b6 = SB.startBulk({ items: [cbo('1')] }, { exec: async () => { await gate; return {}; }, sleep: async () => {} });
ok('second start while running → 409', throws(() => SB.startBulk({ items: [cbo('9')] }, { exec }))?.status === 409);
ok('currentBatch is the running one', SB.currentBatch()?.id === b6.id);
release(); await waitDone(b6.id);
ok('after it finishes a new one is allowed', throws(() => { const x = SB.startBulk({ items: [cbo('9')] }, { exec: async () => ({}), sleep: async () => {} }); return x; }) === null);
await wait(20);

console.log('\n7. cancel stops the campaigns that have not started (the finished ones stay)');
SB._resetForTests();
let wake; const wakeP = new Promise((r) => { wake = r; });
const done7 = [];
const b7 = SB.startBulk({ items: [cbo('1'), cbo('2'), cbo('3')] }, { exec: async (a) => { done7.push(a.sourceCampaignId); return {}; }, sleep: async () => { await wakeP; } });
await wait(20);
SB.cancelBatch(b7.id); wake();
const d7 = await waitDone(b7.id);
ok('first done, the others canceled and never executed', done7.join() === '1' && d7.items[1].status === 'CANCELED' && d7.items[2].status === 'CANCELED' && d7.status === 'CANCELED' && d7.counts.skipped === 2);
ok('unknown batch → 404', throws(() => SB.cancelBatch('nope'))?.status === 404);
ok('latestBatch returns the most recent', SB.latestBatch()?.id === b7.id);

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
