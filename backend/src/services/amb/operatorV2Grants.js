// AI Operator V2 — the admin screen's backend: which EMPLOYEE may see which ad accounts / stores in the campaign center, and whether they may REVIEW and prepare DRAFTS.
// It writes ONLY the five «operator.*» keys of an EMPLOYEE's permissions JSON (every other key is preserved), only for an ACTIVE employee (never a manager / admin / owner / yourself),
// only with ADMIN authority, always audited. There is NO key for approving or executing anything — an attempt to send one is refused. Role changes are not possible here.
import { prisma } from '../../prisma.js';
import { knownAccounts, levelOf } from './operatorV2Access.js';

const KEYS = ['operator.view', 'operator.accounts', 'operator.stores', 'operator.review', 'operator.drafts'];
const FORBIDDEN = /approve|execute|execution|apply|write|meta|policy|policies|role|permission|admin|lock|mode|autopilot|automatic/i;
const fail = (status, message, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };
const j = (s, d = {}) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const grantsOf = (p = {}) => ({ view: p['operator.view'] === true, accounts: Array.isArray(p['operator.accounts']) ? p['operator.accounts'].map(String) : [], stores: Array.isArray(p['operator.stores']) ? p['operator.stores'].map(String) : [], review: p['operator.review'] === true, drafts: p['operator.drafts'] === true });
async function knownStores() { const rows = await prisma.product.findMany({ distinct: ['store_id'], select: { store_id: true } }); return rows.map((r) => r.store_id).filter(Boolean).sort(); }

export async function listGrantUsers() {
  const users = await prisma.user.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ role: 'asc' }, { name: 'asc' }], select: { id: true, name: true, email: true, role: true, is_owner: true, permissions: true } });
  return { users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, level: levelOf(u), editable: levelOf(u) === 'EMPLOYEE', grants: grantsOf(j(u.permissions)) })), accounts: await knownAccounts(), stores: await knownStores() };
}

/** body = { view, accounts, stores, review, drafts } — nothing else is accepted */
export async function setGrants({ admin, targetId, body }) {
  const b = body || {}; const extra = Object.keys(b).filter((k) => !['view', 'accounts', 'stores', 'review', 'drafts'].includes(k));
  if (extra.length) throw fail(400, `حقول غير مسموحة: ${extra.join(', ')} — الشاشة دي بتدير المشاهدة والمراجعة والمسودات بس. الاعتماد والتنفيذ مش بيتمنحوا من هنا أبدًا.`, 'FIELD_NOT_ALLOWED');
  for (const [k, v] of Object.entries(b)) if (typeof v === 'string' && FORBIDDEN.test(v)) throw fail(400, 'قيمة غير مسموحة.', 'VALUE_NOT_ALLOWED');
  const target = await prisma.user.findUnique({ where: { id: Number(targetId) } }); if (!target) throw fail(404, 'المستخدم غير موجود.', 'USER_NOT_FOUND');
  if (target.id === admin.id) throw fail(400, 'مينفعش تعدّل صلاحيات حسابك من هنا.', 'SELF_EDIT'); if (target.status !== 'ACTIVE') throw fail(400, 'الحساب مش نشط.', 'USER_NOT_ACTIVE');
  if (levelOf(target) !== 'EMPLOYEE') throw fail(400, 'الصلاحيات دي للموظفين فقط — المشرف والمسؤول صلاحياتهم من دورهم.', 'NOT_AN_EMPLOYEE');
  const cur = j(target.permissions); const next = { ...cur }; for (const k of KEYS) delete next[k];
  if (b.view === true) {
    const known = await knownAccounts(); const accounts = Array.isArray(b.accounts) ? [...new Set(b.accounts.map(String))] : []; if (!accounts.length) throw fail(400, 'اختار حساب إعلاني واحد على الأقل.', 'ACCOUNTS_REQUIRED');
    const unknown = accounts.filter((a) => !known.includes(a)); if (unknown.length) throw fail(400, `حسابات غير معروفة: ${unknown.slice(0, 3).join(', ')}`, 'UNKNOWN_ACCOUNT');
    const stores = Array.isArray(b.stores) ? [...new Set(b.stores.map(String))] : []; if (stores.length) { const ks = await knownStores(); const bad = stores.filter((s) => !ks.includes(s)); if (bad.length) throw fail(400, `متاجر غير معروفة: ${bad.slice(0, 3).join(', ')}`, 'UNKNOWN_STORE'); }
    const review = b.review === true; const drafts = b.drafts === true; if (drafts && !review) throw fail(400, 'إنشاء المسودات محتاج صلاحية المراجعة معاه.', 'DRAFTS_NEED_REVIEW');
    next['operator.view'] = true; next['operator.accounts'] = accounts; if (stores.length) next['operator.stores'] = stores; if (review) next['operator.review'] = true; if (drafts) next['operator.drafts'] = true;
  } else if (b.view !== false) throw fail(400, 'view لازم true أو false.', 'VIEW_REQUIRED');
  else if (b.review === true || b.drafts === true) throw fail(400, 'المراجعة والمسودات محتاجين صلاحية المشاهدة.', 'VIEW_REQUIRED');
  const updated = await prisma.user.update({ where: { id: target.id }, data: { permissions: JSON.stringify(next) }, select: { id: true, name: true, role: true, permissions: true } });
  await prisma.aiAuditLog.create({ data: { actor_id: admin.id, kind: 'V2_GRANTS', action: 'EXECUTE', input_json: JSON.stringify({ target: target.id, before: grantsOf(cur), after: grantsOf(next) }).slice(0, 3500), success: true } }).catch(() => {});
  return { id: updated.id, name: updated.name, grants: grantsOf(j(updated.permissions)) };
}
