// 🧠 Daily Tasks — the SMART builder. Turns what the system already knows (campaign rows with stock / winner / CPA-vs-limits / pending AI-Operator decisions, scale-winner cards, ad-account funds,
// stuck clone batches, today's open plan) into PRODUCT-LEVEL tasks a media buyer can read once and act on. Three buckets, as the owner asked:
//   SCALE — products that are working (ONE task per product: «اسكيل ب500 ABO + 500 CBO» or four 500s when the cost per order is excellent)
//   FIX   — products that HAVE stock but do not sell (spend with no orders / CPA above the limit) + products that sell and have stock → a NEW TEST to raise orders
//   MIX   — everything else: stock running out, low funds, AI-Operator decisions waiting, stuck clone batches, the open plan, routines, manual tasks
// Pure: no database, no network, no clock. The wording is deliberate — short, direct, Egyptian, with the numbers that matter and clear steps.
import { nameFamily } from '../amb/accountProductsToday.js';

export const BUCKET_LABEL = { SCALE: 'اسكيل المنتجات الرابحة', FIX: 'حل مشاكل وتيست جديد', MIX: 'شغل متنوّع' };
export const BUCKET_ICON = { SCALE: '🚀', FIX: '🔧', MIX: '🧩' };
export const SMART_DEFAULTS = { scaleBudget: 500, strongCpa: 50, strongScales: 4, normalScales: 2, testMinOrders: 2, minTestStock: 30, testMaxCampaigns: 2, maxTest: 8, maxFix: 20, liteCpa: 100 };

const n0 = (v) => Math.round(Number(v) || 0);
const egp = (v) => `${n0(v).toLocaleString('en-US')} ج`;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** «350 قطعة» / «المخزون خلص» / «المخزون مش معروف» */
export function stockPhrase(stock) {
  if (!stock) return null;
  if (stock.status === 'OUT_OF_STOCK') return 'المخزون خلص';
  if (stock.current != null && Number(stock.current) >= 0) return `${n0(stock.current)} قطعة في المخزون`;
  if (stock.status === 'LOW') return 'المخزون قليل';
  if (stock.status === 'OK') return 'المخزون متاح';
  return null;
}
const stockKnownOk = (stock, min) => !!stock && stock.status !== 'OUT_OF_STOCK' && stock.status !== 'STOCK_UNKNOWN' && (stock.status === 'OK' || (stock.current != null && Number(stock.current) >= min));

/** Rows (campaign level) → product groups with the numbers the tasks need. Unlinked campaigns group by name family (display only, like the accounts card). */
export function groupByProduct(rows) {
  const g = new Map();
  for (const r of rows || []) {
    const fam = nameFamily(r.name);
    const key = r.productId != null ? `p:${r.productId}` : `n:${fam.key || r.campaignId}`;
    const cur = g.get(key) || { key, productId: r.productId ?? null, name: r.productName || fam.label || r.name, campaigns: [], active: 0, spendToday: 0, ordersToday: 0, spend3: 0, orders3: 0, stock: null, winner: false, hard: false, reduce: false, limit: null, decisions: [], bestCpa: null };
    cur.campaigns.push(r);
    const isActive = r.status === 'ACTIVE' && r.dataFresh !== false;
    if (isActive) cur.active += 1;
    cur.spendToday += Number(r.today?.spend) || 0; cur.ordersToday += Number(r.today?.orders) || 0;
    cur.spend3 += Number(r.period?.spend) || 0; cur.orders3 += Number(r.period?.orders) || 0;
    if (r.stock && (!cur.stock || cur.stock.status === 'STOCK_UNKNOWN')) cur.stock = r.stock;
    const rl = Number(r.limits?.reduce) || Number(r.limits?.hardStop) || 0; if (rl) cur.reduceLimit = cur.reduceLimit ? Math.min(cur.reduceLimit, rl) : rl;
    if (r.winner?.status === 'WINNER') cur.winner = true;
    if (isActive && r.cpaVsLimits === 'ABOVE_HARDSTOP') { cur.hard = true; cur.limit = Math.max(cur.limit || 0, Number(r.limits?.hardStop) || 0) || cur.limit; }
    else if (isActive && r.cpaVsLimits === 'ABOVE_REDUCE') { cur.reduce = true; cur.limit = Math.max(cur.limit || 0, Number(r.limits?.reduce) || 0) || cur.limit; }
    const c = [r.cpa?.d7, r.cpa?.d3].map(Number).filter((x) => x > 0); if (c.length) cur.bestCpa = cur.bestCpa == null ? Math.min(...c) : Math.min(cur.bestCpa, ...c);
    if (r.pendingDecision) cur.decisions.push({ ...r.pendingDecision, campaignName: r.name, productName: r.productName });
    g.set(key, cur);
  }
  for (const x of g.values()) { x.cpa3 = x.orders3 > 0 ? x.spend3 / x.orders3 : null; }
  return g;
}

