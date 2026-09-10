// AI Creative Factory — GenerationJobService.
//
// Background image generation. NEVER runs 20/50 generations inside one HTTP
// request: createGenerationJob() writes a cf_jobs row + flips items to QUEUED
// and returns immediately; a worker (kicked here + by the scheduler) does the
// slow work, so progress survives a page refresh.
//
// Per item: ensure claim-guarded copy -> build prompt -> provider.generate
// -> store asset(s) -> automatic quality review -> APPROVE if it passes,
// else a TARGETED corrective prompt and retry (up to maxRetries) -> after
// that, mark the item NEEDS_REVIEW (never silently "done"). PREMIUM mode
// makes 2–N internal candidates for the hero image and keeps the best.
//
// Mock-safe: with the image provider off, every item fails with a real
// PROVIDER_NOT_CONFIGURED error, the job ends FAILED/PARTIAL_COMPLETE, and no
// fake image is ever produced.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getImageProvider, CfProviderError } from './imageProvider.js';
import { StorageService } from './storage.js';
import { getEffectiveThresholds } from './thresholds.js';
import { imageSizeFor, estimateCostUsd } from './config.js';
import { getDna } from './productDna.js';
import { generateCopyForItem } from './marketingCopy.js';
import { guardCopy } from './claimsGuard.js';
import { directItem, defaultContinuity } from './creativeDirector.js';
import { buildPrompt, selectReferencesForItem } from './promptBuilder.js';
import { reviewImage, saveReview } from './imageQuality.js';
import { buildCorrectiveNote } from './regeneration.js';
import { validatePlanConcepts } from './creativeStrategy.js';
import { composeText, textCompositorAvailable } from './textCompositor.js';

const running = new Set();     // job ids currently being processed in THIS process
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------
export async function createGenerationJob({ projectId, itemIds = null, userId = null, kind = 'PROJECT_GENERATION' }) {
  const project = await prisma.cfProject.findUnique({ where: { id: projectId }, include: { items: { orderBy: { position: 'asc' } } } });
  if (!project) { const e = new Error('المشروع غير موجود.'); e.status = 404; throw e; }

  const targetItems = (project.items || []).filter((it) => (itemIds ? itemIds.includes(it.id) : true));
  if (!targetItems.length) { const e = new Error('لا توجد عناصر خطة لإنشائها — اعتمد الخطة الأول.'); e.status = 400; throw e; }

  // Refuse a second concurrent job for the same project.
  const active = await prisma.cfJob.findFirst({ where: { project_id: projectId, status: { in: ['QUEUED', 'GENERATING', 'REVIEWING', 'REGENERATING'] } } });
  if (active) { const e = new Error('فيه عملية إنشاء شغالة على المشروع ده بالفعل.'); e.status = 409; e.jobId = active.id; throw e; }

  const job = await prisma.cfJob.create({
    data: {
      project_id: projectId, kind, status: 'QUEUED',
      total_items: targetItems.length, completed_items: 0, failed_items: 0, progress: 0,
      item_ids_json: JSON.stringify(targetItems.map((i) => i.id)),
      created_by_id: userId,
    },
  });
  await prisma.cfProjectItem.updateMany({ where: { id: { in: targetItems.map((i) => i.id) } }, data: { status: 'QUEUED' } });
  await prisma.cfProject.update({ where: { id: projectId }, data: { status: 'QUEUED' } });

  kickWorker();
  return serializeJob(await prisma.cfJob.findUnique({ where: { id: job.id } }));
}

export async function cancelJob(jobId) {
  const job = await prisma.cfJob.findUnique({ where: { id: jobId } });
  if (!job) { const e = new Error('المهمة غير موجودة.'); e.status = 404; throw e; }
  if (['COMPLETED', 'FAILED', 'CANCELLED', 'PARTIAL_COMPLETE'].includes(job.status)) return serializeJob(job);
  await prisma.cfJob.update({ where: { id: jobId }, data: { status: 'CANCELLED', finished_at: new Date(), error: 'أُلغيت بواسطة المستخدم.' } });
  await prisma.cfProjectItem.updateMany({ where: { project_id: job.project_id, status: { in: ['QUEUED', 'GENERATING', 'REGENERATING'] } }, data: { status: 'NEEDS_REVIEW' } });
  await syncProjectStatus(job.project_id);
  return serializeJob(await prisma.cfJob.findUnique({ where: { id: jobId } }));
}

