// 🤖 AI Operator — BLOCK REASONS → machine-readable spec codes + "إيه المطلوب عشان القرار يتفتح؟" (pure, no I/O).
// Every blocked decision carries (a) an internal code, (b) the spec's machine code(s), (c) concrete setup steps and (d) a direct setup ACTION the UI
// can render as a button ([أدخل اقتصاديات المنتج] / [ربط/تحديث المخزون] / [اربط الحملة بالمنتج] ...). The Operator should help unblock automation.

/** internal guard code -> spec machine codes (a guard can map to more than one: missing economics also means profit cannot be proven). */
export const SPEC_CODES = {
  EMERGENCY_STOP: ['EMERGENCY_STOP'],
  MODE_OFF: ['AUTOMATION_DISABLED'],
  META_WRITES_LOCKED: ['AUTOMATION_DISABLED'],
  AUTOMATION_DISABLED: ['AUTOMATION_DISABLED'],
  AMB_ADVISORY_ONLY: ['AUTOMATION_DISABLED'],
  META_NOT_CONNECTED: ['DATA_QUALITY_BLOCK'],
  META_DATA_STALE: ['DATA_QUALITY_BLOCK'],
  OUTSIDE_SCHEDULE: ['AUTOMATION_DISABLED'],
  STORE_AMBIGUOUS: ['STORE_CONTEXT_MISSING'],
  MAPPING_UNRELIABLE: ['PRODUCT_MAPPING_UNCERTAIN'],
  MAPPING_UNVERIFIED_WARN: ['PRODUCT_MAPPING_UNCERTAIN'],
  DATA_UNKNOWN: ['DATA_QUALITY_BLOCK'],
  DATA_QUALITY_BLOCKED: ['DATA_QUALITY_BLOCK'],
  DATA_QUALITY_UNKNOWN: ['DATA_QUALITY_BLOCK'],
  COD_UNRELIABLE: ['COD_UNRELIABLE'],
  COD_UNVERIFIED_WARN: ['COD_UNRELIABLE'],
  STOCK_UNKNOWN: ['STOCK_UNKNOWN'],
  STOCK_OUT: ['STOCK_TOO_LOW'],
  STOCK_TOO_LOW: ['STOCK_TOO_LOW'],
  STOCK_BELOW_MIN: ['STOCK_TOO_LOW'],
  STOCK_COVERAGE_LOW: ['STOCK_TOO_LOW'],
  ECONOMICS_INCOMPLETE: ['ECONOMICS_MISSING', 'PROFIT_UNKNOWN'],
  PROFIT_NEGATIVE: ['PROFIT_UNKNOWN'],
  PRICE_CONFLICT: ['ECONOMICS_MISSING', 'PROFIT_UNKNOWN'],
  ZERO_ORDER_NOT_CONFIGURED: ['ECONOMICS_MISSING'],
  RECENT_PURCHASE_PROTECTION: ['INSUFFICIENT_SAMPLE'],
  HARD_STOP_NOT_CONFIGURED: ['ECONOMICS_MISSING'],
  MONEY_GUARD_BLOCKED: ['PROFIT_UNKNOWN'],
  INSUFFICIENT_SAMPLE: ['INSUFFICIENT_SAMPLE'],
  TESTING_SAMPLE: ['INSUFFICIENT_SAMPLE'],
  ATTRIBUTION_GRACE: ['INSUFFICIENT_SAMPLE'],
  TESTING_PROTECTED: ['TESTING_PROTECTED'],
  EXCEPTION_NO_AUTOMATION: ['CAMPAIGN_EXCEPTION'], EXCEPTION_NO_AUTO_STOP: ['CAMPAIGN_EXCEPTION'], EXCEPTION_NO_AUTO_OPEN: ['CAMPAIGN_EXCEPTION'], EXCEPTION_NO_AUTO_SCALE: ['CAMPAIGN_EXCEPTION'], EXCEPTION_NO_BUDGET_CHANGE: ['CAMPAIGN_EXCEPTION'],
  COOLDOWN_ACTIVE: ['COOLDOWN_ACTIVE'],
  MANUAL_OVERRIDE_COOLDOWN: ['COOLDOWN_ACTIVE'],
  FLIP_FLOP: ['COOLDOWN_ACTIVE'],
  CAMPAIGN_DAILY_LIMIT: ['DAILY_LOSS_LIMIT'],
  DAILY_LOSS_LIMIT: ['DAILY_LOSS_LIMIT'],
  ACCOUNT_DAILY_LIMIT: ['DAILY_LOSS_LIMIT'],
  STORE_DAILY_LIMIT: ['DAILY_LOSS_LIMIT'],
  RATE_LIMIT_HOUR: ['DAILY_LOSS_LIMIT'],
  RATE_LIMIT_DAY: ['DAILY_LOSS_LIMIT'],
  ACTION_NOT_ALLOWED: ['ACTION_NOT_ALLOWED'],
  AUTO_ACTION_DISABLED: ['ACTION_NOT_ALLOWED'],
  PRODUCT_AUTOMATION_OFF: ['AUTOMATION_DISABLED'],
  SUPERSEDED_BY_RULE: ['CONFLICTING_RULE'],
  RULE_CONFLICT: ['CONFLICTING_RULE'],
  RECENT_ACTION_PENDING_EVALUATION: ['RECENT_ACTION_PENDING_EVALUATION'],
  RECENT_HARMFUL_SCALE: ['RECENT_ACTION_PENDING_EVALUATION'],
  CONDITIONS_CHANGED: ['DATA_QUALITY_BLOCK'],
  MODE_SHADOW_NO_EXECUTION: ['AUTOMATION_DISABLED'],
  BUDGET_UNKNOWN: ['DATA_QUALITY_BLOCK'],
  ALREADY_IN_TARGET_STATE: ['ALREADY_IN_TARGET_STATE'],
  MAX_ACTION_SIZE: ['ACTION_NOT_ALLOWED'],
  MAX_AUTO_AMOUNT: ['ACTION_NOT_ALLOWED'],
  SPEND_VELOCITY_FREEZE: ['DAILY_LOSS_LIMIT'],
  CRITICAL_INCIDENT: ['CRITICAL_INCIDENT'],
  PROFIT_FLOOR: ['PROFIT_UNKNOWN'],
  CONFIDENCE_TOO_LOW_FOR_AUTOPILOT: ['ACTION_NOT_ALLOWED'],
  ADVISOR_DISAGREES: ['CONFLICTING_RULE'],
  ADVISOR_PLAN_MISSING: ['DATA_QUALITY_BLOCK'],
  ADVISOR_PLAN_MISSING_WARN: ['DATA_QUALITY_BLOCK'],
  ADVISOR_CONFLICT: ['CONFLICTING_RULE'],
  ADVISOR_DATA_GAP: ['DATA_QUALITY_BLOCK'],
  MONEY_GUARD_WARN: ['PROFIT_UNKNOWN'],
  STOCK_COVERAGE_WARN: ['STOCK_TOO_LOW'],
};

