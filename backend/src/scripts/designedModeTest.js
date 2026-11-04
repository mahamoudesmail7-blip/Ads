// 🧪 Creative Factory — DESIGNED mode for product-page images (style_preset DESIGNED_*).
// OpenAI is MOCKED at fetch level (Responses API for copy/direction/judge, Images edits for the pictures) — no network, no spend.
// Covers: the 5-image page plan, product refs first + one style reference after them, the design-system / product-lock / real-price prompt,
// high quality, ONE attempt per designed image (a failing judge leaves it NEEDS_REVIEW instead of retrying), the designed judge gate, and that a
// classic project is untouched. Isolated test database only.
//   node src/scripts/designedModeTest.js
import './_testGuard.js';
import 'dotenv/config';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = 'sk-test-designed-0000000000';
process.env.CF_IMAGE_PROVIDER = 'openai';
process.env.CF_DISABLE_AUTOKICK = '1';
process.env.CF_STORAGE_PROVIDER = 'db';
delete process.env.AI_IMAGE_MODEL; delete process.env.CF_IMAGE_MODEL;

const { prisma } = await import('../prisma.js');
const P = await import('../services/creativeFactory/projects.js');
const { createGenerationJob, processDueJobs } = await import('../services/creativeFactory/generationJob.js');
const D = await import('../services/creativeFactory/designedMode.js');
const TX = await import('../services/creativeFactory/taxonomy.js');
const PT = await import('../services/amb/media/pageTemplates.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra ? `— ${String(extra).slice(0, 220)}` : ''); } };

function pngOf(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); return Buffer.concat([l, Buffer.from(t, 'ascii'), d, Buffer.alloc(4)]); };
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrl = (b) => `data:image/png;base64,${b.toString('base64')}`;
const OUT_PNG = pngOf(64, 64).toString('base64');

// ---- mocked OpenAI ---------------------------------------------------------------------------------------------------
const imageCalls = []; const judgeCalls = [];
let failJudgeMarker = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/v1/images/edits')) {
    const f = init.body;
    imageCalls.push({ prompt: f.get('prompt'), quality: f.get('quality'), images: f.getAll('image[]').map((b) => ({ type: b.type, size: b.size })) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: OUT_PNG }] }) };
  }
  if (u.includes('/v1/responses')) {
    const body = JSON.parse(init.body); const text = JSON.stringify(body);
    let out = {};
    if (/Quality Controller/.test(text)) {
      judgeCalls.push({ designed: /تصميم إعلاني كامل/.test(text), text });
      const bad = failJudgeMarker && text.includes(failJudgeMarker);
      const keys = ['product_accuracy_score', 'identity_score', 'visual_quality_score', 'composition_score', 'product_visibility_score', 'marketing_score', 'arabic_text_score', 'text_readability_score', 'claim_score', 'artifact_score', 'reference_consistency_score', 'plan_compliance_score'];
      out = { scores: Object.fromEntries(keys.map((k) => [k, k === 'arabic_text_score' && bad ? 40 : 92])), realism_score: 20, looks_ai_generated: true, identity_mismatch: false, text_layout_ok: false, failure_code: 'OK', failure_reasons: bad ? ['نص عربي مشوّه'] : [], recommendation: 'APPROVE' };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'resp_1', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(out) }] }], usage: { input_tokens: 10, output_tokens: 10 } }), text: async () => '' };
  }
  return realFetch(url, init);
};

const settle = async (jobId, projectId) => {
  for (let i = 0; i < 100; i++) {
    await processDueJobs().catch(() => {});
    const j = await prisma.cfJob.findUnique({ where: { id: jobId } });
    const items = await prisma.cfProjectItem.findMany({ where: { project_id: projectId }, select: { status: true } });
    if (j && ['FAILED', 'PARTIAL_COMPLETE', 'COMPLETED', 'CANCELLED'].includes(j.status) && items.every((x) => !['QUEUED', 'GENERATING', 'REGENERATING', 'PLANNED'].includes(x.status))) { await new Promise((r) => setTimeout(r, 150)); return j; }
    await new Promise((r) => setTimeout(r, 150));
  }
  return prisma.cfJob.findUnique({ where: { id: jobId } });
};

