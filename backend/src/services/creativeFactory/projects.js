// AI Creative Factory — project / product / plan / asset orchestration.
// Thin, deterministic data operations the HTTP layer calls. Generation +
// quality + learning live in their own services.
import { prisma } from '../../prisma.js';
import { StorageService, parseDataUrl } from './storage.js';
import { getEffectiveThresholds } from './thresholds.js';
import { estimateCostUsd, imageUnitCostUsd } from './config.js';
import { PROJECT_TYPES, PRODUCT_LOCK_MODES, STYLE_PRESETS, TEXT_DENSITIES, PEOPLE_RULES, ASPECT_RATIOS } from './taxonomy.js';
import { buildCreativePlan, recommendImageCount } from './creativeStrategy.js';
import { getDna } from './productDna.js';

const ACCEPT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MIN_DIM = 400;                 // px — validated best-effort from a PNG/JPEG header
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

// ===========================================================================
// Products
// ===========================================================================
export function serializeProduct(p, extra = {}) {
  return {
    id: p.id, name: p.name, internalName: p.internal_name, category: p.category,
    description: p.description, specifications: p.specifications, benefits: p.benefits,
    useCases: p.use_cases, targetAudience: p.target_audience, problems: p.problems,
    allowedClaims: p.allowed_claims, forbiddenClaims: p.forbidden_claims,
    sellingPrice: p.selling_price, currency: p.currency, notes: p.notes,
    productLockMode: p.product_lock_mode, ambProductId: p.amb_product_id, productId: p.product_id,
    createdAt: p.created_at, updatedAt: p.updated_at, ...extra,
  };
}

const PRODUCT_FIELDS = {
  name: 'name', internalName: 'internal_name', category: 'category', description: 'description',
  specifications: 'specifications', benefits: 'benefits', useCases: 'use_cases',
  targetAudience: 'target_audience', problems: 'problems', allowedClaims: 'allowed_claims',
  forbiddenClaims: 'forbidden_claims', notes: 'notes',
};

export async function createProduct(body, userId) {
  const name = String(body?.name || '').trim();
  if (!name) throw bad('اسم المنتج مطلوب.');
  const lock = PRODUCT_LOCK_MODES.includes(body.productLockMode) ? body.productLockMode : 'STRICT';
  const data = { name, product_lock_mode: lock, created_by_id: userId || null };
  for (const [k, col] of Object.entries(PRODUCT_FIELDS)) if (body[k] !== undefined) data[col] = strOrNull(body[k]);
  if (body.sellingPrice !== undefined) data.selling_price = numOrNull(body.sellingPrice);
  if (Number.isInteger(body.ambProductId)) {
    const amb = await prisma.ambProduct.findUnique({ where: { id: body.ambProductId } });
    if (amb) { data.amb_product_id = amb.id; if (amb.product_id) data.product_id = amb.product_id; }
  } else if (Number.isInteger(body.productId)) {
    data.product_id = body.productId;
  }
  const row = await prisma.cfProduct.create({ data }).catch((e) => {
    if (e.code === 'P2002') throw bad('المنتج مرتبط بالفعل بملف Creative Factory.', 409);
    throw e;
  });
  return serializeProduct(row);
}

export async function updateProduct(id, body) {
  const exists = await prisma.cfProduct.findUnique({ where: { id } });
  if (!exists) throw bad('المنتج غير موجود.', 404);
  const data = {};
  for (const [k, col] of Object.entries(PRODUCT_FIELDS)) if (body[k] !== undefined) data[col] = strOrNull(body[k]);
  if (body.sellingPrice !== undefined) data.selling_price = numOrNull(body.sellingPrice);
  if (body.productLockMode !== undefined && PRODUCT_LOCK_MODES.includes(body.productLockMode)) data.product_lock_mode = body.productLockMode;
  const row = await prisma.cfProduct.update({ where: { id }, data });
  return serializeProduct(row);
}

export async function listProducts() {
  const rows = await prisma.cfProduct.findMany({
    orderBy: { updated_at: 'desc' },
    include: { _count: { select: { reference_images: true, projects: true } }, dna: true },
  });
  return rows.map((r) => serializeProduct(r, {
    referenceImageCount: r._count.reference_images,
    projectCount: r._count.projects,
    dnaStatus: r.dna ? r.dna.source : 'NONE',
  }));
}

export async function getProductFull(id) {
  const p = await prisma.cfProduct.findUnique({ where: { id }, include: { reference_images: { orderBy: { sort_order: 'asc' } } } });
  if (!p) throw bad('المنتج غير موجود.', 404);
  const dna = await getDna(id);
  const th = await getEffectiveThresholds();
  return {
    ...serializeProduct(p),
    referenceImages: p.reference_images.map(serializeRef),
    dna,
    limits: { minReferenceImages: th.minReferenceImages, maxReferenceImages: th.maxReferenceImages },
  };
}

