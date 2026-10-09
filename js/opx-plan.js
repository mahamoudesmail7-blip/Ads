// opx-plan.js — the «فتح الحملات» (OPEN, 00:00) and «إيقاف الحملات» (PAUSE, 13:00) workspaces. One component, two skins (green / red).
// Presentation over /api/operator/daily-plan/*: the server owns schedule, candidates, guards, versions, approval and execution. Ticking a checkbox only SELECTS (saved at once);
// only «اعتماد المحدد» approves, and in SHADOW it is a simulation. Nothing here talks to Meta.
import { api } from './api-client.js';
import { E, $, num, egp, cairoTime, cairoDateTime, ago, ICONS, kpiCard, pill, cpaCell, skeletonRows, skeletonCards, openDrawer, closeDrawer, toast, confirmModal, store, thumb, hydrateThumbs } from './opx-ui.js';
import { BLOCK_AR, ELIG_AR, ITEM_AR, ITEM_PILL } from './ai-operator-daily.js';

const API = '/api/operator/daily-plan';
const META = {
  OPEN: { tone: 'green', icon: 'play', title: 'فتح الحملات', sub: 'إدارة الحملات المرشحة للفتح وتشغيلها في المواعيد المحددة', verb: 'فتح', permKey: 'allowOpen', statusLabel: 'متوقفة', statusTone: 'amber', empty: 'مفيش حملات متوقفة مرشحة للفتح.', banner: 'سيتم فتح هذه الحملات بعد اعتمادك', slot: '00:00' },
  PAUSE: { tone: 'red', icon: 'pause', title: 'إيقاف الحملات', sub: 'الحملات المرشحة للإيقاف حسب CPA والصرف بدون أوردرات والاتجاه', verb: 'إيقاف', permKey: 'allowPause', statusLabel: 'نشطة', statusTone: 'green', empty: 'مفيش حملات نشطة محتاجة إيقاف.', banner: 'سيتم إيقاف هذه الحملات بعد اعتمادك', slot: '13:00' },
};
const PAUSE_CATS = { zero: 'صرف بدون أوردرات', highcpa: 'CPA مرتفع', weak: 'اتجاه ضعيف', protected: 'محمية / مستثناة' };
const catOf = (i) => { const e = i.evidence || {}; const cats = new Set(); if (['PROTECTED', 'BLOCKED'].includes(i.eligibility)) cats.add('protected'); if ((e.today?.purchases ?? 0) === 0 && (e.m3?.spend ?? 0) >= 100 && (e.m3?.purchases ?? 0) === 0) cats.add('zero'); if (e.m7?.cpa != null && e.m7.cpa >= 150 || e.today?.cpa != null && e.today.cpa >= 200) cats.add('highcpa'); if (e.m3?.cpa != null && e.m7?.cpa != null && e.m3.cpa > e.m7.cpa * 1.15) cats.add('weak'); return cats; };
const SORTS = { purchases: 'الأوردرات (الأعلى أولًا)', cpa: 'CPA (الأقل أولًا)', score: 'Priority Score', rank: 'ترتيب النظام' };
const RISK = { HIGH: ['red', 'مرتفعة'], MEDIUM: ['amber', 'متوسطة'], LOW: ['green', 'منخفضة'] };
const MODE_AR = { OFF: 'MANUAL', SHADOW: 'SHADOW', APPROVAL: 'APPROVAL', AUTOPILOT: 'AUTOMATIC' };

const mainW = () => (document.querySelector('.opx-main') || document.documentElement).clientWidth || window.innerWidth;
const PAGE = 40; // rows rendered at a time — a plan can hold hundreds of campaigns; rendering all of them (twice) made every filter take seconds
const NARROW_PX = 820; // same breakpoint as the CSS container query: below it the phone layout (cards) is used
const P = { shown: PAGE, pm: null, pmErr: null, sel: null, type: 'OPEN', ctx: null, root: null, ov: null, loading: false, f: null, timer: null, prepTimer: null };

