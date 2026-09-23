// assistant.js — 🤖 مساعد الميديا باير: the floating, draggable, global AI
// chat bubble mounted on (almost) every page via ui-common.js's
// mountAssistantBubble(). Talks to the SAME backend as the AI Command
// Center (POST /api/ai-assistant/chat) — extended, not replaced, with
// history/context/image (backend/src/routes/aiAssistant.js). Reuses the
// exact structured-reply renderer ai-command-center.js already has, so the
// two surfaces never drift into two different reply formats.
import { api } from './api-client.js';
import * as UI from './ui-common.js';
import { nextSlotKeys, computeLaunchContentHash, validateLaunchVideoFile, validateLaunchImageFile, isLaunchImageFile, uploadLaunchVideoSlot, uploadLaunchImageSlot, naturalCompare } from './launchMediaUpload.js';

const STORAGE_POS_KEY = 'amb_assistant_pos_v1';
const STORAGE_HISTORY_KEY = 'amb_assistant_history_v1';
const STORAGE_OPEN_TASKS_KEY = 'amb_assistant_open_tasks_v1';
const MAX_STORED_HISTORY = 20;
const REPLY_LABELS = { STATUS: 'الحالة', 'WHAT HAPPENED': 'اللي حصل', DATA: 'البيانات', WHY: 'ليه', RECOMMENDATION: 'التوصية', ACTION: 'الإجراء', CONFIDENCE: 'مستوى الثقة' };
const REPLY_PATTERN = /^(STATUS|WHAT HAPPENED|DATA|WHY|RECOMMENDATION|ACTION|CONFIDENCE):\s*(.*)$/;

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

// --- Task Card (AI Media Buyer Operator, Phase 2 Slice 1) ---------------
// Replaces the old ACTION_PROPOSAL trailing-text convention entirely: a
// PREPARE-tier tool (prepare_bump/prepare_pause/prepare_resume) now returns
// a real, persisted AssistantTask in the /chat response's `task` field, and
// this renders it as a live card the human must explicitly approve — never
// two competing "propose a write" mechanisms running side by side.
const TASK_KIND_LABEL = { BUMP: '⚡ زيادة ميزانية', PAUSE: '⏸️ إيقاف', RESUME: '▶️ استئناف', LAUNCH_CAMPAIGN: '🚀 إطلاق كامبين', SCALE_CAMPAIGN: '📈 سكيل للمنتج الرابح' };
const LAUNCH_KINDS = ['LAUNCH_CAMPAIGN', 'SCALE_CAMPAIGN'];
const TASK_STATUS_LABEL = {
  PLANNED: 'مخطط', PREPARING: 'جاري التجهيز...', WAITING_FOR_INPUT: 'محتاج بيانات منك',
  WAITING_FOR_APPROVAL: 'محتاج موافقتك', RUNNING: 'جاري التنفيذ...', VERIFYING: 'جاري تأكيد التنفيذ...',
  COMPLETED: 'تم ✅', PARTIALLY_COMPLETED: 'تم — محتاج تأكيد يدوي ⚠️', FAILED: 'فشل ❌', CANCELLED: 'اتلغى', BLOCKED: 'متوقف',
};
const CAMPAIGN_PHASE_LABEL = {
  COMPLETE: 'تم ✅', CANCELLED: 'اتلغى', ACTION_REQUIRED: 'محتاج تدخل ⚠️', FAILED_TERMINAL: 'فشل ❌',
  WAITING_FOR_META: 'بيستنى Meta...', RETRY_SCHEDULED: 'هيعيد المحاولة...', QUEUED: 'في الطابور', PUBLISHING: 'جاري النشر...',
};
const TASK_STATUS_CLASS = { COMPLETED: 'ok', PARTIALLY_COMPLETED: 'warn', FAILED: 'err', BLOCKED: 'warn', CANCELLED: 'muted' };
const TASK_ACTIVE_STATUSES = ['PLANNED', 'PREPARING', 'WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL', 'RUNNING', 'VERIFYING'];
const PROFIT_STATE_LABEL = {
  PROFITABLE: '✅ مربح', MARGIN_THIN: '⚠️ هامش ضيق', BREAK_EVEN: '⚖️ على حافة التعادل',
  UNPROFITABLE: '🔴 خسران', PARTIAL_DATA: '❔ بيانات ناقصة', INSUFFICIENT_DATA: '❔ بيانات غير كافية',
};
const STOCK_STATUS_LABEL = { SAFE: '✅ متوفر', LOW: '⚠️ منخفض', OUT_OF_STOCK: '🔴 نفد', STOCK_UNKNOWN: '❔ غير مسجل' };

