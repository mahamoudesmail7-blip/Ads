// 🧠 Daily Tasks — the SMART builder. Turns what the system already knows (campaign rows with stock / winner / CPA-vs-limits / pending AI-Operator decisions, scale-winner cards, ad-account funds,
// stuck clone batches, today's open plan) into tasks a media buyer can read once and act on. Three buckets, as the owner asked:
//   SCALE — products that are working (ONE task per product: «اسكيل ب500 ABO + 500 CBO» or four 500s when the cost per order is excellent)
//   FIX   — products that HAVE stock but do not sell (spend with no orders / CPA above the limit) + products that sell and have stock → a NEW TEST to raise orders
//   MIX   — everything else: stock running out, low funds, AI-Operator decisions waiting, stuck clone batches, the open plan, routines, manual tasks
// ACCURACY RULES (every number a buyer reads must be real):
//   · «orders» are Meta PURCHASES (the same number the campaigns board shows) — the text says «حسب Meta», never a bare «أوردر» that could be mistaken for confirmed store orders.
//   · an unknown number is never a zero: a campaign whose orders are missing (null) can never produce «بيصرف ومبيجيبش» — the claim needs every active campaign's orders to be KNOWN.
//   · «المشكلة مش في الكمية» is only said when the stock is actually known; otherwise the task says the stock is unknown.
//   · a campaign that is not linked to a product is shown as the CAMPAIGN (exact name) — never merged into a product by name guessing.
//   · only decisions that really wait for a review (status PREPARED) are called «مستنية موافقتك».
//   · every task carries its source window + data time (meta) so the screen can say where the numbers come from.
// Pure: no database, no network, no clock.

export const BUCKET_LABEL = { SCALE: 'اسكيل المنتجات الرابحة', FIX: 'حل مشاكل وتيست جديد', MIX: 'شغل متنوّع' };
export const BUCKET_ICON = { SCALE: '🚀', FIX: '🔧', MIX: '🧩' };
export const SMART_DEFAULTS = { scaleBudget: 500, strongCpa: 50, strongScales: 4, normalScales: 2, testMinOrders: 2, minTestStock: 30, testMaxCampaigns: 2, maxTest: 8, maxFix: 20, liteCpa: 100 };

const n0 = (v) => Math.round(Number(v) || 0);
const egp = (v) => `${n0(v).toLocaleString('en-US')} ج`;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const known = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

/** «350 قطعة» / «المخزون خلص» — null when nothing is known. */
export function stockPhrase(stock) {
  if (!stock || stock.status === 'STOCK_UNKNOWN') return known(stock?.current) ? `${n0(stock.current)} قطعة في المخزون` : null;
  if (stock.status === 'OUT_OF_STOCK') return 'المخزون خلص';
  if (known(stock.current) && Number(stock.current) >= 0) return `${n0(stock.current)} قطعة في المخزون`;
  if (stock.status === 'LOW') return 'المخزون قليل';
  if (stock.status === 'OK') return 'المخزون متاح';
  return null;
}
const stockShort = (stock) => { const p = stockPhrase(stock); return p ? p.replace(' في المخزون', '') : null; };
/** The stock is really known to be available (a number > 0, or the inventory says OK / LOW). */
const stockAvailable = (stock) => !!stock && stock.status !== 'OUT_OF_STOCK' && stock.status !== 'STOCK_UNKNOWN' && ((known(stock.current) && Number(stock.current) > 0) || ['OK', 'LOW'].includes(stock.status));
const stockKnownOk = (stock, min) => stockAvailable(stock) && (stock.status === 'OK' || (known(stock.current) && Number(stock.current) >= min));

/**
 * Rows (campaign level) → groups with the numbers the tasks need. A campaign linked to a product joins that product's group; a campaign that is NOT linked stays its own group named by its exact
 * name (no name-family guessing). Orders that are unknown (null) are tracked, never turned into zero.
 */
