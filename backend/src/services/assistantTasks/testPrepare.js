// AI Media Buyer Operator — Phase 3 Slice 3 (Testing Brain). Prepare logic
// for "اعمل الاختبار المقترح" — a controlled AUDIENCE or GEO test that holds
// the product's current best creative CONSTANT (via the same zero-upload
// reuse scalePrepare.js already built) and varies ONLY the targeting
// dimension being tested, matching the Testing Brain's own "never change
// everything at once" controlled-design requirement. CREATIVE-dimension
// tests are deliberately NOT supported yet — a real creative test needs a
// genuinely NEW creative asset, which needs the Creative Brief/generation
// work (a later slice), not just a differently-targeted reuse of the
// existing winner.
//
// SECURITY BOUNDARY (same as scalePrepare.js): never calls
// persistProductDecision/approveProductDecision/executeApprovedDecision —
// only read-only functions, then the safe createDraftJob().
import { prisma } from '../../prisma.js';
import { buildProductDecisionPackage } from '../amb/productDecision.js';
import { getAmbSettings } from '../amb/settings.js';
import { parseMetaAgeBucket, GENDER_TO_META } from '../amb/productDecisionExecution.js';
import { resolveMultiGeoTargeting } from './launchCampaignPrepare.js';
import { hasBeenTriedAndFailed } from '../amb/testingBrain.js';

/** AUDIENCE testValue parsing — reuses the SAME age-bucket/gender vocabulary Meta audience breakdowns and resolveRealTargeting() already use. Never guesses a shape it doesn't recognize. */
export function parseAudienceTestValue(testValue) {
  const ageRange = parseMetaAgeBucket(testValue);
  if (ageRange) return { mode: 'AGE', ...ageRange };
  const gender = GENDER_TO_META[testValue];
  if (gender) return { mode: 'GENDER', gender };
  return null;
}

/**
 * Real read-only bundle a test prepare needs: the current best creative to
 * hold constant (same field as Slice 3's winning-stack), plus a duplicate-
 * test check against the durable learning memory (never re-propose a test
 * that has already concluded DOES_NOT_WORK for this exact dimension+key).
 */
export async function loadTestContext({ productId, adAccountId, testDimension, testValue }) {
  const settings = await getAmbSettings();
  const pkg = await buildProductDecisionPackage({ productId: Number(productId), windowName: undefined, settings, adAccountId });
  if (!pkg.winners?.creative) {
    return { ok: false, message: `المنتج "${pkg.productName}" لسه مفيش كرياتيف حقيقي بأداء كافٍ نبني عليه اختبار — محتاج بيانات إعلانات حقيقية أولاً.` };
  }
  const learningDimension = testDimension === 'GEO' ? 'MARKET' : 'AUDIENCE';
  const profile = await prisma.productMarketingProfile.findFirst({ where: { product_id: Number(productId) }, select: { id: true } });
  if (profile) {
    const alreadyFailed = await hasBeenTriedAndFailed(profile.id, learningDimension, testValue);
    if (alreadyFailed) {
      return { ok: false, message: `الاختبار ده ("${testValue}") اتجرب قبل كده وفشل (DOES_NOT_WORK) — إعادة نفس الاختبار من غير دليل جديد مش موصى بيه.` };
    }
  }

  const creativeIdRaw = pkg.winners.creative.id;
  const creativeAssetId = typeof creativeIdRaw === 'string' && creativeIdRaw.startsWith('asset:') ? Number(creativeIdRaw.slice('asset:'.length)) : null;
  return {
    ok: true,
    productName: pkg.productName,
    controlCreativeLabel: pkg.winners.creative.label || null,
    creativeAssetId: Number.isInteger(creativeAssetId) && creativeAssetId > 0 ? creativeAssetId : null,
    successMetric: pkg.successMetric || 'CPA',
    evaluationWindowDays: pkg.evaluationWindowDays || 7,
  };
}
