// Easy Orders STATUS SYNC regression (2026-10-02). Part A pure/injected (no network, no DB). Part B DB-backed on DISPOSABLE
// stores/orders/products (cleaned up) with an injected fake Easy Orders — it never calls the real API and never touches a real order.
//   node src/scripts/easyOrdersStatusSyncTest.js
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };

const { prisma } = await imp('../prisma.js');
const EO = await imp('../services/easyOrders.js');
const S = await imp('../services/easyOrdersStatus.js');

console.log('§1 normalizeStatus — in_delivery is NOT delivered:');
const map = { pending: 'PENDING', processing: 'PENDING', high_risk: 'PENDING', confirmed: 'CONFIRMED', paid: 'CONFIRMED', in_delivery: 'CONFIRMED', out_for_delivery: 'CONFIRMED', shipped: 'CONFIRMED', delivered: 'DELIVERED', canceled: 'CANCELLED', cancelled: 'CANCELLED', returned: 'RETURNED', returning_from_delivery: 'RETURNED', 'something_new': 'PENDING', '': 'PENDING' };
for (const [raw, want] of Object.entries(map)) ok(`"${raw}" -> ${want}`, EO.normalizeStatus(raw) === want, EO.normalizeStatus(raw));
ok('undefined/null -> PENDING (never silently DELIVERED)', EO.normalizeStatus(undefined) === 'PENDING' && EO.normalizeStatus(null) === 'PENDING');

console.log('\n§2 judgeStatusTrust (pure):');
ok('under 30 mature orders -> INSUFFICIENT_SAMPLE (no claim either way)', S.judgeStatusTrust({ matureOrders: 12, nonPending: 0 }).state === 'INSUFFICIENT_SAMPLE');
ok('0.4% moved (the real production figure) -> NO_STATUS_SIGNAL', S.judgeStatusTrust({ matureOrders: 8000, nonPending: 32 }).state === 'NO_STATUS_SIGNAL');
ok('5%..25% moved -> PARTIAL', S.judgeStatusTrust({ matureOrders: 100, nonPending: 10 }).state === 'PARTIAL');
ok('25%+ moved -> OK', S.judgeStatusTrust({ matureOrders: 100, nonPending: 40 }).state === 'OK');

console.log('\n§3 token bucket (fake clock):');
{
  let t = 0; const sleeps = [];
  const clock = { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } };
  S.resetRateBuckets();
  for (let i = 0; i < 3; i++) await S.acquire('keyA', { perMinute: 3, ...clock });
  ok('first 3 calls in the minute need no waiting', sleeps.length === 0);
  await S.acquire('keyA', { perMinute: 3, ...clock });
  ok('4th call within the minute is delayed (budget enforced)', sleeps.length >= 1 && sleeps[0] >= 19_000, JSON.stringify(sleeps));
  const before = sleeps.length;
  await S.acquire('keyB', { perMinute: 3, ...clock });
  ok('budget is per API key (another key is not throttled by the first)', sleeps.length === before);
}

