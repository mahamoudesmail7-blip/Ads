// Easy Orders WEBHOOK auth + store-attribution regression (2026-10-02). Real HTTP against an in-process Express app with the
// real router, FAKE secrets and injected ingest/status/owner dependencies — no DB, no Easy Orders call, no production data.
//   node src/scripts/easyOrdersWebhookTest.js
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import express from 'express';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };

const A = await imp('../services/easyOrdersWebhookAuth.js');
const W = await imp('../routes/webhooks.js');

// FAKE secrets (never real ones) — chosen so a leak into any log line is detectable by substring
const SEC = { defOrder: 'FAKE-DEFAULT-ORDER-0001', defStatus: 'FAKE-DEFAULT-STATUS-0002', store2: 'FAKE-STORE-TWO-SECRET-3' };
const stores = [{ id: 'default', enabled: true }, { id: 'trendy-storeee', enabled: true }, { id: 'nosecret', enabled: true }];
const storeSecret = (id) => ({ 'trendy-storeee': SEC.store2 })[id] || null;
const env = { EASYORDERS_WEBHOOK_SECRET: SEC.defOrder, EASYORDERS_STATUS_WEBHOOK_SECRET: SEC.defStatus };
const registry = () => A.buildSecretRegistry({ env, stores, storeSecret, defaultStoreId: 'default' });

console.log('§1 secret registry + matching (pure):');
const reg = registry();
ok('registry: default order secret is ORDER_CREATED-only, default status secret is STATUS_UPDATE-only, store secret works for both', reg.length === 3 && reg.find((r) => r.name === 'EASYORDERS_WEBHOOK_SECRET').events === 'ORDER_CREATED' && reg.find((r) => r.name === 'EASYORDERS_STATUS_WEBHOOK_SECRET').events === 'STATUS_UPDATE' && reg.find((r) => r.storeId === 'trendy-storeee').events === 'ANY');
ok('default order secret + ORDER_CREATED -> default store', A.matchWebhookSecret(SEC.defOrder, 'ORDER_CREATED', reg).storeId === 'default');
ok("the other account's secret identifies ITS store whichever URL it was sent to", A.matchWebhookSecret(SEC.store2, 'ORDER_CREATED', reg).storeId === 'trendy-storeee' && A.matchWebhookSecret(SEC.store2, 'STATUS_UPDATE', reg).storeId === 'trendy-storeee');
const wrongType = A.matchWebhookSecret(SEC.defOrder, 'STATUS_UPDATE', reg);
ok('right secret but wrong EVENT TYPE is rejected and the diagnosis says exactly that', !wrongType.ok && wrongType.diagnosis.headerEqualsKnownSecret[0]?.name === 'EASYORDERS_WEBHOOK_SECRET');
const nothing = A.matchWebhookSecret('totally-wrong', 'ORDER_CREATED', reg);
ok('unknown secret -> rejected, diagnosis has lengths/booleans only', !nothing.ok && nothing.diagnosis.headerPresent === true && nothing.diagnosis.headerEqualsKnownSecret.length === 0 && !JSON.stringify(nothing.diagnosis).includes(SEC.defOrder) && !JSON.stringify(nothing.diagnosis).includes('totally-wrong'));
ok('missing header -> rejected with headerPresent=false', A.matchWebhookSecret(undefined, 'ORDER_CREATED', reg).diagnosis.headerPresent === false);
ok('safeEqual is exact and empty-safe', A.safeEqual('a', 'a') && !A.safeEqual('a', 'b') && !A.safeEqual('', '') && !A.safeEqual(null, 'x'));
ok('same secret value registered for two stores -> flagged ambiguous (first match used, never silent)', (() => { const r = A.buildSecretRegistry({ env: { EASYORDERS_WEBHOOK_SECRET: 'DUP' }, stores: [{ id: 'default' }, { id: 'b' }], storeSecret: (id) => (id === 'b' ? 'DUP' : null), defaultStoreId: 'default' }); const m = A.matchWebhookSecret('DUP', 'ORDER_CREATED', r); return m.ok && m.ambiguous?.length === 2; })());

