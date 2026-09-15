// Product Marketing Center — Phase 1 pure assemblers. Zero DB reads, zero AI
// calls: every function here only combines objects productMarketing.js's
// computeSnapshot() has already computed elsewhere (diagnosis, actions,
// hook/angle intel, markets, winning formula). No new signal is invented.

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * §4 "Needs Your Attention" — ranks already-computed diagnosis items and
 * prioritized actions into one P0->P3 list. Adds nothing the caller didn't
 * already compute; this is assembly + ranking only.
 */
export function assembleNeedsAttention({ diagnosis = [], actions = [], hookIntel = null, angleIntel = null } = {}) {
  const items = [];

  for (const d of diagnosis) {
    if (d.category === 'HEALTHY_PRODUCT') continue; // nothing to flag
    items.push({
      priority: d.priority || 'P3',
      type: d.category === 'INSUFFICIENT_DATA' || d.category === 'TRACKING_MAPPING_PROBLEM' ? 'MISSING_DATA' : 'PROBLEM',
      what: d.problem,
      why: d.evidence,
      action: d.action,
      confidence: d.dataSufficiency === 'STRONG' ? 'HIGH' : d.dataSufficiency === 'MODERATE' ? 'MEDIUM' : 'LOW',
      dataSufficiency: d.dataSufficiency,
    });
  }

  for (const a of actions) {
    items.push({
      priority: a.priority || 'P2',
      type: 'OPPORTUNITY',
      what: a.title,
      why: a.reason,
      action: a.expectedBenefit || a.title,
      confidence: a.confidence || 'MEDIUM',
      dataSufficiency: null,
    });
  }

  const winnerHook = hookIntel?.winner;
  if (winnerHook) {
    items.push({
      priority: 'P1', type: 'OPPORTUNITY',
      what: `Hook فائز موجود: ${winnerHook.label}`,
      why: winnerHook.why,
      action: 'استخدم نفس الـHook في كرياتيفات جديدة أو زوّد ميزانيته.',
      confidence: 'HIGH', dataSufficiency: 'STRONG',
    });
  }
  const winnerAngle = angleIntel?.winner;
  if (winnerAngle) {
    items.push({
      priority: 'P1', type: 'OPPORTUNITY',
      what: `Selling Angle فائز موجود: ${winnerAngle.label}`,
      why: winnerAngle.why,
      action: 'ابنِ Creative/Copy جديد حول نفس الـAngle.',
      confidence: 'HIGH', dataSufficiency: 'STRONG',
    });
  }

  items.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9));
  return items;
}

/**
 * §21 "Winning Components" — pulls together already-known winners into one
 * object with a `why` built from evidence already present on each piece.
 */
export function assembleWinningComponents({ bestAd = null, bestAdCreative = null, hookIntel = null, angleIntel = null, markets = [], winningFormula = null } = {}) {
  const bestMarket = (markets || []).filter((m) => m.band === 'SCALE_MARKET').sort((a, b) => (b.delivered || 0) - (a.delivered || 0))[0]
    || (markets || []).slice().sort((a, b) => (b.delivered || 0) - (a.delivered || 0))[0]
    || null;

  return {
    bestMarket: bestMarket ? { government: bestMarket.government, why: `${bestMarket.delivered} طلب مُستلم من ${bestMarket.orders}${bestMarket.band ? ` (${bestMarket.band})` : ''}.` } : null,
    bestHook: hookIntel?.winner ? { label: hookIntel.winner.label, why: hookIntel.winner.why } : null,
    bestSellingAngle: angleIntel?.winner ? { label: angleIntel.winner.label, why: angleIntel.winner.why } : null,
    bestAd: bestAd ? { id: bestAd.id, name: bestAd.name, why: bestAd.analysis ? `Hook: ${bestAd.analysis.hook || '—'} / Angle: ${bestAd.analysis.sellingAngle || '—'}` : 'أفضل إعلان حاليًا حسب الأداء الحقيقي.' } : null,
    bestCreative: bestAdCreative || null,
    bestOffer: winningFormula?.available ? { summary: winningFormula.narrative || null } : null,
    dataSufficient: Boolean(bestMarket || hookIntel?.winner || angleIntel?.winner || bestAd),
  };
}

const CREATIVE_IDEA_STATUS = {
  matchesWinner: 'CREATE_MORE_LIKE_THIS',
  newAngle: 'NEW_TEST',
  refreshWinner: 'REFRESH_WINNER',
  matchesWeak: 'STOP_REPEATING',
};

/** §12 — status labels for the EXISTING (ephemeral) generateCreativeIdeas() output, post-processing only. */
export function labelCreativeIdeas(ideas = [], { hookBand = null, angleBand = null } = {}) {
  return (ideas || []).map((idea) => {
    let status = CREATIVE_IDEA_STATUS.newAngle;
    if (angleBand === 'WINNER' || hookBand === 'WINNER') status = CREATIVE_IDEA_STATUS.matchesWinner;
    else if (angleBand === 'WEAK' || hookBand === 'WEAK') status = CREATIVE_IDEA_STATUS.matchesWeak;
    else if (angleBand === 'PROMISING' || hookBand === 'PROMISING') status = CREATIVE_IDEA_STATUS.refreshWinner;
    return { ...idea, status };
  });
}

