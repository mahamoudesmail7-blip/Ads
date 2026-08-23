// task-engine.js — Media Buyer Task Engine. Pure functions, no DOM/
// IndexedDB. Turns a Decision Engine result (decision-engine.js) into ONE
// of 8 concrete task types with a priority, instead of stopping at an
// abstract "action code" — this is the layer that makes the system feel
// like it's handing the media buyer a to-do list, not just a verdict.
//
// Deliberately narrow about what it can infer: REVIEW_NOW only ever
// produces REVIEW_PRODUCT here, never REVIEW_AD, because nothing in this
// app's data can tell an ad-creative problem apart from a product problem
// (no ad-level data exists yet). REVIEW_AD stays defined in TASK_TYPE as a
// reserved slot for when that signal exists, rather than being guessed at.

export const TASK_TYPE = {
  SCALE: { code: 'SCALE', icon: '🔥', label: 'ارفع الميزانية تدريجيًا', color: 'green' },
  REDUCE: { code: 'REDUCE', icon: '⬇️', label: 'قلل الميزانية وراجع الإعلان', color: 'yellow' },
  PAUSE_REVIEW: { code: 'PAUSE_REVIEW', icon: '🚨', label: 'أوقف/راجع الكامبين', color: 'red' },
  MONITOR: { code: 'MONITOR', icon: '👀', label: 'استمر وراقب', color: 'gray' },
  CHECK_STOCK: { code: 'CHECK_STOCK', icon: '📦', label: 'راجع المخزون قبل زيادة الميزانية', color: 'red' },
  REVIEW_AD: { code: 'REVIEW_AD', icon: '🛠️', label: 'راجع محتوى الإعلان', color: 'yellow' },
  REVIEW_PRODUCT: { code: 'REVIEW_PRODUCT', icon: '🛠️', label: 'راجع الإعلان وسبب انخفاض الأوردرات', color: 'yellow' },
  COLLECT_DATA: { code: 'COLLECT_DATA', icon: '🆕', label: 'اجمع بيانات أكثر قبل اتخاذ قرار', color: 'accent' },
  // Reserved, like REVIEW_AD above — nothing in this app yet distinguishes
  // "the numbers dipped, go double-check performance metrics" from a
  // regular REVIEW_PRODUCT, or "this specific creative is fatigued" from
  // an ad problem in general. Kept in the vocabulary so a future signal
  // (e.g. per-creative CTR from Meta Ads) has an obvious slot to land in,
  // rather than guessed at now with data that doesn't exist.
  REVIEW_PERFORMANCE: { code: 'REVIEW_PERFORMANCE', icon: '📊', label: 'راجع أداء الحملة بالتفصيل', color: 'yellow' },
  TEST_CREATIVE: { code: 'TEST_CREATIVE', icon: '🧪', label: 'جرّب تصميم إعلان جديد', color: 'yellow' },
  // Manager-only types (spec: 👑 تحكم المدير Add Task dropdown) — never
  // auto-derived from a decision, only ever chosen by hand.
  CAMPAIGN: { code: 'CAMPAIGN', icon: '🎯', label: 'مهمة متعلقة بالحملة', color: 'accent' },
  OTHER: { code: 'OTHER', icon: '📌', label: 'مهمة أخرى', color: 'gray' },
};

export const TASK_PRIORITY = {
  URGENT: { code: 'URGENT', icon: '🔴', label: 'عاجل' },
  IMPORTANT: { code: 'IMPORTANT', icon: '🟠', label: 'مهم' },
  NORMAL: { code: 'NORMAL', icon: '🟡', label: 'عادي' },
};

export const NOT_COMPLETED_REASONS = [
  'لم أقتنع بالقرار',
  'احتاج بيانات أكثر',
  'مشكلة في الإعلان',
  'مشكلة في المخزون',
  'مشكلة في المنتج',
  'مشكلة أخرى',
];

const URGENT_TYPES = new Set(['PAUSE_REVIEW', 'REVIEW_AD', 'REVIEW_PRODUCT', 'CHECK_STOCK']);
const IMPORTANT_TYPES = new Set(['SCALE', 'REDUCE']);

/**
 * @param {string} actionCode decision-engine.js ACTION.*.code
 * @param {string|null} inventoryStatus inventory.js analyzeProductInventory().status
 */
export function deriveTaskType(actionCode, inventoryStatus) {
  if (actionCode === 'SCALE_UP') {
    if (inventoryStatus === 'LOW' || inventoryStatus === 'CRITICAL') return TASK_TYPE.CHECK_STOCK;
    return TASK_TYPE.SCALE;
  }
  if (actionCode === 'REDUCE') return TASK_TYPE.REDUCE;
  if (actionCode === 'REVIEW_NOW') return TASK_TYPE.REVIEW_PRODUCT;
  if (actionCode === 'STOP_CANDIDATE') return TASK_TYPE.PAUSE_REVIEW;
  if (actionCode === 'INSUFFICIENT_DATA') return TASK_TYPE.COLLECT_DATA;
  return TASK_TYPE.MONITOR; // CONTINUE
}

export function taskPriority(taskTypeCode) {
  if (URGENT_TYPES.has(taskTypeCode)) return TASK_PRIORITY.URGENT;
  if (IMPORTANT_TYPES.has(taskTypeCode)) return TASK_PRIORITY.IMPORTANT;
  return TASK_PRIORITY.NORMAL;
}

/**
 * @param {{product: object, a: object, decision: object, inventory: object|null}} bundle
 * @returns {object} a flat task record ready to render/persist
 */
export function buildTask({ product, a, decision, inventory }) {
  const taskType = deriveTaskType(decision.action.code, inventory?.status ?? null);
  const priority = taskPriority(taskType.code);
  // Erratic-but-not-urgent products (spec section 21: "متذبذب: أداء غير
  // مستقر -> MONITOR/REVIEW") get a more specific instruction than the
  // generic "استمر وراقب" — explicitly warning against reacting to any
  // single day of an already-choppy history.
  const requiredAction =
    decision.status?.code === 'VOLATILE' && taskType.code === 'MONITOR'
      ? 'لا تزود الميزانية الآن — راقب الأداء وراجع الإعلانات'
      : taskType.label;
  return {
    productId: product.id,
    productName: product.product_name,
    today: a.today,
    yesterday: a.yesterday,
    diff: a.change.abs,
    taskType,
    priority,
    requiredAction,
    reason: decision.note,
    confidence: decision.confidence,
  };
}

/** Priority first, then size of movement (spec section 25) — never plain product order. */
export function topTasks(tasks, max = 5) {
  const order = { URGENT: 0, IMPORTANT: 1, NORMAL: 2 };
  return [...tasks]
    .sort((x, y) => {
      const p = order[x.priority.code] - order[y.priority.code];
      if (p !== 0) return p;
      return Math.abs(y.diff ?? 0) - Math.abs(x.diff ?? 0);
    })
    .slice(0, max);
}
