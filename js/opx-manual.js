// opx-manual.js — «التشغيل اليدوي»: a REAL manual mode. Pick ONE campaign and ONE operation (open · pause · increase · reduce) → live preflight from Meta → explicit confirmation of that exact change → result with the
// independent Meta read-back. Presentation only: every rule (gate, permissions, caps, conflicts, confirmation token) lives on the server; a blocked operation always says WHY and what to do.
import { api } from './api-client.js';
import { E, num, egp, ICONS, kpiCard, pill, skeletonRows, openDrawer, closeDrawer, toast, confirmModal, $ } from './opx-ui.js';

const M = { root: null, ctx: null, list: [], q: '', busy: null, pre: null, args: null };
const OPS = { OPEN: ['فتح', 'play'], PAUSE: ['إيقاف', 'pause'], INCREASE: ['زيادة ميزانية', 'plus'], REDUCE: ['تقليل ميزانية', 'budget'] };
const STAGES = ['جاري التجهيز', 'جاري التحقق', 'بانتظار تأكيدك', 'جاري التنفيذ', 'جاري التحقق من Meta', 'تم'];
const FINAL_TONE = { VERIFIED: ['green', 'تم — اتأكد من Meta'], EXECUTED: ['amber', 'اتبعت — لسه مفيش تأكيد (Uncertain)'], UNCERTAIN: ['amber', 'غير مؤكد'], FAILED: ['red', 'فشل'], BLOCKED: ['red', 'اتمنع'], SHADOW: ['blue', 'محاكاة فقط'] };
const stageBar = (i) => `<ol class="opx-stages" aria-label="مراحل التنفيذ" style="display:flex;gap:6px;flex-wrap:wrap;padding:0;margin:8px 0;list-style:none">${STAGES.map((s, n) => `<li>${pill(`${n + 1}. ${s}`, n < i ? 'green' : n === i ? 'violet' : 'gray')}</li>`).join('')}</ol>`;

