// AI Media Buyer — Testing Brain (Product Growth & Profit Intelligence,
// Phase 3 Slice 3). A pure READ/COMPOSITION layer — never a second testing
// database. Normalizes THREE already-existing, already-canonical sources
// into one TESTED/TESTING/WON/LOST/INCONCLUSIVE/NOT_TESTED matrix:
//   1. productLearning.js's getProductLearningMemory() — the durable
//      PROVEN/PROMISING/REJECTED/STALE verdict per dimension+key, already
//      fed by BOTH Smart Decision Center's automatic H24 evaluator AND PMC's
//      manual Testing Lab. This is the highest-trust source (a real
//      completed measurement cycle) and always wins when present.
//   2. creativeIntel.js/segmentIntel.js's LIVE current-window classification
//      (already computed inside buildProductDecisionPackage() — never
//      recomputed here) — fills in dimension+key pairs durable learning
//      hasn't reached a verdict on yet.
//   3. productMarketingTests.js's real ProductMarketingTest rows (PMC's
//      Testing Lab) — covers OFFER/PRICE/COPY/MARKET_AREA dimensions the
//      AMB side has no native concept of, and always wins for the exact
//      key a human explicitly set up as a named test.
import { getProductLearningMemory, resolveProfileForProduct } from './productLearning.js';
import { listTests } from './productMarketingTests.js';

export { hasBeenTriedAndFailed } from './productMarketingTests.js';

const LIVE_CLASS_STATUS = {
  WINNER: 'WON', GOOD: 'WON',
  TESTING: 'TESTING',
  WEAK: 'LOST', FATIGUED: 'LOST',
  PROVEN_WINNER: 'WON', PROMISING: 'TESTING', PROVEN_WEAK: 'LOST',
};
function liveStatusFor(classification, sampleSize) {
  const mapped = LIVE_CLASS_STATUS[classification];
  if (mapped) return mapped;
  return sampleSize && sampleSize > 0 ? 'TESTED' : 'NOT_TESTED';
}

const LEARNING_STATE_STATUS = { PROVEN: 'WON', PROMISING: 'WON', REJECTED: 'LOST', STALE: 'TESTED' };

const PMC_TYPE_DIMENSION = { AUDIENCE: 'AUDIENCE', HOOK: 'HOOK', SELLING_ANGLE: 'ANGLE', CREATIVE: 'CREATIVE', OFFER: 'OFFER', COPY: 'CREATIVE', MARKET_AREA: 'MARKET', PRICE: 'OFFER' };
function pmcTestStatus(test) {
  if (test.status === 'PLANNED' || test.status === 'RUNNING') return 'TESTING';
  const latest = test.results?.[0];
  if (!latest) return 'INCONCLUSIVE';
  if (latest.classification === 'WINNER') return 'WON';
  if (latest.classification === 'LOSER') return 'LOST';
  return 'INCONCLUSIVE';
}

/**
 * @param {{productId:number, pkg:object}} params `pkg` = an already-built
 *   buildProductDecisionPackage() result (caller reuses one, never a second fetch).
 * @returns {Promise<{matrix: Array, hasProfile: boolean}>}
 */