/** Spec codes that exist as guards of their own but are expressed with a scope (campaign vs product exception). */
export function specCodesFor(code, extra = {}) {
  if (code.startsWith('EXCEPTION_') && ['PRODUCT', 'STORE'].includes(extra.scopeType)) return ['PRODUCT_EXCEPTION'];
  return SPEC_CODES[code] || [code];
}

/** setup actions the UI renders as buttons. `type` is stable; `label` is Arabic. */
export const SETUP_ACTIONS = {
  ECONOMICS: { type: 'ECONOMICS', label: 'أدخل اقتصاديات المنتج' },
  STOCK: { type: 'STOCK', label: 'ربط/تحديث المخزون' },
  MAPPING: { type: 'MAPPING', label: 'اربط الحملة بالمنتج' },
  HARD_STOP: { type: 'ECONOMICS', label: 'حدّد Hard Stop CPA' },
  ZERO_ORDER: { type: 'ECONOMICS', label: 'اضبط حد الإيقاف بدون أوردرات' },
  DATA_QUALITY: { type: 'DATA_QUALITY', label: 'افتح فحص جودة البيانات' },
  EXCEPTIONS: { type: 'EXCEPTIONS', label: 'راجع الاستثناءات' },
  RULES: { type: 'RULES', label: 'راجع القواعد' },
  SAFETY: { type: 'SAFETY', label: 'افتح حدود الأمان' },
  EMERGENCY: { type: 'EMERGENCY', label: 'إلغاء إيقاف الطوارئ' },
  MODE: { type: 'MODE', label: 'غيّر وضع التشغيل' },
  AUTOFIX: { type: 'AUTOFIX', label: 'ضبط تلقائي للربط (آمن)' },
};

