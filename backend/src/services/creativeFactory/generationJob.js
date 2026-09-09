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
import { buildPrompt } from './promptBuilder.js';
import { reviewImage, saveReview } from './imageQuality.js';
import { buildCorrectiveNote } from './regeneration.js';

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
// Worker
// ---------------------------------------------------------------------------
async function runJob(jobId) {
  const job = await prisma.cfJob.findUnique({ where: { id: jobId }, include: { project: { include: { product: true } } } });
  if (!job || ['CANCELLED', 'COMPLETED', 'FAILED', 'PARTIAL_COMPLETE'].includes(job.status)) return;

  const project = job.project;
  const product = project.product;
  const th = await getEffectiveThresholds();
  const dna = await getDna(product.id);
  const references = await loadReferenceImages(product.id, th.maxReferenceImages);
  const continuity = defaultContinuity(project);
  const provider = getImageProvider();
  const providerCaps = provider.getCapabilities();

  const itemIds = safeParse(job.item_ids_json, []);
  await prisma.cfJob.update({ where: { id: jobId }, data: { status: 'GENERATING', started_at: job.started_at || new Date(), heartbeat_at: new Date() } });
  await prisma.cfProject.update({ where: { id: project.id }, data: { status: 'GENERATING' } });

  let completed = 0;
  let failed = 0;
  for (let idx = 0; idx < itemIds.length; idx++) {
    const fresh = await prisma.cfJob.findUnique({ where: { id: jobId } });
    if (!fresh || fresh.status === 'CANCELLED') return;

    const item = await prisma.cfProjectItem.findUnique({ where: { id: itemIds[idx] }, include: { copy: true } });
    if (!item) { failed++; continue; }

    try {
      const outcome = await generateItem({ item, project, product, dna, references, continuity, provider, providerCaps, th });
      if (outcome.status === 'COMPLETED') completed++;
      else failed++;
    } catch (err) {
      failed++;
      await prisma.cfProjectItem.update({ where: { id: item.id }, data: { status: 'FAILED' } });
      logger.error('CF_ITEM_FAILED', { itemId: item.id, message: err.message });
      if (err instanceof CfProviderError && err.code === 'PROVIDER_NOT_CONFIGURED') {
        // No point hammering the rest — fail the remaining items with the same honest reason.
        await prisma.cfProjectItem.updateMany({ where: { id: { in: itemIds.slice(idx + 1) }, status: { in: ['QUEUED', 'GENERATING', 'REGENERATING', 'PLANNED'] } }, data: { status: 'FAILED' } });
        failed += itemIds.length - idx - 1;
        await prisma.cfJob.update({ where: { id: jobId }, data: { error: err.message } });
        break;
      }
    }

    const progress = Math.round(((completed + failed) / itemIds.length) * 100);
    await prisma.cfJob.update({ where: { id: jobId }, data: { completed_items: completed, failed_items: failed, progress, heartbeat_at: new Date() } });
  }

  const finalStatus = completed === itemIds.length ? 'COMPLETED' : completed > 0 ? 'PARTIAL_COMPLETE' : 'FAILED';
  await prisma.cfJob.update({
    where: { id: jobId },
    data: { status: finalStatus, completed_items: completed, failed_items: failed, progress: 100, finished_at: new Date(), heartbeat_at: new Date() },
  });
  await syncProjectStatus(project.id);
}

/**
 * Generate ONE plan item to completion (or NEEDS_REVIEW after maxRetries).
 * @returns {Promise<{status:'COMPLETED'|'NEEDS_REVIEW'|'FAILED', assetId?:number}>}
 */
