// opx2-shell.js — AI Operator V2 shell (feature flag `opx.v2`, OFF by default). Five sections; Home and the Campaign Center are new, the other three are gateways to the EXISTING screens (nothing is removed or moved yet).
// Permissions are decided by the Backend (/api/operator-v2/me): this file only hides what the user cannot do. The old interface stays reachable (openLegacy) and is the default.
import { api } from './api-client.js';
import { E, store, setRoot, closeAll, errorCard } from './opx2-ui.js';
import { mountHome, stopHome } from './opx2-home.js';
import { mountCampaigns, stopCampaigns } from './opx2-campaigns.js';

const SECTIONS = [
  { key: 'home', ic: '🏠', label: 'الرئيسية', min: 1 }, { key: 'camps', ic: '📣', label: 'الحملات', min: 1 },
  { key: 'auto', ic: '⚙️', label: 'الأتمتة والقواعد', min: 2 }, { key: 'appr', ic: '✅', label: 'الموافقات والإجراءات', min: 2 }, { key: 'set', ic: '🛡️', label: 'الإعدادات والأمان', min: 2 },
];
const LEVEL_RANK = { EMPLOYEE: 1, MANAGER: 2, ADMIN: 3 }; const LEVEL_AR = { EMPLOYEE: 'موظف (قراءة فقط)', MANAGER: 'مشرف', ADMIN: 'مسؤول' };
// the existing screens, grouped under the new sections (each opens the SAME workspace as before)
const GATEWAY = {
  auto: { title: 'الأتمتة والقواعد', lead: 'سياسات المنتجات والقواعد والتسعير وربط الحملات — نفس الشاشات الحالية.', items: [['automation', 'الأتمتة (AUTOMATIC)', 'سياسات المنتج، الإيقاف، الصرف بدون أوردرات، تفعيل الأتمتة'], ['rules', 'قواعد المنتجات', 'حدود CPA والميزانيات لكل منتج'], ['pricing', 'التسعير الذكي', 'تسعير المنتجات'], ['integration', 'مركز الربط', 'ربط الحملات بالمنتجات']] },
  appr: { title: 'الموافقات والإجراءات', lead: 'كل اللي مستني قرارك وسجل ما اتنفّذ.', items: [['approvals', 'الموافقات', 'القرارات والخطط المنتظرة'], ['history', 'سجل التنفيذ', 'اللي اتنفّذ ونتيجته'], ['alerts', 'التنبيهات', 'تنبيهات النظام'], ['open', 'خطة الفتح اليومية', 'تبقى مستقلة كما هي'], ['pause', 'خطة الإيقاف + سياسة الصرف بدون أوردرات', 'فحص 13:00 بإعداداته الحالية'], ['budget', 'إدارة الميزانيات', 'قرارات الميزانية الحالية'], ['manual', 'التشغيل اليدوي', 'إجراء على حملة واحدة']] },
  set: { title: 'الإعدادات والأمان', lead: 'وضع التشغيل وبوابات الأمان والصلاحيات — نفس الشاشات الحالية.', items: [['perms', 'صلاحيات التنفيذ', 'الأربع مفاتيح (فتح، إيقاف، رفع، خفض)'], ['control', 'مركز التحكم والجاهزية', 'الجاهزية والحالة'], ['advanced', 'كل الأدوات القديمة', 'كل التبويبات القديمة']] },
};
const V = { root: null, me: null, sec: 'home', opts: null, nav: null, ambWasCollapsed: null };

export function v2Enabled() { try { return store.get('opx.v2') === '1' || /[?&]ui=v2\b/.test(location.search + location.hash); } catch { return false; } }
export function stopV2() { stopHome(); stopCampaigns(); const nav = document.getElementById('ambNav'); if (V.ambWasCollapsed === false) nav?.classList.remove('collapsed'); V.ambWasCollapsed = null; V.root = null; }

export async function renderV2(panel, opts = {}) {
  V.opts = opts; stopV2(); const nav = document.getElementById('ambNav'); V.ambWasCollapsed = !!nav?.classList.contains('collapsed'); nav?.classList.add('collapsed');
  panel.innerHTML = `<div class="opx2" id="opx2Root" data-theme="${E(store.get('opx2.theme', 'light'))}" data-collapsed="${E(store.get('opx2.collapsed', window.innerWidth < 1500 ? '1' : '0'))}"><aside class="opx2-side"></aside><main class="opx2-main"><div class="opx2-card" style="margin-top:16px"><div class="opx2-skel" style="height:44px"></div></div></main></div>`;
  V.root = panel.querySelector('#opx2Root'); setRoot(V.root);
  try { V.me = await api.get('/api/operator-v2/me'); } catch (e) {
    V.root.querySelector('.opx2-main').innerHTML = `<div class="opx2-card" style="margin-top:16px"><div class="opx2-banner warn">${E(e.message || 'مفيش صلاحية لعرض مركز الحملات.')}</div><p class="opx2-note">لو محتاج وصول، اطلب من المسؤول تفعيل «عرض مركز الحملات» لحسابك وتحديد الحسابات الإعلانية المسموحة.</p><button class="opx2-btn" id="o2Back">الرجوع للواجهة الحالية</button></div>`;
    V.root.querySelector('#o2Back').onclick = () => opts.openLegacy?.(null); return;
  }
  buildFrame(); const saved = store.get('opx2.sec', 'home'); const first = SECTIONS.find((s) => s.key === saved && allowed(s)) ? saved : 'home'; await go(first);
}
const rank = () => LEVEL_RANK[V.me?.level] || 1; const allowed = (s) => rank() >= s.min;

