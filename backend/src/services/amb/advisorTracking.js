// 🧠 Smart Advisor — recommendation TRACKING & VALIDATION (2026-10-02).
//
// One continuous loop per storeId + productId:
//   RECOMMENDED -> PREPARED -> APPROVED -> EXECUTED -> MEASURING -> EVALUATED
//   (or CANCELLED / EXPIRED). A recommendation is only ever credited with a
//   result AFTER a real, completed execution; everything else is reported
//   honestly as NOT_EXECUTED / MEASURING / INCONCLUSIVE.
//
// Hard rules enforced here:
//  * the baseline is frozen ONCE (atomic updateMany where baseline_frozen_at IS NULL) at PREPARED time, before
//    execution, and is never rewritten;
//  * the verdict is a PURE function (judgeOutcome) — deterministic, unit-tested, no AI;
//  * evaluation is idempotent: finalisation is a conditional update, so concurrent/repeated ticks cannot
//    create a second outcome, a second learning write or a second alert;
//  * confounded changes (price/campaign structure/stock/another executed recommendation) downgrade the causal claim;
//  * business guardrails: a primary-metric win that makes CPA / confirmation / profit worse is NOT validated;
//  * stale / mismatched / unmapped data after the action => WAITING_FOR_VALID_DATA, never a verdict;
//  * nothing here ever calls Meta or Easy Orders, and nothing here ever executes an action.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getAmbSettings } from './settings.js';
import { raiseAlert } from './alerts.js';
import { getProductPerformance } from './productPerformance.js';
import { computeProductDataQuality } from './dataQuality.js';
import { resolveProfileForProduct } from './productLearning.js';
import { recordLearning } from './productMarketingTests.js';
import { todayISO } from './metricsEngine.js';
import { composePlan, gatherAdvisorInputs, computeStateHash, diffPlans, PROBLEM_LABEL_AR } from './advisorPlan.js';

export const OPEN_STATUSES = ['RECOMMENDED', 'PREPARED', 'APPROVED', 'EXECUTED', 'MEASURING'];
export const MEASURED_STATUSES = ['EXECUTED', 'MEASURING'];
export const VERDICTS = ['VALIDATED', 'IMPROVED', 'PARTIAL', 'INCONCLUSIVE', 'FAILED', 'HARMFUL', 'MEASURING', 'NOT_EXECUTED'];
export const VERDICT_LABEL_AR = {
  VALIDATED: 'اتأكدت', IMPROVED: 'اتحسّن (مش مثبت سببيًا)', PARTIAL: 'نجاح جزئي', INCONCLUSIVE: 'غير حاسم', FAILED: 'فشلت', HARMFUL: 'ضارّة',
  MEASURING: 'بتتقاس', NOT_EXECUTED: 'ماتنفذتش',
};
const LEARNING_DECAY_DAYS = 45;
const MAJOR_CONFOUNDERS = new Set(['PRICE_CHANGED', 'CAMPAIGN_SET_CHANGED', 'STOCK_OUT', 'PEER_RECOMMENDATION_EXECUTED', 'STORE_CHANGED']);
const DIM_FOR_REC = { HOOK: 'HOOK', CREATIVE: 'CREATIVE', ANGLE: 'ANGLE', AUDIENCE: 'AUDIENCE', GEO: 'GEO', OFFER: 'OFFER', PRICE: 'PRICE', LANDING_PAGE: 'LANDING_PAGE' };

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const hash = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const rel = (post, base) => (num(post) === null || num(base) === null || Number(base) === 0 ? null : ((Number(post) - Number(base)) / Math.abs(Number(base))) * 100);
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

// ===========================================================================
// PURE: context hash / expiry
// ===========================================================================
/** The slice of product context that, when it changes, makes an un-executed recommendation stale. */
export function buildContext(inputs) {
  const p = inputs.productRow || {};
  return {
    storeId: inputs.storeId,
    price: num(p.selling_price),
    stock: inputs.stock?.status || null,
    campaignIds: [...(inputs.dq?.mapping?.includedCampaignIds || [])].sort(),
    dqBlocked: inputs.pkg?.dataQuality?.status === 'DECISION_BLOCKED_DATA_QUALITY',
    winnerCreative: (typeof inputs.pkg?.winners?.creative === 'string' ? inputs.pkg.winners.creative : inputs.pkg?.winners?.creative?.label) || null,
    economics: inputs.profit?.configState || null,
  };
}
export function diffContext(prev, next) {
  if (!prev || !next) return [];
  const out = [];
  if (prev.storeId !== next.storeId) out.push('STORE_CHANGED');
  if (prev.price !== next.price) out.push('PRICE_CHANGED');
  if (prev.stock !== next.stock) out.push('STOCK_CHANGED');
  if (JSON.stringify(prev.campaignIds) !== JSON.stringify(next.campaignIds)) out.push('CAMPAIGN_SET_CHANGED');
  if (prev.dqBlocked !== next.dqBlocked) out.push('DATA_QUALITY_CHANGED');
  if (prev.winnerCreative !== next.winnerCreative) out.push('WINNING_CREATIVE_CHANGED');
  if (prev.economics !== next.economics) out.push('ECONOMICS_CHANGED');
  return out;
}
const CONTEXT_LABEL_AR = {
  STORE_CHANGED: 'المتجر اتغيّر', PRICE_CHANGED: 'السعر اتغيّر', STOCK_CHANGED: 'حالة المخزون اتغيّرت', CAMPAIGN_SET_CHANGED: 'هيكل/مجموعة الحملات اتغيّر',
  DATA_QUALITY_CHANGED: 'جودة البيانات اتغيّرت', WINNING_CREATIVE_CHANGED: 'الكرياتيف الرابح اتغيّر', ECONOMICS_CHANGED: 'اقتصاديات المنتج اتغيّرت',
};

