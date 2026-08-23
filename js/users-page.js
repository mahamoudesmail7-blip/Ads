// users-page.js — page controller for users.html (👑 Owner-only). Talks to
// /api/users/* directly via api-client (same fetch wrapper db.js uses) since
// this is the one area of the app not modeled as a db.js repository —
// user/permission management is inherently backend-owned, not a data store
// other pages read.
import { api } from './api-client.js';
import * as UI from './ui-common.js';

const PERMISSION_GROUPS = [
  { label: '📦 المنتجات', keys: [
    ['products.view', 'مشاهدة المنتجات'],
    ['products.create', 'إضافة منتجات'],
    ['products.edit', 'تعديل المنتجات'],
    ['products.delete', 'حذف المنتجات'],
  ]},
  { label: '🛒 الأوردرات', keys: [
    ['orders.view', 'مشاهدة الأوردرات'],
    ['orders.manage', 'إضافة أو تعديل الأوردرات'],
    ['orders.delete', 'حذف الأوردرات'],
  ]},
  { label: '🏭 المخزون', keys: [
    ['inventory.view', 'مشاهدة المخزون'],
    ['inventory.manage', 'إضافة أو تعديل المخزون'],
    ['inventory.movements', 'إدارة حركة المخزون'],
  ]},
  { label: '🎯 المهام', keys: [
    ['tasks.view', 'مشاهدة المهام'],
    ['tasks.create', 'إنشاء مهام'],
    ['tasks.edit', 'تعديل المهام'],
    ['tasks.manage_team', 'إدارة مهام الفريق'],
  ]},
  { label: '📊 التقارير والتحليلات', keys: [
    ['reports.view', 'مشاهدة التقارير'],
    ['reports.analytics', 'الوصول إلى التحليلات والأداء'],
  ]},
  { label: '👥 المستخدمون والإدارة', keys: [
    ['users.view', 'مشاهدة المستخدمين'],
    ['users.manage', 'إدارة المستخدمين'],
    ['users.approve', 'قبول أو رفض طلبات الانضمام'],
    ['users.edit_permissions', 'تعديل صلاحيات المستخدمين'],
    ['users.disable', 'تعطيل أو إعادة تفعيل الحسابات'],
  ]},
];

const STATUS_BADGE = {
  PENDING: '<span class="badge gray">⏳ قيد المراجعة</span>',
  ACTIVE: '<span class="badge green">✅ نشط</span>',
  REJECTED: '<span class="badge gray">🚫 مرفوض</span>',
  DISABLED: '<span class="badge gray">⛔ معطّل</span>',
};
const ROLE_LABELS_AR = { ADMIN: 'مدير النظام', MANAGER: 'مدير', EMPLOYEE: 'موظف' };

let currentEditingUserId = null;

async function init() {
  await UI.renderSidebar('users');
  document.getElementById('btnCancelPerms').onclick = closePermsModal;
  document.getElementById('btnSavePerms').onclick = savePerms;
  await refresh();
}

async function refresh() {
  const [pending, all] = await Promise.all([api.get('/api/users/pending'), api.get('/api/users')]);
  renderPending(pending);
  renderAll(all);
}

function renderPending(rows) {
  const body = document.getElementById('pendingBody');
  if (rows.length === 0) {
    body.innerHTML = '<div class="empty-state">مفيش طلبات انضمام جديدة دلوقتي.</div>';
    return;
  }
  body.innerHTML = `
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>الاسم</th><th>الإيميل</th><th>تاريخ الميلاد</th><th>تاريخ التسجيل</th><th>إجراءات</th></tr></thead>
        <tbody>
          ${rows.map((u) => `
            <tr>
              <td>${UI.escapeHtml(u.name)}</td>
              <td class="mono">${UI.escapeHtml(u.email)}</td>
              <td class="mono">${u.date_of_birth || '—'}</td>
              <td class="mono">${new Date(u.created_at).toLocaleString('ar-EG')}</td>
              <td>
                <button class="btn small" data-approve="${u.id}">✅ قبول</button>
                <button class="btn danger small" data-reject="${u.id}">🚫 رفض</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  body.querySelectorAll('[data-approve]').forEach((btn) => (btn.onclick = () => approveUser(Number(btn.dataset.approve))));
  body.querySelectorAll('[data-reject]').forEach((btn) => (btn.onclick = () => rejectUser(Number(btn.dataset.reject))));
}

