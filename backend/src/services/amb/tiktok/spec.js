// TikTok Ads — the ONE place that knows TikTok's vocabulary: objectives, optimisation goals, billing, bidding, placements, CTAs, locations, event names.
// Everything the wizard shows (Arabic labels, defaults, what each choice means) and every enum value the API payloads use comes from here, so a TikTok
// rename is a one-line change. Field names follow TikTok Marketing API v1.3 (campaign/create, adgroup/create, ad/create); enum VALUES are listed in `API`
// so they can be checked against the live docs / a sandbox advertiser in one glance.

export const API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

/** Enum values sent to TikTok. Keep these in sync with the official reference (marked ⚠ = confirm on the first real launch). */
export const API = {
  budgetMode: { DAY: 'BUDGET_MODE_DAY', TOTAL: 'BUDGET_MODE_TOTAL', INFINITE: 'BUDGET_MODE_INFINITE' },
  operationStatus: { ON: 'ENABLE', OFF: 'DISABLE' },
  campaignType: 'REGULAR_CAMPAIGN',
  promotionType: 'WEBSITE',
  placementType: { AUTO: 'PLACEMENT_TYPE_AUTOMATIC', MANUAL: 'PLACEMENT_TYPE_NORMAL' },
  placements: { TIKTOK: 'PLACEMENT_TIKTOK', PANGLE: 'PLACEMENT_PANGLE' },
  scheduleType: { FROM_NOW: 'SCHEDULE_FROM_NOW', START_END: 'SCHEDULE_START_END' },
  pacing: 'PACING_MODE_SMOOTH',
  bidType: { NO_BID: 'BID_TYPE_NO_BID', CUSTOM: 'BID_TYPE_CUSTOM' },
  adFormat: 'SINGLE_VIDEO',
  identityType: 'CUSTOMIZED_USER',
  gender: { ALL: 'GENDER_UNLIMITED', MALE: 'GENDER_MALE', FEMALE: 'GENDER_FEMALE' },
};

// ---- objectives. `apiObjective` = campaign objective_type; `goal` / `billing` = the ad group optimisation goal / billing event it needs.
export const OBJECTIVES = {
  CONVERSIONS: {
    label: 'مبيعات على الموقع (أوردرات)', emoji: '🛒', recommended: true,
    hint: 'تيك توك يدوّر على الناس اللي هتشتري فعلًا من صفحة المنتج. ده الأنسب للتجارة الإلكترونية (الدفع عند الاستلام).',
    apiObjective: 'WEB_CONVERSIONS', goal: 'CONVERT', billing: 'OCPM', needsPixel: true, needsLanding: true, bidKind: 'conversion',
  },
  TRAFFIC: {
    label: 'زيارات للصفحة', emoji: '🔗', recommended: false,
    hint: 'يجيبلك أكبر عدد زيارات للصفحة بأقل تكلفة للنقرة. مناسب للتجربة وبناء جمهور.',
    apiObjective: 'TRAFFIC', goal: 'CLICK', billing: 'CPC', needsPixel: false, needsLanding: true, bidKind: 'click',
  },
  VIDEO_VIEWS: {
    label: 'مشاهدات الفيديو', emoji: '▶️', recommended: false,
    hint: 'أكبر عدد مشاهدات للفيديو بأقل تكلفة. مناسب لتعريف الناس بالمنتج.',
    apiObjective: 'VIDEO_VIEWS', goal: 'VIDEO_VIEW', billing: 'CPV', needsPixel: false, needsLanding: false, bidKind: 'view',
  },
  REACH: {
    label: 'وصول (أكبر عدد أشخاص)', emoji: '📣', recommended: false,
    hint: 'يوصّل إعلانك لأكبر عدد ناس مختلفين. للتعريف بالبراند.',
    apiObjective: 'REACH', goal: 'REACH', billing: 'CPM', needsPixel: false, needsLanding: false, bidKind: 'none',
  },
  LEAD_GENERATION: {
    label: 'عملاء محتملين (فورم)', emoji: '📝', recommended: false,
    hint: 'تجميع بيانات عملاء من فورم جوه تيك توك. محتاج Instant Form جاهز على حسابك.',
    apiObjective: 'LEAD_GENERATION', goal: 'LEAD_GENERATION', billing: 'OCPM', needsPixel: false, needsLanding: false, bidKind: 'conversion', needsExtra: 'instantForm',
  },
};
export const OBJECTIVE_KEYS = Object.keys(OBJECTIVES);

