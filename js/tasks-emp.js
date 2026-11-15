// tasks-emp.js — «مهامي اليوم»: the media buyer's own screen. PURE rendering (no network, no state of its own); daily-tasks.js owns the state and the events.
// Goal: open the page and know what to do within seconds. Short cards (no technical campaign names) → click → the panel says WHY, WHAT to do, the RESULT wanted, with notes + proof + «ابدأ» / «تم التنفيذ».
// Every number comes from the day view the server already returns (task.facts / task.plan / task.tech); nothing is invented here — a missing number is simply not shown.
import { escapeHtml as E, shellHref } from './ui-common.js';
import { ic, TAB_META, tabOf, statusKey, applyFilters, num, planTotal, productOf, typeChip, statusChip, prioChip, EXPECT, hhmm, dm, isOpenTask } from './tasks-ui.js';

// ───────────── short, readable text ─────────────
/** «Quran-Speaker - Test 1 - CBO 500» → «Quran-Speaker»: the technical tail of a campaign name belongs in the details, not on the card. */
export function shortName(s, max = 26) {
  const raw = String(s || '').replace(/\s+/g, ' ').trim(); const cut = raw.split(/\s[-–—|]\s|\s*\|\s*/)[0].trim(); const base = cut.length >= 3 ? cut : raw;
  return base.length > max ? `${base.slice(0, max - 1).trim()}…` : base;
}
/** Any «name» in a sentence that looks like a technical campaign name (carrying « - » / «|» parts) is shortened to its first part; ordinary product names are left alone. */
export const tidy = (txt) => String(txt || '').replace(/«([^»]+)»/g, (m, n) => (/\s[-–—|]\s|\|/.test(n) ? `«${shortName(n, 40)}»` : m));
const firstSentence = (txt, max = 130) => { const s = tidy(txt).replace(/\s+/g, ' ').trim(); const i = s.search(/[.!؟](\s|$)/); const one = i > 20 ? s.slice(0, i + 1) : s; return one.length > max ? `${one.slice(0, max - 1).trim()}…` : one; };
const fact = (t, ...needles) => { const f = (t.facts || []).find((x) => needles.some((n) => String(x.l).includes(n))); return f ? f.v : null; };
const plural = (n, [one, two, few, many]) => (n === 1 ? one : n === 2 ? two : n >= 3 && n <= 10 ? few : many);
export function ago(iso, now = Date.now()) {
  const ms = now - Date.parse(iso); if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000); if (m < 1) return 'دلوقتي';
  const phrase = (n, w) => (n <= 2 ? `منذ ${plural(n, w)}` : `منذ ${n} ${plural(n, w)}`); // «منذ دقيقة» / «منذ دقيقتين» / «منذ 3 دقائق»
  if (m < 60) return phrase(m, ['دقيقة', 'دقيقتين', 'دقائق', 'دقيقة']);
  const h = Math.floor(m / 60); if (h < 24) return phrase(h, ['ساعة', 'ساعتين', 'ساعات', 'ساعة']);
  const d = Math.floor(h / 24); return phrase(d, ['يوم', 'يومين', 'أيام', 'يوم']);
}
export const displayTitle = (t) => tidy(t.title);

