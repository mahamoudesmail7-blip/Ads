// opx-rules.js — «قواعد المنتجات»: one policy per product (and per-campaign overrides) in a side drawer. Save = DRAFT (changes nothing); Activate = ADMIN confirm (AUTOMATIC asks again).
// Presentation over /api/operator/product-rules/*. Only fields the engine really consumes are shown (mode, days, own open/close time, CPA zones, zero-order stop, budget % / bounds, stock policy).
import { api } from './api-client.js';
import { E, $, num, egp, ICONS, kpiCard, pill, cpaCell, skeletonRows, openDrawer, closeDrawer, toast, confirmModal, thumb, hydrateThumbs } from './opx-ui.js';

const R = { ctx: null, root: null, list: [], f: { q: '', status: '', sort: 'orders' }, cur: null, polState: null };
const DAYS = [['0', 'الأحد'], ['1', 'الاثنين'], ['2', 'الثلاثاء'], ['3', 'الأربعاء'], ['4', 'الخميس'], ['5', 'الجمعة'], ['6', 'السبت']];
const ST = { NONE: ['gray', 'بدون سياسة'], DRAFT: ['amber', 'مسودة'], ACTIVE: ['green', 'مفعّلة'], ACTIVE_WITH_DRAFT: ['blue', 'مفعّلة + مسودة'] };
const MODE_AR = { MANUAL: 'MANUAL', APPROVAL: 'APPROVAL', AUTOMATIC: 'AUTOMATIC' };

