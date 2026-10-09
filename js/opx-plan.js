// opx-plan.js — the «فتح الحملات» (OPEN, 00:00) and «إيقاف الحملات» (PAUSE, 13:00) workspaces. One component, two skins (green / red).
// Presentation over /api/operator/daily-plan/* (schedule, candidates, guards, versions, approval, execution — all owned by the server) and the read-only /api/operator/campaign-board
// (EVERY campaign with fresh data: Today / 7D / 30D, Cairo day). Ticking a checkbox only SELECTS (saved at once); only «اعتماد المحدد» approves, and in SHADOW it is a simulation.
// Non-candidate campaigns are shown for reading only (no checkbox). Nothing here talks to Meta.
import { api } from './api-client.js';
import { E, $, num, egp, cairoTime, cairoDateTime, ago, ICONS, kpiCard, pill, skeletonRows, skeletonCards, openDrawer, closeDrawer, toast, confirmModal, store, thumb, hydrateThumbs } from './opx-ui.js';
import { BLOCK_AR, ELIG_AR, ITEM_AR, ITEM_PILL } from './ai-operator-daily.js';

const API = '/api/operator/daily-plan';
const META = {
  OPEN: { tone: 'green', icon: 'play', title: 'فتح الحملات', sub: 'إدارة الحملات المرشحة للفتح وتشغيلها في المواعيد المحددة', verb: 'فتح', permKey: 'allowOpen', empty: 'مفيش حملات مرشحة للفتح في هذا العرض.', banner: 'سيتم فتح هذه الحملات بعد اعتمادك', slot: '00:00' },
  PAUSE: { tone: 'red', icon: 'pause', title: 'إيقاف الحملات', sub: 'الحملات المرشحة للإيقاف حسب CPA والصرف بدون أوردرات والاتجاه', verb: 'إيقاف', permKey: 'allowPause', empty: 'مفيش حملات نشطة محتاجة إيقاف في هذا العرض.', banner: 'سيتم إيقاف هذه الحملات بعد اعتمادك', slot: '13:00' },
};
const PAUSE_CATS = { zero: 'صرف بدون أوردرات', highcpa: 'CPA مرتفع', weak: 'اتجاه ضعيف', protected: 'محمية / مستثناة' };
const catOf = (i) => { const e = i?.evidence || {}; const cats = new Set(); if (!i) return cats; if (['PROTECTED', 'BLOCKED'].includes(i.eligibility)) cats.add('protected'); if ((e.today?.purchases ?? 0) === 0 && (e.m3?.spend ?? 0) >= 100 && (e.m3?.purchases ?? 0) === 0) cats.add('zero'); if (e.m7?.cpa != null && e.m7.cpa >= 150 || e.today?.cpa != null && e.today.cpa >= 200) cats.add('highcpa'); if (e.m3?.cpa != null && e.m7?.cpa != null && e.m3.cpa > e.m7.cpa * 1.15) cats.add('weak'); return cats; };
const SORTS = { purchases: 'الأوردرات (الأعلى أولًا)', cpa: 'CPA (الأقل أولًا)', spend: 'الصرف (الأعلى أولًا)', budget: 'الميزانية (الأعلى أولًا)', score: 'Priority Score', rank: 'ترتيب النظام' };
const VIEWS = [['candidates', 'المرشحة'], ['all', 'الكل'], ['active', 'نشطة'], ['paused', 'متوقفة'], ['protected', 'محمية'], ['blocked', 'ممنوعة']];
const RISK = { HIGH: ['red', 'مرتفعة'], MEDIUM: ['amber', 'متوسطة'], LOW: ['green', 'منخفضة'] };
const MODE_AR = { OFF: 'MANUAL', SHADOW: 'SHADOW', APPROVAL: 'APPROVAL', AUTOPILOT: 'AUTOMATIC' };

const mainW = () => (document.querySelector('.opx-main') || document.documentElement).clientWidth || window.innerWidth;
const PAGE = 40; // rows rendered at a time — never the whole list at once
const NARROW_PX = 820; // same breakpoint as the CSS container query: below it the phone layout (cards) is used
const ASIDE_PX = 1480; // from here the scheduler panel sits beside the table (own column); below it the panel opens in a drawer
const XL_PX = 1260; // table width from which the Today-spend column fits inside the TODAY group; below it the spend lives in the campaign drawer
const layoutOf = () => { const w = mainW(); const tableW = w - (w >= ASIDE_PX ? 316 : 0); return w <= NARROW_PX ? 'cards' : tableW >= XL_PX ? 'xl' : 'lg'; };
const P = { cpa: null, cpaForm: null, cpaDirty: false, shown: PAGE, pm: null, pmErr: null, sel: null, type: 'OPEN', ctx: null, root: null, ov: null, board: null, bmap: new Map(), loading: false, f: null, timer: null, prepTimer: null };

export async function mountPlanWorkspace(root, type, ctx) {
  P.type = type; P.ctx = ctx; P.root = root; P.ov = null; P.sel = null; P.board = null; P.bmap = new Map();
  P.f = { q: '', store: '', sort: 'purchases', period: '7', view: 'candidates', cat: '', from: '', to: '', ...(JSON.parse(store.get(`opx.f.${type}`, 'null')) || {}) };
  if (!SORTS[P.f.sort]) P.f.sort = 'purchases'; if (!VIEWS.some(([k]) => k === P.f.view)) P.f.view = 'candidates';
  P.pm = null; P.pmErr = null; P.shown = PAGE;
  clearInterval(P.timer); clearTimeout(P.prepTimer);
  root.innerHTML = `<div id="opxPlanBody">${skeletonCards(5)}<div class="opx-card" style="margin-top:14px">${skeletonRows(7)}</div></div>`;
  await load();
  clearTimeout(P.rzTimer); if (!P.rz) { P.rz = true; window.addEventListener('resize', () => { clearTimeout(P.rzTimer); P.rzTimer = setTimeout(() => { if (P.ov && P.root && document.body.contains(P.root) && layoutOf() !== P.layout) draw(); }, 250); }); }
  P.timer = setInterval(() => { if (!document.body.contains(root)) return clearInterval(P.timer); tickCountdown(); }, 1000);
}
export function unmountPlanWorkspace() { clearInterval(P.timer); clearTimeout(P.prepTimer); }

