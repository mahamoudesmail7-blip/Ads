// assistant.js — 🤖 مساعد الميديا باير: the floating, draggable, global AI
// chat bubble mounted on (almost) every page via ui-common.js's
// mountAssistantBubble(). Talks to the SAME backend as the AI Command
// Center (POST /api/ai-assistant/chat) — extended, not replaced, with
// history/context/image (backend/src/routes/aiAssistant.js). Reuses the
// exact structured-reply renderer ai-command-center.js already has, so the
// two surfaces never drift into two different reply formats.
import { api } from './api-client.js';
import * as UI from './ui-common.js';

const STORAGE_POS_KEY = 'amb_assistant_pos_v1';
const STORAGE_HISTORY_KEY = 'amb_assistant_history_v1';
const MAX_STORED_HISTORY = 20;
const REPLY_LABELS = { STATUS: 'الحالة', 'WHAT HAPPENED': 'اللي حصل', DATA: 'البيانات', WHY: 'ليه', RECOMMENDATION: 'التوصية', ACTION: 'الإجراء', CONFIDENCE: 'مستوى الثقة' };
const REPLY_PATTERN = /^(STATUS|WHAT HAPPENED|DATA|WHY|RECOMMENDATION|ACTION|CONFIDENCE):\s*(.*)$/;
const ACTION_PROPOSAL_PATTERN = /^ACTION_PROPOSAL:\s*(\{.*\})\s*$/m;

function escapeHtml(s) {
  return UI.escapeHtml ? UI.escapeHtml(String(s ?? '')) : String(s ?? '');
}

// escapeHtml (ui-common.js's textContent/innerHTML roundtrip) only escapes
// &/</> — safe for text-node context, but a JSON blob placed inside a
// double-quoted HTML attribute (data-proposal="...") also needs its own `"`
// escaped, or the attribute value terminates at the JSON's first `"`. Found
// live: the real ACTION_PROPOSAL button rendered with data-proposal='{"'
// (truncated at the first quote), so clicking it silently did nothing.
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

let pageContext = null;
/** Called by any page via UI.setAssistantContext() when it knows what it's showing (e.g. {page:'scale-center', productId, window}) — never scraped from the DOM. */
export function setAssistantContext(ctx) {
  pageContext = ctx && typeof ctx === 'object' ? ctx : null;
}
export function getAssistantContext() {
  return pageContext;
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveHistory(history) {
  try { localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(history.slice(-MAX_STORED_HISTORY))); } catch { /* private window / blocked storage — conversation just won't persist across reloads */ }
}

/** Strips a trailing `ACTION_PROPOSAL: {...}` line (if present/valid) from the visible text and returns it separately, so the button is rendered instead of raw JSON. */
function extractActionProposal(text) {
  const m = ACTION_PROPOSAL_PATTERN.exec(text);
  if (!m) return { visibleText: text, proposal: null };
  let proposal = null;
  try { proposal = JSON.parse(m[1]); } catch { proposal = null; }
  const visibleText = text.slice(0, m.index).trim();
  return { visibleText: visibleText || text, proposal };
}

function renderReplyHtml(text) {
  const lines = text.split('\n');
  const structured = lines.some((l) => REPLY_PATTERN.test(l.trim()));
  if (!structured) return `<div style="white-space:pre-wrap; font-size:13.5px; line-height:1.7;">${escapeHtml(text)}</div>`;

  let html = '<div class="assistant-reply-card">';
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current) html += `<div style="margin-bottom:6px;"><b>${escapeHtml(REPLY_LABELS[current] || current)}:</b> ${escapeHtml(buffer.join(' ').trim())}</div>`;
    buffer = [];
  };
  for (const line of lines) {
    const m = REPLY_PATTERN.exec(line.trim());
    if (m) { flush(); current = m[1]; buffer = [m[2]]; }
    else if (current) buffer.push(line.trim());
  }
  flush();
  html += '</div>';
  return html;
}

function actionProposalHtml(proposal) {
  if (!proposal || typeof proposal !== 'object') return '';
  if (proposal.type === 'PREPARE_BUMP' && proposal.adSetId) {
    const pct = Number(proposal.pct) || 25;
    return `<button type="button" class="assistant-action-btn" data-proposal="${escapeAttr(JSON.stringify(proposal))}">⚡ جهّز زيادة ${pct}% لهذا الـ Ad Set</button>`;
  }
  return '';
}

