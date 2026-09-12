// AI Gateway admin usage/cost dashboard (§38) — page controller for
// ai-usage.html. ADMIN-only. Read-only except the explicit "اختبار الاتصال"
// button, which itself only hits OpenAI's free model-list endpoint on the
// backend (services/aiGateway healthCheck()) — never a paid generation.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const $ = (id) => document.getElementById(id);
const usd = (n) => (n === null || n === undefined ? 'غير معروف' : `$${Number(n).toFixed(3)}`);
const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));

const TIER_LABEL_AR = { routine: 'Luna (روتيني)', balanced: 'Terra (متوسط)', advanced: 'Sol (متقدّم)', image: 'الصور' };

async function init() {
  await UI.renderSidebar('ai-usage');
  await load();
  $('aiUsageBody').addEventListener('click', (e) => {
    if (e.target.id === 'aiHealthCheckBtn') runHealthCheck();
    if (e.target.id === 'aiTestRunBtn') runRealTest();
  });
}

async function load() {
  const body = $('aiUsageBody');
  let data;
  try {
    data = await api.get('/api/ai-usage/summary');
  } catch (err) {
    body.innerHTML = `<div class="card"><p class="muted">⚠️ ${E(err.message)}</p></div>`;
    return;
  }
  render(body, data);
}

