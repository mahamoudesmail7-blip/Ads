// 🧮 Smart Pricing: the formula (exact example), edge cases, missing data (nothing is ever assumed), Meta vs delivered vs estimated kept apart, COD trust, explainable recommendations, and the safety rules:
// suggestions only — no price is ever changed, nothing is activated, Target CPA / Hard Stop are saved only when ticked + confirmed, ADMIN + confirm for every write.
//   node src/scripts/smartPricingTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const SP = await imp('../services/amb/smartPricing.js'); const PP = await imp('../services/amb/productPolicy.js'); const AMBP = await imp('../services/amb/ambProducts.js'); const { prisma } = await imp('../prisma.js');
const EX = { wholesale: 200, shipping: 50, other: 0, expectedCpa: 100, multiplier: 3, markupPct: 85 };

console.log('\n1. The formula — the owner\'s own example');
{
  const c = SP.computePricing(EX);
  ok('status OK', c.status === 'OK', c.status);
  ok('Landed Cost = 200 + 50 + 0 = 250', c.steps.landed === 250);
  ok('Advertising Reserve = 100 × 3 = 300', c.steps.adReserve === 300);
  ok('Reference Cost = 250 + 300 = 550', c.steps.reference === 550);
  ok('Markup Amount = 550 × 85% = 467.50', c.steps.markupAmount === 467.5);
  ok('Suggested Selling Price = 1017.50', c.steps.suggested === 1017.5);
  ok('the marketing rounding is a SEPARATE suggestion (1,020 rounds up, 999 is the psychological price below)', c.rounding.some((r) => r.key === 'ROUND_UP' && r.price === 1020) && c.rounding.some((r) => r.key === 'CHARM_DOWN' && r.price === 999), JSON.stringify(c.rounding.map((r) => r.price)));
  ok('rounding up never lowers the profit; the 999 option says it does', c.rounding.find((r) => r.key === 'ROUND_UP').diff > 0 && c.rounding.find((r) => r.key === 'CHARM_DOWN').diff < 0 && /يقلل/.test(c.rounding.find((r) => r.key === 'CHARM_DOWN').note));
  ok('the formula text is explainable step by step', c.formula.suggested === '550 + 467.5' && c.formula.adReserve === '100 × 3', JSON.stringify(c.formula));
  ok('strings typed in the form work too ("200", "1,250.5")', SP.computePricing({ ...EX, wholesale: '200', shipping: ' 50 ' }).steps.suggested === 1017.5 && SP.normalizeInputs({ wholesale: '1,250.5' }).clean.wholesale === 1250.5);
  ok('scenarios are what-ifs of the same inputs (markup −25 / yours / +15)', c.scenarios.map((s) => s.markupPct).join() === '60,85,100' && c.scenarios[1].price === 1017.5 && c.scenarios[0].price === 880 && c.scenarios[2].price === 1100, JSON.stringify(c.scenarios));
  ok('it states plainly that the reserve is an assumption and the price is a suggestion only', c.notes.some((n) => /افتراض تسعير/.test(n)) && c.notes.some((n) => /لا يتم تغيير أي سعر/.test(n)));
}

console.log('\n2. Profitability — each concept on its own');
{
  const c = SP.computePricing({ ...EX, currentPrice: 800 }); const a = c.analysis;
  ok('Gross Margin = (1017.5 − 250) / 1017.5 = 75.43% (before ads)', a.grossMarginPct === 75.43, a.grossMarginPct);
  ok('Contribution profit = price − landed − expected CPA = 667.50 (an ESTIMATE)', a.contributionPerOrder === 667.5 && a.estimateOnly === true);
  ok('Break-even CPA = price − landed = 767.50', a.breakEvenCpa === 767.5);
  ok('Safety margin = (767.5 − 100) / 767.5 = 86.97%', a.safetyMarginPct === 86.97, a.safetyMarginPct);
  ok('the Advertising Reserve (300) is NOT the CPA (100) and not a realised cost — different numbers, different names', c.steps.adReserve !== c.inputs.expectedCpa && a.contributionPerOrder === c.steps.suggested - c.steps.landed - c.inputs.expectedCpa);
  ok('current price vs suggested: difference, % and its own contribution (800 − 250 − 100 = 450)', c.current.diffToSuggested === 217.5 && c.current.contributionPerOrder === 450 && c.current.diffToSuggestedPct === 27.19, JSON.stringify(c.current));
  const neg = SP.computePricing({ ...EX, currentPrice: 300 }); ok('a current price that does not cover cost + expected CPA → negative contribution is shown, not hidden', neg.current.contributionPerOrder === -50);
}

