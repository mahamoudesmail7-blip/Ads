// ui-common.js — shared UI helpers: sidebar nav, formatting, badges, toasts,
// AND the Arabic translation layer for the whole app.
//
// IMPORTANT — why translation lives here and not in the logic files:
// analytics.js / profit.js / inventory.js / recommendation-engine.js return
// English status codes ('UP', 'CRITICAL', 'PROFITABLE'...) and a small set
// of English reason SENTENCES (e.g. "Health Score: 24/100"). Those exact
// strings are asserted on by the existing test suite (test-analytics.js,
// test-recommendation-engine.js), so changing them there would break
// tests that have nothing to do with language — and section 25 of the
// localization brief explicitly says internal code names may stay English.
// Every one of those codes/sentences is translated to Arabic ONLY here, at
// the point of rendering. No business-logic file is touched by this file.

// Minimal stroke-based line icons (Feather/Lucide-style), embedded inline —
// no external icon font/CDN, matching this project's zero-dependency rule.
// Purely decorative replacements for the old emoji icons; NAV_ITEMS' key/
// href/label are untouched, so nothing that reads them (role filtering,
// active-state matching, routing) is affected.
const ICON_PATHS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>',
  tasks: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  work: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  manager: '<path d="M2 20h20"/><path d="M4 20l1.5-11L9 14l3-9 3 9 3.5-5L20 20"/>',
  inventory: '<path d="M21 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2"/><path d="M3 8l1.4 11.2A2 2 0 0 0 6.38 21h11.24a2 2 0 0 0 1.98-1.8L21 8"/><path d="M9 12h6"/>',
  products: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  entry: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  alerts: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  compare: '<path d="M8 3L4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/>',
  ranking: '<path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-3.4-3.4L4.5 15.6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.7.36 1.51.55 1.51 1.51z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  test: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  easyorders: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
  lostorders: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M9 9l6 6M15 9l-6 6"/>',
  aiintel: '<path d="M12 2a4 4 0 0 0-4 4c0 1.5.8 2.8 2 3.5V12H8a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h1v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2h1a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-2V9.5c1.2-.7 2-2 2-3.5a4 4 0 0 0-4-4z"/><circle cx="9" cy="14" r="0.5"/><circle cx="15" cy="14" r="0.5"/>',
};

function navIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ''}</svg>`;
}

export const NAV_ITEMS = [
  { key: 'dashboard', href: 'index.html', label: 'نظرة سريعة', icon: navIcon('dashboard') },
  { key: 'tasks', href: 'tasks.html', label: 'تاسكات اليوم', icon: navIcon('tasks') },
  { key: 'work', href: 'work.html', label: 'الشغل اللي هيتعمل', icon: navIcon('work') },
  { key: 'manager', href: 'manager.html', label: 'تحكم المدير', icon: navIcon('manager') },
  { key: 'inventory', href: 'inventory.html', label: 'إدارة المخزون', icon: navIcon('inventory') },
  { key: 'products', href: 'products.html', label: 'المنتجات', icon: navIcon('products') },
  { key: 'entry', href: 'entry.html', label: 'إدخال الأوردرات', icon: navIcon('entry') },
  { key: 'easyorders', href: 'easy-orders.html', label: 'Easy Orders', icon: navIcon('easyorders') },
  { key: 'lostorders', href: 'lost-orders.html', label: 'الأوردرات المفقودة', icon: navIcon('lostorders'), badgeId: 'navLostOrdersBadge' },
  { key: 'aiintel', href: 'ai-intelligence.html', label: 'AI Intelligence', icon: navIcon('aiintel') },
  { key: 'alerts', href: 'alerts.html', label: 'التنبيهات', icon: navIcon('alerts') },
  { key: 'compare', href: 'compare.html', label: 'مقارنة المنتجات', icon: navIcon('compare') },
  { key: 'ranking', href: 'ranking.html', label: 'ترتيب الربحية', icon: navIcon('ranking') },
  { key: 'settings', href: 'settings.html', label: 'إعدادات النظام', icon: navIcon('settings') },
  { key: 'users', href: 'users.html', label: 'إدارة المستخدمين', icon: navIcon('users') },
  { key: 'test', href: 'test.html', label: 'اختبارات النظام', icon: navIcon('test') },
];

// Nav items hidden per role — 'manager'/'work' need MANAGER or ADMIN,
// 'settings' (holds the data-migration + integration controls) needs ADMIN.
const NAV_ROLE_REQUIREMENT = {
  manager: ['ADMIN', 'MANAGER'],
  work: ['ADMIN', 'MANAGER'],
  settings: ['ADMIN'],
  aiintel: ['ADMIN', 'MANAGER'],
};

// 'users' (the approval queue + permissions editor) is stricter still —
// Owner-only, same as the backend's requireOwner gate in routes/users.js —
// a promoted-but-not-owner ADMIN should not see it either.
const OWNER_ONLY_NAV = new Set(['users']);

const ROLE_LABELS_AR = { ADMIN: 'مدير النظام', MANAGER: 'مدير', EMPLOYEE: 'موظف' };

/**
 * Renders the sidebar nav AND fetches the current logged-in user (async —
 * callers don't need to await it, the sidebar just fills in a moment
 * later). This is also what keeps every page protected: if nobody is
 * logged in, the /api/auth/me call 401s and api-client.js's global
 * 401-handler redirects to login.html automatically — no separate
 * per-page auth guard needed.
 */
export async function renderSidebar(activeKey) {
  const el = document.getElementById('sidebar');
  if (!el) return;

  const { api } = await import('./api-client.js');
  let user;
  try {
    user = await api.get('/api/auth/me');
  } catch {
    // No backend reachable from this origin (e.g. a legacy static-only page
    // opened just for its own local tools) — never let this become an
    // unhandled rejection that blocks the calling page's init(); just show
    // every nav item with no user footer instead of crashing.
    el.innerHTML = `
      <div class="brand">📈 نظام مراقبة المنتجات<small>مركز التحكم بالتجارة الإلكترونية</small></div>
      <nav>${NAV_ITEMS.map((i) => `<a href="${i.href}" class="${i.key === activeKey ? 'active' : ''}">${i.icon} ${i.label}</a>`).join('')}</nav>
    `;
    const { mountThemeToggle } = await import('./theme.js');
    mountThemeToggle();
    return;
  }

  const visibleItems = NAV_ITEMS.filter((i) => {
    if (OWNER_ONLY_NAV.has(i.key)) return !!user.is_owner;
    const allowedRoles = NAV_ROLE_REQUIREMENT[i.key];
    return !allowedRoles || allowedRoles.includes(user.role);
  });

  el.innerHTML = `
    <div class="brand">📈 نظام مراقبة المنتجات<small>مركز التحكم بالتجارة الإلكترونية</small></div>
    <nav>${visibleItems.map(
      (i) => `<a href="${i.href}" class="${i.key === activeKey ? 'active' : ''}">${i.icon} <span>${i.label}</span>${i.badgeId ? `<span class="nav-badge" id="${i.badgeId}" style="display:none;"></span>` : ''}</a>`
    ).join('')}</nav>
    <div class="sidebar-user">
      <div class="sidebar-user-name">${escapeHtml(user.name)}</div>
      <div class="sidebar-user-role">${ROLE_LABELS_AR[user.role] || user.role}</div>
      <button type="button" id="sidebarLogout" class="sidebar-logout-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        تسجيل الخروج
      </button>
    </div>
  `;

  const { mountThemeToggle } = await import('./theme.js');
  mountThemeToggle();

  document.getElementById('sidebarLogout')?.addEventListener('click', logout);

  if (visibleItems.some((i) => i.badgeId === 'navLostOrdersBadge')) {
    try {
      const { count } = await api.get('/api/lost-orders/new-count');
      const badge = document.getElementById('navLostOrdersBadge');
      if (badge && count > 0) {
        badge.textContent = count;
        badge.style.display = '';
      }
    } catch {
      // Non-critical — the sidebar itself already rendered successfully; a failed badge count just stays hidden.
    }
  }
}

/**
 * Small themed yes/no dialog (dynamically mounted — no per-page HTML
 * needed, unlike the existing inline task/permissions modals). Resolves
 * `true` on confirm, `false` on cancel/Escape/backdrop click.
 */
export function confirmModal({ title = '', message = '', confirmLabel = 'تأكيد', cancelLabel = 'إلغاء', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal-overlay';
    overlay.innerHTML = `
      <div class="card confirm-modal-card">
        ${title ? `<div class="section-title" style="margin-top:0;">${escapeHtml(title)}</div>` : ''}
        <p class="muted" style="margin:0 0 18px;">${escapeHtml(message)}</p>
        <div class="toolbar" style="justify-content:flex-end;">
          <button type="button" class="btn secondary" data-action="cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn ${danger ? 'danger' : ''}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    function onKey(e) {
      if (e.key === 'Escape') close(false);
    }
    overlay.querySelector('[data-action="cancel"]').onclick = () => close(false);
    overlay.querySelector('[data-action="confirm"]').onclick = () => close(true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey);
  });
}

