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
const storeSecretEntries = (id) => (id === 'trendy-storeee' ? { entries: [{ name: 'store:trendy-storeee:webhookSecretEnv', value: SEC.store2, events: 'ANY' }], unsetNames: [] } : { entries: [], unsetNames: [] });
const env = { EASYORDERS_WEBHOOK_SECRET: SEC.defOrder, EASYORDERS_STATUS_WEBHOOK_SECRET: SEC.defStatus };
const registry = () => A.buildSecretRegistry({ env, stores, storeSecretEntries, defaultStoreId: 'default' });

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
ok('same secret value registered for two stores -> flagged ambiguous (first match used, never silent)', (() => { const r = A.buildSecretRegistry({ env: { EASYORDERS_WEBHOOK_SECRET: 'DUP' }, stores: [{ id: 'default' }, { id: 'b' }], storeSecretEntries: (id) => (id === 'b' ? { entries: [{ name: 'b-secret', value: 'DUP', events: 'ANY' }], unsetNames: [] } : { entries: [], unsetNames: [] }), defaultStoreId: 'default' }); const m = A.matchWebhookSecret('DUP', 'ORDER_CREATED', r); return m.ok && m.ambiguous?.length === 2; })());

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
  logger: fakeLogger, registry, getStore: (id) => (stores.some((s) => s.id === id) ? { id } : null), storeHasWebhookSecret: (id) => storeSecretEntries(id).entries.length > 0, defaultStoreId: () => 'default',
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

