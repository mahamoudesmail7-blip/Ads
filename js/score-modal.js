// score-modal.js — the click-to-see-why popup for a Product Score circle
// (spec section 17: "لا تجعل هذه التفاصيل تظهر دائمًا. تظهر عند الضغط فقط").
// Shared across index.html and products.html the same way product-drawer.js
// is, so the explanation always looks and behaves identically everywhere a
// score circle appears.
import { escapeHtml } from './ui-common.js';

let overlayEl = null;

function ensureModal() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement('div');
  overlayEl.className = 'drawer-overlay';
  overlayEl.style.display = 'none';
  overlayEl.style.alignItems = 'center';
  overlayEl.style.justifyContent = 'center';
  overlayEl.innerHTML = `<div class="card" id="scoreModalPanel" style="width:380px; max-width:92vw; max-height:80vh; overflow-y:auto;"></div>`;
  overlayEl.onclick = (e) => {
    if (e.target === overlayEl) closeScoreBreakdown();
  };
  document.body.appendChild(overlayEl);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeScoreBreakdown();
  });
  return overlayEl;
}

export function closeScoreBreakdown() {
  if (overlayEl) {
    overlayEl.style.display = 'none';
    overlayEl.classList.remove('open');
  }
}

/** @param {string} productName @param {ReturnType<import('./product-score.js').calculateProductScore>} result */
export function openScoreBreakdown(productName, result) {
  ensureModal();
  const panel = document.getElementById('scoreModalPanel');

  if (result.score === null) {
    panel.innerHTML = `
      <div class="section-title" style="margin-top:0;">${escapeHtml(productName)}</div>
      <div class="empty-state">🆕 منتج جديد — لا توجد بيانات كافية لحساب تقييم موثوق بعد.</div>
      <button class="btn secondary small" id="scoreModalClose" style="margin-top:12px; width:100%;">إغلاق</button>`;
  } else {
    panel.innerHTML = `
      <div class="section-title" style="margin-top:0;">${escapeHtml(productName)}</div>
      <div style="text-align:center; margin-bottom:16px;">
        <div class="score-circle ${result.color}" style="width:72px; height:72px; font-size:24px; margin:0 auto 8px;">${result.score}</div>
        <div style="font-size:13px;">${result.label}</div>
      </div>
      <div class="section-title" style="font-size:13px; margin-top:0;">لماذا هذا التقييم؟</div>
      ${result.breakdown
        .map(
          (b) => `
        <div style="display:flex; justify-content:space-between; font-size:12.5px; padding:5px 0; border-bottom:1px solid var(--border);">
          <span>${escapeHtml(b.label)}</span>
          <span class="mono">${b.points >= 0 ? '+' : ''}${b.points} / ${b.max}</span>
        </div>`
        )
        .join('')}
      <button class="btn secondary small" id="scoreModalClose" style="margin-top:14px; width:100%;">إغلاق</button>`;
  }

  panel.querySelector('#scoreModalClose').onclick = closeScoreBreakdown;
  overlayEl.style.display = 'flex';
  overlayEl.classList.add('open');
}

/** Wires every `[data-score-trigger]` element inside `container` to open the breakdown for its product. `getResultAndName(id)` returns `{name, result}`. */
export function wireScoreTriggers(container, getResultAndName) {
  container.querySelectorAll('[data-score-trigger]').forEach((el) => {
    const card = el.closest('[data-id]');
    if (!card) return;
    el.onclick = (e) => {
      e.stopPropagation();
      const { name, result } = getResultAndName(card.dataset.id);
      openScoreBreakdown(name, result);
    };
  });
}
