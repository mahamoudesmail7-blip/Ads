// opx-shell.js — the AI Operator shell: navy sidebar (7 independent workspaces + «متقدم»), mode / emergency controls, theme, collapse, remembered workspace.
// Presentation only. Mode changes, Emergency Stop and permissions go through the same server endpoints and confirmations as before.
import { api } from './api-client.js';
import { E, $, num, ICONS, ago, pill, skeletonRows, toast, confirmModal, store } from './opx-ui.js';

const WS = [
  { key: 'open', label: 'فتح الحملات', icon: 'play', kind: 'plan', type: 'OPEN' },
  { key: 'pause', label: 'إيقاف الحملات', icon: 'pause', kind: 'plan', type: 'PAUSE' },
  { key: 'budget', label: 'إدارة الميزانيات', icon: 'budget', kind: 'budget' },
  { key: 'rules', label: 'قواعد المنتجات', icon: 'rules', kind: 'rules' },
  { key: 'pricing', label: 'التسعير الذكي', icon: 'coins', kind: 'module', file: './opx-pricing.js', fn: 'mountPricingWorkspace' },
  { key: 'approvals', label: 'الموافقات', icon: 'approve', kind: 'module', file: './opx-approvals.js', fn: 'mountApprovalsWorkspace', badge: 'pendingApprovals' },
  { key: 'history', label: 'سجل التنفيذ', icon: 'history', kind: 'module', file: './opx-history.js', fn: 'mountHistoryWorkspace' },
  { key: 'alerts', label: 'التنبيهات', icon: 'bell', kind: 'alerts', badge: 'importantAlerts' },
];
const ADV = [
  { key: 'perms', label: 'صلاحيات التنفيذ', icon: 'key', kind: 'legacy', tab: 'perms' },
  { key: 'control', label: 'مركز التحكم والجاهزية', icon: 'compass', kind: 'legacy', tab: 'control' },
  { key: 'advanced', label: 'كل الأدوات القديمة', icon: 'gear', kind: 'full' },
];
const ALL = [...WS, ...ADV];
const MODE_SEG = [{ key: 'OFF', label: 'MANUAL', sub: 'يدوي' }, { key: 'APPROVAL', label: 'APPROVAL', sub: 'بموافقتي' }, { key: 'AUTOPILOT', label: 'AUTOMATIC', sub: 'تلقائي' }];

const SH = { panel: null, host: null, isAdmin: false, legacy: null, ws: 'open', ov: null, status: null, mods: {} };

