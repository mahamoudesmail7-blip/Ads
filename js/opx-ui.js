// opx-ui.js — shared presentation helpers for the AI Operator workspaces (icons, KPI cards, pills, drawer, skeletons). No business logic: every rule lives on the server.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

export const E = (s) => UI.escapeHtml(String(s ?? ''));
export const $ = (id) => document.getElementById(id);
export const num = (v, d = 0) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const egp = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : `${num(v)} ج.م`);
export const cairoTime = (iso, opts = { hour: '2-digit', minute: '2-digit' }) => (iso ? new Date(iso).toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', ...opts }) : '—');
export const cairoDateTime = (iso) => (iso ? new Date(iso).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'short', timeStyle: 'short' }) : '—');
export const ago = (iso) => { if (!iso) return '—'; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? 'الآن' : m < 60 ? `منذ ${m} د` : m < 1440 ? `منذ ${Math.round(m / 60)} س` : `منذ ${Math.round(m / 1440)} يوم`; };

const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
export const ICONS = {
  play: ico('<path d="M8 5v14l11-7z"/>'), pause: ico('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
  budget: ico('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
  rules: ico('<path d="M12 3l8 4v5c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/>'),
  approve: ico('<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>'),
  history: ico('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>'),
  bell: ico('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'),
  gear: ico('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  key: ico('<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3"/><path d="M16 7l3 3"/>'),
  compass: ico('<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>'),
  menu: ico('<path d="M4 6h16M4 12h16M4 18h16"/>'), collapse: ico('<path d="M9 6l6 6-6 6"/>'), moon: ico('<path d="M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10z"/>'), sun: ico('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  megaphone: ico('<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 9a4 4 0 0 1 0 6"/>'), cart: ico('<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 12.4a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.5L21.5 8H6"/>'),
  coins: ico('<circle cx="9" cy="9" r="6"/><path d="M15.5 6.2A6 6 0 1 1 6.2 15.5"/>'), target: ico('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>'),
  eye: ico('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'), check: ico('<path d="M5 12l5 5 9-10"/>'), stop: ico('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
  plus: ico('<path d="M12 5v14M5 12h14"/>'), shield: ico('<path d="M12 3l8 4v5c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V7z"/>'), x: ico('<path d="M6 6l12 12M18 6L6 18"/>'), clock: ico('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
};

export function kpiCard({ label, value, icon, tone = 'violet', sub = '' }) { return `<div class="opx-card opx-kpi opx-fade"><div class="opx-kpi-ic ${tone}">${ICONS[icon] || ''}</div><div><b>${value}</b><span>${E(label)}</span>${sub ? `<small style="display:block;color:var(--opx-muted);font-size:11.5px">${sub}</small>` : ''}</div></div>`; }
export const pill = (text, tone = 'gray', title = '') => `<span class="opx-pill ${tone}"${title ? ` title="${E(title)}"` : ''}>${text}</span>`;
export function cpaCell(v, { good = 80, mid = 120, warn = 150 } = {}) { if (v == null || Number.isNaN(Number(v))) return '<span class="opx-cpa none">—</span>'; const n = Number(v); const cls = n <= good ? 'good' : n <= mid ? 'mid' : n <= warn ? 'warn' : 'bad'; return `<span class="opx-cpa ${cls}">${num(n)}</span>`; }
export const skeletonRows = (n = 6) => `<div style="padding:18px;display:flex;flex-direction:column;gap:12px">${Array.from({ length: n }, () => '<div class="opx-skel" style="height:44px"></div>').join('')}</div>`;
export const skeletonCards = (n = 4) => `<div class="opx-kpis">${Array.from({ length: n }, () => '<div class="opx-skel" style="height:86px;border-radius:16px"></div>').join('')}</div>`;

let drawerEls = null;
function ensureDrawer() {
  if (drawerEls && document.body.contains(drawerEls.root)) return drawerEls;
  const root = document.createElement('div'); root.className = 'opx'; root.style.cssText = 'display:contents;border:0;background:none;min-height:0';
  root.innerHTML = '<div class="opx-drawer-bg" id="opxDrawerBg"></div><aside class="opx-drawer" id="opxDrawer" role="dialog" aria-modal="true"></aside>';
  document.body.appendChild(root); drawerEls = { root, bg: root.querySelector('#opxDrawerBg'), panel: root.querySelector('#opxDrawer') };
  drawerEls.bg.onclick = closeDrawer; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  return drawerEls;
}
/** theme tokens live on `.opx`; the drawer root mirrors the shell's theme */
export function openDrawer({ title, body, foot = '', theme }) {
  const d = ensureDrawer(); d.root.dataset.theme = theme || document.querySelector('.opx[data-theme]')?.dataset.theme || 'light';
  d.panel.innerHTML = `<div class="opx-drawer-head"><h2>${title}</h2><button class="opx-btn ghost sm" id="opxDrawerX" aria-label="إغلاق">${ICONS.x}</button></div><div class="opx-drawer-body">${body}</div>${foot ? `<div class="opx-drawer-foot">${foot}</div>` : ''}`;
  d.panel.querySelector('#opxDrawerX').onclick = closeDrawer; d.bg.classList.add('open'); d.panel.classList.add('open'); return d.panel;
}
export function closeDrawer() { if (!drawerEls) return; drawerEls.bg.classList.remove('open'); drawerEls.panel.classList.remove('open'); }
export const toast = UI.toast; export const confirmModal = UI.confirmModal;
export const store = { get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } } };

// ---- product thumbnails: the REAL product image (AmbProduct.image_url, fetched once per product) with a graceful fallback — the initial letter on a tinted tile, also when the image fails to load
const imgCache = new Map(); // productId -> url | null
export const thumb = (productId, name) => `<div class="opx-thumb" data-pid="${productId ?? ''}" aria-hidden="true">${E(String(name || '?').trim().slice(0, 1).toUpperCase())}</div>`;
export async function hydrateThumbs(root) {
  if (!root) return;
  const ids = [...new Set([...root.querySelectorAll('.opx-thumb[data-pid]')].map((e) => e.dataset.pid).filter(Boolean))]; const need = ids.filter((id) => !imgCache.has(id));
  if (need.length) { try { const r = await api.get('/api/operator/product-images', { ids: need.join(',') }); for (const id of need) imgCache.set(id, r.images?.[id] || null); } catch { need.forEach((id) => imgCache.set(id, null)); } }
  root.querySelectorAll('.opx-thumb[data-pid]').forEach((el) => {
    const u = imgCache.get(el.dataset.pid); if (!u || el.querySelector('img')) return;
    const im = new Image(); im.alt = ''; im.decoding = 'async'; // eager on purpose: a detached lazy image is never fetched
    im.onload = () => { el.textContent = ''; el.appendChild(im); el.classList.add('has-img'); }; im.onerror = () => { /* keep the initial */ }; im.src = u;
  });
}
