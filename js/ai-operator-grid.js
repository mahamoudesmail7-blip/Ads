// ai-operator-grid.js — AI Operator Setup Grid: EVERY real catalogue product (per store) in one editable table. Draft (browser) → Validate → Preview → Apply.
// Presentation only: every verdict (validation, diff, readiness, Shadow) comes from /api/operator/setup-grid*. A blank cell is never sent (never 0, never a clear).
// Pending edits live in `pending` (productId → change) so they survive scope/store/search changes and are what Draft / Validate / Preview / Apply send.
import * as UI from './ui-common.js';
import { api } from './api-client.js';
import { E, $, num, S, READY_CLS } from './ai-operator-core.js';

const DRAFT_KEY = 'opSetupGridDraft.v2';
const CELLS = [['selling_price', 'سعر البيع'], ['purchase_cost', 'تكلفة الشراء'], ['shipping', 'الشحن'], ['packaging', 'التغليف'], ['target_cpa', 'Target CPA'], ['hard_stop_cpa', 'Hard Stop CPA']];
const STOCK = [['current_stock', 'المخزون الحالي'], ['minimum_stock', 'الحد الأدنى']];
const SRC_AR = { AMB: 'AMB', CATALOG: 'الكتالوج' };
const MAP_CLS = { VERIFIED: 'green', SUGGESTED: 'amber', UNMAPPED: 'gray' };
const ADV = { ADVERTISED: ['green', 'ADVERTISED'], SUGGESTED_ONLY: ['amber', 'SUGGESTED'], NOT_ADVERTISED: ['gray', 'NOT_ADVERTISED'] };
const LINK_AR = { EO_UUID: ['green', 'EO ✓'], EO_NAME: ['green', 'EO (بالاسم)'], NOT_IN_EO_CATALOG: ['amber', 'مش في كتالوج EO'], EO_AMBIGUOUS: ['amber', 'EO غامض'], EO_UNAVAILABLE: ['gray', 'EO غير متاح'] };
const PAGE = 100;
const readDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } };
const writeDraft = (d) => { try { d ? localStorage.setItem(DRAFT_KEY, JSON.stringify(d)) : localStorage.removeItem(DRAFT_KEY); return true; } catch { return false; } };

const view = { scope: 'ALL', store: 'ALL', search: '', conflicts: false, orders: false, limit: PAGE };
const pending = new Map(); // productId -> { productId, values, zeroOrder }
let G = null; let draftOffered = false;

export async function drawSetupGrid(root) {
  root.innerHTML = '<div class="amb-panel"><div class="amb-loading">جارِ تحميل كل منتجات المتاجر…</div></div>';
  try { G = await api.get('/api/operator/setup-grid'); } catch (e) { root.innerHTML = `<div class="amb-panel op-bad">${E(e.message)}</div>`; return; }
  if (!draftOffered) { draftOffered = true; const d = readDraft(); if (d?.changes?.length) { d.changes.forEach((c) => pending.set(c.productId, c)); UI.toast(`اتسترجعت مسودة محفوظة (${d.changes.length} منتج)`); } }
  render(root);
}

const matchScope = (r) => {
  switch (view.scope) {
    case 'ADVERTISED': return r.advertising === 'ADVERTISED';
    case 'NOT_ADVERTISED': return r.advertising !== 'ADVERTISED';
    case 'READY': return r.readiness.state === 'READY';
    case 'BLOCKED': return r.readiness.state === 'BLOCKED';
    case 'PARTIAL': return r.readiness.state === 'PARTIAL';
    default: return true;
  }
};

