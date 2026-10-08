// 🧭 Production Readiness Dashboard — READY / BLOCKED / UNVERIFIED per function, computed ONLY from real evidence (never from "the code exists" or from local tests).
//   READY      = proven on Meta by a real executed + independently read-back action (or, for non-Meta functions, demonstrably running now).
//   UNVERIFIED = the code path exists but has never been proven by a real Meta execution.
//   BLOCKED    = a hard policy/safety gate forbids it until the owner decides (e.g. Autopilot).
// `gates` lists what is closed RIGHT NOW (mode / deployment write-lock / per-type permission …) — independent of the proof status.
import { prisma } from '../../prisma.js';
import { getOperatorConfig } from './operatorStore.js';
import { getAmbSettings } from './settings.js';
import { getBudgetPolicy } from './budgetOptimizer.js';
import { EXECUTABLE_ACTIONS } from './budgetExecution.js';
import { getDailyPlanConfig, dailyPlanSchedulerStarted } from './dailyPlans.js';
import { cairoDate } from './dailyPlanTime.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** Real executed actions of one type whose independent read-back confirmed the change. */
async function provenBy(actionType, deps) {
  const rows = deps.executed ? deps.executed.filter((r) => r.action_type === actionType) : await prisma.ambAction.findMany({ where: { action_type: actionType, execution_status: 'EXECUTED', NOT: { OR: [{ entity_id: { startsWith: '__optest_' } }, { ad_account_id: { startsWith: '__optest_' } }] } }, select: { id: true, entity_name: true, executed_at: true, verify_json: true }, orderBy: { id: 'desc' }, take: 50 });
  const ok = rows.filter((r) => j(r.verify_json, {})?.verified === true);
  return { executed: rows.length, verified: ok.length, last: ok[0] ? { actionId: ok[0].id, name: ok[0].entity_name, at: ok[0].executed_at } : null };
}

