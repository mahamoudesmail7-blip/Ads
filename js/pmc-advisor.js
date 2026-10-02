// 🧠 المستشار الذكي — Smart Advisor tab (2026-10-02). Renders the ONE deterministic Action Plan produced by
// backend/src/services/amb/advisorPlan.js and the persisted recommendation tracking from advisorTracking.js.
// Pure presentation: every number/decision here comes from the API. Action buttons only open the existing
// floating assistant with a prefilled message + a one-shot recommendationId — the real PREPARE → PREVIEW →
// APPROVAL → EXECUTE flow stays inside the assistant's Task cards. Nothing on this page executes anything.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const $ = (id) => document.getElementById(id);
const n1 = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : (Math.round(Number(v) * 10) / 10).toLocaleString('en-US'));
const pct1 = (v) => (v === null || v === undefined ? '—' : `${n1(v)}%`);
const frac = (v) => (v === null || v === undefined ? '—' : `${n1(Number(v) * 100)}%`);

const store = { key: null, plan: null, history: null, reliability: null, loading: false, error: null };

const STATUS_AR = { RECOMMENDED: 'مقترحة', PREPARED: 'اتجهزت (مستنية موافقة)', APPROVED: 'اتوافق عليها', EXECUTED: 'اتنفذت', MEASURING: 'بتتقاس', EVALUATED: 'اتقيّمت', CANCELLED: 'اتلغت', EXPIRED: 'انتهت صلاحيتها' };
const VERDICT_AR = { VALIDATED: '✅ اتأكدت', IMPROVED: '📈 اتحسّن (مش مثبت سببيًا)', PARTIAL: '🟡 نجاح جزئي', INCONCLUSIVE: '⚪ غير حاسم', FAILED: '❌ فشلت', HARMFUL: '🛑 ضارّة', MEASURING: '⏳ بتتقاس', NOT_EXECUTED: '➖ ماتنفذتش' };
const VERDICT_CLS = { VALIDATED: 'ok', IMPROVED: 'ok', PARTIAL: 'warn', INCONCLUSIVE: 'muted', FAILED: 'bad', HARMFUL: 'bad', MEASURING: 'warn', NOT_EXECUTED: 'muted' };
const DEC_AR = { KEEP: '🟢 ثبّته', TEST: '🧪 اختبره', EXPAND: '📈 وسّع', DO_NOT_NARROW: '🚫 متضيّقش عليه', INSUFFICIENT_DATA: '⏳ بيانات غير كافية', EXCLUDED: '⚠️ مستبعد (جودة بيانات)' };
const REC_TYPE_AR = { CREATIVE: 'كرياتيف', HOOK: 'Hook', ANGLE: 'زاوية', AUDIENCE: 'جمهور', GEO: 'محافظة/منطقة', OFFER: 'عرض', PRICE: 'سعر', LANDING_PAGE: 'صفحة هبوط', SCALE: 'توسّع', DATA_FIX: 'إصلاح بيانات', COD: 'تشغيل (COD)', PROFIT: 'ربحية', STOCK: 'مخزون' };
const PROB_AR = { DATA_QUALITY_PROBLEM: 'مشكلة جودة بيانات', INSUFFICIENT_DATA: 'بيانات غير كافية', STOCK_PROBLEM: 'مشكلة مخزون', COD_PROBLEM: 'مشكلة تشغيلية', CREATIVE_FATIGUE: 'إجهاد كرياتيف', CTR_PROBLEM: 'انتباه ضعيف (CTR)', TRAFFIC_PROBLEM: 'تكلفة وصول عالية', CONVERSION_PROBLEM: 'تحويل ضعيف', OFFER_PROBLEM: 'عرض غير جذاب', CPA_PROBLEM: 'CPA مرتفع', PROFIT_PROBLEM: 'مشكلة ربحية', NONE: 'مفيش مشكلة' };
const METRIC_AR = { spend: 'الصرف', purchases: 'المشتريات', cpa: 'CPA', ctr: 'CTR', cvr: 'CVR', cpc: 'CPC', confirmationRate: 'التأكيد', deliveryRate: 'التسليم' };

