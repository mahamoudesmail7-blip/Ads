// ai-operator-approvals.js — «✅ القرارات والموافقات» (Approval Center) + the Daily AI Brief card + the top status chips.
// Presentation only. Approve / reject use the existing official routes; bulk approval needs the owner to confirm the exact count and exposed budget the SERVER computed.
import * as UI from './ui-common.js';
import { api } from './api-client.js';
import { E, S, num, egp, ago } from './ai-operator-core.js';

const API = '/api/operator';
const RISK_CLS = { HIGH: 'red', MEDIUM: 'amber', LOW: 'green' }; const RISK_AR = { HIGH: 'مرتفعة', MEDIUM: 'متوسطة', LOW: 'منخفضة' };
const val = (x) => (!x ? '—' : x.kind === 'BUDGET' ? egp(x.value) : E({ ACTIVE: 'شغالة', PAUSED: 'موقوفة' }[x.value] || x.value));
const D = { sel: new Set() };

export async function drawApprovals(body) {
  body.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  const r = await api.get(`${API}/approvals`); D.sel.clear();
  const g = r.gate; const reasons = [];
  if (g.emergencyStop) reasons.push('Emergency Stop'); if (g.mode !== 'APPROVAL') reasons.push(`الوضع ${g.mode === 'OFF' ? 'MANUAL' : g.mode}`); if (g.writesLocked) reasons.push('كتابة Meta مقفولة');
  const row = (d) => `<tr data-id="${d.id}">
    <td>${d.bulkEligible && S.isAdmin ? `<input type="checkbox" class="ap-sel" data-id="${d.id}" aria-label="تحديد">` : ''}</td>
    <td class="dp-name"><b>${E(d.campaign || d.campaignId)}</b><small>${E(d.product || 'بدون منتج')} · #${d.id}</small></td>
    <td>${E(d.actionLabel || d.action)}</td><td>${val(d.before)} <b>←</b> ${val(d.after)}</td>
    <td class="dp-why">${E(d.reason || '—')}${d.hardBlocks.length ? `<small class="bad">🚫 ${E(d.hardBlocks.join(' · '))}</small>` : ''}</td>
    <td><span class="op-pill ${RISK_CLS[d.risk]}">${RISK_AR[d.risk]}</span></td><td>${E(d.confidence || '—')}</td><td>${d.exposedBudget != null ? egp(d.exposedBudget) : '—'}</td>
    <td>${d.execution.executableNow ? '<span class="op-pill amber">هينفّذ فعليًا</span>' : `<span class="op-pill gray" title="${E(d.execution.reasons.join(' · '))}">محاكاة/مقفول</span>`}</td>
    <td class="ap-btns">${S.isAdmin ? `<button class="amb-btn sm orange" data-approve="${d.id}">موافقة</button><button class="amb-btn sm" data-reject="${d.id}">رفض</button>` : ''}</td></tr>`;
  body.innerHTML = `<div class="dp-wrap">
    <div class="dp-head"><div><h2>✅ القرارات والموافقات</h2><div class="op-sub">كل اللي مستني قرارك في قايمة واحدة. الموافقة = إذن بتنفيذ الإجراء ده بس، بعد فحص Meta الحي لحظتها.</div></div>
      <div class="dp-head-btns"><button class="amb-btn sm" id="apRefresh">🔄 تحديث</button></div></div>
    <div class="dp-note ${reasons.length ? '' : 'bad'}">${reasons.length ? `ℹ️ التنفيذ الفعلي دلوقتي <b>مش ممكن</b> (${E(reasons.join(' · '))}) — الموافقة هتتسجّل لكن مفيش كتابة على Meta.` : '⚠️ الوضع APPROVAL والكتابة مفتوحة: كل موافقة هنا بتنفّذ فعليًا (لو صلاحية الأكشن ON).'}</div>
    <div class="op2-kpis"><div class="op2-k amber"><b>${num(r.totals.pendingDecisions)}</b><span>قرارات منتظرة</span></div><div class="op2-k blue"><b>${num(r.totals.pendingPlans)}</b><span>خطط منتظرة</span></div><div class="op2-k green"><b>${num(r.totals.bulkEligible)}</b><span>مؤهلة للموافقة الجماعية</span></div><div class="op2-k gray"><b>${egp(r.totals.exposedBudgetDecisions)}</b><span>ميزانية معرّضة (القرارات)</span></div></div>
    ${r.plans.length ? `<div class="pm-caps"><h3>📅 خطط جاهزة للاعتماد</h3>${r.plans.map((p) => `<div class="ap-plan"><b>${p.type === 'OPEN' ? '▶️ فتح' : '⏸️ إيقاف'}${p.independent ? ' (مستقلة)' : ''} — ${E(p.date)}</b><span>${p.selected} متحددة من ${p.total} · ميزانية معرّضة ${egp(p.exposedBudget)}</span>${p.dataState === 'STALE' ? '<span class="op-pill red">STALE</span>' : ''}<button class="amb-btn sm" data-plan="${p.planId}">افتح الخطة</button></div>`).join('')}</div>` : ''}
    <div class="op-bulkbar"><span id="apBulkInfo">اختار قرارات متجانسة مؤهلة (إيقاف / تقليل ميزانية) للموافقة الجماعية</span> <button class="amb-btn warning" id="apBulk" disabled>موافقة جماعية…</button></div>
    ${r.decisions.length ? `<div class="table-wrap op-table-wrap"><table class="data dp-table"><thead><tr><th></th><th>الحملة / المنتج</th><th>الإجراء</th><th>قبل ← بعد</th><th>السبب</th><th>المخاطرة</th><th>الثقة</th><th>ميزانية معرّضة</th><th>التنفيذ</th><th></th></tr></thead><tbody>${r.decisions.map(row).join('')}</tbody></table></div>` : '<div class="amb-panel amb-empty">مفيش قرارات منتظرة موافقتك دلوقتي.</div>'}</div>`;
  const upd = () => { const b = document.getElementById('apBulk'); if (b) b.disabled = D.sel.size === 0; document.getElementById('apBulkInfo').textContent = D.sel.size ? `${D.sel.size} قرار مختار` : 'اختار قرارات متجانسة مؤهلة (إيقاف / تقليل ميزانية) للموافقة الجماعية'; };
  body.querySelectorAll('.ap-sel').forEach((c) => { c.onchange = () => { c.checked ? D.sel.add(Number(c.dataset.id)) : D.sel.delete(Number(c.dataset.id)); upd(); }; });
  document.getElementById('apRefresh').onclick = () => drawApprovals(body);
  body.querySelectorAll('[data-plan]').forEach((b) => { b.onclick = () => S.hooks.switchTab?.('daily'); });
  body.querySelectorAll('[data-approve]').forEach((b) => { b.onclick = async () => {
    const d = r.decisions.find((x) => x.id === Number(b.dataset.approve));
    if (!(await UI.confirmModal({ title: `موافقة: ${d.actionLabel || d.action}`, message: `${d.campaign}: ${val(d.before).replace(/<[^>]+>/g, '')} ← ${val(d.after).replace(/<[^>]+>/g, '')}. ${d.execution.executableNow ? 'هينفّذ فعليًا على Meta بعد فحص حي، وبعدها قراءة مستقلة وتسجيل.' : 'التنفيذ دلوقتي مقفول/محاكاة: ' + d.execution.reasons.join(' · ')}`, confirmLabel: 'موافقة', danger: d.execution.executableNow }))) return;
    try { const x = await api.post(`${API}/decisions/${d.id}/approve`, {}); UI.toast(x.message || (x.executed ? 'اتنفّذ' : 'اتسجّلت الموافقة'), x.executed ? 'success' : 'warning'); } catch (e) { UI.toast(e.message, 'error'); }
    await drawApprovals(body); }; });
  body.querySelectorAll('[data-reject]').forEach((b) => { b.onclick = async () => {
    if (!(await UI.confirmModal({ title: 'رفض القرار', message: 'القرار هيتقفل ومش هيتنفذ.', confirmLabel: 'رفض' }))) return;
    try { await api.post(`${API}/decisions/${b.dataset.reject}/reject`, {}); UI.toast('اترفض'); } catch (e) { UI.toast(e.message, 'error'); }
    await drawApprovals(body); }; });
  const bulk = document.getElementById('apBulk'); if (bulk) bulk.onclick = async () => {
    try {
      const pv = await api.post(`${API}/approvals/bulk-preview`, { decisionIds: [...D.sel] });
      if (!pv.ok) { UI.toast(pv.blockers.join(' | '), 'error'); return; }
      if (!(await UI.confirmModal({ title: '⚠️ موافقة جماعية', message: `${pv.count} حملة — إجمالي الميزانية المعرضة للصرف ${egp(pv.exposedBudget)}.\n${pv.items.map((i) => `• ${i.campaign}`).join('\n')}\nكل حملة هتتراجع على Meta الحي لحظة تنفيذها، بفاصل 3 ثواني، ومحفوظ Snapshot بالقرار ده.`, confirmLabel: `تأكيد ${pv.count} حملة / ${egp(pv.exposedBudget)}`, danger: true }))) return;
      const x = await api.post(`${API}/approvals/bulk`, { decisionIds: [...D.sel], confirm: { count: pv.count, exposedBudget: pv.exposedBudget } });
      UI.toast(`اتنفّذ ${x.summary.executed} من ${x.summary.total}`); await drawApprovals(body);
    } catch (e) { UI.toast(e.message, 'error'); }
  };
}

