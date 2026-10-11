// ✅ AUTOMATIC READINESS — «ممنوع تشغيل Automatic على منتج ناقص». One verdict per product, used in THREE places so they can never disagree:
//   1) when an ADMIN tries to ACTIVATE a product policy in AUTOMATIC mode (refused with the exact missing list),
//   2) by the automation engine at every tick (a product that stopped being complete is skipped with NEEDS_CONFIGURATION — nothing executes),
//   3) by the UI checklist (what is missing and where to fix it).
// Required for AUTOMATIC: an ACTIVE product policy in mode AUTOMATIC · complete economics (Smart Pricing) · known stock · a verified campaign mapping · required spend limits (daily cap + min/max budget)
// · CPA limits (scale / reduce / hard stop) · the pause policy enabled AND approved at its current version. Nothing is assumed: an unknown value is a missing value.
import { readinessList } from './operatorReadiness.js';
import { getProductPolicy, mergeEffective } from './productPolicy.js';
import { getPausePolicy, pausePolicyActive } from './pausePolicy.js';
import { getOpenCpaPolicy } from './openCpaPolicy.js';

export const REQUIRED_KEYS = ['POLICY_ACTIVE', 'MODE_AUTOMATIC', 'ECONOMICS', 'STOCK', 'MAPPING', 'SPEND_LIMITS', 'CPA_LIMITS', 'PAUSE_POLICY'];
const check = (key, label, ok, detail, fix, required = true) => ({ key, label, ok: !!ok, detail, fix: ok ? null : fix, required });

/** Pure. row = one entry of readinessList() (or null), policy = ACTIVE product policy (or null), pause/open = the saved global policies. */
export function evaluateReadiness({ row, policy, pause, open = null, minStockRequired = null }) {
  const eff = policy ? mergeEffective(policy) : null; const b = eff?.budget || {}; const c = eff?.cpa || {};
  const checks = [
    check('POLICY_ACTIVE', 'سياسة المنتج مفعّلة (مش مسودة)', !!policy, policy ? 'مفعّلة' : 'مفيش سياسة مفعّلة', { tab: 'rules', label: 'فعّل سياسة المنتج من «قواعد المنتج»' }),
    check('MODE_AUTOMATIC', 'وضع المنتج AUTOMATIC', policy?.mode === 'AUTOMATIC', `الوضع: ${policy?.mode || '—'}`, { tab: 'rules', label: 'اختار AUTOMATIC في سياسة المنتج' }),
    check('ECONOMICS', 'اقتصاديات المنتج مكتملة (تكلفة + شحن + سعر + CPA متوقع)', row?.economicsComplete, row?.economicsComplete ? 'مكتملة' : 'ناقصة', { tab: 'pricing', label: 'أكمل التكلفة والشحن من «التسعير الذكي»' }),
    check('STOCK', minStockRequired ? `المخزون معروف وأعلى من الحد الأدنى (${minStockRequired})` : 'المخزون معروف', row?.stockKnown && (minStockRequired == null || Number(row.stock) >= minStockRequired), row?.stockKnown ? `المخزون ${row.stock}` : 'غير معروف', { tab: 'integration', label: 'سجّل المخزون أو اربط الـInventory' }),
    check('MAPPING', 'حملة واحدة على الأقل مربوطة بالمنتج بشكل مؤكد', (row?.campaignsMapped || 0) >= 1, `${row?.campaignsMapped || 0} حملة مؤكدة`, { tab: 'integration', label: 'أكّد ربط الحملات بالمنتج' }),
    check('SPEND_LIMITS', 'حدود الصرف مطلوبة: الحد اليومي للمنتج + أقل وأقصى ميزانية', b.dailySpendCap != null && b.minBudget != null && b.maxBudget != null, b.dailySpendCap != null && b.minBudget != null && b.maxBudget != null ? `سقف ${b.dailySpendCap} · ${b.minBudget}–${b.maxBudget}` : `ناقص: ${[b.dailySpendCap == null && 'الحد اليومي', b.minBudget == null && 'أقل ميزانية', b.maxBudget == null && 'أقصى ميزانية'].filter(Boolean).join('، ')}`, { tab: 'rules', label: 'حدّد الحد اليومي وأقل/أقصى ميزانية في سياسة المنتج' }),
    check('CPA_LIMITS', 'حدود الـCPA: Scale وReduce وHard Stop', c.scale != null && c.reduce != null && c.hardStop != null, c.scale != null && c.reduce != null && c.hardStop != null ? `Scale ≤ ${c.scale} · Reduce ≥ ${c.reduce} · Hard Stop ${c.hardStop}` : `ناقص: ${[c.scale == null && 'Scale', c.reduce == null && 'Reduce', c.hardStop == null && 'Hard Stop'].filter(Boolean).join('، ')}`, { tab: 'rules', label: 'حدّد حدود الـCPA في سياسة المنتج' }),
    check('PAUSE_POLICY', 'سياسة الإيقاف مفعّلة ومعتمدة بنسختها الحالية', pausePolicyActive(pause), pausePolicyActive(pause) ? `v${pause.version}` : pause?.enabled ? 'في نسخة جديدة محتاجة اعتماد' : 'مش مفعّلة', { tab: 'pause', label: 'اعتمد سياسة الإيقاف' }),
    check('OPEN_POLICY', 'سياسة الفتح معتمدة (مطلوبة لو الفتح تلقائي)', !!(open?.enabled && open.approved?.version === open.version), open?.enabled ? `v${open.version}` : 'مش مفعّلة — الفتح هيفضل بموافقتك', { tab: 'open', label: 'اعتمد سياسة الفتح لو عايز فتح تلقائي' }, false),
  ];
  const missing = checks.filter((x) => x.required && !x.ok);
  return { ready: missing.length === 0, state: missing.length === 0 ? 'READY' : (checks.filter((x) => x.required && x.ok).length >= 5 ? 'PARTIAL' : 'BLOCKED'), checks, missing: missing.map((m) => ({ key: m.key, label: m.label, detail: m.detail, fix: m.fix })) };
}