console.log('\n§4 fetchOrderClassified — nothing is a silent null any more:');
const resp = (status, body, headers = {}) => ({ status, ok: status === 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
const fast = { sleep: async () => {}, now: () => 0, perMinute: 1_000_000 };
const seq = (...rs) => { let i = 0; return async () => { const r = rs[Math.min(i, rs.length - 1)]; i++; if (r instanceof Error) throw r; return r; }; };
S.resetRateBuckets();
ok('200 -> OK with the order', (await S.fetchOrderClassified('o1', 'k', { ...fast, fetchImpl: seq(resp(200, { status: 'pending' })) })).kind === 'OK');
ok('400 "record not found" -> NOT_FOUND (this key cannot see the order)', (await S.fetchOrderClassified('o1', 'k', { ...fast, fetchImpl: seq(resp(400, { message: 'record not found' })) })).kind === 'NOT_FOUND');
ok('404 -> NOT_FOUND', (await S.fetchOrderClassified('o1', 'k', { ...fast, fetchImpl: seq(resp(404, 'nope')) })).kind === 'NOT_FOUND');
ok('other 400 -> ERROR (not mistaken for "not found")', (await S.fetchOrderClassified('o1', 'k', { ...fast, fetchImpl: seq(resp(400, { message: 'bad id format' })) })).kind === 'ERROR');
ok('429 then 200 -> OK after backoff', (await S.fetchOrderClassified('o1', 'k', { ...fast, fetchImpl: seq(resp(429, ''), resp(200, { status: 'x' })) })).kind === 'OK');
ok('429 forever -> RATE_LIMITED (never "not found")', (await S.fetchOrderClassified('o1', 'k', { ...fast, fetchImpl: seq(resp(429, '')) })).kind === 'RATE_LIMITED');
ok('Retry-After is honoured', await (async () => { const waits = []; await S.fetchOrderClassified('o1', 'k', { ...fast, sleep: async (ms) => waits.push(ms), fetchImpl: seq(resp(429, '', { 'retry-after': '7' }), resp(200, {})) }); return waits.includes(7000); })());
ok('500 then 200 -> OK', (await S.fetchOrderClassified('o1', 'k', { ...fast, fetchImpl: seq(resp(500, 'x'), resp(200, {})) })).kind === 'OK');
ok('network error -> ERROR', (await S.fetchOrderClassified('o1', 'k', { ...fast, maxRetries: 1, fetchImpl: seq(new Error('boom')) })).kind === 'ERROR');

console.log('\n§5 resolveOrderAcrossStores — orders tagged to the wrong store are still found:');
const stores = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }];
const keyOf = (id) => ({ a: 'KEY_A', b: 'KEY_B' })[id] || null;
ok('candidateStores: hint first, then the others, duplicates by key removed', JSON.stringify(S.candidateStores('b', stores, keyOf).map((c) => c.storeId)) === '["b","a"]' && S.candidateStores('a', stores, () => 'SAME').length === 1);
const fakeByKey = (map) => async (url, opts) => { const r = map[opts.headers['Api-Key']]; return r || resp(400, { message: 'record not found' }); };
{
  const r = await S.resolveOrderAcrossStores('o1', 'a', { ...fast, stores, keyOf, fetchImpl: fakeByKey({ KEY_B: resp(200, { status: 'pending', store_id: 'EO-B' }) }) });
  ok('tagged "a" but only key "b" can see it -> found with b (tag-mismatch is detectable)', r.kind === 'OK' && r.foundWithStoreId === 'b');
  const r2 = await S.resolveOrderAcrossStores('o1', 'a', { ...fast, stores, keyOf, fetchImpl: fakeByKey({}) });
  ok('no key can see it -> NOT_FOUND', r2.kind === 'NOT_FOUND');
  const r3 = await S.resolveOrderAcrossStores('o1', 'a', { ...fast, stores, keyOf, maxRetries: 0, fetchImpl: fakeByKey({ KEY_A: resp(429, '') }) });
  ok('one key rate-limited + one not-found -> RATE_LIMITED (never claim "not found" when we could not ask)', r3.kind === 'RATE_LIMITED');
}