/** SCALE_CAMPAIGN-only header showing exactly which proven creative/evidence the draft was built from — the Task Card's own "never claim proof without showing it" affordance. */
function sourceWinnerHeaderHtml(sourceWinner) {
  if (!sourceWinner) return '';
  const parts = [];
  if (sourceWinner.label) parts.push(escapeHtml(sourceWinner.label));
  if (sourceWinner.cpa != null) parts.push(`CPA ${Math.round(sourceWinner.cpa)} ج`);
  if (sourceWinner.purchases != null) parts.push(`${sourceWinner.purchases} عملية شراء`);
  const reuseNote = sourceWinner.reusedFromMediaLibrary ? ' (تم إعادة استخدامه من غير رفع جديد)' : '';
  return `<div class="assistant-task-source-winner">📈 بناءً على الكرييتيف الرابح: ${parts.join(' — ')}${reuseNote}</div>`;
}

/** SCALE_CAMPAIGN-only Money Guard/Profit Brain/Stock Guard header — never hides a risk flag, only ever additive to the preview rows below it. */
function moneyGuardHeaderHtml(p) {
  if (!p.profitBrain && !p.stockGuard) return '';
  const parts = [];
  if (p.profitBrain) {
    const label = PROFIT_STATE_LABEL[p.profitBrain.state] || p.profitBrain.state;
    parts.push(`💰 الربح الحقيقي: ${label}${p.profitBrain.marginPct != null ? ` (${p.profitBrain.marginPct.toFixed(1)}%)` : ''}`);
  }
  if (p.stockGuard) {
    const label = STOCK_STATUS_LABEL[p.stockGuard.status] || p.stockGuard.status;
    parts.push(`📦 المخزون: ${label}${p.stockGuard.daysRemaining != null ? ` — ${p.stockGuard.daysRemaining} يوم متبقي تقريبًا` : ''}`);
  }
  const warnHtml = p.moneyGuardWarning ? `<div class="assistant-task-warning">⚠️ ${escapeHtml(p.moneyGuardWarning)}</div>` : '';
  return `<div class="assistant-task-money-guard">${parts.map(escapeHtml).join(' · ')}</div>${warnHtml}`;
}

function launchCampaignPreviewHtml(p) {
  const targetingHtml = p.targeting?.mode === 'BROAD'
    ? 'كل مصر — بدون استهداف مخصص'
    : `${escapeHtml(p.targeting?.genders === 'MALE' ? 'رجالة' : p.targeting?.genders === 'FEMALE' ? 'ستات' : 'الكل')} · ${p.targeting?.ageMin ?? 18}-${p.targeting?.ageMax ?? 65} سنة${p.targeting?.governorates?.length ? ' · ' + p.targeting.governorates.map(escapeHtml).join('، ') : ''}`;
  const rows = [
    ['المنتج', p.productName], ['الكامبين', p.campaignName], ['الحساب الإعلاني', p.adAccountName],
    ['الميزانية اليومية', p.budgetEgp != null ? `${p.budgetEgp} ج (${p.budgetMode})` : null],
    ['العدد', `${p.campaignCount || 1} كامبين × ${p.adSetsPerCampaign} Ad Set × ${p.adsPerAdSet} إعلان`],
    ['Pixel', p.pixelName], ['الصفحة', p.pageName], ['إنستجرام', p.instagramUsername || 'مفيش (فيسبوك بس)'],
    ['الميديا', p.mediaCount ? `${p.mediaCount.videos} فيديو، ${p.mediaCount.images} صورة` : null],
    ['البداية', p.startMode === 'SCHEDULED' && p.startAt ? new Date(p.startAt).toLocaleString('ar-EG') : 'فورًا (بعد الموافقة، متوقف مبدئيًا للمراجعة)'],
    ['الاستهداف', targetingHtml],
  ];
  return sourceWinnerHeaderHtml(p.sourceWinner) + moneyGuardHeaderHtml(p) + rows.filter(([, v]) => v != null).map(([k, v]) => `<div><b>${escapeHtml(k)}:</b> ${typeof v === 'string' && v.startsWith('<') ? v : escapeHtml(String(v))}</div>`).join('');
}

