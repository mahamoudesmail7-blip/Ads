// 🧠 Smart Advisor — the FINAL DECISION LAYER (2026-10-02). This module does
// NOT invent a new intelligence engine: it COMPOSES the existing canonical
// systems (Smart Decision Center package, Data Quality, Testing Brain,
// Growth Strategist, Profit/COD/Stock/Money Guard, Scale Ladder, Creative
// Fatigue, Incident Center, Product Playbook/Learning, productActionPlan's
// winning stack) into ONE deterministic Action Plan.
//
//   composePlan(inputs)        — PURE: same inputs -> same plan. No DB, no
//                                network, no AI. Unit-testable with synthetic
//                                inputs (advisorPlanTest.js) and used for the
//                                multi-state acceptance run.
//   gatherAdvisorInputs(...)   — the I/O half: calls the existing systems
//                                (sequentially, never Promise.all'd — the
//                                shared Prisma pool is small).
//
// Rules this file enforces (from the spec): Data Quality first (an
// unreliable dimension is EXCLUDED, never invented); one primary variable per
// test; at most 3 NOW actions; every action carries WHAT/WHY/HOW/WHAT STAYS
// FIXED/SUCCESS METRIC/NEXT CHECKPOINT (no generic advice); new
// hooks/creatives are labeled HYPOTHESIS, never winners; competitor items are
// labeled COMPETITOR OBSERVATION; failed advice is not repeated without a new
// reason; the Assistant and the PMC tab read this SAME plan.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getAmbSettings } from './settings.js';
import { getConnection } from '../metaAuth.js';
import { buildProductDecisionPackage } from './productDecision.js';
import { buildTestMatrix, nextBestTest } from './testingBrain.js';
import { buildGrowthPlan } from './growthStrategist.js';
import { getProductProfitBrain } from './profitBrain.js';
import { buildCodQualityReport } from './codQualityBrain.js';
import { stockGuardForProduct } from './stockGuard.js';
import { resolveScaleLadderStage } from './scaleLadder.js';
import { evaluateMoneyGuardForScale } from './moneyGuard.js';
import { buildActionPlan } from './productActionPlan.js';
import { detectIncidentsForProduct } from './incidentCenter.js';
import { buildProductPlaybook } from './productPlaybook.js';
import { getProductLearningMemory } from './productLearning.js';
import { resolveWindow } from './metricsEngine.js';
import { computeProductDataQuality } from './dataQuality.js';
import { verifyProductStoreScope } from './storeScope.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------
export const PROBLEM_LABEL_AR = {
  DATA_QUALITY_PROBLEM: 'مشكلة جودة بيانات',
  INSUFFICIENT_DATA: 'بيانات غير كافية',
  STOCK_PROBLEM: 'مشكلة مخزون',
  COD_PROBLEM: 'مشكلة تشغيلية (تأكيد/تسليم الأوردرات)',
  COD_STATUS_UNKNOWN: 'حالة الأوردرات غير معروفة (كلها PENDING)',
  CREATIVE_FATIGUE: 'إجهاد الكرياتيف',
  CTR_PROBLEM: 'جذب الانتباه ضعيف (CTR)',
  TRAFFIC_PROBLEM: 'تكلفة الوصول عالية',
  CONVERSION_PROBLEM: 'التحويل بعد الزيارة ضعيف',
  OFFER_PROBLEM: 'العرض غير جذاب',
  CPA_PROBLEM: 'تكلفة الأوردر مرتفعة (السبب غير محسوم)',
  PROFIT_PROBLEM: 'مشكلة ربحية',
  NONE: 'مفيش مشكلة أساسية — المنتج سليم',
};
export const STAGE_LABEL_AR = {
  NEW: 'جديد', LEARNING: 'بيتعلّم', VALIDATING: 'تحت التحقق', NEEDS_FIX: 'محتاج إصلاح', PROMISING: 'واعد',
  WINNER: 'رابح', SCALING: 'في مرحلة التوسّع', FATIGUED: 'الكرياتيف بيتعب', RECOVERY: 'مرحلة إنقاذ', INSUFFICIENT_DATA: 'بيانات غير كافية',
};
const DIM_LABEL_AR = { gender: 'الجنس', age: 'العمر', governorate: 'المحافظة' };
const TRACKED_REC_TYPES = new Set(['CREATIVE', 'HOOK', 'ANGLE', 'AUDIENCE', 'GEO', 'OFFER', 'PRICE', 'LANDING_PAGE', 'SCALE', 'DATA_FIX', 'COD', 'PROFIT', 'STOCK']);
const BAD_DQ = new Set(['UNAVAILABLE', 'UNKNOWN', 'STALE', 'MAPPING_ERROR', 'MISMATCH']);

// Hook DIRECTIONS (a taxonomy of what a hook can test — never a claim it will win). The actual copy is
// written on demand by the existing generate_hooks tool; everything here is labeled HYPOTHESIS.
const HOOK_DIRECTIONS = [
  { key: 'PROBLEM_SOLUTION', label: 'مشكلة ← حل', tests: 'هل ابتداء الإعلان بالألم المباشر للعميل بيرفع الانتباه؟' },
  { key: 'DEMONSTRATION', label: 'عرض عملي للمنتج', tests: 'هل رؤية المنتج وهو بيشتغل في أول 3 ثواني بتقلل الشك وترفع التحويل؟' },
  { key: 'SOCIAL_PROOF', label: 'إثبات اجتماعي/تجربة عميل', tests: 'هل الثقة (تجارب عملاء) بتحسّن التحويل بعد الزيارة؟' },
  { key: 'OFFER_URGENCY', label: 'عرض/ندرة', tests: 'هل إبراز العرض أو محدودية الوقت بيرفع معدل الشراء؟' },
  { key: 'CURIOSITY', label: 'فضول/سؤال', tests: 'هل سؤال غير متوقع بيرفع CTR؟' },
  { key: 'COMPARISON', label: 'مقارنة قبل/بعد أو مع البديل', tests: 'هل المقارنة بتوضح القيمة وبتقلل تردد الشراء؟' },
];
const HOOK_ORDER_BY_PROBLEM = {
  CTR_PROBLEM: ['CURIOSITY', 'PROBLEM_SOLUTION', 'DEMONSTRATION', 'COMPARISON'],
  TRAFFIC_PROBLEM: ['CURIOSITY', 'PROBLEM_SOLUTION', 'DEMONSTRATION', 'COMPARISON'],
  CONVERSION_PROBLEM: ['SOCIAL_PROOF', 'DEMONSTRATION', 'OFFER_URGENCY', 'COMPARISON'],
  OFFER_PROBLEM: ['OFFER_URGENCY', 'SOCIAL_PROOF', 'COMPARISON', 'DEMONSTRATION'],
  CREATIVE_FATIGUE: ['PROBLEM_SOLUTION', 'DEMONSTRATION', 'CURIOSITY', 'SOCIAL_PROOF'],
  CPA_PROBLEM: ['DEMONSTRATION', 'SOCIAL_PROOF', 'PROBLEM_SOLUTION', 'OFFER_URGENCY'],
  NONE: ['PROBLEM_SOLUTION', 'DEMONSTRATION', 'CURIOSITY', 'SOCIAL_PROOF'],
};

const pct = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 1000) / 10); // COD brain returns 0..1 fractions
const n = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const n1days = (v) => (Math.round(Number(v) * 10) / 10).toString();
const fmt1 = (v) => (v === null || v === undefined ? '—' : (Math.round(v * 10) / 10).toString());
const hash = (obj) => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
function sha(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10); }

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Data-quality verdict for the whole plan. BLOCKED stops optimisation advice; individual BAD dimensions are excluded per-dimension instead. */
export function dataQualityGate(inp) {
  const gate = inp.pkg?.dataQuality?.status || 'VERIFIED';
  const dq = inp.dq && inp.dq.ok ? inp.dq : null;
  const overall = dq?.overallStatus || null;
  const blocked = gate === 'DECISION_BLOCKED_DATA_QUALITY' || overall === 'MAPPING_ERROR' || overall === 'PURCHASE_RECONCILIATION_ERROR';
  const reasons = [];
  if (gate === 'DECISION_BLOCKED_DATA_QUALITY') reasons.push(...(inp.pkg?.dataQuality?.criticalFailures || []).map((c) => c.message || c.check || String(c)));
  if (overall === 'MAPPING_ERROR') reasons.push('ربط حملات Meta بالمنتج ناقص أو غير مؤكد.');
  if (overall === 'PURCHASE_RECONCILIATION_ERROR') reasons.push('تضارب حقيقي بين مشتريات الحملة ومشتريات التقسيمات.');
  return {
    blocked, gate, overall, reasons,
    dims: { age: dq?.age?.status || 'UNKNOWN', gender: dq?.gender?.status || 'UNKNOWN', region: dq?.region?.status || 'UNKNOWN' },
    campaignPurchases: dq?.campaignPurchases?.status || 'UNKNOWN',
    score: blocked ? 0 : (overall === 'RECONCILED' ? 90 : overall === 'WARNING' || overall === 'STALE' ? 60 : gate === 'VERIFIED' ? 75 : 50),
  };
}

