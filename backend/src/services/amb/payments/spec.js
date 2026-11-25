// Ads Payment Center («مركز المدفوعات الإعلانية») — constants shared by the store, the engine, the reports and the screen.
// Money rule: EGP numbers with at most 2 decimals; every SUM goes through piasters (integers) so 0.1 + 0.2 never drifts.

export const STATUS = Object.freeze({
  UNPAID: 'UNPAID', // الكود اتطلّع ولسه ما اتدفعش
  PAYING: 'PAYING', // الدفع بدأ ولسه مستني نتيجة موثوقة
  PAID: 'PAID', // مدفوع ولم يسمع (الفلوس خرجت، الرصيد لسه ما اتأكدش)
  CREDITED: 'CREDITED', // مسمّع بنجاح (تأكيد موثوق إن الرصيد اتضاف)
  EXPIRED: 'EXPIRED',
  PAY_FAILED: 'PAY_FAILED', // الدفع فشل — المصدر أكد إن مفيش خصم حصل
  UNCERTAIN: 'UNCERTAIN', // نتيجة غير مؤكدة — ممنوع إعادة الدفع قبل المطابقة
  REVIEW: 'REVIEW', // يحتاج مراجعة بشرية (اختلاف مبلغ، تضارب…)
});
export const STATUS_LABEL = Object.freeze({
  UNPAID: 'غير مدفوع', PAYING: 'جاري الدفع', PAID: 'مدفوع ولم يسمع', CREDITED: 'مسمع بنجاح', EXPIRED: 'منتهي الصلاحية', PAY_FAILED: 'فشل الدفع', UNCERTAIN: 'نتيجة غير مؤكدة', REVIEW: 'يحتاج مراجعة',
});
/** The three buckets of the top cards. EXPIRED is its own thing (not an open code any more). */
export const BUCKET = Object.freeze({
  unpaid: ['UNPAID', 'PAY_FAILED'],
  pending: ['PAYING', 'PAID', 'UNCERTAIN', 'REVIEW'],
  credited: ['CREDITED'],
  expired: ['EXPIRED'],
});
/** Codes that still need somebody's attention — they never leave the follow-up list at midnight. */
export const OPEN_STATUSES = Object.freeze(['UNPAID', 'PAYING', 'PAID', 'UNCERTAIN', 'REVIEW', 'PAY_FAILED']);
/** A code in one of these can be paid (a PAY_FAILED one only because the source CONFIRMED that nothing was charged). */
export const PAYABLE = Object.freeze(['UNPAID', 'PAY_FAILED']);

export const SOURCE = Object.freeze({ PROVIDER: 'PROVIDER', MANUAL: 'MANUAL', SIMULATED: 'SIMULATED' });
export const SOURCE_LABEL = Object.freeze({ PROVIDER: 'مزود رسمي', MANUAL: 'تسجيل يدوي', SIMULATED: 'محاكاة (اختبار)' });
export const CREDIT_SOURCE_LABEL = Object.freeze({ META_TRANSACTION: 'معاملة Meta مطابقة', PROVIDER: 'تأكيد المزود', MANUAL: 'تأكيد يدوي', SIMULATED: 'محاكاة (اختبار)' });

export const JOB_STATUS = Object.freeze({ PENDING: 'PENDING', EXTRACTING: 'EXTRACTING', DONE: 'DONE', FAILED: 'FAILED', UNCERTAIN: 'UNCERTAIN', CANCELLED: 'CANCELLED' });
export const JOB_LABEL = Object.freeze({ PENDING: 'في الانتظار', EXTRACTING: 'جاري الاستخراج', DONE: 'تم استخراج الكود', FAILED: 'فشل الاستخراج', UNCERTAIN: 'نتيجة غير مؤكدة', CANCELLED: 'اتلغى' });
export const PAY_ITEM_LABEL = Object.freeze({ PENDING: 'في الانتظار', PAYING: 'جاري الدفع', PAID: 'تم الدفع', FAILED: 'فشل الدفع', UNCERTAIN: 'نتيجة غير مؤكدة', SKIPPED: 'اتخطّى' });

