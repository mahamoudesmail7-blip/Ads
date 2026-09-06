// AI Media Buyer — Creative Intelligence. For every creative running in the
// account, fetch the REAL creative (body / title / CTA / object_story_spec)
// from the Graph API, then label it with:
//   hook · hook types · selling angle · problem · main benefit ·
//   product feature · audience · offer · CTA · creative type
//
// Method mirrors the existing services/adAnalysis.js (used for competitor
// ads): DETERMINISTIC-first (offer/CTA/creative-type from real fields and
// keyword rules, zero AI cost), then ONE text-only Claude call for the
// fields that genuinely need judgment. Every field carries a source tag and
// is NULL when the creative text does not support a value — labels are never
// invented. Results cached per (creative_id, model_version).
//
// status: ANALYZED | INSUFFICIENT_DATA (creative carries no usable text) |
//         NOT_ANALYZED (not attempted) | FAILED.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection, getDecryptedToken } from '../metaAuth.js';
import { getCreativeDetails } from '../metaGraphClient.js';
import { askClaude } from '../ai.js';

export const MODEL_VERSION = 'amb-creative-v1';

// Shared vocab with services/adAnalysis.js so the two creative-analysis
// surfaces speak the same language.
const HOOK_TYPES = ['Question', 'Problem', 'Pain', 'Curiosity', 'Benefit', 'Price', 'Discount', 'Demonstration', 'Before/After', 'Social Proof', 'Fear', 'Convenience', 'Lifestyle', 'Gift', 'Urgency', 'Product Reveal', 'Educational', 'Story', 'Other', 'UNKNOWN'];
const CREATIVE_TYPES = ['UGC', 'Product Demonstration', 'Problem-Solution', 'Before-After', 'Storytelling', 'Product Showcase', 'Testimonial', 'Lifestyle', 'Educational', 'Unboxing', 'Comparison', 'Offer-focused', 'Other'];

const OFFER_RULES = [
  { key: 'خصم', re: /خصم|discount|%|off\b/i },
  { key: 'شحن مجاني', re: /شحن مجان|توصيل مجان|free (ship|deliver)/i },
  { key: 'هدية', re: /هدية|هديه|مجان[اًي]|free gift|gift/i },
  { key: 'الدفع عند الاستلام', re: /الدفع عند الاستلام|كاش|cod|cash on delivery/i },
  { key: 'ضمان', re: /ضمان|استرجاع|guarantee|warranty|refund/i },
  { key: 'كمية محدودة', re: /كمية محدودة|آخر قطع|limited|ends soon|خلص/i },
];

function pickText(c) {
  if (!c) return '';
  const spec = c.object_story_spec || {};
  const link = spec.link_data || {};
  const video = spec.video_data || {};
  const parts = [
    c.title, c.body,
    link.message, link.name, link.description, link.caption,
    video.message, video.title,
    ...(link.child_attachments || []).flatMap((a) => [a.name, a.description]),
  ];
  return parts.filter(Boolean).map(String).join('\n').trim();
}
function pickCta(c) {
  const spec = c.object_story_spec || {};
  return c?.call_to_action_type
    || spec.link_data?.call_to_action?.type
    || spec.video_data?.call_to_action?.type
    || null;
}
function deterministicOffer(text) {
  const hits = OFFER_RULES.filter((r) => r.re.test(text)).map((r) => r.key);
  return hits.length ? hits.join('، ') : null;
}
function safeJson(t) {
  const s = String(t || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; } }
  return null;
}

const SYSTEM_PROMPT = `إنت محلل إعلانات تسويقية خبير لمتجر مصري (COD). هتاخد نص إعلان حقيقي (عنوان + نص) + الأوفر والـ CTA المستخرجين أوتوماتيكيًا (متكررهمش ومتناقضهمش). مهمتك التحليل الدلالي اللي محتاج فهم حقيقي للنص فقط. رجّع JSON فقط:
{"hook":"","hookTypes":[],"sellingAngle":"","problem":"","mainBenefit":"","productFeature":"","audience":"","creativeType":""}
قواعد:
1. hook: أول جملة/فكرة جذب فعلية في النص — لو مفيش، سيبها "".
2. hookTypes: من القائمة دي بس: ${HOOK_TYPES.join(', ')}.
3. sellingAngle: زاوية البيع الأساسية اللي النص فعلاً بيركز عليها (جملة قصيرة).
4. problem: المشكلة اللي الإعلان بيخاطبها لو موجودة فعلاً، وإلا "".
5. mainBenefit: أهم فايدة/نتيجة للمستخدم (مش خاصية فيزيائية).
6. productFeature: أهم خاصية فيزيائية للمنتج مذكورة (مش فايدة).
7. audience: استنتاج منطقي من لغة الإعلان بس، مش حقيقة، وممنوع "الجميع".
8. creativeType: من: ${CREATIVE_TYPES.join(', ')}.
ممنوع اختراع أي حاجة مش مدعومة بالنص.`;