const BRIEF_FMT = (it) => {
  const v = it.value;
  if (Array.isArray(v)) return v.length ? `<ul class="dp-audit">${v.map((x) => `<li>${E(x.campaign || x.title || x.type || '')} ${x.cpa != null ? `· CPA ${num(x.cpa)}` : ''} ${x.purchases != null ? `· ${num(x.purchases)} أوردر` : ''} ${x.spend != null ? `· صرف ${num(x.spend)}` : ''} ${x.verified === true ? '✅' : x.verified === false ? '⚠️' : ''}</li>`).join('')}</ul>` : '<span class="op-sub">لا يوجد</span>';
  if (v && typeof v === 'object') return Object.entries(v).map(([k, n]) => `${E({ decisions: 'قرارات', plans: 'خطط' }[k] || k)}: <b>${num(n)}</b>`).join(' · ');
  return `<b>${v == null ? '—' : num(v, it.key === 'avgCpa' ? 0 : 0)}</b>`;
};
export async function drawBrief(el) {
  el.innerHTML = '<div class="amb-loading">جارِ تجهيز الملخص…</div>';
  try {
    const b = await api.get(`${API}/brief`);
    el.innerHTML = `<div class="brief-grid">${b.items.map((it) => `<div class="brief-card"><div class="brief-k">${E(it.label)}</div><div class="brief-v">${BRIEF_FMT(it)}</div><small>المصدر: ${E(it.source)} · الفترة: ${E(it.window)}</small></div>`).join('')}</div><div class="op-sub">${E(b.caveat)} · اتولّد ${E(ago(b.generatedAt))}</div>`;
  } catch (e) { el.innerHTML = `<div class="dp-note bad">⚠️ ${E(e.message)}</div>`; }
}

/** small chips under the status row: active campaigns · pending approvals · scheduled plans · important alerts (each jumps to its screen) */
export async function drawStatusChips(el) {
  try {
    const s = await api.get(`${API}/status-bar`);
    el.innerHTML = `<span class="op-pill blue" title="حملات حالتها ACTIVE في آخر مزامنة">▶ نشطة ${num(s.activeCampaigns)}</span><button class="op-pill amber op2-chip" data-jump="approvals">⏳ موافقات ${num(s.pendingApprovals)}</button><button class="op-pill blue op2-chip" data-jump="daily">📅 خطط ${num(s.scheduledPlans)}</button><span class="op-pill ${s.importantAlerts ? 'red' : 'gray'}" title="تنبيهات WARNING/CRITICAL غير مقروءة">🔔 ${num(s.importantAlerts)}</span>`;
    el.querySelectorAll('[data-jump]').forEach((b) => { b.onclick = () => S.hooks.switchTab?.(b.dataset.jump); });
  } catch { el.innerHTML = ''; }
}