async function load({ quiet = false } = {}) {
  try { P.ov = await api.get(`${API}/overview`); } catch (e) { P.root.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message)}</div>`; return; }
  try { P.board = await api.get('/api/operator/campaign-board'); P.bmap = new Map((P.board.rows || []).map((r) => [r.campaignId, r])); } catch { P.board = null; P.bmap = new Map(); } // the table still works from the plan's own evidence
  await loadCpa();
  await ensurePeriodMetrics();
  if (!quiet || document.body.contains(P.root)) draw();
  const preparing = (P.ov.preparing || []).some((p) => !p.error);
  clearTimeout(P.prepTimer); if (preparing) P.prepTimer = setTimeout(() => load({ quiet: true }), 5000);
  const running = P.ov.plans?.[P.type] && ['APPROVED', 'RUNNING'].includes(P.ov.plans[P.type].status);
  if (running) P.prepTimer = setTimeout(() => load({ quiet: true }), 3000);
}
// ---- «الفتح حسب تكلفة الأوردر CPA»: a SAVED, versioned opening policy (limits, window, minimum sample). Saving never enables it; enabling never opens a campaign; preparing only SELECTS.
const WIN_CHIPS = [['today', 'Today'], ['7', '7 Days'], ['30', '30 Days'], ['90', '90 Days'], ['custom', 'Custom']];
const WIN_AR = { today: 'اليوم', 7: 'آخر 7 أيام', 30: 'آخر 30 يوم', 90: 'آخر 90 يوم', custom: 'فترة مخصصة' };
async function loadCpa() {
  if (P.type !== 'OPEN') { P.cpa = null; return; }
  try { P.cpa = await api.get(`${API}/open-cpa`); } catch { P.cpa = null; }
  const pol = P.cpa?.policy; if (pol && (!P.cpaForm || !P.cpaDirty)) { P.cpaForm = { minCpa: pol.minCpa ?? '', maxCpa: pol.maxCpa ?? '', window: pol.window, from: pol.from || '', to: pol.to || '', minPurchases: pol.minPurchases, maxDataAgeMin: pol.maxDataAgeMin }; P.cpaDirty = false; }
}
const cpaDirtyNow = () => { const pol = P.cpa?.policy, f = P.cpaForm; if (!pol || !f) return false; return ['minCpa', 'maxCpa', 'minPurchases', 'maxDataAgeMin'].some((k) => String(f[k] ?? '') !== String(pol[k] ?? '')) || f.window !== pol.window || (f.window === 'custom' && (f.from !== (pol.from || '') || f.to !== (pol.to || ''))); };
function cpaPanel(p, editable) {
  const d = P.cpa; if (!d || !P.cpaForm) return ''; const pol = d.policy, f = P.cpaForm, pv = d.preview?.counts, admin = P.ctx.isAdmin; const dirty = cpaDirtyNow();
  const complete = pol.minCpa != null && pol.maxCpa != null; const approvedHere = pol.enabled && pol.approved?.version === pol.version; const planStale = d.plan?.stale;
  const tile = (cls, n, label, icon) => `<div class="opx-cpa-tile ${cls}"><div><b>${n == null ? '—' : num(n)}</b><span>${label}</span></div><i>${icon}</i></div>`;
  const polText = complete ? `فتح الحملات التي CPA بين <b>${num(pol.minCpa)}</b> إلى <b>${num(pol.maxCpa)}</b> جنيه خلال <b>${WIN_AR[pol.window]}</b>${pol.window === 'custom' ? ` (${E(pol.from)} → ${E(pol.to)})` : ''}<br>الحد الأدنى للأوردرات: <b>${num(pol.minPurchases)}</b> · أقصى عمر للبيانات: <b>${num(pol.maxDataAgeMin)}</b> دقيقة` : 'مفيش نطاق محفوظ — حدّد أقل وأعلى CPA واحفظ. السيستم مش بيفترض أي نطاق.';
  return `<section class="opx-card opx-cpa opx-fade" id="opxCpa">
    <div class="opx-cpa-head"><div class="opx-head-icon violet" style="width:48px;height:48px">${ICONS.target}</div><div class="grow"><h2>الفتح حسب تكلفة الأوردر CPA ${pill('Beta', 'violet')} ${pill('نسخة v' + pol.version, 'gray')}</h2><p>حدد نطاق CPA واختار الفترة — السيستم بيجهز الحملات المطابقة بعد اجتياز الأهلية وحواجز الأمان</p></div>
      <div class="opx-cpa-tiles">${tile('green', pv?.matched, 'مطابقة للنطاق', '◎')}${tile('blue', pv?.eligible, 'مؤهلة للفتح', '✓')}${tile('amber', pv?.excluded, 'مستبعدة', '⊖')}</div></div>
    <div class="opx-cpa-toggle"><button class="opx-switch-btn ${pol.enabled ? 'on' : ''}" id="cpaOn" role="switch" aria-checked="${pol.enabled}" ${admin ? '' : 'disabled'} title="${admin ? '' : 'ADMIN فقط'}"><span></span></button><div><b>${pol.enabled ? 'قاعدة الفتح حسب CPA مفعّلة' : 'تفعيل قاعدة الفتح حسب CPA'}</b><small>منفصلة تمامًا عن قفل كتابة Meta — ${pol.enabled ? (approvedHere ? `معتمدة للنسخة v${pol.version}` : `النسخة المعتمدة v${pol.approved?.version ?? '—'} (الحالية v${pol.version}) `) : 'مقفولة: الجدول بيتجهز بالمنطق العادي'}</small></div>${pol.enabled && !approvedHere && admin ? '<button class="opx-btn sm" id="cpaApprove">اعتماد النسخة الحالية</button>' : ''}</div>
    <div class="opx-cpa-form">
      <label class="opx-field"><span>أقل CPA (جنيه)</span><input class="opx-input" id="cpaMin" inputmode="decimal" value="${E(f.minCpa)}" ${admin ? '' : 'disabled'}></label>
      <label class="opx-field"><span>أعلى CPA (جنيه)</span><input class="opx-input" id="cpaMax" inputmode="decimal" value="${E(f.maxCpa)}" ${admin ? '' : 'disabled'}></label>
      <div class="opx-field"><span>فترة القياس</span><div class="opx-chips" role="group" aria-label="فترة القياس">${WIN_CHIPS.map(([k, t]) => `<button class="opx-chip ${f.window === k ? 'on' : ''}" data-cpaw="${k}" ${admin ? '' : 'disabled'}>${t}</button>`).join('')}</div></div>
      <label class="opx-field"><span>الحد الأدنى للأوردرات</span><input class="opx-input" id="cpaMinP" inputmode="numeric" value="${E(f.minPurchases)}" ${admin ? '' : 'disabled'}></label>
      <label class="opx-field"><span>أقصى عمر للبيانات (دقيقة)</span><input class="opx-input" id="cpaAge" inputmode="numeric" value="${E(f.maxDataAgeMin)}" ${admin ? '' : 'disabled'}></label>
      ${f.window === 'custom' ? `<label class="opx-field"><span>من</span><input class="opx-input" type="date" id="cpaFrom" value="${E(f.from)}" ${admin ? '' : 'disabled'}></label><label class="opx-field"><span>إلى</span><input class="opx-input" type="date" id="cpaTo" value="${E(f.to)}" ${admin ? '' : 'disabled'}></label>` : ''}</div>
    <div id="cpaErr"></div>
    <div class="opx-cpa-now"><div><b>السياسة المحفوظة الحالية</b><p>${polText}</p></div><div class="opx-cpa-btns">
      <button class="opx-btn" id="cpaPreview" ${complete ? '' : 'disabled'}>${ICONS.eye} معاينة النتائج</button>
      <button class="opx-btn primary" id="cpaPrepare" ${admin && complete && p && ['PREPARED', 'APPROVED'].includes(p.status) && !dirty ? '' : 'disabled'} title="${dirty ? 'احفظ التعديلات الأول' : ''}">${ICONS.target} تجهيز الحملات المطابقة</button>
      <button class="opx-btn ${dirty ? 'accent' : ''}" id="cpaSave" ${admin && dirty ? '' : 'disabled'}>${ICONS.history} حفظ السياسة كنسخة جديدة</button><button class="opx-btn ghost sm" id="cpaHist">سجل النسخ</button></div></div>
    ${planStale ? `<div class="opx-notice amber"><div class="grow"><b>الخطة اتجهزت بنسخة سياسة أقدم (v${d.plan.policyVersion ?? 'بدون'})</b><small>اضغط «تجهيز الحملات المطابقة» لإعادة التقييم — اختياراتك اليدوية (اللي استبعدتها) بتفضل زي ما هي.</small></div></div>` : ''}
    <div class="opx-notice red opx-cpa-warn"><div class="grow"><b>مهم: تجهيز الحملات لا يعني تنفيذها.</b><small>سيتم تطبيق القواعد والحماية والتأكد من الأهلية. التنفيذ يتم حسب الوضع (SHADOW محاكاة / APPROVAL بعد اعتمادك / AUTOMATIC حسب الصلاحيات) — ولا يتم فتح أي حملة فعليًا بمجرد تغيير الزر أو حدود CPA.</small></div></div></section>`;
}
function wireCpa(p) {
  const d = P.cpa; if (!d || !$('opxCpa')) return; const root = $('opxCpa'); const f = P.cpaForm; const upd = () => { P.cpaDirty = cpaDirtyNow(); const sv = $('cpaSave'); if (sv) sv.disabled = !(P.ctx.isAdmin && P.cpaDirty); const pr = $('cpaPrepare'); if (pr) pr.disabled = P.cpaDirty || pr.disabled && !P.cpaDirty ? true : false; };
  const bind = (id, k) => { const el = $(id); if (el) el.oninput = () => { f[k] = el.value; P.cpaDirty = cpaDirtyNow(); const sv = $('cpaSave'); if (sv) sv.disabled = !(P.ctx.isAdmin && P.cpaDirty); const pr = $('cpaPrepare'); if (pr && P.cpaDirty) pr.disabled = true; }; };
  bind('cpaMin', 'minCpa'); bind('cpaMax', 'maxCpa'); bind('cpaMinP', 'minPurchases'); bind('cpaAge', 'maxDataAgeMin'); bind('cpaFrom', 'from'); bind('cpaTo', 'to');
  root.querySelectorAll('[data-cpaw]').forEach((b) => { b.onclick = () => { f.window = b.dataset.cpaw; if (f.window === 'custom' && !f.to) { f.to = todayStr(); const dd = new Date(`${todayStr()}T00:00:00Z`); dd.setUTCDate(dd.getUTCDate() - 13); f.from = dd.toISOString().slice(0, 10); } P.cpaDirty = cpaDirtyNow(); draw(); }; });
  const err = (m) => { $('cpaErr').innerHTML = m ? `<div class="opx-note bad">⚠️ ${E(m)}</div>` : ''; };
  if ($('cpaSave')) $('cpaSave').onclick = async () => {
    try { const r = await api.put(`${API}/open-cpa`, { minCpa: f.minCpa, maxCpa: f.maxCpa, window: f.window, from: f.from, to: f.to, minPurchases: f.minPurchases, maxDataAgeMin: f.maxDataAgeMin }); P.cpaDirty = false; P.cpaForm = null;
      toast(r.changed ? `اتحفظت نسخة جديدة v${r.policy.version}${r.reconcile?.superseded?.length ? ' — الخطة المعتمدة اتلغت ومحتاجة اعتماد جديد' : ''}. مفيش حملة اتفتحت.` : 'مفيش تغيير يتحفظ', r.reconcile?.superseded?.length ? 'warning' : undefined); await load(); }
    catch (e) { err((e.details || [e.message]).join(' ')); }
  };
  if ($('cpaOn')) $('cpaOn').onclick = async () => {
    const pol = d.policy; const to = !pol.enabled;
    if (!(await confirmModal({ title: to ? 'تفعيل الفتح حسب CPA' : 'إيقاف الفتح حسب CPA', message: to ? `هتتفعّل سياسة CPA ${pol.minCpa ?? '—'}–${pol.maxCpa ?? '—'} (v${pol.version}). التفعيل لا يفتح أي حملة؛ بيخلّي الجدول يتجهز حسب السياسة، والتنفيذ بيفضل حسب الوضع والاعتماد والصلاحيات.` : 'الجدول هيرجع يتجهز بالمنطق العادي. السياسة والحدود تفضل محفوظة.', confirmLabel: to ? 'تفعيل' : 'إيقاف' }))) return;
    try { await api.post(`${API}/open-cpa/enable`, { enabled: to, confirm: true }); toast(to ? 'اتفعّلت — مفيش حملة اتفتحت' : 'اتقفلت'); await load(); } catch (e) { err((e.details || [e.message]).join(' ')); }
  };
  if ($('cpaApprove')) $('cpaApprove').onclick = async () => { try { await api.post(`${API}/open-cpa/enable`, { enabled: true, confirm: true }); toast('اتعتمدت النسخة الحالية'); await load(); } catch (e) { err(e.message); } };
  if ($('cpaPreview')) $('cpaPreview').onclick = () => cpaPreviewDrawer();
  if ($('cpaHist')) $('cpaHist').onclick = () => openDrawer({ title: 'سجل نسخ سياسة الفتح حسب CPA', body: (d.policy.history || []).length ? `<table class="opx-table"><thead><tr><th>النسخة</th><th class="num">أقل</th><th class="num">أعلى</th><th>الفترة</th><th>اتبدلت</th></tr></thead><tbody>${d.policy.history.map((h) => `<tr><td>v${h.version}${h.enabled ? ' ' + pill('كانت مفعّلة', 'green') : ''}</td><td class="num">${h.minCpa ?? '—'}</td><td class="num">${h.maxCpa ?? '—'}</td><td>${E(WIN_AR[h.window] || h.window)}${h.window === 'custom' ? ' ' + E(h.from) + ' → ' + E(h.to) : ''}</td><td>${E(cairoDateTime(h.replacedAt))}</td></tr>`).join('')}</tbody></table>` : '<div class="opx-empty">النسخة الأولى — مفيش سجل بعد.</div>' });
  if ($('cpaPrepare')) $('cpaPrepare').onclick = async () => {
    if (p?.status === 'APPROVED' && !(await confirmModal({ title: 'تجهيز على خطة معتمدة', message: 'الخطة معتمدة. التجهيز هيلغي النسخة المعتمدة وينشئ نسخة جديدة محتاجة اعتماد جديد. مفيش تنفيذ.', confirmLabel: 'متابعة' }))) return;
    try { const r = await api.post(`${API}/open-cpa/prepare`, {}); if (!r.ok) { toast(r.message || 'مش متاح', 'error'); return; } toast(`اتجهزت: ${num(r.counts.eligible)} مؤهلة · ${num(r.counts.excluded)} مستبعدة من ${num(r.counts.matched)} مطابقة${r.newVersion ? ' — نسخة جديدة محتاجة اعتماد' : ''}. مفيش حملة اتنفذت.`); await load(); }
    catch (e) { toast(e.message, 'error'); }
  };
}
const CPA_V = { ELIGIBLE: ['green', 'مؤهلة'], EXCLUDED: ['amber', 'مستبعدة'], OUT_OF_RANGE: ['gray', 'خارج النطاق'], UNKNOWN_CPA: ['gray', 'CPA غير معروف'] };
function cpaPreviewDrawer() {
  const d = P.cpa; const pv = d?.preview; if (!pv) { openDrawer({ title: 'معاينة نتائج سياسة CPA', body: '<div class="opx-empty">مفيش خطة فتح لليوم لمعاينتها.</div>' }); return; }
  let flt = 'ALL'; const show = () => { const rows = pv.rows.filter((r) => flt === 'ALL' || r.verdict === flt).sort((a, b) => (a.verdict === 'ELIGIBLE' ? 0 : 1) - (b.verdict === 'ELIGIBLE' ? 0 : 1) || (b.purchases ?? 0) - (a.purchases ?? 0));
    const panel = openDrawer({ title: `معاينة نتائج سياسة CPA v${d.policy.version}`, body: `<div class="opx-notice blue"><div class="grow"><b>معاينة فقط — مفيش اختيار اتغيّر ولا حاجة اتنفذت</b><small>${num(pv.counts.matched)} مطابقة · ${num(pv.counts.eligible)} مؤهلة · ${num(pv.counts.excluded)} مستبعدة · عمر بيانات Meta ${num(pv.dataAgeMin)} دقيقة</small></div></div>
      <div class="opx-chips" style="margin:10px 0">${[['ALL', 'الكل'], ['ELIGIBLE', 'مؤهلة'], ['EXCLUDED', 'مستبعدة'], ['OUT_OF_RANGE', 'خارج النطاق'], ['UNKNOWN_CPA', 'CPA غير معروف']].map(([k, t]) => `<button class="opx-chip ${flt === k ? 'on' : ''}" data-f="${k}">${t}</button>`).join('')}</div>
      <div class="opx-scroll" style="max-height:60vh"><table class="opx-table"><thead><tr><th>الحملة</th><th>الحكم</th><th class="num">CPA</th><th class="num">أوردرات</th><th>السبب</th></tr></thead><tbody>${rows.map((r) => `<tr><td><b>${E(r.productName || '—')}</b><small>${E(r.campaignName || r.campaignId)}</small></td><td>${pill(CPA_V[r.verdict][1], CPA_V[r.verdict][0])}</td><td class="num">${r.cpa == null ? 'غير متاح' : num(r.cpa)}</td><td class="num">${r.purchases == null ? '—' : num(r.purchases)}</td><td class="opx-why">${r.verdict === 'ELIGIBLE' ? 'اجتازت كل الشروط' : E((r.reasons || []).join(' · ')) + ((r.guardCodes || []).length ? '<small>' + E(r.guardCodes.map((c) => BLOCK_AR[c] || c).join(' · ')) + '</small>' : '')}</td></tr>`).join('') || '<tr><td colspan="5" class="opx-empty">مفيش</td></tr>'}</tbody></table></div>` });
    panel.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { flt = b.dataset.f; show(); }; }); };
  show();
}
const plansOfType = () => [P.ov?.plans?.[P.type], ...((P.ov?.oneOffPlans || []).filter((p) => p.type === P.type))].filter(Boolean);
const plan = () => { const all = plansOfType(); return all.find((p) => p.key === P.sel) || P.ov?.plans?.[P.type] || all[0] || null; };
const planLabel = (p) => (p.key.includes('|P-') ? `خطة ${cairoTime(p.scheduledAt)} (منتج بموعد خاص)` : p.key.includes('|T-') ? `خطة إضافية ${cairoTime(p.preparedAt)}` : `الخطة الأساسية ${META[P.type].slot}`);
const saveF = () => store.set(`opx.f.${P.type}`, JSON.stringify(P.f));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// derived data
// ---------------------------------------------------------------------------------------------------------------------------------------------
const PERIOD_CHIPS = [['today', 'اليوم'], ['7', '7 أيام'], ['30', '30 يوم'], ['90', '90 يوم'], ['custom', 'فترة مخصصة']];
const todayStr = () => (P.board?.today || new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' })); // the Cairo calendar day
const periodLabel = () => ({ today: 'اليوم', 7: '7د', 30: '30د', 90: '90د', custom: 'الفترة' }[P.f.period] || '');
const periodTitle = () => (P.f.period === 'custom' ? (P.f.from && P.f.to ? `${P.f.from} → ${P.f.to}` : 'فترة مخصصة') : P.f.period === 'today' ? 'اليوم' : `${P.f.period} ${P.f.period === '7' ? 'أيام' : 'يوم'}`);
const cpaOf = (spend, purchases) => (Number(purchases) > 0 && spend != null ? Math.round(Number(spend) / Number(purchases)) : null); // CPA = spend / purchases of the SAME window; no purchases = not available (never 0)
const EMPTY_M = { spend: null, purchases: null, cpa: null };

function mkRow(id, item, b) {
  const e = item?.evidence || {}; const status = b?.status || e.status || (P.type === 'OPEN' ? 'PAUSED' : 'ACTIVE');
  return { id, item, b, name: item?.campaignName || b?.campaignName || id, product: item?.productName || b?.productName || null, productId: item?.productId ?? b?.productId ?? null, storeId: item?.storeId || b?.storeId || null, status,
    candidate: !!item, protectedF: item?.eligibility === 'PROTECTED' || b?.tag === 'PROTECTED', blockedF: item?.eligibility === 'BLOCKED' || !!b?.exceptions?.length, budget: b?.budget ?? e.budget ?? null, budgetLevel: b?.budgetLevel || e.budgetLevel || null, zones: b?.zones || null };
}
function allRows() {
  const p = plan(); const items = p?.items || []; const out = []; const seen = new Set();
  for (const i of items) { out.push(mkRow(i.campaignId, i, P.bmap.get(i.campaignId))); seen.add(i.campaignId); }
  for (const b of P.board?.rows || []) if (!seen.has(b.campaignId)) out.push(mkRow(b.campaignId, null, b));
  return out;
}
/** Today / 7D / 30D of a row — the board (Cairo day, last snapshot of each day) first, the plan's own evidence as a fallback */
function mt(r, k) {
  if (r.b?.[k]) return r.b[k];
  const e = r.item?.evidence || {}; const m = { today: e.today, d7: e.m7, d30: e.m30 }[k]; if (!m) return EMPTY_M;
  return { spend: m.spend ?? null, purchases: m.purchases ?? null, cpa: cpaOf(m.spend, m.purchases) };
}
function pv(r) { const p = P.f.period; if (p === 'today') return mt(r, 'today'); if (p === '7') return mt(r, 'd7'); if (p === '30') return mt(r, 'd30'); const m = P.pm?.map?.[r.id]; return m ? { spend: m.spend, purchases: m.purchases, cpa: m.cpa } : EMPTY_M; }
async function ensurePeriodMetrics() {
  const p = P.f.period; P.pmErr = null;
  if (p !== '90' && p !== 'custom') return;
  if (p === 'custom' && !(P.f.from && P.f.to)) { P.pm = { key: null, map: {} }; return; }
  const ids = allRows().filter(matchView).map((r) => r.id).slice(0, 300); if (!ids.length) { P.pm = { key: null, map: {} }; return; }
  const qs = p === 'custom' ? { from: P.f.from, to: P.f.to } : { days: 90 }; const key = JSON.stringify([plan()?.key, P.f.view, qs, ids.length]); if (P.pm?.key === key) return;
  try { const r = await api.get('/api/operator/campaign-metrics', { ...qs, ids: ids.join(',') }); P.pm = { key, map: r.metrics, window: r.window }; }
  catch (e) { P.pm = { key: null, map: {} }; P.pmErr = e.message; }
}
function matchView(r) {
  switch (P.f.view) { case 'candidates': return r.candidate; case 'active': return r.status === 'ACTIVE'; case 'paused': return r.status === 'PAUSED'; case 'protected': return r.protectedF; case 'blocked': return r.blockedF; default: return true; }
}
function visibleRows(rows = allRows()) {
  const q = P.f.q.trim().toLowerCase();
  let out = rows.filter((r) => matchView(r) && (!q || `${r.name || ''} ${r.product || ''} ${r.id}`.toLowerCase().includes(q)) && (!P.f.store || (r.storeId || '') === P.f.store) && (!P.f.cat || catOf(r.item).has(P.f.cat)));
  const orders = (r) => pv(r).purchases ?? -1, cpa = (r) => (pv(r).cpa == null ? Infinity : Number(pv(r).cpa));
  const MIN = 3; // a CPA from a tiny sample must not outrank a proven campaign
  const by = {
    purchases: (a, b) => orders(b) - orders(a) || ((orders(b) >= MIN) - (orders(a) >= MIN)) || cpa(a) - cpa(b),
    cpa: (a, b) => ((orders(b) >= MIN) - (orders(a) >= MIN)) || cpa(a) - cpa(b) || orders(b) - orders(a),
    spend: (a, b) => (pv(b).spend ?? -1) - (pv(a).spend ?? -1) || orders(b) - orders(a),
    budget: (a, b) => (b.budget ?? -1) - (a.budget ?? -1) || orders(b) - orders(a),
    score: (a, b) => (b.item?.evidence?.priority?.score ?? -1) - (a.item?.evidence?.priority?.score ?? -1), rank: (a, b) => (a.item?.rank ?? 1e9) - (b.item?.rank ?? 1e9),
  }[P.f.sort] || (() => 0);
  return [...out].sort(by);
}
const recentWorse = (e) => e?.m7?.cpa != null && e?.m30?.cpa != null && (e.m7.purchases ?? 0) >= 3 && e.m7.cpa > e.m30.cpa * 1.25;
/** CPA chip coloured from the REAL policy of the product (its active policy over the global budget policy). No policy = a neutral chip: no limit is invented. */
function cpaChip(m, r) {
  if (!m || m.cpa == null) return `<span class="opx-cpa na" title="${m?.purchases === 0 ? 'لا توجد أوردرات في هذه الفترة — CPA غير متاح' : 'لا توجد بيانات'}">غير متاح</span>`;
  const z = r.zones; const n = Number(m.cpa); const cls = !z ? 'plain' : n <= z.good ? 'good' : n <= z.mid ? 'mid' : n <= z.warn ? 'warn' : 'bad';
  return `<span class="opx-cpa ${cls}"${z ? ` title="${E(z.source === 'PRODUCT_POLICY' ? 'حسب سياسة المنتج المفعّلة' : 'حسب سياسة الميزانية العامة')}"` : ' title="لا توجد حدود CPA محددة لهذا المنتج"'}>${num(n)}</span>`;
}
const warnOf = (r) => {
  const i = r.item; const e = i?.evidence || {}; const w = []; if (!i) { if (r.blockedF) w.push('عليها استثناء/منع'); return w; }
  if (i.risk === 'HIGH') w.push('مخاطرة مرتفعة'); (i.blockCodes || []).forEach((c) => w.push(BLOCK_AR[c] || c)); if (recentWorse(e)) w.push('الأداء الحديث أسوأ من التاريخي'); return w;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------------------------------------------------------------------------
function draw() {
  const m = META[P.type], p = plan(), c = P.ov.control || {}; const rowsAll = allRows(); const rows = visibleRows(rowsAll); const sel = (p?.items || []).filter((i) => i.selected); const selRows = rowsAll.filter((r) => r.item?.selected);
  const layout = layoutOf(); P.layout = layout; const narrow = layout === 'cards';
  const pageRows = rows.slice(0, P.shown); const moreBtn = rows.length > P.shown ? `<div style="padding:12px;text-align:center"><button class="opx-btn" data-act="more">عرض المزيد (${num(rows.length - P.shown)} حملة متبقية)</button></div>` : '';
  const editable = p && p.status === 'PREPARED' && P.ctx.isAdmin; const lastBudget = sel.reduce((t, i) => t + (Number(i.evidence?.budget) || 0), 0);
  const orders = selRows.reduce((t, r) => t + (Number(pv(r).purchases) || 0), 0); const cpas = selRows.map((r) => ({ c: Number(pv(r).cpa), w: Number(pv(r).purchases) || 0 })).filter((x) => x.c > 0 && x.w > 0);
  const avgCpa = cpas.length ? cpas.reduce((t, x) => t + x.c * x.w, 0) / cpas.reduce((t, x) => t + x.w, 0) : null;
  const perm = !!c[m.permKey]; const live = c.mode === 'APPROVAL' && !c.writesLocked && perm && !c.emergencyStop;
  const stores = [...new Set(rowsAll.map((r) => r.storeId).filter(Boolean))];
  const next = P.ov.dashboard?.nextByType?.[P.type]; const nextAt = next?.at ? new Date(next.at) : null;
  const stateText = c.emergencyStop ? 'إيقاف طوارئ مفعّل' : live ? 'التنفيذ الفعلي مفتوح' : c.writesLocked ? 'كتابة Meta مقفولة — محاكاة فقط' : c.mode !== 'APPROVAL' ? `الوضع ${MODE_AR[c.mode] || c.mode} — لا تنفيذ فعلي` : `صلاحية ${m.verb} مقفولة`;
  const counts = Object.fromEntries(VIEWS.map(([k]) => [k, rowsAll.filter((r) => { const keep = P.f.view; P.f.view = k; const ok = matchView(r); P.f.view = keep; return ok; }).length]));
  const viewLabel = VIEWS.find(([k]) => k === P.f.view)?.[1] || '';
  $('opxPlanBody').innerHTML = `
    <div class="opx-card opx-head opx-fade">
      <div class="opx-head-icon ${m.tone}">${ICONS[m.icon]}</div>
      <div class="grow"><h1>${m.title}</h1><p>${E(m.sub)}</p></div>
      ${P.ctx.modeSegment()}
      <div class="opx-state"><span class="opx-switch ${live ? 'on' : ''}" aria-hidden="true"></span><div><b>${E(stateText)}</b><small>${c.writesLocked ? 'قفل النشر مقفول' : 'قفل النشر مفتوح'} · صلاحية ${m.verb}: ${perm ? 'ON' : 'OFF'}</small></div></div>
    </div>
    <div class="opx-kpis">
      ${kpiCard({ label: `حملة مرشحة لل${m.verb}`, value: num(p?.counts?.total ?? p?.items?.length ?? 0), icon: 'megaphone', tone: 'violet' })}
      ${kpiCard({ label: 'حملة مختارة', value: num(sel.length), icon: 'check', tone: 'green' })}
      ${kpiCard({ label: `أوردرات المختار (${periodTitle()})`, value: num(orders), icon: 'cart', tone: 'blue' })}
      ${kpiCard({ label: 'متوسط CPA (موزون)', value: avgCpa == null ? 'غير متاح' : `${num(avgCpa)} ج.م`, icon: 'target', tone: 'amber' })}
      ${kpiCard({ label: 'إجمالي الميزانيات المختارة', value: egp(lastBudget), icon: 'coins', tone: 'red' })}
    </div>
    ${p ? `<div class="opx-notice ${m.tone === 'red' ? 'red' : 'green'} opx-fade"><div class="opx-head-icon ${m.tone}" style="width:44px;height:44px">${ICONS.check}</div><div class="grow"><b>${m.banner}</b><small>${p.status === 'PREPARED' ? 'راجع التحديد ثم اعتمد. إغلاق الشاشة لا يعتبر موافقة.' : `حالة الخطة: ${E(p.status)}`} · بيانات Meta بتاريخ ${E(cairoDateTime(p.dataAsOf || p.preparedAt))}${p.dataState === 'STALE' ? ' ⚠️ قديمة' : ''}</small></div>
      <div class="opx-count" id="opxCountdown">${countdownHtml(nextAt)}</div></div>` : `<div class="opx-notice amber"><div class="grow"><b>مفيش خطة ${m.verb} لليوم بعد</b><small>الخطة بتتجهز على السيرفر في الموعد (${m.slot} بتوقيت القاهرة)، أو ابدأ خطة الآن.</small></div></div>`}
    <div class="opx-work opx-work-plan">
      <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
        ${P.type === 'OPEN' ? cpaPanel(p, editable) : ''}
        ${plansOfType().length > 1 ? `<div class="opx-card opx-filters" id="opxPlans">${plansOfType().map((x) => `<button class="opx-chip ${x.key === (p?.key) ? 'on' : ''}" data-plan="${E(x.key)}">${E(planLabel(x))} · ${num(x.counts?.total)} حملة</button>`).join('')}</div>` : ''}
        <div class="opx-card opx-filters">
          <div class="opx-chips opx-views" role="group" aria-label="عرض الحملات">${VIEWS.map(([k, t]) => `<button class="opx-chip ${P.f.view === k ? 'on' : ''}" data-view="${k}">${t} <span class="opx-chip-n">${num(counts[k])}</span></button>`).join('')}</div>
          <div class="opx-chips" role="group" aria-label="الفترة">${PERIOD_CHIPS.map(([k, t]) => `<button class="opx-chip ${P.f.period === k ? 'on' : ''}" data-period="${k}">${t}</button>`).join('')}</div>
          ${P.f.period === 'custom' ? `<div class="opx-range"><label>من<input class="opx-input" type="date" id="opxFrom" max="${todayStr()}" value="${E(P.f.from)}"></label><label>إلى<input class="opx-input" type="date" id="opxTo" max="${todayStr()}" value="${E(P.f.to)}"></label><button class="opx-btn sm primary" id="opxApplyRange">تطبيق</button></div>` : ''}
          ${P.pmErr ? `<div class="opx-note bad" style="flex:1 1 100%">⚠️ ${E(P.pmErr)}</div>` : ''}
          <input class="opx-input opx-search" id="opxQ" placeholder="ابحث باسم المنتج أو الحملة…" value="${E(P.f.q)}">
          ${stores.length > 1 ? `<select class="opx-select" id="opxStore"><option value="">كل المتاجر</option>${stores.map((s) => `<option ${P.f.store === s ? 'selected' : ''}>${E(s)}</option>`).join('')}</select>` : ''}
          ${P.type === 'PAUSE' ? `<select class="opx-select" id="opxCat"><option value="">كل التصنيفات</option>${Object.entries(PAUSE_CATS).map(([k, v]) => `<option value="${k}" ${P.f.cat === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : ''}
          <select class="opx-select" id="opxSort" aria-label="الترتيب">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${P.f.sort === k ? 'selected' : ''}>ترتيب: ${v}${['purchases', 'cpa', 'spend'].includes(k) ? ' — ' + periodLabel() : ''}</option>`).join('')}</select>
        </div>
        <div class="opx-card opx-tablecard opx-fade">
          <div class="opx-tablehead"><h3>الحملات — ${E(viewLabel)} (${num(rows.length)} حملة${rows.length > P.shown ? ` — المعروض ${num(P.shown)}` : ''})<small class="opx-sub">اليوم = ${E(P.board?.today || '—')} بتوقيت القاهرة · CPA = الصرف ÷ الأوردرات لنفس الفترة${P.board?.staleExcluded ? ` · استُبعدت ${num(P.board.staleExcluded)} حملة لقدم بياناتها` : ''}${P.board ? '' : ' · ⚠️ تعذّر تحميل كل الحملات — المعروض المرشحة فقط'}</small></h3>
            <button class="opx-btn sm opx-set-btn" data-act="settings">${ICONS.clock} إعدادات الجدولة</button>
            <button class="opx-btn sm" data-act="eligible" ${editable ? '' : 'disabled'}>${ICONS.check} تحديد المؤهل</button><button class="opx-btn sm" data-act="none" ${editable ? '' : 'disabled'}>${ICONS.x} إلغاء التحديد</button>
            <button class="opx-btn sm" data-act="new" ${P.ctx.isAdmin ? '' : 'disabled'}>${ICONS.plus} إنشاء خطة جديدة</button></div>
          ${narrow
            ? `<div class="opx-cards" style="display:flex">${pageRows.length ? pageRows.map((r) => rowCard(r, editable)).join('') : `<div class="opx-empty">${E(m.empty)}</div>`}${moreBtn}</div>`
            : `<div class="opx-scroll opx-desk">${pageRows.length ? table(pageRows, editable, layout === 'xl') : `<div class="opx-empty">${E(m.empty)}</div>`}${moreBtn}</div>`}
          <div class="opx-foot"><div class="grow"><b>تم تحديد ${num(sel.length)} حملة</b> <span class="opx-note">· إجمالي الميزانية المقترحة: <b style="color:var(--opx-text)">${egp(lastBudget)}</b></span></div>
            <button class="opx-btn" data-act="preview" ${p && sel.length ? '' : 'disabled'}>${ICONS.eye} معاينة التنفيذ</button>
            <button class="opx-btn primary" data-act="approve" ${editable && sel.length ? '' : 'disabled'}>${ICONS[m.icon]} اعتماد المحدد (${num(sel.length)})</button></div>
        </div>
      </div>
      <aside class="opx-card opx-panel opx-fade">${panelHtml(p, c, nextAt)}</aside>
    </div>
    <div class="opx-actionbar" id="opxActionBar"><div class="opx-ab-info"><b>${num(sel.length)}</b> حملة مختارة<small>${egp(lastBudget)}</small></div><button class="opx-btn" data-act="preview" ${p && sel.length ? '' : 'disabled'}>${ICONS.eye} معاينة</button><button class="opx-btn primary" data-act="approve" ${editable && sel.length ? '' : 'disabled'}>${ICONS[m.icon]} اعتماد</button></div>`;
  wire(p, editable);
  hydrateThumbs($('opxPlanBody'));
}
function countdownHtml(at) {
  if (!at) return '<div><b>—</b><small>الموعد القادم</small></div>';
  const ms = Math.max(0, at.getTime() - Date.now()); const h = Math.floor(ms / 3600000), mi = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000); const z = (n) => String(n).padStart(2, '0');
  return `<div><b>${z(s)}</b><small>ثانية</small></div><div><b>${z(mi)}</b><small>دقيقة</small></div><div><b>${z(h)}</b><small>ساعة</small></div>`;
}
function tickCountdown() { const el = $('opxCountdown'); const at = P.ov?.dashboard?.nextByType?.[P.type]?.at; if (el && at) el.innerHTML = countdownHtml(new Date(at)); }

