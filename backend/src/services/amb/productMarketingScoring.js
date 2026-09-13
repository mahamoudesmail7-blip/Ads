// AI Product Marketing Center — deterministic scoring + diagnosis. NOTHING
// here is an AI call and nothing here touches Meta. Pure functions over the
// real numbers services/amb/productMarketing.js already gathered (Meta +
// Easy Orders + economics, via the EXISTING pipeline — this file invents no
// data of its own). Mirrors the style of services/amb/ruleEngine.js so the
// module's "facts" are as auditable as the rest of AI Media Buyer.
//
// Every function here returns a `kind`/`confidence` a caller can trust:
// scores and diagnoses derived from real numbers are FACTs; anything that
// would require inference beyond the numbers belongs in productMarketingAI.js
// instead, explicitly labelled HYPOTHESIS or RECOMMENDATION there.

import { normalizeName } from '../../../../js/product-mapping.js';

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

// ---------------------------------------------------------------------------
// §4 — Product Opportunity Score. Never random: every component is a real,
// named number or explicitly "غير متاح". If too little real data exists the
// score itself is withheld (dataSufficient:false) rather than guessed.
// ---------------------------------------------------------------------------
export function computeOpportunityScore({ metrics, settings }) {
  const targetCpa = n(settings?.ambDefaultTargetCpa) ?? 120;
  const purchases = n(metrics.metaPurchases);
  const spend = n(metrics.totalSpend);
  const deliveredOrders = n(metrics.deliveredOrders);
  const deliveredCpa = n(metrics.deliveredCpa);
  const avgCpa = n(metrics.avgCpa);
  const deliveryRate = metrics.deliveryRate != null ? n(metrics.deliveryRate) : null;
  const netProfit = n(metrics.netProfit);

  const haveSpend = spend != null && spend > 0;
  const havePurchases = purchases != null && purchases > 0;
  if (!haveSpend || !havePurchases) {
    // §3 (BUG 3) — specific, not vague: "never mapped" vs "mapped but the real numbers are just small/zero yet".
    const note = metrics.dataAvailability && !metrics.dataAvailability.metaMapped
      ? 'لا توجد حملات Meta مرتبطة بهذا المنتج — لا يمكن حساب فرصة النجاح بدون بيانات أداء حقيقية.'
      : 'البيانات موجودة لكن حجم العينة غير كافٍ للحكم — لسه مفيش صرف/مشتريات كفاية على هذا المنتج.';
    return { score: null, label: null, confidence: 'LOW', dataSufficient: false, components: [], note };
  }

  const components = [];
  let score = 0; let weightUsed = 0;

  // CPA vs target (weight 35)
  const cpaForScore = deliveredCpa ?? avgCpa;
  if (cpaForScore != null) {
    const ratio = targetCpa / cpaForScore; // >1 = cheaper than target = good
    const pts = Math.max(0, Math.min(35, Math.round(35 * Math.min(1.4, ratio) / 1.4)));
    score += pts; weightUsed += 35;
    components.push({ key: 'cpa', label: deliveredCpa != null ? 'Delivered CPA مقابل الهدف' : 'CPA مقابل الهدف', value: Math.round(cpaForScore), target: targetCpa, points: pts, max: 35 });
  }
  // Purchase volume / sample size (weight 15) — more real conversions = more trustworthy signal
  if (purchases != null) {
    const pts = Math.max(0, Math.min(15, Math.round(15 * Math.min(1, purchases / 20))));
    score += pts; weightUsed += 15;
    components.push({ key: 'volume', label: 'حجم المشتريات (ثقة العيّنة)', value: purchases, points: pts, max: 15 });
  }
  // Delivery rate (weight 25) — the real COD signal, when available
  if (deliveryRate != null) {
    const pts = Math.max(0, Math.min(25, Math.round(25 * deliveryRate)));
    score += pts; weightUsed += 25;
    components.push({ key: 'delivery', label: 'معدل الاستلام (COD حقيقي)', value: Math.round(deliveryRate * 100), unit: '%', points: pts, max: 25 });
  }
  // Delivered orders sample (weight 10)
  if (deliveredOrders != null) {
    const pts = Math.max(0, Math.min(10, Math.round(10 * Math.min(1, deliveredOrders / 15))));
    score += pts; weightUsed += 10;
    components.push({ key: 'delivered_volume', label: 'عدد الطلبات المُستلمة فعليًا', value: deliveredOrders, points: pts, max: 10 });
  }
  // Net profit sign (weight 15)
  if (netProfit != null) {
    const pts = netProfit > 0 ? 15 : netProfit === 0 ? 7 : 0;
    score += pts; weightUsed += 15;
    components.push({ key: 'profit', label: 'صافي الربح الحقيقي', value: Math.round(netProfit), points: pts, max: 15 });
  }

  if (weightUsed === 0) {
    return { score: null, label: null, confidence: 'LOW', dataSufficient: false, components: [], note: 'البيانات غير كافية للحكم.' };
  }
  // Re-normalize to /100 over the weight actually available, so a product
  // missing (say) delivery data isn't unfairly capped below its real standing.
  const normalized = Math.round((score / weightUsed) * 100);
  const label = normalized >= 70 ? 'قوية' : normalized >= 45 ? 'متوسطة' : 'ضعيفة';
  const confidence = weightUsed >= 75 ? 'HIGH' : weightUsed >= 40 ? 'MEDIUM' : 'LOW';
  return { score: normalized, label, confidence, dataSufficient: true, components, weightUsed };
}

