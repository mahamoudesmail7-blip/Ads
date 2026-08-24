// theme.js — the single reusable module behind the Light/Dark theme
// switcher (spec: "reusable global visual system so all current and
// future pages can support both themes consistently"). Purely a visual
// preference: touches only `documentElement.dataset.theme` and one
// localStorage key. Never reads/writes any application data.
//
// FOUC prevention lives separately as a tiny inline <script> in each
// page's <head> (before css/style.css loads) — a module script here would
// run too late (after first paint) to avoid a flash. This module owns
// everything else: computing the effective theme, persisting an explicit
// choice, and rendering/wiring the toggle switch.
const STORAGE_KEY = 'theme';

/** The user's own explicit choice, if they ever made one — null means "follow system". */
export function getStoredTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // localStorage can throw in some locked-down/private-browsing contexts — never let a UI preference break page load.
  }
}

function getSystemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** What's actually being shown right now, whether from an explicit choice or the system default. */
export function getEffectiveTheme() {
  return getStoredTheme() || getSystemTheme();
}

/** Applies a theme to the document. `theme: null` clears any explicit override and reverts to following the system preference (matches the CSS's prefers-color-scheme fallback). */
export function applyTheme(theme) {
  if (theme) {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

/** Persists an explicit choice and applies it immediately. */
export function setTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Same private-browsing/locked-storage guard as above — the toggle still
    // works for this page load even if it can't be remembered.
  }
  applyTheme(theme);
}

export function toggleTheme() {
  const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

const TOGGLE_HTML = `
  <div class="theme-toggle theme-toggle-fixed" id="themeToggle" role="button" tabindex="0" aria-label="تبديل بين الوضع الفاتح والداكن">
    <div class="theme-toggle-icons">
      <span class="theme-toggle-icon" id="themeIconLight">☀️</span>
      <span class="theme-toggle-icon" id="themeIconDark">🌙</span>
    </div>
    <div class="theme-toggle-switch" id="themeSwitch"></div>
  </div>
`;

function syncToggleUI() {
  const isDark = getEffectiveTheme() === 'dark';
  document.getElementById('themeSwitch')?.classList.toggle('is-dark', isDark);
  document.getElementById('themeIconLight')?.classList.toggle('current', !isDark);
  document.getElementById('themeIconDark')?.classList.toggle('current', isDark);
}

/**
 * Mounts the toggle fixed to the top-left corner of the viewport (spec:
 * "عايز يكون فوق على الشمال" — physical left, regardless of RTL) on top of
 * every page, sidebar or not. Call once per page load; safe to call more
 * than once (idempotent — won't create a duplicate).
 */
export function mountThemeToggle() {
  if (document.getElementById('themeToggle')) {
    syncToggleUI();
    return;
  }
  document.body.insertAdjacentHTML('beforeend', TOGGLE_HTML);
  syncToggleUI();

  const toggleEl = document.getElementById('themeToggle');
  const activate = () => {
    toggleTheme();
    syncToggleUI();
  };
  toggleEl.addEventListener('click', activate);
  toggleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  });
}
