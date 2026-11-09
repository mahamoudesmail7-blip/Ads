// daily-tasks.js — «توزيع المهام»: the page controller (state + events). The server builds and distributes the tasks (services/dailyTasks); this page shows them and records what people do.
// Rendering lives in tasks-ui.js. Nothing here touches Meta, and nothing here decides which tasks exist or who gets them.
import { api } from './api-client.js';
import * as UI from './ui-common.js';
import * as X from './tasks-ui.js';

const $ = (id) => document.getElementById(id);
const E = UI.escapeHtml;
const API = '/api/daily-tasks';
const S = {
  date: null, tab: 'day', view: null, me: null, mgr: false, report: null, team: null, range: 7, tries: 0, timer: null,
  f: { who: 'ALL', cat: 'ALL', types: new Set(), statuses: new Set(), prios: new Set(), q: '' }, page: 1, size: 10, drawer: null, more: new Set(), proofDraft: {},
};
const COLORS = ['#7c5cff', '#0ea5e9', '#14b86e', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6'];
const DAYS_AR = ['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];

const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const hhmm = (iso) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); } catch { return ''; } };
const dateAr = (d) => { try { return new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)); } catch { return d; } };
const call = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) UI.toast(okMsg); return r; } catch (e) { UI.toast(e.message || 'حصلت مشكلة', 'error'); return null; } };
const optionsHtml = (list, sel) => list.map(([v, l]) => `<option value="${E(v)}" ${v === sel ? 'selected' : ''}>${E(l)}</option>`).join('');

// ───────────── modal (shared by every dialog) ─────────────
function modal(html, { onMount, wide = false } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'dtk-modal'; el.innerHTML = `<div class="dtk-sheet ${wide ? 'wide' : ''}">${html}</div>`; document.body.appendChild(el);
    const close = (v) => { el.remove(); document.removeEventListener('keydown', esc); resolve(v); };
    const esc = (e) => { if (e.key === 'Escape') close(null); }; document.addEventListener('keydown', esc);
    el.addEventListener('mousedown', (e) => { if (e.target === el) close(null); });
    el.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => close(null); });
    onMount?.(el, close);
  });
}

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
  const root = $('dtkRoot'); root.dataset.mgr = S.mgr ? '1' : '0';
  $('dtkDate').value = S.date;
  $('dtkSub').textContent = `${dateAr(S.date)}${S.date === v.today ? ' — النهارده' : ''}${v.generatedAt ? ` · اتجهّزت ${hhmm(v.generatedAt)}` : ''}${v.dataAsOf ? ` · أرقام Meta لحد ${hhmm(v.dataAsOf)}` : ''}${v.lastReset && S.mgr ? ` · اتصفّر ${hhmm(v.lastReset.at)}` : ''}`;
  document.querySelector('.dx-title h1').textContent = S.mgr || S.tab !== 'day' ? 'توزيع المهام' : 'مهامي اليوم';
  document.querySelectorAll('#dtkTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('dtkActions').style.display = S.tab === 'day' && S.mgr ? '' : 'none';
  if (S.tab === 'day') paintDay(); else if (S.tab === 'follow') paintFollow(); else if (S.tab === 'team') paintTeam(); else paintSettings();
  paintDrawer();
}

