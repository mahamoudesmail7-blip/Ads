// Offline tests for AI Creative Factory. Forces the mock-safe "provider off"
// mode (no ANTHROPIC / no OPENAI key) so every path is deterministic and no
// external API is called. Seeds throwaway cf_* rows and cleans them up.
//   node src/scripts/creativeFactoryTest.js
import 'dotenv/config';

// Force full provider-off mode BEFORE importing the services (they read env
// lazily). Set to '' rather than delete — a later dotenv.config() in the
// import chain does not override an already-set key, but WOULD re-populate a
// deleted one from .env.
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.CF_IMAGE_PROVIDER = 'disabled';
process.env.CF_STORAGE_PROVIDER = 'db';
process.env.CF_IMAGE_UNIT_COST_USD = '';

const { prisma } = await import('../prisma.js');
const P = await import('../services/creativeFactory/projects.js');
const { analyzeProductDna, saveDnaEdit } = await import('../services/creativeFactory/productDna.js');
const { scanClaims, guardCopy } = await import('../services/creativeFactory/claimsGuard.js');
const { getProviderStatus } = await import('../services/creativeFactory/config.js');
const { createGenerationJob, processDueJobs, retryFailedItems } = await import('../services/creativeFactory/generationJob.js');
const { createVariations } = await import('../services/creativeFactory/variations.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra ? `— ${extra}` : ''); } };
async function throws(name, fn, rx) {
  try { await fn(); ok(name, false, 'did NOT throw'); }
  catch (e) { ok(name, rx ? rx.test(e.message) : true, e.message.slice(0, 80)); }
}

// --- minimal but structurally valid PNG with a chosen width/height in IHDR ---
function pngOf(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0); ihdrData.writeUInt32BE(h, 4);
  ihdrData[8] = 8; ihdrData[9] = 2; // bit depth 8, colour type 2 (RGB)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); // CRC not validated by our header reader
    return Buffer.concat([len, body, crc]);
  };
  return Buffer.concat([sig, chunk('IHDR', ihdrData), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

let productId = null;
let projectId = null;

try {
  // =====================================================================
  console.log('provider status (keys removed):');
  const st = getProviderStatus();
  ok('image provider NOT_CONFIGURED', st.image.status === 'NOT_CONFIGURED' && st.image.configured === false);
  ok('text provider NOT_CONFIGURED', st.text.status === 'NOT_CONFIGURED');
  ok('cost estimate unavailable', st.costEstimateAvailable === false);

  // =====================================================================
  console.log('\nproducts + reference images:');
  await throws('createProduct without name rejects', () => P.createProduct({}, null), /اسم المنتج/);
  const prod = await P.createProduct({ name: `__cftest ${Date.now()}`, benefits: 'يوفر وقت, سهل التنظيف, آمن', specifications: 'سعة 2 لتر, بلاستيك ABS', forbiddenClaims: 'يعالج نهائيًا' }, null);
  productId = prod.id;
  ok('createProduct returns id', Number.isInteger(productId));

  await throws('bad mime reference rejected', () => P.addReferenceImage(productId, { dataUrl: 'data:text/plain;base64,aGVsbG8=' }), /غير مدعوم|data URL/);
  await throws('tiny dimensions rejected', () => P.addReferenceImage(productId, { dataUrl: dataUrl(pngOf(100, 100)) }), /صغيرة/);

  for (let i = 0; i < 6; i++) {
    await P.addReferenceImage(productId, { dataUrl: dataUrl(pngOf(600, 600)), angleLabel: ['Front', 'Side', '3/4', 'Top', 'Back', 'Packaging'][i] });
  }
  await throws('7th reference rejected (max 6)', () => P.addReferenceImage(productId, { dataUrl: dataUrl(pngOf(600, 600)) }), /الحد الأقصى/);
  const full = await P.getProductFull(productId);
  ok('6 reference images stored', full.referenceImages.length === 6);
  ok('reference bytes recorded', full.referenceImages.every((r) => r.bytes > 0 && r.width === 600));

  // =====================================================================
  console.log('\nProduct DNA persistence (AI off -> UNAVAILABLE skeleton):');
  const dna1 = await analyzeProductDna(productId);
  ok('DNA persisted, source UNAVAILABLE', dna1.source === 'UNAVAILABLE' && dna1.version === 1 && dna1.data && typeof dna1.data === 'object');
  const dna2 = await analyzeProductDna(productId);
  ok('DNA version increments on re-analyze', dna2.version === 2);
  const dnaEdit = await saveDnaEdit(productId, { primary_colors: ['أسود', 'فضي'], never_invent: ['شعار'] });
  ok('DNA manual edit -> reviewed_by_user + USER_EDITED/MIXED', dnaEdit.reviewedByUser === true && ['USER_EDITED', 'MIXED'].includes(dnaEdit.source) && dnaEdit.data.primary_colors.length === 2);

  // =====================================================================
  console.log('\nprojects + quantity validation:');
  const prod2 = await P.createProduct({ name: `__cftest noref ${Date.now()}` }, null);
  await throws('project needs >=3 references', () => P.createProject({ productId: prod2.id, projectType: 'PRODUCT_PAGE', quantity: 5 }), /صور مرجعية/);
  await prisma.cfProduct.delete({ where: { id: prod2.id } });

  await throws('unknown project type rejected', () => P.createProject({ productId, projectType: 'NOPE', quantity: 3 }), /نوع المشروع/);
  const proj = await P.createProject({ productId, projectType: 'PRODUCT_PAGE', quantity: 999, generationMode: 'PREMIUM' }, null);
  projectId = proj.id;
  ok('quantity 999 clamped to <=50', proj.quantity <= 50 && proj.quantity >= 1);
  const projZero = await P.createProject({ productId, projectType: 'META_ADS', quantity: 0 }, null);
  ok('quantity 0 -> 1', projZero.quantity === 1);
  await prisma.cfProject.delete({ where: { id: projZero.id } });

  // =====================================================================
  console.log('\ncreative plan (AI off -> deterministic template):');
  const planned = await P.generatePlan(projectId, { count: 5 });
  ok('plan has 5 items', planned.items.length === 5 && planned.planSource === 'TEMPLATE');
  ok('product-page plan leads with HERO', /HERO/i.test(planned.items[0].angle || ''));
  ok('product-page plan ends with FINAL_CTA', /FINAL_CTA/i.test(planned.items[4].angle || ''));
  ok('project status PLAN_READY', planned.status === 'PLAN_READY');

  const it0 = planned.items[0];
  const edited = await P.updatePlanItem(projectId, it0.id, { headline: 'هوك جديد', copy: { hook: 'هوك جديد', featureCallouts: ['أ', 'ب'] } });
  ok('plan item edit persists', edited.headline === 'هوك جديد' && edited.copy?.editedByUser === true);
  const added = await P.addPlanItem(projectId, { purpose: 'لقطة إضافية' });
  ok('add plan item -> position 6', added.position === 6);
  await P.deletePlanItem(projectId, added.id);
  const afterDel = await P.getProjectFull(projectId);
  ok('delete plan item renumbers to 5', afterDel.items.length === 5 && afterDel.items.every((x, i) => x.position === i + 1));

  // =====================================================================
  console.log('\nclaim guard:');
  const s1 = scanClaims({ items: [{ field: 'hook', text: 'نتيجة مضمونة 100% خلال أسبوع' }], product: {} });
  ok('guaranteed-result claim BLOCKED', s1.status === 'BLOCKED' && s1.issues.length >= 1);
  const s2 = scanClaims({ items: [{ field: 'hook', text: 'خصم 50% النهاردة' }], product: { specifications: 'سعة 2 لتر' } });
  ok('unbacked percentage BLOCKED', s2.status === 'BLOCKED');
  const s3 = scanClaims({ items: [{ field: 'hook', text: 'وفّر وقتك في التنظيف' }], product: {} });
  ok('supported marketing language PASSES', s3.status === 'PASSED');
  const g = await guardCopy({ copy: { hook: 'نتيجة مضمونة 100%', cta: 'اطلب' }, product: { benefits: 'يوفر وقت' } });
  ok('guardCopy with no AI strips/keeps-safe (not BLOCKED-through)', ['REWRITTEN', 'BLOCKED'].includes(g.status) && (g.copy.hook === null || g.status === 'BLOCKED'));

  // =====================================================================
  console.log('\ngeneration job (provider disabled -> honest failure, NO fake images):');
  const job = await createGenerationJob({ projectId, userId: null });
  ok('job created QUEUED', job.status === 'QUEUED' && job.totalItems === 5);
  await throws('second concurrent job refused', () => createGenerationJob({ projectId, userId: null }), /شغالة/);

  for (let i = 0; i < 12; i++) {
    await processDueJobs();
    const j = await prisma.cfJob.findUnique({ where: { id: job.id } });
    if (['FAILED', 'PARTIAL_COMPLETE', 'COMPLETED', 'CANCELLED'].includes(j.status)) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  const doneJob = await prisma.cfJob.findUnique({ where: { id: job.id } });
  ok('job ends FAILED (provider off)', doneJob.status === 'FAILED', doneJob.status);
  ok('job error mentions provider not configured', /مزود إنشاء الصور غير متصل|OPENAI_API_KEY/.test(doneJob.error || ''), doneJob.error);
  const assetCount = await prisma.cfAsset.count({ where: { product_id: productId } });
  ok('ZERO assets created (no fabricated images)', assetCount === 0, `got ${assetCount}`);
  const items = await prisma.cfProjectItem.findMany({ where: { project_id: projectId } });
  ok('all items marked FAILED', items.every((i) => i.status === 'FAILED'));
  const proj2 = await prisma.cfProject.findUnique({ where: { id: projectId } });
  ok('project status FAILED (never silently COMPLETED)', proj2.status === 'FAILED');

  // retry
  const retryJob = await retryFailedItems({ projectId, userId: null });
  ok('retry creates a new job', Number.isInteger(retryJob.id) && retryJob.id !== job.id);
  for (let i = 0; i < 12; i++) {
    await processDueJobs();
    const j = await prisma.cfJob.findUnique({ where: { id: retryJob.id } });
    if (['FAILED', 'PARTIAL_COMPLETE', 'COMPLETED'].includes(j.status)) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  const jobCount = await prisma.cfJob.count({ where: { project_id: projectId } });
  ok('exactly 2 jobs total (no duplicates per call)', jobCount === 2, `got ${jobCount}`);
  ok('still zero assets after retry', (await prisma.cfAsset.count({ where: { product_id: productId } })) === 0);

  // =====================================================================
  console.log('\ncost estimate + variation lineage:');
  const est = await P.estimateProjectCost({ count: 7, generationMode: 'PREMIUM' });
  ok('cost estimate unavailable -> honest display', est.available === false && est.display === 'غير متاحة حاليًا');

  // Seed a fake APPROVED asset on item 1 so variation lineage can be built.
  const anItem = (await prisma.cfProjectItem.findFirst({ where: { project_id: projectId }, orderBy: { position: 'asc' } }));
  const fakeAsset = await prisma.cfAsset.create({
    data: { project_item_id: anItem.id, product_id: productId, storage_provider: 'db', storage_key: `cf/test/${Date.now()}.png`, mime: 'image/png', status: 'APPROVED', kind: 'GENERATED' },
  });
  const vr = await createVariations({ parentAssetId: fakeAsset.id, variationType: 'NEW_HOOK', count: 2, userId: null });
  ok('createVariations -> 2 variation rows', vr.variationIds.length === 2 && vr.itemIds.length === 2);
  const vrows = await prisma.cfVariation.findMany({ where: { parent_asset_id: fakeAsset.id }, orderBy: { generation_number: 'asc' } });
  ok('variation lineage: parent set + generation_number 1,2', vrows.length === 2 && vrows[0].parent_asset_id === fakeAsset.id && vrows[0].generation_number === 1 && vrows[1].generation_number === 2 && vrows[0].variation_type === 'NEW_HOOK');
  await throws('unknown variation type rejected', () => createVariations({ parentAssetId: fakeAsset.id, variationType: 'NOPE', count: 1 }), /غير معروف/);
} finally {
  // cleanup — cascade wipes projects/items/jobs/refs/dna/variations; assets
  // only SET NULL on item delete, so remove them explicitly first.
  if (productId) {
    const blobs = await prisma.cfBlob.findMany({ where: { key: { contains: `/${productId}` } }, select: { key: true } }).catch(() => []);
    await prisma.cfVariation.deleteMany({ where: { parent_asset: { product_id: productId } } }).catch(() => {});
    await prisma.cfAsset.deleteMany({ where: { OR: [{ product_id: productId }, { storage_key: { contains: 'cf/test/' } }] } }).catch(() => {});
    await prisma.cfProduct.delete({ where: { id: productId } }).catch(() => {});
    await prisma.cfBlob.deleteMany({ where: { key: { in: blobs.map((b) => b.key) } } }).catch(() => {});
    await prisma.cfBlob.deleteMany({ where: { key: { contains: 'cf/test/' } } }).catch(() => {});
  }
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