/** The one real write this bubble can ever trigger — calls the EXISTING /bump-prepare endpoint directly (no LLM tool in the loop), same as Scale Center's own "تجهيز الزيادة" button. Creates a PENDING AmbRecommendation, no Meta write. */
async function handleActionProposal(proposal, btn) {
  if (proposal.type !== 'PREPARE_BUMP') return;
  btn.disabled = true;
  btn.textContent = '...جاري التجهيز';
  try {
    await api.post('/api/scale-center/bump-prepare', { adSetId: proposal.adSetId, pct: proposal.pct || 25 });
    btn.textContent = '✅ اتجهّزت — راجعها في مركز التوسّع';
  } catch (err) {
    btn.textContent = `⚠️ ${err.message || 'فشل التجهيز'}`;
    btn.disabled = false;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('تعذرت قراءة الصورة.'));
    reader.readAsDataURL(file);
  });
}

const MOBILE_QUERY = '(max-width: 768px)';
const isMobile = () => window.matchMedia(MOBILE_QUERY).matches;
/** How close to the bottom (px) counts as "already at the bottom" — auto-scroll only kicks in from here, so a user who scrolled up to re-read history isn't yanked back down by a new/streaming message. */
const AUTO_SCROLL_THRESHOLD = 64;
function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD;
}
function scrollToBottom(el, force = false) {
  if (force || isNearBottom(el)) el.scrollTop = el.scrollHeight;
}

let mounted = false;
let pendingImage = null; // {base64, mediaType, name}