// ───────────── التوزيع (the board) ─────────────
function paintDay() {
  const v = S.view; const body = $('dtkBody'); const keepQ = document.activeElement && document.activeElement.id === 'dxQ'; const caret = keepQ ? document.activeElement.selectionStart : 0;
  if (v.building) { body.innerHTML = '<div class="dtk-empty">⏳ بجهّز مهام اليوم من بيانات الحملات… دقيقة وتظهر لوحدها.</div><div class="dtk-skel" style="margin-top:14px"><div></div><div></div><div></div></div>'; return; }
  if (!v.exists && S.date !== v.today) { body.innerHTML = `<div class="dtk-empty">مفيش مهام متسجّلة ليوم ${E(dateAr(S.date))}.</div>`; return; }
  if (!S.mgr) { // a buyer sees only their own day — no other person, no other numbers
    body.innerHTML = v.linked ? X.employeeBoard(S, v) : '<div class="dtk-empty">حسابك لسه مش مربوط بميديا باير.<br><small>كلّم المدير يربطه من تبويب «الفريق» وهتلاقي مهامك هنا.</small></div>';
    return;
  }
  const bad = Object.entries(v.notes?.generator || {}).filter(([, g]) => g && g.ok === false).map(([k]) => (v.types[k]?.label || k));
  body.innerHTML = `${X.kpiStrip(S, v)}
    ${bad.length ? `<div class="dx-warn">${X.ic('triangle-alert', 17)} مصدر مش متاح دلوقتي: ${E([...new Set(bad)].join('، '))} — مهامه مش هتتحدّث لحد المرة الجاية، ومفيش حاجة اتقفلت بسببه.</div>` : ''}
    <div class="dx-grid"><aside class="dx-side-r">${X.teamCard(S, v)}${X.interventionCard(S, v)}</aside><div class="dx-main">${X.listCard(S, v)}</div><aside class="dx-side-l ${S.filtersOpen ? 'open' : ''}">${X.filtersCard(S, v)}</aside></div>`;
  if (keepQ) { const q = $('dxQ'); if (q) { q.focus(); try { q.setSelectionRange(caret, caret); } catch { /* ignore */ } } }
}

function paintDrawer() {
  const el = $('dxDrawer'); const scrim = $('dxScrim'); const t = S.drawer && S.view ? S.view.tasks.find((x) => x.id === S.drawer) : null;
  if (!t) { el.hidden = true; scrim.hidden = true; el.innerHTML = ''; document.body.classList.remove('dx-lock'); return; }
  const keep = el.querySelector('.dx-dr-body')?.scrollTop || 0; const sameTask = el.dataset.id === t.id;
  el.innerHTML = X.drawerHtml(S, S.view, t); el.dataset.id = t.id; el.hidden = false; scrim.hidden = false; document.body.classList.add('dx-lock');
  if (sameTask) { const b = el.querySelector('.dx-dr-body'); if (b) b.scrollTop = keep; }
}

// ───────────── المتابعة ─────────────
async function paintFollow() {
  const body = $('dtkBody'); const v = S.view;
  body.innerHTML = '<div class="dtk-skel"><div></div></div>';
  const to = S.date; const from = addDays(to, -(S.range - 1));
  const r = await call(() => api.get(`${API}/report`, { from, to })); if (!r || S.tab !== 'follow') return; S.report = r;
  const rate = (x) => `<span class="dtk-rate"><i><b style="width:${x ?? 0}%"></b></i>${x == null ? '—' : x + '%'}</span>`;
  const rows = [...r.perMember].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const iconOf = { DONE: '✅', STARTED: '▶️', NOT_DONE: '❌', ASSIGNED: '📥', REASSIGNED: '🔁', CARRIED: '⏰', AUTO_RESOLVED: '🤖', CREATED: '➕', CANCELLED: '🗑', REOPENED: '↩', PRIORITY: '🚩', REBALANCED: '⚖️', SUBMITTED: '📤', APPROVED: '☑️', REJECTED: '↪️', VERIFIED: '🛡️' };
  const nameOf = (id) => v.team.find((m) => m.id === id)?.name || '';
  body.innerHTML = `<div class="dtk-card"><h3><span>📊 مين عمل إيه</span><span class="dtk-seg">${[[1, 'اليوم'], [7, '7 أيام'], [30, '30 يوم']].map(([n, l]) => `<button class="dtk-chip ${S.range === n ? 'on' : ''}" data-range="${n}">${l}</button>`).join('')}</span></h3>
      <div style="overflow:auto"><table class="dtk-table"><thead><tr><th>الشخص</th><th>اتسلّم</th><th>خلّص</th><th>مستنية مراجعة</th><th>ماتعملش</th><th>اتأجّل لبكرة</th><th>اتحلّت لوحدها</th><th>لسه</th><th>نسبة الإنجاز</th><th>متوسط الزمن</th></tr></thead><tbody>
      ${rows.map((x) => `<tr><td><b>${E(x.name)}</b></td><td>${x.assigned}</td><td style="color:var(--green)">${x.done}</td><td>${x.review || 0}</td><td style="color:${x.notDone ? 'var(--red)' : 'inherit'}">${x.notDone}</td><td>${x.missed}</td><td>${x.autoResolved}</td><td>${x.open}</td><td>${rate(x.rate)}</td><td>${x.avgHours == null ? '—' : x.avgHours + ' س'}</td></tr>`).join('') || '<tr><td colspan="10" class="dtk-none">لسه مفيش بيانات</td></tr>'}</tbody></table></div>
      <div style="color:var(--text-dim);font-size:12.5px;margin-top:8px">«خلّص» = اتقفلت بإثبات (اعتمده المدير أو تأكد منه السيستم). «اتأجّل لبكرة» = المهمة ماخلصتش وانضافت على نفس الشخص في اليوم اللي بعده. «اتحلّت لوحدها» مش بتتحسب عليه.</div></div>
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
      <div style="color:var(--text-dim);font-size:12.5px;margin-top:10px">أي حد تضيفه بيدخل التوزيع من توزيع بكرة، أو دلوقتي لو دوست «توزيع المهام تلقائيًا». اللي بتشيله ماتتمسحش بياناته القديمة، ومهامه المفتوحة بتتحوّل للباقيين.</div></div>`;
}