export async function retryFailedItems({ projectId, userId = null }) {
  const items = await prisma.cfProjectItem.findMany({ where: { project_id: projectId, status: { in: ['FAILED', 'NEEDS_REVIEW'] } } });
  if (!items.length) { const e = new Error('لا توجد عناصر فاشلة لإعادة المحاولة.'); e.status = 400; throw e; }
  return createGenerationJob({ projectId, itemIds: items.map((i) => i.id), userId, kind: 'SINGLE_ITEM' });
}

export function kickWorker() {
  if (process.env.CF_DISABLE_AUTOKICK === '1') return; // offline tests drive processDueJobs() themselves
  setImmediate(() => { processDueJobs().catch((err) => logger.error('CF_JOB_WORKER_KICK_FAILED', { message: err.message })); });
}

/** Scheduler entry point. Picks up QUEUED jobs + jobs whose worker died mid-run. */
export async function processDueJobs() {
  const jobs = await prisma.cfJob.findMany({
    where: { status: { in: ['QUEUED', 'GENERATING', 'REVIEWING', 'REGENERATING'] } },
    orderBy: { created_at: 'asc' },
    take: 5,
  });
  for (const job of jobs) {
    if (running.has(job.id)) continue;
    const stale = !job.heartbeat_at || (Date.now() - new Date(job.heartbeat_at).getTime()) > HEARTBEAT_STALE_MS;
    if (job.status !== 'QUEUED' && !stale) continue; // another worker is on it
    running.add(job.id);
    try { await runJob(job.id); }
    catch (err) { logger.error('CF_JOB_FAILED', { jobId: job.id, message: err.message }); await failJob(job.id, err.message); }
    finally { running.delete(job.id); }
  }
}

