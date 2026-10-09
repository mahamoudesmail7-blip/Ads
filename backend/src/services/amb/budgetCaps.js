// 💰 Budget Caps — a ceiling on DAILY budget at three levels: campaign, product and the whole ad account. They limit INCREASES only (a reduction can never violate a cap).
// null = no cap. Changing a cap needs an ADMIN + explicit confirmation + audit. The bridge checks them at prepare time AND again at execution time.
import { prisma } from '../../prisma.js';
import { getOperatorConfig } from './operatorStore.js';
import { discoverBudgetEntities, loadBudgetStructureFromSnapshots } from './budgetOptimizer.js';

export const CAP_KEYS = ['campaign', 'product', 'account'];
export const CAP_LABEL = { campaign: 'الحملة', product: 'المنتج', account: 'الحساب' };
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const asCap = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : undefined));

export async function getBudgetCaps() {
  const cfg = await getOperatorConfig(); const c = cfg.limits?.budgetCaps || {};
  return Object.fromEntries(CAP_KEYS.map((k) => [k, asCap(c[k]) ?? null]));
}

export async function setBudgetCaps({ caps, confirm, userId, deps = {} }) {
  const u = deps.user || await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, role: true, status: true } });
  if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') { const e = new Error('تغيير حدود الميزانية محتاج ADMIN.'); e.status = 403; throw e; }
  if (confirm !== true) { const e = new Error('تغيير الحدود محتاج تأكيد صريح (confirm).'); e.status = 400; e.code = 'CONFIRM_REQUIRED'; throw e; }
  const next = {}; for (const k of CAP_KEYS) { if (!(k in (caps || {}))) continue; const v = asCap(caps[k]); if (v === undefined) { const e = new Error(`حد ${CAP_LABEL[k]} لازم يكون رقم موجب أو فاضي (بدون حد).`); e.status = 400; throw e; } next[k] = v; }
  const row = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const raw = j(row?.limits_json, null) || {};
  const before = Object.fromEntries(CAP_KEYS.map((k) => [k, asCap(raw.budgetCaps?.[k]) ?? null])); const after = { ...before, ...next };
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...raw, budgetCaps: after }), updated_by_id: userId } });
  await prisma.aiAuditLog.create({ data: { actor_id: Number(userId), kind: 'OPERATOR_BUDGET_CAPS', action: 'EXECUTE', input_json: JSON.stringify({ from: before, to: after }), success: true } }).catch(() => {});
  await prisma.ambOperatorEvent.create({ data: { kind: 'BUDGET_CAPS_CHANGE', actor: 'USER', actor_id: Number(userId), note: `حدود الميزانية: ${CAP_KEYS.map((k) => `${CAP_LABEL[k]} ${before[k] ?? '—'}→${after[k] ?? '—'}`).join(' · ')}`, data_json: JSON.stringify({ from: before, to: after }) } }).catch(() => {});
  return after;
}

/** Current DAILY budget totals (from the synced Meta structure): this campaign, its product's active campaigns, and every active campaign of the account. */
export async function currentBudgetTotals({ adAccountId, campaignId, productId = null, now = new Date(), deps = {} }) {
  const structure = deps.structure || await loadBudgetStructureFromSnapshots({ adAccountId, now });
  const sumOf = (id) => { const s = structure.get(id); if (!s || s.campaign?.status !== 'ACTIVE') return 0; const d = discoverBudgetEntities(s); return (d.entities || []).reduce((t, e) => t + (Number(e.budget) || 0), 0); };
  let account = 0; for (const id of structure.keys()) account += sumOf(id);
  let product = null;
  if (productId != null) { const ids = deps.productCampaignIds ? await deps.productCampaignIds(productId) : (await (await import('./productPerformance.js')).resolveProductCampaigns(productId)).map((c) => c.campaignId); product = ids.reduce((t, id) => t + sumOf(id), 0); }
  return { campaign: sumOf(campaignId), product, account };
}

/** Would raising a daily budget by `delta` break a cap? Reductions (delta <= 0) always pass. Returns {ok, violations[], caps, totals}. */
export async function checkBudgetCaps({ action, delta, adAccountId, campaignId, productId = null, productCapOverride = null, now = new Date(), deps = {} }) {
  const caps = { ...(deps.caps || await getBudgetCaps()) };
  if (productCapOverride != null && Number(productCapOverride) > 0) caps.product = Math.round(Number(productCapOverride)); // a product policy's own daily cap replaces the global product cap for THAT product
  if (!(delta > 0) || !['SCALE_UP', 'INCREASE_BUDGET'].includes(action)) return { ok: true, violations: [], caps, totals: null };
  if (CAP_KEYS.every((k) => caps[k] == null)) return { ok: true, violations: [], caps, totals: null };
  const totals = deps.totals || await currentBudgetTotals({ adAccountId, campaignId, productId, now, deps });
  const violations = [];
  for (const k of CAP_KEYS) { if (caps[k] == null || totals[k] == null) continue; const after = totals[k] + delta; if (after > caps[k]) violations.push({ level: k, label: CAP_LABEL[k], cap: caps[k], current: Math.round(totals[k]), after: Math.round(after) }); }
  return { ok: violations.length === 0, violations, caps, totals };
}