// ───────────── SCALE ─────────────
export function scalePlan(cpa, o) {
  const strong = cpa != null && cpa <= o.strongCpa; const count = strong ? o.strongScales : o.normalScales;
  const modes = []; for (let i = 0; i < count; i++) modes.push(i % 2 === 0 ? 'ABO' : 'CBO');
  return { strong, plan: modes.map((mode) => ({ mode, budget: o.scaleBudget })) };
}

export function scaleTasks(groups, cards, o) {
  const out = []; const used = new Set();
  const cardBy = new Map(); // product key -> best pending card
  for (const c of cards || []) {
    if (c.decisionStatus !== 'PENDING') continue;
    let key = null; for (const [k, g] of groups) if (g.campaigns.some((r) => r.campaignId === c.sourceCampaignId)) { key = k; break; }
    key = key || `n:${nameFamily(c.displayName || c.sourceCampaignName).key}`;
    const cur = cardBy.get(key); if (!cur || (c.orders || 0) > (cur.orders || 0)) cardBy.set(key, c);
  }
  const keys = new Set([...cardBy.keys(), ...[...groups.values()].filter((g) => g.winner).map((g) => g.key)]);
  for (const key of keys) {
    const g = groups.get(key); const card = cardBy.get(key); const name = clean(g?.name || card?.productName || card?.displayName); if (!name) continue;
    if (g?.stock?.status === 'OUT_OF_STOCK') continue; // never scale what cannot be shipped (the stock task covers it)
    const cpa = card?.cpa ?? g?.bestCpa ?? g?.cpa3 ?? null; const orders = card?.orders ?? g?.orders3 ?? 0;
    const { strong, plan } = scalePlan(cpa, o);
    const best = card ? { id: card.sourceCampaignId, name: card.sourceCampaignName } : (() => { const r = (g?.campaigns || []).filter((x) => x.winner?.status === 'WINNER').sort((a, b) => (Number(a.cpa?.d7) || 1e9) - (Number(b.cpa?.d7) || 1e9))[0]; return r ? { id: r.campaignId, name: r.name } : null; })();
    const abo = plan.filter((p) => p.mode === 'ABO').length; const cbo = plan.length - abo; const stock = stockPhrase(g?.stock);
    const lowStock = g?.stock?.status === 'LOW';
    out.push({
      key: `scale:${key}`, type: 'SCALE', category: 'SCALE', priority: strong ? 'HIGH' : 'MED',
      title: strong ? `اسكيل «${name}» — ${plan.length} اسكيلات، كل واحد ${n0(o.scaleBudget)} ج` : `اسكيل «${name}» — ABO بـ${n0(o.scaleBudget)} ج و CBO بـ${n0(o.scaleBudget)} ج`,
      why: `«${name}» ماشي حلو${orders ? `: جاب ${orders} ${orders === 1 ? 'أوردر' : 'أوردر'}` : ''}${cpa != null ? ` بتكلفة ${n0(cpa)} ج للأوردر` : ''}.${strong ? ' الرقم ده ممتاز، فنكبّر بقوة.' : ' يستاهل نوسّعه.'}${lowStock ? ` خد بالك: المخزون قليل (${stock}).` : ''}`,
      steps: [
        `افتح «مركز التوسّع» وخد ${best ? `حملة «${best.name}»` : 'أحسن حملة للمنتج'} كأساس.`,
        ...plan.map((p, i) => `اعمل اسكيل ${i + 1}: ${p.mode} بميزانية ${n0(p.budget)} ج${p.mode === 'ABO' ? ' (الميزانية على الـ Ad Set)' : ' (الميزانية على الحملة)'}.`),
        'استخدم الكرياتيفات الرابحة بس، وماتكرّرش اسكيل اتعمل قبل كده.',
        'لما تخلّص اضغط «تمّت» واكتب في الملاحظة أرقام الاسكيلات.',
      ],
      plan, facts: [...(orders ? [{ l: 'أوردرات', v: String(orders) }] : []), ...(cpa != null ? [{ l: 'تكلفة الأوردر', v: egp(cpa) }] : []), ...(stock ? [{ l: 'المخزون', v: stock.replace(' في المخزون', '') }] : [])],
      product: { id: g?.productId ?? null, name }, campaignId: best?.id || null, accountId: card?.adAccountId || null,
      link: { page: 'ai-media-buyer.html#scale', label: 'افتح مركز التوسّع' }, action: 'اسكيل',
    });
    used.add(key);
  }
  return { tasks: out.sort((a, b) => (b.priority === 'HIGH') - (a.priority === 'HIGH')), used };
}