/** internal code -> {steps, action}. Steps are ordered; they describe what must be TRUE for the block to clear. */
const PLAN = {
  EMERGENCY_STOP: { steps: ['ألغِ إيقاف الطوارئ بعد ما تتأكد إن السبب انتهى'], action: 'EMERGENCY' },
  META_WRITES_LOCKED: { steps: ['كتابة AI Operator على Meta مقفولة على مستوى النشر. بتتفتح فقط بقرار نشر صريح منك (متغير OPERATOR_ALLOW_META_WRITES) بعد مراجعة Shadow والموافقة على أول كتابة'], action: null },
  MODE_OFF: { steps: ['غيّر وضع AI Operator من OFF إلى Shadow أو بموافقتي'], action: 'MODE' },
  AMB_ADVISORY_ONLY: { steps: ['وضع AI Media Buyer "استشاري فقط" — غيّره من الإعدادات لو عايز تنفيذ'], action: 'MODE' },
  META_NOT_CONNECTED: { steps: ['اربط حساب Meta Ads واختار الـ Ad Account'], action: 'DATA_QUALITY' },
  META_DATA_STALE: { steps: ['شغّل مزامنة Meta وانتظر لحد ما آخر مزامنة تبقى حديثة'], action: 'DATA_QUALITY' },
  OUTSIDE_SCHEDULE: { steps: ['استنى لحد ما ميعاد التشغيل الآلي يبدأ، أو عدّل الجدول من "الأمان والحدود"'], action: 'SAFETY' },
  STORE_AMBIGUOUS: { steps: ['اربط الحملة بمنتج بيتبع متجر واضح', 'تأكد إن المنتج مرتبط بمتجر في الكتالوج'], action: 'MAPPING' },
  MAPPING_UNRELIABLE: { steps: ['اربط الحملة بالمنتج الصحيح من "ربط الحملات" (VERIFIED)', 'الاقتراحات (SUGGESTED) مش كفاية للتنفيذ'], action: 'MAPPING' },
  DATA_UNKNOWN: { steps: ['سجّل البيانات الناقصة اللي القاعدة بتعتمد عليها (المخزون / الاقتصاديات / جودة البيانات)'], action: 'ECONOMICS' },
  DATA_QUALITY_BLOCKED: { steps: ['افتح فحص جودة البيانات وصلّح السبب (ربط/مطابقة مشتريات)', 'القرار بيتفتح تلقائيًا في التقييم القادم لما الجودة ترجع سليمة'], action: 'DATA_QUALITY' },
  DATA_QUALITY_UNKNOWN: { steps: ['جودة بيانات المنتج غير محسوبة — اربط الحملات وانتظر المزامنة'], action: 'DATA_QUALITY' },
  COD_UNRELIABLE: { steps: ['حالات Easy Orders لازم تتحدّث وتتأكد أولًا (Webhook الحالة شغال)', 'أو استخدم قاعدة مبنية على Meta + الاقتصاديات فقط بدون تأكيد/تسليم'], action: 'DATA_QUALITY' },
  STOCK_UNKNOWN: { steps: ['حدّث المخزون الحالي للمنتج (رقم حقيقي)', 'حدّد الحد الأدنى للمخزون'], action: 'STOCK' },
  STOCK_OUT: { steps: ['المخزون صفر — حدّث المخزون لما يوصل'], action: 'STOCK' },
  STOCK_TOO_LOW: { steps: ['المخزون عند/تحت الحد الأدنى — زوّد المخزون أو عدّل الحد الأدنى بوعي'], action: 'STOCK' },
  STOCK_BELOW_MIN: { steps: ['المخزون تحت الحد الأدنى — زوّد المخزون'], action: 'STOCK' },
  STOCK_COVERAGE_LOW: { steps: ['تغطية المخزون أقل من المطلوب للتوسع — زوّد المخزون أو قلل نسبة الزيادة'], action: 'STOCK' },
  ECONOMICS_INCOMPLETE: { steps: ['أدخل سعر البيع وتكلفة المنتج (وبعدين الشحن/التغليف)', 'حدّد Target CPA و Hard Stop CPA', 'الربحية بتتحسب تلقائيًا بعد كده'], action: 'ECONOMICS' },
  ZERO_ORDER_NOT_CONFIGURED: { steps: ['حدّد لمنتج ده حد الإيقاف بدون أوردرات من ملف المنتج: مبلغ ثابت، أو مضاعف Target CPA (محتاج Target CPA)'], action: 'ECONOMICS' },
  RECENT_PURCHASE_PROTECTION: { steps: ['استنى لحد ما فترة حماية آخر شراء تعدي — الحملة لسه بتبيع'], action: null },
  PRICE_CONFLICT: { steps: ['السعر مختلف بين مصدرين حقيقيين — راجع السعر الصحيح وسجّله في ملف المنتج (سعر البيع)'], action: 'ECONOMICS' },
  PROFIT_NEGATIVE: { steps: ['المنتج بيخسر عند الـCPA الحالي — راجع السعر/التكلفة أو قلل الـCPA قبل أي فتح/توسع'], action: 'ECONOMICS' },
  MONEY_GUARD_BLOCKED: { steps: ['Money Guard منع التوسع — راجع الربحية والمخزون'], action: 'ECONOMICS' },
  HARD_STOP_NOT_CONFIGURED: { steps: ['حدّد Hard Stop CPA للمنتج'], action: 'HARD_STOP' },
  INSUFFICIENT_SAMPLE: { steps: ['انتظر عينة كافية (صرف/أوردرات أكتر)'], action: null },
  TESTING_SAMPLE: { steps: ['حملة اختبار — انتظر أدنى عينة محددة قبل التوسع'], action: null },
  ATTRIBUTION_GRACE: { steps: ['استنى فترة السماح لوصول الأوردرات المنسوبة (Attribution) قبل الإيقاف'], action: null },
  TESTING_PROTECTED: { steps: ['حملة اختبار محمية — الإيقاف فقط عند حد صرفها الخاص، أو شيل وسم TESTING'], action: 'RULES' },
  EXCEPTION_NO_AUTOMATION: { steps: ['شيل الاستثناء من "المستثناة" لو عايز الأتمتة تشتغل على النطاق ده'], action: 'EXCEPTIONS' },
  EXCEPTION_NO_AUTO_STOP: { steps: ['شيل الاستثناء من "المستثناة" لو عايز إيقاف تلقائي'], action: 'EXCEPTIONS' },
  EXCEPTION_NO_AUTO_OPEN: { steps: ['شيل الاستثناء من "المستثناة" لو عايز فتح تلقائي'], action: 'EXCEPTIONS' },
  EXCEPTION_NO_AUTO_SCALE: { steps: ['شيل الاستثناء من "المستثناة" لو عايز توسع تلقائي'], action: 'EXCEPTIONS' },
  EXCEPTION_NO_BUDGET_CHANGE: { steps: ['شيل الاستثناء من "المستثناة" لو عايز تغيير ميزانية تلقائي'], action: 'EXCEPTIONS' },
  COOLDOWN_ACTIVE: { steps: ['استنى لحد ما فترة التهدئة تخلص'], action: null },
  MANUAL_OVERRIDE_COOLDOWN: { steps: ['انت غيّرت الحملة يدويًا — الأتمتة متوقفة عليها لفترة تهدئة قابلة للتعديل'], action: 'SAFETY' },
  FLIP_FLOP: { steps: ['استنى لحد ما فترة التهدئة للأكشن المعاكس تخلص'], action: null },
  CAMPAIGN_DAILY_LIMIT: { steps: ['وصلت للحد الأقصى لتغييرات الحملة اليوم — بكرة'], action: 'SAFETY' },
  DAILY_LOSS_LIMIT: { steps: ['تم تجاوز حد الخسارة اليومي — راجع الأداء، أو عدّل الحد من "الأمان والحدود"'], action: 'SAFETY' },
  ACCOUNT_DAILY_LIMIT: { steps: ['وصلت لحد الحساب اليومي للأكشنز — عدّله من "الأمان والحدود" أو استنى بكرة'], action: 'SAFETY' },
  STORE_DAILY_LIMIT: { steps: ['وصلت لحد المتجر اليومي — عدّله من "الأمان والحدود" أو استنى بكرة'], action: 'SAFETY' },
  RATE_LIMIT_HOUR: { steps: ['وصلت لحد الأكشنز في الساعة — هيتفتح تلقائيًا بعد الساعة'], action: 'SAFETY' },
  RATE_LIMIT_DAY: { steps: ['وصلت لحد الأكشنز في اليوم'], action: 'SAFETY' },
  ACTION_NOT_ALLOWED: { steps: ['فعّل الأكشن ده في قائمة Autopilot المسموحة، أو وافق عليه يدويًا'], action: 'SAFETY' },
  AUTO_ACTION_DISABLED: { steps: ['التنفيذ التلقائي للأكشن ده مقفول — فعّل التوجل المناسب (Auto Pause / Open / Scale / Budget) من شريط التحكم، أو وافق عليه يدويًا'], action: 'SAFETY' },
  PRODUCT_AUTOMATION_OFF: { steps: ['وضع أتمتة المنتج OFF — غيّره من ملف أتمتة المنتج'], action: 'ECONOMICS' },
  SUPERSEDED_BY_RULE: { steps: ['قاعدة تانية بأولوية أعلى بتغطي نفس الحملة — راجع القواعد'], action: 'RULES' },
  RULE_CONFLICT: { steps: ['راجع التعارض بين القواعد'], action: 'RULES' },
  RECENT_ACTION_PENDING_EVALUATION: { steps: ['فيه أكشن حديث على الحملة لسه مش متقيّم — استنى لحد ما أثره يتقاس'], action: null },
  RECENT_HARMFUL_SCALE: { steps: ['فيه توسع ضار حديث على الحملة — استنى أو راجع الرجوع المجهّز'], action: null },
  CONDITIONS_CHANGED: { steps: ['الشروط اتغيرت — هيتقيّم من جديد في الدورة الجاية'], action: null },
  MODE_SHADOW_NO_EXECUTION: { steps: ['الوضع Shadow — غيّره لـ"بموافقتي" بعد مراجعة تقرير Shadow'], action: 'MODE' },
  BUDGET_UNKNOWN: { steps: ['الميزانية معروفة بس لحملات CBO بعد المزامنة — شغّل مزامنة Meta'], action: 'DATA_QUALITY' },
  MAX_ACTION_SIZE: { steps: ['قلل نسبة تغيير الميزانية في القاعدة (أو عدّل الحد الأقصى من الإعدادات)'], action: 'RULES' },
  MANUAL_STOP_INTENT_UNKNOWN: { steps: ['مفيش دليل إن الحملة اتقفلت من الـOperator — الفتح محتاج موافقتك'], action: null },
  ALREADY_IN_TARGET_STATE: { steps: ['الحملة بالفعل في الحالة المطلوبة — مفيش مطلوب'], action: null },
  SPEND_VELOCITY_FREEZE: { steps: ['صرف غير طبيعي في آخر ساعة من غير نتيجة — راجع الحملة، والتجميد بيتفك لما السرعة ترجع طبيعية'], action: 'SAFETY' },
  CRITICAL_INCIDENT: { steps: ['فيه حادثة حرجة مفتوحة على المنتج — راجع Incident Center وحلّها'], action: null },
  MAPPING_UNVERIFIED_WARN: { steps: ['أكّد ربط الحملة بالمنتج (VERIFIED) عشان باقي الأكشنز تتفتح'], action: 'MAPPING' },
  MAX_AUTO_AMOUNT: { steps: ['قيمة التغيير أكبر من حد Autopilot — هتفضل بموافقتك'], action: 'SAFETY' },
  COD_UNVERIFIED_WARN: { steps: ['حدّث حالات Easy Orders (Webhook الحالة) عشان القرار يعتمد على COD موثّق'], action: 'DATA_QUALITY' },
  STOCK_COVERAGE_WARN: { steps: ['تغطية المخزون قريبة من الحد — فكّر في توسع أصغر'], action: 'STOCK' },
  MONEY_GUARD_WARN: { steps: ['Money Guard بيحذّر — راجع الربحية قبل التوسع'], action: 'ECONOMICS' },
  CONFIDENCE_TOO_LOW_FOR_AUTOPILOT: { steps: ['الثقة مش HIGH — القرار هيفضل بموافقتك لحد ما العينة تقوى'], action: null },
  ADVISOR_PLAN_MISSING: { steps: ['خطة المستشار الذكي لهذا المنتج لسه ما اتحسبتش — شغّل "ضبط تلقائي للربط" من مركز الإكتمال (بتحسبها من نفس مصدر المستشار)'], action: 'AUTOFIX' },
  ADVISOR_PLAN_MISSING_WARN: { steps: ['خطة المستشار غير محسوبة بعد'], action: 'AUTOFIX' },
  ADVISOR_CONFLICT: { steps: ['راجع خطة المستشار الذكي قبل الموافقة — هو شايف المنتج جاهز للتوسع'], action: null },
  ADVISOR_DISAGREES: { steps: ['المستشار الذكي مش شايف التوسع دلوقتي — راجع توصيته أو وافق يدويًا بعد ما تفهم السبب'], action: null },
  ADVISOR_DATA_GAP: { steps: ['المستشار الذكي شايف البيانات غير كافية — استنى عينة أكتر'], action: null },
  PROFIT_FLOOR: { steps: ['الربح الموثّق تحت الحد الأدنى — راجع الاقتصاديات'], action: 'ECONOMICS' },
};

