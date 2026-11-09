// daily-tasks.js — «تاسكات اليوم»: the daily work board for the media buyers. The server builds + distributes the tasks (see services/dailyTasks); this page only shows them and
// records what people do. Four tabs: اليوم (per-person columns), المتابعة (who did / did not + activity log), الفريق, الإعدادات. Nothing here touches Meta.
import { api } from './api-client.js';
import * as UI from './ui-common.js';

const $ = (id) => document.getElementById(id);
const E = UI.escapeHtml;
const API = '/api/daily-tasks';
const S = { date: null, tab: 'day', view: null, me: null, mgr: false, filter: 'ALL', open: new Set(), foldDone: new Set(), range: 7, report: null, team: null, eod: null, tries: 0, timer: null };
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
  S.view = v; S.date = v.date; S.tries = v.building ? S.tries + 1 : 0;
  if (v.building && S.tries < 40) S.timer = setTimeout(() => load({ quiet: true }), 3000);
  paint();
}

function paint() {
  const v = S.view; if (!v) return;
  $('dtkDate').value = S.date; document.querySelector('.dtk').dataset.mgr = S.mgr ? '1' : '0';
  const s = v.summary;
  $('dtkSub').textContent = `${dateAr(S.date)}${S.date === v.today ? ' — النهارده' : ''}${v.generatedAt ? ` · اتجهّزت ${hhmm(v.generatedAt)}` : ''}${v.refreshedAt && v.refreshedAt !== v.generatedAt ? ` · آخر تحديث ${hhmm(v.refreshedAt)}` : ''}`;
  document.querySelectorAll('#dtkTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('dtkActions').style.display = S.tab === 'day' && S.mgr ? '' : 'none';
  if (S.tab === 'day') paintDay(); else if (S.tab === 'follow') paintFollow(); else if (S.tab === 'team') paintTeam(); else paintSettings();
}

// ───────────── اليوم ─────────────
function kpis(s) {
  const k = (label, val, color) => `<div class="dtk-kpi" style="--k:${color}"><small>${label}</small><b>${val}</b></div>`;
  return `<div class="dtk-kpis">${k('إجمالي المهام', s.total, '#5b5bf0')}${k('تمّت', s.done + s.autoResolved, '#14b86e')}${k('لسه', s.pending + s.inProgress, '#0ea5e9')}${k('ماتعملتش', s.notDone, '#ef4444')}
    <div class="dtk-kpi rate" style="--k:#14b86e"><div class="dtk-ring" style="--p:${s.rate ?? 0}"></div><div><small>نسبة الإنجاز</small><b>${s.rate == null ? '—' : s.rate + '%'}</b></div></div></div>`;
}

function passFilter(t) {
  const f = S.filter; const v = S.view;
  if (f === 'ALL') return true;
  if (f === 'MINE') return t.assigneeId === v.mineId;
  if (f === 'PROBLEMS') return PROBLEM_TYPES.includes(t.type);
  if (f === 'GROW') return GROW_TYPES.includes(t.type);
  if (f === 'LATE') return t.source === 'CARRIED';
  if (f === 'OTHER') return ['MANUAL', 'ROUTINE'].includes(t.type);
  return true;
}

function sortTasks(a, b) { return (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || ((b.carryCount || 0) - (a.carryCount || 0)) || (PRI[b.priority] - PRI[a.priority]) || String(a.createdAt).localeCompare(String(b.createdAt)); }

function taskHtml(t, v) {
  const can = S.mgr || t.assigneeId === v.mineId; const closed = ['DONE', 'AUTO_RESOLVED', 'CANCELLED'].includes(t.status); const open = S.open.has(t.id);
  const late = t.originDate && t.originDate < S.date ? daysBetween(t.originDate, S.date) : 0; const ty = v.types[t.type] || { icon: '•', label: t.type };
  const tags = [
    `<span class="dtk-tag">${ty.icon} ${E(ty.label)}</span>`,
    t.priority === 'HIGH' ? '<span class="dtk-tag late">عاجل</span>' : '',
    late > 0 ? `<span class="dtk-tag late">متأخر ${late} ${late === 1 ? 'يوم' : 'أيام'}</span>` : '',
    t.status === 'IN_PROGRESS' ? '<span class="dtk-tag prog">شغّال عليه</span>' : '',
    t.status === 'DONE' ? `<span class="dtk-tag ok">تمّت${t.doneAt ? ' ' + hhmm(t.doneAt) : ''}</span>` : '',
    t.status === 'AUTO_RESOLVED' ? '<span class="dtk-tag auto">🤖 اتحلّت لوحدها</span>' : '',
    t.status === 'NOT_DONE' ? `<span class="dtk-tag late">ماتعملتش: ${E(v.reasons[t.reason] || '')}</span>` : '',
    t.source === 'MANUAL' ? '<span class="dtk-tag">من المدير</span>' : '',
  ].join('');
  const quick = can && !closed ? `<div class="dtk-quick">${t.status === 'PENDING' ? `<button class="dtk-q" data-a="start" data-id="${t.id}" title="ابدأ">▶</button>` : ''}<button class="dtk-q ok" data-a="done" data-id="${t.id}" title="خلّصتها">✅</button><button class="dtk-q" data-a="notdone" data-id="${t.id}" title="ماتعملتش">❌</button></div>` : '';
  const more = open ? `<div class="dtk-more">${t.detail ? `<div>${E(t.detail)}</div>` : ''}${(t.facts || []).length ? `<div class="dtk-facts">${t.facts.map((f) => `<span>${E(f.l)}: ${E(f.v)}</span>`).join('')}</div>` : ''}
      ${t.note ? `<div>📝 ${E(t.note)}</div>` : ''}${t.resolvedNote ? `<div>🤖 ${E(t.resolvedNote)}</div>` : ''}
      <div class="btns">${t.link ? `<a class="dtk-btn sm" href="${UI.shellHref ? UI.shellHref(t.link.page) : t.link.page}">↗ ${E(t.link.label)}</a>` : ''}
      ${S.mgr && !['CANCELLED'].includes(t.status) ? `<button class="dtk-btn sm" data-a="assign" data-id="${t.id}">👤 تحويل لشخص</button><button class="dtk-btn sm" data-a="priority" data-id="${t.id}">🚩 الأولوية</button>` : ''}
      ${S.mgr && ['DONE', 'NOT_DONE'].includes(t.status) ? `<button class="dtk-btn sm" data-a="reopen" data-id="${t.id}">↩ فتح تاني</button>` : ''}
      ${S.mgr && !closed ? `<button class="dtk-btn sm danger" data-a="cancel" data-id="${t.id}">🗑 إلغاء</button>` : ''}</div></div>` : '';
  return `<div class="dtk-task ${t.status === 'DONE' || t.status === 'AUTO_RESOLVED' ? 'done' : ''} ${t.status === 'NOT_DONE' ? 'nd' : ''}"><div class="row" data-toggle="${t.id}"><span class="dtk-dot ${t.priority}" title="${PRI_AR[t.priority]}"></span><div class="dtk-tt">${E(t.title)}<div class="dtk-tags">${tags}</div></div>${quick}</div>${more}</div>`;
}

function personCard(m, tasks, v) {
  const mine = tasks.filter((t) => t.assigneeId === m.id && t.status !== 'CANCELLED').filter(passFilter).sort(sortTasks);
  const all = v.tasks.filter((t) => t.assigneeId === m.id && t.status !== 'CANCELLED'); const done = all.filter((t) => ['DONE', 'AUTO_RESOLVED'].includes(t.status)).length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0; const col = colorOf(v, m.id);
  const act = mine.filter((t) => !['DONE', 'AUTO_RESOLVED'].includes(t.status)); const fin = mine.filter((t) => ['DONE', 'AUTO_RESOLVED'].includes(t.status)); const fold = S.foldDone.has(m.id);
  return `<div class="dtk-person ${m.id === v.mineId ? 'mine' : ''}" style="--pc:${col}">
    <div class="dtk-ph"><div class="dtk-av">${E([...m.name][0] || '?')}</div><div class="dtk-pn"><b>${E(m.name)}${m.off ? '<span class="dtk-off">إجازة</span>' : ''}${m.id === v.mineId ? '<span class="dtk-off" style="background:#5b5bf0">أنا</span>' : ''}</b><small>${all.length ? `${all.length - done} لسه · ${done} تمّت` : 'مفيش مهام'}</small></div><div class="dtk-count">${done}/${all.length}</div></div>
    <div class="dtk-bar2"><i style="width:${pct}%"></i></div>
    <div class="dtk-list">${act.map((t) => taskHtml(t, v)).join('') || (fin.length ? '<div class="dtk-none">✅ خلّص كل حاجة</div>' : '<div class="dtk-none">مفيش مهام مطابقة</div>')}
      ${fin.length ? `<div class="dtk-fold" data-fold="${m.id}">${fold ? '▾ إخفاء' : '▸ عرض'} المنجز (${fin.length})</div>${fold ? fin.map((t) => taskHtml(t, v)).join('') : ''}` : ''}</div></div>`;
}

function paintDay() {
  const v = S.view; const s = v.summary; const body = $('dtkBody');
  if (v.building) { body.innerHTML = '<div class="dtk-empty">⏳ بجهّز مهام اليوم من بيانات الحملات… ثواني وتظهر لوحدها.</div><div class="dtk-skel" style="margin-top:14px"><div></div><div></div><div></div></div>'; return; }
  if (!v.exists && S.date !== v.today) { body.innerHTML = `<div class="dtk-empty">مفيش مهام متسجّلة ليوم ${E(dateAr(S.date))}.${S.mgr ? '<br><br><button class="dtk-btn primary" id="dtkGen">جهّز اليوم ده</button>' : ''}</div>`; $('dtkGen')?.addEventListener('click', () => doRefresh()); return; }
  const chips = [['ALL', 'الكل'], ...(v.mineId ? [['MINE', 'مهامي']] : []), ['PROBLEMS', '🔴 مشاكل'], ['GROW', '🚀 اسكيل وفتح'], ['LATE', '⏰ المتأخر'], ['OTHER', '✍️ يدوي وروتين']];
  const bad = Object.entries(v.notes?.generator || {}).filter(([, g]) => g && g.ok === false).map(([k]) => (v.types[k]?.label || k));
  const unassigned = v.tasks.filter((t) => !t.assigneeId && ['PENDING', 'IN_PROGRESS', 'NOT_DONE'].includes(t.status));
  const members = [...v.team].sort((a, b) => (b.id === v.mineId) - (a.id === v.mineId));
  body.innerHTML = `${kpis(s)}
    ${bad.length ? `<div class="dtk-card" style="border-color:var(--yellow);padding:10px 14px;font-size:13px">⚠️ مصدر مش متاح دلوقتي: ${E([...new Set(bad)].join('، '))} — المهام اللي منه مش هتتحدّث لحد المرة الجاية، ومفيش حاجة اتقفلت بسببه.</div>` : ''}
    <div class="dtk-filters">${chips.map(([k, l]) => `<button class="dtk-chip ${S.filter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}${s.unassigned ? `<span class="dtk-tag late">${s.unassigned} مهمة من غير مسؤول</span>` : ''}</div>
    ${v.tasks.length === 0 ? '<div class="dtk-empty">مفيش مهام النهارده 🎉<br><small>لو فيه مشاكل جديدة هتظهر هنا لوحدها.</small></div>' : `<div class="dtk-grid">${members.map((m) => personCard(m, v.tasks, v)).join('')}${unassigned.length ? personCard({ id: null, name: 'من غير مسؤول', off: false }, v.tasks, v) : ''}</div>`}`;
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
    <div class="dtk-card"><h3><span>🕘 سجل يوم ${E(dateAr(S.date))}</span><button class="dtk-btn sm" id="dtkEod">📋 تقرير نهاية اليوم</button></h3>
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
  const typeRows = [['ZERO_ORDERS', 'بيصرف ومبيجيبش أوردرات', 'حملات صرفت فوق الحد النهارده من غير ولا أوردر'], ['CPA', 'CPA فوق الحد', 'حملات شغالة وتكلفة الأوردر فوق حد التخفيض/الإيقاف'], ['STOCK', 'مخزون', 'منتج المخزون قليل أو خلص والإعلان شغال'], ['FUNDS', 'رصيد الحسابات', 'حساب إعلاني رصيده قليل'], ['SCALE', 'فرص الاسكيل', 'حملات رابحة جاهزة للتوسّع + اسكيل فشل ومحتاج تكملة'], ['CLONE', 'دفعات النسخ المتعطّلة', 'دفعة محتاجة بيانات (زي لينك الإعلان) أو فشلت'], ['OPEN_PLAN', 'خطة فتح الحملات', 'مهمة مراجعة خطة الفتح لما تتجهّز']];
  body.innerHTML = `<div class="dtk-card"><h3>⚙️ التوزيع الأوتوماتيك</h3>
      <div class="dtk-sw"><span>جهّز مهام كل يوم لوحده<small>عشان أي حد يفتح الشغل يلاقي مهامه جاهزة</small></span><input type="checkbox" id="oAuto" ${o.autoGenerate ? 'checked' : ''}></div>
      <div class="dtk-sw"><span>وقت تجهيز اليوم (بتوقيت القاهرة)</span><input type="time" id="oAt" value="${E(o.generateAt)}" style="width:auto;padding:6px 10px;border:1px solid var(--border);border-radius:9px;background:var(--bg-card);color:var(--text)"></div>
      <div class="dtk-sw"><span>يحدّث المهام كل (دقيقة)<small>بيضيف المشاكل الجديدة ويقفل اللي اتحلّت لوحدها</small></span><input type="number" id="oRef" min="15" max="720" value="${o.refreshMinutes}" style="width:90px;padding:6px 10px;border:1px solid var(--border);border-radius:9px;background:var(--bg-card);color:var(--text)"></div></div>
    <div class="dtk-card"><h3>🧲 مصادر المهام</h3>${typeRows.map(([k, l, d]) => `<div class="dtk-sw"><span>${l}<small>${d}</small></span><input type="checkbox" data-type="${k}" ${o.types[k] !== false ? 'checked' : ''}></div>`).join('')}</div>
    <div class="dtk-card"><h3><span>🔁 مهام روتينية يومية</span><button class="dtk-btn sm" id="oAddRoutine">➕ روتين</button></h3><div id="oRoutines">${routinesHtml(o.routines)}</div>
      <div style="color:var(--text-dim);font-size:12.5px;margin-top:8px">«لكل واحد» = كل شخص ياخد نسخة (زي: افحص رصيد حساباتك). «تتوزّع» = مهمة واحدة بتروح لشخص واحد.</div></div>
    <button class="dtk-btn primary" id="oSave">💾 احفظ الإعدادات</button>`;
}
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
  $('dtkRebalance').onclick = async () => { if (!confirm('هوزّع المهام اللي لسه ماتبدأتش بالتساوي من جديد. اللي بدأ أو خلّص مش هيتحرّك. أكمّل؟')) return; const r = await call(() => api.post(`${API}/rebalance`, { date: S.date }), 'اتوزّعت بالتساوي'); if (r) { S.view = r; paint(); } };
  $('dtkAdd').onclick = async () => {
    const team = S.view.team.filter((m) => m.active);
    const res = await modal(`<h3>➕ مهمة جديدة</h3><div class="dtk-form"><div><label>العنوان</label><input id="mT" placeholder="مثلًا: راجع كرياتيف منتج كذا"></div><div><label>تفاصيل (اختياري)</label><textarea id="mD" rows="2"></textarea></div><div><label>المنتج (اختياري)</label><input id="mPr"></div><div style="display:flex;gap:8px"><div style="flex:1"><label>الأولوية</label><select id="mPi">${optionsHtml([['MED', 'مهم'], ['HIGH', 'عاجل'], ['LOW', 'عادي']], 'MED')}</select></div><div style="flex:1"><label>لمين</label><select id="mW">${optionsHtml([['', 'توزيع تلقائي (الأقل شغل)'], ...team.map((m) => [m.id, m.name])], '')}</select></div></div></div><div class="btns"><button class="dtk-btn" data-close>إلغاء</button><button class="dtk-btn primary" id="mOk">أضف</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ title: el.querySelector('#mT').value, detail: el.querySelector('#mD').value, productName: el.querySelector('#mPr').value, priority: el.querySelector('#mPi').value, memberId: el.querySelector('#mW').value || null }); } });
    if (!res) return; const r = await call(() => api.post(`${API}/tasks`, { date: S.date, ...res }), 'اتضافت المهمة'); if (r) { S.view = r; paint(); }
  };
  $('dtkBody').addEventListener('click', async (e) => {
    const q = e.target.closest('[data-a]'); if (q) { e.stopPropagation(); return act(q.dataset.a, q.dataset.id); }
    const tg = e.target.closest('[data-toggle]'); if (tg && !e.target.closest('a')) { const id = tg.dataset.toggle; S.open.has(id) ? S.open.delete(id) : S.open.add(id); return paint(); }
    const f = e.target.closest('[data-filter]'); if (f) { S.filter = f.dataset.filter; return paint(); }
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
      const r = await call(() => api.put(`${API}/options`, { autoGenerate: $('oAuto').checked, generateAt: $('oAt').value, refreshMinutes: +$('oRef').value, types, routines: readRoutines().filter((x) => x.title.trim()) }), 'اتحفظت الإعدادات'); if (r) { S.view.options = r; paint(); }
    }
  });
  $('dtkBody').addEventListener('change', async (e) => { const l = e.target.closest('[data-link]'); if (l) { const r = await call(() => api.patch(`${API}/team/${l.dataset.link}`, { userId: l.value || null }), 'اتربط'); if (r) await load({ quiet: true }); } });
}

async function init() {
  UI.renderSidebar('tasks');
  try { S.me = await api.get('/api/auth/me'); } catch { S.me = null; }
  const u = S.me?.user || S.me || {}; S.mgr = !!(u.is_owner || ['ADMIN', 'MANAGER'].includes(u.role));
  wire(); await load();
  if (S.view?.mineId && !S.mgr) S.filter = 'MINE';
  paint();
}
init();
