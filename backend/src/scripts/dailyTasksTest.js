// 🧪 Daily Tasks (تاسكات اليوم) — fair distribution, roll-over of what was not done, auto-resolve, permissions, activity log, per-person numbers, scheduler.
//   node src/scripts/dailyTasksTest.js     (no database needed: the settings rows are an in-memory map)
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
const { prisma } = await imp('../prisma.js');
const mem = new Map();
Object.defineProperty(prisma, 'settings', { configurable: true, value: {
  findUnique: async ({ where }) => (mem.has(where.id) ? { id: where.id, data: mem.get(where.id) } : null),
  upsert: async ({ where, create, update }) => { mem.set(where.id, mem.has(where.id) ? update.data : create.data); return {}; },
  findMany: async ({ where }) => { const id = where.id; return [...mem.entries()].filter(([k]) => (id.startsWith ? k.startsWith(id.startsWith) : (k >= id.gte && k <= id.lte))).map(([k, v]) => ({ id: k, data: v })); },
} });
const C = await imp('../services/dailyTasks/core.js'); const G = await imp('../services/dailyTasks/generators.js'); const E = await imp('../services/dailyTasks/engine.js'); const SC = await imp('../services/dailyTasks/scheduler.js');
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const members = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `P${i}`, active: true, off: [] }));
const task = (o = {}) => C.makeTask({ type: 'ZERO_ORDERS', key: o.key || `k${Math.random()}`, title: o.title || 't', priority: o.priority || 'MED', product: o.product || null }, { date: '2026-11-09' });

console.log('\n1. fair distribution');
{
  const ts = Array.from({ length: 12 }, (_, i) => task({ key: `k${i}`, priority: ['HIGH', 'MED', 'LOW'][i % 3] })); C.distribute(ts, { members: members(4), date: '2026-11-09' });
  const per = members(4).map((m) => ts.filter((t) => t.assigneeId === m.id));
  ok('12 tasks over 4 people → 3 each', per.every((p) => p.length === 3), per.map((p) => p.length));
  const w = per.map((p) => p.reduce((a, t) => a + C.weightOf(t), 0)); ok('and the priority weight is even too (±2)', Math.max(...w) - Math.min(...w) <= 2, w);
  const odd = Array.from({ length: 10 }, (_, i) => task({ key: `o${i}` })); C.distribute(odd, { members: members(4), date: '2026-11-09' });
  const cnt = members(4).map((m) => odd.filter((t) => t.assigneeId === m.id).length); ok('10 over 4 → counts differ by at most 1', Math.max(...cnt) - Math.min(...cnt) <= 1, cnt);
  const same = [task({ key: 'a', product: { id: 7, name: 'X' } }), task({ key: 'b', product: { id: 7, name: 'X' } }), task({ key: 'c', product: { id: 7, name: 'X' } }), task({ key: 'd' }), task({ key: 'e' }), task({ key: 'f' })];
  C.distribute(same, { members: members(3), date: '2026-11-09' }); ok('every task of ONE product goes to the same person', new Set(same.slice(0, 3).map((t) => t.assigneeId)).size === 1);
  const heavy = members(3); const carried = [task({ key: 'c1' }), task({ key: 'c2' }), task({ key: 'c3' })]; carried.forEach((t) => { t.assigneeId = 'm0'; });
  const fresh = Array.from({ length: 4 }, (_, i) => task({ key: `f${i}` })); C.distribute(fresh, { members: heavy, existing: carried, date: '2026-11-09' });
  ok('a person already carrying yesterday’s work gets fewer NEW tasks (totals even out)', fresh.filter((t) => t.assigneeId === 'm0').length < fresh.filter((t) => t.assigneeId === 'm1').length || fresh.filter((t) => t.assigneeId === 'm0').length === 0);
  ok('a person on a day off never receives work', C.availableMembers([{ id: 'a', active: true, off: ['2026-11-09'] }, { id: 'b', active: true, off: [] }, { id: 'c', active: false }], '2026-11-09').map((m) => m.id).join() === 'b');
  ok('nobody available → tasks stay unassigned (no crash)', C.distribute([task()], { members: [] })[0].assigneeId === null);
}

