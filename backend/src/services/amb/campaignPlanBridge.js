// AI Operator V2 — the BRIDGE from a bulk selection to the EXISTING plan / decision system. It creates NOTHING new in the execution path:
//   OPEN / PAUSE            → one independent daily plan (variant «V2-…») through dailyPlans.preparePlan — the same candidate builder (eligibility, policy, stock, protections, manual-override cooldown),
//                              the same PREPARED status, the same approval (ADMIN + confirmation of count and exposed budget), the same revalidation and execution gate. The standard OPEN/PAUSE plans are never touched.
//   INCREASE / DECREASE     → PREPARED budget decisions through the budget optimizer's own evaluation + persistence (the same checks as prepareBudgetDecision: live structure, the engine's own action and
//                              ±% , budget caps for an increase, ONE entity per campaign — an ABO campaign with several ad sets is never turned into a campaign-level change). Custom % / amounts stay preview-only.
// Before anything is created the selection is RE-VALIDATED on live data (snapshot + eligibility, the preview's own verdicts), the user must echo the preview's hash (so they approve exactly what they saw), and every campaign is
// checked for conflicts: another active plan, an open decision, a newer manual change, a recent executed action. Creating a draft NEVER executes anything and never needs the Meta lock / permissions to be open — approving and
// executing remain ADMIN-only steps behind every existing gate. Duplicates are impossible: the same selection maps to the same plan key / decision key.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { reviewPreview, previewHashOf, CREATABLE } from './campaignReview.js';
import { invalidateQueryCache } from './campaignQuery.js';
import { preparePlan, cancelPlan } from './dailyPlans.js';
import { cairoDate, isTestClock } from './dailyPlanTime.js';
import { getOperatorConfig } from './operatorStore.js';
import { evaluateBudgetOptimization, persistBudgetDecisions } from './budgetOptimizer.js';
import { checkBudgetCaps } from './budgetCaps.js';
import { dailyCapFromLimits } from './productPolicy.js';

export { CREATABLE, previewHashOf };
const bad = (message, code = 'BAD_REQUEST', status = 400, details = null) => { const e = new Error(message); e.status = status; e.code = code; if (details) e.details = details; return e; };
const MS_H = 3_600_000;
const BUDGET_EXPECT = { INCREASE_BUDGET: ['SCALE_UP', 'WOULD_INCREASE'], DECREASE_BUDGET: ['SCALE_DOWN', 'WOULD_REDUCE'] };
const OPEN_DECISION = ['PREPARED', 'APPROVED', 'EXECUTING'];

async function conflictsFor({ ids, action, today, now, planKeyPrefix }) {
  const out = new Map(ids.map((i) => [i, []])); const add = (id, why) => out.get(id)?.push(why);
  const items = await prisma.ambDailyPlanItem.findMany({ where: { campaign_id: { in: ids }, selected: true, plan: { plan_date: today, status: { in: ['PREPARED', 'APPROVED', 'RUNNING'] } } }, select: { campaign_id: true, plan: { select: { id: true, type: true, plan_key: true } } } });
  for (const it of items) { if (planKeyPrefix && String(it.plan.plan_key).includes(planKeyPrefix)) continue; add(it.campaign_id, `مختارة بالفعل في خطة ${it.plan.type === 'OPEN' ? 'فتح' : 'إيقاف'} نشطة #${it.plan.id} — مفيش خطتين على نفس الحملة.`); }
  const decs = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { in: ids }, status: { in: OPEN_DECISION }, created_at: { gte: new Date(now.getTime() - 48 * MS_H) } }, select: { campaign_id: true, action: true, status: true } });
  const want = { OPEN: 'OPEN', PAUSE: 'PAUSE', INCREASE_BUDGET: 'SCALE_UP', DECREASE_BUDGET: 'SCALE_DOWN' }[action];
  for (const d of decs) { if (d.action !== want) add(d.campaign_id, `فيه قرار مفتوح مختلف على نفس الحملة (${d.action}).`); else if (action === 'OPEN' || action === 'PAUSE') add(d.campaign_id, `فيه قرار ${d.action} مفتوح بالفعل على نفس الحملة (${d.status}) — مفيش قرارين.`); }
  const cfg = await getOperatorConfig(); const hours = Number(cfg.limits?.manualOverrideCooldownHours ?? 24);
  const manual = await prisma.ambOperatorEvent.findMany({ where: { kind: 'MANUAL_OVERRIDE', campaign_id: { in: ids }, created_at: { gte: new Date(now.getTime() - hours * MS_H) } }, select: { campaign_id: true } });
  for (const e of manual) add(e.campaign_id, `فيه تعديل يدوي أحدث (آخر ${hours} ساعة) — الأتمتة بتحترمه.`);
  const acts = await prisma.ambAction.findMany({ where: { campaign_id: { in: ids }, execution_status: { in: ['EXECUTED', 'VERIFIED'] }, executed_at: { gte: new Date(now.getTime() - 6 * MS_H) } }, select: { campaign_id: true, action_type: true } });
  for (const a of acts) add(a.campaign_id, `اتنفّذ إجراء ${a.action_type} على الحملة خلال آخر 6 ساعات (حماية التكرار).`);
  for (const [k, v] of out) out.set(k, [...new Set(v)]);
  return out;
}