/** Pure: which changes since the frozen baseline contaminate causal attribution. */
export function detectConfounders({ recType, baselineCtx, currentCtx, peers = [] }) {
  const out = [];
  if (baselineCtx && currentCtx) {
    for (const k of diffContext(baselineCtx, currentCtx)) {
      if (k === 'PRICE_CHANGED' && recType === 'PRICE') continue; // the price IS the tested variable
      if (k === 'CAMPAIGN_SET_CHANGED' && (recType === 'SCALE' || recType === 'AUDIENCE' || recType === 'GEO' || recType === 'CREATIVE' || recType === 'HOOK')) { out.push({ kind: 'CAMPAIGN_SET_CHANGED', major: false, note: 'اتضافت/اتغيرت حملات (متوقع من التنفيذ) — الأثر السببي أضعف.' }); continue; }
      if (k === 'STOCK_CHANGED' && currentCtx.stock !== 'OUT_OF_STOCK') continue;
      const kind = k === 'STOCK_CHANGED' ? 'STOCK_OUT' : k;
      out.push({ kind, major: MAJOR_CONFOUNDERS.has(kind), note: CONTEXT_LABEL_AR[k] || k });
    }
  }
  for (const p of peers) out.push({ kind: 'PEER_RECOMMENDATION_EXECUTED', major: true, note: `توصية تانية اتنفذت في نفس الفترة: ${p.title}` });
  return out;
}

// ===========================================================================
// PURE: the verdict
// ===========================================================================
const SAMPLE_PURCHASE_METRICS = new Set(['cpa', 'cvr', 'purchases', 'confirmationRate', 'deliveryRate']);
function dirImproved(direction, delta, pct) { return delta !== null && (direction === 'UP' ? delta >= pct : delta <= -pct); }
function dirWorse(direction, delta, pct) { return delta !== null && (direction === 'UP' ? delta <= -pct : delta >= pct); }

/**
 * Deterministic verdict for ONE executed recommendation.
 * @param {{success:object, recType:string, baseline:{metrics:object}, post:object, control?:object|null, dataState:{valid:boolean,reason?:string},
 *          confounders?:Array, settings:object, elapsedDays:number}} p
 * @returns {{final:boolean, verdict:string, state:string, reason:string, evidenceKind:string, causalClaim:string, deltas:object, guardrails:Array, sample:object}}
 */
export function judgeOutcome(p) {
  const { success, recType, baseline, post, control = null, dataState, confounders = [], settings = {}, elapsedDays = 0 } = p;
  const improvePct = num(settings.ambAdvisorImprovePct) ?? 10;
  const worsePct = num(settings.ambAdvisorWorsePct) ?? 15;
  const harmfulPct = num(settings.ambAdvisorHarmfulCpaPct) ?? 25;
  const minSpend = num(success?.minSpend) ?? num(settings.ambMinSpendBeforeDecision) ?? 150;
  const minP = num(success?.minPurchases) ?? num(settings.ambMinPurchasesBeforeScaling) ?? 5;
  const windowDays = num(success?.evaluationWindowDays) ?? 7;
  const expired = elapsedDays >= windowDays * 2;
  const evidenceKind = control ? 'CONTROLLED_TEST' : 'BEFORE_AFTER';
  const sample = { spend: num(post?.spend) || 0, purchases: num(post?.purchases) || 0, needSpend: minSpend, needPurchases: minP };
  const base = (o) => ({ final: false, deltas: {}, guardrails: [], sample, evidenceKind, causalClaim: '', ...o });

  // 1) post-action data validity gate — never judge on stale/mismatched/unmapped data
  if (!dataState?.valid) {
    return base({ final: expired, verdict: expired ? 'INCONCLUSIVE' : 'MEASURING', state: expired ? 'INCONCLUSIVE' : 'WAITING_FOR_VALID_DATA',
      reason: `بيانات ما بعد التنفيذ غير صالحة للحكم (${dataState?.reason || 'UNKNOWN'}) — ${expired ? 'انتهت نافذة التقييم بدون بيانات صالحة.' : 'بنستنى بيانات سليمة.'}` });
  }
  const pm = success?.primaryMetric;
  const direction = success?.direction || 'DOWN';

  // 2) operational recommendations (data fix / stock) — judged on the state they target, not on ad metrics
  if (pm === 'dataQuality' || pm === 'stock') {
    const ok = pm === 'dataQuality' ? post?.dqOverall === 'RECONCILED' : ['SAFE', 'LOW'].includes(post?.stockStatus);
    return base({ final: ok || expired, verdict: ok ? 'VALIDATED' : expired ? 'INCONCLUSIVE' : 'MEASURING', state: ok ? 'VALIDATED' : 'MEASURING', evidenceKind: 'STATE_CHECK',
      reason: ok ? 'الحالة المستهدفة اتحققت فعلًا.' : 'الحالة المستهدفة لسه ما اتحققتش.', causalClaim: 'فحص حالة مباشر (مش مقارنة أداء).' });
  }

  // 3) sample gate
  const needsPurchases = SAMPLE_PURCHASE_METRICS.has(pm);
  const sampleOk = sample.spend >= minSpend && (!needsPurchases || sample.purchases >= minP);
  if (!sampleOk) {
    return base({ final: expired, verdict: expired ? 'INCONCLUSIVE' : 'MEASURING', state: expired ? 'INCONCLUSIVE' : 'MEASURING',
      reason: expired ? `انتهت نافذة التقييم والعينة لسه أقل من الحد الأدنى (${sample.purchases}/${minP} مشتريات، ${Math.round(sample.spend)}/${minSpend} ج).` : `العينة لسه صغيرة (${sample.purchases}/${minP} مشتريات، ${Math.round(sample.spend)}/${minSpend} ج صرف) — بنكمّل القياس.` });
  }
  const strong = sample.spend >= minSpend * 2 && (!needsPurchases || sample.purchases >= minP * 2);

  // 4) compare — CONTROL vs VARIANT when available, else frozen baseline vs post
  const ref = control || baseline?.metrics || {};
  const cmp = (k) => rel(post?.[k], ref?.[k]);
  const primaryDelta = cmp(pm);
  if (primaryDelta === null) {
    return base({ final: true, verdict: 'INCONCLUSIVE', state: 'INCONCLUSIVE', reason: `المقياس الأساسي (${pm}) غير متاح في خط الأساس/المقارنة — مينفعش نحكم.` });
  }
  const deltas = { [pm]: round1(primaryDelta) };
  const guardrails = [];
  for (const g of success?.guardrails || []) {
    const d = cmp(g);
    if (d === null) { guardrails.push({ metric: g, status: 'UNKNOWN', delta: null }); continue; }
    deltas[g] = round1(d);
    const gDir = g === 'cpa' ? 'DOWN' : 'UP';
    guardrails.push({ metric: g, status: dirWorse(gDir, d, worsePct) ? 'FAILED' : 'OK', delta: round1(d) });
  }
  // profit guardrail only with VERIFIED economics — otherwise explicitly UNKNOWN (never assumed fine)
  const failedGuard = guardrails.filter((g) => g.status === 'FAILED');
  const cpaDelta = deltas.cpa ?? (pm === 'cpa' ? round1(primaryDelta) : null);
  const primaryImproved = dirImproved(direction, primaryDelta, improvePct);
  const primaryWorse = dirWorse(direction, primaryDelta, improvePct);

  // 5) confounding
  const major = confounders.filter((c) => c.major);
  const minor = confounders.filter((c) => !c.major);
  const confounded = !control && major.length > 0;
  const causal = control ? 'تجربة بمجموعة ضابطة (CONTROL vs VARIANT) — أقوى دليل متاح.'
    : confounded ? 'مش ممكن ننسب النتيجة للتوصية: اتغيّر متغيّر كبير تاني في نفس الفترة.'
    : minor.length ? 'مقارنة قبل/بعد مع تغييرات ثانوية — ارتباط مش إثبات سببي.' : 'مقارنة قبل/بعد بدون متغيّرات كبيرة تانية — دليل مرجّح مش تجربة محكومة.';
  const mk = (verdict, reason, state = verdict) => ({ final: true, verdict, state, reason, evidenceKind, causalClaim: causal, deltas, guardrails, sample, confounders });

  if (confounded) return mk('INCONCLUSIVE', `الأداء ${primaryImproved ? 'اتحسّن' : primaryWorse ? 'ساء' : 'ما اتغيرش'} لكن فيه تغيير كبير تاني (${major.map((c) => c.note).join('، ')}) فمينفعش نحكم للتوصية أو عليها.`, 'CONFOUNDED');

  if (primaryWorse) {
    const harmful = cpaDelta !== null && cpaDelta >= harmfulPct;
    return mk(harmful ? 'HARMFUL' : 'FAILED', harmful ? `المقياس الأساسي ساء (${pm} ${round1(primaryDelta)}%) وكمان CPA زاد ${cpaDelta}% — التوصية ضرّت.` : `المقياس الأساسي ساء (${pm} ${round1(primaryDelta)}%).`);
  }
  if (primaryImproved) {
    if (failedGuard.length) {
      const cpaBad = failedGuard.find((g) => g.metric === 'cpa');
      const veryBad = cpaBad && cpaBad.delta >= harmfulPct;
      return mk(veryBad ? 'FAILED' : 'PARTIAL', `${pm} اتحسّن ${round1(primaryDelta)}% لكن ${failedGuard.map((g) => `${g.metric} ساء ${g.delta}%`).join('، ')} — مش اتأكدت لأن الربح/الجودة أهم من المقياس الأساسي.`);
    }
    return (control || strong) && !minor.length
      ? mk('VALIDATED', `${pm} اتحسّن ${round1(primaryDelta)}% بدون ما أي مقياس حماية يسوء، بعينة قوية${control ? ' ومقابل مجموعة ضابطة' : ''}.`)
      : mk('IMPROVED', `${pm} اتحسّن ${round1(primaryDelta)}% بدون ضرر على مقاييس الحماية — لكن ${minor.length ? 'فيه تغييرات ثانوية' : 'العينة مش قوية كفاية'} فمش هنسميها "اتأكدت".`);
  }
  // neutral
  if (failedGuard.length) return mk('FAILED', `مفيش تحسّن في ${pm} وفيه مقياس حماية ساء (${failedGuard.map((g) => g.metric).join('، ')}).`);
  return strong ? mk('FAILED', `بعد عينة قوية، ${pm} ما اتغيرش فعليًا (${round1(primaryDelta)}%) — التوصية ما حققتش هدفها.`) : mk('INCONCLUSIVE', `مفيش تغيير ملموس في ${pm} (${round1(primaryDelta)}%) والعينة مش قوية — غير حاسم.`);
}