export function groupByProduct(rows) {
  const g = new Map();
  for (const r of rows || []) {
    const linked = r.productId != null;
    const key = linked ? `p:${r.productId}` : `c:${r.campaignId}`;
    const cur = g.get(key) || { key, linked, productId: r.productId ?? null, name: linked ? (r.productName || r.name) : r.name, campaigns: [], active: 0, spendToday: 0, ordersToday: 0, todayKnown: true, spend3: 0, orders3: 0, n3Known: true, stock: null, winner: false, decisions: [], reduceLimit: null, asOf: null };
    cur.campaigns.push(r);
    const isActive = r.status === 'ACTIVE' && r.dataFresh !== false;
    if (isActive) { cur.active += 1; if (!known(r.today?.orders)) cur.todayKnown = false; }
    cur.spendToday += Number(r.today?.spend) || 0; if (known(r.today?.orders)) cur.ordersToday += Number(r.today.orders);
    const sp = Number(r.period?.spend) || 0; cur.spend3 += sp; if (known(r.period?.orders)) cur.orders3 += Number(r.period.orders); else if (sp > 0) cur.n3Known = false;
    if (r.stock && (!cur.stock || cur.stock.status === 'STOCK_UNKNOWN')) cur.stock = r.stock;
    const rl = Number(r.limits?.reduce) || Number(r.limits?.hardStop) || 0; if (rl) cur.reduceLimit = cur.reduceLimit ? Math.min(cur.reduceLimit, rl) : rl;
    if (r.winner?.status === 'WINNER') cur.winner = true;
    if (r.pendingDecision && r.pendingDecision.status === 'PREPARED') cur.decisions.push({ ...r.pendingDecision, campaignName: r.name, productName: r.productName });
    if (r.lastSeenAt && (!cur.asOf || r.lastSeenAt > cur.asOf)) cur.asOf = r.lastSeenAt;
    g.set(key, cur);
  }
  for (const x of g.values()) x.cpa3 = x.n3Known && x.orders3 > 0 ? x.spend3 / x.orders3 : null;
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
  const cardBy = new Map(); // group key -> best pending card
  for (const c of cards || []) {
    if (c.decisionStatus !== 'PENDING') continue;
    let key = null; for (const [k, g] of groups) if (g.campaigns.some((r) => r.campaignId === c.sourceCampaignId)) { key = k; break; }
    key = key || `c:${c.sourceCampaignId}`;
    const cur = cardBy.get(key); if (!cur || (c.orders || 0) > (cur.orders || 0)) cardBy.set(key, c);
  }
  const keys = new Set([...cardBy.keys(), ...[...groups.values()].filter((g) => g.winner).map((g) => g.key)]);
  for (const key of keys) {
    const g = groups.get(key); const card = cardBy.get(key);
    if (g?.stock?.status === 'OUT_OF_STOCK') continue; // never scale what cannot be shipped (the stock task covers it)
    // the campaign the scale is based on: the one the winner card names, else the best winner campaign of the product
    let row = card && g ? g.campaigns.find((r) => r.campaignId === card.sourceCampaignId) : null;
    if (!row && g) row = g.campaigns.filter((r) => r.winner?.status === 'WINNER').sort((a, b) => (Number(a.cpa?.d7) || 1e9) - (Number(b.cpa?.d7) || 1e9))[0] || null;
    const name = clean(g ? g.name : (card?.productName || card?.displayName)); if (!name) continue;
    const campName = clean(row?.name || card?.sourceCampaignName);
    const orders = known(row?.period?.orders) ? Number(row.period.orders) : (known(card?.orders) ? Number(card.orders) : null);
    const spend = known(row?.period?.spend) ? Number(row.period.spend) : (known(card?.spend) ? Number(card.spend) : null);
    const cpa3 = known(row?.period?.cpa) ? Number(row.period.cpa) : (known(card?.cpa) ? Number(card.cpa) : null);
    const cpa7 = known(row?.cpa?.d7) && Number(row.cpa.d7) > 0 ? Number(row.cpa.d7) : null;
    const worst = [cpa3, cpa7].filter((x) => x != null); const cpaForPlan = worst.length ? Math.max(...worst) : null; // judged on the WORSE of the two windows, never the flattering one
    const { strong, plan } = scalePlan(cpaForPlan, o);
    const stockTxt = stockShort(g?.stock); const lowStock = g?.stock?.status === 'LOW';
    const isWinner = row?.winner?.status === 'WINNER';
    out.push({
      key: `scale:${key}`, type: 'SCALE', category: 'SCALE', priority: strong ? 'HIGH' : 'MED',
      title: strong ? `اسكيل «${name}» — ${plan.length} اسكيلات، كل واحد ${n0(o.scaleBudget)} ج` : `اسكيل «${name}» — ABO بـ${n0(o.scaleBudget)} ج و CBO بـ${n0(o.scaleBudget)} ج`,
      why: `${campName ? `حملة «${campName}»` : `«${name}»`} ${orders != null ? `جابت ${orders} أوردر (حسب Meta)` : 'ماشية حلو'}${cpa3 != null ? ` بتكلفة ${n0(cpa3)} ج للأوردر في آخر 3 أيام` : ''}${cpa7 != null ? `${cpa3 != null ? '، و' : ' بتكلفة '}${n0(cpa7)} ج في آخر 7 أيام` : ''}.${isWinner ? ' السيستم مصنّفها «رابحة».' : ' مؤهلة للاسكيل في مركز التوسّع.'}${strong ? ' التكلفة ممتازة في الفترتين، فنكبّر بقوة.' : ''}${lowStock ? ` خد بالك: المخزون قليل (${stockTxt}).` : ''}`,
      steps: [
        `افتح «مركز التوسّع» وخد ${campName ? `حملة «${campName}»` : 'أحسن حملة للمنتج'} كأساس.`,
        ...plan.map((p, i) => `اعمل اسكيل ${i + 1}: ${p.mode} بميزانية ${n0(p.budget)} ج${p.mode === 'ABO' ? ' (الميزانية على الـ Ad Set)' : ' (الميزانية على الحملة)'}.`),
        'استخدم الكرياتيفات الرابحة بس، وماتكرّرش اسكيل اتعمل قبل كده.',
        'لما تخلّص اضغط «تمّت» واكتب في الملاحظة أرقام الاسكيلات.',
      ],
      plan, facts: [...(orders != null ? [{ l: 'أوردرات Meta (3 أيام)', v: String(orders) }] : []), ...(cpa3 != null ? [{ l: 'تكلفة الأوردر (3 أيام)', v: egp(cpa3) }] : []), ...(cpa7 != null ? [{ l: 'تكلفة الأوردر (7 أيام)', v: egp(cpa7) }] : []), ...(spend != null ? [{ l: 'صرف (3 أيام)', v: egp(spend) }] : []), ...(stockTxt ? [{ l: 'المخزون', v: stockTxt }] : [])],
      product: { id: g?.productId ?? null, name }, campaignId: row?.campaignId || card?.sourceCampaignId || null, accountId: card?.adAccountId || row?.adAccountId || null,
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
    const active = g.campaigns.filter((r) => r.status === 'ACTIVE' && r.dataFresh !== false);
    // CPA above the limit — judged per CAMPAIGN on its own last-3-days numbers (the same rule as the alerts center), then reported for the worst one
    const over = active.map((r) => { const vs = r.cpaVsLimits; const lim = vs === 'ABOVE_HARDSTOP' ? Number(r.limits?.hardStop) : vs === 'ABOVE_REDUCE' ? Number(r.limits?.reduce) : 0; const cpa = Number(r.period?.cpa) || 0; return { r, hard: vs === 'ABOVE_HARDSTOP', lim, cpa }; })
      .filter((x) => x.lim > 0 && x.cpa >= x.lim * 1.1 && (Number(x.r.period?.spend) || 0) >= minSpend).sort((a, b) => b.cpa / b.lim - a.cpa / a.lim);
    const zeroToday = active.length > 0 && g.todayKnown && g.ordersToday === 0 && g.spendToday > zeroLimit;
    const zero3 = active.length > 0 && g.n3Known && g.orders3 === 0 && g.spend3 >= zeroLimit * 2;
    if (!zeroToday && !zero3 && !over.length) continue;
    const available = stockAvailable(g.stock); const stockTxt = stockShort(g.stock);
    const zero = zeroToday || zero3; const name = clean(g.name);
    const worst = over[0]; const hardOrBig = over.some((x) => x.hard) || (zeroToday && g.spendToday >= zeroLimit * 2) || (zero3 && g.spend3 >= zeroLimit * 4);
    const stockLine = available ? `${stockTxt ? ` والمنتج عنده ${stockTxt} في المخزون` : ''}` : '';
    fixes.push({
      key: `fix:${g.key}`, type: zero ? 'ZERO_ORDERS' : 'CPA', category: 'FIX', priority: hardOrBig ? 'HIGH' : 'MED', weightHint: zero ? g.spendToday || g.spend3 : g.spend3,
      title: zero ? `«${name}» بيصرف ومبيجيبش أوردرات` : `«${name}» تكلفة الأوردر عالية`,
      why: zero
        ? `${g.linked ? `«${name}»` : `حملة «${name}»`} ${zeroToday ? `صرف ${egp(g.spendToday)} النهارده من غير ولا أوردر (حسب Meta)` : `صرف ${egp(g.spend3)} في آخر 3 أيام من غير ولا أوردر (حسب Meta)`}${stockLine}. ${available ? 'يعني المشكلة مش في الكمية، لازم نعرف ليه مبيطلعش.' : 'مخزون المنتج مش معروف في السيستم، اتأكد منه الأول.'}`
        : `حملة «${clean(worst.r.name)}» تكلفة الأوردر فيها ${n0(worst.cpa)} ج في آخر 3 أيام، وده فوق ${worst.hard ? 'حد الإيقاف' : 'حد التخفيض'} (${n0(worst.lim)} ج) وهي لسه شغّالة${over.length > 1 ? ` — وفيه ${over.length - 1} ${over.length - 1 === 1 ? 'حملة تانية' : 'حملات تانية'} فوق الحد كمان` : ''}${stockLine}.`,
      steps: zero ? [
        `افتح حملات «${name}» وشوف الكرياتيف: الـ Hook في أول 3 ثواني والـ CTR.`,
        `لو الحملة صرفت فوق ${egp(zeroLimit)} من غير أوردر، وقّفها (أو قلّل ميزانيتها للنص على الأقل).`,
        `جرّب كرياتيف أو جمهور جديد بميزانية صغيرة (حوالي ${egp(200)}) بدل ما تكمّل على اللي مش شغّال.`,
        'اكتب في الملاحظة إيه اللي عملته (وقفت / غيّرت كرياتيف / جمهور جديد).',
      ] : [
        `افتح حملات «${name}» وابدأ بالأعلى تكلفة: ${over.slice(0, 3).map((x) => `«${clean(x.r.name)}» (${n0(x.cpa)} ج)`).join('، ')}.`,
        over.some((x) => x.hard) ? 'وقّف الحملات اللي فوق حد الإيقاف، أو قلّل ميزانيتها بشكل واضح.' : 'قلّل ميزانية الحملات اللي فوق حد التخفيض وراقبها بكرة.',
        'خلّي الحملات الأحسن شغّالة ومتلمسهاش.',
        'اكتب في الملاحظة إيه اللي عملته.',
      ],
      facts: zero
        ? [...(zeroToday ? [{ l: 'صرف النهارده', v: egp(g.spendToday) }] : []), { l: 'صرف (3 أيام)', v: egp(g.spend3) }, { l: 'أوردرات Meta (3 أيام)', v: String(g.orders3) }, { l: 'المخزون', v: stockTxt || 'غير معروف' }]
        : [{ l: 'تكلفة الأوردر (3 أيام)', v: egp(worst.cpa) }, { l: worst.hard ? 'حد الإيقاف' : 'حد التخفيض', v: egp(worst.lim) }, { l: 'صرف الحملة (3 أيام)', v: egp(worst.r.period?.spend) }, { l: 'أوردرات Meta (3 أيام)', v: String(worst.r.period?.orders ?? '—') }, ...(stockTxt ? [{ l: 'المخزون', v: stockTxt }] : [])],
      product: { id: g.productId, name }, campaignId: worst?.r.campaignId || null, link: { page: 'ai-media-buyer.html', label: 'افتح AI Media Buyer' }, action: zero ? 'افحص أو وقّف' : 'قلّل أو وقّف',
    });
    fixKeys.add(g.key);
  }
  fixes.sort((a, b) => (b.priority === 'HIGH') - (a.priority === 'HIGH') || (b.weightHint || 0) - (a.weightHint || 0));
  const tests = [];
  for (const g of groups.values()) {
    if (scaleKeys.has(g.key) || fixKeys.has(g.key) || g.winner) continue;
    const active = g.campaigns.filter((r) => r.status === 'ACTIVE' && r.dataFresh !== false);
    if (!g.n3Known || g.orders3 < o.testMinOrders || active.length === 0 || active.length > o.testMaxCampaigns || !stockKnownOk(g.stock, o.minTestStock)) continue;
    if (active.some((r) => r.cpaVsLimits === 'ABOVE_HARDSTOP' || r.cpaVsLimits === 'ABOVE_REDUCE')) continue;
    tests.push(testTask(g, o, 'MED', g.orders3));
  }
  tests.sort((a, b) => b.weightHint - a.weightHint);
  return { fixes: fixes.slice(0, o.maxFix), tests: tests.slice(0, o.maxTest) };
}

function testTask(g, o, priority, weightHint) {
  const name = clean(g.name); const stockTxt = stockShort(g.stock);
  return {
    key: `test:${g.key}`, type: 'TEST', category: 'FIX', priority, weightHint,
    title: `«${name}» بيطلع أوردرات — اعمله تيست جديد`,
    why: `${g.linked ? `«${name}»` : `حملة «${name}»`} جاب ${g.orders3} أوردر (حسب Meta) في آخر 3 أيام${g.cpa3 != null ? ` بتكلفة ${n0(g.cpa3)} ج` : ''}، وعنده ${stockTxt} في المخزون. فيه كمية تستحمل نزوّد أوردراته، فنجرّب كرياتيف جديد.`,
    steps: [
      'اعمل تيست جديد بكرياتيف مختلف تمامًا (زاوية أو فيديو جديد) وسيب القديم شغّال زي ما هو.',
      `ابدأ بميزانية صغيرة (حوالي ${egp(200)}) وراقبه 48 ساعة.`,
      'لو جاب أوردرات بتكلفة كويسة، يبقى مرشّح للاسكيل في تاسكات الأيام الجاية.',
      'اكتب في الملاحظة إيه الكرياتيف الجديد.',
    ],
    facts: [{ l: 'أوردرات Meta (3 أيام)', v: String(g.orders3) }, ...(g.cpa3 != null ? [{ l: 'تكلفة الأوردر (3 أيام)', v: egp(g.cpa3) }] : []), { l: 'المخزون', v: stockTxt }],
    product: { id: g.productId, name }, link: { page: 'creative-factory.html', label: 'افتح مصنع الكرياتيفات' }, action: 'تيست جديد',
  };
}

// ───────────── MIX ─────────────
const DECISION_AR = { PAUSE: ['إيقاف', 'راجع واعتمد قرارات الإيقاف', 'AI Operator رشّح إيقاف'], OPEN: ['فتح', 'راجع واعتمد قرارات الفتح', 'AI Operator جهّز فتح'], SCALE_UP: ['زيادة ميزانية', 'راجع واعتمد زيادات الميزانية', 'AI Operator اقترح زيادة ميزانية'], SCALE_DOWN: ['تخفيض ميزانية', 'راجع واعتمد تخفيضات الميزانية', 'AI Operator اقترح تخفيض ميزانية'] };

export function mixTasks(groups, { funds = [], batches = [], plan = null, failedScales = [] } = {}) {
  const out = [];
  for (const g of groups.values()) {
    const st = g.stock?.status; const active = g.campaigns.filter((r) => r.status === 'ACTIVE' && r.dataFresh !== false).length;
    if (!['OUT_OF_STOCK', 'LOW'].includes(st) || active === 0) continue;
    const out0 = st === 'OUT_OF_STOCK'; const cur = known(g.stock.current) ? n0(g.stock.current) : null; const name = clean(g.name);
    out.push({ key: `stock:${g.key}`, type: 'STOCK', category: 'MIX', priority: out0 ? 'HIGH' : 'MED', title: out0 ? `«${name}» المخزون خلص والإعلان شغّال` : `«${name}» المخزون قرب يخلص`,
      why: out0 ? `«${name}» مفيهوش مخزون وفيه ${active} ${active === 1 ? 'حملة' : 'حملات'} لسه شغّالة، يعني أوردرات ممكن تتسجّل ومفيش بضاعة تتبعت.` : `«${name}» ${cur != null ? `فاضل منه ${cur} قطعة` : 'مخزونه قليل'} وإحنا بنصرف عليه. لازم نعرف نكمّل ولا نهدّي.`,
      steps: out0 ? [`وقّف حملات «${name}» دلوقتي.`, 'بلّغ المدير أو المخزن إن المنتج خلص.', 'ارجع شغّلها أول ما البضاعة توصل.'] : ['اسأل المخزن إيه هيوصل ومتى.', 'ماتزوّدش ميزانية المنتج ده لحد ما الكمية تتأكد.', 'لو الكمية مش كفاية لبكرة، قلّل الميزانية.'],
      facts: [{ l: 'المخزون', v: cur != null ? String(cur) : 'غير معروف' }, { l: 'حملات شغّالة', v: String(active) }, { l: 'صرف النهارده', v: egp(g.spendToday) }], product: { id: g.productId, name }, link: { page: 'inventory.html', label: 'افتح المخزون' }, action: out0 ? 'وقّف الحملات' : 'راجع الكمية' });
  }
  for (const f of funds) out.push({ key: `funds:${f.id}`, type: 'FUNDS', category: 'MIX', priority: 'HIGH', title: `الرصيد قليل في حساب ${clean(f.name)}`, why: `رصيد حساب ${clean(f.name)} ${f.balanceText ? `بقى ${f.balanceText}` : 'قليل'} وممكن الإعلانات تقف في أي وقت.`, steps: ['بلّغ المدير يشحن الرصيد.', 'راقب الحسابات الباقية.'], facts: f.balanceText ? [{ l: 'الرصيد المتاح', v: f.balanceText }] : [], product: null, accountId: f.accountId || null, link: { page: 'ai-media-buyer.html', label: 'افتح AI Media Buyer' }, action: 'اشحن الرصيد' });
  const byAction = new Map();
  for (const g of groups.values()) for (const d of g.decisions) { if (!byAction.has(d.action)) byAction.set(d.action, []); byAction.get(d.action).push(d); }
  for (const [action, list] of byAction) {
    const meta = DECISION_AR[action] || [String(action), `راجع قرارات ${action}`, `AI Operator جهّز قرارات ${action}`]; const names = [...new Set(list.map((d) => clean(d.productName || d.campaignName)))].filter(Boolean);
    out.push({ key: `dec:${action}`, type: 'DECISIONS', category: 'MIX', priority: action === 'PAUSE' ? 'HIGH' : 'MED', title: `${meta[2]} (${list.length})`, why: `${meta[2]} على ${list.length} حملة${names.length ? `: ${names.slice(0, 4).join('، ')}${names.length > 4 ? ` و${names.length - 4} كمان` : ''}` : ''}. القرارات جاهزة ومستنية مراجعتك.`,
      steps: ['افتح مركز الموافقات.', 'راجع كل قرار: الرقم قبل وبعد والسبب.', 'اعتمد اللي مقتنع بيه وارفض الباقي.'], facts: [{ l: 'قرارات مستنية', v: String(list.length) }], product: null, link: { page: 'ai-media-buyer.html', label: 'افتح مركز الموافقات' }, action: meta[1] });
  }
  for (const b of batches) out.push({ key: `clone:${b.batch_id}`, type: 'CLONE', category: 'MIX', priority: 'HIGH', title: `عملية اسكيل واقفة في حساب ${clean(b.source_ad_account_name) || 'مجهول'} ومحتاجة منك حاجة`, why: `${b.status === 'NEEDS_INPUT' ? 'الدفعة واقفة عشان ناقصها بيانات (غالبًا لينك الإعلان).' : 'الدفعة فشلت.'} ${b.error ? clean(b.error).slice(0, 160) : ''}`.trim(), steps: ['افتح «استنساخ وجدولة» وشوف الدفعة.', 'كمّل الناقص واضغط «كمّل» (ماتعملش اسكيل جديد).'], facts: [{ l: 'نسخ', v: String(b.total_copies ?? '—') }], product: null, accountId: b.source_ad_account_id || null, link: { page: 'ai-media-buyer.html#clone', label: 'افتح الدفعات' }, action: 'كمّل الدفعة' });
  for (const c of failedScales) out.push({ key: `scalefail:${c.sourceCampaignId}`, type: 'CLONE', category: 'MIX', priority: 'HIGH', title: `«${clean(c.displayName)}»: الاسكيل فشل — كمّله`, why: `${c.lastHint ? `${c.lastHint.title}. ${c.lastHint.action}` : clean(c.lastError) || 'راجع سبب الفشل.'}`, steps: ['افتح مركز التوسّع وشوف سبب الفشل.', 'اضغط «كمّل الناقص» بدل ما تعمل اسكيل من الأول.'], facts: [], product: { id: null, name: clean(c.displayName) }, campaignId: c.sourceCampaignId, link: { page: 'ai-media-buyer.html#scale', label: 'افتح مركز التوسّع' }, action: 'كمّل الاسكيل' });
  const n = (plan?.items || []).filter((i) => i.selected).length;
  if (plan && n && plan.status !== 'APPROVED') out.push({ key: `plan:OPEN:${plan.plan_date}`, type: 'OPEN_PLAN', category: 'MIX', priority: 'HIGH', title: `راجع خطة فتح الحملات (${n} حملة)`, why: `خطة فتح النهارده جاهزة فيها ${n} حملة ومستنية مراجعتك واعتمادك قبل ميعادها.`, steps: ['افتح AI Operator ← فتح الحملات.', 'شيل أي حملة مش مقتنع بيها.', 'اعتمد الخطة.'], facts: [{ l: 'حملات', v: String(n) }], product: null, link: { page: 'ai-media-buyer.html', label: 'افتح AI Operator' }, action: 'راجع واعتمد' });
  return out;
}

// ───────────── top-up: reach «at least N tasks per person» with REAL work, never invented tasks ─────────────
// After the natural tasks, the day is filled — in the owner's proportions (50% scale / 25% fix+test / 25% mix) — with: a careful single scale for products that sell at a good cost but are not
// proven winners yet · a new test for any selling product with stock · a quick daily review of every other active product. If the data cannot fill it, the day simply stays shorter.
const pkeyOf = (t) => (/^(scale|fix|test|stock|scalelite|review):/.test(t.key || '') ? t.key.slice(t.key.indexOf(':') + 1) : null);

export const kindOfTask = (t) => (t.type === 'SCALE' ? 'SCALE' : t.type === 'ZERO_ORDERS' || t.type === 'CPA' ? 'PROBLEM' : t.type === 'TEST' ? 'TEST' : 'MIX');

/**
 * Per-kind MINIMUMS (owner's rule: every media buyer gets at least N scale / N problem / N test / N mix tasks, evenly). `totals` = { SCALE, PROBLEM, TEST, MIX } = quota × people.
 * The natural tasks come first; what is still missing is filled with REAL work only:
 *   SCALE   — a careful single scale for products that sell at a good cost but are not proven winners (≥3 Meta orders), then a small «تجريبي» scale for anything that sells (≥1 order) within its CPA limit
 *   TEST    — a new test for every selling product that has stock
 *   MIX     — a quick daily review of the remaining active products
 *   PROBLEM — never invented: a problem exists or it does not. A shortfall stays visible instead.
 * Never two tasks of the same kind for one product.
 */
export function topUp(groups, natural, o, totals) {
  if (!totals) return [];
  const have = (k) => natural.filter((t) => kindOfTask(t) === k).length;
  const need = { SCALE: Math.max(0, (totals.SCALE || 0) - have('SCALE')), TEST: Math.max(0, (totals.TEST || 0) - have('TEST')), MIX: Math.max(0, (totals.MIX || 0) - have('MIX')) };
  if (!need.SCALE && !need.TEST && !need.MIX) return [];
  const keys = new Set(natural.map((t) => t.key)); const taken = new Set(natural.map(pkeyOf).filter(Boolean));
  const takenBy = (prefixes) => new Set(natural.filter((t) => prefixes.some((p) => String(t.key).startsWith(p))).map(pkeyOf).filter(Boolean));
  const activeOf = (g) => g.campaigns.filter((r) => r.status === 'ACTIVE' && r.dataFresh !== false);
  const okStock = (g) => stockKnownOk(g.stock, o.minTestStock); const bad = (g) => activeOf(g).some((r) => r.cpaVsLimits === 'ABOVE_HARDSTOP' || r.cpaVsLimits === 'ABOVE_REDUCE');
  const all = [...groups.values()].filter((g) => activeOf(g).length > 0);
  const out = []; const usedMix = new Set();
  const take = (list, n, used = new Set()) => { let k = 0; for (const t of list) { if (k >= n) break; const pk = pkeyOf(t); if (used.has(pk) || keys.has(t.key)) continue; used.add(pk); keys.add(t.key); out.push({ ...t, filler: true }); k++; } return k; };
  // TEST: every selling product with stock (a product with a natural test is skipped)
  const noTest = takenBy(['test:', 'fix:']);
  const testPool = all.filter((g) => !noTest.has(g.key) && okStock(g) && !bad(g) && g.n3Known && g.orders3 >= 1).sort((a, b) => b.orders3 - a.orders3).map((g) => ({ ...testTask(g, o, 'LOW', g.orders3), key: `test:${g.key}` }));
  const usedTest = new Set(); take(testPool, need.TEST, usedTest);
  // SCALE: tier 1 = careful (proven-ish), tier 2 = small experimental. A product that already has a natural scale / fix / stock task is skipped.
  const noScale = takenBy(['scale:', 'fix:', 'stock:']);
  const scaleBase = all.filter((g) => !noScale.has(g.key) && okStock(g) && !bad(g) && g.n3Known && g.cpa3 != null);
  const lim = (g) => g.reduceLimit || o.liteCpa;
  const tier1 = scaleBase.filter((g) => g.orders3 >= 3 && g.cpa3 <= lim(g)).sort((a, b) => b.orders3 - a.orders3).map((g) => liteScale(g, o));
  const tier2 = scaleBase.filter((g) => g.orders3 >= 1 && g.orders3 < 3 && g.cpa3 <= lim(g)).sort((a, b) => b.orders3 - a.orders3).map((g) => liteScale(g, o, true));
  const usedScale = new Set(); let got = take(tier1, need.SCALE, usedScale); if (got < need.SCALE) take(tier2, need.SCALE - got, usedScale);
  // MIX: a daily review for products that got no other task today
  const busy = new Set([...taken, ...out.map(pkeyOf).filter(Boolean)]);
  const reviewPool = all.filter((g) => !busy.has(g.key) && (g.spend3 > 0 || g.orders3 > 0)).sort((a, b) => b.spend3 - a.spend3).map((g) => reviewTask(g));
  take(reviewPool, need.MIX, usedMix);
  return out;
}

function liteScale(g, o, experimental = false) {
  const name = clean(g.name); const plan = [{ mode: 'ABO', budget: o.scaleBudget }]; const stockTxt = stockShort(g.stock);
  return { key: `scalelite:${g.key}`, type: 'SCALE', category: 'SCALE', priority: experimental ? 'LOW' : 'MED', title: experimental ? `اسكيل تجريبي «${name}» — ABO بـ${n0(o.scaleBudget)} ج` : `اسكيل بحذر «${name}» — ABO بـ${n0(o.scaleBudget)} ج`,
    why: experimental ? `${g.linked ? `«${name}»` : `حملة «${name}»`} جاب ${g.orders3} أوردر بس (حسب Meta) في آخر 3 أيام بتكلفة ${n0(g.cpa3)} ج للأوردر، وده تحت الحد. لسه بدري نحكم عليه، فنجرّب اسكيل واحد صغير ونتابعه.` : `${g.linked ? `«${name}»` : `حملة «${name}»`} جاب ${g.orders3} أوردر (حسب Meta) في آخر 3 أيام بتكلفة ${n0(g.cpa3)} ج للأوردر. التكلفة كويسة، بس لسه مش رابح مؤكد، فنجرّب اسكيل واحد بحذر ونشوف.`,
    steps: ['افتح «مركز التوسّع» وخد أحسن حملة للمنتج كأساس.', `اعمل اسكيل واحد ABO بميزانية ${n0(o.scaleBudget)} ج.`, 'راقبه 48 ساعة قبل أي زيادة.', 'اكتب في الملاحظة اللي عملته.'],
    plan, facts: [{ l: 'أوردرات Meta (3 أيام)', v: String(g.orders3) }, { l: 'تكلفة الأوردر (3 أيام)', v: egp(g.cpa3) }, ...(stockTxt ? [{ l: 'المخزون', v: stockTxt }] : [])],
    product: { id: g.productId, name }, link: { page: 'ai-media-buyer.html#scale', label: 'افتح مركز التوسّع' }, action: 'اسكيل بحذر' };
}
function reviewTask(g) {
  const name = clean(g.name); const ordersTxt = g.n3Known ? `${g.orders3} أوردر (حسب Meta)` : 'عدد أوردرات مش متاح';
  return { key: `review:${g.key}`, type: 'REVIEW', category: 'MIX', priority: 'LOW', title: `راجع أداء «${name}» النهارده`,
    why: `${g.linked ? `«${name}»` : `حملة «${name}»`} صرف ${egp(g.spend3)} في آخر 3 أيام وجاب ${ordersTxt}${g.cpa3 != null ? ` بتكلفة ${n0(g.cpa3)} ج للأوردر` : ''}. فحص سريع كل يوم عشان نمسك أي مشكلة بدري.`,
    steps: ['قارن صرف وأوردرات النهارده بإمبارح.', 'لو الـ Frequency عالي أو الـ CTR نازل، جهّز كرياتيف جديد.', 'لو كل حاجة تمام سيبه واكتب في الملاحظة «تمام».'],
    facts: [{ l: 'صرف (3 أيام)', v: egp(g.spend3) }, { l: 'أوردرات Meta (3 أيام)', v: g.n3Known ? String(g.orders3) : 'غير متاح' }], product: { id: g.productId, name }, link: { page: 'ai-media-buyer.html', label: 'افتح AI Media Buyer' }, action: 'فحص سريع' };
}

/** Everything together. `src` = { rows, cards, funds, batches, plan, zeroLimit, minSpend, period, asOf }. Returns candidates + counts. Every candidate carries `meta` (source window + data time). */
export function buildSmartCandidates(src, options = {}) {
  const totals = options.totals || null; // { SCALE, PROBLEM, TEST, MIX } = the per-person minimums × people
  const o = { ...SMART_DEFAULTS, ...options }; if (totals) { o.maxFix = Math.max(o.maxFix, totals.PROBLEM || 0); o.maxTest = Math.max(o.maxTest, totals.TEST || 0); } const on = options.types || {}; const groups = groupByProduct(src.rows || []);
  const sc = on.SCALE === false ? { tasks: [], used: new Set() } : scaleTasks(groups, src.cards, o);
  const fx = fixTasks(groups, sc.used, o, { zeroLimit: src.zeroLimit || 150, minSpend: src.minSpend || 150 });
  const mix = mixTasks(groups, { funds: src.funds, batches: on.CLONE === false ? [] : src.batches, plan: on.OPEN_PLAN === false ? null : src.plan, failedScales: on.CLONE === false ? [] : (src.cards || []).filter((c) => c.decisionStatus === 'FAILED') });
  const all = [...sc.tasks, ...fx.fixes.filter((t) => on[t.type] !== false), ...(on.TEST === false ? [] : fx.tests), ...mix.filter((t) => on[t.type] !== false)];
  const filler = topUp(groups, all, o, totals).filter((t) => on[t.type] !== false);
  const meta = { window: src.period || null, asOf: src.asOf || null, basis: 'مشتريات Meta' };
  return { candidates: [...all, ...filler].map((t) => ({ ...t, meta })), groups: groups.size, natural: all.length, filler: filler.length };
}