// ---- the table: RTL, checkbox + campaign sticky; columns grouped TODAY / LAST 7 DAYS / LAST 30 DAYS (+ the chosen 90D / custom period)
function table(rows, editable, xl) {
  const extra = P.f.period === '90' || P.f.period === 'custom';
  const grp = (cls, en, ar, span) => `<th colspan="${span}" class="grp ${cls}"><span>${en}</span><small>${ar}</small></th>`;
  const sub = (cls, t, c = '') => `<th class="num sub ${cls} ${c}">${t}</th>`;
  const head = `<thead>
    <tr class="r1"><th rowspan="2" class="stk s0"></th><th rowspan="2" class="stk s1">الحملة / المنتج</th><th rowspan="2">الحالة</th>
      ${grp('g-today', 'TODAY', 'اليوم', xl ? 3 : 2)}${grp('g-7', 'LAST 7 DAYS', 'آخر 7 أيام', 2)}${grp('g-30', 'LAST 30 DAYS', 'آخر 30 يوم', 2)}${extra ? grp('g-x', P.f.period === '90' ? 'LAST 90 DAYS' : 'CUSTOM RANGE', periodTitle(), 3) : ''}
      <th rowspan="2" class="num">الميزانية اليومية</th><th rowspan="2"></th></tr>
    <tr class="r2">${sub('g-today', 'أوردرات')}${sub('g-today', 'CPA')}${xl ? sub('g-today', 'صرف') : ''}${sub('g-7', 'أوردرات')}${sub('g-7', 'CPA')}${sub('g-30', 'أوردرات')}${sub('g-30', 'CPA')}${extra ? `${sub('g-x', 'أوردرات')}${sub('g-x', 'CPA')}${sub('g-x', 'صرف')}` : ''}</tr></thead>`;
  return `<table class="opx-table opx-board ${xl ? 'xl' : ''}"><colgroup></colgroup>${head}<tbody>${rows.map((r) => boardRow(r, editable, xl, extra)).join('')}</tbody></table>`;
}
const statusPill = (r) => (r.status === 'ACTIVE' ? pill('نشطة', 'green') : r.status === 'PAUSED' ? pill('متوقفة', 'amber') : pill(E(r.status), 'gray'));
function tagLine(r) {
  const i = r.item; const out = [];
  if (i) { const tone = i.eligibility === 'ELIGIBLE' ? 'green' : i.eligibility === 'BLOCKED' ? 'red' : i.eligibility === 'PROTECTED' ? 'blue' : 'amber'; out.push(pill(i.eligibility === 'ELIGIBLE' ? 'مؤهلة' : (ELIG_AR[i.eligibility] || i.eligibility), tone)); if (i.status && i.status !== 'PENDING') out.push(pill(E(ITEM_AR[i.status] || i.status), ITEM_PILL[i.status] || 'gray')); }
  const cp = i?.evidence?.cpaPolicy; if (cp && P.cpa?.policy?.enabled !== undefined && cp.verdict) out.push(cp.verdict === 'ELIGIBLE' ? pill('✓ مطابقة CPA', 'green', `CPA ${cp.cpa} · ${cp.purchases} أوردر`) : cp.verdict === 'EXCLUDED' ? pill('⊖ ' + (cp.reasons?.[0] || 'مستبعدة'), 'amber', (cp.reasons || []).join(' · ')) : pill(cp.verdict === 'OUT_OF_RANGE' ? 'خارج نطاق CPA' : 'CPA غير معروف', 'gray', (cp.reasons || []).join(' · ')));
  if (i?.evidence?.userDeselected) out.push(pill('استبعاد يدوي', 'gray', 'استبعدتها بنفسك — لا تُختار تلقائيًا'));
  if (!i) { out.push(pill('غير مرشحة', 'gray')); if (r.protectedF) out.push(pill('محمية', 'blue')); if (r.blockedF) out.push(pill('استثناء', 'red')); }
  return `<div class="opx-tags">${out.join('')}</div>`;
}
function nameCell(r) {
  const w = warnOf(r); const pausedBy = r.item?.evidence?.pausedBy;
  return `<div class="opx-prod">${thumb(r.productId, r.product || r.name)}<div class="opx-prod-t"><b>${E(r.product || 'بدون منتج')}${w.length ? ` <span class="opx-warn" title="${E(w.join(' · '))}" aria-label="تحذير">⚠</span>` : ''}</b><small>${E(r.name || r.id)}${r.storeId && r.storeId !== 'default' ? ' · ' + E(r.storeId) : ''}${pausedBy && P.type === 'OPEN' ? ' · ' + E({ DAILY_SCHEDULE: 'روتين يومي', SYSTEM: 'السيستم', MANUAL: 'يدوي', UNKNOWN_OLD: 'سبب غير معروف' }[pausedBy] || '') : ''}</small></div></div>`;
}
const orderCell = (m, k) => `<td class="num" data-k="${k}">${m.purchases == null ? '—' : num(m.purchases)}</td>`;
const cpaTd = (m, r, k) => `<td class="num" data-k="${k}">${cpaChip(m, r)}</td>`;
function boardRow(r, editable, xl, extra) {
  const i = r.item; const dis = !editable || !i?.selectable ? 'disabled' : ''; const t = mt(r, 'today'), d7 = mt(r, 'd7'), d30 = mt(r, 'd30'), x = extra ? pv(r) : null;
  return `<tr class="${!i || i.eligibility !== 'ELIGIBLE' ? 'dim' : ''} ${i?.selected ? 'is-sel' : ''}" data-cid="${E(r.id)}">
    <td class="stk s0">${i ? `<input type="checkbox" class="opx-check" data-cid="${E(r.id)}" ${i.selected ? 'checked' : ''} ${dis} aria-label="اختيار الحملة">` : '<span class="opx-nochk" title="غير مرشحة — للعرض فقط">–</span>'}</td>
    <td class="stk s1">${nameCell(r)}</td><td>${statusPill(r)}${tagLine(r)}</td>
    ${orderCell(t, 'tOrders')}${cpaTd(t, r, 'tCpa')}${xl ? `<td class="num" data-k="tSpend">${t.spend == null ? '—' : num(t.spend)}</td>` : ''}
    ${orderCell(d7, 'o7')}${cpaTd(d7, r, 'c7')}${orderCell(d30, 'o30')}${cpaTd(d30, r, 'c30')}
    ${extra ? `${orderCell(x, 'xOrders')}${cpaTd(x, r, 'xCpa')}<td class="num" data-k="xSpend">${x.spend == null ? '—' : num(x.spend)}</td>` : ''}
    <td class="num" data-k="budget"><b>${r.budget == null ? '—' : egp(r.budget)}</b>${r.budgetLevel ? `<small>${E(r.budgetLevel)}</small>` : ''}</td>
    <td><button class="opx-btn ghost sm" data-row="${E(r.id)}" aria-label="تفاصيل الحملة">⋯</button></td></tr>`;
}
// ---- phone: one card per campaign — selection, Today / 7D / 30D, budget
function rowCard(r, editable) {
  const i = r.item; const dis = !editable || !i?.selectable ? 'disabled' : ''; const t = mt(r, 'today'), d7 = mt(r, 'd7'), d30 = mt(r, 'd30'); const w = warnOf(r);
  const cell = (lbl, m) => `<div><span>${lbl}</span><b>${m.purchases == null ? '—' : num(m.purchases)} <small>أوردر</small></b>${cpaChip(m, r)}</div>`;
  return `<article class="opx-c2 ${!i || i.eligibility !== 'ELIGIBLE' ? 'dim' : ''} ${i?.selected ? 'sel' : ''}" data-cid="${E(r.id)}">
    ${i ? `<label class="opx-c2-chk" aria-label="اختيار الحملة"><input type="checkbox" class="opx-check" data-cid="${E(r.id)}" ${i.selected ? 'checked' : ''} ${dis}></label>` : ''}
    <div class="opx-c2-top" ${i ? '' : 'style="padding-left:0"'}>${thumb(r.productId, r.product || r.name)}<div class="opx-c2-name"><b>${E(r.product || 'بدون منتج')}${w.length ? ` <span class="opx-warn" title="${E(w.join(' · '))}">⚠</span>` : ''}</b><small>${E(r.name || r.id)}</small></div>${statusPill(r)}</div>
    <div class="opx-c2-grid g3">${cell('TODAY', t)}${cell('7D', d7)}${cell('30D', d30)}</div>
    <div class="opx-c2-foot">${tagLine(r)}<span class="opx-c2-bud">${r.budget == null ? '' : `${egp(r.budget)}${r.budgetLevel ? ' · ' + E(r.budgetLevel) : ''}`}</span><button class="opx-btn ghost sm" data-row="${E(r.id)}">تفاصيل</button></div>
  </article>`;
}
function panelHtml(p, c, nextAt) {
  const m = META[P.type]; const last = P.ov.dashboard?.lastPlan; const sched = c.scheduledExecution;
  const status = c.emergencyStop ? ['red', 'إيقاف طوارئ'] : c.halted ? ['red', 'موقوف يدويًا'] : ['green', 'شغال'];
  return `<h3>${ICONS.clock} إعدادات الجدولة</h3>
    <div><div class="opx-kv"><span>حالة الـScheduler</span><b>${pill(status[1], status[0])}</b></div>
      <div class="opx-kv"><span>موعد هذه الخطة (القاهرة)</span><b>${p ? E(cairoTime(p.scheduledAt)) : m.slot}</b></div>
      <div class="opx-kv"><span>الموعد القادم</span><b>${nextAt ? E(cairoDateTime(nextAt.toISOString())) : '—'}</b></div>
      <div class="opx-kv"><span>آخر تشغيل</span><b>${last ? `${E(last.type === 'OPEN' ? 'فتح' : 'إيقاف')} ${E(last.date)} — ${E(last.status)}` : '—'}</b></div>
      <div class="opx-kv"><span>وضع التنفيذ</span><b>${E(MODE_AR[c.mode] || c.mode)}</b></div>
      <div class="opx-kv"><span>التنفيذ المجدول</span><b>${sched ? pill('مفعّل', 'green') : pill('OFF — الخطة تتجهز فقط', 'gray')}</b></div>
      <div class="opx-kv"><span>الفاصل بين العمليات</span><b>${num(c.spacingSeconds ?? 3)} ث</b></div></div>
    <div class="opx-actions">${P.ctx.isAdmin ? `<button class="opx-btn sm" data-p="spacing">ضبط الفاصل بين عمليات Meta</button><button class="opx-btn sm ${c.halted ? 'danger' : ''}" data-p="halt">${c.halted ? 'استئناف الجدولة' : 'إيقاف الجدولة مؤقتًا'}</button>` : ''}${p && ['PREPARED', 'APPROVED'].includes(p.status) && P.ctx.isAdmin ? '<button class="opx-btn sm ghost" data-p="cancel">إلغاء خطة اليوم</button>' : ''}</div>
    <p class="opx-note">إغلاق الشاشة لا يعتبر موافقة. التنفيذ بيحصل واحدة واحدة بعد إعادة التحقق من Meta وقراءة مستقلة بعده.${P.ctx.statusExtra?.() || ''}</p>`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// interactions
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function saveSelection(selections, special = []) {
  const p = plan(); if (!p) return;
  try {
    const r = await api.put(`${API}/${p.id}/selection`, { selections, special });
    if (r.newVersion) toast(`اتحفظت نسخة جديدة v${r.plan.version} — لازم تعتمدها من جديد`, 'warning');
    { const oi = (P.ov.oneOffPlans || []).findIndex((x) => x.key === r.plan.key); if (oi >= 0) P.ov.oneOffPlans[oi] = r.plan; else P.ov.plans[P.type] = r.plan; } draw();
  } catch (e) { toast(e.message, 'error'); await load(); }
}
function wirePanel(scope, p) {
  const on = (k, fn) => { const b = scope.querySelector(`[data-p="${k}"]`); if (b) b.onclick = fn; };
  on('spacing', async () => { const v = prompt('الفاصل بين عمليات Meta بالثواني (3 – 120):', String(P.ov.control.spacingSeconds ?? 3)); if (v == null) return; try { await api.put(`${API}/config`, { spacingSeconds: Number(v) }); toast('تم'); closeDrawer(); await load(); } catch (e) { toast(e.message, 'error'); } });
  on('halt', async () => { try { await api.post(`${API}/halt`, { halted: !P.ov.control.halted }); toast('تم'); closeDrawer(); await load(); } catch (e) { toast(e.message, 'error'); } });
  on('cancel', async () => { if (!(await confirmModal({ title: 'إلغاء الخطة', message: 'الخطة هتتلغي ومش هيتنفذ منها حاجة.', confirmLabel: 'إلغاء الخطة', danger: true }))) return; try { await api.post(`${API}/${p.id}/cancel`, { reason: 'إلغاء من المستخدم' }); toast('اتلغت'); closeDrawer(); await load(); } catch (e) { toast(e.message, 'error'); } });
}
function wire(p, editable) {
  const root = $('opxPlanBody');
  const rerender = (fn) => { fn(); saveF(); P.shown = PAGE; draw(); };
  $('opxQ').oninput = (e) => { P.f.q = e.target.value; saveF(); const pos = e.target.selectionStart; clearTimeout(P.qTimer); P.qTimer = setTimeout(() => { P.shown = PAGE; draw(); const q = $('opxQ'); if (q) { q.focus(); q.setSelectionRange(pos, pos); } }, 220); };
  root.querySelectorAll('[data-plan]').forEach((b) => { b.onclick = async () => { P.sel = b.dataset.plan; P.shown = PAGE; P.pm = null; await ensurePeriodMetrics(); draw(); }; });
  root.querySelectorAll('[data-view]').forEach((b) => { b.onclick = async () => { P.f.view = b.dataset.view; P.shown = PAGE; saveF(); await ensurePeriodMetrics(); draw(); }; });
  root.querySelectorAll('[data-period]').forEach((b) => { b.onclick = async () => { P.f.period = b.dataset.period; P.shown = PAGE; if (P.f.period === 'custom' && !P.f.to) { P.f.to = todayStr(); const d = new Date(`${todayStr()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 13); P.f.from = d.toISOString().slice(0, 10); } saveF(); await ensurePeriodMetrics(); draw(); }; });
  if ($('opxApplyRange')) $('opxApplyRange').onclick = async () => {
    const f = $('opxFrom').value, t = $('opxTo').value; const bad = (m) => { P.pmErr = m; P.pm = { key: null, map: {} }; draw(); };
    if (!f || !t) return bad('اختار تاريخ البداية والنهاية.'); if (f > t) return bad('تاريخ البداية لازم يكون قبل أو يساوي تاريخ النهاية.'); if (t > todayStr()) return bad('تاريخ النهاية لا يمكن أن يكون في المستقبل.');
    if ((Date.parse(t) - Date.parse(f)) / 86400000 + 1 > 366) return bad('الفترة أطول من 366 يوم.');
    P.f.from = f; P.f.to = t; saveF(); await ensurePeriodMetrics(); draw();
  };
  if ($('opxStore')) $('opxStore').onchange = (e) => rerender(() => { P.f.store = e.target.value; });
  if ($('opxCat')) $('opxCat').onchange = (e) => rerender(() => { P.f.cat = e.target.value; });
  $('opxSort').onchange = (e) => rerender(() => { P.f.sort = e.target.value; });
  root.querySelectorAll('.opx-check').forEach((c) => { c.onchange = async () => {
    const it = p.items.find((x) => x.campaignId === c.dataset.cid); let special = [];
    if (c.checked && it?.eligibility === 'NEEDS_SPECIAL_APPROVAL') {
      if (!(await confirmModal({ title: '⚠️ موافقة خاصة', message: `الحملة «${it.campaignName || it.campaignId}» اتوقفت ${it.evidence?.pausedBy === 'MANUAL' ? 'يدويًا' : 'لسبب غير معروف'}. تأكيد إنك عايز تفتحها؟`, confirmLabel: 'موافقة خاصة' }))) { c.checked = false; return; } special = [it.campaignId];
    }
    saveSelection({ [c.dataset.cid]: c.checked }, special); }; });
  root.querySelectorAll('[data-act]').forEach((b) => { b.onclick = async () => {
    const a = b.dataset.act;
    if (a === 'eligible') { const sel = {}; p.items.forEach((i) => { if (i.selectable && i.eligibility === 'ELIGIBLE') sel[i.campaignId] = P.type === 'OPEN' ? !!i.evidence?.recommended : !!i.evidence?.policyPause; }); await saveSelection(sel); }
    else if (a === 'none') { const sel = {}; p.items.forEach((i) => { if (i.selected) sel[i.campaignId] = false; }); await saveSelection(sel); }
    else if (a === 'more') { P.shown += PAGE; draw(); }
    else if (a === 'settings') { const panel = openDrawer({ title: 'إعدادات الجدولة', body: `<div class="opx-panel" style="padding:0">${panelHtml(p, P.ov.control || {}, P.ov.dashboard?.nextByType?.[P.type]?.at ? new Date(P.ov.dashboard.nextByType[P.type].at) : null)}</div>` }); wirePanel(panel, p); }
    else if (a === 'preview') await preview(p); else if (a === 'approve') await approve(p);
    else if (a === 'new') { try { await api.post(`${API}/new`, { type: P.type }); toast('بدأ تجهيز خطة جديدة'); await load(); } catch (e) { toast(e.message, 'error'); } }
  }; });
  root.querySelectorAll('[data-row]').forEach((b) => { b.onclick = () => rowDrawer(allRows().find((x) => x.id === b.dataset.row)); });
  wirePanel(root.querySelector('aside.opx-panel'), p);
  wireCpa(p);
}
async function approve(p) {
  const m = META[P.type]; const sel = p.items.filter((i) => i.selected); const c = P.ov.control || {}; const live = c.mode === 'APPROVAL' && !c.writesLocked && c[m.permKey];
  const msg = `${sel.length} حملة هتتعمل لها ${m.verb} ${live ? 'فعليًا على Meta واحدة واحدة (بفاصل ' + (c.spacingSeconds ?? 3) + ' ثواني، مع إعادة تحقق قبل كل واحدة وقراءة من Meta بعدها).' : 'كتنفيذ تجريبي (SHADOW): كل خطوة بتتسجل لكن مفيش أي كتابة على Meta.'}`;
  if (!(await confirmModal({ title: `اعتماد خطة ${m.verb} الحملات`, message: msg, confirmLabel: live ? 'اعتماد وتنفيذ' : 'اعتماد (محاكاة)', danger: !!live }))) return;
  try { const r = await api.post(`${API}/${p.id}/approve`, {}); if (!r.ok) { toast(r.message || 'الاعتماد اتمنع', 'error'); return; } toast(r.executionMode === 'LIVE' ? 'اتعتمدت — التنفيذ بدأ' : 'اتعتمدت — محاكاة SHADOW (مفيش كتابة على Meta)'); await load(); } catch (e) { toast(e.message, 'error'); }
}
async function preview(p) {
  const m = META[P.type]; openDrawer({ title: `معاينة التنفيذ — ${m.title}`, body: '<div class="opx-skel" style="height:220px"></div><p class="opx-note">بيراجع الحملات المختارة على Meta الحي (قراءة فقط، مفيش كتابة)…</p>' });
  try {
    const r = await api.post(`${API}/${p.id}/preview-execution`, {});
    const gate = r.gate.blocked ? `<div class="opx-notice red"><div class="grow"><b>الاعتماد دلوقتي هيتمنع</b><small>${E(r.gate.blocked.message)}</small></div></div>` : `<div class="opx-notice ${r.gate.mode === 'LIVE' ? 'red' : 'blue'}"><div class="grow"><b>${r.gate.mode === 'LIVE' ? 'الاعتماد هينفّذ فعليًا على Meta' : 'الاعتماد هيكون محاكاة (SHADOW)'}</b><small>${E(r.note || '')}</small></div></div>`;
    openDrawer({ title: `معاينة التنفيذ — ${m.title}`, body: `${gate}<div class="opx-scroll" style="max-height:60vh"><table class="opx-table"><thead><tr><th>الحملة</th><th>الميزانية</th><th>الحالة الحية</th><th>هيحصل إيه</th><th>السبب</th></tr></thead><tbody>${r.items.map((i) => `<tr><td><b>${E(i.campaignName || i.campaignId)}</b><small>${E(i.campaignId)}</small></td><td class="num">${egp(i.budget)}</td><td>${E(i.liveStatus || '—')}</td><td>${E(i.willDo || i.outcome || '—')}</td><td class="opx-why">${E(i.reason || '')}</td></tr>`).join('')}</tbody></table></div>` });
  } catch (e) { openDrawer({ title: 'معاينة التنفيذ', body: `<div class="opx-notice red"><div class="grow"><b>${E(e.message)}</b></div></div>` }); }
}
/** everything that does not fit a table cell: why it is a candidate, the Priority Score, guards, spend per window, the CPA policy used for the colours */
function rowDrawer(r) {
  if (!r) return; const i = r.item; const e = i?.evidence || {};
  const kv = (k, v) => `<div class="opx-kv"><span>${k}</span><b>${v}</b></div>`;
  const win = (lbl, m) => `<tr><td>${lbl}</td><td class="num">${m.purchases == null ? '—' : num(m.purchases)}</td><td class="num">${m.spend == null ? '—' : egp(m.spend)}</td><td class="num">${m.cpa == null ? 'غير متاح' : egp(m.cpa)}</td></tr>`;
  const t = mt(r, 'today'), d7 = mt(r, 'd7'), d30 = mt(r, 'd30'); const zones = r.zones ? `${r.zones.good} / ${r.zones.mid} / ${r.zones.warn} ج.م (${r.zones.source === 'PRODUCT_POLICY' ? 'سياسة المنتج المفعّلة' : 'سياسة الميزانية العامة'})` : 'لا توجد حدود CPA محددة — بدون ألوان';
  const blocks = (i?.blockCodes || []).map((c) => BLOCK_AR[c] || c); const risk = RISK[i?.risk];
  openDrawer({ title: E(r.name || r.id), body: `<div>${kv('المنتج', E(r.product || '—'))}${kv('Campaign ID', E(r.id))}${kv('الحالة على Meta', E({ ACTIVE: 'نشطة', PAUSED: 'متوقفة' }[r.status] || r.status))}${kv('الميزانية اليومية', `${r.budget == null ? '—' : egp(r.budget)} ${E(r.budgetLevel || '')}${r.b?.adsets ? ` · ${r.b.adsets} Ad Set` : ''}`)}
    ${kv('الربط بالمنتج', r.b?.mapping ? (r.b.mapping.verified ? 'مؤكد' : 'غير مؤكد (اقتراح)') : '—')}${kv('مرشحة؟', i ? `نعم — ${i.eligibility === 'ELIGIBLE' ? 'مؤهلة' : E(ELIG_AR[i.eligibility] || i.eligibility)}` : 'لا — للعرض فقط')}${risk ? kv('المخاطرة', `<span class="opx-pill ${risk[0]}">${risk[1]}</span>`) : ''}</div>
    <div class="opx-scroll" style="margin:12px 0"><table class="opx-table"><thead><tr><th>الفترة</th><th class="num">أوردرات</th><th class="num">الصرف</th><th class="num">CPA</th></tr></thead><tbody>${win('اليوم (القاهرة)', t)}${win('آخر 7 أيام', d7)}${win('آخر 30 يوم', d30)}${P.f.period === '90' || P.f.period === 'custom' ? win(periodTitle(), pv(r)) : ''}</tbody></table></div>
    <div>${kv('ألوان CPA (جيد / متوسط / تحذير)', E(zones))}${e.priority ? kv('Priority Score', `${e.priority.score} (${E(e.priority.band)})`) : ''}${i ? kv('سبب الترشيح', E(i.reason || '—')) : ''}${recentWorse(e) ? kv('تنبيه', 'الأداء الحديث أسوأ من التاريخي') : ''}</div>
    ${e.priority?.reasons?.length ? `<div><b>ليه السكور ده؟</b><ul class="opx-note">${e.priority.reasons.map((x) => `<li>${E(x)}</li>`).join('')}</ul></div>` : ''}
    ${e.cpaPolicy ? `<div>${kv('سياسة الفتح حسب CPA', E(`v${e.cpaPolicy.version} · ${WIN_AR[e.cpaPolicy.window] || e.cpaPolicy.window}`))}${kv('الحكم', E(CPA_V[e.cpaPolicy.verdict]?.[1] || e.cpaPolicy.verdict))}${kv('CPA / أوردرات / صرف', E(`${e.cpaPolicy.cpa == null ? 'غير متاح' : e.cpaPolicy.cpa} / ${e.cpaPolicy.purchases ?? '—'} / ${e.cpaPolicy.spend ?? '—'}`))}${(e.cpaPolicy.reasons || []).length ? kv('الأسباب', E(e.cpaPolicy.reasons.join(' · '))) : ''}</div>` : ''}
    ${blocks.length ? `<div class="opx-notice red"><div class="grow"><b>حواجز أمان</b><small>${E(blocks.join(' · '))}</small></div></div>` : ''}
    ${!i && r.b?.exceptions?.length ? `<div class="opx-notice red"><div class="grow"><b>استثناءات مفعّلة</b><small>${E(r.b.exceptions.join(' · '))}</small></div></div>` : ''}`,
  foot: i && P.ctx.isAdmin ? `<button class="opx-btn" id="opxExDay">استبعاد لليوم</button><button class="opx-btn danger" id="opxExAlways">استبعاد دائم</button><button class="opx-btn" id="opxProtect">حماية كـWinner</button>` : '' });
  const ex = (scope) => async () => { if (!(await confirmModal({ title: scope === 'DAY' ? 'استبعاد لليوم' : 'استبعاد دائم', message: `استبعاد «${r.name || r.id}» ${scope === 'DAY' ? 'من خطط النهارده' : 'من أي فتح/إيقاف تلقائي'}؟`, confirmLabel: 'استبعاد', danger: scope !== 'DAY' }))) return; try { await api.post(`${API}/exclude`, { campaignId: r.id, scope, label: r.name }); toast('تم الاستبعاد'); closeDrawer(); await load(); } catch (er) { toast(er.message, 'error'); } };
  if ($('opxExDay')) { $('opxExDay').onclick = ex('DAY'); $('opxExAlways').onclick = ex('ALWAYS'); $('opxProtect').onclick = async () => { try { await api.post(`${API}/protect`, { campaignId: r.id, label: r.name }); toast('اتحمت'); closeDrawer(); await load(); } catch (er) { toast(er.message, 'error'); } }; }
}