function launchCampaignProgressHtml(launchProgress) {
  if (!launchProgress?.campaigns?.length) return '';
  const rows = launchProgress.campaigns.map((c) => `<div>${escapeHtml(c.name)} — ${escapeHtml(CAMPAIGN_PHASE_LABEL[c.phase] || c.phase)} (${c.adSetsCreated}/${c.adSetsTotal} Ad Sets، ${c.adsCreated}/${c.adsTotal} إعلان)</div>`).join('');
  return `<div class="assistant-task-progress-rows">${rows}</div>`;
}

function taskCardBodyHtml(task) {
  const p = task.preparedPayload || {};
  if (LAUNCH_KINDS.includes(task.kind)) {
    return launchCampaignPreviewHtml(p) + launchCampaignProgressHtml(task.launchProgress);
  }
  const name = escapeHtml(task.entityName || p.adSetName || p.entityName || task.entityId || '—');
  if (task.kind === 'BUMP') {
    return `<div>الـ Ad Set: <b>${name}</b></div>
      <div>الميزانية: ${p.currentBudget != null ? `${p.currentBudget} ج` : '—'} ← ${p.proposedBudget != null ? `${p.proposedBudget} ج` : '—'}${p.bumpPct != null ? ` (+${p.bumpPct}%)` : ''}</div>`;
  }
  if (task.kind === 'PAUSE' || task.kind === 'RESUME') {
    return `<div>${name}</div><div>الحالة: ${escapeHtml(p.currentStatus || '—')} ← ${escapeHtml(p.targetStatus || '—')}</div>`;
  }
  return `<div>${name}</div>`;
}