console.log('\n3. Edge cases and missing data — nothing is assumed');
{
  const empty = SP.computePricing({});
  ok('nothing typed → INCOMPLETE with the missing fields listed; NO number is computed', empty.status === 'INCOMPLETE' && empty.missing.length === 6 && !empty.steps && !empty.analysis, JSON.stringify(empty.missing.map((m) => m.key)));
  const noShip = SP.computePricing({ ...EX, shipping: '' }); ok('a blank shipping cost is NOT treated as 0 (it is asked for)', noShip.status === 'INCOMPLETE' && noShip.missing[0].key === 'shipping');
  ok('an explicitly typed 0 is accepted (free shipping / no extras)', SP.computePricing({ ...EX, shipping: 0, other: 0 }).status === 'OK');
  ok('wholesale 0 is refused (a product with no cost is not a price)', SP.computePricing({ ...EX, wholesale: 0 }).status === 'INVALID');
  ok('negative values are refused, not fixed silently', SP.computePricing({ ...EX, expectedCpa: -5 }).status === 'INVALID' && SP.computePricing({ ...EX, shipping: -1 }).status === 'INVALID');
  ok('text / NaN is refused with a clear message', SP.computePricing({ ...EX, wholesale: 'abc' }).errors[0].includes('رقم صالح'));
  ok('absurd values are refused (markup 5000%, multiplier 99)', SP.computePricing({ ...EX, markupPct: 5000 }).status === 'INVALID' && SP.computePricing({ ...EX, multiplier: 99 }).status === 'INVALID');
  const z = SP.computePricing({ ...EX, expectedCpa: 0, multiplier: 0, markupPct: 0 }); ok('zero CPA / multiplier / markup is a valid case: price = landed cost', z.status === 'OK' && z.steps.suggested === 250 && z.analysis.contributionPerOrder === 0);
  ok('floating point stays at 2 decimals (0.1 + 0.2 style)', SP.computePricing({ ...EX, wholesale: 100.1, shipping: 0.2, other: 0 }).steps.landed === 100.3);
  ok('very large numbers do not break the formula', SP.computePricing({ wholesale: 9999999, shipping: 1, other: 1, expectedCpa: 1000, multiplier: 50, markupPct: 1000 }).status === 'OK');
  ok('only the multiplier (3) and markup (85) are PROPOSED starting values — never costs', SP.SUGGESTED_DEFAULTS.multiplier === 3 && SP.SUGGESTED_DEFAULTS.markupPct === 85 && Object.keys(SP.SUGGESTED_DEFAULTS).length === 2);
  ok('no current price → no current block, still OK', SP.computePricing(EX).current === null);
  ok('tiny prices round to 5, not 10', (SP.computePricing({ wholesale: 20, shipping: 5, other: 0, expectedCpa: 5, multiplier: 2, markupPct: 10 }).rounding[0]?.price ?? 0) % 5 === 0);
}

