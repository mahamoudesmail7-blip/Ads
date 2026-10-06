// ai-operator-core.js — shared helpers + state for the AI Operator section (presentation only; every rule lives on the server).
import * as UI from './ui-common.js';

export const E = (s) => UI.escapeHtml(String(s ?? ''));
export const $ = (id) => document.getElementById(id);
export const num = (v, d = 0) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const egp = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : `${num(v)} ج.م`);
export const ago = (iso) => { if (!iso) return '—'; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? 'الآن' : m < 60 ? `منذ ${m} د` : m < 1440 ? `منذ ${Math.round(m / 60)} س` : `منذ ${Math.round(m / 1440)} يوم`; };
export const dt = (iso) => (iso ? new Date(iso).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export const MODES = [
  { key: 'OFF', label: 'MANUAL', hint: 'يدوي — مفيش أكشنز جديدة ولا متأخرة على Meta ومفيش Rollback. المراقبة وتسجيل تعديلاتك اليدوية شغالين.' },
  { key: 'SHADOW', label: 'Shadow', hint: 'بيسجّل اللي كان هيعمله بس — مفيش تنفيذ على Meta.' },
  { key: 'APPROVAL', label: 'بموافقتي', hint: 'بيجهّز القرارات وانت بتوافق قبل أي تنفيذ.' },
  { key: 'AUTOPILOT', label: 'Autopilot', hint: 'بينفّذ لوحده فقط للقواعد المعلّمة Autopilot بعد كل حواجز الأمان وبوابة التفعيل.' },
];
export const ACTION_ICON = { OPEN: '▶️', PAUSE: '⏸️', SCALE_UP: '📈', SCALE_DOWN: '📉', PREPARE_TEST: '🧪' };
export const STATUS_CLS = { SHADOW: 'blue', BLOCKED: 'red', PREPARED: 'amber', APPROVED: 'amber', EXECUTING: 'amber', EXECUTED: 'amber', VERIFIED: 'green', FAILED: 'red', ROLLED_BACK: 'purple', REJECTED: 'gray', SNOOZED: 'gray', EXPIRED: 'gray' };
export const CONF_AR = { HIGH: 'عالية', MEDIUM: 'متوسطة', LOW: 'منخفضة' };
export const PROFIT_AR = { PROFITABLE: 'مربح', MARGIN_THIN: 'هامش ضعيف', BREAK_EVEN: 'تعادل', UNPROFITABLE: 'خسارة', INSUFFICIENT_DATA: 'بيانات قليلة', UNKNOWN: 'غير معروف' };
export const READY_CLS = { READY: 'green', PARTIAL: 'amber', BLOCKED: 'red' };

/** shared mutable UI state + callbacks the main module registers (avoids a circular import) */
export const S = { tab: 'control', ov: null, cfg: null, isAdmin: false, panel: null, busy: false, evaluating: false, poll: null, mapFocus: null, hooks: {} };

export function openDrawer(html) { $('ambDrawerPanel').innerHTML = html; $('ambDrawerOverlay').classList.add('open'); const c = $('opDrawerClose'); if (c) c.onclick = closeDrawer; }
export function closeDrawer() { $('ambDrawerOverlay').classList.remove('open'); }
export const drawerHead = (title) => `<div class="amb-drawer-head"><h2>${title}</h2><button class="amb-btn ghost" id="opDrawerClose">✕</button></div>`;

export function kpi(label, v, tone, sub = '') { return `<div class="amb-kpi op-kpi ${tone}"><div class="k-label">${E(label)}</div><div class="k-val">${v === null || v === undefined ? '—' : num(v)}</div>${sub ? `<div class="op-kpi-sub">${E(sub)}</div>` : ''}</div>`; }
export const fld = (label, k, v, attrs = '') => `<label>${E(label)}<input id="f_${k}" type="number" min="0" step="any" value="${v ?? ''}" ${attrs} /></label>`;
export function condText(c, fields) {
  const one = (x) => `${E(fields[x.field]?.label || x.field)} ${E(x.op)} ${E(Array.isArray(x.value) ? x.value.join('–') : x.value && typeof x.value === 'object' ? `[${x.value.ref}]` : x.value)}`;
  return [...(c.all || []).map(one), ...((c.any || []).length ? [`(أي من: ${(c.any || []).map(one).join(' أو ')})`] : [])].join(' <b>و</b> ');
}

/**
 * "🚫 لا يمكن تنفيذ X — الأسباب • … — إيه المطلوب عشان القرار يتفتح؟ 1. … [setup buttons]" (spec 56/57).
 * Setup buttons carry data-setup + product/campaign so any screen can route the user to the exact fix.
 */
export function blockPanel(d, { compact = false } = {}) {
  const u = d.unblock;
  if (!u || !u.blocked) return '';
  const reasons = u.reasons.map((r) => `<li>${E(r.message)}${r.detail ? ` <small>(${E(r.detail)})</small>` : ''} <code class="op-code">${E((r.specCodes || [r.code]).join(' · '))}</code></li>`).join('');
  const steps = u.steps.map((s) => `<li>${E(s)}</li>`).join('');
  const btns = u.actions.map((a) => `<button class="amb-btn orange sm" data-setup="${E(a.type)}" data-pid="${E(a.productId ?? '')}" data-cid="${E(a.campaignId ?? '')}">${E(a.label)}</button>`).join(' ');
  if (compact) return `<div class="op-block-compact"><b>🚫</b> ${E(u.reasons[0]?.message || '')}${u.reasons.length > 1 ? ` <small>+${u.reasons.length - 1}</small>` : ''}<div>${btns}</div></div>`;
  return `<div class="op-blockpanel"><h4>🚫 لا يمكن تنفيذ ${E(d.actionLabel)}</h4><div class="op-sub" style="margin:0 0 6px">الأسباب:</div><ul class="op-ul">${reasons}</ul>
    <h4>إيه المطلوب عشان القرار يتفتح؟</h4><ol class="op-ol">${steps}</ol><div class="op-setupbtns">${btns}</div></div>`;
}

export function wireSetupButtons(root) {
  root.querySelectorAll('[data-setup]').forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); S.hooks.setupAction?.(b.dataset.setup, { productId: b.dataset.pid ? Number(b.dataset.pid) : null, campaignId: b.dataset.cid || null }); }; });
}
