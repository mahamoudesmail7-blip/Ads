// AI Creative Factory — ProductAnalysisService + ProductDNAService.
//
// Turns the reference photos + the owner's product info into a STRUCTURED
// Product DNA profile (not free text). AI (Claude vision) when configured;
// otherwise a clearly-labelled empty skeleton the owner fills in manually —
// never a fabricated profile. The result is stored versioned on
// cf_product_dna and always feeds the generation pipeline.
import { prisma } from '../../prisma.js';
import { callAiJson } from './textAi.js';
import { StorageService } from './storage.js';
import { emptyDnaSkeleton } from './taxonomy.js';

const MODEL_VERSION = 'cf-dna-v1';

const SYSTEM = `أنت محلل منتجات بصري دقيق للتجارة الإلكترونية. مهمتك: من صور المنتج المرجعية وبيانات المنتج، استخرج ملف "حمض نووي بصري" (Product DNA) منظّم.
قواعد صارمة:
- صف فقط ما هو مرئي فعلاً في الصور أو مذكور صراحة في البيانات. لا تخترع أي تفصيلة.
- إذا كانت معلومة غير واضحة، اترك القيمة null أو []، ولا تخمّن.
- "never_invent" = قائمة العناصر التي يجب ألا يبتكرها مولّد الصور لاحقاً (شعارات، منافذ، أزرار، ملصقات، أرقام موديل...).
- أعطِ confidence رقم من 0 إلى 100 لمدى وضوح الصور.`;

function dnaUserPrompt(product) {
  return `بيانات المنتج:
- الاسم: ${product.name || '—'}
- التصنيف: ${product.category || '—'}
- الوصف: ${product.description || '—'}
- المواصفات: ${product.specifications || '—'}
- الفوائد: ${product.benefits || '—'}
- ملاحظات: ${product.notes || '—'}

أعد JSON بهذا الشكل بالضبط (نفس المفاتيح):
{
  "primary_colors": [], "secondary_colors": [], "product_shape": null,
  "visible_materials": [], "proportions": null, "buttons": null, "ports": null,
  "display_screen": null, "handles": null, "attachments": [], "cables": [],
  "hoses": [], "accessories": [], "logos_branding": [], "patterns": [],
  "transparent_parts": null, "metallic_parts": null, "packaging_appearance": null,
  "unique_design_details": [], "features_visible_in_reference": [],
  "never_invent": [], "confidence": 0
}`;
}

async function loadReferenceBuffers(productId, limit = 6) {
  const refs = await prisma.cfReferenceImage.findMany({
    where: { product_id: productId, active: true },
    orderBy: { sort_order: 'asc' },
    take: limit,
  });
  const out = [];
  for (const r of refs) {
    const got = await StorageService.get({ provider: r.storage_provider, key: r.storage_key });
    if (got?.buffer?.length) out.push({ buffer: got.buffer, mime: got.mime, label: `صورة مرجعية: ${r.angle_label || 'بدون تسمية'}` });
  }
  return out;
}

/** Analyse (or re-analyse) a product's DNA and persist it. Never throws for a
 *  missing AI key — returns a skeleton with source:'UNAVAILABLE'. */
export async function analyzeProductDna(productId) {
  const product = await prisma.cfProduct.findUnique({ where: { id: productId } });
  if (!product) { const e = new Error('المنتج غير موجود.'); e.status = 404; throw e; }

  const images = await loadReferenceBuffers(productId);
  const prev = await prisma.cfProductDna.findUnique({ where: { product_id: productId } });
  const nextVersion = (prev?.version || 0) + 1;

  let data = emptyDnaSkeleton();
  let confidence = null;
  let source = 'UNAVAILABLE';

  if (images.length) {
    const ai = await callAiJson({ system: SYSTEM, user: dnaUserPrompt(product), images, maxTokens: 1800 });
    if (ai.ok && ai.data && typeof ai.data === 'object') {
      data = { ...emptyDnaSkeleton(), ...ai.data };
      confidence = clampScore(ai.data.confidence);
      data.confidence = confidence;
      source = 'AI_ANALYZED';
    }
  }

  const row = await prisma.cfProductDna.upsert({
    where: { product_id: productId },
    create: {
      product_id: productId, data_json: JSON.stringify(data), confidence,
      version: nextVersion, model_version: MODEL_VERSION, source, reviewed_by_user: false,
    },
    update: {
      data_json: JSON.stringify(data), confidence, version: nextVersion,
      model_version: MODEL_VERSION, source, reviewed_by_user: false,
    },
  });
  return serializeDna(row, { referenceCount: images.length });
}

/** Owner's manual correction — flips reviewed_by_user, keeps version, marks MIXED/USER_EDITED. */
export async function saveDnaEdit(productId, patchData) {
  const prev = await prisma.cfProductDna.findUnique({ where: { product_id: productId } });
  const base = prev ? safeParse(prev.data_json) : emptyDnaSkeleton();
  const merged = { ...emptyDnaSkeleton(), ...base, ...(patchData || {}) };
  const source = prev?.source === 'AI_ANALYZED' ? 'MIXED' : 'USER_EDITED';
  const row = await prisma.cfProductDna.upsert({
    where: { product_id: productId },
    create: { product_id: productId, data_json: JSON.stringify(merged), version: 1, model_version: MODEL_VERSION, source: 'USER_EDITED', reviewed_by_user: true, confidence: clampScore(merged.confidence) },
    update: { data_json: JSON.stringify(merged), source, reviewed_by_user: true, confidence: clampScore(merged.confidence) },
  });
  return serializeDna(row);
}

export async function getDna(productId) {
  const row = await prisma.cfProductDna.findUnique({ where: { product_id: productId } });
  return row ? serializeDna(row) : null;
}

export function serializeDna(row, extra = {}) {
  return {
    productId: row.product_id,
    data: safeParse(row.data_json),
    confidence: row.confidence,
    version: row.version,
    reviewedByUser: row.reviewed_by_user,
    source: row.source,
    modelVersion: row.model_version,
    updatedAt: row.updated_at,
    ...extra,
  };
}

function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}
function safeParse(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