console.log('\n2. roll-over (what was not done is added to tomorrow, same person)');
{
  const mk = (status, extra = {}) => ({ ...task({ key: `r-${status}${Math.random()}`, title: status }), status, assigneeId: 'm1', ...extra });
  const prev = [mk('PENDING'), mk('IN_PROGRESS'), mk('NOT_DONE'), mk('DONE'), mk('CANCELLED'), mk('AUTO_RESOLVED'), mk('PENDING', { carried: true })];
  const r = C.rollOver(prev, { date: '2026-11-10', members: members(3) });
  ok('open + «ماتعملش» tasks come over; done / cancelled / auto-resolved / already-carried do not', r.carriedIn.map((t) => t.title).sort().join() === 'IN_PROGRESS,NOT_DONE,PENDING', r.carriedIn.map((t) => t.title));
  ok('they stay with the same person, reset to PENDING, carryCount +1, source CARRIED', r.carriedIn.every((t) => t.assigneeId === 'm1' && t.status === 'PENDING' && t.carryCount === 1 && t.source === 'CARRIED'));
  ok('the original day keeps the facts: the carried rows are reported back to be marked', r.marked.length === 3);
  const old = [{ ...mk('PENDING'), carryCount: C.MAX_CARRY - 1, priority: 'LOW' }]; ok('after 3 roll-overs the task becomes HIGH', C.rollOver(old, { date: 'x', members: members(2) }).carriedIn[0].priority === 'HIGH');
  ok('a person who left → the task comes over unassigned (the engine distributes it)', C.rollOver([mk('PENDING', { assigneeId: 'gone' })], { date: 'x', members: members(2) }).carriedIn[0].assigneeId === null);
}

console.log('\n3. dedupe + auto-resolve');
{
  const ex = [{ ...task({ key: 'alert:1' }) }, { ...task({ key: 'alert:2' }), status: 'DONE' }];
  ok('a problem that already has a task today (open or done) is not duplicated', C.dedupeCandidates([{ key: 'alert:1' }, { key: 'alert:2' }, { key: 'alert:3' }, { key: 'alert:3' }], ex).map((c) => c.key).join() === 'alert:3');
  const open = [{ ...task({ key: 'alert:1' }), id: 'a' }, { ...task({ key: 'alert:9', }), id: 'b', type: 'SCALE' }, { ...task({ key: 'alert:5' }), id: 'c', source: 'MANUAL' }];
  ok('vanished problem → auto-resolved ONLY for generators that ran fine, never for manual tasks', C.findAutoResolved(open, [], ['ZERO_ORDERS']).join() === 'a');
  ok('a problem still alive is left alone', C.findAutoResolved(open, ['alert:1'], ['ZERO_ORDERS', 'SCALE']).join() === 'b');
}

console.log('\n4. sources → candidates');
{
  const c = G.candidatesFromAlerts([{ id: 'zero:1', kind: 'ZERO_ORDERS', severity: 'CRITICAL', title: 'X صرفت 300 من غير أوردر', detail: 'd', facts: [], action: 'أوقفها', entity: { productId: 5, productName: 'X', campaignId: 'c1', adAccountId: 'act_1' } }, { id: 'meta-sync-stale', kind: 'SYNC', severity: 'WARNING', title: 's' }, { id: 'stock:5', kind: 'STOCK', severity: 'WARNING', title: 'st', entity: { productId: 5, productName: 'X' } }]);
  ok('alerts: zero-orders (CRITICAL→HIGH) and stock become tasks; system alerts (sync) do not', c.length === 2 && c[0].priority === 'HIGH' && c[0].type === 'ZERO_ORDERS' && c[1].priority === 'MED' && !c.some((x) => x.type === 'SYNC'));
  ok('the task keeps product / campaign / account so it is grouped by product', c[0].product.id === 5 && c[0].campaignId === 'c1' && c[0].accountId === 'act_1');
  const w = G.candidatesFromWinners([{ decisionStatus: 'PENDING', sourceCampaignId: 'a', displayName: 'A', orders: 5, cpa: 40, spend: 200, recommendation: 'r' }, { decisionStatus: 'EXECUTED', sourceCampaignId: 'b', displayName: 'B' }, { decisionStatus: 'FAILED', sourceCampaignId: 'c', displayName: 'C', orders: 3, lastHint: { title: 'Throttle', action: 'استنى' } }]);
  ok('winners: pending + failed become tasks, executed does not; failed is HIGH with the real hint', w.length === 2 && w.find((x) => x.key === 'scale:c').priority === 'HIGH' && /Throttle/.test(w.find((x) => x.key === 'scale:c').detail));
  ok('open plan → one task only when it has selected campaigns', G.candidateFromPlan({ plan_date: '2026-11-09', items: [{ selected: true }, { selected: false }] }).length === 1 && G.candidateFromPlan({ plan_date: 'x', items: [{ selected: false }] }).length === 0);
  const rt = G.candidatesFromRoutines([{ id: 'r1', title: 'افحص الرصيد', mode: 'ALL', days: [] }, { id: 'r2', title: 'تقرير', mode: 'SPREAD', days: [1] }], { date: '2026-11-09', dow: 0, members: members(3) });
  ok('routines: «ALL» = a copy for each person, day filter respected', rt.length === 3 && rt.every((x) => x.assigneeId));
}