// ===========================================================================
// Baseline / context capture (I/O — reads synced data only)
// ===========================================================================
function metricsFromPerf(perf) {
  const m = perf?.meta || {}, e = perf?.easyOrders || {};
  return { spend: num(m.spend), purchases: num(m.purchases), cpa: num(m.cpa), ctr: num(m.ctr), cvr: num(m.conversionRate), cpc: num(m.cpc), revenue: num(m.revenue),
    confirmationRate: num(e.confirmationRate), deliveryRate: num(e.deliveryRate), orders: num(e.sample) };
}
export async function captureContext(productId, storeId) {
  const row = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { selling_price: true, store_id: true } });
  const dq = await computeProductDataQuality({ productId, storeId, windowName: 'last7' }).catch(() => null);
  const { stockGuardForProduct } = await import('./stockGuard.js');
  const stock = await stockGuardForProduct({ productId, storeId }).catch(() => null);
  return { storeId, price: num(row?.selling_price), stock: stock?.status || null, campaignIds: [...(dq?.mapping?.includedCampaignIds || [])].sort(), dqBlocked: dq?.overallStatus === 'MAPPING_ERROR', winnerCreative: null, economics: null, dqOverall: dq?.overallStatus || null };
}
export async function captureBaselineDefault({ productId, storeId, windowName = 'last7' }) {
  const perf = await getProductPerformance({ productId, windowName });
  const ctx = await captureContext(productId, storeId);
  return { capturedAt: new Date().toISOString(), window: { name: windowName, from: perf.window.from, to: perf.window.to }, metrics: metricsFromPerf(perf), metaDataState: perf.meta?.dataState || null,
    campaignIds: ctx.campaignIds, dqOverall: ctx.dqOverall, context: ctx, resolvedVia: perf.resolvedVia };
}