function renderTaskCardHtml(task) {
  const label = TASK_KIND_LABEL[task.kind] || task.kind;
  const statusLabel = TASK_STATUS_LABEL[task.status] || task.status;
  const cls = TASK_STATUS_CLASS[task.status] || '';
  let actions = '';
  if (task.status === 'WAITING_FOR_APPROVAL') {
    actions = `<div class="assistant-task-actions">
      <button type="button" class="assistant-action-btn" data-task-approve="${escapeAttr(task.taskUuid)}" data-approval-hash="${escapeAttr(task.approvalHash || '')}">✅ موافقة وتنفيذ</button>
      <button type="button" class="assistant-action-btn assistant-action-btn-secondary" data-task-cancel="${escapeAttr(task.taskUuid)}">❌ إلغاء</button>
    </div>`;
  } else if (['PLANNED', 'PREPARING', 'WAITING_FOR_INPUT'].includes(task.status)) {
    actions = `<div class="assistant-task-actions"><button type="button" class="assistant-action-btn assistant-action-btn-secondary" data-task-cancel="${escapeAttr(task.taskUuid)}">❌ إلغاء</button></div>`;
  }
  const noteHtml = (task.error || task.blockedReason) ? `<div class="assistant-error">${escapeHtml(task.error || task.blockedReason)}</div>` : '';
  // A LAUNCH_CAMPAIGN task with a real job_id, still WAITING_FOR_INPUT, is
  // (most commonly) waiting specifically on media — offer the attach
  // control right on the card so the user doesn't have to guess where to
  // click. Harmless to show even if it's waiting on something else (product/
  // page/pixel) — attaching media early is never wasted, prepare_campaign's
  // own media gate just checks for it later regardless of what unblocked first.
  const attachHtml = (LAUNCH_KINDS.includes(task.kind) && task.status === 'WAITING_FOR_INPUT' && task.launchJobId)
    ? `<div class="assistant-launch-attach">
        <label class="assistant-action-btn assistant-action-btn-secondary" style="display:flex; align-items:center; justify-content:center; gap:6px; cursor:pointer;">
          📎 أرفق فيديوهات أو صور<input type="file" multiple accept="video/*,image/*" data-launch-attach-input="${escapeAttr(task.taskUuid)}" data-launch-job-id="${escapeAttr(task.launchJobId)}" hidden>
        </label>
        <div class="assistant-launch-media-list" id="launchMedia-${escapeAttr(task.taskUuid)}"></div>
      </div>`
    : '';
  return `<div class="assistant-task-card" data-task-uuid="${escapeAttr(task.taskUuid)}">
    <div class="assistant-task-card-head"><b>${escapeHtml(label)}</b><span class="assistant-task-badge assistant-task-badge-${cls}">${escapeHtml(statusLabel)}</span></div>
    <div class="assistant-task-card-body">${taskCardBodyHtml(task)}</div>
    ${noteHtml}${attachHtml}${actions}
  </div>`;
}

