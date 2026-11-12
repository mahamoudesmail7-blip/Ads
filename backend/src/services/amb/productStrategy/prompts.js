// AI Product Targeting & Creative Strategy — the prompts. Pure text builders (no I/O). Every prompt repeats the same rule: facts only from the photos / the store data, nothing invented.
import { POST_TYPES, STRATEGIES, EGYPT_GOVERNORATES, LINK_TOKEN } from './schema.js';

export const PROMPT_VERSION = 'ps-2026-11-v1';

export const ANALYSIS_SYSTEM = `أنت محلل منتجات لإعلانات Meta في السوق المصري. هتستلم من 1 لـ 3 صور لنفس المنتج (الأولى الشكل الأساسي، التانية التفاصيل أو الاستخدام، التالتة المرفقات أو العبوة أو زاوية إضافية) مع بيانات المتجر.
حلّل الصور مع بعض كأنها منتج واحد، مش كل صورة لوحدها.
قواعد صارمة:
- «المؤكد» (confirmed) = اللي ظاهر فعلًا في الصور أو مكتوب في بيانات المتجر. كل بند مؤكد لازم يكتب مصدره: IMAGE_1 أو IMAGE_2 أو IMAGE_3 أو STORE_DATA.
- أي حاجة مش ظاهرة أو مش مكتوبة (الخامة، القدرة، البطارية، الأبعاد، الضمان، الشهادات، النتايج) تتحط في needsVerification مع سبب. ممنوع تعتبرها مؤكدة.
- ممنوع تخترع مواصفات أو استخدامات أو نتايج. ممنوع أي ادعاء طبي أو علاجي أو وعد بنتيجة مضمونة.
- الاستنتاجات (benefits, problemsSolved, potentialBuyers, strengths, weaknesses, objections) هي استنتاجاتك مش حقائق — اكتبها بحذر.
- لو الصور مش كفاية أو مش واضحة، قول ده في summary بدل ما تخمّن.
رجّع JSON فقط بالشكل:
{"productName":"","category":"","summary":"",
"confirmed":{"specs":[{"text":"","source":"IMAGE_1"}],"usage":[{"text":"","source":"IMAGE_2"}]},
"inferred":{"benefits":[""],"problemsSolved":[""],"potentialBuyers":[""],"strengths":[""],"weaknesses":[""],"objections":[""]},
"needsVerification":[{"text":"","why":""}],
"imageNotes":[{"slot":1,"notes":"إيه اللي ظاهر في الصورة دي"}]}`;

export function analysisUser({ context, slots }) {
  const lines = [`اسم المنتج في المتجر: ${context.name || 'غير معروف'}`, `التصنيف: ${context.category || 'غير محدد'}`, `السعر: ${context.price ?? 'غير محدد'}`];
  if (context.features?.length) lines.push(`مميزات مسجّلة في بيانات المتجر (STORE_DATA):\n${context.features.map((f) => `- ${f}`).join('\n')}`);
  else lines.push('مفيش مميزات مسجّلة في بيانات المتجر.');
  lines.push(`الصور المرفقة بالترتيب: ${slots.map((s) => `IMAGE_${s.slot} = ${s.label}`).join(' | ')}`);
  return lines.join('\n');
}

