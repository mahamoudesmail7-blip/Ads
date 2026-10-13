// opx2-campaigns.js — AI Operator V2 Campaign Center (read + bulk REVIEW + DRAFT creation through the existing plan engine — never approval or execution). ONE table for every campaign list: the six «views» are filters over the same server-side query.
// The browser never holds the campaign list — it asks the server for ONE page (/api/operator-v2/campaigns/query) and cancels a superseded request. «Select all N matching» uses a server-side snapshot.
// Nothing here writes to Meta or changes a policy. The review modal is a PREVIEW; «إنشاء مسودة» calls /campaigns/create-plan, which re-validates on live data and prepares a PREPARED plan / decisions (final eligibility is the engine's).
import { api } from './api-client.js';
import { E, num, egp, pill, ago, toast, skeleton, errorCard, timebarHtml, bindTimebar, periodLabel, openDrawer, openModal, closeAll, modalEl, askView, store } from './opx2-ui.js';

const C = { host: null, ctx: null, me: null, tab: 'all', tpl: null, q: null, cols: null, data: null, loading: false, error: null, gen: 0, ctl: null, sel: null, views: [], viewId: null, fbOpen: false, rev: null };
const DEFAULT_COLS = ['name', 'account', 'product', 'status', 'budget', 'spendToday', 'ordersToday', 'spendPeriod', 'ordersPeriod', 'cpaPeriod', 'cpa7', 'winner', 'recommendation', 'approval', 'eligibility'];
const freshSel = () => ({ ids: new Map(), all: false, snap: null, excl: new Set(), stale: false, note: '' });
const freshQ = () => ({ period: { key: 'last7' }, basis: 'CALENDAR', operatingDays: 7, compare: false, logic: 'AND', conds: [], search: '', sort: { k: 'spendPeriod', d: -1 }, page: 1, pageSize: 25 });
export function stopCampaigns() { C.ctl?.abort?.(); C.host = null; C.data = null; document.getElementById('o2Bulk')?.classList.remove('show'); }