/** legacy = { mountBody(container, tab), mountFull(container), refreshTop(), showGate() , getOv() } supplied by ai-operator.js */
export async function renderShell(panel, { isAdmin = false, legacy }) {
  SH.panel = panel; SH.isAdmin = isAdmin; SH.legacy = legacy;
  const saved = store.get('opx.ws', 'open'); SH.ws = ALL.some((w) => w.key === saved) ? saved : 'open';
  const theme = store.get('opx.theme', 'light'); const collapsed = store.get('opx.collapsed', window.innerWidth < 1650 ? '1' : '0'); // narrower screens start with the icon rail so the tables get the room
  panel.innerHTML = `<div class="opx" data-theme="${theme}" data-collapsed="${collapsed}" id="opxRoot">
    <aside class="opx-side" id="opxSide">
      <div class="opx-brand"><div class="opx-logo">AI</div><div><b>AI Operator</b><small>التحكم الذكي في الحملات</small></div></div>
      <nav class="opx-nav" id="opxNav" aria-label="أقسام AI Operator"></nav>
      <div class="opx-navgroup">متقدم</div><nav class="opx-nav" id="opxNavAdv"></nav>
      <div class="opx-side-foot">
        <div class="opx-foot-row" id="opxSysState"></div>
        <button class="opx-iconbtn" id="opxTheme" aria-label="تبديل المظهر"><span id="opxThemeIc"></span><span class="txt" id="opxThemeTx"></span></button>
        <button class="opx-iconbtn" id="opxCollapse" aria-label="طي القائمة"><span style="display:inline-flex">${ICONS.collapse}</span><span class="txt">طي القائمة</span></button>
      </div>
    </aside>
    <main class="opx-main"><div class="opx-topline"><button class="opx-burger" id="opxBurger" aria-label="القائمة">${ICONS.menu}</button><b class="opx-toptitle" id="opxTopTitle"></b></div><div id="opxBanner"></div><div id="opxWork"></div></main>
    <div class="opx-scrim" id="opxScrim"></div>
    <nav class="opx-bnav" id="opxBnav" aria-label="تنقل سريع"><button id="bnMenu">${ICONS.menu}<span>الأقسام</span></button><button id="bnApprovals">${ICONS.approve}<span>الموافقات</span><span class="opx-badge" id="bnBadge" hidden></span></button><button class="stop" id="bnStop">${ICONS.stop}<span>إيقاف فوري</span></button></nav></div>`;
  SH.root = $('opxRoot'); SH.host = $('opxWork');
  const nav = document.getElementById('ambNav'); SH.navWasCollapsed = !!nav?.classList.contains('collapsed'); nav?.classList.add('collapsed'); // the app nav becomes an icon rail so the workspace gets the width
  $('opxScrim').onclick = () => { SH.root.dataset.mobileOpen = '0'; }; $('bnMenu').onclick = () => { SH.root.dataset.mobileOpen = SH.root.dataset.mobileOpen === '1' ? '0' : '1'; }; $('bnApprovals').onclick = () => { SH.root.dataset.mobileOpen = '0'; openWorkspace('approvals'); }; $('bnStop').onclick = () => emergencyStop();
  $('opxTheme').onclick = toggleTheme; $('opxCollapse').onclick = toggleCollapse; $('opxBurger').onclick = () => { SH.root.dataset.mobileOpen = SH.root.dataset.mobileOpen === '1' ? '0' : '1'; };
  paintTheme();
  if (!SH.evt) window.addEventListener('opx:open', SH.evt = (e) => { if (document.body.contains(SH.root) && ALL.some((w) => w.key === e.detail)) openWorkspace(e.detail); });
  await refreshSystem(); drawNav(); await openWorkspace(SH.ws, { first: true });
  clearInterval(SH.poll); SH.poll = setInterval(async () => { if (!document.body.contains(SH.root)) return clearInterval(SH.poll); try { await refreshSystem(); drawNav(); drawBanner(); } catch { /* keep last */ } }, 60_000);
}
export function stopShell() { clearInterval(SH.poll); if (SH.navWasCollapsed === false) document.getElementById('ambNav')?.classList.remove('collapsed'); SH.navWasCollapsed = undefined; SH.mods.plan?.unmountPlanWorkspace?.(); }

async function refreshSystem() {
  const [ov, st] = await Promise.all([api.get('/api/operator/overview'), api.get('/api/operator/status-bar').catch(() => null)]);
  SH.ov = ov; SH.status = st; SH.legacy.setOv?.(ov);
  const cfg = await api.get('/api/operator/config').catch(() => null); SH.cfg = cfg;
}
function drawNav() {
  const badgeOf = (w) => (w.badge && SH.status ? Number(SH.status[w.badge]) || 0 : 0);
  const item = (w) => { const b = badgeOf(w); return `<button class="opx-item ${w.key === SH.ws ? 'on' : ''}" data-ws="${w.key}" title="${E(w.label)}">${ICONS[w.icon]}<span class="lbl">${E(w.label)}</span>${b ? `<span class="opx-badge">${b}</span>` : ''}</button>`; };
  $('opxNav').innerHTML = WS.map(item).join(''); $('opxNavAdv').innerHTML = ADV.map(item).join('');
  SH.root.querySelectorAll('[data-ws]').forEach((b) => { b.onclick = () => { SH.root.dataset.mobileOpen = '0'; openWorkspace(b.dataset.ws); }; });
  { const pend = SH.status ? Number(SH.status.pendingApprovals) || 0 : 0; const bb = $('bnBadge'); if (bb) { bb.textContent = pend; bb.hidden = !pend; } const tt = $('opxTopTitle'); if (tt) tt.textContent = (ALL.find((w) => w.key === SH.ws) || {}).label || ''; }
  const ov = SH.ov; const tone = ov.emergencyStop ? 'red' : ov.mode === 'AUTOPILOT' ? 'green' : ov.mode === 'APPROVAL' ? 'amber' : 'amber';
  $('opxSysState').innerHTML = `<span class="opx-dot ${tone}"></span><span class="txt">${ov.emergencyStop ? 'إيقاف طوارئ' : modeLabel(ov.mode)} · Meta ${ov.writesLocked ? '🔒' : '🔓'}</span>`;
}
const modeLabel = (m) => ({ OFF: 'MANUAL', SHADOW: 'SHADOW', APPROVAL: 'APPROVAL', AUTOPILOT: 'AUTOMATIC' }[m] || m);

