// buyer-notify.js — «تنبيه شغل الميديا باير»: a Shopify-style alert for the OWNER whenever a media buyer creates a campaign (test / scale) or acts on his own task.
// Lives in the app shell, so it fires whichever page is open. It only READS /api/ai-media-buyer/buyer-activity/feed (owner-only; anybody else gets 403 and the poller stops for good).
// What is «new»: ids this browser has not announced yet today. The first load of a day only records what already exists (no flood of old news).
import { api } from './api-client.js';
import { renderOrderSound } from './order-sound.js';

const POLL_MS = 45_000; const SEEN_CAP = 400; const MAX_TOASTS = 3; const TOAST_MS = 9_000;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

/** Pure: the Arabic headline + detail line + icon kind of one feed event. */
export function describeEvent(e) {
  const who = e.who || 'ميديا باير';
  if (e.kind === 'CAMPAIGN') {
    const what = e.type === 'SCALE' ? 'اسكيل جديد' : e.type === 'TEST' ? 'تيست جديد' : 'كامبين جديد';
    return { icon: e.type === 'SCALE' ? 'scale' : 'test', head: `${who} عمل ${what}`, line: [e.title, e.account].filter(Boolean).join(' · ') };
  }
  const head = e.action === 'SUBMITTED' ? `${who} بعت إثبات مهمة` : e.action === 'STARTED' ? `${who} بدأ مهمة` : e.action === 'NOT_DONE' ? `${who} قال إن مهمة ماتعملتش` : `${who} عمل حاجة في مهمة`;
  return { icon: 'task', head, line: e.title || '' };
}
/** Pure: the order sound rings only when a CAMPAIGN (test / scale / other) was created in the batch — task alerts show silently. */
export function shouldPlaySound(events) { return (events || []).some((e) => e?.kind === 'CAMPAIGN'); }
/** Pure: the events not announced yet, oldest first (so the toasts read in the order things happened). */
export function pickNew(events, seen) { const s = new Set(seen); return (events || []).filter((e) => e?.id && !s.has(e.id)).slice().sort((a, b) => String(a.at).localeCompare(String(b.at))); }

