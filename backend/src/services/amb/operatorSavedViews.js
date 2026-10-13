// AI Operator V2 — saved views of the campaign center, stored per user in the database.
// A view is a PRESENTATION preference (filters, period, columns, sort): it never grants access, never changes a policy and never starts an action.
//   • every view's config goes through the SAME validation as a live query (unknown fields/periods/columns are refused), so a stored view can never smuggle a bad filter
//   • sharing: only MANAGER / ADMIN may share; a shared view is visible to users who already have access to the campaign center (optionally from a minimum role up) and it NEVER widens THEIR data scope —
//     when they open it, the query is still intersected with THEIR allowed ad accounts on the server
//   • edit: the owner only · delete: the owner, or an ADMIN for a shared view
import { prisma } from '../../prisma.js';
import { sanitizeConds, PERIOD_KEYS, SORT_KEYS, FIELDS } from './campaignQuery.js';
import { ROLE_RANK, levelOf } from './operatorV2Access.js';

export const MAX_VIEWS_PER_USER = 50; const SCOPE = 'CAMPAIGNS';
export const COLUMN_KEYS = ['name', 'account', 'store', 'product', 'status', 'budget', 'spendToday', 'ordersToday', 'cpaToday', 'spendPeriod', 'ordersPeriod', 'cpaPeriod', 'cpa3', 'cpa7', 'cpa14', 'cpa30', 'cpa60', 'roas', 'zones', 'budgetLevel', 'lastSync', 'lastDecision', 'winner', 'recommendation', 'approval', 'eligibility', 'lastPause', 'lastBudgetChange'];
const VIEW_KEYS = ['all', 'open', 'pause', 'up', 'down', 'review'];
const fail = (status, message, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function sanitizeConfig(cfg) {
  const c = cfg || {}; const out = {};
  out.view = VIEW_KEYS.includes(c.view) ? c.view : 'all';
  out.period = { key: PERIOD_KEYS.includes(c.period?.key) ? c.period.key : 'last7' }; if (out.period.key === 'custom') { const re = /^\d{4}-\d{2}-\d{2}$/; if (!re.test(String(c.period?.from)) || !re.test(String(c.period?.to))) throw fail(400, 'الفترة المخصصة في العرض محتاجة تاريخين صالحين.'); out.period.from = c.period.from; out.period.to = c.period.to; }
  out.compare = c.compare === true; out.logic = c.logic === 'OR' ? 'OR' : 'AND'; out.conds = sanitizeConds(c.conds); out.search = String(c.search ?? '').slice(0, 100);
  const sk = c.sort?.k ?? 'spendPeriod'; if (!SORT_KEYS.includes(sk)) throw fail(400, `ترتيب غير مدعوم في العرض: ${sk}`); out.sort = { k: sk, d: Number(c.sort?.d) === 1 ? 1 : -1 };
  const cols = Array.isArray(c.columns) ? c.columns.map(String) : []; const bad = cols.filter((x) => !COLUMN_KEYS.includes(x)); if (bad.length) throw fail(400, `أعمدة غير معروفة: ${bad.slice(0, 3).join(', ')}`); out.columns = cols.length ? [...new Set(cols)] : null;
  out.pageSize = Math.min(200, Math.max(5, Math.floor(Number(c.pageSize) || 25)));
  void FIELDS; return out;
}
const shape = (v, me) => ({ id: v.id, name: v.name, shared: v.shared, sharedMinRole: v.shared_min_role, mine: v.owner_id === me.id, ownerId: v.owner_id, config: j(v.config_json, {}), updatedAt: v.updated_at.toISOString() });
const cleanName = (n) => { const s = String(n ?? '').trim(); if (!s || s.length > 80) throw fail(400, 'اسم العرض لازم يكون من 1 لـ 80 حرف.'); return s; };
const sharing = (user, shared, minRole) => {
  if (!shared) return { shared: false, shared_min_role: null };
  if (levelOf(user) === 'EMPLOYEE') throw fail(403, 'مشاركة العروض للمشرف والمسؤول فقط.', 'SHARE_FORBIDDEN');
  const m = minRole == null || minRole === '' ? null : String(minRole); if (m && !ROLE_RANK[m]) throw fail(400, 'أقل دور للمشاركة غير معروف.'); return { shared: true, shared_min_role: m };
};

export async function listViews({ user }) {
  const rank = ROLE_RANK[levelOf(user)];
  const rows = await prisma.ambOperatorSavedView.findMany({ where: { scope: SCOPE, OR: [{ owner_id: user.id }, { shared: true }] }, orderBy: [{ name: 'asc' }] });
  return rows.filter((v) => v.owner_id === user.id || !v.shared_min_role || rank >= ROLE_RANK[v.shared_min_role]).map((v) => shape(v, user));
}
export async function createView({ user, name, config, shared = false, sharedMinRole = null }) {
  const nm = cleanName(name); const cfg = sanitizeConfig(config); const sh = sharing(user, shared, sharedMinRole);
  if ((await prisma.ambOperatorSavedView.count({ where: { owner_id: user.id, scope: SCOPE } })) >= MAX_VIEWS_PER_USER) throw fail(400, `أقصى عدد عروض محفوظة ${MAX_VIEWS_PER_USER}.`, 'TOO_MANY_VIEWS');
  try { const v = await prisma.ambOperatorSavedView.create({ data: { owner_id: user.id, scope: SCOPE, name: nm, config_json: JSON.stringify(cfg), ...sh } }); return shape(v, user); }
  catch (e) { if (e.code === 'P2002') throw fail(409, 'عندك عرض بنفس الاسم.', 'DUPLICATE_NAME'); throw e; }
}
export async function updateView({ user, id, name, config, shared, sharedMinRole }) {
  const v = await prisma.ambOperatorSavedView.findUnique({ where: { id: Number(id) } }); if (!v || v.scope !== SCOPE || v.owner_id !== user.id) throw fail(404, 'العرض غير موجود.', 'VIEW_NOT_FOUND');
  const data = {}; if (name !== undefined) data.name = cleanName(name); if (config !== undefined) data.config_json = JSON.stringify(sanitizeConfig(config)); if (shared !== undefined) Object.assign(data, sharing(user, shared, sharedMinRole));
  try { return shape(await prisma.ambOperatorSavedView.update({ where: { id: v.id }, data }), user); } catch (e) { if (e.code === 'P2002') throw fail(409, 'عندك عرض بنفس الاسم.', 'DUPLICATE_NAME'); throw e; }
}
export async function deleteView({ user, id }) {
  const v = await prisma.ambOperatorSavedView.findUnique({ where: { id: Number(id) } }); if (!v || v.scope !== SCOPE) throw fail(404, 'العرض غير موجود.', 'VIEW_NOT_FOUND');
  if (v.owner_id !== user.id && !(v.shared && levelOf(user) === 'ADMIN')) throw fail(404, 'العرض غير موجود.', 'VIEW_NOT_FOUND'); // never reveal someone else's private view
  await prisma.ambOperatorSavedView.delete({ where: { id: v.id } }); return { ok: true };
}
/** duplicate = a new PRIVATE view owned by the caller (copying a shared view never copies its sharing) */
export async function duplicateView({ user, id }) {
  const rank = ROLE_RANK[levelOf(user)]; const v = await prisma.ambOperatorSavedView.findUnique({ where: { id: Number(id) } });
  if (!v || v.scope !== SCOPE || !(v.owner_id === user.id || (v.shared && (!v.shared_min_role || rank >= ROLE_RANK[v.shared_min_role])))) throw fail(404, 'العرض غير موجود.', 'VIEW_NOT_FOUND');
  let name = `${v.name} (نسخة)`; for (let n = 2; await prisma.ambOperatorSavedView.findFirst({ where: { owner_id: user.id, scope: SCOPE, name } }); n++) name = `${v.name} (نسخة ${n})`;
  return createView({ user, name, config: j(v.config_json, {}) });
}