export const PRESETS = Object.freeze(['today', 'yesterday', 'last7', 'last14', 'last30', 'month', 'lastMonth', 'year', 'custom']);
export const PRESET_LABEL = Object.freeze({ today: 'اليوم', yesterday: 'أمس', last7: 'آخر 7 أيام', last14: 'آخر 14 يوم', last30: 'آخر 30 يوم', month: 'الشهر الحالي', lastMonth: 'الشهر السابق', year: 'السنة الحالية', custom: 'فترة مخصصة' });

export const QUICK_AMOUNTS = Object.freeze([1000, 2000, 3000, 5000, 10000]);

/** Permissions (one switch each). ADMIN / the owner always has all of them; the rest come from the saved grants. */
export const PERMS = Object.freeze({
  view: 'مشاهدة المدفوعات',
  extract: 'استخراج الأكواد',
  pay: 'تنفيذ الدفع',
  bulkPay: 'الدفع الجماعي',
  manageMethods: 'إدارة وسائل الدفع',
  reports: 'مراجعة التقارير والتقفيل',
});
/** What a MANAGER gets until the owner grants more. Money moves (pay / bulk pay / methods) are NEVER implied by a role other than ADMIN. */
export const DEFAULT_MANAGER_PERMS = Object.freeze({ view: true, extract: true, pay: false, bulkPay: false, manageMethods: false, reports: true });

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'AUTO', // AUTO = the real connection when there is one, else manual registration. SIMULATION only exists on the isolated test database.
  monitorEveryMin: 5, // follow-up cadence (1..60)
  alertAfterMin: 30, // unpaid / paid-not-credited alert age (15 / 30 / 60 …)
  expiryWarnMin: 120, // «اقترب من انتهاء الصلاحية»
  creditOverdueMin: 60, // a PAID code that is not credited after this long is flagged
  defaultExpiryHours: 24, // when the source gives no expiry date (manual registration) — shown as a hint, never invented as a fact
  minAmountEgp: 1,
  maxAmountEgp: 100000,
  extractGapMs: 1500, // pause between two extractions of a bulk run (provider rate limits)
  coverDays: 2, // forecast: how many days of spend a top-up should cover
  needTopUpHours: 36, // forecast: «تحتاج شحن» when the balance covers fewer hours than this
  lowBalanceEgp: 2000,
  accountNames: {}, // { act_… : display name } — used when Meta gives no name
  dailyLimits: {}, // { userId: EGP } — max an employee may pay per Cairo day (absent = no limit)
  closingEnabled: true,
});

/** A user-facing error. `extra.error` becomes the machine code the screen switches on (err.code); every other extra goes to err.details (the error handler returns both). */
export const bad = (message, status = 400, extra = {}) => {
  const { error, ...rest } = extra;
  return Object.assign(new Error(message), { status }, extra, error ? { code: error } : {}, Object.keys(rest).length ? { details: rest } : {});
};

// ---- money ----
export const toPi = (egp) => Math.round(Number(egp || 0) * 100);
export const fromPi = (pi) => Math.round(pi) / 100;
export const sumEgp = (list) => fromPi(list.reduce((s, v) => s + toPi(v), 0));
export function parseAmount(v, { min = 1, max = 100000 } = {}) {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n <= 0) throw bad('اكتب مبلغ صحيح أكبر من صفر.');
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw bad('المبلغ لازم يكون بحد أقصى خانتين عشريتين.');
  if (n < min) throw bad(`أقل مبلغ ${min} ج.`);
  if (n > max) throw bad(`أعلى مبلغ للعملية الواحدة ${max.toLocaleString('en-US')} ج.`);
  return Math.round(n * 100) / 100;
}
export const validAccountId = (id) => /^act_\d{5,25}$/.test(String(id || ''));
/** Fawry reference numbers are digits; some wallets prefix letters — keep it strict enough to catch a typo but not reject a real one. */
export const normalizeCode = (v) => String(v ?? '').trim().replace(/[\s-]+/g, '').toUpperCase();
export const validCode = (v) => /^[A-Z0-9]{5,24}$/.test(normalizeCode(v));
