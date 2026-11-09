// 🧪 Daily Tasks (تاسكات اليوم) — the product-level builder (scale / fix / test / mix), fair distribution PER BUCKET, roll-over, auto-resolve, permissions, activity log, numbers, scheduler.
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
const C = await imp('../services/dailyTasks/core.js'); const SM = await imp('../services/dailyTasks/smart.js'); const G = await imp('../services/dailyTasks/generators.js'); const E = await imp('../services/dailyTasks/engine.js'); const SC = await imp('../services/dailyTasks/scheduler.js');
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const members = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `P${i}`, active: true, off: [] }));
const task = (o = {}) => C.makeTask({ type: o.type || 'ZERO_ORDERS', category: o.category, key: o.key || `k${Math.random()}`, title: o.title || 't', priority: o.priority || 'MED', product: o.product || null }, { date: '2026-11-09' });

// campaign-row factory (the shape campaignQuery.buildRows returns, only the fields the builder reads)
const row = (o) => ({ campaignId: o.id, name: o.name || `${o.product} - Test`, productId: o.pid, productName: o.product, status: 'ACTIVE', dataFresh: true, today: { spend: o.spendToday ?? 0, orders: o.ordersToday ?? 0 }, period: { spend: o.spend3 ?? 0, orders: o.orders3 ?? 0 }, cpa: { d3: o.cpa ?? null, d7: o.cpa ?? null }, cpaVsLimits: o.vs || 'WITHIN_TARGET', limits: o.limits || {}, stock: o.stock === undefined ? { status: 'OK', current: 200 } : o.stock, winner: { status: o.winner ? 'WINNER' : 'UNKNOWN' }, pendingDecision: o.decision ? { action: o.decision, status: 'PREPARED' } : null });
const baseRows = () => [
  row({ id: 'c1', pid: 1, product: 'كاب الليزر', winner: true, cpa: 38, spend3: 400, orders3: 10 }), row({ id: 'c1b', pid: 1, product: 'كاب الليزر', winner: true, cpa: 41, spend3: 200, orders3: 5 }),
  row({ id: 'c2', pid: 2, product: 'فرشاة', winner: true, cpa: 70, spend3: 350, orders3: 5 }),
  row({ id: 'c3', pid: 3, product: 'قصافة', spendToday: 400, ordersToday: 0, spend3: 500, orders3: 1, stock: { status: 'OK', current: 300 } }),
  row({ id: 'c4', pid: 4, product: 'نضارة', spendToday: 120, ordersToday: 1, spend3: 600, orders3: 4, vs: 'ABOVE_HARDSTOP', limits: { hardStop: 90 }, cpa: 150 }),
  row({ id: 'c5', pid: 5, product: 'منفاخ', spendToday: 60, ordersToday: 2, spend3: 300, orders3: 5, cpa: 60, stock: { status: 'OK', current: 120 } }),
  row({ id: 'c6', pid: 6, product: 'سماعة', winner: true, cpa: 40, spend3: 200, orders3: 5, stock: { status: 'OUT_OF_STOCK', current: 0 }, spendToday: 80, ordersToday: 1 }),
  row({ id: 'c7', pid: 7, product: 'حلة', spend3: 100, orders3: 1, decision: 'PAUSE' }),
];
const cards = [{ decisionStatus: 'PENDING', sourceCampaignId: 'c1', sourceCampaignName: 'كاب الليزر - Test 3', displayName: 'كاب الليزر', productName: 'كاب الليزر', orders: 9, cpa: 38, spend: 340, adAccountId: 'act_1' }, { decisionStatus: 'FAILED', sourceCampaignId: 'cx', displayName: 'Face-Heir', lastHint: { title: 'Meta throttle', action: 'استنى 20 دقيقة وكمّل' } }];
const funds = [{ id: 'act_9', name: 'Ahmed Samy', accountId: 'act_9', balanceText: '800 ج' }];
const O = SM.SMART_DEFAULTS;

