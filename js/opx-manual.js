// opx-manual.js — «التشغيل اليدوي» + the manual budget panel inside «إدارة الميزانيات». A REAL manual mode: pick ONE campaign and ONE operation (open · pause · increase · reduce) → live preflight from Meta → explicit confirmation of
// that exact change → result with the independent Meta read-back. Budget changes know the budget STRUCTURE: CBO = the campaign's own budget; ABO = ONE ad set the owner picks (id · name · status · live budget · eligibility) —
// the other ad sets are never changed. Presentation only: every rule (gate, permissions, caps, cooldown, bounds, conflicts, confirmation token) lives on the server; a blocked operation always says WHY and what to do.
import { api } from './api-client.js';
import { E, num, egp, ICONS, pill, skeletonRows, openDrawer, closeDrawer, toast, confirmModal, $ } from './opx-ui.js';

const OPS = { OPEN: ['فتح', 'play'], PAUSE: ['إيقاف', 'pause'], INCREASE: ['زيادة ميزانية', 'plus'], REDUCE: ['تقليل ميزانية', 'budget'] };
const STAGES = ['جاري التجهيز', 'جاري التحقق', 'بانتظار تأكيدك', 'جاري التنفيذ', 'جاري التحقق من Meta', 'تم'];
const FINAL_TONE = { VERIFIED: ['green', 'تم — اتأكد من Meta'], EXECUTED: ['amber', 'اتبعت — لسه مفيش تأكيد (Uncertain)'], UNCERTAIN: ['amber', 'غير مؤكد'], FAILED: ['red', 'فشل'], BLOCKED: ['red', 'اتمنع'], SHADOW: ['blue', 'محاكاة فقط'] };
const ACK_AR = { ADSET_PAUSED: 'الـAd Set موقوف', CAMPAIGN_NOT_ACTIVE: 'الحملة موقوفة', RECENT_BUDGET_CHANGE: 'ميزانية اتغيّرت قريب', MANUAL_OVERRIDE_RECENT: 'تعديل يدوي حديث من Meta' };
const stageBar = (i) => `<ol class="opx-stages" aria-label="مراحل التنفيذ" style="display:flex;gap:6px;flex-wrap:wrap;padding:0;margin:8px 0;list-style:none">${STAGES.map((s, n) => `<li>${pill(`${n + 1}. ${s}`, n < i ? 'green' : n === i ? 'violet' : 'gray')}</li>`).join('')}</ol>`;
const lvlAr = (l) => (l === 'adset' ? 'Ad Set (ABO)' : 'الحملة (CBO)');

