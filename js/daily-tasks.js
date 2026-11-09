// daily-tasks.js — «تاسكات اليوم»: the daily work board for the media buyers. The server builds + distributes the tasks (see services/dailyTasks); this page only shows them and
// records what people do. Four tabs: اليوم (per-person columns), المتابعة (who did / did not + activity log), الفريق, الإعدادات. Nothing here touches Meta.
import { api } from './api-client.js';
import * as UI from './ui-common.js';

const $ = (id) => document.getElementById(id);
const E = UI.escapeHtml;
const API = '/api/daily-tasks';
const S = { more: new Set(), who: null, date: null, tab: 'day', view: null, me: null, mgr: false, filter: 'ALL', open: new Set(), foldDone: new Set(), range: 7, report: null, team: null, eod: null, tries: 0, timer: null };
const COLORS = ['#5b5bf0', '#0ea5e9', '#14b86e', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6'];
const PRI = { HIGH: 3, MED: 2, LOW: 1 };
const PRI_AR = { HIGH: 'عاجل', MED: 'مهم', LOW: 'عادي' };
const STATUS_ORDER = { IN_PROGRESS: 0, PENDING: 1, NOT_DONE: 2, DONE: 3, AUTO_RESOLVED: 4, CANCELLED: 5 };
const PROBLEM_TYPES = ['ZERO_ORDERS', 'CPA', 'STOCK', 'FUNDS'];
const GROW_TYPES = ['SCALE', 'CLONE', 'OPEN_PLAN'];
const DAYS_AR = ['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];

const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const hhmm = (iso) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); } catch { return ''; } };
const dateAr = (d) => { try { return new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)); } catch { return d; } };
const colorOf = (view, id) => COLORS[Math.max(0, view.team.findIndex((m) => m.id === id)) % COLORS.length];
const call = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) UI.toast(okMsg); return r; } catch (e) { UI.toast(e.message || 'حصلت مشكلة', 'error'); return null; } };

// ───────────── modal ─────────────
function modal(html, { onMount } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'dtk-modal'; el.innerHTML = `<div class="dtk-sheet">${html}</div>`; document.body.appendChild(el);
    const close = (v) => { el.remove(); resolve(v); };
    el.addEventListener('click', (e) => { if (e.target === el) close(null); });
    el.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => close(null); });
    onMount?.(el, close);
  });
}
const optionsHtml = (list, sel) => list.map(([v, l]) => `<option value="${E(v)}" ${v === sel ? 'selected' : ''}>${E(l)}</option>`).join('');

// ───────────── data ─────────────
async function load({ quiet = false } = {}) {
  clearTimeout(S.timer);
  if (!quiet && !S.view) $('dtkBody').innerHTML = '<div class="dtk-skel"><div></div><div></div><div></div></div>';
  const v = await call(() => api.get(`${API}/day`, S.date ? { date: S.date } : {}));
  if (!v) { $('dtkBody').innerHTML = '<div class="dtk-empty">مقدرتش أحمّل المهام. حدّث الصفحة وجرّب تاني.</div>'; return; }
  S.view = v; S.mgr = !!v.admin; S.date = v.date; S.tries = v.building ? S.tries + 1 : 0;
  if (v.building && S.tries < 40) S.timer = setTimeout(() => load({ quiet: true }), 3000);
  paint();
}

function paint() {
  const v = S.view; if (!v) return;
  $('dtkDate').value = S.date; document.querySelector('.dtk').dataset.mgr = S.mgr ? '1' : '0';
  const s = v.summary;
  $('dtkSub').textContent = `${dateAr(S.date)}${S.date === v.today ? ' — النهارده' : ''}${v.generatedAt ? ` · اتجهّزت ${hhmm(v.generatedAt)}` : ''}${v.refreshedAt && v.refreshedAt !== v.generatedAt ? ` · آخر تحديث ${hhmm(v.refreshedAt)}` : ''}${v.dataAsOf ? ` · أرقام Meta لحد ${hhmm(v.dataAsOf)}` : ''}`;
  document.querySelectorAll('#dtkTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('dtkActions').style.display = S.tab === 'day' && S.mgr ? '' : 'none';
  if (S.tab === 'day') paintDay(); else if (S.tab === 'follow') paintFollow(); else if (S.tab === 'team') paintTeam(); else paintSettings();
}

// ───────────── اليوم ─────────────
const BUCKETS = [
  ['SCALE', '🚀', 'اسكيل المنتجات الرابحة', 'كل مهمة هنا منتج ماشي حلو — اعمل له الاسكيلات المكتوبة (ميزانية كل اسكيل مكتوبة جواها).'],
  ['FIX', '🔧', 'حل مشاكل وتيست جديد', 'منتجات عندها كمية ومبتطلعش أوردرات، ومنتجات بتطلع وتستاهل تيست جديد.'],
  ['MIX', '🧩', 'شغل متنوّع', 'قرارات مستنية، مخزون، رصيد، ودفعات واقفة، وأي مهمة بيضيفها المدير.'],
];
const catOf = (t) => t.category || (t.type === 'SCALE' ? 'SCALE' : ['ZERO_ORDERS', 'CPA', 'TEST'].includes(t.type) ? 'FIX' : 'MIX');

function summaryBar(s) {
  const i = (label, val, cls = '') => `<div class="dtk-sum ${cls}"><b>${val}</b><small>${label}</small></div>`;
  return `<div class="dtk-sumbar">${i('مهام النهارده', s.total)}${i('تمّت', s.done + s.autoResolved, 'g')}${i('لسه', s.pending + s.inProgress, 'b')}${i('ماتعملتش', s.notDone, s.notDone ? 'r' : '')}<div class="dtk-sum rate"><div class="dtk-ring" style="--p:${s.rate ?? 0}"></div><div><b>${s.rate == null ? '—' : s.rate + '%'}</b><small>نسبة الإنجاز</small></div></div></div>`;
}

function passFilter(t) {
  const f = S.filter; const v = S.view;
  if (f === 'ALL') return true;
  if (f === 'HIGH') return t.priority === 'HIGH';
  if (f === 'LATE') return t.source === 'CARRIED';
  return true;
}
function sortTasks(a, b) { return (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || ((b.carryCount || 0) - (a.carryCount || 0)) || (PRI[b.priority] - PRI[a.priority]) || String(a.createdAt).localeCompare(String(b.createdAt)); }

function planChips(t) { return (t.plan || []).length ? `<div class="dtk-plan">${t.plan.map((p, i) => `<span class="${p.mode}"><i>${i + 1}</i><b dir="ltr">${p.mode}</b><em>${p.budget.toLocaleString('en-US')} ج</em></span>`).join('')}</div>` : ''; }

const NUM_TYPES = ['SCALE', 'ZERO_ORDERS', 'CPA', 'TEST', 'REVIEW', 'STOCK'];
const dm = (d) => { try { return new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)); } catch { return d; } };
function srcLine(t) { const m = t.meta; if (!m || !NUM_TYPES.includes(t.type)) return ''; return `<div class="dtk-src">📊 الأرقام: ${E(m.basis || 'Meta')}${m.window ? ` من ${E(dm(m.window.from))} لـ ${E(dm(m.window.to))} (شامل النهارده)` : ''}${m.asOf ? ` · آخر مزامنة ${hhmm(m.asOf)}` : ''}${t.numbersAt ? ` · اتحدّثت ${hhmm(t.numbersAt)}` : ''}</div>`; }