// ───────────── FIX + TEST ─────────────
export function fixTasks(groups, scaleKeys, o, { zeroLimit = 150, minSpend = 150 } = {}) {
  const fixes = []; const fixKeys = new Set();
  for (const g of groups.values()) {
    if (g.stock?.status === 'OUT_OF_STOCK') continue; // out of stock is a different job (MIX)
    const zeroToday = g.active > 0 && g.ordersToday === 0 && g.spendToday > zeroLimit;
    const zero3 = g.active > 0 && g.orders3 === 0 && g.spend3 >= zeroLimit * 2;
    const cpaBad = (g.hard || g.reduce) && g.spend3 >= minSpend && g.limit && g.cpa3 != null && g.cpa3 >= g.limit * 1.1;
    if (!zeroToday && !zero3 && !cpaBad) continue;
    const stock = stockPhrase(g.stock); const stockLine = stock && g.stock?.status !== 'STOCK_UNKNOWN' ? ` والمنتج عنده ${stock.replace(' في المخزون', '')} في المخزون` : '';
    const worst = g.campaigns.filter((r) => r.status === 'ACTIVE').sort((a, b) => (Number(b.period?.spend) || 0) - (Number(a.period?.spend) || 0)).slice(0, 3).map((r) => r.name);
    const zero = zeroToday || zero3; const hardOrBig = g.hard || (zeroToday && g.spendToday >= zeroLimit * 2) || (zero3 && g.spend3 >= zeroLimit * 4);
    fixes.push({
      key: `fix:${g.key}`, type: zero ? 'ZERO_ORDERS' : 'CPA', category: 'FIX', priority: hardOrBig ? 'HIGH' : 'MED', weightHint: zero ? g.spendToday || g.spend3 : g.spend3,
      title: zero ? `«${clean(g.name)}» بيصرف ومبيجيبش أوردرات` : `«${clean(g.name)}» تكلفة الأوردر عالية`,
      why: zero
        ? `«${clean(g.name)}» ${zeroToday ? `صرف ${egp(g.spendToday)} النهارده من غير ولا أوردر` : `صرف ${egp(g.spend3)} في آخر 3 أيام من غير ولا أوردر`}${stockLine}. يعني المشكلة مش في الكمية، لازم نعرف ليه مبيطلعش.`
        : `تكلفة الأوردر في «${clean(g.name)}» بقت ${n0(g.cpa3)} ج وده فوق ${g.hard ? 'حد الإيقاف' : 'حد التخفيض'} (${n0(g.limit)} ج) والحملة لسه شغالة${stockLine}.`,
      steps: zero ? [
        `افتح حملات «${clean(g.name)}» وشوف الكرياتيف: الـ Hook في أول 3 ثواني والـ CTR.`,
        `لو الحملة صرفت فوق ${egp(zeroLimit)} من غير أوردر، وقّفها (أو قلّل ميزانيتها للنص على الأقل).`,
        `جرّب كرياتيف أو جمهور جديد بميزانية صغيرة (حوالي ${egp(200)}) بدل ما تكمّل على اللي مش شغّال.`,
        'اكتب في الملاحظة إيه اللي عملته (وقفت / غيّرت كرياتيف / جمهور جديد).',
      ] : [
        `افتح حملات «${clean(g.name)}» ${worst.length ? `(الأعلى صرفًا: ${worst.join('، ')})` : ''} وشوف أنهي حملة الـ CPA بتاعها أعلى.`,
        g.hard ? 'وقّف الحملات اللي فوق حد الإيقاف، أو قلّل ميزانيتها بشكل واضح.' : 'قلّل ميزانية الحملات اللي فوق حد التخفيض وراقبها بكرة.',
        'خلّي الحملات الأحسن شغّالة ومتلمسهاش.',
        'اكتب في الملاحظة إيه اللي عملته.',
      ],
      facts: [{ l: 'صرف آخر 3 أيام', v: egp(g.spend3) }, { l: 'أوردرات', v: String(g.orders3) }, ...(g.cpa3 != null ? [{ l: 'التكلفة', v: egp(g.cpa3) }] : []), ...(stock ? [{ l: 'المخزون', v: stock.replace(' في المخزون', '') }] : [])],
      product: { id: g.productId, name: clean(g.name) }, link: { page: 'ai-media-buyer.html', label: 'افتح AI Media Buyer' }, action: zero ? 'افحص أو وقّف' : 'قلّل أو وقّف',
    });
    fixKeys.add(g.key);
  }
  fixes.sort((a, b) => (b.priority === 'HIGH') - (a.priority === 'HIGH') || (b.weightHint || 0) - (a.weightHint || 0));
  const tests = [];
  for (const g of groups.values()) {
    if (scaleKeys.has(g.key) || fixKeys.has(g.key) || g.winner) continue;
    if (g.orders3 < o.testMinOrders || g.active === 0 || g.active > o.testMaxCampaigns || !stockKnownOk(g.stock, o.minTestStock)) continue;
    if (g.hard || g.reduce) continue;
    const stock = stockPhrase(g.stock);
    tests.push({
      key: `test:${g.key}`, type: 'TEST', category: 'FIX', priority: 'MED', weightHint: g.orders3,
      title: `«${clean(g.name)}» بيطلع أوردرات — اعمله تيست جديد`,
      why: `«${clean(g.name)}» جاب ${g.orders3} أوردر في آخر 3 أيام${g.cpa3 != null ? ` بتكلفة ${n0(g.cpa3)} ج` : ''}، وعنده ${stock.replace(' في المخزون', '')} في المخزون. فيه كمية تستحمل نزوّد أوردراته، فنجرّب كرياتيف جديد.`,
      steps: [
        'اعمل تيست جديد بكرياتيف مختلف تمامًا (زاوية أو فيديو جديد) وسيب القديم شغّال زي ما هو.',
        `ابدأ بميزانية صغيرة (حوالي ${egp(200)}) وراقبه 48 ساعة.`,
        'لو جاب أوردرات بتكلفة كويسة، يبقى مرشّح للاسكيل في تاسكات الأيام الجاية.',
        'اكتب في الملاحظة إيه الكرياتيف الجديد.',
      ],
      facts: [{ l: 'أوردرات آخر 3 أيام', v: String(g.orders3) }, ...(g.cpa3 != null ? [{ l: 'التكلفة', v: egp(g.cpa3) }] : []), { l: 'المخزون', v: stock.replace(' في المخزون', '') }],
      product: { id: g.productId, name: clean(g.name) }, link: { page: 'creative-factory.html', label: 'افتح مصنع الكرياتيفات' }, action: 'تيست جديد',
    });
  }
  tests.sort((a, b) => b.weightHint - a.weightHint);
  return { fixes: fixes.slice(0, o.maxFix), tests: tests.slice(0, o.maxTest) };
}