// ───────────── الإعدادات ─────────────
async function paintSettings() {
  const body = $('dtkBody'); const o = S.view.options;
  const typeRows = [['ZERO_ORDERS', 'بيصرف ومبيجيبش أوردرات', 'حملات صرفت فوق الحد النهارده من غير ولا أوردر'], ['CPA', 'CPA فوق الحد', 'حملات شغالة وتكلفة الأوردر فوق حد التخفيض/الإيقاف'], ['TEST', 'تيست جديد للمنتجات اللي بتطلع', 'منتج بيجيب أوردرات وعنده مخزون كويس — يتعمله تيست جديد'], ['STOCK', 'مخزون', 'منتج المخزون قليل أو خلص والإعلان شغال'], ['REVIEW', 'مراجعة يومية للمنتجات', 'فحص سريع لكل منتج شغّال (بيكمّل العدد لحد الحد الأدنى)'], ['DECISIONS', 'قرارات AI Operator المستنية', 'إيقاف / فتح / زيادة ميزانية مستنية موافقتك'], ['FUNDS', 'رصيد الحسابات', 'حساب إعلاني رصيده قليل'], ['SCALE', 'فرص الاسكيل', 'حملات رابحة جاهزة للتوسّع + اسكيل فشل ومحتاج تكملة'], ['CLONE', 'دفعات النسخ المتعطّلة', 'دفعة محتاجة بيانات (زي لينك الإعلان) أو فشلت'], ['OPEN_PLAN', 'خطة فتح الحملات', 'مهمة مراجعة خطة الفتح لما تتجهّز']];
  body.innerHTML = `<div class="dtk-card"><h3>⚙️ التوزيع الأوتوماتيك</h3>
      <div class="dtk-sw"><span>جهّز مهام كل يوم لوحده<small>عشان أي حد يفتح الشغل يلاقي مهامه جاهزة</small></span><input type="checkbox" id="oAuto" ${o.autoGenerate ? 'checked' : ''}></div>
      ${numRow('oTarget', 'الحد الأدنى للمهام لكل شخص', 'لو مهام الداتا أقل، السيستم بيكمّل بشغل حقيقي (اسكيل بحذر / تيست / مراجعة منتج) بنسبة 50/25/25. اكتب 0 لو مش عايز تكميل.', o.perPersonTarget)}
      <div class="dtk-sw"><span>وزّع المهام تلقائي أول ما تتجهّز<small>مقفول: المهام بتستنى لحد ما تضغط «توزيع المهام تلقائيًا»، وكل واحد بيشوف مهامه بعدها</small></span><input type="checkbox" id="oAutoDist" ${o.autoDistribute ? 'checked' : ''}></div>
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

// ───────────── task actions ─────────────
async function act(a, id) {
  const t = S.view.tasks.find((x) => x.id === id); if (!t) return;
  const post = async (action, body = {}) => { const r = await call(() => api.post(`${API}/tasks/${id}/${action}`, { date: S.date, ...body })); if (r) { S.view = r; paint(); } return r; };
  if (a === 'start') return post('start');
  if (a === 'reopen') return post('reopen');
  if (a === 'approve') return post('approve');
  if (a === 'done') { if (!confirm('هتقفل المهمة دي كمكتملة من عندك من غير إثبات. أكمّل؟')) return; return post('done'); }
  if (a === 'submit') {
    const text = ($('dxProof')?.value || '').trim(); const link = ($('dxProofLink')?.value || '').trim(); S.proofDraft[id] = { text, link };
    if (text.length < 8) { UI.toast('اكتب إثبات التنفيذ: إيه اللي عملته بالظبط (جملة على الأقل).', 'error'); $('dxProof')?.focus(); return; }
    const r = await post('submit', { proof: text, link }); if (r) delete S.proofDraft[id]; return;
  }
  if (a === 'reject') {
    const res = await modal(`<h3>ارجّع المهمة للميديا باير</h3><div class="dtk-form"><div style="font-weight:700;font-size:13.5px">${E(t.title)}</div><div><label>السبب (هيظهرله)</label><textarea id="mN" rows="2" placeholder="مثلًا: ماحددتش أنهي حملة"></textarea></div></div><div class="btns"><button class="dx-sec-btn" data-close>رجوع</button><button class="dx-go" id="mOk">ارجّعها</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ note: el.querySelector('#mN').value }); } });
    if (res) return post('reject', res); return;
  }
  if (a === 'notdone') {
    const res = await modal(`<h3>ليه ماتعملتش؟</h3><div class="dtk-form"><div style="font-weight:700;font-size:13.5px">${E(t.title)}</div><div><label>السبب</label><select id="mR">${optionsHtml(Object.entries(S.view.reasons), 'NO_TIME')}</select></div><div><label>ملاحظة (اختياري)</label><textarea id="mN" rows="2"></textarea></div><div style="color:var(--text-dim);font-size:12.5px">هتتنقل لنفس الشخص بكرة تلقائي.</div></div><div class="btns"><button class="dx-sec-btn" data-close>إلغاء</button><button class="dx-go" id="mOk">تأكيد</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ reason: el.querySelector('#mR').value, note: el.querySelector('#mN').value }); } });
    if (res) return post('notdone', res); return;
  }
  if (a === 'assign') {
    const res = await modal(`<h3>تحويل المهمة</h3><div class="dtk-form"><div style="font-weight:700;font-size:13.5px">${E(t.title)}</div><div><label>لمين؟</label><select id="mM">${optionsHtml(S.view.team.filter((m) => m.active).map((m) => [m.id, m.name + (m.off ? ' (إجازة)' : '')]), t.assigneeId)}</select></div></div><div class="btns"><button class="dx-sec-btn" data-close>إلغاء</button><button class="dx-go" id="mOk">حوّل</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ memberId: el.querySelector('#mM').value }); } });
    if (res) return post('assign', res); return;
  }
  if (a === 'priority') {
    const res = await modal(`<h3>أولوية المهمة</h3><div class="dtk-form"><select id="mP">${optionsHtml([['HIGH', 'عالية'], ['MED', 'متوسطة'], ['LOW', 'منخفضة']], t.priority)}</select></div><div class="btns"><button class="dx-sec-btn" data-close>إلغاء</button><button class="dx-go" id="mOk">حفظ</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ priority: el.querySelector('#mP').value }); } });
    if (res) return post('priority', res); return;
  }
  if (a === 'cancel') {
    const res = await modal(`<h3>شيل المهمة؟</h3><div class="dtk-form"><div style="font-weight:700;font-size:13.5px">${E(t.title)}</div><div><label>السبب (اختياري)</label><input id="mN"></div></div><div class="btns"><button class="dx-sec-btn" data-close>رجوع</button><button class="dx-sec-btn danger" id="mOk">شيل المهمة</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ note: el.querySelector('#mN').value }); } });
    if (res) { const r = await post('cancel', res); if (r) { S.drawer = null; paint(); } }
  }
}

