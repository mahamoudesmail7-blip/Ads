// opx-cpa.js — «قواعد CPA الذكية»: ONE place to set the four CPA points (Bump Start · Bump End · Reduce Start · Hard Stop), the budget steps and limits, globally or per product,
// with the products table (READY / NEEDS_CONFIGURATION / BLOCKED), bulk draft, bulk financial preview and the gated bulk activation.
// It is a screen over the EXISTING engine: global rules (draft ≠ active), product policies (draft ≠ active, AUTOMATIC needs a second explicit confirmation + readiness), bulkActivation. Saving never executes
// anything; the example numbers are only a preview — nothing is applied until the owner saves and approves.
import { api } from './api-client.js';
import { E, num, egp, pill, toast, confirmModal, openDrawer, closeDrawer } from './opx-ui.js';
import { classifyCpa, validateRanges, describeZones, ZONE_META, performanceStatus } from './cpa-zones.js';

const C = { open: new Set(), root: null, ctx: null, ov: null, gl: null, scope: 'GLOBAL', pol: null, eff: null, V: {}, base: {}, touched: new Set(), filter: { q: '', state: '', perf: '', mode: '', store: '' }, period: (() => { try { return localStorage.getItem('opx.cpa.period') || 'last3'; } catch { return 'last3'; } })(), sort: 'attention', sel: new Set(), test: '' };
// form field → [group, key] in the policy
const MAP = { bumpStart: ['cpa', 'scaleMin'], bumpEnd: ['cpa', 'scale'], reduceStart: ['cpa', 'reduce'], hardStop: ['cpa', 'hardStop'], incPct: ['budget', 'increasePct'], decPct: ['budget', 'decreasePct'], minOrders: ['budget', 'minPurchases'], cooldown: ['budget', 'cooldownHours'], maxChanges: ['budget', 'maxChangesPerDay'],
  zeroSpend: ['zeroOrder', 'spend'], minBudget: ['budget', 'minBudget'], maxBudget: ['budget', 'maxBudget'], dailyCap: ['budget', 'dailySpendCap'], window: ['zeroOrder', 'windowDays'], manualHours: [null, 'manualOverrideHours'] };
