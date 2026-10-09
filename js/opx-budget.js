// opx-budget.js — «إدارة الميزانيات»: two independent sections, A) زيادة الميزانية and B) تقليل الميزانية.
// Presentation over the existing budget policy / caps / auto-actions / permissions / decisions endpoints. Saving a threshold never executes anything; execution still needs the mode,
// the per-type execution permission, the deployment write lock, the guards, ADMIN approval and a live Meta read — all on the server.
import { api } from './api-client.js';
import { E, $, num, egp, ICONS, kpiCard, pill, skeletonRows, skeletonCards, toast, confirmModal, ago, thumb, hydrateThumbs } from './opx-ui.js';

const B = { ctx: null, root: null, policy: null, caps: null, decisions: [], ov: null, cfg: null };
const DIR = {
  up: { key: 'scale', toggle: 'up', perm: 'budgetIncrease', tone: 'green', icon: 'budget', title: 'زيادة الميزانية', sub: 'ترفع الميزانية بنسبة محددة عند أداء قوي وعينة كافية — وبدون زيادة ثانية من نفس الأوردرات', action: 'SCALE_UP', verb: 'زيادة' },
  down: { key: 'reduce', toggle: 'down', perm: 'budgetDecrease', tone: 'red', icon: 'coins', title: 'تقليل الميزانية', sub: 'تخفّض الميزانية عند CPA مرتفع مؤكد باتجاه 7 أيام — بدون رد فعل لتذبذب بسيط', action: 'SCALE_DOWN', verb: 'تقليل' },
};

export async function mountBudgetWorkspace(root, ctx) {
  B.ctx = ctx; B.root = root; root.innerHTML = `<div class="opx-card">${skeletonRows(4)}</div>`;
  await load(); draw();
}
async function load() {
  const [p, caps, cfg, dec, ov] = await Promise.all([api.get('/api/operator/budget-optimizer/policy'), api.get('/api/operator/budget-caps'), api.get('/api/operator/config'), api.get('/api/operator/decisions', { bucket: 'scale', limit: 100 }).catch(() => ({ decisions: [] })), api.get('/api/operator/overview')]);
  B.policy = p.policy; B.caps = caps.caps; B.cfg = cfg; B.decisions = dec.decisions || []; B.ov = ov;
}
const toggles = () => Object.fromEntries((B.ov?.control?.toggles || []).map((t) => [t.key, t.on]));
const perms = () => B.cfg?.config?.execPermissions || {};
function effectiveMode(d) {
  const mode = B.ov.mode, on = !!toggles()[d.toggle], perm = !!perms()[d.perm];
  if (B.ov.emergencyStop) return ['red', 'إيقاف طوارئ'];
  if (mode === 'OFF') return ['gray', 'MANUAL — لا تنفيذ آلي'];
  if (mode === 'SHADOW') return ['blue', 'SHADOW — محاكاة'];
  if (mode === 'APPROVAL') return [perm ? 'amber' : 'gray', perm ? 'APPROVAL — ينتظر موافقتك' : 'APPROVAL — صلاحية التنفيذ OFF'];
  return [on && perm ? 'green' : 'gray', on && perm ? 'AUTOMATIC — للقواعد المعتمدة' : 'AUTOMATIC — المفتاح/الصلاحية OFF'];
}
const fld = (id, label, v, { step = 'any', min = 0, hint = '' } = {}) => `<label>${E(label)}<input class="opx-input" id="${id}" type="number" step="${step}" min="${min}" value="${v ?? ''}" ${B.ctx.isAdmin ? '' : 'disabled'}>${hint ? `<small style="font-weight:600;color:var(--opx-muted)">${E(hint)}</small>` : ''}</label>`;