/** Primary bottleneck in advisor vocabulary, with the symptom kept separate from the root cause. */
export function mapProblem(inp, gate) {
  const { pkg, profit, stock, cod, fatigueStates = [], settings } = inp;
  const m = pkg?.diagnosis?.metrics || {};
  const bn = pkg?.diagnosis?.bottleneck || {};
  const targetCpa = n(settings?.ambDefaultTargetCpa) || 120;
  const minSpend = n(settings?.ambMinSpendBeforeDecision) || 150;
  const spend = n(m.totalSpend) || 0;
  const purchases = n(m.metaPurchases) || 0;
  const ctr = n(m.ctr), cvr = n(m.cvr), cpc = n(m.cpc), cpa = n(m.avgCpa);
  const evidence = [];
  const add = (s) => { if (s) evidence.push(s); };
  const pl0 = cod?.productLevel || null;
  // Every order still PENDING (no confirmed/cancelled/delivered/returned at all) = the status never progressed, so a "0% confirmation" is an artefact, not evidence.
  const codUnknown = !!pl0 && pl0.confirmed !== undefined && (pl0.orders || 0) > 0 && ((pl0.confirmed || 0) + (pl0.cancelled || 0) + (pl0.delivered || 0) + (pl0.returned || 0)) === 0;
  if (!(codUnknown && (bn.category === 'CONFIRMATION_PROBLEM' || bn.category === 'DELIVERY_PROBLEM'))) add(bn.evidence);
  if (ctr !== null) add(`CTR ${fmt1(ctr)}%`);
  if (cvr !== null) add(`معدل التحويل (CVR) ${fmt1(cvr)}%`);
  if (cpc !== null) add(`CPC ${fmt1(cpc)} ج`);
  if (cpa !== null) add(`CPA ${fmt1(cpa)} ج مقابل هدف ${targetCpa} ج (${purchases} شراء، صرف ${fmt1(spend)} ج)`);

  let primary, rootNote = null, symptom = null;
  if (gate.blocked) { primary = 'DATA_QUALITY_PROBLEM'; evidence.unshift(...gate.reasons); }
  else if (pkg?.decision === 'INSUFFICIENT_DATA' || bn.category === 'INSUFFICIENT_DATA' || spend < minSpend || (purchases === 0 && spend < minSpend * 2)) primary = 'INSUFFICIENT_DATA'; // just over the spend floor with zero purchases is still too thin to optimise on
  else if (stock?.status === 'OUT_OF_STOCK') { primary = 'STOCK_PROBLEM'; add('المخزون الحالي صفر.'); }
  else if (codUnknown && (bn.category === 'CONFIRMATION_PROBLEM' || bn.category === 'DELIVERY_PROBLEM')) {
    primary = 'COD_STATUS_UNKNOWN';
    rootNote = `الإعلان نفسه شغال${cpa !== null ? ` (CPA ${fmt1(cpa)} ج)` : ''} لكن كل أوردرات Easy Orders (${pl0.orders}) لسه PENDING — مفيش تأكيد/تسليم متسجّل، فمينفعش نحكم على جودة الأوردرات الحقيقية.`;
    add(`${pl0.orders} أوردر كلها PENDING — الحالة مش متحدّثة (مش معناه إن التأكيد 0%).`);
  } else if (bn.category === 'CONFIRMATION_PROBLEM' || bn.category === 'DELIVERY_PROBLEM' || (cod?.codBlocksScale && cpa !== null && cpa <= targetCpa)) {
    primary = 'COD_PROBLEM'; rootNote = 'الإعلان نفسه مش المشكلة — المشكلة في تأكيد/تسليم الأوردرات (تشغيلية).';
    if (cod?.productLevel) add(`${cod.productLevel.orders ?? '—'} أوردر · تأكيد ${fmt1(pct(cod.productLevel.confirmationRate))}% · تسليم ${fmt1(pct(cod.productLevel.deliveryRate))}%`);
  } else if ((bn.category === 'CREATIVE_FATIGUE' || (fatigueStates.includes('FATIGUED') && pkg?.winners?.creative)) && ctr !== null && ctr >= 2 && cvr !== null && cvr < 2) {
    // Fatigue shows up as falling attention. While CTR is still strong and CVR is the weak link, the binding problem is conversion — fatigue stays a secondary finding.
    primary = 'CONVERSION_PROBLEM'; rootNote = `CTR لسه قوي (${fmt1(ctr)}%) فالإجهاد مش العائق الأساسي؛ الاختناق في التحويل (CVR ${fmt1(cvr)}%).`;
  } else if (bn.category === 'CREATIVE_FATIGUE' || (fatigueStates.includes('FATIGUED') && pkg?.winners?.creative)) primary = 'CREATIVE_FATIGUE';
  else if (bn.category === 'CREATIVE_PROBLEM') primary = 'CTR_PROBLEM';
  else if (bn.category === 'CONVERSION_PROBLEM') primary = 'CONVERSION_PROBLEM';
  else if (bn.category === 'TRAFFIC_PROBLEM') primary = 'TRAFFIC_PROBLEM';
  else if (bn.category === 'OFFER_PROBLEM') primary = 'OFFER_PROBLEM';
  else if (bn.category === 'CPA_PROBLEM') {
    symptom = `CPA مرتفع (${fmt1(cpa)} ج مقابل ${targetCpa} ج)`;
    if (ctr !== null && cvr !== null && ctr >= 2 && cvr < 2) { primary = 'CONVERSION_PROBLEM'; rootNote = `CPA المرتفع هو النتيجة؛ الاختناق الأقوى في التحويل (CTR ${fmt1(ctr)}% كويس لكن CVR ${fmt1(cvr)}% ضعيف).`; }
    else if (cpc !== null && cpc > 8) { primary = 'TRAFFIC_PROBLEM'; rootNote = `CPA المرتفع نتيجة تكلفة الكليك العالية (${fmt1(cpc)} ج).`; }
    else primary = 'CPA_PROBLEM';
  } else if (bn.category === 'TRACKING_MAPPING_PROBLEM') { primary = 'DATA_QUALITY_PROBLEM'; }
  else if (profit?.state === 'UNPROFITABLE' || profit?.state === 'MARGIN_THIN') { primary = 'PROFIT_PROBLEM'; add(`حالة الربح: ${profit.state}`); }
  else primary = 'NONE';
  if (!symptom && primary !== 'NONE' && primary !== 'INSUFFICIENT_DATA' && cpa !== null && cpa > targetCpa) symptom = `CPA ${fmt1(cpa)} ج أعلى من الهدف ${targetCpa} ج`;
  return { primary, label: PROBLEM_LABEL_AR[primary], symptom, rootNote, evidence: evidence.slice(0, 6), bottleneckCategory: bn.category || null, bottleneckConfidence: bn.confidence || null };
}

/** Operational stage — never from one metric. */
export function classifyStage(inp, problem, gate) {
  const { pkg, ladder, fatigueStates = [], priorRecs = [], settings } = inp;
  const m = pkg?.diagnosis?.metrics || {};
  const spend = n(m.totalSpend) || 0, purchases = n(m.metaPurchases) || 0;
  const minSpend = n(settings?.ambMinSpendBeforeDecision) || 150, minP = n(settings?.ambMinPurchasesBeforeScaling) || 5;
  const lad = ladder?.stage || null;
  const failedAttempts = priorRecs.filter((r) => ['FAILED', 'HARMFUL'].includes(r.verdict)).length;
  if (problem.primary === 'INSUFFICIENT_DATA' || gate.blocked) return gate.blocked && spend >= minSpend ? 'NEEDS_FIX' : 'INSUFFICIENT_DATA';
  if (spend < minSpend * 2 && purchases === 0) return 'NEW';
  if (problem.primary === 'CREATIVE_FATIGUE' || (problem.primary === 'NONE' && (lad === 'FATIGUE' || lad === 'REFRESH'))) return 'FATIGUED'; // a different primary problem (e.g. conversion) is not relabelled as fatigue
  if (lad === 'SCALE_CAMPAIGN' || lad === 'STABLE') return 'SCALING';
  if (pkg?.decision === 'SCALE_CANDIDATE' || lad === 'VALIDATED') return 'WINNER';
  if (problem.primary === 'NONE' && (lad === 'SIGNAL_FOUND' || pkg?.health?.band === 'GOOD' || pkg?.health?.band === 'HEALTHY')) return 'PROMISING';
  if (['PAUSE_CANDIDATE'].includes(pkg?.decision) || ['AT_RISK', 'CRITICAL'].includes(pkg?.health?.band) || problem.primary !== 'NONE') {
    return failedAttempts >= 1 ? 'RECOVERY' : (purchases < minP ? 'VALIDATING' : 'NEEDS_FIX');
  }
  return purchases < minP ? 'LEARNING' : 'VALIDATING';
}

function confidenceOf(inp, problem, gate) {
  const m = inp.pkg?.diagnosis?.metrics || {};
  const purchases = n(m.metaPurchases) || 0;
  const minP = n(inp.settings?.ambMinPurchasesBeforeScaling) || 5;
  let score = 0;
  score += problem.bottleneckConfidence === 'CONFIRMED' ? 2 : problem.bottleneckConfidence === 'LIKELY' ? 1 : 0;
  score += inp.pkg?.confidence === 'HIGH' ? 1.5 : inp.pkg?.confidence === 'MEDIUM' ? 0.75 : 0;
  score += purchases >= minP * 2 ? 1 : purchases >= minP ? 0.5 : 0;
  score += gate.blocked ? -3 : gate.overall === 'RECONCILED' ? 0.75 : gate.gate === 'VERIFIED' ? 0.5 : 0;
  const label = score >= 3.5 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW';
  return { label, label_ar: { HIGH: 'ثقة عالية', MEDIUM: 'ثقة متوسطة', LOW: 'ثقة منخفضة' }[label], basis: 'مبنية على قوة الدليل وحجم العينة وجودة البيانات — مش على ثقة النموذج.' };
}

