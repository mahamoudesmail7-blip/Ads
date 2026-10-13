// opx2-home.js — AI Operator V2 Home (read-only). One screen answering: is the system running, what is ready for review, what must I do now.
// Everything comes from /api/operator-v2/home (composed server-side from the existing sources). A saved policy is NEVER shown as ready — only «enabled + approved». Missing data is shown as «—», never as 0.
import { api } from './api-client.js';
import { E, num, egp, pill, ago, skeleton, errorCard, timebarHtml, bindTimebar, periodLabel } from './opx2-ui.js';
import { emergencyBanner, openEmergencyOff } from './opx2-safety.js';

const H = { host: null, ctx: null, st: { period: { key: 'last7' }, compare: false }, gen: 0, ctl: null, poll: null };
export function stopHome() { clearInterval(H.poll); H.poll = null; H.ctl?.abort?.(); H.host = null; }
const MODE_AR = { SHADOW: 'مراقبة فقط', APPROVAL: 'بموافقتي', AUTOPILOT: 'تلقائي', OFF: 'يدوي (متوقف)' };

export async function mountHome(host, ctx) {
  stopHome(); H.host = host; H.ctx = ctx; await load();
  H.poll = setInterval(() => { if (H.host && document.body.contains(H.host)) load(true); else stopHome(); }, 60_000);
}
async function load(silent = false) {
  const host = H.host; if (!host) return; const gen = ++H.gen; H.ctl?.abort?.(); H.ctl = new AbortController();
  if (!silent) host.innerHTML = `<h1>الرئيسية</h1><div class="opx2-card">${skeleton(5, 40)}</div>`;
  try {
    const p = H.st.period; const d = await api.get('/api/operator-v2/home', { period: p.key, from: p.key === 'custom' ? p.from : undefined, to: p.key === 'custom' ? p.to : undefined, compare: H.st.compare ? '1' : undefined }, { signal: H.ctl.signal });
    if (gen !== H.gen || !H.host) return; draw(d);
  } catch (e) { if (e.name === 'AbortError' || gen !== H.gen || !H.host) return; host.innerHTML = errorCard(e.message || 'تعذّر تحميل الرئيسية.'); host.querySelector('#o2Retry').onclick = () => load(); }
}
function draw(d) {
  const host = H.host; const s = d.summary; const g = d.gates; const caps = H.ctx.caps; const fresh = d.freshness; const syncAge = fresh.lastSyncAt ? Math.round((Date.now() - new Date(fresh.lastSyncAt).getTime()) / 60000) : null;
  const blockers = g ? [g.mode === 'SHADOW' && 'الوضع «مراقبة فقط»', g.writesLocked && 'قفل Meta مقفول على مستوى النشر', g.permissionsOn === 0 && 'صلاحيات التنفيذ الأربع OFF', g.emergencyStop && 'Emergency Stop مفعّل'].filter(Boolean) : [];
  const ready = [['open', 'جاهزة للفتح', '▶️'], ['pause', 'مرشحة للإيقاف', '⏸️'], ['up', 'فرص زيادة ميزانية', '📈'], ['down', 'فرص تقليل ميزانية', '📉'], ['review', 'تحتاج مراجعة', '🔎']];
  host.innerHTML = `<div class="opx2-sticky" style="position:static">${timebarHtml({ period: { ...H.st.period }, compare: H.st.compare })}</div>
  <h1>الرئيسية</h1><p class="lead">صورة واحدة: النظام شغال ولا لأ، وإيه الجاهز للمراجعة، وإيه المطلوب.</p>
  ${syncAge != null && syncAge > 60 ? `<div class="opx2-banner warn">⚠️ آخر مزامنة Meta من ${syncAge} دقيقة — الأرقام ممكن تكون متأخرة. ${fresh.staleCampaigns} حملة بياناتها قديمة.</div>` : ''}
  <div class="opx2-grid opx2-g4"><div class="opx2-card opx2-kpi"><b>${num(s.active)}</b><span>حملات نشطة (من ${num(s.campaigns)})</span></div><div class="opx2-card opx2-kpi"><b>${num(s.orders)}</b><span>أوردرات — ${E(periodLabel(d.period.key))}</span></div><div class="opx2-card opx2-kpi"><b>${egp(s.spend)}</b><span>الصرف</span></div><div class="opx2-card opx2-kpi"><b>${s.cpa == null ? '—' : egp(s.cpa)}</b><span>CPA${s.cpa == null ? ' (مفيش أوردرات متاحة)' : ''}</span></div></div>
  <div class="opx2-grid opx2-g4" data-home-extra="1"><div class="opx2-card opx2-kpi"><b>${num(s.paused)}</b><span>حملات متوقفة</span></div><div class="opx2-card opx2-kpi"><b>${num(s.winners)}</b><span>Winners (شغالة)</span></div><div class="opx2-card opx2-kpi"><b>${num(s.losing)}</b><span>خاسرة 3 أيام متتالية أو أكتر</span></div><div class="opx2-card opx2-kpi"><b>${s.profit ? egp(s.profit.value) : 'غير متوفر'}</b><span>${s.profit ? `ربح تقديري (${s.profit.campaigns} من ${s.profit.of} حملة لها اقتصاديات كاملة)` : 'الربح التقديري: مفيش حملة اقتصادياتها مكتملة'}</span></div></div>
  <div class="opx2-card" style="padding:10px 14px"><div class="opx2-kv"><span>اتصال Meta</span><b>${fresh.lastSyncAt ? pill(syncAge <= 30 ? 'متصل — بيانات حديثة' : syncAge <= 120 ? 'متصل — مزامنة متأخرة' : 'مزامنة متوقفة', syncAge <= 30 ? 'ok' : 'warn') : pill('مفيش مزامنة', 'bad')} <small class="opx2-note">${fresh.lastSyncAt ? ago(fresh.lastSyncAt) : ''}</small></b></div>${g ? `<div class="opx2-kv"><span>حالة الأتمتة (AUTOMATIC)</span><b>${pill(g.mode === 'AUTOPILOT' ? 'تلقائي مفعّل' : 'غير مفعّلة', g.mode === 'AUTOPILOT' ? 'warn' : 'ok')} <small class="opx2-note">الوضع الحالي: ${MODE_AR[g.mode] || E(g.mode)}</small></b></div>` : ''}</div>
  ${g ? emergencyBanner(g, H.ctx.level) : ''}
  ${g ? `<div class="opx2-card"><h2>هل هينفّذ على Meta؟</h2><div class="opx2-layers">
     <div class="opx2-layer"><div class="t">① وضع التشغيل ${pill(MODE_AR[g.mode] || E(g.mode), 'info')}</div><small>مين بيقرر</small></div>
     <div class="opx2-layer"><div class="t">② قفل Meta ${pill(g.writesLocked ? '🔒 مقفول' : '🔓 مفتوح', g.writesLocked ? 'warn' : 'ok')}</div><small>قراءة فقط — مفيش زر بيفتحه</small></div>
     <div class="opx2-layer"><div class="t">③ الصلاحيات ${pill(`${g.permissionsOn} من 4`, g.permissionsOn ? 'ok' : 'warn')}</div><small>فتح · إيقاف · رفع · خفض</small></div></div>
     <div class="opx2-verdict" style="background:var(--${blockers.length ? 'infobg' : 'badbg'});color:var(--${blockers.length ? 'info' : 'bad'})">${blockers.length ? 'ℹ️ مفيش تنفيذ على Meta دلوقتي: ' + E(blockers.join(' · ')) + '. أي إجراء جماعي بيتجهز كمعاينة/خطة للمراجعة فقط.' : '⚠️ التنفيذ ممكن بعد الموافقة وفحص الأمان.'}</div></div>`
    : `<div class="opx2-card"><div class="opx2-banner info">حسابك للعرض فقط — مفيش تنفيذ ولا موافقات من هنا.</div></div>`}
  <div class="opx2-card"><h2>العمليات الجاهزة للمراجعة</h2><div class="opx2-ready">${ready.map(([k, l, ic]) => `<button class="opx2-rc" data-view="${k}"><span>${ic} ${l}</span><b>${num(d.viewCounts[k])}</b><span>ميزانية معرّضة: ${egp(d.viewExposure[k])}</span></button>`).join('')}</div>
    <p class="opx2-note" style="margin:8px 0 0">«مرشح» ≠ «جاهز للمراجعة» ≠ «معتمد» ≠ «مسموح بتنفيذه» ≠ «تم» ≠ «تعذّر» — كل خطوة منفصلة ومتسجلة. الأعداد دي من نتايج المحركات الحالية (قرارات مفتوحة، خطط اليوم، حد الصرف المحفوظ).</p></div>
  <div class="opx2-grid opx2-g2">
    <div>${d.todo ? `<div class="opx2-card"><h2>ماذا أفعل الآن؟</h2>${d.todo.length ? `<ol class="opx2-todo">${d.todo.slice(0, 8).map((t) => `<li><span class="n"></span><div class="tx">${E(t.text)}${t.detail ? `<small>${E(t.detail)}</small>` : ''}</div><button class="opx2-btn sm pri" data-sec="${E(t.section)}">روح</button></li>`).join('')}</ol>${d.todo.length > 8 ? `<p class="opx2-note">و${d.todo.length - 8} خطوات كمان.</p>` : ''}` : '<p>مفيش خطوات ناقصة.</p>'}</div>` : ''}
      ${d.policies ? `<div class="opx2-card"><h2>السياسات <span class="opx2-note">(جاهزة = مفعّلة + معتمدة)</span></h2>${d.policies.list.map((p) => `<div class="opx2-kv"><span>${E(p.label)}</span><b>${pill(p.state === 'READY' ? 'جاهزة' : p.state === 'MISSING' ? 'ناقصة' : p.state === 'PARTIAL' ? 'جزئية' : 'غير معتمدة', p.state === 'READY' ? 'ok' : 'warn')} <small class="opx2-note">${E(p.detail)}</small></b></div>`).join('')}<p class="opx2-note" style="margin-top:6px">${d.policies.ready} جاهزة · ${d.policies.incomplete} غير مكتملة</p></div>` : ''}</div>
    <div><div class="opx2-card"><h3>البيانات والاتصال</h3><div class="opx2-kv"><span>آخر مزامنة Meta</span><b>${fresh.lastSyncAt ? `${ago(fresh.lastSyncAt)} ${pill(syncAge <= 30 ? 'حديثة' : 'متأخرة', syncAge <= 30 ? 'ok' : 'warn')}` : '—'}</b></div><div class="opx2-kv"><span>حملات بياناتها قديمة</span><b>${num(fresh.staleCampaigns)}</b></div><div class="opx2-kv"><span>الحسابات الإعلانية</span><b>${d.accounts.length}</b></div>
      ${d.pending ? `<div class="opx2-kv"><span>قرارات منتظرة</span><b>${num(d.pending.decisions)}</b></div><div class="opx2-kv"><span>خطط منتظرة</span><b>${num(d.pending.plans)}</b></div>` : ''}<p class="opx2-note" style="margin:8px 0 0">${E(d.attribution.note)}</p></div>
      ${d.lastAction ? `<div class="opx2-card"><h3>آخر قرار اتنفّذ</h3><div>${E(d.lastAction.action)} — ${E(d.lastAction.campaign || '—')}</div><div class="opx2-note">${pill(d.lastAction.status === 'FAILED' ? 'فشل' : d.lastAction.verified ? 'اتأكد من Meta' : 'اتبعت — مش متأكد', d.lastAction.status === 'FAILED' ? 'bad' : d.lastAction.verified ? 'ok' : 'warn')} ${d.lastAction.at ? ago(d.lastAction.at) : ''}${d.lastAction.reason ? ' — ' + E(String(d.lastAction.reason).slice(0, 120)) : ''}</div></div>` : ''}</div></div>`;
  bindTimebar(host, H.st, () => load());
  host.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => H.ctx.go('camps', { view: b.dataset.view, period: { ...H.st.period }, compare: H.st.compare }); });
  host.querySelectorAll('[data-sec]').forEach((b) => { b.onclick = () => H.ctx.go(b.dataset.sec); }); void caps;
  const eo = host.querySelector('[data-emoff]'); if (eo) eo.onclick = () => openEmergencyOff(() => load());
}
