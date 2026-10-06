// ai-operator.js — "🤖 AI Operator / التحكم الذكي في الحملات", a section INSIDE AI Media Buyer.
// Pure presentation over /api/operator/*. Every rule (guards, modes, Emergency Stop, approvals, precedence, Autopilot gate) lives on the server — this
// file never decides anything and never talks to Meta. Shadow is the default; a decision is only executed through the existing executor after the server
// re-validates it. Setup/ops screens live in ai-operator-setup.js, shared helpers in ai-operator-core.js.
import * as UI from './ui-common.js';
import { api } from './api-client.js';
import { E, $, num, egp, ago, dt, S, MODES, ACTION_ICON, STATUS_CLS, CONF_AR, PROFIT_AR, openDrawer, closeDrawer, drawerHead, kpi, fld, condText, blockPanel, wireSetupButtons } from './ai-operator-core.js';
import { handleSetupAction, showProfile, showGate, showEvents, drawControl, drawReadiness, drawMapping, drawExcluded, drawHistory, drawPerformance } from './ai-operator-setup.js';

const TABS = [
  { key: 'control', label: '🧭 مركز التحكم' }, { key: 'today', label: '📋 قرارات اليوم' }, { key: 'open', label: '▶️ جاهزة للفتح' }, { key: 'pause', label: '⏸️ مقترحة للإيقاف' }, { key: 'scale', label: '📈 فرص التوسع' },
  { key: 'excluded', label: '🚫 المستثناة' }, { key: 'rules', label: '⚙️ القواعد' }, { key: 'mapping', label: '🔗 ربط الحملات' }, { key: 'readiness', label: '🟢 جاهزية المنتجات' }, { key: 'history', label: '📜 سجل التنفيذ' }, { key: 'performance', label: '📊 أداء AI Operator' },
];
const DECISION_TABS = ['today', 'open', 'pause', 'scale'];

export function stopOperatorPolling() { if (S.poll) { clearInterval(S.poll); S.poll = null; } }

export async function renderOperator(panel, { isAdmin = false } = {}) {
  S.panel = panel; S.isAdmin = isAdmin;
  panel.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  await refreshTop();
  draw();
  stopOperatorPolling();
  S.poll = setInterval(async () => {
    if (!document.body.contains(panel)) return stopOperatorPolling();
    if (S.busy || S.evaluating || $('ambDrawerOverlay')?.classList.contains('open')) return;
    try { await refreshTop(); drawTop(); if (DECISION_TABS.includes(S.tab)) await drawBody(); } catch { /* keep last view */ }
  }, 60_000);
}

async function refreshTop() {
  const [ov, cfg] = await Promise.all([api.get('/api/operator/overview'), api.get('/api/operator/config')]);
  S.ov = ov; S.cfg = cfg;
}

S.hooks = { refreshTop, drawTop: () => drawTop(), reloadBody: () => drawBody(), setupAction: handleSetupAction, switchTab: (tab, o = {}) => switchTab(tab, o), emergencyStop: () => emergencyStop(), ruleForm: (r) => ruleForm(r) };

function switchTab(tab, { campaignId = null } = {}) {
  closeDrawer(); S.tab = tab; S.mapFocus = campaignId;
  S.panel.querySelectorAll('[data-opt]').forEach((x) => x.classList.toggle('active', x.dataset.opt === tab));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  return drawBody();
}

function draw() {
  S.panel.innerHTML = `<div id="opTop"></div><div class="op-tabs" id="opTabs">${TABS.map((t) => `<button class="amb-fbtn ${t.key === S.tab ? 'active' : ''}" data-opt="${t.key}">${E(t.label)}</button>`).join('')}</div><div id="opBody"></div>`;
  S.panel.querySelectorAll('[data-opt]').forEach((b) => { b.onclick = () => switchTab(b.dataset.opt); });
  drawTop();
  drawBody();
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// top: mode + emergency stop + KPIs
// ---------------------------------------------------------------------------------------------------------------------------------------------
function drawTop() {
  const { ov } = S;
  const k = ov.kpis, stop = ov.emergencyStop;
  const mode = MODES.find((m) => m.key === ov.mode);
  $('opTop').innerHTML = `
    ${stop ? `<div class="op-banner red">🛑 <b>إيقاف الطوارئ مفعّل</b> — ${E(ov.emergencyReason || '')} (${ago(ov.emergencyAt)}). مفيش أي فتح/إيقاف/تغيير ميزانية على Meta. المراقبة والتحليل شغالين. ${S.isAdmin ? '<button class="amb-btn" id="opResume">إلغاء الإيقاف</button>' : ''}</div>` : ''}
    ${ov.mode === 'SHADOW' ? '<div class="op-banner blue">👻 <b>وضع Shadow</b> — بيسجّل اللي كان هيعمله ولماذا، ومفيش أي تنفيذ على Meta. راجع تقرير Shadow وجاهزية المنتجات قبل ما تنقل لـ"بموافقتي".</div>' : ''}
    ${ov.mode === 'AUTOPILOT' && !stop ? '<div class="op-banner amber">🤖 <b>Autopilot شغال</b> — بينفّذ فقط القواعد المعلّمة Autopilot، بأكشنز مسموحة وبعد كل حواجز الأمان.</div>' : ''}
    ${ov.writesLocked ? '<div class="op-banner amber">🔒 <b>كتابة AI Operator على Meta مقفولة على مستوى النشر</b> — حتى لو اخترت "بموافقتي" أو Autopilot مفيش تنفيذ. بتتفتح بقرار نشر صريح منك بعد مراجعة Shadow.</div>' : ''}
    ${!ov.connected ? '<div class="op-banner amber">⚠️ مفيش اتصال Meta Ads — اربط الحساب من AI Intelligence.</div>' : ''}
    ${controlStrip(ov.control)}
    <div class="op-controlbar">
      <div class="op-modes" role="group" aria-label="وضع التشغيل">
        ${MODES.map((m) => `<button class="op-mode ${m.key === ov.mode ? 'on' : ''} ${m.key === 'AUTOPILOT' ? 'auto' : ''}" data-mode="${m.key}" title="${E(m.hint)}" ${S.isAdmin ? '' : 'disabled'}>${E(m.label)}</button>`).join('')}
        <div class="op-mode-hint">${E(mode?.hint || '')}</div>
      </div>
      <div class="op-actions">
        ${S.isAdmin ? '<button class="amb-btn" id="opEval" title="تقييم القواعد المفعّلة دلوقتي وتسجيل القرارات (مفيش تنفيذ في Shadow/بموافقتي)">🔄 قيّم الآن</button>' : ''}
        <button class="op-stop" id="opStop" ${stop ? 'disabled' : ''}>🛑 إيقاف فوري</button>
      </div>
    </div>
    <div class="amb-kpis op-kpis">
      ${kpi('حملات تحت المراقبة', k.monitored, 'blue')}${kpi('جاهزة للفتح', k.readyToOpen, 'green')}${kpi('مقترح إيقافها', k.proposedPause, 'amber')}${kpi('فرص توسع', k.scaleOpportunities, 'purple')}
      ${kpi('مستبعدة/محمية', k.excluded, 'gray')}${kpi('ممنوعة بحاجز أمان', k.blockedBySafety, 'red', `منها جودة بيانات: ${num(k.blockedByDataQuality)}`)}${kpi('أكشنز اليوم', k.actionsToday, 'green', `تقييمات: ${num(k.evaluationsToday)}`)}
    </div>
    <div class="op-sub">القواعد: ${num(ov.rules.enabled)} مفعّلة من ${num(ov.rules.total)} (${num(ov.rules.autopilot)} Autopilot) · الاستثناءات: ${num(ov.exceptions)} · آخر تشغيل مجدول: ${E(ov.scheduler?.lastRun ? ago(ov.scheduler.lastRun.at) : 'لسه')}</div>`;
  $('opTop').querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => changeMode(b.dataset.mode); });
  $('opTop').querySelectorAll('[data-auto]').forEach((b) => { b.onclick = () => toggleAuto(b.dataset.auto, b.dataset.on !== '1'); });
  $('opStop').onclick = emergencyStop;
  if ($('opResume')) $('opResume').onclick = resumeFromStop;
  if ($('opEval')) $('opEval').onclick = evaluateNow;
}

