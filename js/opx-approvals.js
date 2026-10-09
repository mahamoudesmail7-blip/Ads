// opx-approvals.js — «الموافقات»: every pending decision and daily plan in one table. Approve / Reject / Evidence per row; bulk approval only for decisions the SERVER marks eligible, with the
// exposed budget and exact count the server computed shown before confirming. Presentation over /api/operator/approvals (the same official routes as before).
import { api } from './api-client.js';
import { E, num, egp, ago, ICONS, kpiCard, pill, skeletonRows, openDrawer, toast, confirmModal, $, thumb, hydrateThumbs } from './opx-ui.js';

const A = { ctx: null, root: null, r: null, sel: new Set() };
const RISK = { HIGH: ['red', 'مرتفعة'], MEDIUM: ['amber', 'متوسطة'], LOW: ['green', 'منخفضة'] };
const plain = (h) => String(h).replace(/<[^>]+>/g, '');
const val = (x) => (!x ? '—' : x.kind === 'BUDGET' ? egp(x.value) : E({ ACTIVE: 'شغالة', PAUSED: 'موقوفة' }[x.value] || x.value));

export async function mountApprovalsWorkspace(root, ctx) { A.ctx = ctx; A.root = root; root.innerHTML = `<div class="opx-card">${skeletonRows(5)}</div>`; await load(); }
async function load() {
  try { A.r = await api.get('/api/operator/approvals'); } catch (e) { A.root.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message)}</div>`; return; }
  A.sel.clear(); draw();
}
function draw() {
  const r = A.r, g = r.gate; const reasons = []; if (g.emergencyStop) reasons.push('Emergency Stop'); if (g.mode !== 'APPROVAL') reasons.push(`الوضع ${g.mode === 'OFF' ? 'MANUAL' : g.mode}`); if (g.writesLocked) reasons.push('كتابة Meta مقفولة');
  const exposed = r.decisions.reduce((t, d) => t + (Number(d.exposedBudget) || 0), 0);
  A.root.innerHTML = `
    <div class="opx-card opx-head opx-fade"><div class="opx-head-icon violet">${ICONS.approve}</div><div class="grow"><h1>الموافقات</h1><p>كل اللي مستني قرارك — الموافقة إذن بتنفيذ الإجراء ده بس، بعد فحص Meta الحي لحظتها</p></div>${A.ctx.modeSegment()}<button class="opx-btn danger" data-opxstop ${g.emergencyStop ? 'disabled' : ''}>${ICONS.stop} إيقاف فوري</button></div>
    <div class="opx-notice ${reasons.length ? 'blue' : 'red'} opx-fade"><div class="grow"><b>${reasons.length ? 'التنفيذ الفعلي دلوقتي مش ممكن' : 'التنفيذ الفعلي ممكن — كل موافقة هتكتب على Meta'}</b><small>${reasons.length ? E(reasons.join(' · ')) + ' — الموافقة هتتسجّل لكن مفيش كتابة على Meta.' : 'الوضع APPROVAL وقفل النشر مفتوح: الموافقة بتنفّذ فعليًا بعد فحص حي.'}</small></div></div>
    <div class="opx-kpis">${kpiCard({ label: 'قرارات منتظرة', value: num(r.totals.pendingDecisions), icon: 'approve', tone: 'amber' })}${kpiCard({ label: 'خطط منتظرة', value: num(r.totals.pendingPlans), icon: 'clock', tone: 'blue' })}${kpiCard({ label: 'مؤهلة للموافقة الجماعية', value: num(r.totals.bulkEligible), icon: 'check', tone: 'green' })}${kpiCard({ label: 'إجمالي الميزانية المعرضة', value: egp(exposed), icon: 'coins', tone: 'red' })}</div>
    ${r.plans.length ? `<div class="opx-card opx-panel opx-fade"><h3>${ICONS.clock} خطط جاهزة للاعتماد</h3><div style="display:flex;flex-direction:column;gap:8px">${r.plans.map((p) => `<div class="opx-kv"><span><b style="color:var(--opx-text)">${p.type === 'OPEN' ? 'فتح' : 'إيقاف'}${p.independent ? ' (مستقلة)' : ''} — ${E(p.date)}</b></span><b>${num(p.selected)} مختارة من ${num(p.total)} · ${egp(p.exposedBudget)} <button class="opx-btn sm" data-goto="${p.type === 'OPEN' ? 'open' : 'pause'}">فتح الخطة</button></b></div>`).join('')}</div></div>` : ''}
    <div class="opx-card opx-tablecard opx-fade"><div class="opx-tablehead"><h3>القرارات المنتظرة (${num(r.decisions.length)})</h3>${A.ctx.isAdmin ? `<span class="opx-note" id="apInfo">اختار قرارات مؤهلة (إيقاف / تقليل ميزانية) للموافقة الجماعية</span><button class="opx-btn sm" id="apBulk" disabled>موافقة جماعية…</button>` : ''}<button class="opx-btn sm ghost" id="apRefresh">تحديث</button></div>
      <div class="opx-scroll opx-desk">${r.decisions.length ? table(r.decisions) : '<div class="opx-empty">مفيش قرارات منتظرة دلوقتي.</div>'}</div><div class="opx-cards">${r.decisions.length ? r.decisions.map(card).join('') : '<div class="opx-empty">مفيش قرارات منتظرة دلوقتي.</div>'}</div></div>`;
  wire(); hydrateThumbs(A.root);
}
function card(d) {
  const rk = RISK[d.risk] || ['gray', '—'];
  return `<article class="opx-c2"><label class="opx-c2-chk">${d.bulkEligible && A.ctx.isAdmin ? `<input type="checkbox" class="opx-check ap-sel" data-id="${d.id}" aria-label="تحديد">` : ''}</label><div class="opx-c2-top">${thumb(d.productId, d.product || d.campaign)}<div class="opx-c2-name"><b>${E(d.product || 'بدون منتج')}</b><small>${E(d.campaign || d.campaignId)} · #${d.id}</small></div>${pill(rk[1], rk[0])}</div><div class="opx-c2-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div><span>${E(d.actionLabel || d.action)}</span><b>${val(d.before)} ← ${val(d.after)}</b></div><div><span>ميزانية معرضة</span><b>${d.exposedBudget != null ? egp(d.exposedBudget) : '—'}</b></div></div>${d.hardBlocks?.length ? `<div class="opx-note bad">🚫 ${E(d.hardBlocks.join(' · '))}</div>` : `<div class="opx-note">${E(d.reason || '')}</div>`}<div class="opx-c2-foot">${A.ctx.isAdmin ? `<button class="opx-btn sm primary" data-approve="${d.id}">Approve</button><button class="opx-btn sm" data-reject="${d.id}">Reject</button>` : ''}<button class="opx-btn sm ghost" data-ev="${d.id}">الأدلة</button></div></article>`;
}
function table(list) {
  return `<table class="opx-table"><thead><tr><th></th><th>المنتج / الحملة</th><th>العملية</th><th class="num">قبل ← بعد</th><th class="num">ميزانية معرضة</th><th>المخاطرة</th><th>الحواجز</th><th>الوقت</th><th></th></tr></thead><tbody>${list.map((d) => { const rk = RISK[d.risk] || ['gray', '—'];
    return `<tr><td>${d.bulkEligible && A.ctx.isAdmin ? `<input type="checkbox" class="opx-check ap-sel" data-id="${d.id}" aria-label="تحديد">` : ''}</td>
      <td><div class="opx-prod"><div class="opx-thumb">${E(String(d.product || d.campaign || '?').slice(0, 1).toUpperCase())}</div><div><b>${E(d.product || 'بدون منتج')}</b><small>${E(d.campaign || d.campaignId)} · #${d.id}</small></div></div></td>
      <td>${pill(E(d.actionLabel || d.action), /PAUSE|DOWN|تقليل|إيقاف/.test(d.action + (d.actionLabel || '')) ? 'red' : 'green')}</td><td class="num">${val(d.before)} ← <b>${val(d.after)}</b></td><td class="num">${d.exposedBudget != null ? egp(d.exposedBudget) : '—'}</td>
      <td>${pill(rk[1], rk[0])}<small>ثقة ${E(d.confidence || '—')}</small></td><td class="opx-why">${d.hardBlocks?.length ? `<span class="bad">🚫 ${E(d.hardBlocks.join(' · '))}</span>` : E(d.execution?.executableNow ? 'هينفّذ فعليًا' : 'محاكاة/مقفول')}<small>${E(d.reason || '')}</small></td><td>${E(ago(d.at || d.createdAt))}</td>
      <td style="white-space:nowrap">${A.ctx.isAdmin ? `<button class="opx-btn sm primary" data-approve="${d.id}">Approve</button> <button class="opx-btn sm" data-reject="${d.id}">Reject</button> ` : ''}<button class="opx-btn sm ghost" data-ev="${d.id}">الأدلة</button></td></tr>`; }).join('')}</tbody></table>`;
}
function wire() {
  const root = A.root; const r = A.r;
  root.querySelectorAll('[data-opxstop]').forEach((b) => { b.onclick = A.ctx.emergencyStop; });
  root.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => window.dispatchEvent(new CustomEvent('opx:open', { detail: b.dataset.goto })); });
  const upd = () => { const b = $('apBulk'); if (b) b.disabled = A.sel.size === 0; if ($('apInfo')) $('apInfo').textContent = A.sel.size ? `${A.sel.size} قرار مختار` : 'اختار قرارات مؤهلة (إيقاف / تقليل ميزانية) للموافقة الجماعية'; };
  root.querySelectorAll('.ap-sel').forEach((c) => { c.onchange = () => { c.checked ? A.sel.add(Number(c.dataset.id)) : A.sel.delete(Number(c.dataset.id)); upd(); }; });
  if ($('apRefresh')) $('apRefresh').onclick = load;
  root.querySelectorAll('[data-approve]').forEach((b) => { b.onclick = async () => {
    const d = r.decisions.find((x) => x.id === Number(b.dataset.approve));
    if (!(await confirmModal({ title: `موافقة: ${d.actionLabel || d.action}`, message: `${d.campaign}: ${plain(val(d.before))} ← ${plain(val(d.after))}. ${d.execution?.executableNow ? 'هينفّذ فعليًا على Meta بعد فحص حي، وبعدها قراءة مستقلة للتأكد.' : 'مش هينفّذ على Meta دلوقتي (محاكاة/مقفول) — بيتسجّل بس.'}`, confirmLabel: d.execution?.executableNow ? 'موافقة وتنفيذ' : 'موافقة', danger: !!d.execution?.executableNow }))) return;
    try { const x = await api.post(`/api/operator/decisions/${d.id}/approve`, {}); toast(x.message || (x.executed ? 'اتنفّذ' : 'اتسجّلت الموافقة'), x.executed ? 'success' : 'warning'); } catch (e) { toast(e.message, 'error'); }
    await load(); await A.ctx.refresh(); }; });
  root.querySelectorAll('[data-reject]').forEach((b) => { b.onclick = async () => {
    if (!(await confirmModal({ title: 'رفض القرار', message: 'القرار هيتقفل ومش هيتنفذ.', confirmLabel: 'رفض' }))) return;
    try { await api.post(`/api/operator/decisions/${b.dataset.reject}/reject`, {}); toast('اترفض'); } catch (e) { toast(e.message, 'error'); }
    await load(); await A.ctx.refresh(); }; });
  root.querySelectorAll('[data-ev]').forEach((b) => { b.onclick = async () => {
    const d = r.decisions.find((x) => x.id === Number(b.dataset.ev)); openDrawer({ title: E(d.campaign || d.campaignId), body: '<div class="opx-skel" style="height:160px"></div>' });
    let tl = []; try { tl = (await api.get(`/api/operator/decisions/${d.id}/events`)).events; } catch { /* optional */ }
    openDrawer({ title: E(d.campaign || d.campaignId), body: `<div><div class="opx-kv"><span>العملية</span><b>${E(d.actionLabel || d.action)}</b></div><div class="opx-kv"><span>قبل ← بعد</span><b>${val(d.before)} ← ${val(d.after)}</b></div><div class="opx-kv"><span>السبب</span><b style="max-width:340px">${E(d.reason || '—')}</b></div><div class="opx-kv"><span>الثقة</span><b>${E(d.confidence || '—')}</b></div><div class="opx-kv"><span>ينفّذ فعليًا الآن؟</span><b>${d.execution?.executableNow ? 'نعم' : 'لا — ' + E((d.execution?.reasons || []).join(' · '))}</b></div></div>
      ${d.hardBlocks?.length ? `<div class="opx-notice red"><div class="grow"><b>حواجز</b><small>${E(d.hardBlocks.join(' · '))}</small></div></div>` : ''}<h3>الخط الزمني</h3>${tl.length ? `<ol class="opx-note">${tl.map((e) => `<li><b>${E(e.from || '·')} → ${E(e.to || e.kind)}</b> ${E(e.actor || '')} · ${E(ago(e.at))}${e.note ? ' — ' + E(e.note) : ''}</li>`).join('')}</ol>` : '<p class="opx-note">مفيش أحداث بعد.</p>'}` });
  }; });
  const bulk = $('apBulk'); if (bulk) bulk.onclick = async () => {
    try {
      const pv = await api.post('/api/operator/approvals/bulk-preview', { decisionIds: [...A.sel] });
      if (!pv.ok) { toast(pv.blockers.join(' | '), 'error'); return; }
      if (!(await confirmModal({ title: '⚠️ موافقة جماعية', message: `${pv.count} حملة — إجمالي الميزانية المعرضة ${egp(pv.exposedBudget)}.\n${pv.items.map((i) => `• ${i.campaign}`).join('\n')}\nكل حملة هتتراجع على Meta الحي قبل تنفيذها، وبفاصل ثواني بين كل عملية.`, confirmLabel: `موافقة على ${pv.count} حملة`, danger: true }))) return;
      const x = await api.post('/api/operator/approvals/bulk', { decisionIds: [...A.sel], confirm: { count: pv.count, exposedBudget: pv.exposedBudget } });
      toast(`اتنفّذ ${x.summary.executed} من ${x.summary.total}`); await load(); await A.ctx.refresh();
    } catch (e) { toast(e.message, 'error'); }
  };
}