function render(body, data) {
  const { usage, budget, models, anthropicEnabled } = data;
  body.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <div class="section-title" style="margin-top:0;">مزوّد الذكاء الاصطناعي</div>
      <div class="toolbar" style="gap:10px; flex-wrap:wrap;">
        <span class="badge green">OpenAI هو المزوّد الوحيد النشط</span>
        <span class="badge ${anthropicEnabled ? 'red' : 'gray'}">Anthropic: ${anthropicEnabled ? '⚠️ مفعّل (غير متوقع)' : 'معطّل'}</span>
        <button class="btn secondary" id="aiHealthCheckBtn">🔌 اختبار الاتصال (بدون تكلفة)</button>
      </div>
      <div id="aiHealthResult" style="margin-top:12px;"></div>
      <div class="faint" style="font-size:12px;margin-top:10px;">
        Luna: <code>${E(models.routine)}</code> · Terra: <code>${E(models.balanced)}</code> · Sol: <code>${E(models.advanced)}</code> · الصور: <code>${E(models.image)}</code>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="section-title" style="margin-top:0;">اختبار إنتاج حقيقي (§1/§83 — أقل تكلفة ممكنة)</div>
      <p class="faint" style="font-size:12px;">3 نداءات حقيقية صغيرة جدًا: Luna نصي، JSON مُهيكل، ورؤية على صورة منتج حقيقي من Easy Orders (بدون توليد أي صورة جديدة). دوس مرتين متتاليتين على نفس الزرار عشان تتأكد إن النداء التاني بيرجع من الكاش (cached:true) من غير أي تكلفة تانية.</p>
      <button class="btn" id="aiTestRunBtn">🧪 تشغيل الاختبار الحقيقي الآن (تكلفة حقيقية صغيرة جدًا)</button>
      <div id="aiTestRunResult" style="margin-top:12px;"></div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="section-title" style="margin-top:0;">الميزانية الشهرية</div>
      ${budget.configured ? `
        <div class="stat-grid">
          ${UI.statTile('💰 المصروف هذا الشهر', usd(budget.spentUsd))}
          ${UI.statTile('🎯 الميزانية', usd(budget.budgetUsd))}
          ${UI.statTile('📉 المتبقي', usd(budget.remainingUsd), { colorClass: budget.warning ? 'yellow' : 'green' })}
        </div>
        ${budget.blocked ? '<p class="badge red" style="margin-top:10px;">🛑 تم الوصول للحد الأقصى — التوليد الجديد متوقف مؤقتًا (البيانات المحفوظة والحسابات الحتمية شغالة عادي)</p>'
          : budget.warning ? '<p class="badge yellow" style="margin-top:10px;">⚠️ اقتربت من حد الميزانية الشهرية</p>' : ''}
      ` : '<p class="muted">مفيش سقف ميزانية مضبوط (OPENAI_MONTHLY_BUDGET_USD) — الاستهلاك غير محدود حاليًا.</p>'}
      <p class="faint" style="font-size:11px;margin-top:8px;">الميزانية دي بتشمل النص والصور مع بعض — الوصول لـ100% بيوقف التوليد الجديد (Hooks/بوستات/تحليل عميق/صور جديدة) بس مبيأثرش على النتائج المحفوظة أو الحسابات الحتمية أو استخدام النظام العادي.</p>
    </div>

    <div class="section-title">اليوم</div>
    <div class="stat-grid" style="margin-bottom:16px;">
      ${UI.statTile('💬 نداءات نصية', num(usage.today.textCalls))}
      ${UI.statTile('💬 تكلفة النص', usd(usage.today.textCostUsd))}
      ${UI.statTile('🖼️ صور مُولّدة', num(usage.today.imageGenerations))}
      ${UI.statTile('🖼️ تكلفة الصور', usd(usage.today.imageCostUsd))}
      ${UI.statTile('💰 إجمالي التكلفة', usd(usage.today.costUsd), { colorClass: 'green' })}
    </div>

    <div class="section-title">آخر 7 أيام</div>
    <div class="stat-grid" style="margin-bottom:16px;">
      ${UI.statTile('💬 تكلفة النص', usd(usage.last7.textCostUsd))}
      ${UI.statTile('🖼️ تكلفة الصور', usd(usage.last7.imageCostUsd))}
      ${UI.statTile('💰 الإجمالي', usd(usage.last7.costUsd))}
      ${UI.statTile('♻️ نسبة استخدام الكاش', usage.last7.cacheHitPct === null ? '—' : `${usage.last7.cacheHitPct}%`)}
      ${UI.statTile('⚠️ نداءات نصية فاشلة', num(usage.last7.textFailed))}
      ${UI.statTile('⚠️ نداءات صور فاشلة', num(usage.last7.imageFailed))}
    </div>

    <div class="section-title">هذا الشهر</div>
    <div class="stat-grid" style="margin-bottom:16px;">
      ${UI.statTile('💰 إجمالي إنفاق الذكاء الاصطناعي', usd(usage.month.costUsd), { colorClass: 'green' })}
      ${UI.statTile('📉 الميزانية المتبقية', budget.configured ? usd(budget.remainingUsd) : 'بدون سقف')}
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="section-title" style="margin-top:0;">الاستخدام حسب المستوى (هذا الشهر)</div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>المستوى</th><th>عدد الاستدعاءات</th><th>التكلفة التقديرية</th></tr></thead>
        <tbody>${['routine', 'balanced', 'advanced', 'image'].map((t) => `<tr><td>${E(TIER_LABEL_AR[t])}</td><td>${num(usage.byTier[t]?.calls)}</td><td>${usd(usage.byTier[t]?.costUsd)}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0;">الأكثر تكلفة (آخر 7 أيام)</div>
      <p>الميزة الأعلى تكلفة: <b>${usage.mostExpensiveFeature ? `${E(usage.mostExpensiveFeature.feature)} — ${usd(usage.mostExpensiveFeature.costUsd)}` : 'لا توجد بيانات تكلفة كافية'}</b></p>
      <p>النموذج الأعلى تكلفة: <b>${usage.mostExpensiveModel ? `${E(usage.mostExpensiveModel.model)} — ${usd(usage.mostExpensiveModel.costUsd)}` : 'لا توجد بيانات تكلفة كافية'}</b></p>
      ${!Object.values(usage.byTier).some((t) => t.costUsd > 0) ? '<p class="faint" style="font-size:12px;">⚠️ التسعير غير مضبوط (AI_PRICE_*_PER_1M / CF_IMAGE_UNIT_COST_USD) — الاستدعاءات بتتسجل فعليًا لكن التكلفة تظهر "غير معروف" بدل رقم وهمي، لحد ما تضيف الأسعار الحقيقية.</p>' : ''}
    </div>`;
}

async function runRealTest() {
  const box = $('aiTestRunResult');
  box.innerHTML = '<p class="muted">🧪 بنشغّل الاختبار الحقيقي — نداءات فعلية بتكلفة صغيرة جدًا…</p>';
  let r;
  try {
    r = await api.post('/api/ai-usage/test-run', {});
  } catch (err) {
    box.innerHTML = `<p class="badge red">${E(err.message)}</p>`;
    return;
  }
  const row = (label, p) => {
    if (!p) return '';
    if (!p.ok) return `<tr><td>${E(label)}</td><td>❌ فشل</td><td colspan="3">${E(p.error)}</td></tr>`;
    const cost = p.estimatedCostUsd === undefined ? '—' : usd(p.estimatedCostUsd);
    const toks = p.usage ? `in ${num(p.usage.inputTokens)} / out ${num(p.usage.outputTokens)}` : (p.cached ? 'من الكاش — 0 توكن جديد' : '—');
    return `<tr><td>${E(label)}</td><td>${p.cached ? '♻️ CACHE_HIT' : '✅ نداء حقيقي'}</td><td>${E(p.model || '—')}</td><td>${num(p.latencyMs)} ms</td><td>${E(toks)}</td><td>${cost}</td></tr>`;
  };
  box.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>الاختبار</th><th>النتيجة</th><th>الموديل</th><th>الزمن</th><th>التوكنز</th><th>التكلفة</th></tr></thead>
      <tbody>
        ${row('A) Luna نصي (فيه cacheKey ثابت)', r.luna)}
        ${row('B) JSON مُهيكل', r.structured)}
        ${row('C) رؤية (صورة منتج حقيقية من Easy Orders)', r.vision)}
      </tbody>
    </table></div>
    ${r.luna?.ok && !r.luna.cached ? '<p class="faint" style="font-size:11px;margin-top:8px;">دلوقتي دوس الزرار تاني — المفروض اختبار Luna يظهر ♻️ CACHE_HIT من غير نداء OpenAI جديد.</p>' : ''}
    ${r.luna?.ok && r.luna.cached ? '<p class="badge green" style="margin-top:8px;">✅ تأكّد: الطلب التاني رجع من الكاش (cached:true) — مفيش تكلفة إضافية.</p>' : ''}
    ${r.vision?.ok ? `<p class="faint" style="font-size:11px;margin-top:8px;">وصف المنتج (${E(r.vision.productName)}): «${E(r.vision.text)}»</p>` : ''}
    <p class="faint" style="font-size:11px;margin-top:4px;">وقت التشغيل: ${E(new Date(r.ranAt).toLocaleString('ar-EG'))}</p>`;
}

async function runHealthCheck() {
  const box = $('aiHealthResult');
  box.innerHTML = '<p class="muted">بنتأكد من الاتصال…</p>';
  try {
    const h = await api.get('/api/ai-usage/health');
    const rows = [
      ['الحالة العامة', h.status],
      ['Luna متاح', h.textAvailable?.routine === undefined ? '—' : (h.textAvailable.routine ? '✅' : '❌')],
      ['Terra متاح', h.textAvailable?.balanced === undefined ? '—' : (h.textAvailable.balanced ? '✅' : '❌')],
      ['Sol متاح', h.textAvailable?.advanced === undefined ? '—' : (h.textAvailable.advanced ? '✅' : '❌')],
      ['نموذج الصور متاح', h.imageAvailable ? '✅' : '❌'],
    ];
    box.innerHTML = `<div class="table-wrap"><table class="data"><tbody>${rows.map(([k, v]) => `<tr><td>${E(k)}</td><td>${E(v)}</td></tr>`).join('')}</tbody></table></div>
      ${h.error ? `<p class="badge red" style="margin-top:8px;">${E(h.error)}</p>` : ''}
      <p class="faint" style="font-size:11px;margin-top:8px;">آخر فحص: ${E(new Date(h.checkedAt).toLocaleString('ar-EG'))} — قراءة قائمة النماذج فقط، بدون أي توليد مدفوع.</p>`;
  } catch (err) {
    box.innerHTML = `<p class="badge red">${E(err.message)}</p>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
