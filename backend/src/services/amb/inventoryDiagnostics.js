// 📦 TEMPORARY Inventory-webhook diagnostics — to learn HOW the external inventory system authenticates and what it sends, WITHOUT ever recording a secret.
// What is recorded (names / booleans / sizes only):
//   header NAMES, Content-Type, User-Agent, body size, top-level JSON key NAMES, a short event-type token, which header NAMES look like a timestamp / an id,
//   and — computed in memory against OUR secret — WHICH header (by name) carries a signature and under WHICH scheme, or which header (by name) carries the secret itself.
// What is NEVER recorded: any header VALUE, the signature, the secret (or a length/shape of it), the body, any value inside the body.
// Remove this module (and its single call in routes/inventoryWebhook.js) once the real contract is known: it is not part of the finished integration.
import crypto from 'node:crypto';

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,49}$/;
const SAFE_KEY = /^[A-Za-z0-9_.$-]{1,40}$/;
const SAFE_TOKEN = /^[A-Za-z0-9_.:\-/]{1,60}$/;
const EVENT_KEYS = ['event_type', 'eventType', 'event', 'type', 'topic', 'action'];
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Candidate HMAC keys derived from our secret (utf8, without a `whsec_`-style prefix, and base64-decoded — Standard-Webhooks / Svix style). */
function keyVariants(secret) {
  const out = [{ label: 'key=utf8', key: Buffer.from(secret) }];
  const stripped = secret.replace(/^[a-z]+_/i, '');
  if (stripped !== secret) out.push({ label: 'key=utf8-no-prefix', key: Buffer.from(stripped) });
  for (const [label, s] of [['key=base64-no-prefix', stripped], ['key=base64', secret]]) {
    try { const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); if (b.length >= 8) out.push({ label, key: b }); } catch { /* not base64 */ }
  }
  return out;
}
const encodings = (buf) => [['hex', buf.toString('hex')], ['base64', buf.toString('base64')], ['base64url', buf.toString('base64url')]];
/** Tokens that could be a signature inside a header value: the whole value, parts split on , ; space and the right side of `k=v` / `v1,<sig>`. */
function tokensOf(value) {
  const v = String(value).trim(); const t = new Set([v]);
  for (const part of v.split(/[,; ]+/)) { if (!part) continue; t.add(part); const eq = part.indexOf('='); if (eq > 0) t.add(part.slice(eq + 1)); }
  return [...t].filter((x) => x.length >= 16 && x.length <= 400);
}

/**
 * headers: lowercase node map; rawBody: Buffer. Returns a record that is SAFE to log. `secret` is only used for in-memory comparison.
 */
export function diagnoseInventoryRequest({ headers = {}, rawBody = Buffer.alloc(0), secret = '', now = Date.now() }) {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''));
  const names = Object.keys(headers).map((n) => n.toLowerCase()).filter((n) => SAFE_NAME.test(n)).sort();
  const rec = {
    headerNames: names, contentType: String(headers['content-type'] || '').toLowerCase().replace(/[^a-z0-9/;=+. -]/g, '').slice(0, 60) || null,
    userAgent: String(headers['user-agent'] || '').replace(/[^\w ./()-]/g, '').slice(0, 60) || null, bodyBytes: raw.length,
    topLevelKeys: null, eventType: null, timestampHeaders: [], idHeaders: [], secretInHeader: [], signatureMatches: [], signatureHeaderCandidates: [],
  };
  // ---- body: top-level key NAMES + a short event-type token only
  try {
    const body = JSON.parse(raw.toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      rec.topLevelKeys = Object.keys(body).filter((k) => SAFE_KEY.test(k)).slice(0, 30);
      for (const k of EVENT_KEYS) if (typeof body[k] === 'string' && SAFE_TOKEN.test(body[k])) { rec.eventType = { key: k, value: body[k] }; break; }
    } else rec.topLevelKeys = Array.isArray(body) ? '(array)' : '(scalar)';
  } catch { rec.topLevelKeys = '(not json)'; }
  // ---- which header NAMES look like a timestamp / an id (names only)
  const tsLike = (v) => /^\d{10}(\d{3})?$/.test(String(v).trim()) || /^\d{4}-\d{2}-\d{2}T/.test(String(v).trim());
  for (const n of names) {
    const v = headers[n];
    if (typeof v === 'string' && (/time|date|ts$/.test(n) || tsLike(v)) && tsLike(v)) rec.timestampHeaders.push(n);
    if (/(^|-)(id|event|delivery|request|message|webhook)(-|$)/.test(n) && !/^x-(forwarded|railway|real)/.test(n) && n !== 'x-request-id') rec.idHeaders.push(n);
  }
  if (!secret) return rec;
  // ---- is the SECRET itself in a header (equal / Bearer)? names only
  for (const n of names) {
    const v = headers[n]; if (typeof v !== 'string') continue;
    if (['host', 'user-agent', 'content-type', 'content-length', 'accept', 'accept-encoding', 'connection'].includes(n)) continue;
    if (safeEq(v.trim(), secret)) rec.secretInHeader.push(`${n} (exact)`);
    else if (/^bearer\s+/i.test(v) && safeEq(v.replace(/^bearer\s+/i, '').trim(), secret)) rec.secretInHeader.push(`${n} (Bearer)`);
  }
  // ---- which header carries an HMAC of the body under which scheme (computed here, never logged as a value)
  const keys = keyVariants(secret);
  const stamps = new Set(); for (const n of names) { const v = String(headers[n]); if (tsLike(v)) stamps.add(v.trim()); const m = v.match(/(?:^|[,; ])t=(\d{10,13})/); if (m) stamps.add(m[1]); }
  const ids = new Set(); for (const n of rec.idHeaders) ids.add(String(headers[n]).trim());
  const messages = [['body', raw]];
  for (const s of stamps) messages.push([`timestamp.body`, Buffer.concat([Buffer.from(`${s}.`), raw]), s]);
  for (const id of ids) for (const s of stamps) messages.push([`id.timestamp.body`, Buffer.concat([Buffer.from(`${id}.${s}.`), raw])]);
  const digests = [];
  for (const k of keys) for (const [mlabel, msg] of messages) for (const algo of ['sha256', 'sha1', 'sha512']) {
    const d = crypto.createHmac(algo, k.key).update(msg).digest();
    for (const [enc, text] of encodings(d)) digests.push({ text, label: `hmac-${algo}(${mlabel}) ${enc} [${k.label}]` });
  }
  for (const n of names) {
    const v = headers[n]; if (typeof v !== 'string' || v.length < 16) continue;
    if (/^(host|user-agent|content-type|content-length|accept|accept-encoding|connection|date|cookie|authorization)$/.test(n) && n !== 'authorization') continue;
    const toks = tokensOf(v); let hit = null;
    for (const tok of toks) { const low = tok.toLowerCase(); const d = digests.find((x) => x.text === tok || x.text.toLowerCase() === low); if (d) { hit = d.label; break; } }
    if (hit) rec.signatureMatches.push({ header: n, scheme: hit, prefix: /^sha(1|256|512)=/i.test(v) ? 'sha*=' : /(?:^|[, ])v1[,=]/.test(v) ? 'v1' : null });
    else if (/sig|signature|hmac|digest|webhook|token|secret|auth|key/i.test(n)) rec.signatureHeaderCandidates.push(n); // looks like a credential header but matched none of our schemes
  }
  return rec;
}