export async function mountRulesWorkspace(root, ctx) {
  R.ctx = ctx; R.root = root; root.innerHTML = `<div class="opx-card">${skeletonRows(6)}</div>`;
  try { R.list = (await api.get('/api/operator/product-rules')).products; } catch (e) { root.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message)}</div>`; return; }
  draw();
}
const rows = () => {
  const q = R.f.q.trim().toLowerCase(); let l = R.list.filter((p) => (!q || `${p.name} ${p.productId} ${p.storeId}`.toLowerCase().includes(q)) && (!R.f.status || (R.f.status === 'ACTIVE' ? p.status.startsWith('ACTIVE') : p.status === R.f.status)));
  const by = { orders: (a, b) => b.purchases7 - a.purchases7, cpa: (a, b) => (a.cpa7 ?? 1e9) - (b.cpa7 ?? 1e9), campaigns: (a, b) => b.campaignCount - a.campaignCount }[R.f.sort]; return [...l].sort(by);
};
function draw() {
  const all = R.list; const act = all.filter((p) => p.status.startsWith('ACTIVE')).length, dr = all.filter((p) => p.status === 'DRAFT').length;
  R.root.innerHTML = `
    <div class="opx-card opx-head opx-fade"><div class="opx-head-icon violet">${ICONS.rules}</div><div class="grow"><h1>قواعد المنتجات</h1><p>سياسة مستقلة لكل منتج: المواعيد والأيام وحدود CPA والصرف بدون أوردرات ونسب الميزانية — الحفظ لا يعني التفعيل</p></div>${R.ctx.modeSegment()}<button class="opx-btn danger" data-opxstop ${R.ctx.ov().emergencyStop ? 'disabled' : ''}>${ICONS.stop} إيقاف فوري</button></div>
    <div class="opx-kpis">${kpiCard({ label: 'منتجات مربوطة بحملات', value: num(all.length), icon: 'megaphone', tone: 'violet' })}${kpiCard({ label: 'سياسات مفعّلة', value: num(act), icon: 'check', tone: 'green' })}${kpiCard({ label: 'مسودات غير مفعّلة', value: num(dr), icon: 'clock', tone: 'amber' })}${kpiCard({ label: 'بدون سياسة (الإعدادات العامة)', value: num(all.length - act - dr), icon: 'shield', tone: 'blue' })}</div>
    <div class="opx-card opx-filters"><input class="opx-input opx-search" id="rlQ" placeholder="ابحث باسم المنتج أو الرقم أو المتجر…" value="${E(R.f.q)}">
      <select class="opx-select" id="rlStatus"><option value="">كل الحالات</option><option value="ACTIVE" ${R.f.status === 'ACTIVE' ? 'selected' : ''}>مفعّلة</option><option value="DRAFT" ${R.f.status === 'DRAFT' ? 'selected' : ''}>مسودة</option><option value="NONE" ${R.f.status === 'NONE' ? 'selected' : ''}>بدون سياسة</option></select>
      <select class="opx-select" id="rlSort"><option value="orders">ترتيب: الأوردرات</option><option value="cpa" ${R.f.sort === 'cpa' ? 'selected' : ''}>ترتيب: CPA</option><option value="campaigns" ${R.f.sort === 'campaigns' ? 'selected' : ''}>ترتيب: عدد الحملات</option></select></div>
    <div class="opx-card opx-tablecard opx-fade"><div class="opx-tablehead"><h3>المنتجات (${num(rows().length)})</h3></div><div class="opx-scroll opx-desk">${table()}</div><div class="opx-cards">${cards()}</div></div>`;
  hydrateThumbs(R.root);
  $('rlQ').oninput = (e) => { R.f.q = e.target.value; const p = e.target.selectionStart; draw(); const q = $('rlQ'); q.focus(); q.setSelectionRange(p, p); };
  $('rlStatus').onchange = (e) => { R.f.status = e.target.value; draw(); }; $('rlSort').onchange = (e) => { R.f.sort = e.target.value; draw(); };
  R.root.querySelectorAll('[data-open]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); openPolicy(R.list.find((p) => p.key === b.dataset.open)); }; });
  R.root.querySelectorAll('[data-opxstop]').forEach((b) => { b.onclick = R.ctx.emergencyStop; });
}
function table() {
  const l = rows(); if (!l.length) return '<div class="opx-empty">مفيش منتجات مربوطة بحملات. اربط الحملات بالمنتجات من «كل الأدوات القديمة ← ربط الحملات» أو من إطلاق الحملات.</div>';
  return `<table class="opx-table"><thead><tr><th>المنتج</th><th class="num">الحملات</th><th class="num">أوردرات 7د</th><th class="num">CPA 7د</th><th class="num">أوردرات 30د</th><th class="num">CPA 30د</th><th>حالة السياسة</th><th>Operating Mode</th><th></th></tr></thead><tbody>${l.map((p) => { const st = ST[p.status]; return `<tr data-open="${E(p.key)}" style="cursor:pointer"><td><div class="opx-prod">${thumb(p.productId, p.name)}<div><b>${E(p.name)}</b><small>#${p.productId} · ${E(p.storeId)}</small></div></div></td>
    <td class="num">${num(p.campaignCount)}<small>${num(p.activeCampaigns)} نشطة</small></td><td class="num">${num(p.purchases7)}</td><td class="num">${cpaCell(p.cpa7)}</td><td class="num">${num(p.purchases30)}</td><td class="num">${cpaCell(p.cpa30)}</td>
    <td>${pill(E(st[1]), st[0])}</td><td>${p.mode ? pill(E(MODE_AR[p.mode]), p.mode === 'AUTOMATIC' ? 'red' : p.mode === 'APPROVAL' ? 'amber' : 'gray') : '<small>يرث العام</small>'}</td><td><button class="opx-btn sm" data-open="${E(p.key)}">فتح السياسة</button></td></tr>`; }).join('')}</tbody></table>`;
}

function cards() {
  const l = rows(); if (!l.length) return '<div class="opx-empty">مفيش منتجات مربوطة بحملات.</div>';
  return l.map((p) => { const st = ST[p.status]; return `<article class="opx-c2" data-open="${E(p.key)}"><div class="opx-c2-top" style="padding-left:0">${thumb(p.productId, p.name)}<div class="opx-c2-name"><b>${E(p.name)}</b><small>#${p.productId} · ${E(p.storeId)} · ${num(p.campaignCount)} حملة (${num(p.activeCampaigns)} نشطة)</small></div>${pill(E(st[1]), st[0])}</div><div class="opx-c2-grid"><div><span>أوردرات 7د</span><b>${num(p.purchases7)}</b></div><div><span>CPA 7د</span>${cpaCell(p.cpa7)}</div><div><span>أوردرات 30د</span><b>${num(p.purchases30)}</b></div><div><span>CPA 30د</span>${cpaCell(p.cpa30)}</div></div><div class="opx-c2-foot">${p.mode ? pill(E(MODE_AR[p.mode]), p.mode === 'AUTOMATIC' ? 'red' : p.mode === 'APPROVAL' ? 'amber' : 'gray') : '<small>يرث الإعداد العام</small>'}<button class="opx-btn sm primary" data-open="${E(p.key)}">فتح السياسة</button></div></article>`; }).join('');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the drawer