/** The planned scales in one short line: «4 اسكيلات: ABO ×2 + CBO ×2 · 500 ج لكل واحد». */
export function planLine(t) {
  const plan = Array.isArray(t.plan) ? t.plan : []; if (!plan.length) return '';
  const abo = plan.filter((p) => p.mode === 'ABO').length; const cbo = plan.filter((p) => p.mode === 'CBO').length;
  const budgets = [...new Set(plan.map((p) => Number(p.budget) || 0))];
  const kinds = [abo ? `ABO ×${abo}` : '', cbo ? `CBO ×${cbo}` : ''].filter(Boolean).join(' + ');
  return `${plan.length} ${plural(plan.length, ['اسكيل', 'اسكيلين', 'اسكيلات', 'اسكيل'])}: ${kinds} · ${budgets.length === 1 ? `${num(budgets[0])} ج لكل واحد` : `إجمالي ${num(planTotal(t))} ج`}`;
}
/** One plain line for the card: what is happening and what is asked — from the task's own numbers. */
export function brief(t) {
  if (t.type === 'SCALE' && planLine(t)) return `جهّز ${planLine(t)}`;
  if (t.type === 'ZERO_ORDERS') { const s = fact(t, 'صرف النهارده') || fact(t, 'صرف'); if (s) return `صرف ${s} من غير أوردرات (حسب Meta) — اعرف السبب.`; }
  if (t.type === 'CPA') { const c = fact(t, 'تكلفة الأوردر'); const lim = fact(t, 'حد الإيقاف') || fact(t, 'حد التخفيض'); if (c) return `تكلفة الأوردر ${c}${lim ? ` وده فوق الحد (${lim})` : ''} — قلّل أو وقّف.`; }
  if (t.type === 'TEST') { const o = fact(t, 'أوردرات'); if (o) return `جاب ${o} أوردر (حسب Meta) وعنده مخزون — جهّز تيست بكرياتيف جديد.`; }
  return firstSentence(t.why || t.detail || t.title);
}
/** The wanted result — only what the task's own numbers support. */
export function resultText(t) {
  if (t.type === 'CPA') { const lim = fact(t, 'حد التخفيض') || fact(t, 'حد الإيقاف'); if (lim) return `تكلفة الأوردر ترجع تحت ${lim} بعد التخفيض أو الإيقاف، وتتابعها بكرة.`; }
  if (t.type === 'SCALE' && planLine(t)) return `${planLine(t)} شغّالين، وتتابع تكلفة الأوردر 48 ساعة قبل أي زيادة.`;
  return EXPECT[t.type] || 'المهمة تتقفل بإثبات واضح.';
}
/** «ليه المهمة دي؟» — the real numbers, one per line. */
export function whyLines(t) {
  const lines = (t.facts || []).map((f) => `${f.l}: ${f.v}`);
  const intro = t.source === 'MANUAL' ? 'المدير ضاف المهمة دي بنفسه.' : t.filler ? 'اتضافت عشان تكمّل الحد الأدنى للمهام من شغل حقيقي على منتج شغّال.' : '';
  return { intro, lines, text: lines.length ? '' : firstSentence(t.why || t.detail || '', 260) };
}

const GROUPS = [['SCALE', 'اسكيل', 'rocket'], ['PROBLEM', 'حل مشاكل', 'triangle-alert'], ['TEST', 'تيستات جديدة', 'flask-conical'], ['MIX', 'متابعة', 'refresh-cw']];
const ageOf = (t, date) => (t.originDate && t.originDate < date ? `متأخرة ${Math.round((Date.parse(date) - Date.parse(t.originDate)) / 86_400_000)} يوم` : ago(t.createdAt));

// ───────────── the page ─────────────
export function empCard(S, v, t) {
  const m = TAB_META[tabOf(t)]; const sk = statusKey(t, S.date); const done = sk === 'DONE';
  return `<button class="emp-card ${m.cls} ${done ? 'is-done' : ''}" data-open="${t.id}">
    <span class="emp-ic">${ic(m.icon, 24)}</span>
    <span class="emp-main">
      <span class="emp-top"><b class="emp-title">${E(displayTitle(t))}</b></span>
      <span class="emp-line">${E(brief(t))}</span>
      <span class="emp-foot">${typeChip(t)}<span class="emp-prod">${E(shortName(productOf(t), 40))}</span></span>
    </span>
    <span class="emp-side">${prioChip(t)}${statusChip(t, S.date)}<small>${E(ageOf(t, S.date))}</small></span>
  </button>`;
}

