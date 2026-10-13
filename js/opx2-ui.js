// opx2-ui.js — shared presentation helpers of AI Operator V2 (flag `opx.v2`). No business logic: every number, filter, eligibility and permission is decided by the server.
import { E, toast } from './opx-ui.js';

export { E, toast };
export const num = (v, d = 0) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const egp = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : `${num(v)} ج.م`);
export const pill = (text, tone = 'gray', title = '') => `<span class="opx2-pill ${tone}"${title ? ` title="${E(title)}"` : ''}>${text}</span>`;
export const ago = (iso) => { if (!iso) return '—'; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? 'الآن' : m < 60 ? `منذ ${m} د` : m < 1440 ? `منذ ${Math.round(m / 60)} س` : `منذ ${Math.round(m / 1440)} يوم`; };
export const cairoTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' }) : '—');
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const store = { get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

let ROOT = null;
export const setRoot = (r) => { ROOT = r; };
const q = (id) => ROOT?.querySelector(`#${id}`);
export function openDrawer(html) { const d = q('o2Drawer'); if (!d) return; d.innerHTML = html; d.classList.add('open'); q('o2Scrim').classList.add('open'); }
export function openModal(html) { const m = q('o2Modal'); if (!m) return; m.innerHTML = html; m.classList.add('open'); q('o2Scrim').classList.add('open'); }
export function closeAll() { q('o2Drawer')?.classList.remove('open'); q('o2Modal')?.classList.remove('open'); q('o2Scrim')?.classList.remove('open'); }
export const modalEl = () => q('o2Modal'); export const drawerEl = () => q('o2Drawer');
/** a small modal asking for a name (+ optional share switch). Resolves { name, shared } or null when cancelled. */
export function askView({ title, canShare, def = '' }) {
  return new Promise((resolve) => {
    openModal(`<div style="max-width:460px;margin:0 auto"><h2>${E(title)}</h2><div class="opx2-fld"><label style="flex:1">الاسم <input id="o2VName" value="${E(def)}" maxlength="80" style="width:100%"></label></div>
      ${canShare ? '<div class="opx2-fld"><label><input type="checkbox" id="o2VShare"> مشاركة العرض مع الفريق (حسب الصلاحيات — لا تغيّر صلاحياتهم)</label></div>' : '<p class="opx2-note">العرض بيتحفظ ليك أنت بس.</p>'}
      <div style="display:flex;gap:8px;margin-top:12px"><button class="opx2-btn pri" id="o2VOk">حفظ</button><button class="opx2-btn" id="o2VNo">إلغاء</button></div></div>`);
    const m = modalEl(); const done = (v) => { closeAll(); resolve(v); };
    m.querySelector('#o2VOk').onclick = () => { const name = m.querySelector('#o2VName').value.trim(); if (!name) { m.querySelector('#o2VName').focus(); return; } done({ name, shared: !!m.querySelector('#o2VShare')?.checked }); };
    m.querySelector('#o2VNo').onclick = () => done(null); m.querySelector('#o2VName').focus();
  });
}
export const skeleton = (n = 6, h = 44) => `<div style="padding:14px;display:flex;flex-direction:column;gap:10px">${Array.from({ length: n }, () => `<div class="opx2-skel" style="height:${h}px"></div>`).join('')}</div>`;
export const errorCard = (message, retryId = 'o2Retry') => `<div class="opx2-card"><div class="opx2-banner bad">⚠️ ${E(message)}</div><button class="opx2-btn pri" id="${retryId}">إعادة المحاولة</button><p class="opx2-note">مفيش أي تنفيذ حصل — ده عرض قراءة فقط.</p></div>`;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the period bar (shared by Home and the Campaign Center). The default period is the last 7 days. The note states what the period does NOT change.
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const PERIODS = [['today', 'اليوم'], ['yesterday', 'أمس'], ['last3', 'آخر 3 أيام'], ['last7', 'آخر 7 أيام'], ['last14', 'آخر 14 يوم'], ['last30', 'آخر 30 يوم'], ['last60', 'آخر 60 يوم'], ['last90', 'آخر 90 يوم'], ['custom', 'فترة مخصصة']];
export const periodLabel = (k) => PERIODS.find((p) => p[0] === k)?.[1] || k;
export function timebarHtml({ period, compare }, { note = true } = {}) {
  return `<div class="opx2-timebar" role="group" aria-label="الفترة الزمنية"><div class="opx2-seg">${PERIODS.map(([k, l]) => `<button data-period="${k}" class="${period.key === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${period.key === 'custom' ? `<span>من <input type="date" id="o2From" value="${E(period.from || '')}"> إلى <input type="date" id="o2To" value="${E(period.to || '')}"></span>` : ''}
    <label class="opx2-sw"><input type="checkbox" id="o2Cmp" ${compare ? 'checked' : ''}> مقارنة بالفترة السابقة المماثلة</label></div>
    ${note ? '<div class="opx2-note" style="margin:4px 6px 0">الفترة الافتراضية: آخر 7 أيام. فترة التحليل <b>لا تغيّر</b> سياسة الإيقاف 13:00 (بتحسب من أول اليوم لحد الفحص).</div>' : ''}`;
}
/** wires the bar inside `el`; calls onChange() after the state object was updated */
export function bindTimebar(el, state, onChange) {
  el.querySelectorAll('[data-period]').forEach((b) => { b.onclick = () => { state.period.key = b.dataset.period; if (state.period.key === 'custom' && !state.period.from) { const d = new Date(Date.now() + 2 * 3600e3); state.period.to = d.toISOString().slice(0, 10); d.setDate(d.getDate() - 6); state.period.from = d.toISOString().slice(0, 10); } onChange('period'); }; });
  const cmp = el.querySelector('#o2Cmp'); if (cmp) cmp.onchange = () => { state.compare = cmp.checked; onChange('compare'); };
  const f = el.querySelector('#o2From'), t = el.querySelector('#o2To'); if (f) f.onchange = () => { state.period.from = f.value; onChange('period'); }; if (t) t.onchange = () => { state.period.to = t.value; onChange('period'); };
}