export async function mountPlanWorkspace(root, type, ctx) {
  P.type = type; P.ctx = ctx; P.root = root; P.ov = null; P.sel = null;
  P.f = JSON.parse(store.get(`opx.f.${type}`, 'null')) || { q: '', store: '', status: '', sort: 'purchases', period: '7', cat: '', from: '', to: '' };
  P.pm = null; P.pmErr = null; P.shown = PAGE;
  clearInterval(P.timer); clearTimeout(P.prepTimer);
  root.innerHTML = `<div id="opxPlanBody">${skeletonCards(5)}<div class="opx-card" style="margin-top:14px">${skeletonRows(7)}</div></div>`;
  await load();
  clearTimeout(P.rzTimer); if (!P.rz) { P.rz = true; window.addEventListener('resize', () => { clearTimeout(P.rzTimer); P.rzTimer = setTimeout(() => { if (P.ov && P.root && document.body.contains(P.root) && (mainW() <= NARROW_PX) !== P.narrow) draw(); }, 250); }); }
  P.timer = setInterval(() => { if (!document.body.contains(root)) return clearInterval(P.timer); tickCountdown(); }, 1000);
}
export function unmountPlanWorkspace() { clearInterval(P.timer); clearTimeout(P.prepTimer); }

async function load({ quiet = false } = {}) {
  try { P.ov = await api.get(`${API}/overview`); } catch (e) { P.root.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message)}</div>`; return; }
  await ensurePeriodMetrics();
  if (!quiet || document.body.contains(P.root)) draw();
  const preparing = (P.ov.preparing || []).some((p) => !p.error);
  clearTimeout(P.prepTimer); if (preparing) P.prepTimer = setTimeout(() => load({ quiet: true }), 5000);
  const running = P.ov.plans?.[P.type] && ['APPROVED', 'RUNNING'].includes(P.ov.plans[P.type].status);
  if (running) P.prepTimer = setTimeout(() => load({ quiet: true }), 3000);
}
const plansOfType = () => [P.ov?.plans?.[P.type], ...((P.ov?.oneOffPlans || []).filter((p) => p.type === P.type))].filter(Boolean);
const plan = () => { const all = plansOfType(); return all.find((p) => p.key === P.sel) || P.ov?.plans?.[P.type] || all[0] || null; };
const planLabel = (p) => (p.key.includes('|P-') ? `خطة ${cairoTime(p.scheduledAt)} (منتج بموعد خاص)` : p.key.includes('|T-') ? `خطة إضافية ${cairoTime(p.preparedAt)}` : `الخطة الأساسية ${META[P.type].slot}`);
const saveF = () => store.set(`opx.f.${P.type}`, JSON.stringify(P.f));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// derived data
// ---------------------------------------------------------------------------------------------------------------------------------------------
// ---- period: 7 / 30 use the plan's own evidence; 90 days and a custom range are read from the server (the last snapshot of each day) for exactly the campaigns in the plan
const PERIOD_CHIPS = [['7', '7 أيام'], ['30', '30 يوم'], ['90', '90 يوم'], ['custom', 'فترة مخصصة']];
const todayStr = () => new Date().toISOString().slice(0, 10);
const periodLabel = () => (P.f.period === 'custom' ? 'الفترة' : `${P.f.period}د`);
const refKey = () => (P.f.period === '30' ? 'm7' : 'm30'); const refLabel = () => (refKey() === 'm7' ? '7د' : '30د');
function met(i, key) { const p = P.f.period; if (p === '7') return i.evidence?.m7?.[key]; if (p === '30') return i.evidence?.m30?.[key]; return P.pm?.map?.[i.campaignId]?.[key]; }
async function ensurePeriodMetrics() {
  const p = P.f.period; const pl = plan(); P.pmErr = null;
  if (p === '7' || p === '30' || !pl) return;
  if (p === 'custom' && !(P.f.from && P.f.to)) { P.pm = { key: null, map: {} }; return; }
  const qs = p === 'custom' ? { from: P.f.from, to: P.f.to } : { days: 90 }; const key = JSON.stringify([pl.key, qs]); if (P.pm?.key === key) return;
  try { const r = await api.get('/api/operator/campaign-metrics', { ...qs, ids: pl.items.map((i) => i.campaignId).join(',') }); P.pm = { key, map: r.metrics, window: r.window }; }
  catch (e) { P.pm = { key: null, map: {} }; P.pmErr = e.message; }
}
function visibleItems() {
  const p = plan(); if (!p) return [];
  const q = P.f.q.trim().toLowerCase();
  let items = p.items.filter((i) => (!q || `${i.campaignName || ''} ${i.productName || ''} ${i.campaignId}`.toLowerCase().includes(q)) && (!P.f.store || (i.storeId || '') === P.f.store) && (!P.f.cat || catOf(i).has(P.f.cat)) && (!P.f.status || (P.f.status === 'ELIGIBLE' ? i.eligibility === 'ELIGIBLE' : P.f.status === 'BLOCKED' ? ['BLOCKED', 'PROTECTED'].includes(i.eligibility) : i.eligibility === P.f.status)));
  const purchases = (i) => Number(met(i, 'purchases') ?? 0), cpa = (i) => (met(i, 'cpa') == null ? Infinity : Number(met(i, 'cpa')));
  const MIN = 3; // a CPA from a tiny sample must not outrank a proven campaign
  const by = {
    purchases: (a, b) => purchases(b) - purchases(a) || ((purchases(b) >= MIN) - (purchases(a) >= MIN)) || cpa(a) - cpa(b),
    cpa: (a, b) => ((purchases(b) >= MIN) - (purchases(a) >= MIN)) || cpa(a) - cpa(b) || purchases(b) - purchases(a),
    score: (a, b) => (b.evidence?.priority?.score ?? -1) - (a.evidence?.priority?.score ?? -1), rank: (a, b) => a.rank - b.rank,
  }[P.f.sort] || ((a, b) => a.rank - b.rank);
  items = [...items].sort((a, b) => (b.selectable - a.selectable) || by(a, b));
  return items;
}
const recentWorse = (e) => e?.m7?.cpa != null && e?.m30?.cpa != null && (e.m7.purchases ?? 0) >= 3 && e.m7.cpa > e.m30.cpa * 1.25;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------------------------------------------------------------------------
function draw() {
  const m = META[P.type], p = plan(), c = P.ov.control || {}; const items = visibleItems(); const sel = (p?.items || []).filter((i) => i.selected);
  const narrow = mainW() <= NARROW_PX; P.narrow = narrow;
  const pageItems = items.slice(0, P.shown); const moreBtn = items.length > P.shown ? `<div style="padding:12px;text-align:center"><button class="opx-btn" data-act="more">عرض المزيد (${num(items.length - P.shown)} حملة متبقية)</button></div>` : '';
  const editable = p && p.status === 'PREPARED' && P.ctx.isAdmin; const lastBudget = sel.reduce((t, i) => t + (Number(i.evidence?.budget) || 0), 0);
  const orders = sel.reduce((t, i) => t + (Number(met(i, 'purchases')) || 0), 0); const cpas = sel.map((i) => ({ c: Number(met(i, 'cpa')), w: Number(met(i, 'purchases')) || 0 })).filter((x) => x.c > 0 && x.w > 0);
  const avgCpa = cpas.length ? cpas.reduce((t, x) => t + x.c * x.w, 0) / cpas.reduce((t, x) => t + x.w, 0) : null;
  const perm = !!c[m.permKey]; const live = c.mode === 'APPROVAL' && !c.writesLocked && perm && !c.emergencyStop;
  const stores = [...new Set((p?.items || []).map((i) => i.storeId).filter(Boolean))];
  const next = P.ov.dashboard?.nextByType?.[P.type]; const nextAt = next?.at ? new Date(next.at) : null;
  const stateTone = c.emergencyStop ? 'red' : live ? 'green' : 'amber';
  const stateText = c.emergencyStop ? 'إيقاف طوارئ مفعّل' : live ? 'التنفيذ الفعلي مفتوح' : c.writesLocked ? 'كتابة Meta مقفولة — محاكاة فقط' : c.mode !== 'APPROVAL' ? `الوضع ${MODE_AR[c.mode] || c.mode} — لا تنفيذ فعلي` : `صلاحية ${m.verb} مقفولة`;
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
      ${kpiCard({ label: `إجمالي الأوردرات (${P.f.period === 'custom' ? (P.f.from && P.f.to ? P.f.from + ' → ' + P.f.to : 'فترة مخصصة') : P.f.period + (P.f.period === '7' ? ' أيام' : ' يوم')})`, value: num(orders), icon: 'cart', tone: 'blue' })}
      ${kpiCard({ label: 'متوسط CPA (موزون)', value: avgCpa == null ? '—' : `${num(avgCpa)} ج.م`, icon: 'target', tone: 'amber' })}
      ${kpiCard({ label: 'إجمالي الميزانيات المختارة', value: egp(lastBudget), icon: 'coins', tone: 'red' })}
    </div>
    ${p ? `<div class="opx-notice ${m.tone === 'red' ? 'red' : 'green'} opx-fade"><div class="opx-head-icon ${m.tone}" style="width:44px;height:44px">${ICONS.check}</div><div class="grow"><b>${m.banner}</b><small>${p.status === 'PREPARED' ? 'راجع التحديد ثم اعتمد. إغلاق الشاشة لا يعتبر موافقة.' : `حالة الخطة: ${E(p.status)}`} · بيانات Meta بتاريخ ${E(cairoDateTime(p.dataAsOf || p.preparedAt))}${p.dataState === 'STALE' ? ' ⚠️ قديمة' : ''}</small></div>
      <div class="opx-count" id="opxCountdown">${countdownHtml(nextAt)}</div></div>` : `<div class="opx-notice amber"><div class="grow"><b>مفيش خطة ${m.verb} لليوم بعد</b><small>الخطة بتتجهز على السيرفر في الموعد (${m.slot} بتوقيت القاهرة)، أو ابدأ خطة الآن.</small></div></div>`}
    <div class="opx-work">
      <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
        ${plansOfType().length > 1 ? `<div class="opx-card opx-filters" id="opxPlans">${plansOfType().map((x) => `<button class="opx-chip ${x.key === (p?.key) ? 'on' : ''}" data-plan="${E(x.key)}">${E(planLabel(x))} · ${num(x.counts?.total)} حملة</button>`).join('')}</div>` : ''}
        <div class="opx-card opx-filters">
          <input class="opx-input opx-search" id="opxQ" placeholder="ابحث باسم المنتج أو الحملة…" value="${E(P.f.q)}">
          <div class="opx-chips" role="group" aria-label="الفترة">${PERIOD_CHIPS.map(([k, t]) => `<button class="opx-chip ${P.f.period === k ? 'on' : ''}" data-period="${k}">${k === 'custom' ? t : 'آخر ' + t}</button>`).join('')}</div>
          ${P.f.period === 'custom' ? `<div class="opx-range"><label>من<input class="opx-input" type="date" id="opxFrom" max="${todayStr()}" value="${E(P.f.from)}"></label><label>إلى<input class="opx-input" type="date" id="opxTo" max="${todayStr()}" value="${E(P.f.to)}"></label><button class="opx-btn sm primary" id="opxApplyRange">تطبيق</button></div>` : ''}
          ${P.pmErr ? `<div class="opx-note bad" style="flex:1 1 100%">⚠️ ${E(P.pmErr)}</div>` : ''}
          ${stores.length > 1 ? `<select class="opx-select" id="opxStore"><option value="">كل المتاجر</option>${stores.map((s) => `<option ${P.f.store === s ? 'selected' : ''}>${E(s)}</option>`).join('')}</select>` : ''}
          ${P.type === 'PAUSE' ? `<select class="opx-select" id="opxCat"><option value="">كل التصنيفات</option>${Object.entries(PAUSE_CATS).map(([k, v]) => `<option value="${k}" ${P.f.cat === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : ''}
          <select class="opx-select" id="opxStatus"><option value="">كل الحالات</option><option value="ELIGIBLE" ${P.f.status === 'ELIGIBLE' ? 'selected' : ''}>مؤهلة</option><option value="NEEDS_SPECIAL_APPROVAL" ${P.f.status === 'NEEDS_SPECIAL_APPROVAL' ? 'selected' : ''}>موافقة خاصة</option><option value="BLOCKED" ${P.f.status === 'BLOCKED' ? 'selected' : ''}>ممنوعة / محمية</option></select>
          <select class="opx-select" id="opxSort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${P.f.sort === k ? 'selected' : ''}>ترتيب: ${v}</option>`).join('')}</select>
        </div>
        <div class="opx-card opx-tablecard opx-fade">
          <div class="opx-tablehead"><h3>الحملات المرشحة لل${m.verb} (${num(p?.items?.length ?? 0)} حملة${items.length !== (p?.items?.length ?? 0) ? ` — بعد الفلتر ${num(items.length)}` : ''}${items.length > P.shown ? ` — المعروض ${num(P.shown)}` : ''})</h3>
            <button class="opx-btn sm" data-act="eligible" ${editable ? '' : 'disabled'}>${ICONS.check} تحديد المؤهل</button><button class="opx-btn sm" data-act="none" ${editable ? '' : 'disabled'}>${ICONS.x} إلغاء التحديد</button>
            <button class="opx-btn sm" data-act="new" ${P.ctx.isAdmin ? '' : 'disabled'}>${ICONS.plus} إنشاء خطة جديدة</button></div>
          ${narrow
            ? `<div class="opx-cards" style="display:flex">${p && items.length ? pageItems.map((i) => itemCard(i, editable)).join('') : `<div class="opx-empty">${E(m.empty)}</div>`}${moreBtn}</div>`
            : `<div class="opx-scroll opx-desk">${p ? table(pageItems, editable) : `<div class="opx-empty">${E(m.empty)}</div>`}${moreBtn}</div>`}
          <div class="opx-foot"><div class="grow"><b>تم تحديد ${num(sel.length)} حملة</b> <span class="opx-note">· إجمالي الميزانية المقترحة: <b style="color:var(--opx-text)">${egp(lastBudget)}</b></span></div>
            <button class="opx-btn" data-act="preview" ${p && sel.length ? '' : 'disabled'}>${ICONS.eye} معاينة التنفيذ</button>
            <button class="opx-btn primary" data-act="approve" ${editable && sel.length ? '' : 'disabled'}>${ICONS[m.icon]} اعتماد المحدد (${num(sel.length)})</button></div>
        </div>
      </div>
      ${sidePanel(p, c, nextAt)}
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