export function employeeBoard(S, v) {
  const mine = applyFilters({ ...S, f: { ...S.f, who: 'ALL', cat: 'ALL', types: new Set(), statuses: new Set(), prios: new Set(), q: '' } }, v);
  const me = v.team?.[0]; const first = String(S.me?.user?.name || S.me?.name || me?.name || '').trim().split(/\s+/)[0];
  const done = mine.filter((t) => statusKey(t, S.date) === 'DONE').length; const pct = mine.length ? Math.round((done / mine.length) * 100) : null;
  const inGroup = (k) => mine.filter((t) => tabOf(t) === k);
  const cat = S.f.cat === 'ALL' || GROUPS.some((g) => g[0] === S.f.cat) ? S.f.cat : 'ALL';
  const shown = cat === 'ALL' ? mine : inGroup(cat);
  const size = 5; const pages = Math.max(1, Math.ceil(shown.length / size)); if (S.page > pages) S.page = pages; const cur = S.page; const slice = shown.slice((cur - 1) * size, cur * size);
  const tile = ([k, label, icon]) => { const list = inGroup(k); const open = list.filter(isOpenTask).length; return `<button class="emp-kpi ${TAB_META[k].cls} ${cat === k ? 'on' : ''}" data-cat="${k}"><span class="emp-kic">${ic(icon, 22)}</span><span><small>${label}</small><b>${list.length}</b></span>${list.length ? `<em>${open ? `${open} لسه` : 'خلصت ✓'}</em>` : ''}</button>`; };
  const chip = (k, label, n) => `<button class="${cat === k ? 'on' : ''}" data-cat="${k}">${label}<em>${n}</em></button>`;
  const nums = []; for (let p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - cur) <= 1) nums.push(p); else if (nums[nums.length - 1] !== '…') nums.push('…');
  const pager = pages > 1 ? `<footer class="emp-pager"><span>عرض ${(cur - 1) * size + 1} – ${Math.min(shown.length, cur * size)} من ${shown.length} مهمة</span><div>${[`<button data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''} aria-label="السابق">${ic('chevron-right', 16)}</button>`, ...nums.map((p) => (p === '…' ? '<i>…</i>' : `<button class="${p === cur ? 'on' : ''}" data-page="${p}">${p}</button>`)), `<button data-page="${cur + 1}" ${cur >= pages ? 'disabled' : ''} aria-label="التالي">${ic('chevron-left', 16)}</button>`].join('')}</div></footer>` : '';
  return `<section class="emp-hello"><div><h2>مرحباً ${E(first || '')} <span aria-hidden="true">👋</span></h2><p>دي مهامك لليوم، نفّذها بالترتيب وحدّث حالتها أولاً بأول.</p></div>
      <div class="emp-prog"><span class="dx-ring" style="--p:${pct ?? 0}"><b>${pct == null ? '—' : `${pct}%`}</b></span><small>${mine.length ? `خلّصت ${done} من ${mine.length}` : 'مفيش مهام لسه'}</small></div></section>
    <div class="emp-kpis">${GROUPS.map(tile).join('')}<button class="emp-kpi total ${cat === 'ALL' ? 'on' : ''}" data-cat="ALL"><span class="emp-kic">${ic('clipboard-list', 22)}</span><span><small>إجمالي المهام</small><b>${mine.length}</b></span></button></div>
    <div class="emp-chips" role="tablist">${chip('ALL', 'الكل', mine.length)}${GROUPS.map(([k, l]) => chip(k, l, inGroup(k).length)).join('')}</div>
    <div class="emp-list">${slice.map((t) => empCard(S, v, t)).join('') || `<div class="emp-empty">${ic('inbox', 36)}<b>${mine.length ? 'مفيش مهام في القسم ده' : 'مفيش مهام ليك النهارده'}</b><small>${mine.length ? 'اختار قسم تاني من فوق.' : 'أول ما المدير يوزّع المهام هتظهر هنا لوحدها.'}</small></div>`}</div>${pager}`;
}

// ───────────── the task panel ─────────────
const proofImgs = (S, t, n) => (n ? `<div class="emp-imgs">${Array.from({ length: n }, (_, i) => `<a href="/api/daily-tasks/proof/${E(t.id)}/${i}?date=${E(S.date)}" target="_blank" rel="noopener noreferrer"><img loading="lazy" alt="إثبات ${i + 1}" src="/api/daily-tasks/proof/${E(t.id)}/${i}?date=${E(S.date)}"></a>`).join('')}</div>` : '');
export const thumbsHtml = (files) => (files || []).map((f, i) => `<span class="emp-th"><img alt="" src="${E(f.data)}"><button type="button" data-rmfile="${i}" aria-label="شيل الصورة">${ic('x', 12)}</button></span>`).join('');