// ───────────── MIX ─────────────
const DECISION_AR = { PAUSE: ['إيقاف', 'راجع واعتمد قرارات الإيقاف', 'AI Operator رشّح إيقاف'], OPEN: ['فتح', 'راجع واعتمد قرارات الفتح', 'AI Operator جهّز فتح'], SCALE_UP: ['زيادة ميزانية', 'راجع واعتمد زيادات الميزانية', 'AI Operator اقترح زيادة ميزانية'], SCALE_DOWN: ['تخفيض ميزانية', 'راجع واعتمد تخفيضات الميزانية', 'AI Operator اقترح تخفيض ميزانية'] };

export function mixTasks(groups, { funds = [], batches = [], plan = null, failedScales = [] } = {}) {
  const out = [];
  for (const g of groups.values()) {
    const st = g.stock?.status; if (!['OUT_OF_STOCK', 'LOW'].includes(st) || g.active === 0) continue;
    const out0 = st === 'OUT_OF_STOCK'; const cur = g.stock.current;
    out.push({ key: `stock:${g.key}`, type: 'STOCK', category: 'MIX', priority: out0 ? 'HIGH' : 'MED', title: out0 ? `«${clean(g.name)}» المخزون خلص والإعلان شغّال` : `«${clean(g.name)}» المخزون قرب يخلص`,
      why: out0 ? `«${clean(g.name)}» مفيهوش مخزون وفيه ${g.active} ${g.active === 1 ? 'حملة' : 'حملات'} لسه بتصرف، يعني أوردرات ممكن تتسجّل ومفيش بضاعة تتبعت.` : `«${clean(g.name)}» فاضل منه ${cur != null ? n0(cur) + ' قطعة' : 'كمية قليلة'} وإحنا بنصرف عليه. لازم نعرف نكمّل ولا نهدّي.`,
      steps: out0 ? [`وقّف حملات «${clean(g.name)}» دلوقتي.`, 'بلّغ المدير أو المخزن إن المنتج خلص.', 'ارجع شغّلها أول ما البضاعة توصل.'] : ['اسأل المخزن إيه هيوصل ومتى.', 'ماتزوّدش ميزانية المنتج ده لحد ما الكمية تتأكد.', 'لو الكمية مش كفاية لبكرة، قلّل الميزانية.'],
      facts: [{ l: 'المخزون', v: cur != null ? String(n0(cur)) : '—' }, { l: 'حملات شغّالة', v: String(g.active) }, { l: 'صرف النهارده', v: egp(g.spendToday) }], product: { id: g.productId, name: clean(g.name) }, link: { page: 'inventory.html', label: 'افتح المخزون' }, action: out0 ? 'وقّف الحملات' : 'راجع الكمية' });
  }
  for (const f of funds) out.push({ key: `funds:${f.id}`, type: 'FUNDS', category: 'MIX', priority: 'HIGH', title: `الرصيد قليل في حساب ${clean(f.name)}`, why: `رصيد حساب ${clean(f.name)} بقى ${f.balanceText || 'قليل'} وممكن الإعلانات تقف في أي وقت.`, steps: ['بلّغ المدير يشحن الرصيد.', 'راقب الحسابات الباقية.'], facts: [], product: null, accountId: f.accountId || null, link: { page: 'ai-media-buyer.html', label: 'افتح AI Media Buyer' }, action: 'اشحن الرصيد' });
  const byAction = new Map();
  for (const g of groups.values()) for (const d of g.decisions) { const k = d.action; if (!byAction.has(k)) byAction.set(k, []); byAction.get(k).push(d); }
  for (const [action, list] of byAction) {
    const meta = DECISION_AR[action] || [String(action), `راجع قرارات ${action}`, `AI Operator جهّز قرارات ${action}`]; const names = [...new Set(list.map((d) => clean(d.productName || d.campaignName)))].filter(Boolean);
    out.push({ key: `dec:${action}`, type: 'DECISIONS', category: 'MIX', priority: action === 'PAUSE' ? 'HIGH' : 'MED', title: `${meta[2]} (${list.length})`, why: `${meta[2]} على ${list.length} ${list.length === 1 ? 'حملة' : 'حملة'}${names.length ? `: ${names.slice(0, 4).join('، ')}${names.length > 4 ? ` و${names.length - 4} كمان` : ''}` : ''}. القرارات مستنية مراجعتك.`,
      steps: ['افتح مركز الموافقات.', 'راجع كل قرار: الرقم قبل وبعد والسبب.', 'اعتمد اللي مقتنع بيه وارفض الباقي.'], facts: [{ l: 'قرارات', v: String(list.length) }], product: null, link: { page: 'ai-media-buyer.html', label: 'افتح مركز الموافقات' }, action: meta[1] });
  }
  for (const b of batches) out.push({ key: `clone:${b.batch_id}`, type: 'CLONE', category: 'MIX', priority: 'HIGH', title: `عملية اسكيل واقفة في حساب ${clean(b.source_ad_account_name) || 'مجهول'} ومحتاجة منك حاجة`, why: `${b.status === 'NEEDS_INPUT' ? 'الدفعة واقفة عشان ناقصها بيانات (غالبًا لينك الإعلان).' : 'الدفعة فشلت.'} ${b.error ? clean(b.error).slice(0, 160) : ''}`.trim(), steps: ['افتح «استنساخ وجدولة» وشوف الدفعة.', 'كمّل الناقص واضغط «كمّل» (ماتعملش اسكيل جديد).'], facts: [{ l: 'نسخ', v: String(b.total_copies ?? '—') }], product: null, accountId: b.source_ad_account_id || null, link: { page: 'ai-media-buyer.html#clone', label: 'افتح الدفعات' }, action: 'كمّل الدفعة' });
  for (const c of failedScales) out.push({ key: `scalefail:${c.sourceCampaignId}`, type: 'CLONE', category: 'MIX', priority: 'HIGH', title: `«${clean(c.displayName)}»: الاسكيل فشل — كمّله`, why: `${c.lastHint ? `${c.lastHint.title}. ${c.lastHint.action}` : clean(c.lastError) || 'راجع سبب الفشل.'}`, steps: ['افتح مركز التوسّع وشوف سبب الفشل.', 'اضغط «كمّل الناقص» بدل ما تعمل اسكيل من الأول.'], facts: [], product: { id: null, name: clean(c.displayName) }, campaignId: c.sourceCampaignId, link: { page: 'ai-media-buyer.html#scale', label: 'افتح مركز التوسّع' }, action: 'كمّل الاسكيل' });
  const n = (plan?.items || []).filter((i) => i.selected).length;
  if (plan && n) out.push({ key: `plan:OPEN:${plan.plan_date}`, type: 'OPEN_PLAN', category: 'MIX', priority: 'HIGH', title: `راجع خطة فتح الحملات (${n} حملة)`, why: `خطة فتح النهارده جاهزة فيها ${n} حملة. لازم تتراجع وتتعتمد قبل ميعادها.`, steps: ['افتح AI Operator ← فتح الحملات.', 'شيل أي حملة مش مقتنع بيها.', 'اعتمد الخطة.'], facts: [{ l: 'حملات', v: String(n) }], product: null, link: { page: 'ai-media-buyer.html', label: 'افتح AI Operator' }, action: 'راجع واعتمد' });
  return out;
}