async function doRefresh() { const b = $('dtkRefresh'); if (b) b.disabled = true; const r = await call(() => api.post(`${API}/generate`, { date: S.date }), 'اتحدّثت المهام'); if (b) b.disabled = false; if (r) { S.view = r; paint(); } }

/** The distribution: first a PREVIEW (read-only), only «أكّد التوزيع» changes anything. */
async function distribute() {
  const pv = await call(() => api.get(`${API}/rebalance/preview`, { date: S.date })); if (!pv) return;
  const ok = await modal(X.previewHtml(pv), { wide: true, onMount: (el, close) => { const b = el.querySelector('#mOk'); if (b) b.onclick = () => close(true); } });
  if (!ok) return;
  const r = await call(() => api.post(`${API}/rebalance`, { date: S.date }), 'اتوزّعت المهام بالتساوي'); if (r) { S.view = r; S.f.who = 'ALL'; S.page = 1; paint(); }
}

/** «ابدأ من جديد»: take every task off the media buyers and zero their numbers; the tasks stay ready in the pool for a fresh distribution. Needs an explicit, informed confirmation. */
async function resetAll() {
  const v = S.view; if (!v) return; if (S.date !== v.today) { UI.toast('التصفير لليوم الحالي بس.', 'error'); return; }
  const live = v.tasks.filter((t) => !['CANCELLED', 'AUTO_RESOLVED'].includes(t.status)); const n = (st) => live.filter((t) => t.status === st).length; const assigned = live.filter((t) => t.assigneeId).length;
  const ok = await modal(`<h3>${X.ic('rotate-ccw', 20)} تصفير وبداية جديدة</h3>
    <p class="dx-hint">هيتشال كل حاجة من على الميديا بايرز، وكل المهام ترجع <b>مجمّعة وجاهزة</b> عشان توزّعها من الأول بالتساوي.</p>
    <div class="dx-reset-box"><b>اللي هيتصفّر دلوقتي:</b><ul><li><b>${assigned}</b> مهمة متوزّعة هتتشال من على أصحابها</li><li><b>${n('DONE')}</b> مكتملة هترجع جديدة</li><li><b>${n('NEEDS_REVIEW')}</b> مستنية مراجعة (الإثبات هيتمسح)</li><li><b>${n('IN_PROGRESS')}</b> قيد التنفيذ، و<b>${n('NOT_DONE')}</b> ماتعملتش</li></ul><small>المهام اللي شيلتها بإيدك بتفضل محذوفة، وأرقام كل ميديا باير بتبقى صفر.</small></div>
    <label class="dx-ack"><input type="checkbox" id="mAck"> فاهم إن اللي اتعمل النهارده (مكتمل / إثبات / بداية) هيتمسح ومش هينفع أرجّعه</label>
    <div class="btns"><button class="dx-sec-btn" data-close>إلغاء</button><button class="dx-sec-btn danger" id="mOk" disabled>${X.ic('rotate-ccw', 16)} صفّر دلوقتي</button></div>`, { onMount: (el, close) => { const b = el.querySelector('#mOk'); el.querySelector('#mAck').onchange = (e) => { b.disabled = !e.target.checked; }; b.onclick = () => close(true); } });
  if (!ok) return;
  const r = await call(() => api.post(`${API}/reset`, { date: S.date }), 'اتصفّر اليوم — المهام جاهزة للتوزيع من جديد'); if (r) { S.view = r; S.f.who = 'NONE'; S.f.cat = 'ALL'; S.f.types.clear(); S.f.statuses.clear(); S.f.prios.clear(); S.f.q = ''; S.page = 1; S.drawer = null; paint(); }
}

