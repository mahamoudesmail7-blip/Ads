// AI Operator — INTEGRATION LAYER. 2026-10-09.
// One place that makes the features behave as ONE system instead of separate pages. It composes the EXISTING pieces (no second policy store, no second metrics engine):
//   • ONE approved policy source per product = productPolicy (versioned: draft ≠ active) + the global budget policy + the saved «الفتح حسب CPA» policy → resolvePolicy() gives the unified, versioned view;
//   • identity: every campaign → its verified product + store (campaign↔product map), and executions require it;
//   • every Action is stamped with the policy versions it was decided under (policyRef) → shown in the Execution History;
//   • conflicts: open vs pause, scale-up vs scale-down, plan queue vs budget — blocked, never raced;
//   • a policy change reconciles what is pending (approved-but-not-started plans are cancelled and re-prepared for a NEW approval; PREPARED decisions are expired so they are re-evaluated) — nothing executes;
//   • Today / 7D / 30D = the Cairo-day windows everywhere; Safety Guards stay above every policy; health + map for the Operator UI.
import { prisma } from '../../prisma.js';
import { getConnection } from '../metaAuth.js';
import { getOperatorConfig } from './operatorStore.js';
import { getProductPolicy, mergeEffective, applyToBudgetPolicy, policyKey, activePolicyFromLimits } from './productPolicy.js';
import { getBudgetPolicy } from './budgetOptimizer.js';
import { getOpenCpaPolicy } from './openCpaPolicy.js';
import { cairoDate, isTestClock } from './dailyPlanTime.js';
import { raiseAlert } from './alerts.js';
import { buildCampaignProductIndex, listCampaignsFromSnapshots } from './operatorContext.js';
import { getSyncStatus } from './snapshotSync.js';
import { boardWindows } from './campaignBoard.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const FINAL_ITEM = new Set(['VERIFIED', 'FAILED', 'SKIPPED', 'BLOCKED', 'SIMULATED', 'UNCERTAIN']);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 1) ONE versioned policy per product (+ the layers it sits on)
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** The compact stamp stored with every Action: which policy versions the decision was made under. */
export async function policyRefFor({ productId = null, storeId = null, campaignId = null } = {}) {
  const [open, glob] = await Promise.all([getOpenCpaPolicy().catch(() => null), getOperatorConfig().catch(() => null)]);
  let prod = null;
  if (productId != null) { const pol = await getProductPolicy({ productId, storeId }).catch(() => null); if (pol) prod = { key: pol.key, status: pol.status, version: pol.version || 0, activatedAt: pol.activatedAt || null, active: !!pol.active, campaignOverride: !!(campaignId && pol.active?.campaigns?.[campaignId]) }; }
  return { at: new Date().toISOString(), productPolicy: prod, openCpa: open ? { version: open.version, enabled: open.enabled, approvedVersion: open.approved?.version ?? null, minCpa: open.minCpa, maxCpa: open.maxCpa, window: open.window } : null, budgetPolicy: prod?.active ? 'PRODUCT_OVER_GLOBAL' : 'GLOBAL', globalUpdatedAt: glob?.updated_at || null };
}
/**
 * The unified, versioned view every screen reads: identity (product + store + mapping), the policy layers with their versions, and the EFFECTIVE values.
 * Precedence (documented + tested): Emergency Stop > Safety Guards (global limits) > product policy (draft is NOT applied) > global budget policy. A product value can never loosen a global guard.
 */