export async function createBulkPlan(args) {
  try { return await createBulkPlanInner(args); } finally { invalidateQueryCache(); } // whatever happened, the list must re-read decisions / plans / approvals on its next request (never show a stale «pending decision»)
}
async function createBulkPlanInner({ user, access, body, now = new Date(), deps = {} }) {
  const b = body || {}; const action = String(b.action || ''); if (!CREATABLE.includes(action)) throw bad('الإنشاء متاح لـ: فتح · إيقاف · زيادة ميزانية · تقليل ميزانية. (الاستثناءات والأرقام المخصصة معاينة فقط.)', 'ACTION_NOT_CREATABLE');
  // 1) re-validate the snapshot and every campaign on LIVE data — exactly the verdicts the user saw
  const prev = await reviewPreview({ user, access, body: { ...b, action }, now });
  const eligible = prev.items.filter((i) => i.kind === 'ELIGIBLE'); const hash = previewHashOf(action, eligible.map((i) => `${i.adAccountId}:${i.campaignId}`));
  if (!b.confirm || b.confirm.hash !== hash) throw bad('النتيجة اتغيّرت من وقت المعاينة (حملات اتغيرت حالتها أو بياناتها) — راجع المعاينة الجديدة وأكّد تاني.', 'PREVIEW_CHANGED', 409, { previewHash: hash, totals: prev.totals });
  if (!eligible.length) throw bad('مفيش حملة مؤهلة في الاختيار ده — مفيش حاجة تتجهّز.', 'NOTHING_ELIGIBLE', 400, { totals: prev.totals });
  const today = cairoDate(now); const ids = eligible.map((i) => i.campaignId);
  // 2) conflicts with active plans / open decisions / newer manual changes / recent executed actions
  const finalHash = previewHashOf(action, ids); const variant = `V2-${finalHash.slice(0, 10)}`;
  const conflicts = await conflictsFor({ ids, action, today, now, planKeyPrefix: variant });
  const clean = eligible.filter((i) => !conflicts.get(i.campaignId)?.length); const cleanIds = clean.map((i) => i.campaignId);
  const rows = []; const byId = new Map(prev.items.map((i) => [i.campaignId, i]));
  const rowOf = (i, outcome, reasons = [], extra = {}) => ({ campaignId: i.campaignId, adAccountId: i.adAccountId, name: i.name || null, outcome, reasons, warnings: i.warnings || [], ...extra });
  for (const i of prev.items) { if (i.kind === 'ELIGIBLE') continue; rows.push(rowOf(i, i.kind === 'EXCLUDED' ? 'EXCLUDED' : i.kind === 'PROTECTED' ? 'PROTECTED' : 'REJECTED', i.reasons)); }
  for (const i of eligible) if (conflicts.get(i.campaignId)?.length) rows.push(rowOf(i, 'CONFLICT', conflicts.get(i.campaignId)));
  const execution = prev.execution; const base = { action, label: prev.label, previewHash: hash, snapshotId: prev.snapshotId, counts: { requested: prev.totals.selected, eligibleAtPreview: eligible.length, afterConflicts: clean.length }, execution };
  const event = async (note, data) => { try { await prisma.ambOperatorEvent.create({ data: { kind: 'V2_BULK_PLAN', actor: 'USER', actor_id: user.id, note: String(note).slice(0, 480), data_json: JSON.stringify({ action, snapshotId: prev.snapshotId, ...data }).slice(0, 3000) } }); } catch (e) { logger.warn('[campaignPlanBridge] audit event failed', { message: e.message }); } };
  if (!cleanIds.length) { await event('خطة جماعية: كل الحملات المؤهلة فيها تعارض — مفيش حاجة اتجهّزت', { eligible: ids.length, conflicts: ids.length }); return { ...base, created: false, kind: null, reason: 'ALL_CONFLICTED', results: rows }; }

  if (action === 'OPEN' || action === 'PAUSE') {
    const type = action; const v2 = variant; let r; // the variant comes from the EXACT eligible set: the same selection can only ever make one plan
    try { r = await preparePlan({ type, date: today, now, simulated: isTestClock(), deps: deps.plan || {}, userId: user.id, variant: v2, only: cleanIds, unselected: false }); }
    catch (e) { if (e.status === 400) { for (const i of clean) rows.push(rowOf(i, 'NOT_IN_ENGINE_POOL', [e.message])); await event('خطة جماعية: محرك الخطط ما رشّحش أي حملة من الاختيار', { clean: cleanIds.length }); return { ...base, created: false, kind: null, reason: 'NOT_IN_ENGINE_POOL', results: rows }; } throw e; }
    if (!r.created) { for (const i of clean) rows.push(rowOf(i, 'DUPLICATE', [`خطة بنفس الاختيار موجودة بالفعل (#${r.plan.id}، حالتها ${r.plan.status}) — مفيش خطة مكررة.`])); return { ...base, created: false, duplicate: true, planId: r.plan.id, planStatus: r.plan.status, kind: 'PLAN', results: rows }; }
    const items = new Map(r.plan.items.map((it) => [it.campaign_id, it])); let selected = 0;
    for (const i of clean) { const it = items.get(i.campaignId); if (!it) rows.push(rowOf(i, 'NOT_IN_ENGINE_POOL', ['محرك الخطط ما رشّحهاش (مش ضمن حساب الأتمتة المتصل أو مش مؤهلة له).'])); else if (it.selected) { selected++; rows.push(rowOf(i, 'IN_PLAN', ['اتحطت في الخطة (PREPARED) — محتاجة اعتماد المسؤول.'], { planItemId: it.id, eligibility: it.eligibility })); } else rows.push(rowOf(i, 'IN_PLAN_NOT_SELECTED', [`المحرك رفض اختيارها: ${(() => { try { return JSON.parse(it.block_codes_json || '[]').join(' · '); } catch { return ''; } })() || it.eligibility}`], { planItemId: it.id, eligibility: it.eligibility })); }
    if (!selected) { await cancelPlan({ planId: r.plan.id, userId: user.id, reason: 'مفيش حملة مؤهلة من محرك الخطط (خطة جماعية V2)', now }).catch(() => {}); await event(`خطة جماعية #${r.plan.id} اتلغت: مفيش حملة مؤهلة عند المحرك`, { planId: r.plan.id }); return { ...base, created: false, kind: 'PLAN', planId: r.plan.id, planStatus: 'CANCELLED', reason: 'NONE_SELECTABLE', results: rows }; }
    await event(`خطة جماعية ${type} #${r.plan.id} اتجهّزت PREPARED (${selected} حملة)`, { planId: r.plan.id, variant: v2, campaigns: cleanIds.slice(0, 200), selected });
    return { ...base, created: true, kind: 'PLAN', planId: r.plan.id, planStatus: 'PREPARED', planVersion: r.plan.version, selected, results: rows, next: 'APPROVALS' };
  }

  // budget: PREPARED decisions from the optimizer's own evaluation (never a custom number)
  const cfg = await (deps.config ? deps.config() : getOperatorConfig()); if (cfg.mode !== 'APPROVAL') throw bad(`الوضع الحالي ${cfg.mode} — تجهيز قرارات الميزانية للموافقة محتاج وضع APPROVAL.`, 'MODE_NOT_APPROVAL', 409);
  const res = await (deps.evaluate || ((o) => evaluateBudgetOptimization(o)))({ now, persist: false, live: true, only: { campaignIds: cleanIds }, ruleMode: 'APPROVAL' });
  if (res.structureSource !== 'META_LIVE') { for (const i of clean) rows.push(rowOf(i, 'NO_LIVE_DATA', [`بنية الميزانية ما اتقرتش لايف من Meta (${res.structureSource}) — مفيش تحضير على بيانات قديمة.`])); await event('خطة ميزانية جماعية: مفيش بيانات لايف', { clean: cleanIds.length }); return { ...base, created: false, kind: 'DECISIONS', reason: 'NO_LIVE_DATA', results: rows }; }
  const [wantAction, wantDecision] = BUDGET_EXPECT[action]; const ok = [];
  for (const i of clean) {
    const mine = res.rows.filter((r) => r.campaignId === i.campaignId && r.intended); if (mine.length !== 1) { rows.push(rowOf(i, 'NOT_PREPARED', [mine.length ? 'الحملة فيها أكتر من Ad Set بقرار — اختار Ad Set واحد من شاشة الميزانيات (مفيش تحويل لتعديل على الحملة).' : 'محرك الميزانية مفيش عنده قرار للحملة دي دلوقتي (حسب سياسته وCooldown).'])); continue; }
    const row = mine[0]; if (row.intended.action !== wantAction || row.decision !== wantDecision || row.wouldBe !== 'PREPARED' || row.primaryBlock) { rows.push(rowOf(i, 'NOT_PREPARED', [`قرار المحرك الحالي ${row.decision} (${row.intended.action}) — مش ${action === 'INCREASE_BUDGET' ? 'زيادة' : 'تقليل'} قابلة للتحضير.`])); continue; }
    if (row.intended.action === 'SCALE_UP') { const cap = await checkBudgetCaps({ action: 'SCALE_UP', delta: (row.intended.toBudget ?? 0) - (row.intended.fromBudget ?? 0), adAccountId: res.adAccountId || row.adAccountId, campaignId: i.campaignId, productId: row.productId ?? null, productCapOverride: dailyCapFromLimits(cfg.limits, row.storeId, row.productId, i.campaignId), now, deps: deps.capsDeps || {} }); if (!cap.ok) { rows.push(rowOf(i, 'NOT_PREPARED', [`الزيادة هتتجاوز حدّ الميزانية: ${cap.violations.map((v) => `${v.label} (${v.after} > ${v.cap})`).join('، ')}`])); continue; } }
    ok.push({ i, row });
  }
  if (!ok.length) { await event('خطة ميزانية جماعية: المحرك ما حضّرش أي قرار', { clean: cleanIds.length }); return { ...base, created: false, kind: 'DECISIONS', reason: 'NONE_PREPARED', results: rows }; }
  await (deps.persist || persistBudgetDecisions)(ok.map((x) => x.row), { adAccountId: res.adAccountId || ok[0].row.adAccountId, mode: 'APPROVAL', now, expireStale: false });
  const decs = await prisma.ambOperatorDecision.findMany({ where: { rule_name: { startsWith: 'DYNAMIC_BUDGET:' }, campaign_id: { in: ok.map((x) => x.i.campaignId) }, status: 'PREPARED' }, orderBy: { id: 'desc' }, select: { id: true, campaign_id: true, params_json: true } }); const decBy = new Map(); for (const d of decs) if (!decBy.has(d.campaign_id)) decBy.set(d.campaign_id, d);
  let prepared = 0; for (const x of ok) { const d = decBy.get(x.i.campaignId); if (d) { prepared++; rows.push(rowOf(x.i, 'PREPARED', [`قرار ميزانية PREPARED #${d.id}: ${x.row.intended.fromBudget} ← ${x.row.intended.toBudget} (حسب محرك الميزانية) — محتاج اعتماد المسؤول.`], { decisionId: d.id, fromBudget: x.row.intended.fromBudget, toBudget: x.row.intended.toBudget })); } else rows.push(rowOf(x.i, 'NOT_PREPARED', ['القرار ما اتحفظش كـPREPARED.'])); }
  await event(`قرارات ميزانية جماعية PREPARED (${prepared})`, { prepared, campaigns: ok.map((x) => x.i.campaignId).slice(0, 200) });
  return { ...base, created: prepared > 0, kind: 'DECISIONS', prepared, decisionIds: [...decBy.values()].map((d) => d.id), results: rows, next: 'APPROVALS' };
}
