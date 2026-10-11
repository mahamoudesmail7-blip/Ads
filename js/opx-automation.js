// opx-automation.js — «الأتمتة»: where AUTOMATIC is controlled. Engine status · the pause policy (versioned, approved separately) · per-product READINESS and the ACTIVATION summary · what the engine would do right now.
// Presentation only: AUTOMATIC is per product, refused for anything incomplete (the server says exactly what is missing), and every execution still passes the central gate.
import { api } from './api-client.js';
import { E, num, egp, cairoDateTime, ago, ICONS, kpiCard, pill, skeletonRows, openDrawer, closeDrawer, toast, confirmModal, $ } from './opx-ui.js';

const A = { root: null, ctx: null, st: null, pp: null, rd: null, cand: null, form: null, dirty: false };
const DAYS = [[6, 'سبت'], [0, 'أحد'], [1, 'اتنين'], [2, 'تلات'], [3, 'أربع'], [4, 'خميس'], [5, 'جمعة']];
const EFF = { AUTOMATIC: ['violet', 'AUTOMATIC'], APPROVAL: ['blue', 'بموافقتك'], SHADOW: ['gray', 'محاكاة'], BLOCKED: ['red', 'ممنوع'] };
const CHECK_TAB = { rules: 'rules', pricing: 'pricing', integration: 'integration', pause: 'automation', open: 'open' };

