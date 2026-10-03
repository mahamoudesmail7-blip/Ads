// ai-operator-grid.js — AI Operator Setup Grid: all products in one editable table. Draft (browser) → Validate → Preview → Apply.
// Presentation only: every verdict (validation, diff, readiness, Shadow) comes from /api/operator/setup-grid*. A blank cell is never sent (never 0, never a clear).
import * as UI from './ui-common.js';
import { api } from './api-client.js';
import { E, $, num, S, READY_CLS } from './ai-operator-core.js';

const DRAFT_KEY = 'opSetupGridDraft.v1';
const CELLS = [['selling_price', 'سعر البيع'], ['purchase_cost', 'تكلفة الشراء'], ['shipping', 'الشحن'], ['packaging', 'التغليف'], ['target_cpa', 'Target CPA'], ['hard_stop_cpa', 'Hard Stop CPA']];
const STOCK = [['current_stock', 'المخزون الحالي'], ['minimum_stock', 'الحد الأدنى']];
const SRC_AR = { AMB: 'AMB', CATALOG: 'الكتالوج' };
const MAP_CLS = { VERIFIED: 'green', SUGGESTED: 'amber', UNMAPPED: 'gray' };
const readDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } };
const writeDraft = (d) => { try { d ? localStorage.setItem(DRAFT_KEY, JSON.stringify(d)) : localStorage.removeItem(DRAFT_KEY); return true; } catch { return false; } };

let filter = 'ALL'; let search = ''; let onlyConflicts = false;