/** Readiness of ONE product (live data). deps.rows / deps.pause / deps.open / deps.policy for tests. */
export async function productAutomationReadiness({ productId, storeId = null, deps = {} }) {
  const rows = deps.rows || await readinessList({});
  const row = rows.find((r) => Number(r.productId) === Number(productId) && (!storeId || storeId === 'default' || r.storeId === storeId)) || null;
  const pol = deps.policy !== undefined ? deps.policy : (await getProductPolicy({ productId, storeId: storeId || row?.storeId })).active;
  const [pause, open] = await Promise.all([deps.pause || getPausePolicy(), deps.open !== undefined ? deps.open : getOpenCpaPolicy().catch(() => null)]);
  return { productId: Number(productId), storeId: storeId || row?.storeId || 'default', name: row?.name || null, ...evaluateReadiness({ row, policy: pol, pause, open, minStockRequired: open?.enabled ? open.minStock : null }) };
}
/** Same verdict for every product that has an ACTIVE policy (what the engine iterates). Returns Map(`${storeId}:${productId}` → verdict). */
export async function automationReadinessMap({ deps = {} } = {}) {
  const { loadActivePolicies, policyKey } = await import('./productPolicy.js');
  const [rows, pols, pause, open] = await Promise.all([deps.rows || readinessList({}), deps.policies || loadActivePolicies(), deps.pause || getPausePolicy(), deps.open !== undefined ? deps.open : getOpenCpaPolicy().catch(() => null)]);
  const out = new Map();
  for (const r of rows) { const k = policyKey(r.storeId, r.productId); out.set(k, { productId: r.productId, storeId: r.storeId, name: r.name, ...evaluateReadiness({ row: r, policy: pols.get(k) || null, pause, open, minStockRequired: open?.enabled ? open.minStock : null }) }); }
  return out;
}
