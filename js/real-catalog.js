// real-catalog.js — the user's actual Master Product List (spec: "هذه
// المنتجات هي Master Product List"). A one-time, hand-transcribed literal
// list (127 products) run through the SAME buildImportPlan()/db.js path a
// future CSV/Excel upload would use — so this isn't a special back door,
// it exercises the real import pipeline once with real data.
//
// PRD-001..PRD-127 assigned in the exact order the products were given.
// SKU is set ONLY for the 9 products that had one visibly embedded in
// their name (S53, S55, S56, S103, S104, S105, S184, S190, S232) — in
// those cases the "(Sxx)" suffix is stripped from the display name and
// moved into the sku field, matching the worked example given for import.
// Every other product's sku is '' — never invented.
//
// category is a best-effort keyword classification into the fixed list
// (Beauty/Health/Home/Electronics/Kids/Fitness/Accessories/Kitchen/Smart
// Devices/Other) from the product name alone — nothing researched or
// guessed beyond what the name itself says. Ambiguous names default to
// 'Other' rather than a confident-sounding wrong guess.
//
// stock is intentionally NOT set here (stays null = "غير محدد") — real
// stock counts don't exist yet; inventing a number would violate the
// no-fabrication rule that's been enforced everywhere else in this app.
import { Products } from './db.js';
import { buildImportPlan } from './product-import.js';