function loadOpenTaskUuids() {
  try { const raw = localStorage.getItem(STORAGE_OPEN_TASKS_KEY); const parsed = raw ? JSON.parse(raw) : []; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function trackTaskOpenState(task) {
  try {
    const set = new Set(loadOpenTaskUuids());
    if (TASK_ACTIVE_STATUSES.includes(task.status)) set.add(task.taskUuid);
    else set.delete(task.taskUuid);
    localStorage.setItem(STORAGE_OPEN_TASKS_KEY, JSON.stringify([...set]));
  } catch { /* per-viewer convenience only */ }
}

/** Replaces one task card's DOM in place (used after approve/cancel and each poll tick) — never re-renders the whole message list. */
function updateTaskCardInPlace(messagesEl, task) {
  trackTaskOpenState(task);
  const el = messagesEl.querySelector(`.assistant-task-card[data-task-uuid="${task.taskUuid}"]`);
  if (el) el.outerHTML = renderTaskCardHtml(task);
}

/**
 * Polls GET /api/assistant-tasks/:taskUuid while RUNNING/VERIFYING,
 * re-rendering the card each tick, landing on the real terminal state.
 * Bounded so a stuck task can't poll forever. A BUMP/PAUSE/RESUME write is
 * synchronous (one Meta call, done in seconds) so the default interval/
 * bound is tight; a LAUNCH_CAMPAIGN hands off to a durable scheduler with a
 * mandatory 5-minute inter-campaign gate and can legitimately take
 * minutes-to-an-hour for multiple campaigns — restoreOpenTasks() re-arms
 * polling on page reload as the safety net if this bound is ever exceeded.
 */
async function pollTaskUntilSettled(messagesEl, taskUuid, kind) {
  const intervalMs = LAUNCH_KINDS.includes(kind) ? 5000 : 1500;
  const maxTicks = LAUNCH_KINDS.includes(kind) ? 720 : 20;
  for (let i = 0; i < maxTicks; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let task;
    try { ({ task } = await api.get(`/api/assistant-tasks/${taskUuid}`)); } catch { return; }
    if (!task) return;
    updateTaskCardInPlace(messagesEl, task);
    if (!['RUNNING', 'VERIFYING'].includes(task.status)) return;
  }
}

async function handleTaskApprove(messagesEl, btn) {
  const taskUuid = btn.dataset.taskApprove;
  const approvalHash = btn.dataset.approvalHash;
  btn.disabled = true;
  const card = messagesEl.querySelector(`.assistant-task-card[data-task-uuid="${taskUuid}"]`);
  if (card) card.querySelectorAll('.assistant-action-btn').forEach((b) => { b.disabled = true; });
  try {
    const result = await api.post(`/api/assistant-tasks/${taskUuid}/approve`, { approvalHash });
    if (result.task) updateTaskCardInPlace(messagesEl, result.task);
    if (result.task && ['RUNNING', 'VERIFYING'].includes(result.task.status)) await pollTaskUntilSettled(messagesEl, taskUuid, result.task.kind);
    if (!result.ok && result.error === 'STALE_APPROVAL') {
      // Task went back to PREPARING server-side — re-fetch to show the real current card instead of a stuck disabled button.
      try { const fresh = await api.get(`/api/assistant-tasks/${taskUuid}`); if (fresh.task) updateTaskCardInPlace(messagesEl, fresh.task); } catch { /* leave as-is */ }
    }
  } catch (err) {
    if (card) card.querySelector('.assistant-error')?.remove();
    if (card) card.insertAdjacentHTML('beforeend', `<div class="assistant-error">⚠️ ${escapeHtml(err.message || 'فشل التنفيذ')}</div>`);
  }
}

const MEDIA_ROW_STATUS_LABEL = { pending: 'في الانتظار', uploading: 'جاري الرفع...', done: '✓ تم', failed: '❌' };
function mediaRowHtml(row) {
  return `<div class="assistant-launch-media-row" data-media-row="${escapeAttr(row.slotKey)}"><span>${escapeHtml(row.name)}</span><span class="assistant-launch-media-status">${row.status === 'failed' ? `❌ ${escapeHtml(row.error || 'فشل')}` : MEDIA_ROW_STATUS_LABEL[row.status]}</span></div>`;
}

/**
 * Chat-driven multi-file attach for a LAUNCH_CAMPAIGN task — uploads
 * straight to the SAME existing Launch Builder routes the wizard uses
 * (js/launchMediaUpload.js's shared, byte-for-byte-identical fetch helpers),
 * never a new backend surface. Slot keys are assigned client-side by
 * reading the job's current videos/images first (same convention the
 * wizard itself uses), so re-attaching more files later in the same
 * conversation never collides with what's already uploaded.
 */
async function handleLaunchAttach(messagesEl, input) {
  const files = [...(input.files || [])].sort((a, b) => naturalCompare(a.name, b.name));
  if (!files.length) return;
  const jobId = input.dataset.launchJobId;
  const taskUuid = input.dataset.launchAttachInput;
  const listEl = document.getElementById(`launchMedia-${taskUuid}`);
  input.value = '';
  if (!listEl) return;

  let existing;
  try { existing = await api.get(`/api/ai-media-buyer/launch/jobs/${jobId}`); } catch (err) {
    listEl.insertAdjacentHTML('beforeend', `<div class="assistant-error">⚠️ ${escapeHtml(err.message || 'تعذر تحميل بيانات الكامبين')}</div>`);
    return;
  }
  const existingVideoKeys = (existing.videos || []).map((v) => v.slot_key);
  const existingImageKeys = (existing.images || []).map((v) => v.slot_key);

  const videoFiles = files.filter((f) => !isLaunchImageFile(f));
  const imageFiles = files.filter(isLaunchImageFile);
  const videoKeys = nextSlotKeys(existingVideoKeys, videoFiles.length, 'video');
  const imageKeys = nextSlotKeys(existingImageKeys, imageFiles.length, 'image');
  const entries = [
    ...videoFiles.map((file, i) => ({ slotKey: videoKeys[i], kind: 'video', file, name: file.name, status: 'pending' })),
    ...imageFiles.map((file, i) => ({ slotKey: imageKeys[i], kind: 'image', file, name: file.name, status: 'pending' })),
  ];

  for (const row of entries) listEl.insertAdjacentHTML('beforeend', mediaRowHtml(row));
  const rowEl = (slotKey) => listEl.querySelector(`[data-media-row="${slotKey}"]`);
  const updateRow = (row) => { const el = rowEl(row.slotKey); if (el) el.outerHTML = mediaRowHtml(row); };

  for (const row of entries) {
    row.status = 'uploading'; updateRow(row);
    try {
      const validation = row.kind === 'image' ? await validateLaunchImageFile(row.file) : await validateLaunchVideoFile(row.file);
      if (!validation.ok) throw new Error(validation.reason);
      const contentHash = await computeLaunchContentHash(row.file);
      if (row.kind === 'image') await uploadLaunchImageSlot({ jobId, slotKey: row.slotKey, file: row.file, contentHash, width: validation.width, height: validation.height });
      else await uploadLaunchVideoSlot({ jobId, slotKey: row.slotKey, file: row.file, contentHash, duration: validation.duration });
      row.status = 'done';
    } catch (err) {
      row.status = 'failed'; row.error = err.message;
    }
    updateRow(row);
  }

  const allDone = entries.every((r) => r.status === 'done');
  if (allDone) {
    listEl.insertAdjacentHTML('beforeend', `<div class="assistant-launch-media-done">✅ كل الملفات جاهزة — اكتب "كمّل" عشان أراجع الكامبين.</div>`);
  }
}

async function handleTaskCancel(messagesEl, btn) {
  const taskUuid = btn.dataset.taskCancel;
  btn.disabled = true;
  try {
    const result = await api.post(`/api/assistant-tasks/${taskUuid}/cancel`, {});
    if (result.task) updateTaskCardInPlace(messagesEl, result.task);
  } catch (err) {
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
  restoreOpenTasks(messagesEl);

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
    const approveBtn = e.target.closest('[data-task-approve]');
    if (approveBtn) return handleTaskApprove(messagesEl, approveBtn);
    const cancelBtn = e.target.closest('[data-task-cancel]');
    if (cancelBtn) return handleTaskCancel(messagesEl, cancelBtn);
  });
  messagesEl.addEventListener('change', async (e) => {
    const attachInput = e.target.closest('[data-launch-attach-input]');
    if (attachInput) return handleLaunchAttach(messagesEl, attachInput);
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
      // Captured BEFORE mutating the placeholder's content — a user who
      // scrolled up to re-read earlier history while the reply was still
      // "جاري التفكير..." should not get yanked back down by it landing.
      const stick = isNearBottom(messagesEl);
      loadingEl.classList.remove('assistant-msg-thinking');
      loadingEl.innerHTML = renderReplyHtml(reply);
      if (result.task) {
        trackTaskOpenState(result.task);
        loadingEl.insertAdjacentHTML('afterend', `<div class="assistant-msg assistant-msg-assistant">${renderTaskCardHtml(result.task)}</div>`);
      }
      scrollToBottom(messagesEl, stick);

      history.push({ role: 'user', text });
      history.push({ role: 'assistant', text: reply });
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
    if (h.role === 'assistant') el.innerHTML = renderReplyHtml(h.text);
  }
}

/** Resumability: re-fetches any task that was still non-terminal when the page was last open (a real page refresh, not just a minimize) and re-renders its card — the concrete answer to "tasks survive page refresh" given chat history itself stays client-only. */
async function restoreOpenTasks(messagesEl) {
  const uuids = loadOpenTaskUuids();
  if (!uuids.length) return;
  for (const taskUuid of uuids) {
    let task;
    try { ({ task } = await api.get(`/api/assistant-tasks/${taskUuid}`)); } catch { continue; }
    if (!task) continue;
    trackTaskOpenState(task);
    addMessage(messagesEl, 'assistant', '');
    const el = messagesEl.lastElementChild;
    el.innerHTML = renderTaskCardHtml(task);
    if (['RUNNING', 'VERIFYING'].includes(task.status)) pollTaskUntilSettled(messagesEl, taskUuid, task.kind);
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
