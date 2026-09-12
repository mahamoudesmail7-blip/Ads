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
    </div>

    <div class="stat-grid" style="margin-bottom:16px;">
      ${UI.statTile('📅 اليوم — استدعاءات', num(usage.today.calls))}
      ${UI.statTile('📅 اليوم — التكلفة', usd(usage.today.costUsd))}
      ${UI.statTile('🗓️ آخر 7 أيام — استدعاءات', num(usage.last7.calls))}
      ${UI.statTile('🗓️ آخر 7 أيام — التكلفة', usd(usage.last7.costUsd))}
      ${UI.statTile('📆 هذا الشهر — استدعاءات', num(usage.month.calls))}
      ${UI.statTile('📆 هذا الشهر — التكلفة', usd(usage.month.costUsd))}
      ${UI.statTile('♻️ نسبة استخدام الكاش (آخر 7 أيام)', usage.last7.cacheHitPct === null ? '—' : `${usage.last7.cacheHitPct}%`)}
      ${UI.statTile('⚠️ استدعاءات فاشلة (آخر 7 أيام)', num(usage.last7.failed))}
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
      ${!Object.values(usage.byTier).some((t) => t.costUsd > 0) ? '<p class="faint" style="font-size:12px;">لسه معملتش تسعير للنماذج (AI_PRICE_*_PER_1M) — الاستدعاءات بتتسجل فعليًا لكن التكلفة تظهر "غير معروف" لحد ما تضيف الأسعار الحقيقية.</p>' : ''}
    </div>`;
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