const CATALOG = [
  ['جهاز قياس نبضات الجنين', '', 'Health'],
  ['جهاز إزالة شعر الوجه مع المصباح الذكي', '', 'Beauty'],
  ['جهاز كشف الكاميرات والتجسس الذكي', '', 'Electronics'],
  ['جهاز هايفور للتجاعيد', '', 'Beauty'],
  ['مكبر صوت مع معطر – موسيقى هادئة وعطر يملأ المكان', '', 'Home'],
  ['مصباح المنارة الذكي – إضاءة هادئة وديكور أنيق لمنزلك', '', 'Home'],
  ['جهاز تنظيف الأذن الذكي مزود بكاميرا', '', 'Health'],
  ['فرشاة ذكية لتنظيف الاسنان', '', 'Health'],
  ['شنطة ظهر ذكية', '', 'Accessories'],
  ['شاشة السيلفي المغناطيسية الذكية', '', 'Electronics'],
  ['مبرد اظافر كهربائي', '', 'Beauty'],
  ['عربية ريموت', '', 'Kids'],
  ['سماعة اذن', '', 'Electronics'],
  ['كاميرا جيب الذكية', '', 'Electronics'],
  ['جهاز تنظيف الزجاج الكهربائي', '', 'Home'],
  ['جهاز تنظيف الاسنان بالموجات فوق الصوتية مع مجموعة من الرؤوس للتنظيف', '', 'Health'],
  ['سماعة بلوتوث كلاسيكية مع إضاءة موجية', '', 'Electronics'],
  ['جهاز مساعد علي النوم محمول', '', 'Health'],
  ['قبعة حاجبة للشمس مع مروحة تبريد شحن USB', '', 'Accessories'],
  ['حساسية الانف جديد', '', 'Health'],
  ['حساسية الانف', '', 'Health'],
  ['فواحد اللهب جديدة', '', 'Home'],
  ['نظارة جديدة قراءة', '', 'Accessories'],
  ['جهاز انقاذ من الاختناق', '', 'Health'],
  ['حامل لابتوب', '', 'Electronics'],
  ['ستاند ترايبود مغناطيسي', '', 'Electronics'],
  ['نظارة شمس', '', 'Accessories'],
  ['ديكور زجاجي أنيق مستوحى من الطبيعة', '', 'Home'],
  ['فرشاة أسنان كهربائية 4 في 1 و6 أوضاع سرعة', '', 'Health'],
  ['نظارة علاج بالضوء الاحمر لتجاعيد العين', 'S53', 'Beauty'],
  ['كاميرا أكشن 4K صغيرة متعددة الاستخدامات', '', 'Electronics'],
  ['جهاز تدليك الركبة بالتسخين وعلاج طبيعي بالاهتزاز بالاشعة', '', 'Health'],
  ['منفاخ و شاحن لبطارية السيارة وباور بانك 4X1', '', 'Electronics'],
  ['مدفأة الأجواء الذكية 3×1 (دفء + ترطيب + عطر)', '', 'Home'],
  ['بخاخ نانو تعقيم سريع وعملي في ثواني', '', 'Health'],
  ['ميكروسكوب USB بقدرة تكبير حتى 1600x', '', 'Electronics'],
  ['مضخة كهربائية لاسلكية للرضاعة الطبيعية – قطعة واحدة', '', 'Health'],
  ['جهاز ضغط معصم', '', 'Health'],
  ['مرطب الهواء بتأثير المطر – تصميم غابة مصغرة داخلية مع إضاءة ليلية LED', '', 'Home'],
  ['حزام تبول', '', 'Health'],
  ['محول شحن ذكي', '', 'Electronics'],
  ['مصباح LED كشاف', '', 'Home'],
  ['مقبض مغناطيسي للتحكم في كاميرا الهاتف مناسب لأيفون وأندرويد', '', 'Electronics'],
  ['جهاز قياس درجة حرارة الديجيتال', '', 'Health'],
  ['الطاولة الذكية متعددة الاستخدام قابلة للطي', '', 'Home'],
  ['حامل كاميرا أسود', '', 'Electronics'],
  ['راديو كلاسيكي – ستايل الماضي', '', 'Electronics'],
  ['جهاز قياس الضغط الذكي المنزلي', '', 'Health'],
  ['جهاز قياس نبضات القلب ونسبة الأكسجين في الدم بدقة طبية عالية', '', 'Health'],
  ['راديو أنيق يجمع بين الماضي والحاضر', '', 'Electronics'],
  ['شفاط حليب كهربائي بشاشة للتحكم', '', 'Health'],
  ['مسدس الحجامة الكهربائي الذكي مع 6 كؤوس', '', 'Health'],
  ['خيمة شاطئية', '', 'Accessories'],
  ['منفاخ بامب', '', 'Accessories'],
  ['قناع السيليكون لشد الوجه وإخفاء اللغد', '', 'Beauty'],
  ['جهاز لتصحيح اعوجاج إصبع القدم الكبير', '', 'Health'],
  ['راوتر واي فاي', '', 'Electronics'],
  ['دعامة رقبة بتصميم ذكي لدعم الذقن والعمود الفقري', 'S55', 'Health'],
  ['ماكينة إزالة الشعر الكهربائية متعددة الاستخدام', '', 'Beauty'],
  ['جهاز مساج لتخفيف ألم الدورة الشهرية بالتدفئة والمساج', '', 'Health'],
  ['كونسول ألعاب محمول', '', 'Electronics'],
  ['ساعة ومنبه', '', 'Electronics'],
  ['جهاز العناية بالبشرة وشد الوجه بتقنية HIFU', 'S56', 'Beauty'],
  ['فواحة', '', 'Home'],
  ['مكتب لاب توب متنقل متعدد الزوايا والاستخدام', '', 'Home'],
  ['جهاز تنظيف الأسنان بالماء اللاسلكي مع 3 أوضاع و4 رؤوس', '', 'Health'],
  ['طاولة جانبية على شكل C بارتفاع قابل للتعديل، طاولة جانبية دوارة 360 درجة', '', 'Home'],
  ['جهاز جلسات استنشاق البخار المتنقل', '', 'Health'],
  ['مسند ظهر ذكي متعدد الزوايا', '', 'Health'],
  ['وسادة تدليك الرقبة الذكية بالاهتزاز لتخفيف آلام العضلات والاسترخاء اليومي', '', 'Health'],
  ['منظف أقمشة', '', 'Home'],
  ['طيارة', '', 'Kids'],
  ['جهاز تدليك كهربائي للرقبة والظهر لتخفيف الألم - للأنسجة العميقة رباعية الأبعاد', '', 'Health'],
  ['لانش بوكس 3 قطع حراري لحفظ الطعام + شنطة عزل حراري', '', 'Kitchen'],
  ['جهاز تنظيف بالبخار المحمول – متعدد الاستخدامات', '', 'Home'],
  ['جهاز شفط حليب الأم كهربائي للرضاعة الطبيعية بدرجة صوت هادئة', '', 'Health'],
  ['حقيبة انسولين', '', 'Health'],
  ['جهاز العناية الذكية بالبشرة وشد الوجه بتقنية الهايفو وEMS', '', 'Beauty'],
  ['نافورة مياه تعمل بالطاقة الشمسية', '', 'Home'],
  ['جهاز تدليك الرقبة والظهر مع تدفئة، لتخفيف آلام الجسم والكتفين', '', 'Health'],
  ['طاولة دراسة أطفال', '', 'Kids'],
  ['استشوار فرشاة وان ستيب هوم جولد 1200 وات', '', 'Beauty'],
  ['سمارت كيدز - تواصل آمن وذكي للأطفال بالصوت والصورة', '', 'Kids'],
  ['جهاز تدليك العين مع حرارة لتخفيف الصداع النصفي - مع بلوتوث وضغط هواء', '', 'Health'],
  ['مساج قطعة واحدة', '', 'Health'],
  ['كرات تبريد الوجه للإرهاق والرؤوس السوداء', '', 'Beauty'],
  ['كاتيل زجاج ديجيتال ذكي', '', 'Kitchen'],
  ['مثبت الموبايل الذكي بتحكم كامل', '', 'Electronics'],
  ['آلة حاسبة', '', 'Electronics'],
  ['قناع البشرة المنزلي للوجه والرقبة للعناية بالبشرة وتجديد شباب الوجه', '', 'Beauty'],
  ['فرشاة ومصفف شعر احترافية للنساء 4 في 1 ماركة VGR', '', 'Beauty'],
  ['جهاز Game TV Stick 8K لتحويل شاشتك لـSmart وألعاب بلايستيشن', '', 'Electronics'],
  ['منظف البخار – تطهير بدرجة الحرارة العالية وتكييف الهواء', '', 'Home'],
  ['ترمومتر', '', 'Health'],
  ['سيارة أطفال كهربائية بابلز', '', 'Kids'],
  ['جهاز الطهي كهربائي متعدد الاستخدام', '', 'Kitchen'],
  ['مسدس مساج CHIROGUN متعدد الرؤوس 17 رأس', '', 'Fitness'],
  ['مثبت الهاتف الذكي 360', '', 'Electronics'],
  ['عربية كهربائية للأطفال مزودة بريموت تحكم للآباء – متينة وقابلة للطي', '', 'Kids'],
  ['مسدس مساج أصلي متعدد السرعات مزود بـ9 رؤوس لتقوية العضلات', '', 'Fitness'],
  ['مكتب متنقل للابتوب أسود متعدد الاستخدام', '', 'Home'],
  ['جهاز تبريد ذكي صغير وسهل الحمل', 'S103', 'Electronics'],
  ['دراجة نارية V4R', 'S104', 'Kids'],
  ['حوض السمك الذكي للمكتب 5 في 1', 'S105', 'Home'],
  ['كاميرا الصيد الذكية تحت الماء بشاشة ملونة وسلك بطول 20 متر', '', 'Electronics'],
  ['منبه التبول الذكي للأطفال وكبار السن', '', 'Health'],
  ['جهاز فحص الأذن والأنف والفم بالكاميرا الذكية', '', 'Health'],
  ['كاب الليزر لتحفيز نمو الشعر', '', 'Beauty'],
  ['كوب ذكي كهربائي للتبريد والتسخين الفوري', '', 'Kitchen'],
  ['القفاز الذكي لإعادة تأهيل اليد والأصابع', '', 'Health'],
  ['ديرما ستامب احترافية 120 إبرة للشعر والبشرة', '', 'Beauty'],
  ['ماكينة صنع الثلج DSP الاحترافية – ثلج جاهز خلال 6 دقائق', '', 'Kitchen'],
  ['ماكينة صنع الخبز الذكية من DSP – عجن وتخمير وخبز بضغطة زر', '', 'Kitchen'],
  ['ماكينة إسبريسو احترافية DSP KA3123 بمطحنة بن مدمجة وتحكم باللمس – ضغط 20 بار', '', 'Kitchen'],
  ['ماكينة تنظيف السجاد والمفروشات بالبخار والماء الساخن – شفط قوي 3 في 1 من DSP', '', 'Home'],
  ['ماكينة السلاش متعددة الاستخدامات من DSP', '', 'Kitchen'],
  ['جهاز تنظيف الأذن بالماء الآمن', '', 'Health'],
  ['ديكور تأثير الأسماك المتحركة بإضاءة LED', 'S232', 'Home'],
  ['روبوت ذكي لتنظيف الزجاج والنوافذ بميزة رش المياه التلقائي مع ريموت كنترول DSP', '', 'Home'],
  ['جهاز تنظيف السجاد والمفروشات 3 في 1 – شفط ورش وتنظيف', '', 'Home'],
  ['فواحة زيوت عطرية بتصميم الأسطوانة الكلاسيكية مع إضاءة ومرطب هواء وبلوتوث', 'S184', 'Home'],
  ['روبوت تنظيف الزجاج والرخام والسيراميك', 'S190', 'Home'],
  ['جهاز مساج للوجه والرقبة بأربع رؤوس دوارة', '', 'Health'],
  ['راديو كلاسيكي ذكي بتأثير اللهب', '', 'Electronics'],
  ['سبيكر القرآن الكريم – صوت روحاني في كل مكان + Bluetooth', '', 'Electronics'],
  ['فرشاة الشعر الذكية للترطيب والتصفيف', '', 'Beauty'],
  ['فواحة وهج البركان والضباب الهادئ مع إضاءة LED', '', 'Home'],
];

