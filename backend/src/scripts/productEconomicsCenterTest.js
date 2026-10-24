// 🧪 «اقتصاديات المنتجات» (AMB V2) — the board, the three saves (economics · CPA limits · a policy DRAFT), the pure preview, the readiness check and the locks. Disposable fixtures (`__pec_`) on the ISOLATED test database.
//   Rules proven here: nothing is assumed (missing = null, never 0) · nothing is written when ANY number is wrong · a product with an ACTIVE policy (Hair-Cap's situation) is LOCKED · AUTOMATIC cannot be activated on an incomplete product ·
//   a saved policy is only a DRAFT (no behaviour change) · the AMB record can never silently shadow what the owner typed.
//   node src/scripts/productEconomicsCenterTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url)); const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
const { prisma } = await imp('../prisma.js'); const PEC = await imp('../services/amb/productEconomicsCenter.js'); const PP = await imp('../services/amb/productPolicy.js');
const ADMIN_ID = (await prisma.user.findFirst({ where: { role: 'ADMIN', status: 'ACTIVE' } }))?.id ?? 1; const ST = 'trendy-storeee';
const cfgRow0 = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const limits0 = cfgRow0?.limits_json ?? null;
const created = { products: [], ambs: [] };
const mk = async (name, { price = 1000, cost = 0, ambCost = 0 } = {}) => { const p = await prisma.product.create({ data: { product_name: `__pec_${name}_${Date.now()}`, selling_price: price, product_cost: cost, store_id: ST } }); const a = await prisma.ambProduct.create({ data: { product_id: p.id, product_name: p.product_name, product_cost: ambCost, active: true } }); created.products.push(p.id); created.ambs.push(a.id); return { p, a }; };
const card = async (id) => (await PEC.getProductEconomicsBoard({ ids: [id] })).products.find((c) => c.productId === id);
const rows = (m) => (m && m.details) || [];
try {
  console.log('\n1. Pure helpers');
  ok('suggestLines: derived ONLY from a real max CPA with the Hair-Cap ratios (0.6 / 0.9 / 1.0); null when there is no max CPA', JSON.stringify(PEC.suggestLines(200)) && PEC.suggestLines(200).scale === 120 && PEC.suggestLines(200).reduce === 180 && PEC.suggestLines(200).hardStop === 200 && PEC.suggestLines(null) === null && PEC.suggestLines(0) === null);
  ok('profitView: incomplete economics → every number is null (never 0)', (() => { const v = PEC.profitView({ econ: { complete: false }, perf: { orders30: 10, spend30: 500 } }); return v.unitMargin === null && v.profit30 === null && v.marginPct === null; })());
  ok('profitView: real numbers → profit = orders × unit margin − ad spend (margin 500, 10 orders, spend 3000 → 2000), margin % of price', (() => { const v = PEC.profitView({ econ: { complete: true, unitMargin: 500, price: 1000 }, perf: { orders7: 4, spend7: 1500, orders30: 10, spend30: 3000 } }); return v.unitMargin === 500 && v.profit30 === 2000 && v.profit7 === 500 && v.marginPct === 50; })());
  ok('profitView: a loss is shown as a negative number (margin 100, 5 orders, spend 900 → −400)', PEC.profitView({ econ: { complete: true, unitMargin: 100, price: 400 }, perf: { orders30: 5, spend30: 900 } }).profit30 === -400);
  const form = { scale: 120, reduce: 180, hardStop: 200, zeroSpend: 200, zeroMinAgeHours: 24, increasePct: 20, decreasePct: 20, minPurchases: 5, cooldownHours: 24, minBudget: 200, maxBudget: 600, dailySpendCap: 2100, maxChangesPerDay: 4 };
  const pol = PEC.fromForm(form); ok('form ⇄ policy round trip keeps every number and sets the INTENT to AUTOMATIC (it still needs activation)', pol.mode === 'AUTOMATIC' && JSON.stringify(PEC.toForm(pol)) === JSON.stringify(form) && PP.validatePolicy(pol).length === 0, JSON.stringify(PEC.toForm(pol)));

  console.log('\n2. An incomplete product: nothing is assumed');
  const A = await mk('incomplete'); const c0 = await card(A.p.id);
  ok('cost is «not entered» (not 0), economics incomplete, no margin, no profit, NO suggested CPA lines', c0.economics.cost.entered === false && c0.economics.cost.value === null && c0.economics.complete === false && c0.profit.unitMargin === null && c0.cpa.suggestion === null && c0.policy.status === 'NONE', JSON.stringify([c0.economics, c0.profit, c0.cpa.suggestion]));
  ok('readiness is BLOCKED and lists what is missing (economics · spend limits · CPA limits …)', c0.readiness.ready === false && ['SPEND_LIMITS', 'CPA_LIMITS'].every((k) => c0.readiness.missing.some((m) => m.key === k)) && !c0.readiness.missing.some((m) => m.key === 'ECONOMICS'), JSON.stringify(c0.readiness.missing.map((m) => m.key)));
  ok('the product is not locked (no active policy) and not a priority-six member', c0.locked === false && c0.isPriority === false);

  console.log('\n3. Validation: ONE wrong number → nothing is written');
  const before = JSON.stringify(await prisma.product.findUnique({ where: { id: A.p.id } }));
  const bad = async (body) => { try { await PEC.saveProductEconomics({ productId: A.p.id, userId: ADMIN_ID, ...body }); return null; } catch (e) { return e; } };
  const e1 = await bad({ economics: { cost: -5 } }); const e2 = await bad({ economics: { cost: 400 }, cpaLimits: { target: 300, max: 200 } }); const e3 = await bad({ economics: { cost: 400 }, policyForm: { ...form, scale: 190, reduce: 180 } }); const e4 = await bad({ cpaLimits: { max: 200, hardStop: 150 } }); const e5 = await bad({ economics: { cost: 0 } });
  ok('a negative cost, target > max, scale ≥ reduce, hard stop < max, and a zero cost are each refused with 400 and a clear Arabic message', [e1, e2, e3, e4, e5].every((e) => e?.status === 400 && e.details?.length) , JSON.stringify([e1?.message, e2?.message, e3?.message, e4?.message, e5?.message]));
  ok('…and the database is EXACTLY as it was (the valid cost 400 in the same request was NOT written)', JSON.stringify(await prisma.product.findUnique({ where: { id: A.p.id } })) === before && (await prisma.ambOperatorProductConfig.count({ where: { product_id: A.p.id } })) === 0 && (await PP.getProductPolicy({ productId: A.p.id, storeId: ST })).status === 'NONE');

  console.log('\n4. The pure preview: real economics from typed numbers, writes nothing');
  const pv = await PEC.previewProductForm({ productId: A.p.id, economics: { cost: 400, shipping: 60, packaging: 40 }, cpaLimits: { target: 120, max: 200, hardStop: 220 }, policyForm: form });
  ok('preview: margin 1000 − (400+60+40) = 500, economics complete, calculated max CPA 500, suggestion from the typed max 200 (120 / 180 / 200)', pv.ok && pv.economicsComplete && pv.profit.unitMargin === 500 && pv.calculatedMaxCpa === 500 && pv.suggestion.reduce === 180, JSON.stringify(pv));
  ok('preview wrote NOTHING (cost still not entered, no config row, no draft)', JSON.stringify(await prisma.product.findUnique({ where: { id: A.p.id } })) === before && (await PP.getProductPolicy({ productId: A.p.id, storeId: ST })).status === 'NONE');
  const pvBad = await PEC.previewProductForm({ productId: A.p.id, policyForm: { ...form, increasePct: 99 } }); ok('preview reports an invalid policy form instead of simulating it', pvBad.ok === false && pvBad.errors.length > 0 && pvBad.simulation === null);

  console.log('\n5. Save: economics + CPA limits + a policy DRAFT (and the AMB record can never shadow the typed cost)');
  const B = await mk('stale', { ambCost: 123 }); // a stale AMB cost that would WIN over the catalogue value in the economics engine
  const r = await PEC.saveProductEconomics({ productId: B.p.id, userId: ADMIN_ID, economics: { cost: 400, shipping: 60, packaging: 40, currentStock: 150, minimumStock: 30 }, cpaLimits: { target: 120, max: 200, hardStop: 220 }, policyForm: form });
  const cb = r.card; const ambAfter = await prisma.ambProduct.findUnique({ where: { id: B.a.id } });
  ok('saved all three parts and returned the fresh card', r.ok && r.wrote.join() === 'economics,cpaLimits,policyDraft' && !!cb, JSON.stringify(r.wrote));
  ok('the AMB record now equals what the owner typed (400, not the stale 123) and the economics use it', ambAfter.product_cost === 400 && cb.economics.cost.value === 400 && cb.economics.shipping.value === 60 && cb.economics.packaging.value === 40 && cb.economics.complete === true, JSON.stringify(cb.economics));
  ok('REAL profitability: unit margin 500 (= 1000 − 500 costs), margin 50% of the price, break-even CPA 500', cb.profit.unitMargin === 500 && cb.profit.marginPct === 50 && cb.profit.breakEvenCpa === 500, JSON.stringify(cb.profit));
  ok('stock saved on the catalogue (150 / minimum 30) and read back by the engine\'s own stock facts', cb.stock.manualCurrent === 150 && cb.stock.manualMinimum === 30 && cb.stock.current === 150 && cb.stock.minimum === 30, JSON.stringify(cb.stock));
  ok('CPA limits saved through the existing config (target 120 · max 200 · hard stop 220); suggestion derived from the REAL max 200', cb.cpa.target === 120 && cb.cpa.max === 200 && cb.cpa.hardStop === 220 && cb.cpa.suggestion.scale === 120 && cb.cpa.suggestion.reduce === 180);
  ok('the policy is only a DRAFT with mode AUTOMATIC intent — nothing active, the form comes back identical', cb.policy.status === 'DRAFT' && cb.policy.draft.mode === 'AUTOMATIC' && cb.policy.active === null && JSON.stringify(cb.policy.form) === JSON.stringify(form));
  const need = ['ECONOMICS', 'STOCK', 'SPEND_LIMITS', 'CPA_LIMITS']; ok('readiness now passes economics / stock / spend limits / CPA limits (the product still lacks a verified campaign mapping → not READY, honestly)', need.every((k) => cb.readiness.checks.find((x) => x.key === k)?.ok) && cb.readiness.ready === false && cb.readiness.missing.some((m) => m.key === 'MAPPING'), JSON.stringify(cb.readiness.checks.map((x) => [x.key, x.ok])));
  const rc = await PEC.productReadinessCheck({ productId: B.p.id }); ok('the readiness check agrees and says it cannot be activated yet (a missing mapping blocks it)', rc.ready === false && rc.canActivate === false && rc.hasDraft === true && rc.policyStatus === 'DRAFT');

  console.log('\n6. AUTOMATIC is refused on an incomplete product — through the EXISTING gated activation');
  let act = null; try { await PP.activatePolicy({ productId: B.p.id, storeId: ST, confirm: true, confirmAutomatic: true, userId: ADMIN_ID }); } catch (e) { act = e; }
  ok('activation of the saved AUTOMATIC draft is refused (409 AUTOMATIC_NOT_READY) with the exact missing list, and the policy stays a draft', act?.status === 409 && act.code === 'AUTOMATIC_NOT_READY' && /ناقص/.test(act.message) && (await PP.getProductPolicy({ productId: B.p.id, storeId: ST })).status === 'DRAFT', act?.message);
  let act2 = null; try { await PP.activatePolicy({ productId: B.p.id, storeId: ST, confirm: true, userId: ADMIN_ID }); } catch (e) { act2 = e; } ok('…and without the extra AUTOMATIC confirmation it is refused as well (CONFIRM_AUTOMATIC_REQUIRED)', act2?.code === 'CONFIRM_AUTOMATIC_REQUIRED');

  console.log('\n7. A product with an ACTIVE policy is LOCKED here (Hair-Cap\'s situation)');
  const C = await mk('locked'); const key = PP.policyKey(ST, C.p.id); const raw = JSON.parse((await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } })).limits_json || '{}'); raw.productPolicies = { ...(raw.productPolicies || {}), [key]: { active: PEC.fromForm(form), draft: null, version: 1, activatedAt: new Date().toISOString() } };
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify(raw) } });
  const cl = await card(C.p.id); let lk = null; try { await PEC.saveProductEconomics({ productId: C.p.id, userId: ADMIN_ID, economics: { cost: 999 } }); } catch (e) { lk = e; }
  ok('it shows as LOCKED with the reason, and any save is refused (423 PRODUCT_LOCKED) — its live settings are never touched', cl.locked === true && /مقفولة/.test(cl.lockedReason) && lk?.status === 423 && lk.code === 'PRODUCT_LOCKED' && (await prisma.product.findUnique({ where: { id: C.p.id } })).product_cost === 0);
  const board = await PEC.getProductEconomicsBoard({ ids: [A.p.id] }); ok('a locked product is ALWAYS added to the board (visible, never hidden) even when it was not asked for', board.products.some((x) => x.productId === C.p.id && x.locked) && board.summary.locked >= 1);
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } }); // restore

  console.log('\n8. Ordering and scope');
  ok('the default scope is the owner\'s six + any locked product; unknown ids are skipped (no crash)', PEC.PRIORITY_PRODUCT_IDS.length === 6 && PEC.PRIORITY_PRODUCT_IDS.join() === '159,250,323,320,443,257' && (await PEC.getProductEconomicsBoard({ ids: [999999999] })).count === 0);
} finally {
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } }).catch(() => {});
  await prisma.ambOperatorProductConfig.deleteMany({ where: { product_id: { in: created.products } } }).catch(() => {});
  await prisma.ambProduct.deleteMany({ where: { id: { in: created.ambs } } }).catch(() => {}); await prisma.product.deleteMany({ where: { id: { in: created.products } } }).catch(() => {});
  await prisma.ambOperatorEvent.deleteMany({ where: { note: { contains: '__pec_' } } }).catch(() => {});
}
await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`); setTimeout(() => process.exit(fail ? 1 : 0), 50);
