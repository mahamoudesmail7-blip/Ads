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
const row = (o) => { const spend3 = o.spend3 ?? 0; const orders3 = o.orders3 === undefined ? 0 : o.orders3; return { campaignId: o.id, name: o.name || `${o.product} - Test`, productId: o.pid === undefined ? null : o.pid, productName: o.pid === undefined || o.pid === null ? null : o.product, status: 'ACTIVE', dataFresh: true, lastSeenAt: '2026-11-09T10:00:00.000Z', today: { spend: o.spendToday ?? 0, orders: o.ordersToday === undefined ? 0 : o.ordersToday }, period: { spend: spend3, orders: orders3, cpa: orders3 > 0 ? Math.round(spend3 / orders3) : null }, cpa: { d3: o.cpa ?? null, d7: o.cpa ?? null }, cpaVsLimits: o.vs || 'WITHIN_TARGET', limits: o.limits || {}, stock: o.stock === undefined ? { status: 'OK', current: 200 } : o.stock, winner: { status: o.winner ? 'WINNER' : 'UNKNOWN' }, pendingDecision: o.decision ? { action: o.decision, status: o.decisionStatus || 'PREPARED' } : null }; };
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
  ok('the reason is written for a person: numbers + why (orders, cost per order, strong → «نكبّر بقوة»)', /جابت 10 أوردر \(حسب Meta\)/.test(t1.why) && /40 ج/.test(t1.why) && /38 ج في آخر 7 أيام/.test(t1.why) && /نكبّر بقوة/.test(t1.why), t1.why);
  ok('a product with NO stock is never scaled (the stock task handles it)', !tasks.some((t) => t.product.id === 6));
  const cheap = SM.scaleTasks(groups, cards, { ...O, scaleBudget: 700 }).tasks[0]; ok('the budget per scale is a setting', cheap.plan.every((p) => p.budget === 700));
}

console.log('\n2. FIX — products that HAVE stock but do not sell · TEST — products that sell and have stock');
{
  const groups = SM.groupByProduct(baseRows()); const sc = SM.scaleTasks(groups, cards, O); const { fixes, tests } = SM.fixTasks(groups, sc.used, O, { zeroLimit: 150, minSpend: 150 });
  const f3 = fixes.find((t) => t.product.id === 3); const f4 = fixes.find((t) => t.product.id === 4);
  ok('spend with no orders → a FIX task that says the stock is there («المشكلة مش في الكمية»)', f3 && f3.type === 'ZERO_ORDERS' && /صرف 400 ج النهارده من غير ولا أوردر \(حسب Meta\)/.test(f3.why) && /300 قطعة/.test(f3.why) && /مش في الكمية/.test(f3.why), f3 && f3.why);
  ok('CPA above the hard-stop limit → a FIX task with both numbers, HIGH', f4 && f4.type === 'CPA' && /150 ج/.test(f4.why) && /90 ج/.test(f4.why) && f4.priority === 'HIGH');
  ok('every fix has concrete steps (3-4) ending with «اكتب في الملاحظة»', fixes.every((t) => t.steps.length >= 3 && /الملاحظة/.test(t.steps[t.steps.length - 1])));
  ok('a product that is out of stock is NOT a fix (it is a stock job)', !fixes.some((t) => t.product.id === 6));
  ok('a selling product with stock and few campaigns → a TEST task, with its numbers', tests.length === 1 && tests[0].product.id === 5 && /5 أوردر \(حسب Meta\)/.test(tests[0].why) && /120 قطعة/.test(tests[0].why));
  ok('a product already being scaled or fixed is not also tested', !tests.some((t) => [1, 2, 3, 4].includes(t.product.id)));
  const many = []; for (let i = 0; i < 20; i++) many.push(row({ id: `t${i}`, pid: 100 + i, product: `منتج ${i}`, spend3: 200, orders3: 3 + i, cpa: 60 }));
  ok('tests are capped (maxTest) and the best sellers come first', SM.fixTasks(SM.groupByProduct(many), new Set(), { ...O, maxTest: 5 }, {}).tests.length === 5 && SM.fixTasks(SM.groupByProduct(many), new Set(), { ...O, maxTest: 5 }, {}).tests[0].product.name === 'منتج 19');
}