/** Catalog picker — existing AmbProducts (+ their linked Product) not yet wired to a CfProduct. */
export async function catalogSuggestions() {
  const [ambs, taken] = await Promise.all([
    prisma.ambProduct.findMany({ where: { active: true }, orderBy: { product_name: 'asc' }, take: 300, select: { id: true, product_name: true, product_id: true, image_url: true } }),
    prisma.cfProduct.findMany({ select: { amb_product_id: true } }),
  ]);
  const used = new Set(taken.map((t) => t.amb_product_id).filter(Boolean));
  return ambs.map((a) => ({ ambProductId: a.id, name: a.product_name, productId: a.product_id, imageUrl: a.image_url, linked: used.has(a.id) }));
}

// ===========================================================================
// Reference images
// ===========================================================================
function serializeRef(r) {
  return { id: r.id, angleLabel: r.angle_label, sortOrder: r.sort_order, mime: r.mime, width: r.width, height: r.height, bytes: r.bytes, active: r.active, createdAt: r.created_at };
}

/** Best-effort pixel dimensions from a PNG (IHDR) or JPEG (SOF) header. */
function readDims(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg') {
      let o = 2;
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) { o++; continue; }
        const marker = buf[o + 1];
        const len = buf.readUInt16BE(o + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
        }
        o += 2 + len;
      }
    }
  } catch { /* ignore */ }
  return { width: null, height: null };
}

export async function addReferenceImage(productId, { dataUrl, angleLabel }) {
  const product = await prisma.cfProduct.findUnique({ where: { id: productId }, include: { _count: { select: { reference_images: true } } } });
  if (!product) throw bad('المنتج غير موجود.', 404);
  const th = await getEffectiveThresholds();
  if (product._count.reference_images >= th.maxReferenceImages) throw bad(`الحد الأقصى ${th.maxReferenceImages} صور مرجعية.`);

  let buffer, mime;
  try { ({ buffer, mime } = parseDataUrl(dataUrl)); }
  catch { throw bad('تعذر قراءة الصورة — لازم تكون data URL صالحة.'); }
  mime = (mime || '').toLowerCase();
  if (!ACCEPT_MIME.has(mime)) throw bad('نوع الصورة غير مدعوم — jpg / png / webp فقط.');
  if (!buffer.length) throw bad('ملف الصورة تالف أو فارغ.');
  if (buffer.length > MAX_IMAGE_BYTES) throw bad('حجم الصورة كبير جدًا (الحد 12MB).');
  const { width, height } = readDims(buffer, mime);
  if (width && height && (width < MIN_DIM || height < MIN_DIM)) throw bad(`أبعاد الصورة صغيرة جدًا (${width}×${height}) — الحد الأدنى ${MIN_DIM}px.`);

  const stored = await StorageService.putBuffer(buffer, { mime, prefix: `cf/ref/${productId}` });
  const max = await prisma.cfReferenceImage.aggregate({ where: { product_id: productId }, _max: { sort_order: true } });
  const row = await prisma.cfReferenceImage.create({
    data: {
      product_id: productId, storage_provider: stored.provider, storage_key: stored.key, url: stored.url || null,
      angle_label: strOrNull(angleLabel), mime, width, height, bytes: buffer.length, sort_order: (max._max.sort_order || 0) + 1,
    },
  });
  return serializeRef(row);
}

export async function deleteReferenceImage(productId, refId) {
  const row = await prisma.cfReferenceImage.findFirst({ where: { id: refId, product_id: productId } });
  if (!row) throw bad('الصورة غير موجودة.', 404);
  await StorageService.del({ provider: row.storage_provider, key: row.storage_key }).catch(() => {});
  await prisma.cfReferenceImage.delete({ where: { id: refId } });
  return { ok: true };
}

export async function reorderReferenceImages(productId, orderIds) {
  const rows = await prisma.cfReferenceImage.findMany({ where: { product_id: productId } });
  const set = new Set(rows.map((r) => r.id));
  let i = 1;
  for (const id of orderIds || []) {
    if (!set.has(id)) continue;
    await prisma.cfReferenceImage.update({ where: { id }, data: { sort_order: i++ } });
  }
  return { ok: true };
}

export async function referenceImageDataUrl(productId, refId) {
  const row = await prisma.cfReferenceImage.findFirst({ where: { id: refId, product_id: productId } });
  if (!row) throw bad('الصورة غير موجودة.', 404);
  const url = await StorageService.getDataUrl({ provider: row.storage_provider, key: row.storage_key });
  if (!url) throw bad('تعذر تحميل الصورة من التخزين.', 404);
  return url;
}

// ===========================================================================
// Projects
// ===========================================================================
export function serializeProject(p, extra = {}) {
  return {
    id: p.id, productId: p.product_id, projectType: p.project_type, quantity: p.quantity,
    quantityMode: p.quantity_mode, aiQuantityReason: p.ai_quantity_reason, generationMode: p.generation_mode,
    stylePreset: p.style_preset, market: p.market, language: p.language, dialect: p.dialect,
    aspectRatio: p.aspect_ratio, textDensity: p.text_density, peopleRule: p.people_rule, hijabRequired: p.hijab_required,
    productLockMode: p.product_lock_mode, status: p.status, planNotes: p.plan_notes, estimatedCost: p.estimated_cost,
    createdAt: p.created_at, updatedAt: p.updated_at, archivedAt: p.archived_at, ...extra,
  };
}