console.log('\n§2 verifyOrderOwner never blocks / throws:');
ok('verified owner is returned', (await A.verifyOrderOwner('o', 'default', { resolve: async () => ({ kind: 'OK', foundWithStoreId: 'trendy-storeee', order: { store_id: 'EO-UUID' } }) })).storeId === 'trendy-storeee');
ok('not found / rate-limited -> unverified (not an error)', (await A.verifyOrderOwner('o', 'default', { resolve: async () => ({ kind: 'RATE_LIMITED' }) })).verified === false);
ok('a hanging lookup times out instead of stalling the webhook', await (async () => { const t = Date.now(); const r = await A.verifyOrderOwner('o', 'default', { timeoutMs: 80, resolve: () => new Promise(() => {}) }); return r.verified === false && r.reason === 'TIMEOUT' && Date.now() - t < 1500; })());
ok('a throwing lookup -> unverified', (await A.verifyOrderOwner('o', 'default', { resolve: async () => { throw new Error('boom'); } })).verified === false);

console.log('\n§3 HTTP: the route decides nothing — the secret + verified owner decide the store:');
const logs = [];
const fakeLogger = { info: (m, f) => logs.push(['info', m, f]), warn: (m, f) => logs.push(['warn', m, f]), error: (m, f) => logs.push(['error', m, f]), debug: () => {} };
const calls = { ingest: [], apply: [] };
let ownerAnswer = { verified: true, storeId: 'default' };
let resolveAnswer = { kind: 'NOT_FOUND' };
const existingRows = new Set(['existing-order']);
const router = W.createWebhooksRouter({
  logger: fakeLogger, registry, getStore: (id) => (stores.some((s) => s.id === id) ? { id } : null), getStoreWebhookSecret: storeSecret, defaultStoreId: () => 'default',
  verifyOwner: async () => ownerAnswer, resolveOrder: async () => resolveAnswer,
  orderRows: async (id) => (existingRows.has(id) ? [{ id: 1 }] : []),
  ingestOrder: async (order, storeId) => { calls.ingest.push([order.id, storeId]); }, applyStatusToOrder: async (id, st) => { calls.apply.push([id, st]); return { totalRows: 1, changedRows: 1 }; },
});
const app = express(); app.use(express.json()); app.use('/api/webhooks', router);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/api/webhooks`;
const post = async (path, body, secret) => { const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret !== undefined ? { secret } : {}), 'user-agent': 'go-resty/2.7.0' }, body: JSON.stringify(body) }); return { status: res.status, json: await res.json().catch(() => null) }; };
const order = (id) => ({ id, cart_items: [{ id: 'c1' }] });
const statusEvt = (id, st = 'delivered') => ({ event_type: 'order-status-update', order_id: id, new_status: st });
const last = () => calls.ingest[calls.ingest.length - 1];
try {
  ownerAnswer = { verified: true, storeId: 'default' };
  let r = await post('/easyorders', order('o1'), SEC.defOrder);
  ok('bare URL + default order secret + owner verified default -> 200, filed under default', r.status === 200 && last()[1] === 'default');

  ownerAnswer = { verified: true, storeId: 'trendy-storeee' };
  r = await post('/easyorders', order('o2'), SEC.store2);
  ok("bare URL + the OTHER account's secret -> 200 (was 401) and filed under ITS store", r.status === 200 && last()[0] === 'o2' && last()[1] === 'trendy-storeee');
  ok('...and the URL/secret disagreement is logged (secret decides)', logs.some((l) => l[1].includes('secret belongs to a different store')));

  ownerAnswer = { verified: true, storeId: 'trendy-storeee' };
  r = await post('/easyorders', order('o3'), SEC.defOrder);
  ok('the real production case: right-looking secret/URL but Easy Orders says the OTHER account owns it -> verified owner wins (TAG_CORRECTED)', r.status === 200 && last()[1] === 'trendy-storeee' && W.webhookAuthHealth.tagCorrected >= 1);

  ownerAnswer = { verified: false, reason: 'RATE_LIMITED' };
  r = await post('/easyorders', order('o4'), SEC.defOrder);
  ok('owner lookup unavailable -> still ingested (never dropped), filed by the secret store, flagged unverified', r.status === 200 && last()[1] === 'default' && W.webhookAuthHealth.ownerUnverified >= 1);

  const before = calls.ingest.length;
  r = await post('/easyorders', order('o5'), 'WRONG-SECRET-XYZ');
  ok('wrong secret -> 401 and NOTHING ingested', r.status === 401 && r.json.error === 'INVALID_SECRET' && calls.ingest.length === before);
  const rej = logs.find((l) => l[1].includes('REJECTED'));
  ok('the rejection explains itself: route, event type, known secret NAMES + lengths, header presence', !!rej && rej[2].route === '/easyorders' && rej[2].eventType === 'ORDER_CREATED' && rej[2].headerPresent === true && Array.isArray(rej[2].knownSecrets) && rej[2].knownSecrets.every((k) => k.name && typeof k.length === 'number'));
  ok('NO secret value (real or presented) appears anywhere in any log line', !JSON.stringify(logs).includes('FAKE-') && !JSON.stringify(logs).includes('WRONG-SECRET-XYZ'));
  const warnsBefore = logs.filter((l) => l[1].includes('REJECTED')).length;
  for (let i = 0; i < 5; i++) await post('/easyorders', order('x' + i), 'WRONG-SECRET-XYZ');
  ok('a retry storm is throttled: still ONE rejection log line', logs.filter((l) => l[1].includes('REJECTED')).length === warnsBefore);
  r = await post('/easyorders', order('o6'));
  ok('missing secret header -> 401 with headerPresent=false in the diagnosis', r.status === 401 && W.webhookAuthHealth.lastRejection.headerPresent === false);

  ownerAnswer = { verified: true, storeId: 'default' };
  calls.apply.length = 0;
  r = await post('/easyorders', statusEvt('existing-order'), SEC.defStatus);
  ok('status-update + the default STATUS secret -> 200 and applied', r.status === 200 && calls.apply[0]?.[0] === 'existing-order');
  r = await post('/easyorders', statusEvt('existing-order'), SEC.defOrder);
  ok('status-update sent with the ORDER-CREATED secret -> 401, diagnosis says "right secret, wrong event type"', r.status === 401 && W.webhookAuthHealth.lastRejection.headerEqualsKnownSecret[0]?.name === 'EASYORDERS_WEBHOOK_SECRET' && W.webhookAuthHealth.lastRejection.eventType === 'STATUS_UPDATE');
  resolveAnswer = { kind: 'OK', foundWithStoreId: 'trendy-storeee', order: { id: 'unseen', cart_items: [{ id: 'c' }] } };
  r = await post('/easyorders', statusEvt('unseen'), SEC.defStatus);
  ok('status-update for an UNSEEN order is fetched across stores and ingested under its verified owner', r.status === 200 && last()[0] === 'unseen' && last()[1] === 'trendy-storeee');

  ownerAnswer = { verified: true, storeId: 'trendy-storeee' };
  r = await post('/easyorders/trendy-storeee', order('o7'), SEC.store2);
  ok('store URL + store secret -> 200 under that store', r.status === 200 && last()[1] === 'trendy-storeee');
  r = await post('/easyorders/trendy-storeee', statusEvt('existing-order'), SEC.store2);
  ok("a store's single secret works for status events too", r.status === 200);
  ownerAnswer = { verified: true, storeId: 'default' };
  r = await post('/easyorders/trendy-storeee', order('o8'), SEC.defOrder);
  ok('store URL + the default secret -> accepted but filed by the secret/owner (default), not the URL', r.status === 200 && last()[1] === 'default');
  r = await post('/easyorders/nope', order('o9'), SEC.store2);
  ok('unknown store URL -> 404 UNKNOWN_STORE', r.status === 404 && r.json.error === 'UNKNOWN_STORE');
  r = await post('/easyorders/nosecret', order('o10'), SEC.store2);
  ok('store without a configured webhook secret -> 400 STORE_WEBHOOK_NOT_CONFIGURED', r.status === 400 && r.json.error === 'STORE_WEBHOOK_NOT_CONFIGURED');

  r = await post('/easyorders', { hello: 'world' }, SEC.defOrder);
  ok('bare URL: unrecognised payload -> 400 even with a valid secret (shape first)', r.status === 400 && r.json.error === 'UNRECOGNIZED_PAYLOAD');
  r = await post('/easyorders/trendy-storeee', { hello: 'world' }, 'bad');
  ok('store URL: bad secret is checked before the shape -> 401', r.status === 401);
  r = await post('/easyorders/trendy-storeee', { hello: 'world' }, SEC.store2);
  ok('store URL: valid secret + unrecognised payload -> 400', r.status === 400);
  ok('health counters moved (accepted / rejected / tagCorrected / routeSecretMismatch)', W.webhookAuthHealth.accepted > 5 && W.webhookAuthHealth.rejected > 5 && W.webhookAuthHealth.tagCorrected >= 1 && W.webhookAuthHealth.routeSecretMismatch >= 1);
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