export async function buildTestMatrix({ productId, pkg }) {
  const entries = new Map(); // key: `${dimension}::${key}`

  const learning = await getProductLearningMemory({ productId });
  for (const row of learning.entries) {
    entries.set(`${row.dimension}::${row.key}`, {
      dimension: row.dimension, key: row.key, status: LEARNING_STATE_STATUS[row.state] || 'TESTED',
      source: 'LEARNING_MEMORY', sampleSize: row.sampleSize, lastVerified: row.computedAt, evidence: row.evidence,
    });
  }

  const creativeDims = { creative: 'CREATIVE', hooks: 'HOOK', angles: 'ANGLE', primaryTexts: 'CREATIVE', headlines: 'CREATIVE' };
  for (const [field, dimension] of Object.entries(creativeDims)) {
    for (const row of pkg?.creativeIntel?.[field]?.table || []) {
      const mapKey = `${dimension}::${row.label}`;
      if (entries.has(mapKey)) continue; // durable learning already has the definitive verdict for this exact key
      entries.set(mapKey, {
        dimension, key: row.label, status: liveStatusFor(row.classification, row.sampleSize),
        source: 'LIVE_CREATIVE_INTEL', sampleSize: row.sampleSize, lastVerified: pkg.generatedAt,
        evidence: row.evidence, fatigueState: row.fatigueRadar?.state || null,
      });
    }
  }

  const segmentDims = { age: 'AUDIENCE', gender: 'AUDIENCE', governorates: 'MARKET' };
  for (const [field, dimension] of Object.entries(segmentDims)) {
    for (const row of pkg?.segmentIntel?.[field]?.table || []) {
      const key = row.segment;
      const mapKey = `${dimension}::${key}`;
      if (entries.has(mapKey)) continue;
      const sample = row.sampleSize ?? row.orders ?? row.purchases ?? null;
      entries.set(mapKey, { dimension, key, status: liveStatusFor(row.classification, sample), source: 'LIVE_SEGMENT_INTEL', sampleSize: sample, lastVerified: pkg.generatedAt, evidence: row.evidence });
    }
  }

  const profile = await resolveProfileForProduct(productId);
  if (profile) {
    const tests = await listTests(profile.id);
    for (const t of tests) {
      const dimension = PMC_TYPE_DIMENSION[t.test_type] || 'OFFER';
      const mapKey = `${dimension}::${t.variation}`;
      // A real, explicitly-run PMC test always wins for its own exact key — it's deliberate human-run evidence, not an inferred live signal.
      entries.set(mapKey, {
        dimension, key: t.variation, status: pmcTestStatus(t), source: 'PMC_TEST', testType: t.test_type,
        hypothesis: t.hypothesis, control: t.control, sampleSize: t.results?.[0]?.meta_purchases ?? t.results?.[0]?.orders ?? null,
        lastVerified: t.results?.[0]?.created_at || t.created_at,
      });
    }
  }

  return { matrix: [...entries.values()], hasProfile: !!profile };
}

const BOTTLENECK_TO_DIMENSION = {
  CREATIVE_PROBLEM: { dims: ['CREATIVE', 'HOOK', 'ANGLE'], note: 'الـCTR ضعيف — المشكلة في جذب الانتباه، مش في الجمهور أو العرض.' },
  CREATIVE_FATIGUE: { dims: ['CREATIVE', 'HOOK'], note: 'الكرياتيف الحالي بدأ يتعب — محتاج تدوير Hook/تنفيذ جديد على نفس الزاوية والجمهور.' },
  TRAFFIC_PROBLEM: { dims: ['AUDIENCE'], note: 'تكلفة الكليك مرتفعة — يستاهل اختبار جمهور مختلف لتقليل تكلفة الوصول.' },
  CONVERSION_PROBLEM: { dims: ['OFFER'], note: 'الـCTR كويس لكن التحويل ضعيف — المشكلة غالبًا في صفحة الهبوط أو العرض، مش في الإعلان نفسه.' },
  OFFER_PROBLEM: { dims: ['OFFER'], note: 'العرض/الفايدة الأساسية مش واضحة بما يكفي في الكرياتيف.' },
  CPA_PROBLEM: { dims: ['CREATIVE', 'AUDIENCE'], note: 'الـCPA أعلى من المستهدف — محتاج كرياتيف أو جمهور أقوى، مش بالضرورة إيقاف كل حاجة.' },
};
const NOT_MARKETING_BOTTLENECKS = new Set(['CONFIRMATION_PROBLEM', 'DELIVERY_PROBLEM', 'TRACKING_MAPPING_PROBLEM', 'INSUFFICIENT_DATA']);

/**
 * "أختبر إيه بعد كده؟" — reuses the EXISTING root-cause bottleneck
 * (`pkg.diagnosis.bottleneck.category`, computed once in productMarketingScoring.js)
 * as the sole input; never a second threshold. Explicitly refuses to
 * recommend a marketing test at all when the real bottleneck is
 * operational (COD confirmation/delivery) — matches the spec's own "do not
 * solve with a new Hook" rule.
 */
