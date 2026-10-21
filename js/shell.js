// shell.js — the app shell (app.html). One persistent grouped sidebar + top bar + «feature slides»; every page of the system opens INSIDE it (an embedded frame),
// so moving between sections never reloads the menu, keeps one consistent look, and sub-sections (e.g. the AI Media Buyer's) are just slides — not a second menu.
// Routes are hashes:  app.html#/products.html   ·   app.html#/ai-media-buyer.html#launch
import { api } from './api-client.js';
import { logout } from './ui-common.js';
import { visibleGroups, NAV_GROUPS, PAGE_ALIASES, locate } from './nav-config.js';
import { lucide } from './launch-icons.js';

const $ = (id) => document.getElementById(id);
const frame = $('shFrame'); const stage = $('shStage'); const side = $('shSide'); const scrim = $('shScrim');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').replace(/[ً-ْٰ]/g, '').replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase().trim();
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

let user = null; let groups = NAV_GROUPS; let current = { file: '', sub: '' };
const KNOWN = () => new Set([...groups.flatMap((g) => g.items.map((i) => i.href.split('#')[0])), ...Object.keys(PAGE_ALIASES)]);

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const i = raw.indexOf('#');
  const file = (i < 0 ? raw : raw.slice(0, i)) || 'index.html';
  const sub = i < 0 ? '' : raw.slice(i + 1);
  return { file: /^[a-z0-9-]+\.html$/i.test(file) && KNOWN().has(file) ? file : 'index.html', sub: /^[a-z0-9_-]*$/i.test(sub) ? sub : '' };
}
const routeHref = (file, sub) => `#/${file}${sub ? `#${sub}` : ''}`;

/* ------------------------------------------------------------------ navigation rendering */
const chev = '<svg class="sh-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
function itemHtml(it) {
  const hasKids = Array.isArray(it.children) && it.children.length;
  const href = routeHref(it.href.split('#')[0], '');
  return `<div class="sh-itemwrap" data-key="${esc(it.key)}">
    <a class="sh-item" href="${href}" data-key="${esc(it.key)}" title="${esc(it.label)}">${it.icon}<span class="sh-label">${esc(it.label)}</span>${it.badgeId ? `<span class="sh-badge" data-badge="${esc(it.badgeId)}" hidden></span>` : ''}${hasKids ? `<button type="button" class="sh-twist" data-twist="${esc(it.key)}" aria-label="أقسام ${esc(it.label)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>` : ''}</a>
    ${hasKids ? `<div class="sh-children" data-kids="${esc(it.key)}">${it.children.map((c, ci) => `<a class="sh-child" style="--i:${ci}" href="${routeHref('ai-media-buyer.html', c.sub)}" data-child="${esc(c.sub)}" data-parent="${esc(it.key)}">${c.icon}<span class="sh-label">${esc(c.label)}</span></a>`).join('')}</div>` : ''}
  </div>`;
}
function renderNav() {
  const closed = JSON.parse(store.get('shGroupsClosed') || '{}');
  $('shNav').innerHTML = groups.map((g) => `<section class="sh-group ${closed[g.id] ? 'closed' : ''}" data-group="${g.id}">
    <button type="button" class="sh-ghead" data-ghead="${g.id}" aria-expanded="${closed[g.id] ? 'false' : 'true'}"><span class="sh-gico">${g.icon}</span><span class="sh-gtxt">${esc(g.label)}</span>${chev}</button>
    <div class="sh-gbody"><div>${g.items.map(itemHtml).join('')}</div></div>
  </section>`).join('');
}
function renderUser() {
  if (!user) { $('shUser').hidden = true; return; }
  const initial = (String(user.name || '?').trim()[0] || '?').toUpperCase();
  const role = { ADMIN: 'مدير النظام', MANAGER: 'مدير', EMPLOYEE: 'موظف' }[user.role] || user.role || '';
  $('shUser').innerHTML = `<span class="sh-avatar">${esc(initial)}</span><span class="sh-uinfo"><b>${esc(user.name)}</b><small>${esc(role)}</small></span><button type="button" class="sh-iconbtn" id="shLogout" aria-label="تسجيل الخروج" title="تسجيل الخروج"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></button>`;
  $('shLogout').addEventListener('click', logout);
}

/* ------------------------------------------------------------------ active state, breadcrumb, slides */
function setActive(file, sub) {
  const loc = locate(file, sub ? `#${sub}` : '', groups);
  document.querySelectorAll('.sh-item.active, .sh-child.active').forEach((e) => { e.classList.remove('active'); e.removeAttribute('aria-current'); });
  document.querySelectorAll('.sh-group.has-active').forEach((e) => e.classList.remove('has-active'));
  if (!loc) { $('shCrumb').innerHTML = ''; $('shSlides').hidden = true; return; }
  const { group, item } = loc;
  const effectiveSub = item.children ? (sub || 'home') : '';
  const link = document.querySelector(`.sh-item[data-key="${CSS.escape(item.key)}"]`);
  if (link) { link.classList.add('active'); link.setAttribute('aria-current', 'page'); }
  if (item.children) {
    const kidsEl = document.querySelector(`.sh-children[data-kids="${CSS.escape(item.key)}"]`);
    if (kidsEl) kidsEl.classList.add('open');
    link?.classList.add('subopen');
    const kid = document.querySelector(`.sh-child[data-child="${CSS.escape(effectiveSub)}"]`);
    if (kid) { kid.classList.add('active'); kid.setAttribute('aria-current', 'page'); link?.classList.remove('active'); }
  }
  const sec = document.querySelector(`.sh-group[data-group="${group.id}"]`);
  if (sec) { sec.classList.add('has-active'); sec.classList.remove('closed'); sec.querySelector('.sh-ghead')?.setAttribute('aria-expanded', 'true'); }
  const kidLabel = item.children ? (item.children.find((c) => c.sub === effectiveSub)?.label || '') : '';
  $('shCrumb').innerHTML = `<span class="ci">${item.children ? (item.children.find((c) => c.sub === effectiveSub)?.icon || item.icon) : item.icon}</span><span class="grp">${esc(group.label)}</span><span class="sep">›</span>${item.children ? `<span class="grp">${esc(item.label)}</span><span class="sep">›</span>` : ''}<b>${esc(kidLabel || item.label)}</b>`;
  document.title = `${kidLabel || item.label} — AI Media Buyer`;
  document.documentElement.style.setProperty('--sh-acc', group.accent || '#4f7cff'); // the whole frame (crumb, chips, glow) takes the section's colour
  const crumb = $('shCrumb'); crumb.classList.remove('swap'); void crumb.offsetWidth; crumb.classList.add('swap');
  renderSlides(loc, effectiveSub);
}

