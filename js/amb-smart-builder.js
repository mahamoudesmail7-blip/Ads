// Smart Campaign step 8 — the campaign builder. One screen (account → ad → shape → budget → audience → files → upload) that builds the SAME config the launch wizard builds and
// hands it to the SAME launch engine (validated config, mandatory landing-page proof, every campaign created PAUSED, publish only after an explicit confirmation).
// The journey supplies the product, the captions, the images / AI videos and the researched audience as the starting point; every value stays editable.
import { api } from './api-client.js';
import * as UI from './ui-common.js';

const B = '/api/amb-media/pages';
const L = '/api/ai-media-buyer/launch';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const minor = (egp) => Math.round(Number(egp) * 100);
const nfmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const KEEP = new Map(); // projectId -> form, so leaving the step and coming back loses nothing

/** Pure: the exact body the launch engine's draft endpoint takes (same shape as the wizard's buildDraftPayload). Returns { error } when something required is missing. */
export function buildLaunchPayload(f, ctx) {
  const miss = (m) => ({ error: m });
  if (!ctx?.productId) return miss('المنتج مش في كتالوج السيستم.');
  if (!f.adAccountId) return miss('اختار الحساب الإعلاني.');
  if (!f.pageId) return miss('اختار الصفحة.');
  if (!f.pixelId) return miss('اختار البيكسل.');
  if (!/^https?:\/\//i.test(f.websiteUrl || '')) return miss('اكتب لينك صفحة المنتج (https://…).');
  if (!String(f.primaryText || '').trim()) return miss('اكتب أو اختار نص الإعلان (الكابشن).');
  if (!(Number(f.budget) > 0)) return miss('اكتب الميزانية اليومية.');
  const n = Math.min(10, Math.max(1, Number(f.campaignCount) || 1)), sets = Math.max(1, Number(f.adSets) || 1), ads = Math.max(1, Number(f.adsPerSet) || 1);
  const cbo = f.budgetMode === 'CBO';
  return {
    payload: {
      jobId: f.jobId, productId: ctx.productId, storeId: ctx.storeId || undefined,
      adAccountId: f.adAccountId, adAccountName: f.adAccountName, pageId: f.pageId, pageName: f.pageName,
      instagramId: f.instagramId || null, instagramUsername: f.instagramUsername || null, instagramKind: f.instagramId ? 'LINKED' : null,
      objective: 'OUTCOME_SALES', budgetMode: f.budgetMode, pixelId: f.pixelId, pixelName: f.pixelName, conversionEvent: 'PURCHASE', perCampaignPixel: false,
      platforms: f.instagramId ? ['facebook', 'instagram'] : ['facebook'],
      adSetsPerCampaign: sets, adsPerAdSet: ads, campaignCount: n,
      startMode: 'NOW', launchMode: 'PAUSED_REVIEW', timezone: f.timezone || 'Africa/Cairo',
      bidding: { mode: 'AUTOMATIC' },
      targeting: f.targetingMode === 'CUSTOM' ? { mode: 'CUSTOM', genders: f.gender, ageMin: Number(f.ageMin), ageMax: Number(f.ageMax), geoRegions: [], placementsMode: 'AUTOMATIC' } : { mode: 'BROAD' },
      cta: 'ORDER_NOW',
      budget: cbo ? { cbo: { dailyBudgetMinor: minor(f.budget) } } : { abo: { adSets: Array.from({ length: sets }, () => ({ dailyBudgetMinor: minor(f.budget) })) } },
      campaigns: Array.from({ length: n }, (_, i) => ({ name: n > 1 ? `${f.name} · ${i + 1}` : f.name, primaryText: f.primaryText, headline: f.headline || null, websiteUrl: f.websiteUrl, pixelId: null })),
    },
    dailyTotal: (cbo ? Number(f.budget) : Number(f.budget) * sets) * n, shape: { campaigns: n, adSets: sets * n, ads: sets * ads * n },
  };
}

export async function mountSmartBuilder(el, { toast = () => {}, projectId, journey, project, onChange = async () => {} } = {}) {
  const f = KEEP.get(projectId) || { name: `${project.name} · Smart · ${new Date().toISOString().slice(5, 10)}`, budgetMode: 'ABO', budget: '', campaignCount: 1, adSets: 1, adsPerSet: 3, targetingMode: 'BROAD', gender: 'ALL', ageMin: 18, ageMax: 65, capIdx: 0, jobId: project.smart?.launch?.jobId || null };
  KEEP.set(projectId, f);
  const S = { ctx: null, accounts: [], assets: null, busy: {}, msg: {}, bar: {}, landing: null, queue: null, assetRes: null, jobStatus: null };
  const say = (k, text, bad = false) => { S.msg[k] = text ? { text, bad } : null; };
  const note = (k) => (S.msg[k] ? `<div class="pgp-msg ${S.msg[k].bad ? 'bad' : 'good'}">${esc(S.msg[k].text)}</div>` : '');
  const bar = (k) => (S.busy[k] ? `<div class="amt-prog"><i style="width:${S.bar[k]?.pct || 3}%"></i></div><small class="amt-dim">${esc(S.bar[k]?.message || 'شغال…')}</small>` : '');

  el.innerHTML = '<div class="amb-loading">جارِ تجهيز بيانات الكامبين…</div>';
  try { S.ctx = await api.get(`${B}/${projectId}/launch-context`); } catch (e) { el.innerHTML = `<div class="pgp-empty">تعذّر التحميل: ${esc(e.message)}</div>`; return; }
  if (!S.ctx.linked || !S.ctx.found) { el.innerHTML = `<div class="lp-card pgp-sec"><div class="pgp-msg bad">⛔ ${esc(S.ctx.reason || 'المنتج مش جاهز للكامبين.')}</div><div class="pgp-actions"><button class="amb-btn" data-b-step="1">روح للخطوة 1</button></div></div>`; el.querySelector('[data-b-step]').onclick = () => document.querySelector('[data-sc-step="1"]')?.click(); return; }
  try { const r = await api.get(`${L}/discovery/ad-accounts`); S.accounts = (r.accounts || []).filter((a) => a.accountStatus === 1 || a.accountStatus == null); if (!f.adAccountId && r.selectedAdAccountId && S.accounts.some((a) => a.id === r.selectedAdAccountId)) f.adAccountId = r.selectedAdAccountId; }
  catch (e) { S.accountsError = e.message; }
  if (!f.websiteUrl) f.websiteUrl = S.ctx.landingGuess || '';
  if (f.targetingMode === 'BROAD' && journey.suggestedTargeting && f.gender === 'ALL' && f.ageMin === 18 && f.ageMax === 65 && !f._seeded) { f.gender = journey.suggestedTargeting.genders || 'ALL'; f.ageMin = journey.suggestedTargeting.ageMin; f.ageMax = journey.suggestedTargeting.ageMax; f._seeded = true; }
  const caps = project.copy?.captions || [];
  const pickCaption = (i) => { f.capIdx = i; f.primaryText = caps[i]?.primary || ''; f.headline = caps[i]?.headline || ''; };
  if (f.primaryText === undefined && caps.length) pickCaption(0);
  const loadAssets = async () => { S.assets = null; if (!f.adAccountId) return; try { S.assets = await api.get(`${L}/discovery/account-assets?adAccountId=${encodeURIComponent(f.adAccountId)}`); const a = S.assets; f.timezone = a.account?.timezoneName || f.timezone; f.adAccountName = a.account?.name || f.adAccountName; if (!a.pages.some((x) => x.id === f.pageId)) { f.pageId = a.pages[0]?.id || ''; f.pageName = a.pages[0]?.name || ''; } if (f.instagramId && !a.instagram.some((x) => x.id === f.instagramId)) f.instagramId = ''; if (!a.pixels.some((x) => x.id === f.pixelId)) { f.pixelId = a.pixels[0]?.id || ''; f.pixelName = a.pixels[0]?.name || ''; } } catch (e) { say('assets', e.message, true); } };
  if (f.adAccountId) await loadAssets();
  await refreshJob();

  // an earlier job is reused only while it is still a draft on the SAME ad account; a launched / failed one (or another account) starts a fresh job
  async function refreshJob() { if (!f.jobId) return; try { const j = await api.get(`${L}/jobs/${f.jobId}`); S.jobStatus = j?.status || null; if (j && ((f.adAccountId && j.ad_account_id && j.ad_account_id !== f.adAccountId) || !['DRAFT', 'READY', 'VALIDATING'].includes(j.status))) { f.jobId = null; S.jobStatus = null; } else if (j) S.jobStarted = true; } catch { S.jobStatus = null; f.jobId = null; } }

  function draw() {
    const imgs = (project.images || []).filter((i) => i.status === 'READY').length, vids = (project.videos || []).filter((v) => v.kind === 'AI').length;
    const built = buildLaunchPayload(f, S.ctx); const shape = built.shape || { campaigns: f.campaignCount, adSets: f.adSets * f.campaignCount, ads: f.adSets * f.adsPerSet * f.campaignCount };
    const a = S.assets; const ready = journey.readiness.ready;
    const sel = (cls, opts, cur, attr) => `<select ${attr}>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    el.innerHTML = `
      ${ready ? '' : `<div class="pgp-msg bad">⛔ الرحلة مش جاهزة: ${esc(journey.readiness.blockers.join(' · '))} — <a href="#" data-b-step="7">افتح المراجعة</a></div>`}
      <div class="lp-card pgp-sec"><b>① الحساب والصفحة والبيكسل</b>${S.accountsError ? `<div class="pgp-msg bad">${esc(S.accountsError)}</div>` : ''}
        <div class="pgp-row"><label class="pgp-f"><span>الحساب الإعلاني</span>${sel('', [['', 'اختار…'], ...S.accounts.map((x) => [x.id, `${x.name} (${x.currency || ''})`])], f.adAccountId, 'data-b="adAccountId"')}</label>
        <label class="pgp-f"><span>الصفحة</span>${sel('', [['', a ? 'اختار…' : 'اختار الحساب الأول'], ...(a?.pages || []).map((x) => [x.id, x.name])], f.pageId, 'data-b="pageId"')}</label></div>
        <div class="pgp-row"><label class="pgp-f"><span>انستجرام (اختياري)</span>${sel('', [['', 'من غير انستجرام'], ...(a?.instagram || []).map((x) => [x.id, '@' + x.username])], f.instagramId || '', 'data-b="instagramId"')}</label>
        <label class="pgp-f"><span>البيكسل</span>${sel('', [['', a ? 'اختار…' : 'اختار الحساب الأول'], ...(a?.pixels || []).map((x) => [x.id, x.name])], f.pixelId, 'data-b="pixelId"')}</label></div>${note('assets')}
      </div>
      <div class="lp-card pgp-sec"><b>② الإعلان</b>
        <label class="pgp-f"><span>اسم الكامبين</span><input data-b="name" value="${esc(f.name)}"></label>
        <label class="pgp-f"><span>لينك صفحة المنتج</span><input data-b="websiteUrl" dir="ltr" value="${esc(f.websiteUrl)}" placeholder="https://متجرك/products/…"></label>
        <div class="pgp-actions"><button class="amb-btn sm" data-b-landing ${S.busy.landing ? 'disabled' : ''}>🔍 افحص إن الصفحة بتاعة المنتج ده</button></div>
        ${S.landing ? `<div class="pgp-msg ${S.landing.ok ? 'good' : 'bad'}">${S.landing.ok ? '✅ اللينك بتاع المنتج ده.' : '⛔ اللينك مش متطابق مع المنتج: ' + esc((S.landing.errors || []).map((x) => x.message || x).join(' · ') || 'مش متأكدين من الصفحة')}</div>` : ''}${note('landing')}
        ${caps.length ? `<label class="pgp-f"><span>الكابشن</span>${sel('', caps.map((c, i) => [i, `كابشن ${i + 1}: ${c.headline || c.primary.slice(0, 30)}`]), f.capIdx, 'data-b="capIdx"')}</label>` : '<div class="pgp-msg bad">مفيش كابشنات — اكتبها في الخطوة 4.</div>'}
        <label class="pgp-f"><span>نص الإعلان</span><textarea rows="4" data-b="primaryText">${esc(f.primaryText || '')}</textarea></label>
        <label class="pgp-f"><span>العنوان</span><input data-b="headline" value="${esc(f.headline || '')}"></label>
      </div>
      <div class="lp-card pgp-sec"><b>③ شكل الكامبين والميزانية</b>
        <div class="pgp-row"><label class="pgp-f"><span>عدد الكامبينات</span><input type="number" min="1" max="3" data-b="campaignCount" value="${f.campaignCount}"></label>
        <label class="pgp-f"><span>مجموعات إعلانية في كل كامبين</span><input type="number" min="1" max="5" data-b="adSets" value="${f.adSets}"></label>
        <label class="pgp-f"><span>إعلانات في كل مجموعة</span><input type="number" min="1" max="5" data-b="adsPerSet" value="${f.adsPerSet}"></label></div>
        <div class="sc-eq">${shape.campaigns} كامبين × ${f.adSets} مجموعة × ${f.adsPerSet} إعلان = <b>${shape.ads}</b> إعلان — الملفات الجاهزة: ${imgs} صورة + ${vids} فيديو ${shape.ads > imgs + vids ? '(بعضها هيتكرر)' : ''}</div>
        <div class="sc-radio"><label><input type="radio" name="bm" data-b="budgetMode" value="ABO" ${f.budgetMode === 'ABO' ? 'checked' : ''}> ABO — ميزانية لكل مجموعة <small>(أحسن للتجربة)</small></label><label><input type="radio" name="bm" data-b="budgetMode" value="CBO" ${f.budgetMode === 'CBO' ? 'checked' : ''}> CBO — ميزانية للكامبين كله <small>(أحسن بعد ما تلاقي الكسبان)</small></label></div>
        <div class="pgp-row"><label class="pgp-f"><span>الميزانية اليومية (${f.budgetMode === 'CBO' ? 'للكامبين' : 'لكل مجموعة'}) ج</span><input type="number" min="1" inputmode="decimal" data-b="budget" value="${esc(f.budget)}"></label>
        <div class="sc-total">${built.dailyTotal ? `الإجمالي اليومي: <b>${nfmt(built.dailyTotal)} ج</b>` : ''}</div></div>
      </div>
      <div class="lp-card pgp-sec"><b>④ الاستهداف</b>
        <div class="sc-radio"><label><input type="radio" name="tm" data-b="targetingMode" value="BROAD" ${f.targetingMode === 'BROAD' ? 'checked' : ''}> مفتوح (Broad) <small>ميتا تلاقي المشترين لوحدها</small></label><label><input type="radio" name="tm" data-b="targetingMode" value="CUSTOM" ${f.targetingMode === 'CUSTOM' ? 'checked' : ''}> مخصص (من البحث) <small>النوع والسن</small></label></div>
        ${f.targetingMode === 'CUSTOM' ? `<div class="pgp-row"><label class="pgp-f"><span>النوع</span>${sel('', [['ALL', 'الكل'], ['FEMALE', 'ستات'], ['MALE', 'رجالة']], f.gender, 'data-b="gender"')}</label><label class="pgp-f"><span>من سن</span><input type="number" min="18" max="65" data-b="ageMin" value="${f.ageMin}"></label><label class="pgp-f"><span>لحد سن</span><input type="number" min="18" max="65" data-b="ageMax" value="${f.ageMax}"></label></div>` : ''}
        ${journey.research ? `<small class="amt-dim">من البحث: ${esc(journey.research.audience.description)} — ${esc((journey.research.audience.interests || []).join('، '))}. الدولة مصر، والأماكن تلقائية.</small>` : '<small class="amt-dim">لسه مفيش بحث — ممكن تعمله في الخطوة 2. الدولة مصر، والأماكن تلقائية.</small>'}
      </div>
      <div class="lp-card pgp-sec"><b>⑤ الملفات (صور وفيديوهات الرحلة)</b>
        <small class="amt-dim">بترفع الصور الجاهزة وفيديوهات الـ AI على الحساب الإعلاني، وبتتوزع على الإعلانات. اللي اترفع قبل كده مبيترفعش تاني.</small>
        <div class="pgp-actions"><button class="amb-btn" data-b-assets ${S.busy.assets2 || !f.adAccountId ? 'disabled' : ''}>📤 جهّز الملفات على الحساب</button></div>${bar('assets2')}${note('assets2')}
        ${S.assetRes ? `<div class="pgp-msg good">اتسجّل ${S.assetRes.images.length} صورة و${S.assetRes.videos.length} فيديو${S.assetRes.failed.length ? ` — فشل ${S.assetRes.failed.length}: ${esc(S.assetRes.failed[0].error)}` : ''}.</div>` : ''}
      </div>
      <div class="lp-card pgp-sec sc-final"><b>⑥ الرفع على ميتا</b>
        <div class="pgp-msg good">🔒 الكامبين بيترفع <b>متوقف (PAUSED)</b> — مفيش صرف لحد ما تشغّله بنفسك من ميتا.</div>
        ${f.jobId ? `<small class="amt-dim">طلب الرفع: ${esc(f.jobId.slice(0, 8))}… — الحالة: <b>${esc(S.jobStatus || 'مسودة')}</b></small>` : ''}
        <div class="pgp-actions"><button class="amb-btn" data-b-draft ${S.busy.draft ? 'disabled' : ''}>💾 حفظ كمسودة</button><button class="amb-btn danger" data-b-publish ${S.busy.publish || !ready ? 'disabled' : ''}>🚀 ارفع الكامبين على ميتا (متوقف)</button></div>${note('draft')}${bar('publish')}${note('publish')}
        ${S.queue ? queueHtml(S.queue) : ''}
      </div>`;
    wire();
  }

  function queueHtml(q) {
    return `<div class="sc-queue">${(q.campaigns || []).map((c) => `<div class="sc-q"><b>${esc(c.name || 'كامبين')}</b><span>${esc(c.status)}</span><small>${c.adSetsCreated ?? 0} مجموعة · ${c.adsCreated ?? 0} إعلان</small>${c.error ? `<em>${esc(String(c.error).slice(0, 160))}</em>` : ''}</div>`).join('')}</div>`;
  }

  async function ensureJob() {
    if (f.jobId && S.jobStarted) return f.jobId;
    if (!f.jobId) f.jobId = crypto.randomUUID();
    if (!S.jobStarted) { await api.post(`${L}/jobs/${f.jobId}/start`, { adAccountId: f.adAccountId, adAccountName: f.adAccountName, productId: S.ctx.productId }); S.jobStarted = true; await api.post(`${B}/${projectId}/launch-link`, { jobId: f.jobId, status: 'DRAFT' }).catch(() => {}); }
    return f.jobId;
  }
  async function pollMedia(id, key) {
    for (let i = 0; i < 900; i++) { const j = await api.get(`/api/amb-media/jobs/${id}`); S.bar[key] = { pct: j.progress, message: j.message }; const b = el.querySelector('.amt-prog i'); if (b) b.style.width = `${j.progress}%`; if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(j.status)) return j; await new Promise((r) => setTimeout(r, 2000)); }
    throw new Error('الشغل أخد وقت أطول من المتوقع.');
  }
  async function saveDraft() {
    await ensureJob();
    const built = buildLaunchPayload(f, S.ctx); if (built.error) throw new Error(built.error);
    const job = await api.post(`${L}/jobs`, built.payload);
    S.jobStatus = job?.status || 'DRAFT'; await api.post(`${B}/${projectId}/launch-link`, { jobId: f.jobId, status: S.jobStatus }).catch(() => {});
    return { job, built };
  }

  function wire() {
    el.querySelectorAll('[data-b-step]').forEach((b) => { b.onclick = (e) => { e.preventDefault(); document.querySelector(`[data-sc-step="${b.dataset.bStep}"]`)?.click(); }; });
    el.querySelectorAll('[data-b]').forEach((inp) => {
      const k = inp.dataset.b;
      const apply = async () => {
        let v = inp.type === 'radio' ? (inp.checked ? inp.value : undefined) : inp.value; if (v === undefined) return;
        if (['campaignCount', 'adSets', 'adsPerSet', 'ageMin', 'ageMax'].includes(k)) v = Number(v) || 1;
        if (k === 'capIdx') { pickCaption(Number(v)); draw(); return; }
        f[k] = v;
        if (k === 'adAccountId') { f.pageId = ''; f.pixelId = ''; f.instagramId = ''; f.jobId = null; S.jobStarted = false; S.assetRes = null; await loadAssets(); draw(); return; }
        if (k === 'pageId') f.pageName = (S.assets?.pages || []).find((x) => x.id === v)?.name || '';
        if (k === 'pixelId') f.pixelName = (S.assets?.pixels || []).find((x) => x.id === v)?.name || '';
        if (k === 'instagramId') f.instagramUsername = (S.assets?.instagram || []).find((x) => x.id === v)?.username || '';
        if (['budgetMode', 'targetingMode', 'campaignCount', 'adSets', 'adsPerSet', 'budget'].includes(k)) { const pos = inp.selectionStart; draw(); const again = el.querySelector(`[data-b="${k}"]:not([type=radio])`); if (again && inp.type !== 'radio') { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* number input */ } } }
      };
      inp.addEventListener(inp.tagName === 'SELECT' || inp.type === 'radio' ? 'change' : 'input', apply);
    });
    const lb = el.querySelector('[data-b-landing]');
    if (lb) lb.onclick = async () => {
      S.busy.landing = true; S.landing = null; say('landing', null); draw();
      try { S.landing = await api.post(`${L}/validate-landing`, { productId: S.ctx.productId, campaigns: [{ name: f.name, websiteUrl: f.websiteUrl }] }); } catch (e) { say('landing', e.message, true); }
      S.busy.landing = false; draw();
    };
    const ab = el.querySelector('[data-b-assets]');
    if (ab) ab.onclick = async () => {
      S.busy.assets2 = true; S.bar.assets2 = { pct: 3, message: 'بجهّز الملفات…' }; say('assets2', null); S.assetRes = null; draw();
      try {
        const jid = await ensureJob();
        const started = await api.post(`${B}/${projectId}/launch-assets`, { launchJobId: jid });
        const done = await pollMedia(started.id, 'assets2');
        if (done.status === 'FAILED') say('assets2', done.error?.message || 'فشل.', true); else S.assetRes = done.result;
      } catch (e) { say('assets2', e.message, true); }
      S.busy.assets2 = false; draw();
    };
    const db = el.querySelector('[data-b-draft]');
    if (db) db.onclick = async () => {
      S.busy.draft = true; say('draft', null); draw();
      try { await saveDraft(); say('draft', '✅ اتحفظت المسودة.'); toast('اتحفظت المسودة.', 'success'); await onChange(); } catch (e) { say('draft', e.message, true); }
      S.busy.draft = false; draw();
    };
    const pb = el.querySelector('[data-b-publish]');
    if (pb) pb.onclick = async () => {
      say('publish', null); S.busy.publish = true; draw();
      try {
        const { built } = await saveDraft();
        const ok = await UI.confirmModal({ title: 'تأكيد رفع الكامبين على ميتا', message: `هيتم إنشاء ${built.shape.campaigns} كامبين، ${built.shape.adSets} Ad Set، ${built.shape.ads} إعلان — كلها متوقفة (PAUSED) على الحساب الإعلاني (${f.adAccountName || f.adAccountId}).\nالميزانية اليومية المُهيّأة: ${nfmt(built.dailyTotal)} ج.\nمش هتصرف ولا جنيه لحد ما تفعّلها إنت من ميتا. متابعة؟`, confirmLabel: 'ارفع الكامبين', danger: true });
        if (!ok) { S.busy.publish = false; say('publish', 'اتلغى — المسودة محفوظة.'); draw(); return; }
        await api.post(`${L}/jobs/${f.jobId}/publish`, {});
        await api.post(`${B}/${projectId}/launch-link`, { jobId: f.jobId, status: 'PUBLISHING' }).catch(() => {});
        S.bar.publish = { pct: 5, message: 'بيترفع على ميتا…' };
        for (let i = 0; i < 360; i++) { // watch the queue (the server keeps going even if this tab is closed)
          await new Promise((r) => setTimeout(r, 5000)); if (!document.body.contains(el)) return;
          S.queue = await api.get(`${L}/jobs/${f.jobId}/queue-status`).catch(() => S.queue);
          const st = S.queue?.jobStatus; S.jobStatus = st || S.jobStatus;
          const camps = S.queue?.campaigns || []; const doneN = camps.filter((c) => c.status === 'COMPLETE').length;
          S.bar.publish = { pct: camps.length ? Math.round((doneN / camps.length) * 100) : 5, message: `${doneN} من ${camps.length || '…'} كامبين خلصوا` }; draw();
          if (['COMPLETE', 'FAILED', 'PARTIAL', 'CANCELLED'].includes(st)) break;
        }
        await api.post(`${B}/${projectId}/launch-link`, { jobId: f.jobId, status: S.jobStatus || 'PUBLISHING' }).catch(() => {});
        say('publish', S.jobStatus === 'COMPLETE' ? '✅ الكامبين اترفع على ميتا متوقف — شغّله من Ads Manager لما تكون جاهز.' : `حالة الرفع: ${S.jobStatus}`, S.jobStatus === 'FAILED'); await onChange();
      } catch (e) { say('publish', e.message, true); }
      S.busy.publish = false; draw();
    };
  }
  draw();
}
