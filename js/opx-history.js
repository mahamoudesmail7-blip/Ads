// opx-history.js — «سجل التنفيذ»: every Meta write the system attempted with its stages (Requested → Validated → Approved → Sent → Read-back → Verified / Failed / Blocked / Uncertain).
// "Verified" only appears after the independent Meta read-back confirmed the change. Presentation over /api/operator/execution-history (+ /monitoring for the 6/12/24/48h follow-up).
import { api } from './api-client.js';
import { E, num, egp, cairoDateTime, ICONS, kpiCard, pill, skeletonRows, openDrawer, $ } from './opx-ui.js';

const H = { ctx: null, root: null, r: null, mon: null, f: { type: '', final: '', q: '' } };
const FINAL = { VERIFIED: ['green', 'Verified'], FAILED: ['red', 'Failed'], BLOCKED: ['red', 'Blocked'], UNCERTAIN: ['amber', 'Uncertain'], REQUESTED: ['gray', 'Requested'], VALIDATED: ['blue', 'Validated'] };
const STAGE_AR = { REQUESTED: 'Requested', VALIDATED: 'Validated', APPROVED: 'Approved', SENT: 'Sent', READ_BACK: 'Read-back', VERIFIED: 'Verified', FAILED: 'Failed', BLOCKED: 'Blocked', UNCERTAIN: 'Uncertain', PENDING: 'Pending' };
const VERDICT = { IMPROVED: ['green', 'تحسّن'], WORSE: ['red', 'أسوأ'], NO_CHANGE: ['gray', 'بدون تغيير'], INSUFFICIENT: ['amber', 'بيانات غير كافية'], PENDING: ['blue', 'قيد المراقبة'] };

