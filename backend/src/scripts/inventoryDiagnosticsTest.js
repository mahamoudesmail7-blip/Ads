// 📦 Inventory webhook TEMPORARY diagnostics: it must identify the sender's signing scheme / header names / payload shape WITHOUT ever recording a value.
// Pure + in-process route (no DB writes, no Meta).   node src/scripts/inventoryDiagnosticsTest.js
import 'dotenv/config';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const DX = await imp('../services/amb/inventoryDiagnostics.js');
const { createInventoryWebhookRouter, inventoryWebhookHealth } = await imp('../routes/inventoryWebhook.js');

const SECRET = `whsec_${crypto.randomBytes(18).toString('base64url')}`; // test-only
const body = JSON.stringify({ id: 'evt_secret_looking_id_123', type: 'inventory.stock_changed', created: 1791334000, data: { sku: 'SKU-SENSITIVE-VALUE', stock: 7 } });
const raw = Buffer.from(body);
const hexH = (key, msg, algo = 'sha256') => crypto.createHmac(algo, key).update(msg).digest('hex');
const b64H = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('base64');
const base = { host: 'x', 'content-type': 'application/json; charset=utf-8', 'user-agent': 'node', 'content-length': String(raw.length) };
const diag = (headers) => DX.diagnoseInventoryRequest({ headers: { ...base, ...headers }, rawBody: raw, secret: SECRET });

console.log('\n1. what is recorded');
let r = diag({ 'x-weird-name': 'v', 'x-bad name!': 'v' });
ok('header NAMES (lowercase, safe charset), content-type, UA, body size', r.headerNames.includes('x-weird-name') && !r.headerNames.some((n) => n.includes(' ')) && r.contentType === 'application/json; charset=utf-8' && r.userAgent === 'node' && r.bodyBytes === raw.length);
ok('top-level JSON key NAMES only + the event-type token', JSON.stringify(r.topLevelKeys) === '["id","type","created","data"]' && r.eventType.key === 'type' && r.eventType.value === 'inventory.stock_changed');
r = DX.diagnoseInventoryRequest({ headers: base, rawBody: Buffer.from('not json'), secret: SECRET });
ok('non-JSON body => "(not json)", no key names', r.topLevelKeys === '(not json)' && r.eventType === null);
r = DX.diagnoseInventoryRequest({ headers: base, rawBody: Buffer.from('{"__proto__x":1,"bad key":2,"ok_key":3,"event":"has spaces and secrets"}'), secret: SECRET });
ok('unsafe key names (with spaces) and unsafe event-type VALUES are dropped', JSON.stringify(r.topLevelKeys) === '["__proto__x","ok_key","event"]' && !r.topLevelKeys.includes('bad key') && r.eventType === null);
r = diag({ 'x-event-id': 'abc', 'x-timestamp': '1791334000', 'x-delivery': 'zzz' });
ok('header names that look like an id / a timestamp are listed (names only)', r.idHeaders.includes('x-event-id') && r.idHeaders.includes('x-delivery') && r.timestampHeaders.includes('x-timestamp'));

