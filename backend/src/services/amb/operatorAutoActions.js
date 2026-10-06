// 🤖 AI Operator — AUTOPILOT PERMISSION TOGGLES (pure). One switch per class of automatic action; all OFF by default, stored in the AMB settings blob
// (ambAllowAuto*), so there is ONE source of truth and no migration. A toggle only matters when the effective mode of a decision is AUTOPILOT: a decision
// whose action is not allowed stays PREPARED for the owner's approval (guard AUTO_ACTION_DISABLED, a DOWNGRADE — never a silent drop, never an execution).
//   Auto Pause           -> PAUSE
//   Auto Open            -> OPEN
//   Auto Scale           -> SCALE_UP   (the strategic permission to scale a winner) ...
//   Auto Budget Increase -> SCALE_UP   (... AND the money permission to raise a budget: BOTH must be ON)
//   Auto Budget Reduce   -> SCALE_DOWN
export const AUTO_ACTIONS = [
  { key: 'pause', setting: 'ambAllowAutoPause', label: 'Auto Pause', label_ar: 'إيقاف تلقائي', actions: ['PAUSE'], short: 'Pause' },
  { key: 'open', setting: 'ambAllowAutoOpen', label: 'Auto Open', label_ar: 'فتح تلقائي', actions: ['OPEN'], short: 'Open' },
  { key: 'scale', setting: 'ambAllowAutoScale', label: 'Auto Scale', label_ar: 'توسع تلقائي', actions: ['SCALE_UP'], short: 'Scale' },
  { key: 'budgetIncrease', setting: 'ambAllowAutoBudgetIncrease', label: 'Auto Budget Increase', label_ar: 'زيادة ميزانية تلقائية', actions: ['SCALE_UP'], short: 'Budget ↑' },
  { key: 'budgetReduce', setting: 'ambAllowAutoBudgetDecrease', label: 'Auto Budget Reduce', label_ar: 'تقليل ميزانية تلقائي', actions: ['SCALE_DOWN'], short: 'Budget ↓' },
];
export const AUTO_ACTION_KEYS = AUTO_ACTIONS.map((t) => t.key);
const BY_KEY = Object.fromEntries(AUTO_ACTIONS.map((t) => [t.key, t]));

/** {pause,open,scale,budgetIncrease,budgetReduce} -> booleans. Anything but an explicit `true` is OFF. */
export function autoActionsState(settings) {
  return Object.fromEntries(AUTO_ACTIONS.map((t) => [t.key, settings?.[t.setting] === true]));
}
/** The toggle keys an action needs (all of them must be ON). OPEN/PAUSE/SCALE_UP/SCALE_DOWN only; anything else needs none. */
export const togglesRequiredFor = (action) => AUTO_ACTIONS.filter((t) => t.actions.includes(action)).map((t) => t.key);
/** Required toggles that are currently OFF for this action (empty = Autopilot may run it). */
export function missingAutoToggles(action, settings) {
  const st = autoActionsState(settings);
  return togglesRequiredFor(action).filter((k) => !st[k]);
}
export const settingKeyOf = (key) => BY_KEY[key]?.setting || null;