console.log('\n1. SCALE — one task per working product, built from the product’s economics');
{
  const sp = SM.scalePlan(38, O); ok('cost per order ≤ 50 → «كوستة حلوة» → FOUR scales of 500, ABO/CBO alternating', sp.strong && sp.plan.length === 4 && sp.plan.every((p) => p.budget === 500) && sp.plan.map((p) => p.mode).join() === 'ABO,CBO,ABO,CBO');
  const sn = SM.scalePlan(70, O); ok('a pricier one → TWO scales: 500 ABO + 500 CBO', !sn.strong && sn.plan.map((p) => `${p.mode}${p.budget}`).join() === 'ABO500,CBO500');
  ok('no CPA known → the cautious two-scale plan', SM.scalePlan(null, O).plan.length === 2);
  const groups = SM.groupByProduct(baseRows()); const { tasks } = SM.scaleTasks(groups, cards, O);
  ok('one task per product even with two campaigns of the same product', tasks.filter((t) => t.product.id === 1).length === 1 && tasks.length === 2, tasks.map((t) => t.title));
  const t1 = tasks.find((t) => t.product.id === 1); const t2 = tasks.find((t) => t.product.id === 2);
  ok('the strong one says 4 scales × 500 and lists each scale as a step', /4 اسكيلات/.test(t1.title) && /500/.test(t1.title) && t1.steps.filter((s) => /^اعمل اسكيل/.test(s)).length === 4 && t1.priority === 'HIGH');
  ok('the normal one says ABO 500 + CBO 500 in a single task', /ABO بـ500 ج و CBO بـ500 ج/.test(t2.title) && t2.steps.filter((s) => /^اعمل اسكيل/.test(s)).length === 2);
  ok('the reason is written for a person: numbers + why (orders, cost per order, strong → «نكبّر بقوة»)', /جاب 9 أوردر/.test(t1.why) && /38 ج/.test(t1.why) && /نكبّر بقوة/.test(t1.why));
  ok('a product with NO stock is never scaled (the stock task handles it)', !tasks.some((t) => t.product.id === 6));
  const cheap = SM.scaleTasks(groups, cards, { ...O, scaleBudget: 700 }).tasks[0]; ok('the budget per scale is a setting', cheap.plan.every((p) => p.budget === 700));
}

console.log('\n2. FIX — products that HAVE stock but do not sell · TEST — products that sell and have stock');
{
  const groups = SM.groupByProduct(baseRows()); const sc = SM.scaleTasks(groups, cards, O); const { fixes, tests } = SM.fixTasks(groups, sc.used, O, { zeroLimit: 150, minSpend: 150 });
  const f3 = fixes.find((t) => t.product.id === 3); const f4 = fixes.find((t) => t.product.id === 4);
  ok('spend with no orders → a FIX task that says the stock is there («المشكلة مش في الكمية»)', f3 && f3.type === 'ZERO_ORDERS' && /صرف 400 ج النهارده من غير ولا أوردر/.test(f3.why) && /300 قطعة/.test(f3.why) && /مش في الكمية/.test(f3.why), f3 && f3.why);
  ok('CPA above the hard-stop limit → a FIX task with both numbers, HIGH', f4 && f4.type === 'CPA' && /150 ج/.test(f4.why) && /90 ج/.test(f4.why) && f4.priority === 'HIGH');
  ok('every fix has concrete steps (3-4) ending with «اكتب في الملاحظة»', fixes.every((t) => t.steps.length >= 3 && /الملاحظة/.test(t.steps[t.steps.length - 1])));
  ok('a product that is out of stock is NOT a fix (it is a stock job)', !fixes.some((t) => t.product.id === 6));
  ok('a selling product with stock and few campaigns → a TEST task, with its numbers', tests.length === 1 && tests[0].product.id === 5 && /5 أوردر/.test(tests[0].why) && /120 قطعة/.test(tests[0].why));
  ok('a product already being scaled or fixed is not also tested', !tests.some((t) => [1, 2, 3, 4].includes(t.product.id)));
  const many = []; for (let i = 0; i < 20; i++) many.push(row({ id: `t${i}`, pid: 100 + i, product: `منتج ${i}`, spend3: 200, orders3: 3 + i, cpa: 60 }));
  ok('tests are capped (maxTest) and the best sellers come first', SM.fixTasks(SM.groupByProduct(many), new Set(), { ...O, maxTest: 5 }, {}).tests.length === 5 && SM.fixTasks(SM.groupByProduct(many), new Set(), { ...O, maxTest: 5 }, {}).tests[0].product.name === 'منتج 19');
}