export async function createProject(body, userId) {
  const product = await prisma.cfProduct.findUnique({ where: { id: Number(body?.productId) }, include: { _count: { select: { reference_images: true } } } });
  if (!product) throw bad('اختر منتجًا صحيحًا.');
  if (!PROJECT_TYPES.includes(body.projectType)) throw bad('نوع المشروع غير معروف.');
  const th = await getEffectiveThresholds();
  if (product._count.reference_images < th.minReferenceImages) {
    throw bad(`محتاج على الأقل ${th.minReferenceImages} صور مرجعية للمنتج قبل بدء مشروع.`);
  }
  let quantity = clampInt(body.quantity, 1, 1, th.maxImagesPerProject);
  const quantityMode = body.quantityMode === 'AI' ? 'AI' : 'MANUAL';
  const genMode = body.generationMode === 'PREMIUM' && th.allowPremiumMode ? 'PREMIUM' : 'FAST';

  const row = await prisma.cfProject.create({
    data: {
      product_id: product.id, project_type: body.projectType, quantity, quantity_mode: quantityMode,
      ai_quantity_reason: strOrNull(body.aiQuantityReason),
      generation_mode: genMode,
      style_preset: strOrNull(body.stylePreset),
      market: strOrNull(body.market) || 'EG',
      language: strOrNull(body.language) || 'ar',
      dialect: strOrNull(body.dialect) || 'egyptian',
      aspect_ratio: ASPECT_RATIOS.includes(body.aspectRatio) ? body.aspectRatio : '1:1',
      text_density: TEXT_DENSITIES.includes(body.textDensity) ? body.textDensity : 'MINIMAL',
      people_rule: PEOPLE_RULES.includes(body.peopleRule) ? body.peopleRule : 'NONE',
      hijab_required: !!body.hijabRequired,
      product_lock_mode: PRODUCT_LOCK_MODES.includes(body.productLockMode) ? body.productLockMode : product.product_lock_mode,
      status: 'DRAFT',
      estimated_cost: estimateCostUsd(quantity),
      created_by_id: userId || null,
    },
  });
  return serializeProject(row);
}

const PROJECT_SETTING_FIELDS = {
  projectType: (v) => (PROJECT_TYPES.includes(v) ? ['project_type', v] : null),
  quantityMode: (v) => (['MANUAL', 'AI'].includes(v) ? ['quantity_mode', v] : null),
  aiQuantityReason: (v) => ['ai_quantity_reason', strOrNull(v)],
  generationMode: (v) => (['FAST', 'PREMIUM'].includes(v) ? ['generation_mode', v] : null),
  stylePreset: (v) => ['style_preset', strOrNull(v)],
  market: (v) => ['market', strOrNull(v) || 'EG'],
  language: (v) => ['language', strOrNull(v) || 'ar'],
  dialect: (v) => ['dialect', strOrNull(v) || 'egyptian'],
  aspectRatio: (v) => (ASPECT_RATIOS.includes(v) ? ['aspect_ratio', v] : null),
  textDensity: (v) => (TEXT_DENSITIES.includes(v) ? ['text_density', v] : null),
  peopleRule: (v) => (PEOPLE_RULES.includes(v) ? ['people_rule', v] : null),
  hijabRequired: (v) => ['hijab_required', !!v],
  productLockMode: (v) => (PRODUCT_LOCK_MODES.includes(v) ? ['product_lock_mode', v] : null),
  planNotes: (v) => ['plan_notes', strOrNull(v)],
};

/** Auto-save of the "إنشاء جديد" workspace settings. Never touches an already-
 *  generating project; harmless no-op for unknown fields. */
export async function updateProjectSettings(id, body) {
  const project = await prisma.cfProject.findUnique({ where: { id } });
  if (!project) throw bad('المشروع غير موجود.', 404);
  if (['QUEUED', 'GENERATING', 'REVIEWING', 'REGENERATING'].includes(project.status)) {
    throw bad('المشروع تحت الإنشاء الآن — لا يمكن تعديل إعداداته.', 409);
  }
  const th = await getEffectiveThresholds();
  const data = {};
  for (const [k, fn] of Object.entries(PROJECT_SETTING_FIELDS)) {
    if (body[k] === undefined) continue;
    const pair = fn(body[k]);
    if (pair) data[pair[0]] = pair[1];
  }
  if (body.quantity !== undefined) {
    data.quantity = clampInt(body.quantity, project.quantity, 1, th.maxImagesPerProject);
    data.estimated_cost = estimateCostUsd(data.quantity);
  }
  if (!Object.keys(data).length) return serializeProject(project);
  const row = await prisma.cfProject.update({ where: { id }, data });
  return serializeProject(row);
}

