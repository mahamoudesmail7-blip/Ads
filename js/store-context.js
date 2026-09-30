// store-context.js — canonical, page-agnostic ACTIVE STORE state (§9 of the
// "Global Store Switcher" spec). Any page that needs to know "which store am
// I looking at right now" imports this instead of hand-rolling its own
// list/select/persist/validate logic — product-marketing-center.js is the
// reference integration; ai-media-buyer.js/easy-orders.js/etc. can adopt the
// same module later without re-deriving any of this.
//
// Hard rules this module enforces (never left to the page):
//   - FAIL CLOSED (§12): when 2+ real stores exist and neither the URL nor a
//     remembered choice names a still-real, still-enabled one, activeStoreId
//     stays null — never silently guesses/defaults to the first store in the
//     list. A page must render an explicit "اختر المتجر أولًا" state for that.
//   - ONE-STORE CONVENIENCE (§13): exactly one real store may auto-select.
//   - PERSISTENCE (§10) is never trusted blindly: a remembered/URL storeId is
//     validated against the REAL, freshly-fetched store list every time —
//     an id that no longer exists or was disabled is dropped, not honored.
//   - URL SUPPORT (§11): ?storeId=<id> is read on init and kept in sync on
//     every explicit switch, so a bookmarked/shared link is deterministic.
//     (Still just a client-side convenience — every real API call is
//     server-side validated regardless of what the URL claims.)
import { api } from './api-client.js';

const STORAGE_KEY = 'amb.activeStoreId';
const URL_PARAM = 'storeId';

let stores = null;        // real list from the server; null = not loaded yet (distinct from [] = loaded, zero stores)
let activeStoreId = null; // null = "no store chosen" (fail-closed state) — never a guessed default among 2+ real stores
let loading = false;
let error = null;
const listeners = new Set();

function notify() { for (const cb of listeners) { try { cb(getState()); } catch { /* one bad subscriber must never break the others */ } } }

function readUrlStoreId() {
  try { return new URL(window.location.href).searchParams.get(URL_PARAM) || null; } catch { return null; }
}
function writeUrlStoreId(id) {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set(URL_PARAM, id); else url.searchParams.delete(URL_PARAM);
    window.history.replaceState(null, '', url);
  } catch { /* non-browser context or a blocked History API — localStorage persistence still works */ }
}
function readStoredStoreId() {
  try { return localStorage.getItem(STORAGE_KEY) || null; } catch { return null; }
}
function writeStoredStoreId(id) {
  try { if (id) localStorage.setItem(STORAGE_KEY, id); else localStorage.removeItem(STORAGE_KEY); } catch { /* private-mode/blocked storage — the choice just won't survive a refresh */ }
}

function isRealEnabled(id) {
  return !!(id && stores && stores.some((s) => s.id === id && s.enabled !== false));
}

function getState() {
  return {
    stores, loading, error,
    activeStoreId,
    activeStore: (stores && activeStoreId) ? (stores.find((s) => s.id === activeStoreId) || null) : null,
    needsSelection: !loading && !error && Array.isArray(stores) && stores.length > 1 && !activeStoreId,
  };
}

/**
 * Loads the real store list and resolves the initial active store, in order:
 * URL ?storeId= (if it names a real, enabled store) -> the last-remembered
 * choice (same real/enabled check) -> auto-select ONLY if exactly one real
 * store exists -> otherwise null (fail closed). Call once per page load.
 */
async function init() {
  loading = true; error = null; notify();
  try {
    const r = await api.get('/api/product-marketing/stores');
    stores = r.stores || [];
  } catch (e) {
    stores = null; error = e.message || 'تعذر تحميل المتاجر المتاحة.';
    loading = false; notify();
    return getState();
  }
  const fromUrl = readUrlStoreId();
  const fromStorage = readStoredStoreId();
  if (isRealEnabled(fromUrl)) activeStoreId = fromUrl;
  else if (isRealEnabled(fromStorage)) activeStoreId = fromStorage;
  else if (stores.length === 1) activeStoreId = stores[0].id;
  else activeStoreId = null;

  if (activeStoreId) { writeStoredStoreId(activeStoreId); writeUrlStoreId(activeStoreId); }
  else { writeStoredStoreId(null); } // a stale/invalid remembered id must never linger once proven wrong
  loading = false;
  notify();
  return getState();
}

/** Re-fetches the store list without resetting a still-valid selection — e.g. after "+ ربط متجر جديد" adds one, or on tab focus. Drops the active store if it stopped being real/enabled since the last load. */
async function reload() {
  try {
    const r = await api.get('/api/product-marketing/stores');
    stores = r.stores || [];
  } catch (e) {
    error = e.message || 'تعذر تحميل المتاجر المتاحة.';
    notify();
    return getState();
  }
  error = null;
  if (activeStoreId && !isRealEnabled(activeStoreId)) {
    activeStoreId = null;
    writeStoredStoreId(null);
    writeUrlStoreId(null);
  } else if (!activeStoreId && stores.length === 1) {
    activeStoreId = stores[0].id; // e.g. the just-added second store turned out to be the very first one loaded on this page instance
    writeStoredStoreId(activeStoreId);
    writeUrlStoreId(activeStoreId);
  }
  notify();
  return getState();
}

/** Explicit switch — refuses (returns false, no-op) for anything not in the real, currently-loaded, enabled store list; never trusts a caller-supplied id blindly. */
function setActiveStoreId(id) {
  if (!isRealEnabled(id)) return false;
  if (id === activeStoreId) return true;
  activeStoreId = id;
  writeStoredStoreId(id);
  writeUrlStoreId(id);
  notify();
  return true;
}

/** Explicit "forget the current store" — used by a page's own logout-like reset, never called automatically. */
function clearActiveStore() {
  activeStoreId = null;
  writeStoredStoreId(null);
  writeUrlStoreId(null);
  notify();
}

/** @param {(state: ReturnType<typeof getState>) => void} cb @returns {() => void} unsubscribe */
function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

/** Small shared display helpers so every page's selector looks/behaves consistently without copy-pasting the same markup logic. */
function storeStatusLabel(store) { return store?.enabled === false ? '⚪ معطّل' : '🟢 متصل'; }

export { init, reload, getState, setActiveStoreId, clearActiveStore, onChange, storeStatusLabel };