export async function mountAutomationWorkspace(root, ctx) {
  A.root = root; A.ctx = ctx; root.innerHTML = `<div class="opx-card">${skeletonRows(6)}</div>`;
  await load();
}
async function load() {
  try {
    [A.st, A.pp, A.rd] = await Promise.all([api.get('/api/operator/automation/status'), api.get('/api/operator/pause-policy'), api.get('/api/operator/automation/readiness')]);
    A.cand = A.ctx.isAdmin ? await api.get('/api/operator/automation/candidates').catch((e) => ({ error: e.message, candidates: [] })) : { candidates: [] };
  } catch (e) { A.root.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message)}</div>`; return; }
  if (!A.form || !A.dirty) { const p = A.pp.policy; A.form = { scheduledClose: p.scheduledClose.enabled, zeroEnabled: p.zeroOrder.enabled, zeroSpend: p.zeroOrder.spend ?? '', highEnabled: p.highCpa.enabled, highAbove: p.highCpa.above ?? '', highMinP: p.highCpa.minPurchases, highMinSpend: p.highCpa.minSpend ?? '', stockEnabled: p.stockOut.enabled, winner: p.protections.winnerProtection, precedence: p.protections.precedence, days: p.days || [], exProducts: (p.scope.excludeProducts || []).join(', '), inProducts: (p.scope.includeProducts || []).join(', '), exCampaigns: (p.scope.excludeCampaigns || []).join(', '), inCampaigns: (p.scope.includeCampaigns || []).join(', '), exStores: (p.scope.excludeStores || []).join(', '), inStores: (p.scope.includeStores || []).join(', ') }; A.dirty = false; }
  draw();
}
const list = (s) => String(s || '').split(/[,\n،]/).map((x) => x.trim()).filter(Boolean);
const patchOf = (f) => ({ scheduledClose: { enabled: f.scheduledClose }, zeroOrder: { enabled: f.zeroEnabled, spend: f.zeroSpend === '' ? null : Number(f.zeroSpend) }, highCpa: { enabled: f.highEnabled, above: f.highAbove === '' ? null : Number(f.highAbove), minPurchases: Number(f.highMinP) || 5, minSpend: f.highMinSpend === '' ? null : Number(f.highMinSpend) }, stockOut: { enabled: f.stockEnabled }, protections: { winnerProtection: f.winner, precedence: f.precedence }, days: f.days.length ? f.days : null, scope: { includeProducts: list(f.inProducts), excludeProducts: list(f.exProducts), includeStores: list(f.inStores), excludeStores: list(f.exStores), includeCampaigns: list(f.inCampaigns), excludeCampaigns: list(f.exCampaigns) } });

function draw() {
  const s = A.st, admin = A.ctx.isAdmin; const pol = A.pp.policy; const approvedHere = A.pp.active;
  const l24 = s.last24h || {}; const sum = (...k) => k.reduce((t, x) => t + (l24[x] || 0), 0);
  const health = s.emergencyStop ? ['red', 'Emergency Stop شغّال'] : s.writesLocked ? ['amber', 'قفل Meta مقفول — الأتمتة بتجهّز/بتحاكي بس'] : s.mode === 'AUTOPILOT' ? ['violet', 'AUTOMATIC شغّال'] : s.mode === 'APPROVAL' ? ['blue', 'APPROVAL'] : s.mode === 'SHADOW' ? ['gray', 'SHADOW'] : ['gray', 'MANUAL'];
  A.root.innerHTML = `
    <div class="opx-card opx-head opx-fade"><div class="opx-head-icon violet">${ICONS.shield}</div><div class="grow"><h1>الأتمتة (AUTOMATIC)</h1><p>AUTOMATIC بيشتغل <b>على منتج معيّن فقط</b> بعد ما يستوفي كل الشروط. أي منتج ناقص بيترفض مع السبب، وكل تنفيذ بيعدّي على بوابة الأمان المركزية ويتسجّل في سجل التنفيذ.</p></div>${pill(health[1], health[0])}</div>
    <div class="opx-kpis">${kpiCard({ label: 'وضع النظام', value: s.mode, icon: 'shield', tone: 'violet' })}${kpiCard({ label: 'قرارات آخر 24س (اتنفذت)', value: num(sum('VERIFIED', 'EXECUTED')), icon: 'check', tone: 'green' })}${kpiCard({ label: 'جاهزة للموافقة', value: num(sum('PREPARED')), icon: 'clock', tone: 'amber' })}${kpiCard({ label: 'ممنوعة / منتهية / فاشلة', value: `${num(sum('BLOCKED'))} / ${num(sum('EXPIRED'))} / ${num(sum('FAILED'))}`, icon: 'stop', tone: sum('FAILED') ? 'red' : 'gray' })}</div>
    <div class="opx-card opx-fade" style="padding:14px 16px"><b>آخر دورة أتمتة:</b> ${s.lastTick ? `${E(ago(s.lastTick.at))} — ${s.lastTick.skipped ? E(s.lastTick.skipped) : s.lastTick.stale ? 'بيانات Meta قديمة (مفيش تسجيل)' : `${num(s.lastTick.evaluated)} قرار · نُفّذ ${num((s.lastTick.executed || []).length)}${(s.lastTick.gate || []).length ? ` · بوابات مقفولة: ${E(s.lastTick.gate.join('، '))}` : ''}`}` : 'لسه ما اشتغلتش (بتشتغل كل 10 دقايق)'} · السياسة المعتمدة للفتح: ${s.policies.open.enabled ? `v${s.policies.open.approvedVersion ?? '—'}` : 'مش مفعّلة'} · للإيقاف: ${s.policies.pause.active ? `v${s.policies.pause.approvedVersion}` : 'مش معتمدة'}${admin ? ` <button class="opx-btn sm" id="auTick" style="margin-inline-start:10px">${ICONS.play} شغّل دورة الآن</button>` : ''}</div>
    ${pausePanel(pol, approvedHere, admin)}
    <div class="opx-card opx-tablecard opx-fade"><div class="opx-tablehead"><h3>جاهزية المنتجات لـAUTOMATIC</h3></div><div class="opx-scroll">${readyTable()}</div></div>
    <div class="opx-card opx-tablecard opx-fade"><div class="opx-tablehead"><h3>إيه اللي المحرك هيعمله دلوقتي (${num(A.cand.candidates.length)})</h3></div><div class="opx-scroll">${candTable()}</div></div>`;
  wire();
}
function pausePanel(pol, approvedHere, admin) {
  const f = A.form; const dis = admin ? '' : 'disabled'; const chk = (id, v, label) => `<label class="opx-note" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="${id}" ${v ? 'checked' : ''} ${dis}> ${label}</label>`; const inp = (id, label, v) => `<label class="opx-field"><span>${label}</span><input class="opx-input" id="${id}" inputmode="decimal" value="${E(v)}" ${dis}></label>`;
  return `<section class="opx-card opx-cpa opx-fade" id="auPause"><div class="opx-cpa-head"><div class="opx-head-icon red" style="width:48px;height:48px">${ICONS.pause}</div><div class="grow"><h2>سياسة الإيقاف التلقائي ${pill('v' + pol.version, 'gray')} ${approvedHere ? pill('معتمدة', 'green') : pill(pol.enabled ? 'نسخة جديدة محتاجة اعتماد' : 'مش مفعّلة', 'amber')}</h2><p>الأولوية: نفاد المخزون › صرف بدون أوردرات › CPA عالي. التقليل/الزيادة بتتحكم فيهم سياسة الميزانية وقواعد كل منتج. الحفظ بينتج نسخة جديدة ولا بيفعّل أي حاجة؛ الاعتماد خطوة منفصلة.</p></div>
      <div class="opx-cpa-toggle"><button class="opx-switch-btn ${pol.enabled ? 'on' : ''}" id="auPOn" role="switch" aria-checked="${pol.enabled}" ${dis}><span></span></button><div><b>${pol.enabled ? 'السياسة معتمدة (v' + (pol.approved?.version ?? '—') + ')' : 'اعتماد سياسة الإيقاف'}</b></div></div></div>
    <div class="opx-cpa-form">${chk('auSC', f.scheduledClose, 'الإغلاق المجدول يتنفّذ تلقائيًا (خطة الإيقاف الساعة 13:00 أو موعد المنتج)')}${chk('auZE', f.zeroEnabled, 'إيقاف الصرف بدون أوردرات')}${inp('auZS', 'حد الصرف بدون أوردرات (فاضي = حد المنتج/الحساب)', f.zeroSpend)}${chk('auHE', f.highEnabled, 'إيقاف مباشر عند CPA عالي')}${inp('auHA', 'CPA أعلى من', f.highAbove)}${inp('auHP', 'أقل عدد أوردرات للحكم', f.highMinP)}${inp('auHS', 'أقل صرف للحكم', f.highMinSpend)}${chk('auSO', f.stockEnabled, 'إيقاف عند نفاد المخزون')}${chk('auWN', f.winner, 'حماية الـWinner')}
      <label class="opx-field"><span>أولوية الحماية</span><select class="opx-select" id="auPR" ${dis}><option value="PROTECTION_WINS" ${f.precedence === 'PROTECTION_WINS' ? 'selected' : ''}>حماية الـWinner أقوى (ما عدا نفاد المخزون)</option><option value="RULE_WINS" ${f.precedence === 'RULE_WINS' ? 'selected' : ''}>قاعدة الإيقاف أقوى حتى على الـWinner</option></select></label>
      <div class="opx-field"><span>أيام الإيقاف التلقائي</span><div class="opx-chips">${DAYS.map(([d, t]) => `<button class="opx-chip ${f.days.includes(d) ? 'on' : ''}" data-auday="${d}" ${dis}>${t}</button>`).join('')}</div></div>
      <label class="opx-field"><span>منتجات مستبعدة (IDs بفاصلة)</span><input class="opx-input" id="auXP" value="${E(f.exProducts)}" ${dis}></label><label class="opx-field"><span>منتجات مضمّنة فقط (فاضي = الكل)</span><input class="opx-input" id="auIP" value="${E(f.inProducts)}" ${dis}></label>
      <label class="opx-field"><span>متاجر مستبعدة</span><input class="opx-input" id="auXS" value="${E(f.exStores)}" ${dis}></label><label class="opx-field"><span>متاجر مضمّنة فقط</span><input class="opx-input" id="auIS" value="${E(f.inStores)}" ${dis}></label>
      <label class="opx-field"><span>حملات مستبعدة</span><input class="opx-input" id="auXC" value="${E(f.exCampaigns)}" ${dis}></label><label class="opx-field"><span>حملات مضمّنة فقط</span><input class="opx-input" id="auIC" value="${E(f.inCampaigns)}" ${dis}></label></div>
    <div id="auErr"></div><div class="opx-cpa-btns"><button class="opx-btn ${A.dirty ? 'accent' : ''}" id="auSave" ${admin && A.dirty ? '' : 'disabled'} title="${admin ? (A.dirty ? '' : 'مفيش تعديلات لحفظها') : 'ADMIN فقط'}">${ICONS.history} حفظ كنسخة جديدة</button></div></section>`;
}
function readyTable() {
  const rows = A.rd.products; if (!rows.length) return '<div class="opx-empty">مفيش منتجات.</div>';
  return `<table class="opx-table"><thead><tr><th>المنتج</th><th>الحالة</th><th>الناقص</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td><b>${E(r.name || r.productId)}</b></td><td>${pill(r.ready ? 'جاهز لـAUTOMATIC' : r.state === 'PARTIAL' ? 'جزئي' : 'ناقص', r.ready ? 'green' : r.state === 'PARTIAL' ? 'amber' : 'red')}</td><td>${r.missing.length ? r.missing.map((m) => `<small class="opx-why" style="display:block">${E(m.label)}${m.detail ? ` — ${E(m.detail)}` : ''}</small>`).join('') : '—'}</td><td><button class="opx-btn sm" data-sum="${r.productId}" data-st="${E(r.storeId)}">ملخص التفعيل</button></td></tr>`).join('')}</tbody></table>`;
}
function candTable() {
  if (A.cand.error) return `<div class="opx-note bad">⚠️ ${E(A.cand.error)}</div>`;
  if (!A.cand.candidates.length) return '<div class="opx-empty">مفيش قرارات أتمتة حاليًا (مفيش منتج مفعّل له سياسة، أو مفيش حملة بتحقق شرط).</div>';
  return `<table class="opx-table"><thead><tr><th>القرار</th><th>الحملة</th><th>الوضع</th><th>السبب</th><th>موانع</th></tr></thead><tbody>${A.cand.candidates.map((c) => { const e = EFF[c.effective] || ['gray', c.effective]; const bl = [...c.blockers, ...c.autoBlockers]; return `<tr><td><b>${E(c.kindLabel)}</b>${c.toBudget != null ? `<small style="display:block">${egp(c.fromBudget)} ← ${egp(c.toBudget)}</small>` : ''}</td><td>${E(c.campaignName)}<small style="display:block;color:var(--opx-muted)">${E(c.productName || '')}</small></td><td>${pill(e[1], e[0])}${c.canExecuteNow ? '' : c.effective === 'AUTOMATIC' ? `<small class="opx-why">مش هينفّذ: صلاحية «${E(c.permission)}» مقفولة</small>` : ''}</td><td>${E(c.reason)}</td><td>${bl.length ? bl.map((b) => `<small class="opx-why"><span class="bad">${E(b.message || b.code)}</span></small>`).join('') : '—'}</td></tr>`; }).join('')}</tbody></table>`;
}
function wire() {
  const f = A.form; const bindT = (id, k) => { const el = $(id); if (el) el.onchange = () => { f[k] = el.checked; mark(); }; }; const bindV = (id, k) => { const el = $(id); if (el) el.oninput = () => { f[k] = el.value; mark(); }; };
  const mark = () => { A.dirty = true; const sv = $('auSave'); if (sv) { sv.disabled = !A.ctx.isAdmin; sv.classList.add('accent'); } };
  bindT('auSC', 'scheduledClose'); bindT('auZE', 'zeroEnabled'); bindT('auHE', 'highEnabled'); bindT('auSO', 'stockEnabled'); bindT('auWN', 'winner');
  bindV('auZS', 'zeroSpend'); bindV('auHA', 'highAbove'); bindV('auHP', 'highMinP'); bindV('auHS', 'highMinSpend'); bindV('auXP', 'exProducts'); bindV('auIP', 'inProducts'); bindV('auXS', 'exStores'); bindV('auIS', 'inStores'); bindV('auXC', 'exCampaigns'); bindV('auIC', 'inCampaigns');
  if ($('auPR')) $('auPR').onchange = (e) => { f.precedence = e.target.value; mark(); };
  A.root.querySelectorAll('[data-auday]').forEach((b) => { b.onclick = () => { const d = Number(b.dataset.auday); f.days = f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d]; mark(); b.classList.toggle('on'); }; });
  const err = (m) => { $('auErr').innerHTML = m ? `<div class="opx-note bad">⚠️ ${E(m)}</div>` : ''; };
  if ($('auSave')) $('auSave').onclick = async () => { try { const r = await api.put('/api/operator/pause-policy', patchOf(f)); A.dirty = false; A.form = null; toast(r.changed ? `اتحفظت نسخة v${r.policy.version} — مفيش حاجة اتوقفت، والاعتماد خطوة منفصلة` : 'مفيش تغيير يتحفظ'); await load(); } catch (e) { err((e.details || [e.message]).join(' ')); } };
  if ($('auPOn')) $('auPOn').onclick = async () => { const to = !A.pp.policy.enabled; if (A.dirty) return err('احفظ التعديلات الأول.');
    if (!(await confirmModal({ title: to ? 'اعتماد سياسة الإيقاف' : 'إيقاف سياسة الإيقاف', message: to ? `هتتعتمد النسخة v${A.pp.policy.version}. الاعتماد لا يوقف أي حملة بنفسه؛ المحرك هيستخدمها فقط للمنتجات اللي في وضع AUTOMATIC وجاهزة، وبعد بوابات الأمان.` : 'السياسة هتتقفل والمحرك مش هيوقف حاجة تلقائيًا.', confirmLabel: to ? 'اعتمد' : 'أوقف', danger: !to }))) return;
    try { await api.post('/api/operator/pause-policy/enable', { enabled: to, confirm: true }); toast(to ? 'اتعتمدت — مفيش حملة اتوقفت' : 'اتقفلت'); await load(); } catch (e) { err((e.details || [e.message]).join(' ')); } };
  if ($('auTick')) $('auTick').onclick = async () => { if (!(await confirmModal({ title: 'تشغيل دورة الأتمتة الآن', message: 'نفس الدورة اللي بتشتغل كل 10 دقايق، وبنفس بوابات الأمان. لو كل البوابات مقفولة مفيش أي تنفيذ هيحصل.', confirmLabel: 'شغّل' }))) return;
    try { const r = await api.post('/api/operator/automation/tick', { confirm: true }); toast(r.skipped ? `اتخطّت: ${r.skipped}` : r.stale ? 'بيانات Meta قديمة — مفيش تنفيذ' : `تقييم ${r.evaluated} · نُفّذ ${(r.executed || []).length}${(r.gate || []).length ? ' · بوابات مقفولة: ' + r.gate.join('،') : ''}`, (r.executed || []).length ? undefined : 'warning'); await load(); } catch (e) { toast(e.message, 'error'); } };
  A.root.querySelectorAll('[data-sum]').forEach((b) => { b.onclick = () => summary(b.dataset.sum, b.dataset.st); });
}
async function summary(productId, storeId) {
  openDrawer({ title: 'ملخص التفعيل', body: skeletonRows(4) });
  try {
    const s = await api.get(`/api/operator/automation/activation-summary/${productId}`, { storeId });
    const chk = s.readiness.checks.map((c) => `<tr><td>${c.ok ? '✅' : c.required ? '⛔' : 'ℹ️'}</td><td>${E(c.label)}${c.detail ? `<small style="display:block;color:var(--opx-muted)">${E(c.detail)}</small>` : ''}</td><td>${c.fix ? `<button class="opx-btn sm" data-fix="${E(c.fix.tab)}">${E(c.fix.label)}</button>` : ''}</td></tr>`).join('');
    const body = `<div class="opx-notice ${s.canActivate ? 'green' : 'red'}"><div class="grow"><b>${E(s.name || 'المنتج')} — ${s.canActivate ? 'جاهز لـAUTOMATIC' : 'ناقص — مينفعش AUTOMATIC'}</b><small>المخاطر: ${E(s.risk.level)}${s.risk.reasons.length ? ' — ' + E(s.risk.reasons.join('، ')) : ''}</small></div></div>
      <h4>النطاق</h4><p class="opx-note">${num(s.scope.campaigns.length)} حملة (${num(s.scope.activeCount)} شغالة) · سياسة المنتج: ${E(s.policy.status)} v${s.policy.version} · وضع المنتج: ${E(s.policy.mode || '—')} · وضع النظام: ${E(s.global.mode)}</p>
      <h4>نسخ السياسات</h4><p class="opx-note">الفتح: ${s.versions.openCpa ? `v${s.versions.openCpa.version} (معتمدة: ${s.versions.openCpa.approvedVersion ?? 'لا'})` : '—'} · الإيقاف: v${s.versions.pausePolicy.version} (معتمدة: ${s.versions.pausePolicy.approvedVersion ?? 'لا'})</p>
      <h4>العمليات</h4><table class="opx-table"><tbody>${s.operations.map((o) => `<tr><td>${E(o.label)}</td><td>${o.permissionOn ? pill('الصلاحية مفتوحة', 'green') : pill('الصلاحية مقفولة', 'gray')}</td><td>${o.policyApproved ? pill('سياسة معتمدة', 'green') : pill('مفيش سياسة معتمدة', 'amber')}</td><td>${o.willRun ? '<b>هتشتغل</b>' : 'مش هتشتغل'}</td></tr>`).join('')}</tbody></table>
      <h4>أقصى تعرّض</h4><p class="opx-note">شغال دلوقتي: ${s.exposure.runningBudget != null ? egp(s.exposure.runningBudget) : 'غير معروف'} · الحد اليومي: ${s.exposure.maxDailyCap != null ? egp(s.exposure.maxDailyCap) : '<b>غير محدد</b>'} · المتاح: ${s.exposure.headroom != null ? egp(s.exposure.headroom) : '—'} · لكل حملة: ${s.exposure.minPerCampaign ?? '—'} – ${s.exposure.maxPerCampaign ?? '—'}</p>
      <h4>الشروط</h4><table class="opx-table"><tbody>${chk}</tbody></table><p class="opx-note">${E(s.note)}</p>`;
    openDrawer({ title: `ملخص التفعيل — ${E(s.name || productId)}`, body });
    document.querySelectorAll('[data-fix]').forEach((b) => { b.onclick = () => { closeDrawer(); window.dispatchEvent(new CustomEvent('opx:open', { detail: CHECK_TAB[b.dataset.fix] || b.dataset.fix })); }; });
  } catch (e) { openDrawer({ title: 'ملخص التفعيل', body: `<div class="opx-note bad">⚠️ ${E(e.message)}</div>` }); }
}