// ---- conversion events (what the pixel counts). `api` is the optimization_event value.
export const EVENTS = {
  PURCHASE: { label: 'إتمام الطلب (Purchase)', api: 'SHOPPING', recommended: true },
  INITIATE_CHECKOUT: { label: 'بدء الطلب (Initiate Checkout)', api: 'INITIATE_ORDER' },
  ADD_TO_CART: { label: 'إضافة للسلة (Add to Cart)', api: 'ON_WEB_CART' },
  VIEW_CONTENT: { label: 'مشاهدة المنتج (View Content)', api: 'ON_WEB_DETAIL' },
  REGISTRATION: { label: 'تسجيل (Registration)', api: 'ON_WEB_REGISTER' },
};

export const BID_STRATEGIES = {
  LOWEST_COST: { label: 'أقل تكلفة (تلقائي — الأنسب للبداية)', hint: 'تيك توك بيختار المزايدة لوحده عشان يجيب أكتر نتائج بالميزانية.' },
  COST_CAP: { label: 'سقف للتكلفة', hint: 'بتحدد أقصى تكلفة للنتيجة (مثلًا أقصى CPA). لو حطيته واطي قوي ممكن الإعلان ما يصرفش.' },
};

export const CTAS = {
  SHOP_NOW: 'تسوّق الآن', ORDER_NOW: 'اطلب الآن', BUY_NOW: 'اشتري الآن', LEARN_MORE: 'اعرف أكتر', GET_QUOTE: 'اطلب عرض سعر',
  CONTACT_US: 'تواصل معنا', SIGN_UP: 'سجّل', BOOK_NOW: 'احجز الآن', GET_OFFER: 'احصل على العرض', WATCH_NOW: 'شاهد الآن',
};
export const CTA_DEFAULT = 'SHOP_NOW';

export const AGE_GROUPS = { AGE_13_17: '13–17', AGE_18_24: '18–24', AGE_25_34: '25–34', AGE_35_44: '35–44', AGE_45_54: '45–54', AGE_55_100: '55+' };
export const AGE_DEFAULT = ['AGE_18_24', 'AGE_25_34', 'AGE_35_44', 'AGE_45_54', 'AGE_55_100']; // TikTok ads for products are 18+ (13–17 is excluded by default)

export const GENDERS = { ALL: 'الكل', MALE: 'رجال', FEMALE: 'ستات' };

export const LANGUAGES = { ar: 'العربية', en: 'الإنجليزية', fr: 'الفرنسية' };
export const OPERATING_SYSTEMS = { ANDROID: 'أندرويد', IOS: 'آيفون (iOS)' };

/** Countries (GeoNames ids — what TikTok's location_ids use). */
export const LOCATIONS = {
  '357994': { label: 'مصر', code: 'EG' },
  '102358': { label: 'السعودية', code: 'SA' },
  '290557': { label: 'الإمارات', code: 'AE' },
  '285570': { label: 'الكويت', code: 'KW' },
  '289688': { label: 'قطر', code: 'QA' },
  '290291': { label: 'البحرين', code: 'BH' },
  '286963': { label: 'عُمان', code: 'OM' },
  '248816': { label: 'الأردن', code: 'JO' },
  '99237': { label: 'العراق', code: 'IQ' },
  '2542007': { label: 'المغرب', code: 'MA' },
};
export const LOCATION_DEFAULT = ['357994'];

export const PLACEMENTS = {
  AUTO: { label: 'تلقائي (موصى به)', hint: 'تيك توك يختار أحسن أماكن عرض (تيك توك + شركاء).' },
  TIKTOK_ONLY: { label: 'تيك توك بس', hint: 'الإعلان يظهر في تطبيق تيك توك فقط.' },
};