/** Post-execution metrics for one recommendation (default provider). Tests inject their own provider. */
export async function defaultMetricsProvider({ rec, from, to, settings }) {
  const pid = rec.product_id;
  const perf = await getProductPerformance({ productId: pid, from, to });
  const ctx = await captureContext(pid, rec.store_id);
  const { getSyncStatus } = await import('./snapshotSync.js');
  const sync = await getSyncStatus().catch(() => null);
  const intervalMs = (num(sync?.intervalMinutes) || 15) * 60_000;
  const last = sync?.lastSuccessAt ? new Date(sync.lastSuccessAt).getTime() : null;
  const fresh = last !== null && Date.now() - last <= intervalMs * 4;
  const dq = await computeProductDataQuality({ productId: pid, storeId: rec.store_id, windowName: 'last7' }).catch(() => null);
  const blocked = !dq || ['MAPPING_ERROR', 'PURCHASE_RECONCILIATION_ERROR'].includes(dq.overallStatus);
  let reason = null;
  if (perf.meta?.dataState !== 'AVAILABLE') reason = `Meta ${perf.meta?.dataState || 'UNKNOWN'}`;
  else if (!fresh) reason = 'STALE (آخر مزامنة Meta قديمة)';
  else if (blocked) reason = dq?.overallStatus || 'UNKNOWN';
  return { post: { ...metricsFromPerf(perf), dqOverall: dq?.overallStatus || null, stockStatus: ctx.stock }, control: null, dataState: { valid: !reason, reason }, context: ctx };
}

// ===========================================================================
// Recommendation sync (create / expire) — runs inside the plan build
// ===========================================================================
const inflight = new Map();
export function withProductLock(key, fn) {
  const run = (inflight.get(key) || Promise.resolve()).then(fn);
  inflight.set(key, run.catch(() => {})); // serialise per product — a failed run never blocks the next
  return run;
}

export async function expireRec(rec, reason) {
  const r = await prisma.ambAdvisorRecommendation.updateMany({ where: { id: rec.id, status: 'RECOMMENDED' }, data: { status: 'EXPIRED', verdict: 'NOT_EXECUTED', expired_reason: reason } });
  return r.count === 1;
}

export async function syncRecommendations({ plan, inputs }) {
  const pid = inputs.productId, storeId = inputs.storeId;
  const ctx = buildContext(inputs); const ctxHash = hash(ctx);
  const open = await prisma.ambAdvisorRecommendation.findMany({ where: { product_id: pid, store_id: storeId, status: { in: OPEN_STATUSES } } });
  const currentKeys = new Set(plan.trackableActions.map((a) => a.actionKey));
  const expired = [];
  for (const rec of open) {
    if (rec.status !== 'RECOMMENDED') continue; // anything PREPARED+ keeps its frozen baseline
    if (!currentKeys.has(rec.action_key)) { if (await expireRec(rec, 'NO_LONGER_RELEVANT: الخطة الحالية ما بقتش بتوصي بنفس الإجراء.')) expired.push(rec.recommendation_id); }
    else if (rec.context_hash !== ctxHash) {
      const changed = diffContext(j(rec.context_json, {})?.ctx, ctx).map((k) => CONTEXT_LABEL_AR[k] || k);
      if (await expireRec(rec, `CONTEXT_CHANGED: ${changed.join('، ') || 'سياق المنتج اتغيّر'}`)) expired.push(rec.recommendation_id);
    }
  }
  const fresh = await prisma.ambAdvisorRecommendation.findMany({ where: { product_id: pid, store_id: storeId, status: { in: OPEN_STATUSES } } });
  const openKeys = new Set(fresh.map((r) => r.action_key));
  const withheld = [];
  const created = [];
  for (const a of plan.trackableActions) {
    if (openKeys.has(a.actionKey)) continue;
    // failed/harmful before + same context => not re-recommended without a new reason
    const last = await prisma.ambAdvisorRecommendation.findFirst({ where: { product_id: pid, store_id: storeId, action_key: a.actionKey, verdict: { in: ['FAILED', 'HARMFUL'] } }, orderBy: { created_at: 'desc' } });
    if (last && last.context_hash === ctxHash) { withheld.push({ actionKey: a.actionKey, title: a.title, reason: 'اتجرّب قبل كده وفشل ولسه مفيش سبب جديد (سياق المنتج ما اتغيّرش).', priorRecommendationId: last.recommendation_id }); continue; }
    const row = await prisma.ambAdvisorRecommendation.create({ data: {
      recommendation_id: `adv_${crypto.randomUUID()}`, product_id: pid, store_id: storeId, plan_version: 0, action_key: a.actionKey, rec_type: a.recType,
      problem_type: plan.status.primaryProblem, title: a.title, hypothesis: a.hypothesis || a.what, target_variable: a.targetVariable,
      evidence_json: JSON.stringify({ evidence: a.evidence, why: a.why, how: a.how, staysFixed: a.staysFixed, sources: a.sources }),
      data_quality_json: JSON.stringify({ gate: plan.status.dataQuality.gate, overall: plan.status.dataQuality.overall, blocked: plan.status.dataQuality.blocked }),
      confidence: a.confidence, success_json: JSON.stringify(a.success),
      context_json: JSON.stringify({ ctx, target: a.actionKey.split('|')[2] || null, priority: a.priority, owner: a.owner, tool: a.tool || null }), context_hash: ctxHash,
    } });
    created.push(row.recommendation_id); fresh.push(row);
  }
  const byKey = new Map(fresh.map((r) => [r.action_key, r]));
  for (const list of [plan.actions.now, plan.actions.next, plan.actions.later]) for (const a of list) { const r = byKey.get(a.actionKey); if (r) { a.recommendationId = r.recommendation_id; a.recStatus = r.status; a.recManual = !!j(r.links_json, {})?.manual; } }
  plan.trackableActions.forEach((a) => { const r = byKey.get(a.actionKey); if (r) { a.recommendationId = r.recommendation_id; a.recStatus = r.status; } });
  return { created, expired, withheld, open: fresh };
}

// ===========================================================================
// Lifecycle linking (PREPARE -> PREVIEW -> APPROVAL -> EXECUTE stays in assistantTasks)
// ===========================================================================
/** Validates a recommendationId from assistant page-context — returns it only if it is a live recommendation of THIS product+store. */
export async function resolveAdvisorLink({ context, productId }) {
  try {
    const rid = context?.recommendationId;
    if (!rid || !context?.storeId) return null;
    const rec = await prisma.ambAdvisorRecommendation.findUnique({ where: { recommendation_id: String(rid) } });
    if (!rec || rec.store_id !== context.storeId || (productId && rec.product_id !== Number(productId))) return null;
    if (!['RECOMMENDED', 'PREPARED'].includes(rec.status)) return null;
    return rec.recommendation_id;
  } catch { return null; }
}

