// 🧮 BULK AUTOMATION — one table for every product (READY / NEEDS_CONFIGURATION / BLOCKED), bulk draft configuration, bulk preview and a GATED bulk activation.
//   · Overview / preview are READ-ONLY. Bulk configure only writes product policy DRAFTS (nothing is activated, nothing reaches Meta).
//   · Bulk activation is refused unless the owner confirms the EXACT numbers the preview computed (products, campaigns, running exposure, global version, policy versions), the account daily exposure cap and every product's
//     daily cap are set, the exposure fits under them, and each product is READY on its INHERITED values. It then uses the normal per-product activation path (which re-checks readiness). Activation does NOT open Meta writes,
//     does not change the system mode and does not touch a single campaign: the deployment lock, the execution permissions and the mode still decide whether anything runs.
//   · A product is never READY on assumed numbers: missing economics / CPA / budget limits / pause policy keep it NEEDS_CONFIGURATION. Unconfirmed campaign mappings are excluded and listed.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { getOperatorConfig, listExceptions } from './operatorStore.js';
import { readinessList, mappingCenter } from './operatorReadiness.js';
import { policyBook, policyKey, normalizePolicy, validatePolicy, overlayGlobal, mergeEffective, saveDraft, activatePolicy } from './productPolicy.js';
import { evaluateReadiness } from './automationReadiness.js';
import { getPausePolicy } from './pausePolicy.js';
import { getOpenCpaPolicy } from './openCpaPolicy.js';
import { windowRange } from './operatorRules.js';
import { cairoDate } from './dailyPlanTime.js';

const fail = (status, message, code, details) => { const e = new Error(message); e.status = status; if (code) e.code = code; if (details) e.details = details; return e; };
const round = (x) => Math.round(Number(x) || 0);
const cpaOf = (spend, orders) => (orders > 0 ? Math.round(spend / orders) : null);
const REASON_AR = { UNMAPPED: 'مش مربوطة بمنتج', SUGGESTED: 'الربط مجرد اقتراح (مش مؤكد)', CONFLICT: 'تعارض في الربط', EXTERNAL_STORE: 'متجر خارجي' };

async function requireAdmin(userId, deps = {}) { const u = deps.user || await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, role: true, status: true } }); if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') throw fail(403, 'ده محتاج ADMIN.', 'FORBIDDEN'); return u; }

/** The would-be policy of a product if it were enrolled with the global rules: its own active (inherited) policy, else its draft ← global, else global alone; the mode is forced to AUTOMATIC because that is what is being evaluated. */
function wouldBePolicy(book, key) {
  const e = book.products[key] || {}; const g = book.global.active;
  const base = e.active ? overlayGlobal(g, e.active) : e.draft ? overlayGlobal(g, e.draft) : (g ? overlayGlobal(g, normalizePolicy({})) : normalizePolicy({}));
  return { ...base, mode: 'AUTOMATIC' };
}