// ---------------------------------------------------------------------------------------------------------------------------------------------
// labels / columns
// ---------------------------------------------------------------------------------------------------------------------------------------------
const VIEW_TABS = [['all', 'كل الحملات'], ['open', 'جاهزة للفتح'], ['pause', 'مرشحة للإيقاف'], ['up', 'فرص زيادة ميزانية'], ['down', 'فرص تقليل ميزانية'], ['review', 'تحتاج مراجعة']];
const STOCK_AR = { SAFE: 'متوفر', LOW: 'منخفض', OUT_OF_STOCK: 'خلص', STOCK_UNKNOWN: 'غير مسجّل' }; const STOCK_TONE = { SAFE: 'ok', LOW: 'warn', OUT_OF_STOCK: 'bad', STOCK_UNKNOWN: 'gray' };
const AUTO_AR = { NONE: 'بدون أتمتة', MANUAL: 'يدوي', SHADOW: 'مراقبة فقط', APPROVAL: 'بموافقتي', AUTOMATIC: 'تلقائي' }; const CVL_AR = { WITHIN_TARGET: 'داخل Target', BETWEEN: 'بين Target وReduce', ABOVE_REDUCE: 'فوق Reduce', ABOVE_HARDSTOP: 'فوق Hard Stop', UNKNOWN: 'غير معروف' };
const AR = { ACTIVE: 'نشطة', PAUSED: 'متوقفة', WINNER: 'Winner', NOT_WINNER: 'مش Winner', UNKNOWN: 'غير معروف', LINKED: 'مربوطة', UNLINKED: 'غير مربوطة', PROTECTED: 'محمية', EXCLUDED: 'مستثناة', NORMAL: 'عادية', FRESH: 'حديثة', STALE: 'قديمة', NONE: '—', CANDIDATE: 'مرشحة', READY_FOR_REVIEW: 'جاهزة للمراجعة', APPROVED: 'معتمدة', BLOCKED: 'ممنوعة', ELIGIBLE: 'مؤهلة', NEEDS_SPECIAL_APPROVAL: 'تحتاج موافقة خاصة', NOT_EVALUATED: 'لم تُقيَّم' };
const OPTS = { status: ['ACTIVE', 'PAUSED'], budgetLevel: ['ABO', 'CBO'], winner: ['WINNER', 'NOT_WINNER', 'UNKNOWN'], approval: ['NONE', 'CANDIDATE', 'READY_FOR_REVIEW', 'APPROVED', 'BLOCKED'], eligibility: ['ELIGIBLE', 'NEEDS_SPECIAL_APPROVAL', 'BLOCKED', 'PROTECTED', 'NOT_EVALUATED'], linked: ['LINKED', 'UNLINKED'], guard: ['PROTECTED', 'EXCLUDED', 'NORMAL'], dataFresh: ['FRESH', 'STALE'], cpaVsLimits: ['WITHIN_TARGET', 'BETWEEN', 'ABOVE_REDUCE', 'ABOVE_HARDSTOP', 'UNKNOWN'], stock: ['SAFE', 'LOW', 'OUT_OF_STOCK', 'STOCK_UNKNOWN'], automation: ['NONE', 'MANUAL', 'SHADOW', 'APPROVAL', 'AUTOMATIC'] };
const ACT_AR = { OPEN: 'فتح', PAUSE: 'إيقاف', SCALE_UP: 'زيادة ميزانية', SCALE_DOWN: 'تقليل ميزانية' };
const cmpCell = (r, k, goodUp) => { if (!C.q.compare || !r.compare) return ''; const v = r.compare[k]; if (v == null) return '<span class="sub">—</span>'; if (k === 'spendPct') return `<span class="sub">${v >= 0 ? '▲' : '▼'} ${Math.abs(v)}%</span>`; const good = goodUp ? v >= 0 : v <= 0; return `<span class="${good ? 'up' : 'dn'}">${v >= 0 ? '▲' : '▼'} ${Math.abs(v)}%</span>`; };
const dayAgo = (x) => (x?.daysAgo == null ? '—' : x.daysAgo === 0 ? 'اليوم' : `قبل ${x.daysAgo} يوم`);
const COLS = {
  name: ['اسم الحملة', (r) => `<b>${E(r.name)}</b><span class="sub">${E(r.campaignId)}${r.protectedC ? ' · 🛡️ محمية' : r.excluded ? ' · مستثناة' : ''}</span>`, 'name'], account: ['الحساب', (r) => E(r.adAccountId), null], store: ['المتجر', (r) => E(r.storeId || '—'), null],
  product: ['المنتج', (r) => (r.linked ? E(r.productName || '—') : pill('غير مربوطة', 'warn', 'مفيش منتج متأكد منه — مفيش حد ربح/مخزون للفحص')), null], status: ['الحالة', (r) => pill(r.status === 'ACTIVE' ? 'نشطة' : 'متوقفة', r.status === 'ACTIVE' ? 'ok' : 'gray'), 'status'],
  budget: ['ميزانية اليوم', (r) => (r.budget == null ? '<span class="mut" title="الميزانية غير معروفة">—</span>' : `<span class="n">${num(r.budget)}</span><span class="sub">${E(r.budgetLevel || '')}</span>`), 'budget'], budgetLevel: ['ABO/CBO', (r) => E(r.budgetLevel || '—'), null],
  spendToday: ['صرف اليوم', (r) => `<span class="n">${num(r.today.spend)}</span>`, 'spendToday'], ordersToday: ['أوردرات اليوم', (r) => `<span class="n">${num(r.today.orders)}</span>`, 'ordersToday'], cpaToday: ['CPA اليوم', (r) => `<span class="n">${num(r.today.cpa)}</span>`, 'cpaToday'],
  spendPeriod: ['صرف الفترة', (r) => `<span class="n">${num(r.period.spend)}</span>${cmpCell(r, 'spendPct', false)}`, 'spendPeriod'], ordersPeriod: ['أوردرات الفترة', (r) => `<span class="n">${num(r.period.orders)}</span>${cmpCell(r, 'ordersPct', true)}`, 'ordersPeriod'], cpaPeriod: ['CPA الفترة', (r) => `<span class="n">${num(r.period.cpa)}</span>${cmpCell(r, 'cpaPct', false)}`, 'cpaPeriod'],
  cpa3: ['CPA 3 أيام', (r) => num(r.cpa.d3), 'cpa3'], cpa7: ['CPA 7 أيام', (r) => num(r.cpa.d7), 'cpa7'], cpa14: ['CPA 14 يوم', (r) => num(r.cpa.d14), 'cpa14'], cpa30: ['CPA 30 يوم', (r) => num(r.cpa.d30), 'cpa30'], cpa60: ['CPA 60 يوم', (r) => num(r.cpa.d60), 'cpa60'],
  roas: ['ROAS (Meta)', (r) => (r.period.roas == null ? '<span class="mut" title="مفيش إيراد موثوق من Meta">—</span>' : num(r.period.roas, 2)), 'roas'],
  zones: ['حدود CPA (السياسة)', (r) => (r.zones ? `<span class="sub">ممتاز ≤ ${num(r.zones.good)} · مقبول ≤ ${num(r.zones.mid)} · تحذير ≤ ${num(r.zones.warn)}</span>` : '<span class="mut" title="مفيش سياسة تحدد الحدود">—</span>'), null],
  lastSync: ['آخر مزامنة', (r) => (r.dataFresh ? `${r.dataAgeMin} د` : pill(`${r.dataAgeMin} د`, 'warn', 'بيانات قديمة')), 'dataAgeMin'], lastDecision: ['آخر قرار', (r) => (r.pendingDecision ? E(`${ACT_AR[r.pendingDecision.action] || r.pendingDecision.action}`) : '—'), null],
  winner: ['Winner', (r) => pill(AR[r.winner.status], r.winner.status === 'WINNER' ? 'ok' : 'gray', r.winner.reason), null], recommendation: ['توصية النظام', (r) => (r.pendingDecision ? pill(ACT_AR[r.pendingDecision.action] || E(r.pendingDecision.action), 'info') : r.planItem ? pill(`${r.planItem.type === 'OPEN' ? 'فتح' : 'إيقاف'} (خطة اليوم)`, 'info') : '<span class="mut">—</span>'), null],
  approval: ['حالة الموافقة', (r) => (r.approval.code === 'NONE' ? '<span class="mut">—</span>' : pill(E(r.approval.label), r.approval.code === 'APPROVED' ? 'ok' : r.approval.code === 'BLOCKED' ? 'bad' : 'info')), null],
  eligibility: ['الأهلية (خطة اليوم)', (r) => (r.eligibility === 'NOT_EVALUATED' ? '<span class="mut" title="لم تُقيَّم في خطة اليوم">لم تُقيَّم</span>' : pill(AR[r.eligibility] || E(r.eligibility), r.eligibility === 'ELIGIBLE' ? 'ok' : 'warn')), null],
  lastPause: ['آخر إيقاف', (r) => (r.lastPause ? `${dayAgo(r.lastPause)}<span class="sub">${E(String(r.lastPause.reason || '').slice(0, 40))}</span>` : '—'), 'lastPausedDays'], lastBudgetChange: ['آخر تعديل ميزانية', (r) => (r.lastBudgetChange ? dayAgo(r.lastBudgetChange) : '—'), 'lastBudgetChangeDays'],
  target: ['Target CPA', (r) => limitCell(r, 'target'), 'target'], reduce: ['Reduce CPA', (r) => limitCell(r, 'reduce'), 'reduce'], hardStop: ['Hard Stop CPA', (r) => limitCell(r, 'hardStop'), 'hardStop'],
  stock: ['المخزون', (r) => (r.stock ? pill(STOCK_AR[r.stock.status] || E(r.stock.status), STOCK_TONE[r.stock.status] || 'gray', r.stock.current != null ? `الكمية: ${r.stock.current}` : 'الكمية غير مسجّلة') : '<span class="mut" title="غير متوفر: الحملة مش مربوطة بمنتج">—</span>'), null],
  profit: ['الربح التقديري', (r) => (r.profit?.value != null ? `<span class="n ${r.profit.value < 0 ? 'dn' : 'up'}">${num(r.profit.value)}</span><span class="sub">تقديري</span>` : `<span class="mut" title="${E(r.profit?.reason || '')}">غير متوفر</span>`), 'profit'],
  automation: ['حالة الأتمتة', (r) => pill(AUTO_AR[r.automation] || E(r.automation), r.automation === 'AUTOMATIC' ? 'ok' : r.automation === 'NONE' ? 'gray' : 'info', 'حسب سياسة المنتج — مش تفعيل للتنفيذ'), null],
  lastRun: ['آخر تشغيل فعلي', (r) => (r.lastRun ? `${r.lastRun.days} يوم<span class="sub">${r.lastRun.daysAgo === 0 ? 'لحد النهارده' : `انتهى قبل ${r.lastRun.daysAgo} يوم`}</span>` : '<span class="mut" title="مفيش صرف في الـ 90 يوم">—</span>'), 'lastRunDays'], losingDays: ['أيام خسارة', (r) => (r.losingDays == null ? '<span class="mut" title="غير متوفر: مفيش حد ربحية للمنتج">—</span>' : r.losingDays >= 3 ? pill(`${r.losingDays} يوم`, 'bad') : String(r.losingDays)), 'losingDays'],
  bounds: ['حدود الميزانية (المنتج)', (r) => (r.bounds ? `<span class="sub">${r.bounds.minBudget != null ? `min ${num(r.bounds.minBudget)}` : ''} ${r.bounds.maxBudget != null ? `max ${num(r.bounds.maxBudget)}` : ''} ${r.bounds.dailySpendCap != null ? `cap ${num(r.bounds.dailySpendCap)}` : ''}${r.bounds.maxChangesPerDay != null ? ` · ${r.bounds.maxChangesPerDay} تعديل/يوم` : ''}</span>` : '<span class="mut" title="مفيش سياسة منتج مفعّلة">—</span>'), null],
};
function limitCell(r, k) { const v = r.limits?.[k]; return v == null ? '<span class="mut" title="غير متوفر: مفيش حد CPA معرّف لهذا المنتج/القواعد">—</span>' : `<span class="n">${num(v)}</span><span class="sub">${r.limits.source === 'PRODUCT_POLICY' ? 'سياسة المنتج' : 'القواعد العامة'}</span>`; }
/** WHY a campaign is a candidate: the real numbers behind it (never a bare CPA) — shown next to the open / pause lists and any template */
function nominateBits(r) {
  const b = []; const L = r.limits;
  b.push(r.period.cpa != null ? `CPA ${num(r.period.cpa)}${L ? ` (Target ${num(L.target)} · Reduce ${num(L.reduce)} · Hard Stop ${num(L.hardStop)} → ${CVL_AR[r.cpaVsLimits] || ''})` : ' (مفيش حدود CPA معرّفة)'}` : 'CPA غير متاح');
  b.push(`${num(r.period.orders)} أوردر · صرف ${num(r.period.spend)}`); b.push(`المخزون: ${r.stock ? STOCK_AR[r.stock.status] || r.stock.status : 'غير متاح'}`);
  b.push(r.profit?.value != null ? `الربح التقديري ${num(r.profit.value)}` : 'الربح: غير متوفر');
  if (r.lastRun) b.push(`آخر تشغيل ${r.lastRun.days} يوم ${r.lastRun.daysAgo === 0 ? '(لحد النهارده)' : `(انتهى قبل ${r.lastRun.daysAgo} يوم)`}`);
  if (r.lastPause) b.push(`آخر إيقاف: ${String(r.lastPause.reason || 'بدون سبب مسجّل').slice(0, 60)}`); if (r.losingDays >= 2) b.push(`خسارة ${r.losingDays} أيام متتالية`);
  return b;
}
const NOM = ['سبب الترشيح', (r) => `<div class="opx2-nom">${nominateBits(r).map((x) => `<span>${E(x)}</span>`).join('')}</div>`, null];
const showNom = () => !!C.tpl || C.tab === 'open' || C.tab === 'pause';
const colList = () => (C.cols || DEFAULT_COLS).filter((k) => COLS[k]);
const drawCols = () => { const l = colList(); return showNom() ? [l[0], 'nominate', ...l.slice(1)] : l; };
const CD = (k) => (k === 'nominate' ? NOM : COLS[k]);
const keyOf = (r) => `${r.adAccountId}:${r.campaignId}`;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// templates (editable starting points — never hard rules). Missing server fields are shown disabled with the reason, not faked.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const stat = (v) => ({ f: 'status', v: [v] });
const TPL = {
  open: [['o1', 'CPA ممتاز 20–80', [stat('PAUSED'), { f: 'cpaPeriod', op: 'between', v: [20, 80] }], 'متوقفة وCPA الفترة من 20 إلى 80 (الحدين شاملين)'], ['o2', 'CPA جيد 81–130', [stat('PAUSED'), { f: 'cpaPeriod', op: 'between', v: [81, 130] }], 'متوقفة وCPA الفترة من 81 إلى 130'], ['o3', 'CPA 20–130', [stat('PAUSED'), { f: 'cpaPeriod', op: 'between', v: [20, 130] }], 'متوقفة وCPA الفترة من 20 إلى 130'],
    ...[['o4a', 7, 'last7', 5], ['o4b', 14, 'last14', 8], ['o4c', 30, 'last30', 10], ['o4d', 60, 'last60', 15]].map(([id, n, key, min]) => [id, `ممتازة ${n} يوم`, [stat('PAUSED'), { f: 'cpaPeriod', op: 'between', v: [20, 80] }, { f: 'ordersPeriod', op: 'gte', v: [min] }], `متوقفة وCPA من 20 لـ 80 مع ${min} أوردرات أو أكتر خلال آخر ${n} يوم (بتضبط الفترة تلقائيًا وتقدر تعدّلها)`, key]), ['o5', 'رابحة لكنها متوقفة', [stat('PAUSED'), { f: 'winner', v: ['WINNER'] }], 'تصنيف Winner (أوردرات 7 و30 يوم + حد الربحية)'], ['o6', 'أنا أختار يدويًا', [stat('PAUSED')], 'كل المتوقفة — حدّد بنفسك'],
    ['o7', 'داخل Target CPA للمنتج', [stat('PAUSED'), { f: 'cpaVsLimits', v: ['WITHIN_TARGET'] }, { f: 'stock', v: ['SAFE', 'LOW', 'STOCK_UNKNOWN'] }], 'متوقفة وCPA الفترة داخل Target CPA بتاع المنتج (من سياسته أو القواعد العامة)، والمخزون مش خالص. الحملات اللي مالهاش حدود CPA مش بتظهر.']],
  pause: [['p1', 'صفر أوردرات 150–200', [stat('ACTIVE'), { f: 'ordersToday', op: 'eq', v: [0] }, { f: 'spendToday', op: 'gt', v: [150] }, { f: 'spendToday', op: 'lte', v: [200] }], 'صرف اليوم أكبر من 150 (غير شامل) وحتى 200 (شامل)، وأوردرات اليوم = 0'], ['p2', 'صفر أوردرات > 150', [stat('ACTIVE'), { f: 'ordersToday', op: 'eq', v: [0] }, { f: 'spendToday', op: 'gt', v: [150] }], 'نفس شرط سياسة 13:00 (أكبر من 150) — السياسة نفسها ما اتغيرتش'], ['p3', 'صفر أوردرات > 200', [stat('ACTIVE'), { f: 'ordersToday', op: 'eq', v: [0] }, { f: 'spendToday', op: 'gt', v: [200] }], 'صرف اليوم أكبر من 200'],
    ['p4', 'CPA > 130', [stat('ACTIVE'), { f: 'cpaPeriod', op: 'gt', v: [130] }], 'CPA الفترة أعلى من 130'], ['p9', 'CPA > Target CPA للمنتج', [stat('ACTIVE'), { f: 'cpaVsLimits', v: ['BETWEEN', 'ABOVE_REDUCE', 'ABOVE_HARDSTOP'] }], 'شغالة وCPA الفترة فوق Target CPA بتاع المنتج (أي مستوى فوقه)'], ['p10', 'متدهورة', [stat('ACTIVE'), { f: 'cpaTrend', op: 'gte', v: [25] }, { f: 'ordersPeriod', op: 'gte', v: [1] }], 'CPA آخر 3 أيام أعلى من CPA آخر 14 يوم بـ 25% أو أكتر (الاتجاه بيسوء)'],
    ['p5', 'CPA > Reduce CPA للمنتج', [stat('ACTIVE'), { f: 'cpaVsLimits', v: ['ABOVE_REDUCE', 'ABOVE_HARDSTOP'] }], 'شغالة وCPA الفترة فوق Reduce CPA بتاع المنتج (الحدود من سياسة المنتج أو القواعد العامة)'], ['p6', 'CPA > Hard Stop للمنتج', [stat('ACTIVE'), { f: 'cpaVsLimits', v: ['ABOVE_HARDSTOP'] }], 'شغالة وCPA الفترة فوق Hard Stop CPA بتاع المنتج'], ['p7', 'بدون مخزون', [stat('ACTIVE'), { f: 'stock', v: ['OUT_OF_STOCK'] }], 'شغالة والمنتج مخزونه خلص (من Stock Guard الموجود)'], ['p8', 'خاسرة 3 أيام متتالية', [stat('ACTIVE'), { f: 'losingDays', op: 'gte', v: [3] }], 'شغالة وخسرانة 3 أيام متتالية أو أكتر (يوم بدون أوردرات وصرفه ≥ حد الربحية، أو CPA أعلى منه). مفيش حد ربحية = بتتخطى.']],
};
const PRESETS = [['حملات ممتازة', { tab: 'all', conds: [stat('ACTIVE'), { f: 'cpaPeriod', op: 'between', v: [20, 80] }, { f: 'ordersPeriod', op: 'gte', v: [5] }] }], ['تحتاج إيقاف', { tab: 'pause', conds: [] }], ['فرص توسع', { tab: 'up', conds: [] }], ['تحتاج مراجعة', { tab: 'review', conds: [] }]];