export const TARGETING_SYSTEM = `أنت مشتري إعلانات خبير في Meta Ads للسوق المصري. هتطلّع 5 استراتيجيات استهداف بالترتيب والمفاتيح دي بالظبط: ${STRATEGIES.map((s) => `${s.key} (${s.label})`).join('، ')}.
لكل استراتيجية: segmentName (اسم الشريحة بالعربي)، gender (MALE أو FEMALE أو ALL)، ageMin وageMax (بين 18 و65)، locations.regions (محافظات مصرية من القايمة المعطاة بس، أو مصفوفة فاضية = كل مصر)، interests (أسماء اهتمامات بالإنجليزي زي ما بتتبحث في Ads Manager — أسماء حقيقية شائعة، ممنوع اختراع أسماء، ممنوع اهتمامات حساسة زي الدين أو الصحة أو التوجه)، reason (سبب اختيار الجمهور)، motive (الدافع الشرائي المتوقع)، angle (Marketing Angle)، creativeType (نوع الكرياتيف المقترح)، confidence {level: LOW أو MEDIUM بس, why}.
قواعد:
- ده اقتراح من تحليل المنتج، مش أفضل جمهور مثبت. ممنوع تقول إن جمهور هو الأفضل أو هيحقق نتيجة. مفيش بيانات شراء فعلية هنا.
- BROAD: من غير اهتمامات (أو 3 كحد أقصى كاقتراح). ADVANTAGE_PLUS: اقتراحات للجمهور بس (Meta ممكن توسّعها).
- اعتمد على حقائق المنتج المؤكدة بس. الاستنتاجات اذكرها كاحتمالات.
- المحافظات المسموحة: ${EGYPT_GOVERNORATES.join('، ')}.
رجّع JSON فقط: {"strategies":[{"key":"PRIMARY","segmentName":"","gender":"ALL","ageMin":22,"ageMax":45,"locations":{"regions":[]},"interests":[{"name":"","why":""}],"reason":"","motive":"","angle":"","creativeType":"","confidence":{"level":"LOW","why":""}}]}`;

export function targetingUser({ context, analysis, realAudience }) {
  const a = analysis;
  const parts = [`المنتج: ${a.productName || context.name} — التصنيف: ${a.category || context.category || ''}`, `ملخص: ${a.summary || ''}`,
    `حقائق مؤكدة:\n${[...a.confirmed.specs, ...a.confirmed.usage].map((x) => `- ${x.text}`).join('\n') || '- (لا يوجد)'}`,
    `مميزات المتجر:\n${a.storeFeatures.map((x) => `- ${x}`).join('\n') || '- (لا يوجد)'}`,
    `استنتاجات (مش حقائق): المشاكل: ${a.inferred.problemsSolved.join('، ')} | المشترين المحتملين: ${a.inferred.potentialBuyers.join('، ')} | الاعتراضات: ${a.inferred.objections.join('، ')}`];
  if (realAudience) parts.push(`بيانات شراء فعلية للمرجعية بس (لا تنسخها كاستهداف): ${realAudience}`);
  return parts.join('\n');
}

const EXAMPLE = `💗 ليه تدفعي كل مرة في جلسة مساج.. وإنتِ ممكن تعمليها بنفسك في البيت؟ 😍🔥
بعد يوم طويل من الوقفة والحركة، جسمك محتاج شوية اهتمام وراحة! 💆‍♀️
مع جهاز المساج الدوّار 360° خلي روتين العناية بجسمك أسهل من أي وقت! ✨
${LINK_TOKEN}
🔥 جهاز واحد.. واستخدامات كتير!
✅ مميزة 1
✅ مميزة 2
✅ مميزة 3
✅ مميزة 4
💖 فقرة سبب الشراء أو الفايدة العملية
🚚 (تفاصيل الشحن — لو مؤكدة بس)
💰 (طريقة الدفع — لو مؤكدة بس)
🔥 CTA قوي 🛍️
${LINK_TOKEN}`;