/** Builds the {product_name, sku, category} rows product-import.js expects, with PRD-001..PRD-NNN assigned in list order. */
export function buildRealCatalogRows() {
  return CATALOG.map(([product_name, sku, category], i) => ({
    product_name,
    sku,
    category,
    product_code: `PRD-${String(i + 1).padStart(3, '0')}`,
  }));
}

/**
 * Runs the real catalog through the same buildImportPlan() a CSV upload
 * would use, then commits it: creates new products (is_demo:false,
 * active:true, stock left null/"غير محدد"), and for already-existing
 * matches, updates product_code/category/sku without touching any
 * financial/inventory/active data the user may have already entered by
 * hand. Safe to run more than once — a second run updates in place instead
 * of creating duplicates.
 */
export async function importRealCatalog() {
  const rows = buildRealCatalogRows();
  const existing = await Products.all();
  const plan = buildImportPlan(existing, rows);

  let created = 0;
  let updated = 0;

  for (const row of plan.toCreate) {
    await Products.create({
      product_name: row.product_name,
      sku: row.sku,
      category: row.category,
      product_code: row.product_code,
      active: true,
      is_demo: false,
    });
    created++;
  }

  for (const { existing: existingProduct, row } of plan.toUpdate) {
    await Products.update(existingProduct.id, {
      product_name: row.product_name,
      sku: row.sku || existingProduct.sku,
      category: row.category || existingProduct.category,
      product_code: existingProduct.product_code || row.product_code,
    });
    updated++;
  }

  return {
    created,
    updated,
    duplicatesInFile: plan.duplicatesInFile.length,
    errors: plan.errors.length,
    total: rows.length,
    withSku: rows.filter((r) => r.sku).length,
    withoutSku: rows.filter((r) => !r.sku).length,
  };
}
