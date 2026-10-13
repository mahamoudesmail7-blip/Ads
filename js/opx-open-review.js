// opx-open-review.js — «مراجعة الحملات المطابقة لسياسة CPA»: one tidy screen that lists what the system WOULD open, one row per campaign (product, CPA + orders for the last 7 and 30 days, budget),
// a checkbox on each row, and a single approve button. Presentation only: ticking saves the selection through the plan API (the caller), approving goes through the caller's approve() — the same
// confirm / lock / live-revalidation path as the table. Closing the screen is NOT an approval. Nothing here talks to Meta.
import { E, num, egp, ICONS, thumb, hydrateThumbs } from './opx-ui.js';

let R = null; // { el, get, cb, showExcluded, onKey, busy }
const inRange = (cpa, pol) => cpa != null && cpa >= pol.minCpa && cpa <= pol.maxCpa;
const cell = (m, pol, isBasis, k) => {
  const cls = m?.cpa == null ? 'na' : inRange(Number(m.cpa), pol) ? 'good' : 'warn';
  return `<span class="opx-rv-m ${k} ${isBasis ? 'basis' : ''}"><span class="opx-cpa ${cls}">${m?.cpa == null ? 'غير متاح' : num(m.cpa)}</span><small>${m?.purchases == null ? '—' : num(m.purchases)} أوردر</small></span>`;
};
export const isReviewOpen = () => !!R;
export function closeReview() { if (!R) return; document.removeEventListener('keydown', R.onKey); R.el.remove(); R = null; }
export function refreshReview() { if (R) render(); }

/** get() → { policy:{minCpa,maxCpa,window,minPurchases}, editable, note:{title,text}|null, rows:[{id,product,productId,name,store,selected,selectable,eligible,matched,reasons,d7,d30,budget,special}] }
 *  cb → { toggle(id, checked), all(), none(), approve() → Promise<boolean>, openTable(), dismiss() } */