async function generateItem({ item, project, product, dna, references, continuity, provider, providerCaps, th }) {
  await prisma.cfProjectItem.update({ where: { id: item.id }, data: { status: 'GENERATING' } });

  // 1) claim-guarded copy (only (re)generate if missing or not yet passed)
  let copy = item.copy;
  if (!copy || !['PASSED', 'REWRITTEN'].includes(copy.claim_status) || !copy.edited_by_user) {
    const draft = copy?.edited_by_user
      ? { hook: copy.hook, supporting_line: copy.supporting_line, headline: copy.headline, subtitle: copy.subtitle, cta: copy.cta, feature_callouts: safeParse(copy.feature_callouts_json, []) }
      : await generateCopyForItem({ item: { ...item, features: safeParse(item.features_json, []) }, product, project, dna });
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
  const copyObj = {
    hook: copy.hook, supporting_line: copy.supporting_line, headline: copy.headline, subtitle: copy.subtitle,
    cta: copy.cta, feature_callouts: safeParse(copy.feature_callouts_json, []), safe_area: copy.safe_area,
  };

  // 2) creative direction
  const { direction } = await directItem({ item: { ...item, reference_priority: safeParse(item.reference_priority_json, []) }, copy: copyObj, product, dna, project, continuity });
  await prisma.cfProjectItem.update({ where: { id: item.id }, data: { creative_direction_json: JSON.stringify(direction), continuity_json: JSON.stringify(continuity) } });

  const size = imageSizeFor(project.aspect_ratio);
  const isHero = item.position === 1 || /HERO/i.test(item.angle || '');
  const wantCandidates = project.generation_mode === 'PREMIUM' && th.allowPremiumMode && isHero ? Math.max(2, th.premiumCandidates) : 1;
  const providerRefs = providerCaps.referenceImages ? references.map((r) => ({ b64: r.buffer.toString('base64'), mime: r.mime })) : [];

  const maxAttempts = th.maxRetries + 1;
  let corrective = null;
  let bestAsset = null;
  let bestReview = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const built = buildPrompt({ item: { ...item, features: safeParse(item.features_json, []) }, copy: copyObj, direction, product, dna, project, lockMode: project.product_lock_mode, correctiveNote: corrective, promptVersion: attempt });
    const attemptRow = await prisma.cfGenerationAttempt.create({
      data: {
        project_item_id: item.id, attempt_number: attempt, provider: provider.name, model: providerCaps.model || null,
        prompt: built.prompt, prompt_version: attempt, corrective_prompt: corrective,
        provider_request_json: JSON.stringify({ size, n: wantCandidates, references: providerRefs.length }),
        status: 'RUNNING', images_requested: wantCandidates, estimated_cost: estimateCostUsd(wantCandidates),
      },
    });

    let gen;
    try {
      gen = await provider.generate({ prompt: built.prompt, size, n: wantCandidates, referenceImages: providerRefs, quality: undefined });
    } catch (err) {
      await prisma.cfGenerationAttempt.update({ where: { id: attemptRow.id }, data: { status: 'FAILED', error: (err.message || String(err)).slice(0, 500), duration_ms: null } });
      if (err instanceof CfProviderError && err.code === 'PROVIDER_NOT_CONFIGURED') throw err; // bubble to runJob's short-circuit
      corrective = buildCorrectiveNote({ failure_reasons: [err.message] });
      continue;
    }

    await prisma.cfGenerationAttempt.update({
      where: { id: attemptRow.id },
      data: { status: 'SUCCEEDED', duration_ms: gen.durationMs || null, provider_metadata_json: JSON.stringify({ usage: gen.usage || null, raw: gen.raw || null }), actual_cost: estimateCostUsd(gen.images.length) },
    });

    // Store + review each candidate
    let attemptBest = null;
    let attemptBestReview = null;
    for (let c = 0; c < gen.images.length; c++) {
      const img = gen.images[c];
      const buf = Buffer.from(img.b64, 'base64');
      const stored = await StorageService.putBuffer(buf, { mime: img.mime || 'image/png', prefix: `cf/p${project.id}/i${item.id}` });
      const asset = await prisma.cfAsset.create({
        data: {
          project_item_id: item.id, generation_attempt_id: attemptRow.id, product_id: product.id,
          storage_provider: stored.provider, storage_key: stored.key, mime: stored.mime, bytes: stored.bytes,
          kind: 'GENERATED', status: 'PENDING_REVIEW',
          is_candidate: gen.images.length > 1, candidate_rank: gen.images.length > 1 ? c + 1 : null,
          generation_number: attempt,
        },
      });
      const review = await reviewImage({ assetBuffer: buf, assetMime: stored.mime, item, copy: copyObj, product, dna, project, references });
      await saveReview(asset.id, review);
      const score = review.overall ?? -1;
      if (!attemptBestReview || score > (attemptBestReview.overall ?? -1)) { attemptBest = asset; attemptBestReview = review; }
      if (review.passed) { attemptBest = asset; attemptBestReview = review; break; }
    }

    if (!bestReview || (attemptBestReview?.overall ?? -1) > (bestReview.overall ?? -1)) { bestAsset = attemptBest; bestReview = attemptBestReview; }

    if (attemptBestReview?.passed) {
      await prisma.cfAsset.update({ where: { id: attemptBest.id }, data: { status: 'APPROVED', is_candidate: false, candidate_rank: null } });
      // demote sibling candidates from this attempt
      await prisma.cfAsset.updateMany({ where: { generation_attempt_id: attemptRow.id, id: { not: attemptBest.id } }, data: { status: 'REJECTED' } });
      await prisma.cfProjectItem.update({ where: { id: item.id }, data: { status: 'COMPLETED', approved_asset_id: attemptBest.id } });
      return { status: 'COMPLETED', assetId: attemptBest.id };
    }

    corrective = buildCorrectiveNote(attemptBestReview || { failure_reasons: ['جودة غير كافية'] });
    if (attempt < maxAttempts) await prisma.cfProjectItem.update({ where: { id: item.id }, data: { status: 'REGENERATING' } });
  }

  // Exhausted retries — keep the best attempt visible, flag for a human.
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
    await prisma.cfProjectItem.updateMany({ where: { project_id: job.project_id, status: { in: ['QUEUED', 'GENERATING', 'REGENERATING'] } }, data: { status: 'FAILED' } });
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