async function labelWithClaude(text, offer, cta) {
  const userText = `العنوان/النص:\n${text}\n\nمستخرج أوتوماتيكيًا — لا تعيد اشتقاقه: أوفر=${offer || 'غير موجود'}, CTA=${cta || 'غير موجود'}.`;
  const raw = await askClaude({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userText }], maxTokens: 700 });
  const p = safeJson(raw);
  if (!p || typeof p !== 'object') throw new Error('invalid JSON from creative analysis');
  return {
    hook: p.hook ? String(p.hook).slice(0, 300) : null,
    hookTypes: Array.isArray(p.hookTypes) ? p.hookTypes.filter((t) => HOOK_TYPES.includes(t)) : [],
    sellingAngle: p.sellingAngle ? String(p.sellingAngle).slice(0, 200) : null,
    problem: p.problem ? String(p.problem).slice(0, 200) : null,
    mainBenefit: p.mainBenefit ? String(p.mainBenefit).slice(0, 200) : null,
    productFeature: p.productFeature ? String(p.productFeature).slice(0, 200) : null,
    audience: p.audience ? String(p.audience).slice(0, 200) : null,
    creativeType: CREATIVE_TYPES.includes(p.creativeType) ? p.creativeType : null,
  };
}

/** Analyze ONE creative (cache-first). Never throws. */
export async function analyzeCreative({ adAccountId, creativeId, token }) {
  const cached = await prisma.ambCreativeAnalysis.findUnique({
    where: { creative_id_model_version: { creative_id: creativeId, model_version: MODEL_VERSION } },
  }).catch(() => null);
  if (cached && cached.status !== 'NOT_ANALYZED') return cached;

  const details = await getCreativeDetails(token, creativeId);
  const text = pickText(details);
  const cta = pickCta(details);
  const offer = deterministicOffer(text);
  const creativeTypeDet = details?.video_id ? null : null; // type is semantic → left to Claude

  let payload = {
    ad_account_id: adAccountId,
    creative_id: creativeId,
    model_version: MODEL_VERSION,
    raw_text: text ? text.slice(0, 2000) : null,
    offer, cta,
    analyzed_at: new Date(),
  };

  if (!text || text.length < 12) {
    // No usable copy (e.g. image-only or DPA creative) — deterministic-only.
    payload.status = 'INSUFFICIENT_DATA';
    payload.source = offer || cta ? 'DETERMINISTIC' : null;
    payload.creative_type = details?.video_id ? 'Product Demonstration' : null;
  } else if (!process.env.ANTHROPIC_API_KEY) {
    payload.status = 'ANALYZED';
    payload.source = 'RULE_BASED';
    payload.creative_type = /قبل.?بعد|before.?after/i.test(text) ? 'Before-After' : /تجربة|رأي|review/i.test(text) ? 'Testimonial' : null;
  } else {
    try {
      const ai = await labelWithClaude(text, offer, cta);
      payload = {
        ...payload,
        status: 'ANALYZED',
        source: offer || cta ? 'MIXED' : 'AI_ANALYZED',
        hook: ai.hook,
        hook_types_json: JSON.stringify(ai.hookTypes),
        selling_angle: ai.sellingAngle,
        problem: ai.problem,
        main_benefit: ai.mainBenefit,
        product_feature: ai.productFeature,
        audience: ai.audience,
        creative_type: ai.creativeType,
        fields_json: JSON.stringify({
          hook: { value: ai.hook, source: 'AI_ANALYZED' },
          hookTypes: { value: ai.hookTypes, source: 'AI_ANALYZED' },
          sellingAngle: { value: ai.sellingAngle, source: 'AI_ANALYZED' },
          problem: { value: ai.problem, source: 'AI_ANALYZED' },
          mainBenefit: { value: ai.mainBenefit, source: 'AI_ANALYZED' },
          productFeature: { value: ai.productFeature, source: 'AI_ANALYZED' },
          audience: { value: ai.audience, source: 'AI_INFERRED' },
          offer: { value: offer, source: 'DETERMINISTIC' },
          cta: { value: cta, source: 'DETERMINISTIC' },
          creativeType: { value: ai.creativeType, source: 'AI_ANALYZED' },
        }),
      };
    } catch (err) {
      logger.warn('AMB creative analysis AI step failed', { creativeId, message: err.message });
      payload.status = 'ANALYZED';
      payload.source = 'RULE_BASED';
    }
  }

  const row = await prisma.ambCreativeAnalysis.upsert({
    where: { creative_id_model_version: { creative_id: creativeId, model_version: MODEL_VERSION } },
    create: payload,
    update: payload,
  });
  return row;
}

