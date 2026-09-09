// AI Creative Factory — variation system + creative family tree.
//
// A variation always keeps LINEAGE: parent_asset_id -> child asset, a
// variation_type and a generation_number. The change is applied on top of the
// parent's plan item + copy + direction (not a restart from zero) so the
// concept survives. Generation itself reuses the standard job worker via a
// synthetic single-item project path.
import { prisma } from '../../prisma.js';
import { VARIATION_TYPES } from './taxonomy.js';
import { createGenerationJob } from './generationJob.js';

const TYPE_INSTRUCTION = {
  SAME_CONCEPT: 'أعد إنشاء نفس الفكرة بنفس التوجيه مع تحسين التنفيذ.',
  NEW_HOOK: 'غيّر الهوك النصي فقط — نفس المشهد والتكوين.',
  NEW_COPY: 'أعد صياغة كل النص (هوك + سطر مساند + CTA) مع الحفاظ على المشهد.',
  NEW_BACKGROUND: 'غيّر الخلفية فقط — نفس المنتج ونفس الزاوية والنص.',
  NEW_CAMERA_ANGLE: 'غيّر زاوية الكاميرا فقط.',
  NEW_ENVIRONMENT: 'انقل المنتج لبيئة/سياق استخدام مختلف.',
  NEW_AUDIENCE: 'وجّه المشهد والنص لشريحة جمهور مختلفة.',
  NEW_STYLE: 'غيّر الأسلوب البصري (preset) مع نفس الفكرة.',
  NEW_ANGLE: 'غيّر زاوية الرسالة التسويقية بالكامل.',
};

/**
 * Create N variations of one asset. Returns { variationIds, jobId }.
 */
export async function createVariations({ parentAssetId, variationType, count = 1, instructions = null, userId = null }) {
  if (!VARIATION_TYPES.includes(variationType)) { const e = new Error('نوع Variation غير معروف.'); e.status = 400; throw e; }
  const n = Math.max(1, Math.min(10, Number(count) || 1));

  const parent = await prisma.cfAsset.findUnique({
    where: { id: parentAssetId },
    include: { project_item: { include: { project: true, copy: true } } },
  });
  if (!parent) { const e = new Error('الصورة الأصلية غير موجودة.'); e.status = 404; throw e; }
  const srcItem = parent.project_item;
  if (!srcItem) { const e = new Error('الصورة دي مش مرتبطة بعنصر خطة — لا يمكن اشتقاق Variation منها.'); e.status = 400; throw e; }
  const project = srcItem.project;

  const priorGen = await prisma.cfVariation.count({ where: { parent_asset_id: parentAssetId } });

  const newItemIds = [];
  const variationRows = [];
  for (let i = 0; i < n; i++) {
    const item = await prisma.cfProjectItem.create({
      data: {
        project_id: project.id,
        position: (await nextPosition(project.id)),
        purpose: srcItem.purpose, angle: variationType === 'NEW_ANGLE' ? null : srcItem.angle,
        scene: variationType === 'NEW_ENVIRONMENT' ? null : srcItem.scene,
        product_placement: srcItem.product_placement,
        camera_angle: variationType === 'NEW_CAMERA_ANGLE' ? null : srcItem.camera_angle,
        composition: srcItem.composition,
        background: variationType === 'NEW_BACKGROUND' ? null : srcItem.background,
        headline: ['NEW_HOOK', 'NEW_COPY'].includes(variationType) ? null : srcItem.headline,
        supporting_copy: variationType === 'NEW_COPY' ? null : srcItem.supporting_copy,
        cta: srcItem.cta,
        features_json: srcItem.features_json,
        reference_priority_json: srcItem.reference_priority_json,
        visual_style: variationType === 'NEW_STYLE' ? null : srcItem.visual_style,
        reason: `Variation (${variationType}) من الصورة ${parent.uuid}`,
        status: 'PLANNED',
      },
    });
    // Carry the parent copy unless this variation type explicitly changes it.
    if (srcItem.copy && !['NEW_HOOK', 'NEW_COPY'].includes(variationType)) {
      await prisma.cfCreativeCopy.create({
        data: {
          project_item_id: item.id,
          hook: srcItem.copy.hook, supporting_line: srcItem.copy.supporting_line,
          headline: srcItem.copy.headline, subtitle: srcItem.copy.subtitle, cta: srcItem.copy.cta,
          feature_callouts_json: srcItem.copy.feature_callouts_json,
          alignment: srcItem.copy.alignment, priority: srcItem.copy.priority, safe_area: srcItem.copy.safe_area,
          claim_status: srcItem.copy.claim_status, edited_by_user: true, // treat as fixed for a non-copy variation
        },
      });
    }
    const v = await prisma.cfVariation.create({
      data: {
        parent_asset_id: parentAssetId, project_id: project.id,
        variation_type: variationType, generation_number: priorGen + i + 1,
        instructions_json: JSON.stringify({ note: instructions || TYPE_INSTRUCTION[variationType] }),
        status: 'GENERATING', created_by_id: userId,
      },
    });
    newItemIds.push(item.id);
    variationRows.push(v);
  }

  const job = await createGenerationJob({ projectId: project.id, itemIds: newItemIds, userId, kind: 'VARIATION' });
  return { variationIds: variationRows.map((v) => v.id), jobId: job.id, itemIds: newItemIds };
}