function taskHtml(t, v, { showWho = false } = {}) {
  const can = S.mgr || t.assigneeId === v.mineId; const closed = ['DONE', 'AUTO_RESOLVED', 'CANCELLED'].includes(t.status); const open = S.open.has(t.id);
  const late = t.originDate && t.originDate < S.date ? daysBetween(t.originDate, S.date) : 0; const ty = v.types[t.type] || { icon: '•', label: t.type };
  const who = showWho ? v.team.find((m) => m.id === t.assigneeId) : null; const cat = catOf(t);
  const tags = [
    late > 0 ? `<span class="dtk-tag late">⏰ متأخرة ${late} ${late === 1 ? 'يوم' : 'أيام'}</span>` : '',
    t.priority === 'HIGH' && !closed ? '<span class="dtk-tag hot">عاجلة</span>' : '',
    t.status === 'IN_PROGRESS' ? '<span class="dtk-tag prog">شغّال عليها</span>' : '',
    t.status === 'DONE' ? `<span class="dtk-tag ok">✅ تمّت${t.doneAt ? ' ' + hhmm(t.doneAt) : ''}</span>` : '',
    t.status === 'AUTO_RESOLVED' ? '<span class="dtk-tag auto">🤖 اتحلّت لوحدها</span>' : '',
    t.status === 'NOT_DONE' ? `<span class="dtk-tag late">❌ ماتعملتش: ${E(v.reasons[t.reason] || '')}</span>` : '',
    t.source === 'MANUAL' ? '<span class="dtk-tag">من المدير</span>' : '',
    who ? `<span class="dtk-tag who" style="--pc:${colorOf(v, who.id)}">${E(who.name)}</span>` : '',
  ].join('');
  const why = t.why || t.detail || '';
  const steps = (t.steps || []).length ? `<ol class="dtk-steps">${t.steps.map((s) => `<li>${E(s)}</li>`).join('')}</ol>` : '';
  const actions = can && !closed
    ? `<div class="dtk-acts"><button class="dtk-go" data-a="done" data-id="${t.id}">✅ خلّصتها</button>${t.status === 'PENDING' ? `<button class="dtk-sec" data-a="start" data-id="${t.id}">▶ بدأت</button>` : ''}<button class="dtk-sec" data-a="notdone" data-id="${t.id}">❌ مقدرتش</button>${t.link ? `<a class="dtk-lnk" href="${UI.shellHref ? UI.shellHref(t.link.page) : t.link.page}">↗ ${E(t.link.label)}</a>` : ''}</div>`
    : (t.link && !closed ? `<div class="dtk-acts"><a class="dtk-lnk" href="${UI.shellHref ? UI.shellHref(t.link.page) : t.link.page}">↗ ${E(t.link.label)}</a></div>` : '');
  const mgr = open && S.mgr && t.status !== 'CANCELLED' ? `<div class="dtk-mgr">${!closed ? `<button class="dtk-btn sm" data-a="assign" data-id="${t.id}">👤 حوّلها لشخص</button><button class="dtk-btn sm" data-a="priority" data-id="${t.id}">🚩 الأولوية</button>` : ''}${['DONE', 'NOT_DONE'].includes(t.status) ? `<button class="dtk-btn sm" data-a="reopen" data-id="${t.id}">↩ افتحها تاني</button>` : ''}${!closed ? `<button class="dtk-btn sm danger" data-a="cancel" data-id="${t.id}">🗑 شيل المهمة</button>` : ''}</div>` : '';
  return `<article class="dtk-t b-${cat} ${closed ? 'closed' : ''} ${t.status === 'NOT_DONE' ? 'nd' : ''}">
    <div class="dtk-t-hd"><span class="dtk-dot ${t.priority}" title="${PRI_AR[t.priority]}"></span><h4>${E(t.title)}</h4></div>
    ${tags ? `<div class="dtk-tags">${tags}</div>` : ''}
    ${why ? `<p class="dtk-why">${E(why)}</p>` : ''}
    ${planChips(t)}
    ${(t.facts || []).length ? `<div class="dtk-facts">${t.facts.map((f) => `<span><small>${E(f.l)}</small><b>${E(f.v)}</b></span>`).join('')}</div>` : ''}
    ${srcLine(t)}
    ${steps || t.note || t.resolvedNote ? `<button class="dtk-steps-btn" data-toggle="${t.id}">${open ? '▾ إخفاء الخطوات' : `▸ الخطوات${(t.steps || []).length ? ` (${t.steps.length})` : ''}`}</button>` : ''}
    ${open ? `${steps}${t.note ? `<div class="dtk-note">📝 ${E(t.note)}</div>` : ''}${t.resolvedNote ? `<div class="dtk-note">🤖 ${E(t.resolvedNote)}</div>` : ''}` : ''}
    ${actions}${mgr}
    ${S.mgr && !open && !closed ? `<button class="dtk-more-btn" data-toggle="${t.id}" title="خيارات المدير">⋯</button>` : ''}
  </article>`;
}