// ---------------------------------------------------------------------------
// Worker — prepares the shared intelligence ONCE (DNA cached, plan validated,
// references cached), then runs the independent image items through a bounded
// concurrency pool (spec §14/§15). Text is rendered by our own engine, never
// the image model (spec §10).
// ---------------------------------------------------------------------------
async function runJob(jobId) {
  const job = await prisma.cfJob.findUnique({ where: { id: jobId }, include: { project: { include: { product: true } } } });
  if (!job || ['CANCELLED', 'COMPLETED', 'FAILED', 'PARTIAL_COMPLETE'].includes(job.status)) return;

  const project = job.project;
  const product = project.product;
  const th = await getEffectiveThresholds();
  const dna = await getDna(product.id);                                   // cached (run once at analyze time)
  const references = await loadReferenceImages(product.id, th.maxReferenceImages);
  const continuity = defaultContinuity(project);
  const provider = getImageProvider();
  const providerCaps = provider.getCapabilities();
  const textEngine = th.textOverlay && textCompositorAvailable();

  const itemIds = safeParse(job.item_ids_json, []);
  await prisma.cfJob.update({ where: { id: jobId }, data: { status: 'GENERATING', started_at: job.started_at || new Date(), heartbeat_at: new Date() } });
  await prisma.cfProject.update({ where: { id: project.id }, data: { status: 'GENERATING' } });

  // Pre-generation intelligence: tighten any plan concept that contradicts
  // the DNA BEFORE spending on generation (spec §23).
  {
    const rows = await prisma.cfProjectItem.findMany({ where: { id: { in: itemIds } } });
    const shaped = rows.map((r) => {
      const pm = safeParse(r.plan_meta_json, {}) || {};
      return {
        id: r.id, position: r.position, angle: r.angle, marketing_angle: pm.marketingAngle || r.angle,
        scene: r.scene, scene_plan: pm.scenePlan || r.scene,
        visual_concept: pm.visualConcept || null, text_layout: pm.textLayout || null,
      };
    });
    const { items: checked, notes } = validatePlanConcepts({ items: shaped, dna, product });
    if (notes.length) {
      for (const it of checked) {
        const patch = { scene: it.scene ?? undefined, angle: it.angle ?? undefined };
        if (it.text_layout || it.visual_concept) {
          const r = rows.find((x) => x.id === it.id);
          const pm = { ...(safeParse(r?.plan_meta_json, {}) || {}), textLayout: it.text_layout || undefined, visualConcept: it.visual_concept || undefined, marketingAngle: it.marketing_angle || undefined };
          patch.plan_meta_json = JSON.stringify(pm);
        }
        await prisma.cfProjectItem.update({ where: { id: it.id }, data: patch }).catch(() => {});
      }
      logger.info('CF_PLAN_SANITY', { jobId, adjusted: notes.length });
    }
  }

  const state = { completed: 0, failed: 0, providerDown: false };
  const queue = itemIds.slice();
  const concurrency = Math.max(1, Math.min(th.generationConcurrency, queue.length));

  async function poolWorker() {
    while (queue.length) {
      const fresh = await prisma.cfJob.findUnique({ where: { id: jobId }, select: { status: true } });
      if (!fresh || fresh.status === 'CANCELLED' || state.providerDown) return;
      const itemId = queue.shift();
      if (itemId == null) return;
      const item = await prisma.cfProjectItem.findUnique({ where: { id: itemId }, include: { copy: true } });
      if (!item) { state.failed++; continue; }
      try {
        const outcome = await generateItem({ item, project, product, dna, references, continuity, provider, providerCaps, th, textEngine });
        if (outcome.status === 'COMPLETED') state.completed++; else state.failed++;
      } catch (err) {
        state.failed++;
        await prisma.cfProjectItem.update({ where: { id: item.id }, data: { status: 'FAILED' } }).catch(() => {});
        logger.error('CF_ITEM_FAILED', { itemId: item.id, message: err.message });
        if (err instanceof CfProviderError && err.code === 'PROVIDER_NOT_CONFIGURED') {
          state.providerDown = true;
          await prisma.cfJob.update({ where: { id: jobId }, data: { error: err.message } }).catch(() => {});
        }
      }
      const progress = Math.round(((state.completed + state.failed) / itemIds.length) * 100);
      await prisma.cfJob.update({ where: { id: jobId }, data: { completed_items: state.completed, failed_items: state.failed, progress, heartbeat_at: new Date() } }).catch(() => {});
    }
  }

  await Promise.all(Array.from({ length: concurrency }, poolWorker));

  if (state.providerDown) {
    await prisma.cfProjectItem.updateMany({ where: { id: { in: itemIds }, status: { in: ['QUEUED', 'GENERATING', 'REGENERATING', 'PLANNED'] } }, data: { status: 'FAILED' } });
    const stillOpen = await prisma.cfProjectItem.count({ where: { id: { in: itemIds }, status: 'FAILED' } });
    state.failed = Math.max(state.failed, stillOpen);
  }

  const jobNow = await prisma.cfJob.findUnique({ where: { id: jobId }, select: { status: true } });
  if (jobNow?.status === 'CANCELLED') return;
  const finalStatus = state.completed === itemIds.length ? 'COMPLETED' : state.completed > 0 ? 'PARTIAL_COMPLETE' : 'FAILED';
  await prisma.cfJob.update({
    where: { id: jobId },
    data: { status: finalStatus, completed_items: state.completed, failed_items: state.failed, progress: 100, finished_at: new Date(), heartbeat_at: new Date() },
  });
  await syncProjectStatus(project.id);
}

/**
 * Generate ONE plan item to completion (or NEEDS_REVIEW after the mode's
 * retry cap). Targeted retries only; text is composited by our own engine.
 * @returns {Promise<{status:'COMPLETED'|'NEEDS_REVIEW'|'FAILED', assetId?:number}>}
 */