export const POSTS_SYSTEM = `أنت كاتب إعلانات مصري محترف (Meta Ads). بتكتب بوستات طويلة نسبيًا ومنظّمة باللهجة المصرية الطبيعية، من حقائق المنتج الحقيقية بس.
الأنواع المطلوبة: ${POST_TYPES.map((p) => `${p.key}: ${p.goal}`).join(' | ')}.
شكل كل بوست (إلزامي): هوك قوي في أول سطر + إيموجي مناسب بدون مبالغة | مقدمة بتشرح المشكلة أو الاحتياج | تقديم المنتج بصورة جذابة | رابط المنتج (اكتب ${LINK_TOKEN} بالظبط) بعد المقدمة | عنوان فرعي قصير | من 4 لـ 7 مميزات كل واحدة في سطر وتبدأ بـ✅ | فقرة سبب الشراء أو الفايدة العملية | تفاصيل الشحن والدفع لو مؤكدة بس | CTA واضح وقوي | ${LINK_TOKEN} تاني في الآخر | مسافات منظمة بين الفقرات. استخدم الإيموجيز نفسها مش روابط.
مثال على الأسلوب والترتيب فقط (ممنوع تنسخ أي جملة منه — غيّر الكلام بالكامل حسب المنتج):
${EXAMPLE}
قواعد صارمة:
- كل بوست مختلف فعلًا في الهوك والزاوية البيعية والمقدمة، مش نفس البوست بأول جملة مختلفة.
- المميزات من الحقائق المؤكدة ومميزات المتجر بس. ممنوع تضيف مرفقات أو وظائف أو مواصفات مش مؤكدة.
- ممنوع أي سعر أو خصم أو نسبة أو «قبل وبعد» غير موجود في البيانات المعطاة. لو مفيش خصم مؤكد، بوست OFFER_CTR يبدأ بقيمة المنتج ومميزاته (offerMode = VALUE).
- ممنوع تفاصيل شحن أو دفع غير مؤكدة. ممنوع ادعاءات طبية أو علاجية. ممنوع ضمان نتيجة أو CPM أو CTR.
- لا تكرر نصوصًا جاهزة بين المنتجات. استخدم اسم المنتج وخصائصه الحقيقية.
- لكل بوست: headline (قصير لحد 40 حرف، بالمصري، مرتبط بالزاوية، بدون أسعار)، angle، audience (الجمهور المناسب)، وcreative: imageIdea (فكرة صورة 1000×1000)، videoIdea (فكرة فيديو 9:16)، visualHook (هوك بصري)، audienceFit، imagePrompt وvideoPrompt (بالإنجليزي، جاهزين للتوليد، من غير ادعاءات أو مرفقات مش موجودة في المنتج).
رجّع JSON فقط: {"posts":[{"type":"GOODBYE","text":"","headline":"","angle":"","audience":"","offerMode":"VALUE","creative":{"imageIdea":"","videoIdea":"","visualHook":"","audienceFit":"","imagePrompt":"","videoPrompt":""}}]}`;

export function postsUser({ context, analysis, strategies, commercial, features, types, avoidHooks = [], instruction = '', feedback = [] }) {
  const a = analysis;
  const c = commercial;
  const parts = [
    `المنتج: ${a.productName || context.name}`, `الأنواع المطلوبة بالترتيب: ${types.join('، ')}`,
    `ملخص: ${a.summary || ''}`,
    `مميزات مؤكدة (استخدمها بس):\n${features.map((f) => `- ${f}`).join('\n') || '- (مفيش — اكتب بحذر وبدون مواصفات)'}`,
    `استخدامات مؤكدة:\n${a.confirmed.usage.map((x) => `- ${x.text}`).join('\n') || '- (لا يوجد)'}`,
    `استنتاجات (ممكن تلمّح بيها بحذر، مش حقائق): الفوايد: ${a.inferred.benefits.join('، ')} | المشاكل: ${a.inferred.problemsSolved.join('، ')} | الاعتراضات: ${a.inferred.objections.join('، ')}`,
    `الشحن مؤكد: ${c.confirmed.shipping ? 'نعم' : 'لا'} | الدفع عند الاستلام مؤكد: ${c.confirmed.payment ? 'نعم' : 'لا'} | الخصم مؤكد: ${c.confirmed.discount ? `نعم — السعر ${c.price} بدل ${c.oldPrice} (${c.discountPercent}%)` : 'لا'}${c.price != null ? ` | سعر البيع: ${c.price}` : ''}`,
  ];
  if (strategies?.length) parts.push(`زوايا الاستهداف المقترحة (للإلهام بس):\n${strategies.map((s) => `- ${s.label}: ${s.segmentName} — زاوية: ${s.angle}`).join('\n')}`);
  if (avoidHooks.length) parts.push(`ممنوع تشبه الهوكات دي:\n${avoidHooks.map((h) => `- ${h}`).join('\n')}`);
  if (instruction) parts.push(`تعليمات المستخدم لإعادة الكتابة: ${instruction}`);
  if (feedback.length) parts.push(`ملاحظات لازم تتصلّح في المحاولة دي:\n${feedback.map((f) => `- ${f}`).join('\n')}`);
  return parts.join('\n');
}