export async function listProjects(filters = {}) {
  const where = {};
  if (filters.productId) where.product_id = Number(filters.productId);
  if (filters.projectType) where.project_type = String(filters.projectType);
  if (filters.status) where.status = String(filters.status);
  if (!filters.includeArchived) where.archived_at = null;
  const rows = await prisma.cfProject.findMany({
    where, orderBy: { updated_at: 'desc' }, take: 200,
    include: {
      product: { select: { name: true, id: true } },
      items: { select: { status: true } },
      _count: { select: { items: true } },
    },
  });
  const assetAgg = await prisma.cfQualityReview.groupBy({ by: [], _avg: { overall_score: true } }).catch(() => null);
  return rows.map((p) => {
    const completed = p.items.filter((i) => i.status === 'COMPLETED').length;
    return serializeProject(p, {
      productName: p.product?.name || null,
      itemCount: p._count.items,
      completedItems: completed,
    });
  });
}

export async function getProjectFull(id) {
  const p = await prisma.cfProject.findUnique({
    where: { id },
    include: {
      product: true,
      items: { orderBy: { position: 'asc' }, include: { copy: true, assets: { orderBy: { id: 'desc' } }, _count: { select: { attempts: true } } } },
      jobs: { orderBy: { id: 'desc' }, take: 5 },
    },
  });
  if (!p) throw bad('المشروع غير موجود.', 404);
  const reviews = await prisma.cfQualityReview.findMany({ where: { asset_id: { in: p.items.flatMap((it) => it.assets.map((a) => a.id)) } } });
  const reviewByAsset = new Map(reviews.map((r) => [r.asset_id, r]));
  return {
    ...serializeProject(p, { productName: p.product?.name || null }),
    product: serializeProduct(p.product),
    items: p.items.map((it) => serializePlanItem(it, reviewByAsset)),
    jobs: p.jobs.map((j) => ({ id: j.id, status: j.status, progress: j.progress, totalItems: j.total_items, completedItems: j.completed_items, failedItems: j.failed_items, error: j.error, createdAt: j.created_at, finishedAt: j.finished_at })),
    activeJob: p.jobs.find((j) => ['QUEUED', 'GENERATING', 'REVIEWING', 'REGENERATING'].includes(j.status)) ? p.jobs[0].id : null,
  };
}

export async function archiveProject(id) {
  await prisma.cfProject.update({ where: { id }, data: { archived_at: new Date(), status: 'CANCELLED' } }).catch(() => { throw bad('المشروع غير موجود.', 404); });
  return { ok: true };
}

export async function duplicateProject(id, userId) {
  const src = await prisma.cfProject.findUnique({ where: { id }, include: { items: { include: { copy: true }, orderBy: { position: 'asc' } } } });
  if (!src) throw bad('المشروع غير موجود.', 404);
  const copy = await prisma.cfProject.create({
    data: {
      product_id: src.product_id, project_type: src.project_type, quantity: src.quantity, quantity_mode: src.quantity_mode,
      generation_mode: src.generation_mode, style_preset: src.style_preset, market: src.market, language: src.language,
      dialect: src.dialect, aspect_ratio: src.aspect_ratio, text_density: src.text_density, people_rule: src.people_rule,
      hijab_required: src.hijab_required, product_lock_mode: src.product_lock_mode, status: 'PLAN_READY',
      plan_notes: src.plan_notes, estimated_cost: src.estimated_cost, created_by_id: userId || null,
    },
  });
  for (const it of src.items) {
    const ni = await prisma.cfProjectItem.create({
      data: {
        project_id: copy.id, position: it.position, purpose: it.purpose, angle: it.angle, scene: it.scene,
        product_placement: it.product_placement, camera_angle: it.camera_angle, composition: it.composition,
        background: it.background, headline: it.headline, supporting_copy: it.supporting_copy, cta: it.cta,
        features_json: it.features_json, reference_priority_json: it.reference_priority_json, visual_style: it.visual_style,
        reason: it.reason, status: 'PLANNED',
      },
    });
    if (it.copy) {
      await prisma.cfCreativeCopy.create({
        data: {
          project_item_id: ni.id, hook: it.copy.hook, supporting_line: it.copy.supporting_line, headline: it.copy.headline,
          subtitle: it.copy.subtitle, cta: it.copy.cta, feature_callouts_json: it.copy.feature_callouts_json,
          alignment: it.copy.alignment, priority: it.copy.priority, safe_area: it.copy.safe_area,
          claim_status: it.copy.claim_status, edited_by_user: it.copy.edited_by_user,
        },
      });
    }
  }
  return serializeProject(copy);
}