export function nextBestTest({ pkg, testMatrix }) {
  const bottleneck = pkg?.diagnosis?.bottleneck;
  const category = bottleneck?.category;
  if (!category || category === 'HEALTHY_PRODUCT') {
    if (pkg?.priceTestOpportunity?.detected) {
      return { recommendation: 'PRICE_TEST', dimensions: ['OFFER'], note: pkg.priceTestOpportunity.evidence, candidates: [] };
    }
    return { recommendation: 'NONE', dimensions: [], note: 'المنتج صحي حاليًا — مفيش اختبار عاجل مطلوب، ممكن تفكر في Scale لو الأدلة كافية.', candidates: [] };
  }
  if (NOT_MARKETING_BOTTLENECKS.has(category)) {
    return {
      recommendation: 'NOT_A_MARKETING_TEST', dimensions: [],
      note: category === 'CONFIRMATION_PROBLEM' || category === 'DELIVERY_PROBLEM'
        ? 'المشكلة في التأكيد/التسليم بعد الطلب — ده مش هيتحل بكرياتيف أو جمهور جديد، محتاج مراجعة تشغيلية (تأكيد الأوردرات/الشحن).'
        : 'البيانات المتاحة غير كافية لاقتراح اختبار موثوق حاليًا.',
      candidates: [],
    };
  }

  const mapping = BOTTLENECK_TO_DIMENSION[category];
  if (!mapping) return { recommendation: 'NONE', dimensions: [], note: 'لا يوجد اختبار محدد مقترح لهذا النوع من المشاكل حاليًا.', candidates: [] };

  // Primary mapped dimension first, TESTING (already has partial real evidence) before NOT_TESTED, higher sample first — so candidates[0] is always the single best next test, never an arbitrary array-order pick.
  const candidates = (testMatrix || [])
    .filter((e) => mapping.dims.includes(e.dimension) && (e.status === 'NOT_TESTED' || e.status === 'TESTING'))
    .sort((a, b) => mapping.dims.indexOf(a.dimension) - mapping.dims.indexOf(b.dimension) || (a.status === b.status ? 0 : a.status === 'TESTING' ? -1 : 1) || (b.sampleSize || 0) - (a.sampleSize || 0));
  return { recommendation: 'MARKETING_TEST', dimensions: mapping.dims, note: mapping.note, evidence: bottleneck.evidence, candidates };
}

/**
 * Full controlled-test structure the spec requires — never lets a proposed
 * test read as a decided fact. Every field is either a real number already
 * computed elsewhere (successMetric/evaluationWindowDays from
 * decideProductAction()) or an honest, explicitly-labeled HYPOTHESIS.
 */
export function buildControlledTestDesign({ pkg, next }) {
  if (next.recommendation !== 'MARKETING_TEST' && next.recommendation !== 'PRICE_TEST') return null;
  const candidate = next.candidates?.[0] || null;
  return {
    evidence: next.evidence || pkg?.diagnosis?.bottleneck?.evidence || null,
    hypothesis: candidate
      ? `تغيير ${candidate.dimension === 'CREATIVE' ? 'الكرياتيف' : candidate.dimension === 'HOOK' ? 'الـHook' : candidate.dimension === 'ANGLE' ? 'الزاوية' : candidate.dimension === 'AUDIENCE' ? 'الجمهور' : 'العرض'} لـ"${candidate.key}" ممكن يحسّن الأداء بناءً على المشكلة الحالية.`
      : next.note,
    variableChanged: candidate?.dimension || next.dimensions?.[0] || null,
    variablesHeldConstant: ['الميزانية', 'باقي عناصر الحملة عدا المتغيّر المختبَر'],
    control: pkg?.winners?.creative?.label || pkg?.winners?.governorate?.value || 'Broad (الوضع الحالي)',
    variant: candidate?.key || 'محتاج تنفيذ/جمهور جديد لسه متجربش',
    successMetric: pkg?.successMetric || 'CPA',
    sampleRequirement: 'على الأقل 5 مشتريات حقيقية قبل أي حكم',
    evaluationWindowDays: pkg?.evaluationWindowDays || 7,
  };
}