export async function freezeBaselineOnce(rec, baseline) {
  const r = await prisma.ambAdvisorRecommendation.updateMany({ where: { id: rec.id, baseline_frozen_at: null }, data: { baseline_json: JSON.stringify(baseline), baseline_frozen_at: new Date() } });
  return r.count === 1;
}

export async function linkTaskToRecommendation({ recommendationId, task, captureBaseline = captureBaselineDefault }) {
  const rec = await prisma.ambAdvisorRecommendation.findUnique({ where: { recommendation_id: recommendationId } });
  if (!rec) return { ok: false, reason: 'RECOMMENDATION_NOT_FOUND' };
  if (!['RECOMMENDED', 'PREPARED'].includes(rec.status)) return { ok: false, reason: `REC_STATUS_${rec.status}` };
  let baseline;
  try { baseline = await captureBaseline({ productId: rec.product_id, storeId: rec.store_id }); }
  catch (err) { baseline = { error: err.message, capturedAt: new Date().toISOString() }; logger.warn('[advisorTracking] baseline capture failed', { recommendationId, message: err.message }); }
  await freezeBaselineOnce(rec, baseline);
  const links = { ...(j(rec.links_json, {}) || {}), taskUuid: task.task_uuid, toolName: task.tool_name, linkedAt: new Date().toISOString() };
  await prisma.ambAdvisorRecommendation.update({ where: { id: rec.id }, data: { status: 'PREPARED', links_json: JSON.stringify(links) } });
  try {
    const fresh = await prisma.assistantTask.findUnique({ where: { task_uuid: task.task_uuid }, select: { input_json: true } });
    const input = { ...(j(fresh?.input_json, {}) || {}), advisorRecommendationId: recommendationId };
    await prisma.assistantTask.update({ where: { task_uuid: task.task_uuid }, data: { input_json: JSON.stringify(input) } });
  } catch { /* traceability only */ }
  return { ok: true, recommendationId, status: 'PREPARED' };
}

export async function cancelRecommendation({ recommendationId, storeId, reason = 'USER_DISMISSED' }) {
  const rec = await prisma.ambAdvisorRecommendation.findUnique({ where: { recommendation_id: recommendationId } });
  if (!rec || rec.store_id !== storeId) return { ok: false, code: 'NOT_FOUND' };
  if (!['RECOMMENDED', 'PREPARED', 'APPROVED'].includes(rec.status)) return { ok: false, code: 'NOT_CANCELLABLE', status: rec.status };
  await prisma.ambAdvisorRecommendation.update({ where: { id: rec.id }, data: { status: 'CANCELLED', verdict: 'NOT_EXECUTED', expired_reason: reason } });
  return { ok: true };
}

/** Human-owned recommendation (offer/landing/COD/stock/profit — no assistant tool): the owner says "I'm starting" -> baseline is frozen BEFORE the change. */
export async function startManualExecution({ recommendationId, storeId, captureBaseline = captureBaselineDefault }) {
  const rec = await prisma.ambAdvisorRecommendation.findUnique({ where: { recommendation_id: recommendationId } });
  if (!rec || rec.store_id !== storeId) return { ok: false, code: 'NOT_FOUND' };
  if (rec.status !== 'RECOMMENDED') return { ok: false, code: 'NOT_STARTABLE', status: rec.status };
  let baseline;
  try { baseline = await captureBaseline({ productId: rec.product_id, storeId: rec.store_id }); } catch (err) { baseline = { error: err.message, capturedAt: new Date().toISOString() }; }
  await freezeBaselineOnce(rec, baseline);
  const links = { ...(j(rec.links_json, {}) || {}), manual: true, startedAt: new Date().toISOString() };
  const r = await prisma.ambAdvisorRecommendation.updateMany({ where: { id: rec.id, status: 'RECOMMENDED' }, data: { status: 'PREPARED', links_json: JSON.stringify(links) } });
  return r.count === 1 ? { ok: true, status: 'PREPARED' } : { ok: false, code: 'RACE' };
}
/** ...and later "I finished" -> EXECUTED (only from a started manual rec with a frozen baseline; never from an unstarted one). */
export async function confirmManualExecution({ recommendationId, storeId, note = null }) {
  const rec = await prisma.ambAdvisorRecommendation.findUnique({ where: { recommendation_id: recommendationId } });
  if (!rec || rec.store_id !== storeId) return { ok: false, code: 'NOT_FOUND' };
  const links = j(rec.links_json, {}) || {};
  if (!links.manual || rec.status !== 'PREPARED' || !rec.baseline_frozen_at) return { ok: false, code: 'NOT_STARTED', status: rec.status };
  const r = await prisma.ambAdvisorRecommendation.updateMany({ where: { id: rec.id, status: 'PREPARED' }, data: { status: 'EXECUTED', executed_at: new Date(), links_json: JSON.stringify({ ...links, confirmedAt: new Date().toISOString(), note: note ? String(note).slice(0, 500) : null }) } });
  return r.count === 1 ? { ok: true, status: 'EXECUTED' } : { ok: false, code: 'RACE' };
}