function section(d) {
  const p = B.policy; const s = d.key === 'scale' ? p.scale : p.reduce; const on = !!toggles()[d.toggle]; const perm = !!perms()[d.perm]; const em = effectiveMode(d);
  const fields = d.key === 'scale'
    ? `${fld('sc_pct', 'نسبة الزيادة %', s.pct, { hint: 'الخطوة الواحدة (مثال 100 → 120 → 144)' })}${fld('sc_maxCpa', 'حد CPA للزيادة (≤)', s.maxCpa)}${fld('sc_minPurchases', 'أقل عدد أوردرات', s.minPurchases)}${fld('sc_minSpend', 'أقل صرف', s.minSpend)}${fld('sc_cooldownHours', 'Cooldown (ساعات)', s.cooldownHours)}${fld('sc_minAgeHours', 'أقل عمر للحملة (ساعات)', s.minAgeHours)}`
    : `${fld('rd_pct', 'نسبة التقليل %', s.pct, { hint: 'مثال 150 → 120' })}${fld('rd_minCpa', 'بداية منطقة التقليل (CPA ≥)', s.minCpa)}${fld('rd_maxCpa', 'نهاية منطقة التقليل (CPA ≤)', s.maxCpa)}${fld('rd_min7dCpa', 'تأكيد باتجاه 7 أيام (CPA ≥)', s.min7dCpa, { hint: 'مفيش تقليل لو متوسط 7 أيام أحسن' })}${fld('rd_minPurchases', 'أقل عدد أوردرات', s.minPurchases)}${fld('rd_minSpend', 'أقل صرف', s.minSpend)}${fld('rd_cooldownHours', 'Cooldown (ساعات)', s.cooldownHours)}`;
  const capLabel = d.key === 'scale' ? 'أقصى ميزانية يومية بعد الزيادة (لكل حملة)' : null;
  return `<section class="opx-card opx-panel opx-fade" data-dir="${d.key}">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><div class="opx-head-icon ${d.tone}" style="width:46px;height:46px">${ICONS[d.icon]}</div><div style="flex:1;min-width:200px"><h3 style="font-size:17px">${E(d.title)}</h3><p class="opx-note" style="margin:2px 0 0">${E(d.sub)}</p></div>
      ${pill(E(em[1]), em[0])}</div>
    <div class="opx-kv"><span>تشغيل تلقائي (Auto ${d.verb})</span><b><button class="opx-switch ${on ? 'on' : ''}" data-toggle="${d.toggle}" ${B.ctx.isAdmin ? '' : 'disabled'} aria-label="تبديل" style="border:0"></button></b></div>
    <div class="opx-kv"><span>صلاحية التنفيذ (${d.verb})</span><b>${perm ? pill('ON', 'green') : pill('OFF', 'gray')} <small style="display:inline;margin:0 6px">من «صلاحيات التنفيذ»</small></b></div>
    <div class="opx-form">${fields}${capLabel ? fld('cap_campaign', capLabel, B.caps?.campaign ?? '', { hint: 'فارغ = بدون حد' }) : ''}</div>
    ${B.ctx.isAdmin ? `<div class="opx-actions"><button class="opx-btn primary" data-save="${d.key}">حفظ ${E(d.title)}</button><span class="opx-note" id="msg_${d.key}">الحفظ لا يعني التنفيذ.</span></div>` : '<p class="opx-note">للقراءة فقط — التعديل لـADMIN.</p>'}
  </section>`;
}