console.log('\n2. which header carries what — detected in memory, reported by NAME and scheme');
r = diag({ 'x-webhook-signature': hexH(SECRET, raw) });
ok('hex HMAC-SHA256 over the body', r.signatureMatches.length === 1 && r.signatureMatches[0].header === 'x-webhook-signature' && /hmac-sha256\(body\) hex \[key=utf8\]/.test(r.signatureMatches[0].scheme), JSON.stringify(r.signatureMatches));
r = diag({ 'x-hub-signature-256': `sha256=${hexH(SECRET, raw)}` });
ok('"sha256=<hex>" (GitHub style) is recognised with its prefix', r.signatureMatches[0]?.header === 'x-hub-signature-256' && r.signatureMatches[0].prefix === 'sha*=');
r = diag({ 'x-sig': b64H(SECRET, raw) });
ok('base64 HMAC over the body', /base64/.test(r.signatureMatches[0]?.scheme || ''));
const ts = '1791334000';
r = diag({ 'x-signature': `t=${ts},v1=${hexH(SECRET, `${ts}.${body}`)}` });
ok('Stripe style "t=..,v1=.." over "timestamp.body"', /hmac-sha256\(timestamp\.body\) hex/.test(r.signatureMatches[0]?.scheme || '') && r.signatureMatches[0].header === 'x-signature');
r = diag({ 'x-ts': ts, 'x-sig': hexH(SECRET, `${ts}.${body}`) });
ok('separate timestamp header + hex over "timestamp.body" (the timestamp header is found too)', /timestamp\.body/.test(r.signatureMatches[0]?.scheme || '') && r.timestampHeaders.includes('x-ts'));
const stripped = SECRET.replace(/^whsec_/, ''); const keyB = Buffer.from(stripped.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const msgId = 'msg_2abc', msgTs = '1791334001';
r = diag({ 'webhook-id': msgId, 'webhook-timestamp': msgTs, 'webhook-signature': `v1,${crypto.createHmac('sha256', keyB).update(`${msgId}.${msgTs}.${body}`).digest('base64')}` });
ok('Standard Webhooks / Svix ("whsec_" base64 key, id.timestamp.body, "v1,<b64>") is recognised', /id\.timestamp\.body\) base64 \[key=base64/.test(r.signatureMatches[0]?.scheme || '') && r.signatureMatches[0].prefix === 'v1' && r.idHeaders.includes('webhook-id') && r.timestampHeaders.includes('webhook-timestamp'), JSON.stringify(r));
r = diag({ 'x-api-key': SECRET });
ok('the secret sent as a plain header is reported by header NAME', r.secretInHeader.includes('x-api-key (exact)') && r.signatureMatches.length === 0);
r = diag({ authorization: `Bearer ${SECRET}` });
ok('"Authorization: Bearer <secret>" is reported as (Bearer) — by name', r.secretInHeader.includes('authorization (Bearer)'));
r = diag({ 'x-webhook-secret': 'a-completely-different-value-here-12345', 'x-signature': 'f'.repeat(64) });
ok('credential-looking headers that match NOTHING are listed as candidates (names only) so the owner can check the secret / scheme', r.signatureMatches.length === 0 && r.secretInHeader.length === 0 && r.signatureHeaderCandidates.includes('x-webhook-secret') && r.signatureHeaderCandidates.includes('x-signature'));
r = diag({});
ok('no credential headers at all => empty findings (the observed MISSING_CREDENTIALS case)', r.signatureMatches.length === 0 && r.secretInHeader.length === 0 && r.signatureHeaderCandidates.length === 0);
r = DX.diagnoseInventoryRequest({ headers: { ...base, 'x-webhook-signature': hexH(SECRET, raw) }, rawBody: raw, secret: '' });
ok('without a configured secret nothing is compared', r.signatureMatches.length === 0 && r.secretInHeader.length === 0);

console.log('\n3. NEVER a value — through the real route');
process.env.INVENTORY_WEBHOOK_SECRET = SECRET;
const calls = []; const spy = { info: (m, f) => calls.push([m, f]), warn: (m, f) => calls.push([m, f]), error: (m, f) => calls.push([m, f]) };
const app = express(); app.use('/api/webhooks/inventory', createInventoryWebhookRouter({ logger: spy }));
const server = await new Promise((rs) => { const s = app.listen(0, '127.0.0.1', () => rs(s)); });
const url = `http://127.0.0.1:${server.address().port}/api/webhooks/inventory`;
const sigVal = hexH(SECRET, raw);
const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sigVal, 'X-Delivery-Id': 'del_super_private_999', Cookie: 'session=cookie_value_secret', Authorization: 'Basic dXNlcjpwYXNzd29yZA==' }, body });
ok('the request is still rejected (the diagnostics do not authenticate anything)', resp.status === 401);
const dump = JSON.stringify(calls);
const diagRec = inventoryWebhookHealth.diagnostics[0];
ok('a DIAGNOSTIC line was logged with the outcome and the scheme that matched', calls.some(([m, f]) => /DIAGNOSTIC/.test(m) && /REJECTED:/.test(f.outcome)) && diagRec.signatureMatches[0].header === 'x-webhook-signature', JSON.stringify(diagRec));
ok('NO secret / signature / cookie / authorization value / body value / id value appears in any log line or in the stored diagnostic', ![SECRET, SECRET.slice(8), sigVal, 'cookie_value_secret', 'dXNlcjpwYXNzd29yZA', 'del_super_private_999', 'SKU-SENSITIVE-VALUE', 'evt_secret_looking_id_123'].some((v) => dump.includes(v) || JSON.stringify(inventoryWebhookHealth).includes(v)), dump.slice(0, 300));
ok('header NAMES (authorization, cookie, x-webhook-signature, x-delivery-id) are what is listed', ['authorization', 'cookie', 'x-webhook-signature', 'x-delivery-id'].every((n) => diagRec.headerNames.includes(n)));
process.env.INVENTORY_WEBHOOK_DIAGNOSTICS = 'off'; const n0 = calls.length;
await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
ok('INVENTORY_WEBHOOK_DIAGNOSTICS=off silences it', !calls.slice(n0).some(([m]) => /DIAGNOSTIC/.test(m)));
delete process.env.INVENTORY_WEBHOOK_DIAGNOSTICS;
const ring = []; for (let i = 0; i < 14; i++) { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); ring.push(i); }
ok('the in-memory ring keeps only the last 10 records', inventoryWebhookHealth.diagnostics.length === 10);
// accepted-auth + bad payload also diagnoses (to learn the real payload shape) — still only key names
const resp2 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Inventory-Secret': SECRET }, body });
const rec2 = inventoryWebhookHealth.diagnostics[0];
ok('a correctly-authenticated but unrecognised payload is diagnosed too: key names + event token, no values', resp2.status === 200 && rec2.outcome === 'IGNORED_EVENT_TYPE' && JSON.stringify(rec2.topLevelKeys) === '["id","type","created","data"]' && rec2.eventType.value === 'inventory.stock_changed' && !JSON.stringify(rec2).includes('SKU-SENSITIVE-VALUE'), JSON.stringify(rec2));
server.close();
delete process.env.INVENTORY_WEBHOOK_SECRET;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