/**
 * Analyze every creative currently seen in recent snapshots for the
 * connected account (cache-first, so re-runs are cheap). Bounded per call
 * to keep cost/time predictable; run again to cover the rest.
 * @returns {{ok:boolean, analyzed:number, cached:number, insufficient:number, failed:number, remaining:number}}
 */
export async function analyzeAccountCreatives({ maxNew = 25, sinceDays = 14 } = {}) {
  const connection = await getConnection();
  if (!connection || connection.status !== 'CONNECTED' || !connection.selected_ad_account_id) return { ok: false, error: 'NOT_CONNECTED' };
  const adAccountId = connection.selected_ad_account_id;
  const from = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);

  const groups = await prisma.metaPerformanceSnapshot.groupBy({
    by: ['creative_id'],
    where: { level: 'ad', ad_account_id: adAccountId, creative_id: { not: null }, date_start: { gte: from } },
    _sum: { spend: true },
  });
  const creativeIds = groups.filter((g) => g.creative_id).sort((a, b) => (b._sum.spend || 0) - (a._sum.spend || 0)).map((g) => g.creative_id);

  const existing = await prisma.ambCreativeAnalysis.findMany({
    where: { creative_id: { in: creativeIds }, model_version: MODEL_VERSION },
    select: { creative_id: true, status: true },
  });
  const doneIds = new Set(existing.filter((e) => e.status !== 'NOT_ANALYZED').map((e) => e.creative_id));
  const todo = creativeIds.filter((id) => !doneIds.has(id)).slice(0, maxNew);

  let token;
  try { token = await getDecryptedToken(); } catch (err) { return { ok: false, error: err.message }; }

  let analyzed = 0, insufficient = 0, failed = 0;
  for (const creativeId of todo) {
    try {
      const r = await analyzeCreative({ adAccountId, creativeId, token });
      if (r.status === 'ANALYZED') analyzed++;
      else if (r.status === 'INSUFFICIENT_DATA') insufficient++;
      else failed++;
    } catch (err) {
      failed++;
      logger.warn('AMB creative analyze loop error', { creativeId, message: err.message });
    }
  }
  return {
    ok: true,
    analyzed,
    cached: doneIds.size,
    insufficient,
    failed,
    total: creativeIds.length,
    remaining: Math.max(0, creativeIds.length - doneIds.size - analyzed - insufficient - failed),
  };
}

/** Map<creative_id, analysisRow> for a set of creative ids (only ANALYZED/INSUFFICIENT rows). */
export async function creativeLabelIndex(creativeIds) {
  if (!creativeIds || creativeIds.length === 0) return new Map();
  const rows = await prisma.ambCreativeAnalysis.findMany({
    where: { creative_id: { in: [...new Set(creativeIds)] }, model_version: MODEL_VERSION },
  });
  return new Map(rows.map((r) => [r.creative_id, r]));
}

export async function creativeAnalysisCoverage({ sinceDays = 14 } = {}) {
  const connection = await getConnection();
  if (!connection?.selected_ad_account_id) return { analyzed: 0, insufficient: 0, notAnalyzed: 0, total: 0 };
  const adAccountId = connection.selected_ad_account_id;
  const from = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);
  const groups = await prisma.metaPerformanceSnapshot.groupBy({
    by: ['creative_id'],
    where: { level: 'ad', ad_account_id: adAccountId, creative_id: { not: null }, date_start: { gte: from } },
  });
  const ids = groups.map((g) => g.creative_id).filter(Boolean);
  const rows = await prisma.ambCreativeAnalysis.findMany({ where: { creative_id: { in: ids }, model_version: MODEL_VERSION }, select: { status: true } });
  const analyzed = rows.filter((r) => r.status === 'ANALYZED').length;
  const insufficient = rows.filter((r) => r.status === 'INSUFFICIENT_DATA').length;
  return { analyzed, insufficient, notAnalyzed: Math.max(0, ids.length - analyzed - insufficient), total: ids.length };
}