/** Everything the owner needs in ONE table. deps (tests): rows, mapRows, world, exposure, pause, open, exceptions, book, config, openCandidates. */
export async function bulkOverview({ now = new Date(), deps = {} } = {}) {
  const [rows, book, pause, open, config, exceptions] = await Promise.all([deps.rows || readinessList({}), deps.book || policyBook(), deps.pause || getPausePolicy(), deps.open !== undefined ? deps.open : getOpenCpaPolicy().catch(() => null), deps.config || getOperatorConfig(), deps.exceptions || listExceptions({}).catch(() => [])]);
  let world = deps.world; if (!world) { const { buildOperatorWorld } = await import('./operatorContext.js'); world = await buildOperatorWorld({ windowKeys: ['today', 'last3', 'last7', 'last30'], now }); }
  const mapRows = deps.mapRows || (world.adAccountId ? (await mappingCenter({ adAccountId: world.adAccountId, limit: 5000 })).rows : []);
  let exposureBy = deps.exposure; if (!exposureBy) { try { const { activeExposure } = await import('./automationScope.js'); exposureBy = (await activeExposure({ adAccountId: world.adAccountId, now })).byCampaign; } catch { exposureBy = new Map(); } }
  const win = (k, id) => world.windows?.[k]?.get(id) || null;
  const noAuto = new Set(exceptions.filter((x) => x.types?.includes('NO_AUTOMATION') && ['PRODUCT', 'STORE'].includes(x.scope_type)).map((x) => `${x.scope_type}:${x.scope_id}`));
  const byProd = new Map(); const excluded = [];
  for (const r of mapRows) {
    if (!['ACTIVE', 'PAUSED'].includes(r.campaignStatus)) continue;
    if (r.state !== 'VERIFIED' || !r.product?.productId || r.excluded) { if (r.campaignStatus === 'ACTIVE' || r.spend7d > 0) excluded.push({ campaignId: r.campaignId, name: r.campaignName, status: r.campaignStatus, state: r.excluded ? 'EXCLUDED' : r.state, reason: r.excluded ? 'مستبعدة (NO_AUTOMATION)' : (REASON_AR[r.state] || r.state), productHint: r.product?.name || r.detectedProductKey || null, spend7d: r.spend7d }); continue; }
    const e = byProd.get(r.product.productId) || { campaigns: [] }; e.campaigns.push(r); byProd.set(r.product.productId, e);
  }
  const products = [];
  for (const row of rows) {
    const key = policyKey(row.storeId, row.productId); const mine = byProd.get(row.productId)?.campaigns || [];
    const m = (k) => mine.reduce((t, c) => { const w = win(k, c.campaignId); return { spend: t.spend + (w?.spend || 0), orders: t.orders + (w?.purchases || 0) }; }, { spend: 0, orders: 0 });
    const m0 = m('today'), m3 = m('last3'), m7 = m('last7'), m30 = m('last30'); const pf = (x) => ({ spend: round(x.spend), orders: x.orders, cpa: cpaOf(x.spend, x.orders) }); const active = mine.filter((c) => c.campaignStatus === 'ACTIVE');
    if (!mine.length && !(row.campaignsMapped > 0)) { /* no campaign at all: still listed so the owner sees it is BLOCKED, but only when it ever had orders */ if (!m7.orders && !m30.orders) continue; }
    const wp = wouldBePolicy(book, key); const rd = evaluateReadiness({ row, policy: wp, pause, open, minStockRequired: open?.enabled ? open.minStock : null });
    const toBeSet = new Set(['POLICY_ACTIVE', 'MODE_AUTOMATIC']); const missing = rd.missing.filter((x) => !toBeSet.has(x.key));
    const noAutoEx = noAuto.has(`PRODUCT:${row.productId}`) || noAuto.has(`STORE:${row.storeId}`);
    const blocked = !mine.length || noAutoEx; const state = blocked ? 'BLOCKED' : missing.length ? 'NEEDS_CONFIGURATION' : 'READY';
    const pol = book.products[key] || null; const eff = mergeEffective(wp);
    products.push({ key, productId: row.productId, storeId: row.storeId, name: row.name, state, blockedReason: blocked ? (noAutoEx ? 'استثناء NO_AUTOMATION على المنتج/المتجر' : 'مفيش حملة مربوطة بشكل مؤكد') : null, missing: missing.map((x) => ({ key: x.key, label: x.label, detail: x.detail })),
      orders7: m7.orders, cpa: { d3: cpaOf(m3.spend, m3.orders), d7: cpaOf(m7.spend, m7.orders), d30: cpaOf(m30.spend, m30.orders) }, perf: { today: pf(m0), last3: pf(m3), last7: pf(m7), last30: pf(m30) }, campaigns: { mapped: mine.length, active: active.length, ids: mine.map((c) => c.campaignId) }, runningBudget: round(active.reduce((t, c) => t + (exposureBy.get(c.campaignId) || 0), 0)),
      policy: { status: pol?.active ? (pol.draft ? 'ACTIVE_WITH_DRAFT' : 'ACTIVE') : pol?.draft ? 'DRAFT' : 'NONE', mode: pol?.active?.mode || pol?.draft?.mode || null, version: pol?.version || 0 }, limits: { minPurchases: eff.budget.minPurchases, zeroSpend: eff.zeroOrder.spend, increasePct: eff.budget.increasePct, decreasePct: eff.budget.decreasePct, cpaScaleMin: eff.cpa.scaleMin, cpaScale: eff.cpa.scale, cpaReduce: eff.cpa.reduce, hardStop: eff.cpa.hardStop, dailyCap: eff.budget.dailySpendCap, minBudget: eff.budget.minBudget, maxBudget: eff.budget.maxBudget, maxChangesPerDay: eff.budget.maxChangesPerDay },
      economicsComplete: !!row.economicsComplete, stockKnown: !!row.stockKnown });
  }
  const order = { READY: 0, NEEDS_CONFIGURATION: 1, BLOCKED: 2 }; products.sort((a, b) => order[a.state] - order[b.state] || b.orders7 - a.orders7);
  const count = (s) => products.filter((p) => p.state === s).length;
  return { generatedAt: now.toISOString(), global: { rulesVersion: book.global.active ? book.global.version : null, rulesStatus: book.global.status, pausePolicyApproved: !!(pause.enabled && pause.approved?.version === pause.version), openPolicy: open && { enabled: !!open.enabled, approved: open.approved?.version === open.version, minCpa: open.minCpa, maxCpa: open.maxCpa, window: open.window, minPurchases: open.minPurchases }, accountCap: config.limits?.account?.maxDailySpendUnderAi ?? null, writesLocked: config.writesLocked !== false, mode: config.mode, permissions: config.execPermissions || {}, emergencyStop: !!config.emergency_stop },
    totals: { products: products.length, READY: count('READY'), NEEDS_CONFIGURATION: count('NEEDS_CONFIGURATION'), BLOCKED: count('BLOCKED'), mappedCampaigns: products.reduce((t, p) => t + p.campaigns.mapped, 0), excludedCampaigns: excluded.length, runningBudget: products.reduce((t, p) => t + p.runningBudget, 0) },
    windows: Object.fromEntries(['today', 'last3', 'last7', 'last30'].map((k) => [k, windowRange(k, cairoDate(now))])), // the real date range behind each period chip
    products, excluded: excluded.sort((a, b) => (b.spend7d || 0) - (a.spend7d || 0)).slice(0, 80) };
}