/**
 * The one place logout actually happens — called from the sidebar button
 * AND the Settings → الحساب section, so both stay in sync automatically.
 * Confirms first (spec: "Confirmation Dialog قبل الخروج"), then hits the
 * real /api/auth/logout endpoint (clears the httpOnly session cookie
 * server-side) before redirecting — never just a client-side redirect.
 */
export async function logout() {
  const ok = await confirmModal({
    title: '🚪 تسجيل الخروج',
    message: 'هل أنت متأكد أنك تريد تسجيل الخروج؟',
    confirmLabel: 'تسجيل الخروج',
    cancelLabel: 'إلغاء',
    danger: true,
  });
  if (!ok) return;
  const { api } = await import('./api-client.js');
  await api.post('/api/auth/logout');
  location.href = 'login.html';
}

// ---------------------------------------------------------------------------
// Stat tiles — one shared renderer for the `.stat-tile` cards used across
// manager.js/work.js/inventory-page.js/product-details.js/tasks.js. Most of
// those labels already carry a hand-chosen leading emoji (e.g. "⏳ متبقي") —
// this pulls that same emoji into the new `.stat-tile-icon` box instead of
// inventing a new icon-lookup table, so the icon is still 100% real,
// already-existing information, just repositioned. Labels with no leading
// emoji simply render without an icon box (never a fabricated one).
// ---------------------------------------------------------------------------

const LEADING_EMOJI_RE = /^(\p{Extended_Pictographic}️?)\s*/u;

/** @param {string} label @param {string|number} value @param {{colorClass?:string, fontSize?:string}} [opts] */
export function statTile(label, value, opts = {}) {
  const match = label.match(LEADING_EMOJI_RE);
  const icon = match ? match[1] : null;
  const text = match ? label.slice(match[0].length) : label;
  const valueStyle = opts.fontSize ? ` style="font-size:${opts.fontSize}"` : '';
  return `<div class="stat-tile">
    ${icon ? `<div class="stat-tile-icon">${icon}</div>` : ''}
    <div class="label">${text}</div>
    <div class="value${opts.colorClass ? ' ' + opts.colorClass : ''}"${valueStyle}>${value}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtNum(n, decimals = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '<span class="no-data">لا توجد بيانات كافية</span>';
  return n.toFixed(decimals);
}

export function fmtAvg(n) {
  if (n === null || n === undefined) return '<span class="no-data">—</span>';
  return n.toFixed(1);
}

export function fmtPct(n, decimals = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '<span class="faint">—</span>';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}%`;
}

export function fmtChangeAbs(n) {
  if (n === null || n === undefined) return '—';
  if (n > 0) return `+${n}`;
  return `${n}`;
}