let productId = null; const projects = [];
try {
  console.log('\n[1] pure helpers');
  ok('presets map to design systems; classic presets map to null', D.designedStyleOf('DESIGNED_CLEAN_BLUE') === 'clean_blue' && D.designedStyleOf('DESIGNED_CREAM_GOLD') === 'cream_gold' && D.designedStyleOf('DESIGNED_AUTO') === 'auto' && D.designedStyleOf('EGY_ECOM') === null && D.designedStyleOf(null) === null);
  ok('every mapped angle points to a REAL template; unmapped angles (MULTI_ANGLE…) stay classic', Object.values(D.ANGLE_TO_TEMPLATE).every((t) => PT.PAGE_TEMPLATES[t]) && D.designedTemplateFor('MULTI_ANGLE') === null && D.designedTemplateFor('PRODUCT_PACKAGING') === null && D.designedTemplateFor('final_cta') === 'final_cta' && D.designedTemplateFor('HERO') === 'hero_hook');
  ok('the factory sequence HERO→PROBLEM→PROBLEM_SOLUTION→DEMONSTRATION→FINAL_CTA maps to the 5-image pack', ['HERO', 'PROBLEM', 'PROBLEM_SOLUTION', 'DEMONSTRATION', 'FINAL_CTA'].map(D.designedTemplateFor).join() === 'hero_hook,problem,problem_solution,demonstration,final_cta');
  ok('the designed presets are the FIRST options the UI lists', TX.STYLE_PRESETS.slice(0, 3).map((x) => x.key).join() === 'DESIGNED_CLEAN_BLUE,DESIGNED_CREAM_GOLD,DESIGNED_AUTO' && TX.STYLE_PRESETS.some((x) => x.key === 'EGY_ECOM'));
  const refsIn = ['a', 'b', 'c', 'd'].map((x) => ({ b64: Buffer.from(x).toString('base64'), mime: 'image/png' }));
  const rq = D.buildDesignedRequest({ templateId: 'final_cta', styleId: 'clean_blue', product: { name: 'جهاز', selling_price: 250 }, copy: { headline: 'اطلبه', subtitle: 'عرض', featureLabels: ['الدفع عند الاستلام'], cta: 'اطلب' }, productRefs: refsIn });
  ok('request: product photos FIRST (max 3) then the style reference; exact price; design system + lock', rq.referenceImages.length === 4 && rq.referenceImages.slice(0, 3).every((r) => r.mime === 'image/png') && rq.referenceImages[3].mime === 'image/jpeg' && rq.prompt.includes('"250 جنيه"') && /DESIGN SYSTEM/.test(rq.prompt) && /PRODUCT LOCK/.test(rq.prompt) && rq.styleRefCount === 1);
  const rq0 = D.buildDesignedRequest({ templateId: 'final_cta', styleId: 'auto', product: { name: 'جهاز', selling_price: null }, copy: { headline: 'اطلبه' }, productRefs: refsIn.slice(0, 1) });
  ok('no price → "do not show any price"; style auto → no style reference', /Do not show any price/.test(rq0.prompt) && rq0.referenceImages.length === 1 && rq0.styleRefCount === 0);
  ok('expectedTexts lists the headline, subtitle, labels, CTA and price', D.expectedTexts(rq.ctx).join('|') === 'اطلبه|عرض|الدفع عند الاستلام|اطلب|250 جنيه');
  ok('unknown template → null', D.buildDesignedRequest({ templateId: 'nope', styleId: 'auto', product: {}, copy: {}, productRefs: [] }) === null);

  console.log('\n[2] a DESIGNED project end to end (OpenAI mocked)');
  const prod = await P.createProduct({ name: `__designed ${Date.now()}`, benefits: 'سهل الاستخدام, خفيف, بطارية', specifications: 'وزن خفيف' }, null);
  productId = prod.id;
  await prisma.cfProduct.update({ where: { id: productId }, data: { selling_price: 250 } });
  for (let i = 0; i < 4; i++) await P.addReferenceImage(productId, { dataUrl: dataUrl(pngOf(600, 600)), angleLabel: ['Front', 'Side', '3/4', 'Top'][i] });
  const proj = await P.createProject({ productId, projectType: 'PRODUCT_PAGE', quantity: 5, stylePreset: 'DESIGNED_CLEAN_BLUE' }, null);
  projects.push(proj.id);
  ok('project keeps the designed preset', proj.stylePreset === 'DESIGNED_CLEAN_BLUE');
  const planned = await P.generatePlan(proj.id, { count: 5 });
  ok('plan = the 5-image page sequence', planned.items.map((x) => String(x.angle).toUpperCase()).join() === 'HERO,PROBLEM,PROBLEM_SOLUTION,DEMONSTRATION,FINAL_CTA', planned.items.map((x) => x.angle).join());
  for (const it of planned.items) await P.updatePlanItem(proj.id, it.id, { headline: `عنوان-${it.angle}`, copy: { hook: `عنوان-${it.angle}`, headline: `عنوان-${it.angle}`, supportingLine: `جملة-${it.angle}`, cta: 'اطلبه دلوقتي', featureCallouts: ['سهل', 'خفيف', 'بطارية'] } });
  failJudgeMarker = 'عنوان-PROBLEM_SOLUTION';
  const job = await createGenerationJob({ projectId: proj.id, userId: null });
  const done = await settle(job.id, proj.id);
  const items = await prisma.cfProjectItem.findMany({ where: { project_id: proj.id }, orderBy: { position: 'asc' } });
  ok('4 images COMPLETED, the one whose Arabic text the judge rejected is NEEDS_REVIEW (job PARTIAL)', items.map((x) => x.status).join() === 'COMPLETED,COMPLETED,NEEDS_REVIEW,COMPLETED,COMPLETED' && done.status === 'PARTIAL_COMPLETE', items.map((x) => x.status).join());
  ok('exactly 5 image calls: one attempt per designed image (no retry on the failed one)', imageCalls.length === 5, String(imageCalls.length));
  ok('every call: product photos first (PNG) and ONE style reference (JPEG) last', imageCalls.every((c) => c.images.length === 4 && c.images.slice(0, 3).every((i) => i.type === 'image/png') && c.images[3].type === 'image/jpeg'), JSON.stringify(imageCalls[0]?.images));
  ok('every call is requested at HIGH quality', imageCalls.every((c) => c.quality === 'high'));
  ok('prompts carry the design system, the product lock and the style-only rule', imageCalls.every((c) => /DESIGN SYSTEM/.test(c.prompt) && /PRODUCT LOCK/.test(c.prompt) && /STYLE REFERENCES/.test(c.prompt)));
  const byMark = (m) => imageCalls.find((c) => c.prompt.includes(m)); // the worker pool may run the images in any order
  const hero = byMark('"عنوان-HERO"'), cta = byMark('"عنوان-FINAL_CTA"'), prob = byMark('"عنوان-PROBLEM"');
  ok('the approved copy is what is drawn: each step\'s headline + the three feature labels', !!hero && !!prob && !!cta && hero.prompt.includes('"سهل"') && hero.prompt.includes('"خفيف"') && hero.prompt.includes('"بطارية"'), imageCalls.map((c) => c.prompt.slice(60, 420)).join(' || '));
  ok('the closing image shows the product\'s REAL price (250); the others show no price', !!cta && cta.prompt.includes('"250 جنيه"') && imageCalls.filter((c) => c !== cta).every((c) => !c.prompt.includes('250')));
  ok('hero and problem images use DIFFERENT style references (per-role)', !!hero && !!prob && hero.images[3].size !== prob.images[3].size);
  ok('the judge used the DESIGNED rubric and was told which texts to read back', judgeCalls.length === 5 && judgeCalls.every((j) => j.designed && /النصوص المطلوبة على الصورة/.test(j.text)));
  const attempts = await prisma.cfGenerationAttempt.findMany({ where: { project_item_id: { in: items.map((x) => x.id) } } });
  ok('attempt rows: one per item, flagged designed, text engine off', attempts.length === 5 && attempts.every((a) => { const r = JSON.parse(a.provider_request_json || '{}'); return r.designed && r.textEngine === false; }));
  const bad = items[2]; const badAsset = await prisma.cfAsset.findFirst({ where: { project_item_id: bad.id }, include: { quality_review: true } });
  ok('the rejected image is kept visible for a human (not deleted), with its review', !!badAsset && badAsset.quality_review?.passed === false && (badAsset.quality_review?.arabic_text_score ?? 100) < 70);
  const good = await prisma.cfAsset.findFirst({ where: { project_item_id: items[0].id }, include: { quality_review: true } });
  ok('a passing designed image is approved although the photo-realism gate would fail it (realism 20, "looks AI")', good.status === 'APPROVED' && good.quality_review?.passed === true);

  console.log('\n[3] a CLASSIC project is untouched');
  imageCalls.length = 0; judgeCalls.length = 0; failJudgeMarker = null;
  const classic = await P.createProject({ productId, projectType: 'PRODUCT_PAGE', quantity: 2, stylePreset: 'EGY_ECOM' }, null);
  projects.push(classic.id);
  const cp = await P.generatePlan(classic.id, { count: 2 });
  const cj = await createGenerationJob({ projectId: classic.id, itemIds: [cp.items[0].id], userId: null });
  await settle(cj.id, classic.id);
  ok('classic: no design system in the prompt, product photos only (no JPEG style reference)', imageCalls.length >= 1 && imageCalls.every((c) => !/DESIGN SYSTEM/.test(c.prompt) && c.images.every((i) => i.type === 'image/png')), imageCalls[0] && JSON.stringify(imageCalls[0].images));
  ok('classic: judged with the classic photo rubric', judgeCalls.length >= 1 && judgeCalls.every((j) => !j.designed));
  const cattempt = await prisma.cfGenerationAttempt.findFirst({ where: { project_item_id: cp.items[0].id } });
  ok('classic: attempt not flagged designed', JSON.parse(cattempt.provider_request_json || '{}').designed == null);

  console.log('\n[4] DESIGNED_AUTO uses no style reference');
  imageCalls.length = 0;
  const auto = await P.createProject({ productId, projectType: 'PRODUCT_PAGE', quantity: 1, stylePreset: 'DESIGNED_AUTO' }, null);
  projects.push(auto.id);
  const ap = await P.generatePlan(auto.id, { count: 1 });
  const aj = await createGenerationJob({ projectId: auto.id, userId: null });
  await settle(aj.id, auto.id);
  ok('auto: only product photos, design-system sentence without style references', imageCalls.length === 1 && imageCalls[0].images.length === 3 && /DESIGN SYSTEM/.test(imageCalls[0].prompt) && !/STYLE REFERENCES/.test(imageCalls[0].prompt), imageCalls[0] && String(imageCalls[0].images.length));
  void ap;

  console.log('\n[3] free-text plan angles + the plan/job race');
  const ang = ['hero', 'feature', 'display', 'interface', 'design_detail'].map((x, i) => D.designedTemplateForItem({ angle: x, position: i + 1 }, i + 1, 5));
  ok('the AI plan free-text angles ALL map to a real template (never classic)', ang.every((t) => PT.PAGE_TEMPLATES[t]) && ang[0] === 'hero_hook', ang.join());
  ok('unknown angle → position fallback (first=hero, last of >2=final_cta, else features)', D.designedTemplateForItem({ angle: 'zzz' }, 1, 5) === 'hero_hook' && D.designedTemplateForItem({ angle: 'zzz' }, 5, 5) === 'final_cta' && D.designedTemplateForItem({ angle: 'zzz' }, 2, 5) === 'features_hero');
  const race = await P.createProject({ productId, projectType: 'PRODUCT_PAGE', quantity: 2, stylePreset: 'DESIGNED_CLEAN_BLUE' }, null);
  projects.push(race.id);
  await P.generatePlan(race.id, { count: 2 });
  const idsBefore = (await prisma.cfProjectItem.findMany({ where: { project_id: race.id }, orderBy: { position: 'asc' } })).map((i) => i.id);
  const rj = await createGenerationJob({ projectId: race.id, userId: null });
  let refused = null;
  try { await P.generatePlan(race.id, { count: 2 }); } catch (e) { refused = e; }
  ok('re-planning while a job is queued is refused (409) and keeps the items', refused && refused.status === 409 && (await prisma.cfProjectItem.findMany({ where: { project_id: race.id }, orderBy: { position: 'asc' } })).map((i) => i.id).join() === idsBefore.join());
  // two plan requests at once → the second is refused, never interleaved
  const race2 = await P.createProject({ productId, projectType: 'PRODUCT_PAGE', quantity: 1, stylePreset: 'DESIGNED_CLEAN_BLUE' }, null);
  projects.push(race2.id);
  const settled = await Promise.allSettled([P.generatePlan(race2.id, { count: 1 }), P.generatePlan(race2.id, { count: 1 })]);
  ok('two simultaneous plan requests: exactly one runs, the other gets 409', settled.filter((r) => r.status === 'fulfilled').length === 1 && settled.some((r) => r.status === 'rejected' && r.reason?.status === 409));
  // items deleted under a job → the job FAILS with a readable reason (not silently)
  await prisma.cfProjectItem.deleteMany({ where: { project_id: race.id } });
  await settle(rj.id, race.id);
  const failedJob = await prisma.cfJob.findUnique({ where: { id: rj.id } });
  ok('items vanished under a job → FAILED with a visible error', failedJob.status === 'FAILED' && /الخطة|اتغيّر|اتمسح/.test(failedJob.error || ''), JSON.stringify({ s: failedJob.status, e: failedJob.error }));
} finally {
  globalThis.fetch = realFetch;
  for (const id of projects) { await prisma.cfProject.delete({ where: { id } }).catch(() => {}); }
  if (productId) await prisma.cfProduct.delete({ where: { id: productId } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