/** Everything together. `src` = { rows, cards, funds, batches, plan, zeroLimit, minSpend }. Returns candidates + per-bucket counts. */
export function buildSmartCandidates(src, options = {}) {
  const o = { ...SMART_DEFAULTS, ...options }; const on = options.types || {}; const groups = groupByProduct(src.rows || []);
  const sc = on.SCALE === false ? { tasks: [], used: new Set() } : scaleTasks(groups, src.cards, o);
  const fx = fixTasks(groups, sc.used, o, { zeroLimit: src.zeroLimit || 150, minSpend: src.minSpend || 150 });
  const mix = mixTasks(groups, { funds: src.funds, batches: on.CLONE === false ? [] : src.batches, plan: on.OPEN_PLAN === false ? null : src.plan, failedScales: on.CLONE === false ? [] : (src.cards || []).filter((c) => c.decisionStatus === 'FAILED') });
  const all = [...sc.tasks, ...fx.fixes.filter((t) => on[t.type] !== false), ...(on.TEST === false ? [] : fx.tests), ...mix.filter((t) => on[t.type] !== false)];
  const filler = topUp(groups, all, o, Number(options.target) || 0).filter((t) => on[t.type] !== false);
  return { candidates: [...all, ...filler], groups: groups.size, natural: all.length, filler: filler.length };
}