// ===========================================================================
// Plan
// ===========================================================================
export function serializePlanItem(it, reviewByAsset = new Map()) {
  const approved = it.assets.find((a) => a.id === it.approved_asset_id) || null;
  return {
    id: it.id, position: it.position, purpose: it.purpose, angle: it.angle, scene: it.scene,
    productPlacement: it.product_placement, cameraAngle: it.camera_angle, composition: it.composition,
    background: it.background, headline: it.headline, supportingCopy: it.supporting_copy, cta: it.cta,
    features: safeParse(it.features_json, []), referencePriority: safeParse(it.reference_priority_json, []),
    visualStyle: it.visual_style, reason: it.reason, status: it.status,
    planMeta: safeParse(it.plan_meta_json, null),
    approvedAssetId: it.approved_asset_id,
    attemptCount: it._count?.attempts ?? undefined,
    copy: it.copy ? {
      hook: it.copy.hook, supportingLine: it.copy.supporting_line, headline: it.copy.headline, subtitle: it.copy.subtitle,
      cta: it.copy.cta, featureCallouts: safeParse(it.copy.feature_callouts_json, []),
      claimStatus: it.copy.claim_status, claimIssues: safeParse(it.copy.claim_issues_json, []), editedByUser: it.copy.edited_by_user,
    } : null,
    assets: (it.assets || []).map((a) => serializeAssetBrief(a, reviewByAsset.get(a.id))),
    approvedAsset: approved ? serializeAssetBrief(approved, reviewByAsset.get(approved.id)) : null,
  };
}

export async function generatePlan(projectId, { count } = {}) {
  const project = await prisma.cfProject.findUnique({ where: { id: projectId }, include: { product: true, items: true } });
  if (!project) throw bad('المشروع غير موجود.', 404);
  if (['GENERATING', 'QUEUED'].includes(project.status)) throw bad('فيه إنشاء صور شغال — لا يمكن إعادة توليد الخطة الآن.', 409);

  const dna = await getDna(project.product_id);
  const th = await getEffectiveThresholds();
  const n = clampInt(count ?? project.quantity, 1, 1, th.maxImagesPerProject);
  const feedbackHints = await getFeedbackHints(project.product?.category || null).catch(() => null);
  const { items, source } = await buildCreativePlan({ project, product: project.product, dna, count: n, feedbackHints });

  // Replace any existing plan items (only allowed pre-generation).
  await prisma.cfProjectItem.deleteMany({ where: { project_id: projectId } });
  for (const raw of items) {
    await prisma.cfProjectItem.create({
      data: {
        project_id: projectId, position: raw.position,
        purpose: strOrNull(raw.purpose), angle: strOrNull(raw.angle), scene: strOrNull(raw.scene),
        product_placement: strOrNull(raw.product_placement), camera_angle: strOrNull(raw.camera_angle),
        composition: strOrNull(raw.composition), background: strOrNull(raw.background),
        headline: strOrNull(raw.headline), supporting_copy: strOrNull(raw.supporting_copy), cta: strOrNull(raw.cta),
        features_json: JSON.stringify(raw.features || []),
        reference_priority_json: JSON.stringify(raw.reference_priority || []),
        visual_style: strOrNull(raw.visual_style), reason: strOrNull(raw.reason), status: 'PLANNED',
        plan_meta_json: JSON.stringify({
          creativeGoal: raw.creative_goal || raw.creativeGoal || null,
          marketingAngle: raw.marketing_angle || raw.marketingAngle || raw.angle || null,
          customerQuestion: raw.customer_question || raw.customerQuestion || null,
          visualConcept: raw.visual_concept || raw.visualConcept || null,
          cameraPlan: raw.camera_plan || raw.cameraPlan || raw.camera_angle || null,
          scenePlan: raw.scene_plan || raw.scenePlan || raw.scene || null,
          productPosition: raw.product_position || raw.productPosition || raw.product_placement || null,
          copyGoal: raw.copy_goal || raw.copyGoal || null,
          textLayout: raw.text_layout || raw.textLayout || null,
        }),
      },
    });
  }
  await prisma.cfProject.update({ where: { id: projectId }, data: { quantity: n, status: 'PLAN_READY', estimated_cost: estimateCostUsd(n) } });
  return { ...(await getProjectFull(projectId)), planSource: source };
}

const ITEM_EDITABLE = {
  purpose: 'purpose', angle: 'angle', scene: 'scene', productPlacement: 'product_placement',
  cameraAngle: 'camera_angle', composition: 'composition', background: 'background',
  headline: 'headline', supportingCopy: 'supporting_copy', cta: 'cta', visualStyle: 'visual_style', reason: 'reason',
};