// ---------------------------------------------------------------------------------------------------------------------------------------------
const V = (x) => (x === null || x === undefined ? '' : x);
const inp = (id, label, v, { type = 'number', hint = '' } = {}) => `<label>${E(label)}<input class="opx-input" id="${id}" type="${type}" ${type === 'number' ? 'step="any" min="0"' : ''} value="${E(V(v))}" ${R.ctx.isAdmin ? '' : 'disabled'}>${hint ? `<small style="font-weight:600;color:var(--opx-muted)">${E(hint)}</small>` : ''}</label>`;
const sel = (id, label, v, opts) => `<label>${E(label)}<select class="opx-select" id="${id}" ${R.ctx.isAdmin ? '' : 'disabled'}>${opts.map(([k, t]) => `<option value="${E(k)}" ${String(V(v)) === String(k) ? 'selected' : ''}>${E(t)}</option>`).join('')}</select></label>`;
const MODE_OPTS = [['', 'يرث الإعداد العام'], ['MANUAL', 'MANUAL — بدون تنفيذ آلي'], ['APPROVAL', 'APPROVAL — بموافقتي'], ['AUTOMATIC', 'AUTOMATIC — تلقائي (يحتاج تأكيد ADMIN)']];

async function openPolicy(p) {
  R.cur = p; openDrawer({ title: E(p.name), body: '<div class="opx-skel" style="height:260px"></div>' });
  R.polState = await api.get(`/api/operator/product-rules/${p.productId}`, { store: p.storeId });
  renderDrawer();
}
function renderDrawer() {
  const p = R.cur, st = R.polState; const pol = st.draft || st.active || {}; const s = pol.schedule || {}, c = pol.cpa || {}, z = pol.zeroOrder || {}, b = pol.budget || {}; const days = s.days || null; const stt = ST[st.status];
  const camps = p.campaigns;
  const body = `
    <div class="opx-notice ${st.status === 'ACTIVE' ? 'green' : st.status === 'NONE' ? 'blue' : 'amber'}"><div class="grow"><b>${E(stt[1])}</b><small>${st.status === 'NONE' ? 'المنتج بيشتغل بالإعدادات العامة.' : st.status === 'DRAFT' ? 'مسودة محفوظة — لسه مش بتأثر على أي حاجة.' : st.status === 'ACTIVE' ? 'السياسة مفعّلة ومطبّقة على قرارات الفتح والإيقاف والميزانية.' : 'سياسة مفعّلة + تعديلات في المسودة لسه مش مفعّلة.'}${st.activatedAt ? ' · فُعّلت ' + E(new Date(st.activatedAt).toLocaleString('ar-EG')) : ''}</small></div></div>
    <div class="opx-form"><label class="full">المنتج<input class="opx-input" value="${E(p.name)} — #${p.productId} — ${E(p.storeId)} — ${num(p.campaignCount)} حملة" disabled></label>${sel('pl_mode', 'Operating Mode', pol.mode || '', MODE_OPTS)}${sel('pl_stock', 'سياسة المخزون المجهول', pol.stockPolicy || '', [['', 'يرث العام'], ['WARN', 'تحذير فقط'], ['BLOCK', 'منع التنفيذ']])}</div>
    <h3>${ICONS.clock} الجدولة (توقيت القاهرة)</h3>
    <div class="opx-form">${inp('pl_open', 'وقت الفتح (فارغ = 00:00 العام)', s.openTime, { type: 'time' })}${inp('pl_close', 'وقت الإيقاف (فارغ = 13:00 العام)', s.closeTime, { type: 'time' })}</div>
    <div><div class="opx-note" style="margin-bottom:6px">أيام التشغيل (فارغ = كل الأيام)</div><div class="opx-days" id="pl_days">${DAYS.map(([k, t]) => `<button type="button" class="opx-day ${days?.includes(Number(k)) ? 'on' : ''}" data-day="${k}" ${R.ctx.isAdmin ? '' : 'disabled'}>${t}</button>`).join('')}</div></div>
    <h3>${ICONS.target} حدود CPA</h3>
    <div class="opx-form">${inp('pl_nmin', 'CPA الطبيعي — من', c.normalMin)}${inp('pl_nmax', 'CPA الطبيعي — إلى', c.normalMax)}${inp('pl_scale', 'حد الـScale (CPA ≤)', c.scale)}${inp('pl_reduce', 'حد الـReduce (CPA ≥)', c.reduce)}${inp('pl_hard', 'Hard Stop CPA', c.hardStop, { hint: 'بيتطبق من حواجز الأمان الحالية' })}</div>
    <h3>${ICONS.stop} إيقاف الصرف بدون أوردرات</h3>
    <div class="opx-form">${inp('pl_zspend', 'حد الصرف بدون أوردر (ج.م)', z.spend, { hint: 'مثال 150 — أقل قيمة 50' })}${inp('pl_zage', 'أقل عمر للحملة (ساعات)', z.minAgeHours)}${sel('pl_zwin', 'نافذة القياس', z.windowDays || '', [['', 'يرث العام'], ['3', 'آخر 3 أيام'], ['7', 'آخر 7 أيام']])}</div>
    <p class="opx-note">فترة السماح للإسناد وحماية آخر أوردر وحداثة البيانات بتتطبق عالميًا ومش بتتجاوز.</p>
    <h3>${ICONS.budget} الميزانية</h3>
    <div class="opx-form">${inp('pl_inc', 'نسبة الزيادة %', b.increasePct)}${inp('pl_dec', 'نسبة التقليل %', b.decreasePct)}${inp('pl_minp', 'أقل عدد أوردرات', b.minPurchases)}${inp('pl_cool', 'Cooldown (ساعات، أقل 6)', b.cooldownHours)}${inp('pl_minb', 'أقل ميزانية', b.minBudget)}${inp('pl_maxb', 'أقصى ميزانية', b.maxBudget)}${inp('pl_cap', 'الحد اليومي لميزانية المنتج (Daily Spend Cap)', b.dailySpendCap, { hint: 'إجمالي ميزانيات حملاته النشطة — أي زيادة أو فتح يتجاوزه بيتمنع' })}</div>
    <h3>${ICONS.shield} حماية التعديل اليدوي</h3>
    <div class="opx-form">${inp('pl_moh', 'مدة الحماية بعد تعديلك اليدوي على Meta (ساعات)', pol.manualOverrideHours, { hint: 'بتتمدد بس: مش بتقل عن الإعداد العام (24 ساعة افتراضيًا)' })}</div>
    <h3>${ICONS.megaphone} تجاوز لكل حملة <small style="font-weight:600;color:var(--opx-muted)">(اختياري — لا يتجاوز الحواجز العامة)</small></h3>
    <div style="display:flex;flex-direction:column;gap:8px">${camps.length ? camps.map((cm) => campRow(cm, (pol.campaigns || {})[cm.id])).join('') : '<div class="opx-note">مفيش حملات.</div>'}</div>
    <div id="pl_preview"></div><div id="pl_copy"></div>`;
  const foot = R.ctx.isAdmin
    ? `<button class="opx-btn" id="pl_prev">${ICONS.eye} معاينة السياسة</button><button class="opx-btn" id="pl_save">حفظ السياسة (مسودة)</button><button class="opx-btn primary" id="pl_act" ${st.draft ? '' : 'disabled'}>${ICONS.check} تفعيل السياسة</button>${st.active ? '<button class="opx-btn danger sm" id="pl_deact">إيقاف السياسة</button>' : ''}<button class="opx-btn ghost sm" id="pl_cp" ${st.status === 'NONE' ? 'disabled' : ''}>نسخ لمنتجات أخرى</button>`
    : '<span class="opx-note">للقراءة فقط — التعديل لـADMIN.</span>';
  const panel = openDrawer({ title: E(p.name), body, foot }); if (window.innerWidth > 900) panel.style.width = 'min(640px,100vw)'; else panel.style.width = '';
  panel.querySelectorAll('[data-day]').forEach((d) => { d.onclick = () => d.classList.toggle('on'); });
  panel.querySelectorAll('[data-camp]').forEach((d) => { d.onclick = () => { const box = panel.querySelector(`[data-campbox="${d.dataset.camp}"]`); box.hidden = !box.hidden; }; });
  if ($('pl_prev')) { $('pl_prev').onclick = preview; $('pl_save').onclick = save; $('pl_act').onclick = activate; if ($('pl_deact')) $('pl_deact').onclick = deactivate; $('pl_cp').onclick = copyUi; }
}
function campRow(cm, ov = {}) {
  const s = ov.schedule || {}, z = ov.zeroOrder || {}, b = ov.budget || {}; const has = JSON.stringify(ov) !== '{}' && (ov.mode || s.openTime || s.closeTime || z.spend || b.increasePct || b.decreasePct);
  const id = (k) => `cm_${cm.id}_${k}`;
  return `<div class="opx-card" style="padding:10px 12px;box-shadow:none"><div style="display:flex;align-items:center;gap:10px"><div style="flex:1;min-width:0"><b style="font-size:13px">${E(cm.name || cm.id)}</b><small style="display:block;color:var(--opx-muted)">${E(cm.id)} · ${E(cm.status || '—')} · ${num(cm.purchases7)} أوردر 7د</small></div>${has ? pill('تجاوز مفعّل', 'violet') : ''}<button type="button" class="opx-btn ghost sm" data-camp="${E(cm.id)}">تجاوز</button></div>
    <div data-campbox="${E(cm.id)}" ${has ? '' : 'hidden'} class="opx-form" style="margin-top:10px">${sel(id('mode'), 'Mode', ov.mode || '', MODE_OPTS)}${inp(id('open'), 'وقت الفتح', s.openTime, { type: 'time' })}${inp(id('close'), 'وقت الإيقاف', s.closeTime, { type: 'time' })}${inp(id('zs'), 'صرف بدون أوردر', z.spend)}${inp(id('inc'), 'زيادة %', b.increasePct)}${inp(id('dec'), 'تقليل %', b.decreasePct)}</div></div>`;
}
function collect() {
  const v = (id) => { const x = $(id); if (!x) return null; const t = String(x.value).trim(); return t === '' ? null : x.type === 'number' ? Number(t) : t; };
  const days = [...document.querySelectorAll('#pl_days .opx-day.on')].map((d) => Number(d.dataset.day));
  const policy = { mode: v('pl_mode'), stockPolicy: v('pl_stock'), schedule: { openTime: v('pl_open'), closeTime: v('pl_close'), days: days.length ? days : null },
    cpa: { normalMin: v('pl_nmin'), normalMax: v('pl_nmax'), scale: v('pl_scale'), reduce: v('pl_reduce'), hardStop: v('pl_hard') },
    zeroOrder: { spend: v('pl_zspend'), minAgeHours: v('pl_zage'), windowDays: v('pl_zwin') == null ? null : Number(v('pl_zwin')) }, budget: { increasePct: v('pl_inc'), decreasePct: v('pl_dec'), minPurchases: v('pl_minp'), cooldownHours: v('pl_cool'), minBudget: v('pl_minb'), maxBudget: v('pl_maxb'), dailySpendCap: v('pl_cap') }, manualOverrideHours: v('pl_moh'), campaigns: {} };
  for (const cm of R.cur.campaigns) { const g = (k) => v(`cm_${cm.id}_${k}`); const o = { mode: g('mode'), schedule: { openTime: g('open'), closeTime: g('close') }, zeroOrder: { spend: g('zs') }, budget: { increasePct: g('inc'), decreasePct: g('dec') } }; if (o.mode || o.schedule.openTime || o.schedule.closeTime || o.zeroOrder.spend != null || o.budget.increasePct != null || o.budget.decreasePct != null) policy.campaigns[cm.id] = o; }
  return policy;
}
async function save() {
  try { R.polState = await api.put(`/api/operator/product-rules/${R.cur.productId}/draft`, { storeId: R.cur.storeId, policy: collect() }); toast('اتحفظت كمسودة — لسه مش مفعّلة'); await refreshList(); renderDrawer(); } catch (e) { toast(e.message, 'error'); }
}
async function preview() {
  const box = $('pl_preview'); box.innerHTML = '<div class="opx-skel" style="height:80px"></div>';
  try {
    const r = await api.post(`/api/operator/product-rules/${R.cur.productId}/preview`, { storeId: R.cur.storeId, policy: collect() });
    if (!r.ok) { box.innerHTML = `<div class="opx-notice red"><div class="grow"><b>السياسة غير صالحة</b><small>${E(r.errors.join(' · '))}</small></div></div>`; return; }
    const V2 = { KEEP: ['gray', 'استمرار'], WOULD_INCREASE: ['green', 'كان هيزوّد'], WOULD_REDUCE: ['red', 'كان هيقلّل'], ZERO_ORDER_STOP: ['red', 'إيقاف: صرف بدون أوردر'] };
    box.innerHTML = `<h3>${ICONS.eye} معاينة السياسة (قراءة فقط)</h3><div class="opx-scroll" style="max-height:260px"><table class="opx-table"><thead><tr><th>الحملة</th><th class="num">أوردرات 7د</th><th class="num">CPA 7د</th><th>النتيجة</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td><b style="font-size:13px">${E(x.name || x.campaignId)}</b></td><td class="num">${num(x.purchases7)}</td><td class="num">${cpaCell(x.cpa7)}</td><td>${pill(E(V2[x.verdict][1]), V2[x.verdict][0])}<small>${E(x.why)}</small></td></tr>`).join('') || '<tr><td colspan="4" class="opx-empty">مفيش حملات.</td></tr>'}</tbody></table></div><p class="opx-note">${E(r.rows[0]?.note || '')}</p>`;
  } catch (e) { box.innerHTML = `<div class="opx-notice red"><div class="grow"><b>${E(e.message)}</b></div></div>`; }
}
async function activate() {
  const pol = R.polState.draft; const auto = pol?.mode === 'AUTOMATIC' || Object.values(pol?.campaigns || {}).some((c) => c.mode === 'AUTOMATIC');
  if (!(await confirmModal({ title: 'تفعيل سياسة المنتج', message: `السياسة هتتطبق على قرارات «${R.cur.name}»: الفتح والإيقاف والميزانية. الحماية العامة (Emergency Stop، قفل النشر، صلاحيات التنفيذ) فوقها دايمًا.`, confirmLabel: 'تفعيل' }))) return;
  let confirmAutomatic = false; if (auto) { if (!(await confirmModal({ title: '⚠️ تفعيل AUTOMATIC', message: 'ده بيسمح لقواعد المنتج دي تنفّذ تلقائيًا بعد اجتياز الحواجز (لو الوضع العام AUTOMATIC والصلاحيات مفتوحة وقفل النشر مفتوح). متأكد؟', confirmLabel: 'أؤكد التفعيل التلقائي', danger: true }))) return; confirmAutomatic = true; }
  try { R.polState = await api.post(`/api/operator/product-rules/${R.cur.productId}/activate`, { storeId: R.cur.storeId, confirm: true, confirmAutomatic }); toast('السياسة اتفعّلت'); await refreshList(); renderDrawer(); } catch (e) { toast(e.message, 'error'); }
}
async function deactivate() {
  if (!(await confirmModal({ title: 'إيقاف السياسة', message: 'المنتج هيرجع للإعدادات العامة (المسودة هتتحفظ).', confirmLabel: 'إيقاف', danger: true }))) return;
  try { R.polState = await api.post(`/api/operator/product-rules/${R.cur.productId}/deactivate`, { storeId: R.cur.storeId, confirm: true }); toast('اتوقفت'); await refreshList(); renderDrawer(); } catch (e) { toast(e.message, 'error'); }
}
function copyUi() {
  const others = R.list.filter((x) => x.key !== R.cur.key); const box = $('pl_copy');
  box.innerHTML = `<h3>نسخ السياسة كمسودات</h3><div class="opx-card" style="padding:10px;max-height:200px;overflow:auto;box-shadow:none">${others.map((o) => `<label style="display:flex;gap:8px;align-items:center;padding:4px 0"><input type="checkbox" class="opx-check" data-cp="${E(o.key)}"> ${E(o.name)} <small style="color:var(--opx-muted)">#${o.productId}</small></label>`).join('') || '<div class="opx-note">مفيش منتجات تانية.</div>'}</div><button class="opx-btn sm" id="pl_cpgo" style="margin-top:8px">نسخ كمسودات (مش بتتفعّل)</button>`;
  $('pl_cpgo').onclick = async () => {
    const to = [...box.querySelectorAll('[data-cp]:checked')].map((c) => R.list.find((x) => x.key === c.dataset.cp)).filter(Boolean).map((x) => ({ productId: x.productId, storeId: x.storeId }));
    if (!to.length) return toast('اختار منتج واحد على الأقل', 'warning');
    try { const r = await api.post('/api/operator/product-rules/copy', { from: { productId: R.cur.productId, storeId: R.cur.storeId }, to }); toast(`اتنسخت ${r.copied.length} مسودة`); await refreshList(); } catch (e) { toast(e.message, 'error'); }
  };
}
async function refreshList() { R.list = (await api.get('/api/operator/product-rules')).products; R.cur = R.list.find((x) => x.key === R.cur.key) || R.cur; draw(); }