export function openReview(get, cb) {
  closeReview(); const host = document.querySelector('.opx') || document.body;
  const el = document.createElement('div'); el.className = 'opx-rv-ov'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); host.appendChild(el);
  const onKey = (e) => { if (e.key === 'Escape') { cb.dismiss?.(); closeReview(); } }; document.addEventListener('keydown', onKey);
  R = { el, get, cb, showExcluded: false, onKey, busy: false }; render();
}
function render() {
  const { el, get, cb } = R; const s = get(); const pol = s.policy; const rows = s.rows;
  const cand = rows.filter((r) => r.eligible || (r.selectable && r.selected)); const excl = rows.filter((r) => !cand.includes(r) && r.matched);
  const sel = cand.filter((r) => r.selected); const budget = sel.reduce((t, r) => t + (Number(r.budget) || 0), 0);
  const basisKey = pol.window === '30' ? 'd30' : 'd7'; const w = sel.map((r) => ({ c: Number(r[basisKey]?.cpa), n: Number(r[basisKey]?.purchases) || 0 })).filter((x) => x.c > 0 && x.n > 0); const avg = w.length ? w.reduce((t, x) => t + x.c * x.n, 0) / w.reduce((t, x) => t + x.n, 0) : null;
  const orders = sel.reduce((t, r) => t + (Number(r[basisKey]?.purchases) || 0), 0); const ed = s.editable && !R.busy;
  const basisLabel = { today: 'اليوم', 7: 'آخر 7 أيام', 30: 'آخر 30 يوم', 90: 'آخر 90 يوم', custom: 'فترة مخصصة' }[pol.window] || pol.window;
  const row = (r) => `<label class="opx-rv-row ${r.selected ? 'on' : ''}">
      <span class="opx-rv-ck"><input type="checkbox" class="opx-check" data-id="${E(r.id)}" ${r.selected ? 'checked' : ''} ${ed && r.selectable ? '' : 'disabled'} aria-label="اختيار ${E(r.product || r.name)}"></span>
      <span class="opx-rv-prod">${thumb(r.productId, r.product || r.name)}<span class="opx-rv-pt"><b>${E(r.product || 'بدون منتج')}</b><small>${E(r.name || r.id)}${r.store && r.store !== 'default' ? ' · ' + E(r.store) : ''}</small>${r.special ? `<small class="opx-rv-warn">⚠ ${E(r.special)}</small>` : ''}</span></span>
      ${cell(r.d7, pol, basisKey === 'd7', 'm7')}${cell(r.d30, pol, basisKey === 'd30', 'm30')}
      <span class="opx-rv-b">${r.budget == null ? '—' : egp(r.budget)}</span></label>`;
  el.innerHTML = `<div class="opx-rv">
    <header class="opx-rv-head"><div class="opx-head-icon green" style="width:52px;height:52px">${ICONS.play}</div>
      <div class="grow"><h2>الحملات اللي السيستم هيفتحها</h2><p>CPA من <b>${num(pol.minCpa)}</b> إلى <b>${num(pol.maxCpa)}</b> ج.م — حسب <b>${E(basisLabel)}</b> · أقل عينة ${num(pol.minPurchases)} أوردر</p></div>
      <button class="opx-btn ghost sm" id="rvX" aria-label="إغلاق">${ICONS.x}</button></header>
    <div class="opx-rv-body">
    <div class="opx-rv-kpis"><div><b>${num(sel.length)}</b><span>مختارة من ${num(cand.length)}</span></div><div><b>${egp(budget)}</b><span>ميزانية يومية هتتفتح</span></div><div><b>${avg == null ? 'غير متاح' : num(avg)}</b><span>متوسط CPA (موزون)</span></div><div><b>${num(orders)}</b><span>أوردرات الفترة</span></div></div>
    ${s.note ? `<div class="opx-notice amber"><div class="grow"><b>${E(s.note.title)}</b><small>${E(s.note.text)}</small></div></div>` : ''}
    <div class="opx-rv-bar"><span class="opx-note">شيل العلامة من أي حملة مش عايز تفتحها — الاختيار بيتحفظ فورًا. إغلاق الشاشة مش موافقة.</span>
      <span><button class="opx-btn sm" id="rvAll" ${ed ? '' : 'disabled'}>${ICONS.check} تحديد الكل</button> <button class="opx-btn sm" id="rvNone" ${ed ? '' : 'disabled'}>${ICONS.x} إلغاء الكل</button></span></div>
    <div class="opx-rv-list" role="list">
      <div class="opx-rv-th"><span></span><span>المنتج / الحملة</span><span class="c">CPA آخر 7 أيام</span><span class="c">CPA آخر 30 يوم</span><span class="c">الميزانية اليومية</span></div>
      ${cand.length ? cand.map(row).join('') : '<div class="opx-empty">مفيش حملات مطابقة وجاهزة للفتح دلوقتي.</div>'}
    </div>
    ${excl.length ? `<button class="opx-btn ghost sm opx-rv-tog" id="rvEx">${R.showExcluded ? '▾' : '◂'} مطابقة للنطاق لكن مستبعدة (${num(excl.length)}) — ليه؟</button>${R.showExcluded ? `<div class="opx-rv-ex">${excl.map((r) => `<div><b>${E(r.product || r.name)}</b><small>${E(r.name || r.id)}</small><span>${E((r.reasons || []).join(' · ') || '—')}</span></div>`).join('')}</div>` : ''}` : ''}
    </div>
    <footer class="opx-rv-foot"><div class="grow"><b>${num(sel.length)} حملة</b> · ${egp(budget)} يوميًا<small>هيتعمل لكل واحدة إعادة تحقق من Meta قبل الفتح وقراءة بعده — واحدة واحدة.</small></div>
      <button class="opx-btn" id="rvTable">فتح الجدول الكامل</button><button class="opx-btn" id="rvLater">لاحقًا</button>
      <button class="opx-btn primary" id="rvOk" ${ed && sel.length ? '' : 'disabled'}>${ICONS.play} اعتماد وفتح (${num(sel.length)})</button></footer></div>`;
  hydrateThumbs(el);
  el.onclick = (e) => { if (e.target === el) { cb.dismiss?.(); closeReview(); } };
  el.querySelector('#rvX').onclick = el.querySelector('#rvLater').onclick = () => { cb.dismiss?.(); closeReview(); };
  el.querySelector('#rvTable').onclick = () => { cb.dismiss?.(); closeReview(); cb.openTable?.(); };
  const busy = async (fn) => { if (R.busy) return; R.busy = true; render(); try { await fn(); } finally { if (R) { R.busy = false; render(); } } };
  el.querySelectorAll('.opx-rv-row input.opx-check').forEach((c) => { c.onchange = () => busy(() => cb.toggle(c.dataset.id, c.checked)); });
  el.querySelector('#rvAll').onclick = () => busy(() => cb.all()); el.querySelector('#rvNone').onclick = () => busy(() => cb.none());
  const ex = el.querySelector('#rvEx'); if (ex) ex.onclick = () => { R.showExcluded = !R.showExcluded; render(); };
  el.querySelector('#rvOk').onclick = async () => { if (R.busy) return; R.busy = true; render(); let ok = false; try { ok = await cb.approve(); } finally { if (R) { R.busy = false; if (ok) closeReview(); else render(); } } };
}
