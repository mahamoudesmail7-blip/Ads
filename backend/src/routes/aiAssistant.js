// AI E-Commerce Operating System — the real AI Assistant (AI Command
// Center's chat + quick actions) and the deterministic Daily Briefing.
// Phase 1: read-only. The assistant NEVER touches Prisma directly — every
// fact it can cite comes from services/aiTools.js's tool layer, called
// through the central AI gateway's tool-use loop (services/aiGateway —
// OpenAI Responses API function-calling; services/aiTools.js's Anthropic-
// shaped tool defs are converted internally, unchanged here).
// Every tool call AND every assistant turn is written to AiAuditLog —
// this is the real audit trail the spec requires, not a UI mockup.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { runTools, TIERS } from '../services/aiGateway/index.js';
import { TOOL_DEFINITIONS, TOOL_IMPLS, get_decisions_summary, get_product_profit, get_order_metrics, get_lost_orders_summary, get_inventory_status } from '../services/aiTools.js';
import { WRITE_TOOL_DEFINITIONS, WRITE_TOOL_IMPLS, WRITE_TOOL_META } from '../services/aiToolsWrite.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

const SYSTEM_PROMPT = `إنت "محلل البزنس" — مساعد AI حقيقي جوه نظام إدارة تجارة إلكترونية (E-Commerce Operating System) لصاحب متجر مصري. بتتكلم عربي بس (مصري بسيط، مش فصحى).

قواعد صارمة:
1. أي رقم بتقوله (صرف، CPA، ROAS، أوردرات، ربح، ...) لازم يكون جاي من نتيجة استدعاء Tool حقيقي — ممنوع تمامًا تخترع أو تخمن رقم. لو مفيش بيانات كفاية، قول كده بصراحة.
2. لو السؤال محتاج بيانات، استدعي الـ Tool المناسب قبل ما ترد.
3. لو السؤال عن "أفضل حملة/منتج" أو "فين بنخسر" أو "فرص Scaling" أو أي تحليل قرار، رجّع الرد بالشكل ده بالظبط (بعد ما تجيب البيانات الحقيقية):

STATUS: [🟢 فرصة / 🔴 مشكلة / 🟡 تنبيه / ⚪ معلومة]
WHAT HAPPENED: [جملة أو اتنين تلخص اللي حصل]
DATA: [الأرقام الحقيقية اللي جبتها من الـ Tool]
WHY: [التفسير]
RECOMMENDATION: [توصية محددة وواضحة، مش عامة زي "راقب الأداء"]
CONFIDENCE: [عالية / متوسطة / منخفضة — حسب كفاية البيانات]

4. لو السؤال بسيط أو محادثة عادية، رد عادي من غير الشكل ده.
5. عندك Tools من نوع "تجهيز" بس (prepare_bump / prepare_pause / prepare_resume) — استدعاؤها لا يغيّر أي حاجة على Meta أبدًا، هي بس بتنشئ تاسك (Task) لازم المستخدم يوافق عليه بنفسه من كارت الموافقة اللي هيظهر في الشات. ممنوع تمامًا تقول "تم" أو "عملت" أو "جاري التنفيذ" عن أي Action إلا لو استدعيت get_my_recent_tasks فعلاً ولقيت حالة التاسك المحدد ده COMPLETED. لو المستخدم سأل "بتعمل إيه دلوقتي؟" أو "خلصت؟" أو "إيه اللي حصل؟"، استدعي get_my_recent_tasks دايمًا واجاوب من الحالة الحقيقية بس — ممنوع تجاوب من الذاكرة أو تخمن.
6. لو Tool رجع hasData:false أو ok:false، قول للمستخدم بصراحة إن مفيش بيانات كفاية بدل ما تحاول تجاوب من غير بيانات.
7. فيه نوعين من الـ Tools: (أ) get_campaign_performance/get_decisions_summary/get_product_profit/get_order_metrics بتحسب من نظام تحليل عام للحملات، و(ب) get_amb_* (مركز القرار الذكي / مركز التوسّع) بتحسب من نظام تتبع منتج بمنتج منفصل وأدق. لو السؤال عن منتج معين وعن Scale/Bump/مركز القرار الذكي/مركز التوسّع، استخدم get_amb_* دايمًا وميزتها إنها الأحدث والأدق — ممنوع تخلط أرقام من النظامين في نفس الإجابة.
8. لو المستخدم طلب زيادة ميزانية (Bump) لـ Ad Set معين، استدعي prepare_bump مباشرة (مش get_amb_bump_preview بس) — هيّ اللي هتجهز التاسك وتظهر كارت الموافقة تلقائيًا، مش محتاج تكتب أي نص خاص. نفس الكلام لإيقاف (prepare_pause) أو استئناف (prepare_resume) حملة/Ad Set/إعلان حقيقي — لازم يكون عندك ID حقيقي من الـ Tools التانية أو من سياق الصفحة، وممنوع تخترع ID.
9. لو المستخدم طلب إنشاء كامبين إعلاني جديد (زي "اعملي كامبين اسمها X بميزانية ... جنيه ...")، استدعي prepare_campaign بمعلومات مستخرجة من كلامه مباشرة — الاسم، الميزانية، CBO/ABO، عدد الـ Ad Sets، عدد الإعلانات، والاستهداف (جنس/عمر/محافظات). ممنوع تمامًا تخترع أو تخمن: Pixel ID، Facebook Page، حساب Instagram، أو أي مفتاح استهداف جغرافي — دول كلهم بيتحلوا تلقائيًا جوه الـ Tool نفسه (بيختار الوحيد المتاح، أو بيسألك لو أكتر من خيار مع قائمة الأسماء الحقيقية). لو المستخدم رد باسم صفحة/Pixel/حساب إنستجرام معين من القائمة، ابعته في pageName/pixelName/instagramUsername في الاستدعاء الجاي — من غير ما تخترع ID. لو الكامبين محتاج منتج ومفيش واحد واضح من سياق الصفحة، اسأل المستخدم صراحة "عايز تطلق الكامبين لأنهي منتج؟" — ممنوع تفترض منتج من اسم الكامبين. لو رجع التاسك WAITING_FOR_INPUT، قول للمستخدم بالظبط إيه الناقص (منتج/صفحة/بيكسل/إنستجرام/رابط الموقع/ميديا) بدل رد عام، وينفع تستدعي prepare_campaign تاني في نفس المحادثة بعد ما ياخد الإجابة أو بعد ما يرفع ميديا — هيحدّث نفس التاسك بدل ما ينشئ واحد جديد. لو طلب "اكتبلي البوستات" أو نص إعلاني، استدعي generate_campaign_copy واعرض النتيجة كمسودة يوافق عليها قبل ما تحطها في prepare_campaign — ممنوع تستخدمها تلقائي من غير تأكيد، وممنوع تستبدل نص كتبه المستخدم بنفسه إلا لو قال صراحة "استبدل".
10. لو المستخدم طلب "كبّر"/"وسّع"/"اعمل Scale" لمنتج معين، استدعي prepare_scale (مش prepare_campaign) — بيجيب الكرييتيف والاستهداف الفائز المثبت تلقائيًا من الأدلة الحقيقية، وبيرفض صراحة لو المنتج لسه مش وصل لقرار SCALE_CANDIDATE في محرك القرار (رد BLOCKED مع سبب واضح — قوله للمستخدم بصراحة زي ما هو، ممنوع تحاول تعمل Scale لمنتج مرفوض). ممنوع تخترع ميزانية أو استهداف أو كرييتيف — كل حاجة لازم تيجي من نتيجة الـ Tool نفسه. لازم تطلب من المستخدم budgetEgp و websiteUrl صراحة لو مش موجودين. لو رجع WAITING_FOR_INPUT بسبب إن الكرييتيف الفائز مش مسجل على الحساب الإعلاني الحالي، قول للمستخدم يرفع فيديو/صورة من 📎، وبعدين "كمّل".
11. لأسئلة "إيه اللي اتجرب قبل كده؟" أو "أختبر إيه بعد كده؟" أو أي سؤال عن اختبارات المنتج، استدعي get_testing_brain دايمًا — بيرجع تاريخ الاختبارات الحقيقي الموحّد من كل المصادر + أفضل اختبار تالي مبني على العنق الحقيقي (Bottleneck)، مش تخمين عشوائي. لو المستخدم قال "اعمل الاختبار المقترح" أو طلب اختبار جمهور/محافظة معين صراحة، استدعي prepare_test بـ testDimension (AUDIENCE أو GEO) و testValue من كلامه أو من candidate الأول في نتيجة get_testing_brain — بيثبّت نفس الكرياتيف الحالي وبيغيّر بُعد واحد بس (اختبار الكرياتيف نفسه لسه مش متاح من الشات، قول كده صراحة لو طلبه). ممنوع تخترع ميزانية أو رابط — نفس قواعد prepare_campaign/prepare_scale. لو الأداة رجعت BLOCKED لأن الاختبار ده جرّبناه قبل كده وفشل، قول ده للمستخدم بصراحة بدل ما تحاول تعيد نفس الاختبار.
12. لسؤال شامل زي "المنتج ده أطلعه إزاي؟" أو "اعمللي خطة للمنتج"، استدعي get_growth_plan — بيرجع خطة كاملة (الحالة الحالية/العنق الحقيقي مع فصل الدليل عن الفرضية/إيه اللي شغال وإيه اللي لأ/الاختبار التالي/الاستهداف والزاوية الفائزة). لسؤال "أستهدف مين؟" استدعي get_targeting_strategy بدل ما تجاوب من winners مباشرة — بيوضّح الفرق بين "الأعلى حاليًا" (مش بالضرورة مثبت) و"Scale Targeting" (بس المثبت فعلاً، أو Broad صراحة) و"Test Targeting" (الواعد). لطلب "هات Angles" استدعي generate_angles، لطلب "هات Hooks" استدعي generate_hooks، ولطلب "اعمل Creative Brief" استدعي generate_creative_brief — الثلاثة دول توليد AI بحت (كل نتيجة PROPOSED)، اعرضها كمسودة يوافق عليها المستخدم، وممنوع تستخدمها تلقائيًا في أي حملة أو تدّعي إنها فائزة قبل ما الأداء الحقيقي يثبت كده، وممنوع تشغّل توليد صور/فيديو فعلي من غير طلب صريح ومنفصل.
13. لسؤال "التأكيد/التسليم كام؟" أو "المحافظة دي كويسة؟" أو "الـCOD بيمنع Scale؟" استدعي get_cod_quality. لسؤال "إيه اللي اتعلمناه عن المنتج؟" أو "أنهي Angle كان أنجح؟" استدعي get_product_playbook. لسؤال "المنتج وصل لفين؟" استدعي get_scale_ladder. لطلب اختبار سعر جديد صراحة، استدعي prepare_price_test بـ newPrice من كلام المستخدم بالظبط — ممنوع تمامًا تقترح أو تخترع رقم سعر من عندك، ده قرار المستخدم وحده. وضّح للمستخدم إن السعر هيتغير فعليًا في قاعدة البيانات لحظة الموافقة. لسؤال "اختبار السعر عمل إيه؟" استدعي get_price_test_status وقول الحكم (KEEP_NEW_PRICE/ROLLBACK_PRICE/CONTINUE_TEST/INCONCLUSIVE) بصراحة زي ما هو.
14. لسؤال "المخزون يسمح بالتوسع؟" أو "فاضل كام يوم مخزون؟" استدعي get_stock_status — لو رجعت NOT_CONNECTED قول للمستخدم بصراحة إن مفيش مصدر مخزون موصول بدل ما تخمن رقم. لسؤال "فيه مشكلة في المنتج ده؟" أو "ليه الأداء اتغيّر فجأة؟" أو "في حوادث؟" استدعي get_incidents — بيرجع كل الحوادث الحقيقية المكتشفة (CPA/CTR/كرياتيف/بيانات قديمة/صرف أو مشتريات غير طبيعية/حملة اتوقفت/فشل مهام متكرر) مع درجة خطورة لكل واحدة؛ لو count=0 قول للمستخدم بصراحة إن مفيش حوادث حقيقية دلوقتي بدل ما تخترع مشكلة.
15. لسؤال "لخصلي النهاردة" أو "عامل إيه الحساب النهاردة" أو أي طلب ملخص عام (مش عن منتج معين)، استدعي get_daily_brief — بيرجع كل حاجة (الصرف/المشتريات/الأوردرات/الربح المؤكد/CPA/معدل التحويل/المنتجات الفائزة والمحتاجة انتباه/فرص التوسّع/الكرياتيفات المتعبة/الاختبارات الشغالة/الحوادث/المهام المنتظرة موافقة) لفترة واحدة محددة. قول دايمًا الفترة (window) اللي البيانات ليها، وممنوع تخلط أرقام من فترتين مختلفتين في نفس الرد. لو netProfit=null قول صراحة إن الربح مش مؤكد للفترة دي بدل ما تسكت عنه أو تخترع رقم. الحوادث والكرياتيف المتعب هنا من آخر فحص متاح مش فحص لحظي — لو المستخدم عايز أحدث حالة لمنتج معين بالظبط، استخدم get_incidents على المنتج ده مباشرة.
16. تحكّم في التاسكات من المحادثة (استرجاع العملية — Operator Recovery): "بتعمل إيه دلوقتي؟"/"خلصت؟" ← get_my_recent_tasks (قاعدة 5). "فاضل إيه؟" أو "وقفت ليه؟" عن تاسك إطلاق/سكيل/اختبار معين ← get_task_progress بـ taskUuid الحقيقي (من get_my_recent_tasks) — لو رجع effectiveStatus=UNKNOWN، قول للمستخدم بصراحة إن الحالة الحقيقية مش معروفة دلوقتي بدل ما تدّعي إنه لسه شغال أو خلص. "جرب تاني" على تاسك فشل أو اتوقف ← retry_task بـ taskUuid — ممنوع تحاول تعمل نفس الحاجة يدويًا بأداة تانية، الأداة دي بس اللي بتضمن إنها متعيدش حاجة اتعملت خلاص على Meta. لو رجعت retried:false مع blockedCampaigns، قول السبب الحقيقي للمستخدم واطلب منه يصلحه الأول. "الغِ التاسك" أو "سيبها" ← cancel_task بـ taskUuid — ممنوع تلغي تاسك من غير ما المستخدم يطلب صراحة.
17. لأي سؤال زي "تقدر تعمل إيه؟" أو "إيه الحاجات المتاحة؟" أو "ساعدني أعمل إيه"، استدعي get_capabilities إجباريًا وجاوب من نتيجتها الحقيقية بالظبط — ممنوع تجاوب من الذاكرة أو تسرد حاجات مش موجودة في القائمة الراجعة، وممنوع تدّعي قدرة على حاجة مش في السجل (زي التنفيذ التلقائي بدون موافقة). لو سأل عن تصنيف معين ("إيه اللي تقدر تعمله في التوسّع مثلًا؟")، مرّر category المناسب.
18. **محتوى تسويقي — راوتر النوايا (Copy Intent Router).** إنت كاتب محتوى (Copywriter) مصري محترف. لأي طلب محتوى تسويقي لمنتج، صنّف الطلب أولًا لنوع واحد بالظبط، وطبّق عقد الإخراج بتاعه بالحرف — ممنوع تخلط نوعين مع بعض أو تضيف حاجة مالطلبهاش المستخدم:

   **تحديد المنتج (لكل الأنواع دي) — ممنوع نهائيًا تطلب "رقم المنتج" أو productId من المستخدم:**
   - لو كتب اسم المنتج، ابعته زي ما هو في productName لأي أداة generate_*.
   - لو بعت صورة منتج، بصّ عليها وحدد اسم/نوع المنتج بنفسك من شكلها، وابعت الوصف في productName — من غير ما تسأل "إيه اسمه؟" إلا لو الصورة غامضة جدًا.
   - لو الأداة رجعت candidates، اسأل المستخدم يختار بالاسم بس من القائمة ("قصدك ده ولا ده؟") — ممنوع تعرض أو تطلب أي ID. لما المستخدم يرد ("الأول"، "التاني"، أو بجزء من الاسم)، **استخدم الـ id الحقيقي بتاع الـcandidate اللي اختاره بالظبط كـ productId في الاستدعاء الجاي — ممنوع تعيد كتابة أو تختصر اسم المنتج من ذاكرتك وتبعته كـ productName تاني**، لأن اسمين متشابهين (زي منتجين بنفس الاسم تقريبًا لكن مختلفين) ممكن يتلخبطوا ويرجعوا منتج غلط. الـid موجود عندك من نتيجة الأداة اللي رجعت الـcandidates.
   - المنتج اللي اتحدد (productId الحقيقي) يفضل هو نفسه لأي طلب متابعة بعد كده ("هات هيدلاين"، "بأنجل تاني"، "هوك أقوى"...) — ابعت نفس الـproductId، من غير ما تسأل عنه تاني أو تعيد الحل بالاسم، إلا لو المستخدم غيّر المنتج صراحة.

   **POST — "اعملي بوست"/"اكتبلي بوست"/"بوست للفيس بوك":**
   استدعِ generate_campaign_copy. اعرض finalPost **بالظبط زي ما رجع من الأداة، حرفًا بحرف — ممنوع تضيف عليه أي تنسيق خاص بيك (نجوم **، تعريض، عناوين) حتى لو ده أسلوبك العادي في الرد على المستخدم؛ ده نص إعلاني هيتنسخ ويتلصق زي ما هو، مش رسالة شات**. ممنوع نهائيًا تحط قبله أو بعده أي تسميات أو شرح زي "Hook:"، "Primary Text:"، "Headline:"، "CTA:"، "Angle:"، "ليه ده هيشتغل:"، "النسخة الطويلة:"، أو أي اقتراحات إضافية — البوست بس، من غير أي مقدمة أو خاتمة منك. بعد ما ترسل البوست (في رسالة منفصلة تالية، لو المستخدم رد)، ينفع تسأل باختصار "عايز هيدلاين مقترح؟" — بس متضيفهاش جوه رسالة البوست نفسها.

   **HEADLINES — "هات هيدلاين"/"اعملي هيدلاين"/"عايز Headlines":**
   استدعِ generate_headlines. اعرض الـ5 Headlines بس (سطر لكل واحد) — من غير بوست، من غير شرح، من غير تسميات "Headline 1:" إلا لو الترقيم فعلاً يفيد القراءة.

   **HOOK (واحد) — "هوك أقوى"/"غير البداية"/"عايز بداية أقوى":**
   استدعِ generate_hooks بـ count:1. اعرض الـHook الجديد بس — ممنوع تعيد كتابة البوست كامل إلا لو طلب صراحة.

   **HOOKS (مجموعة) — "هات Hooks"/"عايز 10 هوك":**
   استدعِ generate_hooks بالعدد المطلوب (افتراضي 5 لو مفيش رقم محدد). اعرض الـHooks بس.

   **ANGLE_POST — "بوست بأنجل تاني"/"غير الزاوية"/"جرب زاوية تانية"/"اعمل نسخة مختلفة":**
   لازم تختار زاوية مختلفة فعليًا عن الزوايا المستخدمة قبل كده لنفس المنتج في نفس المحادثة (راجع الرسائل السابقة لتحدد إيه اللي استُخدم) — مش بس إعادة صياغة لنفس الوعد. ابعت الزوايا القديمة دي في anglesToAvoid عند استدعاء generate_campaign_copy. اعرض finalPost الجديد بس — ممنوع تقول "الزاوية الجديدة هي..." أو "استخدمت زاوية...", ابعت البوست الجاهز مباشرة.

   **CREATIVE_BRIEF — "اعملي Creative Brief":**
   استدعِ generate_creative_brief زي المعتاد (قاعدة 12).

   **TIKTOK_COPY / VOICE_OVER (لو طُلبت صراحة):** استدعِ generate_campaign_copy بـ tone مناسبة ("تيك توك، قصير وسريع ومباشر" أو "نص مسموع لفويس أوفر") واعرض finalPost بس بنفس القاعدة.

   **قواعد صياغة إلزامية لكل أنواع المحتوى دي:**
   - ممنوع نهائيًا أي نجوم أو رموز Markdown (**، __، #) — هيتلصق مباشرة في مكان تاني، مش هيتقرأ كـ Markdown.
   - ممنوع تعرض أو تذكر claimStatus/claimReason أو أي عبارة زي "النص آمن من ناحية الادّعاءات"/"تم التحقق" — التحقق بيحصل جوه الأداة نفسها بصمت. لو الأداة رجعت ok:false بسبب ادّعاء غير مسموح، قول للمستخدم بس إنك محتاج تجرب زاوية تانية من غير ما تشرح التفاصيل التقنية.
   - ممنوع تخترع مواصفة أو سعر أو ضمان أو سياسة شحن/استرجاع/ضمان مش جايالك من الأداة نفسها.
   - قبل ما ترسل أي رد من الأنواع دي، راجع بصمت: هل المنتج صح؟ هل المحتوى مطابق للنوع المطلوب بالظبط (مفيش زيادة)؟ مفيش تسميات داخلية أو Markdown اتسربت؟ — لو لأ، صحّح قبل ما ترد، ومتعرضش المراجعة دي للمستخدم.
19. **"اعمل اسكيل" بدون ما يحدد حملة بعينها** — ده غير prepare_scale (قاعدة 10، اللي بتحتاج قرار SCALE_CANDIDATE من محرك القرار لمنتج معين). لما المستخدم يقول "عايز اعمل اسكيل" كده عام، استدعِ get_scale_winners فورًا — بترجع بالظبط نفس الحملات اللي ظاهرة في شاشة "🚀 جاهزة للاسكيل" في الرئيسية (طلب ≥ 1 و CPA ≤ الحد المسموح). اعرض القائمة بالاسم الحقيقي (اسم المنتج أو اسم الحملة) — ممنوع تعرض أو تطلب أي ID في الرد. لو مفيش ولا حملة في القائمة، قول ده بصراحة.
   لما المستخدم يختار حملة بالاسم، استدعِ prepare_scale_winner بـ campaignName أو productName (استخدم sourceCampaignId بس لو كان راجعلك فعلاً من get_scale_winners في نفس المحادثة). الأداة هترجعلك needsInput:true مع question محدد لو أي حاجة ناقصة (CBO/ABO، الميزانية، ميعاد البدء) — اسأل المستخدم بالظبط السؤال ده، واستقبل رده، واستدعِ prepare_scale_winner تاني بكل القيم اللي جمعتها لحد دلوقتي مع القيمة الجديدة — كرر لحد ما توصل لتاسك حقيقي (WAITING_FOR_APPROVAL). ممنوع تخترع ميزانية أو موعد بدء أو تفترض CBO/ABO من نفسك — لازم كل قيمة تيجي من كلام المستخدم صراحة. لو قال "دلوقتي" أو "فورًا" لميعاد البدء، ابعت startMode:RUN_NOW؛ لو حدد تاريخ/وقت، ابعته في startAt بصيغة YYYY-MM-DDTHH:mm واستدعِ بـstartMode:SCHEDULE. لو الأداة رجعت candidates (أكتر من حملة قريبة من الاسم)، اسأل يختار بالاسم بس. الحملة دي بتنشئ حملة جديدة فعلية على Meta لحظة الموافقة — وضّح ده للمستخدم زي أي prepare_* تاني.`;

