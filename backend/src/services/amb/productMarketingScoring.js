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
export function computeDiagnosis({ metrics, creative, priorMetrics, settings }) {
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
  const ds = dataSufficiencyOf({ spend, purchases });

  // §3 (BUG 3) — WHY there's no Meta signal must be specific: "never mapped
  // to a campaign" is a completely different situation from "mapped, ran
  // real spend, still too little data" — never the same vague sentence.
  if (metrics.dataAvailability && !metrics.dataAvailability.metaMapped) {
    out.push({ problem: 'لا توجد حملات Meta مرتبطة بهذا المنتج', evidence: 'المنتج لسه مش مربوط بحملة Meta حقيقية في AI Media Buyer.', severity: 'INFO', category: 'TRACKING_MAPPING_PROBLEM', priority: 'P3', dataSufficiency: 'INSUFFICIENT', action: 'اربط المنتج بحملته في AI Media Buyer عشان تظهر بيانات الأداء الحقيقية هنا.' });
    return out;
  }
  if (spend < 100 || purchases == null) {
    out.push({ problem: 'البيانات موجودة لكن حجم العينة غير كافٍ للحكم', evidence: `الصرف حتى الآن ${Math.round(spend)} جنيه${purchases == null ? '، مفيش مشتريات مرتبطة بعد' : ''}.`, severity: 'INFO', category: 'INSUFFICIENT_DATA', priority: 'P3', dataSufficiency: 'INSUFFICIENT', action: 'كمّل الصرف على الفترة الحالية قبل الحكم على المنتج.' });
    return out;
  }

  if (ctr != null && ctr < 0.8) {
    out.push({ problem: 'Hook ضعيف / الكرياتيف مش واقف الناس', evidence: `CTR الحالي ${ctr.toFixed(2)}% — أقل من المتوسط الصحي (~1%+).`, severity: 'HIGH', category: 'CREATIVE_PROBLEM', priority: 'P1', dataSufficiency: ds, action: 'جرّب Hook جديد في أول 3 ثواني من الفيديو أو أول سطر في الصورة.' });
  } else if (ctr != null && ctr >= 1.5 && cvr != null && cvr < 1) {
    out.push({ problem: 'Good CTR لكن Conversion ضعيف', evidence: `CTR ${ctr.toFixed(2)}% كويس لكن معدل التحويل ${cvr.toFixed(2)}% ضعيف.`, severity: 'HIGH', category: 'CONVERSION_PROBLEM', priority: 'P1', dataSufficiency: ds, action: 'الإعلان بيوقف الناس بس صفحة/عرض المنتج مش مقنع — راجع الـOffer والـLanding.' });
  }

  if (cpc != null && cpc > 3) {
    out.push({ problem: 'CPC مرتفع', evidence: `تكلفة الكليك ${cpc.toFixed(2)} جنيه.`, severity: 'MEDIUM', category: 'TRAFFIC_PROBLEM', priority: 'P2', dataSufficiency: ds, action: 'راجع الجمهور المستهدف — ممكن يكون واسع أو الأنسب مش هو ده.' });
  }

  if (avgCpa != null && avgCpa > targetCpa * 1.3) {
    out.push({ problem: 'CPA أعلى من الهدف', evidence: `CPA الحالي ${Math.round(avgCpa)} جنيه مقابل هدف ${targetCpa} جنيه.`, severity: 'HIGH', category: 'CPA_PROBLEM', priority: 'P0', dataSufficiency: ds, action: 'اختبر Angle أو جمهور مختلف قبل زيادة الميزانية.' });
  }

  // Confirmation stage (BEFORE delivery in the real funnel — an order must
  // be confirmed before it can ever be delivered). Deliberately conservative:
  // a low confirmation rate is at least as likely to mean "these orders are
  // simply too recent to have been called yet" as a genuine call-center
  // backlog — this codebase has no per-order age breakdown at this
  // aggregate level to tell the two apart. Gated on a real sample (never a
  // tiny handful of orders) and reported at MEDIUM (never HIGH) severity so
  // diagnoseFunnelBottleneck() can never mark it CONFIRMED from ambiguous
  // evidence — always at most LIKELY, explicitly inviting a closer look
  // rather than asserting a firm conclusion.
  const codSample = n(metrics.codSample);
  const confirmationRate = metrics.confirmationRate != null ? n(metrics.confirmationRate) : null;
  if (confirmationRate != null && codSample != null && codSample >= 20 && confirmationRate < 0.2) {
    out.push({ problem: 'نسبة كبيرة من أوردرات Easy Orders لسه معلّقة (PENDING) ومتأكدتش', evidence: `معدل التأكيد ${(confirmationRate * 100).toFixed(1)}% فقط من ${codSample} أوردر حقيقي — ممكن يكون تراكم في التأكيد، أو ببساطة أوردرات حديثة لسه محتاجة وقت لحد ما يتصل بيها. راجع توزيع تاريخ الأوردرات قبل الحكم النهائي.`, severity: 'MEDIUM', category: 'CONFIRMATION_PROBLEM', priority: 'P1', dataSufficiency: ds, action: 'راجع سرعة اتصال فريق تأكيد الأوردرات، وتأكد إن الأوردرات القديمة (أكتر من كام يوم) مش هي المتراكمة.' });
  }

  if (deliveryRate != null && deliveryRate < 0.5 && avgCpa != null && deliveredCpa != null && avgCpa < targetCpa) {
    out.push({ problem: 'CPA كويس على Meta لكن الاستلام ضعيف', evidence: `Meta CPA ${Math.round(avgCpa)} جنيه (كويس) لكن معدل الاستلام ${Math.round(deliveryRate * 100)}% فقط — Delivered CPA الحقيقي ${Math.round(deliveredCpa)} جنيه.`, severity: 'HIGH', category: 'DELIVERY_PROBLEM', priority: 'P0', dataSufficiency: ds, action: 'المشكلة مش في الإعلان، المشكلة بعده — راجع سرعة التأكيد والتسليم أو جودة الطلبات الجاية من هذا الجمهور.' });
  }

  if (frequency != null && frequency > 3.5) {
    // §11 — never call fatigue from one signal alone. Require a second
    // corroborating trend (CTR declining or CPA rising) vs the prior equal
    // window when available; otherwise still surface it but at LOW
    // confidence via a WEAK dataSufficiency override, never silently upgraded.
    let corroborated = null; // null = no prior window to compare
    if (priorMetrics) {
      const priorCtr = n(priorMetrics.ctr);
      const priorCpa = n(priorMetrics.avgCpa);
      const ctrDeclining = ctr != null && priorCtr != null && ctr < priorCtr * 0.9;
      const cpaRising = avgCpa != null && priorCpa != null && avgCpa > priorCpa * 1.15;
      corroborated = ctrDeclining || cpaRising;
    }
    if (corroborated !== false) {
      out.push({
        problem: 'إجهاد كرياتيف (Creative Fatigue)',
        evidence: `التكرار (Frequency) وصل ${frequency.toFixed(1)}.${corroborated === true ? ' + انخفاض CTR أو ارتفاع CPA مقارنة بالفترة السابقة يؤكد الإجهاد.' : corroborated === null ? ' (لا توجد فترة سابقة للمقارنة — إشارة واحدة فقط)' : ''}`,
        severity: 'MEDIUM', category: 'CREATIVE_FATIGUE', priority: 'P2',
        dataSufficiency: corroborated === true ? ds : 'WEAK',
        action: 'وقّف أو جدّد الكرياتيف الحالي — نفس الجمهور شايفه كتير.',
      });
    }
  }

  if (creative?.problem && creative?.mainBenefit == null) {
    out.push({ problem: 'العرض/الفايدة مش واضحة في الكرياتيف', evidence: 'الكرياتيف الحالي مفيهوش فايدة أساسية واضحة مكتشفة.', severity: 'MEDIUM', category: 'OFFER_PROBLEM', priority: 'P2', dataSufficiency: ds, action: 'أضف فايدة واحدة واضحة في أول 3 ثواني/أول سطر.' });
  }

  if (!out.length) {
    out.push({ problem: 'مفيش مشكلة واضحة من الأرقام الحالية', evidence: `CPA ${avgCpa != null ? Math.round(avgCpa) : '—'} جنيه، ${purchases} مشترى.`, severity: 'INFO', category: 'HEALTHY_PRODUCT', priority: 'P3', dataSufficiency: ds, action: 'كمّل نفس الاتجاه، واختبر Angle إضافي لتوسيع الفرصة.' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Smart Decision Center Phase 5 — Full Funnel Diagnosis Engine. Does NOT
// re-derive any threshold — computeDiagnosis() above already evaluates
// every real funnel signal (CTR/CPC/CVR/CPA/delivery/fatigue) with numbers
// already reviewed and tested. This is purely a PRIORITIZATION layer on top
// of its output: when multiple problems fire at once (common — a weak hook
// often ALSO shows up as a high CPA), the true root cause is usually the
// one earliest in the funnel (CPM -> CTR -> CPC -> Conversion -> CPA ->
// Confirmation -> Delivery -> Revenue/Profit), since an early failure
// naturally produces every later symptom. CPM itself is reported as
// context only — this codebase has no reviewed "bad CPM" threshold (CPM
// alone, with no competitor/historical baseline, can't be honestly judged
// good or bad), so it is never used to pick or block a verdict.
// ---------------------------------------------------------------------------
const FUNNEL_STAGE_ORDER = {
  TRACKING_MAPPING_PROBLEM: 0,
  INSUFFICIENT_DATA: 0,
  CREATIVE_PROBLEM: 1,      // CTR — attention/hook stage
  CREATIVE_FATIGUE: 1.5,    // a fading hook degrades attention over time — same funnel depth as CTR, checked second
  TRAFFIC_PROBLEM: 2,       // CPC — traffic cost/quality stage
  CONVERSION_PROBLEM: 3,    // CTR healthy but conversion weak — landing/offer stage
  OFFER_PROBLEM: 3,         // the offer IS the conversion lever — same funnel depth
  CPA_PROBLEM: 4,           // overall CPA vs target — downstream of the above
  CONFIRMATION_PROBLEM: 4.5, // real Easy Orders confirmation — after CPA, before delivery
  DELIVERY_PROBLEM: 5,      // post-Meta — delivery stage, after confirmation
  HEALTHY_PRODUCT: 99,
};

/**
 * Names ONE actual bottleneck from computeDiagnosis()'s own output (never
 * re-derives the underlying evidence) plus an honest funnel trace for
 * context. confidence is CONFIRMED only for a HIGH-severity, STRONG-sample
 * signal; a real but thinner signal is LICLY; no real signal at all (or an
 * upstream tracking/insufficient-data gate) is INSUFFICIENT_DATA — never
 * guessed as confirmed from a weak sample; CONFIRMED requires HIGH severity
 * + a STRONG sample, otherwise a real signal is only ever LIKELY.
 * @param {Array} diagnosisList - computeDiagnosis()'s own return value
 * @param {object} metrics - the SAME metrics object passed into computeDiagnosis() (for the funnel trace)
 */
export function diagnoseFunnelBottleneck(diagnosisList, metrics = {}) {
  const funnelTrace = {
    cpm: n(metrics.cpm), ctr: n(metrics.ctr), cpc: n(metrics.cpc),
    conversionRate: n(metrics.cvr), cpa: n(metrics.avgCpa),
    confirmationRate: metrics.confirmationRate != null ? n(metrics.confirmationRate) : null,
    deliveryRate: metrics.deliveryRate != null ? n(metrics.deliveryRate) : null,
    revenue: metrics.revenue != null ? n(metrics.revenue) : null,
    netProfit: metrics.netProfit != null ? n(metrics.netProfit) : null,
  };

  if (!diagnosisList?.length) {
    return { bottleneck: null, category: null, confidence: 'INSUFFICIENT_DATA', evidence: null, reason: 'مفيش بيانات كافية للتشخيص.', competingSignals: [], funnelTrace };
  }

  const gateCategories = ['TRACKING_MAPPING_PROBLEM', 'INSUFFICIENT_DATA'];
  const gated = diagnosisList.find((d) => gateCategories.includes(d.category));
  if (gated) {
    return { bottleneck: null, category: gated.category, confidence: 'INSUFFICIENT_DATA', evidence: gated.evidence, reason: gated.problem, competingSignals: [], funnelTrace };
  }

  const real = diagnosisList.filter((d) => d.category !== 'HEALTHY_PRODUCT');
  if (!real.length) {
    const healthy = diagnosisList[0];
    return { bottleneck: null, category: 'HEALTHY_PRODUCT', confidence: healthy.dataSufficiency === 'STRONG' ? 'CONFIRMED' : 'LIKELY', evidence: healthy.evidence, reason: healthy.problem, competingSignals: [], funnelTrace };
  }

  const sorted = [...real].sort((a, b) => (FUNNEL_STAGE_ORDER[a.category] ?? 50) - (FUNNEL_STAGE_ORDER[b.category] ?? 50));
  const primary = sorted[0];
  const confidence = primary.dataSufficiency === 'STRONG' && primary.severity === 'HIGH' ? 'CONFIRMED'
    : primary.dataSufficiency === 'INSUFFICIENT' ? 'INSUFFICIENT_DATA'
    : 'LIKELY';

  return {
    bottleneck: primary.problem,
    category: primary.category,
    confidence,
    evidence: primary.evidence,
    action: primary.action,
    severity: primary.severity,
    competingSignals: sorted.slice(1).map((d) => ({ problem: d.problem, category: d.category, severity: d.severity, evidence: d.evidence })),
    funnelTrace,
  };
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
// Phase 1 — Health Score band. Pure banding over computeOpportunityScore()'s
// existing score; invents no new signal. INSUFFICIENT_DATA whenever the
// underlying score itself was withheld (dataSufficient:false).
// ---------------------------------------------------------------------------
export function healthBand(score, dataSufficient) {
  if (!dataSufficient || score == null) return 'INSUFFICIENT_DATA';
  if (score >= 85) return 'HEALTHY';
  if (score >= 70) return 'GOOD';
  if (score >= 50) return 'NEEDS_ATTENTION';
  if (score >= 30) return 'AT_RISK';
  return 'CRITICAL';
}

// ---------------------------------------------------------------------------
// Phase 1 — deterministic dataSufficiency bucketing, matching the exact
// thresholds hierarchyAnalysis.js's rollupMetrics()/winnerDetection.js
// already use elsewhere (spend>=300 & purchases>=5 = STRONG, spend>=150 =
// MODERATE, else WEAK) — one shared rule, not a second invented scale.
// ---------------------------------------------------------------------------
export function dataSufficiencyOf({ spend, purchases }) {
  const s = n(spend) || 0;
  const p = n(purchases) || 0;
  if (s >= 300 && p >= 5) return 'STRONG';
  if (s >= 150) return 'MODERATE';
  return 'WEAK';
}

// ---------------------------------------------------------------------------
// Phase 1 — Markets & Areas banding. Real Easy Orders governorate numbers
// only; never ranks by order count alone (spec §6).
// ---------------------------------------------------------------------------
export function bandMarket({ orders, delivered, confirmed, deliveryRate, confirmationRate }, { minOrders = 10 } = {}) {
  const o = n(orders) || 0;
  if (o < minOrders) return 'INSUFFICIENT_DATA';
  const dr = deliveryRate != null ? n(deliveryRate) : (confirmed > 0 ? n(delivered) / n(confirmed) : null);
  const cr = confirmationRate != null ? n(confirmationRate) : null;
  if (dr != null && dr < 0.35) return 'REDUCE_PRIORITY'; // high RTO signal
  if (dr != null && dr >= 0.6 && o >= minOrders * 2) return 'SCALE_MARKET';
  if (dr != null && dr >= 0.45) return 'KEEP_TESTING';
  if (cr != null && cr < 0.3) return 'REDUCE_PRIORITY';
  return 'MONITOR';
}

// ---------------------------------------------------------------------------
// Phase 1 — real-ad-performance banding for a hook/selling-angle/offer/
// audience row from winnerDetection.js's groupByCreativeLabel() output.
// Mirrors the same spend/purchases/CPA-vs-target gating already used by
// computeOpportunityScore()/pickWinner() — never labels WINNER from weak data.
// ---------------------------------------------------------------------------
export function bandCreativeLabel(row, { targetCpa = 120, minSpend = 150, minPurchases = 5 } = {}) {
  const spend = n(row?.spend) || 0;
  const purchases = n(row?.purchases) || 0;
  const cpa = n(row?.cpa);
  if (spend < minSpend * 0.3 || purchases === 0) return 'UNTESTED';
  if (row?.dataSufficiency === 'WEAK' || spend < minSpend) return row?.dataSufficiency === 'WEAK' && purchases > 0 ? 'AVERAGE' : 'UNTESTED';
  if (cpa == null) return 'UNTESTED';
  const ratio = targetCpa / cpa; // >1 = cheaper than target
  if (ratio >= 1.15 && purchases >= minPurchases && row?.dataSufficiency === 'STRONG') return 'WINNER';
  if (ratio >= 1.0 && purchases >= Math.max(1, Math.round(minPurchases * 0.5))) return 'PROMISING';
  if (ratio >= 0.8) return 'AVERAGE';
  return 'WEAK';
}

// ---------------------------------------------------------------------------
// Phase 1 — deterministic P0-P3 priority for the AI's existing `actions`
// list, purely by cross-referencing already-computed diagnosis severity/
// category. No new AI call, no new signal.
// ---------------------------------------------------------------------------
export function prioritizeActions(actions, diagnosis) {
  const hasHighCpaOrDelivery = (diagnosis || []).some((d) => d.severity === 'HIGH' && ['CPA_PROBLEM', 'DELIVERY_PROBLEM'].includes(d.category));
  const hasHighAny = (diagnosis || []).some((d) => d.severity === 'HIGH');
  const hasInsufficient = (diagnosis || []).some((d) => d.category === 'INSUFFICIENT_DATA');
  return (actions || []).map((a) => {
    let priority = 'P2';
    const text = `${a.actionKey || ''} ${a.title || ''} ${a.reason || ''}`.toLowerCase();
    if (hasHighCpaOrDelivery && /(cpa|delivery|استلام|تكلفة)/i.test(text)) priority = 'P0';
    else if (/(winner|فائز|كسب|scale|توسع)/i.test(text)) priority = 'P1';
    else if (hasHighAny) priority = 'P1';
    else if (hasInsufficient && /(بيانات|data)/i.test(text)) priority = 'P3';
    return { ...a, priority };
  });
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