export function mountAssistantBubble() {
  if (mounted || document.getElementById('ambAssistantBubble')) return;
  mounted = true;

  const backdrop = document.createElement('div');
  backdrop.id = 'ambAssistantBackdrop';
  backdrop.className = 'assistant-backdrop';
  document.body.appendChild(backdrop);

  const wrap = document.createElement('div');
  wrap.id = 'ambAssistantRoot';
  wrap.innerHTML = `
    <button type="button" id="ambAssistantBubble" class="assistant-bubble" aria-label="مساعد الميديا باير" title="مساعد الميديا باير">🤖</button>
    <div id="ambAssistantPanel" class="assistant-panel" hidden>
      <div class="assistant-panel-header">
        <div class="assistant-header-avatar">🤖</div>
        <div class="assistant-header-titles">
          <div class="assistant-header-name">مساعد الميديا باير</div>
          <div class="assistant-header-status">متصل</div>
        </div>
        <div class="assistant-header-actions">
          <button type="button" id="ambAssistantMinimize" class="assistant-icon-btn" aria-label="تصغير" title="تصغير">−</button>
          <button type="button" id="ambAssistantClose" class="assistant-icon-btn" aria-label="إغلاق" title="إغلاق">✕</button>
        </div>
      </div>
      <div id="ambAssistantMessages" class="assistant-messages"></div>
      <div id="ambAssistantImagePreview" class="assistant-image-preview" hidden></div>
      <form id="ambAssistantForm" class="assistant-input-row">
        <label class="assistant-icon-btn assistant-upload-btn" title="ارفع صورة">
          📷<input type="file" id="ambAssistantImageInput" accept="image/*" hidden>
        </label>
        <input type="text" id="ambAssistantInput" placeholder="اكتب رسالتك هنا..." autocomplete="off">
        <button type="submit" class="assistant-icon-btn assistant-send-btn" aria-label="إرسال">➤</button>
      </form>
    </div>`;
  document.body.appendChild(wrap);

  const bubble = document.getElementById('ambAssistantBubble');
  const panel = document.getElementById('ambAssistantPanel');
  const closeBtn = document.getElementById('ambAssistantClose');
  const minimizeBtn = document.getElementById('ambAssistantMinimize');
  const messagesEl = document.getElementById('ambAssistantMessages');
  const form = document.getElementById('ambAssistantForm');
  const input = document.getElementById('ambAssistantInput');
  const imageInput = document.getElementById('ambAssistantImageInput');
  const imagePreview = document.getElementById('ambAssistantImagePreview');

  restorePosition(wrap);
  restoreConversation(messagesEl);

  let open = false;
  const setOpen = (v) => {
    open = v;
    panel.hidden = !v;
    bubble.setAttribute('aria-expanded', String(v));
    const mobile = isMobile();
    panel.classList.toggle('is-sheet', mobile);
    if (mobile) {
      // On mobile the sheet REPLACES the bubble while open (never both at
      // once — a floating bubble behind/under a near-full-height sheet has
      // nothing useful to do and just adds visual clutter), and gets a
      // backdrop; on desktop the bubble stays visible next to the panel
      // exactly as before, no backdrop.
      bubble.hidden = v;
      backdrop.classList.toggle('is-open', v);
      if (v) applyMobileViewport(panel); else teardownMobileViewport();
    }
    if (v) { input.focus(); scrollToBottom(messagesEl, true); }
  };

  wireDrag(bubble, wrap, () => setOpen(!open));
  closeBtn.addEventListener('click', () => setOpen(false));
  minimizeBtn.addEventListener('click', () => setOpen(false));
  backdrop.addEventListener('click', () => setOpen(false));

  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    try {
      const base64 = await fileToBase64(file);
      pendingImage = { base64, mediaType: file.type || 'image/jpeg', name: file.name };
      imagePreview.hidden = false;
      imagePreview.innerHTML = `
        <img class="assistant-image-preview-thumb" src="data:${pendingImage.mediaType};base64,${pendingImage.base64}" alt="">
        <span class="assistant-image-preview-name">${escapeHtml(file.name)}</span>
        <button type="button" id="ambAssistantImageRemove" class="assistant-icon-btn" aria-label="إزالة الصورة">✕</button>`;
      document.getElementById('ambAssistantImageRemove').addEventListener('click', () => {
        pendingImage = null; imagePreview.hidden = true; imagePreview.innerHTML = ''; imageInput.value = '';
      });
    } catch (err) {
      addMessage(messagesEl, 'assistant', `⚠️ ${err.message}`);
    }
  });

  messagesEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.assistant-action-btn');
    if (!btn) return;
    let proposal;
    try { proposal = JSON.parse(btn.dataset.proposal); } catch { return; }
    await handleActionProposal(proposal, btn);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const imageToSend = pendingImage;
    pendingImage = null;
    imagePreview.hidden = true;
    imagePreview.innerHTML = '';
    imageInput.value = '';

    addMessage(messagesEl, 'user', text, imageToSend);
    const loadingEl = addThinkingMessage(messagesEl);

    const history = loadHistory();
    try {
      const result = await api.post('/api/ai-assistant/chat', {
        message: text,
        history: history.map((h) => ({ role: h.role, content: h.text })),
        context: pageContext,
        image: imageToSend ? { base64: imageToSend.base64, mediaType: imageToSend.mediaType } : undefined,
      });
      const reply = result.reply || 'مفيش رد.';
      const { visibleText, proposal } = extractActionProposal(reply);
      // Captured BEFORE mutating the placeholder's content — a user who
      // scrolled up to re-read earlier history while the reply was still
      // "جاري التفكير..." should not get yanked back down by it landing.
      const stick = isNearBottom(messagesEl);
      loadingEl.classList.remove('assistant-msg-thinking');
      loadingEl.innerHTML = renderReplyHtml(visibleText) + actionProposalHtml(proposal);
      scrollToBottom(messagesEl, stick);

      history.push({ role: 'user', text });
      history.push({ role: 'assistant', text: visibleText });
      saveHistory(history);
    } catch (err) {
      const stick = isNearBottom(messagesEl);
      loadingEl.classList.remove('assistant-msg-thinking');
      loadingEl.innerHTML = `<div class="assistant-error">⚠️ ${escapeHtml(err.message || 'حصل خطأ')}</div>`;
      scrollToBottom(messagesEl, stick);
    }
  });
}

