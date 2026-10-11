// opx-open-adv.js — «شروط متقدمة لسياسة الفتح»: scope (include/exclude products · stores · campaigns), weekdays, total-exposure ceiling, minimum stock, manual-pause protection.
// They are part of the SAME versioned opening policy (saving = a new version, approval is separate). Presentation only — the server validates, versions and enforces them at evaluation AND at execution time.
import { api } from './api-client.js';
import { E, ICONS, toast, $ } from './opx-ui.js';

const DAYS = [[6, 'سبت'], [0, 'أحد'], [1, 'اتنين'], [2, 'تلات'], [3, 'أربع'], [4, 'خميس'], [5, 'جمعة']];
const list = (s) => String(s || '').split(/[,\n،]/).map((x) => x.trim()).filter(Boolean);
export const advFrom = (pol) => ({ days: pol.days || [], exposure: pol.maxTotalExposure ?? '', minStock: pol.minStock ?? '', protect: pol.protectManualPause?.enabled !== false, protectHours: pol.protectManualPause?.hours ?? 48, inP: (pol.scope?.includeProducts || []).join(', '), exP: (pol.scope?.excludeProducts || []).join(', '), inS: (pol.scope?.includeStores || []).join(', '), exS: (pol.scope?.excludeStores || []).join(', '), inC: (pol.scope?.includeCampaigns || []).join(', '), exC: (pol.scope?.excludeCampaigns || []).join(', ') });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const advDirty = (pol, f) => !!f && !same(f, advFrom(pol));
export function advPanel(pol, f, admin) {
  const dis = admin ? '' : 'disabled'; const dirty = advDirty(pol, f);
  const inp = (id, label, v, mode = 'text') => `<label class="opx-field"><span>${label}</span><input class="opx-input" id="${id}" ${mode === 'num' ? 'inputmode="numeric"' : ''} value="${E(v)}" ${dis}></label>`;
  return `<details class="opx-card opx-cpa opx-fade" id="opxAdv" ${dirty ? 'open' : ''}><summary style="cursor:pointer;font-weight:800;padding:4px 0">شروط متقدمة للسياسة: النطاق · الأيام · سقف التعرّض · المخزون · حماية الإيقاف اليدوي ${pol.maxTotalExposure != null || pol.minStock != null || pol.days ? '<span class="opx-pill violet">مفعّلة</span>' : ''}</summary>
    <div class="opx-cpa-form" style="margin-top:12px">
      <div class="opx-field"><span>أيام الفتح (بتوقيت القاهرة) — فاضي = كل الأيام</span><div class="opx-chips">${DAYS.map(([d, t]) => `<button class="opx-chip ${f.days.includes(d) ? 'on' : ''}" data-adday="${d}" ${dis}>${t}</button>`).join('')}</div></div>
      ${inp('adExp', 'سقف إجمالي الميزانيات المعرضة للصرف (جنيه) — اللي شغال + اللي هيتفتح', f.exposure, 'num')}${inp('adStock', 'الحد الأدنى للمخزون (قطعة)', f.minStock, 'num')}
      <label class="opx-note" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="adProt" ${f.protect ? 'checked' : ''} ${dis}> حماية الإيقاف اليدوي: متفتحش حملة وقّفتها بإيدك خلال آخر</label>${inp('adProtH', 'ساعات الحماية', f.protectHours, 'num')}
      ${inp('adInP', 'منتجات مضمّنة فقط (IDs بفاصلة — فاضي = الكل)', f.inP)}${inp('adExP', 'منتجات مستبعدة', f.exP)}${inp('adInS', 'متاجر مضمّنة فقط', f.inS)}${inp('adExS', 'متاجر مستبعدة', f.exS)}${inp('adInC', 'حملات مضمّنة فقط', f.inC)}${inp('adExC', 'حملات مستبعدة', f.exC)}</div>
    <div id="adErr"></div><div class="opx-cpa-btns"><button class="opx-btn ${dirty ? 'accent' : ''}" id="adSave" ${admin && dirty ? '' : 'disabled'} title="${admin ? (dirty ? '' : 'مفيش تعديلات لحفظها') : 'ADMIN فقط'}">${ICONS.history} حفظ الشروط كنسخة جديدة من السياسة</button></div></details>`;
}
/** wires the panel; `onSaved()` reloads the workspace; `getPol()` returns the saved policy */
export function wireAdv(f, getPol, onSaved) {
  const root = $('opxAdv'); if (!root) return; const upd = () => { const d = advDirty(getPol(), f); const sv = $('adSave'); if (sv) { sv.disabled = !d; sv.classList.toggle('accent', d); } };
  const v = (id, k) => { const el = $(id); if (el) el.oninput = () => { f[k] = el.value; upd(); }; };
  v('adExp', 'exposure'); v('adStock', 'minStock'); v('adProtH', 'protectHours'); v('adInP', 'inP'); v('adExP', 'exP'); v('adInS', 'inS'); v('adExS', 'exS'); v('adInC', 'inC'); v('adExC', 'exC');
  if ($('adProt')) $('adProt').onchange = (e) => { f.protect = e.target.checked; upd(); };
  root.querySelectorAll('[data-adday]').forEach((b) => { b.onclick = () => { const d = Number(b.dataset.adday); f.days = f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d]; b.classList.toggle('on'); upd(); }; });
  if ($('adSave')) $('adSave').onclick = async () => {
    try { const r = await api.put('/api/operator/daily-plan/open-cpa', { days: f.days.length ? f.days : null, maxTotalExposure: f.exposure === '' ? null : Number(f.exposure), minStock: f.minStock === '' ? null : Number(f.minStock), protectManualPause: { enabled: f.protect, hours: Number(f.protectHours) || 48 }, scope: { includeProducts: list(f.inP), excludeProducts: list(f.exP), includeStores: list(f.inS), excludeStores: list(f.exS), includeCampaigns: list(f.inC), excludeCampaigns: list(f.exC) } });
      toast(r.changed ? `اتحفظت نسخة جديدة v${r.policy.version}${r.reconcile?.superseded?.length ? ' — الخطة المعتمدة اتلغت ومحتاجة اعتماد جديد' : ''}. مفيش حملة اتفتحت.` : 'مفيش تغيير يتحفظ', r.reconcile?.superseded?.length ? 'warning' : undefined); await onSaved(); }
    catch (e) { const el = $('adErr'); if (el) el.innerHTML = `<div class="opx-note bad">⚠️ ${E((e.details || [e.message]).join(' '))}</div>`; }
  };
}