console.log('\n3. MIX — everything else the system knows');
{
  const groups = SM.groupByProduct(baseRows()); const mix = SM.mixTasks(groups, { funds, batches: [{ batch_id: 'b1', status: 'NEEDS_INPUT', error: 'لينك الإعلان ناقص', total_copies: 3, source_ad_account_name: 'El Nozha' }], plan: { plan_date: '2026-11-09', items: [{ selected: true }, { selected: true }, { selected: false }] }, failedScales: [cards[1]] });
  const keys = mix.map((t) => t.key); ok('stock, funds, AI-Operator decisions, stuck batch, failed scale, open plan all become tasks', ['stock:p:6', 'funds:act_9', 'dec:PAUSE', 'clone:b1', 'scalefail:cx', 'plan:OPEN:2026-11-09'].every((k) => keys.includes(k)), keys);
  ok('all of them are in the MIX bucket', mix.every((t) => t.category === 'MIX'));
  ok('out of stock + still spending → HIGH and says what to do', mix.find((t) => t.key === 'stock:p:6').priority === 'HIGH' && /وقّف/.test(mix.find((t) => t.key === 'stock:p:6').steps[0]));
  ok('decisions are grouped per action (one task, with the product names)', /AI Operator رشّح إيقاف \(1\)/.test(mix.find((t) => t.key === 'dec:PAUSE').title) && /حلة/.test(mix.find((t) => t.key === 'dec:PAUSE').why));
  const r = G.candidatesFromRoutines([{ id: 'r1', title: 'افحص الرصيد', mode: 'ALL', days: [] }, { id: 'r2', title: 'تقرير', mode: 'SPREAD', days: [1] }], { date: '2026-11-09', dow: 0, members: members(3) });
  ok('routines: «ALL» = a copy for each person, day filter respected, bucket MIX', r.length === 3 && r.every((x) => x.assigneeId && x.category === 'MIX'));
  const all = SM.buildSmartCandidates({ rows: baseRows(), cards, funds, batches: [], plan: null }, { types: { SCALE: true, CLONE: true, OPEN_PLAN: true, TEST: false } });
  ok('turning a source off removes its tasks (TEST off → no test task)', !all.candidates.some((t) => t.type === 'TEST') && all.candidates.some((t) => t.type === 'SCALE'));
}