function addMessage(messagesEl, role, text, image) {
  const stick = isNearBottom(messagesEl);
  const el = document.createElement('div');
  el.className = `assistant-msg assistant-msg-${role}`;
  const imgHtml = image ? `<img class="assistant-msg-image" src="data:${image.mediaType};base64,${image.base64}" alt="">` : '';
  el.innerHTML = role === 'user' ? `${imgHtml}<div style="white-space:pre-wrap;">${escapeHtml(text)}</div>` : `<div style="white-space:pre-wrap;">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(el);
  scrollToBottom(messagesEl, stick);
  return el;
}

/** Compact "جاري التفكير..." placeholder — never a big empty bubble while waiting on a real tool-calling turn that can take several seconds. */
function addThinkingMessage(messagesEl) {
  const el = addMessage(messagesEl, 'assistant', '');
  el.classList.add('assistant-msg-thinking');
  el.innerHTML = '<span>جاري التفكير...</span>';
  return el;
}

function restoreConversation(messagesEl) {
  const history = loadHistory();
  if (!history.length) {
    addMessage(messagesEl, 'assistant', 'أهلاً! أنا مساعد الميديا باير 🤖 اسألني عن أي منتج، حملة، أو اطلب مني أفكار تسويقية.');
    return;
  }
  for (const h of history.slice(-10)) {
    const el = addMessage(messagesEl, h.role, h.text);
    if (h.role === 'assistant') {
      const { visibleText, proposal } = extractActionProposal(h.text);
      el.innerHTML = renderReplyHtml(visibleText) + actionProposalHtml(proposal);
    }
  }
}

let vvCleanup = null;
/**
 * iOS/mobile on-screen-keyboard handling for the mobile bottom sheet, via
 * the Visual Viewport API. `window.innerHeight` (the LAYOUT viewport) stays
 * put when the keyboard opens on iOS Safari, but `visualViewport.height`
 * shrinks to the actually-visible area — the gap between the two is
 * approximately the keyboard's height, so pinning the sheet's `bottom` to
 * that gap keeps the composer directly above the keyboard instead of
 * behind it or leaving a dead gap. Browsers without Visual Viewport support
 * just keep the CSS resting position (safe-area-aware, still usable, only
 * without live keyboard tracking).
 */
function applyMobileViewport(panel) {
  teardownMobileViewport();
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  const update = () => {
    const covered = window.innerHeight - vv.height - vv.offsetTop;
    panel.style.bottom = `${Math.max(14, covered + 14)}px`;
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
  vvCleanup = () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
}
function teardownMobileViewport() {
  if (vvCleanup) { vvCleanup(); vvCleanup = null; }
  document.getElementById('ambAssistantPanel')?.style.removeProperty('bottom');
}

function restorePosition(wrap) {
  try {
    const raw = localStorage.getItem(STORAGE_POS_KEY);
    if (!raw) return;
    const pos = JSON.parse(raw);
    if (pos && typeof pos.right === 'number' && typeof pos.bottom === 'number') {
      wrap.style.right = `${pos.right}px`;
      wrap.style.bottom = `${pos.bottom}px`;
    }
  } catch { /* per-viewer convenience only — fine to lose */ }
}
function savePosition(right, bottom) {
  try { localStorage.setItem(STORAGE_POS_KEY, JSON.stringify({ right, bottom })); } catch { /* ignore */ }
}

/** Pointer-Events drag (mouse + touch) on the bubble itself, with a tap-vs-drag threshold so a plain click still opens the panel. Dragging the header (ambAssistantDragHandle) moves the whole root the same way. */
function wireDrag(bubble, wrap, onTap) {
  const DRAG_THRESHOLD = 6;
  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0, startRight = 0, startBottom = 0;

  const getRect = () => wrap.getBoundingClientRect();

  const onPointerDown = (e) => {
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = getRect();
    startRight = window.innerWidth - rect.right;
    startBottom = window.innerHeight - rect.bottom;
    bubble.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    moved = true;
    const rect = getRect();
    let right = startRight - dx;
    let bottom = startBottom - dy;
    right = Math.max(4, Math.min(window.innerWidth - rect.width - 4, right));
    bottom = Math.max(4, Math.min(window.innerHeight - rect.height - 4, bottom));
    wrap.style.right = `${right}px`;
    wrap.style.bottom = `${bottom}px`;
  };
  const onPointerUp = () => {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      const rect = getRect();
      const right = window.innerWidth - rect.right;
      const bottom = window.innerHeight - rect.bottom;
      // edge-snap: stick to whichever side (left/right) is closer, keep vertical position
      const snapRight = rect.left > window.innerWidth - rect.right ? 4 : window.innerWidth - rect.width - 4;
      wrap.style.right = `${snapRight}px`;
      savePosition(snapRight, bottom);
    } else {
      onTap();
    }
  };

  bubble.style.touchAction = 'none';
  bubble.addEventListener('pointerdown', onPointerDown);
  bubble.addEventListener('pointermove', onPointerMove);
  bubble.addEventListener('pointerup', onPointerUp);
  bubble.addEventListener('pointercancel', onPointerUp);
}