/** One panel instance (the workspace and the budget screen each get their own state). opts.budgetOnly hides open / pause. */
function createPanel(root, ctx, { budgetOnly = false } = {}) {
  const M = { list: [], q: '', args: null, pre: null, st: null, pick: null };
  const admin = ctx.isAdmin;
  async function load() {
    try { const r = await api.get('/api/operator/manual/targets', { q: M.q }); M.list = r.campaigns || []; } catch (e) { root.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message)}</div>`; return; }
    draw();
  }
  function draw() {
    root.innerHTML = `
      ${budgetOnly ? '' : `<div class="opx-card opx-head opx-fade"><div class="opx-head-icon violet">${ICONS.key}</div><div class="grow"><h1>التشغيل اليدوي</h1><p>اختار حملة وعملية — السيستم بيقرأ حالتها الحية من Meta ويعرضلك التغيير بالظبط، ومفيش تنفيذ إلا بعد تأكيدك الصريح.</p></div></div>
      <div class="opx-notice ${admin ? 'blue' : 'amber'}"><div class="grow"><b>${admin ? 'كل عملية بتتأكد لوحدها' : 'العرض فقط — التنفيذ لـ ADMIN'}</b><small>نفس بوابات الأمان: إيقاف الطوارئ · قفل Meta · صلاحية العملية نفسها · الحدود والتعارضات. لو أي حاجة منهم قافلة هتشوف السبب بالظبط ومش هيتبعت أي حاجة لـMeta. في وضع SHADOW بيتسجل محاكاة فقط.</small></div></div>`}
      <div class="opx-card opx-filters"><input class="opx-input opx-search" id="${budgetOnly ? 'bmQ' : 'mnQ'}" placeholder="ابحث باسم الحملة أو الرقم…" value="${E(M.q)}"></div>
      <div class="opx-card opx-tablecard opx-fade" ${budgetOnly ? 'id="bmCard"' : ''}><div class="opx-tablehead"><h3>${budgetOnly ? 'تعديل ميزانية يدوي — اختار حملة (CBO أو ABO)' : 'الحملات'} (${num(M.list.length)})</h3></div><div class="opx-scroll">${M.list.length ? table() : '<div class="opx-empty">مفيش حملات مطابقة.</div>'}</div></div>`;
    $(budgetOnly ? 'bmQ' : 'mnQ').onchange = (e) => { M.q = e.target.value; load(); };
    root.querySelectorAll('[data-mop]').forEach((b) => { b.onclick = () => begin(b.dataset.cid, b.dataset.mop); });
  }
  function table() {
    return `<table class="opx-table"><thead><tr><th>الحملة</th><th>الحالة</th><th>نوع الميزانية</th><th class="num">الميزانية</th><th>الربط</th><th>عمليات</th></tr></thead><tbody>${M.list.map((c) => {
      const ops = budgetOnly ? ['INCREASE', 'REDUCE'] : c.status === 'PAUSED' ? ['OPEN', 'INCREASE', 'REDUCE'] : ['PAUSE', 'INCREASE', 'REDUCE'];
      const kind = c.budgetKind === 'ABO' ? pill(`ABO · ${num(c.adsetCount)} Ad Set`, 'violet') : c.budgetKind === 'CBO' ? pill('CBO', 'blue') : pill('غير معروفة', 'amber', 'مفيش ميزانية معروفة من آخر مزامنة — بتتقرأ لايف عند المعاينة');
      return `<tr><td><b>${E(c.name || c.id)}</b><small style="display:block;color:var(--opx-muted)">${E(c.id)}</small></td><td>${pill(c.status === 'ACTIVE' ? 'شغالة' : 'موقوفة', c.status === 'ACTIVE' ? 'green' : 'gray')}</td><td>${kind}</td><td class="num">${c.budget != null ? egp(c.budget) : '—'}${c.budgetKind === 'ABO' ? '<small style="display:block;color:var(--opx-muted)">مجموع الـAd Sets</small>' : ''}</td><td>${c.verified ? pill('مؤكد', 'green') : c.mapped ? pill('غير مؤكد', 'amber') : pill('غير مربوط', 'red')}</td>
        <td><div style="display:flex;gap:6px;flex-wrap:wrap">${ops.map((o) => `<button class="opx-btn sm" data-cid="${E(c.id)}" data-mop="${o}" ${admin ? '' : 'disabled'} title="${admin ? '' : 'ADMIN فقط'}">${ICONS[OPS[o][1]]} ${OPS[o][0]}</button>`).join('')}</div></td></tr>`;
    }).join('')}</tbody></table>`;
  }
  async function begin(campaignId, operation) {
    const c = M.list.find((x) => x.id === campaignId); M.args = { campaignId, operation, name: c?.name || campaignId }; M.st = null; M.pick = null;
    if (['INCREASE', 'REDUCE'].includes(operation)) return budgetStep();
    openDrawer({ title: `${OPS[operation][0]} — معاينة`, body: stageBar(0) + skeletonRows(3) }); await preflight({});
  }
  // ---- budget: read the LIVE structure, pick the ad set (ABO), choose the new budget
  async function budgetStep() {
    const a = M.args; openDrawer({ title: `${OPS[a.operation][0]} — ${E(a.name)}`, body: stageBar(0) + skeletonRows(4) });
    try { M.st = await api.get(`/api/operator/manual/structure/${a.campaignId}`); } catch (e) { openDrawer({ title: 'تعذّرت قراءة الميزانية', body: `<div class="opx-note bad">⚠️ ${E(e.message)}</div><p class="opx-note">مفيش أي تنفيذ حصل.</p>` }); return; }
    const s = M.st; if (s.level === 'CBO') M.pick = s.entities[0]?.id; else if (s.level === 'ABO' && s.entities.filter((e) => e.eligibility.ok).length === 1) M.pick = s.entities.find((e) => e.eligibility.ok).id; else M.pick = null;
    drawBudget();
  }
  const cur = () => M.st?.entities?.find((e) => e.id === M.pick) || null;
  function drawBudget() {
    const s = M.st, a = M.args, sign = a.operation === 'INCREASE' ? 1 : -1, lim = s.limits || {}, e0 = cur();
    const issues = (s.issues || []).map((i) => `<div class="opx-notice red"><div class="grow"><b>${E(i.message)}</b><small>${E(i.code)} — مفيش تعديل ممكن على الحملة دي.</small></div></div>`).join('');
    const header = `<p class="opx-note">${E(s.campaign.name || '')} · <b>${s.level === 'CBO' ? 'CBO — الميزانية على الحملة نفسها' : s.level === 'ABO' ? 'ABO — الميزانية على الـAd Sets' : E(s.level)}</b> · الحد الأقصى للتغيير في الأكشن الواحد <b>${num(lim.maxChangePct)}%</b>${lim.minDaily != null ? ` · أدنى ميزانية ${egp(lim.minDaily)}` : ''}</p>`;
    const rows = s.level === 'ABO' ? `<table class="opx-table"><thead><tr><th></th><th>الـAd Set</th><th>الحالة</th><th class="num">الميزانية الحية</th><th>الأهلية</th></tr></thead><tbody>${s.entities.map((e) => `<tr ${e.eligibility.ok ? '' : 'style="opacity:.55"'}><td><input type="radio" name="bmPick" value="${E(e.id)}" ${e.eligibility.ok ? '' : 'disabled'} ${M.pick === e.id ? 'checked' : ''} aria-label="${E(e.name || e.id)}"></td><td><b>${E(e.name || e.id)}</b><small style="display:block;color:var(--opx-muted)">${E(e.id)}</small></td><td>${pill(E(e.status === 'ACTIVE' ? (e.effective === 'ACTIVE' ? 'شغال' : e.effective) : e.status), e.status === 'ACTIVE' && e.effective === 'ACTIVE' ? 'green' : 'gray')}</td><td class="num">${e.budget != null ? egp(e.budget) + (e.budgetType === 'LIFETIME' ? ' (Lifetime)' : '') : '—'}</td><td>${e.eligibility.ok ? (e.eligibility.ack ? pill('بتأكيد', 'amber', e.eligibility.message) : pill('مؤهل', 'green')) : `<small class="opx-why"><span class="bad">${E(e.eligibility.message)}</span></small>`}</td></tr>`).join('')}<tr><td></td><td colspan="2"><b>إجمالي ميزانيات الـAd Sets</b></td><td class="num"><b>${egp(s.totals.adsetsAll)}</b></td><td><small>شغّال فعليًا: ${egp(s.totals.adsetsDelivering)}</small></td></tr></tbody></table>` : s.level === 'CBO' ? `<div class="opx-kv"><span>ميزانية الحملة الحالية</span><b>${egp(s.campaign.budget)}</b></div>` : '';
    const pctBtns = [10, 20].filter((p) => p <= (lim.maxChangePct || 20)).map((p) => `<button class="opx-btn sm" data-pct="${p}">${sign > 0 ? '+' : '−'}${p}%</button>`).join(' ');
    const body = `${stageBar(1)}${issues}${header}${rows}${e0 ? `<div class="opx-card" style="padding:12px;margin-top:10px"><p class="opx-note"><b>${E(e0.name || e0.id)}</b> (${lvlAr(e0.level)}) — الميزانية الحالية <b>${egp(e0.budget)}</b></p>
      <label class="opx-field"><span>الميزانية اليومية الجديدة (جنيه)</span><input class="opx-input" id="bmTo" inputmode="numeric" placeholder="${Math.round(e0.budget * (1 + sign * 0.2))}"></label><div style="margin:6px 0">${pctBtns}</div><div id="bmCalc" class="opx-note"></div></div>` : (s.level === 'ABO' ? '<p class="opx-note">اختار الـAd Set اللي هتغيّر ميزانيته — الباقي مش هيتغيّر.</p>' : '')}
      <div style="margin-top:10px"><button class="opx-btn primary" id="bmPre" ${e0 ? '' : 'disabled'}>معاينة من Meta</button></div>`;
    openDrawer({ title: `${OPS[a.operation][0]} — ${E(a.name)}`, body });
    document.querySelectorAll('[name="bmPick"]').forEach((r) => { r.onchange = () => { M.pick = r.value; drawBudget(); }; });
    const inp = $('bmTo'); const calc = () => { if (!inp || !e0) return; const to = Number(inp.value); const out = $('bmCalc'); if (!inp.value) { out.innerHTML = ''; return; } const d = to - e0.budget, p = e0.budget ? (d / e0.budget) * 100 : 0; const wrongDir = (sign > 0 && d <= 0) || (sign < 0 && d >= 0); const tooBig = Math.abs(p) > (lim.maxChangePct || 20) + 0.5;
      out.innerHTML = `<b>${egp(e0.budget)} ← ${egp(to)}</b> · التغيير ${d >= 0 ? '+' : ''}${num(d)} ج (${p >= 0 ? '+' : ''}${num(p, 1)}%)${s.level === 'ABO' ? ` · إجمالي الـAd Sets ${egp(s.totals.adsetsAll)} ← <b>${egp(s.totals.adsetsAll + d)}</b>` : ''}${wrongDir ? '<br><span class="bad">⚠️ الاتجاه مش مطابق للعملية</span>' : ''}${tooBig ? `<br><span class="bad">⚠️ أكبر من الحد المسموح (${num(lim.maxChangePct)}%)</span>` : ''}`; };
    if (inp) inp.oninput = calc; document.querySelectorAll('[data-pct]').forEach((b) => { b.onclick = () => { inp.value = Math.round(e0.budget * (1 + sign * Number(b.dataset.pct) / 100)); calc(); }; });
    if ($('bmPre')) $('bmPre').onclick = () => { const to = Number($('bmTo').value); if (!(to > 0)) return toast('اكتب الميزانية الجديدة', 'warning'); preflight({ toBudget: to, entityId: M.pick, level: s.entityLevel }); };
  }
  async function preflight(extra) {
    const a = M.args; M.args = { ...a, ...extra };
    openDrawer({ title: `${OPS[a.operation][0]} — معاينة`, body: stageBar(1) + skeletonRows(3) });
    try { M.pre = await api.post('/api/operator/manual/preflight', { campaignId: a.campaignId, entityId: extra.entityId ?? null, level: extra.level ?? null, operation: a.operation, toBudget: extra.toBudget ?? null }); } catch (e) { openDrawer({ title: 'تعذّرت المعاينة', body: `<div class="opx-note bad">⚠️ ${E(e.message)}</div><p class="opx-note">مفيش أي تنفيذ حصل.</p>` }); return; }
    showPre();
  }
  const HELP = { PERMISSION_OFF: ' — الخطوة المطلوبة: فعّل صلاحية العملية من «صلاحيات التنفيذ» (ADMIN + تأكيد).', META_WRITES_LOCKED: ' — قفل كتابة Meta بيتفتح بقرار نشر صريح فقط.', EMERGENCY_STOP: ' — ألغِ إيقاف الطوارئ الأول.', SCALING_COOLDOWN: ' — استنى انتهاء فترة التهدئة.', CHANGE_PCT_TOO_LARGE: ' — قسّم التغيير على أكتر من خطوة.', BUDGET_CAP: ' — ارفع الحد من «حدود الميزانية» أو قلّل الزيادة.' };
  function showPre() {
    const p = M.pre; const ack = p.requiresAck || []; const im = p.impact;
    const why = p.executeBlockedBy ? `<div class="opx-notice red"><div class="grow"><b>التنفيذ ممنوع الآن: ${E(p.executeBlockedBy.message)}</b><small>الكود: ${E(p.executeBlockedBy.code)}${HELP[p.executeBlockedBy.code] || ''}</small></div></div>` : '';
    const rows = [['الحملة', E(p.campaignName || p.name || p.campaignId)], ...(p.level === 'adset' ? [['الـAd Set المحدد', `<b>${E(p.entityName || p.entityId)}</b> <small>${E(p.entityId)}</small>`]] : []), ['المستوى', lvlAr(p.level)], ['المنتج', E(p.identity?.productName || 'غير مربوط')], ['الحالة الحالية على Meta', `${E(p.current.status)}${p.current.budget != null ? ` · ${egp(p.current.budget)}` : ''}`], ['بعد التنفيذ', `<b>${E(p.proposed.status)}${p.proposed.budget != null ? ` · ${egp(p.proposed.budget)}` : ''}</b>`],
      ...(p.change ? [['التغيير', `${p.change.delta >= 0 ? '+' : ''}${num(p.change.delta)} ج (${p.change.deltaPct >= 0 ? '+' : ''}${num(p.change.deltaPct, 1)}%)`]] : []), ['التغيير المتوقع في Meta', E(p.expectedMetaChange)], ['أثر الصرف اليومي', p.exposureDelta == null ? '—' : `${p.exposureDelta > 0 ? '+' : ''}${egp(p.exposureDelta)}`], ['وضع النظام', E(p.mode) + (p.simulation ? ' (محاكاة)' : '')]];
    const abo = im?.abo ? `<h4>إجمالي ميزانيات الـAd Sets</h4><p class="opx-note">${egp(im.abo.adsetsTotalBefore)} ← <b>${egp(im.abo.adsetsTotalAfter)}</b> · الشغّال فعليًا ${egp(im.abo.deliveringBefore)} ← ${egp(im.abo.deliveringAfter)}<br>اللي <b>مش هيتغيّر</b>: ${im.abo.untouched.map((x) => `${E(x.name || x.id)} (${egp(x.budget)})`).join('، ') || '—'}</p>` : '';
    const caps = im?.caps ? `<h4>الحدود</h4><table class="opx-table"><tbody>${['campaign', 'product', 'account'].map((k) => { const c = im.caps[k]; const lb = { campaign: 'الحملة', product: 'المنتج', account: 'الحساب' }[k]; return `<tr><td>${lb}</td><td>${c.cap == null ? 'بدون حد' : `الحد ${egp(c.cap)} · الحالي ${egp(c.current)} ← ${egp(c.after)} ${c.ok === false ? pill('هيتجاوز', 'red') : pill('داخل الحد', 'green')}`}</td></tr>`; }).join('')}</tbody></table>` : '';
    const body = `${stageBar(2)}<table class="opx-table"><tbody>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</tbody></table>${abo}${caps}
      ${p.blockers.map((b) => `<div class="opx-note bad">⛔ ${E(b.message)}</div>`).join('')}${why}
      ${p.warnings.map((w) => `<label class="opx-note" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-ack="${E(w.code)}"> ⚠️ ${E(w.message)} <b>(لازم تؤكد)</b></label>`).join('')}
      <p class="opx-note">${E(p.note)} — المعاينة صالحة لحد ${E(new Date(p.expiresAt).toLocaleTimeString('ar-EG'))}.</p>
      <div style="display:flex;gap:8px"><button class="opx-btn primary" id="mnGo" ${p.canExecute ? '' : 'disabled'} title="${p.canExecute ? '' : E(p.executeBlockedBy?.message || '')}">${p.simulation ? 'تسجيل محاكاة' : 'تنفيذ فعلي على Meta'}</button><button class="opx-btn ghost" id="mnNo">إلغاء</button></div>`;
    openDrawer({ title: `${p.label} — ${E(p.entityName || p.name || p.campaignId)}`, body });
    const go = $('mnGo'); const need = () => ack.every((c) => document.querySelector(`[data-ack="${c}"]`)?.checked); const sync = () => { if (go && p.canExecute) go.disabled = !need(); }; document.querySelectorAll('[data-ack]').forEach((c) => { c.onchange = sync; }); sync();
    $('mnNo').onclick = () => { closeDrawer(); toast('اتلغت — مفيش أي تنفيذ'); };
    if (go) go.onclick = () => execute(p);
  }
  async function execute(p) {
    const acks = [...document.querySelectorAll('[data-ack]:checked')].map((c) => c.dataset.ack);
    if (!(await confirmModal({ title: p.simulation ? 'تسجيل محاكاة' : 'تأكيد التنفيذ على Meta', message: `${p.label}: ${p.entityName || p.name || p.campaignId}${p.level === 'adset' ? `\nAd Set: ${p.entityId} (الحملة ${p.campaignName || p.campaignId})` : ''}\nمن ${p.current.status}${p.current.budget != null ? ' / ' + p.current.budget : ''}  ←  ${p.proposed.status}${p.proposed.budget != null ? ' / ' + p.proposed.budget : ''}${p.change ? `  (${p.change.deltaPct >= 0 ? '+' : ''}${p.change.deltaPct}%)` : ''}\n${p.simulation ? 'مفيش كتابة على Meta (SHADOW).' : 'هيتبعت طلب واحد لـMeta وبعده قراءة مستقلة للتأكد.'}`, confirmLabel: p.simulation ? 'سجّل' : 'نفّذ', danger: !p.simulation }))) return;
    openDrawer({ title: p.label, body: stageBar(3) + skeletonRows(2) });
    try {
      const r = await api.post('/api/operator/manual/execute', { campaignId: p.campaignId, entityId: p.entityId, level: p.level, operation: p.operation, confirm: { ...p.confirm, ack: acks } });
      const f = FINAL_TONE[r.status] || ['gray', r.status]; const done = r.simulated ? 5 : r.verified ? 5 : 4;
      openDrawer({ title: 'النتيجة', body: `${stageBar(done)}<div class="opx-notice ${f[0] === 'green' ? 'green' : f[0] === 'red' ? 'red' : 'amber'}"><div class="grow"><b>${E(f[1])}</b><small>${E(r.message || '')}</small></div></div><p class="opx-note">اتسجّلت في «سجل التنفيذ» كعملية يدوية${r.verified ? ' ومتأكدة بقراءة Meta' : ''}.</p><button class="opx-btn" id="mnHist">افتح سجل التنفيذ</button>` });
      $('mnHist').onclick = () => { closeDrawer(); window.dispatchEvent(new CustomEvent('opx:open', { detail: 'history' })); };
      toast(r.verified ? 'اتنفذ واتأكد من Meta' : r.simulated ? 'اتسجّلت محاكاة' : 'راجع النتيجة', r.verified || r.simulated ? undefined : 'warning'); await load();
    } catch (e) { openDrawer({ title: 'ما اتنفذش', body: `${stageBar(2)}<div class="opx-notice red"><div class="grow"><b>${E(e.message)}</b><small>${E(e.code || '')} — مفيش أي حاجة اتبعتت لـMeta${e.code === 'STATE_CHANGED' ? '. الحالة اتغيّرت من وقت المعاينة، اعمل معاينة جديدة.' : ''}.</small></div></div>` }); }
  }
  return { load };
}

export async function mountManualWorkspace(root, ctx) { root.innerHTML = `<div class="opx-card">${skeletonRows(5)}</div>`; await createPanel(root, ctx).load(); }
/** the manual increase / reduce panel shown inside «إدارة الميزانيات» (CBO and ABO) */
export async function mountBudgetPanel(root, ctx) { root.innerHTML = `<div class="opx-card">${skeletonRows(3)}</div>`; await createPanel(root, ctx, { budgetOnly: true }).load(); }