// ---------------------------------------------------------------------------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------------------------------------------------------------------------
const effView = () => (C.tpl ? 'all' : C.tab);
function queryBody(extra = {}) {
  const p = C.q.period; return { period: { key: p.key, from: p.key === 'custom' ? p.from : undefined, to: p.key === 'custom' ? p.to : undefined }, basis: C.q.basis, operatingDays: C.q.operatingDays, compare: C.q.compare, view: effView(), logic: C.q.logic, conds: C.q.conds, search: C.q.search, sort: C.q.sort, page: C.q.page, pageSize: C.q.pageSize, ...extra };
}
async function load({ keepRows = true } = {}) {
  const host = C.host; if (!host) return; const gen = ++C.gen; C.ctl?.abort?.(); C.ctl = new AbortController(); C.loading = true; C.error = null;
  if (C.data && keepRows) host.querySelector('.opx2-tw')?.classList.add('busy'); else if (!C.data) host.innerHTML = `<h1>الحملات</h1><div class="opx2-card">${skeleton(7, 42)}</div>`;
  try {
    const d = await api.post('/api/operator-v2/campaigns/query', queryBody(), { signal: C.ctl.signal });
    if (gen !== C.gen || !C.host) return; C.data = d; C.loading = false; C.q.page = d.page; draw();
  } catch (e) { if (e.name === 'AbortError' || gen !== C.gen || !C.host) return; C.loading = false; C.error = e.message || 'تعذّر تحميل الحملات.'; if (!C.data) { host.innerHTML = errorCard(C.error); host.querySelector('#o2Retry').onclick = () => load({ keepRows: false }); } else { toast(C.error, 'error'); draw(); } }
}
/** a change of period / view / filters / search invalidates the current selection scope — the user must re-confirm it before any bulk action */
function touch(note) { C.q.page = 1; if (selCount() > 0) { C.sel.stale = true; C.sel.note = note; } }
const selCount = () => (C.sel.all ? Math.max(0, (C.sel.snap?.total || 0) - C.sel.excl.size) : C.sel.ids.size);
const isSel = (r) => (C.sel.all ? !C.sel.excl.has(r.campaignId) : C.sel.ids.has(keyOf(r)));
function setSel(r, on) { if (C.sel.all) { on ? C.sel.excl.delete(r.campaignId) : C.sel.excl.add(r.campaignId); } else { on ? C.sel.ids.set(keyOf(r), { campaignId: r.campaignId, adAccountId: r.adAccountId }) : C.sel.ids.delete(keyOf(r)); } }