function draw() {
  const p = B.policy; const up = B.decisions.filter((d) => d.action === 'SCALE_UP'), down = B.decisions.filter((d) => d.action === 'SCALE_DOWN');
  const pending = B.decisions.filter((d) => d.status === 'PREPARED').length;
  B.root.innerHTML = `
    <div class="opx-card opx-head opx-fade"><div class="opx-head-icon violet">${ICONS.budget}</div><div class="grow"><h1>إدارة الميزانيات</h1><p>زيادة وتقليل الميزانيات بقواعد واضحة — كل تغيير بيتحقق من Meta قبل وبعد ويبدأ Cooldown</p></div>${B.ctx.modeSegment()}<button class="opx-btn danger" data-opxstop ${B.ov.emergencyStop ? 'disabled' : ''}>${ICONS.stop} إيقاف فوري</button></div>
    <div class="opx-kpis">
      ${kpiCard({ label: 'محرك الميزانيات', value: p.enabled ? 'مفعّل' : 'متوقف', icon: 'budget', tone: p.enabled ? 'green' : 'amber' })}
      ${kpiCard({ label: 'فرص زيادة حالية', value: num(up.length), icon: 'megaphone', tone: 'green' })}
      ${kpiCard({ label: 'مرشحة للتقليل', value: num(down.length), icon: 'target', tone: 'red' })}
      ${kpiCard({ label: 'قرارات تنتظر موافقتك', value: num(pending), icon: 'approve', tone: 'violet' })}
      ${kpiCard({ label: 'نافذة القياس', value: p.window === 'last7' ? '7 أيام' : '3 أيام', icon: 'clock', tone: 'blue' })}
    </div>
    <div class="opx-card opx-panel opx-fade" style="flex-direction:row;align-items:center;flex-wrap:wrap;gap:14px"><b>محرك الميزانيات</b><span class="opx-switch ${p.enabled ? 'on' : ''}" data-engine ${B.ctx.isAdmin ? '' : ''} role="switch" aria-checked="${p.enabled}" style="cursor:${B.ctx.isAdmin ? 'pointer' : 'default'}"></span>
      <span class="opx-note">${p.enabled ? 'الـScheduler بيقيّم الحملات ويجهّز القرارات (التنفيذ حسب الوضع والصلاحيات).' : 'متوقف: الـScheduler مش بيجهّز قرارات ميزانية.'}</span></div>
    <div class="opx-work-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:16px;align-items:start">${section(DIR.up)}${section(DIR.down)}</div>
    <div class="opx-card opx-tablecard opx-fade"><div class="opx-tablehead"><h3>القرارات الحالية للميزانيات (${num(B.decisions.length)})</h3><span class="opx-note">الاعتماد والرفض من «الموافقات»</span></div>
      <div class="opx-scroll opx-desk">${decisionsTable(B.decisions)}</div><div class="opx-cards">${decisionCards(B.decisions)}</div></div>
    <div class="opx-card opx-panel opx-fade"><h3>${ICONS.shield} الحمايات (لا تتجاوزها أي قاعدة)</h3><p class="opx-note">Cooldown بعد كل تعديل · أقل/أقصى ميزانية وحدود الحساب والمنتج · Emergency Stop · قفل النشر · صلاحيات التنفيذ · منع التكرار (Idempotency) · قراءة حية من Meta قبل وبعد · لا زيادة ثانية من نفس الأوردرات (حد أدنى صرف جديد: ${num(p.newEvidence?.minSpend)} ج.م).</p></div>`;
  wire(); hydrateThumbs(B.root);
}
function decisionCards(list) {
  if (!list.length) return '<div class="opx-empty">مفيش قرارات ميزانية حاليًا.</div>';
  const ST = { PREPARED: ['amber', 'جاهز للموافقة'], SHADOW: ['blue', 'محاكاة'], BLOCKED: ['red', 'ممنوع'], VERIFIED: ['green', 'اتأكد'], FAILED: ['red', 'فشل'], REJECTED: ['gray', 'مرفوض'] };
  return list.map((d) => { const bc = d.canonical?.budgetChange; const st = ST[d.status] || ['gray', d.statusLabel || d.status]; return `<article class="opx-c2"><div class="opx-c2-top" style="padding-left:0">${thumb(d.productId, d.productName || d.campaignName)}<div class="opx-c2-name"><b>${E(d.productName || '—')}</b><small>${E(d.campaignName || d.campaignId)}</small></div>${pill(E(st[1]), st[0])}</div><div class="opx-c2-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div><span>العملية</span><b>${E(d.actionLabel || d.action)}</b></div><div><span>قبل ← بعد</span><b>${bc ? `${egp(bc.from)} ← ${egp(bc.to)}` : '—'}</b></div></div></article>`; }).join('');
}
function decisionsTable(list) {
  if (!list.length) return '<div class="opx-empty">مفيش قرارات ميزانية حاليًا. فعّل المحرك واضغط «قيّم الآن» من مركز التحكم، أو انتظر دورة الـScheduler.</div>';
  const ST = { PREPARED: ['amber', 'جاهز للموافقة'], SHADOW: ['blue', 'محاكاة'], BLOCKED: ['red', 'ممنوع'], VERIFIED: ['green', 'اتأكد'], FAILED: ['red', 'فشل'], REJECTED: ['gray', 'مرفوض'] };
  return `<table class="opx-table"><thead><tr><th>الحملة</th><th>العملية</th><th class="num">قبل → بعد</th><th>السبب</th><th>الحالة</th></tr></thead><tbody>${list.map((d) => { const bc = d.canonical?.budgetChange; const st = ST[d.status] || ['gray', d.statusLabel || d.status]; return `<tr><td><div class="opx-prod"><div class="opx-thumb">${E(String(d.productName || d.campaignName || '?').slice(0, 1).toUpperCase())}</div><div><b>${E(d.productName || '—')}</b><small>${E(d.campaignName || d.campaignId)}</small></div></div></td><td>${pill(E(d.actionLabel || d.action), d.action === 'SCALE_UP' ? 'green' : 'red')}</td><td class="num">${bc ? `${egp(bc.from)} → <b>${egp(bc.to)}</b>` : '—'}</td><td class="opx-why">${E(d.reason || d.why || d.summary || '')}</td><td>${pill(E(st[1]), st[0])}</td></tr>`; }).join('')}</tbody></table>`;
}
function wire() {
  const root = B.root; const stop = root.querySelectorAll('[data-opxstop]'); stop.forEach((b) => { b.onclick = B.ctx.emergencyStop; });
  root.querySelectorAll('[data-toggle]').forEach((b) => { b.onclick = async () => {
    const key = b.dataset.toggle; const on = !toggles()[key];
    if (on && !(await confirmModal({ title: 'تفعيل تشغيل تلقائي', message: 'ده بيدّي صلاحية فقط — مفيش تنفيذ إلا لو الوضع AUTOMATIC وصلاحية التنفيذ ON وقفل النشر مفتوح.', confirmLabel: 'تفعيل' }))) return;
    try { await api.put('/api/operator/auto-actions', { [key]: on }); toast('تم'); await B.ctx.refresh(); await load(); draw(); } catch (e) { toast(e.message, 'error'); }
  }; });
  const eng = root.querySelector('[data-engine]'); if (eng && B.ctx.isAdmin) eng.onclick = async () => {
    const next = !B.policy.enabled; if (next && !(await confirmModal({ title: 'تشغيل محرك الميزانيات', message: 'الـScheduler هيبدأ يجهّز قرارات زيادة/تقليل (التنفيذ لسه حسب الوضع والصلاحيات).', confirmLabel: 'تشغيل' }))) return;
    try { await api.put('/api/operator/budget-optimizer/policy', { enabled: next }); toast('تم'); await load(); draw(); } catch (e) { toast(e.message, 'error'); }
  };
  root.querySelectorAll('[data-save]').forEach((b) => { b.onclick = async () => {
    const key = b.dataset.save; const val = (id) => { const v = $(id)?.value; return v === '' || v == null ? null : Number(v); };
    const patch = key === 'scale'
      ? { scale: { pct: val('sc_pct'), maxCpa: val('sc_maxCpa'), minPurchases: val('sc_minPurchases'), minSpend: val('sc_minSpend'), cooldownHours: val('sc_cooldownHours'), minAgeHours: val('sc_minAgeHours') } }
      : { reduce: { pct: val('rd_pct'), minCpa: val('rd_minCpa'), maxCpa: val('rd_maxCpa'), min7dCpa: val('rd_min7dCpa'), minPurchases: val('rd_minPurchases'), minSpend: val('rd_minSpend'), cooldownHours: val('rd_cooldownHours') } };
    try {
      await api.put('/api/operator/budget-optimizer/policy', patch);
      if (key === 'scale') { const capV = val('cap_campaign'); if (capV !== (B.caps?.campaign ?? null)) { if (!(await confirmModal({ title: 'تغيير حد الميزانية', message: capV == null ? 'إزالة حد الميزانية اليومية للحملة؟' : `أقصى ميزانية يومية للحملة بعد الزيادة = ${capV} ج.م. التغيير بيتسجل في الـAudit.`, confirmLabel: 'تأكيد' }))) return; await api.put('/api/operator/budget-caps', { caps: { campaign: capV }, confirm: true }); } }
      toast('اتحفظت — الحفظ لا يعني التنفيذ'); await load(); draw();
    } catch (e) { toast(e.message, 'error'); const m = $(`msg_${key}`); if (m) { m.className = 'opx-note bad'; m.textContent = e.message; } }
  }; });
  B.ctx.afterDraw?.(root);
}