const ICON = {
  test: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
  scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>',
  task: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (iso) => { try { return new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' }).format(new Date(iso)); } catch { return ''; } };

let audio = null; let orderBuf = null;
/** THE order sound — a loud cash-register «ka-CHING» (js/order-sound.js renders it as samples, so what is previewed is exactly what plays). The ONLY sound the alerts make — one for a test, a scale or any new campaign; a task alert is silent.
 *  Browsers may block audio until the page was clicked once; then it is silently skipped. Returns true when it was started. */
export function playOrderSound({ force = false } = {}) {
  if (!force && store.get('bn.sound') === '0') return false;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume().catch(() => {});
    if (!orderBuf || orderBuf.sampleRate !== audio.sampleRate) { const pcm = renderOrderSound(audio.sampleRate, 'register'); orderBuf = audio.createBuffer(1, pcm.length, audio.sampleRate); orderBuf.copyToChannel(pcm, 0); }
    const src = audio.createBufferSource(); src.buffer = orderBuf; src.connect(audio.destination); src.start(); return true;
  } catch { return false; }
}
const ching = () => playOrderSound();

function box() {
  let b = document.getElementById('bnToasts'); if (b) return b;
  b = document.createElement('div'); b.id = 'bnToasts'; b.className = 'bn-toasts'; b.setAttribute('role', 'status'); b.setAttribute('aria-live', 'polite'); document.body.appendChild(b); return b;
}
function toast({ icon, head, line, at }, { onClick } = {}) {
  const b = box(); const el = document.createElement('button'); el.type = 'button'; el.className = `bn-toast bn-${icon}`;
  el.innerHTML = `<span class="bn-ico">${ICON[icon] || ICON.task}</span><span class="bn-txt"><b>${esc(head)}</b>${line ? `<small>${esc(line)}</small>` : ''}</span><span class="bn-time">${esc(at ? clock(at) : 'دلوقتي')}</span><span class="bn-bar"></span>`;
  const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  el.addEventListener('click', () => { kill(); onClick?.(); });
  b.appendChild(el); while (b.children.length > MAX_TOASTS + 1) b.firstElementChild.remove();
  setTimeout(kill, TOAST_MS);
}
function desktopNotify(items) {
  try {
    if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const d = items.length === 1 ? items[0] : { head: `${items.length} حاجات جديدة من الميديا بايرز`, line: items.map((x) => x.head).slice(0, 3).join(' — ') };
    new Notification(d.head, { body: d.line, tag: 'bn-feed' });
  } catch { /* not allowed */ }
}

let timer = null; let stopped = false; let busy = false;
function seenKey(date) { return `bn.seen.${date}`; }
function loadSeen(date) { try { const v = JSON.parse(store.get(seenKey(date)) || 'null'); return Array.isArray(v) ? v : null; } catch { return null; } }
async function tick(go) {
  if (stopped || busy || document.hidden) return; busy = true;
  try {
    const f = await api.get('/api/ai-media-buyer/buyer-activity/feed');
    const events = f.events || []; let seen = loadSeen(f.date);
    if (seen === null) { store.set(seenKey(f.date), JSON.stringify(events.map((e) => e.id).slice(-SEEN_CAP))); return; } // first look today: just remember what is already there
    const fresh = pickNew(events, seen); if (!fresh.length) return;
    store.set(seenKey(f.date), JSON.stringify([...seen, ...fresh.map((e) => e.id)].slice(-SEEN_CAP)));
    const items = fresh.map((e) => ({ ...describeEvent(e), at: e.at }));
    const shown = items.slice(-MAX_TOASTS); const more = items.length - shown.length;
    if (more > 0) toast({ icon: 'task', head: `و ${more} حاجات تانية جديدة`, line: 'افتح «نظرة سريعة» تشوفهم كلهم' }, { onClick: () => go?.() });
    shown.forEach((it) => toast(it, { onClick: () => go?.() }));
    if (shouldPlaySound(fresh)) ching(); // the order sound is for a campaign / scale that was made — a task alert is silent
    desktopNotify(items);
  } catch (e) {
    if (e?.status === 403 || e?.status === 404) { stopped = true; clearInterval(timer); const bell = document.getElementById('shBell'); if (bell) bell.hidden = true; } // not the owner (or the feed is not on this server): never ask again
  } finally { busy = false; }
}

/** The bell in the top bar: sound on/off + (first click) permission for desktop alerts when the tab is in the background. Shows a sample alert so the owner hears what it will sound like. */
function wireBell(btn) {
  if (!btn) return; btn.hidden = false;
  const paint = () => { const on = store.get('bn.sound') !== '0'; btn.classList.toggle('bn-off', !on); btn.title = on ? 'تنبيهات شغل الميديا بايرز: شغّالة بصوت (دوس لكتم الصوت)' : 'تنبيهات شغل الميديا بايرز: صامتة (دوس لتشغيل الصوت)'; btn.setAttribute('aria-pressed', String(on)); };
  paint();
  btn.addEventListener('click', () => {
    const wasOn = store.get('bn.sound') !== '0'; store.set('bn.sound', wasOn ? '0' : '1'); paint();
    if (wasOn) toast({ icon: 'task', head: 'صوت التنبيه اتقفل', line: 'التنبيهات لسه بتظهر في الركن، بس من غير صوت — دوس على الجرس تفتحه', at: null });
    else { ching(); toast({ icon: 'test', head: 'صوت التنبيه اتفتح', line: 'كده هيرن لما ميديا باير يعمل كامبين أو اسكيل جديد', at: null }); }
    try { if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch { /* ignore */ }
  });
}

/** Called once by the shell after the user is known. Only an ADMIN can be the owner; the server makes the real decision (403 → stop). */
export function startBuyerNotify({ user, onOpen } = {}) {
  if (typeof document === 'undefined' || !user || user.role !== 'ADMIN') return;
  wireBell(document.getElementById('shBell'));
  tick(onOpen); timer = setInterval(() => tick(onOpen), POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(onOpen); });
}
