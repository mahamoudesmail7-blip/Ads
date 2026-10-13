// opx2-safety.js — AI Operator V2 emergency stop (uses the EXISTING /api/operator/emergency-stop routes; nothing new on the server).
// POST (manager / admin) turns the stop ON — it blocks every new Meta execution at the gate and never pauses a campaign or changes a budget. DELETE (admin only) turns it OFF.
import { api } from './api-client.js';
import { E, toast, openModal, closeAll, modalEl } from './opx2-ui.js';

export function openEmergencyStop(onDone) {
  openModal(`<div style="max-width:540px;margin:0 auto"><h2>🛑 إيقاف الطوارئ</h2>
    <p>ده بيمنع <b>أي تنفيذ جديد على Meta فورًا</b> — حتى لو الاعتماد والصلاحيات مفتوحين — لحد ما المسؤول يلغيه.</p>
    <p class="opx2-note">مش بيوقف حملات شغالة ومش بيغيّر ميزانيات، ومش بيمسح خطط أو قرارات. بيتسجّل في سجل التدقيق وبيتبعت تنبيه.</p>
    <div class="opx2-fld"><label style="flex:1">السبب (اختياري) <input id="o2EmReason" maxlength="200" style="width:100%"></label></div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="opx2-btn pri" id="o2EmGo" style="background:var(--bad);border-color:var(--bad)">تأكيد: وقّف أي تنفيذ</button><button class="opx2-btn" id="o2EmNo">إلغاء</button></div></div>`);
  const m = modalEl(); m.querySelector('#o2EmNo').onclick = closeAll;
  m.querySelector('#o2EmGo').onclick = async (e) => { e.target.disabled = true; try { await api.post('/api/operator/emergency-stop', { reason: m.querySelector('#o2EmReason').value.trim() || null }); toast('إيقاف الطوارئ اتفعّل — مفيش تنفيذ جديد على Meta'); closeAll(); onDone?.(); } catch (err) { e.target.disabled = false; toast(err.message || 'تعذّر تفعيل إيقاف الطوارئ.', 'error'); } };
}
export function openEmergencyOff(onDone) {
  openModal(`<div style="max-width:520px;margin:0 auto"><h2>إلغاء إيقاف الطوارئ</h2><p>الإلغاء بيرجّع بوابة التنفيذ لحالتها العادية: التنفيذ لسه محتاج اعتماد وصلاحيات ووضع تشغيل مناسب، لكن الإيقاف الاستثنائي هيتشال.</p><p class="opx2-note">للمسؤول فقط ومسجّل في التدقيق.</p>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="opx2-btn pri" id="o2EmOff">تأكيد الإلغاء</button><button class="opx2-btn" id="o2EmNo">رجوع</button></div></div>`);
  const m = modalEl(); m.querySelector('#o2EmNo').onclick = closeAll;
  m.querySelector('#o2EmOff').onclick = async (e) => { e.target.disabled = true; try { await api.delete('/api/operator/emergency-stop'); toast('اتلغى إيقاف الطوارئ'); closeAll(); onDone?.(); } catch (err) { e.target.disabled = false; toast(err.message || 'تعذّر إلغاء إيقاف الطوارئ.', 'error'); } };
}
export const emergencyBanner = (g, level) => (g?.emergencyStop ? `<div class="opx2-stop"><b>🛑 إيقاف الطوارئ مفعّل</b> — مفيش أي تنفيذ جديد على Meta لحد ما يتلغى.${level === 'ADMIN' ? ' <button class="opx2-btn sm" data-emoff="1">إلغاء الإيقاف (مسؤول)</button>' : ' (الإلغاء للمسؤول فقط)'}</div>` : '');
void E;