function render(root) {
  const dis = S.isAdmin ? '' : 'disabled';
  const all = G.rows;
  const inStore = all.filter((r) => view.store === 'ALL' || r.store === view.store);
  const c = view.store === 'ALL' ? G.counts : (G.counts.byStore[view.store] || G.counts);
  const rows = inStore.filter((r) => matchScope(r) && (!view.conflicts || r.price.status === 'CONFLICT') && (!view.orders || r.orders30d > 0) && (!view.search || r.name.toLowerCase().includes(view.search.toLowerCase())));
  const shown = rows.slice(0, view.limit);
  const num_ = (k, v, orig) => `<input class="op-gc" type="number" min="0" step="any" data-k="${k}" value="${v ?? ''}" data-orig="${orig ?? ''}" ${dis} />`;
  const priceCell = (r) => {
    const p = r.price;
    if (p.status === 'CONFLICT') return `<div class="op-gconf"><input class="op-gc conflict" type="number" min="0" step="any" data-k="selling_price" value="" data-orig="" placeholder="اكتب السعر الصحيح" ${dis} /><div class="op-camp op-bad">⚠️ تعارض: ${Object.entries(p.conflict || {}).map(([k, v]) => `${{ owner: 'AMB', catalog: 'الكتالوج', storeCatalog: 'كتالوج المتجر' }[k] || k} ${num(v)}`).join(' ≠ ')}</div></div>`;
    return `${num_('selling_price', p.value, p.value)}<div class="op-camp">${p.value != null ? `${E(SRC_AR[p.source] || p.source)}${p.status === 'VERIFIED' ? ' ✓ مطابق للمتجر' : ''}` : '<span class="op-unk">MISSING</span>'}${p.suggestion ? ` · <button class="amb-link" data-sugg="${p.suggestion.value}" type="button">مقترح من كتالوج المتجر: ${num(p.suggestion.value)}</button>` : ''}</div>`;
  };
  const zoCell = (r) => `<div class="op-gzo"><select data-k="zo_mode" data-orig="${E(r.zero_order?.mode || '')}" ${dis}><option value="">—</option><option value="FIXED_SPEND" ${r.zero_order?.mode === 'FIXED_SPEND' ? 'selected' : ''}>مبلغ ثابت</option><option value="TARGET_CPA_MULTIPLE" ${r.zero_order?.mode === 'TARGET_CPA_MULTIPLE' ? 'selected' : ''}>× Target CPA</option></select>${num_('zo_value', r.zero_order?.value, r.zero_order?.value)}</div>`;
  const scopeBtn = (k, label, n) => `<button class="amb-fbtn ${view.scope === k ? 'active' : ''}" data-gs="${k}">${label} (${num(n)})</button>`;
  root.innerHTML = `
    <div class="amb-panel"><h3>📝 جدول الإعداد الشامل — كل منتجات الكتالوج (${num(all.length)} منتج في ${G.stores.length} متجر)</h3>
      <div class="op-banner blue">${E(G.note)}</div>
      <div class="op-banner amber">🔒 الحفظ هنا بيكتب في الأماكن الأصلية بس (اقتصاديات AMB / مخزون الكتالوج / إعدادات Operator). مفيش كتابة على Meta، ومفيش تحويل ربط لـVERIFIED، والوضع بيفضل SHADOW. المنتج اللي مالوش سجل AMB بيتنشأ له السجل <b>أول ما تحفظ بياناته بس</b> (مفيش إنشاء منتجات جديدة في الكتالوج). Easy Orders والمخزون الحي بيفضلوا BLOCKED لحد ما يتوصلوا فعلًا.</div>
      <div class="op-toolbar"><div class="amb-filters" style="margin:0">
        <select id="gStore" class="op-search"><option value="ALL">كل المتاجر (${num(G.counts.total)})</option>${G.stores.map((s) => `<option value="${E(s)}" ${view.store === s ? 'selected' : ''}>${E(s)} (${num(G.counts.byStore[s]?.total || 0)})</option>`).join('')}</select>
        ${scopeBtn('ALL', 'كل المنتجات', c.total)}${scopeBtn('ADVERTISED', 'Advertised', c.advertised)}${scopeBtn('NOT_ADVERTISED', 'Not Advertised', c.notAdvertised + c.suggestedOnly)}${scopeBtn('READY', '🟢 Ready', c.READY)}${scopeBtn('PARTIAL', '🟡 Partial', c.PARTIAL)}${scopeBtn('BLOCKED', '🔴 Blocked', c.BLOCKED)}
        <button class="amb-fbtn ${view.conflicts ? 'active' : ''}" id="gConf">⚠️ تعارضات (${num(c.priceConflicts)})</button><button class="amb-fbtn ${view.orders ? 'active' : ''}" id="gOrd">🛒 بأوردرات آخر 30 يوم (${num(c.withOrders30d)})</button></div>
        <div><input id="gSearch" class="op-search" placeholder="بحث باسم المنتج" value="${E(view.search)}" /></div></div>
      <div class="op-sub">غير مربوط بسجل AMB: <b>${num(c.notLinked)}</b> · سعر ناقص: <b>${num(c.priceMissing)}</b> · بيعرض ${num(shown.length)} من ${num(rows.length)}</div>
      <div class="op-gbar"><span id="gDirty" class="op-sub"></span>${S.isAdmin ? '<button class="amb-btn" id="gSaveDraft">💾 حفظ مسودة</button> <button class="amb-btn" id="gClearDraft">🗑️ مسح المسودة</button> ' : ''}<button class="amb-btn" id="gValidate">✔ تحقق</button> <button class="amb-btn" id="gRecompute" title="بيفحص جودة البيانات للمنتجات المربوطة بـAMB ويعيد حساب الجاهزية (قراءة فقط)">🔍 فحص الجودة وإعادة حساب الجاهزية</button> <button class="amb-btn orange" id="gPreview">👁 معاينة التغييرات</button> ${S.isAdmin ? '<button class="amb-btn success" id="gApply" disabled>✅ تطبيق</button>' : ''}</div>
      <div id="gOut">${gOutKeep}</div>
      <div class="table-wrap"><table class="data op-table2 op-grid"><thead><tr><th>المنتج</th><th>المتجر</th><th>الحملات</th>${CELLS.map(([, l]) => `<th>${E(l)}</th>`).join('')}<th>حد الإيقاف بدون أوردرات</th>${STOCK.map(([, l]) => `<th>${E(l)}</th>`).join('')}<th>الربط</th><th>الجاهزية</th></tr></thead><tbody>
      ${shown.map((r) => `<tr data-pid="${r.productId}" class="${r.price.status === 'CONFLICT' ? 'op-focus' : ''}"><td><button class="amb-link" data-prof="${r.productId}" type="button" ${r.operatorLinked ? '' : 'disabled title="لسه مفيش سجل AMB — اتحفظ من الجدول"'}><b>${E(r.name)}</b></button><div class="op-camp"><span class="op-pill ${LINK_AR[r.catalogLink]?.[0] || 'gray'}">${E(LINK_AR[r.catalogLink]?.[1] || r.catalogLink)}</span>${r.operatorLinked ? '' : ' <span class="op-pill gray">بدون سجل AMB</span>'}${r.orders30d ? ` · 🛒 ${num(r.orders30d)}` : ''}</div></td><td>${E(r.store)}</td>
        <td><span class="op-pill ${ADV[r.advertising][0]}">${ADV[r.advertising][1]}</span>${r.mapping.verified ? `<div class="op-camp">${r.mapping.verified} حملة</div>` : ''}</td>
        <td>${priceCell(r)}</td><td>${num_('purchase_cost', r.purchase_cost, r.purchase_cost)}</td><td>${num_('shipping', r.shipping, r.shipping)}</td><td>${num_('packaging', r.packaging, r.packaging)}</td><td>${num_('target_cpa', r.target_cpa, r.target_cpa)}</td><td>${num_('hard_stop_cpa', r.hard_stop_cpa, r.hard_stop_cpa)}</td><td>${zoCell(r)}</td>
        <td>${num_('current_stock', r.current_stock, r.current_stock)}</td><td>${num_('minimum_stock', r.minimum_stock, r.minimum_stock)}</td>
        <td><span class="op-pill ${MAP_CLS[r.mapping.state]}">${E(r.mapping.state)}</span>${r.mapping.suggested && !r.mapping.verified ? `<div class="op-camp">${r.mapping.suggested} مقترح</div>` : ''}</td>
        <td><span class="op-pill ${READY_CLS[r.readiness.state]}">${r.readiness.icon} ${E(r.readiness.state)}</span><div class="op-camp" title="${E(r.readiness.missing.map((m) => m.label).join('، '))}">${r.readiness.missing.slice(0, 2).map((m) => E(m.label)).join('، ')}${r.readiness.missing.length > 2 ? ` +${r.readiness.missing.length - 2}` : ''}</div></td></tr>`).join('')}
      </tbody></table></div>
      ${rows.length > shown.length ? `<div style="margin:10px 0"><button class="amb-btn" id="gMore">عرض ${Math.min(PAGE, rows.length - shown.length)} كمان (باقي ${num(rows.length - shown.length)})</button></div>` : ''}</div>`;
  gOutKeep = '';

  const cellsOf = (tr) => [...tr.querySelectorAll('[data-k]')];
  // one row -> its pending change (or none). Blank / unchanged cells are never part of a change.
  const syncRow = (tr) => {
    const values = {}; let zo = null; let touched = false;
    for (const el of cellsOf(tr)) { const k = el.dataset.k; if (k === 'zo_mode' || k === 'zo_value') continue; const v = String(el.value ?? '').trim(), o = String(el.dataset.orig ?? '').trim(); el.classList.toggle('dirty', v !== '' && v !== o); if (v !== '' && v !== o) { values[k] = v; touched = true; } }
    const modeEl = tr.querySelector('[data-k="zo_mode"]'), valEl = tr.querySelector('[data-k="zo_value"]'); const mode = modeEl.value, zv = valEl.value.trim(), mo = modeEl.dataset.orig, zvo = String(valEl.dataset.orig ?? '').trim();
    if (mode && (mode !== mo || zv !== zvo)) { zo = { mode, value: zv }; touched = true; }
    const pid = Number(tr.dataset.pid); if (touched) pending.set(pid, { productId: pid, values, zeroOrder: zo }); else pending.delete(pid);
  };
  const markDirty = () => { $('gDirty').textContent = pending.size ? `✏️ ${pending.size} منتج معدّل (لسه ما اتحفظش)` : 'مفيش تعديلات'; if ($('gApply')) $('gApply').disabled = true; /* any edit invalidates the previous preview */ };
  // re-apply pending edits to the rows that are on screen
  for (const tr of root.querySelectorAll('tbody tr[data-pid]')) {
    const ch = pending.get(Number(tr.dataset.pid)); if (!ch) continue;
    for (const [k, v] of Object.entries(ch.values || {})) { const el = tr.querySelector(`[data-k="${k}"]`); if (el) el.value = v; }
    if (ch.zeroOrder) { tr.querySelector('[data-k="zo_mode"]').value = ch.zeroOrder.mode; tr.querySelector('[data-k="zo_value"]').value = ch.zeroOrder.value ?? ''; }
    cellsOf(tr).forEach((el) => { const v = String(el.value ?? '').trim(), o = String(el.dataset.orig ?? '').trim(); el.classList.toggle('dirty', v !== '' && v !== o); });
  }
  markDirty();
  root.querySelectorAll('.op-grid [data-k]').forEach((el) => { el.oninput = el.onchange = () => { syncRow(el.closest('tr')); markDirty(); }; });
  root.querySelectorAll('[data-sugg]').forEach((b) => { b.onclick = () => { const el = b.closest('td').querySelector('[data-k="selling_price"]'); el.value = b.dataset.sugg; syncRow(el.closest('tr')); markDirty(); }; });
  root.querySelectorAll('[data-prof]:not([disabled])').forEach((b) => { b.onclick = () => S.hooks.setupAction('ECONOMICS', { productId: Number(b.dataset.prof) }); });
  const redraw = () => { view.limit = PAGE; gOutKeep = $('gOut')?.innerHTML || ''; render(root); };
  root.querySelectorAll('[data-gs]').forEach((b) => { b.onclick = () => { view.scope = b.dataset.gs; redraw(); }; });
  $('gStore').onchange = (e) => { view.store = e.target.value; redraw(); };
  $('gConf').onclick = () => { view.conflicts = !view.conflicts; redraw(); };
  $('gOrd').onclick = () => { view.orders = !view.orders; redraw(); };
  $('gSearch').onchange = (e) => { view.search = e.target.value; redraw(); };
  if ($('gMore')) $('gMore').onclick = () => { view.limit += PAGE; gOutKeep = $('gOut')?.innerHTML || ''; render(root); };
  const collect = () => [...pending.values()];
  if ($('gSaveDraft')) $('gSaveDraft').onclick = () => { const ch = collect(); if (!ch.length) return UI.toast('مفيش تعديلات تتحفظ.'); const saved = writeDraft({ changes: ch, savedAt: Date.now() }); UI.toast(saved ? `اتحفظت المسودة (${ch.length} منتج) في المتصفح ده` : 'المتصفح منع الحفظ المحلي.', saved ? undefined : 'error'); };
  if ($('gClearDraft')) $('gClearDraft').onclick = () => { writeDraft(null); pending.clear(); UI.toast('اتمسحت المسودة'); render(root); };

  const showPlan = (plan, { preview }) => {
    const s = plan.summary;
    $('gOut').innerHTML = `<div class="amb-panel"><h4>${preview ? '👁 معاينة (بدون حفظ)' : '✔ نتيجة التحقق'}: ${num(s.rows)} منتج · <span class="op-ok">${s.ok} سليم</span> · ${s.warn} تحذير · <span class="op-bad">${s.error} خطأ</span> · ${s.unchanged} بدون تغيير · ${num(s.cells)} خانة</h4>
      <div class="table-wrap"><table class="data op-table2"><thead><tr><th>المنتج</th><th>الحالة</th><th>من ← إلى</th><th>ملاحظات</th></tr></thead><tbody>${plan.rows.map((r) => `<tr class="${r.status === 'ERROR' ? 'blocked' : ''}"><td>${E(r.name || r.productId)}<div class="op-camp">${E(r.store || '')}</div></td><td><span class="op-pill ${r.status === 'OK' ? 'green' : r.status === 'WARN' ? 'amber' : r.status === 'ERROR' ? 'red' : 'gray'}">${E(r.status)}</span></td><td class="op-why">${r.changes.map((x) => `${E(x.field)}: ${E(x.from ?? 'MISSING')} ← <b>${E(x.to)}</b>`).join('<br>') || '—'}</td><td class="op-why">${[...r.errors.map((e) => `<span class="op-bad">✗ ${E(e)}</span>`), ...r.warnings.map((w) => `⚠️ ${E(w)}`)].join('<br>')}</td></tr>`).join('')}</tbody></table></div>
      ${s.error ? '<label class="op-check"><input type="checkbox" id="gSkip" /> تجاهل المنتجات الغلط وطبّق السليم بس</label>' : ''}</div>`;
  };
  const run = async (path, preview) => {
    const changes = collect(); if (!changes.length) return UI.toast('مفيش تعديلات.');
    $('gOut').innerHTML = '<div class="amb-loading">…</div>';
    try { const plan = await api.post(`/api/operator/setup-grid/${path}`, { changes }); showPlan(plan, { preview }); if (preview && S.isAdmin && $('gApply')) { $('gApply').disabled = plan.summary.ok + plan.summary.warn === 0; $('gApply').dataset.previewed = '1'; } }
    catch (e) { $('gOut').innerHTML = `<div class="op-bad">${E(e.message)}</div>`; }
  };
  $('gRecompute').onclick = async () => {
    $('gRecompute').disabled = true; $('gOut').innerHTML = '<div class="amb-loading">⏳ بيفحص جودة البيانات… (ممكن ياخد دقيقة)</div>';
    try {
      const r = await api.post('/api/operator/setup-grid/recompute', {}); const by = new Map(r.readiness.map((x) => [x.productId, x]));
      for (const row of G.rows) { const x = by.get(row.productId); if (x) row.readiness = { state: x.state, icon: x.icon, missing: x.missing }; }
      const cc = { READY: 0, PARTIAL: 0, BLOCKED: 0 }; r.readiness.forEach((x) => cc[x.state]++);
      gOutKeep = `<div class="op-banner blue">اتحسبت الجاهزية بعد فحص جودة البيانات للمنتجات المربوطة بـAMB (${num(r.readiness.length)}): 🟢 ${cc.READY} · 🟡 ${cc.PARTIAL} · 🔴 ${cc.BLOCKED}. باقي المنتجات (بدون سجل AMB) بتفضل BLOCKED لحد ما تتحفظ بياناتها.</div>`;
      render(root);
    } catch (e) { $('gOut').innerHTML = `<div class="op-bad">${E(e.message)}</div>`; } finally { if ($('gRecompute')) $('gRecompute').disabled = false; }
  };
  $('gValidate').onclick = () => run('validate', false);
  $('gPreview').onclick = () => run('preview', true);
  if ($('gApply')) $('gApply').onclick = async () => {
    const changes = collect(); if (!changes.length) return;
    if (!(await UI.confirmModal({ title: 'تطبيق التغييرات', message: `هيتحفظ ${changes.length} منتج في أماكنه الأصلية (والمنتج اللي مالوش سجل AMB هيتنشأ له سجل)، وبعدها الجاهزية بتتحسب تاني وبتتعمل محاكاة Shadow (قراءة فقط) للمنتجات اللي بقت READY. مفيش أي كتابة على Meta.`, confirmLabel: 'طبّق' }))) return;
    $('gApply').disabled = true; $('gOut').innerHTML = '<div class="amb-loading">⏳ بيحفظ ويعيد حساب الجاهزية…</div>';
    try {
      const r = await api.post('/api/operator/setup-grid/apply', { changes, skipInvalid: !!$('gSkip')?.checked });
      writeDraft(null); pending.clear();
      const sh = r.shadow;
      const shadowHtml = sh.skipped ? `<div class="op-banner amber">🔮 Shadow: ${E(sh.message)}</div>` : `<div class="op-banner blue">🔮 Shadow (قراءة فقط — wrote: ${sh.wrote ? 'نعم' : 'لا'}): هيفتح ${sh.summary.wouldOpen} · هيقفل ${sh.summary.wouldPause} · هيوسّع ${sh.summary.wouldScale} · هيقلل ${sh.summary.wouldReduce} · ممنوع ${sh.summary.blocked} — على ${num(sh.campaigns)} حملة من ${sh.readyProducts.length} منتج READY</div>`;
      gOutKeep = `<div class="amb-panel"><h4>✅ اتحفظ ${r.summary.saved} · اتجاهل ${r.summary.skipped} · بدون تغيير ${r.summary.unchanged}${r.summary.failed ? ` · <span class="op-bad">فشل ${r.summary.failed}</span>` : ''}</h4>
        ${r.results.filter((x) => x.status === 'FAILED' || x.status === 'SKIPPED').map((x) => `<div class="op-bad">✗ ${E(x.name)}: ${E(x.error || (x.errors || []).join(' '))}</div>`).join('')}
        <h4>الجاهزية بعد الحفظ</h4><ul class="op-ul">${r.readinessAfter.map((p) => `<li><span class="op-pill ${READY_CLS[p.state]}">${E(p.state)}</span> ${E(p.name)}${p.missing.length ? ` — ناقص: ${E(p.missing.join('، '))}` : ''}</li>`).join('') || '<li class="op-unk">—</li>'}</ul>${shadowHtml}</div>`;
      await S.hooks.refreshTop?.(); S.hooks.drawTop?.();
      await drawSetupGrid(root);
    } catch (e) { $('gOut').innerHTML = `<div class="op-bad">✗ ${E(e.message)}</div>${(e.details || []).map((d) => `<div class="op-bad">${E(d.name)}: ${E((d.errors || []).join(' '))}</div>`).join('')}`; if ($('gApply')) $('gApply').disabled = false; }
  };
}
let gOutKeep = ''; // result panel carried across a re-render (filters, recompute, apply)
