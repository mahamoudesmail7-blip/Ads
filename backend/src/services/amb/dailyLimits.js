// 📏 DAILY LIMITS — what each AUTOMATIC daily limit really measures, how much of it is used, and an honest explanation of a limit alert. READ-ONLY: nothing here changes a limit, a permission or a campaign.
//
//   Two limits are easy to confuse and they protect DIFFERENT things:
//     · maxBudgetIncreasePerDay  (حد زيادة الميزانية)  = how much budget the Operator may ADD in a rolling 24h (sum of the increases it executed). Reductions never count. It limits the SPEED of growth.
//     · maxDailySpendUnderAi     (حد التعرض المالي)    = the TOTAL daily budget of the ACTIVE campaigns the Operator opened/scaled in the last 7 days (+ the new increase/open). It limits the SIZE of the money under AI control.
//   Both apply to the whole account (a per-store limit exists but is not configured), and both only stop an INCREASE / OPEN. A reduction or a pause is never stopped by them (a pause has its own count: maxPausesPerDay).
//   The counters are the Operator's own executed decisions in a ROLLING 24h window (the same numbers the guards use), not the calendar day.
const MS_M = 60_000;

export const LIMIT_DEFS = Object.freeze({
  budgetIncrease: { key: 'budgetIncrease', limitKey: 'maxBudgetIncreasePerDay', label: 'حد زيادة الميزانية', unit: 'ج', icon: '📈',
    measures: 'مجموع مبالغ الزيادة اللي الـOperator نفّذها آخر 24 ساعة (متحرك). التقليل ما بيتحسبش.',
    effect: 'بيحدّ سرعة النمو: أي زيادة جديدة هتخلّي المجموع يعدّي الحد بتتحجب. مش بيمنع التقليل ولا الإيقاف ولا الفتح.' },
  exposure: { key: 'exposure', limitKey: 'maxDailySpendUnderAi', label: 'حد التعرض المالي', unit: 'ج', icon: '🛡️',
    measures: 'مجموع الميزانيات اليومية الحالية للحملات النشطة اللي الـOperator فتحها أو زوّدها آخر 7 أيام.',
    effect: 'بيحدّ حجم الفلوس تحت تحكم الـAI: أي زيادة أو فتح هيخلّي المجموع يعدّي الحد بيتحجب. مش بيمنع التقليل ولا الإيقاف.' },
  opens: { key: 'opens', limitKey: 'maxEnablesPerDay', label: 'حد الفتح', unit: 'حملة', icon: '▶️',
    measures: 'عدد الحملات اللي الـOperator فتحها آخر 24 ساعة (متحرك).', effect: 'لو اتوصل، أي فتح جديد بيتحجب لحد ما العدد ينزل.' },
  pauses: { key: 'pauses', limitKey: 'maxPausesPerDay', label: 'حد الإيقاف', unit: 'حملة', icon: '⏸️',
    measures: 'عدد الحملات اللي الـOperator أوقفها آخر 24 ساعة (متحرك).', effect: 'لو اتوصل، أي إيقاف تلقائي جديد بيتحجب ويستنى موافقتك.' },
  actionsDay: { key: 'actionsDay', limitKey: 'maxActionsPerDay', label: 'حد الأكشنز اليومي', unit: 'أكشن', icon: '⚙️', topLevel: true,
    measures: 'كل ما نفّذه الـOperator (زيادة/تقليل/فتح/إيقاف) آخر 24 ساعة.', effect: 'لو اتوصل، أي تنفيذ جديد بيتحجب.' },
  actionsHour: { key: 'actionsHour', limitKey: 'maxActionsPerHour', label: 'حد الأكشنز في الساعة', unit: 'أكشن', icon: '⏱️', topLevel: true,
    measures: 'كل ما نفّذه الـOperator آخر ساعة.', effect: 'لو اتوصل، التنفيذ بيتأجل للدورة اللي بعد ما العدد ينزل.' },
});

export const DIFFERENCE_NOTE = 'الفرق: حد زيادة الميزانية (مثلًا 100 ج) بيحدّ كام جنيه ينضاف في 24 ساعة — يعني سرعة النمو. أما حد التعرض المالي (مثلًا 600 ج) فبيحدّ إجمالي الميزانيات اليومية الشغالة تحت تحكم الـAI — يعني الحجم الكلي. ممكن زيادة صغيرة (20 ج) تتحجب لأن الإجمالي واصل لـ600، وممكن إجمالي صغير يتحجب بسبب إن الزيادات الكتير في يوم عدّت 100. التقليل والإيقاف مش بيتأثروا بالاتنين.';

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Used / limit / remaining for every daily limit. `config` = getOperatorConfig(); `counters` = loadCounters() — both injectable. */
export function limitUsage({ config, counters }) {
  const acct = config?.limits?.account || {}; const top = config?.limits || {}; const c = counters || {}; const by = c.byAction || {};
  const used = { budgetIncrease: Math.round(c.budgetIncreaseToday || 0), exposure: Math.round(c.aiBudget || 0), opens: by.OPEN || 0, pauses: by.PAUSE || 0, actionsDay: c.actionsToday || 0, actionsHour: c.actionsLastHour || 0 };
  return Object.values(LIMIT_DEFS).map((d) => {
    const limit = num((d.topLevel ? top : acct)[d.limitKey]); const u = used[d.key]; const remaining = limit == null ? null : Math.max(0, limit - u);
    const pct = limit ? Math.min(100, Math.round((u / limit) * 100)) : null;
    const state = limit == null ? 'UNSET' : u >= limit ? 'FULL' : pct >= 80 ? 'NEAR' : 'OK';
    return { key: d.key, label: d.label, unit: d.unit, icon: d.icon, limit, used: u, remaining, pct, state, measures: d.measures, effect: d.effect };
  });
}