function successFor(recType, settings) {
  const minSpend = n(settings?.ambMinSpendBeforeDecision) || 150, minP = n(settings?.ambMinPurchasesBeforeScaling) || 5;
  const base = { minSpend, minPurchases: minP, evaluationWindowDays: 7 };
  const map = {
    HOOK: { primaryMetric: 'ctr', direction: 'UP', guardrails: ['cpa', 'cvr', 'confirmationRate'] },
    CREATIVE: { primaryMetric: 'ctr', direction: 'UP', guardrails: ['cpa', 'cvr', 'confirmationRate'] },
    ANGLE: { primaryMetric: 'cpa', direction: 'DOWN', guardrails: ['ctr', 'cvr', 'confirmationRate'] },
    AUDIENCE: { primaryMetric: 'cpa', direction: 'DOWN', guardrails: ['ctr', 'confirmationRate'] },
    GEO: { primaryMetric: 'cpa', direction: 'DOWN', guardrails: ['confirmationRate', 'deliveryRate'] },
    OFFER: { primaryMetric: 'cvr', direction: 'UP', guardrails: ['cpa', 'confirmationRate'] },
    LANDING_PAGE: { primaryMetric: 'cvr', direction: 'UP', guardrails: ['cpa', 'confirmationRate'] },
    PRICE: { primaryMetric: 'cvr', direction: 'UP', guardrails: ['cpa', 'confirmationRate', 'profit'] },
    SCALE: { primaryMetric: 'purchases', direction: 'UP', guardrails: ['cpa', 'confirmationRate', 'profit'] },
    DATA_FIX: { primaryMetric: 'dataQuality', direction: 'UP', guardrails: [] },
    COD: { primaryMetric: 'confirmationRate', direction: 'UP', guardrails: ['cpa'] },
    PROFIT: { primaryMetric: 'profit', direction: 'UP', guardrails: ['cpa'] },
    STOCK: { primaryMetric: 'stock', direction: 'UP', guardrails: [] },
  };
  return { ...(map[recType] || { primaryMetric: 'cpa', direction: 'DOWN', guardrails: [] }), ...base };
}

/** Build one fully-specified action (WHAT/WHY/HOW/STAYS FIXED/SUCCESS/CHECKPOINT) — generic advice is not representable here. */
function action(a, settings) {
  const recType = a.recType;
  const success = successFor(recType, settings);
  const actionKey = a.actionKey || `${recType}|${a.variable || '-'}|${a.target || '-'}`;
  return {
    actionKey, priority: a.priority, owner: a.owner, recType, title: a.title,
    what: a.what, why: a.why, how: a.how, staysFixed: a.staysFixed || [],
    successMetric: a.successMetric || `${success.primaryMetric} (${success.direction === 'UP' ? 'يرتفع' : 'ينخفض'})`,
    failureCriteria: a.failureCriteria || `المقياس الأساسي ما اتحسنش بعد عينة كافية (${success.minPurchases} مشتريات و${success.minSpend} ج صرف)، أو CPA/تأكيد الأوردرات ساء.`,
    checkpoint: a.checkpoint || `بعد ${success.evaluationWindowDays} أيام أو عند وصول العينة الكافية`,
    evidence: a.evidence || [], sources: a.sources || [], confidence: a.confidence || 'LOW',
    whyNot: a.whyNot || [], hypothesis: a.hypothesis || null, targetVariable: a.variable || null,
    tool: a.tool || null, // existing preparation tool (PREPARE -> PREVIEW -> APPROVAL -> EXECUTE — never executes by itself)
    trackable: a.trackable !== false && TRACKED_REC_TYPES.has(recType),
    success,
    triedBefore: a.triedBefore || null,
  };
}