/** Take a media buyer out of the team: his open tasks are handed to the others right away, his history (done work, numbers) stays. Needs a confirmation that says exactly what happens. */
async function removeMember(id) {
  const v = S.view; const m = v.team.find((x) => x.id === id); if (!m) return;
  const mine = v.tasks.filter((t) => t.assigneeId === id && t.status !== 'CANCELLED'); const n = (f) => mine.filter(f).length;
  const open = n((t) => ['PENDING', 'IN_PROGRESS'].includes(t.status)); const review = n((t) => t.status === 'NEEDS_REVIEW'); const done = n((t) => ['DONE', 'AUTO_RESOLVED'].includes(t.status)); const others = v.team.filter((x) => x.active && x.id !== id).length;
  if (!others) { UI.toast('مينفعش تشيل آخر ميديا باير في الفريق.', 'error'); return; }
  const ok = await modal(`<h3>${X.ic('user-minus', 20)} شيل ${E(m.name)} من الفريق؟</h3>
    <div class="dx-reset-box"><b>اللي هيحصل:</b><ul><li><b>${open}</b> مهمة مفتوحة معاه هتتوزّع على الـ ${others} الباقيين بالتساوي</li>${review ? `<li><b>${review}</b> مستنية مراجعة بتفضل باسمه لحد ما تراجعها</li>` : ''}<li><b>${done}</b> مكتملة بتفضل في سجله وأرقامه القديمة</li><li>مش هيظهر في التوزيع الجاي، وحسابه على السيستم مبيتمسحش</li></ul><small>تقدر ترجّعه بعدين من تبويب «الفريق».</small></div>
    <div class="btns"><button class="dx-sec-btn" data-close>إلغاء</button><button class="dx-sec-btn danger" id="mOk">${X.ic('user-minus', 16)} شيله من الفريق</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close(true); } });
  if (!ok) return;
  const r = await call(() => api.delete(`${API}/team/${id}`), `اتشال ${m.name} ومهامه اتوزّعت على الباقيين`); if (!r) return;
  if (S.f.who === id) S.f.who = 'ALL'; await load({ quiet: true });
}

async function addMember() {
  const t = await call(() => api.get(`${API}/team`)); if (!t) return;
  const userOpts = [['', '— مش مربوط بحساب —'], ...t.users.map((u) => [String(u.id), `${u.name} (${u.role})`])];
  const res = await modal(`<h3>${X.ic('user-plus', 20)} إضافة موظف جديد</h3><div class="dtk-form"><div><label>الاسم</label><input id="mName" placeholder="اسم الميديا باير"></div><div><label>حسابه على السيستم (اختياري)</label><select id="mUser">${optionsHtml(userOpts, '')}</select></div><div class="dx-hint">هيدخل التوزيع من أول مرة تضغط فيها «توزيع المهام تلقائيًا».</div></div><div class="btns"><button class="dx-sec-btn" data-close>إلغاء</button><button class="dx-go" id="mOk">أضف</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ name: el.querySelector('#mName').value, userId: el.querySelector('#mUser').value || null }); } });
  if (!res) return; const r = await call(() => api.post(`${API}/team`, res), 'اتضاف'); if (r) await load({ quiet: true });
}

