// opx-automation-console.js — the AUTOMATIC control panel: safety state · GLOBAL rules (versioned, inherited by every enrolled product) · ONE table of every product (READY / NEEDS_CONFIGURATION / BLOCKED) ·
// bulk draft configuration · bulk preview · GATED bulk activation (exact confirmed numbers) · excluded campaigns · latest operations and errors.
// Presentation over /api/operator/automation/{global-rules,overview,bulk/*}. Every button either does its job or says exactly why it cannot. Nothing here sends anything to Meta.
import { api } from './api-client.js';
import { E, $, num, egp, ago, ICONS, pill, openDrawer, closeDrawer, toast, confirmModal, skeletonRows } from './opx-ui.js';

const C = { root: null, ctx: null, ov: null, gr: null, hist: null, sel: new Set(), prev: null, reload: null };
const DAYS = [[6, 'سبت'], [0, 'أحد'], [1, 'اتنين'], [2, 'تلات'], [3, 'أربع'], [4, 'خميس'], [5, 'جمعة']];
const STATE = { READY: ['green', 'READY'], NEEDS_CONFIGURATION: ['amber', 'NEEDS_CONFIGURATION'], BLOCKED: ['red', 'BLOCKED'] };
const V = (x) => (x === null || x === undefined ? '' : x);
const FIELDS = [
  ['cpa.normalMin', 'CPA الطبيعي — من (Minimum)'], ['cpa.normalMax', 'CPA الطبيعي — إلى (Maximum)'], ['cpa.scale', 'CPA الزيادة (Scale ≤)'], ['cpa.reduce', 'CPA التقليل (Reduce ≥)'], ['cpa.hardStop', 'Hard Stop CPA'],
  ['zeroOrder.spend', 'حد الصرف بدون أوردرات (ج)'], ['zeroOrder.minAgeHours', 'أقل عمر للحملة (ساعات)'], ['budget.minPurchases', 'أقل عدد أوردرات'],
  ['budget.increasePct', 'نسبة الزيادة %'], ['budget.decreasePct', 'نسبة التقليل %'], ['budget.minBudget', 'أقل ميزانية للحملة'], ['budget.maxBudget', 'أقصى ميزانية للحملة'],
  ['budget.dailySpendCap', 'سقف الصرف اليومي للمنتج'], ['budget.cooldownHours', 'Cooldown (ساعات، أقل 6)'], ['budget.maxChangesPerDay', 'أقصى تعديلات في اليوم للمنتج'], ['manualOverrideHours', 'حماية التعديل اليدوي (ساعات)'],
];
const getp = (o, path) => path.split('.').reduce((x, k) => x?.[k], o);
const fieldsHtml = (pre, values, dis) => `<div class="opx-form">${FIELDS.map(([p, l]) => `<label>${E(l)}<input class="opx-input" id="${pre}_${p.replace('.', '_')}" type="number" step="any" min="0" value="${E(V(getp(values, p)))}" ${dis}></label>`).join('')}
  <label>وقت الفتح<input class="opx-input" id="${pre}_open" type="time" value="${E(V(values?.schedule?.openTime))}" ${dis}></label><label>وقت الإيقاف<input class="opx-input" id="${pre}_close" type="time" value="${E(V(values?.schedule?.closeTime))}" ${dis}></label>
  <label>سياسة المخزون غير المعروف<select class="opx-select" id="${pre}_stock" ${dis}>${[['', 'تحذير فقط (قرارك الحالي)'], ['WARN', 'تحذير فقط (WARN)'], ['BLOCK', 'حماية صارمة (BLOCK) — المخزون المجهول يمنع']].map(([k, t]) => `<option value="${k}" ${String(V(values?.stockPolicy)) === k ? 'selected' : ''}>${E(t)}</option>`).join('')}</select></label></div>
  <div><div class="opx-note" style="margin-bottom:6px">أيام التشغيل (فارغ = كل الأيام)</div><div class="opx-days" id="${pre}_days">${DAYS.map(([k, t]) => `<button type="button" class="opx-day ${values?.schedule?.days?.includes(k) ? 'on' : ''}" data-day="${k}" ${dis}>${t}</button>`).join('')}</div></div>`;