const hashOf = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);

/** READ-ONLY. The scope the owner would approve: READY products among `productKeys` (or all READY), their campaigns and the money exposed. */
export async function bulkPreview({ productKeys = null, now = new Date(), deps = {} } = {}) {
  const ov = deps.overview || await bulkOverview({ now, deps });
  const want = productKeys ? new Set(productKeys) : null; const chosen = ov.products.filter((p) => (!want || want.has(p.key)));
  const included = chosen.filter((p) => p.state === 'READY'); const notIncluded = chosen.filter((p) => p.state !== 'READY').map((p) => ({ key: p.key, name: p.name, state: p.state, why: p.blockedReason || p.missing.map((m) => m.label).join(' · ') }));
  const book = deps.book || await policyBook(); const blockers = [];
  const accountCap = ov.global.accountCap; const running = included.reduce((t, p) => t + p.runningBudget, 0);
  if (!included.length) blockers.push({ code: 'NO_READY_PRODUCT', message: 'مفيش منتج READY في النطاق المختار.' });
  if (accountCap == null) blockers.push({ code: 'ACCOUNT_CAP_MISSING', message: 'سقف التعرض اليومي للحساب مش محدد (حدود الحساب ← الصرف اليومي تحت الـAI).' });
  else if (running > accountCap) blockers.push({ code: 'ACCOUNT_CAP_EXCEEDED', message: `الميزانيات الشغالة ${running} أكبر من سقف الحساب ${accountCap}.` });
  for (const p of included) { if (p.limits.dailyCap == null) blockers.push({ code: 'PRODUCT_CAP_MISSING', productKey: p.key, message: `سقف المنتج اليومي مش محدد: ${p.name}` }); else if (p.runningBudget > p.limits.dailyCap) blockers.push({ code: 'PRODUCT_CAP_EXCEEDED', productKey: p.key, message: `ميزانيات ${p.name} الشغالة ${p.runningBudget} أكبر من سقفه ${p.limits.dailyCap}.` }); }
  if (!ov.global.pausePolicyApproved) blockers.push({ code: 'PAUSE_POLICY_NOT_APPROVED', message: 'سياسة الإيقاف غير معتمدة.' });
  const confirm = { products: included.length, campaigns: included.reduce((t, p) => t + p.campaigns.mapped, 0), activeCampaigns: included.reduce((t, p) => t + p.campaigns.active, 0), runningExposure: running, globalRulesVersion: ov.global.rulesVersion, accountCap, productVersions: Object.fromEntries(included.map((p) => [p.key, (book.products[p.key]?.version || 0)])) };
  confirm.hash = hashOf({ keys: included.map((p) => p.key).sort(), confirm: { ...confirm, hash: undefined } });
  return { generatedAt: ov.generatedAt, included: included.map((p) => ({ key: p.key, name: p.name, orders7: p.orders7, cpa: p.cpa, campaigns: p.campaigns, runningBudget: p.runningBudget, limits: p.limits, policy: p.policy })), notIncluded, exposure: { running, accountCap, headroom: accountCap != null ? Math.max(0, accountCap - running) : null }, blockers, canActivate: blockers.length === 0, confirm,
    note: 'التفعيل الجماعي بيحوّل السياسات المعتمدة بس لـAUTOMATIC على مستوى المنتج. التنفيذ الفعلي لسه محتاج: وضع النظام AUTOMATIC + فتح قفل Meta + صلاحيات التنفيذ.' };
}