function table(items, editable) {
  const open = P.type === 'OPEN';
  const head = open
    ? `<th></th><th>المنتج / الحملة</th><th>الحالة</th><th class="num">أوردرات ${periodLabel()}</th><th class="num">CPA ${periodLabel()}</th><th class="num">أوردرات ${refLabel()}</th><th class="num">CPA ${refLabel()}</th><th class="num c-wide">الميزانية الحالية</th><th class="num">ميزانية التشغيل</th><th class="c-wide">موعد الفتح</th><th>سبب الترشيح</th><th>الأهلية</th><th></th>`
    : `<th></th><th>المنتج / الحملة</th><th>الحالة</th><th class="num">CPA اليوم</th><th class="num">CPA 3د / 7د / 30د</th><th class="num">صرف اليوم</th><th class="num">أوردرات اليوم</th><th class="num">أوردرات ${periodLabel()}</th><th class="num">الميزانية</th><th>سبب الإيقاف</th><th>الأهلية</th><th></th>`;
  if (!items.length) return `<div class="opx-empty">${E(META[P.type].empty)}</div>`;
  const at = plan()?.scheduledAt;
  return `<table class="opx-table"><thead><tr>${head}</tr></thead><tbody>${items.map((i) => open ? openRow(i, editable, at) : pauseRow(i, editable)).join('')}</tbody></table>`;
}
function nameCell(i) { return `<td><div class="opx-prod">${thumb(i.productId, i.productName || i.campaignName)}<div><b>${E(i.productName || 'بدون منتج')}</b><small>${E(i.campaignName || i.campaignId)}${i.storeId && i.storeId !== 'default' ? ' · ' + E(i.storeId) : ''}</small></div></div></td>`; }
function eligCell(i) {
  const blocks = (i.blockCodes || []).map((c) => BLOCK_AR[c] || c); const risk = RISK[i.risk];
  const tone = i.eligibility === 'ELIGIBLE' ? 'green' : i.eligibility === 'BLOCKED' ? 'red' : 'amber';
  return `<td>${pill(i.eligibility === 'ELIGIBLE' ? 'مؤهلة' : (ELIG_AR[i.eligibility] || i.eligibility), tone)}${risk ? `<small>مخاطرة ${risk[1]}</small>` : ''}${blocks.length ? `<small class="opx-why"><span class="bad">🚫 ${E(blocks.join(' · '))}</span></small>` : ''}${i.status && i.status !== 'PENDING' ? `<small>${pill(E(ITEM_AR[i.status] || i.status), ITEM_PILL[i.status] || 'gray')}</small>` : ''}</td>`;
}
function checkCell(i, editable) { const dis = !editable || !i.selectable ? 'disabled' : ''; return `<td><input type="checkbox" class="opx-check" data-cid="${E(i.campaignId)}" ${i.selected ? 'checked' : ''} ${dis} aria-label="اختيار الحملة"></td>`; }
function whyCell(i, e) { const worse = recentWorse(e); const score = e?.priority; return `<td class="opx-why">${E(i.reason || '')}${worse ? '<small class="bad">⚠️ الأداء الحديث أسوأ من التاريخي</small>' : ''}${score ? `<small>Score ${score.score} · ${E(score.band)}</small>` : ''}</td>`; }
const actCell = (i) => `<td><button class="opx-btn ghost sm" data-row="${E(i.campaignId)}" aria-label="إجراءات الحملة">⋯</button></td>`;
function openRow(i, editable, at) {
  const e = i.evidence || {}; return `<tr class="${i.selected ? '' : ''}${i.eligibility !== 'ELIGIBLE' ? 'dim' : ''}" data-cid="${E(i.campaignId)}">${checkCell(i, editable)}${nameCell(i)}
    <td>${pill(META.OPEN.statusLabel, 'amber')}${e.pausedBy ? `<small>${E({ DAILY_SCHEDULE: 'روتين يومي', SYSTEM: 'السيستم', MANUAL: 'يدوي', UNKNOWN_OLD: 'سبب غير معروف' }[e.pausedBy] || '')}</small>` : ''}</td>
    <td class="num">${num(met(i, 'purchases'))}</td><td class="num">${cpaCell(met(i, 'cpa'))}</td><td class="num">${num(e[refKey()]?.purchases)}</td><td class="num">${cpaCell(e[refKey()]?.cpa)}</td>
    <td class="num c-wide">${egp(e.budget)}<small>${E(e.budgetLevel || '')}</small></td><td class="num"><b>${egp(e.budget)}</b></td><td class="c-wide">${E(cairoTime(at))}</td>${whyCell(i, e)}${eligCell(i)}${actCell(i)}</tr>`;
}
function pauseRow(i, editable) {
  const e = i.evidence || {}; const m = (x) => (x?.cpa == null ? '—' : num(x.cpa));
  return `<tr class="${i.eligibility !== 'ELIGIBLE' ? 'dim' : ''}" data-cid="${E(i.campaignId)}">${checkCell(i, editable)}${nameCell(i)}<td>${pill(META.PAUSE.statusLabel, 'green')}</td>
    <td class="num">${cpaCell(e.today?.cpa, { good: 80, mid: 150, warn: 200 })}</td><td class="num"><small style="margin:0">${m(e.m3)} · ${m(e.m7)} · ${m(e.m30)}</small></td>
    <td class="num">${egp(e.today?.spend)}</td><td class="num">${num(e.today?.purchases)}</td><td class="num">${num(met(i, 'purchases'))}</td><td class="num">${egp(e.budget)}<small>${E(e.budgetLevel || '')}</small></td>${whyCell(i, e)}${eligCell(i)}${actCell(i)}</tr>`;
}

