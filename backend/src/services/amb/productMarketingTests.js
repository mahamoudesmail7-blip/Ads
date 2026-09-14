// Product Marketing Center — §17/§18/§19 Testing Lab + §20 Marketing Memory.
// The only write path for pmc_tests / pmc_test_results / pmc_learning.
// Classification of a completed test is deterministic (real-number margin +
// sample size) — never an AI judgement call.
import { prisma } from '../../prisma.js';

function bad(message, status = 400) { const e = new Error(message); e.status = status; return e; }

const TEST_TYPES = new Set(['AUDIENCE', 'HOOK', 'SELLING_ANGLE', 'CREATIVE', 'OFFER', 'COPY', 'MARKET_AREA', 'PRICE']);
const STATUSES = new Set(['PLANNED', 'RUNNING', 'COMPLETED', 'STOPPED', 'INCONCLUSIVE']);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);

export async function createTest({ profileId, testType, hypothesis, variable, control, variation, recommendedBudget, minDataRequirement, successMetric, stopCondition, expectedLearning, priority, userId }) {
  if (!TEST_TYPES.has(testType)) throw bad(`نوع اختبار غير معروف: ${testType}`);
  if (!hypothesis || !variable || !control || !variation || !successMetric) throw bad('لازم تحدد الفرضية والمتغيّر والـControl والـVariation ومقياس النجاح.');
  const profile = await prisma.productMarketingProfile.findUnique({ where: { id: Number(profileId) } });
  if (!profile) throw bad('البروفايل غير موجود.', 404);

  return prisma.productMarketingTest.create({
    data: {
      profile_id: profile.id, test_type: testType, hypothesis, variable, control, variation,
      recommended_budget: recommendedBudget ?? null, min_data_requirement: minDataRequirement ?? null,
      success_metric: successMetric, stop_condition: stopCondition || null, expected_learning: expectedLearning || null,
      priority: PRIORITIES.has(priority) ? priority : 'P2',
      status: 'PLANNED',
      created_by_id: userId || null,
    },
  });
}

export async function listTests(profileId, { status } = {}) {
  const where = { profile_id: Number(profileId) };
  if (status && STATUSES.has(status)) where.status = status;
  return prisma.productMarketingTest.findMany({ where, orderBy: { created_at: 'desc' }, include: { results: { orderBy: { created_at: 'desc' } } } });
}

export async function updateTestStatus({ testId, status, userId }) {
  if (!STATUSES.has(status)) throw bad(`حالة غير معروفة: ${status}`);
  const test = await prisma.productMarketingTest.findUnique({ where: { id: Number(testId) } });
  if (!test) throw bad('الاختبار غير موجود.', 404);
  return prisma.productMarketingTest.update({ where: { id: test.id }, data: { status } });
}

// Metrics where a HIGHER value is better (purchases/orders/revenue/rate
// metrics). Everything else (cpa, deliveredCpa, cpc, rtoRate, spend) is
// treated as "lower is better" — the more common case for a cost metric.
const HIGHER_IS_BETTER = new Set(['ctr', 'roas', 'orders', 'confirmedOrders', 'deliveredOrders', 'metaPurchases', 'revenue', 'netProfit', 'confirmationRate', 'deliveryRate', 'cvr', 'conversionRate']);

/**
 * Deterministic classification from real numbers only — never an AI call.
 * WINNER: the test's success metric beats control by a real margin (>=15%
 * in the direction that's actually better for THAT metric) AND sample size
 * clears min_data_requirement (or a sane default). LOSER: worse by the same
 * margin. Otherwise NEUTRAL (met threshold, no real gap either way) or
 * INCONCLUSIVE (sample too small to judge at all).
 */
function classify({ metricName, metricValue, controlValue, purchases, minDataRequirement }) {
  const minSample = minDataRequirement != null ? minDataRequirement : 5;
  if (purchases == null || purchases < minSample) return 'INCONCLUSIVE';
  if (metricValue == null || controlValue == null || controlValue === 0) return 'INCONCLUSIVE';
  const higherIsBetter = HIGHER_IS_BETTER.has(metricName);
  // Normalize so positive `improvement` always means "the variation is better".
  const rawChange = (metricValue - controlValue) / controlValue;
  const improvement = higherIsBetter ? rawChange : -rawChange;
  if (improvement >= 0.15) return 'WINNER';
  if (improvement <= -0.15) return 'LOSER';
  return 'NEUTRAL';
}

