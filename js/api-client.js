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

async function request(method, path, body, opts) {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts?.signal, // optional: lets a screen cancel a superseded request (AbortController)
  });

  if (res.status === 401) {
    if (!location.pathname.endsWith('/login.html')) {
      if (window.self !== window.top) { try { window.top.location.href = 'login.html'; } catch { location.href = 'login.html'; } } // inside the app shell: leave the whole shell, not just the frame
      else {
        const next = encodeURIComponent(location.pathname + location.search + (location.pathname.endsWith('/app.html') ? location.hash : ''));
        location.href = `login.html?next=${next}`;
      }
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

/** POST that answers with a FILE (e.g. a CSV export): resolves { blob, filename, count } — never parsed as JSON. */
async function download(path, body) {
  const res = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) { let m = null; try { m = await res.json(); } catch { /* not json */ } const err = new Error(m?.message || `Request failed: POST ${path} (${res.status})`); err.code = m?.error || 'REQUEST_FAILED'; err.status = res.status; throw err; }
  const cd = res.headers.get('content-disposition') || ''; const filename = (cd.match(/filename="?([^";]+)"?/) || [])[1] || 'export.csv';
  return { blob: await res.blob(), filename, count: Number(res.headers.get('x-row-count')) || null };
}

export const api = {
  get: (path, params, opts) => request('GET', path + qs(params), undefined, opts),
  download,
  post: (path, body, opts) => request('POST', path, body ?? {}, opts),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  delete: (path) => request('DELETE', path),
};
