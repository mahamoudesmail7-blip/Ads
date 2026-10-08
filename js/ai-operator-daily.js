// ai-operator-daily.js — "📅 جدول التشغيل اليومي": the OPEN (00:00) / PAUSE (13:00) Africa/Cairo plans + the automatic popup.
// Pure presentation over /api/operator/daily-plan/*. Everything that matters (schedule, safety gates, versions, execution, Cairo day change) lives on the server.
// Ticking a checkbox only SELECTS (saved to the server). Only the approve button is the approval, and in SHADOW it executes a SIMULATION (no Meta write).
import * as UI from './ui-common.js';
import { api } from './api-client.js';
import { E, $, num, egp, ago, dt, S, openDrawer, closeDrawer, drawerHead } from './ai-operator-core.js';

const API = '/api/operator/daily-plan';
const TYPE_META = {
  OPEN: { icon: '▶️', title: 'خطة فتح الحملات', at: '12:00 صباحًا', approve: 'اعتماد ونشر خطة فتح 12 صباحًا', popupApprove: 'اعتماد وتنفيذ فتح الحملات المحددة', verb: 'فتح', empty: 'مفيش حملات متوقفة مرشحة للفتح.' },
  PAUSE: { icon: '⏸️', title: 'خطة إيقاف الحملات', at: '1:00 ظهرًا', approve: 'اعتماد خطة إيقاف 1 ظهرًا', popupApprove: 'اعتماد وتنفيذ إيقاف الحملات المحددة', verb: 'إيقاف', empty: 'مفيش حملات نشطة محتاجة إيقاف.' },
};
const ITEM_PILL = { PENDING: 'gray', REVALIDATING: 'blue', SENT: 'amber', VERIFIED: 'green', FAILED: 'red', SKIPPED: 'gray', BLOCKED: 'red', SIMULATED: 'blue', UNCERTAIN: 'amber' };
const ITEM_AR = { PENDING: 'في الانتظار', REVALIDATING: 'جارِ التحقق', SENT: 'اتبعت لـMeta', VERIFIED: 'اتأكد من Meta', FAILED: 'فشل', SKIPPED: 'اتخطّت', BLOCKED: 'ممنوعة', SIMULATED: 'محاكاة (SHADOW)', UNCERTAIN: 'غير مؤكد' };
const PLAN_AR = { PREPARED: 'جاهزة للمراجعة', APPROVED: 'معتمدة', RUNNING: 'قيد التنفيذ', COMPLETED: 'انتهت', CANCELLED: 'ملغية', SUPERSEDED: 'نسخة قديمة', MISSED: 'فاتت' };
const PLAN_CLS = { PREPARED: 'amber', APPROVED: 'blue', RUNNING: 'blue', COMPLETED: 'green', CANCELLED: 'gray', SUPERSEDED: 'gray', MISSED: 'red' };
const RISK_CLS = { HIGH: 'red', MEDIUM: 'amber', LOW: 'green' }; const RISK_AR = { HIGH: 'مرتفعة', MEDIUM: 'متوسطة', LOW: 'منخفضة' };
const STOCK_AR = { IN_STOCK: 'متاح', LOW_STOCK: 'قليل', OUT_OF_STOCK: 'نافد ⛔', STOCK_UNKNOWN: 'غير معروف ⚠️' };
const ELIG_AR = { ELIGIBLE: '', PROTECTED: 'محمية', BLOCKED: 'ممنوعة', NEEDS_SPECIAL_APPROVAL: 'موافقة خاصة' };
const BLOCK_AR = { MAPPING_UNMAPPED: 'غير مربوطة بمنتج', MAPPING_CONFLICT: 'ربط متعارض', EXTERNAL_STORE: 'متجر خارجي', STOCK_OUT: 'المخزون صفر', STALE_DATA: 'بيانات قديمة', UNKNOWN_STOP_REASON: 'اتوقفت لسبب غير معروف — محتاجة موافقة خاصة', EXCEPTION_NO_AUTOMATION: 'مستثناة', EXCEPTION_NO_AUTO_OPEN: 'مستثناة من الفتح', EXCEPTION_NO_AUTO_STOP: 'مستثناة من الإيقاف', WINNER_PROTECTED: 'Winner محمي' };