// Global control strip: the mode (MANUAL / SHADOW / APPROVAL / AUTOPILOT) + what Autopilot is allowed to do. A toggle is a PERMISSION only — nothing executes unless the mode is AUTOPILOT,
// Emergency Stop is off and the deployment write-lock is open (the strip says so).
function controlStrip(c) {
  if (!c) return '';
  const cls = c.emergencyStop ? 'red' : c.mode === 'AUTOPILOT' ? 'green' : c.mode === 'APPROVAL' ? 'amber' : c.mode === 'SHADOW' ? 'blue' : 'red';
  const chips = c.toggles.map((t) => `<button class="op-chip ${t.on ? 'on' : 'off'}" data-auto="${E(t.key)}" data-on="${t.on ? 1 : 0}" title="${E(t.label_ar)} — ${t.on ? 'مسموح (لو الوضع Autopilot)' : 'مقفول'}" ${S.isAdmin ? '' : 'disabled'}>${E(t.short)} ${t.on ? '✓' : '✗'}</button>`).join('');
  const note = c.emergencyStop ? 'إيقاف الطوارئ فوق كل شيء.' : c.mode !== 'AUTOPILOT' ? 'الصلاحيات دي مبتشتغلش غير في Autopilot.' : c.writesLocked ? 'كتابة Meta مقفولة على مستوى النشر.' : '';
  return `<div class="op-strip ${cls}" id="opStrip"><b class="op-strip-mode">${c.icon} ${E(c.emergencyStop ? 'EMERGENCY STOP' : c.modeLabel)}${c.mode === 'OFF' ? ' MODE' : ''}</b><span class="op-strip-perms">${chips}</span><small>${E(note)}</small></div>`;
}
async function toggleAuto(key, on) {
  if (on && !(await UI.confirmModal({ title: 'تفعيل صلاحية تلقائية', message: `السماح لـ Autopilot بـ «${key}»؟ ده بيدّي صلاحية بس — مفيش تنفيذ لو الوضع مش Autopilot أو كتابة Meta مقفولة.`, confirmLabel: 'تفعيل' }))) return;
  try { await api.put('/api/operator/auto-actions', { [key]: on }); UI.toast('تم'); await refreshTop(); drawTop(); } catch (e) { UI.toast(e.message, 'error'); }
}
async function changeMode(mode) {
  if (mode === S.ov.mode) return;
  if (mode === 'AUTOPILOT') return showGate(); // Autopilot only through the activation gate (server enforces it too)
  if (!(await UI.confirmModal({ title: 'تغيير الوضع', message: `تغيير وضع AI Operator إلى «${MODES.find((m) => m.key === mode).label}»؟`, confirmLabel: 'تأكيد' }))) return;
  try { await api.put('/api/operator/mode', { mode }); UI.toast('تم تغيير الوضع'); await refreshTop(); drawTop(); drawBody(); } catch (e) { UI.toast(e.message, 'error'); }
}
async function emergencyStop() {
  if (!(await UI.confirmModal({ title: '🛑 إيقاف فوري', message: 'هيوقف أي فتح/إيقاف/تغيير ميزانية تلقائي أو بموافقة فورًا، فوق كل القواعد. المراقبة بتكمل. متأكد؟', confirmLabel: 'إيقاف فوري', danger: true }))) return;
  try { await api.post('/api/operator/emergency-stop', { reason: 'إيقاف يدوي من الواجهة' }); UI.toast('تم تفعيل الإيقاف الفوري'); await refreshTop(); drawTop(); drawBody(); } catch (e) { UI.toast(e.message, 'error'); }
}
async function resumeFromStop() {
  if (!(await UI.confirmModal({ title: 'إلغاء إيقاف الطوارئ', message: 'التنفيذ هيرجع حسب الوضع الحالي والقواعد. متأكد؟', confirmLabel: 'إلغاء الإيقاف' }))) return;
  try { await api.delete('/api/operator/emergency-stop'); UI.toast('تم إلغاء الإيقاف'); await refreshTop(); drawTop(); drawBody(); } catch (e) { UI.toast(e.message, 'error'); }
}
async function evaluateNow() {
  S.evaluating = true; const btn = $('opEval'); btn.disabled = true; btn.textContent = '⏳ بيقيّم… (حتى 40 ثانية)';
  try { const r = await api.post('/api/operator/evaluate', { persist: true, refresh: true }); UI.toast(`تم: ${num(r.campaignsEvaluated)} حملة · ${num(r.candidates.length)} قرار مرشّح${r.autoExecuted ? ` · نُفّذ تلقائيًا ${r.autoExecuted}` : ''}`); await refreshTop(); drawTop(); await drawBody(); }
  catch (e) { UI.toast(e.message, 'error'); } finally { S.evaluating = false; }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// body dispatch
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function drawBody() {
  const body = $('opBody'); if (!body) return;
  S.busy = true;
  try {
    if (DECISION_TABS.includes(S.tab)) await drawDecisions(body);
    else if (S.tab === 'control') await drawControl(body);
    else if (S.tab === 'excluded') await drawExcluded(body);
    else if (S.tab === 'rules') await drawRules(body);
    else if (S.tab === 'mapping') await drawMapping(body);
    else if (S.tab === 'readiness') await drawReadiness(body);
    else if (S.tab === 'history') await drawHistory(body);
    else if (S.tab === 'performance') await drawPerformance(body);
  } catch (e) { body.innerHTML = `<div class="amb-panel amb-empty">⚠️ ${E(e.message || e)}</div>`; } finally { S.busy = false; }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------------------------------------------------------------------------
const decisionCache = new Map();
const selected = new Set();
const isBulkable = (d) => S.isAdmin && d.status === 'PREPARED' && ['PAUSE', 'SCALE_DOWN'].includes(d.action) && !d.blocks.some((b) => b.severity === 'BLOCK');

async function drawDecisions(body) {
  body.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  const r = await api.get('/api/operator/decisions', { bucket: S.tab, limit: 150 });
  const rows = r.decisions || [];
  decisionCache.clear(); rows.forEach((d) => decisionCache.set(d.id, d)); selected.clear();
  if (!rows.length) {
    const hint = S.tab === 'today' ? (S.ov.rules.enabled ? 'مفيش قرارات حاليًا. اضغط «قيّم الآن» لتسجيل التقييم، أو جرّب "🔮 لو شغلت الأوتوميشن دلوقتي؟" من مركز التحكم.' : 'مفيش قواعد مفعّلة. افتح «القواعد» وابدأ من قالب (بيبدأ Shadow) وفعّله.') : 'مفيش حاجة هنا دلوقتي.';
    body.innerHTML = `<div class="amb-panel amb-empty">${E(hint)}</div>`; return;
  }
  const anyBulk = rows.some(isBulkable);
  body.innerHTML = `${anyBulk ? '<div class="op-bulkbar"><span id="opBulkInfo">اختار قرارات متجانسة (نفس القاعدة ونفس الأكشن) للموافقة الجماعية</span> <button class="amb-btn warning" id="opBulk" disabled>موافقة جماعية</button></div>' : ''}
    <div class="table-wrap op-table-wrap"><table class="data op-table">
    <thead><tr>${anyBulk ? '<th></th>' : ''}<th>المتجر</th><th>المنتج / الحملة</th><th>الحالة</th><th>الصرف</th><th>أوردرات</th><th>CPA</th><th>Target</th><th>Hard Stop</th><th>المخزون</th><th>الربحية</th><th>جودة البيانات</th><th>القاعدة</th><th>القرار</th><th>الثقة</th><th>السبب</th><th></th></tr></thead>
    <tbody>${rows.map((d) => row(d, anyBulk)).join('')}</tbody></table></div>`;
  body.querySelectorAll('[data-d]').forEach((b) => { b.onclick = () => decisionAction(Number(b.dataset.id), b.dataset.d); });
  body.querySelectorAll('[data-sel]').forEach((c) => { c.onchange = () => { const id = Number(c.dataset.sel); if (c.checked) selected.add(id); else selected.delete(id); updateBulk(); }; });
  if ($('opBulk')) $('opBulk').onclick = bulkApproveFlow;
  wireSetupButtons(body);
}
function updateBulk() { const b = $('opBulk'); if (!b) return; b.disabled = selected.size === 0; $('opBulkInfo').textContent = selected.size ? `${selected.size} قرار مختار` : 'اختار قرارات متجانسة (نفس القاعدة ونفس الأكشن) للموافقة الجماعية'; }

function row(d, anyBulk) {
  const m = d.todayMetrics || d.metrics || {}, ec = d.economics || {}, st = d.stock, dq = d.dataQuality;
  const blocked = d.status === 'BLOCKED' || (d.unblock && d.unblock.blocked);
  const stockTxt = !st ? '—' : st.status === 'STOCK_UNKNOWN' ? '<span class="op-unk">غير مسجّل</span>' : `${num(st.current)}${st.daysRemaining != null ? ` <small>(${num(st.daysRemaining, 1)} يوم)</small>` : ''}`;
  const dqTxt = !dq ? '<span class="op-unk">غير معروف</span>' : dq.gate === 'DECISION_BLOCKED_DATA_QUALITY' ? '<span class="op-bad">⚠️ متوقف</span>' : E(dq.overall || dq.gate || '—');
  const canAct = S.isAdmin && d.status === 'PREPARED';
  const bc = d.canonical?.budgetChange;
  return `<tr class="op-row ${blocked ? 'blocked' : ''}">
    ${anyBulk ? `<td>${isBulkable(d) ? `<input type="checkbox" data-sel="${d.id}" />` : ''}</td>` : ''}
    <td>${E(d.store || '—')}</td>
    <td><div class="op-prod">${E(d.productName || '— غير مربوط —')}</div><div class="op-camp" title="${E(d.campaignId)}">${E(d.campaignName || d.campaignId)}</div></td>
    <td><span class="op-pill ${STATUS_CLS[d.status] || 'gray'}">${E(d.lifecycleLabel || d.statusLabel)}</span></td>
    <td>${egp(m.spend)}</td><td>${m.purchases == null ? '—' : num(m.purchases)}</td><td>${m.cpa == null ? '—' : egp(m.cpa)}</td>
    <td>${ec.targetCpa == null ? '<span class="op-unk">—</span>' : egp(ec.targetCpa)}</td><td>${ec.hardStopCpa == null ? '<span class="op-unk">—</span>' : egp(ec.hardStopCpa)}</td>
    <td>${stockTxt}</td><td>${ec.complete ? E(PROFIT_AR[ec.profitState] || ec.profitState) : '<span class="op-unk">UNKNOWN</span>'}</td><td>${dqTxt}</td>
    <td>${E(d.ruleName || '—')}${d.ruleVersion ? ` <small>v${d.ruleVersion}</small>` : ''}</td>
    <td><b>${ACTION_ICON[d.action] || ''} ${E(d.actionLabel)}</b>${bc ? `<div class="op-money">${num(bc.from)} ← ${num(bc.to)} ج.م <b>${bc.pct > 0 ? '+' : ''}${bc.pct}%</b></div>` : ''}</td>
    <td><span class="op-conf ${d.confidence}">${E(CONF_AR[d.confidence] || d.confidence)}</span></td>
    <td class="op-why">${blocked ? blockPanel(d, { compact: true }) : E(d.why?.why || '')}${d.warnings?.length ? `<div class="op-camp">⚠️ ${E(d.warnings[0].message)}</div>` : ''}</td>
    <td class="op-btns">
      ${canAct ? `<button class="amb-btn success sm" data-d="review" data-id="${d.id}">مراجعة وموافقة</button><button class="amb-btn danger sm" data-d="reject" data-id="${d.id}">رفض</button>` : ''}
      <button class="amb-btn sm" data-d="details" data-id="${d.id}">عرض التفاصيل</button>
      ${S.isAdmin && ['PREPARED', 'SHADOW', 'BLOCKED'].includes(d.status) ? `<button class="amb-btn sm" data-d="exempt" data-id="${d.id}">استثناء</button><button class="amb-btn sm" data-d="snooze" data-id="${d.id}">تأجيل</button>` : ''}
    </td></tr>`;
}

async function decisionAction(id, act) {
  const d = decisionCache.get(id);
  try {
    if (act === 'details') return showDecision(d, { approval: false });
    if (act === 'review') return showDecision(d, { approval: true });
    if (act === 'exempt') return showExemptForm(d);
    if (act === 'reject') return rejectFlow(d);
    if (act === 'snooze') { await api.post(`/api/operator/decisions/${id}/snooze`, { hours: 24 }); UI.toast('اتأجل 24 ساعة'); }
    await refreshTop(); drawTop(); await drawBody();
  } catch (e) { UI.toast(e.message, 'error'); }
}
async function rejectFlow(d, reason = null) {
  try { await api.post(`/api/operator/decisions/${d.id}/reject`, { reason }); UI.toast('تم الرفض (القرار مش بيتحسب حكم على الاستراتيجية)'); closeDrawer(); await refreshTop(); drawTop(); await drawBody(); } catch (e) { UI.toast(e.message, 'error'); }
}

/** Approval modal (spec 88) / read-only details: current → proposed, why, rule (+version), evidence, guards, risks, next monitoring step. */
async function showDecision(d, { approval }) {
  const c = d.canonical, w = d.why || {};
  const list = (arr) => (arr && arr.length ? `<ul class="op-ul">${arr.map((x) => `<li>${E(x)}</li>`).join('')}</ul>` : '<div class="op-unk">—</div>');
  const guards = (d.blocks || []).map((b) => `<li class="${b.severity === 'BLOCK' ? 'op-bad' : ''}"><b>${E(b.severity)}</b> · ${E(b.message)}${b.detail ? ` (${E(b.detail)})` : ''} <code class="op-code">${E((b.specCodes || []).join(' · '))}</code></li>`).join('');
  const bc = c.budgetChange;
  const adv = d.advisor;
  openDrawer(`${drawerHead(`${ACTION_ICON[d.action] || ''} ${E(d.actionLabel)} — ${E(d.campaignName || d.campaignId)}`)}
    <div class="amb-drawer-body op-details">
      ${blockPanel(d)}
      <div class="op-block"><h4>الحالة الحالية ← المقترحة</h4><div class="op-states"><div><small>الآن</small><b>${E(c.previousMetaState.status || '—')}${c.previousMetaState.budget != null ? ` · ${num(c.previousMetaState.budget)} ج.م` : ''}</b></div><span>←</span><div><small>بعد التنفيذ</small><b>${E(c.proposedMetaState.status || '—')}${c.proposedMetaState.budget != null ? ` · ${num(c.proposedMetaState.budget)} ج.م` : ''}</b></div></div>
        ${bc ? `<div class="op-money big">${num(bc.from)} ← ${num(bc.to)} ج.م (${bc.pct > 0 ? '+' : ''}${bc.pct}% · ${bc.delta > 0 ? '+' : ''}${num(bc.delta)} ج.م)</div>` : ''}</div>
      <div class="op-block"><h4>ماذا ولماذا؟</h4><p>${E(w.what || '')}</p><p>${E(w.why || '')}</p></div>
      <div class="op-block"><h4>القاعدة</h4><p>${E(d.ruleName || '—')}${d.ruleVersion ? ` — الإصدار <b>v${d.ruleVersion}</b>` : ''} · ${E(c.category === 'HARD_SAFETY' ? 'قاعدة أمان' : 'قاعدة تحسين')} · الوضع: ${E(d.mode)}${d.ruleSnapshot ? `<div class="op-conds">${condText(d.ruleSnapshot.conditions, S.cfg.meta.fields)}</div>` : ''}</p></div>
      <div class="op-block"><h4>الأدلة (نافذة: ${E(S.cfg.meta.windowLabels[d.window] || d.window || '—')} · ثقة: ${E(CONF_AR[d.confidence] || d.confidence)})</h4>${list(w.basedOn)}</div>
      <div class="op-block"><h4>الحواجز</h4>${guards ? `<ul class="op-ul">${guards}</ul>` : '<div class="op-ok">كل الحواجز مرّت.</div>'}${d.error ? `<div class="op-bad">${E(d.error)}</div>` : ''}</div>
      <div class="op-block"><h4>المخاطر</h4>${list(w.risks)}</div>
      <div class="op-block"><h4>الخطوة الجاية في المراقبة</h4><p>${E(w.afterExecution || '')} بعد التنفيذ: قراءة Meta للتأكد (مش بنقول "تم التنفيذ" قبلها) ثم قياس الأثر بعد عينة كافية${d.action === 'SCALE_UP' ? '، ولو الـCPA ساء بيتجهز رجوع لموافقتك' : ''}.</p></div>
      ${adv ? `<div class="op-block"><h4>🧠 المستشار الذكي</h4><p>مرحلة المنتج: <b>${E(adv.stage || '—')}</b> · المشكلة الأساسية: <b>${E(adv.primaryProblem || '—')}</b> · نسخة الخطة: v${E(adv.planVersion ?? '—')}.<br>${E(adv.primaryProblem && adv.primaryProblem !== 'NONE' && d.action === 'SCALE_UP' ? 'المستشار شايف إن فيه مشكلة لسه — التوسع بيتحوّل لموافقتك ومش بيتنفذ تلقائيًا (التعارض ظاهر، مش مخفي).' : 'الأكشن ده مش بيتعارض مع خطة المستشار الحالية.')}</p></div>` : ''}
      ${d.shadow ? `<div class="op-block"><h4>👻 نتيجة بأثر رجعي</h4><p>${E(d.shadow.hindsight?.note || '—')}${d.shadow.userDidSame?.done ? ' · وانت عملت نفس الأكشن بعدها.' : ''}</p></div>` : ''}
      <div class="op-block"><button class="amb-btn sm" id="opDEv">الخط الزمني للقرار</button> ${S.isAdmin && d.productId ? '<button class="amb-btn sm" id="opDProf">ملف أتمتة المنتج</button> <button class="amb-btn sm" id="opTag">🧪 وسم الحملة</button>' : ''}</div>
      ${approval ? `<div class="op-approvebar"><button class="amb-btn success" id="opAppr">✅ تأكيد وتنفيذ</button><button class="amb-btn danger" id="opRej">رفض</button><button class="amb-btn" id="opProt">🛡️ احمي الحملة</button>${d.ruleId ? '<button class="amb-btn" id="opEditRule">تعديل القاعدة</button>' : ''}<input id="opRejReason" class="op-search" placeholder="سبب الرفض (اختياري)" /></div><div class="op-sub">الرفض عملي مش حكم على الاستراتيجية — مبنتعلمش منه تلقائيًا.</div>` : ''}
    </div>`);
  wireSetupButtons($('ambDrawerPanel'));
  $('opDEv').onclick = () => showEvents(d.id);
  if ($('opDProf')) $('opDProf').onclick = () => showProfile(d.productId);
  if ($('opTag')) $('opTag').onclick = () => showTag(d);
  if (approval) {
    $('opAppr').onclick = async () => {
      if (!(await UI.confirmModal({ title: 'تأكيد التنفيذ', message: `${d.actionLabel} — ${d.campaignName || d.campaignId}${bc ? ` (${num(bc.from)} ← ${num(bc.to)} ج.م)` : ''}. السيستم هيعيد فحص كل الحواجز والأدلة قبل الكتابة على Meta، ولو أي حاجة اتغيّرت القرار هيتبطل. تنفّذ؟`, confirmLabel: 'تأكيد وتنفيذ', danger: d.action !== 'PAUSE' }))) return;
      try { const r = await api.post(`/api/operator/decisions/${d.id}/approve`, {}); UI.toast(r.message || 'تم', r.executed ? 'success' : 'error'); closeDrawer(); await refreshTop(); drawTop(); await drawBody(); } catch (e) { UI.toast(e.message, 'error'); }
    };
    $('opRej').onclick = () => rejectFlow(d, $('opRejReason').value.trim() || null);
    $('opProt').onclick = async () => { try { await api.post('/api/operator/exceptions', { scopeType: 'CAMPAIGN', scopeId: d.campaignId, scopeLabel: d.campaignName, types: ['NO_AUTOMATION'], reason: 'محمية من نافذة الموافقة' }); UI.toast('الحملة اتحمت من الأتمتة'); closeDrawer(); await refreshTop(); drawTop(); await drawBody(); } catch (e) { UI.toast(e.message, 'error'); } };
    if ($('opEditRule')) $('opEditRule').onclick = async () => { const rr = await api.get('/api/operator/rules'); const rule = rr.rules.find((x) => x.id === d.ruleId); if (rule) ruleForm(rule); };
  }
}

async function bulkApproveFlow() {
  const ids = [...selected]; const ds = ids.map((i) => decisionCache.get(i)).filter(Boolean);
  const rules = new Set(ds.map((d) => d.ruleId)), acts = new Set(ds.map((d) => d.action));
  if (rules.size > 1 || acts.size > 1) return UI.toast('الموافقة الجماعية بس لقرارات نفس القاعدة ونفس الأكشن.', 'error');
  openDrawer(`${drawerHead(`موافقة جماعية — ${E(ds[0].actionLabel)} (${ds.length})`)}<div class="amb-drawer-body op-details">
    <div class="op-banner amber">راجع كل حملة وأكّدها بنفسك. كل قرار بيتعاد فحصه ويتنفذ لوحده — مفيش موافقة عمياء. (لحد 10 قرارات، إيقاف/تقليل ميزانية بس)</div>
    <ul class="op-checklist">${ds.map((d) => `<li class="ok"><label class="op-check"><input type="checkbox" data-bk="${d.id}" checked /> <b>${E(d.campaignName || d.campaignId)}</b> <small>${E(d.productName || '')} — صرف ${egp((d.todayMetrics || d.metrics || {}).spend)} · أوردرات ${(d.todayMetrics || d.metrics || {}).purchases ?? '—'}${d.canonical.budgetChange ? ` · ${num(d.canonical.budgetChange.from)} ← ${num(d.canonical.budgetChange.to)}` : ''}</small></label></li>`).join('')}</ul>
    <button class="amb-btn success" id="opBkGo">تأكيد ${ds.length} حملة وتنفيذ</button><div id="opBkOut"></div></div>`);
  $('opBkGo').onclick = async () => {
    const confirmed = [...document.querySelectorAll('[data-bk]:checked')].map((x) => Number(x.dataset.bk));
    if (!confirmed.length) return UI.toast('اختار حملة واحدة على الأقل.');
    if (!(await UI.confirmModal({ title: 'تأكيد الموافقة الجماعية', message: `${confirmed.length} حملة هتتنفذ على Meta (كل واحدة بتتفحص لوحدها).`, confirmLabel: 'تنفيذ', danger: true }))) return;
    try { const r = await api.post('/api/operator/decisions/bulk-approve', { decisionIds: confirmed, confirmedIds: confirmed }); $('opBkOut').innerHTML = `<div class="op-sub">اتنفذ ${r.summary.executed} من ${r.summary.total}</div><ul class="op-ul">${r.results.map((x) => `<li class="${x.executed ? 'op-ok' : 'op-bad'}">${E(x.campaign || x.id)} — ${E(x.message || x.status)}</li>`).join('')}</ul>`; await refreshTop(); drawTop(); drawBody(); } catch (e) { UI.toast(e.message, 'error'); }
  };
}

function showTag(d) {
  openDrawer(`${drawerHead('🧪 وسم الحملة')}
    <div class="amb-drawer-body op-details"><div class="op-sub">${E(d.campaignName || d.campaignId)}. حملات TESTING محمية من الإيقاف الآلي العام ولها حدودها الخاصة.</div>
      <div class="op-form"><label>الوسم<select id="f_tag"><option value="">بدون وسم</option><option>TESTING</option><option>SCALE</option><option>RETARGET</option><option>PROTECTED</option></select></label>
      ${fld('حد الصرف للإيقاف (TESTING)', 'stopSpend', null)}${fld('أدنى عينة (أوردرات) للتوسع', 'minSample', null)}</div>
      <button class="amb-btn success" id="opSaveTag">حفظ</button></div>`);
  $('opSaveTag').onclick = async () => {
    const tag = $('f_tag').value || null; const n = (k) => { const v = $(`f_${k}`).value.trim(); return v === '' ? null : Number(v); };
    try { await api.put(`/api/operator/campaigns/${encodeURIComponent(d.campaignId)}/tag`, { tag, storeId: d.store, productId: d.productId, testing: tag === 'TESTING' ? { stopSpend: n('stopSpend'), minSample: n('minSample') } : null }); UI.toast('تم الحفظ'); closeDrawer(); } catch (e) { UI.toast(e.message, 'error'); }
  };
}

function showExemptForm(d) {
  openDrawer(`${drawerHead('🚫 استثناء')}
    <div class="amb-drawer-body op-details"><div class="op-sub">الاستثناء بيتغلب على أي قاعدة.</div>
      <div class="op-form"><label>النطاق<select id="x_scope"><option value="CAMPAIGN">الحملة دي (${E(d.campaignName || d.campaignId)})</option>${d.productId ? `<option value="PRODUCT">المنتج ده (${E(d.productName || d.productId)})</option>` : ''}<option value="STORE">المتجر (${E(d.store)})</option></select></label>
      <label>النوع<select id="x_type"><option value="NO_AUTO_STOP">NO AUTO STOP</option><option value="NO_AUTO_OPEN">NO AUTO OPEN</option><option value="NO_AUTO_SCALE">NO AUTO SCALE</option><option value="NO_BUDGET_CHANGE">NO BUDGET CHANGE</option><option value="NO_AUTOMATION">NO AUTOMATION</option></select></label>
      <label>المدة (ساعات — فاضي = دائم)<input id="x_ttl" type="number" min="1" /></label><label>السبب<input id="x_reason" /></label></div>
      <button class="amb-btn success" id="opSaveEx">حفظ الاستثناء</button></div>`);
  $('opSaveEx').onclick = async () => {
    const scope = $('x_scope').value; const scopeId = scope === 'CAMPAIGN' ? d.campaignId : scope === 'PRODUCT' ? String(d.productId) : d.store;
    const ttl = $('x_ttl').value.trim();
    try { await api.post('/api/operator/exceptions', { scopeType: scope, scopeId, scopeLabel: scope === 'CAMPAIGN' ? d.campaignName : scope === 'PRODUCT' ? d.productName : d.store, storeId: scope === 'STORE' ? d.store : null, types: [$('x_type').value], reason: $('x_reason').value.trim() || null, ttlHours: ttl ? Number(ttl) : null }); UI.toast('تم'); closeDrawer(); await refreshTop(); drawTop(); } catch (e) { UI.toast(e.message, 'error'); }
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// rules: templates, Arabic builder, versions, dry run
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function drawRules(body) {
  body.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  const [r, tp] = await Promise.all([api.get('/api/operator/rules'), api.get('/api/operator/templates')]);
  const fields = S.cfg.meta.fields;
  body.innerHTML = `
    ${r.conflicts.length ? `<div class="op-banner amber">⚠️ تعارضات بين القواعد: ${r.conflicts.map((c) => E(c.message)).join(' | ')}</div>` : ''}
    <div class="amb-panel"><h3>🧩 قوالب القواعد (قابلة للتعديل — مش استراتيجية مفروضة)</h3><div class="op-sub">القالب بيعمل مسودة متوقفة (Shadow أو بموافقتي) انت بتحدد أرقامها وبتراجعها قبل الحفظ.</div>
      <div class="op-templates">${tp.templates.map((t) => `<div class="op-tpl ${t.kind}"><div><b>${E(t.title)}</b> <span class="op-pill ${t.category === 'HARD_SAFETY' ? 'red' : 'blue'}">${t.category === 'HARD_SAFETY' ? 'أمان' : 'تحسين'}</span>${t.kind === 'GUARD' ? ' <span class="op-pill gray">مبني</span>' : ''}</div><div class="op-sub">${E(t.description)}</div>${t.kind === 'RULE' && S.isAdmin ? `<button class="amb-btn sm" data-tpl="${E(t.key)}">استخدم القالب</button>` : ''}</div>`).join('')}</div></div>
    <div class="amb-panel"><h3>🧾 قاعدة بالعربي (بتتحوّل لقاعدة منظمة وتتعرض للتأكيد — مش بتتنفذ مباشرة)</h3>
      <div class="op-nl"><input id="opNl" placeholder='مثال: اقفل الحملة لو صرفت 180 جنيه من غير أوردرات إلا حملات التيست' /><button class="amb-btn orange" id="opNlGo">حوّل</button></div><div id="opNlOut"></div></div>
    <div class="amb-panel"><h3>⚙️ القواعد (${r.rules.length})</h3>${r.rules.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>القاعدة</th><th>الأكشن</th><th>النافذة</th><th>الوضع</th><th>أولوية</th><th>تهدئة</th><th>الشروط</th><th>مفعّلة</th><th></th></tr></thead><tbody>
      ${r.rules.map((x) => `<tr><td><b>${E(x.name)}</b> <small>v${x.version}</small>${x.source === 'NL' ? ' <small>(من نص عربي)</small>' : x.source === 'TEMPLATE' ? ' <small>(قالب)</small>' : ''}</td><td>${ACTION_ICON[x.action] || ''} ${E(S.cfg.meta.actionLabels[x.action] || x.action)}</td><td>${E(S.cfg.meta.windowLabels[x.window] || x.window)}</td><td><span class="op-pill ${x.mode === 'AUTOPILOT' ? 'red' : x.mode === 'APPROVAL' ? 'amber' : 'blue'}">${E(x.mode)}</span></td><td>${x.priority}</td><td>${x.cooldown_hours}س</td><td class="op-conds">${condText(x.conditions, fields)}</td>
        <td>${S.isAdmin ? `<input type="checkbox" data-en="${x.id}" ${x.enabled ? 'checked' : ''} />` : (x.enabled ? '✓' : '—')}</td>
        <td class="op-btns"><button class="amb-btn sm" data-dry="${x.id}">▶ RUN DRY</button>${S.isAdmin ? `<button class="amb-btn sm" data-edit="${x.id}">تعديل</button><button class="amb-btn danger sm" data-del="${x.id}">حذف</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="amb-empty">مفيش قواعد لسه — ابدأ من قالب.</div>'}
      ${S.isAdmin ? '<div style="margin-top:12px"><button class="amb-btn success" id="opNewRule">+ قاعدة جديدة</button></div>' : ''}
      <div class="op-sub">تغيير أي شرط بيرفع رقم الإصدار — القرارات القديمة بتفضل مسجّلة بإصدارها (v1 مثلًا) ومعناها مش بيتغير.</div></div>
    <div id="opSimOut"></div>`;
  $('opNlGo').onclick = nlParse;
  if ($('opNewRule')) $('opNewRule').onclick = () => ruleForm(null);
  body.querySelectorAll('[data-tpl]').forEach((b) => { b.onclick = () => templateForm(tp.templates.find((t) => t.key === b.dataset.tpl)); });
  body.querySelectorAll('[data-en]').forEach((c) => { c.onchange = async () => { try { await api.post(`/api/operator/rules/${c.dataset.en}/enabled`, { enabled: c.checked }); UI.toast(c.checked ? 'اتفعّلت' : 'اتوقفت'); await refreshTop(); drawTop(); } catch (e) { c.checked = !c.checked; UI.toast(e.message || 'مش مسموح', 'error'); } }; });
  body.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => ruleForm(r.rules.find((x) => x.id === Number(b.dataset.edit))); });
  body.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { if (!(await UI.confirmModal({ title: 'حذف قاعدة', message: 'متأكد؟', confirmLabel: 'حذف', danger: true }))) return; await api.delete(`/api/operator/rules/${b.dataset.del}`); UI.toast('تم'); await refreshTop(); drawTop(); drawRules(body); }; });
  body.querySelectorAll('[data-dry]').forEach((b) => { b.onclick = () => dryRun(r.rules.find((x) => x.id === Number(b.dataset.dry))); });
}

function templateForm(t) {
  openDrawer(`${drawerHead(`🧩 ${E(t.title)}`)}<div class="amb-drawer-body op-details"><div class="op-sub">${E(t.description)}</div>
    <div class="op-form">${t.params.map((p) => `<label>${E(p.label)}<input id="tp_${E(p.key)}" type="number" value="${p.default}" min="${p.min ?? 0}" ${p.max ? `max="${p.max}"` : ''} step="any" /></label>`).join('')}</div>
    <div class="op-sub">الوضع الافتراضي: <b>${E(t.defaultMode)}</b> · هتتحفظ متوقفة.</div>
    <button class="amb-btn" id="tpPrev">معاينة القاعدة</button><div id="tpOut"></div></div>`);
  $('tpPrev').onclick = async () => {
    const params = {}; t.params.forEach((p) => { params[p.key] = Number($(`tp_${p.key}`).value); });
    try {
      const r = await api.post(`/api/operator/templates/${t.key}/instantiate`, { params });
      $('tpOut').innerHTML = `<div class="op-preview"><b>${E(r.rule.name)}</b><div class="op-conds">${condText(r.rule.conditions, S.cfg.meta.fields)}</div>${(r.validation.errors || []).map((e) => `<div class="op-bad">✗ ${E(e.message)}</div>`).join('')}${(r.validation.warnings || []).map((e) => `<div class="op-sub">⚠️ ${E(e.message)}</div>`).join('')}
        <button class="amb-btn" id="tpEdit">عدّل في المنشئ</button> <button class="amb-btn success" id="tpSave" ${r.validation.ok ? '' : 'disabled'}>احفظ كمسودة</button></div>`;
      $('tpEdit').onclick = () => ruleForm(r.rule);
      $('tpSave').onclick = async () => { try { await api.post('/api/operator/rules', { rule: r.rule }); UI.toast('اتحفظت كمسودة متوقفة'); closeDrawer(); await refreshTop(); drawTop(); drawRules($('opBody')); } catch (e) { UI.toast(e.message, 'error'); } };
    } catch (e) { UI.toast(e.message, 'error'); }
  };
}

async function nlParse() {
  const text = $('opNl').value.trim(); if (!text) return;
  const out = $('opNlOut'); out.innerHTML = '<div class="amb-loading">…</div>';
  try {
    const p = await api.post('/api/operator/rules/parse', { text });
    if (!p.ok) { out.innerHTML = `<div class="op-banner amber">مقدرتش أحوّل النص: ${E((p.notes || []).join(' '))}</div>`; return; }
    const v = p.validation;
    out.innerHTML = `<div class="op-preview"><b>الفهم:</b> ${ACTION_ICON[p.rule.action]} ${E(S.cfg.meta.actionLabels[p.rule.action])} · ${E(S.cfg.meta.windowLabels[p.rule.window])}<div class="op-conds">${condText(p.rule.conditions, S.cfg.meta.fields)}</div>
      ${(p.notes || []).map((n) => `<div class="op-sub">ℹ️ ${E(n)}</div>`).join('')}${(v.errors || []).map((e) => `<div class="op-bad">✗ ${E(e.message)}</div>`).join('')}${(v.warnings || []).map((e) => `<div class="op-sub">⚠️ ${E(e.message)}</div>`).join('')}
      <div class="op-sub">هتتحفظ <b>متوقفة</b> وبوضع <b>Shadow</b> — تفعّلها بنفسك بعد المراجعة.</div>
      ${S.isAdmin ? `<button class="amb-btn" id="opNlEdit">راجع/عدّل</button> <button class="amb-btn success" id="opNlSave" ${v.ok ? '' : 'disabled'}>أكّد واحفظ كمسودة</button>` : ''}</div>`;
    if ($('opNlEdit')) $('opNlEdit').onclick = () => ruleForm({ ...p.rule, name: p.rule.name || text.slice(0, 60), nl_text: text });
    if ($('opNlSave')) $('opNlSave').onclick = async () => { try { await api.post('/api/operator/rules', { rule: { ...p.rule, name: p.rule.name || text.slice(0, 60), nl_text: text, enabled: false, mode: 'SHADOW', source: 'NL' } }); UI.toast('اتحفظت كمسودة'); await refreshTop(); drawTop(); drawRules($('opBody')); } catch (e) { UI.toast(e.message, 'error'); } };
  } catch (e) { out.innerHTML = `<div class="op-bad">${E(e.message)}</div>`; }
}

function renderSim(out, title, r) {
  const s = r.summary;
  out.innerHTML = `<div class="amb-panel"><h3>🧪 ${E(title)} <small>(RUN DRY — مفيش أي كتابة)</small></h3>
    <div class="amb-kpis op-kpis">${kpi('اتقيّم', s.objectsEvaluated, 'blue')}${kpi('هيفتح', s.wouldOpen, 'green')}${kpi('هيقفل', s.wouldPause, 'amber')}${kpi('هيوسّع', s.wouldScale, 'purple')}${kpi('هيقلل', s.wouldReduce, 'amber')}${kpi('ممنوع', s.blocked, 'red')}${kpi('مستبعد', s.excluded, 'gray')}${kpi('بيانات ناقصة', s.unknown, 'red')}</div>
    ${r.candidates.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>الحملة</th><th>المنتج</th><th>النتيجة</th><th>السبب / المطلوب</th></tr></thead><tbody>${r.candidates.slice(0, 40).map((c) => `<tr><td>${E(c.campaign.name)}</td><td>${E(c.productName || '—')}</td><td><span class="op-pill ${c.wouldBe === 'BLOCKED' ? 'red' : 'blue'}">${c.wouldBe === 'BLOCKED' ? 'ممنوع' : 'هيتنفذ'}</span></td><td class="op-why">${c.wouldBe === 'BLOCKED' ? blockPanel({ actionLabel: c.actionLabel, unblock: c.canonical.unblock }, { compact: true }) : E(c.canonical.recommendedAction)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="amb-empty">القاعدة مش هتطلع أي قرار دلوقتي.</div>'}</div>`;
  wireSetupButtons(out);
}
async function dryRun(rule) {
  const out = $('opSimOut'); out.innerHTML = '<div class="amb-panel"><div class="amb-loading">▶ RUN DRY على بيانات حقيقية (قراءة فقط) — حتى 40 ثانية…</div></div>';
  try { renderSim(out, `RUN DRY — ${rule.name}`, await api.post(`/api/operator/rules/${rule.id}/dry-run`, {})); out.scrollIntoView({ behavior: 'smooth' }); } catch (e) { out.innerHTML = `<div class="amb-panel op-bad">${E(e.message)}</div>`; }
}
async function simulate(rule) {
  const out = $('opSimOut') || $('opBody'); out.innerHTML = '<div class="amb-panel"><div class="amb-loading">🧪 محاكاة على بيانات حقيقية (قراءة فقط) — حتى 40 ثانية…</div></div>';
  try { renderSim(out, `محاكاة — ${rule.name}`, await api.post('/api/operator/rules/simulate', { rule })); } catch (e) { out.innerHTML = `<div class="amb-panel op-bad">${E(e.message)}</div>`; }
}

function ruleForm(rule) {
  const meta = S.cfg.meta, fields = meta.fields;
  const r = rule || { name: '', action: 'PAUSE', window: 'today', mode: 'SHADOW', cooldown_hours: 24, priority: 100, action_params: {}, conditions: { all: [{ field: 'spend', op: '>=', value: 180 }, { field: 'purchases', op: '=', value: 0 }] }, enabled: false };
  const opts = (arr, sel, lab = (x) => x) => arr.map((x) => `<option value="${E(x)}" ${x === sel ? 'selected' : ''}>${E(lab(x))}</option>`).join('');
  const condRow = (c, i) => `<div class="op-cond" data-i="${i}"><select class="c-field">${Object.entries(fields).map(([k, f]) => `<option value="${k}" ${k === c.field ? 'selected' : ''}>${E(f.label)}</option>`).join('')}</select>
    <select class="c-op">${meta.opsFor[fields[c.field]?.type || 'number'].map((o) => `<option ${o === c.op ? 'selected' : ''}>${E(o)}</option>`).join('')}</select>
    <input class="c-val" value="${E(Array.isArray(c.value) ? c.value.join(',') : c.value && typeof c.value === 'object' ? `@${c.value.ref}` : c.value ?? '')}" placeholder="القيمة (أو @target_cpa / a,b للنطاق)" /><button class="amb-btn ghost" data-rm="${i}">✕</button></div>`;
  openDrawer(`${drawerHead(`${rule?.id ? 'تعديل قاعدة' : 'قاعدة جديدة'}${rule?.version ? ` <small>v${rule.version}</small>` : ''}`)}
    <div class="amb-drawer-body op-details"><div class="op-form">
      <label>الاسم<input id="r_name" value="${E(r.name)}" /></label>
      <label>الأكشن<select id="r_action">${opts(meta.actions, r.action, (x) => meta.actionLabels[x])}</select></label>
      <label>فترة التحليل<select id="r_window">${opts(meta.windows, r.window, (x) => meta.windowLabels[x])}</select></label>
      <label>وضع القاعدة<select id="r_mode">${opts(meta.ruleModes, r.mode)}</select></label>
      <label>فترة التهدئة (ساعة)<input id="r_cd" type="number" min="1" max="168" value="${r.cooldown_hours ?? 24}" /></label>
      <label>الأولوية (الأقل أولًا)<input id="r_pri" type="number" value="${r.priority ?? 100}" /></label>
      <label>نسبة تغيير الميزانية % (للتوسع/التقليل)<input id="r_pct" type="number" value="${r.action_params?.pct ?? ''}" /></label></div>
      <h4>الشروط (كلها لازم تتحقق)</h4><div id="r_conds">${(r.conditions.all || []).map(condRow).join('')}</div>
      <button class="amb-btn sm" id="r_add">+ شرط</button>
      <div id="r_msg"></div>
      <div style="margin-top:14px"><button class="amb-btn" id="r_validate">تحقق</button> <button class="amb-btn" id="r_sim">▶ RUN DRY</button> <button class="amb-btn success" id="r_save">حفظ</button></div></div>`);
  const conds = [...(r.conditions.all || [])];
  const redraw = () => { $('r_conds').innerHTML = conds.map(condRow).join(''); wire(); };
  const collect = () => {
    $('r_conds').querySelectorAll('.op-cond').forEach((el) => {
      const i = Number(el.dataset.i), f = el.querySelector('.c-field').value, op = el.querySelector('.c-op').value; const v = el.querySelector('.c-val').value.trim();
      let value; if (v.startsWith('@')) value = { ref: v.slice(1) }; else if (op === 'between') value = v.split(',').map(Number); else if (op === 'in') value = v.split(',').map((x) => x.trim()); else if (fields[f].type === 'number') value = v === '' ? null : Number(v); else value = v;
      conds[i] = { field: f, op, value };
    });
    const pct = $('r_pct').value.trim();
    return { ...(rule?.id ? { id: rule.id } : {}), name: $('r_name').value.trim(), action: $('r_action').value, window: $('r_window').value, mode: $('r_mode').value, cooldown_hours: Number($('r_cd').value), priority: Number($('r_pri').value), action_params: pct ? { pct: Number(pct) } : {}, conditions: { all: conds.filter(Boolean) }, enabled: rule?.enabled ?? false, source: rule?.source || 'BUILDER', nl_text: rule?.nl_text || null };
  };
  const wire = () => {
    $('r_conds').querySelectorAll('.c-field').forEach((s) => { s.onchange = () => { collect(); redraw(); }; });
    $('r_conds').querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { collect(); conds.splice(Number(b.dataset.rm), 1); redraw(); }; });
  };
  wire();
  const msg = (v) => { $('r_msg').innerHTML = `${(v.errors || []).map((e) => `<div class="op-bad">✗ ${E(e.message)}</div>`).join('')}${(v.warnings || []).map((e) => `<div class="op-sub">⚠️ ${E(e.message)}</div>`).join('')}${v.ok ? '<div class="op-ok">✓ القاعدة صالحة</div>' : ''}`; };
  $('r_add').onclick = () => { collect(); conds.push({ field: 'spend', op: '>=', value: 0 }); redraw(); };
  $('r_validate').onclick = async () => { const x = await api.post('/api/operator/rules/validate', { rule: collect() }); msg(x.validation); if (x.conflicts?.length) $('r_msg').innerHTML += `<div class="op-sub">⚠️ تعارض: ${x.conflicts.map((c) => E(c.message)).join(' | ')}</div>`; };
  $('r_sim').onclick = async () => { const body = collect(); const pre = await api.post('/api/operator/rules/validate', { rule: body }); if (!pre.validation.ok) return msg(pre.validation); closeDrawer(); S.tab = 'rules'; if (!$('opSimOut')) await switchTab('rules'); await simulate(body); };
  $('r_save').onclick = async () => {
    try {
      const body = collect();
      const pre = await api.post('/api/operator/rules/validate', { rule: body }); if (!pre.validation.ok) { msg(pre.validation); return; }
      if (body.mode === 'AUTOPILOT' && !(await UI.confirmModal({ title: 'قاعدة Autopilot', message: 'القاعدة دي هتنفّذ بدون موافقة لما الوضع العام Autopilot وكل الحواجز تعدي. متأكد؟', confirmLabel: 'احفظ', danger: true }))) return;
      if (rule?.id) await api.put(`/api/operator/rules/${rule.id}`, { rule: body }); else await api.post('/api/operator/rules', { rule: body });
      UI.toast('تم الحفظ'); closeDrawer(); await refreshTop(); drawTop(); drawRules($('opBody'));
    } catch (e) { UI.toast(e.message, 'error'); }
  };
}
