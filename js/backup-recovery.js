// Backup & Recovery status page (backup-recovery.html) — ADMIN-only,
// read-only/informational. Never shows a secret value, never offers a
// restore/delete/migrate action — see docs/DISASTER_RECOVERY.md for the
// actual recovery procedures, which are run manually and deliberately.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

const E = (s) => UI.escapeHtml(String(s ?? ''));
const $ = (id) => document.getElementById(id);

async function init() {
  await UI.renderSidebar('backuprecovery');
  await load();
}

async function load() {
  const body = $('backupStatusBody');
  let data;
  try {
    data = await api.get('/api/backup-status');
  } catch (err) {
    body.innerHTML = `<div class="card"><p class="muted">⚠️ ${E(err.message)}</p></div>`;
    return;
  }
  render(body, data);
}

function statusBadge(ok, yesLabel, noLabel) {
  return `<span class="badge ${ok ? 'green' : 'red'}">${ok ? `✓ ${E(yesLabel)}` : `⚠ ${E(noLabel)}`}</span>`;
}

function render(body, data) {
  const { github, database, environment, safetyGuards } = data;

  const envRows = environment.map((v) => `
    <div class="pmc-kv" style="align-items:flex-start;">
      <span>${E(v.name)}${v.required ? ' <span class="faint" style="font-size:10px;">(مطلوب)</span>' : ''}</span>
      <b>${v.configured ? '<span class="badge green">مضبوط ✓</span>' : `<span class="badge ${v.required ? 'red' : 'gray'}">${v.required ? 'ناقص ⚠' : 'غير مضبوط'}</span>`}</b>
    </div>
    ${v.note ? `<div class="faint" style="font-size:11px;margin:-4px 0 6px;">${E(v.note)}</div>` : ''}
  `).join('');

  const guardRows = safetyGuards.map((g) => `
    <div class="pmc-kv"><span><code>${E(g.file)}</code></span><b>${statusBadge(g.present, 'موجود', 'غير موجود')}</b></div>
  `).join('');

  body.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <div class="section-title" style="margin-top:0;">🐙 GitHub — كود المشروع</div>
      <div class="pmc-kv"><span>Commit الحالي</span><b>${github.commit ? `<code>${E(github.commit.slice(0, 12))}</code>` : 'غير متاح'}</b></div>
      <div class="pmc-kv"><span>الفرع (Branch)</span><b>${E(github.branch || 'غير متاح')}</b></div>
      <div class="pmc-kv"><span>المستودع</span><b>${E(github.repo || 'غير متاح')}</b></div>
      <div class="faint" style="font-size:11px;margin-top:8px;">المصدر: ${E(github.source)}</div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="section-title" style="margin-top:0;">🗄️ قاعدة البيانات — Neon</div>
      <div class="pmc-kv"><span>الاتصال</span><b>${statusBadge(database.connected, 'متصلة', 'غير متصلة')}</b></div>
      <div class="pmc-kv"><span>المزوّد</span><b>${E(database.provider)}</b></div>
      <div class="faint" style="font-size:11px;margin-top:8px;">${E(database.note)}</div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="section-title" style="margin-top:0;">🔑 متغيرات البيئة (بدون عرض أي قيمة حقيقية أبدًا)</div>
      ${envRows}
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="section-title" style="margin-top:0;">🛡️ حماية قاعدة البيانات</div>
      ${guardRows}
      <div class="faint" style="font-size:11px;margin-top:8px;">هذا يعرض فقط وجود ملفات الحماية على القرص — راجع docs/DISASTER_RECOVERY.md للتفاصيل الكاملة عن كل حارس.</div>
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0;">📖 دليل الاسترجاع الكامل</div>
      <p class="muted" style="font-size:13px;">docs/DISASTER_RECOVERY.md في المستودع — يشرح كل سيناريو استرجاع خطوة بخطوة (كود سيء، قاعدة بيانات تالفة، فقدان Railway، أو كارثة كاملة).</p>
    </div>
  `;
}

init();
