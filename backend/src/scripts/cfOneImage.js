// One-shot: run a SINGLE real image through the production Creative Factory
// pipeline on an existing product, poll to terminal, dump the exact outcome
// (provider status/HTTP/error, quality scores) and save the composed image.
//   CF_BASE=https://…  CF_TOKEN=<jwt>  CF_PRODUCT=14  node src/scripts/cfOneImage.js
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.CF_BASE || 'https://ads-production-360b.up.railway.app';
const TOKEN = process.env.CF_TOKEN || fs.readFileSync('/tmp/cf_tok.txt', 'utf8').trim();
const PRODUCT = Number(process.env.CF_PRODUCT || 14);
const OUT = process.env.CF_OUT || '.';
const TYPE = process.env.CF_TYPE || 'META_ADS';
const MODE = process.env.CF_MODE || 'FAST';

const H = { 'Content-Type': 'application/json', Cookie: `token=${TOKEN}` };
async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* */ }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 300)}`);
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
const proj = await api('POST', '/api/creative-factory/projects', { productId: PRODUCT, projectType: TYPE, quantity: 1, generationMode: MODE });
console.log('project', proj.id);
const planRes = await api('POST', `/api/creative-factory/projects/${proj.id}/plan`, { count: 1 });
console.log('plan item:', JSON.stringify({ angle: planRes.items?.[0]?.angle, purpose: planRes.items?.[0]?.purpose, layout: planRes.items?.[0]?.planMeta?.textLayout }));
await api('POST', `/api/creative-factory/projects/${proj.id}/plan/approve`, {});
const gStart = Date.now();
const job = await api('POST', `/api/creative-factory/projects/${proj.id}/generate`, {});
console.log('job', job.id, '→ polling…');

let j;
for (let k = 0; k < 60; k++) {
  await sleep(5000);
  j = await api('GET', `/api/creative-factory/jobs/${job.id}`);
  console.log(`  [${k}] ${j.status} ${j.completedItems}/${j.totalItems} ${j.progress}%${j.error ? '  err=' + j.error.slice(0, 120) : ''}`);
  if (['COMPLETED', 'PARTIAL_COMPLETE', 'FAILED', 'CANCELLED'].includes(j.status)) break;
}
const genSec = Math.round((Date.now() - gStart) / 1000);

const full = await api('GET', `/api/creative-factory/projects/${proj.id}`);
const it = full.items[0];
console.log('\n=== ITEM', it.id, 'status:', it.status, '===');
console.log('attempts:', it.attemptCount);
const a = it.approvedAsset || (it.assets || [])[0];
if (a) {
  const det = await api('GET', `/api/creative-factory/assets/${a.id}`);
  console.log('asset', a.id, 'uuid', det.uuid, 'status', det.status);
  console.log('quality:', JSON.stringify(det.qualityFull, null, 1));
  console.log('copy:', JSON.stringify(det.copy));
  console.log('promptVersion:', det.promptVersion, '| attempts:', (det.attempts || []).map((x) => `${x.n}:${x.status}${x.error ? '(' + x.error.slice(0, 60) + ')' : ''}`).join(', '));
  const img = await fetch(`${BASE}/api/creative-factory/assets/${a.id}/image`, { headers: { Cookie: `token=${TOKEN}` } });
  const buf = Buffer.from(await img.arrayBuffer());
  const fp = path.join(OUT, `cf_oneimage_${a.id}.png`);
  fs.writeFileSync(fp, buf);
  console.log('saved', fp, buf.length, 'bytes');
} else {
  console.log('NO ASSET. Reading attempt errors from the plan item…');
}
console.log('\nRESULT:', JSON.stringify({
  job: j.status, item: it.status, genSeconds: genSec, totalSeconds: Math.round((Date.now() - t0) / 1000),
  jobError: j.error || null, hasImage: !!a,
}));
// archive the throwaway project
await api('POST', `/api/creative-factory/projects/${proj.id}/archive`, {}).catch(() => {});
process.exit(0);
