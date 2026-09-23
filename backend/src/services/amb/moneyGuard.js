// AI Media Buyer — Money Guard (Product Growth & Profit Intelligence, Phase
// 3 Slice 1). A hard safety layer that turns the ALREADY-EXISTING AMB
// safety-rail settings (settings.js's ambMaxBudgetIncreasePct etc.) into ONE
// consolidated ALLOWED/WARN/BLOCKED decision, so a consequential PREPARE
// tool never silently clamps a request without telling the human about the
// conflict. Pure functions only — every input is already-fetched data the
// caller passes in; this file never queries Meta or the DB itself.
//
// "REQUIRES_HIGHER_APPROVAL" from the spec is implemented as WARN: every
// AssistantTask kind's approve endpoint is already requireRole('ADMIN')-only
// (routes/assistantTasks.js) — there is no higher role to escalate a
// request to today. WARN still lets the task reach WAITING_FOR_APPROVAL for
// the one ADMIN approval that already exists, but the Task Card must show
// the risk flag honestly rather than hiding it.

/** A single budget-bump/scale action's requested % vs the per-action cap. Never silently clamps — BLOCKED names both numbers so the human sees the real conflict. */
export function evaluateBudgetCap({ requestedPct, maxSingleActionPct }) {
  const requested = Number(requestedPct);
  const max = Number(maxSingleActionPct);
  if (!Number.isFinite(requested) || !Number.isFinite(max)) return { decision: 'ALLOWED', reason: null };
  if (requested > max) {
    return { decision: 'BLOCKED', reason: `الزيادة المطلوبة ${requested}% بينما الحد المسموح في أكشن واحد ${max}%.` };
  }
  return { decision: 'ALLOWED', reason: null };
}

/** The cumulative 24h cap across every bump on the same entity — a request that's fine on its own can still push the entity's cumulative increase past the daily ceiling. */
export function evaluateDailyCumulativeCap({ cumulativePctLast24h, requestedPct, maxDailyPct }) {
  const cumulative = Number(cumulativePctLast24h) || 0;
  const requested = Number(requestedPct) || 0;
  const max = Number(maxDailyPct);
  if (!Number.isFinite(max)) return { decision: 'ALLOWED', reason: null, projected: cumulative + requested };
  const projected = cumulative + requested;
  if (projected > max) {
    return { decision: 'BLOCKED', reason: `الزيادة دي هتوصل بالتراكمي لـ${projected}% خلال 24 ساعة، بينما الحد الأقصى المسموح ${max}%.`, projected };
  }
  return { decision: 'ALLOWED', reason: null, projected };
}

/**
 * The real gate prepare_scale calls before letting a Scale task reach
 * WAITING_FOR_APPROVAL. Refuses outright for the two conditions no amount
 * of human approval should paper over (genuinely unprofitable, or literally
 * nothing left to sell); everything else that isn't fully clean data
 * becomes an honest WARN flag on the Task Card, never a silent pass.
 */
export function evaluateMoneyGuardForScale({ profitState, stockGuard, creativeFatigueState, settings }) {
  const riskFlags = [];

  if (profitState === 'UNPROFITABLE') {
    return { decision: 'BLOCKED', reason: 'الأرقام الحقيقية (الإيرادات - التكاليف - صرف الإعلانات) بتقول المنتج ده بيخسر فعليًا في الفترة دي — مينفعش تعمل Scale عليه دلوقتي.', riskFlags };
  }
  if (stockGuard?.status === 'OUT_OF_STOCK') {
    return { decision: 'BLOCKED', reason: 'المخزون خلص فعليًا لهذا المنتج — مفيش حاجة تتباع لو الحملة كبرت.', riskFlags };
  }

  if (profitState === 'MARGIN_THIN') riskFlags.push('هامش الربح الحقيقي ضيق جدًا حاليًا.');
  if (profitState === 'BREAK_EVEN') riskFlags.push('المنتج على حافة التعادل تقريبًا (لا ربح ولا خسارة واضحة).');
  if (profitState === 'PARTIAL_DATA') riskFlags.push('بيانات التكاليف (سعر البيع/تكلفة المنتج) غير مكتملة — الرقم اللي ظاهر تقديري مش دقيق 100%.');
  if (profitState === 'INSUFFICIENT_DATA') riskFlags.push('مفيش عدد أوردرات كافي في الفترة دي للحكم على الربح الحقيقي.');
  if (stockGuard?.status === 'LOW') riskFlags.push('المخزون منخفض.');
  if (stockGuard?.status === 'STOCK_UNKNOWN') riskFlags.push('المخزون غير مسجل لهذا المنتج.');
  if (creativeFatigueState === 'WATCH') riskFlags.push('⚠️ الكرياتيف الفائز بدأ يضعف شوية — فكّر في تجهيز كرياتيف بديل قريبًا.');
  if (creativeFatigueState === 'FATIGUING') riskFlags.push('⚠️ الكرياتيف الفائز بدأ يضعف بشكل واضح — يفضّل تجهيز كرياتيف بديل قبل ما تكبّر الميزانية عليه.');
  const minDays = Number(settings?.ambStockGuardMinDaysForScale) || 14;
  if (stockGuard?.daysRemaining != null && stockGuard.daysRemaining < minDays) {
    riskFlags.push(`المخزون الحالي هيخلص خلال ${stockGuard.daysRemaining} يوم تقريبًا بمعدل البيع الحالي.`);
  }

  if (riskFlags.length) return { decision: 'WARN', reason: riskFlags.join(' '), riskFlags };
  return { decision: 'ALLOWED', reason: null, riskFlags };
}