/** DRAFTS ONLY. Applies the non-empty fields of `patch` to many products' drafts (an empty field never overwrites an existing value; nothing is invented). Never activates. */
export async function bulkConfigure({ productKeys, patch, userId, deps = {} }) {
  await requireAdmin(userId, deps); if (!Array.isArray(productKeys) || !productKeys.length) throw fail(400, 'اختار منتج واحد على الأقل.', 'NO_PRODUCTS');
  const p = normalizePolicy({ ...(patch || {}), campaigns: {} }); const errors = validatePolicy(p); if (errors.length) { const e = fail(400, errors.join(' '), 'INVALID_POLICY'); e.details = errors; throw e; }
  const book = deps.book || await policyBook(); const done = [], skipped = [];
  const merge = (cur, add) => { const out = JSON.parse(JSON.stringify(cur)); const put = (a, b) => { for (const k of Object.keys(b)) if (b[k] !== null && b[k] !== undefined) a[k] = b[k]; }; put(out.cpa, add.cpa); put(out.zeroOrder, add.zeroOrder); put(out.budget, add.budget); put(out.schedule, add.schedule); if (add.manualOverrideHours != null) out.manualOverrideHours = add.manualOverrideHours; if (add.stockPolicy) out.stockPolicy = add.stockPolicy; if (add.mode) out.mode = add.mode; return out; };
  for (const key of productKeys) {
    const [storeId, pid] = [key.slice(0, key.lastIndexOf(':')), Number(key.slice(key.lastIndexOf(':') + 1))]; if (!Number.isFinite(pid)) { skipped.push({ key, why: 'مفتاح غير صالح' }); continue; }
    const cur = book.products[key]; const base = normalizePolicy(cur?.draft || cur?.active || {}); const next = merge(base, p);
    try { await saveDraft({ productId: pid, storeId, policy: next, userId, deps }); done.push(key); } catch (e) { skipped.push({ key, why: e.message }); }
  }
  return { drafted: done, skipped, note: 'اتحفظت كمسودات فقط — مفيش سياسة اتفعّلت ومفيش حاجة اتنفذت.' };
}