async function generateItem({ item, project, product, dna, references, continuity, provider, providerCaps, th, textEngine }) {
  await prisma.cfProjectItem.update({ where: { id: item.id }, data: { status: 'GENERATING' } });

  // 1) claim-guarded copy (only (re)generate if missing or not yet passed).
  //    generateCopyForItem returns { hook, supportingLine, featureLabels, cta,
  //    headline, subtitle } — normalise to the snake_case guardCopy/DB shape.
  let copy = item.copy;
  if (!copy || !['PASSED', 'REWRITTEN'].includes(copy.claim_status) || !copy.edited_by_user) {
    const raw = copy?.edited_by_user
      ? { hook: copy.hook, supportingLine: copy.supporting_line, headline: copy.headline, subtitle: copy.subtitle, cta: copy.cta, featureLabels: safeParse(copy.feature_callouts_json, []) }
      : await generateCopyForItem({ item: { ...item, features: safeParse(item.features_json, []), customerQuestion: item.customer_question, copyGoal: safeParse(item.creative_direction_json, {})?.copy_goal }, product, project, dna: dna?.data || dna });
    const draft = {
      hook: raw.hook, headline: raw.headline || raw.hook,
      supporting_line: raw.supportingLine ?? raw.supporting_line ?? null,
      subtitle: raw.subtitle ?? null, cta: raw.cta ?? null,
      feature_callouts: raw.featureLabels ?? raw.feature_callouts ?? [],
      alignment: raw.alignment || 'center', priority: raw.priority || 'HEADLINE_FIRST', safe_area: raw.safe_area || 'top',
    };
    const guarded = await guardCopy({ copy: { ...draft, feature_callouts: draft.feature_callouts || [] }, product });
    copy = await prisma.cfCreativeCopy.upsert({
      where: { project_item_id: item.id },
      create: {
        project_item_id: item.id,
        hook: guarded.copy.hook || null, supporting_line: guarded.copy.supporting_line || null,
        headline: guarded.copy.headline || null, subtitle: guarded.copy.subtitle || null, cta: guarded.copy.cta || null,
        feature_callouts_json: JSON.stringify(guarded.copy.feature_callouts || []),
        alignment: guarded.copy.alignment || 'center', priority: guarded.copy.priority || 'HEADLINE_FIRST', safe_area: guarded.copy.safe_area || 'top',
        claim_status: guarded.status, claim_issues_json: JSON.stringify(guarded.issues || []),
        edited_by_user: !!copy?.edited_by_user,
      },
      update: {
        hook: guarded.copy.hook || null, supporting_line: guarded.copy.supporting_line || null,
        headline: guarded.copy.headline || null, subtitle: guarded.copy.subtitle || null, cta: guarded.copy.cta || null,
        feature_callouts_json: JSON.stringify(guarded.copy.feature_callouts || []),
        claim_status: guarded.status, claim_issues_json: JSON.stringify(guarded.issues || []),
      },
    });
    if (guarded.status === 'BLOCKED') {
      await prisma.cfProjectItem.update({ where: { id: item.id }, data: { status: 'NEEDS_REVIEW' } });
      return { status: 'NEEDS_REVIEW' };
    }
  }
  const pm = safeParse(item.plan_meta_json, {}) || {};
  const itemFull = {
    ...item,
    features: safeParse(item.features_json, []),
    reference_priority: safeParse(item.reference_priority_json, []),
    creative_goal: pm.creativeGoal || item.purpose || null,
    marketing_angle: pm.marketingAngle || item.angle || null,
    customer_question: pm.customerQuestion || null,
    visual_concept: pm.visualConcept || null,
    camera_plan: pm.cameraPlan || item.camera_angle || null,
    scene_plan: pm.scenePlan || item.scene || null,
    product_position: pm.productPosition || item.product_placement || null,
    copy_goal: pm.copyGoal || null,
    text_layout: pm.textLayout || null,
  };
  const copyObj = {
    hook: copy.hook, headline: copy.headline || copy.hook, supportingLine: copy.supporting_line, subtitle: copy.subtitle,
    cta: copy.cta, featureLabels: safeParse(copy.feature_callouts_json, []), safe_area: copy.safe_area,
  };

  // 2) creative direction (once)
  const { direction } = await directItem({ item: itemFull, copy: copyObj, product, dna, project, continuity });
  await prisma.cfProjectItem.update({ where: { id: item.id }, data: { creative_direction_json: JSON.stringify(direction), continuity_json: JSON.stringify(continuity) } });

  const size = imageSizeFor(project.aspect_ratio);
  const isHero = item.position === 1 || /HERO/i.test(item.angle || '');
  const premium = project.generation_mode === 'PREMIUM' && th.allowPremiumMode;
  // best-of-N: PREMIUM + HERO only (spec §19 "not several candidates for every image")
  const wantCandidates = premium && isHero ? Math.max(2, th.premiumCandidates) : 1;
  const maxRetries = premium ? th.maxRetriesPremium : th.maxRetriesFast;
  const maxAttempts = maxRetries + 1;

  // reference-aware selection for THIS shot (spec §3)
  const chosenRefs = selectReferencesForItem(references, itemFull, 4);
  const providerRefs = providerCaps.referenceImages
    ? chosenRefs.map((r) => ({ b64: r.buffer.toString('base64'), mime: r.mime }))
    : [];
  const layout = itemFull.text_layout || direction.text_layout || 'HEADLINE_TOP';

  let corrective = null;
  let bestAsset = null;
  let bestReview = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const built = buildPrompt({
      item: { ...itemFull, text_layout: layout }, copy: copyObj, direction, product, dna, project,
      references: chosenRefs, lockMode: project.product_lock_mode, correctiveNote: corrective,
      promptVersion: attempt, textOverlay: textEngine,
    });
    const attemptRow = await prisma.cfGenerationAttempt.create({
      data: {
        project_item_id: item.id, attempt_number: attempt, provider: provider.name, model: providerCaps.model || null,
        prompt: built.prompt, prompt_version: attempt, corrective_prompt: corrective,
        provider_request_json: JSON.stringify({ size, n: wantCandidates, references: providerRefs.length, textLayout: layout, textEngine }),
        status: 'RUNNING', images_requested: wantCandidates, estimated_cost: estimateCostUsd(wantCandidates),
      },
    });

    let gen;
    try {
      gen = await provider.generate({ prompt: built.prompt, size, n: wantCandidates, referenceImages: providerRefs, quality: undefined });
    } catch (err) {
      await prisma.cfGenerationAttempt.update({ where: { id: attemptRow.id }, data: { status: 'FAILED', error: (err.message || String(err)).slice(0, 500) } });
      if (err instanceof CfProviderError && err.code === 'PROVIDER_NOT_CONFIGURED') throw err;
      corrective = buildCorrectiveNote({ failure_reasons: [err.message], failure_code: 'VISUAL_ARTIFACT' });
      continue;
    }

    await prisma.cfGenerationAttempt.update({
      where: { id: attemptRow.id },
      data: { status: 'SUCCEEDED', duration_ms: gen.durationMs || null, provider_metadata_json: JSON.stringify({ usage: gen.usage || null, raw: gen.raw || null }), actual_cost: estimateCostUsd(gen.images.length) },
    });

    let attemptBest = null;
    let attemptBestReview = null;
    for (let c = 0; c < gen.images.length; c++) {
      const rawBuf = Buffer.from(gen.images[c].b64, 'base64');
      // 3) our text engine renders the EXACT approved Arabic — the model drew none
      let finalBuf = rawBuf;
      let textApplied = false;
      let usedLayout = layout;
      if (textEngine) {
        const comp = await composeText({ baseImageBuffer: rawBuf, copy: copyObj, layout, projectType: project.project_type, textDensity: project.text_density });
        finalBuf = comp.buffer; textApplied = comp.applied; usedLayout = comp.layout;
      }
      const stored = await StorageService.putBuffer(finalBuf, { mime: 'image/png', prefix: `cf/p${project.id}/i${item.id}` });
      const asset = await prisma.cfAsset.create({
        data: {
          project_item_id: item.id, generation_attempt_id: attemptRow.id, product_id: product.id,
          storage_provider: stored.provider, storage_key: stored.key, mime: stored.mime, bytes: stored.bytes,
          kind: 'GENERATED', status: 'PENDING_REVIEW',
          is_candidate: gen.images.length > 1, candidate_rank: gen.images.length > 1 ? c + 1 : null,
          generation_number: attempt,
        },
      });
      const review = await reviewImage({ assetBuffer: finalBuf, assetMime: 'image/png', item: itemFull, copy: copyObj, product, dna, project, references: chosenRefs });
      review._textApplied = textApplied; review._textLayout = usedLayout;
      await saveReview(asset.id, review);
      const score = review.overall ?? -1;
      if (!attemptBestReview || score > (attemptBestReview.overall ?? -1)) { attemptBest = asset; attemptBestReview = review; }
      if (review.passed) { attemptBest = asset; attemptBestReview = review; break; }
    }

    if (!bestReview || (attemptBestReview?.overall ?? -1) > (bestReview.overall ?? -1)) { bestAsset = attemptBest; bestReview = attemptBestReview; }

    if (attemptBestReview?.passed) {
      await prisma.cfAsset.update({ where: { id: attemptBest.id }, data: { status: 'APPROVED', is_candidate: false, candidate_rank: null } });
      await prisma.cfAsset.updateMany({ where: { generation_attempt_id: attemptRow.id, id: { not: attemptBest.id } }, data: { status: 'REJECTED' } });
      await prisma.cfProjectItem.update({ where: { id: item.id }, data: { status: 'COMPLETED', approved_asset_id: attemptBest.id } });
      return { status: 'COMPLETED', assetId: attemptBest.id };
    }

    // targeted corrective for the next attempt (never a blind repeat)
    corrective = buildCorrectiveNote(attemptBestReview || { failure_reasons: ['جودة غير كافية'], failure_code: 'BAD_COMPOSITION' });
    if (attempt < maxAttempts) await prisma.cfProjectItem.update({ where: { id: item.id }, data: { status: 'REGENERATING' } });
  }

  // Retry cap reached — keep the best attempt visible, flag for a human.
  await prisma.cfProjectItem.update({ where: { id: item.id }, data: { status: 'NEEDS_REVIEW', approved_asset_id: null } });
  if (bestAsset) await prisma.cfAsset.update({ where: { id: bestAsset.id }, data: { status: 'PENDING_REVIEW' } });
  return { status: 'NEEDS_REVIEW', assetId: bestAsset?.id };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function loadReferenceImages(productId, limit) {
  const refs = await prisma.cfReferenceImage.findMany({ where: { product_id: productId, active: true }, orderBy: { sort_order: 'asc' }, take: limit });
  const out = [];
  for (const r of refs) {
    const got = await StorageService.get({ provider: r.storage_provider, key: r.storage_key });
    if (got?.buffer?.length) out.push({ buffer: got.buffer, mime: got.mime, label: r.angle_label || 'مرجع' });
  }
  return out;
}