function itemCard(i, editable) {
  const e = i.evidence || {}; const dis = !editable || !i.selectable ? 'disabled' : ''; const blocks = (i.blockCodes || []).map((c) => BLOCK_AR[c] || c);
  const tone = i.eligibility === 'ELIGIBLE' ? 'green' : i.eligibility === 'BLOCKED' ? 'red' : 'amber'; const cpaV = met(i, 'cpa');
  const stat = P.type === 'OPEN' ? pill('متوقفة', 'amber') : pill('نشطة', 'green');
  return `<article class="opx-c2 ${i.eligibility !== 'ELIGIBLE' ? 'dim' : ''} ${i.selected ? 'sel' : ''}" data-cid="${E(i.campaignId)}">
    <label class="opx-c2-chk" aria-label="اختيار الحملة"><input type="checkbox" class="opx-check" data-cid="${E(i.campaignId)}" ${i.selected ? 'checked' : ''} ${dis}></label>
    <div class="opx-c2-top">${thumb(i.productId, i.productName || i.campaignName)}<div class="opx-c2-name"><b>${E(i.productName || 'بدون منتج')}</b><small>${E(i.campaignName || i.campaignId)}</small></div>${stat}</div>
    <div class="opx-c2-grid"><div><span>أوردرات ${E(periodLabel())}</span><b>${num(met(i, 'purchases'))}</b></div><div><span>CPA</span>${cpaCell(cpaV)}</div><div><span>الميزانية</span><b>${egp(e.budget)}</b></div><div><span>${E(refLabel())}</span><b>${num(e[refKey()]?.purchases)} · ${e[refKey()]?.cpa == null ? '—' : num(e[refKey()].cpa)}</b></div></div>
    <div class="opx-c2-foot">${pill(i.eligibility === 'ELIGIBLE' ? 'مؤهلة' : (ELIG_AR[i.eligibility] || i.eligibility), tone)}${recentWorse(e) ? pill('⚠️ أداء حديث أسوأ', 'amber') : ''}${i.status && i.status !== 'PENDING' ? pill(E(ITEM_AR[i.status] || i.status), ITEM_PILL[i.status] || 'gray') : ''}<button class="opx-btn ghost sm" data-row="${E(i.campaignId)}">تفاصيل</button></div>
    ${blocks.length ? `<div class="opx-note bad">🚫 ${E(blocks.join(' · '))}</div>` : (i.reason ? `<div class="opx-note">${E(i.reason)}</div>` : '')}
  </article>`;
}
function sidePanel(p, c, nextAt) {
  const m = META[P.type]; const last = P.ov.dashboard?.lastPlan; const sched = c.scheduledExecution;
  const status = c.emergencyStop ? ['red', 'إيقاف طوارئ'] : c.halted ? ['red', 'موقوف يدويًا'] : ['green', 'شغال'];
  return `<aside class="opx-card opx-panel opx-fade"><h3>${ICONS.clock} إعدادات الجدولة</h3>
    <div><div class="opx-kv"><span>حالة الـScheduler</span><b>${pill(status[1], status[0])}</b></div>
      <div class="opx-kv"><span>موعد هذه الخطة (القاهرة)</span><b>${p ? E(cairoTime(p.scheduledAt)) : m.slot}</b></div>
      <div class="opx-kv"><span>الموعد القادم</span><b>${nextAt ? E(cairoDateTime(nextAt.toISOString())) : '—'}</b></div>
      <div class="opx-kv"><span>آخر تشغيل</span><b>${last ? `${E(last.type === 'OPEN' ? 'فتح' : 'إيقاف')} ${E(last.date)} — ${E(last.status)}` : '—'}</b></div>
      <div class="opx-kv"><span>وضع التنفيذ</span><b>${E(MODE_AR[c.mode] || c.mode)}</b></div>
      <div class="opx-kv"><span>التنفيذ المجدول</span><b>${sched ? pill('مفعّل', 'green') : pill('OFF — الخطة تتجهز فقط', 'gray')}</b></div>
      <div class="opx-kv"><span>الفاصل بين العمليات</span><b>${num(c.spacingSeconds ?? 3)} ث</b></div></div>
    <div class="opx-actions">${P.ctx.isAdmin ? `<button class="opx-btn sm" id="opxSpacing">ضبط الفاصل بين عمليات Meta</button><button class="opx-btn sm ${c.halted ? 'danger' : ''}" id="opxHalt">${c.halted ? 'استئناف الجدولة' : 'إيقاف الجدولة مؤقتًا'}</button>` : ''}${p && ['PREPARED', 'APPROVED'].includes(p.status) && P.ctx.isAdmin ? '<button class="opx-btn sm ghost" id="opxCancel">إلغاء خطة اليوم</button>' : ''}</div>
    <p class="opx-note">إغلاق الشاشة لا يعتبر موافقة. التنفيذ بيحصل واحدة واحدة بعد إعادة التحقق من Meta وقراءة مستقلة بعده.${P.ctx.statusExtra?.() || ''}</p></aside>`;
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
function wire(p, editable) {
  const root = $('opxPlanBody');
  const rerender = (fn) => { fn(); saveF(); P.shown = PAGE; draw(); };
  $('opxQ').oninput = (e) => { P.f.q = e.target.value; saveF(); const pos = e.target.selectionStart; clearTimeout(P.qTimer); P.qTimer = setTimeout(() => { P.shown = PAGE; draw(); const q = $('opxQ'); if (q) { q.focus(); q.setSelectionRange(pos, pos); } }, 220); };
  root.querySelectorAll('[data-plan]').forEach((b) => { b.onclick = () => { P.sel = b.dataset.plan; P.shown = PAGE; draw(); }; });
  root.querySelectorAll('[data-period]').forEach((b) => { b.onclick = async () => { P.f.period = b.dataset.period; if (P.f.period === 'custom' && !P.f.to) { P.f.to = todayStr(); const d = new Date(); d.setUTCDate(d.getUTCDate() - 13); P.f.from = d.toISOString().slice(0, 10); } saveF(); await ensurePeriodMetrics(); draw(); }; });
  if ($('opxApplyRange')) $('opxApplyRange').onclick = async () => {
    const f = $('opxFrom').value, t = $('opxTo').value; const bad = (m) => { P.pmErr = m; P.pm = { key: null, map: {} }; draw(); };
    if (!f || !t) return bad('اختار تاريخ البداية والنهاية.'); if (f > t) return bad('تاريخ البداية لازم يكون قبل أو يساوي تاريخ النهاية.'); if (t > todayStr()) return bad('تاريخ النهاية لا يمكن أن يكون في المستقبل.');
    if ((Date.parse(t) - Date.parse(f)) / 86400000 + 1 > 366) return bad('الفترة أطول من 366 يوم.');
    P.f.from = f; P.f.to = t; saveF(); await ensurePeriodMetrics(); draw();
  };
  if ($('opxStore')) $('opxStore').onchange = (e) => rerender(() => { P.f.store = e.target.value; });
  if ($('opxCat')) $('opxCat').onchange = (e) => rerender(() => { P.f.cat = e.target.value; });
  $('opxStatus').onchange = (e) => rerender(() => { P.f.status = e.target.value; }); $('opxSort').onchange = (e) => rerender(() => { P.f.sort = e.target.value; });
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
    else if (a === 'preview') await preview(p); else if (a === 'approve') await approve(p);
    else if (a === 'new') { try { await api.post(`${API}/new`, { type: P.type }); toast('بدأ تجهيز خطة جديدة'); await load(); } catch (e) { toast(e.message, 'error'); } }
  }; });
  root.querySelectorAll('[data-row]').forEach((b) => { b.onclick = () => rowDrawer(p.items.find((x) => x.campaignId === b.dataset.row)); });
  if ($('opxSpacing')) $('opxSpacing').onclick = async () => { const v = prompt('الفاصل بين عمليات Meta بالثواني (3 – 120):', String(P.ov.control.spacingSeconds ?? 3)); if (v == null) return; try { await api.put(`${API}/config`, { spacingSeconds: Number(v) }); toast('تم'); await load(); } catch (e) { toast(e.message, 'error'); } };
  if ($('opxHalt')) $('opxHalt').onclick = async () => { try { await api.post(`${API}/halt`, { halted: !P.ov.control.halted }); toast('تم'); await load(); } catch (e) { toast(e.message, 'error'); } };
  if ($('opxCancel')) $('opxCancel').onclick = async () => { if (!(await confirmModal({ title: 'إلغاء الخطة', message: 'الخطة هتتلغي ومش هيتنفذ منها حاجة.', confirmLabel: 'إلغاء الخطة', danger: true }))) return; try { await api.post(`${API}/${p.id}/cancel`, { reason: 'إلغاء من المستخدم' }); toast('اتلغت'); await load(); } catch (e) { toast(e.message, 'error'); } };
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
function rowDrawer(i) {
  if (!i) return; const e = i.evidence || {};
  const kv = (k, v) => `<div class="opx-kv"><span>${k}</span><b>${v}</b></div>`;
  openDrawer({ title: E(i.campaignName || i.campaignId), body: `<div>${kv('المنتج', E(i.productName || '—'))}${kv('Campaign ID', E(i.campaignId))}${kv('الميزانية', `${egp(e.budget)} ${E(e.budgetLevel || '')}`)}
    ${kv('CPA 3د / 7د / 30د', `${e.m3?.cpa == null ? '—' : num(e.m3.cpa)} / ${e.m7?.cpa == null ? '—' : num(e.m7.cpa)} / ${e.m30?.cpa == null ? '—' : num(e.m30.cpa)}`)}${kv('أوردرات 7د / 30د', `${num(e.m7?.purchases)} / ${num(e.m30?.purchases)}`)}${kv('صرف 7د / 30د', `${egp(e.m7?.spend)} / ${egp(e.m30?.spend)}`)}
    ${e.priority ? kv('Priority Score', `${e.priority.score} (${E(e.priority.band)})`) : ''}${kv('السبب', E(i.reason || '—'))}</div>
    ${e.priority?.reasons?.length ? `<div><b>ليه السكور ده؟</b><ul class="opx-note">${e.priority.reasons.map((r) => `<li>${E(r)}</li>`).join('')}</ul></div>` : ''}
    ${(i.blockCodes || []).length ? `<div class="opx-notice red"><div class="grow"><b>حواجز أمان</b><small>${E(i.blockCodes.map((c) => BLOCK_AR[c] || c).join(' · '))}</small></div></div>` : ''}`,
  foot: P.ctx.isAdmin ? `<button class="opx-btn" id="opxExDay">استبعاد لليوم</button><button class="opx-btn danger" id="opxExAlways">استبعاد دائم</button><button class="opx-btn" id="opxProtect">حماية كـWinner</button>` : '' });
  const ex = (scope) => async () => { if (!(await confirmModal({ title: scope === 'DAY' ? 'استبعاد لليوم' : 'استبعاد دائم', message: `استبعاد «${i.campaignName || i.campaignId}» ${scope === 'DAY' ? 'من خطط النهارده' : 'من أي فتح/إيقاف تلقائي'}؟`, confirmLabel: 'استبعاد', danger: scope !== 'DAY' }))) return; try { await api.post(`${API}/exclude`, { campaignId: i.campaignId, scope, label: i.campaignName }); toast('تم الاستبعاد'); closeDrawer(); await load(); } catch (er) { toast(er.message, 'error'); } };
  if ($('opxExDay')) { $('opxExDay').onclick = ex('DAY'); $('opxExAlways').onclick = ex('ALWAYS'); $('opxProtect').onclick = async () => { try { await api.post(`${API}/protect`, { campaignId: i.campaignId, label: i.campaignName }); toast('اتحمت'); closeDrawer(); await load(); } catch (er) { toast(er.message, 'error'); } }; }
}