// ───────────── top-up: reach «at least N tasks per person» with REAL work, never invented tasks ─────────────
// After the natural tasks, the day is filled — in the owner's proportions (50% scale / 25% fix+test / 25% mix) — with: a careful single scale for products that sell at a good cost but are not
// proven winners yet · a new test for any selling product with stock · a quick daily review of every other active product. If the data cannot fill it, the day simply stays shorter.
const pkeyOf = (t) => (/^(scale|fix|test|stock|scalelite|review):/.test(t.key || '') ? t.key.slice(t.key.indexOf(':') + 1) : null);

export function topUp(groups, natural, o, target) {
  if (!(target > 0)) return [];
  const have = (c) => natural.filter((t) => t.category === c).length; const total = natural.length; if (total >= target) return [];
  const scaleQ = Math.ceil(target * 0.5); const fixQ = Math.round(target * 0.25); const mixQ = Math.max(0, target - scaleQ - fixQ);
  const taken = new Set(natural.map(pkeyOf).filter(Boolean)); const keys = new Set(natural.map((t) => t.key));
  const takenForScale = new Set(natural.filter((t) => !String(t.key).startsWith('test:')).map(pkeyOf).filter(Boolean)); // a product that already has a natural TEST can still get a careful scale
  const eligible = [...groups.values()].filter((g) => !taken.has(g.key) && g.active > 0);
  const eligibleScale = [...groups.values()].filter((g) => !takenForScale.has(g.key) && g.active > 0);
  const okStock = (g) => stockKnownOk(g.stock, o.minTestStock); const bad = (g) => g.hard || g.reduce;
  const pools = {
    SCALE: eligibleScale.filter((g) => okStock(g) && !bad(g) && g.orders3 >= 3 && g.cpa3 != null && g.cpa3 <= (g.reduceLimit || o.liteCpa)).sort((a, b) => b.orders3 - a.orders3).map((g) => liteScale(g, o)),
    FIX: eligible.filter((g) => okStock(g) && !bad(g) && g.orders3 >= 1).sort((a, b) => b.orders3 - a.orders3).map((g) => liteTest(g, o)),
    MIX: eligible.filter((g) => g.spend3 > 0 || g.orders3 > 0).sort((a, b) => b.spend3 - a.spend3).map((g) => reviewTask(g)),
  };
  const out = []; const usedProducts = new Set(); let need = target - total;
  const take = (bucket, n) => { let k = 0; for (const t of pools[bucket]) { if (k >= n || need <= 0) break; const pk = pkeyOf(t); if (usedProducts.has(pk) || keys.has(t.key)) continue; usedProducts.add(pk); out.push({ ...t, filler: true }); k++; need--; } };
  take('SCALE', Math.max(0, scaleQ - have('SCALE'))); take('FIX', Math.max(0, fixQ - have('FIX'))); take('MIX', Math.max(0, mixQ - have('MIX')));
  for (const b of ['FIX', 'MIX', 'SCALE']) take(b, need); // still short → whatever real work is left, in this order
  return out;
}

