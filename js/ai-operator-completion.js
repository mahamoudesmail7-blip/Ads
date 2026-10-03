// ai-operator-completion.js — "AI Operator Setup / Completion" center: ONE view that says, per link of the real workflow, whether the Operator is
// actually connected (never "complete because the code exists"), with every missing item clickable to the screen that fixes it.
// Presentation only: every verdict comes from GET /api/operator/integration.
import * as UI from './ui-common.js';
import { api } from './api-client.js';
import { E, $, num, ago, S } from './ai-operator-core.js';

const ST_CLS = { CONNECTED: 'green', BLOCKED: 'amber', MISSING: 'red', UNVERIFIED: 'gray' };
const ST_AR = { CONNECTED: 'متصل', BLOCKED: 'محجوب', MISSING: 'ناقص', UNVERIFIED: 'غير مُثبَت' };
const RES_AR = { AUTO_FIXABLE: 'يتصلّح تلقائيًا', NEEDS_USER_VALUE: 'محتاج رقم منك', NEEDS_EXTERNAL_CONFIGURATION: 'إعداد خارجي', NEEDS_REVIEW: 'محتاج مراجعتك', NONE: '' };
const RES_CLS = { AUTO_FIXABLE: 'blue', NEEDS_USER_VALUE: 'red', NEEDS_EXTERNAL_CONFIGURATION: 'amber', NEEDS_REVIEW: 'amber' };
const resPill = (r) => (r && r !== 'NONE' ? `<span class="op-pill ${RES_CLS[r] || 'gray'}">${E(RES_AR[r] || r)}</span>` : '');
const LINK_TAB = { PRODUCT_ECONOMICS: 'readiness', PRODUCT_INVENTORY: 'readiness', PRODUCT_CAMPAIGN: 'mapping', PRODUCT_ADVISOR: 'control', OPERATOR_RULE: 'rules', DECISION_APPROVAL: 'control', PRODUCT_ORDERS: 'control' };

/** one webhook secret: dedicated variable set / only the old shared secret / not set. Names only — never a value. */
function whPill(s, kind) {
  const set = kind === 'order' ? s.orderWebhookSecretSet : s.statusWebhookSecretSet;
  const name = s.configuredNames?.[kind] || s.legacyName || '—';
  const pill = set && !s.dedicatedSecretsMissing ? '<span class="op-pill green">مضبوط</span>' : set ? '<span class="op-pill amber">سر مشترك قديم فقط — المتغيّر المخصص ناقص</span>' : '<span class="op-pill red">غير مضبوط</span>';
  return `<code>${E(name)}</code> ${pill}`;
}
function ratio(c) { return c && c.total != null ? `${num(c.value ?? c.connected)}/${num(c.total)}` : c?.value != null ? num(c.value) : '—'; }

