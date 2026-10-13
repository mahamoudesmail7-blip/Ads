// opx2-access.js — AI Operator V2: the ADMIN screen that decides which EMPLOYEE sees which ad accounts / stores in the campaign center, and whether they may review / prepare DRAFTS.
// The server enforces everything (/api/operator-v2/admin/users — ADMIN only). There is deliberately NO switch for approving or executing: those stay with the role (ADMIN) and the existing gates.
import { api } from './api-client.js';
import { E, pill, toast, skeleton, errorCard, openModal, closeAll, modalEl } from './opx2-ui.js';

const A = { host: null, ctx: null, data: null };
export function stopAccess() { A.host = null; }
const LVL = { ADMIN: 'مسؤول', MANAGER: 'مشرف', EMPLOYEE: 'موظف' };

export async function mountAccess(host, ctx) {
  A.host = host; A.ctx = ctx; host.innerHTML = `<h1>صلاحيات الموظفين</h1><div class="opx2-card">${skeleton(5, 40)}</div>`;
  try { A.data = await api.get('/api/operator-v2/admin/users'); } catch (e) { host.innerHTML = errorCard(e.message || 'تعذّر تحميل المستخدمين.'); host.querySelector('#o2Retry').onclick = () => mountAccess(host, ctx); return; }
  draw();
}
const grantPills = (g) => (!g.view ? pill('بدون وصول', 'gray') : `${pill(`${g.accounts.length} حساب`, 'info')} ${g.stores.length ? pill(`${g.stores.length} متجر`, 'info') : pill('كل المتاجر', 'gray')} ${g.review ? pill('مراجعة', 'ok') : ''} ${g.drafts ? pill('مسودات', 'ok') : ''} ${pill('عرض وتصدير', 'gray')}`);
function draw() {
  const host = A.host; if (!host) return; const d = A.data; const emp = d.users.filter((u) => u.editable); const other = d.users.filter((u) => !u.editable);
  host.innerHTML = `<div class="opx2-acc"><button class="opx2-btn sm" id="o2AccBack">← الإعدادات والأمان</button><h1>صلاحيات الموظفين</h1>
    <p class="lead">حدّد كل موظف يشوف أنهي حسابات ومتاجر في مركز الحملات، وهل يقدر يراجع ويجهّز مسودات.</p>
    <div class="opx2-banner info">🔒 من هنا <b>مفيش</b> اعتماد ولا تنفيذ ولا تعديل سياسات: الموظف بيشوف ويصدّر فقط (ولو اتمنح المراجعة/المسودات بيجهّز بس ومفيش اعتماد). الاعتماد والتنفيذ للمسؤول وبعد بوابات الأمان. كل تغيير بيتسجّل في سجل التدقيق وبيسري فورًا، وإلغاء الوصول بيسري فورًا.</div>
    <div class="opx2-card"><h2>الموظفون (${emp.length})</h2>${emp.length ? `<div class="opx2-ulist">${emp.map((u) => `<div class="opx2-urow"><div class="who"><b>${E(u.name)}</b><span class="sub">${E(u.email)}</span></div><div class="gr">${grantPills(u.grants)}${u.grants.view ? `<span class="sub">${E(u.grants.accounts.join('، '))}</span>` : ''}</div><div class="act"><button class="opx2-btn sm pri" data-edit="${u.id}">تعديل</button> ${u.grants.view ? `<button class="opx2-btn sm" data-revoke="${u.id}">إلغاء الوصول</button>` : ''}</div></div>`).join('')}</div>` : '<p class="mut">مفيش موظفين نشطين.</p>'}</div>
    <div class="opx2-card"><h3>المشرفون والمسؤولون (مش بيتعدلوا من هنا)</h3><p class="opx2-note">صلاحياتهم من دورهم: المسؤول بيعتمد وبيدير السياسات والأتمتة؛ المشرف بيجهّز ويراجع ويحفظ المسودات بدون اعتماد أو تنفيذ.</p>${other.map((u) => `<div class="opx2-kv"><span>${E(u.name)} <small class="mut">${E(u.email)}</small></span><b>${pill(LVL[u.level] || E(u.level), u.level === 'ADMIN' ? 'brandp' : 'info')}</b></div>`).join('') || '<p class="mut">—</p>'}</div></div>`;
  host.querySelector('#o2AccBack').onclick = () => A.ctx.go('set');
  host.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => edit(Number(b.dataset.edit)); });
  host.querySelectorAll('[data-revoke]').forEach((b) => { b.onclick = () => revoke(Number(b.dataset.revoke)); });
}
async function save(id, body, okMsg) {
  try { await api.put(`/api/operator-v2/admin/users/${id}/grants`, body); toast(okMsg); A.data = await api.get('/api/operator-v2/admin/users'); closeAll(); draw(); } catch (e) { toast(e.message || 'تعذّر حفظ الصلاحيات.', 'error'); }
}
function revoke(id) {
  const u = A.data.users.find((x) => x.id === id); if (!u) return;
  openModal(`<div style="max-width:460px;margin:0 auto"><h2>إلغاء الوصول</h2><p>هيتشال وصول <b>${E(u.name)}</b> لمركز الحملات بالكامل (الحسابات والمراجعة والمسودات). باقي صلاحياته في النظام ما بتتغيّرش.</p><div style="display:flex;gap:8px"><button class="opx2-btn pri" id="o2Rv">تأكيد الإلغاء</button><button class="opx2-btn" id="o2RvNo">رجوع</button></div></div>`);
  const m = modalEl(); m.querySelector('#o2RvNo').onclick = closeAll; m.querySelector('#o2Rv').onclick = () => save(id, { view: false }, 'اتلغى وصول الموظف');
}
function edit(id) {
  const u = A.data.users.find((x) => x.id === id); if (!u) return; const g = u.grants;
  const box = (name, val, label, on, dis = false) => `<label style="display:flex;gap:8px;align-items:center;padding:3px 0"><input type="checkbox" data-${name}="${E(val)}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''}> ${E(label)}</label>`;
  openModal(`<div style="max-width:560px;margin:0 auto"><h2>صلاحيات: ${E(u.name)}</h2>
    <div class="opx2-card" style="padding:12px">${box('flag', 'view', 'يشوف مركز الحملات (عرض وتصدير فقط)', g.view)}
    <div style="margin:6px 22px"><b>الحسابات الإعلانية المسموحة</b>${A.data.accounts.length ? A.data.accounts.map((a) => box('acc', a, a, g.accounts.includes(a))).join('') : '<p class="mut">مفيش حسابات معروفة.</p>'}</div>
    <div style="margin:6px 22px"><b>المتاجر (اختياري — لو ما اخترتش يشوف كل متاجر الحسابات دي)</b>${A.data.stores.map((s) => box('sto', s, s, g.stores.includes(s))).join('') || '<p class="mut">—</p>'}<p class="opx2-note">لو حددت متجر، الحملات غير المربوطة بمنتج بتتخفي عنه.</p></div>
    ${box('flag', 'review', 'يراجع الإجراءات الجماعية (معاينة فقط)', g.review)}${box('flag', 'drafts', 'يجهّز مسودات (مش اعتماد ومش تنفيذ)', g.drafts)}</div>
    <p class="opx2-note">المسودات محتاجة المراجعة، والمراجعة محتاجة المشاهدة. مفيش اختيار للاعتماد أو التنفيذ هنا.</p>
    <div style="display:flex;gap:8px;margin-top:10px"><button class="opx2-btn pri" id="o2AccSave">حفظ</button><button class="opx2-btn" id="o2AccNo">إلغاء</button></div></div>`);
  const m = modalEl(); const flag = (n) => m.querySelector(`[data-flag="${n}"]`); const sync = () => { const v = flag('view').checked; flag('review').disabled = !v; if (!v) flag('review').checked = false; flag('drafts').disabled = !v || !flag('review').checked; if (flag('drafts').disabled) flag('drafts').checked = false; }; sync();
  ['view', 'review'].forEach((n) => { flag(n).onchange = sync; }); m.querySelector('#o2AccNo').onclick = closeAll;
  m.querySelector('#o2AccSave').onclick = () => {
    const view = flag('view').checked; const accounts = [...m.querySelectorAll('[data-acc]:checked')].map((x) => x.dataset.acc); const stores = [...m.querySelectorAll('[data-sto]:checked')].map((x) => x.dataset.sto);
    if (view && !accounts.length) { toast('اختار حساب إعلاني واحد على الأقل.', 'error'); return; }
    save(id, view ? { view: true, accounts, stores, review: flag('review').checked, drafts: flag('drafts').checked } : { view: false }, 'اتحفظت الصلاحيات وبتسري فورًا');
  };
}