export async function buildProductionReadiness({ now = new Date(), deps = {} } = {}) {
  const cfg = deps.config || await getOperatorConfig(); const s = deps.settings || await getAmbSettings(); const dcfg = deps.dcfg || await getDailyPlanConfig();
  const policy = deps.policy || await getBudgetPolicy();
  const proof = { OPEN: await provenBy('RESUME', deps), PAUSE: await provenBy('PAUSE', deps), UP: await provenBy('INCREASE_BUDGET', deps), DOWN: await provenBy('DECREASE_BUDGET', deps) };
  const toggles = { open: !!s.ambAllowAutoOpen, pause: !!s.ambAllowAutoPause, scale: !!s.ambAllowAutoScale, up: !!s.ambAllowAutoBudgetIncrease, down: !!s.ambAllowAutoBudgetDecrease };
  const P = cfg.execPermissions || null; // the four audited switches (null only for stubbed configs)
  const baseGates = [];
  if (cfg.emergency_stop) baseGates.push('Emergency Stop مفعّل');
  if (cfg.mode !== 'APPROVAL') baseGates.push(`الوضع ${cfg.mode === 'OFF' ? 'MANUAL' : cfg.mode} (التنفيذ بموافقة محتاج APPROVAL)`);
  if (cfg.writesLocked) baseGates.push('كتابة Meta مقفولة على مستوى النشر');
  const todayPlans = deps.todayPlans || await prisma.ambDailyPlan.findMany({ where: { plan_date: cairoDate(now), simulated: false }, select: { id: true, type: true, status: true, version: true, data_state: true } });
  const sched = deps.schedulerStarted ?? dailyPlanSchedulerStarted();
  const apprVerified = deps.approvedDecision ?? await prisma.ambOperatorDecision.count({ where: { status: 'VERIFIED', NOT: { campaign_id: { startsWith: '__optest_' } } } });
  const advisor = deps.advisorPlans ?? await prisma.ambAdvisorPlanVersion.count();
  const invLinked = deps.inventoryProducts ?? (await prisma.inventorySnapshot.findMany({ where: { source: { startsWith: 'INVENTORY_API' } }, distinct: ['product_id'], select: { product_id: true } })).length;
  const totalVerified = proof.OPEN.verified + proof.PAUSE.verified + proof.UP.verified + proof.DOWN.verified;
  const meta = (p, name) => ({ proven: p.verified > 0 ? { count: p.verified, last: p.last } : null, note: p.verified > 0 ? `اتنفّذ فعليًا واتأكد بقراءة مستقلة من Meta (${p.verified}×) — آخرها: ${p.last?.name || '—'}` : `ما اتنفّذش فعليًا على Meta ولا مرة (${name}) — الكود والاختبارات المحلية مش دليل.` });
  const fn = [];
  fn.push({ key: 'CAMPAIGN_OPEN', label: 'Campaign Open', status: proof.OPEN.verified > 0 ? 'READY' : 'UNVERIFIED', gates: [...baseGates, ...((P ? P.open : dcfg.allowOpen) ? [] : ['صلاحية «فتح الحملات» مقفولة'])], needsApproval: true, ...meta(proof.OPEN, 'RESUME') });
  fn.push({ key: 'CAMPAIGN_PAUSE', label: 'Campaign Pause', status: proof.PAUSE.verified > 0 ? 'READY' : 'UNVERIFIED', gates: [...baseGates, ...((P ? P.pause : dcfg.allowPause) ? [] : ['صلاحية «إيقاف الحملات» مقفولة'])], needsApproval: true, ...meta(proof.PAUSE, 'PAUSE') });
  fn.push({ key: 'BUDGET_INCREASE', label: 'Budget Increase', status: proof.UP.verified > 0 ? 'READY' : 'UNVERIFIED', gates: [...baseGates, ...(P && !P.budgetIncrease ? ['صلاحية «زيادة الميزانية» مقفولة'] : []), ...(EXECUTABLE_ACTIONS.has('SCALE_UP') ? [] : ['جسر تنفيذ الميزانية بيسمح بالتقليل فقط لحد ما توسّعه بقرارك'])], needsApproval: true, ...meta(proof.UP, 'INCREASE_BUDGET') });
  fn.push({ key: 'BUDGET_REDUCE', label: 'Budget Reduce', status: proof.DOWN.verified > 0 ? 'READY' : 'UNVERIFIED', gates: [...baseGates, ...(P && !P.budgetDecrease ? ['صلاحية «تقليل الميزانية» مقفولة'] : [])], needsApproval: true, ...meta(proof.DOWN, 'DECREASE_BUDGET') });
  const planOk = todayPlans.length > 0;
  fn.push({ key: 'DAILY_SCHEDULER', label: 'Daily Scheduler', status: sched && planOk && !dcfg.halted ? 'READY' : dcfg.halted ? 'BLOCKED' : 'UNVERIFIED', gates: [...(dcfg.halted ? ['الطابور موقوف (Kill Switch)'] : []), ...(dcfg.scheduledExecution.enabled ? [] : ['التنفيذ المجدول التلقائي مقفول (الاعتماد = تنفيذ لحظي بعد ضغطك)'])], needsApproval: false, proven: planOk ? { count: todayPlans.length } : null, note: sched ? (planOk ? `شغال وجهّز خطط اليوم (${todayPlans.map((p) => `${p.type}:${p.status}`).join('، ')}) — بيجهّز وينبّه بس، مبيّنفذش لوحده` : 'شغال لكن ما جهّزش خطة النهارده لسه') : 'المجدول مش شغال في العملية دي' });
  fn.push({ key: 'APPROVAL', label: 'Approval', status: apprVerified > 0 ? 'READY' : 'UNVERIFIED', gates: [], needsApproval: false, proven: apprVerified > 0 ? { count: apprVerified } : null, note: apprVerified > 0 ? 'مسار موافقة ADMIN اشتغل فعليًا (قرار ميزانية VERIFIED). اعتماد الخطط اليومية اتجرّب كمحاكاة SHADOW فقط.' : 'مسار الموافقة ما اتجرّبش فعليًا.' });
  fn.push({ key: 'AUTOPILOT', label: 'Autopilot', status: 'BLOCKED', gates: [`الوضع ${cfg.mode}`, ...(Object.keys(cfg.autopilotAttest || {}).length ? [] : ['بوابة التفعيل (الإقرارات اليدوية) ناقصة']), ...Object.entries(toggles).filter(([, v]) => !v).map(([k]) => `Auto ${k} مقفول`)], needsApproval: true, proven: null, note: 'مقفول عمدًا — مفيش تشغيل تلقائي على الحساب قبل ما تعتمد كل نوع لوحده.' });
  fn.push({ key: 'INVENTORY', label: 'Inventory', status: invLinked > 0 ? 'READY' : 'UNVERIFIED', gates: [], needsApproval: false, proven: invLinked > 0 ? { count: invLinked } : null, note: `${invLinked} منتج عليه مخزون Live من الـAPI — اختياري حاليًا. STOCK_UNKNOWN = تحذير، والمخزون صفر المؤكد بيمنع الفتح والتوسع.` });
  fn.push({ key: 'SMART_ADVISOR', label: 'Smart Advisor', status: advisor > 0 ? 'READY' : 'UNVERIFIED', gates: [], needsApproval: false, proven: advisor > 0 ? { count: advisor } : null, note: `${advisor} نسخة خطة محفوظة` });
  fn.push({ key: 'META_VERIFICATION', label: 'Meta Verification (Read-back)', status: totalVerified > 0 ? 'READY' : 'UNVERIFIED', gates: [], needsApproval: false, proven: totalVerified > 0 ? { count: totalVerified } : null, note: totalVerified > 0 ? `القراءة المستقلة اتأكدت فعليًا على تعديل ميزانية. مسار Pause/Open ما اتجرّبش (${proof.PAUSE.verified + proof.OPEN.verified} تأكيد).` : 'ما اتأكدش على Meta فعليًا.' });
  const count = (st) => fn.filter((f) => f.status === st).length;
  return { generatedAt: now, summary: { READY: count('READY'), BLOCKED: count('BLOCKED'), UNVERIFIED: count('UNVERIFIED') }, functions: fn, control: { execPermissions: P, mode: cfg.mode, emergencyStop: cfg.emergency_stop, writesLocked: cfg.writesLocked, autoToggles: toggles, budgetPolicyEnabled: !!policy.enabled, dailyPlan: { allowOpen: dcfg.allowOpen, allowPause: dcfg.allowPause, scheduledExecution: dcfg.scheduledExecution.enabled, halted: dcfg.halted } } };
}