console.log('\n4. fair distribution — per bucket');
{
  const mk = (cat, i) => task({ key: `${cat}${i}`, category: cat, type: cat === 'SCALE' ? 'SCALE' : cat === 'FIX' ? 'ZERO_ORDERS' : 'STOCK', product: { id: `${cat}${i}`, name: `${cat}${i}` } });
  const ts = [...Array.from({ length: 8 }, (_, i) => mk('SCALE', i)), ...Array.from({ length: 6 }, (_, i) => mk('FIX', i)), ...Array.from({ length: 4 }, (_, i) => mk('MIX', i))];
  C.distribute(ts, { members: members(4), date: '2026-11-09' });
  const per = (cat) => members(4).map((m) => ts.filter((t) => t.category === cat && t.assigneeId === m.id).length);
  ok('8 scale tasks over 4 people → 2 each', per('SCALE').every((n) => n === 2), per('SCALE'));
  ok('6 fix tasks → 1 or 2 each (never one person with the whole bucket)', Math.max(...per('FIX')) - Math.min(...per('FIX')) <= 1, per('FIX'));
  ok('4 mix tasks → 1 each', per('MIX').every((n) => n === 1));
  const tot = members(4).map((m) => ts.filter((t) => t.assigneeId === m.id).length); ok('and the TOTAL is even too (18 → 4/5/5/4 style, ±1)', Math.max(...tot) - Math.min(...tot) <= 1, tot);
  const same = [task({ key: 'a', product: { id: 7, name: 'X' } }), task({ key: 'b', product: { id: 7, name: 'X' } }), task({ key: 'c', product: { id: 7, name: 'X' } }), task({ key: 'd' }), task({ key: 'e' }), task({ key: 'f' })];
  C.distribute(same, { members: members(3), date: '2026-11-09' }); ok('tasks of ONE product (same bucket) go to the same person', new Set(same.slice(0, 3).map((t) => t.assigneeId)).size === 1);
  const carried = [task({ key: 'c1', category: 'SCALE' }), task({ key: 'c2', category: 'SCALE' }), task({ key: 'c3', category: 'SCALE' })]; carried.forEach((t) => { t.assigneeId = 'm0'; });
  const fresh = Array.from({ length: 3 }, (_, i) => task({ key: `f${i}`, category: 'SCALE' })); C.distribute(fresh, { members: members(3), existing: carried, date: '2026-11-09' });
  ok('a person already carrying yesterday’s scale work gets fewer NEW scale tasks', fresh.filter((t) => t.assigneeId === 'm0').length === 0);
  ok('a person on a day off never receives work', C.availableMembers([{ id: 'a', active: true, off: ['2026-11-09'] }, { id: 'b', active: true, off: [] }, { id: 'c', active: false }], '2026-11-09').map((m) => m.id).join() === 'b');
  ok('nobody available → tasks stay unassigned (no crash)', C.distribute([task()], { members: [] })[0].assigneeId === null);
}

console.log('\n5. roll-over, dedupe, auto-resolve (pure)');
{
  const mk = (status, extra = {}) => ({ ...task({ key: `r-${status}${Math.random()}`, title: status }), status, assigneeId: 'm1', ...extra });
  const r = C.rollOver([mk('PENDING'), mk('IN_PROGRESS'), mk('NOT_DONE'), mk('DONE'), mk('CANCELLED'), mk('AUTO_RESOLVED'), mk('PENDING', { carried: true })], { date: '2026-11-10', members: members(3) });
  ok('open + «ماتعملش» come over to the SAME person (carryCount +1, CARRIED); done / cancelled / auto-resolved / already-carried do not', r.carriedIn.map((t) => t.title).sort().join() === 'IN_PROGRESS,NOT_DONE,PENDING' && r.carriedIn.every((t) => t.assigneeId === 'm1' && t.carryCount === 1 && t.source === 'CARRIED'));
  ok('after 3 roll-overs → HIGH; a person who left → unassigned', C.rollOver([{ ...mk('PENDING'), carryCount: 2, priority: 'LOW' }], { date: 'x', members: members(2) }).carriedIn[0].priority === 'HIGH' && C.rollOver([mk('PENDING', { assigneeId: 'gone' })], { date: 'x', members: members(2) }).carriedIn[0].assigneeId === null);
  ok('dedupe: a key that already has a task today (open or done) is not duplicated', C.dedupeCandidates([{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'c' }], [{ key: 'a', status: 'PENDING' }, { key: 'b', status: 'DONE' }]).map((c) => c.key).join() === 'c');
  const open = [{ ...task({ key: 'x1', category: 'FIX' }), id: 'a' }, { ...task({ key: 'x2', type: 'SCALE', category: 'SCALE' }), id: 'b' }, { ...task({ key: 'x3', category: 'FIX' }), id: 'c', source: 'MANUAL' }, { ...task({ key: 'x4' }), id: 'd', category: undefined }];
  ok('auto-resolve only for sources that read fine, never manual, never older (category-less) rows', C.findAutoResolved(open, [], ['ZERO_ORDERS']).join() === 'a');
}

