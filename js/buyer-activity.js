// buyer-activity.js — «اللي اتعمل النهارده حسب الميديا باير» (الصفحة الرئيسية، تحت «أفضل 5 منتجات»).
// Simple on purpose: a day slider, then one card per media buyer — his campaigns of the day by NAME («Cup - Test», «Cup - Scale»), the product, the account and the time; and what each gave
// the same day / the next day (orders + cost per order). The campaigns come from the ad accounts' «View history» (Ads Manager) + the system's own records. View over GET /api/ai-media-buyer/buyer-activity.
import { api } from './api-client.js';
import * as UI from './ui-common.js';

const E = UI.escapeHtml;
let baDay = null; let baGen = 0; let baIdx = 0; let baTimer = null; let baTries = 0;
const MODES = [['day', 'اللي اتعمل'], ['yesterday', 'نتايج شغل امبارح'], ['month', 'الشهر']];
let baMode = 'day'; try { const m = localStorage.getItem('ba.mode'); if (MODES.some(([k]) => k === m)) baMode = m; } catch { /* default */ }
const modeTabs = () => `<div class="ba-modes" role="tablist">${MODES.map(([k, l]) => `<button type="button" role="tab" class="${baMode === k ? 'on' : ''}" data-mode="${k}">${l}</button>`).join('')}</div>`;
function wireModes(body) { body.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { baMode = b.dataset.mode; baIdx = 0; baTries = 0; try { localStorage.setItem('ba.mode', baMode); } catch { /* ignore */ } renderBuyerActivity(false); }; }); }
const num = (n) => UI.fmtNum(Math.round(n));
const DAYS = ['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];
const wd = (d) => DAYS[new Date(`${d}T12:00:00Z`).getUTCDay()];
const dm = (d) => `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`;
const hhmm = (iso) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); } catch { return ''; } };
const long = (d) => { try { return new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`)); } catch { return d; } };
const TYPE = { TEST: ['تيست', 't-test'], SCALE: ['اسكيل', 't-scale'], OTHER: ['كامبين', 't-other'] };

/** «3 أوردر · كوست 187 ج» — or why there is no number yet. */
function res(label, r, pending) {
  const body = pending ? '<i>لسه مجاش</i>' : r ? `<b>${num(r.orders)}</b> أوردر <span>· ${r.cpa != null ? `كوست <em>${num(r.cpa)} ج</em>` : 'كوست —'}</span>` : '<i>مفيش بيانات لسه</i>';
  return `<div class="ba-res ${pending || !r ? 'is-empty' : ''}"><small>${label}</small><div>${body}</div></div>`;
}
/** A campaign made today starts at 12 AM tomorrow, so the creation day has no result: before that the card says so; after it, the FIRST running day and the total since it started. */
function ress(c) {
  const r = c.results; if (!r) return '';
  if (!r.started) return '<div class="ba-ress one"><div class="ba-res is-empty"><small>النتيجة</small><div><i>Scheduled — بيبدأ بكره 12 ص، والنتايج بتظهر بكره</i></div></div></div>';
  const d = r.firstDay.slice(8, 10) + '/' + r.firstDay.slice(5, 7);
  return `<div class="ba-ress ${r.total ? '' : 'one'}">${res(`أول يوم تشغيل (${Number(d.slice(0, 2))}/${Number(d.slice(3))})${r.firstDayIsToday ? ' — لسه شغّال' : ''}`, r.first)}${r.total ? res(`الإجمالي (${r.totalDays} أيام)`, r.total) : ''}</div>`;
}
function campaignRow(c) {
  const [typeLabel, typeCls] = TYPE[c.type] || TYPE.OTHER;
  return `<div class="ba-camp ${typeCls}">
    <div class="ba-line"><span class="ba-type">${typeLabel}</span><b class="ba-name" dir="auto" title="${E(c.name)}">${E(c.name)}</b>${c.results ? (c.results.started ? '<span class="ba-state run">اشتغل</span>' : '<span class="ba-state sched">⏰ Scheduled</span>') : ''}<time>${hhmm(c.at)}</time></div>
    <div class="ba-meta"><span>المنتج: <b>${c.product ? E(c.product) : '—'}</b></span><span>الأكونت: <b>${E(c.accountName)}</b></span><span class="src">${c.source === 'SYSTEM' ? 'من السيستم' : 'من Meta'}</span></div>
    ${ress(c)}
  </div>`;
}
function personCard(p, team) {
  const initial = E([...(p.name || '؟')][0] || '؟');
  const link = !p.linked && p.actor ? `<div class="ba-link"><small>الاسم ده على فيسبوك مش مربوط بميديا باير:</small><select data-actor="${E(p.actor.id || p.actor.name)}"><option value="">— اختار الميديا باير —</option>${team.map((m) => `<option value="${E(m.id)}">${E(m.name)}</option>`).join('')}</select><button type="button" data-link>اربط</button></div>` : '';
  const counts = p.total ? `<span class="ba-n t-test">تيست <b>${p.tests}</b></span><span class="ba-n t-scale">اسكيل <b>${p.scales}</b></span>${p.other ? `<span class="ba-n t-other">أخرى <b>${p.other}</b></span>` : ''}` : '';
  return `<section class="ba-card ${p.idle ? 'is-idle' : ''}">
    <header><span class="ba-av ${p.linked ? '' : 'unk'}">${initial}</span><div><b>${E(p.name)}</b><small>${p.idle ? 'لسه معملش كامبين' : `${p.total} ${p.total === 1 ? 'كامبين' : 'كامبينات'}`}${p.linked ? '' : ' · غير مربوط'}</small></div><div class="ba-counts">${counts}</div></header>
    ${link}
    <div class="ba-list">${p.campaigns.length ? p.campaigns.map(campaignRow).join('') : '<div class="ba-none">مفيش كامبين اتعمل باسمه في اليوم ده.</div>'}</div>
  </section>`;
}

function stripHtml(week) {
  return week.map((w) => `<button type="button" class="ba-day ${w.selected ? 'on' : ''} ${w.campaigns || w.approx ? '' : 'zero'}" data-day="${w.date}"><small>${wd(w.date)}</small><b>${dm(w.date)}</b><em>${w.approx && !w.campaigns ? '…' : w.campaigns ? `${w.campaigns} كامبين` : '—'}</em></button>`).join('');
}
function render(body, d) {
  const shift = (n) => { const x = new Date(`${d.date}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const strip = stripHtml(d.week);
  const warn = d.meta?.reason ? `<div class="ba-warn">⚠️ ${E(d.meta.reason)} — بيظهر اللي اتعمل من السيستم بس.</div>` : (d.meta && !d.meta.ok ? `<div class="ba-warn">⚠️ مقدرتش أقرا «View history» لأكونت: ${E(d.meta.failed.join('، '))} — ممكن يكون فيه كامبينات ناقصة.</div>` : '');
  body.innerHTML = `<section class="ba">
    <div class="ba-head"><div class="ba-title">🧑‍💼 ${d.scope === 'SELF' ? 'شغلك' : 'اللي اتعمل'} ${d.isToday ? 'النهارده' : 'يوم'} <em>${E(long(d.date))}</em></div>
      <div class="ba-nav"><button type="button" class="ba-arrow" data-day="${shift(-1)}" aria-label="اليوم اللي قبله">›</button><button type="button" class="ba-arrow" data-day="${shift(1)}" aria-label="اليوم اللي بعده" ${d.isToday ? 'disabled' : ''}>‹</button></div></div>
    ${modeTabs()}
    <div class="ba-days">${strip}</div>
    <div class="ba-sum"><span><b>${d.totals.campaigns}</b> كامبين</span><span><b>${d.totals.tests}</b> تيست</span><span><b>${d.totals.scales}</b> اسكيل</span>${d.scope === 'SELF' ? '' : `<span><b>${d.totals.people}</b> ميديا باير اشتغل</span>`}</div>
    ${warn}
    <div class="ba-slider"><button type="button" class="ba-sl" data-slide="next" aria-label="اللي بعده">‹</button>
      <div class="ba-track" tabindex="0">${d.people.map((p) => personCard(p, d.team)).join('') || '<div class="ba-none">مفيش ميديا بايرز متسجّلين لسه.</div>'}</div>
      <button type="button" class="ba-sl" data-slide="prev" aria-label="اللي قبله">›</button></div>
    <div class="ba-dots" aria-hidden="true">${d.people.map((_, i) => `<i class="${i === baIdx ? 'on' : ''}"></i>`).join('')}</div>
    <div class="ba-note">${E(d.note)}</div></section>`;
  wireModes(body);
  wire(body, d);
  loadWeek(body, d); // the counts of the other days (a wider read) arrive after the cards are already on screen
}

async function loadWeek(body, d) {
  if (!d.week.some((w) => w.approx)) return;
  const gen = baGen;
  try {
    const w = await api.get('/api/ai-media-buyer/buyer-activity/week', { date: d.date });
    if (gen !== baGen || !w?.week) return;
    const box = body.querySelector('.ba-days'); if (!box) return;
    box.innerHTML = stripHtml(w.week);
    box.querySelectorAll('[data-day]').forEach((b) => { b.onclick = () => { baDay = b.dataset.day; baIdx = 0; renderBuyerActivity(false); }; });
  } catch { /* the chips keep the system-only counts: the cards are the important part */ }
}

function wire(body, d) {
  body.querySelectorAll('[data-day]').forEach((b) => { b.onclick = () => { if (b.disabled) return; baDay = b.dataset.day; baIdx = 0; renderBuyerActivity(false); }; });
  body.querySelectorAll('.ba-link').forEach((box) => { box.querySelector('[data-link]').onclick = async () => {
    const sel = box.querySelector('select'); if (!sel.value) { UI.toast('اختار الميديا باير الأول.', 'error'); return; }
    try { await api.put('/api/ai-media-buyer/buyer-activity/aliases', { actorId: sel.dataset.actor, memberId: sel.value, date: d.date }); UI.toast('اتربط'); renderBuyerActivity(true); } catch (e) { UI.toast(e.message || 'مقدرتش أربطه', 'error'); }
  }; });
  const track = body.querySelector('.ba-track'); if (!track) return;
  const cards = [...track.querySelectorAll('.ba-card')]; const dots = [...body.querySelectorAll('.ba-dots i')];
  const go = (i) => { const c = cards[Math.max(0, Math.min(cards.length - 1, i))]; if (c) c.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' }); }; // works the same in RTL (scrollLeft is negative there, so a numeric scrollTo would land on the wrong card)
  body.querySelectorAll('[data-slide]').forEach((b) => { b.onclick = () => go(baIdx + (b.dataset.slide === 'next' ? 1 : -1)); });
  let tick = null;
  track.addEventListener('scroll', () => { clearTimeout(tick); tick = setTimeout(() => { const mid = track.getBoundingClientRect(); let best = 0, bd = 1e9; cards.forEach((c, i) => { const r = c.getBoundingClientRect(); const dist = Math.abs((r.left + r.right) / 2 - (mid.left + mid.right) / 2); if (dist < bd) { bd = dist; best = i; } }); baIdx = best; dots.forEach((x, i) => x.classList.toggle('on', i === best)); }, 60); });
  track.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); go(baIdx + 1); } else if (e.key === 'ArrowRight') { e.preventDefault(); go(baIdx - 1); } }); // RTL: «next» is on the left
  dots.forEach((x, i) => { x.style.cursor = 'pointer'; x.onclick = () => go(i); });
  if (baIdx > 0) setTimeout(() => go(baIdx), 0);
}