function buildFrame() {
  const r = V.root; const items = SECTIONS.filter(allowed);
  r.querySelector('.opx2-side').innerHTML = `<div class="opx2-brand"><div class="opx2-logo">AI</div><div><b>AI Operator</b><small>مساحة عمل Media Buying</small></div></div>
    <nav id="o2Nav">${items.map((s) => `<button class="opx2-nb" data-sec="${s.key}"><span class="ic">${s.ic}</span><span class="tx">${E(s.label)}</span></button>`).join('')}</nav>
    <div class="opx2-sf"><div class="opx2-who"><span class="tx">${E(LEVEL_AR[V.me.level] || V.me.level)} · ${V.me.accounts.length} حساب</span></div>
      <button id="o2Theme">🌙 <span class="tx">المظهر</span></button><button id="o2Col">⇤ <span class="tx">طي القائمة</span></button><button id="o2Old"><span class="tx">↩ الواجهة الحالية</span></button></div>`;
  const main = r.querySelector('.opx2-main'); main.innerHTML = `<div class="opx2-top"><button class="opx2-btn" id="o2Burger">☰ القائمة</button></div><div id="o2View"></div>`;
  r.insertAdjacentHTML('beforeend', '<div class="opx2-scrim" id="o2Scrim"></div><aside class="opx2-drawer" id="o2Drawer" aria-label="تفاصيل"></aside><div class="opx2-modal" id="o2Modal" role="dialog" aria-modal="true"></div><div class="opx2-bulk" id="o2Bulk" role="toolbar" aria-label="إجراءات جماعية"></div>');
  r.querySelector('#o2Nav').onclick = (e) => { const b = e.target.closest('[data-sec]'); if (b) go(b.dataset.sec); };
  r.querySelector('#o2Theme').onclick = () => { const t = r.dataset.theme === 'dark' ? 'light' : 'dark'; r.dataset.theme = t; store.set('opx2.theme', t); };
  r.querySelector('#o2Col').onclick = () => { const c = r.dataset.collapsed === '1' ? '0' : '1'; r.dataset.collapsed = c; store.set('opx2.collapsed', c); };
  r.querySelector('#o2Old').onclick = () => V.opts.openLegacy?.(null);
  r.querySelector('#o2Burger').onclick = () => { r.dataset.mobileOpen = r.dataset.mobileOpen === '1' ? '0' : '1'; };
  r.querySelector('#o2Scrim').onclick = closeAll;
}
const ctx = () => ({ me: V.me, level: V.me.level, caps: V.me.capabilities, go: (sec, o) => go(sec, o), openLegacy: (ws) => V.opts.openLegacy?.(ws), root: V.root });
export async function go(sec, o = {}) {
  const s = SECTIONS.find((x) => x.key === sec && allowed(x)) || SECTIONS[0]; V.sec = s.key; store.set('opx2.sec', s.key); closeAll(); V.root.dataset.mobileOpen = '0';
  V.root.querySelectorAll('.opx2-nb').forEach((b) => b.classList.toggle('on', b.dataset.sec === s.key)); stopHome(); stopCampaigns();
  const host = V.root.querySelector('#o2View'); V.root.querySelector('#o2Bulk')?.classList.remove('show');
  try {
    if (s.key === 'home') await mountHome(host, ctx(), o); else if (s.key === 'camps') await mountCampaigns(host, ctx(), o); else mountGateway(host, s.key);
  } catch (e) { host.innerHTML = errorCard(e.message || 'تعذّر تحميل الشاشة.'); host.querySelector('#o2Retry')?.addEventListener('click', () => go(sec, o)); }
}
function mountGateway(host, key) {
  const g = GATEWAY[key];
  host.innerHTML = `<h1>${E(g.title)}</h1><p class="lead">${E(g.lead)}</p><div class="opx2-banner info">المرحلة 2 بتغطي «الرئيسية» و«مركز الحملات». الشاشات دي لسه بتفتح من الواجهة الحالية بنفس سلوكها — مفيش وظيفة اتشالت.</div>
    <div class="opx2-grid opx2-g4">${g.items.map(([ws, t, d]) => `<button class="opx2-rc" data-ws="${ws}"><b style="font-size:16px">${E(t)}</b><span>${E(d)}</span></button>`).join('')}</div>`;
  host.onclick = (e) => { const b = e.target.closest('[data-ws]'); if (b) V.opts.openLegacy?.(b.dataset.ws); };
}