function renderAll(rows) {
  const body = document.getElementById('usersBody');
  body.innerHTML = rows.map((u) => `
    <tr>
      <td>${UI.escapeHtml(u.name)}${u.is_owner ? ' <span class="badge green">👑 Owner</span>' : ''}</td>
      <td class="mono">${UI.escapeHtml(u.email)}</td>
      <td>${ROLE_LABELS_AR[u.role] || u.role}</td>
      <td>${STATUS_BADGE[u.status] || u.status}</td>
      <td class="mono">${new Date(u.created_at).toLocaleDateString('ar-EG')}</td>
      <td>
        ${u.is_owner
          ? '<span class="faint">—</span>'
          : `
            <button class="btn secondary small" data-perms="${u.id}" data-name="${UI.escapeHtml(u.name)}">🔐 الصلاحيات</button>
            ${u.status === 'DISABLED'
              ? `<button class="btn small" data-reactivate="${u.id}">▶️ تفعيل</button>`
              : `<button class="btn danger small" data-disable="${u.id}">⛔ تعطيل</button>`}
          `}
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-perms]').forEach((btn) => (btn.onclick = () => openPermsModal(Number(btn.dataset.perms), btn.dataset.name, rows)));
  body.querySelectorAll('[data-disable]').forEach((btn) => (btn.onclick = () => disableUser(Number(btn.dataset.disable))));
  body.querySelectorAll('[data-reactivate]').forEach((btn) => (btn.onclick = () => reactivateUser(Number(btn.dataset.reactivate))));
}

async function approveUser(id) {
  await api.post(`/api/users/${id}/approve`, {});
  UI.toast('✅ تم قبول المستخدم');
  await refresh();
}

async function rejectUser(id) {
  if (!confirm('رفض طلب الانضمام ده؟ مش هيقدر يدخل النظام تاني.')) return;
  await api.post(`/api/users/${id}/reject`, {});
  UI.toast('تم رفض الطلب');
  await refresh();
}

async function disableUser(id) {
  if (!confirm('تعطيل الحساب ده؟ مش هيقدر يدخل النظام لحد ما تفعّله تاني.')) return;
  await api.post(`/api/users/${id}/disable`, {});
  UI.toast('تم تعطيل الحساب');
  await refresh();
}

async function reactivateUser(id) {
  await api.post(`/api/users/${id}/reactivate`, {});
  UI.toast('تم تفعيل الحساب');
  await refresh();
}

function openPermsModal(id, name, rows) {
  currentEditingUserId = id;
  const user = rows.find((u) => u.id === id);
  document.getElementById('permsUserName').textContent = name;
  document.getElementById('permsRole').value = user.role;
  document.getElementById('permsGroups').innerHTML = PERMISSION_GROUPS.map((g) => `
    <div class="section-title" style="font-size:13px;">${g.label}</div>
    <div style="margin-bottom:10px;">
      ${g.keys.map(([key, label]) => `
        <label style="display:flex; align-items:center; gap:8px; padding:4px 0; font-size:13.5px;">
          <input type="checkbox" data-perm-key="${key}" ${user.permissions[key] ? 'checked' : ''} />
          ${label}
        </label>
      `).join('')}
    </div>
  `).join('');
  document.getElementById('permsModalOverlay').style.display = 'flex';
}

function closePermsModal() {
  document.getElementById('permsModalOverlay').style.display = 'none';
  currentEditingUserId = null;
}

async function savePerms() {
  const role = document.getElementById('permsRole').value;
  const permissions = {};
  document.querySelectorAll('#permsGroups [data-perm-key]').forEach((cb) => {
    permissions[cb.dataset.permKey] = cb.checked;
  });
  await api.patch(`/api/users/${currentEditingUserId}/permissions`, { role, permissions });
  UI.toast('✅ اتحفظت الصلاحيات');
  closePermsModal();
  await refresh();
}

init();