export async function recordTestResult({ testId, window, metrics = {}, controlValue, whatDidWeLearn, whatNext }) {
  const test = await prisma.productMarketingTest.findUnique({ where: { id: Number(testId) } });
  if (!test) throw bad('الاختبار غير موجود.', 404);
  if (!window?.from || !window?.to) throw bad('لازم تحدد الفترة الزمنية (from/to).');

  const metricValue = metrics[test.success_metric] ?? null;
  const classification = classify({
    metricName: test.success_metric, metricValue, controlValue: controlValue ?? null,
    purchases: metrics.metaPurchases ?? metrics.orders ?? null,
    minDataRequirement: test.min_data_requirement,
  });

  const result = await prisma.productMarketingTestResult.create({
    data: {
      test_id: test.id, window_from: window.from, window_to: window.to,
      spend: metrics.spend ?? null, meta_purchases: metrics.metaPurchases ?? null, orders: metrics.orders ?? null,
      confirmed_orders: metrics.confirmedOrders ?? null, delivered_orders: metrics.deliveredOrders ?? null,
      ctr: metrics.ctr ?? null, cpc: metrics.cpc ?? null, cpa: metrics.cpa ?? null, delivered_cpa: metrics.deliveredCpa ?? null,
      roas: metrics.roas ?? null, revenue: metrics.revenue ?? null, net_profit: metrics.netProfit ?? null,
      classification, what_did_we_learn: whatDidWeLearn || null, what_next: whatNext || null,
    },
  });

  // Only a real WINNER/LOSER teaches us anything worth remembering — a
  // NEUTRAL or INCONCLUSIVE result must never overwrite an earlier
  // confirmed verdict for the same dimension+key with a weaker/no signal.
  if (classification === 'WINNER' || classification === 'LOSER') {
    const verdict = classification === 'WINNER' ? 'WORKS' : 'DOES_NOT_WORK';
    const dimension = { AUDIENCE: 'AUDIENCE', HOOK: 'HOOK', SELLING_ANGLE: 'ANGLE', CREATIVE: 'CREATIVE', OFFER: 'OFFER', COPY: 'CREATIVE', MARKET_AREA: 'MARKET', PRICE: 'OFFER' }[test.test_type] || 'OFFER';
    await recordLearning({
      profileId: test.profile_id, dimension, key: test.variation, verdict,
      sampleSize: metrics.metaPurchases ?? metrics.orders ?? 0,
      evidence: { testId: test.id, hypothesis: test.hypothesis, classification, whatDidWeLearn: whatDidWeLearn || null },
    });
  }

  return result;
}

export async function recordLearning({ profileId, dimension, key, verdict, sampleSize = 0, evidence }) {
  return prisma.productMarketingLearning.upsert({
    where: { profile_id_dimension_key: { profile_id: Number(profileId), dimension, key } },
    create: { profile_id: Number(profileId), dimension, key, verdict, sample_size: sampleSize, evidence_json: evidence ? JSON.stringify(evidence) : null },
    update: { verdict, sample_size: sampleSize, evidence_json: evidence ? JSON.stringify(evidence) : null, computed_at: new Date() },
  });
}

/** §20 — duplicate-test prevention: checked before suggesting/creating a new test for the same dimension+key. */
export async function hasBeenTriedAndFailed(profileId, dimension, key) {
  const row = await prisma.productMarketingLearning.findUnique({ where: { profile_id_dimension_key: { profile_id: Number(profileId), dimension, key } } });
  return Boolean(row && row.verdict === 'DOES_NOT_WORK');
}

export async function listLearning(profileId) {
  return prisma.productMarketingLearning.findMany({ where: { profile_id: Number(profileId) }, orderBy: { computed_at: 'desc' } });
}
