// auth.js — page controller for login.html. On success, redirects to
// ?next=... if present (set by api-client.js when a 401 bounced the user
// here) or index.html otherwise. Account creation now lives on its own
// page (register.html) — every new signup is PENDING until the Owner
// approves it, so login.html no longer has a "first user becomes Admin"
// bootstrap path (that already happened once, for real, and won't recur).
const params = new URLSearchParams(location.search);
const next = params.get('next') || 'index.html';

function init() {
  document.getElementById('btnLogin').onclick = submit;
  document.getElementById('fPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
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
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.message || 'حصل خطأ.';
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