const D = { ov: null, pollRun: null, hiddenRows: {}, showAll: {}, saving: new Map(), seenPopup: new Set(), popupBusy: false, popupTimer: null, isAdmin: false, onOpenCenter: null };
const m = (x) => (x ? `${num(x.cpa)}` : '—');
const cpaPair = (a, b) => `<b>${a?.cpa == null ? '—' : num(a.cpa)}</b><small> / ${b?.cpa == null ? '—' : num(b.cpa)}</small>`;
const timeAr = (iso) => (iso ? new Date(iso).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'short', timeStyle: 'short' }) : '—');
const hmCairo = (iso) => (iso ? new Date(iso).toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' }) : '—');

// ---------------------------------------------------------------------------------------------------------------------------------------------
// table (shared by the tab and the popup)
// ---------------------------------------------------------------------------------------------------------------------------------------------
function openRow(it, editable) {
  const e = it.evidence || {}; const dis = !editable || !it.selectable ? 'disabled' : ''; const warn = (e.warnings || []).filter((w) => w !== 'STOCK_UNKNOWN');
  const blocks = (it.blockCodes || []).map((c) => BLOCK_AR[c] || c);
  return `<tr class="dp-row ${it.selected ? 'on' : ''} ${it.eligibility !== 'ELIGIBLE' ? 'dim' : ''}" data-cid="${E(it.campaignId)}">
    <td><input type="checkbox" class="dp-chk" data-cid="${E(it.campaignId)}" ${it.selected ? 'checked' : ''} ${dis} aria-label="اختيار"></td>
    <td class="dp-rank">${it.rank}</td>
    <td class="dp-name"><b>${E(it.campaignName || it.campaignId)}</b><small>${E(it.productName || 'بدون منتج')} · ${E(it.campaignId)}${it.storeId ? ' · ' + E(it.storeId) : ''}</small>${it.eligibility !== 'ELIGIBLE' ? `<span class="op-pill ${it.eligibility === 'BLOCKED' ? 'red' : 'amber'}">${ELIG_AR[it.eligibility] || it.eligibility}</span>` : ''}</td>
    <td>${cpaPair(e.m7, e.m30)}</td><td>${num(e.m7?.purchases)}<small> / ${num(e.m30?.purchases)}</small></td><td>${num(e.m7?.spend)}<small> / ${num(e.m30?.spend)}</small></td>
    <td>${egp(e.budget)}<small>${e.budgetLevel || ''}</small></td><td>${e.lastActiveDate ? E(e.lastActiveDate) : '—'}${e.pausedBy ? `<small>${{ DAILY_SCHEDULE: 'روتين يومي', SYSTEM: 'السيستم', MANUAL: 'يدوي', UNKNOWN_OLD: 'سبب غير معروف' }[e.pausedBy] || ''}</small>` : ''}</td>
    <td class="dp-adv">${e.advisor ? `${E(e.advisor.stageLabel || '—')}<small>${E(e.advisor.problemLabel || '')}</small>` : '—'}</td>
    <td>${E(STOCK_AR[e.stock?.status] || 'غير معروف ⚠️')}</td><td><span class="op-pill ${RISK_CLS[it.risk] || 'gray'}">${RISK_AR[it.risk] || '—'}</span></td>
    <td class="dp-why">${E(it.reason || '')}${blocks.length ? `<small class="bad">🚫 ${E(blocks.join(' · '))}</small>` : ''}${warn.length ? `<small>⚠️ ${E(warn.join(' · '))}</small>` : ''}</td>${statusCell(it)}</tr>`;
}
function pauseRow(it, editable) {
  const e = it.evidence || {}; const dis = !editable || !it.selectable ? 'disabled' : ''; const blocks = (it.blockCodes || []).map((c) => BLOCK_AR[c] || c);
  const lbc = e.lastBudgetChange; const rp = e.recentPurchaseMinutesAgo;
  return `<tr class="dp-row ${it.selected ? 'on' : ''} ${it.eligibility !== 'ELIGIBLE' ? 'dim' : ''}" data-cid="${E(it.campaignId)}">
    <td><input type="checkbox" class="dp-chk" data-cid="${E(it.campaignId)}" ${it.selected ? 'checked' : ''} ${dis} aria-label="اختيار"></td>
    <td class="dp-rank">${it.rank}</td>
    <td class="dp-name"><b>${E(it.campaignName || it.campaignId)}</b><small>${E(it.productName || 'بدون منتج')} · ${E(it.campaignId)}</small>${it.eligibility !== 'ELIGIBLE' ? `<span class="op-pill ${it.eligibility === 'BLOCKED' ? 'red' : 'amber'}">${ELIG_AR[it.eligibility] || it.eligibility}</span>` : ''}</td>
    <td class="dp-cpa4"><b>${e.today?.cpa == null ? '—' : num(e.today.cpa)}</b><small>${m(e.m3)} · ${m(e.m7)} · ${m(e.m30)}</small></td>
    <td>${egp(e.today?.spend)}<small>اليوم (جزئي)</small></td><td>${num(e.today?.purchases)}<small>7 أيام: ${num(e.m7?.purchases)}</small></td><td>${egp(e.budget)}<small>${e.budgetLevel || ''}</small></td>
    <td>${e.m3?.ctr == null ? '—' : num(e.m3.ctr, 2) + '%'}<small>CPC ${e.m3?.cpc == null ? '—' : num(e.m3.cpc, 1)} · CVR ${e.m3?.cvr == null ? '—' : num(e.m3.cvr, 1) + '%'}</small></td>
    <td class="dp-adv">${e.advisor ? `${E(e.advisor.problemLabel || e.advisor.stageLabel || '—')}` : '—'}</td>
    <td>${e.attributionGraceHours != null ? `${e.attributionGraceHours}س` : '—'}<small>${rp != null ? `آخر أوردر من ${rp} د` : 'مفيش أوردر حديث'}</small></td>
    <td>${lbc ? `${E(lbc.action === 'SCALE_UP' ? '↑' : '↓')} ${lbc.from ?? ''}→${lbc.to ?? ''}<small>${ago(lbc.at)}</small>` : '—'}</td>
    <td><span class="op-pill ${RISK_CLS[it.risk] || 'gray'}">${it.riskScore ?? ''} ${RISK_AR[it.risk] || ''}</span></td>
    <td class="dp-why">${E(it.reason || '')}${blocks.length ? `<small class="bad">🚫 ${E(blocks.join(' · '))}</small>` : ''}</td>${statusCell(it)}</tr>`;
}
const statusCell = (it) => (it.status && it.status !== 'PENDING' ? `<td><span class="op-pill ${ITEM_PILL[it.status] || 'gray'}">${ITEM_AR[it.status] || it.status}</span>${it.statusReason ? `<small>${E(it.statusReason)}</small>` : ''}</td>` : '<td><small>—</small></td>');

function tableHtml(plan, { editable, limit = 40, compact = false } = {}) {
  const T = plan.type; const items = plan.items; const showAll = !!D.showAll[plan.id] || items.length <= limit;
  const rows = showAll ? items : items.filter((i) => i.selectable || i.selected).slice(0, limit);
  const head = T === 'OPEN'
    ? '<th></th><th>#</th><th>المنتج / الحملة</th><th>CPA 7د/30د</th><th>أوردرات 7د/30د</th><th>صرف 7د/30د</th><th>ميزانية</th><th>آخر نشاط</th><th>Smart Advisor</th><th>المخزون</th><th>المخاطرة</th><th>السبب</th><th>حالة التنفيذ</th>'
    : '<th></th><th>#</th><th>المنتج / الحملة</th><th>CPA اليوم<small> 3د · 7د · 30د</small></th><th>صرف اليوم</th><th>أوردرات اليوم</th><th>ميزانية</th><th>CTR / CPC / CVR</th><th>تشخيص Advisor</th><th>Grace / آخر أوردر</th><th>آخر تعديل ميزانية</th><th>درجة الخطر</th><th>السبب</th><th>حالة التنفيذ</th>';
  const tr = T === 'OPEN' ? openRow : pauseRow;
  return `<div class="table-wrap op-table-wrap"><table class="data dp-table ${compact ? 'compact' : ''}" data-plan="${plan.id}"><thead><tr>${head}</tr></thead><tbody>${rows.map((i) => tr(i, editable)).join('') || `<tr><td colspan="14" class="amb-empty">${E(TYPE_META[T].empty)}</td></tr>`}</tbody></table></div>
    ${!showAll ? `<div class="dp-more"><button class="amb-btn sm" data-showall="${plan.id}">عرض كل الحملات (${items.length}) — بما فيها المحمية والممنوعة</button></div>` : ''}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// selection (saved on the server on every change) + buttons
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function saveSelection(planId, selections, rerender, special = []) {
  try {
    const r = await api.put(`${API}/${planId}/selection`, { selections, special });
    if (r.newVersion) UI.toast(`اتحفظت نسخة جديدة v${r.plan.version} — لازم تعتمدها من جديد (القديمة اتلغت)`, 'warning');
    replacePlan(r.plan); rerender();
  } catch (e) { UI.toast(e.message, 'error'); await reload(); rerender(); }
}
function replacePlan(p) { if (!D.ov) return; const oi = (D.ov.oneOffPlans || []).findIndex((x) => x.key === p.key); if (oi >= 0) { D.ov.oneOffPlans[oi] = p; return; } D.ov.plans[p.type] = p; if (D.popupPlan && D.popupPlan.type === p.type) D.popupPlan = p; }
function wirePlan(root, plan, rerender) {
  root.querySelectorAll('.dp-chk').forEach((c) => { c.onchange = async () => {
    const it = plan.items.find((x) => x.campaignId === c.dataset.cid); let special = [];
    if (c.checked && it?.eligibility === 'NEEDS_SPECIAL_APPROVAL') {
      const okSpecial = await UI.confirmModal({ title: '⚠️ موافقة خاصة', message: `الحملة «${it.campaignName || it.campaignId}» اتوقفت ${it.evidence?.pausedBy === 'MANUAL' ? 'يدويًا' : 'لسبب غير معروف'}${it.evidence?.pausedAt ? ' (' + timeAr(it.evidence.pausedAt) + ')' : ''}. فتحها هنا هيكون بقرارك الصريح. متأكد؟`, confirmLabel: 'موافقة خاصة على الفتح' });
      if (!okSpecial) { c.checked = false; return; } special = [it.campaignId];
    }
    c.closest('tr').classList.toggle('on', c.checked); saveSelection(plan.id, { [c.dataset.cid]: c.checked }, rerender, special); }; });
  root.querySelectorAll('[data-showall]').forEach((b) => { b.onclick = () => { D.showAll[plan.id] = true; rerender(); }; });
  root.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const a = b.dataset.act;
      if (a === 'eligible') { const sel = {}; plan.items.forEach((i) => { if (i.selectable && i.eligibility === 'ELIGIBLE') sel[i.campaignId] = plan.type === 'OPEN' ? !!i.evidence?.recommended : !!i.evidence?.policyPause; }); await saveSelection(plan.id, sel, rerender); }
      else if (a === 'none') { const sel = {}; plan.items.forEach((i) => { if (i.selected) sel[i.campaignId] = false; }); await saveSelection(plan.id, sel, rerender); }
      else if (a === 'approve') await approve(plan, rerender);
      else if (a === 'cancel') await cancelPlan(plan, rerender);
      else if (a === 'audit') await showAudit(plan.id);
      else if (a === 'preview') await showPreview(plan);
    };
  });
}
async function approve(plan, rerender) {
  const sel = plan.items.filter((i) => i.selected); const T = TYPE_META[plan.type]; const ctl = D.ov?.control || {};
  const live = ctl.mode === 'APPROVAL' && !ctl.writesLocked && (plan.type === 'OPEN' ? ctl.allowOpen : ctl.allowPause);
  const msg = `${sel.length} حملة هتتعمل لها ${T.verb} ${live ? 'فعليًا على Meta واحدة واحدة (بفاصل 3 ثواني، مع إعادة تحقق قبل كل واحدة وقراءة من Meta بعدها).' : 'كتنفيذ تجريبي (SHADOW): كل حملة هتتراجع مقابل حالتها الحية على Meta وتتسجّل "كان هيتنفذ" — مفيش أي كتابة على Meta.'}`;
  if (!(await UI.confirmModal({ title: `${T.icon} ${T.approve}`, message: msg, confirmLabel: live ? 'اعتماد وتنفيذ' : 'اعتماد (محاكاة SHADOW)', danger: live }))) return;
  try {
    const r = await api.post(`${API}/${plan.id}/approve`, {});
    if (!r.ok) { UI.toast(r.message || 'الاعتماد اتمنع', 'error'); return; }
    UI.toast(r.executionMode === 'LIVE' ? 'اتعتمدت — التنفيذ بدأ' : 'اتعتمدت — محاكاة SHADOW بدأت (مفيش كتابة على Meta)');
    await reload(); rerender(); pollRunning(rerender);
  } catch (e) { UI.toast(e.message, 'error'); }
}
async function cancelPlan(plan, rerender) {
  if (!(await UI.confirmModal({ title: 'إلغاء الخطة', message: 'الخطة هتتلغي ومش هيتنفذ منها حاجة. هتتجهز خطة جديدة تلقائيًا في الموعد التالي فقط.', confirmLabel: 'إلغاء الخطة', danger: true }))) return;
  try { await api.post(`${API}/${plan.id}/cancel`, { reason: 'إلغاء من المستخدم' }); UI.toast('اتلغت'); await reload(); rerender(); } catch (e) { UI.toast(e.message, 'error'); }
}
function pollPreparing(body) {
  clearTimeout(D.pollPrep);
  const tick = async () => { if (S.tab !== 'daily' || !document.body.contains(body)) return; await reload(); render(body); if ((D.ov.preparing || []).some((p) => !p.error)) D.pollPrep = setTimeout(tick, 6000); };
  D.pollPrep = setTimeout(tick, 6000);
}
function pollRunning(rerender) {
  clearTimeout(D.pollRun);
  const tick = async () => { await reload(); rerender(); if ([...Object.values(D.ov.plans), ...(D.ov.oneOffPlans || [])].some((p) => p && ['APPROVED', 'RUNNING'].includes(p.status))) D.pollRun = setTimeout(tick, 3000); };
  D.pollRun = setTimeout(tick, 2500);
}
const RD_CLS = { READY: 'green', BLOCKED: 'red', UNVERIFIED: 'amber' }; const RD_AR = { READY: 'READY', BLOCKED: 'BLOCKED', UNVERIFIED: 'UNVERIFIED' };
function readinessHtml(r) {
  if (!r) return '<div class="dp-note">⏳ جارِ حساب جاهزية التشغيل الفعلي…</div>';
  return `<details class="dp-ready"><summary>🧭 جاهزية التشغيل الفعلي على Meta — <span class="op-pill green">READY ${r.summary.READY}</span> <span class="op-pill amber">UNVERIFIED ${r.summary.UNVERIFIED}</span> <span class="op-pill red">BLOCKED ${r.summary.BLOCKED}</span></summary>
    <div class="op-sub">الحالة من أدلة فعلية على Meta فقط (تنفيذ حقيقي + قراءة مستقلة) — مش من نجاح الاختبارات المحلية. «بوابات مقفولة» = اللي لسه مقفول دلوقتي.</div>
    <div class="table-wrap"><table class="data dp-rtable"><thead><tr><th>الوظيفة</th><th>الحالة</th><th>الدليل</th><th>بوابات مقفولة</th></tr></thead><tbody>${r.functions.map((f) => `<tr><td><b>${E(f.label)}</b>${f.needsApproval ? '<small>محتاج موافقتك لكل تنفيذ</small>' : ''}</td><td><span class="op-pill ${RD_CLS[f.status] || 'gray'}">${RD_AR[f.status] || f.status}</span></td><td class="dp-why">${E(f.note || '')}</td><td class="dp-why">${f.gates.length ? E(f.gates.join(' · ')) : '—'}</td></tr>`).join('')}</tbody></table></div></details>`;
}
async function reload() { D.ov = await api.get(`${API}/overview`); if (D.popupPlan) D.popupPlan = D.ov.plans[D.popupPlan.type] || D.popupPlan; return D.ov; }
async function showPreview(plan) {
  openDrawer(`${drawerHead('👁 معاينة التنفيذ — بدون تنفيذ')}<div class="amb-drawer-body"><div class="amb-loading">بيراجع الحملات المختارة على Meta الحي…</div></div>`);
  try {
    const r = await api.post(`${API}/${plan.id}/preview-execution`, {}); const T = TYPE_META[r.type];
    const gate = r.gate.blocked ? `<div class="dp-note bad">⛔ الاعتماد دلوقتي هيتمنع: ${E(r.gate.blocked.message)}</div>` : r.gate.mode === 'LIVE' ? '<div class="dp-note bad">⚠️ الاعتماد هينفّذ فعليًا على Meta (الوضع APPROVAL + القفل مفتوح + الصلاحية ON).</div>' : '<div class="dp-note ok">✅ الاعتماد دلوقتي = محاكاة SHADOW (مفيش كتابة على Meta).</div>';
    openDrawer(`${drawerHead('👁 معاينة التنفيذ — بدون تنفيذ')}<div class="amb-drawer-body"><div class="op-sub">${E(r.note)} · الوضع: ${E(r.config.mode)} · الكتابة: ${r.config.writesLocked ? '🔒 مقفولة' : '🔓 مفتوحة'} · مختارة: ${r.selected} · اتراجعت: ${r.previewed}</div>${gate}
      <div class="table-wrap"><table class="data"><thead><tr><th>الحملة</th><th>الميزانية</th><th>الحالة الحية</th><th>هيحصل إيه</th><th>السبب</th></tr></thead><tbody>${r.items.map((i) => `<tr><td><b>${E(i.campaignName || i.campaignId)}</b><small>${E(i.campaignId)}</small></td><td>${egp(i.budget)}</td><td>${E(i.liveStatus || '—')}</td><td><span class="op-pill ${i.ok ? 'green' : 'red'}">${E(i.wouldBe)}</span></td><td class="dp-why">${E(i.reason || '—')}</td></tr>`).join('') || '<tr><td colspan="5" class="amb-empty">مفيش حملات مختارة.</td></tr>'}</tbody></table></div></div>`);
  } catch (e) { openDrawer(`${drawerHead('👁 معاينة التنفيذ')}<div class="amb-drawer-body"><div class="dp-note bad">${E(e.message)}</div></div>`); }
}
async function showAudit(planId) {
  const r = await api.get(`${API}/${planId}`);
  openDrawer(`${drawerHead(`📜 سجل الخطة #${r.plan.id} (v${r.plan.version})`)}<div class="amb-drawer-body"><div class="op-sub">كل خطوة اتسجلت: تجهيز، تعديل اختيارات، اعتماد، وحالة كل حملة.</div>
    <ul class="dp-audit">${r.audit.map((a) => `<li><time>${timeAr(a.at)}</time> <span class="op-pill ${a.kind === 'DAILY_PLAN_ITEM' ? 'blue' : 'gray'}">${a.kind === 'DAILY_PLAN_ITEM' ? 'حملة' : 'خطة'}</span> ${E(a.note || '')}${a.campaignId ? ` <small>${E(a.campaignId)}</small>` : ''}${a.actorId ? ` <small>(مستخدم #${a.actorId})</small>` : ''}</li>`).join('') || '<li>لا يوجد.</li>'}</ul></div>`);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// one plan panel
// ---------------------------------------------------------------------------------------------------------------------------------------------
function timeline(plan) {
  const items = plan.items.filter((i) => i.selected && i.status && i.status !== 'PENDING' || (plan.status !== 'PREPARED' && i.selected));
  if (!items.length) return '';
  const steps = ['PREPARED', 'APPROVED', 'SCHEDULED', 'REVALIDATING', 'SENT', 'VERIFIED'];
  const cur = (it) => ({ PENDING: 2, REVALIDATING: 3, SENT: 4, VERIFIED: 5, SIMULATED: 5, FAILED: 5, SKIPPED: 3, BLOCKED: 3, UNCERTAIN: 5 }[it.status] ?? 2);
  return `<details class="dp-timeline" open><summary>⏱️ Execution Timeline (${items.length})</summary>${items.map((it) => `<div class="dp-tl"><b>${E(it.campaignName || it.campaignId)}</b><div class="dp-steps">${steps.map((s, ix) => `<span class="${ix <= cur(it) ? 'done' : ''}">${{ PREPARED: 'جهزت', APPROVED: 'معتمدة', SCHEDULED: 'مجدولة', REVALIDATING: 'تحقق', SENT: 'إرسال', VERIFIED: 'تأكيد' }[s]}</span>`).join('')}</div><span class="op-pill ${ITEM_PILL[it.status] || 'gray'}">${ITEM_AR[it.status] || it.status}</span>${it.statusReason ? `<small>${E(it.statusReason)}</small>` : ''}</div>`).join('')}</details>`;
}
function summaryBox(plan) {
  const s = plan.summary; if (!s || s.missed || s.cancelled) return s?.missed ? `<div class="dp-note bad">⌛ ${E(s.reason)}</div>` : s?.cancelled ? `<div class="dp-note">🚫 الخطة اتلغت: ${E(s.reason || '')}</div>` : '';
  const T = TYPE_META[plan.type];
  return `<div class="dp-note ${s.failed || s.uncertain ? 'bad' : 'ok'}"><b>ملخص:</b> ${s.executionMode === 'LIVE' ? `${T.verb} فعليًا ${s.verified} من ${s.selected}` : `محاكاة SHADOW — ${s.simulated} من ${s.selected} كانوا هيتنفذوا (مفيش كتابة على Meta)`} · متخطّي ${s.skipped} · ممنوع ${s.blocked} · فشل ${s.failed}${s.uncertain ? ` · غير مؤكد ${s.uncertain}` : ''} · كتابات Meta فعلية: <b>${s.metaWrites}</b>${Object.keys(s.byReason || {}).length ? `<small>${Object.entries(s.byReason).map(([k, v]) => `${E(k)} ×${v}`).join(' · ')}</small>` : ''}</div>`;
}
function panelHtml(type, plan) {
  const T = TYPE_META[type]; const ctl = D.ov.control;
  if (!plan) return `<section class="dp-panel" data-type="${type}"><header><h3>${T.icon} ${T.title} — ${T.at}</h3><span class="op-pill gray">لسه ما جاش الموعد</span></header><div class="amb-empty">الجدول بيتجهز تلقائيًا الساعة ${T.at} بتوقيت القاهرة. التالي: ${timeAr(D.ov.dashboard.nextDue.type === type ? D.ov.dashboard.nextDue.at : null)}</div></section>`;
  const editable = D.isAdmin && ['PREPARED'].includes(plan.status); const sel = plan.counts.selected;
  const stale = plan.dataState === 'STALE';
  return `<section class="dp-panel ${plan.simulated ? 'sim' : ''}" data-type="${type}" data-plan="${plan.id}">
    <header><h3>${T.icon} ${plan.key.includes('|T-') ? `${T.title} — مستقلة` : `${T.title} — ${T.at}`}</h3>${plan.key.includes('|T-') ? '<span class="op-pill blue">🧪 خطة مستقلة</span>' : ''}<span class="op-pill ${PLAN_CLS[plan.status] || 'gray'}">${PLAN_AR[plan.status] || plan.status}</span><small>v${plan.version} · ${E(plan.date)} · ${hmCairo(plan.scheduledAt)} القاهرة</small>${plan.simulated ? '<span class="op-pill purple">وقت افتراضي (اختبار)</span>' : ''}</header>
    <div class="dp-meta"><span>بيانات Meta: <b class="${stale ? 'bad' : ''}">${stale ? 'STALE ⛔' : 'FRESH ✓'}</b> ${plan.dataAsOf ? ago(plan.dataAsOf) : ''}</span><span>مختارة: <b>${sel}</b> من ${plan.counts.selectable} قابلة للاختيار</span><span>محمية/ممنوعة: ${plan.counts.protected}</span>${plan.approvedAt ? `<span>اتعتمدت: ${timeAr(plan.approvedAt)} (${plan.executionMode === 'LIVE' ? 'فعلي' : 'محاكاة'})</span>` : ''}</div>
    ${stale ? '<div class="dp-note bad">⛔ بيانات Meta قديمة — مفيش اعتماد ولا تنفيذ لحد ما التحديث ينجح.</div>' : ''}
    <div class="dp-actions">${editable ? `<button class="amb-btn sm" data-act="eligible">✔ اختيار المؤهّل</button><button class="amb-btn sm" data-act="none">✖ إلغاء التحديد</button>` : ''}
      ${D.isAdmin && plan.status === 'PREPARED' ? `<button class="amb-btn ${ctl.mode === 'APPROVAL' ? 'orange' : 'primary'}" data-act="approve" ${sel && !stale ? '' : 'disabled'}>${plan.key.includes('|T-') ? 'اعتماد وتنفيذ' : E(T.approve)}</button>` : ''}
      ${D.isAdmin && ['PREPARED', 'APPROVED'].includes(plan.status) ? '<button class="amb-btn sm danger" data-act="cancel">إلغاء الخطة</button>' : ''}${['PREPARED', 'APPROVED'].includes(plan.status) && D.isAdmin ? '<button class="amb-btn sm" data-act="preview">👁 معاينة التنفيذ</button>' : ''}<button class="amb-btn sm ghost" data-act="audit">📜 السجل</button></div>
    ${!editable && plan.status !== 'PREPARED' ? `<div class="dp-note">🔒 الخطة ${PLAN_AR[plan.status] || plan.status} ومحفوظة — مربعات الاختيار معطّلة. لاختيار حملات تانية اضغط «➕ إنشاء خطة جديدة» فوق.</div>` : ''}
    ${summaryBox(plan)}${tableHtml(plan, { editable })}${timeline(plan)}</section>`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the tab
// ---------------------------------------------------------------------------------------------------------------------------------------------
function ctlStrip() {
  const c = D.ov.control; const row = (ok, t, bad) => `<span class="op-pill ${ok ? 'green' : bad ? 'red' : 'amber'}">${t}</span>`;
  return `<div class="dp-ctl">${row(c.mode === 'APPROVAL', `الوضع: ${E(c.mode)}`, false)}${row(!c.emergencyStop, c.emergencyStop ? '🛑 Emergency Stop' : 'لا Emergency Stop', c.emergencyStop)}${row(!c.writesLocked, c.writesLocked ? 'كتابة Meta: مقفولة 🔒' : 'كتابة Meta: مفتوحة', false)}${row(!c.halted, c.halted ? '⏹ الطابور موقوف' : 'الطابور شغال', c.halted)}<span class="op-pill ${c.allowOpen ? 'amber' : 'gray'}">صلاحية الفتح: ${c.allowOpen ? 'ممنوحة' : 'مقفولة'}</span><span class="op-pill ${c.allowPause ? 'amber' : 'gray'}">صلاحية الإيقاف: ${c.allowPause ? 'ممنوحة' : 'مقفولة'}</span><span class="op-pill ${c.scheduledExecution ? 'amber' : 'gray'}">تنفيذ مجدول تلقائي: ${c.scheduledExecution ? 'مفعّل' : 'مقفول'}</span></div>`;
}
export async function drawDaily(body) {
  D.isAdmin = S.isAdmin; body.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  await reload(); render(body);
  if ((D.ov.preparing || []).some((p) => !p.error)) pollPreparing(body);
  api.get('/api/operator/production-readiness').then((r) => { D.readiness = r; const el = $('dpReadiness'); if (el) el.innerHTML = readinessHtml(r); }).catch(() => {});
  if ([...Object.values(D.ov.plans), ...(D.ov.oneOffPlans || [])].some((p) => p && ['APPROVED', 'RUNNING'].includes(p.status))) pollRunning(() => { const b = $('opBody'); if (b && S.tab === 'daily') render(b); });
}
function render(body) {
  const o = D.ov; const d = o.dashboard; const ext = o.externalSchedule;
  body.innerHTML = `<div class="dp-wrap">
    <div class="dp-head"><div><h2>📅 جدول التشغيل اليومي</h2><div class="op-sub">علّم ✓ ثم اعتمد. مفيش تنفيذ قبل زر الاعتماد · القاهرة الآن <b>${E(o.cairo.hhmm)}</b>${o.testClock ? ' <span class="op-pill purple">ساعة افتراضية</span>' : ''}</div></div>
      <div class="dp-head-btns">${D.isAdmin ? `<button class="amb-btn sm orange" id="dpNewOpen">➕ إنشاء خطة فتح جديدة</button><button class="amb-btn sm orange" id="dpNewPause">➕ إنشاء خطة إيقاف جديدة</button><button class="amb-btn sm" id="dpPreview">🔮 معاينة بكرة</button><button class="amb-btn sm ${o.control.halted ? 'primary' : 'danger'}" id="dpHalt">${o.control.halted ? '▶️ استئناف الطابور' : '⏹ إيقاف الطابور (Kill Switch)'}</button>` : ''}<button class="amb-btn sm" id="dpRefresh">🔄 تحديث</button></div></div>
    <div id="dpReadiness">${readinessHtml(D.readiness)}</div>
    ${ext?.pending ? '<div class="dp-note">⏳ بيتفحص وجود روتين فتح/إيقاف خارجي (Meta rule) — حدّث الصفحة بعد دقيقة.</div>' : ''}
    ${ext?.detected ? `<div class="dp-note bad" title="${E(ext.note)}">⚠️ فيه روتين فتح/إيقاف يدوي ثابت (${ext.changes} تغيير على ${ext.campaigns} حملة آخر 7 أيام) — نسّقه مع الجدولين.</div>` : ''}
    ${(o.preparing || []).map((p) => `<div class="dp-note ${p.error ? 'bad' : ''}">${p.error ? `⚠️ فشل تجهيز خطة ${TYPE_META[p.type].verb} المستقلة: ${E(p.error)}` : `⏳ بيجهّز خطة ${TYPE_META[p.type].verb} مستقلة من بيانات Meta الحالية (ممكن ياخد كام دقيقة) — الصفحة هتتحدّث لوحدها.`}</div>`).join('')}
    <div class="op2-kpis">
      <div class="op2-k blue"><b>${num(d.openProposed)}</b><span>مرشحة للفتح</span></div>
      <div class="op2-k amber"><b>${num(d.pauseProposed)}</b><span>مرشحة للإيقاف</span></div>
      <div class="op2-k green"><b>${num(d.selected)}</b><span>المختارة ✓</span></div>
      <div class="op2-k gray"><b>${E(hmCairo(d.nextDue.at))}</b><span>${E(d.nextDue.label.split(' — ')[0])} القادم</span></div>
    </div>
    <div class="dp-grid">${panelHtml('OPEN', o.plans.OPEN)}${panelHtml('PAUSE', o.plans.PAUSE)}</div>
    ${(o.oneOffPlans || []).length ? `<div class="dp-note">🧪 خطط اختبار بحملة واحدة (طلبتها بنفسك) — نفس بوابات الأمان والاعتماد، ومش بتأثر على خطة اليوم.</div><div class="dp-grid">${o.oneOffPlans.map((p) => panelHtml(p.type, p)).join('')}</div>` : ''}
    <div class="dp-foot op-sub">الخطة بتتجهز وتظهر كـPopup، والتنفيذ مش بيبدأ إلا بضغطة اعتماد منك. أي تعديل بعد الاعتماد = نسخة جديدة.</div></div>`;
  const rr = () => render(body);
  [...Object.values(o.plans), ...(o.oneOffPlans || [])].filter(Boolean).forEach((p) => { const sec = body.querySelector(`.dp-panel[data-plan="${p.id}"]`); if (sec) wirePlan(sec, p, rr); });
  $('dpRefresh').onclick = async () => { await reload(); rr(); };
  for (const [id, type] of [['dpNewOpen', 'OPEN'], ['dpNewPause', 'PAUSE']]) if ($(id)) $(id).onclick = async () => {
    if (!(await UI.confirmModal({ title: `➕ إنشاء خطة ${TYPE_META[type].verb} جديدة`, message: 'هتتجهز خطة مستقلة بكل الحملات المرشحة دلوقتي من بيانات Meta، ومفيش حاجة متحددة. خطة اليوم القديمة تفضل محفوظة زي ما هي. الاختيار والحفظ مش بينفّذوا حاجة — التنفيذ بس بزر «اعتماد وتنفيذ».', confirmLabel: 'إنشاء الخطة' }))) return;
    try { await api.post(`${API}/new`, { type }); UI.toast('بدأ تجهيز الخطة'); await reload(); rr(); pollPreparing(body); } catch (e) { UI.toast(e.message, 'error'); }
  };
  if ($('dpHalt')) $('dpHalt').onclick = async () => { try { await api.post(`${API}/halt`, { halted: !o.control.halted }); UI.toast('تم'); await reload(); rr(); } catch (e) { UI.toast(e.message, 'error'); } };
  if ($('dpPreview')) $('dpPreview').onclick = async () => { const r = await api.get(`${API}/preview-tomorrow`); openDrawer(`${drawerHead('🔮 معاينة بكرة — مش متخزنة')}<div class="amb-drawer-body"><div class="op-sub">كده الشكل لو الخطة اتجهزت دلوقتي. مفيش حاجة اتحفظت ولا اتنفذت.</div>${['OPEN', 'PAUSE'].map((t) => `<h4>${TYPE_META[t].icon} ${TYPE_META[t].title}: ${r[t].count} حملة (${r[t].selected} مختارة)</h4><ul class="dp-audit">${r[t].top.map((x) => `<li>#${x.rank} <b>${E(x.campaignName)}</b> ${x.selected ? '✓' : '✗'} <small>${E(x.reason || '')}</small></li>`).join('')}</ul>`).join('')}</div>`); };
}
const kpiBox = (label, v, tone, raw = false, sub = '') => `<div class="amb-kpi op-kpi ${tone}"><div class="k-label">${E(label)}</div><div class="k-val" style="${raw ? 'font-size:15px' : ''}">${raw ? E(v) : num(v)}</div>${sub ? `<div class="op-kpi-sub">${E(sub)}</div>` : ''}</div>`;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the automatic POPUP — the server decides what is due; the browser only polls and shows. It never executes anything by itself.
// ---------------------------------------------------------------------------------------------------------------------------------------------
function closePopup() { $('dpPopup')?.remove(); D.popupPlan = null; D.popupBusy = false; }
async function dismiss(planId) {
  if (!D.isAdmin) { try { localStorage.setItem(`dpSeen:${planId}`, '1'); } catch { /* private mode */ } return; } // a read-only viewer only remembers it locally
  try { await api.post(`${API}/${planId}/dismiss`, {}); } catch { /* shown again next poll at worst */ }
}
const seenLocally = (planId) => { try { return localStorage.getItem(`dpSeen:${planId}`) === '1'; } catch { return false; } };
function renderPopup() {
  const plan = D.popupPlan; if (!plan) return; const T = TYPE_META[plan.type]; const editable = D.isAdmin && plan.status === 'PREPARED'; const sel = plan.counts.selected; const stale = plan.dataState === 'STALE';
  let el = $('dpPopup'); if (!el) { document.body.insertAdjacentHTML('beforeend', '<div id="dpPopup" class="dp-popup-ov" role="dialog" aria-modal="true"></div>'); el = $('dpPopup'); }
  const summary = ['COMPLETED', 'RUNNING', 'APPROVED'].includes(plan.status);
  el.innerHTML = `<div class="dp-popup"><header><h2>${T.icon} ${plan.type === 'OPEN' ? 'موعد فتح الحملات — 12:00 ص' : 'موعد إيقاف الحملات — 1:00 ظ'}</h2><button class="amb-btn ghost" id="dpPopClose" aria-label="إغلاق">✕</button></header>
    <div class="op-sub">${plan.type === 'OPEN' ? 'الحملات المتوقفة المرشحة للفتح، الأفضل CPA والأقوى أوردرات أولًا.' : 'الحملات النشطة المقترح إيقافها، الأسوأ والأعلى تكلفة أولًا.'} الاختيار هنا مجرد تحديد — <b>مفيش حاجة بتتنفذ قبل ما تضغط زر الاعتماد.</b> ${D.ov?.control?.mode !== 'APPROVAL' ? `(الوضع ${E(D.ov?.control?.mode || 'SHADOW')}: الاعتماد = محاكاة بدون كتابة على Meta)` : ''}</div>
    ${stale ? '<div class="dp-note bad">⛔ STALE DATA — بيانات Meta قديمة ومفيش تنفيذ لحد ما تتحدّث.</div>' : ''}
    <div class="dp-meta"><span>مختارة: <b id="dpPopSel">${sel}</b></span><span>قابلة للاختيار: ${plan.counts.selectable}</span><span>بيانات Meta: ${plan.dataAsOf ? ago(plan.dataAsOf) : '—'}</span><span>${E(plan.date)} · القاهرة</span></div>
    <div class="dp-actions">${editable ? '<button class="amb-btn sm" data-act="eligible">✔ اختيار المؤهّل</button><button class="amb-btn sm" data-act="none">✖ إلغاء التحديد</button>' : ''}</div>
    ${summary ? summaryBox(plan) + timeline(plan) : ''}
    <div class="dp-popbody">${tableHtml(plan, { editable, limit: 25, compact: true })}</div>
    <footer>${D.isAdmin && plan.status === 'PREPARED' ? `<button class="amb-btn orange" data-act="approve" ${sel && !stale ? '' : 'disabled'}>${E(T.popupApprove)}</button>` : ''}<button class="amb-btn" id="dpPopCenter">فتح مركز التشغيل اليومي</button><button class="amb-btn ghost" id="dpPopLater">لاحقًا</button></footer></div>`;
  const rr = () => renderPopup();
  wirePlan(el, plan, rr);
  $('dpPopClose').onclick = $('dpPopLater').onclick = async () => { await dismiss(plan.id); closePopup(); };
  $('dpPopCenter').onclick = async () => { await dismiss(plan.id); closePopup(); D.onOpenCenter?.(); };
}
async function checkDue() {
  if (D.popupBusy || $('dpPopup')) return;
  try {
    const r = await api.get(`${API}/due`); const pick = (r.popups || []).find((p) => p.plan && p.status === 'PREPARED' && !D.seenPopup.has(`${p.planId}`) && !seenLocally(p.planId));
    if (!pick) return;
    D.seenPopup.add(`${pick.planId}`); D.popupBusy = true; D.popupPlan = pick.plan;
    if (!D.ov) { try { await reload(); } catch { D.ov = { control: {}, plans: {} }; } } else D.ov.plans[pick.plan.type] = pick.plan;
    renderPopup();
  } catch { /* offline / not allowed — try again next poll */ }
}
/** Starts the watcher once per page. onOpenCenter() should navigate to the AI Operator → "جدول التشغيل اليومي" tab. */
export function startDailyPopupWatcher({ isAdmin = false, onOpenCenter = null } = {}) {
  D.isAdmin = isAdmin; D.onOpenCenter = onOpenCenter;
  if (D.popupTimer) return;
  checkDue(); D.popupTimer = setInterval(checkDue, 45_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDue(); });
}
