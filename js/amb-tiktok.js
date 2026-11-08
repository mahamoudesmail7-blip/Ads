// AMB «TikTok» — create a COMPLETE TikTok campaign without knowing TikTok: connect → 6 simple steps → review → launch (always created PAUSED; turning it on is a separate, confirmed click).
// 1 الهدف · 2 الإعلان · 3 الجمهور · 4 الميزانية والتشغيل · 5 المراجعة · 6 الرفع. Everything is a draft saved on the server as you type; the launch is resumable and never duplicates anything.
import { api } from './api-client.js';
import * as UI from './ui-common.js';

const B = '/api/amb-tiktok';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { view: 'home', opts: null, status: null, account: null, drafts: null, d: null, step: 1, val: null, saving: '', msg: null, interests: null, launching: false, visited: new Set() };
const STEPS = [[1, 'الهدف'], [2, 'الإعلان'], [3, 'الجمهور'], [4, 'الميزانية'], [5, 'المراجعة'], [6, 'الرفع']];
const FIELD_STEP = { name: 1, objective: 1, pixelId: 1, event: 1, landingUrl: 2, displayName: 2, identity: 2, adText: 2, videos: 2, adsPerVideo: 2, locations: 3, ageGroups: 3, languages: 3, dailyBudget: 4, bidStrategy: 4, bidAmount: 4, startDate: 4, endDate: 4, runMode: 4 };
const STATUS_AR = { DRAFT: ['مسودة', ''], LAUNCHING: ['بيتم الرفع…', 'warn'], LAUNCHED: ['اترفع (موقوف)', 'ok'], ENABLED: ['شغّال', 'ok'], FAILED: ['وقف عند خطأ', 'bad'] };