/** One block -> {steps, action}. Unknown codes degrade to a generic, honest line. */
export function planFor(code) {
  const p = PLAN[code];
  if (!p) return { steps: ['راجع سبب المنع في التفاصيل'], action: null };
  return { steps: p.steps, action: p.action ? SETUP_ACTIONS[p.action] : null };
}

/**
 * All BLOCK-severity reasons of a decision -> the consolidated checklist the UI shows under "إيه المطلوب عشان القرار يتفتح؟":
 * numbered unique steps + de-duplicated setup actions (one button per kind). Time-based blocks (cooldown, sample) have steps but no button.
 */
export function unblockPlan(blocks, { productId = null, campaignId = null } = {}) {
  const hard = (blocks || []).filter((b) => b.severity === 'BLOCK');
  const steps = []; const actions = []; const seenA = new Set();
  for (const b of hard) {
    const p = planFor(b.code);
    for (const s of p.steps) if (!steps.includes(s)) steps.push(s);
    if (p.action && !seenA.has(p.action.type)) { seenA.add(p.action.type); actions.push({ ...p.action, productId, campaignId }); }
  }
  const reasons = hard.map((b) => ({ code: b.code, specCodes: b.specCodes || specCodesFor(b.code, b), message: b.message, detail: b.detail || null }));
  return { blocked: hard.length > 0, reasons, steps, actions };
}