console.log('\n5. a full day through the engine');
const A = { getAlerts: async () => ({ unavailable: [], alerts: [
  { id: 'zero:1', kind: 'ZERO_ORDERS', severity: 'CRITICAL', title: 'P1 صرف 400 بدون أوردر', facts: [], entity: { productId: 1, productName: 'P1' } },
  { id: 'zero:2', kind: 'ZERO_ORDERS', severity: 'WARNING', title: 'P2 صرف 200 بدون أوردر', facts: [], entity: { productId: 2, productName: 'P2' } },
  { id: 'stock:3', kind: 'STOCK', severity: 'WARNING', title: 'P3 مخزون قليل', facts: [], entity: { productId: 3, productName: 'P3' } },
  { id: 'cpa:4', kind: 'CPA', severity: 'CRITICAL', title: 'P4 CPA عالي', facts: [], entity: { productId: 4, productName: 'P4' } },
  { id: 'zero:5', kind: 'ZERO_ORDERS', severity: 'WARNING', title: 'P5', facts: [], entity: { productId: 5, productName: 'P5' } },
] }), getWinners: async () => ({ connected: true, cards: [{ decisionStatus: 'PENDING', sourceCampaignId: 'w1', displayName: 'W1', orders: 6, cpa: 30, spend: 180, recommendation: 'r' }] }), getBatches: async () => [], getPlan: async () => null };
const admin = { id: 1, name: 'Hady', role: 'ADMIN', is_owner: false }; const day1 = '2026-11-09'; const day2 = '2026-11-10';
const now1 = new Date('2026-11-09T09:00:00Z'); const now2 = new Date('2026-11-10T09:00:00Z');
{
  const cfg0 = await E.getConfig(); ok('first use seeds the 4 media buyers', cfg0.team.map((m) => m.name).join() === 'Ahmed Samy,Samy,Mohamed 3sam,Hady');
  const d = await E.generateDay(day1, { deps: A, now: now1 }); const v = await E.getDayView(day1, admin);
  ok('the day is generated and every task has an owner', v.tasks.length === 6 && v.tasks.every((t) => t.assigneeId));
  const cnt = v.team.map((m) => v.tasks.filter((t) => t.assigneeId === m.id).length); ok('6 tasks over 4 people → 2/2/1/1', Math.max(...cnt) - Math.min(...cnt) <= 1, cnt);
  ok('every assignment is in the activity log', v.log.filter((l) => l.action === 'ASSIGNED').length === 6);
  const again = await E.generateDay(day1, { deps: A, now: now1 }); ok('generating again adds nothing (idempotent)', again.tasks.length === 6);
  const gone = { ...A, getAlerts: async () => ({ unavailable: [], alerts: (await A.getAlerts()).alerts.filter((a) => a.id !== 'zero:2') }) };
  const r2 = await E.generateDay(day1, { deps: gone, now: now1 }); ok('a problem that disappeared is marked «اتحل لوحده» with a log line', r2.tasks.find((t) => t.key === 'alert:zero:2').status === 'AUTO_RESOLVED' && r2.log.some((l) => l.action === 'AUTO_RESOLVED'));
  const broken = { ...A, getAlerts: async () => { throw new Error('meta down'); } }; const r3 = await E.generateDay(day1, { deps: broken, now: now1 });
  ok('a FAILED read never resolves anything (the alerts tasks stay open)', r3.tasks.filter((t) => t.key.startsWith('alert:') && t.status === 'PENDING').length === 4, r3.tasks.map((t) => t.status));
  await E.generateDay(day1, { deps: A, now: now1 });
}
console.log('\n6. people act on tasks');
{
  const v = await E.getDayView(day1, admin); const mine = v.tasks.find((t) => t.key === 'alert:zero:1'); const other = v.tasks.find((t) => t.assigneeId !== mine.assigneeId && C.isOpen(t));
  const cfg = await E.getConfig(); const owner = cfg.team.find((m) => m.id === mine.assigneeId);
  await E.updateMember(owner.id, { userId: 77 }); const emp = { id: 77, name: 'Buyer', role: 'EMPLOYEE' }; const stranger = { id: 88, name: 'Other', role: 'EMPLOYEE' };
  ok('an employee cannot touch someone else’s task', (await rejects(() => E.actOnTask(day1, mine.id, 'done', {}, stranger)))?.status === 403);
  ok('…nor reassign / cancel (manager only)', (await rejects(() => E.actOnTask(day1, mine.id, 'cancel', {}, emp)))?.status === 403 && (await rejects(() => E.actOnTask(day1, mine.id, 'assign', { memberId: 'x' }, emp)))?.status === 403);
  await E.actOnTask(day1, mine.id, 'start', {}, emp); let d = await E.actOnTask(day1, mine.id, 'done', { note: 'وقفت الحملة' }, emp);
  const t = d.tasks.find((x) => x.id === mine.id); ok('start → done is recorded with who / when / note', t.status === 'DONE' && t.doneBy === 'Buyer' && t.note === 'وقفت الحملة' && !!t.startedAt && !!t.doneAt);
  ok('and logged (STARTED, DONE)', d.log.some((l) => l.action === 'STARTED') && d.log.some((l) => l.action === 'DONE'));
  d = await E.actOnTask(day1, other.id, 'notdone', { reason: 'NEEDS_APPROVAL', note: 'مستني المدير' }, admin);
  ok('«ماتعملش» keeps the reason', d.tasks.find((x) => x.id === other.id).status === 'NOT_DONE' && d.tasks.find((x) => x.id === other.id).reason === 'NEEDS_APPROVAL');
  const target = cfg.team.find((m) => m.id !== other.assigneeId);
  d = await E.actOnTask(day1, other.id, 'assign', { memberId: target.id }, admin); ok('manager reassigns (logged with from → to)', d.tasks.find((x) => x.id === other.id).assigneeId === target.id && d.log.some((l) => l.action === 'REASSIGNED' && /اتحوّلت/.test(l.text)));
  const mt = await E.addManualTask(day1, { title: 'راجع كرياتيف المنتج X', priority: 'HIGH' }, admin); ok('manual task is added and distributed', mt.tasks.some((x) => x.title === 'راجع كرياتيف المنتج X' && x.assigneeId));
  ok('an empty manual task is refused', (await rejects(() => E.addManualTask(day1, { title: '  ' }, admin)))?.status === 400);
}