const TASK_TERMINAL_FAIL = new Set(['FAILED', 'CANCELLED', 'BLOCKED']);
/** Moves one recommendation along the lifecycle based on its linked task. Never marks EXECUTED unless the task really completed. */
export async function syncRecLifecycle(rec) {
  const links = j(rec.links_json, {}) || {};
  if (!links.taskUuid || !['PREPARED', 'APPROVED'].includes(rec.status)) return rec;
  const task = await prisma.assistantTask.findUnique({ where: { task_uuid: links.taskUuid } });
  if (!task) return rec;
  if (['COMPLETED', 'PARTIALLY_COMPLETED'].includes(task.status)) {
    const executedAt = task.updated_at || new Date();
    const rollback = ['SCALE', 'BUDGET'].includes(rec.rec_type) || /SCALE|BUMP/.test(task.kind) ? { capturedAt: new Date().toISOString(), taskUuid: task.task_uuid, kind: task.kind, prepared: String(task.prepared_payload_json || '').slice(0, 3000), note: 'حالة ما قبل التنفيذ محفوظة. الرجوع بيتم بموافقتك عبر المساعد — مفيش Rollback تلقائي.' } : null;
    const r = await prisma.ambAdvisorRecommendation.updateMany({ where: { id: rec.id, status: { in: ['PREPARED', 'APPROVED'] } }, data: { status: 'EXECUTED', executed_at: executedAt, ...(rollback ? { rollback_json: JSON.stringify(rollback) } : {}), links_json: JSON.stringify({ ...links, executedTaskStatus: task.status }) } });
    return r.count ? prisma.ambAdvisorRecommendation.findUnique({ where: { id: rec.id } }) : rec;
  }
  if (TASK_TERMINAL_FAIL.has(task.status)) {
    await prisma.ambAdvisorRecommendation.updateMany({ where: { id: rec.id, status: { in: ['PREPARED', 'APPROVED'] } }, data: { status: 'CANCELLED', verdict: 'NOT_EXECUTED', expired_reason: `TASK_${task.status}${task.error ? ': ' + String(task.error).slice(0, 200) : ''}` } });
    return prisma.ambAdvisorRecommendation.findUnique({ where: { id: rec.id } });
  }
  if (task.approved_at && rec.status === 'PREPARED') {
    await prisma.ambAdvisorRecommendation.updateMany({ where: { id: rec.id, status: 'PREPARED' }, data: { status: 'APPROVED' } });
    return prisma.ambAdvisorRecommendation.findUnique({ where: { id: rec.id } });
  }
  return rec;
}

// ===========================================================================
// Evaluation (idempotent)
// ===========================================================================
export async function evaluateRecommendation(recommendationId, { provider = defaultMetricsProvider, now = new Date() } = {}) {
  let rec = await prisma.ambAdvisorRecommendation.findUnique({ where: { recommendation_id: recommendationId } });
  if (!rec) return { ok: false, code: 'NOT_FOUND' };
  rec = await syncRecLifecycle(rec);
  if (rec.status === 'EVALUATED' || rec.evaluation_key) return { ok: true, skipped: 'ALREADY_FINAL', verdict: rec.verdict };
  if (!MEASURED_STATUSES.includes(rec.status) || !rec.executed_at) return { ok: true, skipped: 'NOT_EXECUTED', status: rec.status };
  const settings = await getAmbSettings();
  const success = j(rec.success_json, {}) || {};
  const baseline = j(rec.baseline_json, null);
  const elapsedDays = (now.getTime() - new Date(rec.executed_at).getTime()) / 86_400_000;
  const from = ymd(rec.executed_at), to = todayISO();
  const finalize = async (judged, post) => {
    const key = `${rec.recommendation_id}:final`;
    const learning = (judged.verdict === 'VALIDATED' || judged.verdict === 'FAILED' || judged.verdict === 'HARMFUL') && DIM_FOR_REC[rec.rec_type] ? { eligible: true } : null;
    const evaluation = { ...judged, window: { from, to }, post, baselineWindow: baseline?.window || null, evaluatedAt: now.toISOString(), elapsedDays: round1(elapsedDays) };
    const r = await prisma.ambAdvisorRecommendation.updateMany({ where: { id: rec.id, evaluation_key: null, status: { in: MEASURED_STATUSES } }, data: { status: 'EVALUATED', verdict: judged.verdict, evaluation_json: JSON.stringify(evaluation), evaluation_key: key, evaluated_at: now } });
    if (r.count !== 1) return { ok: true, skipped: 'RACE_ALREADY_FINAL' };
    const out = { ok: true, finalized: true, verdict: judged.verdict, state: judged.state, reason: judged.reason, learningWritten: false, alerted: false };
    if (learning) out.learningWritten = await writeLearning(rec, judged, { from, to }).catch((e) => { logger.warn('[advisorTracking] learning write failed', { message: e.message }); return false; });
    if (['VALIDATED', 'FAILED', 'HARMFUL', 'PARTIAL', 'IMPROVED'].includes(judged.verdict)) {
      await raiseAlert({ severity: judged.verdict === 'HARMFUL' ? 'CRITICAL' : judged.verdict === 'VALIDATED' ? 'OPPORTUNITY' : 'INFO', category: 'ADVISOR',
        title: `نتيجة توصية المستشار: ${VERDICT_LABEL_AR[judged.verdict]}`, message: `${rec.title} — ${judged.reason}`, entityId: String(rec.product_id), dedupeKey: `advisor:${rec.recommendation_id}:final` }).then(() => { out.alerted = true; });
    }
    return out;
  };

  if (!baseline || baseline.error || !baseline.metrics) {
    return finalize({ final: true, verdict: 'INCONCLUSIVE', state: 'INCONCLUSIVE', reason: 'مفيش خط أساس مجمّد صالح قبل التنفيذ — مينفعش نقارن.', evidenceKind: 'NONE', causalClaim: '', deltas: {}, guardrails: [], sample: {} }, null);
  }
  const prov = await provider({ rec, from, to, settings, baseline });
  const peers = await prisma.ambAdvisorRecommendation.findMany({ where: { product_id: rec.product_id, store_id: rec.store_id, id: { not: rec.id }, executed_at: { not: null, gte: new Date(new Date(rec.executed_at).getTime() - 3 * 86_400_000) } }, select: { title: true, executed_at: true } });
  const confounders = detectConfounders({ recType: rec.rec_type, baselineCtx: baseline.context, currentCtx: prov.context, peers });
  const judged = judgeOutcome({ success, recType: rec.rec_type, baseline, post: prov.post, control: prov.control || null, dataState: prov.dataState, confounders, settings, elapsedDays });
  if (!judged.final) {
    const progress = { lastCheckAt: now.toISOString(), state: judged.state, reason: judged.reason, sample: judged.sample, post: prov.post, window: { from, to } };
    await prisma.ambAdvisorRecommendation.updateMany({ where: { id: rec.id, evaluation_key: null }, data: { status: 'MEASURING', verdict: 'MEASURING', evaluation_json: JSON.stringify({ progress }) } });
    return { ok: true, finalized: false, verdict: 'MEASURING', state: judged.state, reason: judged.reason, sample: judged.sample };
  }
  return finalize(judged, prov.post);
}