function collect(pre) {
  const n = (id) => { const x = $(id); if (!x) return null; const t = String(x.value).trim(); return t === '' ? null : Number(t); }; const t = (id) => { const x = $(id); const v = x ? String(x.value).trim() : ''; return v === '' ? null : v; };
  const p = { cpa: {}, zeroOrder: {}, budget: {}, schedule: { openTime: t(`${pre}_open`), closeTime: t(`${pre}_close`), days: [...document.querySelectorAll(`#${pre}_days .opx-day.on`)].map((d) => Number(d.dataset.day)) }, stockPolicy: t(`${pre}_stock`), manualOverrideHours: n(`${pre}_manualOverrideHours`) };
  if (!p.schedule.days.length) p.schedule.days = null;
  for (const [path] of FIELDS) { const [g, k] = path.split('.'); if (!k) continue; p[g][k] = n(`${pre}_${path.replace('.', '_')}`); }
  return p;
}

export async function mountAutomationConsole(root, ctx, { onChange } = {}) {
  C.root = root; C.ctx = ctx; C.reload = onChange || (() => mountAutomationConsole(root, ctx, { onChange })); root.innerHTML = `<div class="opx-card">${skeletonRows(5)}</div>`;
  try { [C.ov, C.gr, C.hist] = await Promise.all([api.get('/api/operator/automation/overview'), api.get('/api/operator/automation/global-rules'), api.get('/api/operator/execution-history?limit=12').catch(() => ({ rows: [] }))]); } catch (e) { root.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message)}</div>`; return; }
  draw();
}
function draw() {
  const o = C.ov, g = o.global, admin = C.ctx.isAdmin; const dis = admin ? '' : 'disabled'; const gr = C.gr;
  const safe = (ok, t) => `<span class="opx-note" style="margin-inline-end:12px">${ok ? '🟢' : '🔴'} ${t}</span>`;
  const perms = g.permissions || {}; const anyPerm = Object.values(perms).some(Boolean);
  const strip = `<section class="opx-card opx-fade" id="acStrip" style="padding:14px 16px"><h3 style="margin:0 0 8px">${ICONS.shield} حالة الأمان والأتمتة</h3><div>${safe(g.writesLocked, g.writesLocked ? 'كتابة Meta مقفولة' : 'كتابة Meta مفتوحة')}${safe(!anyPerm, anyPerm ? 'فيه صلاحية تنفيذ مفتوحة' : 'كل صلاحيات التنفيذ OFF')}${safe(!g.emergencyStop, g.emergencyStop ? 'Emergency Stop شغّال' : 'Emergency Stop مش مفعّل')}${safe(g.mode !== 'AUTOPILOT', `وضع النظام: ${E(g.mode)}`)}${safe(g.pausePolicyApproved, g.pausePolicyApproved ? 'سياسة الإيقاف معتمدة' : 'سياسة الإيقاف غير معتمدة')}${safe(g.openPolicy?.enabled && g.openPolicy.approved, g.openPolicy?.enabled ? `سياسة الفتح معتمدة (CPA ${g.openPolicy.minCpa}–${g.openPolicy.maxCpa}، ${g.openPolicy.window} أيام، ${g.openPolicy.minPurchases} أوردر)` : 'سياسة الفتح مش مفعّلة')}</div>
    <p class="opx-note" style="margin:8px 0 0">AUTOMATIC هنا = تفعيل السياسات على مستوى المنتج. التنفيذ الفعلي على Meta بيحتاج كمان: وضع النظام AUTOMATIC، فتح القفل من Railway، وصلاحيات التنفيذ — وكلهم بتتحكم فيهم إنت من أماكنهم الرسمية.</p></section>`;
  const gstat = gr.status === 'ACTIVE' ? pill(`مفعّلة v${gr.version}`, 'green') : gr.status === 'ACTIVE_WITH_DRAFT' ? pill(`مفعّلة v${gr.version} + مسودة`, 'blue') : gr.status === 'DRAFT' ? pill('مسودة', 'amber') : pill('مفيش قواعد عامة', 'gray');
  const gv = gr.draft || gr.active || {};
  const global = `<section class="opx-card opx-fade" id="acGlobal" style="padding:14px 16px"><h3 style="margin:0 0 4px">${ICONS.rules} القواعد العامة للأتمتة ${gstat}</h3>
    <p class="opx-note">كل منتج مسجّل بيورث القيم دي إلا لو عنده قيمة خاصة (أو حملته). القيمة الفاضية = مفيش قيمة (مش بتتخترع). القواعد العامة <b>مش بتفعّل AUTOMATIC لأي منتج</b> ومش بتنفّذ حاجة.</p>
    ${fieldsHtml('gl', gv, dis)}
    <div class="opx-cpa-btns"><button class="opx-btn" id="glSave" ${admin ? '' : 'disabled'}>${ICONS.history} حفظ كمسودة</button><button class="opx-btn primary" id="glAct" ${admin && gr.draft ? '' : 'disabled'} title="${gr.draft ? '' : 'احفظ مسودة الأول'}">اعتماد القواعد العامة</button>${gr.active ? `<button class="opx-btn" id="glOff" ${admin ? '' : 'disabled'}>إيقاف القواعد العامة</button>` : ''}</div>
    ${gr.history.length ? `<small class="opx-note">آخر النسخ: ${gr.history.slice(0, 4).map((h) => `v${h.version} ${E(ago(h.at))}${h.deactivated ? ' (إيقاف)' : ''}`).join(' · ')}</small>` : ''}</section>`;
  const acct = g.accountCap;
  const cap = `<section class="opx-card opx-fade" style="padding:14px 16px"><h3 style="margin:0 0 6px">${ICONS.coins} سقف التعرض اليومي للحساب</h3><div class="opx-form"><label>الحد الأقصى للصرف اليومي تحت الـAI (ج.م)<input class="opx-input" id="acCap" type="number" step="any" min="0" value="${E(V(acct))}" ${dis}></label></div><div class="opx-cpa-btns"><button class="opx-btn" id="acCapSave" ${admin ? '' : 'disabled'}>حفظ سقف الحساب</button></div><small class="opx-note">بدونه التفعيل الجماعي بيترفض. الحفظ بيطبّق الحد فورًا على أي تنفيذ؛ مفيش حاجة بتتنفذ بالحفظ.</small></section>`;
  const t = o.totals; const sel = C.sel;
  const row = (p) => { const st = STATE[p.state]; const l = p.limits; return `<tr data-k="${E(p.key)}"><td><input type="checkbox" class="opx-check" data-pick="${E(p.key)}" ${sel.has(p.key) ? 'checked' : ''}></td><td><b>${E(p.name)}</b><small style="display:block;color:var(--opx-muted)">#${p.productId} · ${E(p.storeId)}</small></td><td>${pill(st[1], st[0])}</td>
    <td class="num">${num(p.orders7)}</td><td class="num">${p.cpa.d3 ?? '—'} / ${p.cpa.d7 ?? '—'} / ${p.cpa.d30 ?? '—'}</td><td class="num">${num(p.campaigns.active)}/${num(p.campaigns.mapped)}</td><td class="num">${egp(p.runningBudget)}</td>
    <td><small>Scale ${l.cpaScale ?? '—'} · Reduce ${l.cpaReduce ?? '—'} · Stop ${l.hardStop ?? '—'}<br>سقف ${l.dailyCap ?? '—'} · ${l.minBudget ?? '—'}–${l.maxBudget ?? '—'} · تعديلات/يوم ${l.maxChangesPerDay ?? '—'}</small></td>
    <td>${p.policy.status === 'NONE' ? '<small>بدون سياسة</small>' : `<small>${E(p.policy.status)} · ${E(p.policy.mode || '—')}</small>`}</td><td>${p.blockedReason ? `<small class="opx-why">⛔ ${E(p.blockedReason)}</small>` : p.missing.length ? p.missing.map((m) => `<small class="opx-why" style="display:block">${E(m.label)}${m.detail ? ' — ' + E(m.detail) : ''}</small>`).join('') : '<small>—</small>'}</td></tr>`; };
  const table = `<section class="opx-card opx-tablecard opx-fade" id="acTable"><div class="opx-tablehead"><h3>كل المنتجات (${num(t.products)}) — ${pill(`READY ${t.READY}`, 'green')} ${pill(`NEEDS_CONFIGURATION ${t.NEEDS_CONFIGURATION}`, 'amber')} ${pill(`BLOCKED ${t.BLOCKED}`, 'red')} · الشغال دلوقتي ${egp(t.runningBudget)}/يوم</h3>
      <div class="opx-cpa-btns"><button class="opx-btn sm" id="acPickReady">اختار كل الـREADY</button><button class="opx-btn sm" id="acPickNone">إلغاء الاختيار</button><button class="opx-btn sm" id="acCfg" ${admin ? '' : 'disabled'}>إعداد جماعي (مسودة)</button><button class="opx-btn sm" id="acPrev" ${admin ? '' : 'disabled'}>معاينة جماعية</button><button class="opx-btn sm primary" id="acAct" ${admin && C.prev?.canActivate ? '' : 'disabled'} title="${C.prev ? (C.prev.canActivate ? '' : 'المعاينة فيها موانع — شوفها تحت') : 'اعمل معاينة جماعية الأول'}">تفعيل جماعي</button></div></div>
    <div class="opx-scroll"><table class="opx-table"><thead><tr><th></th><th>المنتج</th><th>الحالة</th><th class="num">أوردرات 7د</th><th class="num">CPA 3/7/30</th><th class="num">حملات شغالة/مربوطة</th><th class="num">ميزانية شغالة</th><th>الحدود (موروثة + خاصة)</th><th>السياسة</th><th>الناقص / المانع</th></tr></thead><tbody>${o.products.map(row).join('') || '<tr><td colspan="10" class="opx-empty">مفيش منتجات.</td></tr>'}</tbody></table></div><div id="acPrevBox">${prevHtml()}</div></section>`;
  const ex = `<section class="opx-card opx-tablecard opx-fade"><div class="opx-tablehead"><h3>حملات مستبعدة من الأتمتة (${num(o.totals.excludedCampaigns)}) — الربط مش مؤكد أو مستثناة</h3></div><div class="opx-scroll" style="max-height:260px"><table class="opx-table"><thead><tr><th>الحملة</th><th>الحالة</th><th>السبب</th><th>تلميح المنتج</th><th class="num">صرف 7د</th></tr></thead><tbody>${o.excluded.length ? o.excluded.map((x) => `<tr><td><b>${E(x.name)}</b><small style="display:block;color:var(--opx-muted)">${E(x.campaignId)}</small></td><td>${E(x.status)}</td><td>${E(x.reason)}</td><td>${E(x.productHint || '—')}</td><td class="num">${egp(x.spend7d)}</td></tr>`).join('') : '<tr><td colspan="5" class="opx-empty">مفيش.</td></tr>'}</tbody></table></div></section>`;
  const hist = (C.hist?.rows || []); const histBox = `<section class="opx-card opx-tablecard opx-fade"><div class="opx-tablehead"><h3>آخر العمليات والأخطاء</h3></div><div class="opx-scroll" style="max-height:260px"><table class="opx-table"><thead><tr><th>الوقت</th><th>العملية</th><th>الحملة / الكيان</th><th>المصدر</th><th>النتيجة</th></tr></thead><tbody>${hist.length ? hist.map((h) => `<tr><td><small>${E(ago(h.at))}</small></td><td>${E(h.typeLabel || h.type)}${h.budgetChange ? `<small style="display:block">${h.before ?? '—'} ← ${h.after ?? '—'}</small>` : ''}</td><td>${E(h.entityName || h.campaignName || h.campaignId || '—')}</td><td><small>${E(h.originLabel || h.origin || '')}</small></td><td>${pill(E(h.finalLabel || h.final), h.final === 'VERIFIED' ? 'green' : ['FAILED', 'BLOCKED'].includes(h.final) ? 'red' : 'amber')}${h.error ? `<small class="opx-why" style="display:block">${E(String(h.error).slice(0, 120))}</small>` : ''}</td></tr>`).join('') : '<tr><td colspan="5" class="opx-empty">لا توجد عمليات.</td></tr>'}</tbody></table></div></section>`;
  C.root.innerHTML = `${strip}${cap}${global}${table}${ex}${histBox}`;
  wire();
}
function prevHtml() {
  const p = C.prev; if (!p) return '';
  const bl = p.blockers.map((b) => `<div class="opx-notice red"><div class="grow"><b>${E(b.code)}</b><small>${E(b.message)}</small></div></div>`).join('');
  return `<div style="padding:12px 16px"><h4>معاينة التفعيل الجماعي (قراءة فقط)</h4><p class="opx-note">منتجات هتتفعّل: <b>${num(p.confirm.products)}</b> · حملات مشمولة: <b>${num(p.confirm.campaigns)}</b> (شغالة ${num(p.confirm.activeCampaigns)}) · الميزانيات الشغالة المعرّضة: <b>${egp(p.exposure.running)}</b>/يوم · سقف الحساب: <b>${p.exposure.accountCap != null ? egp(p.exposure.accountCap) : 'غير محدد'}</b>${p.exposure.headroom != null ? ` · المتاح ${egp(p.exposure.headroom)}` : ''}</p>
    ${bl}${p.notIncluded.length ? `<details><summary class="opx-note">${num(p.notIncluded.length)} منتج مش مشمول</summary>${p.notIncluded.map((n) => `<small class="opx-why" style="display:block">${E(n.name)} — ${E(n.state)}: ${E(n.why)}</small>`).join('')}</details>` : ''}<p class="opx-note">${E(p.note)}</p></div>`;
}
function wire() {
  const admin = C.ctx.isAdmin; const err = (m) => toast(m, 'error');
  C.root.querySelectorAll('#gl_days [data-day]').forEach((d) => { d.onclick = () => d.classList.toggle('on'); });
  C.root.querySelectorAll('[data-pick]').forEach((c) => { c.onchange = () => { c.checked ? C.sel.add(c.dataset.pick) : C.sel.delete(c.dataset.pick); C.prev = null; const a = $('acAct'); if (a) a.disabled = true; $('acPrevBox').innerHTML = ''; }; });
  $('acPickReady').onclick = () => { C.sel = new Set(C.ov.products.filter((p) => p.state === 'READY').map((p) => p.key)); C.prev = null; draw(); };
  $('acPickNone').onclick = () => { C.sel = new Set(); C.prev = null; draw(); };
  $('acCapSave').onclick = async () => { const v = $('acCap').value.trim(); if (!(await confirmModal({ title: 'حفظ سقف الحساب اليومي', message: 'الحد ده بيحمي الحساب كله وبيتطبق فورًا على أي تنفيذ. مفيش حاجة بتتنفذ بالحفظ.', confirmLabel: 'احفظ' }))) return;
    try { await api.put('/api/operator/limits', { limits: { account: { maxDailySpendUnderAi: v === '' ? null : Number(v) } } }); toast('اتحفظ سقف الحساب'); C.reload(); } catch (e) { err((e.details || [e.message]).join(' ')); } };
  $('glSave').onclick = async () => { try { C.gr = await api.put('/api/operator/automation/global-rules', { policy: collect('gl') }); toast('اتحفظت كمسودة — لسه مش معتمدة'); draw(); } catch (e) { err((e.details || [e.message]).join(' ')); } };
  if ($('glAct')) $('glAct').onclick = async () => { if (!(await confirmModal({ title: 'اعتماد القواعد العامة', message: 'القيم هتتورّث لكل منتج مسجّل (عنده سياسة مفعّلة) إلا لو عنده قيمة خاصة. مفيش AUTOMATIC بيتفعّل ومفيش تنفيذ.', confirmLabel: 'اعتمد' }))) return;
    try { C.gr = await api.post('/api/operator/automation/global-rules/activate', { confirm: true }); toast(`اتعتمدت v${C.gr.version}`); C.reload(); } catch (e) { err(e.code === 'GLOBAL_CONFLICTS' ? `هتكسر سياسات: ${(e.details || []).map((d) => d.key).join('، ')}` : (e.details || [e.message]).join(' ')); } };
  if ($('glOff')) $('glOff').onclick = async () => { if (!(await confirmModal({ title: 'إيقاف القواعد العامة', message: 'المنتجات هترجع لقيمها الخاصة فقط. ممكن تبقى ناقصة بعد كده.', confirmLabel: 'أوقف', danger: true }))) return; try { await api.post('/api/operator/automation/global-rules/deactivate', { confirm: true }); toast('اتوقفت'); C.reload(); } catch (e) { err(e.message); } };
  $('acCfg').onclick = () => { if (!C.sel.size) return toast('اختار منتج واحد على الأقل', 'warning'); cfgDrawer(); };
  $('acPrev').onclick = async () => { try { C.prev = await api.post('/api/operator/automation/bulk/preview', { productKeys: C.sel.size ? [...C.sel] : null }); draw(); } catch (e) { err(e.message); } };
  if ($('acAct')) $('acAct').onclick = activateBulk;
}
function cfgDrawer() {
  const body = `<div class="opx-notice blue"><div class="grow"><b>إعداد جماعي لـ${num(C.sel.size)} منتج — مسودات فقط</b><small>الحقول الفاضية مش بتمسح ولا بتغيّر القيم الموجودة. مفيش تفعيل ولا تنفيذ.</small></div></div>${fieldsHtml('bk', {}, '')}`;
  openDrawer({ title: 'إعداد جماعي (مسودة)', body, foot: '<button class="opx-btn primary" id="bkGo">حفظ المسودات</button>' });
  document.querySelectorAll('#bk_days [data-day]').forEach((d) => { d.onclick = () => d.classList.toggle('on'); });
  $('bkGo').onclick = async () => { try { const r = await api.post('/api/operator/automation/bulk/configure', { productKeys: [...C.sel], patch: collect('bk') }); toast(`اتحفظت ${r.drafted.length} مسودة${r.skipped.length ? ` · اتخطى ${r.skipped.length}` : ''}`); closeDrawer(); C.prev = null; C.reload(); } catch (e) { toast((e.details || [e.message]).join(' '), 'error'); } };
}
async function activateBulk() {
  const p = C.prev; if (!p?.canActivate) return;
  if (!(await confirmModal({ title: 'تفعيل جماعي — الخطوة 1 من 2', message: `هتفعّل AUTOMATIC على ${p.confirm.products} منتج (${p.confirm.campaigns} حملة، الشغال ${p.exposure.running} ج/يوم، سقف الحساب ${p.exposure.accountCap} ج). التفعيل ده سياسات فقط — مفيش تنفيذ على Meta.`, confirmLabel: 'كمّل' }))) return;
  if (!(await confirmModal({ title: '⚠️ تأكيد AUTOMATIC — الخطوة 2 من 2', message: 'الأرقام دي هي اللي اعتمدتها بالظبط. لو اتغيّرت من وقت المعاينة التفعيل هيترفض. الاستمرار = تفعيل السياسات المعتمدة بس.', confirmLabel: 'فعّل', danger: true }))) return;
  try { const r = await api.post('/api/operator/automation/bulk/activate', { productKeys: [...C.sel], confirm: p.confirm, confirmAutomatic: true }); toast(`اتفعّل ${r.activated.length} منتج${r.skipped.length ? ` · اتخطى ${r.skipped.length}` : ''}`); C.prev = null; C.reload(); }
  catch (e) { toast(e.code === 'CONFIRM_MISMATCH' ? 'الأرقام اتغيّرت — اعمل معاينة جديدة' : (e.details?.map?.((d) => d.message).join(' · ') || e.message), 'error'); if (e.code === 'CONFIRM_MISMATCH') { C.prev = null; C.reload(); } }
}