const PHRASES = [['زيادة ميزانية', 'budgetIncrease'], ['ميزانية تحت تحكم AI', 'exposure'], ['فتح', 'opens'], ['إيقاف', 'pauses']];
/** One stored guard block ({code, message, detail}) → which limit, the value that was reached and the limit. Unknown shapes still name the limit by code. */
export function parseLimitBlock(b) {
  const code = String(b?.code || ''); const text = `${b?.message || ''} ${b?.detail || ''}`;
  if (!/LIMIT/.test(code)) return null;
  const scope = code === 'STORE_DAILY_LIMIT' ? 'STORE' : 'ACCOUNT';
  if (code === 'RATE_LIMIT_DAY') return { code, scope: 'ACCOUNT', key: 'actionsDay', label: LIMIT_DEFS.actionsDay.label, total: null, limit: null };
  if (code === 'RATE_LIMIT_HOUR') return { code, scope: 'ACCOUNT', key: 'actionsHour', label: LIMIT_DEFS.actionsHour.label, total: null, limit: null };
  if (code === 'CAMPAIGN_DAILY_LIMIT') return { code, scope: 'CAMPAIGN', key: 'campaignDay', label: 'حد تعديلات الحملة في اليوم', total: null, limit: null };
  for (const [phrase, key] of PHRASES) {
    const m = text.match(new RegExp(`${phrase}\\s+(\\d+(?:\\.\\d+)?)\\s*(?:>|/)\\s*(\\d+(?:\\.\\d+)?)`));
    if (m) return { code, scope, key, label: LIMIT_DEFS[key].label, total: Number(m[1]), limit: Number(m[2]) };
  }
  return { code, scope, key: 'unknown', label: scope === 'STORE' ? 'حد المتجر اليومي' : 'حد الحساب اليومي', total: null, limit: null };
}

const OPEN_STATUSES = ['BLOCKED', 'PREPARED'];
/**
 * Classifies the decisions that carry a daily-limit block. CURRENT = still open AND re-evaluated by the engine within `currentMinutes` (it is blocking something right now);
 * OLD = the block comes from a decision nobody has re-evaluated since (it blocks nothing today). `rows` = ambOperatorDecision rows (injectable for tests).
 */
export function buildLimitReport({ rows = [], now = new Date(), currentMinutes = 30 }) {
  const current = [], old = [];
  for (const r of rows) {
    let blocks = []; try { blocks = JSON.parse(r.blocked_codes_json || '[]') || []; } catch { blocks = []; }
    const limits = blocks.map(parseLimitBlock).filter(Boolean); if (!limits.length) continue;
    const ageMin = Math.max(0, Math.round((now.getTime() - new Date(r.updated_at).getTime()) / MS_M));
    const item = { decisionId: r.id, campaign: r.campaign_name || r.campaign_id || '—', action: r.action, status: r.status, updatedAt: new Date(r.updated_at).toISOString(), ageMin, limits };
    (OPEN_STATUSES.includes(r.status) && ageMin <= currentMinutes ? current : old).push(item);
  }
  return { current, old };
}
const agoAr = (min) => (min < 90 ? `${min} دقيقة` : min < 48 * 60 ? `${Math.round(min / 60)} ساعة` : `${Math.round(min / 1440)} يوم`);
const lineOf = (it) => it.limits.map((l) => `${l.label}${l.scope === 'STORE' ? ' (متجر)' : ''}${l.total != null ? `: ${l.total} > ${l.limit}` : ''}`).join(' · ') + ` — قرار #${it.decisionId} (${it.campaign}) من ${agoAr(it.ageMin)}`;

/** The alert for a report: a WARNING only when a limit blocks something NOW; otherwise an INFO that says plainly nothing is blocked today. Returns null when no decision carries a limit block. */
export function limitAlert(report) {
  const { current, old } = report;
  if (current.length) {
    const names = [...new Set(current.flatMap((c) => c.limits.map((l) => l.label)))];
    return { kind: 'CURRENT', severity: 'WARNING', title: `AI Operator: ${names.join(' + ')} بيمنع قرارات دلوقتي`,
      message: `المنع حالي. ${current.slice(0, 4).map(lineOf).join(' | ')}. الحد بيمنع الزيادة/الفتح فقط — التقليل والإيقاف مش متأثرين بحد الميزانية. افتح «لوحة AUTOMATIC ← العدادات اليومية» تشوف المستخدم والمتبقي.`.slice(0, 480) };
  }
  if (old.length) {
    const newest = old.slice().sort((a, b) => a.ageMin - b.ageMin)[0];
    return { kind: 'HISTORICAL', severity: 'INFO', title: 'AI Operator: حد يومي منع قرارات قديمة — مفيش منع حالي',
      message: `مفيش حاجة متوقفة دلوقتي بسبب الحدود. آخر منع كان من قرار قديم: ${lineOf(newest)}. القرارات القديمة دي ما اتعادش تقييمها من وقتها.`.slice(0, 480) };
  }
  return null;
}