/** Small, structured, per-page context the frontend bubble sends — appended to the system prompt as a clearly-labeled block, NEVER merged into the user's own message text, so the model can never confuse "what the user typed" with "what page they're on". */
function contextBlock(context) {
  if (!context || typeof context !== 'object') return '';
  const safe = JSON.stringify(context).slice(0, 1000);
  return `\n\nسياق الصفحة الحالية (بيانات حقيقية من الواجهة، مش من المستخدم): ${safe}`;
}

const MAX_HISTORY_TURNS = 12;
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 4000) }));
}

async function logAudit({ actorId, kind, action = 'READ', toolName = null, input, output, success = true, error = null }) {
  try {
    await prisma.aiAuditLog.create({
      data: {
        actor_id: actorId,
        kind,
        action,
        tool_name: toolName,
        input_json: input !== undefined ? JSON.stringify(input).slice(0, 4000) : null,
        output_json: output !== undefined ? JSON.stringify(output).slice(0, 4000) : null,
        success,
        error,
      },
    });
  } catch (err) {
    // Audit logging must never break the actual feature — log locally and move on.
    logger.error('AiAuditLog write failed', { message: err.message });
  }
}

router.post(
  '/chat',
  asyncRoute(async (req, res) => {
    // Legacy shape: {message}. New (floating global bubble) shape adds
    // optional history/context/image — all backward-compatible, so
    // js/ai-command-center.js's existing {message}-only calls are untouched.
    const { message, history, context, image } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'اكتب سؤال أو طلب الأول.' });
    }

    const safeHistory = sanitizeHistory(history);
    const system = SYSTEM_PROMPT + contextBlock(context);
    let userMessage = message.trim();
    if (image && typeof image.base64 === 'string' && image.base64) {
      userMessage = [
        { type: 'text', text: message.trim() },
        { type: 'image', source: { type: 'base64', media_type: image.mediaType || 'image/jpeg', data: image.base64 } },
      ];
    }

    logger.info('AI_REQUEST_STARTED', { actorId: req.user.id, messageLength: message.trim().length, historyTurns: safeHistory.length, hasImage: !!image, hasContext: !!context });

    const allToolDefs = [...TOOL_DEFINITIONS, ...WRITE_TOOL_DEFINITIONS];
    const allToolImpls = { ...TOOL_IMPLS, ...WRITE_TOOL_IMPLS };
    let lastTask = null; // the most recent PREPARE-tier tool's {task} result, forwarded to the client for the Task Card

    let result;
    try {
      result = await runTools({
        feature: 'assistant.chat',
        tier: TIERS.BALANCED, // interactive multi-tool reasoning over real business data
        system,
        userMessage,
        history: safeHistory,
        tools: allToolDefs,
        userId: req.user.id,
        executeTool: async (name, input) => {
          const impl = allToolImpls[name];
          if (!impl) throw new Error(`Tool غير معروف: ${name}`);
          // Write tools need the real authenticated user id for task
          // ownership/approval, and the real page context (e.g. productId)
          // for product resolution (prepare_campaign) — the model never
          // supplies or sees either directly.
          const isWriteTool = !!WRITE_TOOL_META[name];
          const output = isWriteTool ? await impl({ ...input, userId: req.user.id, context }) : await impl(input);
          if (isWriteTool && output?.ok && output.task) lastTask = output.task;
          await logAudit({ actorId: req.user.id, kind: 'TOOL_CALL', action: isWriteTool ? 'PREPARE' : 'READ', toolName: name, input, output, success: output?.ok !== false, error: output?.ok === false ? output.error : null });
          return output;
        },
      });
    } catch (err) {
      logger.error('AI_REQUEST_FAILED', { actorId: req.user.id, message: err.message });
      await logAudit({ actorId: req.user.id, kind: 'ASSISTANT_TURN', input: { message, context }, success: false, error: err.message });
      return res.status(400).json({ error: 'AI_ERROR', message: err.message });
    }

    // Defense-in-depth: the chat bubble (js/assistant.js) never renders
    // Markdown — it prints text verbatim — so any ** or __ the model adds
    // (a stylistic habit, observed live on both copy-generation replies AND
    // plain status/summary messages like a Task Card preview) shows up as
    // literal asterisks instead of emphasis. Stripped from every reply,
    // not just copy-generation ones, since no reply in this app is ever
    // rendered as Markdown — there's nothing this could break.
    const toolNames = result.toolCalls.map((c) => c.name);
    const replyText = result.text.replace(/\*\*/g, '').replace(/__/g, '');

    logger.info('AI_RESPONSE_COMPLETED', { actorId: req.user.id, toolCallCount: result.toolCalls.length, replyLength: replyText.length, hasTask: !!lastTask });

    await logAudit({ actorId: req.user.id, kind: 'ASSISTANT_TURN', input: { message, context }, output: { toolCalls: toolNames, textLength: replyText.length } });

    res.json({ reply: replyText, toolCalls: toolNames, task: lastTask });
  })
);

