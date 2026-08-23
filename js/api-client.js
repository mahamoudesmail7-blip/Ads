// api-client.js — the ONLY place in the frontend that calls fetch() against
// the backend API. db.js uses this internally; every other page/module
// still only ever talks to db.js, exactly as before. Uses relative URLs
// (`/api/...`) so this works unchanged whether the backend serves the
// frontend itself (local dev via `node backend/src/server.js`, and
// production) — no separate API base URL to configure.
//
// Auth: the session lives in an httpOnly cookie (set by the backend on
// login), so `credentials: 'include'` is what attaches it — there is no
// token in JS memory or localStorage to leak.

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    if (!location.pathname.endsWith('/login.html')) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `login.html?next=${next}`;
    }
    // Never resolves normally on 401 — the redirect above is already underway.
    return new Promise(() => {});
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const err = new Error(data?.message || `Request failed: ${method} ${path} (${res.status})`);
    err.code = data?.error || 'REQUEST_FAILED';
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }

  return data;
}

function qs(params) {
  const entries = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export const api = {
  get: (path, params) => request('GET', path + qs(params)),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  delete: (path) => request('DELETE', path),
};