function renderSlides(loc, effectiveSub) {
  const { group, item } = loc;
  const chips = item.children
    ? item.children.map((c) => ({ href: routeHref('ai-media-buyer.html', c.sub), icon: c.icon, label: c.label, active: c.sub === effectiveSub }))
    : group.items.map((i) => ({ href: routeHref(i.href.split('#')[0], ''), icon: i.icon, label: i.label, active: i.key === item.key }));
  const box = $('shSlides');
  if (chips.length < 2) { box.hidden = true; return; }
  box.hidden = false;
  $('shTrack').innerHTML = chips.map((c, ci) => `<a class="sh-chip ${c.active ? 'active' : ''}" style="--i:${Math.min(ci, 14)}" href="${c.href}" role="tab" aria-selected="${c.active}">${c.icon}<span>${esc(c.label)}</span></a>`).join('');
  requestAnimationFrame(() => { $('shTrack').querySelector('.sh-chip.active')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' }); updateArrows(); });
}
function updateArrows() {
  const t = $('shTrack'); const max = t.scrollWidth - t.clientWidth; const pos = Math.abs(t.scrollLeft);
  $('shSlidePrev').disabled = pos <= 2; $('shSlideNext').disabled = pos >= max - 2;
}

/* ------------------------------------------------------------------ routing + the page frame */
function frameFile() { try { return frame.contentWindow.location.pathname.split('/').pop(); } catch { return ''; } }
function navigate() {
  const { file, sub } = parseHash();
  setActive(file, sub);
  const same = frameFile() === file && frame.contentWindow;
  if (same) {
    if ((frame.contentWindow.location.hash || '').replace(/^#/, '') !== sub) { try { frame.contentWindow.location.hash = sub; } catch { /* cross-origin never happens here */ } }
    current = { file, sub }; return;
  }
  current = { file, sub };
  stage.classList.add('loading', 'routing'); stage.classList.remove('ready');
  frame.src = `${file}?embed=1${sub ? `#${sub}` : ''}`;
}
function onFrameLoad() {
  let loc; try { loc = frame.contentWindow.location; } catch { return; }
  const file = loc.pathname.split('/').pop();
  if (loc.href === 'about:blank' || !/\.html$/i.test(file)) return; // the frame's own initial blank load: not a page — must never rewrite the route
  stage.classList.remove('loading', 'routing'); stage.classList.add('ready');
  if (file === 'login.html') { window.location.href = 'login.html'; return; } // the session ended inside the frame → leave the shell
  const sync = () => {
    const sub = (frame.contentWindow.location.hash || '').replace(/^#/, '');
    current = { file, sub };
    const want = routeHref(file, sub);
    if (location.hash !== want) history.replaceState(null, '', want);
    setActive(file, sub);
  };
  sync();
  try { frame.contentWindow.addEventListener('hashchange', sync); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ search */
function runSearch(q) {
  const nq = norm(q);
  const navEl = $('shNav');
  if (!nq) { renderNav(); setActive(current.file, current.sub); loadBadges(); return; }
  const hits = [];
  for (const g of groups) for (const it of g.items) {
    if (norm(it.label).includes(nq)) hits.push({ href: routeHref(it.href.split('#')[0], ''), icon: it.icon, label: it.label, where: g.label });
    for (const c of it.children || []) if (norm(c.label).includes(nq)) hits.push({ href: routeHref('ai-media-buyer.html', c.sub), icon: c.icon, label: c.label, where: `${it.label}` });
  }
  const mark = (t) => { const i = norm(t).indexOf(nq); return i < 0 ? esc(t) : `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + q.trim().length))}</mark>${esc(t.slice(i + q.trim().length))}`; };
  navEl.innerHTML = hits.length ? hits.map((h) => `<a class="sh-item sh-hit" href="${h.href}" title="${esc(h.where)}">${h.icon}<span class="sh-label">${mark(h.label)}<small style="display:block;color:var(--sh-faint-on-navy);font-size:10.5px;font-weight:600">${esc(h.where)}</small></span></a>`).join('') : '<div class="sh-empty">مفيش نتيجة بالاسم ده.</div>';
}

async function loadBadges() {
  if (!groups.some((g) => g.items.some((i) => i.badgeId))) return;
  try {
    const { count } = await api.get('/api/lost-orders/new-count');
    if (count > 0) document.querySelectorAll('[data-badge="navLostOrdersBadge"]').forEach((b) => { b.textContent = count; b.hidden = false; });
  } catch { /* non-critical */ }
}

/* ------------------------------------------------------------------ wiring */
function closeDrawer() { side.classList.remove('open'); scrim.classList.remove('open'); setTimeout(() => { if (!scrim.classList.contains('open')) scrim.hidden = true; }, 260); }
function openDrawer() { scrim.hidden = false; requestAnimationFrame(() => { side.classList.add('open'); scrim.classList.add('open'); }); }

function wire() {
  $('shNav').addEventListener('click', (e) => {
    const twist = e.target.closest('[data-twist]');
    if (twist) { e.preventDefault(); e.stopPropagation(); const k = twist.dataset.twist; document.querySelector(`.sh-children[data-kids="${CSS.escape(k)}"]`)?.classList.toggle('open'); twist.closest('.sh-item')?.classList.toggle('subopen'); return; }
    const head = e.target.closest('[data-ghead]');
    if (head) {
      const sec = head.closest('.sh-group'); sec.classList.toggle('closed'); head.setAttribute('aria-expanded', String(!sec.classList.contains('closed')));
      const closed = JSON.parse(store.get('shGroupsClosed') || '{}'); closed[sec.dataset.group] = sec.classList.contains('closed'); store.set('shGroupsClosed', JSON.stringify(closed)); return;
    }
    if (e.target.closest('a')) { closeDrawer(); if ($('shSearch').value) { $('shSearch').value = ''; setTimeout(() => runSearch(''), 0); } }
  });
  $('shCollapse').addEventListener('click', () => { const c = document.documentElement.classList.toggle('sh-collapsed'); store.set('shellCollapsed', c ? '1' : '0'); });
  $('shBurger').addEventListener('click', openDrawer);
  scrim.addEventListener('click', closeDrawer);
  $('shSearch').addEventListener('input', (e) => runSearch(e.target.value));
  $('shSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = $('shNav').querySelector('.sh-hit'); if (first) { location.hash = first.getAttribute('href'); $('shSearch').value = ''; runSearch(''); closeDrawer(); } } if (e.key === 'Escape') { $('shSearch').value = ''; runSearch(''); $('shSearch').blur(); } });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (document.documentElement.classList.contains('sh-collapsed')) $('shCollapse').click(); $('shSearch').focus(); $('shSearch').select(); }
    if (e.key === 'Escape') closeDrawer();
  });
  $('shReload').addEventListener('click', () => { stage.classList.add('loading'); stage.classList.remove('ready'); try { frame.contentWindow.location.reload(); } catch { frame.src = frame.src; } });
  $('shNewTab').addEventListener('click', () => window.open(`${current.file}${current.sub ? `#${current.sub}` : ''}`, '_blank', 'noopener'));
  $('shTheme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; store.set('theme', next);
    try { frame.contentDocument.documentElement.dataset.theme = next; } catch { /* ignore */ }
  });
  $('shSlidePrev').addEventListener('click', () => $('shTrack').scrollBy({ left: $('shTrack').clientWidth * 0.7 }));
  $('shSlideNext').addEventListener('click', () => $('shTrack').scrollBy({ left: -$('shTrack').clientWidth * 0.7 }));
  $('shTrack').addEventListener('scroll', updateArrows, { passive: true });
  window.addEventListener('resize', updateArrows);
  window.addEventListener('hashchange', navigate);
  frame.addEventListener('load', onFrameLoad);
}

async function boot() {
  try { user = await api.get('/api/auth/me'); groups = visibleGroups(user); } catch { user = null; groups = NAV_GROUPS; } // api-client already sends a logged-out visitor to login.html
  renderNav(); renderUser(); wire(); loadBadges();
  if (!location.hash) history.replaceState(null, '', '#/index.html');
  navigate();
}
boot();