console.log('\n2b. accuracy — an unknown is never a zero, no guessing, no overstatement');
{
  const O2 = SM.SMART_DEFAULTS; const fixOf = (rows, cardsX = []) => { const g = SM.groupByProduct(rows); return SM.fixTasks(g, new Set(), O2, { zeroLimit: 150, minSpend: 150 }); };
  const unknownOrders = [row({ id: 'u1', pid: 90, product: 'منتج X', spendToday: 400, ordersToday: null, spend3: 500, orders3: null })];
  ok('orders MISSING (null) never become «بيصرف ومبيجيبش» — no claim without data', fixOf(unknownOrders).fixes.length === 0);
  const partial = [row({ id: 'p1', pid: 91, product: 'منتج Y', spendToday: 300, ordersToday: 0, spend3: 300, orders3: 0 }), row({ id: 'p2', pid: 91, product: 'منتج Y', spendToday: 50, ordersToday: null, spend3: 50, orders3: null })];
  ok('one campaign of the product with unknown orders blocks the zero-orders claim for the whole product', fixOf(partial).fixes.length === 0);
  const noStock = fixOf([row({ id: 's1', pid: 92, product: 'منتج Z', spendToday: 400, ordersToday: 0, spend3: 500, orders3: 0, stock: { status: 'STOCK_UNKNOWN', current: null } })]).fixes[0];
  ok('stock unknown → the task says so and does NOT claim «المشكلة مش في الكمية»', noStock && /مش معروف/.test(noStock.why) && !/مش في الكمية/.test(noStock.why) && noStock.facts.some((f) => f.l === 'المخزون' && f.v === 'غير معروف'));
  const unl = SM.groupByProduct([row({ id: 'k1', pid: null, product: 'كاب', name: 'كاب الليزر - Test 1', spend3: 100, orders3: 2 }), row({ id: 'k2', pid: null, product: 'كاب', name: 'كاب الليزر - Test 2', spend3: 100, orders3: 2 })]);
  ok('campaigns NOT linked to a product are never merged by name — each stays its own campaign, named exactly', unl.size === 2 && [...unl.values()].every((g) => g.linked === false && /^كاب الليزر - Test \d$/.test(g.name)));
  const cpaRows = [row({ id: 'a1', pid: 93, product: 'منتج W', spend3: 600, orders3: 4, vs: 'ABOVE_HARDSTOP', limits: { hardStop: 90 }, cpa: 150 }), row({ id: 'a2', pid: 93, product: 'منتج W', spend3: 600, orders3: 12, cpa: 50 })];
  const cp = fixOf(cpaRows).fixes[0];
  ok('CPA task quotes the OFFENDING campaign’s own CPA (150), not an average with a healthy one (≈ 75)', cp && /150 ج/.test(cp.why) && !/75 ج/.test(cp.why) && /منتج W - Test/.test(cp.why));
  const tiny = fixOf([row({ id: 'm1', pid: 94, product: 'منتج V', spend3: 100, orders3: 1, vs: 'ABOVE_HARDSTOP', limits: { hardStop: 90 }, cpa: 100 })]);
  ok('a campaign that spent less than the minimum is not judged on its CPA (noise)', tiny.fixes.length === 0);
  const groupsW = SM.groupByProduct([row({ id: 'w1', pid: 95, product: 'منتج Q', winner: true, spend3: 400, orders3: 8, cpa: 30 })]);
  const flat = row({ id: 'w2', pid: 96, product: 'منتج R', winner: true, spend3: 600, orders3: 10 }); flat.cpa = { d3: 40, d7: 80 }; // flattering 3-day CPA, bad 7-day CPA
  const sc2 = SM.scaleTasks(SM.groupByProduct([flat]), [], O2).tasks[0];
  ok('the scale size is judged on the WORSE of the 3-day / 7-day CPA (never the flattering one), and both are shown', sc2.plan.length === 2 && /60 ج للأوردر/.test(sc2.why) && /80 ج في آخر 7 أيام/.test(sc2.why), sc2.why);
  const dec = SM.mixTasks(SM.groupByProduct([row({ id: 'd1', pid: 97, product: 'منتج D', decision: 'PAUSE', decisionStatus: 'APPROVED' }), row({ id: 'd2', pid: 98, product: 'منتج E', decision: 'PAUSE', decisionStatus: 'BLOCKED' }), row({ id: 'd3', pid: 99, product: 'منتج F', decision: 'SCALE_UP', decisionStatus: 'PREPARED' })]), {});
  ok('only decisions that really WAIT for a review (PREPARED) become «مستنية موافقتك» — approved / blocked ones do not', dec.length === 1 && dec[0].key === 'dec:SCALE_UP');
  ok('an already APPROVED open plan is not a «review» task', SM.mixTasks(new Map(), { plan: { plan_date: 'x', status: 'APPROVED', items: [{ selected: true }] } }).length === 0 && SM.mixTasks(new Map(), { plan: { plan_date: 'x', status: 'PREPARED', items: [{ selected: true }] } }).length === 1);
  const all = SM.buildSmartCandidates({ rows: baseRows(), cards, funds: [], batches: [], plan: null, period: { from: '2026-11-07', to: '2026-11-09' }, asOf: '2026-11-09T10:00:00.000Z' }, {});
  ok('every task carries where its numbers come from (Meta purchases, the 3-day window, the data time)', all.candidates.every((t) => t.meta && t.meta.basis === 'مشتريات Meta' && t.meta.window.from === '2026-11-07' && t.meta.asOf === '2026-11-09T10:00:00.000Z'));
  ok('no task text uses a bare «أوردر» for Meta numbers: every orders sentence says «حسب Meta»', all.candidates.filter((t) => /جاب\S* \d+ أوردر|من غير ولا أوردر/.test(t.why)).every((t) => /حسب Meta/.test(t.why)));
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
const OWNER = 'mahamoudesmail7@gmail.com'; const admin = { id: 1, name: 'Mahmoud', role: 'ADMIN', email: OWNER, is_owner: true }; const day1 = '2026-11-09'; const day2 = '2026-11-10';
const now1 = new Date('2026-11-09T09:00:00Z'); const now2 = new Date('2026-11-10T09:00:00Z');
{
  const cfg0 = await E.getConfig(); ok('first use seeds the 4 media buyers', cfg0.team.map((m) => m.name).join() === 'Ahmed Samy,Samy,Mohamed 3sam,Hady');
  ok('defaults: top-up target 15 per person, distribution waits for the admin', cfg0.options.perPersonTarget === 15 && cfg0.options.autoDistribute === false);
  await E.saveOptions({ perPersonTarget: 0 }); // (the top-up has its own section below)
  await E.generateDay(day1, { deps: { ...dep(), getAlerts: async () => ({ unavailable: [], alerts: [{ id: 'funds:act_9', kind: 'FUNDS', title: 'حساب Ahmed Samy: الرصيد المتاح 800 ج بس', entity: { adAccountId: 'act_9' }, facts: [{ l: 'الرصيد المتاح', v: '800 ج' }] }] }) }, now: now1 });
  const pool = await E.getDayView(day1, admin); ok('the day is built as a POOL: nothing is handed to anyone until the admin presses «توزيع بالتساوي»', pool.tasks.length > 0 && pool.tasks.every((t) => !t.assigneeId));
  await E.rebalance(day1, admin);
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

console.log('\n6b. numbers stay true through the day');
{
  const before = (await E.getDayView(day1, admin)).tasks.find((t) => t.key === 'fix:p:4'); curRows = baseRows().map((r) => (r.campaignId === 'c4' ? { ...r, period: { spend: 800, orders: 4, cpa: 200 } } : r));
  await E.generateDay(day1, { deps: dep(), now: new Date('2026-11-09T12:00:00Z') });
  const after = (await E.getDayView(day1, admin)).tasks.find((t) => t.key === 'fix:p:4');
  ok('a still-open task is re-written from the latest numbers (CPA 150 → 200), same task, same owner', before && after.id === before.id && /200 ج/.test(after.why) && !/150 ج/.test(after.why) && after.assigneeId === before.assigneeId && after.numbersAt > before.numbersAt, after && after.why);
  ok('…and shows the data time + window of its numbers', after.meta && after.meta.window && after.meta.window.to === day1 && after.meta.window.from === '2026-11-07' && after.meta.asOf === '2026-11-09T10:00:00.000Z' && (await E.getDayView(day1, admin)).dataAsOf === '2026-11-09T10:00:00.000Z');
  const donePick = (await E.getDayView(day1, admin)).tasks.find((t) => t.key === 'test:p:5'); await E.actOnTask(day1, donePick.id, 'done', { note: 'ok' }, admin);
  curRows = baseRows().map((r) => (r.campaignId === 'c5' ? { ...r, period: { spend: 999, orders: 1, cpa: 999 } } : r));
  await E.generateDay(day1, { deps: dep(), now: new Date('2026-11-09T13:00:00Z') });
  ok('a DONE task keeps the numbers it was done with (never rewritten afterwards)', (await E.getDayView(day1, admin)).tasks.find((t) => t.id === donePick.id).why === donePick.why);
  const pr = (await E.getDayView(day1, admin)).tasks.find((t) => t.key === 'scale:p:2'); await E.actOnTask(day1, pr.id, 'priority', { priority: 'LOW' }, admin); await E.generateDay(day1, { deps: dep(), now: new Date('2026-11-09T14:00:00Z') });
  ok('a priority the admin set by hand is not overwritten by a refresh', (await E.getDayView(day1, admin)).tasks.find((t) => t.id === pr.id).priority === 'LOW');
  curRows = baseRows();
  ok('a day other than today is never built from today’s numbers', (await rejects(() => E.generateDay('2026-11-01', { deps: dep(), now: now1 })))?.status === 400 && (await rejects(() => E.generateDay('2026-11-30', { deps: dep(), now: now1 })))?.status === 400);
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
  const mx = mt.tasks.find((x) => x.title === 'راجع كرياتيف المنتج X'); const cx = await E.actOnTask(day1, mx.id, 'cancel', { note: 'مش لازم' }, admin); ok('the admin can REMOVE a task from a person (logged, not counted any more)', cx.tasks.find((x) => x.id === mx.id).status === 'CANCELLED' && cx.log.some((l) => l.action === 'CANCELLED') && C.daySummary(cx.tasks).total === C.daySummary(mt.tasks).total - 1);
  const mt2 = await E.addManualTask(day1, { title: 'مهمة يدوي لهادي', memberId: target.id, category: 'MIX' }, admin); ok('…and ADD a manual task straight to that person', mt2.tasks.find((x) => x.title === 'مهمة يدوي لهادي').assigneeId === target.id);
  ok('an empty manual task is refused', (await rejects(() => E.addManualTask(day1, { title: '  ' }, admin)))?.status === 400);
}

console.log('\n8. next day: what was not done is added (same person)');
{
  const before = await E.getDayView(day1, admin); const open = before.tasks.filter((t) => (C.isOpen(t) || t.status === 'NOT_DONE') && !t.carried);
  await E.generateDay(day2, { deps: dep(), now: now2 }); const next = await E.rebalance(day2, admin);
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
  const rep = await E.getReport(day1, day2); ok('the report has a row per person (done / not done / missed / rate) and totals match', rep.perMember.every((r) => 'done' in r && 'notDone' in r && 'missed' in r && 'rate' in r) && rep.perMember.reduce((a, r) => a + r.assigned, 0) + [day1, day2].reduce((a, d) => a + 0, 0) + (await Promise.all([day1, day2].map((d) => E.getDayView(d, admin)))).reduce((a, v) => a + v.tasks.filter((t) => !t.assigneeId && t.status !== 'CANCELLED').length, 0) === rep.days.reduce((a, d) => a + d.total, 0));
  ok('a bad range is refused', (await rejects(() => E.getReport('2026-12-01', '2026-11-01')))?.status === 400);
  const txt = await E.getEodText(day1); ok('the end-of-day text lists every person with ✅/❌', /تقرير تاسكات يوم 2026-11-09/.test(txt) && /✅/.test(txt) && /👤/.test(txt));
  const o = await E.saveOptions({ scaleBudget: 700, strongCpa: 45, maxTest: 3 }); ok('scale budget / strong-CPA / caps are settings (bounded)', o.scaleBudget === 700 && o.strongCpa === 45 && o.maxTest === 3 && (await E.saveOptions({ scaleBudget: 1 })).scaleBudget === 100);
  await E.saveOptions({ scaleBudget: 500, strongCpa: 50, maxTest: 8 });
}

console.log('\n10. only the admin sees everything');
{
  const cfg = await E.getConfig(); const a = cfg.team[0]; const b = cfg.team[1]; await E.updateMember(a.id, { userId: 501 }); await E.updateMember(b.id, { userId: 502 });
  const userA = { id: 501, name: 'A', role: 'EMPLOYEE' }; const userB = { id: 502, name: 'B', role: 'MANAGER' }; const nobody = { id: 999, name: 'N', role: 'EMPLOYEE' };
  const full = await E.getDayView(day2, admin); const va = await E.getDayView(day2, userA); const vb = await E.getDayView(day2, userB); const vn = await E.getDayView(day2, nobody);
  ok('the admin sees every task and every person', full.tasks.length > va.tasks.length && full.team.length >= 4 && full.admin === true && !!full.options);
  ok('a buyer sees ONLY their own tasks — no other person’s task, name, number or setting', va.tasks.length > 0 && va.tasks.every((t) => t.assigneeId === a.id) && va.team.length === 1 && va.team[0].id === a.id && va.perMember.length === 1 && va.options === null && va.notes === null && va.admin === false);
  ok('their summary counts only their own tasks', va.summary.total === va.tasks.filter((t) => t.status !== 'CANCELLED').length);
  ok('a MANAGER-role account is not the admin either (own tasks only)', vb.tasks.every((t) => t.assigneeId === b.id) && vb.admin === false);
  ok('an account not linked to a media buyer sees nothing (and is told so)', vn.tasks.length === 0 && vn.team.length === 0 && vn.linked === false);
  ok('the activity log of a buyer holds only their own lines', va.log.every((l) => l.memberId === a.id));
  const rep = await E.getReport(day1, day2, userA); ok('the follow-up report of a buyer has only their own row', rep.perMember.length === 1 && rep.perMember[0].memberId === a.id && rep.team.length === 1);
  ok('a MANAGER cannot reassign / cancel / see others (admin only)', (await rejects(() => E.actOnTask(day2, full.tasks.find((t) => t.assigneeId === a.id && C.isOpen(t)).id, 'cancel', {}, userB)))?.status === 403);
  { // only the OWNER e-mail sees everything; any other account — even role ADMIN — sees its own tasks only
    const cfg = await E.getConfig(); const h = cfg.team[3]; await E.updateMember(h.id, { userId: 1 });
    const hady = { id: 1, name: 'Hady', role: 'ADMIN', email: 'hady@example.com' };
    const own = await E.getDayView(day2, hady); const all = await E.getDayView(day2, admin);
    ok('an ADMIN-role account that is not the owner sees ONLY his own tasks (no team, no options, not the admin view)', own.admin === false && own.tasks.length > 0 && own.tasks.every((t) => t.assigneeId === h.id) && own.team.length === 1 && own.options === null);
    ok('…while the owner account sees everyone', all.admin === true && all.team.length >= 4 && all.tasks.length > own.tasks.length);
    const other = all.tasks.find((t) => t.assigneeId !== h.id && C.isOpen(t));
    ok('…and cannot cancel / reassign other people’s tasks (the owner can)', (await rejects(() => E.actOnTask(day2, other.id, 'cancel', {}, hady)))?.status === 403 && !(await rejects(() => E.actOnTask(day2, other.id, 'priority', { priority: 'LOW' }, admin))));
    ok('the full-access rule is the e-mail (case-insensitive), nothing else', C.seesAll({ email: 'MahamoudEsmail7@Gmail.com' }) && !C.seesAll({ email: 'x@y.com', role: 'ADMIN', is_owner: true }) && !C.seesAll(null));
    await E.updateMember(h.id, { userId: null });
  }
}

console.log('\n11. top-up: at least N real tasks per person, in the 50 / 25 / 25 proportions');
{
  const many = []; let k = 0; const R = (o) => row({ id: `m${++k}`, ...o });
  for (let i = 0; i < 6; i++) many.push(R({ pid: 200 + i, product: `رابح ${i}`, winner: true, cpa: 40, spend3: 300, orders3: 8 }));
  for (let i = 0; i < 12; i++) many.push(R({ pid: 300 + i, product: `كويس ${i}`, cpa: 70, spend3: 280, orders3: 4 + (i % 3) }));
  for (let i = 0; i < 12; i++) many.push(R({ pid: 400 + i, product: `بيبيع ${i}`, cpa: 130, spend3: 260, orders3: 2, vs: 'BETWEEN' }));
  for (let i = 0; i < 20; i++) many.push(R({ pid: 500 + i, product: `عادي ${i}`, spend3: 150, orders3: 0 }));
  const o = { ...O, types: {} }; const nat = SM.buildSmartCandidates({ rows: many, cards: [], funds: [], batches: [], plan: null }, o);
  const filled = SM.buildSmartCandidates({ rows: many, cards: [], funds: [], batches: [], plan: null, }, { ...o, target: 40 });
  ok('without a target there is no filler', nat.filler === 0);
  ok('with a target the day is filled to exactly the target when the data allows it', filled.candidates.length === 40, filled.candidates.length);
  const by = (c) => filled.candidates.filter((t) => t.category === c).length;
  ok('in the owner’s proportions (≈ 50% scale, 25% fix/test, 25% mix)', by('SCALE') >= 18 && by('SCALE') <= 22 && by('FIX') >= 8 && by('FIX') <= 12 && by('MIX') >= 8 && by('MIX') <= 12, `${by('SCALE')}/${by('FIX')}/${by('MIX')}`);
  ok('every filler task is real work about a real product: reason + steps, never two tasks of the same kind for one product', filled.candidates.filter((t) => t.filler).every((t) => t.why && t.steps.length >= 3 && t.product?.name) && new Set(filled.candidates.map((t) => t.category + '|' + t.key.slice(t.key.indexOf(':') + 1))).size === filled.candidates.length);
  ok('a careful «اسكيل بحذر» is a single ABO 500, labelled as not-yet-proven', filled.candidates.find((t) => t.key.startsWith('scalelite:')).plan.length === 1 && /لسه مش رابح مؤكد/.test(filled.candidates.find((t) => t.key.startsWith('scalelite:')).why));
  const tiny = SM.buildSmartCandidates({ rows: many.slice(0, 3), cards: [], funds: [], batches: [], plan: null }, { ...o, target: 60 }); ok('when the data cannot fill the target the day stays honestly shorter', tiny.candidates.length < 60);
  // through the engine: target = perPersonTarget × people, filler never auto-resolves
  await E.saveOptions({ perPersonTarget: 6 }); mem.delete('dtk:day:2026-11-20');
  const d3 = await E.generateDay('2026-11-20', { deps: { ...dep(), getRows: async () => ({ rows: many, zeroLimit: 150, minSpend: 150 }), getWinners: async () => ({ connected: true, cards: [] }), getBatches: async () => [], getPlan: async () => null }, now: new Date('2026-11-20T09:00:00Z') });
  const live = d3.tasks.filter((t) => t.status !== 'CANCELLED').length; ok('the engine builds it for the active team (6 × 4 = 24)', live === 24, live);
  const d3b = await E.generateDay('2026-11-20', { deps: { ...dep(), getRows: async () => ({ rows: many.slice(0, 5), zeroLimit: 150, minSpend: 150 }), getWinners: async () => ({ connected: true, cards: [] }), getBatches: async () => [], getPlan: async () => null }, now: new Date('2026-11-20T09:00:00Z') });
  ok('a filler task is never marked «اتحل لوحده» just because the fill set changed', d3b.tasks.filter((t) => t.filler).every((t) => t.status === 'PENDING'));
  await E.saveOptions({ perPersonTarget: 0, autoDistribute: true }); mem.delete('dtk:day:2026-11-21');
  const d4 = await E.generateDay('2026-11-21', { deps: dep(), now: new Date('2026-11-21T09:00:00Z') }); ok('autoDistribute ON hands the tasks out at build time (the old behaviour, optional)', d4.tasks.length > 0 && d4.tasks.every((t) => t.assigneeId));
  await E.saveOptions({ autoDistribute: false });
  ok('settings are bounded (target ≤ 60)', (await E.saveOptions({ perPersonTarget: 999 })).perPersonTarget === 60 && (await E.saveOptions({ perPersonTarget: 15 })).perPersonTarget === 15);
}

console.log('\n12. scheduler');
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
