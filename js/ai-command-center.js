// ai-command-center.js — the AI E-Commerce Operating System's AI Command
// Center (top of ai-intelligence.html): greeting, quick actions, chat input,
// and the deterministic AI Daily Briefing. Every number shown here comes
// from a real backend call (POST /api/ai-assistant/chat or GET
// /api/ai-assistant/daily-briefing) — nothing here is computed or invented
// client-side.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const QUICK_ACTIONS = [
  { label: 'حلل أداء اليوم', message: 'حلل أداء اليوم وقولي أعمل إيه' },
  { label: 'فين بنخسر؟', message: 'فين بنخسر فلوس دلوقتي؟ وريني الحملات أو المنتجات اللي بتخسر' },
  { label: 'أفضل حملة؟', message: 'إيه أفضل حملة إعلانية حاليًا من ناحية الكفاءة؟' },
  { label: 'أفضل منتج؟', message: 'إيه أكتر منتج مربح فعليًا؟' },
  { label: 'فرص Scaling', message: 'إيه فرص التوسع (Scaling) المتاحة دلوقتي؟' },
  { label: 'حلل الربح الحقيقي', message: 'إحنا كسبنا كام فعليًا؟ حلل الربح الحقيقي' },
  { label: 'اعمل خطة لمنتج', message: 'اعمل خطة عمل مختصرة بناءً على أفضل وأسوأ منتج/حملة حاليًا' },
];

const HEALTH_LABELS = { marketing: '📣 التسويق', orders: '📦 الأوردرات', profit: '💰 الربح', inventory: '🏷️ المخزون', lostOrders: '↩️ المفقودة' };
const TIER_CLASS = { GOOD: 'green', WARN: 'yellow', BAD: 'red', UNKNOWN: '' };

function escapeHtml(s) {
  return UI.escapeHtml ? UI.escapeHtml(String(s ?? '')) : String(s ?? '');
}

/** Parses the STATUS/WHAT HAPPENED/DATA/WHY/RECOMMENDATION/CONFIDENCE structured reply format the system prompt asks for (backend/src/routes/aiAssistant.js). Falls back to plain text when the reply doesn't use it (casual/simple questions legitimately don't). */
function renderAssistantReply(text) {
  const labels = { STATUS: 'الحالة', 'WHAT HAPPENED': 'اللي حصل', DATA: 'البيانات', WHY: 'ليه', RECOMMENDATION: 'التوصية', ACTION: 'الإجراء', CONFIDENCE: 'مستوى الثقة' };
  const pattern = /^(STATUS|WHAT HAPPENED|DATA|WHY|RECOMMENDATION|ACTION|CONFIDENCE):\s*(.*)$/;
  const lines = text.split('\n');
  const structured = lines.some((l) => pattern.test(l.trim()));

  if (!structured) {
    return `<div style="white-space:pre-wrap; font-size:13.5px; line-height:1.7;">${escapeHtml(text)}</div>`;
  }

  let html = '<div class="action-card" style="border-inline-start-color:var(--accent);">';
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current) html += `<div style="margin-bottom:6px;"><b>${escapeHtml(labels[current] || current)}:</b> ${escapeHtml(buffer.join(' ').trim())}</div>`;
    buffer = [];
  };
  for (const line of lines) {
    const m = pattern.exec(line.trim());
    if (m) {
      flush();
      current = m[1];
      buffer = [m[2]];
    } else if (current) {
      buffer.push(line.trim());
    }
  }
  flush();
  html += '</div>';
  return html;
}

async function sendMessage(message) {
  const input = document.getElementById('aiChatInput');
  const loading = document.getElementById('aiChatLoading');
  const responseEl = document.getElementById('aiChatResponse');
  input.value = message;
  loading.style.display = 'block';
  responseEl.style.display = 'none';
  try {
    const result = await api.post('/api/ai-assistant/chat', { message });
    responseEl.innerHTML = renderAssistantReply(result.reply || 'مفيش رد.');
    responseEl.style.display = 'block';
  } catch (err) {
    responseEl.innerHTML = `<div class="empty-state">⚠️ ${escapeHtml(err.message)}</div>`;
    responseEl.style.display = 'block';
  } finally {
    loading.style.display = 'none';
  }
}

function healthTile(key, health) {
  const cls = TIER_CLASS[health.tier] || '';
  return `
    <div class="stat-tile">
      <div class="label">${HEALTH_LABELS[key] || key}</div>
      <div class="value ${cls}">${health.score !== null && health.score !== undefined ? health.score + '%' : '—'}</div>
      <div class="sub">${escapeHtml(health.label)}</div>
    </div>`;
}

function briefingItemHtml(item, cls) {
  return `
    <div class="action-card ${cls}">
      <div class="action-card-title">${escapeHtml(item.title || '—')}</div>
      <div class="action-card-metrics"><span>${escapeHtml(item.detail || '')}</span></div>
      ${item.reason ? `<div class="action-card-reasons">${escapeHtml(item.reason)}</div>` : ''}
      ${item.action ? `<div class="action-card-confidence">💡 ${escapeHtml(item.action)}</div>` : ''}
    </div>`;
}

async function loadDailyBriefing() {
  try {
    const data = await api.get('/api/ai-assistant/daily-briefing');
    const tilesEl = document.getElementById('aiHealthTiles');
    tilesEl.innerHTML = Object.entries(data.health).map(([key, h]) => healthTile(key, h)).join('');

    const oppEl = document.getElementById('aiBriefingOpportunities');
    const probEl = document.getElementById('aiBriefingProblems');
    const emptyEl = document.getElementById('aiBriefingEmpty');

    oppEl.innerHTML = data.opportunities.length
      ? `<div style="font-size:13px; font-weight:700; margin-bottom:8px;">🟢 أهم الفرص</div>${data.opportunities.map((i) => briefingItemHtml(i, 'SCALE')).join('')}`
      : '';
    probEl.innerHTML = data.problems.length
      ? `<div style="font-size:13px; font-weight:700; margin:10px 0 8px;">🔴 أهم المشاكل</div>${data.problems.map((i) => briefingItemHtml(i, 'EXIT')).join('')}`
      : '';
    emptyEl.style.display = data.opportunities.length === 0 && data.problems.length === 0 ? 'block' : 'none';
  } catch (err) {
    document.getElementById('aiHealthTiles').innerHTML = '';
    const emptyEl = document.getElementById('aiBriefingEmpty');
    emptyEl.textContent = `⚠️ ${err.message}`;
    emptyEl.style.display = 'block';
  }
}

async function init() {
  document.getElementById('aiQuickActions').innerHTML = QUICK_ACTIONS.map((a, i) => `<button class="btn secondary small" data-qa="${i}">${escapeHtml(a.label)}</button>`).join('');
  document.querySelectorAll('[data-qa]').forEach((btn) => {
    btn.onclick = () => sendMessage(QUICK_ACTIONS[Number(btn.dataset.qa)].message);
  });

  document.getElementById('aiChatSend').onclick = () => {
    const val = document.getElementById('aiChatInput').value.trim();
    if (val) sendMessage(val);
  };
  document.getElementById('aiChatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('aiChatSend').click();
  });

  try {
    const user = await api.get('/api/auth/me');
    document.getElementById('aiGreeting').textContent = `أهلاً ${user.name || ''} 👋`;
  } catch {
    // handled globally by api-client.js's 401 redirect; nothing to do here
  }

  await loadDailyBriefing();
}

init();