function bucketSection(code, icon, title, hint, list, v, opts) {
  const act = list.filter((t) => !['DONE', 'AUTO_RESOLVED'].includes(t.status)); const fin = list.filter((t) => ['DONE', 'AUTO_RESOLVED'].includes(t.status)); const key = `${S.who}:${code}`; const fold = S.foldDone.has(key);
  const done = fin.length; const SHOW = 2; const expanded = S.more.has(key); const head = expanded ? act : act.slice(0, SHOW); const rest = act.length - SHOW;
  return `<section class="dtk-sec-b b-${code}"><header><div><h3>${icon} ${title}</h3><small>${hint}</small></div><span class="dtk-cnt">${done}/${list.length}</span></header>
    ${head.map((t) => taskHtml(t, v, opts)).join('') || `<div class="dtk-none">${list.length ? '✅ خلّصت القسم ده' : 'مفيش مهام في القسم ده النهارده'}</div>`}
    ${rest > 0 ? `<button class="dtk-morebar" data-more="${key}">${expanded ? '▴ إخفاء' : `▾ عرض المزيد (${rest})`}</button>` : ''}
    ${fin.length ? `<div class="dtk-fold" data-fold="${key}">${fold ? '▾ إخفاء' : '▸ عرض'} المنجز (${fin.length})</div>${fold ? fin.map((t) => taskHtml(t, v, opts)).join('') : ''}` : ''}</section>`;
}

function whoCards(v) {
  const card = (id, name, color, tasks) => {
    const live = tasks.filter((t) => t.status !== 'CANCELLED'); const done = live.filter((t) => ['DONE', 'AUTO_RESOLVED'].includes(t.status)).length; const pct = live.length ? Math.round((done / live.length) * 100) : 0;
    const mini = BUCKETS.map(([c, icon]) => { const l = live.filter((t) => catOf(t) === c); return `<span title="${icon}">${icon} ${l.filter((t) => ['DONE', 'AUTO_RESOLVED'].includes(t.status)).length}/${l.length}</span>`; }).join('');
    const m = v.team.find((x) => x.id === id);
    return `<button class="dtk-who ${S.who === id ? 'on' : ''}" data-who="${id}" style="--pc:${color}"><div class="dtk-av">${id === 'ALL' ? '👥' : E([...name][0] || '?')}</div><div class="nm"><b>${E(name)}${m?.off ? '<span class="dtk-off">إجازة</span>' : ''}${id === v.mineId ? '<span class="dtk-off me">أنا</span>' : ''}</b><div class="mini">${mini}</div><div class="bar"><i style="width:${pct}%"></i></div></div><div class="cnt">${done}<small>/${live.length}</small></div></button>`;
  };
  const cards = v.team.filter((m) => m.active || v.tasks.some((t) => t.assigneeId === m.id)).map((m) => card(m.id, m.name, colorOf(v, m.id), v.tasks.filter((t) => t.assigneeId === m.id)));
  const un = v.tasks.filter((t) => !t.assigneeId && ['PENDING', 'IN_PROGRESS', 'NOT_DONE'].includes(t.status));
  return `<div class="dtk-whos">${card('ALL', 'الكل', '#64748b', v.tasks)}${cards.join('')}${un.length ? card('NONE', 'من غير مسؤول', '#94a3b8', un) : ''}</div>`;
}

function poolBanner(v) {
  const n = v.summary.unassigned; const target = v.options?.perPersonTarget;
  return n > 0 ? `<div class="dtk-pool"><div><b>📥 ${n} مهمة جاهزة ومحدّش استلمها لسه</b><small>اضغط «⚖️ توزيع بالتساوي» وهتروح لكل ميديا باير مهامه${target ? ` (الهدف ${target} لكل واحد)` : ''}. كل واحد هيشوف مهامه هو بس.</small></div><button class="dtk-btn primary" data-dist>⚖️ وزّع دلوقتي</button></div>` : '';
}

