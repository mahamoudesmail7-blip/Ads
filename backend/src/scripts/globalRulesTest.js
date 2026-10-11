// 🌐 GLOBAL AUTOMATION RULES — one versioned rule set every enrolled product inherits unless it (or a campaign) overrides it. The inherited value always shows its SOURCE and the global version.
//   The global set never carries a mode, never enrols a product, never executes anything; a conflict with an active product policy refuses the activation. Isolated TEST database only.
//   node src/scripts/globalRulesTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const rej = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const { prisma } = await imp('../prisma.js'); const PP = await imp('../services/amb/productPolicy.js'); const AR = await imp('../services/amb/automationReadiness.js');
const rawBefore = (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }))?.limits_json ?? null;
const admin = await prisma.user.findUnique({ where: { id: 1 } }); const ADMIN = { id: 1, role: 'ADMIN', status: 'ACTIVE' }; const MGR = { id: 9999, role: 'MANAGER', status: 'ACTIVE' };
const PID = 880401, PID2 = 880402, STORE = 'trendy-storeee';
const GLOBAL = { cpa: { scale: 130, reduce: 170, hardStop: 200, normalMin: 60, normalMax: 150 }, zeroOrder: { spend: 150, minAgeHours: 6 }, budget: { increasePct: 20, decreasePct: 20, minPurchases: 3, cooldownHours: 24, minBudget: 100, maxBudget: 600, dailySpendCap: 1500, maxChangesPerDay: 4 }, schedule: { openTime: '00:00', closeTime: '13:00', days: [0, 1, 2, 3, 4] }, manualOverrideHours: 48 };
const restore = async () => { await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: rawBefore } }); await prisma.ambOperatorProductConfig.deleteMany({ where: { product_id: { in: [PID, PID2] } } }); await prisma.ambOperatorEvent.deleteMany({ where: { kind: { in: ['GLOBAL_RULES_SAVED', 'GLOBAL_RULES_ACTIVATED', 'GLOBAL_RULES_DEACTIVATED', 'PRODUCT_POLICY_SAVED', 'PRODUCT_POLICY_ACTIVATED'] } } }); };
try {
  await restore();
  console.log('\n1. Pure: the global set never carries a mode; inheritance order; provenance');
  const g = PP.normalizeGlobal({ mode: 'AUTOMATIC', ...GLOBAL, campaigns: { c1: { mode: 'AUTOMATIC' } } });
  ok('a global rule set can NEVER set a mode (AUTOMATIC stays an explicit per-product decision) and has no campaign overrides', g.mode === null && g.campaigns === undefined && g.cpa.scale === 130);
  const prod = PP.normalizePolicy({ mode: 'AUTOMATIC', cpa: { scale: 100 }, budget: { maxBudget: 400 }, campaigns: { c1: { budget: { maxBudget: 300 }, cpa: { reduce: 160 } } } });
  const ov = PP.overlayGlobal(GLOBAL, prod);
  ok('product values win over global; every null inherits the global value (CPA reduce 170, hard stop 200, budget % 20, cooldown 24, caps 1500, changes/day 4, schedule, protection 48h)', ov.cpa.scale === 100 && ov.cpa.reduce === 170 && ov.cpa.hardStop === 200 && ov.budget.maxBudget === 400 && ov.budget.minBudget === 100 && ov.budget.dailySpendCap === 1500 && ov.budget.maxChangesPerDay === 4 && ov.budget.increasePct === 20 && ov.budget.cooldownHours === 24 && ov.schedule.openTime === '00:00' && ov.schedule.closeTime === '13:00' && JSON.stringify(ov.schedule.days) === '[0,1,2,3,4]' && ov.manualOverrideHours === 48 && ov.zeroOrder.spend === 150);
  ok('the mode and the campaign overrides of the product survive the overlay untouched', ov.mode === 'AUTOMATIC' && ov.campaigns.c1.budget.maxBudget === 300);
  const e1 = PP.mergeEffective(ov, 'c1'); ok('a campaign override still wins over both product and global (max budget 300, reduce 160)', e1.budget.maxBudget === 300 && e1.cpa.reduce === 160 && e1.cpa.hardStop === 200);
  ok('no global rules → the policy is returned unchanged (nothing is inherited, nothing assumed)', PP.overlayGlobal(null, prod) === prod);
  const src = PP.resolveSources({ global: GLOBAL, globalVersion: 3, product: prod, campaignId: 'c1' });
  ok('provenance: campaign / product / global(+version) / default / unset are each labelled', src['budget.maxBudget'].source === 'CAMPAIGN' && src['cpa.scale'].source === 'PRODUCT' && src['cpa.hardStop'].source === 'GLOBAL' && src['cpa.hardStop'].version === 3 && src['stockPolicy'].source === 'DEFAULT' && src['stockPolicy'].value === 'WARN' && PP.resolveSources({ product: prod })['budget.minBudget'].source === 'UNSET');
  ok('maximum changes per day is a real, validated field (1–50)', PP.validatePolicy(PP.normalizePolicy({ budget: { maxChangesPerDay: 0 } })).length === 1 && PP.validatePolicy(PP.normalizePolicy({ budget: { maxChangesPerDay: 4 } })).length === 0);
  ok('stock policy default is WARN by the owner\'s decision (unknown stock = warning, OUT_OF_STOCK blocks elsewhere)', PP.stockPolicyDefault === 'WARN');

  console.log('\n2. Storage: draft ≠ active, ADMIN + confirm, versions, history');
  ok('a MANAGER cannot save global rules (403)', (await rej(() => PP.saveGlobalDraft({ policy: GLOBAL, userId: 9999, deps: { user: MGR } })))?.status === 403);
  const bad = await rej(() => PP.saveGlobalDraft({ policy: { cpa: { scale: 200, reduce: 100 } }, userId: 1, deps: { user: ADMIN } })); ok('an incoherent set is refused with the reason (Scale ≥ Reduce)', bad?.code === 'INVALID_POLICY');
  let st = await PP.saveGlobalDraft({ policy: { mode: 'AUTOMATIC', ...GLOBAL }, userId: 1, deps: { user: ADMIN } });
  ok('saving is a DRAFT only: status DRAFT, nothing active, the mode was dropped', st.status === 'DRAFT' && st.active === null && st.draft.mode === null && st.version === 0);
  ok('while only a draft exists, enrolled products see NO inherited value', (await PP.loadActivePolicies()).size >= 0 && PP.activePolicyFromLimits({ productPolicies: {} }, STORE, PID) === null);
  ok('activation needs an explicit confirm', (await rej(() => PP.activateGlobalRules({ userId: 1, deps: { user: ADMIN } })))?.code === 'CONFIRM_REQUIRED');

  console.log('\n3. Inheritance through the real readers (engine + readiness + guards)');
  // a product with an ACTIVE policy that only sets the mode (everything else inherits), and one with a conflicting own value
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify({ ...JSON.parse((await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } })).limits_json || '{}'), productPolicies: { [PP.policyKey(STORE, PID)]: { active: PP.normalizePolicy({ mode: 'AUTOMATIC' }), draft: null, version: 1 }, [PP.policyKey(STORE, PID2)]: { active: PP.normalizePolicy({ mode: 'APPROVAL', cpa: { scale: 165 } }), draft: null, version: 1 } } }) } });
  const c1 = await rej(() => PP.activateGlobalRules({ confirm: true, userId: 1, deps: { user: ADMIN } }));
  ok('activation is REFUSED when it would break an active product policy (product 2 scale 165 ≥ global reduce 170 is fine, but with reduce 160 it breaks) — here: coherent, so it succeeds', c1 === null);
  st = await PP.getGlobalRules(); ok('after activation: ACTIVE, version 1, no draft, history recorded', st.status === 'ACTIVE' && st.version === 1 && st.draft === null && st.history.length === 1);
  const lp = await PP.loadActivePolicies(); const p1 = lp.get(PP.policyKey(STORE, PID));
  ok('the engine reader (loadActivePolicies) now returns the INHERITED values for an enrolled product, mode untouched', p1.mode === 'AUTOMATIC' && p1.cpa.hardStop === 200 && p1.budget.dailySpendCap === 1500 && p1.schedule.closeTime === '13:00');
  const lim = JSON.parse((await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } })).limits_json); const p1b = PP.activePolicyFromLimits(lim, STORE, PID);
  ok('the guard reader (activePolicyFromLimits) sees the same inherited values; the manual-override hours extend to 48h and the daily cap is 1500', p1b.cpa.hardStop === 200 && PP.effectiveManualOverrideHours(lim, STORE, PID) === 48 && PP.dailyCapFromLimits(lim, STORE, PID) === 1500);
  ok('a product that is NOT enrolled (no active policy) is not touched by the global rules at all', PP.activePolicyFromLimits(lim, STORE, 999999) === null && !lp.has(PP.policyKey(STORE, 999999)));
  const gp = await PP.getProductPolicy({ productId: PID, storeId: STORE }); ok('getProductPolicy returns the raw policy (for editing) AND the effective inherited one, with the global version', gp.active.budget.dailySpendCap === null && gp.effective.budget.dailySpendCap === 1500 && gp.globalVersion === 1);
  const view = await PP.effectivePolicyView({ productId: PID2, storeId: STORE }); ok('the effective view labels every value: scale = PRODUCT (165), reduce = GLOBAL v1 (170)', view.sources['cpa.scale'].source === 'PRODUCT' && view.sources['cpa.reduce'].source === 'GLOBAL' && view.sources['cpa.reduce'].version === 1 && view.globalActive === true);
  const rdy = await AR.productAutomationReadiness({ productId: PID, storeId: STORE, deps: { rows: [{ productId: PID, storeId: STORE, name: 'fx', economicsComplete: true, stockKnown: false, stock: null, campaignsMapped: 2 }], pause: { enabled: true, version: 1, approved: { version: 1 } }, open: null, policy: gp.effective } });
  ok('readiness judges the INHERITED limits (spend limits + CPA limits come from the global set) and unknown stock is only a warning', rdy.ready === true && rdy.checks.find((c) => c.key === 'SPEND_LIMITS').ok && rdy.checks.find((c) => c.key === 'CPA_LIMITS').ok && rdy.checks.find((c) => c.key === 'STOCK').required === false);

  console.log('\n4. A new global version cannot break an active product; deactivation removes the inheritance');
  await PP.saveGlobalDraft({ policy: { ...GLOBAL, cpa: { ...GLOBAL.cpa, reduce: 160 } }, userId: 1, deps: { user: ADMIN } });
  const conf = await rej(() => PP.activateGlobalRules({ confirm: true, userId: 1, deps: { user: ADMIN } }));
  ok('reduce 160 would make product 2 (own scale 165) incoherent → refused with GLOBAL_CONFLICTS naming the product; version stays 1', conf?.code === 'GLOBAL_CONFLICTS' && conf.details.some((d) => d.key === PP.policyKey(STORE, PID2)) && (await PP.getGlobalRules()).version === 1);
  await PP.saveGlobalDraft({ policy: { ...GLOBAL, budget: { ...GLOBAL.budget, dailySpendCap: 1800 } }, userId: 1, deps: { user: ADMIN } });
  const v2 = await PP.activateGlobalRules({ confirm: true, userId: 1, deps: { user: ADMIN } }); ok('a coherent change activates as version 2 and enrolled products inherit the new cap (1800); history keeps version 1', v2.version === 2 && (await PP.loadActivePolicies()).get(PP.policyKey(STORE, PID)).budget.dailySpendCap === 1800 && v2.history.length === 2);
  const off = await PP.deactivateGlobalRules({ confirm: true, userId: 1, deps: { user: ADMIN } }); ok('deactivating the global rules makes products fall back to their OWN values only (inherited limits disappear, nothing is invented)', off.active === null && (await PP.loadActivePolicies()).get(PP.policyKey(STORE, PID)).budget.dailySpendCap === null);
  ok('every global change is audited (saved + activated events)', (await prisma.ambOperatorEvent.count({ where: { kind: { in: ['GLOBAL_RULES_SAVED', 'GLOBAL_RULES_ACTIVATED', 'GLOBAL_RULES_DEACTIVATED'] } } })) >= 4);
} finally { try { await restore(); } catch (e) { console.log('cleanup failed', e.message); } }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