async function syncProjectStatus(projectId) {
  const items = await prisma.cfProjectItem.findMany({ where: { project_id: projectId } });
  if (!items.length) return;
  const done = items.filter((i) => i.status === 'COMPLETED').length;
  const bad = items.filter((i) => ['FAILED', 'NEEDS_REVIEW'].includes(i.status)).length;
  let status = 'GENERATING';
  if (done === items.length) status = 'COMPLETED';
  else if (done + bad === items.length) status = done > 0 ? 'PARTIAL_COMPLETE' : 'FAILED';
  await prisma.cfProject.update({ where: { id: projectId }, data: { status } });
}

async function failJob(jobId, message) {
  try {
    const job = await prisma.cfJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    await prisma.cfJob.update({ where: { id: jobId }, data: { status: 'FAILED', error: (message || 'خطأ غير معروف').slice(0, 500), finished_at: new Date() } });
    const itemIds = safeParse(job.item_ids_json, []);
    await prisma.cfProjectItem.updateMany({
      where: { ...(itemIds.length ? { id: { in: itemIds } } : { project_id: job.project_id }), status: { in: ['QUEUED', 'GENERATING', 'REGENERATING', 'PLANNED'] } },
      data: { status: 'FAILED' },
    });
    await syncProjectStatus(job.project_id);
  } catch { /* best effort */ }
}

export function serializeJob(j) {
  if (!j) return null;
  return {
    id: j.id, uuid: j.uuid, projectId: j.project_id, kind: j.kind, status: j.status,
    totalItems: j.total_items, completedItems: j.completed_items, failedItems: j.failed_items,
    progress: j.progress, error: j.error,
    startedAt: j.started_at, finishedAt: j.finished_at, createdAt: j.created_at,
  };
}

function safeParse(s, dflt) { try { const v = JSON.parse(s); return v ?? dflt; } catch { return dflt; } }