function paintDay() {
  const v = S.view; const s = v.summary; const body = $('dtkBody');
  if (v.building) { body.innerHTML = '<div class="dtk-empty">⏳ بجهّز مهام اليوم من بيانات الحملات… دقيقة وتظهر لوحدها.</div><div class="dtk-skel" style="margin-top:14px"><div></div><div></div><div></div></div>'; return; }
  if (!v.exists && S.date !== v.today) { body.innerHTML = `<div class="dtk-empty">مفيش مهام متسجّلة ليوم ${E(dateAr(S.date))}.${S.mgr ? '<br><br><button class="dtk-btn primary" id="dtkGen">جهّز اليوم ده</button>' : ''}</div>`; $('dtkGen')?.addEventListener('click', () => doRefresh()); return; }
  if (!S.mgr) { // a buyer sees only their own day — no other person, no other numbers
    if (!v.linked) { body.innerHTML = '<div class="dtk-empty">حسابك لسه مش مربوط بميديا باير.<br><small>كلّم المدير يربطه من تبويب «الفريق» وهتلاقي مهامك هنا.</small></div>'; return; }
    S.who = v.mineId;
  } else if (!S.who || (S.who !== 'ALL' && S.who !== 'NONE' && !v.team.some((m) => m.id === S.who))) S.who = v.unassignedFirst || (v.summary.unassigned ? 'NONE' : (v.mineId || 'ALL'));
  const bad = Object.entries(v.notes?.generator || {}).filter(([, g]) => g && g.ok === false).map(([k]) => (v.types[k]?.label || k));
  const mine = S.who === 'ALL' ? v.tasks : S.who === 'NONE' ? v.tasks.filter((t) => !t.assigneeId) : v.tasks.filter((t) => t.assigneeId === S.who);
  const shown = mine.filter((t) => t.status !== 'CANCELLED').filter(passFilter).sort(sortTasks);
  const person = v.team.find((m) => m.id === S.who); const live = mine.filter((t) => t.status !== 'CANCELLED'); const done = live.filter((t) => ['DONE', 'AUTO_RESOLVED'].includes(t.status)).length;
  const headline = !S.mgr ? `مهامك النهارده: ${live.length} — ${done ? 'خلّصت ' + done : 'لسه ماخلّصتش حاجة'}` : S.who === 'ALL' ? `كل مهام النهارده: ${live.length} — تمّت ${done}` : person ? `${person.id === v.mineId ? 'مهامك' : 'مهام ' + person.name} النهارده: ${live.length} — ${done ? 'خلّصت ' + done : 'لسه ماخلّصتش حاجة'}` : `مهام من غير مسؤول: ${live.length}`;
  body.innerHTML = `${summaryBar(s)}
    ${bad.length ? `<div class="dtk-warn">⚠️ مصدر مش متاح دلوقتي: ${E([...new Set(bad)].join('، '))} — مهامه مش هتتحدّث لحد المرة الجاية، ومفيش حاجة اتقفلت بسببه.</div>` : ''}
    ${S.mgr ? poolBanner(v) + whoCards(v) : ''}
    <div class="dtk-listhd"><h2>${E(headline)}</h2><div class="dtk-filters">${S.mgr && person ? `<button class="dtk-btn sm primary" data-addfor="${person.id}">➕ ضيف مهمة لـ ${E(person.name)}</button>` : ''}${[['ALL', 'الكل'], ['HIGH', '🔴 العاجلة'], ['LATE', '⏰ المتأخرة']].map(([k, l]) => `<button class="dtk-chip ${S.filter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}</div></div>
    ${v.tasks.length === 0 ? '<div class="dtk-empty">مفيش مهام النهارده 🎉<br><small>لو فيه مشاكل أو فرص جديدة هتظهر هنا لوحدها.</small></div>' : BUCKETS.map(([c, i, t, h]) => bucketSection(c, i, t, h, shown.filter((x) => catOf(x) === c), v, { showWho: S.who === 'ALL' || S.who === 'NONE' })).join('')}`;
}

// ───────────── المتابعة ─────────────
async function paintFollow() {
  const body = $('dtkBody'); const v = S.view;
  body.innerHTML = '<div class="dtk-skel"><div></div></div>';
  const to = S.date; const from = addDays(to, -(S.range - 1));
  const r = await call(() => api.get(`${API}/report`, { from, to })); if (!r || S.tab !== 'follow') return; S.report = r;
  const rate = (x) => `<span class="dtk-rate"><i><b style="width:${x ?? 0}%"></b></i>${x == null ? '—' : x + '%'}</span>`;
  const rows = [...r.perMember].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const iconOf = { DONE: '✅', STARTED: '▶️', NOT_DONE: '❌', ASSIGNED: '📥', REASSIGNED: '🔁', CARRIED: '⏰', AUTO_RESOLVED: '🤖', CREATED: '➕', CANCELLED: '🗑', REOPENED: '↩', PRIORITY: '🚩', REBALANCED: '⚖️' };
  const nameOf = (id) => v.team.find((m) => m.id === id)?.name || '';
  body.innerHTML = `<div class="dtk-card"><h3><span>📊 مين عمل إيه</span><span class="dtk-seg">${[[1, 'اليوم'], [7, '7 أيام'], [30, '30 يوم']].map(([n, l]) => `<button class="dtk-chip ${S.range === n ? 'on' : ''}" data-range="${n}">${l}</button>`).join('')}</span></h3>
      <div style="overflow:auto"><table class="dtk-table"><thead><tr><th>الشخص</th><th>اتسلّم</th><th>خلّص</th><th>ماتعملش</th><th>اتأجّل لبكرة</th><th>اتحلّت لوحدها</th><th>لسه</th><th>نسبة الإنجاز</th><th>متوسط الزمن</th></tr></thead><tbody>
      ${rows.map((x) => `<tr><td><b>${E(x.name)}</b></td><td>${x.assigned}</td><td style="color:var(--green)">${x.done}</td><td style="color:${x.notDone ? 'var(--red)' : 'inherit'}">${x.notDone}</td><td>${x.missed}</td><td>${x.autoResolved}</td><td>${x.open}</td><td>${rate(x.rate)}</td><td>${x.avgHours == null ? '—' : x.avgHours + ' س'}</td></tr>`).join('') || '<tr><td colspan="9" class="dtk-none">لسه مفيش بيانات</td></tr>'}</tbody></table></div>
      <div style="color:var(--text-dim);font-size:12.5px;margin-top:8px">«اتأجّل لبكرة» = المهمة ماخلصتش وانضافت على نفس الشخص في اليوم اللي بعده. «اتحلّت لوحدها» مش بتتحسب عليه.</div></div>
    <div class="dtk-card"><h3><span>🕘 سجل يوم ${E(dateAr(S.date))}</span>${S.mgr ? '<button class="dtk-btn sm" id="dtkEod">📋 تقرير نهاية اليوم</button>' : ''}</h3>
      <div id="dtkEodBox"></div>
      <div class="dtk-log">${v.log.map((l) => `<div class="dtk-li"><time>${hhmm(l.at)}</time><span class="ic">${iconOf[l.action] || '•'}</span><div><b>${E(l.actorName || nameOf(l.memberId) || 'السيستم')}</b> — ${E(l.text || '')}<br><small>${E(l.taskTitle || '')}</small></div></div>`).join('') || '<div class="dtk-none">مفيش حركة متسجّلة لسه</div>'}</div></div>`;
}

// ───────────── الفريق ─────────────
async function paintTeam() {
  const body = $('dtkBody'); body.innerHTML = '<div class="dtk-skel"><div></div></div>';
  const t = await call(() => api.get(`${API}/team`)); if (!t || S.tab !== 'team') return; S.team = t;
  const userOpts = [['', '— مش مربوط بحساب —'], ...t.users.map((u) => [String(u.id), `${u.name} (${u.role})`])];
  body.innerHTML = `<div class="dtk-card"><h3>👥 الميديا بايرز</h3><div class="dtk-members">${t.team.map((m, i) => `<div class="dtk-m ${m.active === false ? 'inactive' : ''}" style="--pc:${COLORS[i % COLORS.length]}">
      <div class="top"><div class="dtk-av">${E([...m.name][0] || '?')}</div><b style="flex:1;font-size:15px">${E(m.name)}</b>${(m.off || []).includes(S.date) ? '<span class="dtk-off">إجازة النهارده</span>' : ''}</div>
      <div><label>حسابه على السيستم (عشان يشوف مهامه أول ما يدخل)</label><select data-link="${m.id}">${optionsHtml(userOpts, m.userId ? String(m.userId) : '')}</select></div>
      <div class="btns" style="display:flex;gap:6px;flex-wrap:wrap">${m.active === false ? `<button class="dtk-btn sm" data-m="activate" data-id="${m.id}">رجّعه للفريق</button>` : `<button class="dtk-btn sm" data-m="off" data-id="${m.id}">${(m.off || []).includes(S.date) ? 'ارجعه من الإجازة' : '🏖 إجازة ' + (S.date === S.view.today ? 'النهارده' : 'اليوم ده')}</button><button class="dtk-btn sm danger" data-m="remove" data-id="${m.id}">شيله من الفريق</button>`}</div></div>`).join('')}</div>
      <div class="dtk-add"><input id="dtkNewName" placeholder="اسم شخص جديد" /><select id="dtkNewUser">${optionsHtml(userOpts, '')}</select><button class="dtk-btn primary" id="dtkAddMember">➕ ضيفه</button></div>
      <div style="color:var(--text-dim);font-size:12.5px;margin-top:10px">أي حد تضيفه بيدخل التوزيع من توزيع بكرة، أو دلوقتي لو دوست «⚖️ توزيع بالتساوي» في تبويب اليوم. اللي بتشيله ماتتمسحش بياناته القديمة، ومهامه المفتوحة بتتحوّل للباقيين.</div></div>`;
}

// ───────────── الإعدادات ─────────────
async function paintSettings() {
  const body = $('dtkBody'); const o = S.view.options; const v = S.view;
  const typeRows = [['ZERO_ORDERS', 'بيصرف ومبيجيبش أوردرات', 'حملات صرفت فوق الحد النهارده من غير ولا أوردر'], ['CPA', 'CPA فوق الحد', 'حملات شغالة وتكلفة الأوردر فوق حد التخفيض/الإيقاف'], ['TEST', 'تيست جديد للمنتجات اللي بتطلع', 'منتج بيجيب أوردرات وعنده مخزون كويس — يتعمله تيست جديد'], ['STOCK', 'مخزون', 'منتج المخزون قليل أو خلص والإعلان شغال'], ['REVIEW', 'مراجعة يومية للمنتجات', 'فحص سريع لكل منتج شغّال (بيكمّل العدد لحد الحد الأدنى)'], ['DECISIONS', 'قرارات AI Operator المستنية', 'إيقاف / فتح / زيادة ميزانية مستنية موافقتك'], ['FUNDS', 'رصيد الحسابات', 'حساب إعلاني رصيده قليل'], ['SCALE', 'فرص الاسكيل', 'حملات رابحة جاهزة للتوسّع + اسكيل فشل ومحتاج تكملة'], ['CLONE', 'دفعات النسخ المتعطّلة', 'دفعة محتاجة بيانات (زي لينك الإعلان) أو فشلت'], ['OPEN_PLAN', 'خطة فتح الحملات', 'مهمة مراجعة خطة الفتح لما تتجهّز']];
  body.innerHTML = `<div class="dtk-card"><h3>⚙️ التوزيع الأوتوماتيك</h3>
      <div class="dtk-sw"><span>جهّز مهام كل يوم لوحده<small>عشان أي حد يفتح الشغل يلاقي مهامه جاهزة</small></span><input type="checkbox" id="oAuto" ${o.autoGenerate ? 'checked' : ''}></div>
      ${numRow('oTarget', 'الحد الأدنى للمهام لكل شخص', 'لو مهام الداتا أقل، السيستم بيكمّل بشغل حقيقي (اسكيل بحذر / تيست / مراجعة منتج) بنسبة 50/25/25. اكتب 0 لو مش عايز تكميل.', o.perPersonTarget)}
      <div class="dtk-sw"><span>وزّع المهام تلقائي أول ما تتجهّز<small>مقفول: المهام بتستنى لحد ما تضغط «توزيع بالتساوي»، وكل واحد بيشوف مهامه بعدها</small></span><input type="checkbox" id="oAutoDist" ${o.autoDistribute ? 'checked' : ''}></div>
      <div class="dtk-sw"><span>وقت تجهيز اليوم (بتوقيت القاهرة)</span><input type="time" id="oAt" value="${E(o.generateAt)}" style="width:auto;padding:6px 10px;border:1px solid var(--border);border-radius:9px;background:var(--bg-card);color:var(--text)"></div>
      <div class="dtk-sw"><span>يحدّث المهام كل (دقيقة)<small>بيضيف المشاكل الجديدة ويقفل اللي اتحلّت لوحدها</small></span><input type="number" id="oRef" min="15" max="720" value="${o.refreshMinutes}" style="width:90px;padding:6px 10px;border:1px solid var(--border);border-radius:9px;background:var(--bg-card);color:var(--text)"></div></div>
    <div class="dtk-card"><h3>🚀 اسكيل المنتجات الرابحة</h3>
      ${numRow('oScaleBudget', 'ميزانية كل اسكيل (ج)', 'أقل حاجة 500 — بتظهر جوه كل مهمة اسكيل', o.scaleBudget)}
      ${numRow('oStrongCpa', 'تكلفة الأوردر اللي تعتبر «كوستة حلوة اوي» (ج)', 'لو تكلفة الأوردر ≤ الرقم ده → اسكيلات كتير', o.strongCpa)}
      ${numRow('oStrongScales', 'عدد الاسكيلات للمنتج القوي', 'نص ABO ونص CBO', o.strongScales)}
      ${numRow('oNormalScales', 'عدد الاسكيلات للمنتج العادي', 'ABO + CBO', o.normalScales)}</div>
    <div class="dtk-card"><h3>🔧 المشاكل والتيست</h3>
      ${numRow('oMinTestOrders', 'أقل عدد أوردرات (3 أيام) عشان المنتج يتعمله تيست', '', o.testMinOrders)}
      ${numRow('oMinTestStock', 'أقل مخزون عشان نقترح تيست (قطعة)', '', o.minTestStock)}
      ${numRow('oMaxTest', 'أقصى عدد مهام تيست في اليوم', '', o.maxTest)}
      ${numRow('oMaxFix', 'أقصى عدد مهام مشاكل في اليوم', '', o.maxFix)}</div>
    <div class="dtk-card"><h3>🧲 مصادر المهام</h3>${typeRows.map(([k, l, d]) => `<div class="dtk-sw"><span>${l}<small>${d}</small></span><input type="checkbox" data-type="${k}" ${o.types[k] !== false ? 'checked' : ''}></div>`).join('')}</div>
    <div class="dtk-card"><h3><span>🔁 مهام روتينية يومية</span><button class="dtk-btn sm" id="oAddRoutine">➕ روتين</button></h3><div id="oRoutines">${routinesHtml(o.routines)}</div>
      <div style="color:var(--text-dim);font-size:12.5px;margin-top:8px">«لكل واحد» = كل شخص ياخد نسخة (زي: افحص رصيد حساباتك). «تتوزّع» = مهمة واحدة بتروح لشخص واحد.</div></div>
    <button class="dtk-btn primary" id="oSave">💾 احفظ الإعدادات</button>`;
}
function numRow(id, label, small, val) { return `<div class="dtk-sw"><span>${label}${small ? `<small>${small}</small>` : ''}</span><input type="number" id="${id}" value="${E(String(val ?? ''))}" style="width:96px;padding:6px 10px;border:1px solid var(--border);border-radius:9px;background:var(--bg-card);color:var(--text)"></div>`; }
function routinesHtml(list) {
  return (list || []).map((r, i) => `<div class="dtk-form" data-r="${i}" style="border:1px solid var(--border);border-radius:14px;padding:12px;margin-bottom:8px">
    <input data-f="title" placeholder="عنوان الروتين" value="${E(r.title)}"><input data-f="detail" placeholder="تفاصيل (اختياري)" value="${E(r.detail || '')}">
    <div style="display:flex;gap:8px;flex-wrap:wrap"><select data-f="priority" style="width:auto">${optionsHtml([['LOW', 'عادي'], ['MED', 'مهم'], ['HIGH', 'عاجل']], r.priority)}</select><select data-f="mode" style="width:auto">${optionsHtml([['SPREAD', 'تتوزّع على واحد'], ['ALL', 'لكل واحد']], r.mode)}</select><button class="dtk-btn sm danger" data-rdel="${i}">حذف</button></div>
    <div class="dtk-days">${DAYS_AR.map((d, n) => `<label><input type="checkbox" data-day="${n}" ${(r.days || []).includes(n) ? 'checked' : ''}>${d}</label>`).join('')}<small style="color:var(--text-dim);align-self:center">(من غير اختيار = كل يوم)</small></div></div>`).join('') || '<div class="dtk-none">مفيش روتينات. ضيف واحد لو فيه شغل بتعمله كل يوم.</div>';
}
function readRoutines() { return [...document.querySelectorAll('#oRoutines [data-r]')].map((el) => ({ title: el.querySelector('[data-f=title]').value, detail: el.querySelector('[data-f=detail]').value, priority: el.querySelector('[data-f=priority]').value, mode: el.querySelector('[data-f=mode]').value, days: [...el.querySelectorAll('[data-day]:checked')].map((c) => +c.dataset.day), id: S.view.options.routines[+el.dataset.r]?.id })); }

// ───────────── actions ─────────────
async function act(a, id) {
  const t = S.view.tasks.find((x) => x.id === id); if (!t) return;
  const post = async (action, body = {}) => { const r = await call(() => api.post(`${API}/tasks/${id}/${action}`, { date: S.date, ...body })); if (r) { S.view = r; paint(); } return r; };
  if (a === 'start') return post('start');
  if (a === 'done') return post('done');
  if (a === 'reopen') return post('reopen');
  if (a === 'notdone') {
    const res = await modal(`<h3>ليه ماتعملتش؟</h3><div class="dtk-form"><div style="font-weight:700;font-size:13.5px">${E(t.title)}</div><div><label>السبب</label><select id="mR">${optionsHtml(Object.entries(S.view.reasons), 'NO_TIME')}</select></div><div><label>ملاحظة (اختياري)</label><textarea id="mN" rows="2"></textarea></div><div style="color:var(--text-dim);font-size:12.5px">هتتنقل لنفس الشخص بكرة تلقائي.</div></div><div class="btns"><button class="dtk-btn" data-close>إلغاء</button><button class="dtk-btn primary" id="mOk">تأكيد</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ reason: el.querySelector('#mR').value, note: el.querySelector('#mN').value }); } });
    if (res) return post('notdone', res); return;
  }
  if (a === 'assign') {
    const res = await modal(`<h3>تحويل المهمة</h3><div class="dtk-form"><div style="font-weight:700;font-size:13.5px">${E(t.title)}</div><div><label>لمين؟</label><select id="mM">${optionsHtml(S.view.team.filter((m) => m.active).map((m) => [m.id, m.name + (m.off ? ' (إجازة)' : '')]), t.assigneeId)}</select></div></div><div class="btns"><button class="dtk-btn" data-close>إلغاء</button><button class="dtk-btn primary" id="mOk">حوّل</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ memberId: el.querySelector('#mM').value }); } });
    if (res) return post('assign', res); return;
  }
  if (a === 'priority') {
    const res = await modal(`<h3>أولوية المهمة</h3><div class="dtk-form"><select id="mP">${optionsHtml([['HIGH', '🔴 عاجل'], ['MED', '🟠 مهم'], ['LOW', '🔵 عادي']], t.priority)}</select></div><div class="btns"><button class="dtk-btn" data-close>إلغاء</button><button class="dtk-btn primary" id="mOk">حفظ</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ priority: el.querySelector('#mP').value }); } });
    if (res) return post('priority', res); return;
  }
  if (a === 'cancel') {
    const res = await modal(`<h3>إلغاء المهمة؟</h3><div class="dtk-form"><div style="font-weight:700;font-size:13.5px">${E(t.title)}</div><div><label>السبب (اختياري)</label><input id="mN"></div></div><div class="btns"><button class="dtk-btn" data-close>رجوع</button><button class="dtk-btn danger" id="mOk">إلغاء المهمة</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ note: el.querySelector('#mN').value }); } });
    if (res) return post('cancel', res);
  }
}

async function doRefresh() { const b = $('dtkRefresh'); if (b) b.disabled = true; const r = await call(() => api.post(`${API}/generate`, { date: S.date }), 'اتحدّثت المهام'); if (b) b.disabled = false; if (r) { S.view = r; paint(); } }

function wire() {
  $('dtkTabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (!b) return; S.tab = b.dataset.tab; paint(); };
  $('dtkPrev').onclick = () => { S.date = addDays(S.date, -1); S.view = null; load(); };
  $('dtkNext').onclick = () => { S.date = addDays(S.date, 1); S.view = null; load(); };
  $('dtkToday').onclick = () => { S.date = null; S.view = null; load(); };
  $('dtkDate').onchange = (e) => { if (e.target.value) { S.date = e.target.value; S.view = null; load(); } };
  $('dtkRefresh').onclick = doRefresh;
  const distribute = async () => { if (!confirm('هوزّع مهام النهارده على الفريق بالتساوي. اللي بدأ أو خلّص أو اتنقل من إمبارح مش هيتحرّك. أكمّل؟')) return; const r = await call(() => api.post(`${API}/rebalance`, { date: S.date }), 'اتوزّعت بالتساوي'); if (r) { S.view = r; S.who = 'ALL'; paint(); } };
  $('dtkRebalance').onclick = distribute;
  const addTask = async (pre = '') => {
    const team = S.view.team.filter((m) => m.active);
    const res = await modal(`<h3>➕ مهمة جديدة</h3><div class="dtk-form"><div><label>العنوان</label><input id="mT" placeholder="مثلًا: راجع كرياتيف منتج كذا"></div><div><label>تفاصيل (اختياري)</label><textarea id="mD" rows="2"></textarea></div><div><label>المنتج (اختياري)</label><input id="mPr"></div><div><label>القسم</label><select id="mC">${optionsHtml([['MIX', '🧩 شغل متنوّع'], ['SCALE', '🚀 اسكيل'], ['FIX', '🔧 مشاكل وتيست']], 'MIX')}</select></div><div style="display:flex;gap:8px"><div style="flex:1"><label>الأولوية</label><select id="mPi">${optionsHtml([['MED', 'مهم'], ['HIGH', 'عاجل'], ['LOW', 'عادي']], 'MED')}</select></div><div style="flex:1"><label>لمين</label><select id="mW">${optionsHtml([['', 'توزيع تلقائي (الأقل شغل)'], ...team.map((m) => [m.id, m.name])], pre)}</select></div></div></div><div class="btns"><button class="dtk-btn" data-close>إلغاء</button><button class="dtk-btn primary" id="mOk">أضف</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ title: el.querySelector('#mT').value, detail: el.querySelector('#mD').value, productName: el.querySelector('#mPr').value, priority: el.querySelector('#mPi').value, category: el.querySelector('#mC').value, memberId: el.querySelector('#mW').value || null }); } });
    if (!res) return; const r = await call(() => api.post(`${API}/tasks`, { date: S.date, ...res }), 'اتضافت المهمة'); if (r) { S.view = r; paint(); }
  };
  $('dtkAdd').onclick = () => addTask(S.who && !['ALL', 'NONE'].includes(S.who) ? S.who : '');
  $('dtkBody').addEventListener('click', async (e) => {
    const q = e.target.closest('[data-a]'); if (q) { e.stopPropagation(); return act(q.dataset.a, q.dataset.id); }
    const tg = e.target.closest('[data-toggle]'); if (tg && !e.target.closest('a')) { const id = tg.dataset.toggle; S.open.has(id) ? S.open.delete(id) : S.open.add(id); return paint(); }
    const f = e.target.closest('[data-filter]'); if (f) { S.filter = f.dataset.filter; return paint(); }
    const wh = e.target.closest('[data-who]'); if (wh) { S.who = wh.dataset.who; return paint(); }
    if (e.target.closest('[data-dist]')) return distribute();
    const af = e.target.closest('[data-addfor]'); if (af) return addTask(af.dataset.addfor);
    const mo = e.target.closest('[data-more]'); if (mo) { const k = mo.dataset.more; S.more.has(k) ? S.more.delete(k) : S.more.add(k); return paint(); }
    const fo = e.target.closest('[data-fold]'); if (fo) { const id = fo.dataset.fold; S.foldDone.has(id) ? S.foldDone.delete(id) : S.foldDone.add(id); return paint(); }
    const rg = e.target.closest('[data-range]'); if (rg) { S.range = +rg.dataset.range; return paint(); }
    if (e.target.closest('#dtkEod')) { const r = await call(() => api.get(`${API}/eod`, { date: S.date })); if (r) { $('dtkEodBox').innerHTML = `<pre class="dtk-eod">${E(r.text)}</pre><div style="margin:8px 0"><button class="dtk-btn sm" id="dtkCopy">نسخ</button></div>`; $('dtkCopy').onclick = async () => { try { await navigator.clipboard.writeText(r.text); UI.toast('اتنسخ'); } catch { UI.toast('مقدرتش أنسخ', 'error'); } }; } return; }
    const mm = e.target.closest('[data-m]');
    if (mm) {
      const id = mm.dataset.id; const m = S.team.team.find((x) => x.id === id); let ok = null;
      if (mm.dataset.m === 'activate') ok = await call(() => api.patch(`${API}/team/${id}`, { active: true }), 'رجع للفريق');
      if (mm.dataset.m === 'off') ok = await call(() => api.post(`${API}/team/${id}/day-off`, { date: S.date, off: !(m.off || []).includes(S.date) }), 'اتسجّل');
      if (mm.dataset.m === 'remove') { if (!confirm(`تشيل ${m.name} من الفريق؟ مهامه المفتوحة هتتحوّل للباقيين وبياناته القديمة هتفضل.`)) return; ok = await call(() => api.delete(`${API}/team/${id}`), 'اتشال'); }
      if (ok) { await load({ quiet: true }); }
      return;
    }
    if (e.target.closest('#dtkAddMember')) { const name = $('dtkNewName').value; const userId = $('dtkNewUser').value || null; const r = await call(() => api.post(`${API}/team`, { name, userId }), 'اتضاف'); if (r) await load({ quiet: true }); return; }
    if (e.target.closest('#oAddRoutine')) { const cur = readRoutines(); cur.push({ title: '', detail: '', priority: 'LOW', mode: 'ALL', days: [] }); S.view.options.routines = cur; $('oRoutines').innerHTML = routinesHtml(cur); return; }
    const rd = e.target.closest('[data-rdel]'); if (rd) { const cur = readRoutines(); cur.splice(+rd.dataset.rdel, 1); S.view.options.routines = cur; $('oRoutines').innerHTML = routinesHtml(cur); return; }
    if (e.target.closest('#oSave')) {
      const types = {}; document.querySelectorAll('[data-type]').forEach((c) => { types[c.dataset.type] = c.checked; });
      const r = await call(() => api.put(`${API}/options`, { autoGenerate: $('oAuto').checked, generateAt: $('oAt').value, refreshMinutes: +$('oRef').value, types, perPersonTarget: $('oTarget').value, autoDistribute: $('oAutoDist').checked, scaleBudget: $('oScaleBudget').value, strongCpa: $('oStrongCpa').value, strongScales: $('oStrongScales').value, normalScales: $('oNormalScales').value, testMinOrders: $('oMinTestOrders').value, minTestStock: $('oMinTestStock').value, maxTest: $('oMaxTest').value, maxFix: $('oMaxFix').value, routines: readRoutines().filter((x) => x.title.trim()) }), 'اتحفظت الإعدادات'); if (r) { S.view.options = r; paint(); }
    }
  });
  $('dtkBody').addEventListener('change', async (e) => { const l = e.target.closest('[data-link]'); if (l) { const r = await call(() => api.patch(`${API}/team/${l.dataset.link}`, { userId: l.value || null }), 'اتربط'); if (r) await load({ quiet: true }); } });
}

async function init() {
  UI.renderSidebar('tasks');
  try { S.me = await api.get('/api/auth/me'); } catch { S.me = null; }
  const u = S.me?.user || S.me || {}; S.mgr = !!(u.is_owner || u.role === 'ADMIN'); // refined by the server's answer (view.admin) after load
  wire(); await load();
  if (S.view?.mineId && !S.mgr) S.filter = 'MINE';
  paint();
}
init();