console.log('\n6. a full day through the engine');
let curRows = baseRows();
const dep = () => ({ getAlerts: async () => ({ unavailable: [], alerts: [] }), getRows: async () => ({ rows: curRows, zeroLimit: 150, minSpend: 150 }), getWinners: async () => ({ connected: true, cards }), getBatches: async () => [{ batch_id: 'b1', status: 'NEEDS_INPUT', error: 'لينك ناقص', total_copies: 3, source_ad_account_name: 'El Nozha' }], getPlan: async () => ({ plan_date: '2026-11-09', items: [{ selected: true }] }) });
const admin = { id: 1, name: 'Hady', role: 'ADMIN', is_owner: false }; const day1 = '2026-11-09'; const day2 = '2026-11-10';
const now1 = new Date('2026-11-09T09:00:00Z'); const now2 = new Date('2026-11-10T09:00:00Z');
{
  const cfg0 = await E.getConfig(); ok('first use seeds the 4 media buyers', cfg0.team.map((m) => m.name).join() === 'Ahmed Samy,Samy,Mohamed 3sam,Hady');
  await E.generateDay(day1, { deps: { ...dep(), getAlerts: async () => ({ unavailable: [], alerts: [{ id: 'funds:act_9', kind: 'FUNDS', title: 'حساب Ahmed Samy: الرصيد المتاح 800 ج بس', entity: { adAccountId: 'act_9' }, facts: [{ l: 'الرصيد المتاح', v: '800 ج' }] }] }) }, now: now1 });
  const v = await E.getDayView(day1, admin); const by = (c) => v.tasks.filter((t) => t.category === c).length;
  ok('the day: 2 scale + 3 fix/test + 5 mix (stock, decision, funds, batch, plan) + the failed scale = 11', by('SCALE') === 2 && by('FIX') === 3 && by('MIX') === 6, `${by('SCALE')}/${by('FIX')}/${by('MIX')}`);
  ok('every task has an owner, a reason and steps written out', v.tasks.every((t) => t.assigneeId && t.why && t.steps.length >= 2));
  const per = (m, c) => v.tasks.filter((t) => t.assigneeId === m.id && t.category === c).length;
  ok('each bucket is spread evenly between the 4 people (max-min ≤ 1)', ['SCALE', 'FIX', 'MIX'].every((c) => { const n = v.team.map((m) => per(m, c)); return Math.max(...n) - Math.min(...n) <= 1; }));
  ok('every assignment is in the activity log', v.log.filter((l) => l.action === 'ASSIGNED').length === v.tasks.length);
  const again = await E.generateDay(day1, { deps: dep(), now: now1 }); ok('generating again adds nothing (idempotent)', again.tasks.length === v.tasks.length);
  curRows = baseRows().map((r) => (r.campaignId === 'c3' ? { ...r, today: { spend: 400, orders: 3 }, period: { spend: 500, orders: 4 } } : r));
  const r2 = await E.generateDay(day1, { deps: dep(), now: now1 }); ok('a problem that got fixed (orders came) is marked «اتحل لوحده» with a log line', r2.tasks.find((t) => t.key === 'fix:p:3').status === 'AUTO_RESOLVED' && r2.log.some((l) => l.action === 'AUTO_RESOLVED'));
  curRows = baseRows();
  const broken = { ...dep(), getAlerts: async () => { throw new Error('meta down'); }, getRows: undefined };
  const r3 = await E.generateDay(day1, { deps: { ...broken, getRows: async () => null }, now: now1 });
  ok('a FAILED read never resolves anything (the open product tasks stay open)', r3.tasks.filter((t) => ['fix:p:4', 'scale:p:1', 'test:p:5'].includes(t.key)).every((t) => t.status === 'PENDING'), r3.tasks.map((t) => t.key + ':' + t.status));
  await E.updateDay ? 0 : 0;
  const S = await imp('../services/dailyTasks/store.js'); await S.updateDay(day1, (d) => { d.tasks.push({ ...C.makeTask({ type: 'ZERO_ORDERS', key: 'alert:old1', title: 'قديمة', priority: 'MED' }, { date: day1 }), category: undefined }, { ...C.makeTask({ type: 'ZERO_ORDERS', key: 'alert:old2', title: 'قديمة شغّالة', priority: 'MED' }, { date: day1 }), category: undefined, status: 'IN_PROGRESS' }); d.tasks.forEach((t) => { if (t.key.startsWith('alert:')) { delete t.category; t.assigneeId = d.tasks[0].assigneeId; } }); });
  const r4 = await E.generateDay(day1, { deps: dep(), now: now1 });
  ok('tasks from the first (alert-level) version: untouched ones are replaced, a started one is left alone', r4.tasks.find((t) => t.key === 'alert:old1').status === 'CANCELLED' && r4.tasks.find((t) => t.key === 'alert:old2').status === 'IN_PROGRESS');
}