// ---------------------------------------------------------------------------
// composePlan — PURE
// ---------------------------------------------------------------------------
export function composePlan(inp) {
  const { pkg, settings = {}, growth, ladder, profit, stock, cod, matrix = [], learning = { entries: [] }, priorRecs = [], incidents = [], actionPlan, competitor = [], fatigueStates = [] } = inp;
  const gate = dataQualityGate(inp);
  const problem = mapProblem(inp, gate);
  const stage = classifyStage(inp, problem, gate);
  const confidence = confidenceOf(inp, problem, gate);
  const m = pkg?.diagnosis?.metrics || {};
  const targetCpa = n(settings.ambDefaultTargetCpa) || 120;
  const minSpend = n(settings.ambMinSpendBeforeDecision) || 150, minP = n(settings.ambMinPurchasesBeforeScaling) || 5;
  const spend = n(m.totalSpend) || 0, purchases = n(m.metaPurchases) || 0;
  const sampleSufficient = spend >= minSpend && purchases >= minP;
  const src = (...s) => s;

  // ---- what failed before (advisor history + testing matrix + learning) — failed advice is not repeated blindly
  const failedKeys = new Set(priorRecs.filter((r) => ['FAILED', 'HARMFUL'].includes(r.verdict)).map((r) => r.action_key));
  const lostMatrix = matrix.filter((e) => e.status === 'LOST').map((e) => `${e.dimension}:${e.key}`);
  const learnedBad = (learning.entries || []).filter((e) => e.verdict === 'DOES_NOT_WORK' || e.state === 'REJECTED').map((e) => `${e.dimension}:${e.key}`);
  const triedBefore = (dim, key) => lostMatrix.includes(`${dim}:${key}`) || learnedBad.includes(`${dim}:${key}`);

  // ---- what is working (do not break) / not working (ranked by impact)
  // An audience slice that Data Quality excludes (age/gender not reliable) must not be shown as "working" either — one source of truth.
  const audienceExcluded = (w) => {
    if (w.dimension !== 'AUDIENCE') return false;
    const k = String(w.key || '');
    const isAge = /\d/.test(k); const isGender = /male|female|ذكر|أنثى|انثى|رجال|نساء|نسا|ولاد|بنات/i.test(k);
    return (isAge && BAD_DQ.has(gate.dims.age)) || (isGender && BAD_DQ.has(gate.dims.gender));
  };
  const working = (growth?.whatIsWorking || []).slice(0, 5).map((w) => ({ dimension: w.dimension, key: w.key, evidence: w.evidence, kind: 'VERIFIED' })).filter((w) => !audienceExcluded(w));
  if (n(m.ctr) !== null && n(m.ctr) >= 2) working.unshift({ dimension: 'ATTENTION', key: 'CTR', evidence: `CTR ${fmt1(m.ctr)}% — الإعلان بيشد الانتباه.`, kind: 'VERIFIED' });
  if (n(m.avgCpa) !== null && n(m.avgCpa) <= targetCpa && purchases >= minP) working.unshift({ dimension: 'COST', key: 'CPA', evidence: `CPA ${fmt1(m.avgCpa)} ج داخل الهدف (${targetCpa} ج) بعينة ${purchases} شراء.`, kind: 'VERIFIED' });
  const notWorking = [];
  if (problem.primary !== 'NONE' && problem.primary !== 'INSUFFICIENT_DATA') notWorking.push({ rank: 1, problem: problem.primary, label: problem.label, evidence: problem.evidence.slice(0, 3) });
  if (fatigueStates.includes('FATIGUED') && problem.primary !== 'CREATIVE_FATIGUE') notWorking.push({ rank: notWorking.length + 1, problem: 'CREATIVE_FATIGUE', label: PROBLEM_LABEL_AR.CREATIVE_FATIGUE, evidence: ['فيه كرياتيف واحد على الأقل بحالة FATIGUED.'] });
  if (cod?.codBlocksScale && problem.primary !== 'COD_PROBLEM' && problem.primary !== 'COD_STATUS_UNKNOWN') notWorking.push({ rank: notWorking.length + 1, problem: 'COD_PROBLEM', label: PROBLEM_LABEL_AR.COD_PROBLEM, evidence: [cod.decisionNote || 'جودة الأوردرات بتمنع التوسّع.'] });
  if ((profit?.state === 'UNPROFITABLE' || profit?.state === 'MARGIN_THIN') && problem.primary !== 'PROFIT_PROBLEM') notWorking.push({ rank: notWorking.length + 1, problem: 'PROFIT_PROBLEM', label: PROBLEM_LABEL_AR.PROFIT_PROBLEM, evidence: [`حالة الربح ${profit.state}`] });
  (growth?.whatIsNotWorking || []).slice(0, 3).forEach((x) => notWorking.push({ rank: notWorking.length + 1, problem: `${x.dimension}_WEAK`, label: `${x.dimension}: ${String(x.key).slice(0, 60)}`, evidence: [x.evidence] }));

  // ---- audience decision (Data Quality first: a bad dimension is EXCLUDED, never guessed)
  const stack = actionPlan?.winningStack || {};
  const audience = {};
  for (const dim of ['gender', 'age', 'governorate']) {
    const t = stack[dim]?.targeting || null;
    const o = stack[dim]?.observation || null;
    const dqStatus = dim === 'governorate' ? null : gate.dims[dim];
    let decision, note, kind = 'EVIDENCE';
    if (dqStatus && BAD_DQ.has(dqStatus)) { decision = 'EXCLUDED'; kind = 'UNAVAILABLE'; note = dqStatus === 'UNKNOWN' ? `تقسيم ${DIM_LABEL_AR[dim]} من Meta لسه ما اتحسبش لهذا المنتج (افتح تاب «الجمهور والأسواق» لحسابه) — مستبعد من القرار لحد ما يتحسب بدل التخمين.` : `بيانات ${DIM_LABEL_AR[dim]} من Meta غير موثوقة حاليًا (${dqStatus}) — مستبعدة من القرار بدل التخمين.`; }
    else if (t?.status === 'PROVEN') { decision = 'KEEP'; note = `${t.value} — مثبت بدليل (${t.evidence || 'عينة كافية'}).`; }
    else if (t?.status === 'PROMISING') { decision = 'TEST'; kind = 'EARLY_SIGNAL'; note = `${t.value} — واعد لكن لسه مش مثبت؛ يستاهل اختبار منفصل.`; }
    else if (t?.status === 'EARLY_SIGNAL' || o?.status === 'EARLY_SIGNAL' || o?.status === 'OBSERVED') { decision = 'DO_NOT_NARROW'; kind = 'EARLY_SIGNAL'; note = `${t?.value || o?.value || 'شريحة'} — إشارة مبكرة فقط. لا تضيّق الاستهداف عليها لحد ما العينة تكفي.`; }
    else if (o?.status === 'PROVEN_NEGATIVE') { decision = 'KEEP'; note = `${o.value} — ضعيف بدليل؛ استبعده من التوسّع بس بلا تضييق على الباقي.`; }
    else { decision = 'INSUFFICIENT_DATA'; kind = 'UNKNOWN'; note = 'مفيش عينة كافية لحكم.'; }
    audience[dim] = { dimension: dim, label: DIM_LABEL_AR[dim], decision, note, kind, dataQuality: dqStatus || 'EASY_ORDERS' };
  }
  if (gate.dims.region && BAD_DQ.has(gate.dims.region)) audience.regionMeta = { dimension: 'region', label: 'المنطقة (Meta)', decision: 'EXCLUDED', kind: 'UNAVAILABLE', note: 'Meta لا تُسند المشتريات لتقسيم المنطقة بدقة لهذا الحساب — لا يُستخدم لاختيار محافظة رابحة. (توزيع المحافظات الحقيقي يأتي من أوردرات Easy Orders.)', dataQuality: gate.dims.region };

  // ---- angle / hook / creative
  const bestAngle = pkg?.winners?.angle || null;
  const angleLabel = bestAngle?.label || (typeof bestAngle === 'string' ? bestAngle : null);
  const angleRows = matrix.filter((e) => e.dimension === 'ANGLE');
  const untestedAngle = angleRows.find((e) => e.status === 'NOT_TESTED' && !triedBefore('ANGLE', e.key));
  const angle = {
    currentBest: angleLabel ? { label: angleLabel, evidence: bestAngle?.spend != null ? `صرف ${fmt1(bestAngle.spend)} ج · ${bestAngle.purchases ?? 0} شراء · CPA ${fmt1(bestAngle.cpa)} ج (${bestAngle.dataSufficiency || 'عينة محدودة'})` : 'من تحليل الكرياتيف', kind: bestAngle?.dataSufficiency === 'STRONG' ? 'VERIFIED' : 'EARLY_SIGNAL' } : null,
    keep: angleLabel,
    testNext: untestedAngle ? { label: untestedAngle.key, kind: 'HYPOTHESIS', note: 'مش اتجرب قبل كده.' } : null,
    avoid: angleRows.filter((e) => e.status === 'LOST').slice(0, 3).map((e) => ({ label: e.key, evidence: e.evidence })),
  };
  const bestHook = pkg?.winners?.hook || null;
  const hookLabel = bestHook?.label || (typeof bestHook === 'string' ? bestHook : null);
  const order = HOOK_ORDER_BY_PROBLEM[problem.primary] || HOOK_ORDER_BY_PROBLEM.NONE;
  const hookDirs = order.map((k) => HOOK_DIRECTIONS.find((h) => h.key === k)).filter((h) => h && !triedBefore('HOOK', h.key) && !failedKeys.has(`HOOK|hook|${h.key}`)).slice(0, 4)
    .map((h) => ({ ...h, kind: 'HYPOTHESIS', badge: 'HYPOTHESIS — NOT WINNER YET' }));
  const hooks = { keep: hookLabel ? { label: hookLabel, kind: 'VERIFIED' } : null, newDirections: hookDirs, note: 'الاتجاهات دي فرضيات للاختبار — النص الفعلي بيتولّد بزرار "اعمل Hooks" ومحدش فيهم يتسمى فائز قبل ما الأداء الحقيقي يثبت.' };

  const fatigued = fatigueStates.includes('FATIGUED');
  const creative = {
    keepWinner: pkg?.winners?.creative ? { label: typeof pkg.winners.creative === 'string' ? pkg.winners.creative : pkg.winners.creative.label, kind: 'VERIFIED' } : null,
    replaceFatigued: fatigued, fatiguedLabels: (inp.fatiguedLabels || []).slice(0, 3),
    challengers: hookDirs.slice(0, 3).map((h, i) => ({
      slot: i + 1, kind: 'HYPOTHESIS', badge: 'NEW CHALLENGER',
      hypothesis: h.tests,
      angle: angleLabel || 'الزاوية الحالية (لسه مفيش زاوية مثبتة)',
      hookDirection: h.label,
      format: problem.primary === 'CONVERSION_PROBLEM' || problem.primary === 'OFFER_PROBLEM' ? 'فيديو Demonstration/UGC' : 'فيديو قصير UGC',
      first3Seconds: `ابدأ بـ«${h.label}» مباشرة — بدون مقدمة.`,
      demonstration: 'لقطة قريبة للمنتج وهو بيشتغل فعليًا.',
      cta: 'اطلب دلوقتي والدفع عند الاستلام',
      holdsConstant: ['الجمهور', 'الميزانية', 'السعر', 'الصفحة'],
    })),
    note: 'كل كرياتيف جديد بيختبر فرضية واحدة محددة — مش توليد عشوائي.',
  };

  // ---- offer / price / page (only when the bottleneck is conversion-side) — never auto-blame targeting
  const conversionSide = ['CONVERSION_PROBLEM', 'OFFER_PROBLEM', 'CPA_PROBLEM'].includes(problem.primary);
  const bcr = pkg?.businessConversionRate?.value ?? null;
  const priceOpp = pkg?.priceTestOpportunity?.detected ? pkg.priceTestOpportunity : null;
  const offerPage = {
    relevant: conversionSide,
    items: conversionSide ? [
      { item: 'السعر', decision: priceOpp ? 'TEST' : 'KEEP', note: priceOpp ? (priceOpp.evidence || 'فرصة اختبار سعر مرصودة.') : 'مفيش دليل على إن السعر هو العائق.' },
      { item: 'العرض', decision: problem.primary === 'OFFER_PROBLEM' ? 'TEST' : (conversionSide ? 'TEST' : 'KEEP'), note: 'العرض هو أول متغيّر مرشّح لو الكرياتيف والجمهور سليمين والتحويل ضعيف.' },
      { item: 'صفحة الهبوط', decision: bcr !== null && bcr < 6 ? 'TEST' : 'KEEP', note: bcr !== null ? `معدل التحويل التجاري ${fmt1(bcr)}% (عتبة المراجعة 6%).` : 'معدل التحويل التجاري غير متاح.' },
      { item: 'الثقة والشحن وطمأنة الدفع عند الاستلام', decision: 'UNKNOWN', note: 'مفيش بيانات مقاسة عن العناصر دي في النظام — محتاج مراجعة بشرية للصفحة.' },
    ] : [],
  };

  // ---- COD / profit
  const pl = cod?.productLevel || null;
  // Every order still PENDING (nothing confirmed/cancelled/delivered/returned) = status never progressed: the rates are UNKNOWN, not 0%.
  const statusUnknown = !!pl && pl.confirmed !== undefined && (pl.orders || 0) > 0 && ((pl.confirmed || 0) + (pl.cancelled || 0) + (pl.delivered || 0) + (pl.returned || 0)) === 0;
  const codBlock = {
    statusUnknown,
    orders: pl?.orders ?? null, confirmationRate: statusUnknown ? null : pct(pl?.confirmationRate), deliveryRate: statusUnknown ? null : pct(pl?.deliveryRate),
    cancellationRate: statusUnknown ? null : pct(pl?.cancellationRate), returnRate: statusUnknown ? null : pct(pl?.returnRate),
    blocksScale: !!cod?.codBlocksScale,
    verdict: statusUnknown ? 'الحكم التشغيلي معلّق لحد ما حالات الأوردرات تتحدّث.' : problem.primary === 'COD_PROBLEM' ? 'المشكلة تشغيلية وليست إعلانية.' : (cod?.codBlocksScale ? 'جودة الأوردرات بتمنع التوسّع.' : null),
    note: statusUnknown ? `كل الأوردرات (${pl.orders}) لسه PENDING في Easy Orders — حالة التأكيد/التسليم مش متحدّثة، فمفيش حكم تشغيلي ممكن (مش معناه إن التأكيد 0%).` : (cod?.decisionNote || null),
  };
  const stockBlock = { status: stock?.status || 'STOCK_UNKNOWN', currentStock: stock?.currentStock ?? null, daysRemaining: stock?.daysRemaining ?? null,
    note: !stock || stock.status === 'STOCK_UNKNOWN' ? 'المخزون الحالي غير مسجّل — Stock Guard مش قادر يحكم على أمان التوسّع (سجّل المخزون في بيانات المنتج).' : stock.status === 'OUT_OF_STOCK' ? 'المخزون صفر.' : stock.status === 'LOW' ? `المخزون منخفض${stock.daysRemaining != null ? ` (حوالي ${n1days(stock.daysRemaining)} يوم)` : ''}.` : `المخزون آمن${stock.daysRemaining != null ? ` (حوالي ${n1days(stock.daysRemaining)} يوم)` : ''}.` };
  const profitBlock = {
    state: profit?.state || 'INSUFFICIENT_DATA', configState: profit?.configState || 'NOT_CONFIGURED', marginPct: profit?.marginPct ?? null,
    note: profit?.configState === 'NOT_CONFIGURED' || !profit ? 'التكاليف الاقتصادية غير مضبوطة — الربحية UNKNOWN (مش بنستنتج ربح من ROAS).' : (profit.reason || null),
  };

  // ---- the exact next test — ONE primary variable
  let nextTest = null; const triedList = []; const excludedByDq = [];
  const design = growth?.controlledTestDesign || null;
  const candidates = [];
  if (design?.variableChanged) candidates.push({ dimension: design.variableChanged, key: design.variant, design });
  for (const c of (growth?.nextTest?.candidates || [])) candidates.push({ dimension: c.dimension, key: c.key, design: null, cand: c });
  for (const c of candidates) {
    const rt = c.dimension === 'AUDIENCE' ? 'AUDIENCE' : c.dimension === 'GEO' ? 'GEO' : c.dimension === 'CREATIVE' ? 'CREATIVE' : c.dimension === 'HOOK' ? 'HOOK' : c.dimension === 'ANGLE' ? 'ANGLE' : c.dimension === 'PRICE' ? 'PRICE' : null;
    if (!rt) continue;
    if (rt === 'AUDIENCE') {
      // Data Quality first: a test candidate that rests on an age/gender slice Meta cannot reliably attribute is DROPPED, not guessed.
      const k = String(c.key || '');
      const isAge = /d/.test(k); const isGender = /male|female|ذكر|أنثى|انثى|رجال|نساء/i.test(k);
      const dqBadAge = BAD_DQ.has(gate.dims.age), dqBadGender = BAD_DQ.has(gate.dims.gender);
      if ((isAge && dqBadAge) || (isGender && dqBadGender) || (!isAge && !isGender && dqBadAge && dqBadGender)) { excludedByDq.push({ dimension: c.dimension, key: c.key, note: 'مستبعد: بيانات الجمهور من Meta غير موثوقة حاليًا (Data Quality).' }); continue; }
    }
    const ak = `${rt}|${c.dimension.toLowerCase()}|${c.key}`;
    if (triedBefore(c.dimension, c.key) || failedKeys.has(ak)) { triedList.push({ dimension: c.dimension, key: c.key, note: 'اتجرب قبل كده وما نجحش — مش هنكرره من غير سبب جديد.' }); continue; }
    nextTest = { recType: rt, variable: c.dimension, variant: c.key, actionKey: ak, design: c.design || design || null, hypothesis: (c.design || design)?.hypothesis || `تغيير ${c.dimension} لـ"${c.key}" ممكن يحسّن الأداء بناءً على المشكلة الحالية.` };
    break;
  }
  if (!nextTest && !gate.blocked && problem.primary !== 'INSUFFICIENT_DATA') {
    if (priceOpp) nextTest = { recType: 'PRICE', variable: 'PRICE', variant: 'سعر بديل يحدده المستخدم', actionKey: 'PRICE|price|opportunity', design: null, hypothesis: priceOpp.proposedChange || 'اختبار سعر بديل.' };
    else if (problem.primary === 'OFFER_PROBLEM' || problem.primary === 'CONVERSION_PROBLEM') nextTest = { recType: 'OFFER', variable: 'OFFER', variant: 'عرض مختلف (يحدده المستخدم)', actionKey: 'OFFER|offer|variant', design: null, hypothesis: 'عرض مختلف مع تثبيت الكرياتيف والجمهور والسعر بيحسّن معدل التحويل.' };
    else if (problem.primary === 'CTR_PROBLEM' || problem.primary === 'CREATIVE_FATIGUE') nextTest = { recType: 'HOOK', variable: 'HOOK', variant: hookDirs[0]?.key || 'PROBLEM_SOLUTION', actionKey: `HOOK|hook|${hookDirs[0]?.key || 'PROBLEM_SOLUTION'}`, design: null, hypothesis: hookDirs[0]?.tests || 'Hook جديد بيرفع CTR.' };
  }
  const nextTestBlock = nextTest ? {
    variable: nextTest.variable, why: problem.evidence[0] || problem.label,
    control: nextTest.design?.control || 'الوضع الحالي (بدون تغيير)', variant: nextTest.design?.variant || nextTest.variant,
    holdsConstant: nextTest.design?.variablesHeldConstant || ['كل المتغيّرات ما عدا المختبَر'],
    budget: 'بميزانية Money Guard/Testing Brain وقت التجهيز (مفيش رقم بيتخمّن هنا).',
    successMetrics: [successFor(nextTest.recType, settings).primaryMetric, ...successFor(nextTest.recType, settings).guardrails],
    minimumSample: `${minP} مشتريات حقيقية و${minSpend} ج صرف على الأقل`,
    review: `بعد ${nextTest.design?.evaluationWindowDays || 7} أيام أو عند وصول العينة`,
    hypothesis: nextTest.hypothesis, singleVariableRule: 'متغيّر أساسي واحد فقط في الاختبار.',
    recType: nextTest.recType, actionKey: nextTest.actionKey, triedBefore: triedList, excludedByDataQuality: excludedByDq,
  } : { none: true, reason: gate.blocked ? 'جودة البيانات بتمنع اقتراح اختبار موثوق دلوقتي.' : problem.primary === 'INSUFFICIENT_DATA' ? 'العينة لسه ناقصة.' : (excludedByDq.length ? 'الاختبارات المرشّحة كلها بتعتمد على بيانات جمهور غير موثوقة (Data Quality) — مفيش اختبار موثوق دلوقتي.' : 'مفيش اختبار مقترح بدليل حاليًا.'), triedBefore: triedList, excludedByDataQuality: excludedByDq };

  // ---- ACTIONS (max 3 NOW) — P0/P1/P2, owner AI/HUMAN, existing tools only
  const evid = problem.evidence.slice(0, 3);
  const base = { evidence: evid, confidence: confidence.label };
  const nowActions = []; const nextActions = []; const laterActions = [];
  const productName = inp.productName || pkg?.productName || '';
  const P = problem.primary;
  if (gate.blocked) {
    nowActions.push(action({ ...base, priority: 'P0', owner: 'HUMAN', recType: 'DATA_FIX', title: 'إصلاح/انتظار البيانات قبل أي قرار', what: 'تأكيد ربط حملات Meta بالمنتج وحل أي تضارب مشتريات.', why: gate.reasons[0] || 'جودة البيانات بتمنع قرار موثوق.', how: 'راجع تاب "جودة البيانات" وقسم "ربط إعلانات Meta"، وأكّد الحملات الصحيحة.', staysFixed: ['الميزانية', 'الاستهداف', 'الكرياتيف'], sources: src('DATA_QUALITY'), variable: 'dataQuality', target: gate.overall || 'BLOCKED', successMetric: 'جودة البيانات ترجع RECONCILED/VERIFIED', checkpoint: 'بعد التأكيد وأول مزامنة' }, settings));
  } else if (P === 'INSUFFICIENT_DATA') {
    // no optimisation action — only waiting (see insufficientPlan)
  } else {
    if (P === 'STOCK_PROBLEM') nowActions.push(action({ ...base, priority: 'P0', owner: 'HUMAN', recType: 'STOCK', title: 'توفير مخزون قبل أي صرف', what: 'إعادة توفير المنتج أو إيقاف الصرف مؤقتًا.', why: 'المخزون صفر — أي أوردر جديد مش هيتسلّم.', how: 'تحديث المخزون الفعلي في بيانات المنتج.', staysFixed: ['الكرياتيف', 'الجمهور'], sources: src('STOCK_GUARD'), variable: 'stock', target: 'restock', successMetric: 'المخزون > 0', checkpoint: 'فور التوفير' }, settings));
    if (P === 'COD_STATUS_UNKNOWN') nowActions.push(action({ ...base, priority: 'P0', owner: 'HUMAN', recType: 'COD', title: 'تأكيد/تحديث حالات الأوردرات في Easy Orders', what: 'راجع إن حالات الأوردرات (مؤكد/ملغي/مُسلَّم) بتتحدّث فعلًا في Easy Orders وفي النظام (webhook الحالة / فريق التأكيد).', why: `كل أوردرات المنتج (${codBlock.orders}) PENDING — من غير حالات حقيقية مفيش حكم على جودة COD ولا أمان للتوسّع.`, how: 'تأكّد من webhook تحديث الحالة ومن فريق التأكيد. أول ما تظهر حالات حقيقية الخطة بتحسب التأكيد/التسليم تلقائيًا وتحكم.', staysFixed: ['الإعلانات', 'الميزانية', 'الاستهداف', 'الكرياتيف'], sources: src('EASY_ORDERS'), variable: 'cod', target: 'status_sync', successMetric: 'ظهور أوردرات بحالات مؤكد/ملغي/مُسلَّم', checkpoint: 'بعد تحديث الحالات وأول مزامنة', trackable: false }, settings));
    if (P === 'COD_PROBLEM') nowActions.push(action({ ...base, priority: 'P0', owner: 'HUMAN', recType: 'COD', title: 'إصلاح تأكيد/تسليم الأوردرات (تشغيلي)', what: 'مراجعة مكالمات التأكيد وشركة الشحن للمحافظات الأضعف.', why: codBlock.verdict || 'الأوردرات مش بتتأكد/تتسلّم بالمعدل المطلوب.', how: 'ابدأ بالمحافظات الأعلى إلغاءً في تاب "الأسواق والمناطق" وراجع مين بيأكد.', staysFixed: ['الإعلانات', 'الميزانية'], sources: src('EASY_ORDERS', 'COD_QUALITY'), variable: 'cod', target: 'confirmation', successMetric: 'confirmationRate يرتفع', checkpoint: 'بعد 7 أيام من أوردرات جديدة' }, settings));
    if (P === 'PROFIT_PROBLEM' || (profit?.state === 'UNPROFITABLE')) nowActions.push(action({ ...base, priority: 'P0', owner: 'HUMAN', recType: 'PROFIT', title: 'مراجعة السعر/التكلفة (المنتج بيخسر)', what: 'مراجعة سعر البيع وتكلفة المنتج والشحن.', why: `حالة الربح ${profit?.state}`, how: 'عدّل التكاليف الفعلية أو السعر في بيانات المنتج قبل أي صرف إضافي.', staysFixed: ['الكرياتيف', 'الجمهور'], sources: src('PROFIT_BRAIN'), variable: 'profit', target: 'margin', successMetric: 'profit يرتفع', checkpoint: 'بعد تعديل التكاليف' }, settings));
    if (P === 'CREATIVE_FATIGUE') nowActions.push(action({ ...base, priority: 'P0', owner: 'AI', recType: 'CREATIVE', title: 'استبدال الكرياتيف المتعب بتحديات جديدة', what: 'جهّز 3 كرياتيف challengers بدل المتعب مع الإبقاء على الزاوية الرابحة.', why: 'المنتج مش المشكلة — الكرياتيف بدأ يتعب.', how: 'اضغط "جهّز الكرياتيف" وهيتولد Brief للتحديات (فرضيات).', staysFixed: ['الجمهور', 'السعر', 'الصفحة', 'الزاوية الرابحة'], sources: src('CREATIVE_FATIGUE', 'CREATIVE_INTEL'), variable: 'creative', target: 'replace_fatigued', hypothesis: 'كرياتيف جديد بنفس الزاوية بيرجّع الأداء اللي اتآكل.', tool: { name: 'generate_creative_brief', args: { productId: inp.productId }, label: 'جهّز الكرياتيف' } }, settings));
    if ((P === 'CTR_PROBLEM' || P === 'TRAFFIC_PROBLEM') && hookDirs.length) nowActions.push(action({ ...base, priority: 'P0', owner: 'AI', recType: 'HOOK', title: `اختبار ${Math.min(3, hookDirs.length)} Hooks جديدة لرفع الانتباه`, what: `Hooks في اتجاهات: ${hookDirs.slice(0, 3).map((h) => h.label).join('، ')}.`, why: problem.evidence[0], how: 'اضغط "اعمل Hooks" وراجع المسودة قبل أي استخدام.', staysFixed: ['الجمهور', 'السعر', 'الصفحة', 'الميزانية'], sources: src('META', 'CREATIVE_INTEL'), variable: 'hook', target: hookDirs[0].key, hypothesis: hookDirs[0].tests, tool: { name: 'generate_hooks', args: { productId: inp.productId }, label: 'اعمل Hooks' } }, settings));
    if (['CONVERSION_PROBLEM', 'OFFER_PROBLEM', 'CPA_PROBLEM'].includes(P) && nextTest) {
      const tool = nextTest.recType === 'AUDIENCE' || nextTest.recType === 'GEO' ? { name: 'prepare_test', args: { productId: inp.productId, testDimension: nextTest.recType, testValue: nextTest.variant }, label: 'جهّز الاختبار' } : nextTest.recType === 'PRICE' ? { name: 'prepare_price_test', args: { productId: inp.productId }, label: 'جهّز اختبار السعر' } : null;
      nowActions.push(action({ ...base, priority: 'P0', owner: tool ? 'AI' : 'HUMAN', recType: nextTest.recType, title: `اختبار ${nextTest.variable} فقط (${String(nextTest.variant).slice(0, 40)})`, what: nextTestBlock.hypothesis, why: P === 'CONVERSION_PROBLEM' ? 'الإعلان بيشد الانتباه لكن التحويل بعد الزيارة ضعيف — الاختناق في العرض/الصفحة مش الاستهداف.' : problem.evidence[0], how: tool ? 'جهّز الاختبار وراجع الـPreview ثم وافق.' : 'نفّذه يدويًا (مفيش أداة تنفيذ لهذا النوع) وسجّله عشان يتقاس.', staysFixed: nextTestBlock.holdsConstant, sources: src('TESTING_BRAIN', 'GROWTH_STRATEGIST'), variable: nextTest.variable.toLowerCase(), target: String(nextTest.variant), hypothesis: nextTest.hypothesis, tool, actionKey: nextTest.actionKey }, settings));
    }
    if (P === 'NONE' && ['WINNER', 'SCALING', 'PROMISING'].includes(stage) && nextTest) {
      const tool = nextTest.recType === 'AUDIENCE' || nextTest.recType === 'GEO' ? { name: 'prepare_test', args: { productId: inp.productId, testDimension: nextTest.recType, testValue: nextTest.variant }, label: 'جهّز الاختبار' } : null;
      nextActions.push(action({ ...base, priority: 'P1', owner: tool ? 'AI' : 'HUMAN', recType: nextTest.recType, title: `Challenger للتحسين: ${nextTest.variable}`, what: nextTestBlock.hypothesis, why: 'المنتج سليم — الاختبار هنا لتوسيع الهامش مش لإصلاح عطل.', how: 'جهّز اختبار منفصل بميزانية صغيرة من غير ما تمس الإعلان الرابح.', staysFixed: nextTestBlock.holdsConstant, sources: src('TESTING_BRAIN'), variable: nextTest.variable.toLowerCase(), target: String(nextTest.variant), hypothesis: nextTest.hypothesis, tool, actionKey: nextTest.actionKey }, settings));
    }
    if (stage === 'WINNER' || stage === 'SCALING') {
      const mg = evaluateMoneyGuardForScale({ profitState: profit?.state, stockGuard: stock, creativeFatigueState: fatigueStates.includes('FATIGUED') ? 'FATIGUED' : null, settings });
      const canScale = mg.decision !== 'BLOCKED' && !cod?.codBlocksScale && !gate.blocked;
      (nowActions.length < 3 ? nowActions : nextActions).push(action({ ...base, priority: canScale ? 'P0' : 'P1', owner: canScale ? 'AI' : 'HUMAN', recType: 'SCALE', title: canScale ? 'مراجعة التوسّع (Scale)' : 'التوسّع محجوب حاليًا', what: canScale ? 'راجع شرائح الإعلانات الرابحة وجهّز Scale بموافقتك.' : mg.reason, why: canScale ? 'القرار الكلي SCALE_CANDIDATE وMoney Guard سمح.' : `Money Guard: ${mg.decision}${cod?.codBlocksScale ? ' · جودة الأوردرات بتمنع' : ''}`, how: canScale ? 'اضغط "راجع التوسع" — هيجهّز Task بيحتاج موافقتك قبل أي تنفيذ.' : 'حل المانع الأول ثم ارجع.', staysFixed: ['الإعلانات الرابحة الحالية'], sources: src('SCALE_LADDER', 'MONEY_GUARD'), variable: 'budget', target: 'scale', tool: canScale ? { name: 'prepare_scale', args: { productId: inp.productId }, label: 'راجع التوسع' } : null, trackable: canScale }, settings));
    }
    if (profit?.configState === 'NOT_CONFIGURED' && P !== 'PROFIT_PROBLEM') nextActions.push(action({ ...base, priority: 'P1', owner: 'HUMAN', recType: 'PROFIT', title: 'ضبط التكاليف الاقتصادية', what: 'إدخال تكلفة المنتج والشحن.', why: 'الربحية UNKNOWN — مش هينفع نحكم على التوسّع من غيرها.', how: 'عدّل بيانات المنتج (تكلفة/شحن/تغليف).', staysFixed: ['كل الإعلانات'], sources: src('PROFIT_BRAIN'), variable: 'profit', target: 'economics', trackable: false, successMetric: 'configState = KNOWN' }, settings));
  }
  const sorted = [...nowActions].sort((a, b) => a.priority.localeCompare(b.priority));
  const now = sorted.slice(0, 3);
  nextActions.push(...sorted.slice(3));
  if (nextTest && !now.some((a) => a.actionKey === nextTest.actionKey) && !nextActions.some((a) => a.actionKey === nextTest.actionKey) && !gate.blocked && P !== 'INSUFFICIENT_DATA') {
    laterActions.push(action({ ...base, priority: 'P2', owner: 'AI', recType: nextTest.recType, title: `بعد كده: اختبار ${nextTest.variable}`, what: nextTestBlock.hypothesis, why: 'ييجي بعد حسم الأولويات الحالية.', how: 'اتجهّز لما الأولوية الحالية تتقيّم.', staysFixed: nextTestBlock.holdsConstant, sources: src('TESTING_BRAIN'), variable: nextTest.variable.toLowerCase(), target: String(nextTest.variant), actionKey: nextTest.actionKey, trackable: false }, settings));
  }

  // ---- branch plans (exactly one is relevant)
  const stopCpa = targetCpa * (n(settings.ambAdvisorStopCpaMultiplier) || 1.5);
  const attemptsDone = priorRecs.filter((r) => r.verdict).length;
  const failedN = priorRecs.filter((r) => ['FAILED', 'HARMFUL'].includes(r.verdict)).length;
  // Recovery = repeated AD-SIDE fixes. Operational/data/stock/profit problems are not fixed by new hooks, so they never get a creative recovery ladder.
  const AD_SIDE = ['CTR_PROBLEM', 'TRAFFIC_PROBLEM', 'CONVERSION_PROBLEM', 'OFFER_PROBLEM', 'CPA_PROBLEM'];
  const recoveryPlan = (stage === 'NEEDS_FIX' || stage === 'RECOVERY' || stage === 'VALIDATING') && AD_SIDE.includes(P) ? {
    attempts: (['CONVERSION_PROBLEM', 'OFFER_PROBLEM'].includes(P)
      ? [{ n: 1, focus: 'Offer', applies: true }, { n: 2, focus: 'Landing Page / Price', applies: true }, { n: 3, focus: 'Creative / Hook', applies: true }]
      : [{ n: 1, focus: 'Creative / Hook', applies: true }, { n: 2, focus: 'Offer', applies: true }, { n: 3, focus: 'Landing Page / Price', applies: true }]
    ).map((a) => ({ ...a, status: attemptsDone >= a.n ? 'DONE' : attemptsDone + 1 === a.n ? 'NEXT' : 'LATER' })),
    stopCondition: `لو بعد ${settings.ambAdvisorStopAfterFailedAttempts || 3} محاولات متقيَّمة بعينة كافية فشلت/ضرّت (حاليًا ${failedN})، وCPA لسه فوق ${fmt1(stopCpa)} ج (${settings.ambAdvisorStopCpaMultiplier || 1.5}× الهدف) → يُوصى بالإيقاف.`,
    stopTriggered: failedN >= (settings.ambAdvisorStopAfterFailedAttempts || 3) && n(m.avgCpa) !== null && n(m.avgCpa) > stopCpa,
  } : null;
  const mg2 = evaluateMoneyGuardForScale({ profitState: profit?.state, stockGuard: stock, creativeFatigueState: fatigued ? 'FATIGUED' : null, settings });
  const scalePlan = (stage === 'WINNER' || stage === 'SCALING') ? {
    ladderStage: ladder?.stage || null, ladderNext: ladder?.next || null, blockers: ladder?.blockers || [],
    cautions: codBlock.statusUnknown ? ['حالة الأوردرات غير معروفة (كلها PENDING) — جودة COD مش متأكدة؛ راجع تحديث الحالات قبل أي رفع كبير.'] : [], moneyGuard: mg2,
    keepWinners: working.slice(0, 3), addChallengers: creative.challengers.length ? 'أضف 1–2 challenger بميزانية صغيرة جنب الرابح.' : null,
    budgetStrategy: `زيادة تدريجية ≤ ${settings.ambMaxBudgetIncreasePct || 20}% لكل خطوة وبينها ${settings.ambScalingCooldownHours || 24} ساعة (قواعد Money Guard الموجودة).`,
    creativeRotation: fatigued ? 'بدّل الكرياتيف المتعب قبل رفع الميزانية.' : 'راقب Frequency وحالة الإجهاد بعد كل رفع.',
    postScaleMonitoring: 'التتبع تلقائي بعد التنفيذ (مقارنة قبل/بعد).',
    rollback: `لو CPA عدّى ${settings.ambBumpRollbackCpaThreshold || 100} ج بعد التوسّع بعينة ${settings.ambBumpMinPurchases || 5} مشتريات → التوصية بالرجوع للميزانية السابقة (بموافقتك، عبر مسار الـRollback الموجود).`,
    readiness: actionPlan?.readiness || null,
  } : null;
  const fatiguePlan = P === 'CREATIVE_FATIGUE' ? { statement: 'المنتج مش المشكلة — الكرياتيف بدأ يتعب.', priorities: ['استبدال الكرياتيف', 'تدوير الـHook', 'توسيع الزوايا'], doNotChange: ['الجمهور', 'العرض'], note: 'مفيش تغيير في الجمهور/العرض من غير دليل.' } : null;
  const insufficientPlan = P === 'INSUFFICIENT_DATA' ? {
    title: '⏳ لسه بنجمع بيانات',
    missing: [spend < minSpend ? `صرف ${fmt1(minSpend - spend)} ج إضافي` : null, purchases < minP ? `${minP - purchases} مشتريات إضافية` : null, inp.dq?.mapping?.status !== 'OK' ? 'تأكيد ربط حملة Meta' : null].filter(Boolean),
    needed: `${minP} مشتريات و${minSpend} ج صرف على الأقل قبل أي حكم.`,
    keepUnchanged: ['الكرياتيف', 'الجمهور', 'الميزانية', 'السعر'],
    review: 'بعد وصول العينة أو 3 أيام (الأقرب).',
    note: 'مفيش تحسين مصطنع على بيانات ناقصة.',
  } : null;

  // ---- competitor observations (labeled — inspiration only, never evidence it works for THIS product)
  const competitorObservations = competitor.slice(0, 3).map((c) => ({ label: 'COMPETITOR OBSERVATION', text: c }));

  // ---- one-line executive answer — derived ONLY from the structures above
  const keepBits = [creative.keepWinner ? 'الكرياتيف الرابح' : null, audience.age?.decision === 'KEEP' || audience.gender?.decision === 'KEEP' ? 'الجمهور المثبت' : (stage !== 'NEW' && P !== 'INSUFFICIENT_DATA' ? 'الجمهور الحالي (من غير تضييق)' : null), angle.keep ? 'الزاوية الحالية' : null].filter(Boolean);
  let executive;
  if (gate.blocked) executive = 'جودة البيانات بتمنع قرار موثوق دلوقتي. أصلح/أكّد ربط الحملات الأول، ومتغيّرش أي حاجة في الإعلانات لحد ما البيانات تتأكد.';
  else if (P === 'INSUFFICIENT_DATA') executive = 'لسه بنجمع بيانات. متغيّرش أي حاجة، وراجع بعد ما العينة توصل (' + `${minP} مشتريات و${minSpend} ج صرف).`;
  else if (P === 'NONE') executive = `المنتج سليم (${STAGE_LABEL_AR[stage]}). حافظ على ${keepBits.join(' + ') || 'الإعدادات الحالية'}${nextTest ? `، واختبر ${nextTest.variable} فقط كـchallenger` : ''}. ${scalePlan ? 'راجع التوسّع بموافقتك.' : ''}`.trim();
  else if (P === 'CONVERSION_PROBLEM') executive = `الإعلان بيشد الناس (CTR ${fmt1(m.ctr)}%) لكن التحويل ضعيف (CVR ${fmt1(m.cvr)}%). حافظ على ${keepBits.join(' + ') || 'الإعلان الحالي'}، واختبر ${nextTest ? nextTest.variable : 'العرض'} فقط. راجع بعد عينة كافية.`;
  else if (P === 'COD_STATUS_UNKNOWN') executive = `الإعلانات شغالة${m.avgCpa ? ` (CPA ${fmt1(m.avgCpa)} ج)` : ''} لكن كل أوردرات المنتج لسه PENDING في Easy Orders — مفيش حالات تأكيد/تسليم حقيقية، فمفيش حكم على جودة COD ومينفعش نوسّع بثقة. أكّد تحديث الحالات الأول، ومتغيّرش في الإعلانات.`;
  else if (P === 'COD_PROBLEM') executive = 'المشكلة تشغيلية وليست إعلانية — الأوردرات مش بتتأكد/تتسلّم بالمعدل المطلوب. ركّز على التأكيد والتسليم ومتعملش Scale دلوقتي.';
  else if (P === 'CREATIVE_FATIGUE') executive = 'المنتج مش المشكلة — الكرياتيف بدأ يتعب. بدّل الكرياتيف/الـHook مع الإبقاء على الجمهور والعرض، وراجع بعد عينة كافية.';
  else if (P === 'STOCK_PROBLEM') executive = 'المخزون ناقص — أوقف أي توسّع ووفّر المخزون الأول.';
  else if (P === 'PROFIT_PROBLEM') executive = 'المنتج بيجيب أوردرات لكن الربحية ضعيفة/غير مؤكدة. راجع السعر والتكاليف قبل أي صرف إضافي.';
  else executive = `${PROBLEM_LABEL_AR[P]}${problem.rootNote ? ' — ' + problem.rootNote : ''}. ${now[0] ? `الخطوة الأهم: ${now[0].title}` : 'لا اختبار مقترح بدليل حاليًا'}${keepBits.length ? `، مع الحفاظ على ${keepBits.join(' + ')}` : ''}. راجع بعد عينة كافية.`;

  const objective = P === 'NONE' ? (scalePlan ? 'توسّع آمن' : 'الحفاظ على الأداء واختبار تحسينات') : P === 'INSUFFICIENT_DATA' ? 'جمع عينة كافية' : P === 'DATA_QUALITY_PROBLEM' ? 'تأكيد البيانات' : P === 'COD_STATUS_UNKNOWN' ? 'تأكيد حالات الأوردرات' : P === 'COD_PROBLEM' ? 'تحسين تأكيد/تسليم الأوردرات' : P === 'CREATIVE_FATIGUE' ? 'تجديد الكرياتيف' : 'تحسين ' + (P === 'CONVERSION_PROBLEM' ? 'التحويل' : P === 'CTR_PROBLEM' || P === 'TRAFFIC_PROBLEM' ? 'الانتباه/تكلفة الوصول' : 'تكلفة الأوردر');

  const plan = {
    productId: inp.productId, productName, storeId: inp.storeId, windowName: inp.windowName, generatedAt: new Date().toISOString(),
    executive,
    status: { stage, stageLabel: STAGE_LABEL_AR[stage], primaryProblem: P, primaryProblemLabel: problem.label, rootCause: problem.rootNote || problem.evidence[0] || null, objective, dataQuality: { score: gate.score, gate: gate.gate, overall: gate.overall, blocked: gate.blocked, dims: gate.dims }, confidence },
    diagnosis: { problem, symptom: problem.symptom, strongestSignal: n(m.ctr) !== null ? `CTR ${fmt1(m.ctr)}%` : null, biggestProblem: problem.label, summary: problem.rootNote || (problem.symptom ? `${problem.symptom}.` : problem.label) },
    working, notWorking, staysFixed: [...new Set([...(growth?.whatShouldRemainUnchanged || []), ...(working.slice(0, 2).map((w) => w.dimension))])].filter(Boolean),
    audience, angle, hooks, creative, offerPage, cod: codBlock, stock: stockBlock, profit: profitBlock,
    nextTest: nextTestBlock,
    actions: { now, next: nextActions, later: laterActions, ifWins: nextTest ? `رقّي الفائز (${nextTest.variable}: ${String(nextTest.variant).slice(0, 40)}) واختبر المتغيّر التالي.` : null, ifLoses: nextTest ? 'سجّل الفشل في الـPlaybook وانتقل للمتغيّر التالي في خطة الإنقاذ (مش هنكرر نفس الاختبار).' : null },
    recoveryPlan, scalePlan, fatiguePlan, insufficientPlan,
    incidents: (incidents || []).map((i) => ({ type: i.type, severity: i.severity, title: i.title })),
    competitorObservations,
    sources: { meta: 'Smart Decision Center package (Meta)', easyOrders: 'COD Quality / segments', testing: 'Testing Brain + Product Learning', quality: 'Data Quality layer', economics: 'Profit Brain / Stock Guard / Money Guard' },
    evidenceQuality: { campaign: gate.campaignPurchases, age: gate.dims.age, gender: gate.dims.gender, region: gate.dims.region },
    sampleSufficient,
  };
  plan.stateHash = computeStateHash(plan, priorRecs, ladder, fatigueStates);
  plan.trackableActions = [...now, ...nextActions].filter((a) => a.trackable);
  return plan;
}