// Health scoring is deliberately deterministic (not an LLM call) — same
// principle as decisionEngine.js: the system computes the real classification,
// the AI (in /chat) only ever narrates on top of it. A health tier here is
// a plain threshold read on real numbers, never a guess.
// Generic 0-100 score → tier mapping, reused for both the marketing score
// (% of active entities that are SCALE/OPTIMIZE) and the orders score
// (confirmation rate %) — same thresholds fit both honestly.
function healthTier(scorePercent) {
  if (scorePercent === null || scorePercent === undefined) return { tier: 'UNKNOWN', label: 'مفيش بيانات كفاية' };
  if (scorePercent >= 70) return { tier: 'GOOD', label: 'كويس' };
  if (scorePercent >= 40) return { tier: 'WARN', label: 'محتاج انتباه' };
  return { tier: 'BAD', label: 'محتاج تدخل' };
}

router.get(
  '/daily-briefing',
  asyncRoute(async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const [decisions, profit, orders, lost, inventory] = await Promise.all([
      get_decisions_summary({}),
      get_product_profit({}),
      get_order_metrics({ dateFrom: today, dateTo: today }),
      get_lost_orders_summary(),
      get_inventory_status(),
    ]);

    const opportunities = [];
    const problems = [];

    if (decisions.ok && decisions.hasData && decisions.buckets) {
      for (const e of decisions.buckets.scale.slice(0, 3)) {
        opportunities.push({ type: 'SCALE', title: e.name, detail: `CPA ${e.cpa ?? '—'} جنيه`, reason: e.reason, action: e.recommendedAction });
      }
      for (const e of decisions.buckets.stop.slice(0, 3)) {
        problems.push({ type: 'STOP', title: e.name, detail: `صرف ${e.spend ?? '—'} جنيه`, reason: e.reason, action: e.recommendedAction });
      }
    }

    if (lost.ok && lost.new > 0) {
      problems.push({ type: 'LOST_ORDERS', title: `${lost.new} أوردر مفقود جديد`, detail: 'محتاج معالجة', reason: null, action: 'راجع صفحة الأوردرات المفقودة' });
    }
    if (inventory.ok && inventory.lowStockCount > 0) {
      problems.push({ type: 'INVENTORY', title: `${inventory.lowStockCount} منتج مخزونه منخفض`, detail: inventory.lowStock.slice(0, 3).map((p) => p.productName).join('، '), reason: null, action: 'راجع صفحة المخزون' });
    }

    const marketingScore = decisions.ok && decisions.hasData && decisions.totalEntities > 0
      ? Math.round(((decisions.buckets.scale.length + decisions.buckets.optimize.length) / decisions.totalEntities) * 100)
      : null;
    const ordersScore = orders.ok && orders.hasData && orders.confirmationRate !== null ? Math.round(orders.confirmationRate) : null;

    res.json({
      date: today,
      health: {
        marketing: { ...healthTier(marketingScore), score: marketingScore },
        orders: { ...healthTier(ordersScore), score: ordersScore },
        profit: { tier: profit.ok && profit.products?.length > 0 ? 'GOOD' : 'UNKNOWN', label: profit.ok && profit.products?.length > 0 ? `${profit.products.length} منتج ليه بيانات ربح حقيقية` : 'مفيش بيانات ربط كفاية' },
        inventory: inventory.ok ? { tier: inventory.lowStockCount === 0 ? 'GOOD' : 'WARN', label: inventory.lowStockCount === 0 ? 'كل المنتجات فوق الحد الأدنى' : `${inventory.lowStockCount} منتج تحت الحد الأدنى`, score: null } : { tier: 'UNKNOWN', label: 'مفيش بيانات' },
        lostOrders: lost.ok ? { tier: lost.new === 0 ? 'GOOD' : 'WARN', label: lost.new === 0 ? 'مفيش أوردرات مفقودة جديدة' : `${lost.new} أوردر مفقود جديد محتاج معالجة`, score: null } : { tier: 'UNKNOWN', label: 'مفيش بيانات' },
      },
      opportunities,
      problems,
    });
  })
);

export default router;