const RANGE = { bumpStart: [0, 100], bumpEnd: [20, 200], reduceStart: [50, 300], hardStop: [100, 400], incPct: [5, 50], decPct: [5, 50], minOrders: [1, 20], cooldown: [6, 72], maxChanges: [1, 10], zeroSpend: [50, 1000] };
const LABEL = { bumpStart: 'بداية نطاق الزيادة (ج)', bumpEnd: 'نهاية الزيادة وبداية التثبيت (ج)', reduceStart: 'بداية تقليل الميزانية (ج)', hardStop: 'بداية الإيقاف (ج)', incPct: 'نسبة زيادة الميزانية', decPct: 'نسبة تقليل الميزانية', minOrders: 'الحد الأدنى للأوردرات', cooldown: 'Cooldown (ساعة)', maxChanges: 'أقصى تعديل ميزانية/يوم', zeroSpend: 'الحد الصرف بدون أوردرات (ج)', minBudget: 'أقل ميزانية للحملة', maxBudget: 'أقصى ميزانية للحملة', dailyCap: 'الحد الأقصى لميزانية المنتج (ج/يوم)' };
const PCT = new Set(['incPct', 'decPct']);
// «تفاصيل» above every box: what it is · what to type · a worked example · what an empty box means. The numbers in the examples are illustrations only — nothing is applied from them.
const EMPTY = 'لو سيبته فاضي: بيستخدم القيمة العامة (لو القواعد العامة معتمدة)، ولو مفيش قيمة عامة يبقى المنتج ناقص إعداد.';
const DETAILS = {
  bumpStart: { what: 'أقل تكلفة أوردر (CPA) نسمح عندها بزيادة الميزانية.', type: 'رقم بالجنيه، أقل من «نهاية الزيادة».', ex: 'لو كتبت 20: أي حملة تكلفة الأوردر فيها أقل من 20 جنيه، السيستم مش هيزوّد ميزانيتها لوحده. رقم قليل كده غالبًا غريب (أوردرات قليلة أو بيانات ناقصة) ومحتاج تراجعه بنفسك.', empty: 'لو سيبته فاضي: مفيش حد أدنى، والسيستم يزوّد مهما كان الـCPA قليل.' },
  bumpEnd: { what: 'آخر تكلفة أوردر لسه تعتبر ممتازة وتستاهل زيادة.', type: 'رقم بالجنيه، أكبر من «بداية الزيادة» وأقل من «بداية التقليل».', ex: 'لو كتبت 100: أي حملة تكلفة الأوردر فيها من 20 لحد 100 جنيه (الرقمين داخلين) الميزانية تزيد بالنسبة المكتوبة في «نسبة زيادة الميزانية». لو الـCPA 100.5 أو أكتر، بتتثبّت.', empty: EMPTY },
  reduceStart: { what: 'التكلفة اللي من عندها الحملة تبقى ضعيفة ونبدأ نقلّل ميزانيتها.', type: 'رقم بالجنيه، أكبر من «نهاية الزيادة». الفرق بينهم هو منطقة «التثبيت» اللي مفيهاش أي تغيير.', ex: 'لو كتبت 130: من 130 لحد «بداية الإيقاف» الميزانية تقل بنسبة «نسبة تقليل الميزانية». وأي CPA بين 100 و130 مفيش فيه تغيير.', empty: EMPTY },
  hardStop: { what: 'التكلفة اللي لو الحملة عدّتها تبقى بتخسّر بوضوح، فتتوقف.', type: 'رقم بالجنيه، أكبر من أو يساوي «بداية التقليل». فكّر فيه كأقصى تكلفة أوردر تتحمّلها وإنت لسه مش خسران.', ex: 'لو كتبت 200: أي حملة تكلفة الأوردر فيها أكبر من 200 جنيه (مثلًا 201) السيستم يوقفها، بس بعد ما يتأكد إن فيه أوردرات كفاية، وإن الحملة مش Winner، وإنك ما غيّرتهاش يدويًا قريب، ويقرا حالتها من Meta. والـCPA 200 نفسه لسه تقليل مش إيقاف.', empty: EMPTY },
  maxChanges: { what: 'كام مرة في اليوم نسمح للسيستم يغيّر ميزانية نفس الحملة (زيادة أو تقليل).', type: 'رقم صحيح من 1 لـ 10.', ex: '1 = تعديل واحد بس في اليوم لكل حملة، حتى لو الأداء اتغيّر. ده بيحميك من تغييرات كتير ورا بعض.', empty: EMPTY },
  cooldown: { what: 'عدد الساعات اللي السيستم يستنى فيها بعد أي تعديل ميزانية قبل ما يعدّل نفس الحملة تاني.', type: 'عدد ساعات من 6 لـ 72.', ex: '24 = لو السيستم زوّد الميزانية الساعة 12 بالليل، ما يلمسهاش تاني قبل 12 بالليل اليوم اللي بعده. ده عشان نشوف أثر الزيادة على أوردرات جديدة قبل أي خطوة تانية.', empty: EMPTY },
  zeroSpend: { what: 'المبلغ اللي لو الحملة صرفته من غير ولا أوردر نعتبرها بتحرق فلوس.', type: 'مبلغ بالجنيه (من 50 لحد 100000).', ex: '200 = حملة صرفت 200 جنيه ومفيش ولا أوردر، فالسيستم يوقفها بعد ما يتأكد من الشروط (عمر الحملة، وإنها مش بتتحسن النهارده). القاعدة دي مالهاش علاقة بنطاقات الـCPA فوق.', empty: EMPTY },
  minOrders: { what: 'أقل عدد أوردرات لازم يكون عند الحملة قبل ما السيستم يثق في تكلفة الأوردر. (CPA ممتاز من أوردر واحد مش دليل.)', type: 'رقم صحيح من 1 لـ 20.', ex: '5 = السيستم مش هيزوّد ولا يقلّل إلا لما الحملة يبقى عندها 5 أوردرات على الأقل في نافذة التقييم. قبل كده بيستنى.', empty: EMPTY },
  decPct: { what: 'النسبة اللي بتتشال من الميزانية في كل خطوة تقليل.', type: 'نسبة من 5% لـ 50%.', ex: '20% = ميزانية 300 جنيه تبقى 240 جنيه. والخطوة اللي بعدها لازم تستنى «Cooldown».', empty: EMPTY },
  incPct: { what: 'النسبة اللي بتتضاف للميزانية في كل خطوة زيادة.', type: 'نسبة من 5% لـ 50%.', ex: '20% = ميزانية 300 جنيه تبقى 360 جنيه. والخطوة اللي بعدها لازم تستنى «Cooldown» وأوردرات جديدة.', empty: EMPTY },
  maxBudget: { what: 'أقصى ميزانية يومية توصلها الحملة الواحدة بالزيادة التلقائية.', type: 'مبلغ بالجنيه في اليوم، أكبر من أو يساوي «أقل ميزانية».', ex: '600 = لو الميزانية الجديدة هتعدّي 600 جنيه، السيستم مش هيعمل الزيادة دي.', empty: EMPTY },
  minBudget: { what: 'أقل ميزانية يومية تنزل لها الحملة بالتقليل التلقائي.', type: 'مبلغ بالجنيه في اليوم، أقل من أو يساوي «أقصى ميزانية».', ex: '200 = لو التقليل هيخلي الميزانية 180 جنيه، السيستم مش هيقلّل. ولو عايز تنزّل أكتر أو توقف الحملة، اعملها بنفسك.', empty: EMPTY },
  dailyCap: { what: 'أقصى مجموع لميزانيات كل حملات نفس المنتج في اليوم.', type: 'مبلغ بالجنيه في اليوم، لازم يكون أكبر من أو يساوي «أقصى ميزانية للحملة».', ex: '600 = لو المنتج عنده 3 حملات مجموع ميزانياتهم 580، زيادة 120 مش هتتنفّذ لأن المجموع هيبقى 700، أكبر من 600.', empty: EMPTY },
  window: { what: 'الفترة اللي السيستم بيقيس فيها أداء الحملة (تكلفة الأوردر وعدد الأوردرات).', type: 'اختار «آخر 3 أيام» أو «آخر 7 أيام».', ex: 'آخر 3 أيام: يتفاعل أسرع مع التغيير. آخر 7 أيام: أهدى وأثبت لكن أبطأ.', empty: 'Today وآخر 30 يوم لسه مش مدعومين في محرك الميزانيات.' },
};
const moreBtn = (k) => (DETAILS[k] ? `<button type="button" class="cpa-more" data-more="${k}" aria-expanded="${C.open.has(k)}" title="اضغط تفاصيل تفهم المربع ده بيعمل إيه">تفاصيل</button>` : '');
const popOf = (k) => { const d = DETAILS[k]; if (!d) return ''; const row = (t, x) => `<p><b>${t}</b> ${E(x)}</p>`; return `<div class="cpa-pop" data-pop="${k}" ${C.open.has(k) ? '' : 'hidden'}>${row('ده إيه؟', d.what)}${row('أكتب إيه؟', d.type)}${row('مثال:', d.ex)}<p class="cpa-pop-empty">${E(d.empty)}</p></div>`; };
const SRC_AR = { GLOBAL: 'عام', PRODUCT: 'المنتج', CAMPAIGN: 'الحملة', DEFAULT: 'افتراضي', UNSET: 'غير محدد' };
const isAdmin = () => !!C.ctx?.isAdmin;
const val = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const policyOf = () => (C.scope === 'GLOBAL' ? (C.gl?.draft || C.gl?.active || {}) : (C.pol?.draft || C.pol?.active || {}));
const fromPolicy = (p) => Object.fromEntries(Object.entries(MAP).map(([k, [g, f]]) => [k, g ? (p?.[g]?.[f] ?? null) : (p?.[f] ?? null)]));
const srcKey = (k) => { const [g, f] = MAP[k]; return g ? `${g}.${f}` : f; };

