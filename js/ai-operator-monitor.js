// ai-operator-monitor.js — «📈 مراقبة ما بعد التنفيذ»: for each REAL executed action: before → after, who/when/rule/confidence, Meta verification and the 6/12/24/48h checkpoints.
// Presentation only. A suggested rollback is just text — nothing here can execute anything.
import { api } from './api-client.js';
import { E, num, egp, dt, ago } from './ai-operator-core.js';

const ACT_AR = { RESUME: '▶️ فتح', PAUSE: '⏸️ إيقاف', INCREASE_BUDGET: '📈 زيادة ميزانية', DECREASE_BUDGET: '📉 تقليل ميزانية' };
const V_CLS = { IMPROVED: 'green', WORSE: 'red', NO_CHANGE: 'gray', INSUFFICIENT: 'amber', PENDING: 'gray' };
const V_AR = { IMPROVED: 'تحسّن', WORSE: 'تدهور', NO_CHANGE: 'تغيّر طفيف', INSUFFICIENT: 'أدلة غير كافية', PENDING: 'بانتظار التقييم' };

export async function drawMonitoring(el) {
  el.innerHTML = '<div class="amb-panel"><div class="amb-loading">جارِ تحميل مراقبة ما بعد التنفيذ…</div></div>';
  let r; try { r = await api.get('/api/operator/monitoring'); } catch (e) { el.innerHTML = `<div class="dp-note bad">⚠️ ${E(e.message)}</div>`; return; }
  const rows = r.actions || [];
  el.innerHTML = `<details class="pm-hist" open><summary>📈 مراقبة ما بعد التنفيذ (${rows.length})</summary>
    <div class="op-sub">كل أكشن اتنفّذ فعليًا على Meta بيتراقب بعد 6 / 12 / 24 / 48 ساعة. الحكم بيقول اتحسّن ولا اتدهور ولا الأدلة مش كفاية — من غير ما يدّعي سببًا. اقتراح الرجوع للقيمة القديمة مجرد اقتراح ومش بيتنفذ تلقائيًا.</div>
    ${rows.length ? rows.map((a) => `<div class="mon-card"><div class="mon-head"><b>${ACT_AR[a.actionType] || E(a.actionType)} — ${E(a.entityName || a.entityId)}</b><span class="op-pill ${V_CLS[a.verdict] || 'gray'}" title="${E(a.verdictLabel)}">${V_AR[a.verdict] || E(a.verdict)}</span></div>
      <div class="mon-meta"><span>قبل → بعد: <b>${a.actionType.includes('BUDGET') ? `${egp(a.before.budget)} → ${egp(a.after.budget)}` : `${E(a.before.status || '—')} → ${E(a.after.status || '—')}`}</b></span><span>نُفّذ: ${E(dt(a.executedAt))} (${E(ago(a.executedAt))})</span><span>المنفّذ: ${E(a.actor)}</span><span>القاعدة: ${E(a.rule || '—')}</span><span>الثقة: ${E(a.confidence || '—')}</span><span>التحقق من Meta: ${a.verification.verified === true ? '✅ مؤكد' : a.verification.verified === false ? '⚠️ غير مؤكد' : '—'}</span></div>
      <div class="mon-cps">${a.checkpoints.map((c) => `<div class="mon-cp ${c.state === 'EVALUATED' ? 'on' : ''}"><b>${c.hours} س</b><span class="op-pill ${V_CLS[c.verdict] || 'gray'}">${V_AR[c.verdict] || E(c.verdict)}</span>${c.state === 'EVALUATED' ? `<small>CPA ${c.cpaBefore == null ? '—' : num(c.cpaBefore)} → ${c.cpaAfter == null ? '—' : num(c.cpaAfter)} · أوردرات ${num(c.purchasesBefore)} → ${num(c.purchasesAfter)} · صرف ${num(c.spendBefore)} → ${num(c.spendAfter)}</small>` : `<small>الموعد: ${E(dt(c.dueAt))}</small>`}</div>`).join('')}</div>
      ${a.rollback ? `<div class="dp-note bad">↩️ ${E(a.rollback.text)} — <b>اقتراح فقط</b>، مش بيتنفذ إلا بقرارك وبمسار الموافقة.</div>` : ''}</div>`).join('') : '<div class="amb-empty">مفيش أكشن حقيقي اتنفّذ في آخر 14 يوم لسه.</div>'}</details>`;
}