function paintTheme() { const dark = SH.root.dataset.theme === 'dark'; $('opxThemeIc').innerHTML = dark ? ICONS.sun : ICONS.moon; $('opxThemeIc').style.display = 'inline-flex'; $('opxThemeTx').textContent = dark ? 'المظهر الفاتح' : 'المظهر الداكن'; }
function toggleTheme() { SH.root.dataset.theme = SH.root.dataset.theme === 'dark' ? 'light' : 'dark'; store.set('opx.theme', SH.root.dataset.theme); paintTheme(); }
function toggleCollapse() { SH.root.dataset.collapsed = SH.root.dataset.collapsed === '1' ? '0' : '1'; store.set('opx.collapsed', SH.root.dataset.collapsed); }

/** the mode segment shared by every workspace header (same endpoints / confirmations as the previous UI) */
function modeSegment() {
  const ov = SH.ov; const cur = ov.mode;
  const btns = MODE_SEG.map((m) => `<button data-opxmode="${m.key}" class="${cur === m.key ? 'on' : ''}" ${SH.isAdmin ? '' : 'disabled'} title="${m.key === 'AUTOPILOT' ? 'التفعيل التلقائي يمر ببوابة تفعيل ADMIN' : ''}">${m.label}<small>${m.sub}</small></button>`).join('');
  return `<div class="opx-seg" role="group" aria-label="وضع التشغيل" data-modeseg>${btns}${cur === 'SHADOW' ? '<button class="on" disabled>SHADOW<small>محاكاة</small></button>' : ''}</div>`;
}
function wireModeSegments(root) {
  root.querySelectorAll('[data-opxmode]').forEach((b) => { b.onclick = async () => {
    const mode = b.dataset.opxmode; if (mode === SH.ov.mode) return;
    if (mode === 'AUTOPILOT') return SH.legacy.showGate();
    if (!(await confirmModal({ title: 'تغيير الوضع', message: `تغيير وضع AI Operator إلى «${modeLabel(mode)}»؟`, confirmLabel: 'تأكيد' }))) return;
    try { await api.put('/api/operator/mode', { mode }); toast('تم تغيير الوضع'); await refreshSystem(); drawNav(); drawBanner(); await openWorkspace(SH.ws); } catch (e) { toast(e.message, 'error'); }
  }; });
}
function drawBanner() {
  const ov = SH.ov; const el = $('opxBanner'); if (!el) return;
  el.innerHTML = ov.emergencyStop ? `<div class="opx-notice red opx-fade"><div class="grow"><b>🛑 إيقاف الطوارئ مفعّل</b><small>${E(ov.emergencyReason || '')} · مفيش أي فتح/إيقاف/تغيير ميزانية.</small></div>${SH.isAdmin ? '<button class="opx-btn" id="opxResume">إلغاء الإيقاف</button>' : ''}</div>` : '';
  if ($('opxResume')) $('opxResume').onclick = async () => { if (!(await confirmModal({ title: 'إلغاء إيقاف الطوارئ', message: 'التنفيذ هيرجع حسب الوضع الحالي والقواعد. متأكد؟', confirmLabel: 'إلغاء الإيقاف' }))) return; try { await api.delete('/api/operator/emergency-stop'); toast('تم'); await refreshSystem(); drawNav(); drawBanner(); await openWorkspace(SH.ws); } catch (e) { toast(e.message, 'error'); } };
}
async function emergencyStop() {
  if (!(await confirmModal({ title: '🛑 إيقاف فوري', message: 'هيوقف أي فتح/إيقاف/تغيير ميزانية تلقائي أو بموافقة فورًا، فوق كل القواعد. المراقبة بتكمل. متأكد؟', confirmLabel: 'إيقاف فوري', danger: true }))) return;
  try { await api.post('/api/operator/emergency-stop', { reason: 'إيقاف يدوي من الواجهة' }); toast('تم تفعيل الإيقاف الفوري'); await refreshSystem(); drawNav(); drawBanner(); await openWorkspace(SH.ws); } catch (e) { toast(e.message, 'error'); }
}

