// Smart Campaign step 8 — «الكامبين». One page (الأساسيات → الإعلان → شكل الكامبين → الميزانية → الاستهداف → التشغيل) with a sticky bar. It builds the SAME config the launch wizard builds
// and hands it to the SAME launch engine: validated config, mandatory landing-page proof, and the owner's explicit confirmation before anything is created on Meta.
// By default the campaign is created PAUSED. «Start now» / «scheduled» are the owner's choice and are confirmed with the exact consequences.
import { api } from './api-client.js';
import * as UI from './ui-common.js';
import { B, esc } from './amb-smart-steps.js';

const L = '/api/ai-media-buyer/launch';
const minor = (egp) => Math.round(Number(egp) * 100);
const nfmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const CTA = [['ORDER_NOW', 'اطلب الآن'], ['SHOP_NOW', 'تسوق الآن'], ['BUY_NOW', 'اشتري الآن'], ['GET_OFFER', 'احصل على العرض'], ['LEARN_MORE', 'اعرف أكتر']];

/** Pure: the exact body the launch engine's draft endpoint takes (same shape as the wizard's own). Returns { error } when something required is missing. */
export function buildLaunchPayload(f, ctx) {
  const miss = (m) => ({ error: m });
  if (!ctx?.productId) return miss('المنتج مش في كتالوج السيستم.');
  if (!f.adAccountId) return miss('اختار الحساب الإعلاني.');
  if (!f.pageId) return miss('اختار الصفحة.');
  if (!f.pixelId) return miss('اختار البيكسل.');
  if (!/^https?:\/\//i.test(f.websiteUrl || '')) return miss('اكتب لينك صفحة المنتج (https://…).');
  if (!String(f.primaryText || '').trim()) return miss('اختار أو اكتب نص الإعلان (الكابشن).');
  if (!(Number(f.budget) > 0)) return miss('اكتب الميزانية اليومية.');
  if (f.runMode === 'SCHEDULED' && !(f.startDate && f.startTime)) return miss('حدد تاريخ وساعة البدء.');
  const n = Math.min(10, Math.max(1, Number(f.campaignCount) || 1)), sets = Math.max(1, Number(f.adSets) || 1), ads = Math.max(1, Number(f.adsPerSet) || 1);
  const cbo = f.budgetMode === 'CBO';
  const run = f.runMode === 'NOW' ? { startMode: 'NOW', launchMode: 'NOW' } : f.runMode === 'SCHEDULED' ? { startMode: 'SCHEDULED', launchMode: 'SCHEDULED', startDate: f.startDate, startTime: f.startTime } : { startMode: 'NOW', launchMode: 'PAUSED_REVIEW' };
  return {
    payload: {
      jobId: f.jobId, productId: ctx.productId, storeId: ctx.storeId || undefined,
      adAccountId: f.adAccountId, adAccountName: f.adAccountName, pageId: f.pageId, pageName: f.pageName,
      instagramId: f.instagramId || null, instagramUsername: f.instagramUsername || null, instagramKind: f.instagramId ? 'LINKED' : null,
      objective: 'OUTCOME_SALES', budgetMode: f.budgetMode, pixelId: f.pixelId, pixelName: f.pixelName, conversionEvent: 'PURCHASE', perCampaignPixel: false,
      platforms: f.instagramId ? ['facebook', 'instagram'] : ['facebook'],
      adSetsPerCampaign: sets, adsPerAdSet: ads, campaignCount: n, ...run, timezone: f.timezone || 'Africa/Cairo',
      bidding: { mode: 'AUTOMATIC' },
      targeting: f.targetingMode === 'CUSTOM' ? { mode: 'CUSTOM', genders: f.gender, ageMin: Number(f.ageMin), ageMax: Number(f.ageMax), geoRegions: [], placementsMode: 'AUTOMATIC' } : { mode: 'BROAD' },
      cta: f.cta || 'ORDER_NOW',
      budget: cbo ? { cbo: { dailyBudgetMinor: minor(f.budget) } } : { abo: { adSets: Array.from({ length: sets }, () => ({ dailyBudgetMinor: minor(f.budget) })) } },
      campaigns: Array.from({ length: n }, (_, i) => ({ name: n > 1 ? `${f.name} · ${i + 1}` : f.name, primaryText: f.primaryText, headline: f.headline || null, websiteUrl: f.websiteUrl, pixelId: null })),
    },
    dailyTotal: (cbo ? Number(f.budget) : Number(f.budget) * sets) * n, shape: { campaigns: n, adSets: sets * n, ads: sets * ads * n },
  };
}

export async function stepCampaign(el, C) {
  const p = C.p; const j = C.j;
  const S = C.bs || (C.bs = { loaded: false, busy: {}, msg: {}, bar: {}, queue: null, assetRes: null, landing: null, jobStatus: null });
  const say = (k, text, bad = false) => { S.msg[k] = text ? { text, bad } : null; };
  const note = (k) => (S.msg[k] ? `<div class="sx-msg ${S.msg[k].bad ? 'bad' : ''}">${esc(S.msg[k].text)}</div>` : '');
  const bar = (k) => (S.busy[k] ? `<div class="sx-job" style="padding:0"><div class="bar"><i style="width:${S.bar[k]?.pct || 3}%"></i></div><small>${esc(S.bar[k]?.message || 'شغال…')}</small></div>` : '');

  if (!S.loaded) {
    el.innerHTML = '<div class="sx-card"><div class="sx-empty"><div class="sx-spin"></div><p>بجهّز بيانات الكامبين…</p></div></div>';
    const caps = p.copy?.captions || []; const selIdx = Math.min(p.smart?.selectedCaption ?? 0, Math.max(0, caps.length - 1));
    S.f = { name: `${p.name} · ${new Date().toISOString().slice(0, 10)}`, budgetMode: 'ABO', budget: '', campaignCount: 1, adSets: 1, adsPerSet: 3, targetingMode: 'BROAD', gender: 'ALL', ageMin: 18, ageMax: 65, cta: 'ORDER_NOW', runMode: 'PAUSED', startDate: '', startTime: '00:00', capIdx: selIdx, primaryText: caps[selIdx]?.primary || '', headline: caps[selIdx]?.headline || '', jobId: p.smart?.launch?.jobId || null };
    try { S.ctx = await api.get(`${B}/${p.id}/launch-context`); } catch (e) { S.ctx = { linked: false, reason: e.message }; }
    if (S.ctx.linked && S.ctx.found) {
      S.f.websiteUrl = p.smart?.landingUrl || S.ctx.landingGuess || '';
      if (j.suggestedTargeting) { S.f.targetingMode = 'CUSTOM'; S.f.gender = j.suggestedTargeting.genders || 'ALL'; S.f.ageMin = j.suggestedTargeting.ageMin; S.f.ageMax = j.suggestedTargeting.ageMax; }
      try { const r = await api.get(`${L}/discovery/ad-accounts`); S.accounts = (r.accounts || []).filter((a) => a.accountStatus === 1 || a.accountStatus == null); if (r.selectedAdAccountId && S.accounts.some((a) => a.id === r.selectedAdAccountId)) S.f.adAccountId = r.selectedAdAccountId; } catch (e) { S.accountsError = e.message; S.accounts = []; }
      await loadAssets(); await refreshJob();
    }
    S.loaded = true;
  }
  const f = S.f;

  async function loadAssets() {
    const f = S.f; S.assets = null; if (!f.adAccountId) return;
    try { const a = await api.get(`${L}/discovery/account-assets?adAccountId=${encodeURIComponent(f.adAccountId)}`); S.assets = a; f.timezone = a.account?.timezoneName || f.timezone; f.adAccountName = a.account?.name || f.adAccountName; if (!a.pages.some((x) => x.id === f.pageId)) { f.pageId = a.pages[0]?.id || ''; f.pageName = a.pages[0]?.name || ''; } if (f.instagramId && !a.instagram.some((x) => x.id === f.instagramId)) f.instagramId = ''; if (!a.pixels.some((x) => x.id === f.pixelId)) { f.pixelId = a.pixels[0]?.id || ''; f.pixelName = a.pixels[0]?.name || ''; } } catch (e) { say('basics', e.message, true); }
  }
  // an earlier job is reused only while it is still a draft on the SAME ad account; a launched / failed one (or another account) starts a fresh job
  async function refreshJob() { const f = S.f; if (!f.jobId) return; try { const jb = await api.get(`${L}/jobs/${f.jobId}`); S.jobStatus = jb?.status || null; if (jb && ((f.adAccountId && jb.ad_account_id && jb.ad_account_id !== f.adAccountId) || !['DRAFT', 'READY', 'VALIDATING'].includes(jb.status))) { f.jobId = null; S.jobStatus = null; } else if (jb) S.jobStarted = true; } catch { S.jobStatus = null; f.jobId = null; } }

  if (!S.ctx.linked || !S.ctx.found) { el.innerHTML = `<div class="sx-sec"><h2>الكامبين</h2><p>الحساب والبيدج والبيكسل، توزيع الفيديوهات، والرفع على ميتا.</p></div><div class="sx-card"><div class="sx-cbody"><div class="sx-msg bad">⛔ ${esc(S.ctx.reason || 'المنتج مش جاهز للكامبين.')}</div><div><button class="sx-btn" data-go="1">روح لخطوة «المعلومات»</button></div></div></div>`; el.querySelector('[data-go]').onclick = () => C.go(1); return; }

  const imgs = (p.images || []).filter((i) => i.status === 'READY').length, vids = (p.videos || []).filter((v) => v.kind === 'AI').length;
  const built = buildLaunchPayload(f, S.ctx); const shape = built.shape || { campaigns: f.campaignCount, adSets: f.adSets * f.campaignCount, ads: f.adSets * f.adsPerSet * f.campaignCount };
  const a = S.assets; const caps = p.copy?.captions || []; const ready = j.readiness.ready;
  const sel = (opts, cur, attr) => `<select ${attr}>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const choice = (name, v, cur, title, small) => `<label class="sx-choice ${cur === v ? 'on' : ''}"><input type="radio" name="${name}" data-b="${name}" value="${v}" ${cur === v ? 'checked' : ''} hidden><span class="dot"></span><span><b>${title}</b><small>${small}</small></span></label>`;
  const missing = [];
  if (!ready) missing.push(...j.readiness.blockers);
  if (!f.adAccountId) missing.push('اختار الحساب الإعلاني'); else if (!f.pageId) missing.push('اختار الصفحة'); else if (!f.pixelId) missing.push('اختار البيكسل');
  if (!/^https?:\/\//i.test(f.websiteUrl || '')) missing.push('لينك صفحة المنتج');
  if (!(Number(f.budget) > 0)) missing.push('الميزانية اليومية');
  if (!String(f.primaryText || '').trim()) missing.push('نص الإعلان');
  const runLabel = { PAUSED: 'يترفع موقوف', NOW: 'يبدأ يصرف على طول', SCHEDULED: 'يبدأ في ميعاد' }[f.runMode];

  el.innerHTML = `<div class="sx-sec"><h2>الكامبين</h2><p>الحساب والبيدج والبيكسل، توزيع الفيديوهات والكابشنات، والرفع على ميتا.</p></div>
    ${missing.length ? `<div class="sx-miss"><b>قبل الكامبين ناقص:</b><ul>${missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
    <div class="sx-card"><div class="sx-chead"><b>الأساسيات</b></div><div class="sx-cbody">${S.accountsError ? `<div class="sx-msg bad">${esc(S.accountsError)}</div>` : ''}
      <div class="sx-row"><label class="sx-f"><span>الحساب الإعلاني</span>${sel([['', 'اختار…'], ...(S.accounts || []).map((x) => [x.id, `${x.name} (${x.currency || ''})`])], f.adAccountId, 'data-b="adAccountId"')}</label>
      <label class="sx-f"><span>البيدج</span>${sel([['', a ? 'اختار…' : 'اختار الحساب الأول'], ...(a?.pages || []).map((x) => [x.id, x.name])], f.pageId, 'data-b="pageId"')}</label>
      <label class="sx-f"><span>البيكسل</span>${sel([['', a ? 'اختار…' : 'اختار الحساب الأول'], ...(a?.pixels || []).map((x) => [x.id, x.name])], f.pixelId, 'data-b="pixelId"')}${a && !a.pixels.length ? '<small>الحساب ده مفيهوش بيكسل.</small>' : ''}</label></div>
      <div class="sx-row"><label class="sx-f"><span>انستجرام (اختياري)</span>${sel([['', 'من غير انستجرام'], ...(a?.instagram || []).map((x) => [x.id, '@' + x.username])], f.instagramId || '', 'data-b="instagramId"')}</label>
      <label class="sx-f"><span>زرار الإعلان (CTA)</span>${sel(CTA, f.cta, 'data-b="cta"')}</label>
      <label class="sx-f"><span>اسم الكامبين</span><input data-b="name" value="${esc(f.name)}"></label></div>${note('basics')}</div></div>
    <div class="sx-card"><div class="sx-chead"><b>الإعلان</b></div><div class="sx-cbody">
      <label class="sx-f"><span>لينك صفحة المنتج</span><input data-b="websiteUrl" dir="ltr" value="${esc(f.websiteUrl || '')}" placeholder="https://متجرك/products/…"></label>
      <div><button class="sx-btn sm" data-b-landing ${S.busy.landing ? 'disabled' : ''}>🔍 افحص إن الصفحة بتاعة المنتج ده</button></div>
      ${S.landing ? `<div class="sx-msg ${S.landing.ok ? '' : 'bad'}">${S.landing.ok ? '✅ اللينك بتاع المنتج ده.' : '⛔ اللينك مش متطابق مع المنتج: ' + esc((S.landing.errors || []).map((x) => x.message || x).join(' · ') || 'مش متأكدين من الصفحة')}</div>` : ''}${note('landing')}
      ${caps.length ? `<div class="sx-f"><span>الكابشن</span><div class="sx-list" style="gap:8px;">${caps.map((c, i) => `<label class="sx-choice ${f.capIdx === i ? 'on' : ''}"><input type="radio" name="cap" data-b="capIdx" value="${i}" ${f.capIdx === i ? 'checked' : ''} hidden><span class="dot"></span><span><b>${esc(c.headline || `كابشن ${i + 1}`)}</b><small>${esc(c.primary.slice(0, 90))}…</small></span></label>`).join('')}</div></div>` : '<div class="sx-msg bad">مفيش كابشنات — اكتبها في خطوة «الكابشن».</div>'}
      <label class="sx-f"><span>نص الإعلان</span><textarea rows="5" data-b="primaryText">${esc(f.primaryText || '')}</textarea></label>
      <label class="sx-f"><span>الهيدلاين</span><input data-b="headline" value="${esc(f.headline || '')}"></label></div></div>
    <div class="sx-card"><div class="sx-chead"><b>شكل الكامبين</b></div><div class="sx-cbody">
      <div class="sx-row"><label class="sx-f"><span>عدد الكامبينات</span><input type="number" min="1" max="3" data-b="campaignCount" value="${f.campaignCount}"></label><label class="sx-f"><span>مجموعات في كل كامبين</span><input type="number" min="1" max="5" data-b="adSets" value="${f.adSets}"></label><label class="sx-f"><span>إعلانات في كل مجموعة</span><input type="number" min="1" max="5" data-b="adsPerSet" value="${f.adsPerSet}"></label></div>
      <div class="sx-eq">${imgs + vids} ملف جاهز (${imgs} صورة + ${vids} فيديو) ← ${shape.campaigns} كامبين × ${f.adSets} مجموعة × ${f.adsPerSet} إعلان = <b>${shape.ads} إعلان</b> ${shape.ads > imgs + vids ? '— بعض الملفات هيتكرر' : ''}</div>
      <small style="color:var(--sx-muted)">بترفع الصور الجاهزة وفيديوهات الـ AI على الحساب الإعلاني وبتتوزع على الإعلانات. اللي اترفع قبل كده مبيترفعش تاني.</small>
      <div><button class="sx-btn" data-b-assets ${S.busy.assets || !f.adAccountId ? 'disabled' : ''}>📤 جهّز الملفات على الحساب</button></div>${bar('assets')}${note('assets')}
      ${S.assetRes ? `<div class="sx-msg">اتسجّل ${S.assetRes.images.length} صورة و${S.assetRes.videos.length} فيديو${S.assetRes.failed.length ? ` — فشل ${S.assetRes.failed.length}: ${esc(S.assetRes.failed[0].error)}` : ''}.</div>` : ''}</div></div>
    <div class="sx-card"><div class="sx-chead"><b>الميزانية</b></div><div class="sx-cbody">
      <div class="sx-choices">${choice('budgetMode', 'ABO', f.budgetMode, 'ABO — ميزانية لكل مجموعة', 'أحسن للتجربة')}${choice('budgetMode', 'CBO', f.budgetMode, 'CBO — ميزانية للكامبين كله', 'أحسن بعد ما تلاقي الكسبان')}</div>
      <div class="sx-row"><label class="sx-f"><span>الميزانية اليومية (${f.budgetMode === 'CBO' ? 'للكامبين' : 'لكل مجموعة'}) ج</span><input type="number" min="1" inputmode="decimal" data-b="budget" value="${esc(f.budget)}"><small>مقترح: 150 ج</small></label><div class="sx-f"><span>الإجمالي اليومي</span><b style="font-size:18px;">${built.dailyTotal ? `${nfmt(built.dailyTotal)} ج` : '—'}</b></div></div></div></div>
    <div class="sx-card"><div class="sx-chead"><b>الاستهداف</b></div><div class="sx-cbody">
      <div class="sx-choices">${choice('targetingMode', 'BROAD', f.targetingMode, 'مفتوح (Broad)', 'ميتا تلاقي المشترين لوحدها — الأفضل غالبًا مع البيكسل')}${choice('targetingMode', 'CUSTOM', f.targetingMode, 'مخصص من البحث', j.research ? 'النوع والسن من جمهور البحث' : 'النوع والسن (لسه مفيش بحث)')}</div>
      ${f.targetingMode === 'CUSTOM' ? `<div class="sx-row"><label class="sx-f"><span>النوع</span>${sel([['ALL', 'الكل'], ['FEMALE', 'ستات'], ['MALE', 'رجالة']], f.gender, 'data-b="gender"')}</label><label class="sx-f"><span>من سن</span><input type="number" min="18" max="65" data-b="ageMin" value="${f.ageMin}"></label><label class="sx-f"><span>لحد سن</span><input type="number" min="18" max="65" data-b="ageMax" value="${f.ageMax}"></label></div>` : ''}
      <small style="color:var(--sx-muted)">${j.research ? `من البحث: ${esc(j.research.audience.description)} — ${esc((j.research.audience.interests || []).join('، '))}. ` : ''}الدولة مصر، والأماكن تلقائية.</small></div></div>
    <div class="sx-card"><div class="sx-chead"><b>التشغيل</b></div><div class="sx-cbody">
      <div class="sx-choices">${choice('runMode', 'PAUSED', f.runMode, 'يترفع موقوف (أشغّله بنفسي)', 'مفيش صرف لحد ما تشغّله من ميتا — الأأمن')}${choice('runMode', 'SCHEDULED', f.runMode, 'يبدأ في ميعاد أحدده', 'الكامبين بيترفع دلوقتي ومش بيصرف قبل الميعاد')}${choice('runMode', 'NOW', f.runMode, 'يبدأ يصرف على طول', 'بيشتغل ويصرف أول ما يترفع — بعد تأكيدك')}</div>
      ${f.runMode === 'SCHEDULED' ? `<div class="sx-row"><label class="sx-f"><span>التاريخ</span><input type="date" data-b="startDate" value="${esc(f.startDate)}"></label><label class="sx-f"><span>الساعة</span><input type="time" data-b="startTime" value="${esc(f.startTime)}"></label></div>` : ''}
      ${f.runMode === 'NOW' ? '<div class="sx-warnnote">⚠️ الكامبين هيصرف من حسابك الإعلاني فعليًا أول ما يترفع. هتتأكد مرة تانية قبل الرفع.</div>' : ''}</div></div>
    ${S.queue ? `<div class="sx-card"><div class="sx-chead"><b>حالة الرفع</b><span class="sx-badge pri">${esc(S.jobStatus || '')}</span></div><div class="sx-cbody"><div class="sx-queue">${(S.queue.campaigns || []).map((c) => `<div class="sx-q"><b>${esc(c.name || 'كامبين')}</b><span>${esc(c.status)}</span><small>${c.adSetsCreated ?? 0} مجموعة · ${c.adsCreated ?? 0} إعلان</small>${c.error ? `<em>${esc(String(c.error).slice(0, 160))}</em>` : ''}</div>`).join('')}</div></div></div>` : ''}
    <div class="sx-sticky"><div><b>${shape.campaigns} كامبين · ${shape.ads} إعلان${built.dailyTotal ? ` · ${nfmt(built.dailyTotal)} ج في اليوم` : ''}</b><small>${runLabel}${f.jobId ? ` · طلب الرفع ${esc(f.jobId.slice(0, 8))}… (${esc(S.jobStatus || 'مسودة')})` : ''}${missing.length ? ` · ناقص: ${esc(missing[0])}` : ''}</small></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="sx-btn" data-b-draft ${S.busy.draft ? 'disabled' : ''}>💾 حفظ كمسودة</button><button class="sx-btn primary" data-b-publish ${S.busy.publish || missing.length ? 'disabled' : ''}>🚀 ارفع الكامبين على ميتا</button></div></div>
    ${note('draft')}${bar('publish')}${note('publish')}`;

  const redraw = () => C.rerender();
  async function ensureJob() {
    if (f.jobId && S.jobStarted) return f.jobId;
    if (!f.jobId) f.jobId = crypto.randomUUID();
    if (!S.jobStarted) { await api.post(`${L}/jobs/${f.jobId}/start`, { adAccountId: f.adAccountId, adAccountName: f.adAccountName, productId: S.ctx.productId }); S.jobStarted = true; await api.post(`${B}/${p.id}/launch-link`, { jobId: f.jobId, status: 'DRAFT' }).catch(() => {}); }
    return f.jobId;
  }
  async function pollMedia(id, key) { for (let i = 0; i < 900; i++) { const jb = await api.get(`/api/amb-media/jobs/${id}`); S.bar[key] = { pct: jb.progress, message: jb.message }; const b = el.querySelector('.sx-job .bar i'); if (b) b.style.width = `${jb.progress}%`; if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(jb.status)) return jb; await new Promise((r) => setTimeout(r, 2000)); } throw new Error('الشغل أخد وقت أطول من المتوقع.'); }
  async function saveDraft() {
    await ensureJob(); const b = buildLaunchPayload(f, S.ctx); if (b.error) throw new Error(b.error);
    const job = await api.post(`${L}/jobs`, b.payload); S.jobStatus = job?.status || 'DRAFT'; await api.post(`${B}/${p.id}/launch-link`, { jobId: f.jobId, status: S.jobStatus }).catch(() => {});
    return { built: b };
  }

  el.querySelectorAll('[data-b]').forEach((inp) => {
    const k = inp.dataset.b;
    const apply = async () => {
      let v = inp.type === 'radio' ? (inp.checked ? inp.value : undefined) : inp.value; if (v === undefined) return;
      if (['campaignCount', 'adSets', 'adsPerSet', 'ageMin', 'ageMax'].includes(k)) v = Number(v) || 1;
      if (k === 'capIdx') { const i = Number(v); f.capIdx = i; f.primaryText = caps[i]?.primary || ''; f.headline = caps[i]?.headline || ''; return redraw(); }
      f[k] = v;
      if (k === 'adAccountId') { f.pageId = ''; f.pixelId = ''; f.instagramId = ''; f.jobId = null; S.jobStarted = false; S.assetRes = null; await loadAssets(); return redraw(); }
      if (k === 'pageId') f.pageName = (S.assets?.pages || []).find((x) => x.id === v)?.name || '';
      if (k === 'pixelId') f.pixelName = (S.assets?.pixels || []).find((x) => x.id === v)?.name || '';
      if (k === 'instagramId') f.instagramUsername = (S.assets?.instagram || []).find((x) => x.id === v)?.username || '';
      if (['budgetMode', 'targetingMode', 'runMode', 'campaignCount', 'adSets', 'adsPerSet', 'budget', 'pageId', 'pixelId', 'primaryText'].includes(k)) {
        const pos = inp.selectionStart; redraw(); const again = el.querySelector(`[data-b="${k}"]:not([type=radio])`); if (again && inp.type !== 'radio') { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* number / select */ } }
      }
    };
    inp.addEventListener(inp.tagName === 'SELECT' || inp.type === 'radio' ? 'change' : 'input', apply);
  });
  const lb = el.querySelector('[data-b-landing]');
  if (lb) lb.onclick = async () => { S.busy.landing = true; S.landing = null; say('landing', null); redraw(); try { S.landing = await api.post(`${L}/validate-landing`, { productId: S.ctx.productId, campaigns: [{ name: f.name, websiteUrl: f.websiteUrl }] }); } catch (e) { say('landing', e.message, true); } S.busy.landing = false; redraw(); };
  const ab = el.querySelector('[data-b-assets]');
  if (ab) ab.onclick = async () => {
    S.busy.assets = true; S.bar.assets = { pct: 3, message: 'بجهّز الملفات…' }; say('assets', null); S.assetRes = null; redraw();
    try { const jid = await ensureJob(); const started = await api.post(`${B}/${p.id}/launch-assets`, { launchJobId: jid }); const done = await pollMedia(started.id, 'assets'); if (done.status === 'FAILED') say('assets', done.error?.message || 'فشل.', true); else S.assetRes = done.result; } catch (e) { say('assets', e.message, true); }
    S.busy.assets = false; redraw();
  };
  const db = el.querySelector('[data-b-draft]');
  if (db) db.onclick = async () => { S.busy.draft = true; say('draft', null); redraw(); try { await saveDraft(); say('draft', '✅ اتحفظت المسودة.'); C.toast('اتحفظت المسودة.', 'success'); await C.reload(); } catch (e) { say('draft', e.message, true); } S.busy.draft = false; redraw(); };
  const pb = el.querySelector('[data-b-publish]');
  if (pb) pb.onclick = async () => {
    say('publish', null); S.busy.publish = true; redraw();
    try {
      const { built: b } = await saveDraft();
      const live = f.runMode === 'NOW';
      const ok = await UI.confirmModal({ title: live ? 'تأكيد رفع الكامبين وتشغيله' : 'تأكيد رفع الكامبين على ميتا', message: `هيتم إنشاء ${b.shape.campaigns} كامبين، ${b.shape.adSets} Ad Set، ${b.shape.ads} إعلان على الحساب الإعلاني (${f.adAccountName || f.adAccountId}).\n${live ? 'الكامبين هيشتغل ويصرف فعليًا أول ما يترفع.' : f.runMode === 'SCHEDULED' ? `كلها متوقفة ومش هتصرف قبل ${f.startDate} ${f.startTime}.` : 'كلها متوقفة (PAUSED) ومش هتصرف لحد ما تشغّلها إنت من ميتا.'}\nالميزانية اليومية المُهيّأة: ${nfmt(b.dailyTotal)} ج.\nمتابعة؟`, confirmLabel: live ? 'أيوه، ارفع وشغّل' : 'ارفع الكامبين', danger: true });
      if (!ok) { S.busy.publish = false; say('publish', 'اتلغى — المسودة محفوظة.'); return redraw(); }
      await api.post(`${L}/jobs/${f.jobId}/publish`, {}); await api.post(`${B}/${p.id}/launch-link`, { jobId: f.jobId, status: 'PUBLISHING' }).catch(() => {});
      S.bar.publish = { pct: 5, message: 'بيترفع على ميتا…' };
      for (let i = 0; i < 360; i++) {
        await new Promise((r) => setTimeout(r, 5000)); if (!document.body.contains(el)) return;
        S.queue = await api.get(`${L}/jobs/${f.jobId}/queue-status`).catch(() => S.queue); const stt = S.queue?.jobStatus; S.jobStatus = stt || S.jobStatus;
        const camps = S.queue?.campaigns || []; const doneN = camps.filter((c) => c.status === 'COMPLETE').length;
        S.bar.publish = { pct: camps.length ? Math.round((doneN / camps.length) * 100) : 5, message: `${doneN} من ${camps.length || '…'} كامبين خلصوا` }; redraw();
        if (['COMPLETE', 'FAILED', 'PARTIAL', 'CANCELLED'].includes(stt)) break;
      }
      await api.post(`${B}/${p.id}/launch-link`, { jobId: f.jobId, status: S.jobStatus || 'PUBLISHING' }).catch(() => {});
      say('publish', S.jobStatus === 'COMPLETE' ? (live ? '✅ الكامبين اترفع وشغال على ميتا.' : '✅ الكامبين اترفع على ميتا — شغّله من Ads Manager لما تكون جاهز.') : `حالة الرفع: ${S.jobStatus}`, S.jobStatus === 'FAILED'); await C.reload();
    } catch (e) { say('publish', e.message, true); }
    S.busy.publish = false; redraw();
  };
}