export async function mountCpaBoard(root, ctx) {
  C.root = root; C.ctx = ctx; root.innerHTML = '<div class="opx-card"><div class="opx-note">⏳ بيحمّل قواعد CPA…</div></div>';
  try { await loadAll(); draw(); } catch (e) { root.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message || 'تعذّر التحميل')}${isAdmin() ? '' : ' — الشاشة دي للـADMIN فقط.'}</div>`; }
}
async function loadAll() {
  const [ov, gl] = await Promise.all([api.get('/api/operator/automation/overview'), api.get('/api/operator/automation/global-rules')]);
  C.ov = ov; C.gl = gl; await loadScope();
}
async function loadScope() {
  C.touched = new Set(); C.pol = null; C.eff = null;
  if (C.scope !== 'GLOBAL') {
    const p = C.ov.products.find((x) => x.key === C.scope); const [pid, store] = [p.productId, p.storeId || 'default'];
    const [pol, eff] = await Promise.all([api.get(`/api/operator/product-rules/${pid}`, { store }), api.get(`/api/operator/product-rules/${pid}/effective`, { store })]); C.pol = pol; C.eff = eff;
    const own = fromPolicy(policyOf()); const V = {};
    for (const k of Object.keys(MAP)) V[k] = own[k] ?? C.eff.sources?.[srcKey(k)]?.value ?? null; // an unset field shows the inherited value (tagged with its source)
    C.V = V; C.base = { ...V };
  } else { C.V = fromPolicy(policyOf()); C.base = { ...C.V }; }
  C.test = '';
}
const ranges = () => ({ bumpStart: C.V.bumpStart, bumpEnd: C.V.bumpEnd, reduceStart: C.V.reduceStart, hardStop: C.V.hardStop });
const axisMax = () => { const m = Math.max(250, Number(C.V.hardStop) || 0, Number(C.V.reduceStart) || 0); return Math.ceil((m * 1.3) / 50) * 50; };

function kpis() {
  const t = C.ov.totals || {}; const win = (C.V.window === 7 ? '7 أيام' : '3 أيام');
  const k = (label, value, tone, icon) => `<div class="cpa-kpi"><div class="cpa-kpi-ic ${tone}">${icon}</div><div><b>${value}</b><span>${E(label)}</span></div></div>`;
  return `<div class="cpa-kpis">${k('نافذة القياس', win, 'blue', '⏱')}${k('محجوز (مخزون)', num(C.ov.products.filter((p) => (p.missing || []).some((m) => /مخزون|stock/i.test(m.label + m.key))).length), 'red', '📦')}${k('يحتاج إعداد', num(t.NEEDS_CONFIGURATION), 'amber', '⚙')}${k('جاهز للتشغيل', num(t.READY), 'green', '✔')}${k('حملة مرتبطة', num(t.mappedCampaigns), 'violet', '📣')}${k('منتج في النظام', num(t.products), 'blue', '▣')}</div>`;
}
function scopeSelect() {
  const opts = [`<option value="GLOBAL" ${C.scope === 'GLOBAL' ? 'selected' : ''}>كل المنتجات المؤهلة (القواعد العامة)</option>`, ...C.ov.products.map((p) => `<option value="${E(p.key)}" ${C.scope === p.key ? 'selected' : ''}>${E(p.name)}</option>`)];
  return `<select class="opx-input" id="cpaScope">${opts.join('')}</select>`;
}
const srcTag = (k) => { if (C.scope === 'GLOBAL') return ''; const s = C.eff?.sources?.[srcKey(k)]; const own = C.touched.has(k) || (fromPolicy(policyOf())[k] != null); const src = own ? 'PRODUCT' : (s?.source || 'UNSET'); return `<em class="cpa-src ${src.toLowerCase()}" title="مصدر القيمة">${SRC_AR[src]}${src === 'GLOBAL' && s?.version ? ' v' + s.version : ''}</em>`; };
function numField(k) {
  const [lo, hi] = RANGE[k] || [0, 1000]; const v = C.V[k]; const pct = PCT.has(k);
  return `<div class="cpa-f" data-f="${k}"><label><span>${E(LABEL[k])} ${srcTag(k)}</span>${moreBtn(k)}</label>${popOf(k)}
    <div class="cpa-inp"><input class="opx-input mono" type="number" min="0" step="any" data-n="${k}" value="${v ?? ''}" ${isAdmin() ? '' : 'disabled'} placeholder="—">${pct ? '<span class="cpa-unit">%</span>' : ''}</div>
    ${RANGE[k] ? `<input type="range" class="cpa-range" data-r="${k}" min="${lo}" max="${hi}" step="1" value="${v ?? lo}" ${isAdmin() ? '' : 'disabled'}><div class="cpa-rr"><span>${lo}${pct ? '%' : ''}</span><span>${hi}${pct ? '%' : ''}</span></div>` : ''}</div>`;
}
function zonesHtml() {
  const z = describeZones(ranges()); const tone = { BUMP: 'g', HOLD: 'n', REDUCE: 'a', STOP: 'r' };
  return `<div class="cpa-zones">${[...z].reverse().map((x) => `<div class="cpa-zone ${tone[x.zone]}" data-zone="${x.zone}" title="${E(x.note)}"><small>${E(x.label.replace(' (وفق شروط الأمان)', ''))}</small><b>${E(x.text)}${x.zone === 'STOP' || /—/.test(x.text) ? '' : ' ج'}</b></div>`).join('')}</div>`;
}
function sliderHtml() {
  const AX = axisMax(); const r = ranges(); const pos = (v) => (v == null ? null : Math.min(100, Math.max(0, (v / AX) * 100)));
  const handles = ['bumpStart', 'bumpEnd', 'reduceStart', 'hardStop'].map((k) => (C.V[k] == null ? '' : `<button class="cpa-handle" data-h="${k}" style="left:${pos(C.V[k])}%" title="${E(LABEL[k])}" ${isAdmin() ? '' : 'disabled'} aria-label="${E(LABEL[k])}"><i>${C.V[k]}</i></button>`)).join('');
  const marks = []; for (let t = 0; t <= AX; t += AX / 10) marks.push(`<span style="left:${(t / AX) * 100}%">${Math.round(t)}</span>`);
  const cur = C.scope !== 'GLOBAL' ? C.ov.products.find((p) => p.key === C.scope)?.cpa?.d3 : null;
  return `<div class="cpa-track-wrap"><div class="cpa-track" id="cpaTrack" style="background:${trackBg(r, AX)}">${handles}${cur != null ? `<div class="cpa-now" style="left:${pos(cur)}%" title="CPA الحالي (3 أيام)"><i>${cur}</i></div>` : ''}</div><div class="cpa-axis">${marks.join('')}<em>CPA (جنيه)</em></div></div>`;
}
function trackBg(r, AX) {
  if ([r.bumpStart, r.bumpEnd, r.reduceStart, r.hardStop].every((v) => v == null)) return '#e3e8f2'; // no points yet: a neutral track, never an invented zone
  const p = (v) => (v == null ? null : Math.min(100, (v / AX) * 100)); const s = p(r.bumpStart) ?? 0, b = p(r.bumpEnd) ?? s, rd = p(r.reduceStart) ?? b, h = p(r.hardStop) ?? rd;
  return `linear-gradient(90deg,#d5dbe8 0 ${s}%,#34c38f ${s}% ${b}%,#aab3c5 ${b}% ${rd}%,#f5a524 ${rd}% ${h}%,#ef4444 ${h}% 100%)`;
}
function previewLine() {
  const errs = validateRanges(ranges()); if (errs.length) return `<div class="cpa-msg bad">⚠️ ${E(errs[0])}</div>`;
  const t = val(C.test); const z = t == null ? null : classifyCpa(t, ranges()); const m = z && ZONE_META[z];
  const action = { BUMP: `زيادة ${C.V.incPct ?? '—'}%`, HOLD: 'مفيش تغيير', REDUCE: `تقليل ${C.V.decPct ?? '—'}%`, STOP: 'إيقاف وفق شروط الأمان (عينة كافية · حماية الـWinner · لا تعديل يدوي حديث · Live Preflight)', BELOW_BUMP: 'مفيش زيادة تلقائية — رقم منخفض بشكل غير معتاد، راجعه', NONE: '—' }[z] || '';
  return `<div class="cpa-test"><label>جرّب CPA <input class="opx-input mono" type="number" min="0" id="cpaTest" value="${E(C.test)}" placeholder="مثال 95"></label>${z ? `<span class="cpa-verdict ${m.tone}">القرار المتوقع: <b>${E(m.label)}</b> — ${E(action)}</span>` : '<span class="opx-note">اكتب CPA وشوف القرار المتوقع. الأرقام دي معاينة فقط — مفيش حاجة بتتطبق قبل ما تحفظ وتعتمد.</span>'}</div>`;
}
function protections() {
  const pz = C.ov.global || {};
  const row = (label, on, note) => `<div class="cpa-prot"><span class="cpa-sw ${on ? 'on' : ''}" aria-hidden="true"></span><div><b>${E(label)}</b><small>${E(note)}</small></div></div>`;
  return `<div class="cpa-prots">${row('حماية الحملات الرابحة', true, 'جزء من سياسة الإيقاف المعتمدة (Winner Protection)')}${row('حماية التحسن الحاد', true, 'لو الحملة اتحسنت النهارده، الإيقاف بسبب CPA عالي بيتأجل')}${row('حماية التعديل اليدوي', true, `بعد أي تعديل يدوي الأتمتة بتقف على الحملة ${C.V.manualHours ?? 24} ساعة`)}${pz.pausePolicyApproved ? '' : '<div class="cpa-msg bad">سياسة الإيقاف مش معتمدة — الحمايات دي مش شغّالة قبل اعتمادها.</div>'}</div>`;
}
function board() {
  const gl = C.gl; const status = C.scope === 'GLOBAL' ? ({ NONE: 'غير محفوظة', DRAFT: 'مسودة', ACTIVE: `معتمدة v${gl.version}`, ACTIVE_WITH_DRAFT: `معتمدة v${gl.version} + مسودة جديدة` }[gl.status] || gl.status) : ({ NONE: 'مفيش سياسة للمنتج', DRAFT: 'مسودة', ACTIVE: `معتمدة v${C.pol?.version ?? ''}`, ACTIVE_WITH_DRAFT: `معتمدة + مسودة` }[C.pol?.status] || '');
  return `<div class="opx-card cpa-card"><div class="cpa-head"><div><h2>قواعد CPA الذكية</h2><p>حدد نطاقات تكلفة الأوردر (CPA) لكل منتج أو طبّق على مجموعة منتجات. الحفظ مش تنفيذ — التنفيذ بعد الاعتماد وبوضع AUTOMATIC.</p></div>
      <div class="cpa-scope">${scopeSelect()}<span class="cpa-status">${pill(E(status), C.scope === 'GLOBAL' ? 'violet' : 'blue')}</span></div></div>
    <details class="cpa-guide"><summary>إزاي أملا الأرقام؟ (دليل سريع)</summary><div><p>الـCPA = تكلفة الأوردر الواحد. بتحط <b>4 أرقام</b> بالترتيب من الأقل للأعلى، والسيستم يقسّم الـCPA لـ4 مناطق:</p><ol><li><b>بداية الزيادة ← نهاية الزيادة:</b> الأداء ممتاز → <b>يزوّد</b> الميزانية.</li><li><b>بعد نهاية الزيادة ← قبل بداية التقليل:</b> الأداء مقبول → <b>تثبيت</b> (مفيش تغيير).</li><li><b>بداية التقليل ← بداية الإيقاف:</b> الأداء ضعيف → <b>يقلّل</b> الميزانية.</li><li><b>فوق بداية الإيقاف:</b> خسارة واضحة → <b>إيقاف</b> بشروط الأمان.</li></ol><p>مثال للتوضيح بس: 20 / 100 / 130 / 200. الباقي (النسب والحدود) بيتحكم في «بكام» و«كام مرة» و«بعد كام أوردر». أي خانة فاضية = بترث القيمة العامة. <b>الحفظ مش تنفيذ</b>: مفيش حاجة بتتطبق قبل «اعتماد» ووضع AUTOMATIC.</p></div></details>
    ${zonesHtml()}${sliderHtml()}${['bumpStart', 'bumpEnd', 'reduceStart', 'hardStop'].every((k) => C.V[k] == null) && isAdmin() ? '<div class="cpa-empty"><span>لسه ما حدّدتش نقاط الـCPA. اكتبها في الخانات تحت، أو جرّب أرقام مثال للمعاينة فقط.</span><button class="opx-btn sm" data-act="example">جرّب أرقام مثال (20 · 100 · 130 · 200)</button></div>' : ''}
    <div class="cpa-grid4">${['hardStop', 'reduceStart', 'bumpEnd', 'bumpStart'].map(numField).join('')}</div>
    ${previewLine()}
    <div class="cpa-grid6">${['maxChanges', 'cooldown', 'zeroSpend', 'minOrders', 'decPct', 'incPct'].map(numField).join('')}</div>
    <div class="cpa-grid3">${['maxBudget', 'minBudget', 'dailyCap'].map(numField).join('')}${windowField()}</div>
    ${protections()}
    <div class="cpa-actions">${isAdmin() ? `<button class="opx-btn" data-act="save">${C.scope === 'GLOBAL' ? 'حفظ كمسودة العامة' : 'حفظ مسودة المنتج'}</button><button class="opx-btn primary" data-act="activate">${C.scope === 'GLOBAL' ? 'اعتماد القواعد العامة' : 'اعتماد سياسة المنتج'}</button>
      <button class="opx-btn" data-act="applysel" title="يكتب القيم دي كمسودة على المنتجات المحددة في الجدول">تطبيق على المحدد (${C.sel.size})</button><button class="opx-btn" data-act="impact">معاينة التأثير المالي</button>` : '<span class="opx-note">للمراجعة فقط — التعديل للـADMIN.</span>'}<span class="opx-note" id="cpaMsg"></span></div></div>`;
}
const windowField = () => `<div class="cpa-f" data-f="window"><label><span>نافذة التقييم ${srcTag('window')}</span>${moreBtn('window')}</label>${popOf('window')}<select class="opx-input" data-n="window" ${isAdmin() ? '' : 'disabled'}><option value="3" ${C.V.window === 3 || C.V.window == null ? 'selected' : ''}>آخر 3 أيام</option><option value="7" ${C.V.window === 7 ? 'selected' : ''}>آخر 7 أيام</option></select></div>`;