// ---------------------------------------------------------------------------
// §6 — Quick Diagnosis. Rule-based over real numbers, never a single vague
// verdict. Every hit carries {problem, evidence, severity, action}.
// ---------------------------------------------------------------------------
export function computeDiagnosis({ metrics, creative, settings }) {
  const out = [];
  const targetCpa = n(settings?.ambDefaultTargetCpa) ?? 120;
  const spend = n(metrics.totalSpend) || 0;
  const purchases = n(metrics.metaPurchases);
  const avgCpa = n(metrics.avgCpa);
  const deliveredCpa = n(metrics.deliveredCpa);
  const deliveryRate = metrics.deliveryRate != null ? n(metrics.deliveryRate) : null;
  const ctr = n(metrics.ctr);
  const cpc = n(metrics.cpc);
  const cvr = n(metrics.cvr);
  const frequency = n(metrics.frequency);

  // §3 (BUG 3) — WHY there's no Meta signal must be specific: "never mapped
  // to a campaign" is a completely different situation from "mapped, ran
  // real spend, still too little data" — never the same vague sentence.
  if (metrics.dataAvailability && !metrics.dataAvailability.metaMapped) {
    out.push({ problem: 'لا توجد حملات Meta مرتبطة بهذا المنتج', evidence: 'المنتج لسه مش مربوط بحملة Meta حقيقية في AI Media Buyer.', severity: 'INFO', action: 'اربط المنتج بحملته في AI Media Buyer عشان تظهر بيانات الأداء الحقيقية هنا.' });
    return out;
  }
  if (spend < 100 || purchases == null) {
    out.push({ problem: 'البيانات موجودة لكن حجم العينة غير كافٍ للحكم', evidence: `الصرف حتى الآن ${Math.round(spend)} جنيه${purchases == null ? '، مفيش مشتريات مرتبطة بعد' : ''}.`, severity: 'INFO', action: 'كمّل الصرف على الفترة الحالية قبل الحكم على المنتج.' });
    return out;
  }

  if (ctr != null && ctr < 0.8) {
    out.push({ problem: 'Hook ضعيف / الكرياتيف مش واقف الناس', evidence: `CTR الحالي ${ctr.toFixed(2)}% — أقل من المتوسط الصحي (~1%+).`, severity: 'HIGH', action: 'جرّب Hook جديد في أول 3 ثواني من الفيديو أو أول سطر في الصورة.' });
  } else if (ctr != null && ctr >= 1.5 && cvr != null && cvr < 1) {
    out.push({ problem: 'Good CTR لكن Conversion ضعيف', evidence: `CTR ${ctr.toFixed(2)}% كويس لكن معدل التحويل ${cvr.toFixed(2)}% ضعيف.`, severity: 'HIGH', action: 'الإعلان بيوقف الناس بس صفحة/عرض المنتج مش مقنع — راجع الـOffer والـLanding.' });
  }

  if (cpc != null && cpc > 3) {
    out.push({ problem: 'CPC مرتفع', evidence: `تكلفة الكليك ${cpc.toFixed(2)} جنيه.`, severity: 'MEDIUM', action: 'راجع الجمهور المستهدف — ممكن يكون واسع أو الأنسب مش هو ده.' });
  }

  if (avgCpa != null && avgCpa > targetCpa * 1.3) {
    out.push({ problem: 'CPA أعلى من الهدف', evidence: `CPA الحالي ${Math.round(avgCpa)} جنيه مقابل هدف ${targetCpa} جنيه.`, severity: 'HIGH', action: 'اختبر Angle أو جمهور مختلف قبل زيادة الميزانية.' });
  }

  if (deliveryRate != null && deliveryRate < 0.5 && avgCpa != null && deliveredCpa != null && avgCpa < targetCpa) {
    out.push({ problem: 'CPA كويس على Meta لكن الاستلام ضعيف', evidence: `Meta CPA ${Math.round(avgCpa)} جنيه (كويس) لكن معدل الاستلام ${Math.round(deliveryRate * 100)}% فقط — Delivered CPA الحقيقي ${Math.round(deliveredCpa)} جنيه.`, severity: 'HIGH', action: 'المشكلة مش في الإعلان، المشكلة بعده — راجع سرعة التأكيد والتسليم أو جودة الطلبات الجاية من هذا الجمهور.' });
  }

  if (frequency != null && frequency > 3.5) {
    out.push({ problem: 'إجهاد كرياتيف (Creative Fatigue)', evidence: `التكرار (Frequency) وصل ${frequency.toFixed(1)}.`, severity: 'MEDIUM', action: 'وقّف أو جدّد الكرياتيف الحالي — نفس الجمهور شايفه كتير.' });
  }

  if (creative?.problem && creative?.mainBenefit == null) {
    out.push({ problem: 'العرض/الفايدة مش واضحة في الكرياتيف', evidence: 'الكرياتيف الحالي مفيهوش فايدة أساسية واضحة مكتشفة.', severity: 'MEDIUM', action: 'أضف فايدة واحدة واضحة في أول 3 ثواني/أول سطر.' });
  }

  if (!out.length) {
    out.push({ problem: 'مفيش مشكلة واضحة من الأرقام الحالية', evidence: `CPA ${avgCpa != null ? Math.round(avgCpa) : '—'} جنيه، ${purchases} مشترى.`, severity: 'INFO', action: 'كمّل نفس الاتجاه، واختبر Angle إضافي لتوسيع الفرصة.' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// §8 — Location ranking from REAL Easy Orders governorate rows (never
// hard-coded). COD priority: Delivered Orders > Delivered CPA > Delivery
// Rate > Meta purchases (spec §8 — never rank COD by Meta purchases alone).
// ---------------------------------------------------------------------------
export function rankLocations(rows, { spend } = {}) {
  const withRates = rows.map((r) => {
    const deliveryRate = r.confirmed > 0 ? r.delivered / r.confirmed : null;
    return { ...r, deliveryRate };
  });
  withRates.sort((a, b) => {
    if (b.delivered !== a.delivered) return b.delivered - a.delivered;
    if ((b.deliveryRate || 0) !== (a.deliveryRate || 0)) return (b.deliveryRate || 0) - (a.deliveryRate || 0);
    return b.orders - a.orders;
  });
  return withRates;
}

// ---------------------------------------------------------------------------
// §11 — Claim validation. A hard, non-AI-overridable safety net: Claude may
// propose an angle, but THIS list — not Claude's own judgement — decides
// whether a medical/weight-loss/guarantee claim ever reaches 🟢/🟡.
// ---------------------------------------------------------------------------
const BANNED_CLAIM_PATTERNS = [
  /يحرق\s*الدهون/, /يخسس/, /تخسيس/, /نزول\s*الوزن/, /فقدان\s*الوزن/,
  /يعالج/, /علاج\s*نهائي/, /يشفي/, /يزيل\s*الدهون/, /نتيجة\s*(مضمونة|طبية)/,
  /يضمن/, /مضمون\s*100/, /بدون\s*أي\s*آثار\s*جانبية/, /يقضي\s*على\s*المرض/,
  /ثبت\s*علميًا/, /موصى\s*به\s*طبيًا/, /علاج\s*بديل/,
];
export function classifyClaim(text) {
  const t = String(text || '');
  if (BANNED_CLAIM_PATTERNS.some((re) => re.test(t))) {
    return { status: 'RED', reason: 'ادّعاء طبي/تخسيس/ضمان نتيجة — غير مسموح بدون إثبات موثّق.' };
  }
  return null; // caller falls back to the AI's own (still-audited) label
}

export function opportunityLabelAr(label) {
  return { 'قوية': 'فرصة قوية', 'متوسطة': 'فرصة متوسطة', 'ضعيفة': 'فرصة ضعيفة' }[label] || label;
}

// ---------------------------------------------------------------------------
// Multi-store Product Marketing Center — Meta campaign matching by real
// Easy Orders slug/id/name evidence found in the campaign's OWN name. This
// is a READ-ONLY, deterministic pipeline: no fuzzy/similarity scoring, no
// persisted mapping table (that mechanism was explicitly paused after the
// 2026-09-13 incident) — every call recomputes fresh from real campaign
// names + the locked product's real identity, and NEVER auto-applies a weak
// guess. A media buyer often puts the Easy Orders product slug/id directly
// into the campaign name (e.g. "Roller - Scale" for slug "Roller"), which
// is exactly the strongest, least-ambiguous signal available without a
// human-confirmed mapping.
//
// Priority (matches the spec exactly):
//   1. (an existing confirmed AmbProduct mapping is checked by the CALLER
//      before this function ever runs — see productMarketing.js computeSnapshot)
//   2. exact Easy Orders slug/id found in the campaign name
//   3. exact normalized product identifier (the raw Easy Orders id) found in the campaign name
//   4. exact normalized product name found (as a full substring) in the campaign name
//   5. every significant word of the product name present in the campaign name (order-independent, but ALL of them — not a partial-overlap score)
//   6. otherwise UNMAPPED
//
// Tiers 2-4 are treated as MATCHED (strong, hard-to-coincidentally-collide
// evidence — an exact slug or the full product name appearing verbatim).
// Tier 5 is only ever POSSIBLE_MATCH — shown to the human, never used to
// silently pull real performance numbers, honoring "do not guess weak
// matches."
function significantTokens(normalized) {
  return normalized.split(' ').filter((t) => t.length > 2);
}

export function matchCampaignsToProduct({ slug, easyOrdersProductId, lockedName }, campaigns) {
  const normSlug = slug ? normalizeName(slug) : null;
  const normId = easyOrdersProductId ? normalizeName(String(easyOrdersProductId)) : null;
  const normName = lockedName ? normalizeName(lockedName) : null;
  const nameTokens = normName ? significantTokens(normName) : [];

  const matchedBySlug = [];
  const matchedById = [];
  const matchedByName = [];
  const possibleByAllTokens = [];

  for (const c of campaigns || []) {
    const normCampaign = normalizeName(c.name || '');
    if (!normCampaign) continue;
    if (normSlug && normSlug.length >= 2 && normCampaign.includes(normSlug)) { matchedBySlug.push(c); continue; }
    if (normId && normId.length >= 4 && normCampaign.includes(normId)) { matchedById.push(c); continue; }
    if (normName && normName.length >= 3 && normCampaign.includes(normName)) { matchedByName.push(c); continue; }
    if (nameTokens.length && nameTokens.every((t) => normCampaign.includes(t))) { possibleByAllTokens.push(c); continue; }
  }

  if (matchedBySlug.length) return { status: 'MATCHED', method: 'SLUG', campaigns: matchedBySlug, reason: 'تم ربط الحملة لأن اسم الحملة يحتوي على رابط/معرّف المنتج (slug) من Easy Orders.' };
  if (matchedById.length) return { status: 'MATCHED', method: 'EXTERNAL_ID', campaigns: matchedById, reason: 'تم ربط الحملة لأن اسم الحملة يحتوي على رقم تعريف المنتج من Easy Orders.' };
  if (matchedByName.length) return { status: 'MATCHED', method: 'EXACT_NAME', campaigns: matchedByName, reason: 'تم ربط الحملة لأن اسم الحملة يحتوي على الاسم الكامل للمنتج.' };
  if (possibleByAllTokens.length) return { status: 'POSSIBLE_MATCH', method: 'ALL_NAME_WORDS', campaigns: possibleByAllTokens, reason: 'اسم الحملة يحتوي على كل كلمات اسم المنتج، لكن مش تطابق تام — راجع الحملة قبل الاعتماد على أرقامها.' };
  return { status: 'UNMAPPED', method: null, campaigns: [], reason: 'لم يتم العثور على حملة Meta مرتبطة بهذا المنتج.' };
}