export async function updatePlanItem(projectId, itemId, body) {
  const it = await prisma.cfProjectItem.findFirst({ where: { id: itemId, project_id: projectId } });
  if (!it) throw bad('عنصر الخطة غير موجود.', 404);
  if (['GENERATING', 'REGENERATING', 'QUEUED'].includes(it.status)) throw bad('العنصر تحت الإنشاء الآن.', 409);
  const data = {};
  for (const [k, col] of Object.entries(ITEM_EDITABLE)) if (body[k] !== undefined) data[col] = strOrNull(body[k]);
  if (Array.isArray(body.features)) data.features_json = JSON.stringify(body.features.slice(0, 12));
  if (Array.isArray(body.referencePriority)) data.reference_priority_json = JSON.stringify(body.referencePriority.slice(0, 6));
  const row = await prisma.cfProjectItem.update({ where: { id: itemId }, data });

  if (body.copy && typeof body.copy === 'object') {
    const c = body.copy;
    await prisma.cfCreativeCopy.upsert({
      where: { project_item_id: itemId },
      create: {
        project_item_id: itemId, hook: strOrNull(c.hook), supporting_line: strOrNull(c.supportingLine),
        headline: strOrNull(c.headline), subtitle: strOrNull(c.subtitle), cta: strOrNull(c.cta),
        feature_callouts_json: JSON.stringify(Array.isArray(c.featureCallouts) ? c.featureCallouts : []),
        claim_status: 'PENDING', edited_by_user: true,
      },
      update: {
        hook: strOrNull(c.hook), supporting_line: strOrNull(c.supportingLine), headline: strOrNull(c.headline),
        subtitle: strOrNull(c.subtitle), cta: strOrNull(c.cta),
        feature_callouts_json: JSON.stringify(Array.isArray(c.featureCallouts) ? c.featureCallouts : []),
        edited_by_user: true, claim_status: 'PENDING',
      },
    });
  }
  return serializePlanItem(await prisma.cfProjectItem.findUnique({ where: { id: itemId }, include: { copy: true, assets: true, _count: { select: { attempts: true } } } }));
}

export async function addPlanItem(projectId, body) {
  const project = await prisma.cfProject.findUnique({ where: { id: projectId }, include: { _count: { select: { items: true } } } });
  if (!project) throw bad('المشروع غير موجود.', 404);
  const th = await getEffectiveThresholds();
  if (project._count.items >= th.maxImagesPerProject) throw bad(`الحد الأقصى ${th.maxImagesPerProject} صورة في المشروع.`);
  const max = await prisma.cfProjectItem.aggregate({ where: { project_id: projectId }, _max: { position: true } });
  const row = await prisma.cfProjectItem.create({
    data: {
      project_id: projectId, position: (max._max.position || 0) + 1,
      purpose: strOrNull(body.purpose) || 'صورة إضافية', angle: strOrNull(body.angle),
      scene: strOrNull(body.scene), camera_angle: strOrNull(body.cameraAngle) || '3/4',
      reason: strOrNull(body.reason) || 'أضيفت يدويًا', status: 'PLANNED',
    },
  });
  await prisma.cfProject.update({ where: { id: projectId }, data: { quantity: project._count.items + 1, estimated_cost: estimateCostUsd(project._count.items + 1) } });
  return serializePlanItem({ ...row, copy: null, assets: [], _count: { attempts: 0 } });
}

export async function deletePlanItem(projectId, itemId) {
  const it = await prisma.cfProjectItem.findFirst({ where: { id: itemId, project_id: projectId } });
  if (!it) throw bad('عنصر الخطة غير موجود.', 404);
  await prisma.cfProjectItem.delete({ where: { id: itemId } });
  const remaining = await prisma.cfProjectItem.findMany({ where: { project_id: projectId }, orderBy: { position: 'asc' } });
  let i = 1; for (const r of remaining) await prisma.cfProjectItem.update({ where: { id: r.id }, data: { position: i++ } });
  await prisma.cfProject.update({ where: { id: projectId }, data: { quantity: remaining.length, estimated_cost: estimateCostUsd(remaining.length) } });
  return { ok: true };
}

export async function reorderPlanItems(projectId, orderIds) {
  const rows = await prisma.cfProjectItem.findMany({ where: { project_id: projectId } });
  const set = new Set(rows.map((r) => r.id));
  let i = 1;
  for (const id of orderIds || []) if (set.has(id)) await prisma.cfProjectItem.update({ where: { id }, data: { position: i++ } });
  return { ok: true };
}

export async function approvePlan(projectId) {
  const project = await prisma.cfProject.findUnique({ where: { id: projectId }, include: { _count: { select: { items: true } } } });
  if (!project) throw bad('المشروع غير موجود.', 404);
  if (project._count.items < 1) throw bad('لا توجد عناصر في الخطة.');
  await prisma.cfProject.update({ where: { id: projectId }, data: { status: 'PLAN_READY' } });
  return { ok: true };
}

// ===========================================================================
// Assets / gallery
// ===========================================================================
export function serializeAssetBrief(a, review) {
  return {
    id: a.id, uuid: a.uuid, status: a.status, kind: a.kind, mime: a.mime, width: a.width, height: a.height,
    isCandidate: a.is_candidate, candidateRank: a.candidate_rank, variationType: a.variation_type,
    generationNumber: a.generation_number, parentAssetId: a.parent_asset_id, createdAt: a.created_at,
    imageUrl: `/api/creative-factory/assets/${a.id}/image`,
    quality: review ? {
      overall: review.overall_score, productAccuracy: review.product_accuracy_score, visualQuality: review.visual_quality_score,
      marketing: review.marketing_score, claim: review.claim_score, arabicText: review.arabic_text_score,
      passed: review.passed, failureReasons: safeParse(review.failure_reasons_json, []), recommendation: review.recommendation,
    } : null,
  };
}

