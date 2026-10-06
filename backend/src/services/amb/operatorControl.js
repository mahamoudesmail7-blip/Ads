// 🤖 AI Operator — GLOBAL CONTROL STATUS + Autopilot permission toggles (I/O layer). The pure toggle table lives in operatorAutoActions.js.
//   controlStatus -> what the top strip shows: MANUAL / SHADOW / APPROVAL / AUTOPILOT + Pause/Open/Scale/Budget permissions + whether anything could
//                    really execute (Emergency Stop and the deployment write-lock always win, whatever the mode or the toggles say).
//   setAutoActions -> flips toggles (ADMIN at the route). It changes ONE thing — a permission flag in the AMB settings blob — and never a mode, a rule,
//                    a campaign or a budget. Turning a toggle ON does not execute anything by itself.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getAmbSettings, saveAmbSettings } from './settings.js';
import { getOperatorConfig, metaWritesLocked } from './operatorStore.js';
import { AUTO_ACTIONS, AUTO_ACTION_KEYS, autoActionsState, settingKeyOf } from './operatorAutoActions.js';

/** UI vocabulary for the four modes. The stored value of MANUAL is `OFF` (kept for compatibility with every existing row/guard). */
export const MODE_VIEW = {
  OFF: { label: 'MANUAL', icon: '🔴', hint_ar: 'يدوي — الـAI مبيكتبش حاجة على Meta ومفيش أكشنز جديدة أو متأخرة.' },
  SHADOW: { label: 'SHADOW', icon: '👁', hint_ar: 'Shadow — بيسجّل اللي كان هيعمله بس، مفيش تنفيذ على Meta.' },
  APPROVAL: { label: 'APPROVAL', icon: '🟡', hint_ar: 'بموافقتك — بيجهّز القرارات وانت بتوافق قبل أي تنفيذ.' },
  AUTOPILOT: { label: 'AUTOPILOT', icon: '🟢', hint_ar: 'Autopilot — بينفّذ فقط القواعد المعلّمة Autopilot والأكشنز المسموحة بعد كل حواجز الأمان.' },
};

/** Pure: build the strip from a config row, the AMB settings and the deployment lock. */
export function buildControlStatus({ config, settings, writesLocked = metaWritesLocked() }) {
  const mode = config?.mode || 'SHADOW';
  const view = MODE_VIEW[mode] || MODE_VIEW.SHADOW;
  const stop = !!config?.emergency_stop;
  const st = autoActionsState(settings);
  const canExecuteAtAll = mode === 'AUTOPILOT' && !stop && !writesLocked;
  const toggles = AUTO_ACTIONS.map((t) => ({ key: t.key, label: t.label, label_ar: t.label_ar, short: t.short, on: st[t.key], effective: st[t.key] && canExecuteAtAll }));
  const need = (keys) => keys.every((k) => st[k]);
  return {
    mode, modeLabel: view.label, icon: stop ? '🛑' : view.icon, hint_ar: view.hint_ar, emergencyStop: stop, emergencyReason: config?.emergency_reason || null, writesLocked,
    toggles,
    // what Autopilot MAY do per class of action (budget = either direction; scale needs BOTH its toggles)
    permissions: { pause: st.pause, open: st.open, scale: need(['scale', 'budgetIncrease']), budget: st.budgetIncrease || st.budgetReduce },
    autopilotCanExecute: canExecuteAtAll && AUTO_ACTION_KEYS.some((k) => st[k]),
    summary_ar: stop ? '🛑 إيقاف الطوارئ مفعّل — مفيش أي فتح/إيقاف/توسع/تغيير ميزانية.' : writesLocked ? `${view.icon} ${view.label} — كتابة Meta مقفولة على مستوى النشر (مفيش تنفيذ في أي وضع).` : `${view.icon} ${view.label}`,
  };
}
export async function controlStatus() {
  const [config, settings] = await Promise.all([getOperatorConfig(), getAmbSettings()]);
  return buildControlStatus({ config, settings });
}

/** patch = {pause?, open?, scale?, budgetIncrease?, budgetReduce?} booleans. Unknown keys / non-booleans are rejected. Returns the new strip. */
export async function setAutoActions({ patch, userId = null }) {
  const bad = Object.keys(patch || {}).filter((k) => !AUTO_ACTION_KEYS.includes(k));
  if (bad.length) { const e = new Error(`صلاحية غير معروفة: ${bad.join(', ')}`); e.status = 400; throw e; }
  const nonBool = Object.entries(patch || {}).filter(([, v]) => typeof v !== 'boolean');
  if (nonBool.length) { const e = new Error('قيم الصلاحيات لازم تكون true/false.'); e.status = 400; throw e; }
  if (!Object.keys(patch || {}).length) { const e = new Error('مفيش صلاحية للتغيير.'); e.status = 400; throw e; }
  const before = autoActionsState(await getAmbSettings());
  const settingsPatch = {}; for (const [k, v] of Object.entries(patch)) settingsPatch[settingKeyOf(k)] = v;
  await saveAmbSettings(settingsPatch);
  const after = autoActionsState(await getAmbSettings());
  const changed = Object.fromEntries(Object.entries(after).filter(([k, v]) => v !== before[k]).map(([k, v]) => [k, { from: before[k], to: v }]));
  try {
    await prisma.aiAuditLog.create({ data: { actor_id: userId || null, kind: 'OPERATOR_AUTO_ACTIONS', action: 'EXECUTE', input_json: JSON.stringify({ changed, after }).slice(0, 4000), success: true } });
    await prisma.ambOperatorEvent.create({ data: { kind: 'NOTE', actor: 'USER', actor_id: userId, note: `AUTO_ACTIONS ${Object.keys(changed).map((k) => `${k}:${changed[k].from}->${changed[k].to}`).join(' ') || '(no change)'}`.slice(0, 480) } });
  } catch (err) { logger.error('[operatorControl] audit write failed', { message: err.message }); }
  return { changed, status: await controlStatus() };
}
