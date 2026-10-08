// ai-operator-perms.js — «🔐 صلاحيات التنفيذ»: four independent switches (open / pause / budget increase / budget decrease) + the Meta lock state.
// Presentation only. A switch is just a PERMISSION: nothing executes unless the mode is APPROVAL, the deployment write-lock is open (Railway variable — this screen CANNOT open it),
// there is no Emergency Stop and an ADMIN approves each plan/decision. Changing a switch = ADMIN + explicit confirmation + audit (server enforces all of it).
import * as UI from './ui-common.js';
import { api } from './api-client.js';
import { E, S, dt } from './ai-operator-core.js';

const ORDER = ['open', 'pause', 'budgetIncrease', 'budgetDecrease'];
const PROOF_KEY = { open: 'CAMPAIGN_OPEN', pause: 'CAMPAIGN_PAUSE', budgetIncrease: 'BUDGET_INCREASE', budgetDecrease: 'BUDGET_REDUCE' };
const PROOF_CLS = { READY: 'green', UNVERIFIED: 'amber', BLOCKED: 'red' };
const PROOF_AR = { READY: 'اتجرّبت فعليًا ✓', UNVERIFIED: 'لسه ما اتجرّبتش فعليًا على Meta', BLOCKED: 'محظورة' };

export async function drawPerms(body) {
  body.innerHTML = '<div class="amb-loading">جارِ التحميل…</div>';
  const [p, rd, bc] = await Promise.all([api.get('/api/operator/execution-permissions'), api.get('/api/operator/production-readiness').catch(() => null), api.get('/api/operator/budget-caps').catch(() => ({ caps: {} }))]);
  const caps = bc.caps || {};
  const proof = (k) => rd?.functions?.find((f) => f.key === PROOF_KEY[k]);
  const lock = p.lock; const canExecute = !lock.writesLocked && lock.mode === 'APPROVAL' && !lock.emergencyStop;
  body.innerHTML = `<div class="pm-wrap">
    <div class="pm-lock ${lock.writesLocked ? 'locked' : 'open'}">
      <div><b>${lock.writesLocked ? '🔒 كتابة Meta مقفولة' : '🔓 كتابة Meta مفتوحة'}</b>
        <div class="op-sub">${lock.writesLocked ? 'القفل على مستوى النشر (متغير Railway ‏<code>OPERATOR_ALLOW_META_WRITES</code>). الشاشة دي <b>مبتقدرش تفتحه</b> — بتتفتح بقرارك من Railway بس. طول ما هو مقفول، مفيش أي تنفيذ فعلي مهما كانت المفاتيح.' : 'أي اعتماد ADMIN لأكشن مسموح هينفّذ فعليًا على Meta. اقفله من Railway لما تخلص.'}</div></div>
      <div class="pm-chips"><span class="op-pill ${lock.mode === 'APPROVAL' ? 'amber' : lock.mode === 'SHADOW' ? 'blue' : 'gray'}">الوضع: ${E(lock.mode === 'OFF' ? 'MANUAL' : lock.mode)}</span>${lock.emergencyStop ? '<span class="op-pill red">🛑 Emergency Stop</span>' : ''}<span class="op-pill ${canExecute ? 'amber' : 'gray'}">${canExecute ? 'التنفيذ الفعلي ممكن بعد اعتمادك' : 'مفيش تنفيذ فعلي دلوقتي'}</span></div>
    </div>
    <div class="op-sub">كل مفتاح <b>OFF</b> افتراضيًا ومستقل عن التاني. تغيير أي مفتاح محتاج <b>ADMIN</b> + تأكيد صريح ويتسجّل في الـAudit. المفتاح <b>لا ينفّذ</b> حاجة لوحده — هو إذن بس.</div>
    <div class="pm-grid">${ORDER.map((k) => {
      const m = p.meta[k]; const on = p.permissions[k]; const pr = proof(k); const last = p.last[k];
      return `<div class="pm-card ${on ? 'on' : ''}"><div class="pm-head"><h3>${m.icon} ${E(m.label)}</h3><span class="op-pill ${on ? 'amber' : 'gray'}">${on ? 'ON' : 'OFF'}</span></div>
        <div class="op-sub">${E(m.desc)}</div>
        ${pr ? `<div class="pm-proof"><span class="op-pill ${PROOF_CLS[pr.status] || 'gray'}">${E(PROOF_AR[pr.status] || pr.status)}</span></div>` : ''}
        ${on && lock.writesLocked ? '<div class="pm-warn">مفعّل لكن كتابة Meta مقفولة — مفيش تنفيذ فعلي.</div>' : ''}
        <div class="pm-foot"><small>${last ? `آخر تغيير: ${last.on ? 'ON' : 'OFF'} · ${E(dt(last.at))}` : 'ما اتغيّرش من قبل'}</small>
          <button class="amb-btn ${on ? '' : 'orange'}" data-perm="${k}" data-on="${on ? 0 : 1}" ${S.isAdmin ? '' : 'disabled'} title="${S.isAdmin ? '' : 'ADMIN فقط'}">${on ? 'إيقاف الصلاحية' : 'تفعيل الصلاحية'}</button></div></div>`;
    }).join('')}</div>
    <div class="pm-caps"><h3>💰 حدود الميزانية اليومية (Caps)</h3><div class="op-sub">سقف لإجمالي الميزانية اليومية. بتحدّ <b>الزيادة</b> بس (التقليل مش بيخالف أي حد). فاضي = بدون حد. تغييرها ADMIN + تأكيد + Audit.</div>
      <div class="pm-capfields">${[['campaign', 'الحملة'], ['product', 'المنتج'], ['account', 'الحساب كله']].map(([k, l]) => `<label>${l}<input type="number" min="1" step="50" id="cap_${k}" value="${caps[k] ?? ''}" placeholder="بدون حد" ${S.isAdmin ? '' : 'disabled'}></label>`).join('')}<button class="amb-btn orange" id="capSave" ${S.isAdmin ? '' : 'disabled'}>حفظ الحدود</button></div></div>
    <details class="pm-hist"><summary>🧾 سجل التغييرات (${p.history.length})</summary>
      <ul class="dp-audit">${p.history.map((h) => `<li><time>${E(dt(h.at))}</time> ${E(h.note || '')} <small>(مستخدم #${h.actorId ?? '—'})</small></li>`).join('') || '<li>لا يوجد.</li>'}</ul></details>
  </div>`;
  const saveBtn = body.querySelector('#capSave'); if (saveBtn) saveBtn.onclick = async () => {
    const next = Object.fromEntries(['campaign', 'product', 'account'].map((k) => [k, body.querySelector(`#cap_${k}`).value.trim() === '' ? null : Number(body.querySelector(`#cap_${k}`).value)]));
    if (!(await UI.confirmModal({ title: '💰 حفظ حدود الميزانية', message: `الحملة: ${next.campaign ?? 'بدون حد'} · المنتج: ${next.product ?? 'بدون حد'} · الحساب: ${next.account ?? 'بدون حد'}. أي زيادة ميزانية هتتجاوز حد منهم هتتمنع (مع إعادة التحقق لحظة التنفيذ).`, confirmLabel: 'حفظ' }))) return;
    try { await api.put('/api/operator/budget-caps', { caps: next, confirm: true }); UI.toast('اتحفظت الحدود'); await drawPerms(body); } catch (e) { UI.toast(e.message, 'error'); }
  };
  body.querySelectorAll('[data-perm]').forEach((b) => {
    b.onclick = async () => {
      const key = b.dataset.perm; const turnOn = b.dataset.on === '1'; const m = p.meta[key];
      const msg = turnOn
        ? `تفعيل «${m.label}»؟ ده إذن بس: أي تنفيذ فعلي لسه محتاج وضع APPROVAL + كتابة Meta مفتوحة من Railway + اعتمادك لكل خطة/قرار. ${lock.writesLocked ? 'دلوقتي كتابة Meta مقفولة فمفيش تنفيذ.' : '⚠️ كتابة Meta مفتوحة دلوقتي — اعتمادك بعد كده بينفّذ فعليًا.'}`
        : `إيقاف «${m.label}»؟ أي خطة/قرار من النوع ده هيتمنع من التنفيذ.`;
      if (!(await UI.confirmModal({ title: `${m.icon} ${turnOn ? 'تفعيل' : 'إيقاف'} صلاحية ${m.label}`, message: msg, confirmLabel: turnOn ? 'نعم، فعّل' : 'نعم، أوقف', danger: turnOn }))) return;
      try { await api.put(`/api/operator/execution-permissions/${key}`, { on: turnOn, confirm: true }); UI.toast(turnOn ? 'اتفعّلت (إذن فقط)' : 'اتقفلت'); await drawPerms(body); } catch (e) { UI.toast(e.message, 'error'); }
    };
  });
}
