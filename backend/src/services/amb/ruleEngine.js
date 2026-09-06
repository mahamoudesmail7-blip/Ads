// AI Media Buyer — deterministic Media Buying Rule Engine (layer 4).
// NOTHING here is an AI call. Claude proposes nothing that reaches Meta
// without passing through validateAction() first. Covers: the Scaling
// Engine (CPA-vs-target budget bands), multi-signal Stop Logic, and the
// full safety-check list the spec requires before any executable action.
import { prisma } from '../../prisma.js';

const EXECUTABLE = new Set(['PAUSE', 'RESUME', 'INCREASE_BUDGET', 'DECREASE_BUDGET']);

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

// ---------------------------------------------------------------------------
// SCALING ENGINE — controlled, multi-signal. Never scales off one cheap
// conversion. Bands are configurable (settings), defaults per spec.
// ---------------------------------------------------------------------------
export function computeScaleRecommendation({ metrics, econ, settings, currentBudget }) {
  const target = n(econ?.targetCpa) ?? n(settings.ambDefaultTargetCpa) ?? 120;
  const cpa = n(metrics.cpa);
  const purchases = metrics.purchases || 0;
  const minPurch = n(settings.ambMinPurchasesBeforeScaling) ?? 5;
  const maxIncPct = n(settings.ambMaxBudgetIncreasePct) ?? 20;

  if (cpa === null || currentBudget == null) return { shouldScale: false, band: 'NONE', reason: 'مفيش CPA أو ميزانية حالية معروفة.' };
  if (purchases < minPurch) return { shouldScale: false, band: 'INSUFFICIENT_VOLUME', reason: `عدد المشتريات (${purchases}) أقل من الحد الأدنى للتوسع (${minPurch}).` };
  if (metrics.dataSufficiency === 'WEAK') return { shouldScale: false, band: 'WEAK_DATA', reason: 'كفاية البيانات ضعيفة — مش وقت توسع.' };

  const better = (target - cpa) / target; // fraction below target
  let pct = 0, band = 'HOLD';
  if (better >= 0.5) { pct = maxIncPct; band = 'STRONG'; }
  else if (better >= 0.3) { pct = Math.min(maxIncPct, 20); band = 'GOOD'; }
  else if (better >= 0.2) { pct = Math.min(maxIncPct, 15); band = 'MODERATE'; }
  else if (better >= 0.1) { pct = Math.min(maxIncPct, 10); band = 'SMALL'; }
  else { return { shouldScale: false, band: 'HOLD', reason: `CPA ${cpa.toFixed(1)} قريب من الهدف (${Math.round(target)}) — الأفضل تثبيت.` }; }

  pct = Math.min(pct, maxIncPct); // hard cap per action
  const newBudget = Math.round(currentBudget * (1 + pct / 100));
  return { shouldScale: true, band, changePct: pct, currentBudget, newBudget, reason: `CPA أحسن من الهدف بـ${Math.round(better * 100)}% مع ${purchases} شراء — توسّع محسوب +${pct}%.` };
}

// ---------------------------------------------------------------------------
// STOP LOGIC — multiple signals, never "CPA > target ⇒ instant pause".
// ---------------------------------------------------------------------------
export function evaluateStopSignals({ metrics, econ, settings, trend }) {
  const target = n(econ?.targetCpa) ?? n(settings.ambDefaultTargetCpa) ?? 120;
  const maxCpa = n(econ?.maxCpa) ?? n(econ?.codBreakEvenCpa) ?? n(econ?.breakEvenCpa) ?? target * 1.5;
  const noPurchaseStop = target * (n(settings.ambNoPurchaseStopMultiplier) ?? 2);
  const spend = metrics.spend || 0;
  const purchases = metrics.purchases || 0;
  const cpa = n(metrics.cpa);
  const signals = [];

  if (purchases === 0 && spend >= noPurchaseStop) signals.push({ code: 'ZERO_RESULT_BURN', detail: `صرف ${Math.round(spend)} جنيه (≥ ${Math.round(noPurchaseStop)}) بدون أي شراء.` });
  if (cpa !== null && cpa >= maxCpa) signals.push({ code: 'CPA_ABOVE_MAX', detail: `CPA ${cpa.toFixed(1)} جنيه ≥ الحد الأقصى ${Math.round(maxCpa)} جنيه.` });
  if (cpa !== null && econ?.codBreakEvenCpa != null && cpa > econ.codBreakEvenCpa) signals.push({ code: 'NEGATIVE_UNIT_ECONOMICS', detail: `CPA ${cpa.toFixed(1)} فوق نقطة التعادل الحقيقية (${Math.round(econ.codBreakEvenCpa)} جنيه).` });
  if (purchases > 0 && spend >= target * 3 && cpa !== null && cpa > target * 1.5) signals.push({ code: 'HIGH_SPEND_POOR_CPA', detail: `صرف كبير (${Math.round(spend)} جنيه) وCPA ضعيف مستمر.` });
  if (trend && trend.cpa?.direction === 'UP' && trend.conversionRate?.direction === 'DOWN' && spend >= target * 2) signals.push({ code: 'BAD_TREND', detail: 'CPA بيرتفع ومعدل التحويل بينزل على عيّنة معتبرة.' });

  const severity = signals.some((x) => ['ZERO_RESULT_BURN', 'CPA_ABOVE_MAX'].includes(x.code)) ? 'CRITICAL'
    : signals.length >= 2 ? 'HIGH' : signals.length === 1 ? 'MEDIUM' : 'NONE';
  return { stop: signals.length >= (purchases === 0 ? 1 : 2), signals, severity };
}