async function writeLearning(rec, judged, evidenceWindow) {
  const dimension = DIM_FOR_REC[rec.rec_type];
  const ctx = j(rec.context_json, {}) || {};
  const key = ctx.target;
  if (!dimension || !key) return false;
  const profile = await resolveProfileForProduct(rec.product_id);
  if (!profile) return false; // never creates a profile as a side-effect
  const verdict = judged.verdict === 'VALIDATED' ? 'WORKS' : 'DOES_NOT_WORK';
  await recordLearning({ profileId: profile.id, dimension, key: String(key), verdict, sampleSize: judged.sample?.purchases || 0, evidence: { source: 'SMART_ADVISOR', recommendationId: rec.recommendation_id, evidenceKind: judged.evidenceKind, evidenceWindow, deltas: judged.deltas, lastValidatedAt: new Date().toISOString() } });
  await prisma.ambAdvisorRecommendation.update({ where: { id: rec.id }, data: { learning_json: JSON.stringify({ dimension, key, verdict, lastValidatedAt: new Date().toISOString(), evidenceWindow, sampleStrength: (judged.sample?.purchases || 0) >= 10 ? 'STRONG' : 'MODERATE', state: verdict === 'WORKS' ? 'PROVEN' : 'REJECTED' }) } });
  return true;
}

/** Learning decay: a PROVEN advisor learning becomes NEEDS_REVALIDATION after LEARNING_DECAY_DAYS. */
export function learningState(learning, now = new Date()) {
  if (!learning) return null;
  const age = (now.getTime() - new Date(learning.lastValidatedAt).getTime()) / 86_400_000;
  return { ...learning, ageDays: Math.round(age), state: learning.state === 'PROVEN' && age > LEARNING_DECAY_DAYS ? 'NEEDS_REVALIDATION' : learning.state };
}

// ===========================================================================
// Plan versions
// ===========================================================================
export async function persistPlanVersion({ plan, trigger = 'VIEW' }) {
  const { productId, storeId } = plan;
  const last = await prisma.ambAdvisorPlanVersion.findFirst({ where: { product_id: productId, store_id: storeId }, orderBy: { version: 'desc' } });
  if (last && last.state_hash === plan.stateHash) return { version: last.version, created: false };
  const reasons = diffPlans(last ? j(last.plan_json) : null, plan);
  try {
    const row = await prisma.ambAdvisorPlanVersion.create({ data: { product_id: productId, store_id: storeId, version: (last?.version || 0) + 1, state_hash: plan.stateHash, trigger, plan_json: JSON.stringify(slimPlan(plan)), change_reasons_json: JSON.stringify(reasons) } });
    return { version: row.version, created: true, reasons };
  } catch (err) {
    if (err.code === 'P2002') { const again = await prisma.ambAdvisorPlanVersion.findFirst({ where: { product_id: productId, store_id: storeId }, orderBy: { version: 'desc' } }); return { version: again.version, created: false }; }
    throw err;
  }
}
function slimPlan(plan) { const { trackableActions, ...rest } = plan; return rest; }

// ===========================================================================
// Annotations: memory / contradictions with prior learning
// ===========================================================================
export function annotatePlan(plan, { priorRecs = [], learning = { entries: [] }, withheld = [] }) {
  const entries = learning.entries || [];
  const contradictions = [];
  for (const a of [...plan.actions.now, ...plan.actions.next]) {
    const target = a.actionKey.split('|')[2];
    const hit = entries.find((e) => String(e.key) === String(target) && (e.verdict === 'DOES_NOT_WORK' || e.state === 'REJECTED'));
    if (hit) contradictions.push({ actionKey: a.actionKey, title: a.title, label: '⚠️ تعارض مع تعلم سابق', note: `${hit.dimension}: "${hit.key}" اتجرب قبل كده وما نجحش (${hit.verdict || hit.state}). لو هتكرره لازم يبقى فيه سبب جديد.` });
  }
  const memory = priorRecs.filter((r) => r.verdict && r.verdict !== 'NOT_EXECUTED' && r.verdict !== 'MEASURING')
    .slice(0, 10).map((r) => ({ recommendationId: r.recommendation_id, title: r.title, recType: r.rec_type, verdict: r.verdict, verdictLabel: VERDICT_LABEL_AR[r.verdict], evaluatedAt: r.evaluated_at, learning: learningState(j(r.learning_json)) }));
  plan.contradictions = contradictions;
  plan.memory = { triedBefore: memory, withheld };
  return plan;
}

// ===========================================================================
// Orchestrator — ONE entry point for the route, the AI tool and the evaluator
// ===========================================================================
const planCache = new Map(); // key -> {at, promise}
const PLAN_TTL_MS = 120_000;

export async function runAdvisorForProduct({ productId, storeId, windowName = 'last7', trigger = 'VIEW', fresh = false }) {
  const key = `${storeId}:${productId}:${windowName}`;
  const hit = planCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.promise;
  const promise = withProductLock(key, async () => {
    const inputs = await gatherAdvisorInputs({ productId, storeId, windowName });
    if (!inputs.ok) return inputs;
    // lifecycle first, so the plan sees up-to-date recommendation states
    for (const r of inputs.priorRecs.filter((x) => ['PREPARED', 'APPROVED'].includes(x.status))) await syncRecLifecycle(r).catch(() => null);
    inputs.priorRecs = await prisma.ambAdvisorRecommendation.findMany({ where: { product_id: Number(productId), store_id: storeId }, orderBy: { created_at: 'desc' }, take: 60 });
    const plan = composePlan(inputs);
    const sync = await syncRecommendations({ plan, inputs });
    const recs = await prisma.ambAdvisorRecommendation.findMany({ where: { product_id: Number(productId), store_id: storeId }, orderBy: { created_at: 'desc' }, take: 60 });
    annotatePlan(plan, { priorRecs: recs, learning: inputs.learning, withheld: sync.withheld });
    plan.stateHash = computeStateHash(plan, recs, inputs.ladder, inputs.fatigueStates);
    const version = await persistPlanVersion({ plan, trigger });
    plan.planVersion = version.version; plan.planVersionCreated = version.created; plan.planChangeReasons = version.reasons || null;
    plan.sync = { created: sync.created.length, expired: sync.expired.length };
    return { ok: true, plan };
  });
  planCache.set(key, { at: Date.now(), promise });
  promise.catch(() => planCache.delete(key));
  return promise;
}
export function invalidatePlanCache(productId, storeId) { for (const k of planCache.keys()) if (k.startsWith(`${storeId}:${productId}:`)) planCache.delete(k); }