/** Money amounts, always with the جنيه unit so a bare number is never ambiguous. */
export function fmtCurrency(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '<span class="no-data">البيانات غير متوفرة</span>';
  const sign = n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })} جنيه`;
}

export function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s ?? '';
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Status / Recommendation / Health visuals — Arabic display text, English
// `status`/`type` code kept as the CSS class so styling stays keyed off the
// stable internal code even though the visible label is Arabic.
// ---------------------------------------------------------------------------

const STATUS_LABELS = {
  UP: { text: '🟢 أداء جيد', color: 'green' },
  STABLE: { text: '➖ مستقر', color: 'gray' },
  DOWN: { text: '🟡 يحتاج متابعة', color: 'yellow' },
  CRITICAL: { text: '🚨 يحتاج تدخل عاجل', color: 'red' },
  NEW: { text: '🆕 منتج جديد', color: 'gray' },
  NO_DATA: { text: 'لا توجد بيانات كافية', color: 'gray' },
};

export function statusBadge(status) {
  const meta = STATUS_LABELS[status] || STATUS_LABELS.NO_DATA;
  return `<span class="badge ${meta.color}">${meta.text}</span>`;
}

const REC_LABELS = {
  KEEP: '🟢 أداء جيد',
  NORMAL: '🟢 أداء جيد',
  WATCH: '🟡 يحتاج متابعة',
  SCALE: '🔥 فرصة للتوسع',
  FIX: '🔧 يحتاج تحسين',
  EXIT: '⛔ مرشح للإيقاف',
  RESTOCK: '📦 يحتاج إعادة طلب',
  NEW: '🆕 منتج جديد',
};

export function recPill(type) {
  return `<span class="rec-pill ${type}">${REC_LABELS[type] || type}</span>`;
}

/** Free-text recommendation call-to-action, one per V2 recommendation type. */
export function recActionText(type) {
  const texts = {
    SCALE: 'فكّر في زيادة الميزانية الإعلانية تدريجيًا.',
    WATCH: 'تابع الأداء خلال الـ24–48 ساعة القادمة.',
    FIX: 'راجع المحتوى الإعلاني والعرض والجمهور المستهدف قبل زيادة الإنفاق.',
    EXIT: 'فكّر في إيقاف هذا المنتج.',
    RESTOCK: 'أعد طلب المخزون فورًا.',
    NORMAL: 'الأداء طبيعي — استمر في المتابعة الدورية.',
    NEW: 'منتج جديد — لسه مبقاش عنده بيانات كافية لقرار واضح.',
  };
  return texts[type] || '';
}

export function cpaStatusBadge(status) {
  if (status === 'PROFITABLE') return '<span class="badge green">🟢 تكلفة الأوردر مناسبة</span>';
  if (status === 'UNPROFITABLE') return '<span class="badge red">🔴 تكلفة الأوردر مرتفعة جدًا</span>';
  return '<span class="badge gray">البيانات غير متوفرة</span>';
}

export function stockStatusBadge(status, daysRemaining) {
  const days = daysRemaining !== null && daysRemaining !== undefined ? `(${daysRemaining.toFixed(1)} يوم متبقي)` : '';
  if (status === 'CRITICAL') return `<span class="badge red">🚨 يحتاج إعادة طلب فورًا ${days}</span>`;
  if (status === 'LOW') return `<span class="badge yellow">⚠️ مخزون منخفض ${days}</span>`;
  if (status === 'OK') return `<span class="badge green">🟢 المخزون كافٍ ${days}</span>`;
  return '<span class="badge gray">غير متتبَّع</span>';
}

export function healthColor(score) {
  if (score >= 80) return 'green';
  if (score >= 60) return 'green';
  if (score >= 40) return 'yellow';
  return 'red';
}

export function healthBar(score) {
  const color = healthColor(score);
  const varColor = color === 'green' ? 'var(--green)' : color === 'yellow' ? 'var(--yellow)' : 'var(--red)';
  return `<span class="health-bar-track"><span class="health-bar-fill" style="width:${score}%; background:${varColor}"></span></span> <span class="mono">${score}</span>`;
}

/** Translates analytics.js's health.label / recommendation-engine.js's productScore label ('Excellent', '🔥 Excellent', 'Good', ...) to Arabic. */
const SCORE_LABELS_AR = {
  Excellent: '🔥 ممتاز',
  Good: '🟢 جيد',
  Watch: '🟡 يحتاج متابعة',
  Danger: '🔴 خطر',
  'Exit Candidate': '⛔ مرشح للإيقاف',
};

export function scoreLabelAr(label) {
  const stripped = (label || '').replace(/^[^\p{L}]*/u, '').trim(); // drop any leading emoji
  return SCORE_LABELS_AR[stripped] || label;
}

const TREND_LABELS_AR = {
  STRONG_UP: '📈 اتجاه صاعد بقوة',
  STRONG_DOWN: '📉 اتجاه هابط بقوة',
  VOLATILE: '↔️ أداء متذبذب',
  STABLE: '➖ مستقر',
  INSUFFICIENT: '🆕 لا توجد بيانات كافية',
};

export function trendLabel(trend) {
  return TREND_LABELS_AR[trend.code] || `${trend.icon} ${trend.label}`;
}

/**
 * Translates the finite, known set of English reason sentences produced by
 * analytics.js's recommend() and recommendation-engine.js's
 * buildRecommendationV2() into natural Arabic, preserving embedded numbers.
 * Anything unrecognized is returned as-is rather than silently dropped —
 * that closed set is fully covered below and exercised by the test data,
 * so the fallback should never actually trigger in practice.
 */
export function translateReason(text) {
  const rules = [
    [/^Not enough data for reliable trend analysis\.$/, () => 'لا توجد بيانات كافية لتحليل الأداء بشكل موثوق.'],
    [/^(\d+) days declining$/, (m) => `الأداء بيتراجع من ${m[1]} يوم متتالي`],
    [/^(\d+)D performance: (-?[\d.]+)%$/, (m) => `الأداء خلال آخر ${m[1]} أيام: ${m[2]}% عن المعدل الطبيعي`],
    [/^Health Score: (\d+)\/100$/, (m) => `تقييم حالة المنتج: ${m[1]} من 100`],
    [/^Orders below normal$/, () => 'عدد الأوردرات أقل من الطبيعي'],
    [/^Strong upward trend$/, () => 'اتجاه صاعد بقوة'],
    [/^Orders above baseline$/, () => 'الأوردرات أعلى من المعدل الطبيعي'],
    [/^Consistent performance$/, () => 'أداء ثابت ومستقر'],
    [/^Performance below normal — monitor closely$/, () => 'الأداء أقل من الطبيعي — يحتاج متابعة عن قرب'],
    [/^Performance within normal range$/, () => 'الأداء ضمن المعدل الطبيعي'],
    [/^Losing (-?[\d.]+) per order at current CPA/, (m) => `المنتج بيخسر ${Math.abs(m[1])} جنيه في كل أوردر عند تكلفة الأوردر الحالية — راجع الربحية قبل زيادة الميزانية`],
    [/^Profitable: \+?(-?[\d.]+) per order$/, (m) => `المنتج مربح: +${m[1]} جنيه لكل أوردر`],
    [/^Currently unprofitable: (-?[\d.]+) per order at current CPA$/, (m) => `المنتج غير مربح حاليًا: خسارة ${Math.abs(m[1])} جنيه لكل أوردر عند تكلفة الأوردر الحالية`],
    [/^Still profitable despite the decline — review before exiting$/, () => 'لا يزال مربحًا رغم التراجع — راجعه قبل اتخاذ قرار الإيقاف'],
    [/^Profit: Negative$/, () => 'الربح: خسارة'],
    [/^Profit: \+?(-?[\d.]+)\/order$/, (m) => `الربح: ${Number(m[1]) >= 0 ? '+' : ''}${m[1]} جنيه لكل أوردر`],
    [/^Only ([\d.]+) days of stock left$/, (m) => `متبقٍ ${m[1]} يوم فقط من المخزون`],
  ];
  for (const [pattern, toArabic] of rules) {
    const m = text.match(pattern);
    if (m) return toArabic(m);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/**
 * Product Score circle (spec sections 1-2) — `result` is a
 * calculateProductScore() (product-score.js) return value. Click target
 * only; the caller wires the actual click handler (see score-modal.js).
 */
export function scoreCircleHtml(result, size = 'md') {
  const dim = size === 'sm' ? 34 : 56;
  const fontSize = size === 'sm' ? 12 : 18;
  const display = result.score === null ? '—' : result.score;
  return `
    <div class="score-circle-wrap" data-score-trigger>
      <div class="score-circle ${result.color}" style="width:${dim}px; height:${dim}px; font-size:${fontSize}px;">${display}</div>
      ${size === 'sm' ? '' : `<div class="score-circle-label">${result.label}</div>`}
    </div>`;
}

export function productLink(id) {
  return `product.html?id=${id}`;
}

export function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}