export async function drawCompletion(root, { heavy = false, fresh = false } = {}) {
  root.innerHTML = '<div class="amb-panel"><div class="amb-loading">جارِ فحص التكامل الشامل… (بيقرا كل المصادر — ممكن ياخد حتى دقيقة)</div></div>';
  let a; try { a = await api.get('/api/operator/integration', { heavy: heavy ? 1 : 0, fresh: fresh ? 1 : 0 }); } catch (e) { root.innerHTML = `<div class="amb-panel op-bad">${E(e.message)}</div>`; return; }
  const c = a.completion;
  const card = (title, value, tab, tone, sub = '') => `<button class="op-card ${tone}" data-goto="${E(tab)}"><small>${E(title)}</small><b>${E(value)}</b>${sub ? `<em>${E(sub)}</em>` : ''}</button>`;
  const tone = (ok, partial) => (ok ? 'green' : partial ? 'amber' : 'red');
  const full = (x) => x && x.total > 0 && (x.value ?? 0) >= x.total;
  const part = (x) => x && (x.value ?? 0) > 0;
  const eo = c.easyOrdersHealthy;
  root.innerHTML = `
    <div class="amb-panel"><h3>🧩 اكتمال AI Operator — مش بنعتبره مكتمل لمجرد إن الكود موجود</h3>
      <div class="op-banner ${a.writesLocked ? 'amber' : 'red'}">🔒 الوضع: <b>${E(a.mode)}</b> · كتابة Meta: <b>${a.writesLocked ? 'مقفولة على مستوى النشر' : 'مفتوحة'}</b> · إيقاف الطوارئ: ${a.emergencyStop ? 'مفعّل' : 'مقفول'} — تقرير ${E(ago(a.generatedAt))}${a.cached ? ' (مخزّن مؤقتًا)' : ''}</div>
      <div class="op-cards">
        ${card('المنتجات', `${c.productsTotal}`, 'readiness', 'gray', `🟢 ${c.productsReady} · 🟡 ${c.productsPartial} · 🔴 ${c.productsBlocked}`)}
        ${card('الاقتصاديات مكتملة', ratio(c.economicsComplete), 'readiness', tone(full(c.economicsComplete), part(c.economicsComplete)), 'سعر + تكلفة شراء')}
        ${card('المخزون متصل', ratio(c.inventoryConnected), 'readiness', tone(full(c.inventoryConnected), part(c.inventoryConnected)), c.inventoryConnected.externalDependency ? 'مفيش مصدر جرد حي' : '')}
        ${card('ربط الحملات VERIFIED', ratio(c.campaignMappingsVerified), 'mapping', tone(full(c.campaignMappingsVerified), part(c.campaignMappingsVerified)), c.campaignMappingsVerified.review ? `${num(c.campaignMappingsVerified.review)} في المراجعة` : '')}
        ${card('جودة البيانات', c.dataQualityHealthy.value == null ? 'لم تُفحص' : ratio(c.dataQualityHealthy), 'readiness', c.dataQualityHealthy.value == null ? 'gray' : tone(full(c.dataQualityHealthy), part(c.dataQualityHealthy)), 'افحص من هنا ↓')}
        ${card('Easy Orders', eo.value ? 'سليم' : 'غير موثوق', 'control', eo.value ? 'green' : 'red', eo.externalDependency ? 'محتاج إعداد Webhooks' : 'حالات الأوردرات')}
        ${card('Smart Advisor متصل', ratio(c.smartAdvisorConnected), 'control', tone(full(c.smartAdvisorConnected), part(c.smartAdvisorConnected)), 'خطة لكل منتج معلَن')}
        ${card('القواعد', `${num(c.rulesConfigured.value)} مفعّلة`, 'rules', c.rulesConfigured.value ? 'green' : 'red')}
        ${card('Shadow متحقَّق', c.shadowValidated.ok ? `${num(c.shadowValidated.value)} قرار` : 'لا', 'today', c.shadowValidated.ok ? 'green' : 'red')}
        ${card('Meta Executor مُثبَت', c.metaExecutorVerified.ok ? 'نعم' : 'لا (0 كتابة)', 'performance', c.metaExecutorVerified.ok ? 'green' : 'gray')}
        ${card('Autopilot مؤهّل', c.autopilotEligible.ok ? 'نعم' : 'لا', 'control', c.autopilotEligible.ok ? 'green' : 'red')}
      </div>
      <div class="op-toolbar">${S.isAdmin ? '<button class="amb-btn orange" id="opAutofix">🛠️ اصلح اللي يتصلّح تلقائيًا (آمن)</button>' : ''} <button class="amb-btn" id="opDqRun">🔍 فحص جودة البيانات لكل المنتجات</button> <button class="amb-btn" id="opAuditRefresh">↻ إعادة الفحص</button></div>
      <div id="opAutofixOut"></div>
      <div class="op-sub">المتبقي بحسب النوع: ${Object.entries(a.missingByResolution).map(([k, v]) => `${resPill(k)} ${num(v)}`).join(' ') || '—'}</div>
    </div>
    <div class="amb-panel"><h3>⛓️ السلسلة من أولها لآخرها (فحص ذاتي)</h3>
      <div class="table-wrap"><table class="data op-table2"><thead><tr><th>الحلقة</th><th>الحالة</th><th>التغطية</th><th>التفاصيل</th><th></th></tr></thead><tbody>
      ${a.chain.map((l) => `<tr><td><b>${E(l.label)}</b></td><td><span class="op-pill ${ST_CLS[l.state]}">${E(ST_AR[l.state])}</span>${l.partial ? ' <small class="op-unk">جزئي</small>' : ''}</td><td>${l.coverage ? `${num(l.coverage.connected)}/${num(l.coverage.total)}` : '—'}</td><td class="op-why">${E(l.detail || '')}</td><td>${resPill(l.state === 'CONNECTED' ? null : l.resolution)}${LINK_TAB[l.key] && l.state !== 'CONNECTED' ? ` <button class="amb-btn sm" data-goto="${LINK_TAB[l.key]}">افتح</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div></div>
    <div class="amb-panel"><h3>🛡️ اختبار الحواجز الذاتي (${a.guardChecks.filter((x) => x.ok).length}/${a.guardChecks.length})</h3><ul class="op-checklist">${a.guardChecks.map((x) => `<li class="${x.ok ? 'ok' : 'no'}">${x.ok ? '✓' : '✗'} ${E(x.name)}</li>`).join('')}</ul></div>
    <div class="amb-panel"><h3>🛒 Easy Orders — حالة الربط</h3><div class="op-banner amber">${E(a.easyOrders.note)}</div>
      <div class="table-wrap"><table class="data"><thead><tr><th>المتجر</th><th>Webhook الأوردرات</th><th>Webhook تحديث الحالة</th><th>موثوقية الحالات</th><th>آخر استلام</th><th>Order Created</th><th>Status Update</th></tr></thead><tbody>
      ${a.easyOrders.stores.map((s) => `<tr><td>${E(s.id)}</td><td>${whPill(s, 'order')}</td><td>${whPill(s, 'status')}</td><td><span class="op-pill ${s.trust === 'OK' ? 'green' : 'red'}">${E(s.trust || '—')}</span></td><td>${s.lastIngestAt ? E(ago(s.lastIngestAt)) : '—'}</td><td>${E(s.orderCreatedVerified)}</td><td>${E(s.statusUpdateVerified)}</td></tr>`).join('')}</tbody></table></div>
      <ol class="op-ol">${a.easyOrders.procedure.map((p) => `<li>${E(p)}</li>`).join('')}</ol>
      <div class="op-sub">COD / Confirmation / Delivery: <b>${E(a.easyOrders.codAutomation)}</b> — ${a.easyOrders.codAutomation === 'BLOCKED' ? 'محجوبة لحد التحقق الفعلي. (أسماء المتغيّرات فقط — قيم الأسرار مش بتظهر أبدًا.)' : 'مؤهّلة.'}</div></div>
    <div class="amb-panel"><h3>📋 المنتجات — إيه الناقص وإزاي يتقفل</h3>
      <div class="table-wrap"><table class="data op-table2"><thead><tr><th>المنتج</th><th>المتجر</th><th>الجاهزية</th><th>حملات VERIFIED</th><th>الناقص</th></tr></thead><tbody>
      ${a.products.map((p) => `<tr><td><button class="amb-link" data-prof="${p.productId}">${E(p.name)}</button></td><td>${E(p.store)}</td><td>${E(p.readiness)}</td><td>${num(p.verifiedCampaigns)}${p.suggestedCampaigns ? ` <small class="op-unk">(+${p.suggestedCampaigns} مقترح)</small>` : ''}</td><td>${p.dependencies.filter((d) => d.state !== 'CONNECTED' && !d.soft).map((d) => `<span class="op-miss" title="${E(d.detail)}">${E(d.label)} ${resPill(d.resolution)}</span>`).join(' ') || '<span class="op-ok">لا شيء</span>'}</td></tr>`).join('')}</tbody></table></div></div>`;
  root.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => S.hooks.switchTab(b.dataset.goto); });
  root.querySelectorAll('[data-prof]').forEach((b) => { b.onclick = () => S.hooks.setupAction('ECONOMICS', { productId: Number(b.dataset.prof) }); });
  $('opAuditRefresh').onclick = () => drawCompletion(root, { heavy, fresh: true });
  $('opDqRun').onclick = () => drawCompletion(root, { heavy: true, fresh: true });
  if ($('opAutofix')) $('opAutofix').onclick = async () => {
    const out = $('opAutofixOut'); $('opAutofix').disabled = true; out.innerHTML = '<div class="amb-loading">🛠️ بيحسب خطط المستشار ويحفظ الاقتراحات… (حتى دقيقتين)</div>';
    try { const r = await api.post('/api/operator/integration/autofix', {}); out.innerHTML = `<div class="op-banner blue">${r.log.map(E).join('<br>')}${r.advisorRemaining ? `<br>باقي ${num(r.advisorRemaining)} منتج — اضغط تاني.` : ''}<br><small>🔒 بيكتب بس: خطط المستشار + ربط مقترح (SUGGESTED). مفيش اقتصاديات/مخزون/Meta/VERIFIED.</small></div>`; UI.toast('تم'); setTimeout(() => drawCompletion(root, { heavy, fresh: true }), 1500); }
    catch (e) { out.innerHTML = `<div class="op-bad">${E(e.message)}</div>`; $('opAutofix').disabled = false; }
  };
}