// ===========================================================================
// Reads: history / problem->fix->result / reliability
// ===========================================================================
function shapeRec(r) {
  const ev = j(r.evaluation_json, null) || {};
  const baseline = j(r.baseline_json, null);
  const ctx = j(r.context_json, {}) || {};
  const evid = j(r.evidence_json, {}) || {};
  return {
    recommendationId: r.recommendation_id, productId: r.product_id, storeId: r.store_id, recType: r.rec_type, problemType: r.problem_type, title: r.title, hypothesis: r.hypothesis,
    status: r.status, verdict: r.verdict, verdictLabel: VERDICT_LABEL_AR[r.verdict] || null, confidence: r.confidence, priority: ctx.priority, owner: ctx.owner,
    createdAt: r.created_at, executedAt: r.executed_at, evaluatedAt: r.evaluated_at, expiredReason: r.expired_reason,
    why: evid.why, how: evid.how, staysFixed: evid.staysFixed, success: j(r.success_json),
    before: baseline?.metrics ? { window: baseline.window, ...baseline.metrics, frozenAt: r.baseline_frozen_at } : null,
    after: ev.post ? { window: ev.window, ...ev.post } : (ev.progress?.post ? { window: ev.progress.window, ...ev.progress.post, interim: true } : null),
    outcome: ev.verdict ? { verdict: ev.verdict, state: ev.state, reason: ev.reason, evidenceKind: ev.evidenceKind, causalClaim: ev.causalClaim, deltas: ev.deltas, guardrails: ev.guardrails, confounders: ev.confounders, sample: ev.sample } : null,
    progress: ev.progress || null, learning: learningState(j(r.learning_json)), rollback: j(r.rollback_json), links: j(r.links_json),
  };
}
export async function getAdvisorHistory({ productId, storeId }) {
  const recs = await prisma.ambAdvisorRecommendation.findMany({ where: { product_id: Number(productId), store_id: storeId }, orderBy: { created_at: 'desc' }, take: 200 });
  const versions = await prisma.ambAdvisorPlanVersion.findMany({ where: { product_id: Number(productId), store_id: storeId }, orderBy: { version: 'desc' }, take: 30, select: { version: true, state_hash: true, trigger: true, change_reasons_json: true, created_at: true } });
  const shaped = recs.map(shapeRec);
  const byProblem = new Map();
  for (const r of shaped) { const k = r.problemType || 'UNKNOWN'; if (!byProblem.has(k)) byProblem.set(k, []); byProblem.get(k).push(r); }
  const problems = [...byProblem.entries()].map(([problem, list]) => {
    const executed = list.filter((x) => x.executedAt);
    const resolved = list.some((x) => ['VALIDATED', 'IMPROVED'].includes(x.verdict));
    return { problem, label: PROBLEM_LABEL_AR[problem] || problem, firstSeen: list[list.length - 1]?.createdAt, attempts: executed.length, resolved, recommendations: list };
  });
  const legacyTasks = await prisma.assistantTask.count({ where: { input_json: { contains: `"productId":${Number(productId)}` }, NOT: { input_json: { contains: 'advisorRecommendationId' } } } }).catch(() => 0);
  return {
    ok: true, productId: Number(productId), storeId, recommendations: shaped, problems,
    planVersions: versions.map((v) => ({ version: v.version, trigger: v.trigger, createdAt: v.created_at, reasons: j(v.change_reasons_json, []) })),
    legacy: { state: 'LEGACY_HISTORY_UNTRACKED', untrackedTasks: legacyTasks, note: 'الإجراءات اللي اتنفذت قبل تفعيل المستشار مش متتبّعة — مش هنألّف لها تاريخ أو نتائج. التتبع الحقيقي بدأ من أول توصية هنا.' },
  };
}

export async function getAdvisorReliability({ storeId, productId = null }) {
  const recs = await prisma.ambAdvisorRecommendation.findMany({ where: { store_id: storeId, ...(productId ? { product_id: Number(productId) } : {}) }, select: { rec_type: true, product_id: true, status: true, verdict: true, executed_at: true } });
  const tally = (list) => {
    const executed = list.filter((r) => r.executed_at).length;
    const evaluated = list.filter((r) => r.status === 'EVALUATED' && r.verdict && !['NOT_EXECUTED', 'MEASURING'].includes(r.verdict));
    const c = (v) => evaluated.filter((r) => v.includes(r.verdict)).length;
    const decisive = c(['VALIDATED', 'IMPROVED', 'PARTIAL', 'FAILED', 'HARMFUL']);
    return { total: list.length, executed, measuring: list.filter((r) => ['EXECUTED', 'MEASURING'].includes(r.status)).length, evaluated: evaluated.length, validated: c(['VALIDATED']), improved: c(['IMPROVED']), partial: c(['PARTIAL']),
      failed: c(['FAILED']), harmful: c(['HARMFUL']), inconclusive: c(['INCONCLUSIVE']), notExecuted: list.filter((r) => r.verdict === 'NOT_EXECUTED').length,
      // never a misleading global %: only shown with a decisive sample of at least 5
      hitRate: decisive >= 5 ? Math.round(((c(['VALIDATED']) + c(['IMPROVED'])) / decisive) * 100) : null, hitRateNote: decisive >= 5 ? `من ${decisive} توصية محسومة` : 'عينة غير كافية لحساب نسبة موثوقة' };
  };
  const group = (keyFn) => { const m = new Map(); for (const r of recs) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return [...m.entries()].map(([k, l]) => ({ key: k, ...tally(l) })); };
  return { ok: true, storeId, summary: tally(recs), byType: group((r) => r.rec_type), byProduct: productId ? [] : group((r) => String(r.product_id)).sort((a, b) => b.total - a.total).slice(0, 30), note: 'لا توجد نسبة دقة عامة؛ كل نوع/منتج له عينته الخاصة.' };
}