async function openWorkspace(key, { first = false } = {}) {
  // a workspace that is still loading finishes (and paints into the host) BEFORE the next one starts: a slow answer can never overwrite the screen the owner just switched to
  try { await SH.inflight; } catch { /* the previous one handled its own error */ }
  let release; SH.inflight = new Promise((r) => { release = r; });
  try { await openWorkspaceNow(key, { first }); } finally { release(); }
}
async function openWorkspaceNow(key, { first = false } = {}) {
  const w = ALL.find((x) => x.key === key) || WS[0]; SH.ws = w.key; store.set('opx.ws', w.key);
  SH.root.querySelectorAll('[data-ws]').forEach((b) => b.classList.toggle('on', b.dataset.ws === w.key)); { const tt = $('opxTopTitle'); if (tt) tt.textContent = w.label; }
  SH.mods.plan?.unmountPlanWorkspace?.(); drawBanner();
  const host = SH.host; host.innerHTML = `<div class="opx-card">${skeletonRows(5)}</div>`;
  const ctx = { isAdmin: SH.isAdmin, modeSegment: () => modeSegment(), ov: () => SH.ov, emergencyStop, refresh: async () => { await refreshSystem(); drawNav(); drawBanner(); }, statusExtra: () => '' };
  try {
    if (w.kind === 'plan') { SH.mods.plan = await import('./opx-plan.js'); await SH.mods.plan.mountPlanWorkspace(host, w.type, ctx); }
    else if (w.kind === 'budget' || w.kind === 'rules') {
      const file = w.kind === 'budget' ? './opx-budget.js' : './opx-rules.js'; let mod = null; try { mod = await import(file); } catch { mod = null; }
      if (mod) await (w.kind === 'budget' ? mod.mountBudgetWorkspace(host, ctx) : mod.mountRulesWorkspace(host, ctx));
      else { host.innerHTML = frame(w, ctx, '<div id="opxLegacy"></div>'); wireFrame(host, ctx); await SH.legacy.mountBody($('opxLegacy'), w.kind === 'budget' ? 'scale' : 'rules'); }
    }
    else if (w.kind === 'module') { const mod = await import(w.file); await mod[w.fn](host, ctx); }
    else if (w.kind === 'alerts') await drawAlerts(host, ctx);
    else if (w.kind === 'legacy') { host.innerHTML = frame(w, ctx, '<div id="opxLegacy"></div>'); wireFrame(host, ctx); await SH.legacy.mountBody($('opxLegacy'), w.tab); }
    else if (w.kind === 'full') { host.innerHTML = frame(w, ctx, '<div id="opxLegacy"></div>'); wireFrame(host, ctx); await SH.legacy.mountFull($('opxLegacy')); }
    wireModeSegments(host); wireStop(host, ctx);
  } catch (e) { host.innerHTML = `<div class="opx-card opx-empty">⚠️ ${E(e.message || e)}</div>`; }
  if (!first) window.scrollTo({ top: 0, behavior: 'smooth' });
}
function wireStop(host, ctx) { host.querySelectorAll('[data-opxstop]').forEach((b) => { b.onclick = ctx.emergencyStop; }); }
const wireFrame = (host, ctx) => { wireModeSegments(host); wireStop(host, ctx); };
/** a simple titled frame (header card with mode + Emergency Stop) around a legacy / list view */
function frame(w, ctx, inner) {
  const tone = { approvals: 'violet', history: 'blue', alerts: 'amber', perms: 'violet', control: 'violet', advanced: 'violet' }[w.key] || 'violet';
  return `<div class="opx-card opx-head opx-fade"><div class="opx-head-icon ${tone}">${ICONS[w.icon]}</div><div class="grow"><h1>${E(w.label)}</h1><p>${E({ approvals: 'القرارات المعلقة وقرارات اليوم — اعتماد أو رفض مع الأدلة', history: 'كل عملية: طُلبت ← اتحقق منها ← أُرسلت ← قُرئت من Meta ← تأكدت', alerts: 'تنبيهات النظام والتنبيهات الذكية', perms: 'تحكم في صلاحيات الفتح والإيقاف وزيادة/تقليل الميزانية', control: 'جاهزية كل وظيفة، والحالة الحقيقية على Meta', advanced: 'الأدوات القديمة كاملة (القواعد، ربط الحملات، المستثنى…)' }[w.key] || '')}</p></div>${ctx.modeSegment()}<button class="opx-btn danger" data-opxstop ${SH.ov.emergencyStop ? 'disabled' : ''}>${ICONS.stop} إيقاف فوري</button></div><div class="opx-fade" style="min-width:0">${inner}</div>`;
}