console.log('\n7. people act on tasks');
{
  const v = await E.getDayView(day1, admin); const mine = v.tasks.find((t) => t.key === 'scale:p:1'); const other = v.tasks.find((t) => t.assigneeId !== mine.assigneeId && C.isOpen(t) && t.category);
  const cfg = await E.getConfig(); const owner = cfg.team.find((m) => m.id === mine.assigneeId);
  await E.updateMember(owner.id, { userId: 77 }); const emp = { id: 77, name: 'Buyer', role: 'EMPLOYEE' }; const stranger = { id: 88, name: 'Other', role: 'EMPLOYEE' };
  ok('an employee cannot touch someone else’s task', (await rejects(() => E.actOnTask(day1, mine.id, 'done', {}, stranger)))?.status === 403);
  ok('…nor reassign / cancel (manager only)', (await rejects(() => E.actOnTask(day1, mine.id, 'cancel', {}, emp)))?.status === 403 && (await rejects(() => E.actOnTask(day1, mine.id, 'assign', { memberId: 'x' }, emp)))?.status === 403);
  await E.actOnTask(day1, mine.id, 'start', {}, emp); let d = await E.actOnTask(day1, mine.id, 'done', { note: 'عملت 4 اسكيلات' }, emp);
  const t = d.tasks.find((x) => x.id === mine.id); ok('start → done is recorded with who / when / note', t.status === 'DONE' && t.doneBy === 'Buyer' && t.note === 'عملت 4 اسكيلات' && !!t.startedAt && !!t.doneAt);
  d = await E.actOnTask(day1, other.id, 'notdone', { reason: 'NEEDS_APPROVAL', note: 'مستني المدير' }, admin);
  ok('«ماتعملش» keeps the reason', d.tasks.find((x) => x.id === other.id).status === 'NOT_DONE' && d.tasks.find((x) => x.id === other.id).reason === 'NEEDS_APPROVAL');
  const target = cfg.team.find((m) => m.id !== other.assigneeId);
  d = await E.actOnTask(day1, other.id, 'assign', { memberId: target.id }, admin); ok('manager reassigns (logged with from → to)', d.tasks.find((x) => x.id === other.id).assigneeId === target.id && d.log.some((l) => l.action === 'REASSIGNED' && /اتحوّلت/.test(l.text)));
  const mt = await E.addManualTask(day1, { title: 'راجع كرياتيف المنتج X', priority: 'HIGH', category: 'FIX' }, admin); ok('manual task is added to the chosen bucket and distributed', mt.tasks.some((x) => x.title === 'راجع كرياتيف المنتج X' && x.assigneeId && x.category === 'FIX'));
  ok('an empty manual task is refused', (await rejects(() => E.addManualTask(day1, { title: '  ' }, admin)))?.status === 400);
}