/** Meaningful-state fingerprint — numbers are bucketed so ordinary data syncs never create a new plan version. */
export function computeStateHash(plan, priorRecs = [], ladder = null, fatigueStates = []) {
  return hash({
    stage: plan.status.stage, problem: plan.status.primaryProblem, dq: plan.status.dataQuality.overall, dqBlocked: plan.status.dataQuality.blocked,
    conf: plan.status.confidence.label, sample: plan.sampleSufficient,
    aud: Object.fromEntries(Object.entries(plan.audience).map(([k, v]) => [k, v.decision])),
    keep: [plan.angle.keep, plan.hooks.keep?.label, plan.creative.keepWinner?.label],
    fatigue: [...new Set(fatigueStates)].sort(), cod: [plan.cod.blocksScale, plan.cod.verdict], profit: plan.profit.state, ladder: ladder?.stage || null,
    incidents: [...new Set(plan.incidents.filter((i) => ['HIGH', 'CRITICAL'].includes(i.severity)).map((i) => i.type))].sort(),
    actions: plan.actions.now.map((a) => a.actionKey), next: plan.nextTest.actionKey || null,
    recs: priorRecs.map((r) => `${r.recommendation_id}:${r.status}:${r.verdict || ''}`).sort(),
  });
}

/** Human-readable reasons a plan version changed (diff of the headline state between two plans). */
export function diffPlans(prev, next) {
  if (!prev) return ['أول خطة مسجّلة لهذا المنتج.'];
  const reasons = [];
  const a = prev.status, b = next.status;
  if (a.stage !== b.stage) reasons.push(`المرحلة اتغيرت: ${STAGE_LABEL_AR[a.stage] || a.stage} ← ${STAGE_LABEL_AR[b.stage] || b.stage}`);
  if (a.primaryProblem !== b.primaryProblem) reasons.push(`المشكلة الأساسية اتغيرت: ${PROBLEM_LABEL_AR[a.primaryProblem] || a.primaryProblem} ← ${PROBLEM_LABEL_AR[b.primaryProblem] || b.primaryProblem}`);
  if (a.dataQuality?.blocked !== b.dataQuality?.blocked) reasons.push(b.dataQuality?.blocked ? 'جودة البيانات بقت BLOCKED.' : 'جودة البيانات رجعت سليمة.');
  if ((prev.sampleSufficient) !== (next.sampleSufficient)) reasons.push(next.sampleSufficient ? 'العينة بقت كافية.' : 'العينة بقت أقل من الكافي.');
  if ((prev.profit?.state) !== (next.profit?.state)) reasons.push(`حالة الربح: ${prev.profit?.state} ← ${next.profit?.state}`);
  if ((prev.cod?.blocksScale) !== (next.cod?.blocksScale)) reasons.push(next.cod?.blocksScale ? 'جودة الأوردرات بقت بتمنع التوسّع.' : 'جودة الأوردرات اتحسنت.');
  const pk = (p) => (p.actions?.now || []).map((x) => x.actionKey).join(',');
  if (pk(prev) !== pk(next)) reasons.push('أولويات التنفيذ الحالية اتغيرت.');
  if (!reasons.length) reasons.push('تغيّر في نتائج التوصيات أو الإشارات الداعمة.');
  return reasons;
}