export async function drawSetupGrid(root) {
  root.innerHTML = '<div class="amb-panel"><div class="amb-loading">جارِ تحميل جدول الإعداد…</div></div>';
  let g; try { g = await api.get('/api/operator/setup-grid'); } catch (e) { root.innerHTML = `<div class="amb-panel op-bad">${E(e.message)}</div>`; return; }
  const dis = S.isAdmin ? '' : 'disabled';
  const rowsAll = g.rows;
  const visible = rowsAll.filter((r) => (filter === 'ALL' || r.readiness.state === filter) && (!onlyConflicts || r.price.status === 'CONFLICT') && (!search || r.name.toLowerCase().includes(search.toLowerCase())));
  const num_ = (k, v, orig) => `<input class="op-gc" type="number" min="0" step="any" data-k="${k}" value="${v ?? ''}" data-orig="${orig ?? ''}" ${dis} />`;
  const priceCell = (r) => {
    const p = r.price;
    if (p.status === 'CONFLICT') return `<div class="op-gconf"><input class="op-gc conflict" type="number" min="0" step="any" data-k="selling_price" value="" data-orig="" placeholder="اكتب السعر الصحيح" ${dis} /><div class="op-camp op-bad">⚠️ تعارض: ${Object.entries(p.conflict || {}).map(([k, v]) => `${{ owner: 'AMB', catalog: 'الكتالوج', storeCatalog: 'كتالوج المتجر' }[k] || k} ${num(v)}`).join(' ≠ ')}</div></div>`;
    return `${num_('selling_price', p.value, p.value)}<div class="op-camp">${p.value != null ? `${E(SRC_AR[p.source] || p.source)}${p.status === 'VERIFIED' ? ' ✓ مطابق للمتجر' : ''}` : '<span class="op-unk">MISSING</span>'}${p.suggestion ? ` · <button class="amb-link" data-sugg="${p.suggestion.value}" type="button">مقترح من كتالوج المتجر: ${num(p.suggestion.value)}</button>` : ''}</div>`;
  };
  const zoCell = (r) => `<div class="op-gzo"><select data-k="zo_mode" data-orig="${E(r.zero_order?.mode || '')}" ${dis}><option value="">—</option><option value="FIXED_SPEND" ${r.zero_order?.mode === 'FIXED_SPEND' ? 'selected' : ''}>مبلغ ثابت</option><option value="TARGET_CPA_MULTIPLE" ${r.zero_order?.mode === 'TARGET_CPA_MULTIPLE' ? 'selected' : ''}>× Target CPA</option></select>${num_('zo_value', r.zero_order?.value, r.zero_order?.value)}</div>`;
  root.innerHTML = `
    <div class="amb-panel"><h3>📝 جدول الإعداد الشامل — ${num(g.counts.total)} منتج</h3>
      <div class="op-banner blue">${E(g.note)}</div>
      <div class="op-banner amber">🔒 الحفظ هنا بيكتب في الأماكن الأصلية بس (اقتصاديات AMB / مخزون الكتالوج / إعدادات Operator). مفيش كتابة على Meta، ومفيش تحويل ربط لـVERIFIED، والوضع بيفضل SHADOW. Easy Orders والمخزون الحي بيفضلوا BLOCKED لحد ما يتوصلوا فعلًا.</div>
      <div class="amb-kpis op-kpis"><div class="amb-kpi op-kpi green"><div class="k-label">🟢 READY</div><div class="k-val">${g.counts.READY}</div></div><div class="amb-kpi op-kpi amber"><div class="k-label">🟡 PARTIAL</div><div class="k-val">${g.counts.PARTIAL}</div></div><div class="amb-kpi op-kpi red"><div class="k-label">🔴 BLOCKED</div><div class="k-val">${g.counts.BLOCKED}</div></div><div class="amb-kpi op-kpi red"><div class="k-label">تعارض أسعار</div><div class="k-val">${g.counts.priceConflicts}</div></div><div class="amb-kpi op-kpi gray"><div class="k-label">سعر ناقص</div><div class="k-val">${g.counts.priceMissing}</div></div></div>
      <div class="op-toolbar"><div class="amb-filters" style="margin:0">${['ALL', 'BLOCKED', 'PARTIAL', 'READY'].map((k) => `<button class="amb-fbtn ${filter === k ? 'active' : ''}" data-gf="${k}">${k === 'ALL' ? 'الكل' : k}</button>`).join('')}<button class="amb-fbtn ${onlyConflicts ? 'active' : ''}" id="gConf">⚠️ تعارضات فقط</button></div>
        <div><input id="gSearch" class="op-search" placeholder="بحث باسم المنتج" value="${E(search)}" /></div></div>
      <div class="op-gbar"><span id="gDirty" class="op-sub"></span>${S.isAdmin ? '<button class="amb-btn" id="gSaveDraft">💾 حفظ مسودة</button> <button class="amb-btn" id="gClearDraft">🗑️ مسح المسودة</button> ' : ''}<button class="amb-btn" id="gValidate">✔ تحقق</button> <button class="amb-btn" id="gRecompute" title="بيفحص جودة البيانات لكل المنتجات ويعيد حساب الجاهزية (قراءة فقط)">🔍 فحص الجودة وإعادة حساب الجاهزية</button> <button class="amb-btn orange" id="gPreview">👁 معاينة التغييرات</button> ${S.isAdmin ? '<button class="amb-btn success" id="gApply" disabled>✅ تطبيق</button>' : ''}</div>
      <div id="gOut"></div>
      <div class="table-wrap"><table class="data op-table2 op-grid"><thead><tr><th>المنتج</th><th>المتجر</th>${CELLS.map(([, l]) => `<th>${E(l)}</th>`).join('')}<th>حد الإيقاف بدون أوردرات</th>${STOCK.map(([, l]) => `<th>${E(l)}</th>`).join('')}<th>الربط</th><th>الجاهزية</th></tr></thead><tbody>
      ${visible.map((r) => `<tr data-pid="${r.productId}" class="${r.price.status === 'CONFLICT' ? 'op-focus' : ''}"><td><button class="amb-link" data-prof="${r.productId}" type="button"><b>${E(r.name)}</b></button></td><td>${E(r.store)}</td>
        <td>${priceCell(r)}</td><td>${num_('purchase_cost', r.purchase_cost, r.purchase_cost)}</td><td>${num_('shipping', r.shipping, r.shipping)}</td><td>${num_('packaging', r.packaging, r.packaging)}</td><td>${num_('target_cpa', r.target_cpa, r.target_cpa)}</td><td>${num_('hard_stop_cpa', r.hard_stop_cpa, r.hard_stop_cpa)}</td><td>${zoCell(r)}</td>
        <td>${num_('current_stock', r.current_stock, r.current_stock)}</td><td>${num_('minimum_stock', r.minimum_stock, r.minimum_stock)}</td>
        <td><span class="op-pill ${MAP_CLS[r.mapping.state]}">${E(r.mapping.state)}</span>${r.mapping.suggested && r.mapping.state !== 'VERIFIED' ? `<div class="op-camp">${r.mapping.suggested} مقترح</div>` : ''}</td>
        <td><span class="op-pill ${READY_CLS[r.readiness.state]}">${r.readiness.icon} ${E(r.readiness.state)}</span><div class="op-camp" title="${E(r.readiness.missing.map((m) => m.label).join('، '))}">${r.readiness.missing.slice(0, 2).map((m) => E(m.label)).join('، ')}${r.readiness.missing.length > 2 ? ` +${r.readiness.missing.length - 2}` : ''}</div></td></tr>`).join('')}
      </tbody></table></div></div>`;

  const cellsOf = (tr) => [...tr.querySelectorAll('[data-k]')];
  const collect = () => {
    const changes = [];
    root.querySelectorAll('tbody tr[data-pid]').forEach((tr) => {
      const values = {}; let zo = null; let touched = false;
      for (const el of cellsOf(tr)) {
        const k = el.dataset.k; const v = String(el.value ?? '').trim(); const orig = String(el.dataset.orig ?? '').trim();
        if (k === 'zo_mode' || k === 'zo_value') continue;
        if (v !== '' && v !== orig) { values[k] = v; touched = true; }
      }
      const mode = tr.querySelector('[data-k="zo_mode"]').value; const zv = tr.querySelector('[data-k="zo_value"]').value.trim();
      const mo = tr.querySelector('[data-k="zo_mode"]').dataset.orig, zvo = String(tr.querySelector('[data-k="zo_value"]').dataset.orig ?? '').trim();
      if (mode && (mode !== mo || zv !== zvo)) { zo = { mode, value: zv }; touched = true; }
      if (touched) changes.push({ productId: Number(tr.dataset.pid), values, zeroOrder: zo });
    });
    return changes;
  };
  const markDirty = () => {
    root.querySelectorAll('tbody tr[data-pid]').forEach((tr) => { cellsOf(tr).forEach((el) => { const v = String(el.value ?? '').trim(), o = String(el.dataset.orig ?? '').trim(); el.classList.toggle('dirty', v !== '' && v !== o); }); });
    const n = collect(); $('gDirty').textContent = n.length ? `✏️ ${n.length} منتج معدّل (لسه ما اتحفظش)` : 'مفيش تعديلات'; if ($('gApply')) $('gApply').disabled = true; // any edit invalidates the previous preview
    return n;
  };
  // restore a saved draft (values only; blank/ unchanged cells stay as they are)
  const draft = readDraft();
  if (draft?.changes?.length) {
    for (const c of draft.changes) { const tr = root.querySelector(`tbody tr[data-pid="${c.productId}"]`); if (!tr) continue; for (const [k, v] of Object.entries(c.values || {})) { const el = tr.querySelector(`[data-k="${k}"]`); if (el) el.value = v; } if (c.zeroOrder) { tr.querySelector('[data-k="zo_mode"]').value = c.zeroOrder.mode; tr.querySelector('[data-k="zo_value"]').value = c.zeroOrder.value ?? ''; } }
    UI.toast(`اتسترجعت مسودة محفوظة (${draft.changes.length} منتج) — ${draft.savedAt ? new Date(draft.savedAt).toLocaleString('ar-EG') : ''}`);
  }
  markDirty();
  root.querySelectorAll('.op-grid [data-k]').forEach((el) => { el.oninput = markDirty; el.onchange = markDirty; });
  root.querySelectorAll('[data-sugg]').forEach((b) => { b.onclick = () => { const el = b.closest('td').querySelector('[data-k="selling_price"]'); el.value = b.dataset.sugg; markDirty(); }; });
  root.querySelectorAll('[data-prof]').forEach((b) => { b.onclick = () => S.hooks.setupAction('ECONOMICS', { productId: Number(b.dataset.prof) }); });
  root.querySelectorAll('[data-gf]').forEach((b) => { b.onclick = () => { filter = b.dataset.gf; drawSetupGrid(root); }; });
  $('gConf').onclick = () => { onlyConflicts = !onlyConflicts; drawSetupGrid(root); };
  $('gSearch').onchange = (e) => { search = e.target.value; drawSetupGrid(root); };
  if ($('gSaveDraft')) $('gSaveDraft').onclick = () => { const ch = collect(); if (!ch.length) return UI.toast('مفيش تعديلات تتحفظ.'); const saved = writeDraft({ changes: ch, savedAt: Date.now() }); UI.toast(saved ? `اتحفظت المسودة (${ch.length} منتج) في المتصفح ده` : 'المتصفح منع الحفظ المحلي.', saved ? undefined : 'error'); };
  if ($('gClearDraft')) $('gClearDraft').onclick = () => { writeDraft(null); UI.toast('اتمسحت المسودة'); drawSetupGrid(root); };

  const showPlan = (plan, { preview }) => {
    const s = plan.summary;
    $('gOut').innerHTML = `<div class="amb-panel"><h4>${preview ? '👁 معاينة (بدون حفظ)' : '✔ نتيجة التحقق'}: ${num(s.rows)} منتج · <span class="op-ok">${s.ok} سليم</span> · ${s.warn} تحذير · <span class="op-bad">${s.error} خطأ</span> · ${s.unchanged} بدون تغيير · ${num(s.cells)} خانة</h4>
      <div class="table-wrap"><table class="data op-table2"><thead><tr><th>المنتج</th><th>الحالة</th><th>من ← إلى</th><th>ملاحظات</th></tr></thead><tbody>${plan.rows.map((r) => `<tr class="${r.status === 'ERROR' ? 'blocked' : ''}"><td>${E(r.name || r.productId)}<div class="op-camp">${E(r.store || '')}</div></td><td><span class="op-pill ${r.status === 'OK' ? 'green' : r.status === 'WARN' ? 'amber' : r.status === 'ERROR' ? 'red' : 'gray'}">${E(r.status)}</span></td><td class="op-why">${r.changes.map((c) => `${E(c.field)}: ${E(c.from ?? 'MISSING')} ← <b>${E(c.to)}</b>`).join('<br>') || '—'}</td><td class="op-why">${[...r.errors.map((e) => `<span class="op-bad">✗ ${E(e)}</span>`), ...r.warnings.map((w) => `⚠️ ${E(w)}`)].join('<br>')}</td></tr>`).join('')}</tbody></table></div>
      ${s.error ? '<label class="op-check"><input type="checkbox" id="gSkip" /> تجاهل المنتجات الغلط وطبّق السليم بس</label>' : ''}</div>`;
  };
  const run = async (path, preview) => {
    const changes = collect(); if (!changes.length) return UI.toast('مفيش تعديلات.');
    $('gOut').innerHTML = '<div class="amb-loading">…</div>';
    try { const plan = await api.post(`/api/operator/setup-grid/${path}`, { changes }); showPlan(plan, { preview }); if (preview && S.isAdmin && $('gApply')) { $('gApply').disabled = plan.summary.ok + plan.summary.warn === 0; $('gApply').dataset.previewed = '1'; } }
    catch (e) { $('gOut').innerHTML = `<div class="op-bad">${E(e.message)}</div>`; }
  };
  $('gRecompute').onclick = async () => {
    $('gRecompute').disabled = true; $('gOut').innerHTML = '<div class="amb-loading">⏳ بيفحص جودة البيانات لكل المنتجات… (ممكن ياخد دقيقة)</div>';
    try {
      const r = await api.post('/api/operator/setup-grid/recompute', {}); const by = new Map(r.readiness.map((x) => [x.productId, x]));
      root.querySelectorAll('tbody tr[data-pid]').forEach((tr) => { const x = by.get(Number(tr.dataset.pid)); if (!x) return; const td = tr.lastElementChild; td.innerHTML = `<span class="op-pill ${READY_CLS[x.state]}">${x.icon} ${E(x.state)}</span><div class="op-camp">${x.missing.slice(0, 2).map((m) => E(m.label)).join('، ')}${x.missing.length > 2 ? ` +${x.missing.length - 2}` : ''}</div>`; });
      const c = { READY: 0, PARTIAL: 0, BLOCKED: 0 }; r.readiness.forEach((x) => c[x.state]++);
      $('gOut').innerHTML = `<div class="op-banner blue">اتحسبت الجاهزية بعد فحص جودة البيانات: 🟢 ${c.READY} · 🟡 ${c.PARTIAL} · 🔴 ${c.BLOCKED}</div>`;
    } catch (e) { $('gOut').innerHTML = `<div class="op-bad">${E(e.message)}</div>`; } finally { $('gRecompute').disabled = false; }
  };
  $('gValidate').onclick = () => run('validate', false);
  $('gPreview').onclick = () => run('preview', true);
  if ($('gApply')) $('gApply').onclick = async () => {
    const changes = collect(); if (!changes.length) return;
    if (!(await UI.confirmModal({ title: 'تطبيق التغييرات', message: `هيتحفظ ${changes.length} منتج في أماكنه الأصلية، وبعدها الجاهزية بتتحسب تاني وبتتعمل محاكاة Shadow (قراءة فقط) للمنتجات اللي بقت READY. مفيش أي كتابة على Meta.`, confirmLabel: 'طبّق' }))) return;
    $('gApply').disabled = true; $('gOut').innerHTML = '<div class="amb-loading">⏳ بيحفظ ويعيد حساب الجاهزية…</div>';
    try {
      const r = await api.post('/api/operator/setup-grid/apply', { changes, skipInvalid: !!$('gSkip')?.checked });
      writeDraft(null);
      const sh = r.shadow;
      const shadowHtml = sh.skipped ? `<div class="op-banner amber">🔮 Shadow: ${E(sh.message)}</div>` : `<div class="op-banner blue">🔮 Shadow (قراءة فقط — wrote: ${sh.wrote ? 'نعم' : 'لا'}): هيفتح ${sh.summary.wouldOpen} · هيقفل ${sh.summary.wouldPause} · هيوسّع ${sh.summary.wouldScale} · هيقلل ${sh.summary.wouldReduce} · ممنوع ${sh.summary.blocked} — على ${num(sh.campaigns)} حملة من ${sh.readyProducts.length} منتج READY</div>`;
      $('gOut').innerHTML = `<div class="amb-panel"><h4>✅ اتحفظ ${r.summary.saved} · اتجاهل ${r.summary.skipped} · بدون تغيير ${r.summary.unchanged}${r.summary.failed ? ` · <span class="op-bad">فشل ${r.summary.failed}</span>` : ''}</h4>
        ${r.results.filter((x) => x.status === 'FAILED' || x.status === 'SKIPPED').map((x) => `<div class="op-bad">✗ ${E(x.name)}: ${E(x.error || (x.errors || []).join(' '))}</div>`).join('')}
        <h4>الجاهزية بعد الحفظ</h4><ul class="op-ul">${r.readinessAfter.map((p) => `<li><span class="op-pill ${READY_CLS[p.state]}">${E(p.state)}</span> ${E(p.name)}${p.missing.length ? ` — ناقص: ${E(p.missing.join('، '))}` : ''}</li>`).join('') || '<li class="op-unk">—</li>'}</ul>${shadowHtml}</div>`;
      await S.hooks.refreshTop?.(); S.hooks.drawTop?.();
      setTimeout(() => drawSetupGridKeepOut(root), 0);
    } catch (e) { $('gOut').innerHTML = `<div class="op-bad">✗ ${E(e.message)}</div>${(e.details || []).map((d) => `<div class="op-bad">${E(d.name)}: ${E((d.errors || []).join(' '))}</div>`).join('')}`; if ($('gApply')) $('gApply').disabled = false; }
  };
}

/** re-draw the grid after an apply but keep the result panel visible */
async function drawSetupGridKeepOut(root) {
  const keep = $('gOut')?.innerHTML || '';
  await drawSetupGrid(root);
  if ($('gOut')) $('gOut').innerHTML = keep;
}