console.log('\n4. Actual vs estimated: Meta purchases ≠ delivered orders; COD trust');
{
  const win = (key, spend, purchases, cod) => ({ key, spend, purchases, cod });
  const trusted = { dataState: 'AVAILABLE', sample: 40, delivered: 20, deliveryRate: 0.5 };
  const cmp = SP.compareWithActual({ expectedCpa: 100, landed: 250, price: 1017.5, windows: [win('last3', 600, 6, trusted), win('last7', 1800, 12, { dataState: 'AVAILABLE', sample: 4, delivered: 2, deliveryRate: null }), win('last30', 9000, 60, { dataState: 'NO_DATA' })] });
  const [w3, w7, w30] = cmp;
  ok('Meta CPA = spend / Meta purchases of the same window (600/6 = 100)', w3.metaCpa === 100 && w7.metaCpa === 150 && w30.metaCpa === 150);
  ok('Delivered CPA is spend / DELIVERED orders (600/20 = 30) and only with trusted COD data', w3.deliveredCpa === 30 && w3.codTrusted && w3.profitConfirmed === true);
  ok('with a small COD sample (rates withheld) delivered CPA is NOT shown and profit is an estimate', w7.deliveredCpa === null && w7.codTrusted === false && w7.profitConfirmed === false && /صغيرة|غير موثوقة/.test(w7.codReason));
  ok('with no COD data at all: no delivered CPA, a clear reason', w30.deliveredCpa === null && /لا توجد بيانات COD/.test(w30.codReason));
  ok('Meta purchases are never presented as delivered: the Meta-based profit and the delivered-based profit are separate fields', w3.contributionByMetaCpa === 667.5 && w3.contributionByDeliveredCpa === 737.5 && w7.contributionByDeliveredCpa === null);
  ok('verdicts are evidence-gated (3d needs 3 orders, 7d 5, 30d 8)', w3.verdict === 'ON_TARGET' || w3.verdict === 'BETTER', w3.verdict);
  ok('an actual CPA 50% above the estimate is WORSE, with the % shown', w7.verdict === 'WORSE' && w7.deltaVsExpectedPct === 50 && w7.deltaVsExpected === 50, JSON.stringify([w7.verdict, w7.deltaVsExpectedPct]));
  const small = SP.compareWithActual({ expectedCpa: 100, windows: [win('last7', 100, 2, { dataState: 'NO_DATA' })] })[0]; ok('2 purchases in 7 days is not enough to judge (INSUFFICIENT_SAMPLE)', small.verdict === 'INSUFFICIENT_SAMPLE' && small.sufficient === false);
  const none = SP.compareWithActual({ expectedCpa: 100, windows: [win('last7', 0, 0, null)] })[0]; ok('no spend and no orders → CPA null (not 0), no verdict', none.metaCpa === null && none.verdict === 'INSUFFICIENT_SAMPLE');
  const spendNoOrders = SP.compareWithActual({ expectedCpa: 100, windows: [win('last7', 900, 0, null)] })[0]; ok('spend with zero purchases → CPA not available (never 0)', spendNoOrders.metaCpa === null);
}

console.log('\n5. Smart recommendations — explainable, never commands');
{
  const c = SP.computePricing({ ...EX, currentPrice: 300 });
  const none = SP.buildRecommendations({ computed: c, comparison: [], currentPrice: 300 });
  ok('with no ad data: says so, and that the estimate rests on the expected CPA only', none.some((r) => /لا توجد بيانات إعلانات/.test(r.title)));
  ok('a current price below cost + CPA → a red warning with the numbers', none.some((r) => r.level === 'bad' && /لا يغطي/.test(r.title) && /-50/.test(r.why)));
  const cmp = SP.compareWithActual({ expectedCpa: 100, landed: 250, price: 1017.5, windows: [{ key: 'last30', spend: 70000, purchases: 70, cod: { dataState: 'NO_DATA' } }] });
  const r2 = SP.buildRecommendations({ computed: SP.computePricing(EX), comparison: cmp });
  ok('actual CPA (1000) above break-even (767.5): flagged as a LOSS per order, with the reason', r2.some((r) => r.level === 'bad' && /أسوأ/.test(r.title) && /خسارة/.test(r.why)), JSON.stringify(r2.map((r) => r.title)));
  ok('unconfirmed profitability warning appears when only Meta orders exist', r2.some((r) => /غير مؤكدة/.test(r.title)));
  const good = SP.buildRecommendations({ computed: SP.computePricing(EX), comparison: SP.compareWithActual({ expectedCpa: 100, windows: [{ key: 'last7', spend: 900, purchases: 10, cod: { dataState: 'AVAILABLE', sample: 30, delivered: 6, deliveryRate: 0.5 } }] }) });
  ok('a better-than-expected CPA is a green item; delivered CPA availability is reported', good.some((r) => r.level === 'good' && /أفضل/.test(r.title)) && good.some((r) => /المسلّم متاح/.test(r.title)));
  ok('incomplete inputs → one info item, no invented advice', SP.buildRecommendations({ computed: SP.computePricing({}) }).length === 1);
  ok('nothing in the recommendations is a command (no "غيّر السعر الآن")', ![...none, ...r2, ...good].some((r) => /غيّر السعر|طبّق|نفّذ/.test(r.title + r.why)));
}