export function employeeDrawer(S, v, t) {
  if (!t) return '';
  const m = TAB_META[tabOf(t)]; const closed = ['DONE', 'AUTO_RESOLVED', 'CANCELLED'].includes(t.status); const can = t.assigneeId === v.mineId;
  const draft = S.proofDraft[t.id] || {}; const why = whyLines(t); const logs = (v.log || []).filter((l) => l.taskId === t.id).slice(0, 8);
  const stepList = (t.steps || []).filter((s) => !((t.plan || []).length && /^اعمل اسكيل \d+:/.test(s))); // the plan chips above already say «اسكيل 1: ABO 500»…, so those lines are not repeated
  const steps = stepList.length ? `<ol class="emp-steps">${stepList.map((s) => `<li>${E(tidy(s))}</li>`).join('')}</ol>` : '';
  const plan = (t.plan || []).length ? `<div class="dx-plan-chips">${t.plan.map((p, i) => `<span class="${p.mode}"><i>${i + 1}</i><b dir="ltr">${p.mode}</b><em>${num(p.budget)} ج</em></span>`).join('')}<span class="tot">الإجمالي ${num(planTotal(t))} ج</span></div>` : '';
  const verify = t.verifyBy === 'SYSTEM' ? 'السيستم هيتأكد لوحده لما المشكلة تتحل في أرقام Meta، ولو ماتحلتش المدير هيراجع إثباتك.' : 'المدير هيراجع إثباتك ويقفل المهمة.';
  const m0 = t.meta; const src = m0 ? `${E(m0.basis || 'Meta')}${m0.window ? ` · من ${E(dm(m0.window.from))} لـ ${E(dm(m0.window.to))}` : ''}${m0.asOf ? ` · آخر مزامنة ${hhmm(m0.asOf)}` : ''}` : '';
  const tech = t.tech || {}; const camps = (tech.campaigns || []).filter(Boolean);
  let act = '';
  if (t.status === 'NEEDS_REVIEW') {
    act = `<section class="emp-sec"><h4>${ic('circle-alert', 17)} إثباتك مستني المراجعة</h4><div class="emp-proof"><p>${E(t.proof || '')}</p>${t.proofLink ? `<a href="${E(t.proofLink)}" target="_blank" rel="noopener noreferrer">${ic('external-link', 14)} رابط الإثبات</a>` : ''}${proofImgs(S, t, (t.proofFiles || []).length)}<small>${E(verify)}</small></div></section>`;
  } else if (t.status === 'DONE') {
    act = `<section class="emp-sec"><h4>${ic('circle-check', 17)} المهمة اتقفلت</h4><div class="emp-proof ok"><p>${E(t.proof || t.note || '')}</p>${proofImgs(S, t, (t.proofFiles || []).length)}<small>${t.verifiedBy === 'SYSTEM' ? 'السيستم اتأكد إن المشكلة اتحلّت.' : t.reviewedBy ? `اعتمدها ${E(t.reviewedBy)}` : ''}${t.doneAt ? ` · ${hhmm(t.doneAt)}` : ''}</small></div></section>`;
  } else if (t.status === 'AUTO_RESOLVED') {
    act = `<section class="emp-sec"><h4>${ic('shield-check', 17)} اتحلّت لوحدها</h4><div class="emp-proof ok"><p>${E(t.resolvedNote || 'المشكلة اختفت من بيانات السيستم.')}</p></div></section>`;
  } else if (can && !closed) {
    act = `<section class="emp-sec"><h4>${ic('send', 17)} إثبات التنفيذ</h4>
      ${t.reviewNote ? `<div class="dx-rej">${ic('circle-alert', 15)} المدير رجّعها: ${E(t.reviewNote)}</div>` : ''}
      <textarea id="dxProof" rows="3" placeholder="اكتب اللي عملته بالظبط… (أو ارفع صورة)">${E(draft.text || '')}</textarea>
      <input id="dxProofLink" type="url" placeholder="رابط الإثبات (اختياري)" value="${E(draft.link || '')}" dir="ltr">
      <div class="emp-up"><label class="emp-file"><input type="file" id="dxFiles" accept="image/*" multiple hidden>${ic('image', 17)}<span>ارفع صورة إثبات</span></label><span class="emp-th-wrap" id="empThumbs">${thumbsHtml(draft.files)}</span></div>
      <p class="emp-hint">${ic('info', 14)} ${E(verify)}</p></section>`;
  }
  const notes = can && !closed ? `<section class="emp-sec"><h4>${ic('pencil', 17)} ملاحظاتي</h4><textarea id="empNote" rows="2" placeholder="أي ملاحظة تفيدك أو تفيد المدير…">${E(draft.note ?? t.empNote ?? '')}</textarea><button class="emp-linkbtn" data-a="note" data-id="${t.id}">حفظ الملاحظة</button></section>` : (t.empNote ? `<section class="emp-sec"><h4>${ic('pencil', 17)} ملاحظاتي</h4><p>${E(t.empNote)}</p></section>` : '');
  const foot = can && !closed && t.status !== 'NEEDS_REVIEW' ? `<footer class="emp-foot-bar">${t.status === 'PENDING' ? `<button class="emp-start" data-a="start" data-id="${t.id}">${ic('play', 17)} ابدأ المهمة</button>` : `<span class="emp-running">${ic('play', 15)} شغّال عليها</span>`}<button class="emp-done" data-a="submit" data-id="${t.id}">${ic('check-check', 18)} تم التنفيذ</button><button class="emp-cant" data-a="notdone" data-id="${t.id}">مقدرتش أنفّذها</button></footer>` : '';
  return `<div class="dx-dr-head"><div class="chips">${typeChip(t)}${prioChip(t)}</div><button class="dx-x" data-act="close-drawer" aria-label="إغلاق">${ic('x', 20)}</button></div>
    <div class="dx-dr-body emp-dr ${m.cls}"><h2>${E(displayTitle(t))}</h2>
      <div class="emp-meta">${ic('shopping-bag', 15)} <b>${E(shortName(productOf(t), 40))}</b> ${statusChip(t, S.date)}${t.carryCount ? `<span>اتأجّلت ${t.carryCount} ${t.carryCount === 1 ? 'مرة' : 'مرات'}</span>` : ''}</div>
      <section class="emp-sec why"><h4>${ic('info', 17)} ليه المهمة دي؟</h4>${why.intro ? `<p>${E(why.intro)}</p>` : ''}${why.lines.length ? `<ul class="emp-facts">${why.lines.map((l) => `<li>${E(l)}</li>`).join('')}</ul>` : `<p>${E(why.text)}</p>`}</section>
      <section class="emp-sec todo"><h4>${ic('clipboard-list', 17)} المطلوب منك</h4>${plan}${steps || (plan ? '' : `<p>${E(tidy(t.detail || ''))}</p>`)}</section>
      <section class="emp-sec res"><h4>${ic('target', 17)} النتيجة المطلوبة</h4><p>${E(resultText(t))}</p></section>
      ${act}${notes}
      ${t.link ? `<a class="dx-open-link" href="${E(shellHref(t.link.page))}">${ic('external-link', 16)} ${E(t.link.label)}</a>` : ''}
      <details class="emp-tech"><summary>${ic('settings', 15)} تفاصيل فنية</summary>
        ${camps.length ? `<div class="emp-tl"><b>الحملات المقصودة:</b><ul dir="auto">${camps.map((c) => `<li>${E(c)}</li>`).join('')}</ul></div>` : ''}
        ${tech.campaignId ? `<div class="emp-tl"><b>رقم الحملة:</b> <code dir="ltr">${E(tech.campaignId)}</code></div>` : ''}${tech.accountId || t.accountId ? `<div class="emp-tl"><b>الحساب الإعلاني:</b> <code dir="ltr">${E(tech.accountId || t.accountId)}</code></div>` : ''}
        ${src ? `<div class="emp-tl"><b>مصدر الأرقام:</b> ${src}</div>` : ''}${t.numbersAt ? `<div class="emp-tl"><b>اتحدّثت:</b> ${hhmm(t.numbersAt)}</div>` : ''}
        ${logs.length ? `<div class="emp-tl"><b>سجل المهمة:</b>${logs.map((l) => `<div class="emp-lg"><time>${hhmm(l.at)}</time> ${E(l.actorName || 'السيستم')} — ${E(l.text || '')}</div>`).join('')}</div>` : ''}
      </details></div>${foot}`;
}