function liteScale(g, o) {
  const name = clean(g.name); const plan = [{ mode: 'ABO', budget: o.scaleBudget }];
  return { key: `scalelite:${g.key}`, type: 'SCALE', category: 'SCALE', priority: 'MED', title: `اسكيل بحذر «${name}» — ABO بـ${n0(o.scaleBudget)} ج`,
    why: `«${name}» جاب ${g.orders3} أوردر في آخر 3 أيام بتكلفة ${n0(g.cpa3)} ج للأوردر. التكلفة كويسة، بس لسه مش رابح مؤكد، فنجرّب اسكيل واحد بحذر ونشوف.`,
    steps: ['افتح «مركز التوسّع» وخد أحسن حملة للمنتج كأساس.', `اعمل اسكيل واحد ABO بميزانية ${n0(o.scaleBudget)} ج.`, 'راقبه 48 ساعة قبل أي زيادة.', 'اكتب في الملاحظة اللي عملته.'],
    plan, facts: [{ l: 'أوردرات آخر 3 أيام', v: String(g.orders3) }, { l: 'تكلفة الأوردر', v: egp(g.cpa3) }, ...(stockPhrase(g.stock) ? [{ l: 'المخزون', v: stockPhrase(g.stock).replace(' في المخزون', '') }] : [])],
    product: { id: g.productId, name }, link: { page: 'ai-media-buyer.html#scale', label: 'افتح مركز التوسّع' }, action: 'اسكيل بحذر' };
}
function liteTest(g, o) {
  const name = clean(g.name); const stock = stockPhrase(g.stock);
  return { key: `test:${g.key}`, type: 'TEST', category: 'FIX', priority: 'LOW', title: `«${name}» — اعمله تيست جديد`,
    why: `«${name}» جاب ${g.orders3} ${g.orders3 === 1 ? 'أوردر' : 'أوردر'} في آخر 3 أيام${g.cpa3 != null ? ` بتكلفة ${n0(g.cpa3)} ج` : ''}${stock ? `، وعنده ${stock.replace(' في المخزون', '')} في المخزون` : ''}. فيه مجال نزوّد أوردراته بكرياتيف جديد.`,
    steps: ['اعمل تيست جديد بكرياتيف مختلف (زاوية أو فيديو جديد) وسيب القديم شغّال.', `ابدأ بميزانية صغيرة (حوالي ${egp(200)}) وراقبه 48 ساعة.`, 'اكتب في الملاحظة إيه الكرياتيف الجديد.'],
    facts: [{ l: 'أوردرات آخر 3 أيام', v: String(g.orders3) }, ...(g.cpa3 != null ? [{ l: 'التكلفة', v: egp(g.cpa3) }] : []), ...(stock ? [{ l: 'المخزون', v: stock.replace(' في المخزون', '') }] : [])],
    product: { id: g.productId, name }, link: { page: 'creative-factory.html', label: 'افتح مصنع الكرياتيفات' }, action: 'تيست جديد' };
}
function reviewTask(g) {
  const name = clean(g.name);
  return { key: `review:${g.key}`, type: 'REVIEW', category: 'MIX', priority: 'LOW', title: `راجع أداء «${name}» النهارده`,
    why: `«${name}» صرف ${egp(g.spend3)} في آخر 3 أيام وجاب ${g.orders3} ${g.orders3 === 1 ? 'أوردر' : 'أوردر'}${g.cpa3 != null ? ` بتكلفة ${n0(g.cpa3)} ج` : ''}. فحص سريع كل يوم عشان نمسك أي مشكلة بدري.`,
    steps: ['قارن صرف وأوردرات النهارده بإمبارح.', 'لو الـ Frequency عالي أو الـ CTR نازل، جهّز كرياتيف جديد.', 'لو كل حاجة تمام سيبه واكتب في الملاحظة «تمام».'],
    facts: [{ l: 'صرف آخر 3 أيام', v: egp(g.spend3) }, { l: 'أوردرات', v: String(g.orders3) }], product: { id: g.productId, name }, link: { page: 'ai-media-buyer.html', label: 'افتح AI Media Buyer' }, action: 'فحص سريع' };
}