// ---------------------------------------------------------------------------
// FULL VALIDATION — every executable recommendation must pass this before it
// is marked executable, and again (revalidation) immediately before execute.
// ---------------------------------------------------------------------------
/**
 * @param {{actionType:string, level:string, entityId:string, campaignId?:string,
 *   metrics:object, econ:object|null, settings:object, connection:object,
 *   liveEntity?:{status?:string, budgetMajor?:number}, recommendedBudget?:number,
 *   currentBudget?:number, netProfitWindow?:number|null}} p
 * @returns {{passed:boolean, executable:boolean, checks:{name,ok,detail}[], blockers:string[]}}
 */
export async function validateAction(p) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // 1. Action is in the executable whitelist at all.
  const whitelisted = EXECUTABLE.has(p.actionType);
  add('action_whitelisted', whitelisted, whitelisted ? `${p.actionType} ضمن الأكشنز المسموح تنفيذها.` : `${p.actionType} أكشن مسودة فقط — يتطلب موافقة صريحة ومش بيتنفّذ تلقائيًا.`);

  // 2. Ad account connection.
  const connOk = p.connection?.status === 'CONNECTED' && !!p.connection?.selected_ad_account_id;
  add('ad_account_connected', connOk, connOk ? 'حساب Meta Ads متصل وفيه Ad Account مختار.' : 'مفيش اتصال Meta Ads صالح أو Ad Account مختار.');
  const tokenOk = !p.connection?.token_expires_at || new Date(p.connection.token_expires_at) > new Date();
  add('token_valid', tokenOk, tokenOk ? 'صلاحية التوكن سارية.' : 'انتهت صلاحية توكن Meta — لازم إعادة ربط.');

  // 3. Minimum data.
  const minSpend = n(p.settings.ambMinSpendBeforeDecision) ?? 150;
  const dataOk = (p.metrics.spend || 0) >= minSpend || p.actionType === 'RESUME';
  add('minimum_data', dataOk, dataOk ? `الصرف (${Math.round(p.metrics.spend || 0)} جنيه) كافٍ لقرار.` : `الصرف (${Math.round(p.metrics.spend || 0)} جنيه) أقل من حد القرار (${minSpend} جنيه) — اجمع بيانات أكتر.`);

  // 4. Live entity status compatible with the action.
  let statusOk = true;
  let statusDetail = 'حالة العنصر غير معروفة (هيتأكد وقت التنفيذ).';
  if (p.liveEntity?.status) {
    const st = p.liveEntity.status;
    if (['PAUSE', 'INCREASE_BUDGET', 'DECREASE_BUDGET'].includes(p.actionType)) {
      statusOk = st === 'ACTIVE';
      statusDetail = statusOk ? `العنصر ACTIVE — يقبل ${p.actionType}.` : `العنصر حالته ${st} — ${p.actionType} مش منطقي دلوقتي.`;
    } else if (p.actionType === 'RESUME') {
      statusOk = st === 'PAUSED';
      statusDetail = statusOk ? 'العنصر PAUSED — يقبل RESUME.' : `العنصر حالته ${st} — RESUME مش منطقي.`;
    }
  }
  add('entity_status_ok', statusOk, statusDetail);

  // 5. Budget-change bounds.
  if (['INCREASE_BUDGET', 'DECREASE_BUDGET'].includes(p.actionType)) {
    const maxPct = n(p.settings.ambMaxBudgetIncreasePct) ?? 20;
    const cur = n(p.currentBudget);
    const next = n(p.recommendedBudget);
    let boundOk = cur != null && next != null && cur > 0;
    let detail = 'الميزانية الحالية أو المقترحة غير معروفة.';
    if (boundOk) {
      const changePct = Math.abs((next - cur) / cur) * 100;
      boundOk = changePct <= maxPct + 0.5;
      detail = boundOk
        ? `تغيير الميزانية ${Math.round(((next - cur) / cur) * 100)}% ضمن الحد المسموح لكل أكشن (${maxPct}%).`
        : `تغيير الميزانية ${Math.round(changePct)}% أكبر من الحد المسموح لكل أكشن (${maxPct}%).`;
    }
    add('budget_change_bounds', boundOk, detail);

    // 6. Daily cumulative scale cap + cooldown (only meaningful for increases).
    if (p.actionType === 'INCREASE_BUDGET' && p.entityId) {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const recent = await prisma.ambAction.findMany({
        where: { entity_id: p.entityId, action_type: 'INCREASE_BUDGET', execution_status: 'EXECUTED', executed_at: { gte: since } },
        orderBy: { executed_at: 'desc' },
      });
      const cooldownH = n(p.settings.ambScalingCooldownHours) ?? 24;
      const lastScale = recent[0];
      const cooldownOk = !lastScale || (Date.now() - new Date(lastScale.executed_at).getTime()) >= cooldownH * 3600 * 1000;
      add('scaling_cooldown', cooldownOk, cooldownOk ? 'مفيش توسع سابق على نفس العنصر خلال فترة التهدئة.' : `فيه توسع على نفس العنصر خلال آخر ${cooldownH} ساعة — انتظر انتهاء التهدئة أو وافق يدويًا.`);

      let cumPct = cur && next ? ((next - cur) / cur) * 100 : 0;
      for (const a of recent) {
        try {
          const oldV = JSON.parse(a.old_value_json || '{}');
          const newV = JSON.parse(a.new_value_json || '{}');
          if (oldV.budget && newV.budget) cumPct += ((newV.budget - oldV.budget) / oldV.budget) * 100;
        } catch { /* ignore */ }
      }
      const maxDaily = n(p.settings.ambMaxDailyBudgetIncreasePct) ?? 50;
      const dailyOk = cumPct <= maxDaily + 0.5;
      add('daily_scale_cap', dailyOk, dailyOk ? `إجمالي زيادة الميزانية اليوم على العنصر ≈ ${Math.round(cumPct)}% (حد ${maxDaily}%).` : `إجمالي زيادة الميزانية اليوم (${Math.round(cumPct)}%) يتجاوز الحد اليومي (${maxDaily}%).`);
    }
  }

  // 7. Max allowed daily loss.
  if (p.netProfitWindow != null) {
    const maxLoss = n(p.settings.ambMaxAllowedDailyLoss) ?? 1000;
    const lossOk = p.netProfitWindow > -maxLoss || p.actionType === 'PAUSE';
    add('max_daily_loss', lossOk, lossOk ? 'الخسارة الحالية تحت الحد الأقصى المسموح.' : `صافي الربح ${Math.round(p.netProfitWindow)} جنيه تجاوز الحد الأقصى للخسارة (${maxLoss} جنيه) — التوسع ممنوع، والأولوية للإيقاف/التقليل.`);
  }

  // 8. Duplicate / very-recent identical action.
  if (p.entityId) {
    const dupSince = new Date(Date.now() - 6 * 3600 * 1000);
    const dup = await prisma.ambAction.findFirst({
      where: { entity_id: p.entityId, action_type: p.actionType, created_at: { gte: dupSince }, execution_status: { in: ['PENDING', 'REVALIDATING', 'EXECUTED'] } },
    });
    add('no_recent_duplicate', !dup, !dup ? 'مفيش أكشن مطابق على نفس العنصر خلال آخر 6 ساعات.' : 'فيه أكشن مطابق اتنفّذ أو منتظر على نفس العنصر خلال آخر 6 ساعات.');
  }

  const blockers = checks.filter((c) => !c.ok).map((c) => c.detail);
  const passed = blockers.length === 0;
  return { passed, executable: passed && whitelisted, checks, blockers };
}

export { EXECUTABLE };