export async function listAssets(filters = {}) {
  const where = { kind: 'GENERATED' };
  if (filters.productId) where.product_id = Number(filters.productId);
  if (filters.status) where.status = String(filters.status);
  if (filters.projectId) where.project_item = { project_id: Number(filters.projectId) };
  if (!filters.includeCandidates) where.is_candidate = false;
  const take = clampInt(filters.limit, 40, 1, 100);
  const cursor = filters.cursor ? { id: Number(filters.cursor) } : undefined;
  const rows = await prisma.cfAsset.findMany({
    where, orderBy: { id: 'desc' }, take: take + 1, ...(cursor ? { cursor, skip: 1 } : {}),
    include: { quality_review: true, project_item: { include: { project: { select: { project_type: true, style_preset: true, id: true } }, copy: true } } },
  });
  const hasMore = rows.length > take;
  const page = rows.slice(0, take);
  return {
    nextCursor: hasMore ? String(page[page.length - 1].id) : null,
    assets: page.map((a) => ({
      ...serializeAssetBrief(a, a.quality_review),
      projectId: a.project_item?.project?.id || null,
      projectType: a.project_item?.project?.project_type || null,
      stylePreset: a.project_item?.project?.style_preset || null,
      purpose: a.project_item?.purpose || null,
      angle: a.project_item?.angle || null,
      hook: a.project_item?.copy?.hook || a.project_item?.headline || null,
    })),
  };
}

export async function getAssetFull(id) {
  const a = await prisma.cfAsset.findUnique({
    where: { id },
    include: {
      quality_review: true,
      generation_attempt: true,
      project_item: { include: { project: { include: { product: true } }, copy: true, attempts: { orderBy: { attempt_number: 'asc' } } } },
    },
  });
  if (!a) throw bad('الصورة غير موجودة.', 404);
  const it = a.project_item;
  return {
    ...serializeAssetBrief(a, a.quality_review),
    productId: a.product_id,
    prompt: a.generation_attempt?.prompt || null,
    promptVersion: a.generation_attempt?.prompt_version || null,
    generationMode: it?.project?.generation_mode || null,
    project: it?.project ? { id: it.project.id, type: it.project.project_type, productName: it.project.product?.name } : null,
    planItem: it ? { id: it.id, position: it.position, purpose: it.purpose, angle: it.angle, scene: it.scene } : null,
    copy: it?.copy ? { hook: it.copy.hook, supportingLine: it.copy.supporting_line, cta: it.copy.cta, claimStatus: it.copy.claim_status } : null,
    attempts: (it?.attempts || []).map((at) => ({ n: at.attempt_number, provider: at.provider, model: at.model, status: at.status, error: at.error, estimatedCost: at.estimated_cost, promptVersion: at.prompt_version, createdAt: at.created_at })),
    qualityFull: a.quality_review ? fullReview(a.quality_review) : null,
  };
}

export async function assetImageResponse(id) {
  const a = await prisma.cfAsset.findUnique({ where: { id } });
  if (!a) throw bad('الصورة غير موجودة.', 404);
  const got = await StorageService.get({ provider: a.storage_provider, key: a.storage_key });
  if (!got) throw bad('تعذر تحميل الصورة من التخزين.', 404);
  return { buffer: got.buffer, mime: got.mime };
}

export async function setAssetStatus(id, status) {
  const allowed = ['APPROVED', 'REJECTED', 'ARCHIVED', 'PENDING_REVIEW'];
  if (!allowed.includes(status)) throw bad('حالة غير صالحة.');
  const a = await prisma.cfAsset.findUnique({ where: { id }, include: { project_item: true } });
  if (!a) throw bad('الصورة غير موجودة.', 404);
  await prisma.cfAsset.update({ where: { id }, data: { status } });
  if (a.project_item) {
    if (status === 'APPROVED') {
      await prisma.cfProjectItem.update({ where: { id: a.project_item.id }, data: { approved_asset_id: id, status: 'COMPLETED' } });
      await prisma.cfAsset.updateMany({ where: { project_item_id: a.project_item.id, id: { not: id }, status: 'APPROVED' }, data: { status: 'REJECTED' } });
    } else if (status === 'REJECTED' && a.project_item.approved_asset_id === id) {
      await prisma.cfProjectItem.update({ where: { id: a.project_item.id }, data: { approved_asset_id: null, status: 'NEEDS_REVIEW' } });
    }
  }
  return { ok: true };
}

// ===========================================================================
// Cost estimate
// ===========================================================================
export async function estimateProjectCost({ count, generationMode }) {
  const th = await getEffectiveThresholds();
  const n = clampInt(count, 1, 1, th.maxImagesPerProject);
  const premiumExtra = generationMode === 'PREMIUM' && th.allowPremiumMode ? (th.premiumCandidates - 1) : 0;
  const totalImages = n + premiumExtra;
  const usd = estimateCostUsd(totalImages);
  return {
    imageCount: n,
    internalImageCount: totalImages,
    estimatedUsd: usd,
    available: imageUnitCostUsd() !== null,
    display: usd === null ? 'غير متاحة حاليًا' : `~$${usd}`,
  };
}