async function drawAlerts(host, ctx) {
  host.innerHTML = frame({ key: 'alerts', label: 'التنبيهات', icon: 'bell' }, ctx, `<div class="opx-card" id="opxAlertsBox">${skeletonRows(6)}</div>`); wireFrame(host, ctx);
  const r = await api.get('/api/ai-media-buyer/alerts', { limit: 80 }); const list = r.alerts || r.items || r || [];
  const SEV = { CRITICAL: ['red', 'حرج'], HIGH: ['red', 'مهم'], WARNING: ['amber', 'تحذير'], MEDIUM: ['amber', 'تحذير'], INFO: ['blue', 'معلومة'], LOW: ['blue', 'معلومة'] };
  $('opxAlertsBox').innerHTML = `<div class="opx-tablehead"><h3>التنبيهات (${num(list.length)})</h3>${SH.isAdmin ? '<button class="opx-btn sm" id="opxReadAll">تحديد الكل كمقروء</button>' : ''}</div>
    <div class="opx-scroll">${list.length ? `<table class="opx-table"><thead><tr><th>الأهمية</th><th>التنبيه</th><th>الفئة</th><th>الوقت</th><th></th></tr></thead><tbody>${list.map((a) => { const s = SEV[String(a.severity || '').toUpperCase()] || ['gray', a.severity || '—']; return `<tr class="${a.is_read || a.isRead ? 'dim' : ''}"><td>${pill(E(s[1]), s[0])}</td><td class="opx-why"><b>${E(a.title || '')}</b><small>${E(a.message || '')}</small></td><td>${E(a.category || '—')}</td><td>${E(ago(a.created_at || a.createdAt))}</td><td>${a.is_read || a.isRead ? '' : `<button class="opx-btn ghost sm" data-readid="${a.id}">مقروء</button>`}</td></tr>`; }).join('')}</tbody></table>` : '<div class="opx-empty">مفيش تنبيهات.</div>'}</div>`;
  host.querySelectorAll('[data-readid]').forEach((b) => { b.onclick = async () => { try { await api.post('/api/ai-media-buyer/alerts/read', { ids: [Number(b.dataset.readid)] }); await drawAlerts(host, ctx); wireModeSegments(host); await ctx.refresh(); } catch (e) { toast(e.message, 'error'); } }; });
  if ($('opxReadAll')) $('opxReadAll').onclick = async () => { try { await api.post('/api/ai-media-buyer/alerts/read-all', {}); await drawAlerts(host, ctx); wireModeSegments(host); await ctx.refresh(); } catch (e) { toast(e.message, 'error'); } };
}