console.log('\n7. next day: what was not done is added (same person), new work is balanced around it');
{
  const before = await E.getDayView(day1, admin); const open = before.tasks.filter((t) => C.isOpen(t) || t.status === 'NOT_DONE');
  const next = await E.generateDay(day2, { deps: A, now: now2 });
  const carried = next.tasks.filter((t) => t.source === 'CARRIED'); ok('every unfinished task of yesterday is on today’s list', carried.length === open.length, `${carried.length} vs ${open.length}`);
  ok('each one is with the SAME person who did not do it', carried.every((c) => open.find((o) => o.id === c.carriedFromId)?.assigneeId === c.assigneeId));
  const y = await E.getDayView(day1, admin); ok('yesterday keeps its own truth: still «not done», flagged as carried', y.tasks.filter((t) => t.carried).length === open.length && y.tasks.filter((t) => t.carried).every((t) => t.status !== 'DONE'));
  ok('the finished task did NOT come over', !next.tasks.some((t) => t.key === 'alert:zero:1' && t.source === 'CARRIED'));
  const v = await E.getDayView(day2, admin); const tot = v.team.map((m) => v.tasks.filter((t) => t.assigneeId === m.id && C.isOpen(t)).length);
  ok('today’s totals are even (carried work counted) — max-min ≤ 2', Math.max(...tot) - Math.min(...tot) <= 2, tot);
}

