// 🤖 AI Operator — END-TO-END INTEGRATION acceptance (2026-10-03).
//   Pure: price resolver, zero-order modes, mapping evidence ranking, guard chain self-check.
//   Fixtures (disposable "__optest_" rows, cleaned up): central stock source (fresh / stale snapshot, catalogue value).
//   Read-only against real data: the integration audit must never invent a value (cost / stock / Target CPA stay NEEDS_USER_VALUE or
//   NEEDS_EXTERNAL_CONFIGURATION), never mark a SUGGESTED mapping VERIFIED, keep COD automation BLOCKED while status trust is not OK,
//   keep Meta writes locked, and never return a webhook secret value.
//   node src/scripts/operatorIntegrationTest.js
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const retryDb = async (fn) => { for (let i = 0; i < 8; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };

const { prisma } = await imp('../prisma.js');
const P = await imp('../services/amb/productPriceResolver.js');
const G = await imp('../services/amb/operatorGuards.js');
const M = await imp('../services/amb/operatorMappingResolver.js');
const SG = await imp('../services/amb/stockGuard.js');
const I = await imp('../services/amb/operatorIntegration.js');
const Store = await imp('../services/amb/operatorStore.js');

console.log('1) selling price resolver');
{
  const cat = P.indexStoreCatalog([{ id: 'a', name: 'جهاز X (s24)', price: 1100 }, { id: 'b', name: 'جهاز Y', price: 500 }, { id: 'c', name: 'جهاز Y (s9)', price: 520 }]);
  const r1 = P.resolveSellingPrice({ product: { product_name: 'جهاز X', selling_price: null }, ambProduct: null, storeCatalog: cat });
  ok('only the store catalogue has it -> FROM_STORE_CATALOG (a suggestion with provenance)', r1.value === 1100 && r1.status === 'FROM_STORE_CATALOG' && r1.source === 'STORE_CATALOG');
  const r2 = P.resolveSellingPrice({ product: { product_name: 'جهاز X', selling_price: 1700 }, ambProduct: null, storeCatalog: cat });
  ok('catalogue 1700 vs store 1100 -> CONFLICT, no value picked', r2.status === 'CONFLICT' && r2.value === null);
  const r3 = P.resolveSellingPrice({ product: { product_name: 'جهاز X', selling_price: 1100 }, ambProduct: null, storeCatalog: cat });
  ok('catalogue matches store catalogue -> VERIFIED', r3.status === 'VERIFIED' && r3.value === 1100);
  const r4 = P.resolveSellingPrice({ product: { product_name: 'جهاز Y' }, ambProduct: null, storeCatalog: cat });
  ok('two same-name products in the store -> never auto-picked (MISSING / review)', r4.value === null && r4.status === 'MISSING');
  const r5 = P.resolveSellingPrice({ product: { product_name: 'غير موجود' }, ambProduct: { actual_selling_price: null }, storeCatalog: cat });
  ok('nothing anywhere -> MISSING (not 0)', r5.value === null && r5.status === 'MISSING');
  const r6 = P.resolveSellingPrice({ product: { product_name: 'غير موجود', selling_price: 300 }, ambProduct: null, storeCatalog: null });
  ok('store catalogue unavailable -> catalogue price used, flagged UNCROSSCHECKED', r6.value === 300 && r6.status === 'UNCROSSCHECKED');
  const e = G.computeOperatorEconomics({ product: { selling_price: 1700, product_cost: 400 }, ambProduct: null, opCfg: null, priceResolution: r2 });
  ok('economics are NOT complete under a price CONFLICT', e.complete === false && e.priceStatus === 'CONFLICT');
}

console.log('2) zero-order limit modes (no global fixed number)');
{
  ok('no override -> NOT_CONFIGURED (limit null)', G.resolveZeroOrderLimit({ override: null, targetCpa: 100 }).reason === 'NOT_CONFIGURED');
  ok('FIXED_SPEND 250', G.resolveZeroOrderLimit({ override: { mode: 'FIXED_SPEND', fixedSpend: 250 }, targetCpa: null }).limit === 250);
  ok('TARGET_CPA_MULTIPLE 100 x 1.5 = 150', G.resolveZeroOrderLimit({ override: { mode: 'TARGET_CPA_MULTIPLE', multiple: 1.5 }, targetCpa: 100 }).limit === 150);
  const noT = G.resolveZeroOrderLimit({ override: { mode: 'TARGET_CPA_MULTIPLE', multiple: 1.5 }, targetCpa: null });
  ok('multiple without Target CPA -> unknown (never a guessed number)', noT.limit === null && noT.reason === 'TARGET_CPA_MISSING');
  ok('validation rejects an unknown mode / negative values', Store.validateZeroOrderOverride({ mode: 'X' }).errors.length > 0 && Store.validateZeroOrderOverride({ mode: 'FIXED_SPEND', fixedSpend: -5 }).errors.length > 0);
}

console.log('3) mapping evidence ranking');
{
  const d1 = M.decideFromEvidence([{ type: 'SIBLING_PREFIX', ambProductId: 1, detail: 'x' }]);
  ok('one strong signal -> SUGGEST_STRONG (never VERIFIED)', d1.decision === 'SUGGEST_STRONG' && d1.pick.ambProductId === 1);
  const d2 = M.decideFromEvidence([{ type: 'SIBLING_PREFIX', ambProductId: 1 }, { type: 'URL_SLUG', ambProductId: 2 }]);
  ok('two products on strong signals -> AMBIGUOUS', d2.decision === 'AMBIGUOUS');
  ok('name similarity only -> SUGGEST_WEAK', M.decideFromEvidence([{ type: 'NAME_SIMILARITY', ambProductId: 3, confidence: 0.4 }]).decision === 'SUGGEST_WEAK');
  ok('nothing -> NO_EVIDENCE', M.decideFromEvidence([]).decision === 'NO_EVIDENCE');
  ok('campaign prefix extraction', M.campaignPrefix('Hair-Cap _ scale 2') === 'hair-cap' && M.campaignPrefix('Smart-Bag-NewTest') === null);
  ok('slug from product URL', M.slugFromUrl('https://x.com/products/Fire-Radio?utm=1') === 'Fire-Radio');
}

console.log('4) guard-chain self-check');
{
  const checks = I.guardSelfCheck();
  ok(`all ${checks.length} guard checks pass (incl. healthy-baseline control)`, checks.every((c) => c.ok), checks.filter((c) => !c.ok).map((c) => c.name).join(' | '));
  ok('control check exists (the others are meaningless without it)', checks[0].name.includes('control'));
}

console.log('5) central stock source (disposable fixtures)');
const created = [];
try {
  const mk = async (name, extra = {}) => { const p = await retryDb(() => prisma.product.create({ data: { product_name: `__optest_${name}`, store_id: 'default', selling_price: 100, ...extra } })); created.push(p.id); return p; };
  const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const pFresh = await mk('stock_fresh'), pStale = await mk('stock_stale'), pCat = await mk('stock_cat', { current_stock: 42 }), pNone = await mk('stock_none');
  await retryDb(() => prisma.inventorySnapshot.create({ data: { product_id: pFresh.id, product_name: pFresh.product_name, date: day(1), closing_stock: 17, units_out: 0, movement_type: 'COUNT' } }));
  await retryDb(() => prisma.inventorySnapshot.create({ data: { product_id: pStale.id, product_name: pStale.product_name, date: day(20), closing_stock: 99, units_out: 0, movement_type: 'COUNT' } }));
  const a = await SG.resolveStockInputs(pFresh.id), b = await SG.resolveStockInputs(pStale.id), c = await SG.resolveStockInputs(pCat.id), d = await SG.resolveStockInputs(pNone.id);
  ok('fresh snapshot is used (17)', a.current === 17 && /SNAPSHOT/i.test(String(a.source)), JSON.stringify(a));
  ok('stale snapshot (20 days) is NOT used as production truth', b.current == null && b.stale === true && b.staleValue === 99, JSON.stringify(b));
  ok('catalogue current_stock wins (42)', c.current === 42, JSON.stringify(c));
  ok('no source at all -> null (never 0)', d.current == null, JSON.stringify(d));
  const g = await SG.stockGuardForProduct({ productId: pNone.id, storeId: 'default' });
  ok('stock guard reports STOCK_UNKNOWN for an unknown stock', g.status === 'STOCK_UNKNOWN', g.status);
} finally {
  for (const id of created) { await retryDb(() => prisma.inventorySnapshot.deleteMany({ where: { product_id: id } })).catch(() => {}); await retryDb(() => prisma.product.delete({ where: { id } })).catch(() => {}); }
}

console.log('6) integration audit on real data (read-only invariants)');
{
  const before = await retryDb(() => prisma.ambOperatorDecision.count({ where: { status: { in: ['EXECUTED', 'VERIFIED', 'EXECUTING'] } } }));
  const a = await retryDb(() => I.buildIntegrationAudit({ heavy: false }));
  ok('chain has the 14 links', a.chain.length >= 14, a.chain.length);
  ok('every link has a valid state', a.chain.every((l) => ['CONNECTED', 'BLOCKED', 'MISSING', 'UNVERIFIED'].includes(l.state)));
  ok('Meta writes stay locked in the test environment unless explicitly enabled', a.writesLocked === (process.env.OPERATOR_ALLOW_META_WRITES !== 'true'));
  const dec = a.chain.find((l) => l.key === 'DECISION_APPROVAL');
  ok('Decision→Approval is not reported CONNECTED while writes are locked', !a.writesLocked || dec.state === 'BLOCKED', dec.state);
  const ver = a.chain.find((l) => l.key === 'EXECUTION_VERIFY');
  ok('Execution→Meta verification is UNVERIFIED with zero real writes (never "complete because code exists")', before > 0 || ver.state === 'UNVERIFIED', ver.state);
  const missingCost = a.products.flatMap((p) => p.dependencies.filter((d) => d.key === 'COST' && d.state !== 'CONNECTED'));
  ok('a missing purchase cost is NEEDS_USER_VALUE (never fabricated)', missingCost.every((d) => d.resolution === 'NEEDS_USER_VALUE' && d.value == null));
  const stockMissing = a.products.flatMap((p) => p.dependencies.filter((d) => d.key === 'STOCK' && d.state === 'MISSING'));
  ok('a missing stock is NEEDS_USER_VALUE or NEEDS_EXTERNAL_CONFIGURATION, with no value', stockMissing.every((d) => ['NEEDS_USER_VALUE', 'NEEDS_EXTERNAL_CONFIGURATION'].includes(d.resolution) && d.value == null));
  ok('only AUTO_FIXABLE/NEEDS_* resolutions exist', Object.keys(a.missingByResolution).every((k) => ['AUTO_FIXABLE', 'NEEDS_USER_VALUE', 'NEEDS_EXTERNAL_CONFIGURATION', 'NEEDS_REVIEW', 'NONE'].includes(k)));
  ok('product counts add up', a.completion.productsReady + a.completion.productsPartial + a.completion.productsBlocked === a.completion.productsTotal);
  const trustNotOk = a.easyOrders.stores.some((s) => s.trust !== 'OK');
  ok('COD automation is BLOCKED while any store status trust is not OK / secrets not set', !trustNotOk && a.easyOrders.webhooksConfigured ? true : a.easyOrders.codAutomation === 'BLOCKED');
  const raw = JSON.stringify(a.easyOrders);
  const secrets = [process.env.EASYORDERS_WEBHOOK_SECRET, process.env.EASYORDERS_STORE_2_WEBHOOK_SECRET, process.env.EASYORDERS_STORE_2_ORDER_WEBHOOK_SECRET, process.env.EASYORDERS_STORE_2_STATUS_WEBHOOK_SECRET].filter((v) => v && v.length > 5);
  ok('no webhook secret VALUE appears in the Easy Orders status', secrets.every((sv) => !raw.includes(sv)));
  ok('no product reports a 0 price/stock/cost as a value', a.products.every((p) => p.dependencies.filter((d) => ['PRICE', 'COST', 'STOCK'].includes(d.key)).every((d) => d.value == null || d.value > 0)));
  ok('mapping counts expose the review queue', a.mapping && typeof a.mapping.counts.review === 'number');
  const after = await retryDb(() => prisma.ambOperatorDecision.count({ where: { status: { in: ['EXECUTED', 'VERIFIED', 'EXECUTING'] } } }));
  ok('the audit executed nothing', after === before);
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