// ---------------------------------------------------------------------------
// I/O half — sequential calls into the existing canonical systems
// ---------------------------------------------------------------------------
export async function gatherAdvisorInputs({ productId, storeId, windowName = 'last7' }) {
  const pid = Number(productId);
  const scope = await verifyProductStoreScope({ productId: pid, storeId });
  if (!scope.ok) return { ok: false, code: scope.code, reason: scope.reason };

  const settings = await getAmbSettings();
  const adAccountId = (await getConnection())?.selected_ad_account_id || null;
  const pkg = await buildProductDecisionPackage({ productId: pid, windowName, settings, adAccountId });
  const { matrix } = await buildTestMatrix({ productId: pid, pkg });
  const nextTest = nextBestTest({ pkg, testMatrix: matrix });
  const w = resolveWindow(windowName);
  const profit = await getProductProfitBrain({ productId: pid, dateFrom: w.from, dateTo: w.to });
  const stock = await stockGuardForProduct({ productId: pid, storeId, days: settings.ambStockGuardVelocityWindowDays });
  const cod = await buildCodQualityReport({ productId: pid, storeId, from: w.from, to: w.to, pkg });
  const fatiguedLabels = (pkg.creativeIntel?.creative?.table || []).filter((r) => r.fatigueRadar?.state === 'FATIGUED').map((r) => r.label);
  const fatigueStates = [
    ...(pkg.creativeIntel?.creative?.table || []),
    ...(pkg.creativeIntel?.hooks?.table || []),
    ...(pkg.creativeIntel?.angles?.table || []),
  ].map((r) => r.fatigueRadar?.state).filter(Boolean);
  const ladder = resolveScaleLadderStage({ pkg, testMatrix: matrix, profitBrain: profit, creativeFatigueStates: fatigueStates });
  const growth = await buildGrowthPlan({ productId: pid, pkg, profitBrain: profit, stockGuard: stock });
  let actionPlan = null;
  try { actionPlan = await buildActionPlan({ pkg, productId: pid, productName: pkg.productName, image: null, adAccountId, campaigns: [] }); }
  catch (err) { logger.warn('[advisorPlan] buildActionPlan failed (non-fatal)', { productId: pid, message: err.message }); }
  const incidents = (await detectIncidentsForProduct({ productId: pid, productName: pkg.productName, pkg }).catch(() => ({ incidents: [] }))).incidents;
  const amb = await prisma.ambProduct.findUnique({ where: { product_id: pid }, select: { id: true } });
  const playbook = await buildProductPlaybook({ productId: pid, ambProductId: amb?.id, profitBrain: profit, codReport: cod }).catch(() => null);
  const learning = await getProductLearningMemory({ productId: pid }).catch(() => ({ entries: [] }));
  const dq = await computeProductDataQuality({ productId: pid, storeId, windowName }).catch(() => null);
  const productRow = await prisma.product.findUnique({ where: { id: pid }, select: { selling_price: true, product_cost: true, shipping_cost: true } });
  const priorRecs = await prisma.ambAdvisorRecommendation.findMany({ where: { product_id: pid, store_id: storeId }, orderBy: { created_at: 'desc' }, take: 60 });

  // Competitor observations — read from the latest cached PMC snapshot (never a new research call).
  let competitor = [];
  try {
    const prof = await prisma.productMarketingProfile.findFirst({ where: { product_id: pid }, orderBy: { updated_at: 'desc' }, select: { id: true } });
    const snap = prof ? await prisma.productMarketingSnapshot.findFirst({ where: { profile_id: prof.id, market_gaps_json: { not: null } }, orderBy: { computed_at: 'desc' }, select: { market_gaps_json: true } }) : null;
    const gaps = snap?.market_gaps_json ? JSON.parse(snap.market_gaps_json) : null;
    competitor = (gaps?.observed || []).slice(0, 3).map((o) => (typeof o === 'string' ? o : (o.angle || o.hook || o.title || o.name || JSON.stringify(o).slice(0, 120))));
  } catch { competitor = []; }

  return { ok: true, productId: pid, productName: pkg.productName, storeId, windowName, settings, pkg, matrix, nextTest, growth, ladder, profit, stock, cod, fatigueStates, actionPlan, incidents, playbook, learning, dq, priorRecs, competitor, productRow, fatiguedLabels };
}

/** Pure composition over freshly-gathered inputs. */
export async function buildProductActionPlan({ productId, storeId, windowName = 'last7' }) {
  const inputs = await gatherAdvisorInputs({ productId, storeId, windowName });
  if (!inputs.ok) return inputs;
  return { ok: true, plan: composePlan(inputs), inputs };
}
