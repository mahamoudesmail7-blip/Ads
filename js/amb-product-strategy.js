// amb-product-strategy.js — «AI Targeting & Creative Strategy», a tab inside the AI Media Buyer product page (Decision Center dossier).
// Upload up to 3 product photos → ONE vision analysis (confirmed vs inferred vs needs-verification) → 5 targeting strategies (interests checked against Meta) → 5 Egyptian-Arabic posts with headlines →
// creative ideas + ready prompts. Everything is saved inside the product. Analysis and text only: nothing here writes to Meta or touches budgets / AUTOPILOT / campaigns.
import { api } from './api-client.js';
import * as UI from './ui-common.js';

const E = UI.escapeHtml;
const API = '/api/product-strategy';
const GENDER_AR = { MALE: 'رجال', FEMALE: 'سيدات', ALL: 'الجميع' };
const CONF_AR = { LOW: ['منخفضة', 'gray'], MEDIUM: ['متوسطة', 'amber'] };
const POST_STATUS = { DRAFT: ['مسودة', 'gray'], EDITED: ['معدّل', 'amber'], APPROVED: ['معتمد', 'green'] };
const TABS = [['media', '📷 الصور والتحليل'], ['page', '🌐 الصفحة والاهتمامات'], ['targeting', '🎯 الاستهداف'], ['posts', '✍️ البوستات'], ['creative', '🎨 الكرياتيف'], ['data', '🔗 بيانات المنتج']];