export async function mountTikTok(panel, opts = {}) {
  const toast = opts.toast || (() => {});
  const root = panel; root.classList.add('tk'); root.innerHTML = '<div class="tk-empty"><span class="tk-spin"></span><b>بجهّز قسم تيك توك…</b></div>';
  let saveTimer = null; let valTimer = null; let pollTimer = null; let pending = {};
  const stop = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
  const cfg = () => S.d?.config || {};
  const isDemo = () => S.status?.mode === 'MOCK';
  const currency = () => S.account?.info?.currency || '';

  async function boot() {
    try { [S.opts, S.status] = await Promise.all([api.get(`${B}/options`), api.get(`${B}/status`)]); } catch (e) { root.innerHTML = `<div class="tk-card"><div class="tk-cbody"><div class="tk-msg bad">${esc(e.message)}</div></div></div>`; return; }
    await loadAccount(); await loadDrafts(); await loadOauth();
    try { const l = (await api.get(`${B}/oauth/last`)).last; if (l) { S.msg = l.ok ? { text: `✅ اتربط ${l.count} حساب إعلاني (${l.added} جديد، ${l.updated} اتحدّث).` } : { text: `ما اتربطش: ${l.message}`, bad: true }; S.view = 'connect'; await loadOauth(); S.status = await api.get(`${B}/status`); await loadAccount(); render(); return; } } catch { /* no callback result */ }
    S.view = S.status.mode === 'NONE' ? 'connect' : 'home'; render();
  }
  async function loadOauth() { try { S.oauth = await api.get(`${B}/oauth/info`); } catch { S.oauth = null; } }
  async function loadAccount() { try { S.account = await api.get(`${B}/account`); } catch { S.account = null; } }
  async function loadDrafts() { try { S.drafts = (await api.get(`${B}/drafts`)).drafts; } catch { S.drafts = []; } }

  // ---------------------------------------------------------------- saving + validation (debounced; the screen never blocks while typing)
  function set(patch, { rerender = false } = {}) {
    Object.assign(S.d.config, patch); Object.assign(pending, patch); S.saving = 'بيتحفظ…';
    clearTimeout(saveTimer); saveTimer = setTimeout(flush, 600); scheduleVal();
    const el = root.querySelector('[data-saving]'); if (el) el.textContent = S.saving; if (rerender) render();
  }
  async function flush() {
    clearTimeout(saveTimer); if (!Object.keys(pending).length) return; const body = pending; pending = {};
    try { S.d = { ...(await api.put(`${B}/drafts/${S.d.id}`, { config: body })), ...{} }; S.saving = 'اتحفظ ✓'; } catch (e) { S.saving = ''; S.msg = { text: e.message, bad: true }; render(); return; }
    const el = root.querySelector('[data-saving]'); if (el) el.textContent = S.saving;
  }
  function scheduleVal() { clearTimeout(valTimer); valTimer = setTimeout(runValidate, 900); }
  async function runValidate() { if (!S.d) return; await flush(); try { S.val = await api.post(`${B}/drafts/${S.d.id}/validate`, {}); } catch { return; } paintStepper(); paintErrors(); if (S.step === 5) paintReview(); }
  const showBad = (i) => i < 5 && S.visited.has(i) && i !== S.step && stepBad(i); // a step turns red only after you have been on it — a fresh draft is not shouted at
  const stepBad = (n) => (S.val?.errors || []).some((e) => (FIELD_STEP[e.field] || 0) === n);

  // ---------------------------------------------------------------- shell
  function render() {
    stop();
    if (S.view === 'wizard') return renderWizard(); // wires itself
    if (S.view === 'connect') renderConnect(); else renderHome();
    wire();
  }
  const head = (sub) => `<div class="tk-head"><div><div class="tk-title"><span class="tk-logo">♪</span>تيك توك — كامبين كامل</div><div class="tk-sub">${sub}</div></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${statusChip()}<button class="tk-btn sm" data-act="connect">⚙️ الربط</button></div></div>`;
  const statusChip = () => (isDemo() ? '<span class="tk-chip demo">🧪 وضع تجريبي</span>' : S.status?.mode === 'REAL' ? `<span class="tk-chip ok">✓ مربوط${S.account?.info?.name ? ' — ' + esc(S.account.info.name) : ''}</span>` : '<span class="tk-chip warn">غير مربوط</span>');
  const msgBox = () => (S.msg ? `<div class="tk-msg ${S.msg.bad ? 'bad' : 'ok'}">${esc(S.msg.text)}</div>` : '');
  const field = (label, inner, hint = '') => `<label class="tk-f"><span>${label}</span>${inner}${hint ? `<small>${hint}</small>` : ''}</label>`;

  // ---------------------------------------------------------------- connect
  function acctCards(accounts) {
    if (!accounts.length) return '<div class="tk-empty"><small>لسه مفيش حسابات مربوطة.</small></div>';
    const card = (a) => {
      const exp = a.tokenExpired ? '⚠️ التوكن منتهي — أعد الربط' : a.tokenExpiresAt ? 'التوكن بيتجدّد تلقائيًا' : 'التوكن مفتوح المدة';
      const act = a.active ? '' : '<button class="tk-btn sm primary" data-act="activate" data-id="' + esc(a.advertiserId) + '">اجعله النشط</button>';
      return '<div class="tk-dcard"><div style="display:flex;justify-content:space-between;gap:8px;"><h3>' + esc(a.name) + '</h3>' + (a.active ? '<span class="tk-chip ok">النشط</span>' : '') + '</div>'
        + '<small dir="ltr">' + esc(a.advertiserId) + ' · ' + esc(a.currency || '—') + '</small><small>' + exp + '</small>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + act + '<button class="tk-btn sm" data-act="checkAcct" data-id="' + esc(a.advertiserId) + '">فحص الصلاحيات</button><button class="tk-btn sm" data-act="disconnectAcct" data-id="' + esc(a.advertiserId) + '">فصل</button></div>'
        + '<div data-check="' + esc(a.advertiserId) + '"></div></div>';
    };
    return '<div class="tk-drafts">' + accounts.map(card).join('') + '</div>';
  }
  function renderConnect() {
    const st = S.status || {}; const o = S.oauth || { app: {}, accounts: [], redirectUri: '', writesUnlocked: false };
    const accounts = o.accounts || [];
    root.innerHTML = `${head('اربط حسابات تيك توك الإعلانية بالتفويض الرسمي (OAuth) — مرة واحدة.')}
    ${msgBox()}
    <div class="tk-card"><div class="tk-chead">① تطبيق تيك توك (Developer App) ${o.app?.configured ? '<span class="tk-chip ok">متظبط</span>' : '<span class="tk-chip warn">لسه</span>'}</div><div class="tk-cbody">
      <div class="tk-f"><span>Advertiser redirect URL — الصقه في TikTok Developers عند تسجيل التطبيق</span>
        <div style="display:flex;gap:8px;"><input type="text" id="tkRedirect" readonly dir="ltr" value="${esc(o.redirectUri || '')}" style="flex:1"><button class="tk-btn" data-act="copyRedirect">📋 انسخ</button></div>
        <small>الرابط ده ثابت. لازم يتطابق حرف بحرف مع اللي في تطبيقك على تيك توك.</small></div>
      <div class="tk-grid2">
        ${field('App ID', `<input type="text" inputmode="numeric" data-f="appId" dir="ltr" placeholder="بعد ما التطبيق يتوافق عليه" value="${esc(o.app?.appId || '')}">`, 'من My Apps → تطبيقك.')}
        ${field('App Secret', `<input type="password" data-f="appSecret" dir="ltr" autocomplete="off" placeholder="${o.app?.secretSaved ? '•••• محفوظ (' + esc(o.app.last4 || 'ENV') + ') — سيبه فاضي لو مش هتغيّره' : 'الصق الـ Secret هنا'}">`, 'بيتخزّن مشفّر ومبيظهرش تاني. إنت اللي بتحطه، محدش تاني.')}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="tk-btn primary" data-act="saveApp">حفظ بيانات التطبيق</button>${o.app?.configured && o.app?.source === 'SAVED' ? '<button class="tk-btn" data-act="clearApp">مسح</button>' : ''}</div>
    </div></div>
    <div class="tk-card"><div class="tk-chead">② الحسابات الإعلانية المربوطة (${accounts.length})</div><div class="tk-cbody">
      <div><button class="tk-btn primary" data-act="startOauth" ${o.app?.configured ? '' : 'disabled'}>🔗 اربط حسابات تيك توك</button> <span class="tk-sub">${o.app?.configured ? 'هتروح لصفحة تيك توك وتختار الحسابات اللي توافق عليها.' : 'احفظ بيانات التطبيق الأول.'}</span></div>
      ${acctCards(accounts)}
    </div></div>
    <div class="tk-card"><div class="tk-chead">③ الرفع الحقيقي على تيك توك ${o.writesUnlocked ? '<span class="tk-chip warn">مفتوح</span>' : '<span class="tk-chip ok">مقفول (أمان)</span>'}</div><div class="tk-cbody">
      <p class="tk-sub">مقفول افتراضيًا: تقدر تربط وتراجع وتجهّز الكامبينات، بس مفيش حاجة بتتعمل على تيك توك الحقيقي لحد ما تفتحه بنفسك.</p>
      <div><button class="tk-btn ${o.writesUnlocked ? '' : 'danger'}" data-act="toggleWrites">${o.writesUnlocked ? '🔒 اقفل الرفع الحقيقي' : '🔓 افتح الرفع الحقيقي'}</button></div>
    </div></div>
    <div class="tk-card"><div class="tk-chead">🧪 الوضع التجريبي</div><div class="tk-cbody"><p class="tk-sub">بيشغّل كل الشاشات بحساب تيك توك وهمي (من غير أي صرف ولا أي حاجة بتتعمل على تيك توك الحقيقي). مناسب للتعلّم وتدريب الفريق.</p>
      <div style="display:flex;gap:8px;"><button class="tk-btn ${isDemo() ? 'danger' : ''}" data-act="toggleDemo">${isDemo() ? 'إيقاف الوضع التجريبي' : 'جرّب الوضع التجريبي'}</button>${st.mode !== 'NONE' ? '<button class="tk-btn" data-act="home">رجوع للكامبينات →</button>' : ''}</div></div></div>
    <details class="tk-card"><summary class="tk-chead" style="cursor:pointer">ربط يدوي بالتوكن (متقدم)</summary><div class="tk-cbody">
      <div class="tk-grid2">
        ${field('Advertiser ID', `<input type="text" inputmode="numeric" data-f="adv" dir="ltr" placeholder="7000000000001" value="${esc(st.advertiserId || '')}">`)}
        ${field('Access Token', `<input type="password" data-f="tok" dir="ltr" autocomplete="off" placeholder="${st.tokenSaved ? '•••• محفوظ (' + esc(st.last4 || 'ENV') + ')' : 'الصق التوكن هنا'}">`)}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="tk-btn" data-act="saveConn">ربط واختبار</button>${st.mode === 'REAL' && !st.oauth?.accounts ? '<button class="tk-btn" data-act="clearConn">فصل</button>' : ''}</div>
    </div></details>`;
  }

  // ---------------------------------------------------------------- home
  function renderHome() {
    const drafts = S.drafts || [];
    root.innerHTML = `${head('اعمل كامبين تيك توك كامل — اختار الهدف، حط الفيديو والميزانية، وارفع.')}
    ${msgBox()}${isDemo() ? '<div class="tk-demo">🧪 إنت في الوضع التجريبي: كل اللي بتعمله هنا وهمي ومش بيوصل لتيك توك.</div>' : ''}
    ${S.status?.mode === 'NONE' ? '<div class="tk-msg warn">لسه مفيش حساب تيك توك مربوط. اضغط «الربط».</div>' : ''}
    <div class="tk-card"><div class="tk-chead">ابدأ كامبين جديد</div><div class="tk-cbody">
      <div class="tk-choices">${S.opts.presets.map((p) => `<button class="tk-choice" data-act="newPreset" data-id="${p.id}"><b>${esc(p.label)}</b><small>${esc(p.description)}</small></button>`).join('')}
        <button class="tk-choice" data-act="newPreset" data-id=""><b>➕ من الصفر</b><small>اختار كل حاجة بنفسك.</small></button></div></div></div>
    <div class="tk-card"><div class="tk-chead">كامبيناتك (${drafts.length})</div><div class="tk-cbody">${drafts.length ? `<div class="tk-drafts">${drafts.map(draftCard).join('')}</div>` : '<div class="tk-empty"><span style="font-size:30px">🎬</span><b>لسه معملتش كامبين</b><small>ابدأ من واحد من القوالب فوق.</small></div>'}</div></div>`;
  }
  function draftCard(d) {
    const [label, kind] = STATUS_AR[d.status] || [d.status, '']; const o = S.opts.objectives.find((x) => x.id === d.objective);
    return `<div class="tk-dcard"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;"><h3>${esc(d.name)}</h3><span class="tk-chip ${kind}">${label}</span></div>
      <small>${o ? o.emoji + ' ' + esc(o.label) : ''}${d.dailyBudget ? ` · ${esc(d.dailyBudget)} /يوم` : ''} · ${d.videos} فيديو${d.mode === 'MOCK' ? ' · 🧪 تجريبي' : ''}</small>
      ${d.error ? `<small style="color:var(--tk-bad)">${esc(d.error)}</small>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="tk-btn sm primary" data-act="open" data-id="${d.id}">فتح</button><button class="tk-btn sm" data-act="dup" data-id="${d.id}">نسخة</button>${d.campaignId ? '' : `<button class="tk-btn sm" data-act="del" data-id="${d.id}">حذف</button>`}</div></div>`;
  }

  // ---------------------------------------------------------------- wizard
  function renderWizard() {
    const d = S.d; const n = S.step;
    root.innerHTML = `${head(`<button class="tk-btn sm" data-act="home">→ كامبيناتك</button> <span class="faint" data-saving>${esc(S.saving)}</span>`)}
    ${isDemo() ? '<div class="tk-demo">🧪 وضع تجريبي — مفيش حاجة هتتعمل على تيك توك الحقيقي.</div>' : ''}${msgBox()}
    <div class="tk-steps" id="tkSteps">${STEPS.map(([i, l]) => `<button class="tk-step ${i === n ? 'on' : ''} ${showBad(i) ? 'bad' : ''} ${i < n && !stepBad(i) ? 'done' : ''}" data-act="go" data-n="${i}"><span class="n">${i < n && !stepBad(i) ? '✓' : i}</span>${l}</button>`).join('')}</div>
    <div class="tk-card"><div class="tk-cbody" id="tkBody">${[null, step1, step2, step3, step4, step5, step6][n]()}</div></div>
    ${n < 6 ? `<div class="tk-foot"><button class="tk-btn" data-act="go" data-n="${n - 1}" ${n === 1 ? 'disabled' : ''}>→ السابق</button>${n < 5 ? `<button class="tk-btn primary" data-act="go" data-n="${n + 1}">التالي ←</button>` : ''}</div>` : ''}`;
    if (n === 5) { runValidate().then(() => { if (S.step === 5) paintReview(); }); }
    if (n === 6) { watchLaunch(); }
    wire(); paintErrors();
  }
  const paintStepper = () => { const el = root.querySelector('#tkSteps'); if (!el || S.view !== 'wizard') return; el.querySelectorAll('.tk-step').forEach((b) => { const i = Number(b.dataset.n); b.classList.toggle('bad', showBad(i)); const done = i < S.step && !stepBad(i); b.classList.toggle('done', done); const nEl = b.querySelector('.n'); if (nEl) nEl.textContent = done ? '✓' : String(i); }); };

  const pills = (items, selected, key, multi = true) => `<div class="tk-pills">${items.map((it) => `<button type="button" class="tk-pill ${(multi ? selected.includes(it.id) : selected === it.id) ? 'on' : ''}" data-act="pill" data-key="${key}" data-id="${it.id}" data-multi="${multi ? 1 : 0}">${esc(it.label)}</button>`).join('')}</div>`;
  const radios = (items, selected, key) => `<div style="display:grid;gap:8px;">${items.map((it) => `<div class="tk-radio ${selected === it.id ? 'on' : ''}" data-act="radio" data-key="${key}" data-id="${it.id}"><input type="radio" ${selected === it.id ? 'checked' : ''} tabindex="-1"><div><b>${esc(it.label)}</b>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</div></div>`).join('')}</div>`;
  // inline field errors: placeholders filled by paintErrors() from the LATEST validation — and only once you have left this step before (a fresh step is not shouted at)
  const errFor = (f) => `<div class="tk-msg bad" data-err="${f}" style="padding:6px 10px" hidden></div>`;
  function paintErrors() {
    const show = S.visited.has(S.step); const errs = S.val?.errors || [];
    root.querySelectorAll('[data-err]').forEach((el) => { const e = show ? errs.find((x) => x.field === el.dataset.err) : null; el.hidden = !e; el.textContent = e ? e.message : ''; });
  }

  function step1() {
    const c = cfg(); const o = S.opts.objectives.find((x) => x.id === c.objective) || {};
    const pixels = S.account?.pixels || [];
    return `<h2>إيه هدف الكامبين؟</h2>
    <div><div class="tk-sub" style="margin-bottom:8px">قوالب جاهزة (بتملا كل الإعدادات المناسبة مرة واحدة):</div><div class="tk-pills">${S.opts.presets.map((p) => `<button class="tk-pill" data-act="preset" data-id="${p.id}" title="${esc(p.description)}">${esc(p.label)}</button>`).join('')}</div></div>
    ${field('اسم الكامبين', `<input type="text" data-f="name" value="${esc(c.name)}" placeholder="مثال: Selicon — مبيعات مصر">`)}${errFor('name')}
    <div class="tk-choices">${S.opts.objectives.map((x) => `<button class="tk-choice ${c.objective === x.id ? 'on' : ''}" data-act="objective" data-id="${x.id}"><b>${x.emoji} ${esc(x.label)}</b>${x.recommended ? '<span class="rec">⭐ الأنسب للمتاجر</span>' : ''}<small>${esc(x.hint)}</small>${x.unsupported ? '<small style="color:var(--tk-warn)">محتاج إعداد إضافي — مش مدعوم هنا لسه</small>' : ''}</button>`).join('')}</div>${errFor('objective')}
    ${o.needsPixel ? `<div class="tk-grid2">${field('الـ Pixel (بيحسب الأوردرات)', pixels.length ? `<select data-f="pixelId"><option value="">— اختار —</option>${pixels.map((p) => `<option value="${esc(p.id)}" ${c.pixelId === p.id ? 'selected' : ''}>${esc(p.name)} (${esc(p.id)})</option>`).join('')}</select>` : `<input type="text" data-f="pixelId" dir="ltr" value="${esc(c.pixelId)}" placeholder="Pixel ID">`, pixels.length ? '' : 'مفيش Pixels ظاهرة على الحساب — اكتب الـ ID أو أنشئ Pixel من تيك توك.')}
      ${field('الحدث اللي بنحسّنه', `<select data-f="event">${S.opts.events.map((e) => `<option value="${e.id}" ${c.event === e.id ? 'selected' : ''}>${esc(e.label)}${e.recommended ? ' — الأنسب' : ''}</option>`).join('')}</select>`, 'للمتاجر: «إتمام الطلب».')}</div>${errFor('pixelId')}` : ''}`;
  }
  function step2() {
    const c = cfg(); const ids = S.account?.identities || []; const o = S.opts.objectives.find((x) => x.id === c.objective) || {};
    const vids = c.videos || [];
    return `<h2>الإعلان نفسه</h2>
    ${o.needsLanding || c.landingUrl ? field('لينك صفحة المنتج (اللي الإعلان هيودّي عليه)', `<input type="url" data-f="landingUrl" dir="ltr" value="${esc(c.landingUrl)}" placeholder="https://your-store.com/products/…">`, 'لازم https وبيفتح من الموبايل.') + errFor('landingUrl') : ''}
    <div class="tk-f"><span>البراند (الاسم اللي بيظهر فوق الإعلان)</span>
      <div style="display:grid;gap:8px;">
        <div class="tk-radio ${c.identity?.mode !== 'EXISTING' ? 'on' : ''}" data-act="idmode" data-id="NEW"><input type="radio" ${c.identity?.mode !== 'EXISTING' ? 'checked' : ''} tabindex="-1"><div style="flex:1"><b>اسم براند جديد</b><input type="text" data-f="displayName" value="${esc(c.displayName)}" maxlength="40" placeholder="مثال: Trendy Store" style="margin-top:6px"></div></div>
        ${ids.length ? `<div class="tk-radio ${c.identity?.mode === 'EXISTING' ? 'on' : ''}" data-act="idmode" data-id="EXISTING"><input type="radio" ${c.identity?.mode === 'EXISTING' ? 'checked' : ''} tabindex="-1"><div style="flex:1"><b>هوية موجودة على حسابك</b><select data-f="identityId" style="margin-top:6px"><option value="">— اختار —</option>${ids.map((i) => `<option value="${esc(i.id)}" ${c.identity?.id === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></div></div>` : ''}
      </div></div>${errFor('displayName')}${errFor('identity')}
    ${field(`نص الإعلان <span class="tk-count ${String(c.adText || '').length > 100 ? 'over' : ''}" data-count>${String(c.adText || '').length}/100</span>`, `<textarea data-f="adText" maxlength="300" placeholder="مثال: اطلب دلوقتي والدفع عند الاستلام 🚚">${esc(c.adText)}</textarea>`, 'قصير وواضح (أقل من 50 حرف أحسن). متكتبش ادعاءات طبية أو «قبل وبعد».')}${errFor('adText')}
    ${field('زر الإجراء (CTA)', `<select data-f="cta">${S.opts.ctas.map((x) => `<option value="${x.id}" ${c.cta === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>`)}
    <div class="tk-f"><span>الفيديوهات (لينك مباشر لملف mp4 — رأسي 9:16)</span>
      ${vids.map((v, i) => `<div class="tk-vrow"><span class="i">${i + 1}</span><input type="url" dir="ltr" data-vurl="${i}" value="${esc(v.url)}" placeholder="https://…/video.mp4"><input class="nm" type="text" data-vname="${i}" value="${esc(v.name)}" placeholder="اسم (اختياري)"><button class="tk-btn sm" data-act="rmVideo" data-i="${i}">✕</button></div>`).join('')}
      <div style="display:grid;gap:6px;margin-top:6px"><textarea data-f="vbulk" rows="2" placeholder="الصق لينكات فيديو هنا (سطر لكل فيديو) وبعدين اضغط «ضيف»"></textarea><div><button class="tk-btn sm" data-act="addVideos">➕ ضيف</button> <span class="tk-sub">من ${vids.length} (الأفضل 2–3 فيديوهات مختلفة)</span></div></div></div>${errFor('videos')}
    ${vids.length ? field('عدد الإعلانات لكل فيديو', `<select data-f="adsPerVideo">${[1, 2, 3].map((n) => `<option ${Number(c.adsPerVideo) === n ? 'selected' : ''} value="${n}">${n}</option>`).join('')}</select>`, 'واحد كفاية للبداية.') : ''}`;
  }
  function step3() {
    const c = cfg(); const o = S.opts;
    return `<h2>مين الجمهور؟</h2>
    <div class="tk-f"><span>البلاد</span>${pills(o.locations, c.locations || [], 'locations')}</div>${errFor('locations')}
    <div class="tk-f"><span>الأعمار</span>${pills(o.ageGroups, c.ageGroups || [], 'ageGroups')}<small>13–17 بتتقيّد في إعلانات المنتجات — متختارهاش.</small></div>${errFor('ageGroups')}
    <div class="tk-f"><span>النوع</span>${pills(o.genders, c.gender, 'gender', false)}</div>
    <div class="tk-f"><span>اللغة</span>${pills(o.languages, c.languages || [], 'languages')}<small>لو جمهورك عربي اختار العربية.</small></div>
    <div class="tk-f"><span>نظام التشغيل (اختياري — سيبه فاضي للكل)</span>${pills(o.operatingSystems, c.operatingSystems || [], 'operatingSystems')}</div>
    <div class="tk-f"><span>الاهتمامات (اختياري)</span>${S.interests ? pills(S.interests.map((i) => ({ id: i.id, label: i.name })), c.interestIds || [], 'interestIds') : '<button class="tk-btn sm" data-act="loadInterests">حمّل الاهتمامات من تيك توك</button>'}<small>سيبها فاضية = تيك توك يلاقي الجمهور لوحده (الأنسب غالبًا).</small></div>`;
  }
  function step4() {
    const c = cfg(); const o = S.opts;
    return `<h2>الميزانية والتشغيل</h2>
    <div class="tk-grid2">${field(`الميزانية اليومية ${currency() ? '(' + esc(currency()) + ')' : ''}`, `<input type="number" min="1" step="1" data-f="dailyBudget" value="${esc(c.dailyBudget)}" placeholder="مثال: 1000">`, 'تيك توك بيطلب حد أدنى حسب العملة — لو الرقم قليل هتتنبه.')}
      ${field('مستوى الميزانية', `<select data-f="budgetLevel">${o.budgetLevels.map((b) => `<option value="${b.id}" ${c.budgetLevel === b.id ? 'selected' : ''}>${esc(b.label)}</option>`).join('')}</select>`)}</div>${errFor('dailyBudget')}
    <div class="tk-f"><span>المزايدة</span>${radios(o.bidStrategies, c.bidStrategy, 'bidStrategy')}</div>
    ${c.bidStrategy === 'COST_CAP' ? field('سقف التكلفة (أقصى تكلفة للنتيجة)', `<input type="number" min="0" step="0.01" data-f="bidAmount" value="${esc(c.bidAmount)}">`) + errFor('bidAmount') : ''}
    <div class="tk-f"><span>أماكن العرض</span>${radios(o.placements, c.placement, 'placement')}</div>
    <div class="tk-f"><span>التشغيل</span>${radios(o.runModes, c.runMode, 'runMode')}</div>
    ${c.runMode === 'SCHEDULED' ? `<div class="tk-grid3">${field('تاريخ البداية', `<input type="date" data-f="startDate" value="${esc(c.startDate)}">`)}${field('وقت البداية', `<input type="time" data-f="startTime" value="${esc(c.startTime)}">`)}${field('تاريخ النهاية (اختياري)', `<input type="date" data-f="endDate" value="${esc(c.endDate)}">`)}</div>${errFor('startDate')}${errFor('endDate')}` : ''}
    <div class="tk-f"><span>خيارات إضافية</span><div style="display:grid;gap:6px;">
      <label class="tk-radio"><input type="checkbox" data-f="commentsOff" ${c.commentsOff ? 'checked' : ''}><div><b>قفل التعليقات</b></div></label>
      <label class="tk-radio"><input type="checkbox" data-f="downloadOff" ${c.downloadOff ? 'checked' : ''}><div><b>منع تحميل الفيديو</b></div></label>
      <label class="tk-radio"><input type="checkbox" data-f="shareOff" ${c.shareOff ? 'checked' : ''}><div><b>منع المشاركة</b></div></label></div></div>`;
  }
  function step5() { return '<div id="tkReview"><div class="tk-empty"><span class="tk-spin"></span><b>براجع كل حاجة…</b></div></div>'; }
  function paintReview() {
    const el = root.querySelector('#tkReview'); if (!el || !S.val) return;
    const v = S.val; const locked = !!S.d.progress?.campaignId;
    el.innerHTML = `<h2>المراجعة قبل الرفع</h2>
      <div class="tk-sum">${v.summary.map(([k, val]) => `<span>${esc(k)}</span><b>${esc(val)}</b>`).join('')}</div>
      ${v.errors.length ? `<div class="tk-list"><b style="color:var(--tk-bad)">لازم تصلّح قبل الرفع (${v.errors.length}):</b>${v.errors.map((e) => `<div class="tk-li bad">${esc(e.message)} <button class="tk-btn sm" data-act="go" data-n="${FIELD_STEP[e.field] || 1}">روح للخطوة</button></div>`).join('')}</div>` : '<div class="tk-msg ok">✅ كل البيانات سليمة وجاهزة للرفع.</div>'}
      ${v.warnings.length ? `<div class="tk-list"><b style="color:var(--tk-warn)">تنبيهات (مش بتمنع الرفع):</b>${v.warnings.map((w) => `<div class="tk-li warn">${esc(w.message)}</div>`).join('')}</div>` : ''}
      <div class="tk-msg">الكامبين بيترفع <b>موقوف</b> وإنت اللي بتشغّله بعد المراجعة على تيك توك. مفيش صرف قبل كده.${isDemo() ? ' (وضع تجريبي: مفيش حاجة بتروح لتيك توك.)' : ''}</div>
      ${locked ? '<div class="tk-msg warn">الكامبين ده اتعمل على تيك توك بالفعل. افتح خطوة «الرفع».</div>' : ''}
      <label class="tk-radio"><input type="checkbox" data-f="agree"><div><b>راجعت البيانات وموافق على رفع الكامبين</b></div></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="tk-btn primary" data-act="launch" data-enable="0" ${v.ok && !locked ? '' : 'disabled'} id="tkLaunch">🚀 ارفع على تيك توك (موقوف)</button>
      <button class="tk-btn" data-act="launch" data-enable="1" ${v.ok && !locked ? '' : 'disabled'} id="tkLaunch2">ارفع وشغّل على طول</button></div>`;
    el.querySelectorAll('[data-act="launch"]').forEach((b) => { b.disabled = true; });
    const agree = el.querySelector('[data-f="agree"]'); if (agree) agree.onchange = () => { el.querySelectorAll('[data-act="launch"]').forEach((b) => { b.disabled = !(agree.checked && v.ok && !locked); }); };
    wireIn(el);
  }

  // ---------------------------------------------------------------- launch progress
  function step6() {
    const d = S.d; const p = d.progress || {}; const steps = p.steps || []; const labels = d.stepLabels || {};
    const order = ['validate', 'identity', 'upload', 'campaign', 'adgroup', 'ads', 'enable'].filter((k) => k !== 'enable' || steps.some((s) => s.key === 'enable'));
    const row = (k) => { const s = steps.find((x) => x.key === k); const kind = s?.status === 'DONE' ? 'done' : s?.status === 'RUNNING' ? 'run' : s?.status === 'FAILED' ? 'fail' : ''; const ic = s?.status === 'DONE' ? '✅' : s?.status === 'RUNNING' ? '<span class="tk-spin"></span>' : s?.status === 'FAILED' ? '❌' : '○'; return `<div class="tk-prow ${kind}"><span class="ic">${ic}</span>${esc(labels[k] || k)}${s?.detail ? `<small>${esc(s.detail)}</small>` : ''}</div>`; };
    const [label, kind] = STATUS_AR[d.status] || [d.status, ''];
    return `<h2>الرفع على تيك توك <span class="tk-chip ${kind}">${label}</span></h2>
      ${steps.length ? `<div class="tk-prog">${order.map(row).join('')}</div>` : '<div class="tk-msg">لسه مارفعتش. اضغط «ارفع» من خطوة المراجعة.</div>'}
      ${d.error ? `<div class="tk-msg bad"><b>${esc(d.error.stepLabel || '')}: ${esc(d.error.hint?.title || 'حصل خطأ')}</b><br>${esc(d.error.hint?.action || '')}<br><small dir="ltr">${esc(d.error.message)}${d.error.requestId ? ' · ' + esc(d.error.requestId) : ''}</small></div><div><button class="tk-btn primary" data-act="resume" ${S.launching || d.running ? 'disabled' : ''}>🔄 كمّل من مكان ما وقف (من غير تكرار)</button></div>` : ''}
      ${(p.warnings || []).length ? `<div class="tk-list">${p.warnings.map((w) => `<div class="tk-li warn">${esc(w)}</div>`).join('')}</div>` : ''}
      ${p.campaignId ? `<div class="tk-sum"><span>Campaign ID</span><b dir="ltr">${esc(p.campaignId)}</b><span>Ad Group ID</span><b dir="ltr">${esc(p.adgroupId || '—')}</b><span>الإعلانات</span><b dir="ltr">${esc((p.adIds || []).join(', ') || '—')}</b></div>` : ''}
      ${d.status === 'LAUNCHED' ? `<div class="tk-msg ok">✅ الكامبين اتعمل على تيك توك <b>موقوف</b>. راجعه في Ads Manager وبعدها شغّله من هنا.</div><div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="tk-btn primary" data-act="enable">▶️ شغّل الكامبين</button>${isDemo() ? '' : '<a class="tk-btn" target="_blank" rel="noopener noreferrer" href="https://ads.tiktok.com/i18n/perf">افتح Ads Manager ↗</a>'}</div>` : ''}
      ${d.status === 'ENABLED' ? `<div class="tk-msg ok">▶️ الكامبين شغّال (بيبدأ بعد مراجعة تيك توك).</div><div><button class="tk-btn" data-act="pause">⏸ إيقاف</button></div>` : ''}`;
  }
  function watchLaunch() {
    stop(); const d = S.d; if (!d) return;
    if (!(d.status === 'LAUNCHING' || d.running || S.launching)) return;
    pollTimer = setInterval(async () => {
      if (S.view !== 'wizard' || S.step !== 6 || !root.isConnected) return stop();
      try { const nd = await api.get(`${B}/drafts/${S.d.id}`); S.d = nd; if (nd.status !== 'LAUNCHING' && !nd.running) { S.launching = false; stop(); } const b = root.querySelector('#tkBody'); if (b) { b.innerHTML = step6(); wireIn(b); } } catch { /* next tick */ }
    }, 2500);
  }

  // ---------------------------------------------------------------- events
  const rerenderBody = () => { const b = root.querySelector('#tkBody'); if (b) { b.innerHTML = [null, step1, step2, step3, step4, step5, step6][S.step](); wireIn(b); paintErrors(); } };
  function wire() { wireIn(root); }
  function wireIn(scope) {
    scope.querySelectorAll('[data-act]').forEach((el) => { el.onclick = (ev) => { ev.stopPropagation(); act(el); }; });
    scope.querySelectorAll('[data-f]').forEach((el) => {
      const key = el.dataset.f; if (['adv', 'tok', 'vbulk', 'agree'].includes(key)) return;
      const read = () => (el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value);
      const apply = () => {
        if (key === 'identityId') return set({ identity: { mode: 'EXISTING', id: el.value } });
        set({ [key]: read() });
        if (key === 'adText') { const c = root.querySelector('[data-count]'); if (c) { c.textContent = `${el.value.length}/100`; c.classList.toggle('over', el.value.length > 100); } }
        if (key === 'displayName') set({ identity: { mode: 'NEW', id: '' } });
        if (['pixelId'].includes(key)) return;
      };
      el.oninput = apply; el.onchange = () => { apply(); if (['event', 'budgetLevel', 'cta', 'adsPerVideo'].includes(key)) rerenderBody(); };
    });
    scope.querySelectorAll('[data-vurl]').forEach((el) => { el.oninput = () => { const v = cfg().videos.map((x) => ({ ...x })); v[Number(el.dataset.vurl)].url = el.value.trim(); set({ videos: v }); }; });
    scope.querySelectorAll('[data-vname]').forEach((el) => { el.oninput = () => { const v = cfg().videos.map((x) => ({ ...x })); v[Number(el.dataset.vname)].name = el.value; set({ videos: v }); }; });
  }

  async function act(el) {
    const a = el.dataset.act; const id = el.dataset.id;
    try {
      if (a === 'connect') { S.view = 'connect'; S.msg = null; return render(); }
      if (a === 'home') { await flush(); S.view = 'home'; S.msg = null; S.d = null; S.val = null; await loadDrafts(); return render(); }
      if (a === 'saveConn') {
        const adv = root.querySelector('[data-f="adv"]').value.trim(); const tok = root.querySelector('[data-f="tok"]').value.trim();
        const r = await api.post(`${B}/connect`, { token: tok, advertiserId: adv }); S.status = r.status; await loadAccount();
        if (r.error) { S.msg = { text: `اتحفظ بس تيك توك مارضيتش: ${r.error.title} — ${r.error.action}`, bad: true }; return render(); }
        S.msg = { text: `✅ اتربط: ${r.account?.name || 'الحساب'} (${r.account?.currency || ''})` }; S.view = 'home'; await loadDrafts(); return render();
      }
      if (a === 'copyRedirect') { const v = root.querySelector('#tkRedirect').value; try { await navigator.clipboard.writeText(v); toast('اتنسخ الرابط.', 'success'); } catch { root.querySelector('#tkRedirect').select(); toast('اضغط Ctrl+C لنسخ الرابط.'); } return; }
      if (a === 'saveApp') { const appId = root.querySelector('[data-f="appId"]').value.trim(); const secret = root.querySelector('[data-f="appSecret"]').value.trim(); await api.put(`${B}/oauth/app`, { appId, secret }); await loadOauth(); S.msg = { text: '✅ اتحفظت بيانات التطبيق (الـ Secret مشفّر).' }; return render(); }
      if (a === 'clearApp') { if (!(await UI.confirmModal({ title: 'مسح بيانات التطبيق', message: 'هيتمسح App ID والـ Secret من السيستم. الحسابات المربوطة هتفضل. متابعة؟', confirmLabel: 'امسح', danger: true }))) return; await api.delete(`${B}/oauth/app`); await loadOauth(); S.msg = null; return render(); }
      if (a === 'startOauth') { const r = await api.post(`${B}/oauth/start`, {}); window.location.href = r.url; return; }
      if (a === 'activate') { await api.post(`${B}/oauth/accounts/${id}/activate`, {}); S.status = await api.get(`${B}/status`); await loadOauth(); await loadAccount(); S.msg = { text: 'اتغيّر الحساب النشط.' }; return render(); }
      if (a === 'disconnectAcct') { if (!(await UI.confirmModal({ title: 'فصل الحساب', message: 'هيتمسح التوكن بتاع الحساب ده من السيستم. الكامبينات اللي على تيك توك مش هتتأثر. متابعة؟', confirmLabel: 'فصل', danger: true }))) return; await api.delete(`${B}/oauth/accounts/${id}`); S.status = await api.get(`${B}/status`); await loadOauth(); await loadAccount(); return render(); }
      if (a === 'checkAcct') { const box = root.querySelector(`[data-check="${id}"]`); if (box) box.innerHTML = '<span class="tk-spin"></span>'; const r = await api.get(`${B}/oauth/accounts/${id}/check`); if (box) box.innerHTML = `<div class="tk-list">${r.checks.map((c) => `<div class="tk-li ${c.status === 'OK' ? 'ok' : c.status === 'FAIL' ? 'bad' : c.status === 'WARN' ? 'warn' : ''}">${esc(c.name)}: ${esc(c.text)}</div>`).join('')}</div>`; return; }
      if (a === 'toggleWrites') { const on = !(S.oauth?.writesUnlocked); if (on && !(await UI.confirmModal({ title: 'فتح الرفع الحقيقي', message: 'بعد الفتح أي كامبين تضغط «ارفع» عليه هيتعمل فعلًا على حساب تيك توك الحقيقي (موقوف، بس بيتسجّل عندهم). متأكد؟', confirmLabel: 'افتح', danger: true }))) return; await api.put(`${B}/oauth/writes`, { on, confirm: true }); await loadOauth(); S.status = await api.get(`${B}/status`); return render(); }
      if (a === 'clearConn') { if (!(await UI.confirmModal({ title: 'فصل الربط', message: 'هيتمسح التوكن من السيستم. الكامبينات اللي اتعملت على تيك توك مش هتتأثر. متابعة؟', confirmLabel: 'فصل', danger: true }))) return; S.status = await api.delete(`${B}/connect`); S.account = null; S.msg = null; S.view = 'connect'; return render(); }
      if (a === 'toggleDemo') { S.status = await api.post(`${B}/connect/mock`, { on: !isDemo() }); await loadAccount(); await loadDrafts(); S.msg = { text: isDemo() ? '🧪 الوضع التجريبي شغّال — كل حاجة وهمية.' : 'اتقفل الوضع التجريبي.' }; S.view = S.status.mode === 'NONE' ? 'connect' : 'home'; return render(); }
      if (a === 'newPreset') { S.d = await api.post(`${B}/drafts`, { preset: id || undefined }); S.visited = new Set(); S.step = 1; S.val = null; S.msg = null; S.view = 'wizard'; S.interests = null; scheduleVal(); return render(); }
      if (a === 'open') { S.d = await api.get(`${B}/drafts/${id}`); S.visited = new Set(); S.step = S.d.progress?.campaignId || S.d.status === 'FAILED' ? 6 : 1; S.val = null; S.msg = null; S.view = 'wizard'; scheduleVal(); return render(); }
      if (a === 'dup') { await api.post(`${B}/drafts/${id}/duplicate`, {}); await loadDrafts(); S.msg = { text: 'اتعملت نسخة جديدة.' }; return render(); }
      if (a === 'del') { if (!(await UI.confirmModal({ title: 'حذف المسودة', message: 'هتتمسح المسودة دي (مفيش حاجة اتعملت على تيك توك). متابعة؟', confirmLabel: 'احذف', danger: true }))) return; await api.delete(`${B}/drafts/${id}`); await loadDrafts(); return render(); }
      if (a === 'go') { const n = Number(el.dataset.n); if (n < 1 || n > 6) return; await flush(); S.visited.add(S.step); S.step = n; S.msg = null; return render(); }
      if (a === 'preset') { const p = S.opts.presets.find((x) => x.id === id); set({ ...p.config }, { rerender: true }); toast(`اتطبّق قالب «${p.label}»`); return; }
      if (a === 'objective') { const o = S.opts.objectives.find((x) => x.id === id); if (o.unsupported) { toast('الهدف ده محتاج إعداد إضافي — مش مدعوم هنا لسه.', 'error'); return; } set({ objective: id }, { rerender: true }); return; }
      if (a === 'pill') { const key = el.dataset.key; const multi = el.dataset.multi === '1'; if (!multi) return set({ [key]: id }, { rerender: true }); const cur = new Set(cfg()[key] || []); if (cur.has(id)) cur.delete(id); else cur.add(id); return set({ [key]: [...cur] }, { rerender: true }); }
      if (a === 'radio') return set({ [el.dataset.key]: id }, { rerender: true });
      if (a === 'idmode') { if (id === 'NEW') set({ identity: { mode: 'NEW', id: '' } }, { rerender: true }); else set({ identity: { mode: 'EXISTING', id: cfg().identity?.id || '' } }, { rerender: true }); return; }
      if (a === 'addVideos') { const ta = root.querySelector('[data-f="vbulk"]'); const urls = ta.value.split(/\s+/).map((u) => u.trim()).filter(Boolean); if (!urls.length) return; const cur = (cfg().videos || []).map((x) => ({ ...x })); for (const u of urls) if (!cur.some((x) => x.url === u)) cur.push({ url: u, name: '' }); return set({ videos: cur }, { rerender: true }); }
      if (a === 'rmVideo') { const v = (cfg().videos || []).filter((_, i) => i !== Number(el.dataset.i)); return set({ videos: v }, { rerender: true }); }
      if (a === 'loadInterests') { try { S.interests = (await api.get(`${B}/interests`)).interests; } catch (e) { S.interests = []; toast(e.message, 'error'); } return rerenderBody(); }
      if (a === 'launch' || a === 'resume') {
        const enable = el.dataset.enable === '1';
        const label = enable ? 'هيترفع الكامبين على تيك توك وهيتشغّل على طول (الصرف بيبدأ بعد مراجعة تيك توك).' : 'هيترفع الكامبين على تيك توك موقوف (مفيش صرف).';
        if (a === 'launch' && !(await UI.confirmModal({ title: 'تأكيد الرفع على تيك توك', message: `${isDemo() ? '(تجريبي — مفيش حاجة هتروح لتيك توك)\n' : ''}${S.d.config.name}\n${label}\nميزانية ${S.d.config.dailyBudget} ${currency()}/يوم. متابعة؟`, confirmLabel: enable ? 'ارفع وشغّل' : 'ارفع موقوف', danger: enable }))) return;
        await flush(); S.launching = true; S.msg = null; await api.post(`${B}/drafts/${S.d.id}/launch`, { confirm: true, enable }); S.d = await api.get(`${B}/drafts/${S.d.id}`); S.step = 6; return render();
      }
      if (a === 'enable') { if (!(await UI.confirmModal({ title: 'تشغيل الكامبين', message: `${S.d.config.name}\nهيتشغّل على تيك توك وبيبدأ الصرف بعد المراجعة (ميزانية ${S.d.config.dailyBudget} ${currency()}/يوم). متابعة؟`, confirmLabel: 'شغّل', danger: true }))) return; S.d = { ...S.d, ...(await api.post(`${B}/drafts/${S.d.id}/enable`, { confirm: true })) }; S.d = await api.get(`${B}/drafts/${S.d.id}`); return render(); }
      if (a === 'pause') { await api.post(`${B}/drafts/${S.d.id}/pause`, {}); S.d = await api.get(`${B}/drafts/${S.d.id}`); return render(); }
    } catch (e) { S.launching = false; S.msg = { text: e.message, bad: true }; if (S.view === 'wizard' && S.d) { try { S.d = await api.get(`${B}/drafts/${S.d.id}`); } catch { /* keep */ } } render(); }
  }
  await boot();
}