// ===========================================================================
// Feedback (spec §21) — 👍/👎 + reason, keyed by category / angle / style.
// ===========================================================================
export const FEEDBACK_REASONS = ['المنتج اتغير', 'الفكرة ضعيفة', 'التصميم مش عاجبني', 'الكلام ضعيف', 'الصورة مش واقعية', 'استخدام المنتج غلط', 'أخرى'];

export async function saveAssetFeedback(assetId, { verdict, reason, note }, userId) {
  const v = verdict === 'UP' || verdict === 'DOWN' ? verdict : null;
  if (!v) throw bad('verdict لازم يكون UP أو DOWN.');
  const a = await prisma.cfAsset.findUnique({
    where: { id: assetId },
    include: { product: { select: { category: true } }, project_item: { include: { project: { select: { style_preset: true, project_type: true, product_lock_mode: true } } } } },
  });
  if (!a) throw bad('الصورة غير موجودة.', 404);
  const it = a.project_item;
  const row = await prisma.cfFeedback.create({
    data: {
      asset_id: assetId, verdict: v,
      reason: reason && FEEDBACK_REASONS.includes(reason) ? reason : (reason ? 'أخرى' : null),
      note: strOrNull(note),
      product_category: a.product?.category || null,
      creative_angle: it?.angle || safeParse(it?.plan_meta_json, {})?.marketingAngle || null,
      style_preset: it?.project?.style_preset || null,
      prompt_strategy: [it?.project?.product_lock_mode, safeParse(it?.plan_meta_json, {})?.textLayout].filter(Boolean).join('+') || null,
      created_by_id: userId || null,
    },
  });
  // reflect a thumbs-down as a soft signal on the asset
  if (v === 'DOWN' && a.status === 'APPROVED') {
    await prisma.cfAsset.update({ where: { id: assetId }, data: { status: 'PENDING_REVIEW' } }).catch(() => {});
  }
  return { id: row.id, verdict: v };
}

/** Aggregated hints Creative Strategy can weight future plans with. */
export async function getFeedbackHints(category = null) {
  const where = category ? { product_category: category } : {};
  const rows = await prisma.cfFeedback.findMany({ where, orderBy: { id: 'desc' }, take: 400 });
  const tally = (field) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[field]; if (!k) continue;
      const e = m.get(k) || { up: 0, down: 0 };
      e[r.verdict === 'UP' ? 'up' : 'down']++;
      m.set(k, e);
    }
    return [...m.entries()].map(([key, v]) => ({ key, ...v, score: v.up - v.down, n: v.up + v.down }))
      .sort((x, y) => y.score - x.score);
  };
  return {
    total: rows.length,
    byAngle: tally('creative_angle'),
    byStyle: tally('style_preset'),
    byReason: rows.filter((r) => r.verdict === 'DOWN' && r.reason)
      .reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {}),
  };
}

// ---------------------------------------------------------------------------
function fullReview(r) {
  const meta = safeParse(r.failure_reasons_json, {});
  const isArr = Array.isArray(meta);
  return {
    overall: r.overall_score,
    realism: isArr ? null : (meta.realism ?? null),
    failureCode: isArr ? null : (meta.code ?? null),
    identityMismatch: isArr ? false : !!meta.identityMismatch,
    looksAi: isArr ? false : !!meta.looksAi,
    goodEnough: isArr ? false : !!meta.goodEnough,
    scores: {
      product_accuracy_score: r.product_accuracy_score, identity_score: r.identity_score, visual_quality_score: r.visual_quality_score,
      composition_score: r.composition_score, product_visibility_score: r.product_visibility_score, marketing_score: r.marketing_score,
      arabic_text_score: r.arabic_text_score, text_readability_score: r.text_readability_score, claim_score: r.claim_score,
      artifact_score: r.artifact_score, reference_consistency_score: r.reference_consistency_score, plan_compliance_score: r.plan_compliance_score,
    },
    passed: r.passed,
    failureReasons: isArr ? meta : (meta.reasons || []),
    recommendation: r.recommendation, judgeModel: r.judge_model,
  };
}

function strOrNull(v) { const s = v === null || v === undefined ? '' : String(v).trim(); return s || null; }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function clampInt(v, dflt, lo, hi) { const n = Math.round(Number(v)); if (!Number.isFinite(n)) return dflt; return Math.max(lo, Math.min(hi, n)); }
function safeParse(s, dflt) { try { const v = JSON.parse(s); return v ?? dflt; } catch { return dflt; } }

export { recommendImageCount, STYLE_PRESETS, PROJECT_TYPES, PRODUCT_LOCK_MODES, TEXT_DENSITIES, PEOPLE_RULES, ASPECT_RATIOS };