export async function mountHistoryWorkspace(root, ctx) {
  H.ctx = ctx; H.root = root; root.innerHTML = `<div class="opx-card">${skeletonRows(6)}</div>`;
  try { [H.r, H.mon] = await Promise.all([api.get('/api/operator/execution-history', { limit: 200 }), api.get('/api/operator/monitoring').catch(() => ({ actions: [] }))]); } catch (e) { root.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message)}</div>`; return; }
  draw();
}
const rows = () => { const q = H.f.q.trim().toLowerCase(); return H.r.rows.filter((r) => (!H.f.type || r.type === H.f.type) && (!H.f.final || r.final === H.f.final) && (!q || `${r.campaignName || ''} ${r.campaignId}`.toLowerCase().includes(q))); };
const stages = (r) => `<div style="display:flex;gap:4px;flex-wrap:wrap">${r.stages.map((s) => { const bad = s.ok === false || ['FAILED', 'BLOCKED'].includes(s.key); const tone = !s.done ? 'gray' : bad ? 'red' : s.key === 'UNCERTAIN' ? 'amber' : s.key === 'VERIFIED' ? 'green' : 'blue'; return `<span class="opx-pill ${tone}" style="opacity:${s.done ? 1 : .45};font-size:11px;padding:2px 8px" title="${E(s.note || '')}">${s.done ? '●' : '○'} ${STAGE_AR[s.key] || s.key}</span>`; }).join('')}</div>`;
function draw() {
  const c = H.r.counts; const l = rows();
  H.root.innerHTML = `
    <div class="opx-card opx-head opx-fade"><div class="opx-head-icon blue">${ICONS.history}</div><div class="grow"><h1>سجل التنفيذ</h1><p>كل عملية: طُلبت ← اتحقق منها ← اتوافق عليها ← أُرسلت ← قُرئت من Meta ← تأكدت. النجاح لا يُحسب إلا بعد قراءة Meta</p></div>${H.ctx.modeSegment()}<button class="opx-btn danger" data-opxstop ${H.ctx.ov().emergencyStop ? 'disabled' : ''}>${ICONS.stop} إيقاف فوري</button></div>
    <div class="opx-kpis">${kpiCard({ label: 'إجمالي العمليات', value: num(c.total), icon: 'history', tone: 'violet' })}${kpiCard({ label: 'Verified (اتأكدت من Meta)', value: num(c.VERIFIED || 0), icon: 'check', tone: 'green' })}${kpiCard({ label: 'Uncertain (غير مؤكدة)', value: num(c.UNCERTAIN || 0), icon: 'clock', tone: 'amber' })}${kpiCard({ label: 'Failed', value: num(c.FAILED || 0), icon: 'stop', tone: 'red' })}${kpiCard({ label: 'Blocked قبل الإرسال', value: num(c.BLOCKED || 0), icon: 'shield', tone: 'red' })}</div>
    <div class="opx-card opx-filters"><input class="opx-input opx-search" id="hQ" placeholder="ابحث باسم الحملة أو الرقم…" value="${E(H.f.q)}">
      <select class="opx-select" id="hType"><option value="">كل العمليات</option>${[['RESUME', 'فتح'], ['PAUSE', 'إيقاف'], ['INCREASE_BUDGET', 'زيادة ميزانية'], ['DECREASE_BUDGET', 'تقليل ميزانية']].map(([k, t]) => `<option value="${k}" ${H.f.type === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <select class="opx-select" id="hFinal"><option value="">كل الحالات</option>${['VERIFIED', 'UNCERTAIN', 'FAILED', 'BLOCKED', 'REQUESTED', 'VALIDATED'].map((k) => `<option value="${k}" ${H.f.final === k ? 'selected' : ''}>${FINAL[k][1]}</option>`).join('')}</select></div>
    <div class="opx-card opx-tablecard opx-fade"><div class="opx-tablehead"><h3>العمليات (${num(l.length)})</h3></div><div class="opx-scroll opx-desk">${l.length ? table(l) : '<div class="opx-empty">مفيش عمليات تنفيذ مسجّلة بعد. أي فتح/إيقاف/تغيير ميزانية (حتى المحاكاة اللي بتكتب سجل) هتظهر هنا.</div>'}</div><div class="opx-cards">${l.map(histCard).join('') || '<div class="opx-empty">مفيش عمليات تنفيذ مسجّلة بعد.</div>'}</div></div>
    <div class="opx-card opx-tablecard opx-fade"><div class="opx-tablehead"><h3>${ICONS.eye} المراقبة بعد التنفيذ (6 / 12 / 24 / 48 ساعة)</h3></div><div class="opx-scroll">${monitoring()}</div></div>`;
  $('hQ').oninput = (e) => { H.f.q = e.target.value; const p = e.target.selectionStart; draw(); const q = $('hQ'); q.focus(); q.setSelectionRange(p, p); };
  $('hType').onchange = (e) => { H.f.type = e.target.value; draw(); }; $('hFinal').onchange = (e) => { H.f.final = e.target.value; draw(); };
  H.root.querySelectorAll('[data-opxstop]').forEach((b) => { b.onclick = H.ctx.emergencyStop; });
  H.root.querySelectorAll('[data-row]').forEach((b) => { b.onclick = () => detail(H.r.rows.find((x) => x.id === Number(b.dataset.row))); });
}
function histCard(r) {
  const f = FINAL[r.final] || ['gray', r.final];
  return `<article class="opx-c2"><div class="opx-c2-top" style="padding-left:0"><div class="opx-c2-name"><b>${E(r.campaignName || r.campaignId)}</b><small>${E(r.typeLabel)} · ${E(cairoDateTime(r.at))}</small></div>${pill(f[1], f[0])}</div><div class="opx-c2-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div><span>قبل ← بعد</span><b>${r.budgetChange ? `${egp(r.before)} ← ${egp(r.after)}` : `${E(r.before ?? '—')} ← ${E(r.after ?? '—')}`}</b></div><div><span>المنفّذ</span><b>${E(r.by || '—')}</b></div></div>${stages(r)}${r.error ? `<div class="opx-note bad">${E(String(r.error).slice(0, 140))}</div>` : ''}<div class="opx-c2-foot"><button class="opx-btn sm ghost" data-row="${r.id}">تفاصيل</button></div></article>`;
}
function table(l) {
  return `<table class="opx-table"><thead><tr><th>الوقت</th><th>الحملة</th><th>العملية</th><th>المنفّذ</th><th class="num">قبل ← بعد</th><th>المراحل</th><th>النتيجة</th><th></th></tr></thead><tbody>${l.map((r) => { const f = FINAL[r.final] || ['gray', r.final];
    return `<tr><td>${E(cairoDateTime(r.at))}</td><td><div class="opx-prod"><div class="opx-thumb">${E(String(r.campaignName || '?').slice(0, 1).toUpperCase())}</div><div><b>${E(r.campaignName || r.campaignId)}</b><small>${E(r.campaignId)}</small></div></div></td><td>${pill(E(r.typeLabel), /PAUSE|DECREASE/.test(r.type) ? 'red' : 'green')}<small>${E(r.mode)}</small></td><td>${E(r.by || '—')}<small>${E(r.approval === 'AUTO' ? 'تلقائي' : 'بموافقة')}</small></td>
      <td class="num">${r.budgetChange ? `${egp(r.before)} ← <b>${egp(r.after)}</b>` : `${E(r.before ?? '—')} ← <b>${E(r.after ?? '—')}</b>`}</td><td>${stages(r)}</td><td>${pill(f[1], f[0])}${r.error ? `<small class="opx-why"><span class="bad">${E(String(r.error).slice(0, 120))}</span></small>` : ''}</td><td><button class="opx-btn ghost sm" data-row="${r.id}">تفاصيل</button></td></tr>`; }).join('')}</tbody></table>`;
}
function monitoring() {
  const a = H.mon.actions || []; if (!a.length) return '<div class="opx-empty">مفيش عمليات تحت المراقبة بعد.</div>';
  const OPL = { RESUME: 'فتح', PAUSE: 'إيقاف', INCREASE_BUDGET: 'زيادة ميزانية', DECREASE_BUDGET: 'تقليل ميزانية' };
  return `<table class="opx-table"><thead><tr><th>الحملة</th><th>العملية</th><th>الحكم</th><th>نقاط المراقبة</th></tr></thead><tbody>${a.map((x) => { const v = VERDICT[x.verdict] || ['gray', x.verdictLabel || x.verdict || '—']; return `<tr><td><b>${E(x.entityName || x.campaignId || '—')}</b><small>${E(cairoDateTime(x.executedAt))}</small></td><td>${E(OPL[x.actionType] || x.actionType)}</td><td>${pill(E(x.verdictLabel || v[1]), v[0])}${x.rollback?.suggested ? `<small>${E(x.rollback.message || 'اقتراح رجوع — مش بيتنفذ تلقائيًا')}</small>` : ''}</td><td class="opx-why">${(x.checkpoints || []).map((c) => `${c.hours}س: ${E(c.state === 'PENDING' ? 'قيد الانتظار' : (c.label || (VERDICT[c.verdict] || [0, c.verdict || '—'])[1]))}`).join(' · ')}</td></tr>`; }).join('')}</tbody></table>`;
}
function detail(r) {
  if (!r) return; const kv = (k, v) => `<div class="opx-kv"><span>${k}</span><b style="max-width:360px;word-break:break-word">${v}</b></div>`;
  openDrawer({ title: E(r.campaignName || r.campaignId), body: `<div>${kv('العملية', E(r.typeLabel))}${kv('الوضع', E(r.mode))}${kv('طُلبت', E(cairoDateTime(r.requestedAt)))}${kv('نُفّذت', E(cairoDateTime(r.at)))}${kv('المنفّذ', E(r.by || '—'))}${kv('قبل ← بعد', r.budgetChange ? `${egp(r.before)} ← ${egp(r.after)}` : `${E(r.before ?? '—')} ← ${E(r.after ?? '—')}`)}${kv('النتيجة', E(r.finalLabel))}${r.verify ? kv('قراءة Meta المستقلة', r.verify.verified ? 'أكدت التغيير' : `لم تؤكد (${E(r.verify.observed ?? '—')})`) : kv('قراءة Meta المستقلة', 'لم تحصل')}${r.reason ? kv('السبب', E(r.reason)) : ''}</div><h3>المراحل</h3>${stages(r)}${r.error ? `<div class="opx-notice red"><div class="grow"><b>سبب الفشل/المنع</b><small>${E(r.error)}</small></div></div>` : ''}${r.metaResponse ? `<h3>رد Meta</h3><pre class="opx-note" style="white-space:pre-wrap;direction:ltr;text-align:left">${E(r.metaResponse)}</pre>` : ''}<p class="opx-note">العملية غير المؤكدة (Uncertain) لا يُعاد إرسالها بشكل أعمى — راجع الحملة على Meta أولًا.</p>` });
}