// ================= the products dashboard: filters · period · performance status per product =================
const PERIODS = [['today', 'اليوم'], ['last3', '3 أيام'], ['last7', '7 أيام'], ['last30', '30 يوم']];
const GROUP = { BUMP: 'good', HOLD: 'ok', REDUCE: 'weak', ZERO_ORDERS: 'weak', STOP: 'bad', ZERO_ORDERS_OVER: 'bad', LOW_SAMPLE: 'low', BELOW_BUMP: 'low', NO_SPEND: 'none', NO_RANGES: 'none' };
const GROUP_META = { good: { label: 'حققوا الهدف', tone: 'green', ic: '🎯' }, ok: { label: 'مقبول (تثبيت)', tone: 'gray', ic: '⚖' }, weak: { label: 'ضعيف', tone: 'amber', ic: '⚠' }, bad: { label: 'خسارة / إيقاف', tone: 'red', ic: '⛔' }, low: { label: 'عينة قليلة', tone: 'blue', ic: '🔎' }, none: { label: 'بدون صرف / غير محدد', tone: 'gray', ic: '—' } };
const PERF_ICON = { BUMP: '🎯', HOLD: '⚖', REDUCE: '📉', STOP: '⛔', ZERO_ORDERS_OVER: '🔥', ZERO_ORDERS: '⏳', LOW_SAMPLE: '🔎', BELOW_BUMP: '❓', NO_SPEND: '💤', NO_RANGES: '⚙' };
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
const rangesOf = (l) => ({ bumpStart: l.cpaScaleMin, bumpEnd: l.cpaScale, reduceStart: l.cpaReduce, hardStop: l.hardStop });
function perfRow(p) {
  const w = p.perf?.[C.period] || { spend: 0, orders: 0, cpa: null }; const l = p.limits || {}; const ranges = rangesOf(l);
  const st = performanceStatus({ cpa: w.cpa, orders: w.orders, spend: w.spend, ranges, minOrders: l.minPurchases, zeroSpend: l.zeroSpend });
  return { p, w, ranges, st, group: GROUP[st.code] };
}
function dashRows() {
  const f = C.filter; const q = f.q.trim().toLowerCase();
  let rows = C.ov.products.map(perfRow).filter(({ p, group }) => (!q || p.name.toLowerCase().includes(q) || String(p.productId) === q.replace('#', '')) && (!f.state || p.state === f.state) && (!f.perf || group === f.perf) && (!f.mode || (p.policy.mode || 'NONE') === f.mode) && (!f.store || p.storeId === f.store));
  const by = { attention: (a, b) => a.st.rank - b.st.rank || (b.w.spend - a.w.spend), cpa: (a, b) => (b.w.cpa ?? -1) - (a.w.cpa ?? -1), cpaAsc: (a, b) => (a.w.cpa ?? 1e9) - (b.w.cpa ?? 1e9), orders: (a, b) => b.w.orders - a.w.orders, spend: (a, b) => b.w.spend - a.w.spend, name: (a, b) => a.p.name.localeCompare(b.p.name, 'ar') }[C.sort] || null;
  return by ? rows.sort(by) : rows;
}
function rangeBar(ranges, cpa) {
  const AX = Math.max(250, (ranges.hardStop || ranges.reduceStart || ranges.bumpEnd || 0) * 1.3, (cpa || 0) * 1.1); const pos = (v) => Math.min(100, Math.max(0, (v / AX) * 100));
  const has = [ranges.bumpStart, ranges.bumpEnd, ranges.reduceStart, ranges.hardStop].some((v) => v != null);
  return `<div class="cpa-rbar" style="background:${has ? trackBg(ranges, AX) : '#e3e8f2'}">${cpa != null ? `<i style="left:${pos(cpa)}%" title="CPA الحالي ${Math.round(cpa)}"></i>` : ''}</div>`;
}
function rowHtml({ p, w, ranges, st }) {
  const ST = { READY: ['جاهز', 'green'], NEEDS_CONFIGURATION: ['يحتاج إعداد', 'amber'], BLOCKED: ['ممنوع', 'red'] }; const [stl, stTone] = ST[p.state] || ['—', 'gray'];
  const auto = p.policy.mode === 'AUTOMATIC' && String(p.policy.status).startsWith('ACTIVE'); const why = p.state === 'READY' ? '' : (p.blockedReason || (p.missing || []).map((m) => m.label).join(' · '));
  const trio = PERIODS.map(([k, l]) => `<span class="${k === C.period ? 'on' : ''}" title="${E(l)}"><em>${E(l.replace(' يوم', 'ي').replace(' أيام', 'د'))}</em>${p.perf?.[k]?.cpa != null ? num(p.perf[k].cpa) : '—'}</span>`).join('');
  return `<div class="cpa-prow t-${st.tone} ${C.scope === p.key ? 'cur' : ''}" data-row="${E(p.key)}">
    <div class="c-sel"><input type="checkbox" data-sel="${E(p.key)}" ${C.sel.has(p.key) ? 'checked' : ''} aria-label="تحديد ${E(p.name)}"></div>
    <div class="c-prod"><b title="${E(p.name)}">${E(p.name)}</b><span class="cpa-chips"><i>#${p.productId}</i><i>${E(p.storeId || '')}</i>${pill(stl, stTone)}</span>${why ? `<small class="cpa-why">${E(why)}</small>` : ''}</div>
    <div class="c-stat"><span class="cpa-badge ${st.tone}">${PERF_ICON[st.code] || ''} ${E(st.label)}</span><small>${E(st.detail)}</small></div>
    <div class="c-cpa"><div class="cpa-big">${w.cpa != null ? num(w.cpa) : '—'}<u>ج</u></div>${rangeBar(ranges, w.cpa)}<div class="cpa-trio">${trio}</div></div>
    <div class="c-num"><b>${num(w.orders)}</b><small>أوردر</small><b class="sp">${num(w.spend)}</b><small>جنيه صرف</small></div>
    <div class="c-camp"><b>${num(p.campaigns.active)}<span>/${num(p.campaigns.mapped)}</span></b><small>حملات شغالة/مرتبطة</small><small>ميزانية شغالة ${num(p.runningBudget)} ج</small></div>
    <div class="c-mode"><button class="cpa-mode ${auto ? 'auto' : ''}" data-mode="${E(p.key)}" ${isAdmin() ? '' : 'disabled'} title="${auto ? 'AUTOMATIC شغّال — اضغط للرجوع لـAPPROVAL' : p.state === 'READY' ? 'اضغط لتفعيل AUTOMATIC (بتأكيد صريح)' : 'مش جاهز — مينفعش AUTOMATIC'}"><span class="cpa-sw ${auto ? 'on' : ''}"></span><b>${auto ? 'AUTOMATIC' : (p.policy.mode || 'APPROVAL')}</b></button></div>
    <div class="c-act"><button class="opx-btn sm" data-edit="${E(p.key)}" title="ضبط قواعد المنتج" aria-label="ضبط قواعد ${E(p.name)}">⚙</button></div></div>`;
}
function listHtml() {
  const rows = dashRows(); if (!rows.length) return '<div class="cpa-none">مفيش منتجات بالفلتر ده. جرّب تمسح الفلاتر.</div>';
  return `<div class="cpa-phead"><div class="c-sel"><input type="checkbox" id="cpaAll" aria-label="تحديد الكل"></div><div class="c-prod">المنتج</div><div class="c-stat">الحالة (هل وصلت للهدف؟)</div><div class="c-cpa">CPA وموقعه من النطاقات</div><div class="c-num">الأوردرات والصرف</div><div class="c-camp">الحملات</div><div class="c-mode">الوضع</div><div class="c-act"></div></div>${rows.map(rowHtml).join('')}`;
}
function summaryHtml() {
  const all = C.ov.products.map(perfRow); const cnt = (g) => all.filter((r) => r.group === g).length;
  return `<div class="cpa-sum">${Object.entries(GROUP_META).map(([g, m]) => `<button class="cpa-sumchip ${m.tone} ${C.filter.perf === g ? 'on' : ''}" data-grp="${g}"><span>${m.ic}</span><b>${num(cnt(g))}</b><em>${E(m.label)}</em></button>`).join('')}</div>`;
}
function dash() {
  const t = C.ov.totals || {}; const g = C.ov.global || {}; const w = C.ov.windows?.[C.period]; const stores = [...new Set(C.ov.products.map((p) => p.storeId).filter(Boolean))];
  const at = C.ov.generatedAt ? new Date(C.ov.generatedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';
  const sel = (id, label, opts, cur) => `<label class="cpa-sel"><span>${label}</span><select class="opx-input" id="${id}">${opts.map(([v, l]) => `<option value="${E(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${E(l)}</option>`).join('')}</select></label>`;
  return `<div class="opx-card cpa-dash"><div class="cpa-dash-head"><div><h3>لوحة أداء المنتجات</h3><p>كل منتج وحالته: هل حملاته وصلت للهدف وللتكلفة الممتازة ولا لأ — حسب نقاط الـCPA بتاعته.</p></div>
      <div class="cpa-periods" role="tablist" aria-label="الفترة">${PERIODS.map(([k, l]) => `<button role="tab" class="${C.period === k ? 'on' : ''}" data-period="${k}" aria-selected="${C.period === k}">${E(l)}</button>`).join('')}<span class="cpa-range-txt">${w ? (w.from === w.to ? `📅 ${dmy(w.from)}` : `📅 من ${dmy(w.from)} إلى ${dmy(w.to)}`) : ''}${at ? ` · آخر تحديث ${E(at)}` : ''}</span></div></div>
    <div id="cpaSum">${summaryHtml()}</div>
    <div class="cpa-filters"><input class="opx-input" id="cpaQ" placeholder="🔍 ابحث باسم المنتج أو رقمه…" value="${E(C.filter.q)}">
      ${sel('cpaFState', 'الجاهزية', [['', 'الكل'], ['READY', `جاهز (${num(t.READY)})`], ['NEEDS_CONFIGURATION', `يحتاج إعداد (${num(t.NEEDS_CONFIGURATION)})`], ['BLOCKED', `ممنوع (${num(t.BLOCKED)})`]], C.filter.state)}
      ${sel('cpaFPerf', 'حالة الأداء', [['', 'الكل'], ...Object.entries(GROUP_META).map(([k, m]) => [k, m.label])], C.filter.perf)}
      ${sel('cpaFMode', 'الوضع', [['', 'الكل'], ['AUTOMATIC', 'AUTOMATIC'], ['APPROVAL', 'APPROVAL'], ['NONE', 'بدون سياسة']], C.filter.mode)}
      ${stores.length > 1 ? sel('cpaFStore', 'المتجر', [['', 'كل المتاجر'], ...stores.map((s) => [s, s])], C.filter.store) : ''}
      ${sel('cpaSort', 'الترتيب', [['attention', 'الأهم أولًا (الخسارة فوق)'], ['cpa', 'الأعلى CPA'], ['cpaAsc', 'الأقل CPA'], ['orders', 'الأكتر أوردرات'], ['spend', 'الأكتر صرف'], ['name', 'الاسم']], C.sort)}
      <button class="opx-btn sm" id="cpaReset" type="button">مسح الفلاتر</button><span class="cpa-count" id="cpaCount"></span></div>
    <div class="cpa-meta opx-note">القواعد العامة: ${g.rulesVersion ? 'v' + g.rulesVersion + ' معتمدة' : 'غير معتمدة'} · سياسة الإيقاف ${g.pausePolicyApproved ? 'معتمدة' : 'غير معتمدة'} · سقف الحساب ${g.accountCap != null ? egp(g.accountCap) : 'غير محدد'}</div>
    <div class="cpa-plist" id="cpaList">${listHtml()}</div></div>`;
}
function redrawList() {
  const R = C.root; R.querySelector('#cpaList').innerHTML = listHtml(); R.querySelector('#cpaSum').innerHTML = summaryHtml();
  R.querySelector('#cpaCount').textContent = `${dashRows().length} من ${C.ov.products.length} منتج`; R.querySelectorAll('[data-period]').forEach((b) => { const on = b.dataset.period === C.period; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  const w = C.ov.windows?.[C.period]; const rt = R.querySelector('.cpa-range-txt'); if (rt && w) rt.textContent = (w.from === w.to ? `📅 ${dmy(w.from)}` : `📅 من ${dmy(w.from)} إلى ${dmy(w.to)}`) + (C.ov.generatedAt ? ` · آخر تحديث ${new Date(C.ov.generatedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}` : '');
  wireRows(); wireSumChips(); updSel();
}
function wireSumChips() { C.root.querySelectorAll('[data-grp]').forEach((b) => { b.onclick = () => { C.filter.perf = C.filter.perf === b.dataset.grp ? '' : b.dataset.grp; const s = C.root.querySelector('#cpaFPerf'); if (s) s.value = C.filter.perf; redrawList(); }; }); }
function wireDash() {
  const R = C.root; const set = (id, key) => { const el = R.querySelector(id); if (el) el.onchange = () => { C.filter[key] = el.value; redrawList(); }; };
  R.querySelector('#cpaQ').oninput = (e) => { C.filter.q = e.target.value; redrawList(); };
  set('#cpaFState', 'state'); set('#cpaFPerf', 'perf'); set('#cpaFMode', 'mode'); set('#cpaFStore', 'store');
  R.querySelector('#cpaSort').onchange = (e) => { C.sort = e.target.value; redrawList(); };
  R.querySelectorAll('[data-period]').forEach((b) => { b.onclick = () => { C.period = b.dataset.period; try { localStorage.setItem('opx.cpa.period', C.period); } catch { /* private mode */ } redrawList(); }; });
  R.querySelector('#cpaReset').onclick = () => { C.filter = { q: '', state: '', perf: '', mode: '', store: '' }; C.sort = 'attention'; draw(); };
  R.querySelector('#cpaCount').textContent = `${dashRows().length} من ${C.ov.products.length} منتج`; wireSumChips();
}
function draw() {
  C.root.innerHTML = `${kpis()}${board()}${dash()}`; wire();
}

// ---------- interaction ----------
function setVal(k, v, { touch = true } = {}) { C.V[k] = v; if (touch) C.touched.add(k); }
function liveUpdate() { // no full re-render while dragging/typing: only what depends on the numbers
  const keys = ['bumpStart', 'bumpEnd', 'reduceStart', 'hardStop']; const wrap = C.root.querySelector('.cpa-track-wrap');
  if (wrap && keys.some((k) => (C.V[k] != null) !== !!wrap.querySelector(`[data-h="${k}"]`))) { wrap.outerHTML = sliderHtml(); wireHandles(); }
  const AX = axisMax(); const tr = C.root.querySelector('#cpaTrack'); if (!tr) return; tr.style.background = trackBg(ranges(), AX);
  for (const k of ['bumpStart', 'bumpEnd', 'reduceStart', 'hardStop']) { const h = tr.querySelector(`[data-h="${k}"]`); if (h && C.V[k] != null) { h.style.left = `${Math.min(100, (C.V[k] / AX) * 100)}%`; h.firstElementChild.textContent = C.V[k]; } const n = C.root.querySelector(`[data-n="${k}"]`); if (n && document.activeElement !== n) n.value = C.V[k] ?? ''; const r = C.root.querySelector(`[data-r="${k}"]`); if (r) r.value = C.V[k] ?? r.min; }
  const zs = C.root.querySelector('.cpa-zones'); if (zs) zs.outerHTML = zonesHtml(); const pv = C.root.querySelector('.cpa-test, .cpa-msg.bad'); if (pv) { const keep = document.activeElement?.id === 'cpaTest'; pv.outerHTML = previewLine(); if (keep) { const t = C.root.querySelector('#cpaTest'); t?.focus(); t?.setSelectionRange(t.value.length, t.value.length); } wireTest(); }
}
function wireTest() { const t = C.root.querySelector('#cpaTest'); if (t) t.oninput = () => { C.test = t.value; liveUpdate(); }; }
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function boundsOf(k) { const v = C.V; const lo = { bumpStart: 1, bumpEnd: (v.bumpStart ?? 0) + 1, reduceStart: (v.bumpEnd ?? 0) + 1, hardStop: v.reduceStart ?? (v.bumpEnd ?? 0) + 1 }[k]; const hi = { bumpStart: (v.bumpEnd ?? axisMax()) - 1, bumpEnd: (v.reduceStart ?? axisMax()) - 1, reduceStart: v.hardStop ?? axisMax(), hardStop: axisMax() }[k]; return [lo, hi]; }
function wireHandles() {
  const R = C.root;
  R.querySelectorAll('[data-h]').forEach((h) => { h.onpointerdown = (e) => { if (!isAdmin()) return; e.preventDefault(); h.setPointerCapture(e.pointerId); const k = h.dataset.h; const rect = R.querySelector('#cpaTrack').getBoundingClientRect();
    h.onpointermove = (ev) => { const AX = axisMax(); const [lo, hi] = boundsOf(k); setVal(k, clamp(Math.round(((ev.clientX - rect.left) / rect.width) * AX), lo, hi)); liveUpdate(); }; h.onpointerup = () => { h.onpointermove = null; h.onpointerup = null; draw(); }; };
    h.onkeydown = (e) => { const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!d) return; const k = h.dataset.h; const [lo, hi] = boundsOf(k); setVal(k, clamp(C.V[k] + d, lo, hi)); liveUpdate(); }; });
}
function wire() {
  const R = C.root;
  R.querySelector('#cpaScope').onchange = async (e) => { C.scope = e.target.value; try { await loadScope(); draw(); } catch (err) { toast(err.message, 'error'); } };
  R.querySelectorAll('[data-n]').forEach((el) => { el.oninput = () => { const k = el.dataset.n; setVal(k, k === 'window' ? val(el.value) : val(el.value)); const r = R.querySelector(`[data-r="${k}"]`); if (r && el.value !== '') r.value = el.value; liveUpdate(); }; });
  R.querySelectorAll('[data-r]').forEach((el) => { el.oninput = () => { const k = el.dataset.r; let x = Number(el.value); if (['bumpStart', 'bumpEnd', 'reduceStart', 'hardStop'].includes(k)) { const [lo, hi] = boundsOf(k); x = clamp(x, lo, hi); } setVal(k, x); const n = R.querySelector(`[data-n="${k}"]`); if (n) n.value = x; liveUpdate(); }; });
  R.querySelectorAll('[data-more]').forEach((b) => { b.onclick = () => { const k = b.dataset.more; const pop = R.querySelector(`[data-pop="${k}"]`); const open = pop.hidden; pop.hidden = !open; open ? C.open.add(k) : C.open.delete(k); b.setAttribute('aria-expanded', String(open)); }; });
  wireHandles(); wireTest();
  const ex = R.querySelector('[data-act="example"]'); if (ex) ex.onclick = () => { for (const [k, v] of [['bumpStart', 20], ['bumpEnd', 100], ['reduceStart', 130], ['hardStop', 200]]) setVal(k, v); draw(); msg('دي أرقام مثال للمعاينة فقط — مش محفوظة ومش متطبّقة على أي حاجة.'); };
  R.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => act(b.dataset.act); });
  wireDash(); wireRows();
}
function updSel() { const b = C.root.querySelector('[data-act="applysel"]'); if (b) b.textContent = `تطبيق على المحدد (${C.sel.size})`; }
function wireRows() {
  const R = C.root; const all = R.querySelector('#cpaAll'); if (all) all.onchange = (e) => { R.querySelectorAll('[data-sel]').forEach((c) => { c.checked = e.target.checked; e.target.checked ? C.sel.add(c.dataset.sel) : C.sel.delete(c.dataset.sel); }); updSel(); };
  R.querySelectorAll('[data-sel]').forEach((c) => { c.onchange = () => { c.checked ? C.sel.add(c.dataset.sel) : C.sel.delete(c.dataset.sel); updSel(); }; });
  R.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = async () => { C.scope = b.dataset.edit; try { await loadScope(); draw(); R.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (err) { toast(err.message, 'error'); } }; });
  R.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => toggleMode(b.dataset.mode); });
}
// the policy object the form describes: only fields the owner touched (or that the policy already had) are written, so an inherited value stays inherited
function buildPolicy() {
  const base = JSON.parse(JSON.stringify(policyOf() || {})); const p = { ...base, cpa: { ...(base.cpa || {}) }, budget: { ...(base.budget || {}) }, zeroOrder: { ...(base.zeroOrder || {}) } };
  for (const [k, [g, f]] of Object.entries(MAP)) { if (C.scope !== 'GLOBAL' && !C.touched.has(k)) continue; if (C.scope === 'GLOBAL' && !C.touched.has(k) && C.V[k] == null) continue; if (g) p[g][f] = C.V[k]; else p[f] = C.V[k]; }
  return p;
}
const msg = (t, bad) => { const m = C.root.querySelector('#cpaMsg'); if (m) { m.textContent = t; m.className = 'opx-note' + (bad ? ' bad' : ''); } };
async function act(a) {
  const errs = validateRanges(ranges()); if (['save', 'activate', 'applysel'].includes(a) && errs.length) { msg(errs[0], true); toast(errs[0], 'error'); return; }
  try {
    if (a === 'save') { await saveCurrent(); toast('اتحفظت كمسودة — الحفظ مش تنفيذ'); await reload(); }
    else if (a === 'activate') {
      if (C.touched.size || !(C.scope === 'GLOBAL' ? C.gl.draft : C.pol?.draft)) await saveCurrent();
      const label = C.scope === 'GLOBAL' ? 'القواعد العامة لكل المنتجات المسجّلة' : `سياسة ${C.ov.products.find((p) => p.key === C.scope)?.name}`;
      if (!(await confirmModal({ title: 'اعتماد القواعد', message: `هتعتمد ${label}. الاعتماد بيغيّر القيم اللي المنتجات بترثها — ومفيش تنفيذ على Meta من الخطوة دي. التنفيذ التلقائي لسه بيحتاج وضع AUTOMATIC وسياسة منتج AUTOMATIC جاهزة.` }))) return;
      if (C.scope === 'GLOBAL') await api.post('/api/operator/automation/global-rules/activate', { confirm: true });
      else { const p = C.ov.products.find((x) => x.key === C.scope); const auto = (C.pol?.draft?.mode || C.pol?.active?.mode) === 'AUTOMATIC'; await api.post(`/api/operator/product-rules/${p.productId}/activate`, { storeId: p.storeId, confirm: true, confirmAutomatic: auto }); }
      toast('اتعتمدت'); await reload();
    } else if (a === 'applysel') {
      if (!C.sel.size) { toast('حدّد منتجات من الجدول الأول', 'error'); return; }
      const pol = buildPolicy(); const patch = { cpa: pol.cpa, budget: pol.budget, zeroOrder: pol.zeroOrder, manualOverrideHours: pol.manualOverrideHours ?? null };
      if (!(await confirmModal({ title: 'تطبيق على المنتجات المحددة', message: `هتتكتب القيم دي كمسودات على ${C.sel.size} منتج (الخانات الفاضية مش بتمسح حاجة). مفيش اعتماد ولا تنفيذ.` }))) return;
      const r = await api.post('/api/operator/automation/bulk/configure', { productKeys: [...C.sel], patch }); toast(`اتحفظ كمسودة: ${r.drafted.length}${r.skipped.length ? ` · اتخطّى ${r.skipped.length}` : ''}`); await reload();
    } else if (a === 'impact') await impact();
  } catch (e) { msg(e.message, true); toast(e.message, 'error'); }
}
async function saveCurrent() {
  const pol = buildPolicy();
  if (C.scope === 'GLOBAL') await api.put('/api/operator/automation/global-rules', { policy: pol });
  else { const p = C.ov.products.find((x) => x.key === C.scope); await api.put(`/api/operator/product-rules/${p.productId}/draft`, { storeId: p.storeId, policy: pol }); }
}
async function reload() { const sc = C.scope; await loadAll(); C.scope = sc; draw(); await C.ctx.refresh?.(); }
async function impact() {
  const keys = C.sel.size ? [...C.sel] : null; const pv = await api.post('/api/operator/automation/bulk/preview', { productKeys: keys });
  const ex = pv.exposure || {}; const bl = pv.blockers || [];
  const list = (arr, f) => (arr.length ? `<ul class="cpa-ul">${arr.map(f).join('')}</ul>` : '<p class="opx-note">—</p>');
  const body = `<div class="cpa-impact"><div class="cpa-impact-k"><div><b>${num(pv.confirm.products)}</b><span>منتج مؤهل</span></div><div><b>${num(pv.confirm.campaigns)}</b><span>حملة</span></div><div><b>${egp(ex.running)}</b><span>الميزانيات الشغالة</span></div><div><b>${ex.accountCap != null ? egp(ex.accountCap) : '—'}</b><span>سقف الحساب</span></div></div>
    ${bl.length ? `<div class="cpa-msg bad"><b>موانع التفعيل الجماعي:</b>${list(bl, (b) => `<li>${E(b.message)}</li>`)}</div>` : '<div class="cpa-msg ok">لا توجد موانع — الأرقام دي هي اللي هتتأكد عند الاعتماد.</div>'}
    <h4>هيتفعّل (READY)</h4>${list(pv.included, (p) => `<li><b>${E(p.name)}</b> — ${num(p.campaigns.mapped)} حملة · جاري ${egp(p.runningBudget)} · زيادة ≤${p.limits.cpaScale ?? '—'} · تقليل ≥${p.limits.cpaReduce ?? '—'} · إيقاف >${p.limits.hardStop ?? '—'}</li>`)}
    <h4>مش هيتفعّل</h4>${list(pv.notIncluded, (p) => `<li><b>${E(p.name)}</b> — ${E(p.why || p.state)}</li>`)}<p class="opx-note">${E(pv.note || '')}</p></div>`;
  const canGo = isAdmin() && !bl.length && pv.included.length > 0;
  const panel = openDrawer({ title: 'معاينة التأثير المالي (قراءة فقط — مفيش تنفيذ)', body, foot: `${canGo ? '<button class="opx-btn primary" id="cpaGo">اعتماد AUTOMATIC لهؤلاء المنتجات</button>' : ''}<button class="opx-btn" id="cpaNo">إغلاق</button>` });
  const ok = await new Promise((res) => { panel.querySelector('#cpaNo').onclick = () => { closeDrawer(); res(false); }; const g = panel.querySelector('#cpaGo'); if (g) g.onclick = () => { closeDrawer(); res(true); }; });
  if (!ok || !canGo) return;
  if (!(await confirmModal({ title: 'تأكيد نهائي — AUTOMATIC', message: `هتحوّل ${pv.confirm.products} منتج لـAUTOMATIC (${pv.confirm.campaigns} حملة، تعرّض ${egp(ex.running)}). ده مش بيفتح قفل Meta ومش بيغيّر وضع النظام — التنفيذ لسه بيمشي على الوضع والصلاحيات والـGuards.` }))) return;
  const r = await api.post('/api/operator/automation/bulk/activate', { productKeys: pv.included.map((p) => p.key), confirm: pv.confirm, confirmAutomatic: true }); toast(`اتفعّل AUTOMATIC: ${r.activated.length}${r.skipped.length ? ` · اتخطّى ${r.skipped.length}` : ''}`); await reload();
}
async function toggleMode(key) {
  const p = C.ov.products.find((x) => x.key === key); const auto = p.policy.mode === 'AUTOMATIC' && p.policy.status.startsWith('ACTIVE');
  try {
    if (!auto && p.state !== 'READY') { toast(`المنتج مش جاهز: ${p.blockedReason || (p.missing || []).map((m) => m.label).join(' · ')}`, 'error'); return; }
    const to = auto ? 'APPROVAL' : 'AUTOMATIC';
    if (!(await confirmModal({ title: `تحويل ${p.name} إلى ${to}`, message: to === 'AUTOMATIC' ? 'بعد التفعيل، السيستم هينفّذ زيادة/تقليل/إيقاف على الحملات المربوطة بالمنتج لوحده ضمن حدوده — بشرط وضع النظام AUTOMATIC وقفل Meta مفتوح وصلاحيات التنفيذ ON. التفعيل بيتحقق من الجاهزية تاني على السيرفر.' : 'هيرجع للموافقة اليدوية على كل عملية.' }))) return;
    const cur = (await api.get(`/api/operator/product-rules/${p.productId}`, { store: p.storeId })); const base = cur.draft || cur.active || {};
    await api.put(`/api/operator/product-rules/${p.productId}/draft`, { storeId: p.storeId, policy: { ...base, mode: to } });
    await api.post(`/api/operator/product-rules/${p.productId}/activate`, { storeId: p.storeId, confirm: true, confirmAutomatic: to === 'AUTOMATIC' });
    toast(`${p.name}: ${to}`); await reload();
  } catch (e) { toast(e.message, 'error'); }
}