export async function mountManualWorkspace(root, ctx) {
  M.root = root; M.ctx = ctx; root.innerHTML = `<div class="opx-card">${skeletonRows(5)}</div>`;
  await load();
}
async function load() {
  try { const r = await api.get('/api/operator/manual/targets', { q: M.q }); M.list = r.campaigns || []; } catch (e) { M.root.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message)}</div>`; return; }
  draw();
}
function draw() {
  const mode = M.ctx.ov?.()?.mode || null; const admin = M.ctx.isAdmin;
  M.root.innerHTML = `
    <div class="opx-card opx-head opx-fade"><div class="opx-head-icon violet">${ICONS.key}</div><div class="grow"><h1>التشغيل اليدوي</h1><p>اختار حملة وعملية — السيستم بيقرأ حالتها الحية من Meta ويعرضلك التغيير بالظبط، ومفيش تنفيذ إلا بعد تأكيدك الصريح.</p></div></div>
    <div class="opx-notice ${admin ? 'blue' : 'amber'}"><div class="grow"><b>${admin ? 'كل عملية بتتأكد لوحدها' : 'العرض فقط — التنفيذ لـ ADMIN'}</b><small>نفس بوابات الأمان: إيقاف الطوارئ · قفل Meta · صلاحية العملية نفسها · الحدود والتعارضات. لو أي حاجة منهم قافلة هتشوف السبب بالظبط ومش هيتبعت أي حاجة لـMeta. في وضع SHADOW بيتسجل محاكاة فقط.</small></div></div>
    <div class="opx-card opx-filters"><input class="opx-input opx-search" id="mnQ" placeholder="ابحث باسم الحملة أو الرقم…" value="${E(M.q)}"></div>
    <div class="opx-card opx-tablecard opx-fade"><div class="opx-tablehead"><h3>الحملات (${num(M.list.length)})</h3></div><div class="opx-scroll">${M.list.length ? table(admin) : '<div class="opx-empty">مفيش حملات مطابقة.</div>'}</div></div>`;
  $('mnQ').onchange = (e) => { M.q = e.target.value; load(); };
  M.root.querySelectorAll('[data-mop]').forEach((b) => { b.onclick = () => begin(b.dataset.cid, b.dataset.mop); });
}
function table(admin) {
  return `<table class="opx-table"><thead><tr><th>الحملة</th><th>الحالة</th><th class="num">الميزانية</th><th>الربط</th><th>عمليات</th></tr></thead><tbody>${M.list.map((c) => {
    const ops = c.status === 'PAUSED' ? ['OPEN'] : ['PAUSE', 'INCREASE', 'REDUCE'];
    return `<tr><td><b>${E(c.name || c.id)}</b><small style="display:block;color:var(--opx-muted)">${E(c.id)}</small></td><td>${pill(c.status === 'ACTIVE' ? 'شغالة' : 'موقوفة', c.status === 'ACTIVE' ? 'green' : 'gray')}</td><td class="num">${c.budget != null ? egp(c.budget) : '—'}</td><td>${c.verified ? pill('مؤكد', 'green') : c.mapped ? pill('غير مؤكد', 'amber') : pill('غير مربوط', 'red')}</td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap">${ops.map((o) => `<button class="opx-btn sm" data-cid="${E(c.id)}" data-mop="${o}" ${admin ? '' : 'disabled'} title="${admin ? '' : 'ADMIN فقط'}">${ICONS[OPS[o][1]]} ${OPS[o][0]}</button>`).join('')}</div></td></tr>`;
  }).join('')}</tbody></table>`;
}
async function begin(campaignId, operation) {
  const c = M.list.find((x) => x.id === campaignId); M.args = { campaignId, operation, name: c?.name || campaignId };
  if (['INCREASE', 'REDUCE'].includes(operation)) {
    const cur = c?.budget; const body = `<p>${E(M.args.name)}</p><p class="opx-note">الميزانية الحالية: <b>${cur != null ? egp(cur) : 'غير معروفة'}</b>. اكتب الميزانية اليومية الجديدة (الأساس، مش نسبة).</p><label class="opx-field"><span>الميزانية الجديدة (جنيه)</span><input class="opx-input" id="mnTo" inputmode="numeric" placeholder="مثال: ${cur ? Math.round(cur * (operation === 'INCREASE' ? 1.2 : 0.8)) : 300}"></label><button class="opx-btn primary" id="mnPre">معاينة</button>`;
    openDrawer({ title: `${OPS[operation][0]} — معاينة`, body }); $('mnPre').onclick = () => preflight({ toBudget: Number($('mnTo').value) }); return;
  }
  openDrawer({ title: `${OPS[operation][0]} — معاينة`, body: stageBar(0) + skeletonRows(3) }); await preflight({});
}
async function preflight(extra) {
  const a = M.args; M.args = { ...a, ...extra };
  openDrawer({ title: `${OPS[a.operation][0]} — معاينة`, body: stageBar(1) + skeletonRows(3) });
  try { M.pre = await api.post('/api/operator/manual/preflight', { campaignId: a.campaignId, operation: a.operation, toBudget: extra.toBudget ?? null }); } catch (e) { openDrawer({ title: 'تعذّرت المعاينة', body: `<div class="opx-note bad">⚠️ ${E(e.message)}</div><p class="opx-note">مفيش أي تنفيذ حصل.</p>` }); return; }
  showPre();
}
function showPre() {
  const p = M.pre; const ack = p.requiresAck || [];
  const why = p.executeBlockedBy ? `<div class="opx-notice red"><div class="grow"><b>التنفيذ ممنوع الآن: ${E(p.executeBlockedBy.message)}</b><small>الكود: ${E(p.executeBlockedBy.code)}${p.executeBlockedBy.code === 'PERMISSION_OFF' ? ' — الخطوة المطلوبة: فعّل صلاحية العملية من «صلاحيات التنفيذ» (ADMIN + تأكيد).' : p.executeBlockedBy.code === 'META_WRITES_LOCKED' ? ' — قفل كتابة Meta بيتفتح بقرار نشر صريح فقط.' : p.executeBlockedBy.code === 'EMERGENCY_STOP' ? ' — ألغِ إيقاف الطوارئ الأول.' : ''}</small></div></div>` : '';
  const rows = [['الحملة', E(p.name || p.campaignId)], ['المنتج', E(p.identity?.productName || 'غير مربوط')], ['الحالة الحالية على Meta', `${E(p.current.status)}${p.current.budget != null ? ` · ${egp(p.current.budget)}` : ''}`], ['بعد التنفيذ', `<b>${E(p.proposed.status)}${p.proposed.budget != null ? ` · ${egp(p.proposed.budget)}` : ''}</b>`], ['التغيير المتوقع في Meta', E(p.expectedMetaChange)], ['أثر الصرف اليومي', p.exposureDelta == null ? '—' : `${p.exposureDelta > 0 ? '+' : ''}${egp(p.exposureDelta)}`], ['وضع النظام', E(p.mode) + (p.simulation ? ' (محاكاة)' : '')]];
  const body = `${stageBar(2)}<table class="opx-table"><tbody>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</tbody></table>
    ${p.blockers.map((b) => `<div class="opx-note bad">⛔ ${E(b.message)}</div>`).join('')}${why}
    ${p.warnings.map((w) => `<label class="opx-note" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-ack="${E(w.code)}"> ⚠️ ${E(w.message)} <b>(لازم تؤكد)</b></label>`).join('')}
    <p class="opx-note">${E(p.note)} — المعاينة صالحة لحد ${E(new Date(p.expiresAt).toLocaleTimeString('ar-EG'))}.</p>
    <div style="display:flex;gap:8px"><button class="opx-btn primary" id="mnGo" ${p.canExecute ? '' : 'disabled'} title="${p.canExecute ? '' : E(p.executeBlockedBy?.message || '')}">${p.simulation ? 'تسجيل محاكاة' : 'تنفيذ فعلي على Meta'}</button><button class="opx-btn ghost" id="mnNo">إلغاء</button></div>`;
  openDrawer({ title: `${p.label} — ${E(p.name || p.campaignId)}`, body });
  const go = $('mnGo'); const need = () => ack.every((c) => document.querySelector(`[data-ack="${c}"]`)?.checked); const sync = () => { if (go && p.canExecute) go.disabled = !need(); }; document.querySelectorAll('[data-ack]').forEach((c) => { c.onchange = sync; }); sync();
  $('mnNo').onclick = () => { closeDrawer(); toast('اتلغت — مفيش أي تنفيذ'); };
  if (go) go.onclick = () => execute(p);
}
async function execute(p) {
  const acks = [...document.querySelectorAll('[data-ack]:checked')].map((c) => c.dataset.ack);
  if (!(await confirmModal({ title: p.simulation ? 'تسجيل محاكاة' : 'تأكيد التنفيذ على Meta', message: `${p.label}: ${p.name || p.campaignId}\nمن ${p.current.status}${p.current.budget != null ? ' / ' + p.current.budget : ''}  ←  ${p.proposed.status}${p.proposed.budget != null ? ' / ' + p.proposed.budget : ''}\n${p.simulation ? 'مفيش كتابة على Meta (SHADOW).' : 'هيتبعت طلب واحد لـMeta وبعده قراءة مستقلة للتأكد.'}`, confirmLabel: p.simulation ? 'سجّل' : 'نفّذ', danger: !p.simulation }))) return;
  openDrawer({ title: p.label, body: stageBar(3) + skeletonRows(2) });
  try {
    const r = await api.post('/api/operator/manual/execute', { campaignId: p.campaignId, entityId: p.entityId, level: p.level, operation: p.operation, confirm: { ...p.confirm, ack: acks } });
    const f = FINAL_TONE[r.status] || ['gray', r.status]; const done = r.simulated ? 5 : r.verified ? 5 : 4;
    openDrawer({ title: 'النتيجة', body: `${stageBar(done)}<div class="opx-notice ${f[0] === 'green' ? 'green' : f[0] === 'red' ? 'red' : 'amber'}"><div class="grow"><b>${E(f[1])}</b><small>${E(r.message || '')}</small></div></div><p class="opx-note">اتسجّلت في «سجل التنفيذ» كعملية يدوية${r.verified ? ' ومتأكدة بقراءة Meta' : ''}.</p><button class="opx-btn" id="mnHist">افتح سجل التنفيذ</button>` });
    $('mnHist').onclick = () => { closeDrawer(); window.dispatchEvent(new CustomEvent('opx:open', { detail: 'history' })); };
    toast(r.verified ? 'اتنفذ واتأكد من Meta' : r.simulated ? 'اتسجّلت محاكاة' : 'راجع النتيجة', r.verified || r.simulated ? undefined : 'warning'); await load();
  } catch (e) { openDrawer({ title: 'ما اتنفذش', body: `${stageBar(2)}<div class="opx-notice red"><div class="grow"><b>${E(e.message)}</b><small>${E(e.code || '')} — مفيش أي حاجة اتبعتت لـMeta${e.code === 'STATE_CHANGED' ? '. الحالة اتغيّرت من وقت المعاينة، اعمل معاينة جديدة.' : ''}.</small></div></div>` }); }
}