// ============================ §4 — per-EVENT secrets per store (Easy Orders issues one secret per webhook TYPE) ============================
console.log('\n§4 per-event secrets for a store (real config functions, fake secrets, temp env restored after):');
const S = await imp('../services/easyOrdersStores.js');
const ENV_KEYS = ['EASYORDERS_STORES_JSON', 'EASYORDERS_WEBHOOK_SECRET', 'EASYORDERS_STATUS_WEBHOOK_SECRET', 'T_DEF_KEY', 'T_TR_KEY', 'T_STORE_2_WEBHOOK_SECRET', 'T_STORE_2_ORDER_WEBHOOK_SECRET', 'T_STORE_2_STATUS_WEBHOOK_SECRET', 'CUSTOM_ORDER', 'CUSTOM_STATUS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (o) => { for (const k of ENV_KEYS) delete process.env[k]; Object.assign(process.env, o); };
const TR_JSON = JSON.stringify([{ id: 'default', name: 'D', apiKeyEnv: 'T_DEF_KEY' }, { id: 'trendy-storeee', name: 'T', apiKeyEnv: 'T_TR_KEY', webhookSecretEnv: 'T_STORE_2_WEBHOOK_SECRET' }]);
const base4 = { EASYORDERS_STORES_JSON: TR_JSON, T_DEF_KEY: 'k1', T_TR_KEY: 'k2', EASYORDERS_WEBHOOK_SECRET: 'FAKE-DEF-ORDER-9', EASYORDERS_STATUS_WEBHOOK_SECRET: 'FAKE-DEF-STATUS-9', T_STORE_2_ORDER_WEBHOOK_SECRET: 'FAKE-T2-ORDER-A', T_STORE_2_STATUS_WEBHOOK_SECRET: 'FAKE-T2-STATUS-B' };
try {
  setEnv(base4);
  const names = S.storeWebhookSecretEnvNames('trendy-storeee');
  ok('convention: <X>_WEBHOOK_SECRET -> <X>_ORDER_WEBHOOK_SECRET / <X>_STATUS_WEBHOOK_SECRET (no JSON edit needed)', names.legacy === 'T_STORE_2_WEBHOOK_SECRET' && names.order === 'T_STORE_2_ORDER_WEBHOOK_SECRET' && names.status === 'T_STORE_2_STATUS_WEBHOOK_SECRET', JSON.stringify(names));
  const ent = S.getStoreWebhookSecretEntries('trendy-storeee');
  ok('entries: order secret -> ORDER_CREATED only, status secret -> STATUS_UPDATE only (legacy unset is simply absent)', ent.entries.length === 2 && ent.entries.find((e) => e.name.includes('ORDER')).events === 'ORDER_CREATED' && ent.entries.find((e) => e.name.includes('STATUS')).events === 'STATUS_UPDATE' && ent.unsetNames.length === 0);
  const reg4 = A.buildSecretRegistry({ env: process.env, stores: S.listStores(), defaultStoreId: 'default' });
  ok('registry now holds the default store\'s two dedicated secrets + the Trendy store\'s two per-event secrets', reg4.length === 4 && reg4.filter((r) => r.storeId === 'trendy-storeee').length === 2);
  ok('Trendy "Orders" webhook secret -> ORDER_CREATED -> trendy-storeee', A.matchWebhookSecret('FAKE-T2-ORDER-A', 'ORDER_CREATED', reg4).storeId === 'trendy-storeee');
  ok('Trendy "Order Status Update" webhook secret -> STATUS_UPDATE -> trendy-storeee', A.matchWebhookSecret('FAKE-T2-STATUS-B', 'STATUS_UPDATE', reg4).storeId === 'trendy-storeee');
  const crossed = A.matchWebhookSecret('FAKE-T2-ORDER-A', 'STATUS_UPDATE', reg4);
  ok('the Trendy ORDER secret on a STATUS event is rejected and the diagnosis names the right variable', !crossed.ok && crossed.diagnosis.headerEqualsKnownSecret[0]?.name === 'T_STORE_2_ORDER_WEBHOOK_SECRET');
  ok("default store's dedicated secrets are untouched by the new variables", A.matchWebhookSecret('FAKE-DEF-ORDER-9', 'ORDER_CREATED', reg4).storeId === 'default' && A.matchWebhookSecret('FAKE-DEF-STATUS-9', 'STATUS_UPDATE', reg4).storeId === 'default' && !A.matchWebhookSecret('FAKE-DEF-STATUS-9', 'ORDER_CREATED', reg4).ok);

  setEnv({ ...base4, T_STORE_2_ORDER_WEBHOOK_SECRET: '' });
  const regMissing = A.buildSecretRegistry({ env: process.env, stores: S.listStores(), defaultStoreId: 'default' });
  const miss = A.matchWebhookSecret('anything', 'ORDER_CREATED', regMissing);
  ok('an expected-but-unset per-event variable is NAMED in the rejection diagnosis (so the operator knows which variable to create)', !miss.ok && miss.diagnosis.expectedButUnset.includes('T_STORE_2_ORDER_WEBHOOK_SECRET') && !JSON.stringify(miss.diagnosis).includes('FAKE-'));

  setEnv({ ...base4, T_STORE_2_WEBHOOK_SECRET: 'FAKE-T2-LEGACY-C', T_STORE_2_ORDER_WEBHOOK_SECRET: '', T_STORE_2_STATUS_WEBHOOK_SECRET: '' });
  const regLegacy = A.buildSecretRegistry({ env: process.env, stores: S.listStores(), defaultStoreId: 'default' });
  ok('backward compatible: the legacy single store secret still works for BOTH event types', A.matchWebhookSecret('FAKE-T2-LEGACY-C', 'ORDER_CREATED', regLegacy).storeId === 'trendy-storeee' && A.matchWebhookSecret('FAKE-T2-LEGACY-C', 'STATUS_UPDATE', regLegacy).storeId === 'trendy-storeee');

  const EXPL = JSON.stringify([{ id: 'default', name: 'D', apiKeyEnv: 'T_DEF_KEY' }, { id: 'trendy-storeee', name: 'T', apiKeyEnv: 'T_TR_KEY', orderWebhookSecretEnv: 'CUSTOM_ORDER', statusWebhookSecretEnv: 'CUSTOM_STATUS' }]);
  setEnv({ ...base4, EASYORDERS_STORES_JSON: EXPL, CUSTOM_ORDER: 'FAKE-CUSTOM-O', CUSTOM_STATUS: 'FAKE-CUSTOM-S' });
  const regExplicit = A.buildSecretRegistry({ env: process.env, stores: S.listStores(), defaultStoreId: 'default' });
  ok('explicit orderWebhookSecretEnv / statusWebhookSecretEnv in the store JSON override the convention', A.matchWebhookSecret('FAKE-CUSTOM-O', 'ORDER_CREATED', regExplicit).storeId === 'trendy-storeee' && A.matchWebhookSecret('FAKE-CUSTOM-S', 'STATUS_UPDATE', regExplicit).storeId === 'trendy-storeee');

  // real HTTP: BOTH Trendy webhooks post to the SAME bare URL with different secrets (the configuration the owner confirmed)
  setEnv(base4);
  const calls4 = { ingest: [], apply: [] };
  const router4 = W.createWebhooksRouter({ logger: fakeLogger, verifyOwner: async () => ({ verified: true, storeId: 'trendy-storeee' }), resolveOrder: async () => ({ kind: 'NOT_FOUND' }), orderRows: async () => [{ id: 1 }], ingestOrder: async (o, s) => { calls4.ingest.push([o.id, s]); }, applyStatusToOrder: async (id, st) => { calls4.apply.push([id, st]); return { totalRows: 1, changedRows: 1 }; } });
  const app4 = express(); app4.use(express.json()); app4.use('/api/webhooks', router4);
  const server4 = http.createServer(app4); await new Promise((r) => server4.listen(0, r));
  const base4url = `http://127.0.0.1:${server4.address().port}/api/webhooks`;
  const post4 = async (body, secret) => { const res = await fetch(base4url + '/easyorders', { method: 'POST', headers: { 'content-type': 'application/json', secret }, body: JSON.stringify(body) }); return res.status; };
  try {
    ok('Trendy "Orders" webhook -> bare /easyorders with its OWN secret -> 200 and filed under trendy-storeee', (await post4({ id: 'trendy-o1', cart_items: [{ id: 'c' }] }, 'FAKE-T2-ORDER-A')) === 200 && calls4.ingest.at(-1)?.[1] === 'trendy-storeee');
    ok('Trendy "Order Status Update" webhook -> same URL with ITS OWN secret -> 200 and applied', (await post4({ event_type: 'order-status-update', order_id: 'trendy-o1', new_status: 'confirmed' }, 'FAKE-T2-STATUS-B')) === 200 && calls4.apply.at(-1)?.[0] === 'trendy-o1');
    ok('swapped secrets are rejected (order secret on a status event)', (await post4({ event_type: 'order-status-update', order_id: 'trendy-o1', new_status: 'confirmed' }, 'FAKE-T2-ORDER-A')) === 401);
  } finally { server4.close(); }
} finally { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