console.log('\n8. team: add / day off / remove');
{
  const p = await E.addMember({ name: 'Mostafa' }); ok('adding a person is one call', !!p.id && (await E.getConfig()).team.some((m) => m.name === 'Mostafa'));
  ok('a duplicate name is refused', (await rejects(() => E.addMember({ name: 'mostafa' })))?.status === 409);
  const reb = await E.rebalance(day2, admin); const v = await E.getDayView(day2, admin);
  ok('«إعادة توزيع» brings the new person in', v.tasks.some((t) => t.assigneeId === p.id));
  const mine = v.tasks.filter((t) => t.assigneeId === p.id && C.isOpen(t)).length;
  await E.setDayOff(p.id, day2, true, admin); const v2 = await E.getDayView(day2, admin);
  ok('marking a day off moves that person’s open tasks to the others', v2.tasks.filter((t) => t.assigneeId === p.id && C.isOpen(t)).length === 0 && mine > 0, mine);
  await E.setDayOff(p.id, day2, false, admin); await E.removeMember(p.id, admin);
  ok('removing a person deactivates them (history stays) and nothing stays on them', !(await E.getConfig()).team.find((m) => m.id === p.id).active && (await E.getDayView(day2, admin)).tasks.filter((t) => t.assigneeId === p.id && C.isOpen(t)).length === 0);
}

console.log('\n9. follow-up numbers');
{
  const rep = await E.getReport(day1, day2); ok('the report has a row per person with done / not done / missed / rate', rep.perMember.length >= 4 && rep.perMember.every((r) => 'done' in r && 'notDone' in r && 'missed' in r && 'rate' in r));
  const tot = rep.perMember.reduce((a, r) => a + r.assigned, 0); ok('assigned totals match the tasks of both days', tot === rep.days.reduce((a, d) => a + d.total, 0), `${tot}`);
  ok('a bad range is refused', (await rejects(() => E.getReport('2026-12-01', '2026-11-01')))?.status === 400 && (await rejects(() => E.getReport('2026-01-01', '2026-11-01')))?.status === 400);
  const txt = await E.getEodText(day1); ok('the end-of-day text lists every person with ✅/❌', /تقرير تاسكات يوم 2026-11-09/.test(txt) && /✅/.test(txt) && /❌/.test(txt) && /👤/.test(txt));
}

console.log('\n10. scheduler');
{
  mem.clear(); const calls = [];
  const gen = async (d) => { calls.push(d); await E.generateDay(d, { deps: A, now: new Date('2026-11-12T10:00:00Z') }); };
  ok('before the configured time → waits', (await SC.tick({ now: new Date('2026-11-11T22:02:00Z'), gen })).skipped === 'too-early'); // 00:02 Cairo
  ok('after it → the day is built', (await SC.tick({ now: new Date('2026-11-11T22:10:00Z'), gen })).built === '2026-11-12' && calls.length === 1);
  ok('already built and fresh → nothing', (await SC.tick({ now: new Date('2026-11-12T10:20:00Z'), gen })).skipped === 'fresh' || (await SC.tick({ now: new Date('2026-11-12T10:20:00Z'), gen })).refreshed);
  await E.saveOptions({ autoGenerate: false }); ok('switched off → never builds', (await SC.tick({ now: new Date('2026-11-13T22:10:00Z'), gen })).skipped === 'off');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
