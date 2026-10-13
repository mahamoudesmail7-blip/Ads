// AI Operator V2 — who may read the campaign center, and WHICH ad accounts they may see. Pure policy + one read of the known accounts; nothing here grants a write or changes a role.
//   ADMIN / owner  → every known ad account, full capabilities (approve, policies, permissions — each still behind its own existing gate)
//   MANAGER        → every known ad account, may PREPARE / SAVE drafts (never approve or execute)
//   EMPLOYEE       → READ ONLY, and ONLY when the owner granted it explicitly in the user's permissions JSON:
//                      "operator.view": true   and   "operator.accounts": ["act_…", …]   (optionally "operator.stores": [store ids] to narrow further)
//                    and, only if the admin chose so: "operator.review" (bulk REVIEW preview) and "operator.drafts" (create a PREPARED draft plan). Approval / execution can NEVER be granted here.
//                    nothing is granted by default, so no existing user's access changes. An account that is not in the list is invisible (not "empty": a request for it is refused).
// The checks live here (the Backend). The screen only hides what the user cannot do.
import { prisma } from '../../prisma.js';
import { getConnection } from '../metaAuth.js';

export const ROLE_RANK = { EMPLOYEE: 1, MANAGER: 2, ADMIN: 3 };
export const levelOf = (user) => (user?.is_owner || user?.role === 'ADMIN' ? 'ADMIN' : user?.role === 'MANAGER' ? 'MANAGER' : 'EMPLOYEE');
export const rankOf = (user) => ROLE_RANK[levelOf(user)];
export const CAPABILITIES = {
  ADMIN: { read: true, export: true, saveViews: true, shareViews: true, reviewActions: true, prepareDrafts: true, approve: true, managePolicies: true },
  MANAGER: { read: true, export: true, saveViews: true, shareViews: true, reviewActions: true, prepareDrafts: true, approve: false, managePolicies: false },
  EMPLOYEE: { read: true, export: true, saveViews: true, shareViews: false, reviewActions: false, prepareDrafts: false, approve: false, managePolicies: false },
};

/** every ad account we hold campaign data for (last 90 days) + the connected one */
export async function knownAccounts() {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const rows = await prisma.metaPerformanceSnapshot.findMany({ where: { level: 'campaign', snapshot_at: { gte: since } }, distinct: ['ad_account_id'], select: { ad_account_id: true } });
  const set = new Set(rows.map((r) => r.ad_account_id).filter(Boolean));
  try { const c = await getConnection(); if (c?.selected_ad_account_id) set.add(c.selected_ad_account_id); } catch { /* no connection: snapshots only */ }
  return [...set].sort();
}

/** → { ok, level, accounts, capabilities } | { ok:false, status, message } */
/** what an EMPLOYEE may do from the grants (never approve / execute / manage policies) */
export const employeeCapabilities = (p = {}) => { const review = p['operator.review'] === true; return { ...CAPABILITIES.EMPLOYEE, reviewActions: review, prepareDrafts: review && p['operator.drafts'] === true }; };
export async function resolveAccess(user, { known = null } = {}) {
  if (!user) return { ok: false, status: 401, message: 'لازم تسجل دخول أولاً.' };
  const level = levelOf(user); const all = known || await knownAccounts();
  if (level !== 'EMPLOYEE') return { ok: true, level, accounts: all, stores: null, capabilities: CAPABILITIES[level] };
  const p = user.permissions || {};
  if (p['operator.view'] !== true) return { ok: false, status: 403, message: 'مفيش صلاحية عرض مركز الحملات لحسابك. اطلب من المسؤول يفعّلها.' };
  const granted = Array.isArray(p['operator.accounts']) ? p['operator.accounts'].map(String) : [];
  const accounts = all.filter((a) => granted.includes(a));
  if (!accounts.length) return { ok: false, status: 403, message: 'مفيش حسابات إعلانية مسموح لك بيها.' };
  const stores = Array.isArray(p['operator.stores']) && p['operator.stores'].length ? p['operator.stores'].map(String) : null;
  return { ok: true, level, accounts, stores, capabilities: employeeCapabilities(p) };
}

/** Express middleware: sets req.v2 = { level, accounts, capabilities } or answers 401/403. */
export function v2Access() {
  return async (req, res, next) => {
    try { const a = await resolveAccess(req.user); if (!a.ok) return res.status(a.status).json({ error: a.status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN', message: a.message }); req.v2 = a; next(); } catch (e) { next(e); }
  };
}
/** Express middleware factory: requires a capability (e.g. 'reviewActions'). */
export const requireCapability = (cap) => (req, res, next) => (req.v2?.capabilities?.[cap] ? next() : res.status(403).json({ error: 'FORBIDDEN', message: 'مفيش صلاحية كافية لعمل ده.' }));