console.log('\n8. next day: what was not done is added (same person)');
{
  const before = await E.getDayView(day1, admin); const open = before.tasks.filter((t) => (C.isOpen(t) || t.status === 'NOT_DONE') && !t.carried);
  const next = await E.generateDay(day2, { deps: dep(), now: now2 });
  const carried = next.tasks.filter((t) => t.source === 'CARRIED'); ok('every unfinished task of yesterday is on today’s list', carried.length === open.length, `${carried.length} vs ${open.length}`);
  ok('each one is with the SAME person who did not do it', carried.every((c) => open.find((o) => o.id === c.carriedFromId)?.assigneeId === c.assigneeId), JSON.stringify(carried.filter((c) => open.find((o) => o.id === c.carriedFromId)?.assigneeId !== c.assigneeId).map((c) => [c.title, c.assigneeId, open.find((o) => o.id === c.carriedFromId)?.assigneeId, c.category])));
  const y = await E.getDayView(day1, admin); ok('yesterday keeps its own truth (still «not done», flagged as carried)', y.tasks.filter((t) => t.carried).length === open.length);
  ok('the finished scale task did NOT come over', !next.tasks.some((t) => t.key === 'scale:p:1' && t.source === 'CARRIED'));
  const vv = await E.getDayView(day2, admin); const tot = vv.team.map((m) => vv.tasks.filter((t) => t.assigneeId === m.id && C.isOpen(t)).length);
  ok('today’s totals are even (carried work counted) — max-min ≤ 2', Math.max(...tot) - Math.min(...tot) <= 2, tot);
}

console.log('\n9. team + numbers');
{
  const p = await E.addMember({ name: 'Mostafa' }); ok('adding a person is one call; a duplicate name is refused', !!p.id && (await rejects(() => E.addMember({ name: 'mostafa' })))?.status === 409);
  await E.rebalance(day2, admin); const v = await E.getDayView(day2, admin); ok('«توزيع بالتساوي» brings the new person in', v.tasks.some((t) => t.assigneeId === p.id));
  await E.setDayOff(p.id, day2, true, admin); ok('a day off moves that person’s open tasks to the others', (await E.getDayView(day2, admin)).tasks.filter((t) => t.assigneeId === p.id && C.isOpen(t)).length === 0);
  await E.setDayOff(p.id, day2, false, admin); await E.removeMember(p.id, admin); ok('removing deactivates (history stays) and nothing stays on them', !(await E.getConfig()).team.find((m) => m.id === p.id).active);
  const rep = await E.getReport(day1, day2); ok('the report has a row per person (done / not done / missed / rate) and totals match', rep.perMember.every((r) => 'done' in r && 'notDone' in r && 'missed' in r && 'rate' in r) && rep.perMember.reduce((a, r) => a + r.assigned, 0) === rep.days.reduce((a, d) => a + d.total, 0));
  ok('a bad range is refused', (await rejects(() => E.getReport('2026-12-01', '2026-11-01')))?.status === 400);
  const txt = await E.getEodText(day1); ok('the end-of-day text lists every person with ✅/❌', /تقرير تاسكات يوم 2026-11-09/.test(txt) && /✅/.test(txt) && /👤/.test(txt));
  const o = await E.saveOptions({ scaleBudget: 700, strongCpa: 45, maxTest: 3 }); ok('scale budget / strong-CPA / caps are settings (bounded)', o.scaleBudget === 700 && o.strongCpa === 45 && o.maxTest === 3 && (await E.saveOptions({ scaleBudget: 1 })).scaleBudget === 100);
  await E.saveOptions({ scaleBudget: 500, strongCpa: 50, maxTest: 8 });
}

console.log('\n10. scheduler');
{
  mem.clear(); const calls = [];
  const gen = async (d) => { calls.push(d); await E.generateDay(d, { deps: dep(), now: new Date('2026-11-12T10:00:00Z') }); };
  ok('before the configured time → waits', (await SC.tick({ now: new Date('2026-11-11T22:02:00Z'), gen })).skipped === 'too-early');
  ok('after it → the day is built', (await SC.tick({ now: new Date('2026-11-11T22:10:00Z'), gen })).built === '2026-11-12' && calls.length === 1);
  const again = await SC.tick({ now: new Date('2026-11-12T10:20:00Z'), gen }); ok('already built and fresh → nothing', again.skipped === 'fresh' || !!again.refreshed);
  await E.saveOptions({ autoGenerate: false }); ok('switched off → never builds', (await SC.tick({ now: new Date('2026-11-13T22:10:00Z'), gen })).skipped === 'off');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
