// opx-integration.js — «مركز الربط»: the AI Operator features as ONE connected system. Read-only: the link map (with live status per link), the health checks, and the unified VERSIONED policy of any product.
// Presentation over /api/operator/integration/* (map · health · resolve). Nothing here changes a setting, executes or talks to Meta.
import { api } from './api-client.js';
import { E, $, num, ICONS, pill, skeletonRows, thumb, hydrateThumbs, store } from './opx-ui.js';

const I = { ctx: null, root: null, map: null, health: null, products: [], cur: null, resolved: null };
const KIND = { input: ['violet', 'مدخل'], source: ['green', 'المصدر الوحيد'], policy: ['blue', 'سياسة'], guard: ['red', 'حماية'], data: ['gray', 'بيانات'], engine: ['amber', 'محرّك'], action: ['blue', 'تنفيذ'], gate: ['amber', 'موافقة'], record: ['gray', 'سجل'] };
const COLS = [['المدخلات والسياسات', ['pricing', 'rules', 'openCpa', 'guards', 'identity', 'metrics']], ['الجدولة والموافقة', ['scheduler', 'approvals']], ['التنفيذ والسجل', ['open', 'pause', 'up', 'down', 'history', 'alerts']]];
const NODE_CHECK = { identity: ['identity'], metrics: ['freshness', 'cairo'], rules: ['policies'], openCpa: ['openCpa'], scheduler: ['pendingPlans'], approvals: ['conflicts'], history: ['failures'], alerts: ['failures'], guards: ['safety'] };
const SEV = { ok: ['green', '●'], warn: ['amber', '▲'], bad: ['red', '✕'] };

