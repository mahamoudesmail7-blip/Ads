// tasks-ui.js — «توزيع المهام»: PURE rendering of the new board (no network, no state of its own). daily-tasks.js owns the state + the events and calls these functions.
// Presentation only: every number shown comes from the day view the server already returns; nothing here creates, distributes or judges a task.
import { escapeHtml as E, shellHref } from './ui-common.js';

// ───────────── Lucide icons (inline, so the page has no external dependency) ─────────────
const P = {
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'flask-conical': '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  'circle-alert': '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  circle: '<circle cx="12" cy="12" r="10"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  funnel: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>', 'chevron-right': '<path d="m9 18 6-6-6-6"/>', 'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  'external-link': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  'shopping-bag': '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  'arrow-left-right': '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  'chevrons-up': '<path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  'check-check': '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  'user-minus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" x2="16" y1="11" y2="11"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  'bar-chart': '<path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};
export const ic = (n, s = 18, cls = '') => `<svg class="lu ${cls}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ''}</svg>`;

// ───────────── vocabulary ─────────────
export const PRI = { HIGH: 3, MED: 2, LOW: 1 };
export const PRI_META = { HIGH: { label: 'عالية', cls: 'p-high', icon: 'chevrons-up' }, MED: { label: 'متوسطة', cls: 'p-med', icon: 'star' }, LOW: { label: 'منخفضة', cls: 'p-low', icon: 'circle' } };
export const TAB_META = {
  SCALE: { label: 'اسكيل', chip: 'اسكيل', icon: 'rocket', cls: 't-scale' },
  PROBLEM: { label: 'حل مشاكل', chip: 'حل مشكلة', icon: 'triangle-alert', cls: 't-problem' },
  TEST: { label: 'تيستات جديدة', chip: 'تيست جديد', icon: 'flask-conical', cls: 't-test' },
  MIX: { label: 'مهام متنوعة', chip: 'أخرى', icon: 'layers', cls: 't-mix' },
};
export const STATUS_META = {
  NEW: { label: 'جديدة', cls: 's-new', icon: 'sparkles' }, PROG: { label: 'قيد التنفيذ', cls: 's-prog', icon: 'play' }, DONE: { label: 'مكتملة', cls: 's-done', icon: 'circle-check' },
  LATE: { label: 'متأخرة', cls: 's-late', icon: 'clock' }, REVIEW: { label: 'تحتاج مراجعة', cls: 's-review', icon: 'circle-alert' }, NOTDONE: { label: 'ماتعملتش', cls: 's-late', icon: 'x' },
};
const STATUS_RANK = { REVIEW: 0, LATE: 1, PROG: 2, NEW: 3, NOTDONE: 4, DONE: 5 };
const OPEN = ['PENDING', 'IN_PROGRESS', 'NOT_DONE'];
const EXPECT = {
  SCALE: 'أوردرات أكتر من الحملة الرابحة، مع تكلفة أوردر تفضل تحت الحد.',
  ZERO_ORDERS: 'إما الصرف الضايع يقف، أو الحملة تبدأ تجيب أوردرات بعد التعديل.',
  CPA: 'تكلفة الأوردر ترجع تحت الحد بعد التخفيض أو الإيقاف.',
  TEST: 'نعرف بعد 48 ساعة لو الكرياتيف الجديد يستاهل اسكيل.',
  STOCK: 'مانصرفش فلوس على منتج مفيهوش بضاعة كفاية.',
  FUNDS: 'الإعلانات ماتقفش بسبب الرصيد.',
  DECISIONS: 'القرارات تتراجع وتتعتمد في وقتها.',
  OPEN_PLAN: 'خطة الفتح تتراجع وتتعتمد قبل ميعادها.',
  CLONE: 'الدفعة تكمل من غير اسكيل مكرر.',
  REVIEW: 'نمسك أي مشكلة بدري قبل ما تكبر.',
};

export const tabOf = (t) => {
  if (t.type === 'SCALE') return 'SCALE';
  if (t.type === 'ZERO_ORDERS' || t.type === 'CPA') return 'PROBLEM';
  if (t.type === 'TEST') return 'TEST';
  if (t.type === 'MANUAL') return t.category === 'SCALE' ? 'SCALE' : t.category === 'FIX' ? 'PROBLEM' : 'MIX';
  return 'MIX';
};
export const isOpenTask = (t) => OPEN.includes(t.status);
export const isLate = (t, date) => isOpenTask(t) && (t.source === 'CARRIED' || (t.originDate && t.originDate < date));
export function statusKey(t, date) {
  if (['DONE', 'AUTO_RESOLVED'].includes(t.status)) return 'DONE';
  if (t.status === 'NEEDS_REVIEW') return 'REVIEW';
  if (t.status === 'NOT_DONE') return 'NOTDONE';
  if (isLate(t, date)) return 'LATE';
  return t.status === 'IN_PROGRESS' ? 'PROG' : 'NEW';
}
export const planTotal = (t) => (Array.isArray(t.plan) ? t.plan.reduce((a, p) => a + (Number(p.budget) || 0), 0) : 0);
export const num = (n) => Number(n || 0).toLocaleString('en-US');
export function actionText(t) {
  if (t.type === 'SCALE' && Array.isArray(t.plan) && t.plan.length) {
    const abo = t.plan.filter((p) => p.mode === 'ABO'); const cbo = t.plan.filter((p) => p.mode === 'CBO'); const parts = [];
    if (abo.length) parts.push(`ABO ${num(abo[0].budget)} ×${abo.length}`); if (cbo.length) parts.push(`CBO ${num(cbo[0].budget)} ×${cbo.length}`);
    return `${t.plan.length > 2 ? 'اسكيل قوي' : t.plan.length === 1 ? 'اسكيل بحذر' : 'اسكيل'}: ${parts.join(' + ')}`;
  }
  return t.title;
}
export const productOf = (t) => (t.product && t.product.name) || 'مهمة عامة';
const hhmm = (iso) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); } catch { return ''; } };
const dm = (d) => { try { return new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)); } catch { return d; } };
const COLORS = ['#7c5cff', '#0ea5e9', '#14b86e', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6'];
export const colorOf = (v, id) => COLORS[Math.max(0, v.team.findIndex((m) => m.id === id)) % COLORS.length];

// ───────────── filtering / sorting (view-only) ─────────────
export function visibleTasks(v) { return (v.tasks || []).filter((t) => t.status !== 'CANCELLED'); }
export function applyFilters(S, v, { ignoreTab = false } = {}) {
  const f = S.f; const q = f.q.trim().toLowerCase();
  return visibleTasks(v).filter((t) => {
    if (f.who !== 'ALL' && (f.who === 'NONE' ? t.assigneeId : t.assigneeId !== f.who)) return false;
    if (!ignoreTab && f.cat !== 'ALL') { if (f.cat === 'LATE') { if (!['LATE', 'NOTDONE'].includes(statusKey(t, S.date))) return false; } else if (tabOf(t) !== f.cat) return false; }
    if (f.types.size && !f.types.has(tabOf(t))) return false;
    if (f.statuses.size && !f.statuses.has(statusKey(t, S.date))) return false;
    if (f.prios.size && !f.prios.has(t.priority)) return false;
    if (q && !`${t.title} ${productOf(t)} ${t.why || ''}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (STATUS_RANK[statusKey(a, S.date)] - STATUS_RANK[statusKey(b, S.date)]) || (PRI[b.priority] - PRI[a.priority]) || ((b.carryCount || 0) - (a.carryCount || 0)) || String(a.createdAt).localeCompare(String(b.createdAt)));
}
export function kpis(v, date) {
  const live = visibleTasks(v); const open = live.filter(isOpenTask);
  const products = new Set(open.filter((t) => ['ZERO_ORDERS', 'CPA', 'STOCK'].includes(t.type)).map((t) => productOf(t)));
  return { total: live.length, rate: v.summary.rate, late: live.filter((t) => ['LATE', 'NOTDONE'].includes(statusKey(t, date))).length, scale: open.filter((t) => t.type === 'SCALE').length, tests: open.filter((t) => t.type === 'TEST').length, products: products.size, review: live.filter((t) => t.status === 'NEEDS_REVIEW').length, unassigned: v.summary.unassigned || 0, people: new Set(live.filter((t) => t.assigneeId).map((t) => t.assigneeId)).size };
}

// ───────────── small pieces ─────────────
const avatar = (v, id, name, sz = 28) => `<span class="dx-av" style="--c:${id ? colorOf(v, id) : '#94a3b8'};width:${sz}px;height:${sz}px;font-size:${Math.round(sz * 0.46)}px">${E([...(name || '؟')][0] || '؟')}</span>`;
export const typeChip = (t) => { const m = TAB_META[tabOf(t)]; return `<span class="dx-type ${m.cls}">${ic(m.icon, 16)}<b>${m.chip}</b></span>`; };
export const statusChip = (t, date) => { const m = STATUS_META[statusKey(t, date)]; return `<span class="dx-st ${m.cls}">${ic(m.icon, 14)}${m.label}</span>`; };
export const prioChip = (t) => { const m = PRI_META[t.priority] || PRI_META.MED; return `<span class="dx-pr ${m.cls}">${ic(m.icon, 14)}${m.label}</span>`; };
const ring = (pct, sz = 46) => `<span class="dx-ring" style="--p:${pct ?? 0};width:${sz}px;height:${sz}px"><b>${pct == null ? '—' : pct + '%'}</b></span>`;

// ───────────── manager: KPI strip ─────────────
export function kpiStrip(S, v) {
  const k = kpis(v, S.date); const card = (icon, tone, label, val, hint = '') => `<div class="dx-kpi"><span class="dx-ico ${tone}">${ic(icon, 22)}</span><div><small>${label}</small><b>${val}</b>${hint ? `<em>${hint}</em>` : ''}</div></div>`;
  return `<div class="dx-kpis">
    <div class="dx-plan"><div><small>خطة اليوم</small><b>${k.total}<span> مهمة</span></b><em>${k.unassigned ? `${k.unassigned} لسه محدّش استلمها — اضغط «توزيع المهام تلقائيًا»` : `موزّعة على ${k.people} ${k.people === 1 ? 'عضو' : 'أعضاء'}`}</em></div><span class="dx-plan-ico">${ic('layers', 30)}</span></div>
    ${card('circle-check', 'tone-green', 'نسبة الإنجاز', k.rate == null ? '—' : `${k.rate}%`, k.review ? `${k.review} مستنية مراجعة` : '')}
    ${card('clock', 'tone-red', 'مهام متأخرة', k.late)}
    ${card('rocket', 'tone-green2', 'فرص اسكيل جاهزة', k.scale)}
    ${card('flask-conical', 'tone-blue', 'تيست جديد مطلوب', k.tests)}
    ${card('shopping-bag', 'tone-pink', 'منتجات تحتاج تدخل', k.products)}
  </div>`;
}

// ───────────── manager: does today's plan hold the minimum for everyone? ─────────────
export function quotaCard(S, v) {
  const st = v.quotaStatus; const q = v.quota; if (!st || !q) return '';
  const kinds = ['SCALE', 'PROBLEM', 'TEST', 'MIX']; const need = kinds.reduce((a, k) => a + (st[k]?.need || 0), 0); if (!need) return '';
  const short = kinds.filter((k) => (st[k]?.have || 0) < (st[k]?.need || 0)); const people = v.team.filter((m) => m.active).length;
  const bar = (k) => { const s = st[k] || { need: 0, have: 0 }; const pct = s.need ? Math.min(100, Math.round((s.have / s.need) * 100)) : 100; return `<div class="dx-q ${s.have < s.need ? 'low' : 'ok'}"><span>${KIND_SHORT[k]}</span><i><b style="width:${pct}%"></b></i><em>${s.have} / ${s.need}</em></div>`; };
  return `<section class="dx-card dx-quota ${short.length ? 'short' : 'full'}"><header><h3>${ic(short.length ? 'triangle-alert' : 'circle-check', 18)} ${short.length ? 'خطة اليوم ناقصة عن الحد الأدنى' : 'خطة اليوم مكتملة: كل واحد هياخد الحد الأدنى'}</h3><span class="dx-minline">الحد الأدنى لكل ميديا باير: اسكيل ${q.SCALE} · مشاكل ${q.PROBLEM} · تيست ${q.TEST} · متنوع ${q.MIX} (× ${people})</span></header>
    <div class="dx-qbars">${kinds.map(bar).join('')}</div>
    ${short.length ? `<p class="dx-hint">المهام بتتولّد من أرقام الحملات الحقيقية. اللي ناقص (${short.map((k) => `${KIND_SHORT[k]} ${(st[k].need - st[k].have)}`).join('، ')}) مفيش داتا كفاية تطلّعه، ومبنألفش مهام وهمية. تقدر تضيف مهام يدوي، أو تنزّل الحد الأدنى من الإعدادات.</p>` : ''}</section>`;
}

// ───────────── manager: team card ─────────────
const KIND_SHORT = { SCALE: 'اسكيل', PROBLEM: 'مشاكل', TEST: 'تيست', MIX: 'متنوع' };
/** per-kind counts of one person, red when under the minimum the owner set (so «at least N each» is visible at a glance) */
function kindRow(v, mine) {
  const q = v.quota; if (!q) return '';
  return `<span class="dx-kinds">${['SCALE', 'PROBLEM', 'TEST', 'MIX'].map((k) => { const n = mine.filter((t) => tabOf(t) === k).length; return `<i class="${n < (q[k] || 0) ? 'low' : 'ok'}" title="${KIND_SHORT[k]}: ${n} من الحد الأدنى ${q[k] || 0}">${KIND_SHORT[k]} <b>${n}</b></i>`; }).join('')}</span>`;
}

export function teamCard(S, v) {
  const rows = v.team.filter((m) => m.active).map((m) => {
    const mine = visibleTasks(v).filter((t) => t.assigneeId === m.id); const done = mine.filter((t) => ['DONE', 'AUTO_RESOLVED'].includes(t.status)).length; const pct = mine.length ? Math.round((done / mine.length) * 100) : 0;
    const late = mine.filter((t) => ['LATE', 'NOTDONE'].includes(statusKey(t, S.date))).length; const on = S.f.who === m.id;
    return `<div class="dx-memrow"><button class="dx-mem ${on ? 'on' : ''}" data-who="${m.id}" title="اعرض مهامه بس">${avatar(v, m.id, m.name, 42)}<span class="nm"><b>${E(m.name)}${m.off ? '<i class="dx-off">إجازة</i>' : ''}</b><small>${done}/${mine.length} مهمة${late ? ` · <u>${late} متأخرة</u>` : ''}</small></span>${ring(mine.length ? pct : null)}${kindRow(v, mine)}</button><span class="dx-memside"><button class="dx-memadd" data-addfor="${m.id}" title="ادّي ${E(m.name)} مهمة بإيدك" aria-label="إضافة مهمة لـ ${E(m.name)}">${ic('plus', 18)}</button><button class="dx-memrm" data-rmmem="${m.id}" title="شيل ${E(m.name)} من الفريق" aria-label="شيل ${E(m.name)} من الفريق">${ic('user-minus', 16)}</button></span></div>`;
  }).join('');
  const un = v.summary.unassigned;
  return `<section class="dx-card"><header><h3>${ic('users', 18)} فريق الميديا بايرز (${v.team.filter((m) => m.active).length})</h3>${S.f.who !== 'ALL' ? '<button class="dx-link" data-who="ALL">عرض الكل</button>' : ''}</header>
    <div class="dx-mems">${rows}${un ? `<button class="dx-mem pool ${S.f.who === 'NONE' ? 'on' : ''}" data-who="NONE">${avatar(v, null, '؟', 42)}<span class="nm"><b>لسه مفيش مسؤول</b><small>${un} مهمة مجمّعة</small></span></button>` : ''}</div>
    <button class="dx-addmem" data-act="add-member">${ic('user-plus', 17)} إضافة موظف جديد</button></section>`;
}

// ───────────── manager: products that need intervention ─────────────
export function interventionCard(S, v) {
  const open = visibleTasks(v).filter(isOpenTask).filter((t) => ['ZERO_ORDERS', 'CPA', 'STOCK'].includes(t.type));
  const by = new Map();
  for (const t of open.sort((a, b) => PRI[b.priority] - PRI[a.priority])) { const k = productOf(t); if (by.has(k)) continue; by.set(k, t); }
  const items = [...by.values()]; const REASON = { ZERO_ORDERS: ['صرف بدون أوردرات', 'bad'], CPA: ['CPA مرتفع', 'warn'], STOCK: ['مخزون', 'info'] };
  const detail = (t) => { const f = (t.facts || []).find((x) => /تكلفة الأوردر|صرف/.test(x.l)); return f ? `${f.l}: ${f.v}` : ''; };
  return `<section class="dx-card"><header><h3>${ic('triangle-alert', 18)} منتجات تحتاج تدخل (${items.length})</h3></header>
    <div class="dx-iv">${items.slice(0, 4).map((t) => { const r = REASON[t.type]; return `<button class="dx-iv-row" data-open="${t.id}"><span class="ivt"><b>${E(productOf(t))}</b><small>${E(detail(t))}</small></span><span class="dx-tag ${r[1]}">${r[0]}</span></button>`; }).join('') || '<div class="dx-none">مفيش منتجات محتاجة تدخل دلوقتي ✅</div>'}</div>
    ${items.length ? `<button class="dx-wide" data-cat="PROBLEM">عرض كل المنتجات (${items.length})</button>` : ''}</section>`;
}

// ───────────── manager: filters card ─────────────
export function filtersCard(S, v) {
  const chk = (g, val, label, extra = '') => `<label class="dx-chk"><input type="checkbox" data-ft="${g}" value="${val}" ${S.f[g].has(val) ? 'checked' : ''}><span class="bx"></span>${extra}${label}</label>`;
  return `<section class="dx-card dx-filters" id="dxFilters"><header><h3>${ic('funnel', 18)} تصفية المهام</h3>${S.f.types.size + S.f.statuses.size + S.f.prios.size + (S.f.who !== 'ALL' ? 1 : 0) ? '<button class="dx-link" data-act="reset-filters">مسح</button>' : ''}</header>
    ${S.mgr ? `<div class="dx-fg"><label>المسؤول</label><div class="dx-sel"><select data-f="who"><option value="ALL">كل الأعضاء</option>${v.team.filter((m) => m.active).map((m) => `<option value="${m.id}" ${S.f.who === m.id ? 'selected' : ''}>${E(m.name)}</option>`).join('')}<option value="NONE" ${S.f.who === 'NONE' ? 'selected' : ''}>من غير مسؤول</option></select>${ic('chevron-down', 16)}</div></div>` : ''}
    <div class="dx-fg"><label>نوع المهمة</label>${['SCALE', 'PROBLEM', 'TEST', 'MIX'].map((k) => chk('types', k, TAB_META[k].chip, `<i class="dx-mi ${TAB_META[k].cls}">${ic(TAB_META[k].icon, 14)}</i>`)).join('')}</div>
    <div class="dx-fg"><label>الحالة</label>${['NEW', 'PROG', 'REVIEW', 'DONE', 'LATE'].map((k) => chk('statuses', k, STATUS_META[k].label)).join('')}</div>
    <div class="dx-fg"><label>أولوية المهمة</label>${['HIGH', 'MED', 'LOW'].map((k) => chk('prios', k, PRI_META[k].label, `<i class="dx-pd ${PRI_META[k].cls}"></i>`)).join('')}</div>
    ${S.mgr ? `<button class="dx-cta" data-act="dist-preview">${ic('sparkles', 18)} توزيع المهام تلقائيًا</button><button class="dx-cta2" data-act="add-task">${ic('plus', 18)} إضافة مهمة</button>` : ''}</section>`;
}

// ───────────── manager: the task list ─────────────
function pager(S, total) {
  const pages = Math.max(1, Math.ceil(total / S.size)); const cur = Math.min(S.page, pages); const from = total ? (cur - 1) * S.size + 1 : 0; const to = Math.min(total, cur * S.size);
  const nums = []; for (let p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - cur) <= 1) nums.push(p); else if (nums[nums.length - 1] !== '…') nums.push('…');
  return `<footer class="dx-pager"><span class="info">عرض ${from} – ${to} من ${total} مهمة</span>
    <div class="pg"><button data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''} aria-label="السابق">${ic('chevron-right', 16)}</button>${nums.map((p) => (p === '…' ? '<i>…</i>' : `<button class="${p === cur ? 'on' : ''}" data-page="${p}">${p}</button>`)).join('')}<button data-page="${cur + 1}" ${cur >= pages ? 'disabled' : ''} aria-label="التالي">${ic('chevron-left', 16)}</button></div>
    <div class="dx-sel sm"><select data-size>${[10, 20, 50].map((n) => `<option value="${n}" ${S.size === n ? 'selected' : ''}>${n}</option>`).join('')}</select>${ic('chevron-down', 14)}</div></footer>`;
}
export function taskRow(S, v, t, { showWho = true } = {}) {
  const who = t.assigneeId ? v.team.find((m) => m.id === t.assigneeId) : null; const tot = planTotal(t);
  return `<button class="dx-row ${statusKey(t, S.date) === 'DONE' ? 'done' : ''}" data-open="${t.id}">
    <span class="c-type">${typeChip(t)}</span>
    <span class="c-prod"><b>${E(productOf(t))}</b></span>
    <span class="c-act">${E(actionText(t))}</span>
    <span class="c-bud">${tot ? `${num(tot)} <small>ج</small>` : '<i>—</i>'}</span>
    ${showWho ? `<span class="c-who">${who ? `${avatar(v, who.id, who.name, 26)}<span>${E(who.name)}</span>` : '<span class="dim">من غير مسؤول</span>'}</span>` : ''}
    <span class="c-st">${statusChip(t, S.date)}</span>
    <span class="c-pr">${prioChip(t)}</span>
  </button>`;
}
export function listCard(S, v) {
  const base = applyFilters(S, v, { ignoreTab: true }); const cnt = (c) => base.filter((t) => (c === 'LATE' ? ['LATE', 'NOTDONE'].includes(statusKey(t, S.date)) : c === 'ALL' ? true : tabOf(t) === c)).length;
  const tabs = [['ALL', 'كل المهام', 'list'], ['SCALE', 'اسكيل', 'rocket'], ['PROBLEM', 'حل مشاكل', 'triangle-alert'], ['TEST', 'تيستات جديدة', 'flask-conical'], ['MIX', 'مهام متنوعة', 'layers'], ['LATE', 'متأخرة', 'clock']];
  const rows = applyFilters(S, v); const pages = Math.max(1, Math.ceil(rows.length / S.size)); if (S.page > pages) S.page = pages; const slice = rows.slice((S.page - 1) * S.size, S.page * S.size);
  return `<section class="dx-card dx-list"><div class="dx-tabs" role="tablist">${tabs.map(([k, l, i]) => `<button role="tab" class="${S.f.cat === k ? 'on' : ''} ${k === 'LATE' ? 'late' : ''}" data-cat="${k}">${ic(i, 16)}<span>${l}</span><em>${cnt(k)}</em></button>`).join('')}</div>
    <div class="dx-search">${ic('search', 17)}<input id="dxQ" type="search" placeholder="ابحث عن منتج أو مهمة…" value="${E(S.f.q)}" autocomplete="off"><button class="dx-fbtn" data-act="toggle-filters" aria-label="تصفية">${ic('funnel', 17)}</button></div>
    <div class="dx-head"><span>المهمة</span><span>المنتج</span><span>الإجراء المطلوب</span><span>الميزانية</span><span>المسؤول</span><span>الحالة</span><span>الأولوية</span></div>
    <div class="dx-rows">${slice.map((t) => taskRow(S, v, t)).join('') || `<div class="dx-empty">${ic('inbox', 34)}<b>مفيش مهام مطابقة</b><small>${visibleTasks(v).length ? 'غيّر الفلاتر أو التبويب.' : 'لو فيه مشاكل أو فرص جديدة هتظهر هنا لوحدها.'}</small></div>`}</div>
    ${rows.length ? pager(S, rows.length) : ''}</section>`;
}

// ───────────── employee screen: «مهامي اليوم» ─────────────
export function employeeBoard(S, v) {
  const mine = applyFilters({ ...S, f: { ...S.f, who: 'ALL', cat: 'ALL', types: new Set(), statuses: new Set(), prios: new Set(), q: '' } }, v);
  const done = mine.filter((t) => statusKey(t, S.date) === 'DONE').length; const late = mine.filter((t) => ['LATE', 'NOTDONE'].includes(statusKey(t, S.date))).length; const prog = mine.filter((t) => statusKey(t, S.date) === 'PROG').length; const rev = mine.filter((t) => t.status === 'NEEDS_REVIEW').length;
  const pct = mine.length ? Math.round((done / mine.length) * 100) : null;
  const stat = (icon, tone, label, val) => `<div class="dx-kpi sm"><span class="dx-ico ${tone}">${ic(icon, 20)}</span><div><small>${label}</small><b>${val}</b></div></div>`;
  const groups = ['SCALE', 'PROBLEM', 'TEST', 'MIX'].map((k) => {
    const list = mine.filter((t) => tabOf(t) === k); const open = list.filter((t) => statusKey(t, S.date) !== 'DONE'); const fin = list.filter((t) => statusKey(t, S.date) === 'DONE'); const key = `emp:${k}`; const exp = S.more.has(key); const shown = exp ? open : open.slice(0, 5);
    const m = TAB_META[k];
    return `<section class="dx-card dx-grp ${m.cls}"><header><h3><i class="dx-mi ${m.cls}">${ic(m.icon, 18)}</i>${m.label}</h3><span class="dx-cnt">${fin.length}/${list.length}</span></header>
      <div class="dx-rows emp">${shown.map((t) => taskRow(S, v, t, { showWho: false })).join('') || `<div class="dx-none">${list.length ? '✅ خلّصت القسم ده' : 'مفيش مهام في القسم ده النهارده'}</div>`}</div>
      ${open.length > 5 ? `<button class="dx-wide" data-more="${key}">${exp ? 'إخفاء' : `عرض المزيد (${open.length - 5})`}</button>` : ''}
      ${fin.length ? `<button class="dx-link done-toggle" data-more="${key}:done">${S.more.has(`${key}:done`) ? 'إخفاء' : 'عرض'} المكتملة (${fin.length})</button>${S.more.has(`${key}:done`) ? `<div class="dx-rows emp">${fin.map((t) => taskRow(S, v, t, { showWho: false })).join('')}</div>` : ''}` : ''}</section>`;
  }).join('');
  return `<div class="dx-kpis emp"><div class="dx-plan"><div><small>مهامي اليوم</small><b>${mine.length}<span> مهمة</span></b><em>${done ? `خلّصت ${done}` : 'لسه ماخلّصتش حاجة'}</em></div><span class="dx-plan-ico">${ic('layers', 30)}</span></div>
    ${stat('circle-check', 'tone-green', 'نسبة الإنجاز', pct == null ? '—' : `${pct}%`)}${stat('play', 'tone-blue', 'قيد التنفيذ', prog)}${stat('circle-alert', 'tone-amber', 'تحتاج مراجعة', rev)}${stat('clock', 'tone-red', 'متأخرة', late)}</div>
    <div class="dx-groups">${groups}</div>`;
}

// ───────────── the side panel (task details) ─────────────
export function drawerHtml(S, v, t) {
  if (!t) return '';
  const can = S.mgr || t.assigneeId === v.mineId; const who = t.assigneeId ? v.team.find((m) => m.id === t.assigneeId) : null; const sk = statusKey(t, S.date); const closed = ['DONE', 'AUTO_RESOLVED', 'CANCELLED'].includes(t.status);
  const late = t.originDate && t.originDate < S.date ? Math.round((Date.parse(S.date) - Date.parse(t.originDate)) / 86_400_000) : 0;
  const steps = (t.steps || []).length ? `<ol class="dx-steps">${t.steps.map((s) => `<li>${E(s)}</li>`).join('')}</ol>` : '';
  const plan = (t.plan || []).length ? `<div class="dx-plan-chips">${t.plan.map((p, i) => `<span class="${p.mode}"><i>${i + 1}</i><b dir="ltr">${p.mode}</b><em>${num(p.budget)} ج</em></span>`).join('')}<span class="tot">الإجمالي ${num(planTotal(t))} ج</span></div>` : '';
  const facts = (t.facts || []).length ? `<div class="dx-facts">${t.facts.map((f) => `<span><small>${E(f.l)}</small><b>${E(f.v)}</b></span>`).join('')}</div>` : '';
  const m = t.meta; const src = m && ['SCALE', 'ZERO_ORDERS', 'CPA', 'TEST', 'REVIEW', 'STOCK'].includes(t.type) ? `<div class="dx-src">${ic('shield-check', 14)} الأرقام: ${E(m.basis || 'Meta')}${m.window ? ` من ${E(dm(m.window.from))} لـ ${E(dm(m.window.to))} (شامل النهارده)` : ''}${m.asOf ? ` · آخر مزامنة ${hhmm(m.asOf)}` : ''}${t.numbersAt ? ` · اتحدّثت ${hhmm(t.numbersAt)}` : ''}</div>` : '';
  const logs = (v.log || []).filter((l) => l.taskId === t.id).slice(0, 8);
  // proof block
  let proof = '';
  if (t.status === 'NEEDS_REVIEW') {
    proof = `<section class="dx-sec"><h4>${ic('circle-alert', 17)} إثبات التنفيذ — مستني مراجعة</h4><div class="dx-proof"><p>${E(t.proof || '')}</p>${t.proofLink ? `<a href="${E(t.proofLink)}" target="_blank" rel="noopener noreferrer">${ic('external-link', 14)} رابط الإثبات</a>` : ''}<small>بعتها ${E(t.submittedBy || '')} ${t.submittedAt ? 'الساعة ' + hhmm(t.submittedAt) : ''}</small></div>
      ${S.mgr ? `<div class="dx-revbtns"><button class="dx-go" data-a="approve" data-id="${t.id}">${ic('check-check', 17)} اعتمد الإثبات</button><button class="dx-sec-btn" data-a="reject" data-id="${t.id}">${ic('x', 16)} ارجّعها مع سبب</button></div>` : '<p class="dx-hint">المدير هيراجع الإثبات، أو السيستم يتأكد لوحده لما المشكلة تتحل.</p>'}</section>`;
  } else if (t.status === 'DONE') {
    proof = `<section class="dx-sec"><h4>${ic('circle-check', 17)} اتقفلت</h4><div class="dx-proof ok"><p>${E(t.proof || t.note || 'اتقفلت من المدير.')}</p><small>${t.verifiedBy === 'SYSTEM' ? 'تحقّق منها السيستم (المشكلة اتحلّت فعلًا)' : t.reviewedBy ? `اعتمدها ${E(t.reviewedBy)}` : 'اتقفلت من المدير'}${t.doneAt ? ' · ' + hhmm(t.doneAt) : ''}</small></div></section>`;
  } else if (t.status === 'AUTO_RESOLVED') {
    proof = `<section class="dx-sec"><h4>${ic('shield-check', 17)} اتحلّت لوحدها</h4><div class="dx-proof ok"><p>${E(t.resolvedNote || 'المشكلة اختفت من بيانات السيستم.')}</p></div></section>`;
  } else if (can && !closed) {
    proof = `<section class="dx-sec"><h4>${ic('send', 17)} إثبات التنفيذ</h4><p class="dx-hint">المهمة مبتتقفلش بضغطة زر. اكتب اللي عملته بالظبط (أو حط رابط)، وهتتراجع أو السيستم يتأكد منها.</p>
      ${t.reviewNote ? `<div class="dx-rej">${ic('circle-alert', 15)} المدير رجّعها: ${E(t.reviewNote)}</div>` : ''}
      <textarea id="dxProof" rows="3" placeholder="مثلًا: عملت 4 اسكيلات على حملة كذا: 2 ABO و2 CBO بـ500 ج…">${E(S.proofDraft[t.id]?.text || '')}</textarea><input id="dxProofLink" type="url" placeholder="رابط الإثبات (اختياري)" value="${E(S.proofDraft[t.id]?.link || '')}" dir="ltr">
      <div class="dx-revbtns"><button class="dx-go" data-a="submit" data-id="${t.id}">${ic('send', 17)} أرسل للمراجعة</button>${t.status === 'PENDING' ? `<button class="dx-sec-btn" data-a="start" data-id="${t.id}">${ic('play', 15)} بدأت</button>` : ''}<button class="dx-sec-btn" data-a="notdone" data-id="${t.id}">${ic('x', 15)} مقدرتش</button></div></section>`;
  }
  const mgrBtns = S.mgr && t.status !== 'CANCELLED' ? `<section class="dx-sec mgr"><h4>${ic('settings', 17)} تحكّم المدير</h4><div class="dx-revbtns">${!closed ? `<button class="dx-sec-btn" data-a="assign" data-id="${t.id}">${ic('arrow-left-right', 15)} حوّلها لشخص</button><button class="dx-sec-btn" data-a="priority" data-id="${t.id}">${ic('flag', 15)} الأولوية</button><button class="dx-sec-btn" data-a="done" data-id="${t.id}">${ic('check-check', 15)} اقفلها مكتملة</button>` : ''}${['DONE', 'NOT_DONE'].includes(t.status) ? `<button class="dx-sec-btn" data-a="reopen" data-id="${t.id}">${ic('refresh-cw', 15)} افتحها تاني</button>` : ''}${!closed ? `<button class="dx-sec-btn danger" data-a="cancel" data-id="${t.id}">${ic('trash', 15)} شيل المهمة</button>` : ''}</div></section>` : '';
  return `<div class="dx-dr-head"><div class="chips">${typeChip(t)}${statusChip(t, S.date)}${prioChip(t)}</div><button class="dx-x" data-act="close-drawer" aria-label="إغلاق">${ic('x', 20)}</button></div>
    <div class="dx-dr-body"><h2>${E(actionText(t) === t.title ? t.title : t.title)}</h2>
      <div class="dx-meta"><span>${ic('shopping-bag', 15)} ${E(productOf(t))}</span><span>${who ? `${avatar(v, who.id, who.name, 20)} ${E(who.name)}` : 'من غير مسؤول'}</span>${late ? `<span class="late">${ic('clock', 15)} متأخرة ${late} ${late === 1 ? 'يوم' : 'أيام'}</span>` : ''}${t.carryCount ? `<span>اتأجّلت ${t.carryCount} ${t.carryCount === 1 ? 'مرة' : 'مرات'}</span>` : ''}</div>
      ${t.why || t.detail ? `<section class="dx-sec"><h4>${ic('triangle-alert', 17)} المشكلة</h4><p>${E(t.why || t.detail)}</p></section>` : ''}
      ${steps || plan ? `<section class="dx-sec"><h4>${ic('list', 17)} المطلوب منك</h4>${plan}${steps}</section>` : ''}
      <section class="dx-sec"><h4>${ic('search', 17)} سبب الاختيار</h4><p>${t.source === 'MANUAL' ? 'المدير ضاف المهمة دي بنفسه.' : t.filler ? 'اتضافت عشان تكمّل الحد الأدنى للمهام من شغل حقيقي على منتج شغّال.' : 'السيستم اختارها من أرقام الحملات الحيّة للأسباب دي:'}</p>${facts}${src}</section>
      <section class="dx-sec"><h4>${ic('rocket', 17)} النتيجة المنتظرة</h4><p>${E(EXPECT[t.type] || 'المهمة تتقفل بإثبات واضح.')}</p></section>
      ${proof}${mgrBtns}
      ${t.link ? `<a class="dx-open-link" href="${E(shellHref(t.link.page))}">${ic('external-link', 16)} ${E(t.link.label)}</a>` : ''}
      ${logs.length ? `<section class="dx-sec"><h4>${ic('history', 17)} سجل المهمة</h4><div class="dx-log">${logs.map((l) => `<div><time>${hhmm(l.at)}</time><span>${E(l.actorName || 'السيستم')} — ${E(l.text || '')}</span></div>`).join('')}</div></section>` : ''}
    </div>`;
}

// ───────────── the distribution preview (before anything changes) ─────────────
export function previewHtml(pv) {
  const total = pv.members.reduce((a, m) => a + m.after, 0);
  return `<h3>${ic('sparkles', 20)} معاينة التوزيع</h3>
    <p class="dx-hint">ده شكل التوزيع لو أكّدت. <b>مفيش حاجة اتغيّرت لسه.</b> اللي بدأ أو خلّص أو اتنقل من إمبارح مش هيتحرّك.</p>
    <div class="dx-pv-sum"><span><b>${pv.moving}</b> مهمة هتتوزّع</span><span><b>${pv.fromPool}</b> من المجمّعة</span><span><b>${pv.moved}</b> هتتنقل من حد لحد</span>${pv.unplaced ? `<span class="warn"><b>${pv.unplaced}</b> مفيش حد متاح ليها</span>` : ''}</div>
    <table class="dx-pv"><thead><tr><th>الشخص</th><th>دلوقتي</th><th>بعد التوزيع</th><th>اسكيل</th><th>مشاكل</th><th>تيست</th><th>متنوّع</th></tr></thead><tbody>${pv.members.map((m) => `<tr class="${m.off ? 'off' : ''}"><td><b>${E(m.name)}</b>${m.off ? ' <i class="dx-off">إجازة</i>' : ''}</td><td>${m.before}</td><td><b>${m.after}</b>${m.added ? ` <span class="add">+${m.added}</span>` : ''}</td>${['SCALE', 'PROBLEM', 'TEST', 'MIX'].map((k) => `<td class="${m[k] < ((pv.quota || {})[k] || 0) ? 'low' : 'okc'}">${m[k]}</td>`).join('')}</tr>`).join('')}</tbody><tfoot><tr><td>الإجمالي</td><td>${pv.members.reduce((a, m) => a + m.before, 0)}</td><td>${total}</td><td colspan="4"></td></tr></tfoot></table>
    ${pv.quota ? `<p class="dx-hint">الحد الأدنى لكل واحد: اسكيل ${pv.quota.SCALE} · مشاكل ${pv.quota.PROBLEM} · تيست ${pv.quota.TEST} · متنوع ${pv.quota.MIX}. <span class="dx-redtxt">الأحمر = أقل من الحد الأدنى</span> (لأن مفيش مهام كفاية من النوع ده في الخطة).</p>` : ''}
    <div class="btns"><button class="dx-sec-btn" data-close>إلغاء</button><button class="dx-go" id="mOk" ${pv.moving ? '' : 'disabled'}>${ic('check-check', 17)} أكّد التوزيع</button></div>`;
}
