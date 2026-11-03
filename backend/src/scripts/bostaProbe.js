// READ-ONLY probe of the Bosta API — run once with your key to learn the REAL response shape before any sync is built.
//   BOSTA_API_KEY=... node src/scripts/bostaProbe.js
// Prints only structure + counts (state codes, which phone/reference fields exist). Never prints the key, never writes anywhere.
const KEY = process.env.BOSTA_API_KEY;
const BASE = process.env.BOSTA_API_BASE || 'https://app.bosta.co/api/v2';
if (!KEY) { console.error('BOSTA_API_KEY is not set'); process.exit(1); }

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text: text.slice(0, 200) };
}

// Bosta has exposed the list both as GET and as POST /search — try both, keep whichever answers.
const attempts = [
  ['GET', '/deliveries?pageId=1&pageLimit=50'],
  ['POST', '/deliveries/search', { pageId: 1, pageLimit: 50 }],
];
let found = null;
for (const [m, p, b] of attempts) {
  const r = await call(m, p, b);
  console.log(`${m} ${p} -> HTTP ${r.status}`);
  const list = r.json?.data?.deliveries || r.json?.deliveries || r.json?.data;
  if (r.status === 200 && Array.isArray(list)) { found = { m, p, r, list }; break; }
  if (r.status !== 200) console.log('  ', r.text);
}
if (!found) { console.log('No list endpoint answered — send me the lines above.'); process.exit(2); }

const { list, r } = found;
console.log('top-level keys:', Object.keys(r.json), '| data keys:', Object.keys(r.json.data || {}));
console.log('deliveries in page:', list.length, '| total reported:', r.json.data?.count ?? r.json.count ?? '?');
const d = list[0];
if (d) {
  console.log('delivery keys:', Object.keys(d));
  console.log('receiver keys:', d.receiver ? Object.keys(d.receiver) : '(none)');
  console.log('state sample:', JSON.stringify(d.state), '| businessReference present:', 'businessReference' in d, '| trackingNumber present:', 'trackingNumber' in d);
}
const states = {};
for (const x of list) { const k = `${x.state?.code ?? x.state?.value ?? x.state?.value} ${x.state?.value ?? x.state?.name ?? ''}`.trim(); states[k] = (states[k] || 0) + 1; }
console.log('states in this page:', states);