// ============================ Part B — DB-backed, disposable ============================
console.log('\n§6 DB-backed: trust + reconcile + remap on disposable stores (cleaned up):');
const SA = 'eo-test-a', SB = 'eo-test-b', SC = 'eo-test-c';
const ID = (s, i) => `eotest-${s}-${i}`;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);
const pA = await prisma.product.create({ data: { product_name: '__eo_test_pa__', store_id: SA, selling_price: 100 } });
const pB = await prisma.product.create({ data: { product_name: '__eo_test_pb__', store_id: SB, selling_price: 100 } });
const allOrderIds = [];
async function seed(store, productId, n, { daysAgo, statuses = {} }) {
  for (let i = 0; i < n; i++) {
    const oid = ID(store, i); allOrderIds.push(oid);
    const raw = statuses[i] || 'pending';
    await prisma.easyOrdersOrder.create({ data: { order_id: oid, cart_item_id: `${oid}-c`, product_id: productId, date: iso(daysAgo), status: EO.normalizeStatus(raw), raw_status: raw, quantity: 1, store_id: store, matched: !!productId } });
  }
}
const cleanup = async () => {
  await prisma.easyOrdersOrder.deleteMany({ where: { store_id: { in: [SA, SB, SC] } } });
  await prisma.dailyOrder.deleteMany({ where: { product_id: { in: [pA.id, pB.id] } } }).catch(() => {});
  await prisma.product.deleteMany({ where: { id: { in: [pA.id, pB.id] } } });
};
try {
  await prisma.easyOrdersOrder.deleteMany({ where: { store_id: { in: [SA, SB, SC] } } }); // leftovers from a crashed run
  await seed(SA, pA.id, 40, { daysAgo: 6, statuses: { 0: 'delivered' } });                    // 1/40 moved -> NO_STATUS_SIGNAL
  await seed(SB, pB.id, 40, { daysAgo: 6, statuses: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, i % 2 ? 'delivered' : 'confirmed'])) }); // 50% -> OK
  await seed(SC, null, 10, { daysAgo: 6 });                                                   // too few -> INSUFFICIENT_SAMPLE
  S.invalidateStatusTrustCache();
  const tA = await S.getStoreStatusTrust(SA, { force: true }), tB = await S.getStoreStatusTrust(SB, { force: true }), tC = await S.getStoreStatusTrust(SC, { force: true });
  ok('store with 1/40 mature orders moved -> NO_STATUS_SIGNAL', tA.state === 'NO_STATUS_SIGNAL', JSON.stringify(tA));
  ok('store with healthy movement -> OK', tB.state === 'OK', JSON.stringify(tB));
  ok('store with too few mature orders -> INSUFFICIENT_SAMPLE', tC.state === 'INSUFFICIENT_SAMPLE');
  ok('trust is cached (second call does not re-query within the TTL)', (await S.getStoreStatusTrust(SA)).checkedAt === tA.checkedAt);

  // --- central consumers
  const { getProductPerformance } = await imp('../services/amb/productPerformance.js');
  const perfA = await getProductPerformance({ productId: pA.id, windowName: 'last7' });
  const perfB = await getProductPerformance({ productId: pB.id, windowName: 'last7' });
  ok('performance block: NO_STATUS_SIGNAL store -> confirmation/delivery RATES withheld (not shown as 2.5%)', perfA.easyOrders.confirmationRate === null && perfA.easyOrders.deliveryRate === null && perfA.easyOrders.statusTrust?.state === 'NO_STATUS_SIGNAL' && /غير محدّثة/.test(perfA.easyOrders.rateNote || ''), JSON.stringify({ c: perfA.easyOrders.confirmationRate, s: perfA.easyOrders.statusTrust?.state }));
  ok('performance block: healthy store still reports a real confirmation rate', perfB.easyOrders.confirmationRate === 0.5, String(perfB.easyOrders.confirmationRate));
  const { buildCodQualityReport } = await imp('../services/amb/codQualityBrain.js');
  const codA = await buildCodQualityReport({ productId: pA.id, storeId: SA, from: iso(7), to: iso(0), pkg: {} });
  ok('COD quality: rates withheld + trust attached for a NO_STATUS_SIGNAL store', codA.productLevel.confirmationRate === null && codA.productLevel.orders === 40 && codA.statusTrust.state === 'NO_STATUS_SIGNAL');
  const { computeProductDataQuality } = await imp('../services/amb/dataQuality.js');
  const dqA = await computeProductDataQuality({ productId: pA.id, storeId: SA, windowName: 'last7' });
  ok('Data Quality exposes the Easy Orders status trust', dqA.ok && dqA.easyOrders.statusTrust?.state === 'NO_STATUS_SIGNAL');
  const P = await imp('../services/amb/advisorPlan.js');
  const base = { productId: 1, productName: 'x', storeId: 's', windowName: 'last7', settings: { ambDefaultTargetCpa: 120, ambMinSpendBeforeDecision: 150, ambMinPurchasesBeforeScaling: 5 }, pkg: { decision: 'KEEP_TESTING', confidence: 'MEDIUM', dataQuality: { status: 'VERIFIED' }, health: { band: 'GOOD' }, winners: {}, businessConversionRate: {}, priceTestOpportunity: {}, diagnosis: { bottleneck: { category: 'CONFIRMATION_PROBLEM', confidence: 'LIKELY', evidence: 'e' }, metrics: { totalSpend: 900, metaPurchases: 20, avgCpa: 70, ctr: 3, cvr: 2 } }, creativeIntel: {} }, growth: {}, ladder: { stage: 'TESTING' }, profit: { state: 'PROFITABLE', configState: 'KNOWN' }, stock: { status: 'SAFE' }, fatigueStates: [], actionPlan: {}, incidents: [], learning: { entries: [] }, dq: { ok: true, overallStatus: 'RECONCILED', age: { status: 'OK' }, gender: { status: 'OK' }, region: { status: 'OK' }, campaignPurchases: { status: 'OK' }, mapping: { status: 'OK', includedCampaignIds: [] } }, priorRecs: [], competitor: [], matrix: [], productRow: {} };
  const recentSmall = P.composePlan({ ...base, cod: { productLevel: { orders: 12, pending: 12, confirmed: 3, cancelled: 0, delivered: 0, returned: 0 }, codBlocksScale: true, statusTrust: { state: 'NO_STATUS_SIGNAL', share: 0.004, cutoffDate: '2026-09-25' } } });
  ok('advisor: store-level NO_STATUS_SIGNAL makes COD status unknown even when the product sample is small/recent', recentSmall.status.primaryProblem === 'COD_STATUS_UNKNOWN' && recentSmall.cod.statusUnknown === true);
  const trusted = P.composePlan({ ...base, cod: { productLevel: { orders: 60, pending: 20, confirmed: 8, cancelled: 25, delivered: 4, returned: 3, confirmationRate: 0.15 }, codBlocksScale: true, statusTrust: { state: 'OK', share: 0.6 } } });
  ok('advisor: with a trusted status signal a real confirmation problem is still reported as operational', trusted.status.primaryProblem === 'COD_PROBLEM');

  // --- reconcile with a FAKE Easy Orders (only our disposable order ids are ever considered)
  S.resetReconcileState(); S.resetRateBuckets();
  const eoState = { // order -> {key allowed, status}
    [ID(SA, 1)]: { owner: 'KEY_A', status: 'delivered' },       // moves PENDING -> DELIVERED
    [ID(SA, 2)]: { owner: 'KEY_A', status: 'in_delivery' },     // moves PENDING -> CONFIRMED (NOT delivered)
    [ID(SA, 3)]: { owner: 'KEY_A', status: 'canceled' },        // moves PENDING -> CANCELLED
    [ID(SA, 4)]: { owner: 'KEY_B', status: 'pending', store_id: 'EO-B-UUID' }, // tagged A, owned by B -> mismatch + store uuid fill
    [ID(SA, 5)]: { owner: 'KEY_A', status: 'pending', store_id: 'EO-A-UUID' }, // unchanged, uuid fill
    // ID(SA,6) is visible to nobody -> NOT_FOUND
  };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const id = url.split('/').pop(); calls.push([id, opts.headers['Api-Key']]);
    const e = eoState[id];
    if (!e || e.owner !== opts.headers['Api-Key']) return resp(400, { message: 'record not found' });
    return resp(200, { id, status: e.status, store_id: e.store_id });
  };
  const deps = { ...fast, candidates: [{ storeId: SA, key: 'KEY_A' }, { storeId: SB, key: 'KEY_B' }], fetchImpl };
  const only = { orderIds: [1, 2, 3, 4, 5, 6].map((i) => ID(SA, i)) };
  const dry = await S.reconcileOrders({ limit: 20, dryRun: true, only, deps });
  const rowsAfterDry = await prisma.easyOrdersOrder.findMany({ where: { order_id: { in: only.orderIds } }, select: { order_id: true, status: true } });
  ok('dry-run reports the 3 real changes but writes NOTHING', dry.changed === 3 && rowsAfterDry.every((r) => r.status === 'PENDING'), JSON.stringify({ changed: dry.changed, st: rowsAfterDry.map((r) => r.status) }));
  S.resetReconcileState();
  const real = await S.reconcileOrders({ limit: 20, only, deps });
  ok('the scheduled-job default NEVER fills easy_orders_store_id (no hidden backfill)', (await prisma.easyOrdersOrder.findMany({ where: { order_id: { in: only.orderIds } }, select: { easy_orders_store_id: true } })).every((r) => r.easy_orders_store_id === null));
  S.resetReconcileState();
  await S.reconcileOrders({ limit: 20, only, fillStoreId: true, deps });
  const get = async (i) => (await prisma.easyOrdersOrder.findFirst({ where: { order_id: ID(SA, i) } }));
  ok('applied: delivered -> DELIVERED, canceled -> CANCELLED', (await get(1)).status === 'DELIVERED' && (await get(3)).status === 'CANCELLED');
  ok('applied: in_delivery -> CONFIRMED (not DELIVERED) with the raw status kept', (await get(2)).status === 'CONFIRMED' && (await get(2)).raw_status === 'in_delivery');
  ok('unchanged order is left alone', (await get(5)).status === 'PENDING');
  ok('counters are exact: checked 5, changed 3, notFound 1, no rate-limit/errors', real.checked === 5 && real.changed === 3 && real.notFound === 1 && real.rateLimited === 0 && real.errors === 0, JSON.stringify({ c: real.checked, ch: real.changed, nf: real.notFound }));
  ok('tag mismatch detected and counted (tagged a, owned by b)', real.tagMismatch['eo-test-a->eo-test-b'] === 1, JSON.stringify(real.tagMismatch));
  ok("Easy Orders' own store UUID is recorded where it was never known (additive metadata)", (await get(4)).easy_orders_store_id === 'EO-B-UUID' && (await get(5)).easy_orders_store_id === 'EO-A-UUID');
  ok('every key was tried in order for the cross-owned order (a then b)', calls.filter(([id]) => id === ID(SA, 4)).map(([, k]) => k).slice(0, 2).join() === 'KEY_A,KEY_B');
  const callsBefore = calls.length;
  const again = await S.reconcileOrders({ limit: 20, only, deps });
  ok('idempotent + bounded: an immediate second pass re-checks nothing (recheck window) and changes nothing', again.checked === 0 && again.changed === 0 && calls.length === callsBefore);
  S.resetReconcileState();
  const third = await S.reconcileOrders({ limit: 20, only, deps });
  ok('forced re-pass is stable: 0 changes (delivered/cancelled orders left the active set; 3 remain checked)', third.changed === 0 && third.checked === 3 && third.notFound === 1, JSON.stringify({ c: third.checked, ch: third.changed, nf: third.notFound }));

  // coverage: the resumable cursor must not skip orders between batches
  S.resetReconcileState(); S.resetRateBuckets();
  const covIds = Array.from({ length: 10 }, (_, i) => `eotest-cov-${i}`);
  for (const id of covIds) await prisma.easyOrdersOrder.create({ data: { order_id: id, cart_item_id: `${id}-c`, product_id: null, date: iso(20), status: 'PENDING', raw_status: 'pending', quantity: 1, store_id: SB, matched: false } });
  const seen = new Set();
  const covDeps = { ...fast, candidates: [{ storeId: SB, key: 'KEY_B' }], fetchImpl: async (url) => { seen.add(url.split('/').pop()); return resp(200, { status: 'pending' }); } };
  for (let i = 0; i < 3; i++) await S.reconcileOrders({ limit: 4, only: { orderIds: covIds }, deps: covDeps });
  ok('cursor coverage: 3 batches of 4 cover all 10 orders (no order skipped between batches)', seen.size === 10, String(seen.size));

  // rate-limit storm: stops early instead of grinding through the whole backlog
  S.resetReconcileState(); S.resetRateBuckets();
  const stormDeps = { ...fast, maxRetries: 0, candidates: [{ storeId: SA, key: 'KEY_A' }], fetchImpl: async () => resp(429, '') };
  const storm = await S.reconcileOrders({ limit: 20, only: { orderIds: Array.from({ length: 10 }, (_, i) => ID(SB, i + 20)) }, deps: stormDeps });
  const stormAny = await S.reconcileOrders({ limit: 20, only: { orderIds: Array.from({ length: 10 }, (_, i) => ID(SB, i)) }, deps: stormDeps });
  ok('sustained 429s stop the batch early and are reported as rateLimited (not silently skipped)', stormAny.stoppedEarly === 'RATE_LIMITED' && stormAny.rateLimited === 3 && stormAny.changed === 0, JSON.stringify({ r: stormAny.rateLimited, s: stormAny.stoppedEarly }));
  void storm;

  // remap of historically mis-bucketed rows (scoped to our disposable order only)
  await prisma.easyOrdersOrder.updateMany({ where: { order_id: ID(SC, 0) }, data: { status: 'DELIVERED', raw_status: 'in_delivery' } }); // what the OLD normaliser stored
  const dryRemap = await S.remapStoredStatuses({ dryRun: true, orderIds: [ID(SC, 0)] });
  ok('remap dry-run finds the in_delivery-stored-as-DELIVERED row without writing', dryRemap.wrong === 1 && (await prisma.easyOrdersOrder.findFirst({ where: { order_id: ID(SC, 0) } })).status === 'DELIVERED');
  const realRemap = await S.remapStoredStatuses({ orderIds: [ID(SC, 0)] });
  ok('remap fixes it to CONFIRMED and leaves raw_status', realRemap.fixed === 1 && (await prisma.easyOrdersOrder.findFirst({ where: { order_id: ID(SC, 0) } })).status === 'CONFIRMED');

  // the scheduler job: never overlaps
  const R = await imp('../services/easyOrdersReconcile.js');
  S.reconcileHealth.running = true;
  ok('reconcile job refuses to overlap a running tick', (await R.reconcileActiveOrders()) === null);
  S.reconcileHealth.running = false;
} finally { await cleanup(); }
const leftovers = await prisma.easyOrdersOrder.count({ where: { store_id: { in: [SA, SB, SC] } } });
ok('disposable rows cleaned up', leftovers === 0, String(leftovers));

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