/** §13 — status label for the EXISTING (ephemeral) generatePost() output, post-processing only. */
export function labelPostCopy(post, { angleBand = null } = {}) {
  if (!post) return post;
  let status = 'NEW_TEST';
  if (angleBand === 'WINNER') status = 'WINNING_COPY';
  else if (angleBand === 'PROMISING' || angleBand === 'AVERAGE') status = 'VARIATION';
  return { ...post, status };
}

/**
 * PMC data-completeness diagnostic (spec: "per analysis" object covering
 * metaPerformance/easyOrders/economics/demographics/geography/creative/
 * hooks/competitors/experiments/ai). Pure assembly over already-computed
 * signals — no new query, no new signal invented. Diagnostics only, never
 * meant to clutter the normal UI; the frontend may surface it in a
 * collapsed/debug panel only. Every dimension is AVAILABLE|PARTIAL|MISSING|ERROR
 * plus a `reason`.
 */
export function assembleDataCompleteness({ metaMapped, metrics, cod, revenueSource, markets, locations, bestAd, ai, hookAngleIntelEnabled = false }) {
  const dim = (status, reason) => ({ status, reason });

  const metaPerformance = !metaMapped
    ? dim('MISSING', 'لا توجد حملة Meta مرتبطة بهذا المنتج بعد.')
    : (metrics?.totalSpend || 0) > 0
      ? dim('AVAILABLE', 'بيانات إنفاق وأداء حقيقية من Meta.')
      : dim('PARTIAL', 'الحملة مربوطة لكن لسه مفيش صرف كافي في هذه الفترة.');

  const easyOrders = cod?.source === 'easyorders'
    ? dim('AVAILABLE', 'بيانات طلبات حقيقية من Easy Orders.')
    : cod?.source === 'daily_orders'
      ? dim('PARTIAL', 'بيانات ملخّصة يومية فقط (بدون تفاصيل الحالة/المحافظة).')
      : dim('MISSING', 'لا توجد بيانات Easy Orders لهذا المنتج في هذه الفترة.');

  const economics = revenueSource === 'real'
    ? dim('AVAILABLE', 'الإيراد وصافي الربح محسوبين من قيمة الطلبات الحقيقية.')
    : revenueSource === 'estimated'
      ? dim('PARTIAL', 'الإيراد تقديري (سعر البيع × عدد الطلبات المُستلمة) — لا توجد قيمة طلب حقيقية بعد.')
      : dim('MISSING', 'لا يمكن حساب الاقتصاديات بدون بيانات طلبات مُستلمة.');

  const demographics = dim('MISSING', 'Meta لا يوفر بيانات تقسيم الجمهور (عمر/نوع) في هذا النظام حاليًا — يحتاج تفعيل breakdowns في مزامنة Meta، غير مُفعّل الآن.');

  const geography = (markets?.length || locations?.length)
    ? dim('AVAILABLE', 'توزيع محافظات حقيقي من طلبات Easy Orders.')
    : dim('MISSING', 'لا توجد طلبات بعنوان محافظة معروف في هذه الفترة.');

  const creative = bestAd?.analysis
    ? dim('AVAILABLE', 'تحليل كرياتيف حقيقي متاح لأفضل إعلان.')
    : bestAd
      ? dim('PARTIAL', 'يوجد أفضل إعلان لكن لسه مفيش تحليل كرياتيف له.')
      : dim('MISSING', 'لا يوجد إعلان بأداء كافٍ لتحليله بعد.');

  // hookAngleIntelEnabled reflects hookAndAngleIntelForProduct()'s own
  // dataAvailable for THIS product — it was never a system-wide feature
  // flag, so the message must say the real, product-specific reason (no
  // Meta mapping yet, vs. mapped but zero ads) rather than implying the
  // whole feature is switched off.
  const hooks = hookAngleIntelEnabled
    ? dim('AVAILABLE', 'تحليل Hooks/Selling Angles من الإعلانات الحقيقية الجارية.')
    : !metaMapped
      ? dim('MISSING', 'لا يمكن تحليل Hooks/Selling Angles قبل ربط المنتج بحملة Meta حقيقية.')
      : dim('MISSING', 'الحملة مربوطة لكن لا توجد إعلانات كافية بعد لاستخراج Hooks/Selling Angles.');

  const competitors = dim('PARTIAL', 'يتم تحميلها عند فتح تبويب المنافسين (بحث محفوظ سابقًا)، وليست جزء من التحليل التلقائي.');
  const experiments = dim('PARTIAL', 'يتم تحميلها عند فتح تبويب الاختبارات، وليست جزء من التحليل التلقائي.');
  const aiDim = ai?.ok ? dim('AVAILABLE', 'التفسير الذكي تم توليده بنجاح.') : dim('ERROR', ai?.reason || 'تعذّر توليد التفسير الذكي.');

  return { metaPerformance, easyOrders, economics, demographics, geography, creative, hooks, competitors, experiments, ai: aiDim };
}