export async function resolvePolicy({ campaignId = null, productId = null, storeId = null, now = new Date(), deps = {} } = {}) {
  const config = deps.config || await getOperatorConfig(); const limits = config.limits || {};
  let identity = null;
  if (campaignId) identity = await campaignIdentity(campaignId, { deps });
  const pid = productId ?? identity?.productId ?? null; const sid = storeId ?? identity?.storeId ?? null;
  const ref = await policyRefFor({ productId: pid, storeId: sid, campaignId });
  const pol = pid != null ? await getProductPolicy({ productId: pid, storeId: sid }) : null; const active = pol?.active || null; // a DRAFT is never read here
  const eff = mergeEffective(active, campaignId); const globalBudget = deps.globalBudget || await getBudgetPolicy(); const merged = applyToBudgetPolicy(globalBudget, active, campaignId);
  const open = await getOpenCpaPolicy();
  const globalMaxDecrease = Number(limits.maxDecreasePct) || null;
  const decreasePct = eff.budget.decreasePct ?? merged.policy.reduce?.pct ?? null; // product value first, global otherwise
  const clamps = []; let decreaseEffective = decreasePct; if (globalMaxDecrease && decreasePct != null && decreasePct > globalMaxDecrease) { decreaseEffective = globalMaxDecrease; clamps.push({ field: 'decreasePct', product: decreasePct, appliedGlobalLimit: globalMaxDecrease, why: 'حد التقليل العام (Safety Guard) أعلى من أي قيمة للمنتج' }); }
  return {
    campaignId, identity, productId: pid, storeId: sid, policyRef: ref, hasActiveProductPolicy: !!active, draftIgnored: !!pol?.draft,
    effective: {
      mode: eff.mode || null, cpa: { zones: { scale: merged.policy.scale?.maxCpa ?? null, keepMin: merged.policy.keep?.minCpa ?? null, keepMax: merged.policy.keep?.maxCpa ?? null, reduceMin: merged.policy.reduce?.minCpa ?? null, reduceMax: merged.policy.reduce?.maxCpa ?? null, highAbove: merged.policy.highCpa?.above ?? null }, hardStop: eff.cpa.hardStop ?? null },
      budget: { increasePct: eff.budget.increasePct ?? merged.policy.scale?.pct ?? null, decreasePct: decreaseEffective, minPurchases: eff.budget.minPurchases ?? merged.policy.scale?.minPurchases ?? null, cooldownHours: eff.budget.cooldownHours ?? merged.policy.scale?.cooldownHours ?? null, minBudget: eff.budget.minBudget ?? null, maxBudget: eff.budget.maxBudget ?? null, dailySpendCap: eff.budget.dailySpendCap ?? null },
      schedule: { openTime: eff.schedule.openTime ?? null, closeTime: eff.schedule.closeTime ?? null, days: eff.schedule.days ?? null }, zeroOrder: { spend: eff.zeroOrder.spend ?? merged.policy.zeroOrders?.spend ?? null, minAgeHours: eff.zeroOrder.minAgeHours ?? merged.policy.zeroOrders?.minAgeHours ?? null },
      manualOverrideHours: eff.manualOverrideHours ?? limits.manualOverrideCooldownHours ?? null, stockPolicy: eff.stockPolicy || null,
      openCpa: open.minCpa != null && open.maxCpa != null ? { min: open.minCpa, max: open.maxCpa, window: open.window, minPurchases: open.minPurchases, maxDataAgeMin: open.maxDataAgeMin, enabled: open.enabled, version: open.version } : null,
    },
    guards: { emergencyStop: !!config.emergency_stop, mode: config.mode, writesLocked: !!config.writesLocked, globalMaxDecreasePct: globalMaxDecrease, clamps, precedence: PRECEDENCE },
    windows: boardWindows(cairoDate(now)),
  };
}
export const PRECEDENCE = ['EMERGENCY_STOP', 'GLOBAL_SAFETY_GUARDS', 'PRODUCT_POLICY (active, versioned)', 'GLOBAL_BUDGET_POLICY'];

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 2) identity: campaign → product + store (verified)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export async function campaignIdentity(campaignId, { adAccountId = null, deps = {} } = {}) {
  const acc = adAccountId || (await getConnection())?.selected_ad_account_id || null; if (!acc) return { campaignId, productId: null, storeId: null, verified: false, via: null };
  const idx = deps.index || await buildCampaignProductIndex({ adAccountId: acc }); const px = idx.get(campaignId); if (!px) return { campaignId, productId: null, storeId: null, verified: false, via: null };
  const rows = await prisma.$queryRawUnsafe('select p.id as product_id, p.product_name, p.store_id from amb_products ap join products p on p.id = ap.product_id where ap.id = $1', px.ambProductId);
  const r = rows[0]; return { campaignId, productId: r?.product_id ?? null, productName: r?.product_name ?? null, storeId: r?.store_id ?? null, verified: !!px.verified, via: px.via };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 3) conflicts — never race two opposite operations on the same campaign
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const CONFLICT_AR = { CONFLICT_OPEN_AND_PAUSE: 'فتح وإيقاف نفس الحملة في خطتين معتمدتين', CONFLICT_PLAN_QUEUE_BUDGET: 'الحملة داخل طابور خطة معتمدة — مفيش تعديل ميزانية معاها في نفس الوقت', CONFLICT_BUDGET_UP_DOWN: 'زيادة وتقليل ميزانية نفس الحملة في نفس الوقت', CONFLICT_BUDGET_IN_FLIGHT: 'فيه تعديل ميزانية شغّال دلوقتي على نفس الحملة', CONFLICT_PLAN_QUEUE_EXECUTING: 'فيه عملية فتح/إيقاف شغّالة دلوقتي على نفس الحملة' };
/** want: OPEN | PAUSE | SCALE_UP | SCALE_DOWN. Returns [] when it is safe, otherwise the conflicts (code + detail). Read-only. */
export async function checkConflicts({ campaignId, want, planId = null, excludeDecisionId = null, now = new Date(), simulated = false }) {
  const out = []; const date = cairoDate(now); const budgetWant = want === 'SCALE_UP' || want === 'SCALE_DOWN';
  const items = await prisma.ambDailyPlanItem.findMany({ where: { campaign_id: campaignId, selected: true, plan: { plan_date: date, simulated, status: { in: ['APPROVED', 'RUNNING'] } } }, select: { status: true, plan: { select: { id: true, type: true, status: true } } } });
  const live = items.filter((i) => !FINAL_ITEM.has(i.status) && i.plan.id !== planId);
  if (want === 'OPEN' && live.some((i) => i.plan.type === 'PAUSE')) out.push({ code: 'CONFLICT_OPEN_AND_PAUSE', detail: 'خطة إيقاف معتمدة فيها نفس الحملة' });
  if (want === 'PAUSE' && live.some((i) => i.plan.type === 'OPEN')) out.push({ code: 'CONFLICT_OPEN_AND_PAUSE', detail: 'خطة فتح معتمدة فيها نفس الحملة' });
  if (budgetWant && live.length) out.push({ code: 'CONFLICT_PLAN_QUEUE_BUDGET', detail: `خطة ${live[0].plan.type === 'OPEN' ? 'فتح' : 'إيقاف'} #${live[0].plan.id} (${live[0].plan.status})` });
  const decisions = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: campaignId, rule_name: { startsWith: 'DYNAMIC_BUDGET:' }, status: { in: ['APPROVED', 'EXECUTING'] }, ...(excludeDecisionId ? { id: { not: Number(excludeDecisionId) } } : {}) }, select: { id: true, action: true, status: true } });
  if (budgetWant) {
    if (decisions.some((d) => d.status === 'EXECUTING')) out.push({ code: 'CONFLICT_BUDGET_IN_FLIGHT', detail: `قرار #${decisions.find((d) => d.status === 'EXECUTING').id}` });
    const opposite = want === 'SCALE_UP' ? 'SCALE_DOWN' : 'SCALE_UP'; if (decisions.some((d) => d.action === opposite)) out.push({ code: 'CONFLICT_BUDGET_UP_DOWN', detail: `${opposite} معتمد/شغّال على نفس الحملة` });
  } else if (decisions.some((d) => d.status === 'EXECUTING')) out.push({ code: 'CONFLICT_BUDGET_IN_FLIGHT', detail: 'تعديل ميزانية شغّال على الحملة' });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 4) a policy change reconciles what is pending — it never executes anything
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** Called after a product policy was ACTIVATED / DEACTIVATED / replaced. */
export async function onProductPolicyChanged({ productId, storeId = null, kind = 'CHANGED', userId = null, now = new Date(), simulated = isTestClock(), deps = {} }) {
  const daily = deps.daily || await import('./dailyPlans.js'); const ref = await policyRefFor({ productId, storeId });
  const plans = await daily.reconcilePlansForProduct({ productId, storeId, kind, policyVersion: ref.productPolicy?.version ?? null, userId, now, simulated });
  const open = await prisma.ambOperatorDecision.findMany({ where: { product_id: Number(productId), status: { in: ['PREPARED', 'APPROVED'] } }, select: { id: true, campaign_id: true, status: true, rule_name: true } });
  const expired = []; for (const d of open) { const r = await prisma.ambOperatorDecision.updateMany({ where: { id: d.id, status: d.status }, data: { status: 'EXPIRED', error: `POLICY_CHANGED (${kind}) — يعاد تقييم القرار على السياسة الجديدة`, error_category: 'POLICY' } }); if (r.count) expired.push(d.id); }
  const n = plans.superseded.length + plans.flagged.length + expired.length;
  const out = { productId, kind, policyVersion: ref.productPolicy?.version ?? null, plans, decisionsExpired: expired, affected: n };
  await prisma.ambOperatorEvent.create({ data: { kind: 'POLICY_CHANGE_RECONCILED', actor: userId ? 'USER' : 'SYSTEM', actor_id: userId, note: `تغيّرت سياسة المنتج ${policyKey(storeId, productId)} (${kind}) — ${plans.superseded.length} خطة معتمدة اتلغت لإعادة الاعتماد · ${plans.flagged.length} خطة معلّمة · ${expired.length} قرار اتبطل لإعادة التقييم (مفيش تنفيذ)`, data_json: JSON.stringify(out).slice(0, 3000) } }).catch(() => {});
  if (n && !(deps.noAlerts || process.env.DAILY_PLAN_DISABLE_ALERTS === '1')) await raiseAlert({ severity: 'INFO', category: 'OPERATOR', title: 'تغيّرت سياسة منتج — اتأثرت عمليات معلّقة', message: `${plans.superseded.length} خطة معتمدة اتلغت وتحتاج اعتماد جديد · ${expired.length} قرار ميزانية اتبطل لإعادة التقييم. مفيش أي تنفيذ حصل.`.slice(0, 480), dedupeKey: `policychange:${policyKey(storeId, productId)}:v${ref.productPolicy?.version ?? 0}:${kind}` }).catch(() => {});
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 5) health + the map
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const INTEGRATION_MAP = {
  nodes: [
    { id: 'pricing', label: 'التسعير الذكي', kind: 'input', owns: 'تكاليف المنتج + السعر المقترح (اقتراح فقط)' },
    { id: 'rules', label: 'قواعد المنتجات', kind: 'source', owns: 'سياسة كل منتج (نسخة + مسودة ≠ مفعّلة) — المصدر الوحيد' },
    { id: 'openCpa', label: 'الفتح حسب CPA', kind: 'policy', owns: 'نطاق CPA + الفترة + الحد الأدنى للعينة (نسخة)' },
    { id: 'guards', label: 'Safety Guards', kind: 'guard', owns: 'حدود عامة فوق أي سياسة (Emergency / كتابة مقفولة / Cooldown / Manual Override)' },
    { id: 'identity', label: 'ربط الحملة بالمنتج والمتجر', kind: 'data', owns: 'campaign → product + store (مؤكد)' },
    { id: 'metrics', label: 'Meta — Today / 7D / 30D (القاهرة)', kind: 'data', owns: 'آخر لقطة لكل يوم، CPA = صرف ÷ أوردرات' },
    { id: 'scheduler', label: 'الجدولة اليومية', kind: 'engine', owns: 'خطط الفتح 12:00 ص والإيقاف 1:00 ظ + مواعيد المنتجات' },
    { id: 'open', label: 'فتح الحملات', kind: 'action', owns: 'RESUME' }, { id: 'pause', label: 'إيقاف الحملات', kind: 'action', owns: 'PAUSE' },
    { id: 'up', label: 'زيادة الميزانية', kind: 'action', owns: 'SCALE_UP' }, { id: 'down', label: 'تقليل الميزانية', kind: 'action', owns: 'SCALE_DOWN' },
    { id: 'approvals', label: 'مركز الموافقات', kind: 'gate', owns: 'اعتماد ADMIN — لا تنفيذ بدونه (APPROVAL)' },
    { id: 'history', label: 'سجل التنفيذ', kind: 'record', owns: 'كل Action: السبب + نسخة السياسة + نتيجة قراءة Meta' },
    { id: 'alerts', label: 'التنبيهات الذكية', kind: 'record', owns: 'أي فشل / غير مؤكد / تغيّر سياسة' },
  ],
  edges: [
    ['pricing', 'rules', 'معاينة ثم تأكيد → مسودة فقط (لا تفعيل، لا سعر يتغير)'], ['rules', 'scheduler', 'مواعيد المنتج + أيام + Daily Cap'], ['rules', 'open', 'حواجز + مواعيد'], ['rules', 'pause', 'CPA zones + Winner/Manual'], ['rules', 'up', 'نسبة + Cooldown + حدود'], ['rules', 'down', 'نسبة + Cooldown + حدود'],
    ['openCpa', 'scheduler', 'اختيار افتراضي للمطابقة'], ['guards', 'open', 'فوق السياسة'], ['guards', 'pause', 'فوق السياسة'], ['guards', 'up', 'فوق السياسة'], ['guards', 'down', 'فوق السياسة'],
    ['identity', 'scheduler', 'منتج + متجر مؤكدين'], ['metrics', 'scheduler', 'بيانات حديثة فقط'], ['metrics', 'up', 'تقييم حي'], ['metrics', 'down', 'تقييم حي'],
    ['scheduler', 'approvals', 'خطة PREPARED'], ['up', 'approvals', 'قرار PREPARED'], ['down', 'approvals', 'قرار PREPARED'], ['approvals', 'open', 'اعتماد → تحقق حي'], ['approvals', 'pause', 'اعتماد → تحقق حي'],
    ['open', 'history', 'Action + policyRef'], ['pause', 'history', 'Action + policyRef'], ['up', 'history', 'Action + policyRef'], ['down', 'history', 'Action + policyRef'], ['history', 'alerts', 'فشل / غير مؤكد'], ['rules', 'approvals', 'تغيير السياسة → إلغاء/إعادة تقييم المعلّق'],
  ],
};
export async function integrationHealth({ now = new Date(), simulated = false } = {}) {
  const checks = []; const add = (key, label, ok, detail, severity = ok ? 'ok' : 'warn') => checks.push({ key, label, ok, severity, detail });
  const acc = (await getConnection())?.selected_ad_account_id || null; const config = await getOperatorConfig(); const open = await getOpenCpaPolicy(); const date = cairoDate(now);
  // identity
  if (acc) { const camps = (await listCampaignsFromSnapshots({ adAccountId: acc })).filter((c) => c.status === 'ACTIVE'); const idx = await buildCampaignProductIndex({ adAccountId: acc }); const verified = camps.filter((c) => idx.get(c.id)?.verified).length; add('identity', 'كل الحملات النشطة مرتبطة بمنتج ومتجر مؤكدين', verified === camps.length, `${verified} من ${camps.length} مؤكدة`, verified === camps.length ? 'ok' : 'warn'); }
  else add('identity', 'اتصال Meta', false, 'مفيش حساب إعلاني مختار', 'bad');
  // freshness
  const sync = await getSyncStatus().catch(() => null); const age = sync?.lastSuccessAt ? Math.round((now.getTime() - new Date(sync.lastSuccessAt).getTime()) / 60000) : null;
  add('freshness', 'بيانات Meta حديثة (قرارات التنفيذ بتتاخد منها فقط)', age != null && age <= 60, age == null ? 'مفيش مزامنة ناجحة' : `آخر مزامنة من ${age} دقيقة`, age != null && age <= 60 ? 'ok' : 'bad');
  add('cairo', 'Today / 7D / 30D بتوقيت القاهرة', boardWindows(date).today.from === date, `اليوم = ${date}`);
  // policy single source
  const raw = config.limits || {}; const prodPolicies = Object.entries(raw.productPolicies || {}); const active = prodPolicies.filter(([, v]) => v?.active), drafts = prodPolicies.filter(([, v]) => v?.draft && !v?.active);
  add('policies', 'سياسات المنتجات: مصدر واحد بنسخة (المسودة ≠ مفعّلة)', true, `${active.length} مفعّلة · ${drafts.length} مسودة (غير مطبّقة)`);
  add('openCpa', 'سياسة الفتح حسب CPA', !open.enabled || (open.minCpa != null && open.maxCpa != null), open.enabled ? `مفعّلة v${open.version} (${open.minCpa}–${open.maxCpa})${open.approved?.version === open.version ? ' · معتمدة' : ' · النسخة الحالية غير معتمدة للتنفيذ التلقائي'}` : `مقفولة (v${open.version})`);
  // pending plans vs policy versions
  const plans = await prisma.ambDailyPlan.findMany({ where: { plan_date: date, simulated, status: { in: ['PREPARED', 'APPROVED'] }, type: 'OPEN' }, select: { id: true, status: true, evidence_json: true } });
  const stale = plans.filter((p) => { const u = j(p.evidence_json, {}).openCpa; return u && u.version !== open.version; });
  add('pendingPlans', 'الخطط المعلّقة على نسخة السياسة الحالية', stale.length === 0, stale.length ? `${stale.length} خطة اتجهزت بنسخة أقدم — جهّز من جديد` : `${plans.length} خطة معلّقة، كلها متوافقة`, stale.length ? 'warn' : 'ok');
  // conflicts inside approved/running queues
  const queue = await prisma.ambDailyPlanItem.findMany({ where: { selected: true, plan: { plan_date: date, simulated, status: { in: ['APPROVED', 'RUNNING'] } } }, select: { campaign_id: true, status: true, plan: { select: { type: true } } } });
  const byC = new Map(); for (const q of queue.filter((x) => !FINAL_ITEM.has(x.status))) (byC.get(q.campaign_id) || byC.set(q.campaign_id, new Set()).get(q.campaign_id)).add(q.plan.type);
  const clash = [...byC].filter(([, t]) => t.size > 1).map(([c]) => c);
  add('conflicts', 'مفيش فتح وإيقاف لنفس الحملة في طوابير معتمدة', clash.length === 0, clash.length ? `${clash.length} حملة متعارضة` : 'لا تعارض', clash.length ? 'bad' : 'ok');
  // failures visible
  const since = new Date(now.getTime() - 24 * 3_600_000); const bad = await prisma.ambDailyPlanItem.count({ where: { status: { in: ['FAILED', 'UNCERTAIN'] }, status_at: { gte: since } } });
  const alerts = bad ? await prisma.ambAlert.count({ where: { category: 'EXECUTION', created_at: { gte: since } } }) : 0;
  add('failures', 'كل فشل/غير مؤكد ظاهر في التنبيهات وسجل التنفيذ', bad === 0 || alerts > 0, bad ? `${bad} عنصر فشل/غير مؤكد · ${alerts} تنبيه` : 'لا فشل في آخر 24 ساعة', bad === 0 || alerts > 0 ? 'ok' : 'bad');
  add('safety', 'الأمان: SHADOW/كتابة مقفولة/صلاحيات', true, `الوضع ${config.mode} · الكتابة ${config.writesLocked ? 'مقفولة' : 'مفتوحة'} · Emergency ${config.emergency_stop ? 'مفعّل' : 'مقفول'}`);
  return { at: now.toISOString(), overall: checks.some((c) => c.severity === 'bad') ? 'bad' : checks.some((c) => c.severity === 'warn') ? 'warn' : 'ok', checks };
}
