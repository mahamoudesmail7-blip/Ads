// AI Creative Factory — REAL production pipeline test across 3 very different
// product categories (spec: electronic / beauty-home / outdoor-tool), 3
// images each, FAST mode. Drives the live API with a session cookie, then
// measures Product Accuracy / Realism / Arabic / time / provider calls.
//
//   CF_PROD_BASE=https://…  CF_PROD_TOKEN=<jwt>  node src/scripts/creativeFactoryProdTest.js
//
// Reference images are clear, category-distinct mock product shots drawn
// locally (@napi-rs/canvas) so the identity-lock + DNA + judge have real
// specific shapes/colours/controls to work against. Cleans up its products.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const BASE = process.env.CF_PROD_BASE || 'https://ads-production-360b.up.railway.app';
const TOKEN = process.env.CF_PROD_TOKEN || (fs.existsSync(path.join(process.env.TEMP || '/tmp', 'cf_tok.txt')) ? fs.readFileSync(path.join(process.env.TEMP || '/tmp', 'cf_tok.txt'), 'utf8').trim() : '');
const OUT = process.env.CF_OUT || '.';
if (!TOKEN) { console.error('no CF_PROD_TOKEN'); process.exit(1); }

const H = { 'Content-Type': 'application/json', Cookie: `token=${TOKEN}` };
async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* */ }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 200)}`);
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- mock reference product shots -------------------------------------------
function pngRef({ w = 1024, h = 1024, bg, body, accent, kind, label }) {
  const c = createCanvas(w, h); const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, bg[0]); g.addColorStop(1, bg[1]);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.save();
  x.translate(w / 2, h / 2);
  if (kind === 'device') {
    x.fillStyle = body; rr(x, -170, -260, 340, 520, 46); x.fill();
    x.fillStyle = '#0d1b2a'; rr(x, -120, -210, 240, 250, 16); x.fill();           // screen
    x.fillStyle = accent; x.beginPath(); x.arc(-70, 150, 34, 0, 7); x.fill();      // round button
    x.beginPath(); x.arc(70, 150, 34, 0, 7); x.fill();                             // round button
    x.fillStyle = '#c9d1d9'; rr(x, -18, 210, 36, 30, 8); x.fill();                // port
  } else if (kind === 'bottle') {
    x.fillStyle = body; rr(x, -110, -120, 220, 380, 40); x.fill();                // body
    x.fillStyle = accent; rr(x, -46, -230, 92, 120, 18); x.fill();               // pump neck
    x.fillStyle = '#ffffff'; rr(x, -90, 10, 180, 150, 14); x.fill();             // label
    x.fillStyle = accent; x.fillRect(-70, 60, 140, 10);
  } else { // tool
    x.fillStyle = body; rr(x, -60, -250, 120, 340, 24); x.fill();                // motor body
    x.fillStyle = '#1b1b1b'; rr(x, -70, 40, 140, 250, 30); x.fill();            // grip
    x.fillStyle = accent; rr(x, -100, -250, 200, 60, 20); x.fill();             // top accent
    x.fillStyle = '#9aa0a6'; x.fillRect(-14, -330, 28, 90);                     // chuck
    x.fillStyle = accent; x.beginPath(); x.moveTo(0, 300); x.lineTo(-40, 360); x.lineTo(40, 360); x.closePath(); x.fill();
  }
  x.restore();
  x.fillStyle = 'rgba(0,0,0,.35)'; x.font = '600 26px sans-serif'; x.textAlign = 'center';
  x.fillText(label, w / 2, h - 40);
  return c.toBuffer('image/png');
  function rr(ctx, X, Y, W, Hh, r) { ctx.beginPath(); ctx.moveTo(X + r, Y); ctx.arcTo(X + W, Y, X + W, Y + Hh, r); ctx.arcTo(X + W, Y + Hh, X, Y + Hh, r); ctx.arcTo(X, Y + Hh, X, Y, r); ctx.arcTo(X, Y, X + W, Y, r); ctx.closePath(); }
}
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

const CATS = [
  {
    key: 'electronic', name: `__cfprod جهاز ${Date.now()}`, category: 'إلكترونيات',
    specs: 'جهاز عناية بالبشرة محمول\nشاشة LED صغيرة تعرض المستوى\nزرين دائريين للتحكم\nمنفذ شحن USB-C\nبطارية تكفي أسبوع استخدام\nخفيف وسهل الحمل في الشنطة',
    audience: 'سيدات', refKind: 'device', bg: ['#eef2f7', '#c9d4e0'], body: '#3aa6a0', accent: '#ff6b6b',
    refs: ['واجهة أمامية للجهاز', 'زاوية 3/4', 'الجانب مع منفذ الشحن'],
  },
  {
    key: 'beauty', name: `__cfprod سيروم ${Date.now()}`, category: 'عناية وجمال',
    specs: 'سيروم مرطّب للوجه بمضخة\nعبوة زجاجية وردية 30 مل\nملصق أبيض على العبوة\nيستخدم صباحًا ومساءً\nمناسب لكل أنواع البشرة',
    audience: 'سيدات', refKind: 'bottle', bg: ['#fbeef2', '#f3d7e2'], body: '#e59bb4', accent: '#8a5a70',
    refs: ['العبوة من الأمام مع المضخة', 'زاوية 3/4 للعبوة', 'قريب من الملصق'],
  },
  {
    key: 'tool', name: `__cfprod دريل ${Date.now()}`, category: 'عِدد وأدوات',
    specs: 'دريل كهربائي محمول بموتور\nقبضة سوداء مطاطية مانعة للانزلاق\nرأس معدني (chuck) لتبديل اللقم\nمناسب للأعمال المنزلية والخشب\nخفيف نسبيًا وسهل التحكم',
    audience: 'رجال', refKind: 'tool', bg: ['#e9edf1', '#c4ccd4'], body: '#f4a220', accent: '#1b1b1b',
    refs: ['الدريل من الأمام', 'زاوية 3/4', 'قريب على الرأس المعدني'],
  },
];

async function run() {
  const results = [];
  for (const cat of CATS) {
    const t0 = Date.now();
    console.log(`\n=== ${cat.key} — ${cat.category} ===`);
    const prod = await api('POST', '/api/creative-factory/products', { name: cat.name, category: cat.category, specifications: cat.specs, benefits: cat.specs, targetAudience: cat.audience });
    console.log('product', prod.id);
    for (let i = 0; i < 3; i++) {
      const buf = pngRef({ bg: cat.bg, body: cat.body, accent: cat.accent, kind: cat.refKind, label: cat.refs[i] });
      await api('POST', `/api/creative-factory/products/${prod.id}/reference-images`, { dataUrl: dataUrl(buf), angleLabel: cat.refs[i] });
    }
    await api('POST', `/api/creative-factory/products/${prod.id}/dna/analyze`, {}).catch((e) => console.log('dna:', e.message));
    const dna = await api('GET', `/api/creative-factory/products/${prod.id}/dna`);
    console.log('DNA category:', dna?.data?.product_category, '| scale_conf:', dna?.data?.scale_confidence, '| safety:', (dna?.data?.category_safety_rules || []).length, 'rules');

    const project = await api('POST', '/api/creative-factory/projects', { productId: prod.id, projectType: 'PRODUCT_PAGE', quantity: 3, generationMode: 'FAST' });
    await api('POST', `/api/creative-factory/projects/${project.id}/plan`, { count: 3 });
    await api('POST', `/api/creative-factory/projects/${project.id}/plan/approve`, {});
    const gStart = Date.now();
    const job = await api('POST', `/api/creative-factory/projects/${project.id}/generate`, {});
    let j;
    for (let k = 0; k < 90; k++) {
      await sleep(5000);
      j = await api('GET', `/api/creative-factory/jobs/${job.id}`);
      process.stdout.write(`\r  job ${j.status} ${j.completedItems}/${j.totalItems} (${j.progress}%)   `);
      if (['COMPLETED', 'PARTIAL_COMPLETE', 'FAILED', 'CANCELLED'].includes(j.status)) break;
    }
    const genMs = Date.now() - gStart;
    console.log('');

    const full = await api('GET', `/api/creative-factory/projects/${project.id}`);
    const assets = [];
    let attempts = 0;
    for (const it of full.items) {
      attempts += it.attemptCount || (it.assets || []).length || 0;
      const a = it.approvedAsset || (it.assets || [])[0];
      if (a) {
        const det = await api('GET', `/api/creative-factory/assets/${a.id}`).catch(() => null);
        assets.push({ itemStatus: it.status, angle: it.angle, layout: safe(it.planMeta)?.textLayout, q: det?.qualityFull });
      } else assets.push({ itemStatus: it.status, angle: it.angle });
    }
    // save one sample image
    const sample = full.items.map((it) => it.approvedAsset || (it.assets || [])[0]).find(Boolean);
    if (sample) {
      const r = await fetch(`${BASE}/api/creative-factory/assets/${sample.id}/image`, { headers: { Cookie: `token=${TOKEN}` } });
      fs.writeFileSync(path.join(OUT, `cfprod_${cat.key}.png`), Buffer.from(await r.arrayBuffer()));
    }

    const meanOf = (pick) => {
      const xs = assets.map(pick).filter((v) => typeof v === 'number');
      return xs.length ? Math.round(xs.reduce((s, v) => s + v, 0) / xs.length) : null;
    };
    const rec = {
      category: cat.key, jobStatus: j?.status,
      completed: full.items.filter((x) => x.status === 'COMPLETED').length,
      needsReview: full.items.filter((x) => x.status === 'NEEDS_REVIEW').length,
      failed: full.items.filter((x) => x.status === 'FAILED').length,
      providerAttempts: attempts,
      productAccuracy: meanOf((a) => a.q?.scores?.product_accuracy_score),
      realism: meanOf((a) => a.q?.realism),
      identityMismatch: assets.filter((a) => a.q?.identityMismatch).length,
      looksAi: assets.filter((a) => a.q?.looksAi).length,
      arabicText: meanOf((a) => a.q?.scores?.arabic_text_score),
      overall: meanOf((a) => a.q?.overall),
      failureCodes: assets.map((a) => a.q?.failureCode).filter((c) => c && c !== 'OK'),
      genSeconds: Math.round(genMs / 1000),
      totalSeconds: Math.round((Date.now() - t0) / 1000),
      dnaCategory: dna?.data?.product_category || null,
      layouts: assets.map((a) => a.layout).filter(Boolean),
    };
    results.push(rec);
    console.log(JSON.stringify(rec, null, 1));

    await api('POST', `/api/creative-factory/projects/${project.id}/archive`, {}).catch(() => {});
  }

  console.log('\n================ SUMMARY ================');
  console.table(results.map((r) => ({
    category: r.category, job: r.jobStatus, done: `${r.completed}/3`, needsReview: r.needsReview,
    prodAcc: r.productAccuracy, realism: r.realism, arabic: r.arabicText, overall: r.overall,
    calls: r.providerAttempts, genSec: r.genSeconds,
  })));
  fs.writeFileSync(path.join(OUT, 'cfprod_results.json'), JSON.stringify(results, null, 2));
  console.log('\nsample images: cfprod_electronic.png / cfprod_beauty.png / cfprod_tool.png');
}
function safe(v) { return v || {}; }
function safeParse(q) { try { return typeof q === 'string' ? JSON.parse(q) : (q || {}); } catch { return {}; } }

run().catch((e) => { console.error('\nFATAL', e); process.exit(1); });