async function addTask(pre = '') {
  const team = S.view.team.filter((m) => m.active);
  const res = await modal(`<h3>${X.ic('plus', 20)} إضافة مهمة</h3><div class="dtk-form"><div><label>العنوان</label><input id="mT" placeholder="مثلًا: راجع كرياتيف منتج كذا"></div><div><label>تفاصيل (اختياري)</label><textarea id="mD" rows="2"></textarea></div><div><label>المنتج (اختياري)</label><input id="mPr"></div><div><label>القسم</label><select id="mC">${optionsHtml([['MIX', 'مهام متنوعة'], ['SCALE', 'اسكيل'], ['FIX', 'حل مشاكل وتيست']], 'MIX')}</select></div><div style="display:flex;gap:8px"><div style="flex:1"><label>الأولوية</label><select id="mPi">${optionsHtml([['MED', 'متوسطة'], ['HIGH', 'عالية'], ['LOW', 'منخفضة']], 'MED')}</select></div><div style="flex:1"><label>لمين</label><select id="mW">${optionsHtml([['', 'توزيع تلقائي (الأقل شغل)'], ...team.map((m) => [m.id, m.name])], pre)}</select></div></div></div><div class="btns"><button class="dx-sec-btn" data-close>إلغاء</button><button class="dx-go" id="mOk">أضف</button></div>`, { onMount: (el, close) => { el.querySelector('#mOk').onclick = () => close({ title: el.querySelector('#mT').value, detail: el.querySelector('#mD').value, productName: el.querySelector('#mPr').value, priority: el.querySelector('#mPi').value, category: el.querySelector('#mC').value, memberId: el.querySelector('#mW').value || null }); } });
  if (!res) return; const r = await call(() => api.post(`${API}/tasks`, { date: S.date, ...res }), 'اتضافت المهمة'); if (r) { S.view = r; paint(); }
}