export async function mountIntegrationWorkspace(root, ctx) {
  I.ctx = ctx; I.root = root; root.innerHTML = `<div class="opx-card">${skeletonRows(6)}</div>`;
  try { [I.map, I.health, I.products] = await Promise.all([api.get('/api/operator/integration/map'), api.get('/api/operator/integration/health'), api.get('/api/operator/pricing/products').then((r) => r.products).catch(() => [])]); }
  catch (e) { root.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message)}</div>`; return; }
  const last = store.get('opx.int.key', ''); I.cur = I.products.find((p) => p.key === last) || I.products[0] || null;
  draw(); if (I.cur) await resolve();
}
const statusOf = (id) => { const keys = NODE_CHECK[id]; if (!keys) return null; const cs = I.health.checks.filter((c) => keys.includes(c.key)); if (!cs.length) return null; return cs.some((c) => c.severity === 'bad') ? 'bad' : cs.some((c) => c.severity === 'warn') ? 'warn' : 'ok'; };
function draw() {
  const h = I.health; const nodeBy = Object.fromEntries(I.map.nodes.map((n) => [n.id, n]));
  const node = (id) => { const n = nodeBy[id]; const [tone, kl] = KIND[n.kind] || ['gray', '']; const st = statusOf(id); return `<div class="opx-node ${tone}" data-node="${id}"><div class="opx-node-h"><b>${E(n.label)}</b>${st ? `<i class="opx-dot ${SEV[st][0]}" title="${E(h.checks.filter((c) => (NODE_CHECK[id] || []).includes(c.key)).map((c) => c.detail).join(' · '))}">${SEV[st][1]}</i>` : ''}</div>${pill(kl, tone)}<small>${E(n.owns)}</small></div>`; };
  I.root.innerHTML = `
    <div class="opx-card opx-head opx-fade"><div class="opx-head-icon violet">${ICONS.compass}</div><div class="grow"><h1>مركز الربط ${pill(h.overall === 'ok' ? 'كله متصل' : h.overall === 'warn' ? 'فيه ملاحظات' : 'فيه مشكلة', SEV[h.overall][0])}</h1><p>كل ميزات AI Operator بتشتغل كنظام واحد: سياسة واحدة بنسخة لكل منتج، ونفس حدود CPA والميزانيات والمواعيد في كل الشاشات — قراءة فقط، مفيش حاجة بتتغيّر من هنا.</p></div>
      <div class="opx-state"><span class="opx-switch ${h.overall === 'ok' ? 'on' : ''}" aria-hidden="true"></span><div><b>${E(h.checks.find((c) => c.key === 'safety')?.detail || '')}</b><small>آخر فحص ${E(new Date(h.at).toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo' }))}</small></div></div></div>
    <div class="opx-card opx-int-map opx-fade" id="intMap"><h3>مخطط الربط</h3><div class="opx-int-cols">${COLS.map(([t, ids], i) => `<div class="opx-int-col"><h4>${i + 1}. ${t}</h4>${ids.map(node).join('')}</div>`).join('')}</div>
      <details class="opx-int-edges" open><summary>الروابط بين الميزات (${I.map.edges.length})</summary><div class="opx-scroll" style="max-height:280px"><table class="opx-table"><thead><tr><th>من</th><th></th><th>إلى</th><th>اللي بيتنقل / بيتطبّق</th></tr></thead><tbody>${I.map.edges.map(([a, b, d]) => `<tr><td><b>${E(nodeBy[a].label)}</b></td><td>←</td><td><b>${E(nodeBy[b].label)}</b></td><td class="opx-why">${E(d)}</td></tr>`).join('')}</tbody></table></div></details></div>
    <div class="opx-int-grid">
      <section class="opx-card opx-panel opx-fade" id="intHealth"><h3>${ICONS.shield} فحص الربط الحي</h3>${h.checks.map((c) => `<div class="opx-check-row ${SEV[c.severity][0]}" data-check="${c.key}"><i>${SEV[c.severity][1]}</i><div><b>${E(c.label)}</b><small>${E(c.detail)}</small></div></div>`).join('')}</section>
      <section class="opx-card opx-panel opx-fade" id="intPolicy"><h3>${ICONS.rules} السياسة الموحدة لمنتج (بنسخة)</h3>
        ${I.products.length ? `<select class="opx-select" id="intSel" aria-label="المنتج">${I.products.map((p) => `<option value="${E(p.key)}" ${p.key === I.cur?.key ? 'selected' : ''}>${E(p.name)} — #${p.productId}</option>`).join('')}</select>` : '<div class="opx-empty">مفيش منتجات مربوطة.</div>'}
        <div id="intResolved"><div class="opx-skel" style="height:160px"></div></div></section></div>`;
  const sel = $('intSel'); if (sel) sel.onchange = async () => { I.cur = I.products.find((p) => p.key === sel.value); store.set('opx.int.key', I.cur.key); await resolve(); };
}
async function resolve() {
  const el = $('intResolved'); if (!el || !I.cur) return;
  try { I.resolved = await api.get('/api/operator/integration/resolve', { productId: I.cur.productId, storeId: I.cur.storeId }); } catch (e) { el.innerHTML = `<div class="opx-note bad">⚠️ ${E(e.message)}</div>`; return; }
  const r = I.resolved; const f = r.effective; const kv = (k, v) => `<div class="opx-kv"><span>${k}</span><b>${v}</b></div>`; const v = (x, u = '') => (x === null || x === undefined ? '—' : `${num(x)}${u}`);
  const pr = r.policyRef;
  el.innerHTML = `
    <div class="opx-int-ver">${pill(r.hasActiveProductPolicy ? `سياسة المنتج مفعّلة v${pr.productPolicy?.version}` : 'مفيش سياسة منتج مفعّلة — بتتطبق السياسة العامة', r.hasActiveProductPolicy ? 'green' : 'gray')}${r.draftIgnored ? pill('فيه مسودة (غير مطبّقة)', 'amber') : ''}${pr.openCpa ? pill(`الفتح حسب CPA v${pr.openCpa.version} ${pr.openCpa.enabled ? '· مفعّلة' : '· مقفولة'}`, pr.openCpa.enabled ? 'blue' : 'gray') : ''}</div>
    <div class="opx-int-kv">${kv('الوضع', E(f.mode || 'حسب الإعداد العام'))}${kv('CPA: scale ≤ / keep / reduce', E(`${v(f.cpa.zones.scale)} / ${v(f.cpa.zones.keepMin)}–${v(f.cpa.zones.keepMax)} / ${v(f.cpa.zones.reduceMin)}–${v(f.cpa.zones.reduceMax)}`))}${kv('Hard Stop CPA', v(f.cpa.hardStop, ' ج.م'))}
      ${kv('زيادة الميزانية', v(f.budget.increasePct, '%'))}${kv('تقليل الميزانية', `${v(f.budget.decreasePct, '%')}${r.guards.clamps.length ? ' <small class="opx-note">(مقيّد بالحد العام)</small>' : ''}`)}${kv('Cooldown', v(f.budget.cooldownHours, ' ساعة'))}${kv('حد الصرف اليومي للمنتج', v(f.budget.dailySpendCap, ' ج.م'))}${kv('الفتح / الإيقاف', E(`${f.schedule.openTime || '12:00 ص (عام)'} / ${f.schedule.closeTime || '1:00 ظ (عام)'}`))}
      ${kv('الفتح حسب CPA', f.openCpa ? E(`${f.openCpa.min}–${f.openCpa.max} ج.م · ${{ today: 'اليوم', 7: '7 أيام', 30: '30 يوم', 90: '90 يوم', custom: 'مخصصة' }[f.openCpa.window]} · عينة ≥ ${f.openCpa.minPurchases}`) : 'غير محدد')}${kv('Manual Override', v(f.manualOverrideHours, ' ساعة'))}</div>
    <div class="opx-note">الأولوية: ${r.guards.precedence.map((p, i) => `${i + 1}) ${E(p)}`).join(' ← ')}. أي قيمة للمنتج لا تتجاوز حدود الأمان العامة.</div>
    <div class="opx-note">الأيام بتتحسب بتوقيت القاهرة: اليوم ${E(r.windows.today.from)} · 7D من ${E(r.windows.d7.from)} · 30D من ${E(r.windows.d30.from)}.</div>`;
}