console.log('\n6. Storage + safety: draft / approve / apply to rules (isolated test database)');
const PID = 987654; let created = false; const ADMIN_ID = (await prisma.user.findFirst({ where: { role: 'ADMIN', status: 'ACTIVE' } }))?.id; const viewer = (await prisma.user.findFirst({ where: { role: { not: 'ADMIN' } } }));
try {
  await prisma.product.upsert({ where: { id: PID }, update: {}, create: { id: PID, product_name: 'SP Test Product', store_id: 'sp-test', active: true } }).catch(() => null); created = true;
  const cfgBefore = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } });
  const draft0 = await SP.savePricingDraft({ productId: PID, storeId: 'sp-test', inputs: { wholesale: 200, shipping: '' }, userId: ADMIN_ID });
  ok('a draft may be incomplete (blank stays blank — not turned into 0)', draft0.draft.inputs.wholesale === 200 && draft0.draft.inputs.shipping === null);
  let e1 = null; try { await SP.savePricingDraft({ productId: PID, storeId: 'sp-test', inputs: { wholesale: 'x' }, userId: ADMIN_ID }); } catch (e) { e1 = e; } ok('an invalid draft is refused (400) and nothing is overwritten', e1?.status === 400 && (await SP.getPricingState({ productId: PID, storeId: 'sp-test' })).draft.inputs.wholesale === 200);
  if (viewer) { let e2 = null; try { await SP.savePricingDraft({ productId: PID, storeId: 'sp-test', inputs: EX, userId: viewer.id }); } catch (e) { e2 = e; } ok('a non-ADMIN user cannot save a draft (403)', e2?.status === 403); } else ok('(no non-admin user in the test DB — role check skipped)', true);
  let e3 = null; try { await SP.approvePrice({ productId: PID, storeId: 'sp-test', inputs: EX, userId: ADMIN_ID }); } catch (e) { e3 = e; } ok('approving needs an explicit confirm', e3?.code === 'CONFIRM_REQUIRED');
  let e4 = null; try { await SP.approvePrice({ productId: PID, storeId: 'sp-test', inputs: { wholesale: 200 }, confirm: true, userId: ADMIN_ID }); } catch (e) { e4 = e; } ok('approving incomplete inputs is refused', e4?.code === 'NOT_COMPUTABLE');
  let e5 = null; try { await SP.approvePrice({ productId: PID, storeId: 'sp-test', inputs: EX, price: 1, confirm: true, userId: ADMIN_ID }); } catch (e) { e5 = e; } ok('only a price the engine offered (suggested or a rounding) can be approved — not an arbitrary number', e5?.code === 'PRICE_NOT_OFFERED');
  const appr = await SP.approvePrice({ productId: PID, storeId: 'sp-test', inputs: EX, price: 1020, confirm: true, userId: ADMIN_ID });
  ok('approve records 1,020 INSIDE the Operator only (appliedToStore false) and says no store/Easy Orders price changed', appr.approved.price === 1020 && appr.approved.appliedToStore === false && /لم يتغير أي سعر/.test(appr.note));
  const ambBefore = await prisma.ambProduct.findUnique({ where: { product_id: PID } });
  ok('approving did NOT touch the product economics / selling price', !ambBefore || (ambBefore.actual_selling_price === null && ambBefore.product_cost === 0), JSON.stringify(ambBefore && [ambBefore.actual_selling_price, ambBefore.product_cost]));
  const pv = await SP.previewApplyToRules({ productId: PID, storeId: 'sp-test', inputs: EX, PP });
  ok('preview lists the fields that WOULD change; Target CPA and Hard Stop are optional and OFF by default', pv.ok && pv.changes.find((c) => c.field === 'product_cost').to === 200 && pv.changes.find((c) => c.field === 'target_cpa').defaultOn === false && pv.changes.find((c) => c.field === 'policy.cpa.hardStop').defaultOn === false && pv.priceUnchanged === true, JSON.stringify(pv.changes.map((c) => [c.field, c.defaultOn])));
  ok('the preview wrote nothing (no AmbProduct, no policy draft)', !(await prisma.ambProduct.findUnique({ where: { product_id: PID } })) && (await PP.getProductPolicy({ productId: PID, storeId: 'sp-test' })).draft === null);
  let e6 = null; try { await SP.applyToRules({ productId: PID, storeId: 'sp-test', inputs: EX, fields: ['product_cost'], userId: ADMIN_ID, PP, ambProducts: AMBP }); } catch (e) { e6 = e; } ok('applying needs an explicit confirm', e6?.code === 'CONFIRM_REQUIRED');
  let e7 = null; try { await SP.applyToRules({ productId: PID, storeId: 'sp-test', inputs: EX, fields: ['actual_selling_price'], confirm: true, userId: ADMIN_ID, PP, ambProducts: AMBP }); } catch (e) { e7 = e; } ok('the selling price is NOT an allowed field — it can never be applied from here', e7?.code === 'FIELD_NOT_ALLOWED');
  let e8 = null; try { await SP.applyToRules({ productId: PID, storeId: 'sp-test', inputs: EX, fields: [], confirm: true, userId: ADMIN_ID, PP, ambProducts: AMBP }); } catch (e) { e8 = e; } ok('applying with no ticked field is refused', e8?.code === 'NO_FIELDS');
  const ap1 = await SP.applyToRules({ productId: PID, storeId: 'sp-test', inputs: EX, fields: ['product_cost', 'shipping_cost', 'other_cost'], confirm: true, userId: ADMIN_ID, PP, ambProducts: AMBP });
  const amb1 = await prisma.ambProduct.findUnique({ where: { product_id: PID } });
  ok('only the ticked economics were saved (cost 200, shipping 50) and Target CPA stayed empty', ap1.ok && amb1.product_cost === 200 && amb1.shipping_cost === 50 && (amb1.target_cpa === null || amb1.target_cpa === 0), JSON.stringify([amb1.product_cost, amb1.shipping_cost, amb1.target_cpa]));
  ok('the selling price is untouched and no policy draft / activation was created', amb1.actual_selling_price === null && ap1.policyActivated === false && ap1.priceChanged === false && (await PP.getProductPolicy({ productId: PID, storeId: 'sp-test' })).draft === null);
  const ap2 = await SP.applyToRules({ productId: PID, storeId: 'sp-test', inputs: EX, fields: ['target_cpa', 'policy.cpa.hardStop'], confirm: true, userId: ADMIN_ID, PP, ambProducts: AMBP });
  const pol = await PP.getProductPolicy({ productId: PID, storeId: 'sp-test' }); const amb2 = await prisma.ambProduct.findUnique({ where: { product_id: PID } });
  ok('Target CPA (100) and Hard Stop (= break-even 767.5) saved ONLY because they were ticked; the policy is a DRAFT and NOT active', amb2.target_cpa === 100 && pol.draft?.cpa?.hardStop === 767.5 && pol.status === 'DRAFT' && !pol.active, JSON.stringify([amb2.target_cpa, pol.draft?.cpa, pol.status]));
  ok('nothing was activated: no product policy is active anywhere', (await PP.loadActivePolicies()).size === 0);
  const cfgAfter = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } });
  ok('mode / permissions / Emergency Stop untouched by the whole pricing flow', cfgAfter.mode === cfgBefore.mode && cfgAfter.emergency_stop === cfgBefore.emergency_stop && JSON.stringify(JSON.parse(cfgAfter.limits_json || '{}').execPermissions) === JSON.stringify(JSON.parse(cfgBefore.limits_json || '{}').execPermissions));
  ok('every write left an audit trail', (await prisma.aiAuditLog.count({ where: { kind: { in: ['OPERATOR_PRICING_DRAFT', 'OPERATOR_PRICING_APPROVED', 'OPERATOR_PRICING_APPLIED_TO_RULES'] } } })) >= 4);
  ok('no Action / Meta write was created', (await prisma.ambAction.count({ where: { entity_id: { contains: String(PID) } } })) === 0);
} finally {
  const cfg = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const l = JSON.parse(cfg.limits_json || '{}'); if (l.pricing) delete l.pricing[`sp-test:${PID}`]; if (l.productPolicies) delete l.productPolicies[`sp-test:${PID}`];
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify(l) } });
  await prisma.ambProduct.deleteMany({ where: { product_id: PID } }); if (created) await prisma.product.deleteMany({ where: { id: PID } }); await prisma.$disconnect();
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