// ───────────── wiring ─────────────
function setHeaderIcons() {
  const set = (id, icon, label, size = 17) => { const b = $(id); if (b) b.innerHTML = `${X.ic(icon, size)}${label ? `<span>${label}</span>` : ''}`; };
  set('dtkPrev', 'chevron-right', '', 16); set('dtkNext', 'chevron-left', '', 16); set('dtkToday', 'calendar', 'النهارده');
  set('dtkAdd', 'plus', 'إضافة مهمة'); set('dtkReset', 'rotate-ccw', 'تصفير وبداية جديدة'); set('dtkRefresh', 'refresh-cw', 'تحديث'); set('dtkRebalance', 'sparkles', 'توزيع المهام تلقائيًا');
  const tabs = { day: ['layers', 'التوزيع'], follow: ['bar-chart', 'المتابعة'], team: ['users', 'الفريق'], settings: ['settings', 'الإعدادات'] };
  document.querySelectorAll('#dtkTabs button').forEach((b) => { const [i, l] = tabs[b.dataset.tab]; b.innerHTML = `${X.ic(i, 16)}<span>${l}</span>`; });
  document.querySelector('.dx-title-ico').innerHTML = X.ic('layers', 24);
}

function closeDrawer() { S.drawer = null; paintDrawer(); }