const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const money = (n) => (n == null ? '—' : `${num(n)} ج`);
function prodRow(p, mode) {
  const kinds = [p.tests ? `${p.tests} تيست` : '', p.scales ? `${p.scales} اسكيل` : '', p.other ? `${p.other} كامبين` : ''].filter(Boolean).join(' · ');
  const items = mode === 'yesterday' ? `<details class="ba-pcamps"><summary>الكامبينات (${p.items.length})</summary>${p.items.map((c) => { const [tl, tc] = TYPE[c.type] || TYPE.OTHER; return `<div class="ba-pc ${tc}"><span class="ba-type">${tl}</span><b dir="auto" title="${E(c.name)}">${E(c.name)}</b><em>${E(c.accountName)}</em><span class="r">${c.perf ? `<b>${num(c.perf.orders)}</b> أوردر · ${c.perf.cpa != null ? `كوست <i>${num(c.perf.cpa)} ج</i>` : 'كوست —'}` : 'لسه مفيش بيانات'}</span></div>`; }).join('')}</details>` : '';
  return `<div class="ba-prow"><div class="n"><b dir="auto">${E(p.name)}</b><small>${E(kinds)}</small></div><div class="v"><small>أوردر</small><b>${p.orders == null ? '—' : num(p.orders)}</b></div><div class="v"><small>صرف</small><b>${p.spendKnown ? money(p.spend) : '—'}</b></div><div class="v"><small>كوست</small><b class="cp">${p.cpa != null ? money(p.cpa) : '—'}</b></div>${items}</div>`;
}
function reportCard(p, mode) {
  const initial = E([...(p.name || '؟')][0] || '؟'); const t = p.totals;
  const head = p.idle ? 'ملوش كامبينات في الفترة دي' : `${t.campaigns} ${t.campaigns === 1 ? 'كامبين' : 'كامبينات'} · ${t.tests} تيست · ${t.scales} اسكيل`;
  return `<section class="ba-card ${p.idle ? 'is-idle' : ''}"><header><span class="ba-av ${p.linked ? '' : 'unk'}">${initial}</span><div><b>${E(p.name)}</b><small>${head}${p.linked ? '' : ' · غير مربوط'}</small></div></header>
    ${p.idle ? '' : `<div class="ba-tot"><span><b>${t.orders == null ? '—' : num(t.orders)}</b> أوردر</span><span><b>${money(t.spend)}</b> صرف</span><span>كوست <b class="cp">${t.cpa != null ? money(t.cpa) : '—'}</b></span></div>`}
    <div class="ba-list">${p.idle ? '<div class="ba-none">مفيش كامبين اتعمل باسمه.</div>' : p.products.map((r) => prodRow(r, mode)).join('')}</div></section>`;
}
function renderReport(body, r) {
  const tm = r.totals; const who = r.scope === 'SELF' ? 'شغلك' : 'شغل امبارح'; const title = r.mode === 'yesterday' ? `${who}${r.scope === 'SELF' ? ' امبارح' : ''} <em>${E(long(r.from))}</em> — إيه اللي عمله النهارده` : `الشهر كله <em>${MONTHS[Number(r.today.slice(5, 7)) - 1]} ${r.today.slice(0, 4)}</em>`;
  const warn = r.meta && !r.meta.ok ? `<div class="ba-warn">⚠️ مقدرتش أقرا «View history» لـ: ${E(r.meta.failed.join('، '))} — ممكن يكون فيه كامبينات ناقصة.</div>` : '';
  body.innerHTML = `<section class="ba"><div class="ba-head"><div class="ba-title">📊 ${title}</div></div>${modeTabs()}
    <div class="ba-sum"><span><b>${tm.campaigns}</b> كامبين</span><span><b>${tm.orders == null ? '—' : num(tm.orders)}</b> أوردر</span><span><b>${money(tm.spend)}</b> صرف</span><span>كوست <b>${tm.cpa != null ? money(tm.cpa) : '—'}</b></span></div>${warn}
    <div class="ba-slider"><button type="button" class="ba-sl" data-slide="next" aria-label="اللي بعده">‹</button><div class="ba-track" tabindex="0">${r.people.map((p) => reportCard(p, r.mode)).join('') || '<div class="ba-none">مفيش بيانات.</div>'}</div><button type="button" class="ba-sl" data-slide="prev" aria-label="اللي قبله">›</button></div>
    <div class="ba-dots" aria-hidden="true">${r.people.map((_, i) => `<i class="${i === baIdx ? 'on' : ''}"></i>`).join('')}</div><div class="ba-note">${E(r.note)}</div></section>`;
  wireModes(body); wire(body, { date: r.today });
}
async function renderReportMode(body, gen, force) {
  let r;
  try { r = await api.get('/api/ai-media-buyer/buyer-activity/report', { mode: baMode, ...(force ? { force: '1' } : {}) }); }
  catch (e) { if (gen === baGen) { if (e.status === 403) { document.getElementById('buyerActCard')?.setAttribute('hidden', ''); return; } body.innerHTML = `<span class="atd-err">⚠️ تعذّر تحميل النتايج: ${E(e.message || '')}</span>`; } return; }
  if (gen !== baGen || !r) return;
  if (!r.ready) { // a big month is still being read in the background: show the progress and ask again
    body.innerHTML = `<section class="ba">${modeTabs()}<div class="ba-loading">⏳ بجمّع كامبينات الشهر من Meta… (${r.progress?.done || 0} من ${r.progress?.total || '—'} يوم)</div></section>`; wireModes(body);
    if (baTries++ < 60) baTimer = setTimeout(() => renderBuyerActivity(false), 3000); return;
  }
  renderReport(body, r);
}

export async function renderBuyerActivity(force) {
  const body = document.getElementById('buyerActBody'); if (!body) return;
  clearTimeout(baTimer); const gen = ++baGen;
  if (!body.querySelector('.ba')) body.innerHTML = '<div class="atd-loading"><div class="atd-skel" style="height:220px"></div></div>';
  if (baMode !== 'day') return renderReportMode(body, gen, force);
  let d;
  try { d = await api.get('/api/ai-media-buyer/buyer-activity', { ...(baDay ? { date: baDay } : {}), force: force ? '1' : '' }); }
  catch (e) { if (gen === baGen) { if (e.status === 403) { document.getElementById('buyerActCard')?.setAttribute('hidden', ''); return; } body.innerHTML = `<span class="atd-err">⚠️ تعذّر تحميل نشاط الميديا بايرز: ${E(e.message || '')}</span>`; } return; }
  if (gen !== baGen || !d) return;
  baDay = d.date; render(body, d);
  if (d.isToday) baTimer = setTimeout(() => renderBuyerActivity(false), 120_000); // today refreshes by itself: a new campaign shows up within a couple of minutes
}