function pill(text, cls = 'muted') { return `<span class="pmc-dq-pill ${cls}">${E(text)}</span>`; }
function ago(d) {
  if (!d) return '—';
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return 'الآن'; if (m < 60) return `منذ ${m} د`; if (m < 1440) return `منذ ${Math.round(m / 60)} س`; return `منذ ${Math.round(m / 1440)} يوم`;
}
function fmtMetric(k, v) { if (v === null || v === undefined) return '—'; if (k === 'confirmationRate' || k === 'deliveryRate') return frac(v); if (k === 'ctr' || k === 'cvr') return pct1(v); return n1(v); }
function section(title, body, cls = '') { return `<div class="pmc-card pmc-adv-sec ${cls}"><div class="h">${title}</div>${body}</div>`; }
function list(items, empty = '—') { return items && items.length ? `<ul class="pmc-adv-list">${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : `<div class="faint" style="font-size:12px;">${E(empty)}</div>`; }

// ---------------------------------------------------------------- action buttons (assistant hand-off)
function messageFor(a, plan) {
  const name = plan.productName || '';
  switch (a.tool?.name) {
    case 'generate_hooks': return `اعمل Hooks جديدة للمنتج "${name}" (فرضيات للاختبار): ${a.hypothesis || a.what}`;
    case 'generate_creative_brief': return `جهّز Creative Brief للمنتج "${name}" بتحديات جديدة بدل الكرياتيف المتعب مع الإبقاء على الزاوية الرابحة`;
    case 'prepare_test': return `جهّز اختبار ${a.tool.args?.testDimension || ''} للمنتج "${name}" بالقيمة "${a.tool.args?.testValue || a.targetVariable || ''}" — ${a.hypothesis || a.what}`;
    case 'prepare_scale': return `راجع التوسّع للمنتج "${name}" وجهّز Task بموافقتي`;
    case 'prepare_price_test': return `عايز أعمل اختبار سعر للمنتج "${name}" — هحدد لك السعر الجديد بنفسي`;
    default: return `ساعدني أنفذ: ${a.title} للمنتج "${name}"`;
  }
}
function openFromAction(a, plan) {
  UI.openAssistant({ message: messageFor(a, plan), autoSend: true, context: a.recommendationId ? { recommendationId: a.recommendationId } : null });
}

// ---------------------------------------------------------------- sections
function headerHtml(p) {
  const s = p.status;
  const dq = s.dataQuality;
  const dqCls = dq.blocked ? 'bad' : dq.overall === 'RECONCILED' ? 'ok' : 'warn';
  return `<div class="pmc-card pmc-adv-hero">
    <div class="pmc-adv-exec">🧭 <b>${E(p.executive)}</b></div>
    <div class="h" style="margin-top:12px;">🧠 حالة المنتج الآن</div>
    <div class="pmc-adv-grid">
      <div><span class="k">المرحلة</span><span class="v">${E(s.stageLabel)}</span></div>
      <div><span class="k">المشكلة الأساسية</span><span class="v">${E(s.primaryProblemLabel)}</span></div>
      <div><span class="k">السبب الجذري</span><span class="v">${E(s.rootCause || '—')}</span></div>
      <div><span class="k">جودة البيانات</span><span class="v">${pill(dq.blocked ? 'BLOCKED' : (dq.overall || dq.gate), dqCls)}</span></div>
      <div><span class="k">الثقة</span><span class="v">${pill(s.confidence.label_ar, s.confidence.label === 'HIGH' ? 'ok' : s.confidence.label === 'MEDIUM' ? 'warn' : 'muted')}</span></div>
      <div><span class="k">الهدف الحالي</span><span class="v">${E(s.objective)}</span></div>
    </div>
    <div class="faint" style="font-size:11px;margin-top:6px;">${E(s.confidence.basis)} · نسخة الخطة v${E(p.planVersion)} · اتحسبت ${E(ago(p.generatedAt))}${p.planChangeReasons ? ` · آخر تغيير: ${E(p.planChangeReasons.join('، '))}` : ''}</div>
  </div>`;
}
function problemHtml(p) {
  const d = p.diagnosis;
  const ev = d.problem.evidence || [];
  return section('🚨 المشكلة الحالية', `
    <div style="font-weight:700;">${E(d.biggestProblem)}</div>
    ${d.symptom ? `<div class="faint" style="font-size:12px;">العَرَض: ${E(d.symptom)}</div>` : ''}
    ${d.problem.rootNote ? `<div class="pmc-adv-note">${E(d.problem.rootNote)}</div>` : ''}
    <div class="faint" style="font-size:11.5px;margin:6px 0 2px;">الدليل (مصدر: Meta + Easy Orders — مش تخمين):</div>
    ${list(ev.map(E), 'مفيش دليل كافٍ لسه.')}
    ${p.notWorking.length > 1 ? `<div class="faint" style="font-size:11.5px;margin-top:6px;">مشاكل تانية مرتبة بالأثر:</div>${list(p.notWorking.slice(1).map((x) => E(`${x.rank}. ${x.label}`)))}` : ''}`);
}
function workingHtml(p) {
  const rows = p.working.map((w) => `<b>${E(w.dimension)}</b>: ${E(w.key)} <span class="faint">— ${E(w.evidence || '')}</span>`);
  return section('✅ اللي شغال وممنوع نبوظه', `${list(rows, 'لسه مفيش حاجة مثبتة بعينة كافية.')}
    ${p.staysFixed.length ? `<div class="faint" style="font-size:11.5px;margin-top:6px;">ثبّت: ${p.staysFixed.map(E).join('، ')}</div>` : ''}`);
}
function actionHtml(a, p, idx) {
  const tool = a.tool;
  const st = a.recStatus ? `<span class="faint" style="font-size:11px;">حالة التوصية: ${E(STATUS_AR[a.recStatus] || a.recStatus)}</span>` : '';
  return `<div class="pmc-adv-action ${E(a.priority)}">
    <div class="pmc-adv-action-top">
      <span class="pmc-adv-prio ${E(a.priority)}">${E(a.priority)}</span>
      <span class="pmc-adv-title">${E(a.title)}</span>
      <span class="faint" style="font-size:11px;">${a.owner === 'AI' ? '🤖 المساعد يجهّز' : '👤 إنت بتنفذ'} · ${E(REC_TYPE_AR[a.recType] || a.recType)}</span>
    </div>
    <div class="pmc-adv-what">${E(a.what)}</div>
    <div class="pmc-adv-meta">🎯 نجاحها: ${E(a.successMetric)} · ⏱️ المراجعة: ${E(a.checkpoint)} · ${pill(a.confidence === 'HIGH' ? 'ثقة عالية' : a.confidence === 'MEDIUM' ? 'ثقة متوسطة' : 'ثقة منخفضة', a.confidence === 'HIGH' ? 'ok' : a.confidence === 'MEDIUM' ? 'warn' : 'muted')} ${st}</div>
    <details class="pmc-adv-why"><summary>ليه الخطة دي؟</summary>
      <div><b>ليه:</b> ${E(a.why)}</div>
      <div><b>إزاي:</b> ${E(a.how)}</div>
      <div><b>اللي هيفضل ثابت:</b> ${E((a.staysFixed || []).join('، ') || '—')}</div>
      <div><b>معيار الفشل:</b> ${E(a.failureCriteria)}</div>
      <div><b>الدليل:</b> ${E((a.evidence || []).join(' · ') || '—')}</div>
      <div class="faint"><b>المصادر:</b> ${E((a.sources || []).join(' + ') || '—')}</div>
    </details>
    <div class="pmc-adv-btns">
      ${tool ? `<button class="amb-btn sm primary" data-adv-act="${idx}">${E(tool.label)}</button>` : ''}
      ${!tool && a.recommendationId && a.recStatus === 'RECOMMENDED' ? `<button class="amb-btn sm primary" data-adv-manual-start="${E(a.recommendationId)}">▶️ هبدأ أنفذها (يدوي)</button>` : ''}
      ${!tool && a.recommendationId && a.recStatus === 'PREPARED' && a.recManual ? `<button class="amb-btn sm primary" data-adv-manual-done="${E(a.recommendationId)}">✅ خلّصت التنفيذ</button>` : ''}
      ${a.recommendationId && ['RECOMMENDED', 'PREPARED'].includes(a.recStatus) ? `<button class="amb-btn sm" data-adv-cancel="${E(a.recommendationId)}">مش هنفذها</button>` : ''}
    </div>
  </div>`;
}
function actionsHtml(p) {
  const now = p.actions.now;
  const first = now.find((a) => a.tool);
  const parts = [];
  if (!now.length) parts.push(`<div class="faint" style="font-size:12.5px;">${p.insufficientPlan ? 'مفيش إجراء دلوقتي — بنجمع بيانات (شوف الخطة تحت).' : 'مفيش إجراء فوري بدليل كافٍ حاليًا.'}</div>`);
  else parts.push(now.map((a, i) => actionHtml(a, p, i)).join(''));
  if (first) parts.push(`<div style="margin-top:8px;"><button class="amb-btn primary" id="pmcAdvExecute">▶️ جهّز تنفيذ الخطة (بيفتح المساعد — مفيش تنفيذ بدون موافقتك)</button></div>`);
  if (p.actions.next.length) parts.push(`<details style="margin-top:8px;"><summary class="faint">إجراءات تالية (${p.actions.next.length})</summary>${p.actions.next.map((a, i) => actionHtml(a, p, 100 + i)).join('')}</details>`);
  if (p.actions.later.length) parts.push(`<details><summary class="faint">بعد كده (${p.actions.later.length})</summary>${p.actions.later.map((a, i) => actionHtml(a, p, 200 + i)).join('')}</details>`);
  if (p.actions.ifWins || p.actions.ifLoses) parts.push(`<div class="faint" style="font-size:11.5px;margin-top:6px;">لو نجح: ${E(p.actions.ifWins || '—')} · لو فشل: ${E(p.actions.ifLoses || '—')}</div>`);
  if (p.contradictions?.length) parts.push(p.contradictions.map((c) => `<div class="pmc-adv-warn">${E(c.label)} — ${E(c.note)}</div>`).join(''));
  return section('📋 اعمل إيه دلوقتي', parts.join(''));
}
function nextTestHtml(p) {
  const t = p.nextTest;
  if (t.none) return section('🧪 الاختبار القادم', `<div class="faint" style="font-size:12.5px;">${E(t.reason)}</div>${(t.triedBefore || []).length ? `<div class="faint" style="font-size:11.5px;">اتجرب قبل كده: ${t.triedBefore.map((x) => E(`${x.dimension}: ${x.key}`)).join('، ')}</div>` : ''}${(t.excludedByDataQuality || []).length ? `<div class="faint" style="font-size:11.5px;">⚠️ مستبعد بسبب جودة البيانات: ${t.excludedByDataQuality.map((x) => E(`${x.dimension}: ${x.key}`)).join('، ')}</div>` : ''}`);
  return section('🧪 الاختبار القادم', `<div class="pmc-adv-grid two">
    <div><span class="k">المتغيّر الوحيد</span><span class="v">${E(t.variable)}</span></div>
    <div><span class="k">ليه</span><span class="v">${E(t.why)}</span></div>
    <div><span class="k">الضابط (Control)</span><span class="v">${E(t.control)}</span></div>
    <div><span class="k">النسخة المختبَرة (Variant)</span><span class="v">${E(t.variant)}</span></div>
    <div><span class="k">الميزانية</span><span class="v">${E(t.budget)}</span></div>
    <div><span class="k">أقل عينة</span><span class="v">${E(t.minimumSample)}</span></div>
    <div><span class="k">مقاييس النجاح</span><span class="v">${E(t.successMetrics.join(' · '))}</span></div>
    <div><span class="k">المراجعة</span><span class="v">${E(t.review)}</span></div>
  </div>
  <div class="faint" style="font-size:11.5px;margin-top:6px;">الفرضية: ${E(t.hypothesis)} · ثابت: ${E((t.holdsConstant || []).join('، '))} · ${E(t.singleVariableRule)}</div>
  ${(t.triedBefore || []).length ? `<div class="faint" style="font-size:11.5px;">اتجرب قبل كده وما اتكررش: ${t.triedBefore.map((x) => E(`${x.dimension}: ${x.key}`)).join('، ')}</div>` : ''}`);
}
function creativeHtml(p) {
  const c = p.creative, h = p.hooks, a = p.angle;
  return section('🎨 خطة الكرياتيف / Hook / الزاوية', `
    <div class="pmc-adv-grid two">
      <div><span class="k">الزاوية الحالية</span><span class="v">${a.currentBest ? `${E(a.currentBest.label)} ${pill(a.currentBest.kind === 'VERIFIED' ? 'مثبتة' : 'إشارة مبكرة', a.currentBest.kind === 'VERIFIED' ? 'ok' : 'warn')}` : 'مفيش زاوية مثبتة'}</span></div>
      <div><span class="k">الـHook الحالي</span><span class="v">${h.keep ? E(h.keep.label) : 'مفيش Hook مثبت'}</span></div>
      <div><span class="k">الكرياتيف الرابح</span><span class="v">${c.keepWinner ? `${E(c.keepWinner.label)} — ثبّته` : 'مفيش كرياتيف مثبت'}</span></div>
      <div><span class="k">زاوية للاختبار</span><span class="v">${a.testNext ? `${E(a.testNext.label)} ${pill('HYPOTHESIS', 'warn')}` : '—'}</span></div>
    </div>
    ${c.replaceFatigued ? `<div class="pmc-adv-note">فيه كرياتيف FATIGUED${(c.fatiguedLabels || []).length ? ': ' + c.fatiguedLabels.map(E).join('، ') : ''} — استبدله بتحديات جديدة (الكرياتيف الرابح فوق يفضل ثابت).</div>` : ''}
    ${h.newDirections.length ? `<div class="faint" style="font-size:11.5px;margin:8px 0 4px;">اتجاهات Hooks جديدة (${E(h.note)})</div>${h.newDirections.map((d) => `<div class="pmc-adv-hook">${pill('HYPOTHESIS — NOT WINNER YET', 'warn')} <b>${E(d.label)}</b> <span class="faint">يختبر: ${E(d.tests)}</span></div>`).join('')}` : ''}
    ${c.challengers.length ? `<details style="margin-top:8px;"><summary class="faint">${c.challengers.length} كرياتيف challengers مقترحة (فرضيات)</summary>${c.challengers.map((x) => `<div class="pmc-adv-hook">${pill(x.badge, 'warn')} <b>#${x.slot}</b> ${E(x.hookDirection)} · ${E(x.format)}<div class="faint" style="font-size:11.5px;">أول 3 ثواني: ${E(x.first3Seconds)} · عرض عملي: ${E(x.demonstration)} · CTA: ${E(x.cta)} · الفرضية: ${E(x.hypothesis)} · ثابت: ${E(x.holdsConstant.join('، '))}</div></div>`).join('')}</details>` : ''}
    ${a.avoid.length ? `<div class="faint" style="font-size:11.5px;margin-top:6px;">زوايا اتجربت وفشلت: ${a.avoid.map((x) => E(x.label)).join('، ')}</div>` : ''}`);
}
function audienceHtml(p) {
  const rows = Object.values(p.audience).map((a) => `<div class="pmc-adv-aud"><b>${E(a.label)}</b> ${pill(DEC_AR[a.decision] || a.decision, a.decision === 'KEEP' ? 'ok' : a.decision === 'EXCLUDED' ? 'bad' : a.decision === 'TEST' ? 'warn' : 'muted')}<div class="faint" style="font-size:11.5px;">${E(a.note)}</div></div>`);
  return section('👥 قرار الجمهور', rows.join('') + `<div class="faint" style="font-size:11px;margin-top:4px;">جودة بيانات: عمر ${E(p.evidenceQuality.age)} · جنس ${E(p.evidenceQuality.gender)} · منطقة Meta ${E(p.evidenceQuality.region)} — أي بُعد مش موثوق بيتستبعد بدل التخمين.</div>`);
}
function offerHtml(p) {
  if (!p.offerPage.relevant) return '';
  return section('🏷️ العرض والصفحة', list(p.offerPage.items.map((i) => `<b>${E(i.item)}</b> ${pill(i.decision === 'TEST' ? 'اختبره' : i.decision === 'KEEP' ? 'سيبه' : 'محتاج مراجعة بشرية', i.decision === 'TEST' ? 'warn' : 'muted')} <span class="faint">${E(i.note)}</span>`)));
}
function codProfitHtml(p) {
  const c = p.cod, f = p.profit;
  const cod = c.orders != null && c.statusUnknown ? `<div class="pmc-adv-grid two"><div><span class="k">أوردرات</span><span class="v">${E(c.orders)}</span></div><div><span class="k">حالة التأكيد/التسليم</span><span class="v">${pill('غير معروفة (كلها PENDING)', 'warn')}</span></div></div><div class="pmc-adv-note">${E(c.note)}</div>` : c.orders != null ? `<div class="pmc-adv-grid two"><div><span class="k">أوردرات</span><span class="v">${E(c.orders)}</span></div><div><span class="k">التأكيد</span><span class="v">${pct1(c.confirmationRate)}</span></div><div><span class="k">التسليم</span><span class="v">${pct1(c.deliveryRate)}</span></div><div><span class="k">الإلغاء</span><span class="v">${pct1(c.cancellationRate)}</span></div></div>${c.verdict ? `<div class="pmc-adv-note">${E(c.verdict)}</div>` : ''}` : '<div class="faint">مفيش أوردرات كفاية.</div>';
  const sk = p.stock || {};
  return section('📦 التشغيل (COD) والمخزون والربحية', `${cod}<div style="margin-top:8px;"><b>المخزون:</b> ${pill(sk.status || 'STOCK_UNKNOWN', sk.status === 'SAFE' ? 'ok' : sk.status === 'OUT_OF_STOCK' ? 'bad' : sk.status === 'LOW' ? 'warn' : 'muted')} <span class="faint">${E(sk.note || '')}</span></div><div style="margin-top:8px;"><b>الربح:</b> ${pill(f.state, ['PROFITABLE'].includes(f.state) ? 'ok' : ['UNPROFITABLE'].includes(f.state) ? 'bad' : 'muted')} ${f.marginPct != null ? `هامش ${n1(f.marginPct)}%` : ''} <span class="faint">${E(f.note || '')}</span></div>`);
}
function branchHtml(p) {
  const out = [];
  if (p.insufficientPlan) { const x = p.insufficientPlan; out.push(section('⏳ لسه بنجمع بيانات', `${list([...x.missing.map(E), E(x.needed)])}<div class="faint" style="font-size:12px;">ثبّت: ${x.keepUnchanged.map(E).join('، ')} · ${E(x.review)}</div><div class="pmc-adv-note">${E(x.note)}</div>`)); }
  if (p.scalePlan) { const s = p.scalePlan; out.push(section('🚀 خطة التوسّع (Scale Plan)', `${list([`مرحلة السلم: ${E(s.ladderStage || '—')}`, `Money Guard: ${E(s.moneyGuard?.decision || '—')}${s.moneyGuard?.reason ? ' — ' + E(s.moneyGuard.reason) : ''}`, E(s.budgetStrategy), E(s.creativeRotation), s.addChallengers ? E(s.addChallengers) : null, `🔁 المراقبة: ${E(s.postScaleMonitoring)}`, `↩️ Rollback: ${E(s.rollback)}`].filter(Boolean))}${(s.cautions || []).map((c) => `<div class="pmc-adv-note">⚠️ ${E(c)}</div>`).join('')}${s.blockers?.length ? `<div class="pmc-adv-warn">موانع: ${s.blockers.map(E).join('، ')}</div>` : ''}`)); }
  if (p.recoveryPlan) { const r = p.recoveryPlan; out.push(section('🚑 خطة الإنقاذ (Recovery Plan)', `${list(r.attempts.map((a) => `محاولة ${a.n}: ${E(a.focus)} ${pill(a.status === 'DONE' ? 'اتعملت' : a.status === 'NEXT' ? 'الجاية' : 'بعدين', a.status === 'NEXT' ? 'warn' : 'muted')}`))}<div class="${r.stopTriggered ? 'pmc-adv-warn' : 'faint'}" style="font-size:12px;">🛑 شرط الإيقاف: ${E(r.stopCondition)}${r.stopTriggered ? ' — <b>اتحقق: يُوصى بإيقاف المنتج.</b>' : ''}</div>`)); }
  if (p.fatiguePlan) { const f = p.fatiguePlan; out.push(section('😮‍💨 خطة الإجهاد', `<div style="font-weight:700;">${E(f.statement)}</div>${list(f.priorities.map(E))}<div class="faint" style="font-size:11.5px;">متغيّرش: ${f.doNotChange.map(E).join('، ')} — ${E(f.note)}</div>`)); }
  return out.join('');
}

// ---- history
function beforeAfterHtml(r) {
  if (!r.before) return '';
  const keys = ['spend', 'purchases', 'cpa', 'ctr', 'cvr', 'confirmationRate'];
  const after = r.after || {};
  const d = r.outcome?.deltas || {};
  const rows = keys.map((k) => `<tr><td>${E(METRIC_AR[k])}</td><td>${fmtMetric(k, r.before[k])}</td><td>${fmtMetric(k, after[k])}</td><td class="${d[k] > 0 ? 'up' : d[k] < 0 ? 'down' : ''}">${d[k] != null ? (d[k] > 0 ? '+' : '') + n1(d[k]) + '%' : ''}</td></tr>`).join('');
  return `<table class="pmc-adv-ba"><thead><tr><th></th><th>قبل${r.before.window ? ` (${E(r.before.window.from)} → ${E(r.before.window.to)})` : ''}</th><th>${r.after?.interim ? 'دلوقتي (مؤقت)' : 'بعد'}</th><th>الفرق</th></tr></thead><tbody>${rows}</tbody></table>
    ${r.outcome ? `<div class="faint" style="font-size:11.5px;margin-top:4px;">نوع الدليل: ${E(r.outcome.evidenceKind)} — ${E(r.outcome.causalClaim || '')}</div>${(r.outcome.guardrails || []).length ? `<div class="faint" style="font-size:11.5px;">مقاييس الحماية: ${r.outcome.guardrails.map((g) => E(`${METRIC_AR[g.metric] || g.metric}: ${g.status === 'FAILED' ? '❌' : g.status === 'OK' ? '✅' : '❔'}`)).join(' · ')}</div>` : ''}${(r.outcome.confounders || []).length ? `<div class="pmc-adv-warn">تغييرات متداخلة: ${r.outcome.confounders.map((c) => E(c.note)).join('، ')}</div>` : ''}` : ''}
    ${r.progress ? `<div class="faint" style="font-size:11.5px;">${E(r.progress.reason || '')} (آخر فحص ${E(ago(r.progress.lastCheckAt))})</div>` : ''}`;
}
function recRowHtml(r) {
  const v = r.verdict || (r.status === 'RECOMMENDED' ? null : null);
  const vp = v ? pill(VERDICT_AR[v] || v, VERDICT_CLS[v] || 'muted') : pill(STATUS_AR[r.status] || r.status, 'muted');
  return `<details class="pmc-adv-rec"><summary>${vp} <b>${E(r.title)}</b> <span class="faint">${E(REC_TYPE_AR[r.recType] || r.recType)} · ${E(ago(r.createdAt))}</span></summary>
    <div class="faint" style="font-size:11.5px;">الحالة: ${E(STATUS_AR[r.status] || r.status)}${r.executedAt ? ` · اتنفذت ${E(ago(r.executedAt))}` : ' · لسه ماتنفذتش — مفيش نتيجة تُنسب ليها'}${r.expiredReason ? ` · ${E(r.expiredReason)}` : ''}</div>
    ${r.outcome ? `<div style="margin:4px 0;">${E(r.outcome.reason)}</div>` : ''}
    ${beforeAfterHtml(r)}
    ${r.learning ? `<div class="faint" style="font-size:11.5px;">🧠 تعلّم: ${E(r.learning.dimension)}:${E(r.learning.key)} → ${E(r.learning.verdict)} (${E(r.learning.state === 'NEEDS_REVALIDATION' ? 'محتاج إعادة تحقق' : r.learning.state)})</div>` : ''}
    ${r.rollback ? `<div class="faint" style="font-size:11.5px;">↩️ ${E(r.rollback.note)}</div>` : ''}
  </details>`;
}
function historyHtml(h) {
  if (!h) return section('🩺 سجل المشاكل والحلول', '<div class="pmc-empty">جارِ التحميل…</div>');
  if (!h.ok) return section('🩺 سجل المشاكل والحلول', `<div class="pmc-empty">⚠️ ${E(h.reason || 'تعذّر التحميل')}</div>`);
  const prob = h.problems.length ? h.problems.map((g) => `<div class="pmc-adv-prob"><div><b>${E(g.label)}</b> ${g.resolved ? pill('اتحلّت', 'ok') : pill('لسه قايمة', 'warn')} <span class="faint">${g.attempts} محاولة منفّذة</span></div>${g.recommendations.slice(0, 6).map((r) => `<div class="pmc-adv-prob-row">↳ ${E(r.title)} → ${r.verdict ? pill(VERDICT_AR[r.verdict] || r.verdict, VERDICT_CLS[r.verdict] || 'muted') : pill(STATUS_AR[r.status] || r.status, 'muted')}</div>`).join('')}</div>`).join('') : '<div class="faint" style="font-size:12.5px;">لسه مفيش توصيات متسجّلة — التتبع الحقيقي بيبدأ من أول توصية هنا.</div>';
  const legacy = `<div class="faint" style="font-size:11.5px;margin-top:8px;">🕰️ ${E(h.legacy.note)}${h.legacy.untrackedTasks ? ` (${h.legacy.untrackedTasks} مهمة سابقة غير متتبَّعة)` : ''}</div>`;
  const recs = h.recommendations.length ? h.recommendations.slice(0, 25).map(recRowHtml).join('') : '<div class="faint" style="font-size:12.5px;">مفيش توصيات لسه.</div>';
  const tl = [];
  for (const r of h.recommendations) {
    tl.push({ t: r.createdAt, text: `📝 اتقترحت: ${r.title}` });
    if (r.executedAt) tl.push({ t: r.executedAt, text: `⚙️ اتنفذت: ${r.title}` });
    if (r.evaluatedAt) tl.push({ t: r.evaluatedAt, text: `📊 اتقيّمت: ${r.title} → ${VERDICT_AR[r.verdict] || r.verdict}` });
  }
  for (const v of h.planVersions) tl.push({ t: v.createdAt, text: `🗂️ نسخة الخطة v${v.version}: ${(v.reasons || []).join('، ')}` });
  tl.sort((a, b) => new Date(b.t) - new Date(a.t));
  return section('🩺 سجل المشاكل والحلول', prob + legacy)
    + section('🎯 سجل توصيات المستشار', recs)
    + section('📈 قبل / بعد والجدول الزمني', list(tl.slice(0, 20).map((x) => `<span class="faint">${E(ago(x.t))}</span> ${E(x.text)}`), 'مفيش أحداث لسه.'));
}
function memoryHtml(p) {
  const m = p.memory;
  if (!m || (!m.triedBefore.length && !m.withheld.length)) return '';
  return section('🧩 اتجرب قبل كده', `${list(m.triedBefore.map((x) => `${pill(VERDICT_AR[x.verdict] || x.verdict, VERDICT_CLS[x.verdict] || 'muted')} ${E(x.title)}${x.learning?.state === 'NEEDS_REVALIDATION' ? ' <span class="faint">(محتاج إعادة تحقق)</span>' : ''}`))}${m.withheld.length ? `<div class="faint" style="font-size:11.5px;margin-top:6px;">اتمنعت من التكرار: ${m.withheld.map((w) => E(`${w.title} — ${w.reason}`)).join('، ')}</div>` : ''}`);
}
function reliabilityHtml(r) {
  if (!r || !r.ok) return '';
  const row = (x, label) => `<tr><td>${E(label)}</td><td>${x.executed}</td><td>${x.evaluated}</td><td>${x.validated + x.improved}</td><td>${x.partial}</td><td>${x.failed + x.harmful}</td><td>${x.inconclusive}</td><td>${x.measuring}</td><td>${x.hitRate != null ? x.hitRate + '%' : `<span class="faint">${E(x.hitRateNote)}</span>`}</td></tr>`;
  return section('📊 أداء توصيات المستشار', `<table class="pmc-adv-ba"><thead><tr><th>النوع</th><th>اتنفذت</th><th>اتقيّمت</th><th>نجحت/اتحسّنت</th><th>جزئي</th><th>فشلت/ضرّت</th><th>غير حاسم</th><th>بتتقاس</th><th>نسبة النجاح</th></tr></thead><tbody>${r.byType.map((x) => row(x, REC_TYPE_AR[x.key] || x.key)).join('') || '<tr><td colspan="9" class="faint">لسه مفيش توصيات.</td></tr>'}</tbody></table><div class="faint" style="font-size:11px;margin-top:4px;">${E(r.note)}</div>`);
}
function competitorHtml(p) {
  if (!p.competitorObservations?.length) return '';
  return section('🕵️ ملاحظات المنافسين', `${list(p.competitorObservations.map((c) => `${pill(c.label, 'muted')} ${E(c.text)}`))}<div class="faint" style="font-size:11px;">إلهام فقط — مش دليل إن نفس الشيء هينجح مع منتجك.</div>`);
}
function sourcesHtml(p) {
  return `<div class="faint" style="font-size:11px;margin-top:6px;">🔎 المصادر: Meta (قرار المنتج) · Easy Orders (COD/المحافظات) · Testing Brain/Product Learning (الاختبارات) · Data Quality · Profit/Stock/Money Guard — نفس الخطة اللي بيقراها المساعد.</div>`;
}

// ---------------------------------------------------------------- render + wiring
function planHtml(p) {
  return [headerHtml(p), problemHtml(p), workingHtml(p), actionsHtml(p), nextTestHtml(p), creativeHtml(p), audienceHtml(p), offerHtml(p), codProfitHtml(p), branchHtml(p), memoryHtml(p), competitorHtml(p), historyHtml(store.history), reliabilityHtml(store.reliability), sourcesHtml(p)].join('');
}
function wire(root, p, ctx) {
  const all = [...p.actions.now, ...p.actions.next.map((a) => a), ...p.actions.later];
  const byIdx = {};
  p.actions.now.forEach((a, i) => { byIdx[i] = a; });
  p.actions.next.forEach((a, i) => { byIdx[100 + i] = a; });
  p.actions.later.forEach((a, i) => { byIdx[200 + i] = a; });
  root.querySelectorAll('[data-adv-act]').forEach((b) => { b.onclick = () => { const a = byIdx[Number(b.dataset.advAct)]; if (a) openFromAction(a, p); }; });
  const ex = root.querySelector('#pmcAdvExecute');
  if (ex) ex.onclick = () => { const a = p.actions.now.find((x) => x.tool); if (a) openFromAction(a, p); };
  root.querySelectorAll('[data-adv-cancel]').forEach((b) => {
    b.onclick = async () => {
      if (!window.confirm('متأكد إنك مش هتنفذ التوصية دي؟ هتتسجل "ماتنفذتش" وما هتتحسبش نتيجة.')) return;
      try { await api.post(`/api/product-marketing/advisor/recommendations/${encodeURIComponent(b.dataset.advCancel)}/cancel`, { storeId: ctx.state.storeId }); UI.toast('اتسجّلت: ماتنفذتش.', 'success'); load(ctx, true); }
      catch (e) { UI.toast(e.message, 'error'); }
    };
  });
  root.querySelectorAll('[data-adv-manual-start]').forEach((b) => { b.onclick = async () => {
    if (!window.confirm('هنسجّل خط الأساس دلوقتي (الأرقام قبل التغيير). نفّذ التغيير بعد كده وارجع اضغط "خلّصت التنفيذ". كمّل؟')) return;
    try { await api.post(`/api/product-marketing/advisor/recommendations/${encodeURIComponent(b.dataset.advManualStart)}/start-manual`, { storeId: ctx.state.storeId }); UI.toast('اتسجّل خط الأساس. نفّذ التغيير وبعدها اضغط "خلّصت التنفيذ".', 'success'); load(ctx, true); } catch (e) { UI.toast(e.message, 'error'); }
  }; });
  root.querySelectorAll('[data-adv-manual-done]').forEach((b) => { b.onclick = async () => {
    if (!window.confirm('أكّد إنك نفّذت التغيير فعلًا — القياس بيبدأ من دلوقتي.')) return;
    try { await api.post(`/api/product-marketing/advisor/recommendations/${encodeURIComponent(b.dataset.advManualDone)}/confirm-manual`, { storeId: ctx.state.storeId }); UI.toast('اتسجّلت كمنفّذة — بنقيس النتيجة تلقائيًا.', 'success'); load(ctx, true); } catch (e) { UI.toast(e.message, 'error'); }
  }; });
  void all;
}
async function load(ctx, refresh = false) {
  const { state } = ctx;
  const key = `${state.profile.id}:${state.storeId}:${state.windowName}`;
  store.key = key; store.loading = true; store.error = null; paint(ctx);
  try {
    const params = { storeId: state.storeId, window: state.windowName };
    const planRes = await api.get(`/api/product-marketing/profiles/${state.profile.id}/action-plan`, refresh ? { ...params, refresh: '1' } : params);
    if (store.key !== key) return;
    store.plan = planRes.plan;
    store.loading = false; paint(ctx);
    // history + reliability are cheap DB reads — loaded after the plan so the plan paints first (pool-friendly, sequential)
    store.history = await api.get(`/api/product-marketing/profiles/${state.profile.id}/advisor-history`, { storeId: state.storeId }).catch((e) => ({ ok: false, reason: e.message }));
    store.reliability = await api.get('/api/product-marketing/advisor/reliability', { storeId: state.storeId }).catch(() => null);
    if (store.key === key) paint(ctx);
  } catch (e) { if (store.key === key) { store.loading = false; store.error = e.message; paint(ctx); } }
}
function paint(ctx) {
  const box = $('pmcAdvBox'); if (!box) return;
  if (store.loading && !store.plan) box.innerHTML = '<div class="pmc-empty">🧠 بنجمع كل الأنظمة ونبني الخطة… (ممكن ياخد 10–20 ثانية)</div>';
  else if (store.error && !store.plan) box.innerHTML = `<div class="pmc-empty">⚠️ ${E(store.error)}</div>`;
  else if (store.plan) { box.innerHTML = planHtml(store.plan); wire(box, store.plan, ctx); }
}

/** Entry point called by product-marketing-center.js for the "المستشار الذكي" tab. */
export function renderAdvisorTab(mount, ctx) {
  const { state } = ctx;
  const productLinked = state.profile?.productId ?? state.profile?.product_id; // serializeProfile() returns camelCase
  if (!productLinked) { mount.innerHTML = '<div class="pmc-card"><div class="pmc-empty">المنتج لسه مش مربوط بمنتج حقيقي في الكتالوج — المستشار محتاج بيانات حقيقية.</div></div>'; return; }
  mount.innerHTML = `
    <div class="pmc-card" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
      <div><b>🧠 المستشار الذكي</b> <span class="faint" style="font-size:12px;">خطة واحدة مبنية على بياناتك الحقيقية — بتتعلّم من كل توصية وبتقيس نتيجتها</span></div>
      <button class="amb-btn sm" id="pmcAdvRefresh">🔄 إعادة الحساب</button>
    </div>
    <div id="pmcAdvBox"></div>
    <details class="pmc-card" id="pmcAdvLegacy"><summary class="faint">🤖 استشارة AI التفصيلية (14 سؤال — غير حتمية)</summary><div id="pmcAdvLegacyBody" style="margin-top:8px;"></div></details>`;
  $('pmcAdvRefresh').onclick = () => load(ctx, true);
  if (ctx.renderLegacy) ctx.renderLegacy($('pmcAdvLegacyBody'));
  const key = `${state.profile.id}:${state.storeId}:${state.windowName}`;
  if (store.key === key && store.plan) { paint(ctx); } else { store.plan = null; store.history = null; load(ctx, false); }
}
