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

export const NAV_ITEMS = [
  { key: 'dashboard', href: 'index.html', label: 'نظرة سريعة', icon: '📊' },
  { key: 'tasks', href: 'tasks.html', label: 'تاسكات اليوم', icon: '🎯' },
  { key: 'work', href: 'work.html', label: 'الشغل اللي هيتعمل', icon: '🛠️' },
  { key: 'manager', href: 'manager.html', label: 'تحكم المدير', icon: '👑' },
  { key: 'inventory', href: 'inventory.html', label: 'إدارة المخزون', icon: '🏭' },
  { key: 'products', href: 'products.html', label: 'المنتجات', icon: '📦' },
  { key: 'entry', href: 'entry.html', label: 'إدخال الأوردرات', icon: '📝' },
  { key: 'alerts', href: 'alerts.html', label: 'التنبيهات', icon: '🔔' },
  { key: 'compare', href: 'compare.html', label: 'مقارنة المنتجات', icon: '⚖️' },
  { key: 'ranking', href: 'ranking.html', label: 'ترتيب الربحية', icon: '🏆' },
  { key: 'settings', href: 'settings.html', label: 'إعدادات النظام', icon: '⚙️' },
  { key: 'users', href: 'users.html', label: 'إدارة المستخدمين', icon: '👥' },
  { key: 'test', href: 'test.html', label: 'اختبارات النظام', icon: '✅' },
];

// Nav items hidden per role — 'manager'/'work' need MANAGER or ADMIN,
// 'settings' (holds the data-migration + integration controls) needs ADMIN.
const NAV_ROLE_REQUIREMENT = {
  manager: ['ADMIN', 'MANAGER'],
  work: ['ADMIN', 'MANAGER'],
  settings: ['ADMIN'],
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
      (i) => `<a href="${i.href}" class="${i.key === activeKey ? 'active' : ''}">${i.icon} ${i.label}</a>`
    ).join('')}</nav>
    <div class="sidebar-user" style="margin-top:auto; padding:14px 16px; border-top:1px solid var(--border); font-size:12.5px;">
      <div>${escapeHtml(user.name)}</div>
      <div class="faint">${ROLE_LABELS_AR[user.role] || user.role}</div>
      <a href="#" id="sidebarLogout" style="display:inline-block; margin-top:6px;">🚪 تسجيل خروج</a>
    </div>
  `;

  document.getElementById('sidebarLogout')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await api.post('/api/auth/logout');
    location.href = 'login.html';
  });
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
