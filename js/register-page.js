// register-page.js — page controller for register.html. Client-side
// validation mirrors backend/src/routes/auth.js's registerSchema so most
// mistakes are caught before a round-trip, but the backend re-validates
// everything regardless (never trust the client). On success, the account
// is PENDING — this page shows that message in place, it never redirects
// into the app or sets any session.
import { mountThemeToggle } from './theme.js';

function init() {
  mountThemeToggle();
  document.getElementById('btnRegister').onclick = submit;
}

function validate({ name, email, password, confirmPassword, dob }) {
  if (!name) return 'الاسم مطلوب.';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'صيغة البريد الإلكتروني غير صحيحة.';
  if (!dob) return 'تاريخ الميلاد مطلوب.';
  if (new Date(dob).getTime() > Date.now()) return 'تاريخ الميلاد مينفعش يكون في المستقبل.';
  if (!password || password.length < 8) return 'كلمة المرور لازم تكون 8 أحرف على الأقل.';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return 'كلمة المرور لازم تحتوي على حرف ورقم على الأقل.';
  if (password !== confirmPassword) return 'كلمة المرور وتأكيدها مش متطابقين.';
  return null;
}

async function submit() {
  const fields = {
    name: document.getElementById('fName').value.trim(),
    email: document.getElementById('fEmail').value.trim(),
    dob: document.getElementById('fDob').value,
    password: document.getElementById('fPassword').value,
    confirmPassword: document.getElementById('fConfirmPassword').value,
  };

  const errEl = document.getElementById('registerError');
  errEl.style.display = 'none';

  const clientError = validate(fields);
  if (clientError) {
    errEl.textContent = clientError;
    errEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btnRegister');
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fields.name,
        email: fields.email,
        password: fields.password,
        confirmPassword: fields.confirmPassword,
        date_of_birth: fields.dob,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.message || 'حصل خطأ.';
      errEl.style.display = 'block';
      btn.disabled = false;
      return;
    }
    document.getElementById('registerForm').style.display = 'none';
    document.getElementById('pendingMessage').textContent = data.message;
    document.getElementById('pendingNotice').style.display = 'block';
  } catch {
    errEl.textContent = 'مقدرش أوصل للسيرفر. اتأكد إن السيرفر شغال.';
    errEl.style.display = 'block';
    btn.disabled = false;
  }
}

init();