export const BUDGET_LEVELS = {
  ADGROUP: { label: 'ميزانية على مستوى المجموعة الإعلانية (الأبسط)', hint: 'الميزانية اليومية بتتحط على المجموعة الإعلانية.' },
  CAMPAIGN: { label: 'ميزانية على مستوى الحملة (CBO)', hint: 'التوزيع بين المجموعات تلقائي.' },
};

export const RUN_MODES = {
  PAUSED: { label: 'يترفع موقوف (الأكثر أمانًا) — أشغّله أنا بعد المراجعة', hint: 'مفيش صرف لحد ما تشغّله بإيدك.' },
  NOW: { label: 'يترفع وشغّال على طول', hint: 'بيبدأ الصرف أول ما تيك توك تراجعه.' },
  SCHEDULED: { label: 'يبدأ في ميعاد محدد', hint: 'الحملة تبدأ في التاريخ والوقت اللي تحدده (بتوقيت حساب الإعلانات).' },
};

/** Limits the UI enforces and the builder re-checks (TikTok enforces its own currency minimums too). */
export const LIMITS = {
  nameMax: 512, adTextMax: 100, adTextMin: 1, displayNameMax: 40, maxVideos: 10, maxAdsPerGroup: 10,
  budgetMin: 1, budgetMax: 10_000_000, bidMin: 0.01,
};

/** One-click presets so a first-timer never has to understand the options. */
export const PRESETS = {
  COD_EGYPT: {
    label: 'منتج دفع عند الاستلام — مصر',
    description: 'أوردرات من مصر، الدفع عند الاستلام: هدف المبيعات، أعمار 18+، العربية، أقل تكلفة، أماكن تلقائية.',
    config: { objective: 'CONVERSIONS', event: 'PURCHASE', locations: ['357994'], ageGroups: AGE_DEFAULT, gender: 'ALL', languages: ['ar'], bidStrategy: 'LOWEST_COST', placement: 'AUTO', budgetLevel: 'ADGROUP', cta: 'SHOP_NOW' },
  },
  TRAFFIC_TEST: {
    label: 'تجربة سريعة — زيارات',
    description: 'اختبار رخيص لصفحة أو فيديو: هدف زيارات، مصر، أعمار 18+.',
    config: { objective: 'TRAFFIC', locations: ['357994'], ageGroups: AGE_DEFAULT, gender: 'ALL', languages: ['ar'], bidStrategy: 'LOWEST_COST', placement: 'AUTO', budgetLevel: 'ADGROUP', cta: 'LEARN_MORE' },
  },
  GULF_SALES: {
    label: 'مبيعات الخليج',
    description: 'السعودية والإمارات والكويت: هدف المبيعات، العربية.',
    config: { objective: 'CONVERSIONS', event: 'PURCHASE', locations: ['102358', '290557', '285570'], ageGroups: AGE_DEFAULT, gender: 'ALL', languages: ['ar'], bidStrategy: 'LOWEST_COST', placement: 'AUTO', budgetLevel: 'ADGROUP', cta: 'SHOP_NOW' },
  },
};

/** The default draft config — what an empty wizard starts from. */
export function defaultConfig() {
  return {
    name: '', objective: 'CONVERSIONS', event: 'PURCHASE', pixelId: '',
    landingUrl: '', displayName: '', adText: '', cta: CTA_DEFAULT,
    identity: { mode: 'NEW', id: '' }, // NEW = create a custom identity from displayName; EXISTING = use identity.id
    videos: [], // [{ url, name }]
    locations: LOCATION_DEFAULT, ageGroups: AGE_DEFAULT, gender: 'ALL', languages: ['ar'], operatingSystems: [], interestIds: [],
    placement: 'AUTO', budgetLevel: 'ADGROUP', dailyBudget: '', bidStrategy: 'LOWEST_COST', bidAmount: '',
    runMode: 'PAUSED', startDate: '', startTime: '00:00', endDate: '', daypartingAllDay: true,
    commentsOff: false, downloadOff: false, shareOff: false,
    adsPerVideo: 1,
  };
}