// ---------------------------------------------------------------------------------------------------------------------------------------------
// mount + draw
// ---------------------------------------------------------------------------------------------------------------------------------------------
export async function mountCampaigns(host, ctx, opts = {}) {
  C.host = host; C.ctx = ctx; C.me = ctx.me; if (!C.q) C.q = freshQ(); if (!C.sel) C.sel = freshSel(); C.cols = (() => { try { const j = JSON.parse(store.get(`opx2.cols.${ctx.level}`, 'null')); return Array.isArray(j) ? j.filter((k) => COLS[k]) : null; } catch { return null; } })();
  if (opts.view && VIEW_TABS.some((t) => t[0] === opts.view)) { C.tab = opts.view; C.tpl = null; C.q.conds = []; C.q.page = 1; } if (opts.period) C.q.period = { ...opts.period }; if (typeof opts.compare === 'boolean') C.q.compare = opts.compare;
  loadViews(); await load({ keepRows: false });
}
async function loadViews() { try { C.views = (await api.get('/api/operator-v2/views')).views || []; if (C.host && C.data) draw(); } catch { C.views = []; } }
const condOptions = (f) => { if (f === 'account') return C.me.accounts.map((a) => [a, a]); if (f === 'store') return (C.data?.facets.stores || []).map((s) => [s.id, s.name]); if (f === 'product') return (C.data?.facets.products || []).map((p) => [p.id, p.name || p.id]); if (f === 'automation') return OPTS.automation.map((o) => [o, AUTO_AR[o]]); if (f === 'stock') return OPTS.stock.map((o) => [o, STOCK_AR[o]]); if (f === 'cpaVsLimits') return OPTS.cpaVsLimits.map((o) => [o, CVL_AR[o]]); return (OPTS[f] || []).map((o) => [o, AR[o] || o]); };
function condRow(c, i) {
  const f = C.me.fields.find((x) => x.key === c.f) || C.me.fields[0]; let val = '';
  if (f.type === 'multi') val = `<span style="display:flex;gap:4px;flex-wrap:wrap">${condOptions(f.key).map(([v, l]) => `<button class="opx2-opt ${c.v?.includes(String(v)) ? 'on' : ''}" data-copt="${i}|${E(v)}">${E(l)}</button>`).join('') || '<span class="mut">لا توجد خيارات</span>'}</span>`;
  else if (f.type === 'text') val = `<input data-cval="${i}|0" value="${E(c.v || '')}" placeholder="نص…">`;
  else val = `<select data-cop="${i}">${[['gte', '≥'], ['lte', '≤'], ['gt', '>'], ['lt', '<'], ['eq', '='], ['between', 'بين']].map(([k, l]) => `<option value="${k}" ${c.op === k ? 'selected' : ''}>${l}</option>`).join('')}</select><input type="number" data-cval="${i}|0" value="${c.v?.[0] ?? ''}" placeholder="القيمة">${c.op === 'between' ? `<input type="number" data-cval="${i}|1" value="${c.v?.[1] ?? ''}" placeholder="إلى">` : ''}`;
  return `<div class="opx2-fr"><select data-cf="${i}">${C.me.fields.map((x) => `<option value="${E(x.key)}" ${x.key === c.f ? 'selected' : ''}>${E(x.label)}</option>`).join('')}</select>${val}<button class="opx2-btn sm" data-delcond="${i}" aria-label="حذف الشرط">✕</button></div>`;
}
function draw() {
  const host = C.host; const d = C.data; if (!host || !d) return; const caps = C.ctx.caps; const sc = selCount(); const cols = drawCols(); const rows = d.rows; const pageAll = rows.length > 0 && rows.every(isSel);
  const tpls = TPL[C.tab] || []; const mine = C.views.filter((v) => v.mine), shared = C.views.filter((v) => !v.mine); const cur = C.views.find((v) => v.id === C.viewId);
  const staleWarn = d.freshness.staleCampaigns > 0 ? `<div class="opx2-banner warn">⚠️ ${d.freshness.staleCampaigns} حملة بياناتها قديمة (أقدمهم: ${d.freshness.oldestCampaignSeenAt ? ago(d.freshness.oldestCampaignSeenAt) : 'غير معروف'}) — بتظهر بعلامة «قديمة» ومش بتتحسب كأنها حديثة.</div>` : '';
  const banner = C.sel.stale ? `<div class="opx2-selb" style="background:var(--warnbg);color:var(--warn)">⚠️ ${E(C.sel.note)} — التحديد الحالي (${sc}) كان على نتيجة سابقة، والإجراءات متوقفة لحد ما تأكد النطاق. ${C.sel.all ? `<button class="opx2-btn sm pri" data-selact="resnap">تحديد النتائج الحالية (${d.total})</button>` : `<button class="opx2-btn sm pri" data-selact="keep">إبقاء الـ ${sc} المحددة</button>`}<button class="opx2-btn sm" data-selact="cancel">إلغاء التحديد</button></div>`
    : sc && !C.sel.all && pageAll && d.total > rows.length ? `<div class="opx2-selb" style="background:var(--infobg);color:var(--info)">اتحددت ${rows.length} حملة في الصفحة دي. <button class="opx2-btn sm pri" data-selact="all">حدد كل الـ ${d.total} حملة المطابقة (عبر الصفحات)</button></div>`
    : C.sel.all ? `<div class="opx2-selb" style="background:var(--brand2);color:var(--brand)">متحدد كل الـ ${C.sel.snap.total} المطابقة${C.sel.excl.size ? ` ما عدا ${C.sel.excl.size}` : ''} — <b>${sc}</b> حملة (لقطة ثابتة من السيرفر). <button class="opx2-btn sm" data-selact="cancel">إلغاء التحديد</button></div>` : '';
  const opBasis = `<div class="opx2-basis"><span class="opx2-seg" role="group" aria-label="أساس الفترة"><button data-basis="CALENDAR" class="${C.q.basis === 'CALENDAR' ? 'on' : ''}">أيام تقويمية</button><button data-basis="OPERATING" class="${C.q.basis === 'OPERATING' ? 'on' : ''}">آخر أيام تشغيل فعلية</button></span>${C.q.basis === 'OPERATING' ? `<label class="opx2-note">آخر <select id="o2OpDays">${[3, 7, 14, 30].map((n) => `<option value="${n}" ${C.q.operatingDays === n ? 'selected' : ''}>${n}</option>`).join('')}</select> يوم صرف فعلي</label><span class="opx2-note">الأيام اللي الحملة كانت فيها متوقفة بتتخطّى، فالفترة الفعلية ممكن تمتد لأسابيع للخلف (لكل حملة لوحدها) — ده مختلف عن «آخر ${C.q.operatingDays} يوم» التقويمية. الإيراد وROAS مش بيتحسبوا بالأسلوب ده. سياسة 13:00 مش بتتأثر.</span>` : ''}</div>`;
  host.innerHTML = `<div class="opx2-sticky">${timebarHtml({ period: C.q.period, compare: C.q.compare }, { note: false })}${opBasis}
    <div class="opx2-views">${VIEW_TABS.map(([k, l]) => `<button data-tab="${k}" class="${C.tab === k ? 'on' : ''}">${l} <span class="c">${num(d.viewCounts[k])}</span></button>`).join('')}</div>
    <div class="opx2-tools"><input type="search" id="o2Q" placeholder="ابحث باسم الحملة أو الـ ID…" value="${E(C.q.search)}" aria-label="بحث"><button class="opx2-btn" data-fb="1">☰ فلاتر ${C.q.conds.length ? `(${C.q.conds.length})` : ''}</button>
      <select id="o2Views" class="opx2-btn" aria-label="العروض المحفوظة"><option value="">⭐ العروض المحفوظة</option><optgroup label="جاهزة">${PRESETS.map((p, i) => `<option value="b:${i}">${E(p[0])}</option>`).join('')}</optgroup>${mine.length ? `<optgroup label="عروضي">${mine.map((v) => `<option value="u:${v.id}" ${v.id === C.viewId ? 'selected' : ''}>${E(v.name)}${v.shared ? ' (مشترك)' : ''}</option>`).join('')}</optgroup>` : ''}${shared.length ? `<optgroup label="مشتركة">${shared.map((v) => `<option value="u:${v.id}" ${v.id === C.viewId ? 'selected' : ''}>${E(v.name)}</option>`).join('')}</optgroup>` : ''}</select>
      <button class="opx2-btn" data-saveview="1">💾 حفظ العرض</button><button class="opx2-btn" data-colpick="1">▦ الأعمدة</button><button class="opx2-btn" data-export="1">⬇ تصدير CSV / Excel</button></div></div>
  ${cur ? `<div class="opx2-chips"><span class="opx2-note">العرض المحدد: <b>${E(cur.name)}</b></span>${cur.mine ? `<button class="opx2-btn sm" data-vact="update">تحديث بالإعدادات الحالية</button>${caps.shareViews ? `<button class="opx2-btn sm" data-vact="share">${cur.shared ? 'إلغاء المشاركة' : 'مشاركة'}</button>` : ''}` : ''}<button class="opx2-btn sm" data-vact="dup">نسخ</button>${cur.mine || (cur.shared && C.ctx.level === 'ADMIN') ? '<button class="opx2-btn sm" data-vact="del">حذف</button>' : ''}</div>` : ''}
  ${tpls.length ? `<div class="opx2-chips">${tpls.map(([id, l, conds, tip]) => `<button class="opx2-chip ${C.tpl === id ? 'on' : ''}" data-tpl="${id}" ${conds ? '' : 'disabled'} title="${E(tip)}">${E(l)}</button>`).join('')}${C.tpl ? `<span class="opx2-note">${E(tpls.find((t) => t[0] === C.tpl)?.[3] || '')} — الأرقام قابلة للتعديل من الفلاتر</span><button class="opx2-btn sm" data-tpl="${C.tpl}">إلغاء القالب</button>` : ''}</div>` : ''}
  <div class="opx2-fb ${C.fbOpen ? 'open' : ''}"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px"><b>الفلاتر المتقدمة</b><span class="opx2-seg"><button class="${C.q.logic === 'AND' ? 'on' : ''}" data-logic="AND">كل الشروط (AND)</button><button class="${C.q.logic === 'OR' ? 'on' : ''}" data-logic="OR">أي شرط (OR)</button></span><button class="opx2-btn sm" data-addcond="1">+ شرط</button><button class="opx2-btn sm" data-resetf="1">إعادة ضبط الكل</button></div>${C.q.conds.length ? C.q.conds.map(condRow).join('') : '<div class="mut">مفيش شروط — اضغط «+ شرط».</div>'}</div>
  ${staleWarn}${banner}
  <div class="opx2-tw"><table><thead><tr><th class="ck"><input type="checkbox" id="o2PageAll" ${pageAll ? 'checked' : ''} aria-label="تحديد الصفحة"></th>${cols.map((k) => `<th class="${k === 'name' ? 'nm' : ''}" ${CD(k)[2] ? `data-sort="${CD(k)[2]}"` : ''}>${CD(k)[0]}${C.q.sort.k === CD(k)[2] && CD(k)[2] ? (C.q.sort.d > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr class="${isSel(r) ? 'sel' : ''}"><td class="ck"><input type="checkbox" data-pick="${E(keyOf(r))}" ${isSel(r) ? 'checked' : ''} aria-label="تحديد ${E(r.name)}"></td>${cols.map((k) => `<td class="${k === 'name' ? 'nm' : ''}" ${k === 'name' ? `data-detail="${E(keyOf(r))}"` : ''}>${CD(k)[1](r)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length + 1}" class="opx2-empty">مفيش حملات مطابقة. جرّب تغيّر الفترة أو الفلاتر.</td></tr>`}</tbody></table></div>
  <div class="opx2-cards">${rows.map((r) => `<div class="opx2-cc ${isSel(r) ? 'sel' : ''}"><div class="r"><label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" data-pick="${E(keyOf(r))}" ${isSel(r) ? 'checked' : ''} style="width:20px;height:20px"><span data-detail="${E(keyOf(r))}"><b>${E(r.name)}</b><span class="sub">${E(r.campaignId)} · ${E(r.budgetLevel || '')}</span></span></label>${pill(r.status === 'ACTIVE' ? 'نشطة' : 'متوقفة', r.status === 'ACTIVE' ? 'ok' : 'gray')}</div><div class="m"><div><span>صرف الفترة</span> ${num(r.period.spend)}</div><div><span>أوردرات</span> ${num(r.period.orders)}</div><div><span>CPA</span> ${num(r.period.cpa)}</div><div><span>ميزانية</span> ${num(r.budget)}</div></div><div style="margin-top:8px">${COLS.winner[1](r)} ${COLS.eligibility[1](r)} ${r.dataFresh ? '' : pill('بيانات قديمة', 'warn')}</div></div>`).join('') || '<div class="opx2-empty">مفيش حملات مطابقة.</div>'}</div>
  <div class="opx2-pg"><span>عرض ${d.total ? (d.page - 1) * d.pageSize + 1 : 0}–${Math.min(d.total, d.page * d.pageSize)} من <b>${num(d.total)}</b> حملة مطابقة · ${d.basis === 'OPERATING' ? `آخر ${d.operatingDays} يوم صرف فعلي لكل حملة${d.compare ? ' · مقارنة بالـ ' + d.operatingDays + ' يوم صرف اللي قبلهم' : ''}` : `${E(periodLabel(d.period.key))} (${E(d.period.from)} → ${E(d.period.to)})${d.compare ? ` · مقارنة بـ ${E(d.period.prev?.from)} → ${E(d.period.prev?.to)}` : ''}`} · ${d.pageSize} في الصفحة</span><span style="display:flex;gap:6px;align-items:center"><button class="opx2-btn sm" data-page="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>السابق</button> صفحة ${d.page} / ${d.pages} <button class="opx2-btn sm" data-page="${d.page + 1}" ${d.page >= d.pages ? 'disabled' : ''}>التالي</button></span></div>
  <p class="opx2-note">${E(d.attribution.note)} · الأرقام الناقصة بتظهر «—» (مش صفر). حدود الصرف لسياسة 13:00: ${d.zeroSpendLimit.comparison === 'GTE' ? '≥' : '>'} ${num(d.zeroSpendLimit.limit)} ج.م ${d.zeroSpendLimit.approved ? '(معتمدة)' : '(غير معتمدة — بتتستخدم كحد للعرض فقط)'}.</p>`;
  bind(); drawBulk();
}
// ---------------------------------------------------------------------------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------------------------------------------------------------------------
function bind() {
  const h = C.host; const reload = (note) => { if (note) touch(note); C.viewId = note ? null : C.viewId; load(); };
  bindTimebar(h, C.q, (what) => reload(what === 'compare' ? null : 'غيّرت الفترة'));
  h.querySelectorAll('[data-basis]').forEach((b) => { b.onclick = () => { if (C.q.basis === b.dataset.basis) return; C.q.basis = b.dataset.basis; reload('غيّرت أساس الفترة'); }; });
  const opd = h.querySelector('#o2OpDays'); if (opd) opd.onchange = () => { C.q.operatingDays = Number(opd.value); reload('غيّرت عدد أيام التشغيل'); };
  h.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { C.tab = b.dataset.tab; if (C.tpl) C.q.conds = []; C.tpl = null; touch('غيّرت العرض'); C.viewId = null; load(); }; });
  h.querySelectorAll('[data-tpl]').forEach((b) => { b.onclick = () => { const id = b.dataset.tpl; if (C.tpl === id) { C.tpl = null; C.q.conds = []; } else { const t = (TPL[C.tab] || []).find((x) => x[0] === id); if (!t?.[2]) return; C.tpl = id; if (t[4]) C.q.period = { key: t[4] }; C.q.conds = t[2].map((c) => ({ ...c })); C.q.logic = 'AND'; C.fbOpen = true; } touch('غيّرت القالب'); C.viewId = null; load(); }; });
  const q = h.querySelector('#o2Q'); q.oninput = debounceInput(() => { C.q.search = q.value; touch('غيّرت البحث'); load(); });
  h.querySelector('[data-fb]').onclick = () => { C.fbOpen = !C.fbOpen; draw(); };
  h.querySelectorAll('[data-logic]').forEach((b) => { b.onclick = () => { C.q.logic = b.dataset.logic; C.tpl = null; reload('غيّرت منطق الفلاتر'); }; });
  h.querySelector('[data-addcond]').onclick = () => { C.q.conds.push({ f: 'cpaPeriod', op: 'between', v: [] }); C.fbOpen = true; draw(); };
  h.querySelector('[data-resetf]').onclick = () => { C.q.conds = []; C.tpl = null; C.q.search = ''; C.tab = 'all'; reload('أعدت ضبط الفلاتر'); };
  h.querySelectorAll('[data-delcond]').forEach((b) => { b.onclick = () => { C.q.conds.splice(+b.dataset.delcond, 1); C.tpl = null; reload('غيّرت الفلاتر'); }; });
  h.querySelectorAll('[data-copt]').forEach((b) => { b.onclick = () => { const [i, ...rest] = b.dataset.copt.split('|'); const o = rest.join('|'); const c = C.q.conds[+i]; c.v = c.v || []; c.v = c.v.includes(o) ? c.v.filter((x) => x !== o) : [...c.v, o]; C.tpl = null; reload('غيّرت الفلاتر'); }; });
  h.querySelectorAll('[data-cf]').forEach((s) => { s.onchange = () => { C.q.conds[+s.dataset.cf] = { f: s.value, op: 'between', v: [] }; C.tpl = null; reload('غيّرت الفلاتر'); }; });
  h.querySelectorAll('[data-cop]').forEach((s) => { s.onchange = () => { C.q.conds[+s.dataset.cop].op = s.value; C.tpl = null; reload('غيّرت الفلاتر'); }; });
  h.querySelectorAll('[data-cval]').forEach((inp) => { inp.onchange = () => { const [i, j] = inp.dataset.cval.split('|'); const c = C.q.conds[+i]; const f = C.me.fields.find((x) => x.key === c.f); if (f.type === 'text') c.v = inp.value; else { c.v = c.v || []; c.v[+j] = inp.value === '' ? null : Number(inp.value); } C.tpl = null; reload('غيّرت الفلاتر'); }; });
  h.querySelectorAll('[data-sort]').forEach((th) => { th.onclick = () => { const k = th.dataset.sort; C.q.sort = { k, d: C.q.sort.k === k ? -C.q.sort.d : -1 }; C.q.page = 1; load(); }; });
  h.querySelectorAll('[data-page]').forEach((b) => { b.onclick = () => { C.q.page = Number(b.dataset.page); load(); }; });
  h.querySelector('#o2PageAll').onchange = (e) => { C.data.rows.forEach((r) => setSel(r, e.target.checked)); draw(); };
  h.querySelectorAll('[data-pick]').forEach((c) => { c.onchange = () => { const r = C.data.rows.find((x) => keyOf(x) === c.dataset.pick); if (r) setSel(r, c.checked); draw(); }; });
  h.querySelectorAll('[data-detail]').forEach((el) => { el.onclick = () => { const r = C.data.rows.find((x) => keyOf(x) === el.dataset.detail); if (r) showDetail(r); }; });
  h.querySelectorAll('[data-selact]').forEach((b) => { b.onclick = () => selAction(b.dataset.selact); });
  h.querySelector('[data-colpick]').onclick = colPicker; h.querySelector('[data-export]').onclick = doExport; h.querySelector('[data-saveview]').onclick = saveView;
  h.querySelector('#o2Views').onchange = (e) => applyView(e.target.value); h.querySelectorAll('[data-vact]').forEach((b) => { b.onclick = () => viewAction(b.dataset.vact); });
}
let _t; const debounceInput = (fn) => () => { clearTimeout(_t); _t = setTimeout(fn, 350); };
async function selAction(a) {
  if (a === 'cancel') { C.sel = freshSel(); draw(); return; } if (a === 'keep') { C.sel.stale = false; draw(); return; }
  if (a === 'all' || a === 'resnap') {
    try { const s = await api.post('/api/operator-v2/campaigns/snapshot', queryBody({ page: undefined, pageSize: undefined })); C.sel = { ids: new Map(), all: true, snap: { id: s.snapshotId, total: s.total, expiresAt: s.expiresAt }, excl: new Set(), stale: false, note: '' }; toast(`اتحددت ${s.total} حملة (لقطة ثابتة لـ 30 دقيقة)`); draw(); } catch (e) { toast(e.message || 'تعذّر عمل لقطة التحديد.', 'error'); }
  }
}
function drawBulk() {
  const b = document.getElementById('o2Bulk'); if (!b) return; const sc = selCount(); if (!sc) { b.classList.remove('show'); return; } const caps = C.ctx.caps; const dis = C.sel.stale || !caps.reviewActions ? 'disabled' : '';
  b.innerHTML = `<span class="cnt">${sc} محددة</span>${[['OPEN', 'مراجعة فتح'], ['PAUSE', 'مراجعة إيقاف'], ['INCREASE_BUDGET', 'مراجعة زيادة ميزانية'], ['DECREASE_BUDGET', 'مراجعة تقليل ميزانية'], ['ADD_EXCLUSION', 'إضافة استثناء'], ['REMOVE_EXCLUSION', 'إزالة استثناء']].map(([k, l]) => `<button class="opx2-btn" data-bact="${k}" ${dis}>${l}</button>`).join('')}<button class="opx2-btn" data-bexport="1" ${C.sel.stale ? 'disabled' : ''}>تصدير</button><button class="opx2-btn" data-bclear="1">✕ إلغاء</button>${caps.reviewActions ? '' : '<span style="font-size:12.5px;opacity:.8">حسابك للعرض والتصدير فقط</span>'}`;
  b.classList.add('show'); b.querySelectorAll('[data-bact]').forEach((x) => { x.onclick = () => openReview(x.dataset.bact); }); b.querySelector('[data-bexport]').onclick = doExport; b.querySelector('[data-bclear]').onclick = () => { C.sel = freshSel(); draw(); };
}
// ---------------------------------------------------------------------------------------------------------------------------------------------
// export / columns / saved views
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function doExport() {
  try { const body = queryBody({ page: undefined, pageSize: undefined, columns: colList().map((k) => (k === 'lastSync' ? 'lastSyncMin' : k)).concat(['id']) });
    if (selCount() && !C.sel.stale) { if (C.sel.all) body.excludeIds = [...C.sel.excl]; else body.campaignIds = [...C.sel.ids.values()].map((x) => x.campaignId); }
    const r = await api.download('/api/operator-v2/campaigns/export', body); const a = document.createElement('a'); a.href = URL.createObjectURL(r.blob); a.download = r.filename; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); toast(`اتصدّر ${r.count ?? ''} حملة (CSV يفتح في Excel)`); } catch (e) { toast(e.message || 'تعذّر التصدير.', 'error'); }
}
function colPicker() {
  const list = Object.entries(COLS).map(([k, c]) => `<label style="display:flex;gap:8px;padding:4px 0"><input type="checkbox" data-col="${k}" ${colList().includes(k) ? 'checked' : ''} ${k === 'name' ? 'disabled' : ''}> ${c[0]}</label>`).join('');
  openDrawer(`<button class="opx2-btn sm" data-close style="float:left">تم ✓</button><h2>الأعمدة</h2><p class="opx2-note">اختار الأعمدة اللي تظهر. بيتحفظ لكل حساب مستخدم على المتصفح، وبيتحفظ مع العرض المحفوظ.</p>${list}`);
  const el = document.getElementById('o2Drawer'); el.querySelector('[data-close]').onclick = closeAll;
  el.querySelectorAll('[data-col]').forEach((c) => { c.onchange = () => { const cur = new Set(colList()); c.checked ? cur.add(c.dataset.col) : cur.delete(c.dataset.col); C.cols = Object.keys(COLS).filter((k) => cur.has(k)); store.set(`opx2.cols.${C.ctx.level}`, JSON.stringify(C.cols)); draw(); }; });
}
const currentConfig = () => ({ view: C.tpl ? 'all' : C.tab, period: { key: C.q.period.key, from: C.q.period.key === 'custom' ? C.q.period.from : undefined, to: C.q.period.key === 'custom' ? C.q.period.to : undefined }, basis: C.q.basis, operatingDays: C.q.operatingDays, compare: C.q.compare, logic: C.q.logic, conds: C.q.conds, search: C.q.search, sort: C.q.sort, columns: colList(), pageSize: C.q.pageSize });
async function saveView() {
  const r = await askView({ title: 'حفظ العرض الحالي', canShare: !!C.ctx.caps.shareViews }); if (!r) return;
  try { const v = await api.post('/api/operator-v2/views', { name: r.name, config: currentConfig(), shared: r.shared }); C.viewId = v.id; toast('اتحفظ العرض في قاعدة البيانات'); await loadViews(); draw(); } catch (e) { toast(e.message || 'تعذّر حفظ العرض.', 'error'); }
}
function applyConfig(cfg) {
  C.tab = cfg.view || 'all'; C.tpl = null; C.q.period = { ...(cfg.period || { key: 'last7' }) }; C.q.compare = !!cfg.compare; C.q.basis = cfg.basis === 'OPERATING' ? 'OPERATING' : 'CALENDAR'; C.q.operatingDays = [3, 7, 14, 30].includes(cfg.operatingDays) ? cfg.operatingDays : 7; C.q.logic = cfg.logic || 'AND'; C.q.conds = (cfg.conds || []).map((c) => ({ ...c })); C.q.search = cfg.search || ''; C.q.sort = cfg.sort || { k: 'spendPeriod', d: -1 }; C.q.pageSize = cfg.pageSize || 25; C.q.page = 1; if (cfg.columns?.length) C.cols = cfg.columns.filter((k) => COLS[k]); C.fbOpen = C.q.conds.length > 0;
}
function applyView(val) {
  if (!val) { C.viewId = null; return; }
  if (val.startsWith('b:')) { const p = PRESETS[+val.slice(2)]; applyConfig({ view: p[1].tab, conds: p[1].conds }); C.viewId = null; touch('طبّقت عرضًا جاهزًا'); load(); return; }
  const v = C.views.find((x) => x.id === Number(val.slice(2))); if (!v) return; applyConfig(v.config); C.viewId = v.id; touch('طبّقت عرضًا محفوظًا'); load();
}
async function viewAction(a) {
  const v = C.views.find((x) => x.id === C.viewId); if (!v) return;
  try {
    if (a === 'update') { await api.put(`/api/operator-v2/views/${v.id}`, { config: currentConfig() }); toast('اتحدّث العرض'); }
    else if (a === 'share') { await api.put(`/api/operator-v2/views/${v.id}`, { shared: !v.shared }); toast(v.shared ? 'اتلغت المشاركة' : 'اتشارك العرض مع الفريق (كل واحد بيشوف حساباته هو بس)'); }
    else if (a === 'dup') { const n = await api.post(`/api/operator-v2/views/${v.id}/duplicate`, {}); C.viewId = n.id; toast('اتعمل نسخة خاصة بيك'); }
    else if (a === 'del') { await api.delete(`/api/operator-v2/views/${v.id}`); C.viewId = null; toast('اتحذف العرض'); }
    await loadViews(); draw();
  } catch (e) { toast(e.message || 'تعذّر تنفيذ العملية على العرض.', 'error'); }
}
// ---------------------------------------------------------------------------------------------------------------------------------------------
// details drawer (from the row already on screen — no extra request)
// ---------------------------------------------------------------------------------------------------------------------------------------------
function budgetImpactHtml(r) {
  const x = r.budgetImpact; if (!x) return '<p class="opx2-note">مفيش تعديل ميزانية مسجّل على الحملة دي.</p>';
  const cell = (s) => (s ? `${s.days} يوم · صرف ${num(s.spend)} · ${s.orders == null ? 'أوردرات غير متاحة' : num(s.orders) + ' أوردر'} · CPA ${num(s.cpa)}` : 'مفيش بيانات');
  return `<div class="opx2-kv"><span>التعديل</span><b>${E(ACT_AR[x.action === 'INCREASE_BUDGET' ? 'SCALE_UP' : 'SCALE_DOWN'] || x.action)} — ${E(x.changeDate)}</b></div><div class="opx2-kv"><span>قبل (3 أيام)</span><b>${cell(x.before)}</b></div><div class="opx2-kv"><span>بعد</span><b>${x.after ? cell(x.after) : 'لسه مفيش يوم كامل بعد التعديل'}</b></div><p class="opx2-note">${E(x.note)}</p>`;
}
function showDetail(r) {
  const kv = (k, v) => `<div class="opx2-kv"><span>${k}</span><b>${v}</b></div>`;
  openDrawer(`<button class="opx2-btn sm" data-close style="float:left">إغلاق ✕</button><h2>${E(r.name)}</h2><p class="mut">${E(r.campaignId)} · ${E(r.adAccountId)}${r.productName ? ' · ' + E(r.productName) : ''}${r.budgetLevel ? ' · ' + r.budgetLevel : ''}</p>
    <p>${pill(r.status === 'ACTIVE' ? 'نشطة' : 'متوقفة', r.status === 'ACTIVE' ? 'ok' : 'gray')} ${COLS.winner[1](r)} ${r.protectedC ? pill('محمية', 'brandp') : r.excluded ? pill('مستثناة', 'gray') : ''} ${r.dataFresh ? '' : pill('بيانات قديمة', 'warn')}</p>
    <h3>الأداء</h3>${kv('اليوم: صرف / أوردرات / CPA', `${num(r.today.spend)} / ${num(r.today.orders)} / ${num(r.today.cpa)}`)}${kv('الفترة: صرف / أوردرات / CPA', `${num(r.period.spend)} / ${num(r.period.orders)} / ${num(r.period.cpa)}`)}${r.prev ? kv('الفترة السابقة: صرف / أوردرات / CPA', `${num(r.prev.spend)} / ${num(r.prev.orders)} / ${num(r.prev.cpa)}`) : ''}${kv('CPA: 3 · 7 · 14 · 30 · 60 يوم', [r.cpa.d3, r.cpa.d7, r.cpa.d14, r.cpa.d30, r.cpa.d60].map((x) => num(x)).join(' · '))}${kv('ROAS (Meta) / الإيراد', `${r.period.roas == null ? '—' : num(r.period.roas, 2)} / ${r.period.revenue == null ? '—' : egp(r.period.revenue)}`)}
    ${kv('ميزانية اليوم', r.budget == null ? '—' : `${egp(r.budget)} (${E(r.budgetLevel || '')})`)}${kv('حدود CPA من السياسة', r.zones ? `ممتاز ≤ ${num(r.zones.good)} · مقبول ≤ ${num(r.zones.mid)} · تحذير ≤ ${num(r.zones.warn)}` : '—')}
    <h3 style="margin-top:12px">القرارات والخطط</h3>${kv('قرار مفتوح', r.pendingDecision ? `${E(ACT_AR[r.pendingDecision.action] || r.pendingDecision.action)} — ${E(r.pendingDecision.status)}` : '—')}${kv('خطة اليوم', r.planItem ? `${r.planItem.type === 'OPEN' ? 'فتح' : 'إيقاف'} — الأهلية: ${E(AR[r.planItem.eligibility] || r.planItem.eligibility)}` : 'لم تُقيَّم')}${kv('حالة الموافقة', E(r.approval.label))}
    <h3 style="margin-top:12px">سجل التغييرات</h3>${kv('آخر إيقاف', r.lastPause ? `${dayAgo(r.lastPause)} — ${E(r.lastPause.reason || 'بدون سبب مسجّل')}` : '—')}${kv('آخر تعديل ميزانية', r.lastBudgetChange ? `${dayAgo(r.lastBudgetChange)} (${E(r.lastBudgetChange.action)})${r.lastBudgetChange.reason ? ' — ' + E(String(r.lastBudgetChange.reason).slice(0, 100)) : ''}` : '—')}${kv('آخر صرف فعلي', r.lastActiveDaysAgo == null ? '—' : r.lastActiveDaysAgo === 0 ? 'اليوم' : `قبل ${r.lastActiveDaysAgo} يوم`)}
    <h3 style="margin-top:12px">البيانات</h3>${kv('آخر مزامنة', `${r.dataAgeMin} دقيقة ${r.dataFresh ? '' : '(قديمة)'}`)}${kv('تصنيف Winner', E(r.winner.reason))}
    ${r.operating ? `<h3 style="margin-top:12px">أيام التشغيل الفعلية</h3>${kv('الفترة المحسوبة', r.operating.days ? `${r.operating.days} يوم صرف فعلي من ${E(r.operating.from)} إلى ${E(r.operating.to)} (تمتد على ${r.operating.calendarSpan} يوم تقويمي)` : 'مفيش أيام صرف')}` : ''}
    <h3 style="margin-top:12px">الحدود والربحية</h3>${kv('Target / Reduce / Hard Stop', r.limits ? `${num(r.limits.target)} / ${num(r.limits.reduce)} / ${num(r.limits.hardStop)} — ${r.limits.source === 'PRODUCT_POLICY' ? 'سياسة المنتج' : 'القواعد العامة'}` : 'غير متوفر')}${kv('CPA مقابل الحدود', E(CVL_AR[r.cpaVsLimits] || '—'))}${kv('المخزون', r.stock ? `${STOCK_AR[r.stock.status] || E(r.stock.status)}${r.stock.current != null ? ` (${num(r.stock.current)})` : ''}` : 'غير متوفر — مش مربوطة بمنتج')}
    ${kv('الربح التقديري', r.profit?.value != null ? `${egp(r.profit.value)} <span class="opx2-note">(${E(r.profit.basis)} — تقدير، مش ربح فعلي)</span>` : `غير متوفر — ${E(r.profit?.reason || '')}`)}${kv('حالة الأتمتة', E(AUTO_AR[r.automation] || r.automation))}${kv('أيام خسارة متتالية', r.losingDays == null ? 'غير متوفر (مفيش حد ربحية)' : String(r.losingDays))}${kv('آخر تشغيل فعلي', r.lastRun ? `${r.lastRun.days} يوم ${r.lastRun.daysAgo === 0 ? '(لحد النهارده)' : `(انتهى قبل ${r.lastRun.daysAgo} يوم)`}` : '—')}
    <h3 style="margin-top:12px">حدود الميزانية (سياسة المنتج)</h3>${r.bounds ? `${kv('أقل / أقصى ميزانية', `${r.bounds.minBudget ?? '—'} / ${r.bounds.maxBudget ?? '—'}`)}${kv('سقف الصرف اليومي', r.bounds.dailySpendCap ?? '—')}${kv('أقصى تعديلات في اليوم', r.bounds.maxChangesPerDay ?? '—')}${kv('Cooldown (ساعة)', r.bounds.cooldownHours ?? '—')}` : '<p class="opx2-note">مفيش سياسة منتج مفعّلة — الحدود العامة بيطبّقها محرك الميزانية وقت التجهيز.</p>'}
    <h3 style="margin-top:12px">أثر آخر تعديل ميزانية (قبل / بعد)</h3>${budgetImpactHtml(r)}`);
  document.getElementById('o2Drawer').querySelector('[data-close]').onclick = closeAll;
}
// ---------------------------------------------------------------------------------------------------------------------------------------------
// bulk review (PREVIEW ONLY)
// ---------------------------------------------------------------------------------------------------------------------------------------------
const ACT_TITLE = { OPEN: 'مراجعة فتح الحملات', PAUSE: 'مراجعة إيقاف الحملات', INCREASE_BUDGET: 'مراجعة زيادة الميزانيات', DECREASE_BUDGET: 'مراجعة تقليل الميزانيات', ADD_EXCLUSION: 'إضافة استثناء', REMOVE_EXCLUSION: 'إزالة استثناء' };
function openReview(action) { C.rev = { action, removed: new Set(), params: { mode: 'pct', value: 20, dailyCap: null, cooldownHours: 24 }, data: null, busy: false, confirming: false, notice: null, result: null }; runReview(); }
function reviewBody() {
  const R = C.rev; const body = { action: R.action, params: R.params, excluded: [...(C.sel.all ? C.sel.excl : []), ...R.removed] };
  if (C.sel.all) body.snapshotId = C.sel.snap.id; else { if (C.sel.ids.size > 500) throw new Error('الاختيار اليدوي أقصاه 500 حملة — استخدم «حدد كل المطابق».'); body.ids = [...C.sel.ids.values()]; }
  return body;
}
const CREATABLE = ['OPEN', 'PAUSE', 'INCREASE_BUDGET', 'DECREASE_BUDGET'];
const OUTCOME = { IN_PLAN: ['في الخطة — جاهزة للمراجعة', 'ok'], IN_PLAN_NOT_SELECTED: ['رفضها المحرك', 'warn'], NOT_IN_ENGINE_POOL: ['خارج مرشحي المحرك', 'warn'], DUPLICATE: ['مكررة — موجودة بالفعل', 'info'], CONFLICT: ['تعارض', 'warn'], REJECTED: ['مرفوضة', 'warn'], EXCLUDED: ['مستثناة', 'gray'], PROTECTED: ['محمية', 'brandp'], PREPARED: ['قرار جاهز للمراجعة', 'ok'], NOT_PREPARED: ['لم يُجهَّز', 'warn'], NO_LIVE_DATA: ['بدون بيانات لايف', 'warn'] };
const WHY_NOT = { ALL_CONFLICTED: 'كل الحملات المؤهلة فيها تعارض مع خطة أو قرار مفتوح أو تعديل يدوي أحدث.', NOT_IN_ENGINE_POOL: 'محرك الخطط ما رشّحش أي حملة من الاختيار (مش ضمن حساب الأتمتة المتصل أو مش مؤهلة له).', NONE_SELECTABLE: 'المحرك رفض كل الحملات — الخطة اتلغت تلقائيًا.', NO_LIVE_DATA: 'بنية الميزانية ما اتقرتش لايف من Meta — مفيش تحضير على بيانات قديمة.', NONE_PREPARED: 'محرك الميزانية ما حضّرش أي قرار للحملات دي دلوقتي.' };
async function createDraft() {
  const R = C.rev; if (!R || R.busy) return; R.busy = true; drawReview();
  try {
    const res = await api.post('/api/operator-v2/campaigns/create-plan', { ...reviewBody(), confirm: { hash: R.data.previewHash } }); R.busy = false; R.result = res;
    if (res.created || res.duplicate) { C.sel = freshSel(); load(); }
    drawResult();
  } catch (e) {
    R.busy = false;
    if (e.code === 'PREVIEW_CHANGED') { R.notice = e.message; R.confirming = false; runReview(); return; }
    toast(e.message || 'تعذّر إنشاء المسودة.', 'error'); R.confirming = false; drawReview();
  }
}
function drawResult() {
  const R = C.rev; const x = R.result; const rows = x.results || []; const by = {}; for (const r of rows) by[r.outcome] = (by[r.outcome] || 0) + 1;
  const title = x.created ? (x.kind === 'PLAN' ? `اتجهّزت خطة #${x.planId} — ${x.selected} حملة` : `اتجهّز ${x.prepared} قرار ميزانية`) : x.duplicate ? `خطة مطابقة موجودة بالفعل (#${x.planId} — ${E(x.planStatus)})` : 'ما اتجهّزش حاجة';
  openModal(`<button class="opx2-btn sm" data-close style="float:left">إغلاق ✕</button><h2>${ACT_TITLE[R.action]} — النتيجة</h2>
    <div class="opx2-steps"><span class="done">مسودة ✓</span><span class="${x.created ? 'cur' : ''}">جاهز للمراجعة${x.created ? ' (دلوقتي)' : ''}</span><span>معتمد</span><span class="${x.execution?.available ? '' : 'no'}">مسموح بتنفيذه: ${x.execution?.available ? 'ممكن بعد الاعتماد' : 'لأ'}</span><span>تم تنفيذه</span><span>تعذّر التنفيذ</span></div>
    <div class="opx2-verdict" style="background:var(--${x.created ? 'okbg' : 'warnbg'});color:var(--${x.created ? 'ok' : 'warn'})">${x.created ? '✅' : 'ℹ️'} ${title}${!x.created && x.reason ? ` — ${E(WHY_NOT[x.reason] || x.reason)}` : ''}</div>
    <p class="opx2-note">${x.created ? 'ده <b>مسودة جاهزة للمراجعة</b> فقط: مفيش اعتماد حصل ومفيش حاجة اتنفّذت على Meta. المسؤول هو اللي يعتمدها من «الموافقات والإجراءات»، وبعدها التنفيذ لسه محتاج وضع التشغيل + قفل Meta + الصلاحيات.' : 'مفيش مسودة جديدة اتعملت، ومفيش حاجة اتنفّذت.'}</p>
    <div class="opx2-tot">${Object.entries(by).map(([k, n]) => `<div><b>${n}</b><span>${E((OUTCOME[k] || [k])[0])}</span></div>`).join('')}</div>
    <div class="opx2-tw" style="max-height:34vh"><table><thead><tr><th>الحملة</th><th>النتيجة</th><th>التفاصيل</th></tr></thead><tbody>${rows.map((r) => { const [l, t] = OUTCOME[r.outcome] || [r.outcome, 'gray']; return `<tr><td style="white-space:normal;min-width:200px"><b>${E(r.name || r.campaignId)}</b><span class="sub">${E(r.campaignId)}</span></td><td>${pill(l, t)}</td><td style="white-space:normal;min-width:260px">${E((r.reasons || []).join(' · '))}</td></tr>`; }).join('')}</tbody></table></div>
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">${x.created || x.duplicate ? '<button class="opx2-btn pri" data-goappr="1">فتح «الموافقات والإجراءات»</button>' : '<button class="opx2-btn" data-again="1">رجوع للمعاينة</button>'}<button class="opx2-btn" data-close>إغلاق</button></div>`);
  const m = modalEl(); m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeAll; }); const ga = m.querySelector('[data-goappr]'); if (ga) ga.onclick = () => { closeAll(); C.ctx.openLegacy?.('approvals'); }; const ag = m.querySelector('[data-again]'); if (ag) ag.onclick = runReview;
}
async function runReview() {
  const R = C.rev; if (!R) return; R.busy = true; openModal(`<h2>${ACT_TITLE[R.action]}</h2>${skeleton(5, 38)}<p class="opx2-note">بيراجع كل حملة على بياناتها الحالية (قراءة فقط)…</p>`);
  try {
    R.data = await api.post('/api/operator-v2/campaigns/review-preview', reviewBody()); R.busy = false; R.confirming = false; drawReview();
  } catch (e) { R.busy = false; if (e.status === 410) { C.sel = freshSel(); closeAll(); draw(); toast('لقطة التحديد انتهت — اعمل تحديد جديد.', 'error'); return; } openModal(`<button class="opx2-btn sm" data-close style="float:left">إغلاق ✕</button><h2>${ACT_TITLE[R.action]}</h2>${errorCard(e.message || 'تعذّرت المعاينة.', 'o2RvRetry')}`); const m = modalEl(); m.querySelector('[data-close]').onclick = closeAll; m.querySelector('#o2RvRetry').onclick = runReview; }
}
const KIND_PILL = { ELIGIBLE: ['مقبولة', 'ok'], REJECTED: ['مرفوضة', 'warn'], EXCLUDED: ['مستثناة', 'gray'], PROTECTED: ['محمية', 'brandp'], NOT_FOUND: ['غير موجودة', 'bad'] };
function drawReview() {
  const R = C.rev; const d = R.data; const t = d.totals; const isBud = ['INCREASE_BUDGET', 'DECREASE_BUDGET'].includes(R.action); const ex = d.execution; const p = R.params;
  const canCreate = d.canCreateDraft === true && CREATABLE.includes(R.action) && t.eligible > 0;
  const createBtn = !CREATABLE.includes(R.action) ? '<button class="opx2-btn pri" disabled title="الاستثناءات معاينة فقط في الإصدار ده">إنشاء مسودة غير متاح لهذا الإجراء</button>'
    : !C.ctx.caps.prepareDrafts ? '<button class="opx2-btn pri" disabled title="حسابك مش مسموح له بتجهيز المسودات">إنشاء مسودة غير مسموح لحسابك</button>'
    : !t.eligible ? '<button class="opx2-btn pri" disabled title="مفيش حملة مؤهلة">مفيش حملة مؤهلة</button>'
    : R.confirming ? `<button class="opx2-btn pri" id="o2MkDraft" disabled>تأكيد وإنشاء المسودة (${t.eligible})</button><button class="opx2-btn" data-unconfirm="1">رجوع</button>` : `<button class="opx2-btn pri" id="o2MkDraft">إنشاء مسودة (${t.eligible} حملة) — بدون تنفيذ</button>`;
  const notice = R.notice; R.notice = null;
  openModal(`<button class="opx2-btn sm" data-close style="float:left">إغلاق ✕</button><h2>${ACT_TITLE[R.action]}</h2>${notice ? `<div class="opx2-banner warn">⚠️ ${E(notice)}</div>` : ''}
    <div class="opx2-steps"><span>مرشح</span><span class="cur">جاهز للمراجعة</span><span>معتمد</span><span class="${ex.available ? '' : 'no'}">مسموح بتنفيذه: ${ex.available ? 'ممكن' : 'لأ'}</span><span>تم تنفيذه</span><span>تعذّر التنفيذ</span></div>
    <div class="opx2-verdict" style="background:var(--${ex.available ? 'warnbg' : 'infobg'});color:var(--${ex.available ? 'warn' : 'info'})">${ex.available ? '⚠️ لو الإجراء ده اتحوّل لخطة هيعدّي على الموافقات وبوابات الأمان قبل أي تنفيذ على Meta.' : `ℹ️ التنفيذ على Meta ممنوع حاليًا: ${E(ex.reasons.map((x) => x.message).join(' · '))}`} <div style="font-weight:400;margin-top:4px">${E(ex.note)}</div></div>
    <div class="opx2-tot"><div><b>${t.selected}</b><span>اللي اخترتهم</span></div><div><b style="color:var(--ok)">${t.eligible}</b><span>مؤهلة فعلًا</span></div><div><b style="color:var(--warn)">${t.rejected}</b><span>غير مؤهلة</span></div><div><b>${t.excluded}</b><span>مستثناة</span></div><div><b>${t.protected}</b><span>محمية</span></div><div><b style="color:var(--info)">${t.changed}</b><span>بياناتها اتغيّرت</span></div></div>
    ${t.outOfScope ? `<div class="opx2-banner warn">${t.outOfScope} حملة خارج نطاق حساباتك — اتتجاهلت ومفيش بيانات عنها.</div>` : ''}
    ${isBud ? `<div class="opx2-card" style="padding:12px"><b>إعداد الميزانية</b><div class="opx2-fld"><label>طريقة التغيير <select data-bp="mode"><option value="pct" ${p.mode === 'pct' ? 'selected' : ''}>نسبة %</option><option value="amt" ${p.mode === 'amt' ? 'selected' : ''}>مبلغ (+/−)</option><option value="fix" ${p.mode === 'fix' ? 'selected' : ''}>ميزانية ثابتة جديدة</option></select></label><label>القيمة <input type="number" data-bp="value" value="${p.value ?? ''}"></label><label>سقف الزيادة اليومي <input type="number" data-bp="dailyCap" value="${p.dailyCap ?? ''}" placeholder="بدون"></label><label>Cooldown (ساعة) <input type="number" data-bp="cooldownHours" value="${p.cooldownHours}"></label></div><span class="opx2-note">ABO وCBO بيتعاملوا بشكل منفصل — مفيش تحويل تعديل Ad Set لتعديل Campaign. حدود المنتج والحساب والـ Cooldown النهائية بيفحصها المحرك الحالي عند إنشاء الخطة.</span></div>` : ''}
    <div class="opx2-kv"><span>أثر الإجراء على الميزانية المعرّضة (المقبولة فقط)</span><b>${d.exposure.delta >= 0 ? '+' : ''}${num(d.exposure.delta)} ج.م / يوم</b></div><div class="opx2-kv"><span>لقطة النتائج</span><b>${d.snapshotAt ? ago(d.snapshotAt) : 'اختيار يدوي'} — فحص حي ${ago(d.previewAt)}</b></div>
    <div class="opx2-tw" style="max-height:36vh;margin-top:10px"><table><thead><tr><th>استبعد</th><th>الحملة</th><th>النتيجة</th><th>السبب / تحذير</th>${isBud ? '<th>قبل ← بعد</th>' : ''}</tr></thead><tbody>${d.items.map((i) => { const [kl, kt] = KIND_PILL[i.kind] || [i.kind, 'gray']; return `<tr><td><input type="checkbox" data-rem="${E(i.campaignId)}"></td><td style="white-space:normal;min-width:200px"><b>${E(i.name || i.campaignId)}</b><span class="sub">${E(i.campaignId)}${i.budgetLevel ? ' · ' + i.budgetLevel : ''}</span></td><td>${pill(kl, kt)}${i.changed ? ' ' + pill('اتغيّرت', 'info') : ''}</td><td style="white-space:normal;min-width:260px">${E(i.reasons.join(' · ') || (i.kind === 'ELIGIBLE' ? 'مقبولة مبدئيًا' : ''))}${i.warnings.map((w) => `<span class="sub">• ${E(w)}</span>`).join('')}</td>${isBud ? `<td class="n">${i.before?.budget != null && i.after?.budget != null ? `${num(i.before.budget)} ← ${num(i.after.budget)}` : '—'}</td>` : ''}</tr>`; }).join('')}</tbody></table></div>
    ${R.confirming && canCreate ? `<div class="opx2-card" style="padding:12px;margin-top:12px;border-color:var(--brand)"><b>تأكيد تجهيز المسودة</b>
      <p style="margin:6px 0">هتتجهّز <b>${t.eligible}</b> حملة ${isBud ? 'كقرارات ميزانية' : 'في خطة مستقلة'} بحالة <b>«جاهز للمراجعة»</b>. كل حملة بتتفحص تاني على السيرفر (تعارضات، قرارات مفتوحة، تعديل يدوي أحدث) قبل ما تتجهّز.</p>
      <div class="opx2-grid opx2-g3"><div class="opx2-note"><b>1) حفظ المسودة</b><br>اللي هتعمله دلوقتي — بيجهّز بس، مفيش أثر على Meta.</div><div class="opx2-note"><b>2) الاعتماد</b><br>المسؤول (ADMIN) بس من «الموافقات»، بعد ما يراجع العدد والميزانية المعرّضة.</div><div class="opx2-note"><b>3) التنفيذ</b><br>بعد الاعتماد وبشرط: وضع التشغيل + قفل Meta + الصلاحيات الأربع. حاليًا: ${ex.available ? 'ممكن' : 'ممنوع'}.</div></div>
      ${isBud ? '<p class="opx2-note" style="margin-top:6px">قرارات الميزانية بتتجهّز من محرك الميزانية نفسه (نسبته وحدوده وCooldown بتاعه) — القيمة المكتوبة فوق للمعاينة فقط ومش بتغيّر القرار.</p>' : ''}
      <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="o2Ack"> فاهم إن ده مسودة فقط: مش اعتماد ومش تنفيذ على Meta</label></div>` : ''}
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap"><button class="opx2-btn" data-rev="refresh">🔄 إعادة المعاينة (إعادة فحص الأهلية)</button>${createBtn}<button class="opx2-btn" data-close>إلغاء</button></div>
    <p class="opx2-note">${E(d.createDraftNote)} كل حملة بتتفحص تاني على السيرفر وقت إنشاء الخطة ووقت التنفيذ (Snapshot محدد + Idempotency + سجل تدقيق)، ونتيجة كل حملة بتظهر لوحدها.</p>`);
  const m = modalEl(); m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeAll; });
  m.querySelectorAll('[data-rem]').forEach((c) => { c.checked = R.removed.has(c.dataset.rem); c.onchange = () => { c.checked ? R.removed.add(c.dataset.rem) : R.removed.delete(c.dataset.rem); }; });
  m.querySelectorAll('[data-bp]').forEach((i) => { i.onchange = () => { const k = i.dataset.bp; R.params[k] = k === 'mode' ? i.value : i.value === '' ? null : Number(i.value); runReview(); }; });
  m.querySelector('[data-rev="refresh"]').onclick = runReview;
  const mk = m.querySelector('#o2MkDraft'); const ack = m.querySelector('#o2Ack'); const un = m.querySelector('[data-unconfirm]');
  if (mk && !R.confirming) mk.onclick = () => { R.confirming = true; drawReview(); m.scrollTop = m.scrollHeight; };
  if (mk && R.confirming) { if (R.busy) { mk.disabled = true; mk.textContent = 'بيجهّز…'; } else if (ack) ack.onchange = () => { mk.disabled = !ack.checked; }; mk.onclick = createDraft; }
  if (un) un.onclick = () => { R.confirming = false; drawReview(); };
}
