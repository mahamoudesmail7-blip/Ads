// auth.js — page controller for login.html. On success, redirects to
// ?next=... if present (set by api-client.js when a 401 bounced the user
// here) or index.html otherwise. Account creation now lives on its own
// page (register.html) — every new signup is PENDING until the Owner
// approves it, so login.html no longer has a "first user becomes Admin"
// bootstrap path (that already happened once, for real, and won't recur).
import { mountThemeToggle } from './theme.js';

const params = new URLSearchParams(location.search);
// Everything now opens inside the app shell (app.html). A «next» that points at one of the pages goes to its shell route; anything that is not a plain
// same-site page name is ignored (no open redirect) and the shell home is used.
function safeNext(raw) {
  const m = /^\/?([a-z0-9-]+\.html)(?:\?[^#]*)?(#.*)?$/i.exec(String(raw || ''));
  if (!m) return 'app.html';
  const file = m[1].toLowerCase();
  if (file === 'login.html' || file === 'register.html') return 'app.html';
  if (file === 'app.html') return m[2] && /^#\/[a-z0-9-]+\.html(#[a-z0-9_-]+)?$/i.test(m[2]) ? `app.html${m[2]}` : 'app.html'; // keep the shell route the session expired on
  return `app.html#/${file}${m[2] || ''}`;
}
const next = safeNext(params.get('next'));

async function init() {
  mountThemeToggle();
  document.getElementById('btnLogin').onclick = submit;
  document.getElementById('fPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  // A raw fetch, not api-client's wrapper — its global 401 handler is built
  // to redirect AWAY from login.html on failure, not to be called FROM it;
  // here a 401 is the expected/normal case (nobody logged in yet) and must
  // just fall through to showing the form, not trigger any redirect.
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.ok) location.href = next;
  } catch {
    // Backend unreachable — let the user try the form; submit() will surface the real error.
  }
}

async function submit() {
  const email = document.getElementById('fEmail').value.trim();
  const password = document.getElementById('fPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';

  if (!email || !password) {
    errEl.textContent = 'لازم تملأ الإيميل وكلمة السر.';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btnLogin');
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({})); // a non-JSON answer (proxy page, rate limit) must not read as «the server is down»
    if (!res.ok) {
      errEl.textContent = data.message || (res.status === 429 ? 'محاولات دخول كتير — استنى 10 دقايق وجرّب تاني. (السيرفر شغال)' : `حصل خطأ (${res.status}).`);
      errEl.style.display = 'block';
      btn.disabled = false;
      return;
    }
    location.href = next;
  } catch {
    errEl.textContent = 'مقدرش أوصل للسيرفر. اتأكد إن السيرفر شغال.';
    errEl.style.display = 'block';
    btn.disabled = false;
  }
}

init();