/**
 * ADMIN. Activates AUTOMATIC product policies for the READY products of `productKeys`, ONLY if `confirm` equals what the preview computes right now (so what the owner approved is exactly what gets activated),
 * `confirmAutomatic` is true, and no preview blocker exists. Each product goes through the normal activation path. Nothing is sent to Meta.
 */
export async function bulkActivate({ productKeys, confirm, confirmAutomatic = false, userId, now = new Date(), deps = {} }) {
  await requireAdmin(userId, deps);
  if (confirmAutomatic !== true) throw fail(400, 'التفعيل الجماعي لـAUTOMATIC محتاج تأكيد صريح (confirmAutomatic).', 'CONFIRM_AUTOMATIC_REQUIRED');
  if (!confirm || typeof confirm !== 'object') throw fail(400, 'محتاج تأكيد أرقام النطاق (confirm) زي ما المعاينة عرضتها.', 'CONFIRM_REQUIRED');
  const pv = await bulkPreview({ productKeys, now, deps });
  if (pv.blockers.length) throw fail(409, `التفعيل الجماعي ممنوع: ${pv.blockers.map((b) => b.message).join(' · ')}`, 'BULK_BLOCKED', pv.blockers);
  if (confirm.hash !== pv.confirm.hash || confirm.products !== pv.confirm.products || confirm.campaigns !== pv.confirm.campaigns || Number(confirm.runningExposure) !== pv.confirm.runningExposure) throw fail(409, 'الأرقام اللي اعتمدتها اتغيّرت من وقت المعاينة — راجع المعاينة من جديد قبل التفعيل.', 'CONFIRM_MISMATCH', { current: pv.confirm });
  const book = deps.book || await policyBook(); const activated = [], skipped = [];
  for (const p of pv.included) {
    const [storeId, pid] = [p.key.slice(0, p.key.lastIndexOf(':')), Number(p.key.slice(p.key.lastIndexOf(':') + 1))]; const e = book.products[p.key] || {};
    try {
      let draft = e.draft || (e.active && !e.draft ? e.active : null);
      if (!e.draft) { const base = normalizePolicy(e.active || {}); if (e.active && e.active.mode === 'AUTOMATIC') { skipped.push({ key: p.key, why: 'مفعّل AUTOMATIC بالفعل' }); continue; } await saveDraft({ productId: pid, storeId, policy: { ...base, mode: 'AUTOMATIC' }, userId, deps }); }
      else if (draft.mode !== 'AUTOMATIC') { const next = normalizePolicy({ ...draft, mode: 'AUTOMATIC' }); await saveDraft({ productId: pid, storeId, policy: next, userId, deps }); }
      await activatePolicy({ productId: pid, storeId, confirm: true, confirmAutomatic: true, userId, deps }); activated.push(p.key);
    } catch (err) { skipped.push({ key: p.key, why: err.message }); }
  }
  await prisma.ambOperatorEvent.create({ data: { kind: 'BULK_ACTIVATION', actor: 'USER', actor_id: userId ?? null, note: `تفعيل جماعي لـAUTOMATIC: ${activated.length} منتج (${pv.confirm.campaigns} حملة، تعرّض ${pv.confirm.runningExposure}) — مفيش تنفيذ على Meta`, data_json: JSON.stringify({ activated, skipped, confirm: pv.confirm }).slice(0, 3500) } }).catch(() => {});
  return { activated, skipped, confirm: pv.confirm, note: 'السياسات اتفعّلت بس. مفيش حاجة اتنفذت على Meta — التنفيذ لسه محتاج وضع AUTOMATIC العام وفتح القفل والصلاحيات من الواجهة الرسمية.' };
}