export async function mountProductStrategy(host, productId) {
  if (!host) return;
  const S = { id: productId, v: null, tab: 'media', busy: null, error: null, real: null, realErr: null, aud: 'ai', drafts: {}, open: new Set(['GOODBYE']), openS: new Set(['PRIMARY']), instr: {} };
  const q = (s) => host.querySelector(s);
  const call = async (fn) => { try { return await fn(); } catch (e) { S.error = e.message || 'حصلت مشكلة'; return null; } };

  async function load() { S.v = await call(() => api.get(`${API}/products/${S.id}`)); paint(); }
  const post = (path, body) => call(async () => { const r = await api.post(`${API}/products/${S.id}${path}`, body || {}); S.v = r; S.error = null; return r; });

  // ───────────── actions ─────────────
  async function runAll() {
    if (S.busy) return; S.error = null;
    const v = S.v; if (!v.images.some((i) => i.uploaded)) { S.error = 'ارفع صورة واحدة على الأقل للمنتج (الأفضل 3 صور).'; return paint(); }
    const steps = [['analyze', 'بحلّل الصور…', { force: true }], ['targeting', 'بجهّز استراتيجيات الاستهداف وبتحقق من الاهتمامات في Meta…', { force: true }], ['posts', 'بكتب 5 بوستات…', { force: true }]];
    for (let i = 0; i < steps.length; i++) {
      S.busy = `(${i + 1}/3) ${steps[i][1]}`; paint();
      const r = await post(`/${steps[i][0]}`, steps[i][2]); if (!r) break;
      if (steps[i][0] === 'analyze' && S.v.analysis?.insufficient) { S.error = 'الصور وبيانات المنتج مش كفاية لتحليل مؤكد. ارفع صور أوضح أو ضيف مميزات للمنتج وحلّل تاني.'; break; }
    }
    S.busy = null; if (!S.error) { S.tab = 'posts'; UI.toast('✅ التحليل خلص واتحفظ في المنتج'); } paint();
  }
  async function runPage() {
    if (S.busy) return; S.error = null; const url = q('#psPageUrl')?.value || '';
    S.busy = 'بقيس سرعة الصفحة وبقيّمها (ممكن ياخد لحد دقيقة)…'; paint();
    const r = await post('/page', { url }); if (!r) { S.busy = null; return paint(); }
    if (S.v.aiConfigured) { S.busy = 'بجهّز 8 اهتمامات وبتحقق منها جوه Meta…'; paint(); const r2 = await post('/interests', { force: true }); if (r2) UI.toast('✅ الصفحة اتقيّمت والاهتمامات جاهزة'); } else { S.error = 'الصفحة اتقيّمت، لكن الاهتمامات محتاجة الـAI (OpenAI غير متصل).'; }
    S.busy = null; paint();
  }
  async function runOne(path, label, body) { if (S.busy) return; S.busy = label; S.error = null; paint(); const r = await post(path, body); S.busy = null; if (r) UI.toast('✅ تمّ'); paint(); }
  async function upload(slot, file) {
    if (!file) return; S.error = null;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { S.error = 'نوع الملف مش مدعوم — الصور المقبولة JPG أو PNG أو WEBP.'; return paint(); }
    if (file.size > (S.v.constants.maxImageMb * 1048576)) { S.error = `الصورة أكبر من ${S.v.constants.maxImageMb}MB.`; return paint(); }
    S.busy = 'برفع الصورة…'; paint();
    const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    const out = await call(() => api.post(`${API}/products/${S.id}/images/${slot}`, { dataUrl })); if (out) S.v = out; S.busy = null; paint();
  }
  const copy = async (text, ok) => { try { await navigator.clipboard.writeText(text); } catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch { /* ignore */ } t.remove(); } UI.toast(ok || 'اتنسخ ✅'); };

  // ───────────── views ─────────────
  const chip = (txt, tone = 'gray') => `<span class="ps-chip ${tone}">${E(txt)}</span>`;
  const srcLabel = (s) => (s === 'STORE_DATA' ? 'بيانات المتجر' : /^IMAGE_(\d)$/.test(s) ? `صورة ${s.slice(-1)}` : s);

  function mediaTab(v) {
    const a = v.analysis;
    const slots = v.images.map((s) => `<div class="ps-slot ${s.uploaded ? 'has' : ''}" data-slot="${s.slot}">
      ${s.uploaded ? `<img src="${API}/products/${S.id}/images/${s.slot}?cb=${encodeURIComponent(s.at || '')}" alt="صورة ${s.slot}" />` : '<div class="ps-ph">＋</div>'}
      <div class="ps-slot-t"><b>صورة ${s.slot}</b><small>${E(s.label)}</small></div>
      <div class="ps-slot-b"><label class="amb-btn ghost sm">${s.uploaded ? 'استبدال' : 'رفع'}<input type="file" accept="image/jpeg,image/png,image/webp" hidden data-up="${s.slot}"></label>${s.uploaded ? `<button class="amb-btn ghost sm danger" data-rmimg="${s.slot}">حذف</button>` : ''}</div></div>`).join('');
    let analysis = '<div class="amb-empty">ارفع الصور واضغط «تحليل المنتج». الـAI بيحلل الصور مع بعض كمنتج واحد.</div>';
    if (a) {
      const list = (items, fn) => (items.length ? `<ul class="ps-list">${items.map(fn).join('')}</ul>` : '<div class="faint">—</div>');
      analysis = `${a.stale ? '<div class="ps-warn">⚠️ الصور اتغيّرت بعد التحليل — اضغط «تحليل المنتج» لتحديث النتايج.</div>' : ''}
        ${a.insufficient ? '<div class="ps-warn bad">الصور وبيانات المنتج مش كفاية لتحليل مؤكد. ارفع صور أوضح أو ضيف مميزات للمنتج وحلّل تاني. (محدش اخترع مواصفات)</div>' : ''}
        <div class="ps-sum"><b>${E(a.productName || v.context.name)}</b>${a.category ? ` · ${E(a.category)}` : ''}<p>${E(a.summary)}</p></div>
        <div class="ps-cols">
          <details open class="ps-box ok"><summary>✅ مؤكّد (من الصور أو بيانات المتجر)</summary>
            <h5>المواصفات</h5>${list([...a.confirmed.specs, ...a.storeFeatures.map((t) => ({ text: t, source: 'STORE_DATA' }))], (x) => `<li>${E(x.text)} ${chip(srcLabel(x.source), 'green')}</li>`)}
            <h5>الاستخدامات</h5>${list(a.confirmed.usage, (x) => `<li>${E(x.text)} ${chip(srcLabel(x.source), 'green')}</li>`)}</details>
          <details open class="ps-box warn"><summary>🟡 استنتاجات AI (مش حقائق)</summary>
            <h5>الفوايد المحتملة</h5>${list(a.inferred.benefits, (x) => `<li>${E(x)}</li>`)}<h5>المشاكل اللي ممكن يساعد فيها</h5>${list(a.inferred.problemsSolved, (x) => `<li>${E(x)}</li>`)}
            <h5>العملاء المحتملين</h5>${list(a.inferred.potentialBuyers, (x) => `<li>${E(x)}</li>`)}<h5>نقاط القوة</h5>${list(a.inferred.strengths, (x) => `<li>${E(x)}</li>`)}
            <h5>نقاط الضعف</h5>${list(a.inferred.weaknesses, (x) => `<li>${E(x)}</li>`)}<h5>اعتراضات متوقعة قبل الشراء</h5>${list(a.inferred.objections, (x) => `<li>${E(x)}</li>`)}</details>
          <details open class="ps-box bad"><summary>❓ محتاج تحقق قبل ما يتقال في الإعلان</summary>${list(a.needsVerification, (x) => `<li>${E(x.text)}<small> — ${E(x.why)}</small></li>`)}</details>
        </div>
        ${a.imageNotes?.length ? `<details class="ps-box"><summary>🖼️ ملاحظات على كل صورة</summary>${list(a.imageNotes, (n) => `<li><b>صورة ${n.slot}:</b> ${E(n.notes)}</li>`)}</details>` : ''}
        <div class="faint ps-at">آخر تحليل: ${E(new Date(a.at).toLocaleString('ar-EG'))}${a.cached ? ' (من الكاش)' : ''}</div>`;
    }
    return `<div class="ps-slots">${slots}</div><div class="faint ps-hint">JPG / PNG / WEBP حتى ${v.constants.maxImageMb}MB للصورة. الأولى الشكل الأساسي، التانية التفاصيل أو الاستخدام، التالتة المرفقات أو العبوة.</div>${analysis}`;
  }

  function interestRow(i) {
    const m = i.meta || { status: 'UNAVAILABLE' }; const st = S.v.constants.interestStatus[m.status] || S.v.constants.interestStatus.UNAVAILABLE;
    const alt = (m.alternatives || []).length ? `<div class="ps-alts">بدائل من Meta: ${m.alternatives.map((a) => `<code>${E(a.name)}</code>`).join(' ')}</div>` : '';
    const size = m.match?.audienceLower != null ? `<small class="faint"> · حجم الجمهور ≈ ${Number(m.match.audienceLower).toLocaleString('en-US')}–${Number(m.match.audienceUpper).toLocaleString('en-US')}</small>` : '';
    return `<li class="ps-int"><code dir="ltr">${E(i.name)}</code> ${chip(st.text, st.tone === 'ok' ? 'green' : st.tone === 'warn' ? 'amber' : 'gray')}${size}<div class="faint">${E(i.why || '')}</div>${alt}</li>`;
  }
  function targetingTab(v) {
    const seg = `<div class="ps-seg"><button class="${S.aud === 'ai' ? 'on' : ''}" data-aud="ai">AI Suggested Audience — جمهور مقترح</button><button class="${S.aud === 'real' ? 'on' : ''}" data-aud="real">Real Buyer Audience — مشترين فعليين</button></div>`;
    if (S.aud === 'real') return seg + realTab();
    const t = v.targeting; if (!t) return seg + '<div class="amb-empty">لسه مفيش استراتيجيات. اضغط «تحليل المنتج» (أو «إعادة توليد الاستهداف» بعد التحليل).</div>';
    const ver = t.verification;
    const banner = ver.available ? `<div class="ps-note">تم التحقق من الاهتمامات في Meta: ${Object.entries(ver.counts).map(([k, n]) => `${E(v.constants.interestStatus[k]?.text || k)} (${n})`).join(' · ') || '—'}</div>` : `<div class="ps-warn">التحقق من الاهتمامات في Meta مش متاح دلوقتي${ver.reason ? ` (${E(ver.reason)})` : ''} — كل الاهتمامات اقتراحات تحتاج مراجعة، مش استهداف مؤكد.</div>`;
    const cards = t.strategies.map((s) => {
      const c = CONF_AR[s.confidence.level] || CONF_AR.LOW; const open = S.openS.has(s.key);
      const kind = s.key === 'ADVANTAGE_PLUS' ? 'في Advantage+ العمر والنوع والاهتمامات <b>اقتراحات</b> بس — Meta ممكن توسّعها. الإلزامي: المكان وأقل سن (راجع Ads Manager).' : s.key === 'BROAD' ? 'Broad: من غير قيود اهتمامات — الاهتمامات هنا للتوجيه بس.' : s.key === 'DETAILED' ? 'الاهتمامات هنا بتشتغل كـ<b>قيود استهداف</b> لو حطيتها في Ads Manager (بتضيّق الجمهور).' : 'اقتراح لشريحة — مش قيد إلزامي من Meta.';
      return `<div class="ps-card ${open ? 'open' : ''}"><button class="ps-card-h" data-sopen="${s.key}"><span><b>${E(s.label)}</b> — ${E(s.segmentName)}</span><span class="ps-chips">${chip(GENDER_AR[s.gender], 'blue')} ${chip(`${s.ageMin}–${s.ageMax} سنة`, 'blue')} ${chip(s.locations.scope === 'EGYPT' ? 'كل مصر' : s.locations.regions.join('، '), 'blue')} ${chip(`ثقة ${c[0]}`, c[1])}</span></button>
        ${open ? `<div class="ps-card-b"><div class="ps-grid">
          <div><h5>الاهتمامات (Detailed Targeting)</h5>${s.interests.length ? `<ul class="ps-list">${s.interests.map(interestRow).join('')}</ul>` : '<div class="faint">من غير اهتمامات.</div>'}</div>
          <div><h5>سبب اختيار الجمهور</h5><p>${E(s.reason)}</p><h5>الدافع الشرائي المتوقع</h5><p>${E(s.motive)}</p><h5>Marketing Angle</h5><p>${E(s.angle)}</p><h5>نوع الكرياتيف المقترح</h5><p>${E(s.creativeType)}</p></div></div>
          <div class="ps-note">${kind}</div><div class="ps-note">🧪 ${E(s.confidence.why)} — مفيش جمهور هو الأفضل من غير اختبار وبيانات شراء فعلية.</div></div>` : ''}</div>`;
    }).join('');
    return `${seg}${banner}${t.stale ? '<div class="ps-warn">⚠️ التحليل اتغيّر بعد الاستراتيجيات دي — أعد توليد الاستهداف.</div>' : ''}${cards}<div class="ps-actions"><button class="amb-btn ghost sm" data-act="re-targeting">🔄 إعادة توليد الاستهداف</button></div>`;
  }
  function realTab() {
    if (S.realErr) return `<div class="ps-warn">${E(S.realErr)}</div>`;
    if (!S.real) { loadReal(); return '<div class="amb-empty">جارِ تحميل بيانات المشترين الفعلية…</div>'; }
    const r = S.real; const rows = (t, cols) => (t.length ? `<table class="ps-table"><thead><tr>${cols.map((c) => `<th>${E(c[1])}</th>`).join('')}</tr></thead><tbody>${t.map((x) => `<tr>${cols.map((c) => `<td>${E(c[2] ? c[2](x[c[0]]) : (x[c[0]] ?? '—'))}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<div class="faint">لا توجد بيانات كافية.</div>');
    const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
    return `<div class="ps-note">${E(r.note)} الفترة: ${E(r.window?.label || `${r.window?.from || ''} → ${r.window?.to || ''}`)}</div>
      ${!r.metaAvailable ? `<div class="ps-warn">بيانات Meta مش متاحة: ${E(r.metaUnavailableReason || '')}</div>` : ''}
      <div class="ps-cols"><div class="ps-box"><h5>النوع (توصيل Meta)</h5>${rows(r.gender, [['segment', 'الشريحة'], ['purchases', 'مشتريات'], ['cpa', 'CPA']])}</div>
        <div class="ps-box"><h5>العمر (توصيل Meta)</h5>${rows(r.age, [['segment', 'الشريحة'], ['purchases', 'مشتريات'], ['cpa', 'CPA']])}</div>
        <div class="ps-box"><h5>المحافظات (أوردرات Easy Orders)</h5>${rows(r.governorates, [['segment', 'المحافظة'], ['orders', 'أوردرات'], ['confirmationRate', 'تأكيد', pct], ['deliveryRate', 'توصيل', pct]])}</div></div>
      ${r.audienceSignal?.label ? `<div class="ps-note">أقوى الإشارات المستقلة: <b>${E(r.audienceSignal.label)}</b> — ${E(r.audienceSignal.note || '')}</div>` : ''}`;
  }
  async function loadReal() { if (S.realLoading) return; S.realLoading = true; try { S.real = await api.get(`${API}/products/${S.id}/real-audience`); } catch (e) { S.realErr = e.message || 'تعذّر تحميل بيانات المشترين.'; } S.realLoading = false; paint(); }

  function postsTab(v) {
    if (!v.posts) return '<div class="amb-empty">لسه مفيش بوستات. اضغط «تحليل المنتج».</div>';
    const miss = v.postsMissing?.length ? `<div class="ps-warn">بوستات ماتولّدتش: ${E(v.postsMissing.join('، '))} — اضغط إعادة التوليد عليها.</div>` : '';
    return `${v.stale.posts ? '<div class="ps-warn">⚠️ الصور أو التحليل اتغيّروا بعد كتابة البوستات — أعد كتابتها.</div>' : ''}${miss}${v.posts.map((p) => postCard(p, v)).join('')}
      <div class="ps-actions"><button class="amb-btn ghost sm" data-act="re-posts">🔄 إعادة كتابة كل البوستات</button></div>`;
  }
  function postCard(p, v) {
    const d = S.drafts[p.type] || {}; const text = d.text ?? p.text; const headline = d.headline ?? p.headline; const dirty = d.text !== undefined && d.text !== p.text || d.headline !== undefined && d.headline !== p.headline;
    const st = POST_STATUS[p.status] || POST_STATUS.DRAFT; const open = S.open.has(p.type);
    const aud = p.audits.map((w) => `<li class="${w.level === 'BLOCK' ? 'blk' : 'wrn'}">${w.level === 'BLOCK' ? '⛔' : '⚠️'} ${E(w.message)}</li>`).join('');
    return `<div class="ps-card ${open ? 'open' : ''}" data-ptype="${p.type}"><button class="ps-card-h" data-popen="${p.type}"><span><b>${E(p.label)}</b> — ${E(p.angle)}</span><span class="ps-chips">${chip(st[0], st[1])}${p.blocked ? chip('فيه ملاحظة لازم تتصلّح', 'red') : ''}</span></button>
      ${open ? `<div class="ps-card-b">
        <label class="ps-lab">Headline <span class="faint" data-hc>${[...headline].length}/40</span></label><input class="ps-input" data-head="${p.type}" value="${E(headline)}" maxlength="90" />
        <label class="ps-lab">نص البوست (تقدر تعدّله قبل النسخ أو الاعتماد)</label><textarea class="ps-text" data-text="${p.type}" rows="16">${E(text)}</textarea>
        ${aud ? `<ul class="ps-audits">${aud}</ul>` : '<div class="ps-ok">✅ مفيش ملاحظات جودة على البوست ده.</div>'}
        <div class="ps-btns"><button class="amb-btn sm" data-copy="${p.type}">📋 نسخ البوست كامل</button><button class="amb-btn ghost sm" data-copyh="${p.type}">📋 نسخ الـHeadline</button>
          <button class="amb-btn ghost sm" data-save="${p.type}" ${dirty ? '' : 'disabled'}>💾 حفظ التعديل</button><button class="amb-btn ghost sm" data-approve="${p.type}" ${p.status === 'APPROVED' ? 'disabled' : ''}>✔ اعتماد</button>
          ${p.versionsCount ? `<button class="amb-btn ghost sm" data-revert="${p.type}">↩ النسخة السابقة (${p.versionsCount})</button>` : ''}</div>
        <div class="ps-regen"><input class="ps-input" data-instr="${p.type}" placeholder="تعليمات لإعادة الكتابة (اختياري) — مثلًا: اقصر، أو زاوية أهدى" value="${E(S.instr[p.type] || '')}" /><button class="amb-btn ghost sm" data-regen="${p.type}">🔄 إعادة توليد البوست ده</button></div></div>` : ''}</div>`;
  }
  function creativeTab(v) {
    if (!v.posts) return '<div class="amb-empty">الكرياتيف بيتولّد مع البوستات. اضغط «تحليل المنتج».</div>';
    return v.posts.map((p) => { const c = p.creative; return `<div class="ps-card open"><div class="ps-card-h static"><span><b>${E(p.label)}</b> — ${E(p.headline)}</span></div><div class="ps-card-b"><div class="ps-grid">
      <div><h5>🖼️ فكرة صورة 1000×1000</h5><p>${E(c.imageIdea)}</p><h5>🎬 فكرة فيديو 9:16</h5><p>${E(c.videoIdea)}</p><h5>👁️ Hook بصري</h5><p>${E(c.visualHook)}</p><h5>👥 الجمهور المناسب للكرياتيف</h5><p>${E(c.audienceFit)}</p></div>
      <div><h5>برومبت الصورة</h5><pre class="ps-pre" dir="ltr">${E(c.imagePrompt)}</pre><button class="amb-btn ghost sm" data-cpr="${p.type}:image">📋 نسخ برومبت الصورة</button>
        <h5>برومبت الفيديو</h5><pre class="ps-pre" dir="ltr">${E(c.videoPrompt)}</pre><button class="amb-btn ghost sm" data-cpr="${p.type}:video">📋 نسخ برومبت الفيديو</button></div></div>
      <div class="ps-note">البرومبتات بتحافظ على شكل المنتج الحقيقي من الصور الـ3 ومفيهاش مرفقات أو وظائف مش موجودة.</div></div></div>`; }).join('');
  }
  function pageTab(v) {
    const pg = v.page; const it = v.interests; const link = v.commercial.link || '';
    const fmtMs = (ms) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} ث` : `${Math.round(ms)}ms`);
    const tone = (s) => (s >= 80 ? 'green' : s >= 50 ? 'amber' : 'red');
    const met = (label, val, good, fmt = fmtMs) => (val == null ? '' : `<div class="ps-met ${val <= good ? 'ok' : 'bad'}"><small>${label}</small><b>${fmt(val)}</b></div>`);
    let pageHtml = '<div class="amb-empty">اكتب رابط صفحة المنتج واضغط «حلّل الصفحة وجهّز الاهتمامات» — هقيس سرعة الصفحة وأقيّمها من 100.</div>';
    if (pg) {
      const sp = pg.speed; const m = sp.metrics || {};
      pageHtml = `<div class="ps-scoreRow"><div class="ps-score ${tone(pg.total)}"><b>${pg.total}</b><small>من 100</small></div>
        <div><h4 style="margin:0 0 4px">تقييم الصفحة: ${E(pg.totalLabel)}</h4><div class="faint">${E(pg.url)}<br>الحساب: ${E(pg.formula)} · اتقاست ${E(new Date(pg.at).toLocaleString('ar-EG'))}</div></div></div>
        <div class="ps-box"><h5>⚡ سرعة الصفحة — ${sp.score}/100 · ${E(sp.label)}</h5><div class="faint">${E(sp.sourceLabel)}${sp.psiReason ? ` — السبب: ${E(sp.psiReason)}` : ''}</div>
          <div class="ps-mets">${sp.metrics ? `${met('أول ظهور للمحتوى FCP', m.fcpMs, 1800)}${met('أكبر عنصر LCP', m.lcpMs, 2500)}${met('تجمّد الصفحة TBT', m.tbtMs, 200)}${met('ثبات الشكل CLS', m.cls, 0.1, (x) => x.toFixed(2))}` : ''}${met('رد السيرفر', pg.measured.ttfbMs, 800)}${met('تحميل الكود', pg.measured.totalMs, 2000)}<div class="ps-met"><small>حجم الكود</small><b>${pg.measured.htmlKb}KB</b></div><div class="ps-met"><small>صور / سكربتات</small><b>${pg.measured.images} / ${pg.measured.scripts}</b></div></div></div>
        ${pg.content.score == null ? `<div class="ps-warn">${E(pg.content.note)}</div>` : `<div class="ps-box"><h5>🧾 محتوى الصفحة — ${pg.content.score}/100</h5><ul class="ps-checks">${pg.content.checks.map((c) => `<li class="${c.ok ? 'ok' : 'no'}"><span>${c.ok ? '✅' : '❌'}</span><div><b>${E(c.label)}</b><small>${E(c.note)}</small></div><em>${c.points}/${c.max}</em></li>`).join('')}</ul></div>`}
        ${pg.tips.length ? `<div class="ps-box warn"><h5>🔧 أهم حاجات تتحسّن</h5><ul class="ps-list">${pg.tips.map((t) => `<li>${E(t)}</li>`).join('')}</ul></div>` : ''}`;
    }
    let intHtml = '<div class="amb-empty">لسه ماتجهّزش. اضغط الزر فوق.</div>';
    if (it) {
      const fmtN = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));
      intHtml = `${it.pageChanged ? '<div class="ps-warn">⚠️ الصفحة اتحلّلت تاني بعد ما الاهتمامات اتجهّزت — اضغط الزر لتحديثها.</div>' : ''}
        <div class="ps-note">${it.verification.available ? `اتحقق من ${it.verification.verified} من ${it.verification.total} جوه Meta نفسها.` : `التحقق جوه Meta مش متاح دلوقتي${it.verification.reason ? ` (${E(it.verification.reason)})` : ''} — الأسماء اقتراحات لازم تتأكد منها في Ads Manager.`}</div>
        <div class="ps-ints">${it.items.map((x, i) => `<div class="ps-int8"><div class="ps-int8-h"><span class="ps-n">${i + 1}</span><code dir="ltr">${E(x.name)}</code><button class="amb-btn ghost sm" data-cpint="${E(x.name)}">نسخ</button></div>
          <div>${chip(x.status === 'VERIFIED' ? (x.alt ? 'موجود في Meta (بديل قريب)' : 'متحقق منه في Meta') : (v.constants.interestStatus[x.status]?.text || 'اقتراح يحتاج مراجعة'), x.status === 'VERIFIED' ? 'green' : 'amber')}${x.audienceLower != null ? ` <small class="faint">حجم الجمهور ≈ ${fmtN(x.audienceLower)}–${fmtN(x.audienceUpper)}</small>` : ''}</div>
          ${x.requested ? `<small class="faint">اتبدّل من «${E(x.requested)}» لأنه مش موجود بنفس الاسم</small>` : ''}<small class="faint">${E(x.why || '')}</small></div>`).join('')}</div>
        <div class="ps-btns"><button class="amb-btn" id="psCopyInts">📋 نسخ الـ${it.items.length} اهتمامات (سطر لكل اهتمام)</button></div>
        <div class="ps-note">دي اقتراحات استهداف مش وعد بنتيجة — مفيش جمهور هو الأفضل من غير اختبار وبيانات شراء فعلية. الاهتمامات مش بتتطبّق على أي حملة تلقائيًا.</div>`;
    }
    return `<div class="ps-box"><h5>رابط صفحة المنتج</h5><div class="ps-regen"><input class="ps-input" id="psPageUrl" dir="ltr" placeholder="https://…" value="${E(link)}" /><button class="amb-btn" id="psPageGo" ${S.busy ? 'disabled' : ''}>🌐 حلّل الصفحة وجهّز الاهتمامات</button></div>
      <div class="faint ps-at">الرابط بيتحفظ مع المنتج ويتحط في البوستات. السرعة بتتقاس بـGoogle PageSpeed (موبايل) وممكن ياخد لحد دقيقة.</div></div>
      <div class="ps-cols" style="margin-top:12px"><div>${pageHtml}</div><div><div class="ps-box"><h5>🎯 أفضل 8 اهتمامات (بالإنجليزي — للبحث في Ads Manager)</h5>${intHtml}</div></div></div>`;
  }
  function dataTab(v) {
    const c = v.context; const cm = v.commercial;
    const fact = (k, label, extra) => `<label class="ps-fact"><input type="checkbox" data-conf="${k}" ${cm.confirmed[k] ? 'checked' : ''}> <span><b>${label}</b> ${cm.sources?.[k] ? chip('من بيانات المتجر', 'green') : ''}<small>${extra}</small></span></label>`;
    return `<div class="ps-cols"><div class="ps-box"><h5>بيانات المنتج المستخدمة</h5><ul class="ps-list"><li>الاسم: <b>${E(c.name)}</b></li><li>التصنيف: ${E(c.category || '—')}</li><li>سعر البيع: <b>${c.price != null ? c.price : '—'}</b>${c.oldPrice ? ` (قبل الخصم ${c.oldPrice})` : ''}</li><li>الحملات المرتبطة: ${c.linkedCampaigns ?? '—'}</li></ul>
        <h5>مميزات المنتج المسجّلة</h5>${c.features.length ? `<ul class="ps-list">${c.features.map((f) => `<li>${E(f)}</li>`).join('')}</ul>` : '<div class="faint">مفيش مميزات مسجّلة في بيانات المتجر.</div>'}
        ${c.eoError ? `<div class="ps-warn">${E(c.eoError)}</div>` : ''}</div>
      <div class="ps-box"><h5>رابط صفحة المنتج</h5>${cm.link ? `<div class="ps-note">الرابط الحالي (${cm.linkSource === 'MANUAL' ? 'مكتوب يدوي' : 'من بيانات المتجر'}): <code dir="ltr">${E(cm.link)}</code></div>` : `<div class="ps-warn">${E(c.storeUrlMissingReason || 'الرابط مش متاح')} — اكتبه هنا عشان يتحط في البوستات.</div>`}
        <div class="ps-regen"><input class="ps-input" id="psLink" dir="ltr" placeholder="https://…" value="${E(S.v.commercial.linkSource === 'MANUAL' ? cm.link : '')}" /><button class="amb-btn ghost sm" id="psSaveLink">حفظ الرابط</button></div>
        <h5>بيانات تجارية مؤكدة (البوستات بتذكر دي بس)</h5>${fact('discount', 'خصم حقيقي', cm.discountPercent ? `السعر ${cm.price} بدل ${cm.oldPrice} (${cm.discountPercent}%)` : 'مفيش خصم مسجّل في بيانات المنتج.')}${fact('shipping', 'تفاصيل الشحن', 'الشحن المجاني بيتأكد من المتجر. لو فيه شحن/توصيل تاني أكّده بنفسك.')}${fact('payment', 'الدفع عند الاستلام', 'أكّده بنفسك لو المتجر بيشتغل COD.')}</div></div>`;
  }

  function paint() {
    const v = S.v; if (!v) { host.innerHTML = '<div class="ps"><div class="amb-empty">جارِ التحميل…</div></div>'; return; }
    const body = { media: mediaTab, page: pageTab, targeting: targetingTab, posts: postsTab, creative: creativeTab, data: dataTab }[S.tab](v);
    const hasAnalysis = !!v.analysis;
    host.innerHTML = `<div class="ps">
      <div class="ps-head"><div><h3>🎯 AI Targeting & Creative Strategy</h3><div class="faint">تحليل المنتج من صوره (3 صور مع بعض) ← استهداف ← بوستات ← كرياتيف. نتايج محفوظة جوه المنتج. اقتراحات فقط — مفيش تنفيذ على Meta.</div></div>
        <div class="ps-head-b">${!v.aiConfigured ? chip('الـAI مش متصل (OpenAI)', 'red') : ''}<button class="amb-btn" id="psRun" ${S.busy || !v.aiConfigured ? 'disabled' : ''}>🔍 ${hasAnalysis ? 'إعادة تحليل المنتج' : 'تحليل المنتج'}</button></div></div>
      ${S.busy ? `<div class="ps-busy"><span class="ps-spin"></span> ${E(S.busy)}</div>` : ''}
      ${S.error ? `<div class="ps-warn bad">⚠️ ${E(S.error)}</div>` : ''}
      <div class="ps-tabs">${TABS.map(([k, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-tab="${k}">${l}${k === 'posts' && v.posts ? ` <em>${v.posts.length}</em>` : ''}</button>`).join('')}</div>
      <div class="ps-body">${body}</div></div>`;
    wire();
  }

  // ───────────── events ─────────────
  function wire() {
    const on = (sel, ev, fn) => host.querySelectorAll(sel).forEach((el) => { el[ev] = (e) => fn(el, e); });
    q('#psRun') && (q('#psRun').onclick = runAll);
    on('[data-tab]', 'onclick', (el) => { S.tab = el.dataset.tab; S.error = null; paint(); });
    on('[data-up]', 'onchange', (el) => upload(Number(el.dataset.up), el.files[0]));
    on('[data-rmimg]', 'onclick', async (el) => { const out = await call(() => api.delete(`${API}/products/${S.id}/images/${el.dataset.rmimg}`)); if (out) S.v = out; paint(); });
    on('[data-aud]', 'onclick', (el) => { S.aud = el.dataset.aud; paint(); });
    on('[data-sopen]', 'onclick', (el) => { const k = el.dataset.sopen; S.openS.has(k) ? S.openS.delete(k) : S.openS.add(k); paint(); });
    on('[data-popen]', 'onclick', (el) => { const k = el.dataset.popen; S.open.has(k) ? S.open.delete(k) : S.open.add(k); paint(); });
    on('[data-act="re-targeting"]', 'onclick', () => runOne('/targeting', 'بجهّز الاستهداف…', { force: true }));
    on('[data-act="re-posts"]', 'onclick', () => runOne('/posts', 'بكتب البوستات…', { force: true }));
    on('[data-head]', 'oninput', (el) => { const t = el.dataset.head; (S.drafts[t] ||= {}).headline = el.value; const c = el.parentElement.querySelector('[data-hc]'); if (c) c.textContent = `${[...el.value].length}/40`; markDirty(t); });
    on('[data-text]', 'oninput', (el) => { const t = el.dataset.text; (S.drafts[t] ||= {}).text = el.value; markDirty(t); });
    on('[data-instr]', 'oninput', (el) => { S.instr[el.dataset.instr] = el.value; });
    on('[data-copy]', 'onclick', (el) => { const t = el.dataset.copy; const p = S.v.posts.find((x) => x.type === t); copy(S.drafts[t]?.text ?? p.text, 'اتنسخ البوست كامل ✅'); });
    on('[data-copyh]', 'onclick', (el) => { const t = el.dataset.copyh; const p = S.v.posts.find((x) => x.type === t); copy(S.drafts[t]?.headline ?? p.headline, 'اتنسخ الـHeadline ✅'); });
    on('[data-cpr]', 'onclick', (el) => { const [t, k] = el.dataset.cpr.split(':'); const p = S.v.posts.find((x) => x.type === t); copy(k === 'image' ? p.creative.imagePrompt : p.creative.videoPrompt, 'اتنسخ البرومبت ✅'); });
    on('[data-save]', 'onclick', (el) => saveDraft(el.dataset.save));
    on('[data-approve]', 'onclick', async (el) => { const t = el.dataset.approve; if (S.drafts[t]) await saveDraft(t, true); const out = await call(() => api.put(`${API}/products/${S.id}/posts/${t}`, { status: 'APPROVED' })); if (out) { S.v = out; UI.toast('✔ البوست اتعتمد'); } paint(); });
    on('[data-revert]', 'onclick', async (el) => { const t = el.dataset.revert; const out = await call(() => api.post(`${API}/products/${S.id}/posts/${t}/revert`, {})); if (out) { S.v = out; delete S.drafts[t]; } paint(); });
    on('[data-regen]', 'onclick', async (el) => { const t = el.dataset.regen; if (S.busy) return; S.busy = 'بعيد كتابة البوست…'; S.error = null; paint(); const out = await call(() => api.post(`${API}/products/${S.id}/posts/${t}/regenerate`, { instruction: S.instr[t] || '' })); S.busy = null; if (out) { S.v = out; delete S.drafts[t]; UI.toast('✅ اتكتب من جديد'); } paint(); });
    q('#psPageGo') && (q('#psPageGo').onclick = runPage);
    q('#psCopyInts') && (q('#psCopyInts').onclick = () => copy(S.v.interests.items.map((x) => x.name).join('\n'), 'اتنسخت الاهتمامات ✅'));
    on('[data-cpint]', 'onclick', (el) => copy(el.dataset.cpint, 'اتنسخ ✅'));
    q('#psSaveLink') && (q('#psSaveLink').onclick = async () => { const out = await call(() => api.put(`${API}/products/${S.id}/commercial`, { link: q('#psLink').value })); if (out) { S.v = out; UI.toast('اتحفظ الرابط'); } paint(); });
    on('[data-conf]', 'onchange', async (el) => { const out = await call(() => api.put(`${API}/products/${S.id}/commercial`, { confirmed: { [el.dataset.conf]: el.checked } })); if (out) S.v = out; paint(); });
  }
  function markDirty(t) { const b = host.querySelector(`[data-save="${t}"]`); if (b) b.disabled = false; }
  async function saveDraft(t, silent = false) {
    const d = S.drafts[t]; if (!d) return; const out = await call(() => api.put(`${API}/products/${S.id}/posts/${t}`, d));
    if (out) { S.v = out; delete S.drafts[t]; if (!silent) UI.toast('💾 اتحفظ التعديل'); } paint();
  }

  await load();
}