function wire() {
  $('dtkTabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (!b) return; S.tab = b.dataset.tab; S.drawer = null; paint(); };
  $('dtkPrev').onclick = () => { S.date = addDays(S.date, -1); S.view = null; S.drawer = null; S.page = 1; load(); };
  $('dtkNext').onclick = () => { S.date = addDays(S.date, 1); S.view = null; S.drawer = null; S.page = 1; load(); };
  $('dtkToday').onclick = () => { S.date = null; S.view = null; S.drawer = null; S.page = 1; load(); };
  $('dtkDate').onchange = (e) => { if (e.target.value) { S.date = e.target.value; S.view = null; S.drawer = null; S.page = 1; load(); } };
  $('dtkRefresh').onclick = doRefresh; $('dtkRebalance').onclick = distribute; $('dtkReset').onclick = resetAll;
  $('dtkAdd').onclick = () => addTask(S.f.who && !['ALL', 'NONE'].includes(S.f.who) ? S.f.who : '');
  $('dxScrim').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.drawer && !document.querySelector('.dtk-modal')) closeDrawer(); });

  document.addEventListener('click', async (e) => {
    const t = e.target;
    const q = t.closest('[data-a]'); if (q) { e.stopPropagation(); return act(q.dataset.a, q.dataset.id); }
    const op = t.closest('[data-open]'); if (op) { S.drawer = op.dataset.open; return paintDrawer(); }
    const act2 = t.closest('[data-act]');
    if (act2) {
      const a = act2.dataset.act;
      if (a === 'close-drawer') return closeDrawer();
      if (a === 'dist-preview') return distribute();
      if (a === 'add-task') return addTask(S.f.who && !['ALL', 'NONE'].includes(S.f.who) ? S.f.who : '');
      if (a === 'add-member') return addMember();
      if (a === 'reset-filters') { S.f.who = 'ALL'; S.f.types.clear(); S.f.statuses.clear(); S.f.prios.clear(); S.f.q = ''; S.page = 1; return paint(); }
      if (a === 'toggle-filters') { S.filtersOpen = !S.filtersOpen; return paintDay(); }
    }
    const af = t.closest('[data-addfor]'); if (af) return addTask(af.dataset.addfor);
    const rm = t.closest('[data-rmmem]'); if (rm) return removeMember(rm.dataset.rmmem);
    const cat = t.closest('[data-cat]'); if (cat) { S.f.cat = cat.dataset.cat; S.page = 1; return paintDay(); }
    const wh = t.closest('[data-who]'); if (wh) { S.f.who = S.f.who === wh.dataset.who ? 'ALL' : wh.dataset.who; S.page = 1; return paintDay(); }
    const pg = t.closest('[data-page]'); if (pg && !pg.disabled) { S.page = Math.max(1, +pg.dataset.page); paintDay(); return document.querySelector('.dx-list')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    const mo = t.closest('[data-more]'); if (mo) { const k = mo.dataset.more; S.more.has(k) ? S.more.delete(k) : S.more.add(k); return paintDay(); }
    // follow-up / team / settings tabs (unchanged behaviour)
    const rg = t.closest('[data-range]'); if (rg) { S.range = +rg.dataset.range; return paint(); }
    if (t.closest('#dtkEod')) { const r = await call(() => api.get(`${API}/eod`, { date: S.date })); if (r) { $('dtkEodBox').innerHTML = `<pre class="dtk-eod">${E(r.text)}</pre><div style="margin:8px 0"><button class="dtk-btn sm" id="dtkCopy">نسخ</button></div>`; $('dtkCopy').onclick = async () => { try { await navigator.clipboard.writeText(r.text); UI.toast('اتنسخ'); } catch { UI.toast('مقدرتش أنسخ', 'error'); } }; } return; }
    const mm = t.closest('[data-m]');
    if (mm) {
      const id = mm.dataset.id; const m = S.team.team.find((x) => x.id === id); let ok = null;
      if (mm.dataset.m === 'activate') ok = await call(() => api.patch(`${API}/team/${id}`, { active: true }), 'رجع للفريق');
      if (mm.dataset.m === 'off') ok = await call(() => api.post(`${API}/team/${id}/day-off`, { date: S.date, off: !(m.off || []).includes(S.date) }), 'اتسجّل');
      if (mm.dataset.m === 'remove') { if (!confirm(`تشيل ${m.name} من الفريق؟ مهامه المفتوحة هتتحوّل للباقيين وبياناته القديمة هتفضل.`)) return; ok = await call(() => api.delete(`${API}/team/${id}`), 'اتشال'); }
      if (ok) await load({ quiet: true });
      return;
    }
    if (t.closest('#dtkAddMember')) { const name = $('dtkNewName').value; const userId = $('dtkNewUser').value || null; const r = await call(() => api.post(`${API}/team`, { name, userId }), 'اتضاف'); if (r) await load({ quiet: true }); return; }
    if (t.closest('#oAddRoutine')) { const cur = readRoutines(); cur.push({ title: '', detail: '', priority: 'LOW', mode: 'ALL', days: [] }); S.view.options.routines = cur; $('oRoutines').innerHTML = routinesHtml(cur); return; }
    const rd = t.closest('[data-rdel]'); if (rd) { const cur = readRoutines(); cur.splice(+rd.dataset.rdel, 1); S.view.options.routines = cur; $('oRoutines').innerHTML = routinesHtml(cur); return; }
    if (t.closest('#oSave')) {
      const types = {}; document.querySelectorAll('[data-type]').forEach((c) => { types[c.dataset.type] = c.checked; });
      const r = await call(() => api.put(`${API}/options`, { autoGenerate: $('oAuto').checked, generateAt: $('oAt').value, refreshMinutes: +$('oRef').value, types, perPersonTarget: $('oTarget').value, autoDistribute: $('oAutoDist').checked, scaleBudget: $('oScaleBudget').value, strongCpa: $('oStrongCpa').value, strongScales: $('oStrongScales').value, normalScales: $('oNormalScales').value, testMinOrders: $('oMinTestOrders').value, minTestStock: $('oMinTestStock').value, maxTest: $('oMaxTest').value, maxFix: $('oMaxFix').value, routines: readRoutines().filter((x) => x.title.trim()) }), 'اتحفظت الإعدادات'); if (r) { S.view.options = r; paint(); }
    }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    const ft = t.closest('[data-ft]'); if (ft) { const set = S.f[ft.dataset.ft]; ft.checked ? set.add(ft.value) : set.delete(ft.value); S.page = 1; return paintDay(); }
    if (t.matches('select[data-f="who"]')) { S.f.who = t.value; S.page = 1; return paintDay(); }
    if (t.matches('select[data-size]')) { S.size = +t.value; S.page = 1; return paintDay(); }
    const l = t.closest('[data-link]'); if (l) { const r = await call(() => api.patch(`${API}/team/${l.dataset.link}`, { userId: l.value || null }), 'اتربط'); if (r) await load({ quiet: true }); }
  });
  let qTimer = null;
  document.addEventListener('input', (e) => { if (e.target.id !== 'dxQ') return; clearTimeout(qTimer); const val = e.target.value; qTimer = setTimeout(() => { S.f.q = val; S.page = 1; paintDay(); }, 180); });
}

async function init() {
  UI.renderSidebar('tasks');
  try { S.me = await api.get('/api/auth/me'); } catch { S.me = null; }
  const u = S.me?.user || S.me || {}; S.mgr = !!(u.is_owner || u.role === 'ADMIN'); // refined by the server's answer (view.admin) after load
  setHeaderIcons(); wire(); await load();
}
init();