/**
 * Link every pending CfVariation to the asset its item actually produced, and
 * close out its status. Cheap; safe to call on every scheduler tick.
 */
export async function reconcileVariationChildren() {
  const open = await prisma.cfVariation.findMany({ where: { status: { in: ['GENERATING', 'PENDING'] }, child_asset_id: null }, take: 100 });
  for (const v of open) {
    // The variation's item is the most recent PLANNED->done item on its project
    // that references this variation's parent in its `reason`.
    const item = await prisma.cfProjectItem.findFirst({
      where: { project_id: v.project_id ?? undefined, reason: { contains: 'Variation' } },
      orderBy: { id: 'desc' },
    });
    if (!item) continue;
    if (['COMPLETED', 'NEEDS_REVIEW'].includes(item.status)) {
      const child = item.approved_asset_id
        ? item.approved_asset_id
        : (await prisma.cfAsset.findFirst({ where: { project_item_id: item.id }, orderBy: [{ status: 'asc' }, { id: 'desc' }] }))?.id || null;
      await prisma.cfVariation.update({
        where: { id: v.id },
        data: { child_asset_id: child, status: item.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED' },
      });
      if (child) {
        await prisma.cfAsset.update({ where: { id: child }, data: { parent_asset_id: v.parent_asset_id, variation_type: v.variation_type, generation_number: v.generation_number } }).catch(() => {});
      }
    } else if (item.status === 'FAILED') {
      await prisma.cfVariation.update({ where: { id: v.id }, data: { status: 'FAILED' } });
    }
  }
}

/** Family tree for an asset: walk up to the root, then list descendants. */
export async function familyTree(assetId) {
  const node = await prisma.cfAsset.findUnique({ where: { id: assetId } });
  if (!node) return null;
  let rootId = assetId;
  let cur = node;
  const guard = new Set();
  while (cur?.parent_asset_id && !guard.has(cur.id)) {
    guard.add(cur.id);
    cur = await prisma.cfAsset.findUnique({ where: { id: cur.parent_asset_id } });
    if (cur) rootId = cur.id;
  }
  const all = await prisma.cfVariation.findMany({ where: { OR: [{ parent_asset_id: rootId }, { child_asset_id: { not: null } }] }, orderBy: { created_at: 'asc' } });
  return { rootId, focusId: assetId, edges: all.map((v) => ({ id: v.id, parentAssetId: v.parent_asset_id, childAssetId: v.child_asset_id, type: v.variation_type, generation: v.generation_number, status: v.status })) };
}

async function nextPosition(projectId) {
  const max = await prisma.cfProjectItem.aggregate({ where: { project_id: projectId }, _max: { position: true } });
  return (max._max.position || 0) + 1;
}
