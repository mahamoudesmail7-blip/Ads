// 🤖 AI Operator — SETUP GRID acceptance (2026-10-04). Disposable "__optest_" fixtures only (products, AMB products); the global Operator config
// (incl. limits_json.productOverrides) is restored byte-for-byte; every fixture/audit row is cleaned up. NO Meta call of any kind.
//   node src/scripts/operatorSetupGridTest.js
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const retryDb = async (fn) => { for (let i = 0; i < 10; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 4000)); } } return fn(); };
const T = '__optest_grid_';
const __start = new Date();

const { prisma } = await imp('../prisma.js');
const G = await imp('../services/amb/operatorSetupGrid.js');
const R = await imp('../services/amb/operatorReadiness.js');
const { createFromCatalogProduct } = await imp('../services/amb/ambProducts.js');
const CV = await imp('../services/amb/operatorCoverage.js');

const origCfg = await retryDb(() => prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }));
const counts0 = { recs: await retryDb(() => prisma.ambRecommendation.count()), actions: await retryDb(() => prisma.ambAction.count()), decisions: await retryDb(() => prisma.ambOperatorDecision.count()) };
const createdProducts = [];
try {
  const mk = async (name, extra = {}) => { const p = await retryDb(() => prisma.product.create({ data: { product_name: `${T}${name}`, product_code: `${T}${name}_${Date.now()}`, store_id: 'default', selling_price: 0, product_cost: 0, ...extra } })); createdProducts.push(p.id); await retryDb(() => createFromCatalogProduct(p.id, null)); return p; };
  const pA = await mk('A', { selling_price: 500 });           // catalogue price only
  const pB = await mk('B', { selling_price: 500 });           // will get a conflicting owner price
  const pC = await mk('C');                                   // nothing at all
  // a real catalogue product that has NO AMB row and NO campaign (the case the old grid silently dropped)
  const pD = await retryDb(() => prisma.product.create({ data: { product_name: `${T}D_no_amb`, product_code: `${T}D_${Date.now()}`, store_id: 'default', selling_price: 0, product_cost: 0 } })); createdProducts.push(pD.id);
  const productRowsBefore = await retryDb(() => prisma.product.count());
  await retryDb(() => prisma.ambProduct.update({ where: { product_id: pB.id }, data: { actual_selling_price: 700 } }));
  const row = (g, p) => g.rows.find((r) => r.productId === p.id);

  console.log('1) grid pre-fill: only trusted values that already exist');
  let g = await retryDb(() => G.buildSetupGrid());
  const a = row(g, pA), b = row(g, pB), c = row(g, pC);
  ok('fixtures appear in the grid', !!a && !!b && !!c);
  ok('existing catalogue price is pre-filled with its source', a.price.value === 500 && ['AMB', 'CATALOG'].includes(a.price.source), JSON.stringify(a.price));
  ok('owner 700 vs catalogue 500 -> CONFLICT: no value picked, both numbers shown', b.price.status === 'CONFLICT' && b.price.value === null && b.price.conflict.owner === 700 && b.price.conflict.catalog === 500, JSON.stringify(b.price));
  ok('nothing known -> MISSING (null), never 0', c.price.value === null && c.purchase_cost === null && c.target_cpa === null && c.current_stock === null && c.hard_stop_cpa === null && c.zero_order === null);
  ok('every row carries mapping status + readiness', g.rows.every((r) => ['VERIFIED', 'SUGGESTED', 'UNMAPPED'].includes(r.mapping.state) && ['READY', 'PARTIAL', 'BLOCKED'].includes(r.readiness.state)));
  ok('fixtures without campaigns are UNMAPPED and BLOCKED', a.mapping.state === 'UNMAPPED' && a.readiness.state === 'BLOCKED');
  ok('counts add up', g.counts.READY + g.counts.PARTIAL + g.counts.BLOCKED === g.counts.total);

  const d = row(g, pD);
  ok('a catalogue product WITHOUT an AMB row is listed (not dropped)', !!d && d.operatorLinked === false && d.ambProductId === null);
  ok('no campaign -> NOT_ADVERTISED (not deleted), readiness BLOCKED with an AMB_LINK + mapping gap', d.advertising === 'NOT_ADVERTISED' && d.readiness.state === 'BLOCKED' && d.readiness.missing.some((m) => m.key === 'AMB_LINK') && d.readiness.missing.some((m) => m.key === 'MAPPING'));
  ok('store isolation: every row belongs to a configured store and the fixture only to its own', g.rows.every((r) => g.stores.includes(r.store)) && g.rows.filter((r) => r.productId === pD.id).length === 1 && d.store === 'default');
  ok('per-store counts add up to the grid size', Object.values(g.counts.byStore).reduce((a, b) => a + b.total, 0) === g.rows.length && g.counts.total === g.rows.length);
  ok('advertised + not-advertised(+suggested) = total, per store', Object.values(g.counts.byStore).every((b) => b.advertised + b.notAdvertised + b.suggestedOnly === b.total));

  console.log('2) validate: blank is never zero, garbage is rejected');
  let v = await G.validateGrid({ changes: [{ productId: pA.id, values: { purchase_cost: '', target_cpa: '   ' } }] });
  ok('blank cells -> UNCHANGED (ignored)', v.rows[0].status === 'UNCHANGED' && v.rows[0].changes.length === 0, JSON.stringify(v.rows[0]));
  v = await G.validateGrid({ changes: [{ productId: pA.id, values: { purchase_cost: 'abc' } }] });
  ok('non-numeric -> ERROR', v.rows[0].status === 'ERROR' && !v.ok);
  v = await G.validateGrid({ changes: [{ productId: pA.id, values: { target_cpa: '100', hard_stop_cpa: '80' } }] });
  ok('Hard Stop < Target -> ERROR', v.rows[0].status === 'ERROR');
  v = await G.validateGrid({ changes: [{ productId: pA.id, values: { purchase_cost: '-5' } }] });
  ok('negative cost -> ERROR', v.rows[0].status === 'ERROR');
  v = await G.validateGrid({ changes: [{ productId: pA.id, values: {}, zeroOrder: { mode: 'FIXED_SPEND', value: '' } }] });
  ok('zero-order method without a value -> ERROR', v.rows[0].status === 'ERROR');
  v = await G.validateGrid({ changes: [{ productId: pA.id, values: {}, zeroOrder: { mode: 'NOPE', value: '5' } }] });
  ok('unknown zero-order method -> ERROR', v.rows[0].status === 'ERROR');
  v = await G.validateGrid({ changes: [{ productId: pA.id, values: { purchase_cost: '100' } }, { productId: pA.id, values: { purchase_cost: '110' } }] });
  ok('duplicate product in one request -> ERROR', v.rows.some((r) => r.status === 'ERROR'));
  v = await G.validateGrid({ changes: [{ productId: 99999999, values: { purchase_cost: '1' } }] });
  ok('unknown product -> ERROR', v.rows[0].status === 'ERROR');

  console.log('3) preview writes nothing');
  const before = await retryDb(() => prisma.product.findUnique({ where: { id: pA.id }, select: { product_cost: true, current_stock: true } }));
  const pv = await G.previewGrid({ changes: [{ productId: pA.id, values: { purchase_cost: '200', target_cpa: '90', hard_stop_cpa: '150', current_stock: '30', minimum_stock: '5' }, zeroOrder: { mode: 'FIXED_SPEND', value: '250' } }] });
  const after = await retryDb(() => prisma.product.findUnique({ where: { id: pA.id }, select: { product_cost: true, current_stock: true } }));
  ok('preview lists before -> after for every cell', pv.rows[0].changes.length === 6 && pv.rows[0].changes.some((x) => x.field === 'zero_order'), JSON.stringify(pv.rows[0].changes));
  ok('preview did not write (cost/stock unchanged)', before.product_cost === after.product_cost && before.current_stock === after.current_stock);
  ok('profit-aware warning: Target CPA vs unit margin is computed by the shared validator', Array.isArray(pv.rows[0].warnings));

  console.log('4) apply writes to the canonical homes, then recomputes readiness');
  const ap = await G.applyGrid({ changes: [
    { productId: pA.id, values: { purchase_cost: '200', target_cpa: '90', hard_stop_cpa: '150', current_stock: '30', minimum_stock: '5', shipping: '40' }, zeroOrder: { mode: 'FIXED_SPEND', value: '250' } },
    { productId: pB.id, values: { selling_price: '600' } },
    { productId: pC.id, values: { purchase_cost: '' } },
  ], userId: null });
  ok('summary: 2 saved, 1 unchanged', ap.summary.saved === 2 && ap.summary.unchanged === 1 && ap.summary.failed === 0, JSON.stringify(ap.summary));
  const pa = await retryDb(() => prisma.product.findUnique({ where: { id: pA.id } })), aa = await retryDb(() => prisma.ambProduct.findUnique({ where: { product_id: pA.id } }));
  ok('cost saved in BOTH the catalogue master and AMB (one save, no drift)', pa.product_cost === 200 && aa.product_cost === 200);
  ok('stock saved on the catalogue product', pa.current_stock === 30 && pa.minimum_stock === 5);
  ok('Target CPA saved', aa.target_cpa === 90);
  const cfgA = await retryDb(() => prisma.ambOperatorProductConfig.findUnique({ where: { product_id_store_id: { product_id: pA.id, store_id: 'default' } } }));
  ok('Hard Stop CPA saved in Operator product config', cfgA?.hard_stop_cpa === 150);
  const gc = JSON.parse((await retryDb(() => prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }))).limits_json);
  ok('zero-order override saved per product (FIXED_SPEND 250)', gc.productOverrides?.[String(pA.id)]?.zeroOrder?.mode === 'FIXED_SPEND' && gc.productOverrides[String(pA.id)].zeroOrder.fixedSpend === 250);
  const pc = await retryDb(() => prisma.product.findUnique({ where: { id: pC.id } }));
  ok('a blank cell was NOT written as 0 (cost still unset, no AMB row change)', pc.product_cost === 0 && pc.selling_price === 0);
  const pb = await retryDb(() => prisma.product.findUnique({ where: { id: pB.id } })), ab = await retryDb(() => prisma.ambProduct.findUnique({ where: { product_id: pB.id } }));
  ok('typing a price resolves the CONFLICT and writes both homes', pb.selling_price === 600 && ab.actual_selling_price === 600);
  ok('readiness was recomputed for the touched products', ap.readinessAfter.length === 2 && ap.readinessAfter.every((x) => ['READY', 'PARTIAL', 'BLOCKED'].includes(x.state)));
  ok('no READY product (no verified campaign) -> Shadow skipped, nothing simulated', ap.shadow.skipped === 'NO_READY_PRODUCTS' && ap.wroteMeta === false, JSON.stringify(ap.shadow).slice(0, 200));
  g = await retryDb(() => G.buildSetupGrid());
  const a2 = row(g, pA), b2 = row(g, pB);
  ok('grid reflects the saved values', a2.purchase_cost === 200 && a2.target_cpa === 90 && a2.hard_stop_cpa === 150 && a2.current_stock === 30 && a2.zero_order?.mode === 'FIXED_SPEND' && a2.zero_order.value === 250);
  ok('conflict gone after the owner decided', b2.price.status !== 'CONFLICT' && b2.price.value === 600, JSON.stringify(b2.price));
  ok('zero-order readiness item is satisfied for A, still missing for C', !row(g, pA).readiness.missing.some((m) => m.key === 'ZERO_ORDER') && row(g, pC).readiness.missing.some((m) => m.key === 'ZERO_ORDER'));

  console.log('4b) a product without an AMB row: Apply creates ONLY its AMB record (never a catalogue product)');
  const apD = await G.applyGrid({ changes: [{ productId: pD.id, values: { purchase_cost: '75', current_stock: '12' } }], userId: null });
  const ambD = await retryDb(() => prisma.ambProduct.findUnique({ where: { product_id: pD.id } }));
  ok('saved, AMB record now exists and carries the cost', apD.summary.saved === 1 && !!ambD && ambD.product_cost === 75);
  ok('no Product row was created or removed', (await retryDb(() => prisma.product.count())) === productRowsBefore);
  const gD = row(await retryDb(() => G.buildSetupGrid()), pD);
  ok('the product is now operator-linked and still NOT_ADVERTISED', gD.operatorLinked === true && gD.advertising === 'NOT_ADVERTISED' && gD.purchase_cost === 75 && gD.current_stock === 12);

  console.log('4c) coverage audit is read-only and internally consistent');
  const cv0 = { products: await retryDb(() => prisma.product.count()), amb: await retryDb(() => prisma.ambProduct.count()) };
  const cov = await retryDb(() => CV.coverageAudit());
  const cv1 = { products: await retryDb(() => prisma.product.count()), amb: await retryDb(() => prisma.ambProduct.count()) };
  ok('coverage wrote nothing', cv0.products === cv1.products && cv0.amb === cv1.amb && cov.readOnly === true);
  const sts = Object.values(cov.stores);
  ok('every store: operator products == catalogue products (nothing excluded)', sts.every((x) => x.operatorProducts === x.totalCatalogProducts));
  ok('every store: with + without campaigns == catalogue products', sts.every((x) => x.withCampaigns + x.withoutCampaigns + x.withSuggestedOnly === x.totalCatalogProducts));
  ok('every store: linked + missing == operator products', sts.every((x) => x.operatorLinked + x.missingFromOperatorActingLayer === x.operatorProducts));
  ok('grid size == coverage total', (await retryDb(() => G.buildSetupGrid())).rows.length === cov.totals.totalCatalogProducts);
  ok('unresolved-store products are reported, never silently attached to a store', Array.isArray(cov.unresolvedStore) && typeof cov.totals.unresolvedStore === 'number');

  console.log('5) apply refuses bad rows atomically (unless skipInvalid)');
  let refused = false; try { await G.applyGrid({ changes: [{ productId: pC.id, values: { purchase_cost: '50' } }, { productId: pA.id, values: { purchase_cost: 'x' } }], userId: null }); } catch (e) { refused = e.status === 400; }
  const pc2 = await retryDb(() => prisma.product.findUnique({ where: { id: pC.id } }));
  ok('one invalid row -> HTTP 400 and NOTHING saved', refused && pc2.product_cost === 0);
  const sk = await G.applyGrid({ changes: [{ productId: pC.id, values: { purchase_cost: '50' } }, { productId: pA.id, values: { purchase_cost: 'x' } }], skipInvalid: true, userId: null });
  ok('skipInvalid saves the valid row only', sk.summary.saved === 1 && sk.summary.skipped === 1);

  console.log('6) shadow is read-only and limited to READY products');
  const sh = await G.shadowForProducts({ productIds: [pA.id, pB.id, pC.id] });
  ok('fixtures are not READY -> skipped (no simulation, no write)', !!sh.skipped && !sh.wrote);
  const rc = await G.recomputeReadiness({ productIds: [pA.id] });
  ok('recompute (with data-quality check) returns the product state', rc.length === 1 && rc[0].productId === pA.id);
  const after2 = { recs: await retryDb(() => prisma.ambRecommendation.count()), actions: await retryDb(() => prisma.ambAction.count()), decisions: await retryDb(() => prisma.ambOperatorDecision.count()) };
  ok('zero recommendation/action/decision rows created (no Meta path, no decision persisted)', after2.recs === counts0.recs && after2.actions === counts0.actions && after2.decisions === counts0.decisions);
} finally {
  try {
    await retryDb(() => prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: origCfg.limits_json, mode: origCfg.mode, emergency_stop: origCfg.emergency_stop } }));
    await retryDb(() => prisma.ambOperatorProductConfig.deleteMany({ where: { product_id: { in: createdProducts } } }));
    await retryDb(() => prisma.ambProduct.deleteMany({ where: { OR: [{ product_id: { in: createdProducts } }, { product_name: { startsWith: T } }] } }));
    await retryDb(() => prisma.product.deleteMany({ where: { OR: [{ id: { in: createdProducts } }, { product_name: { startsWith: T } }] } }));
    await retryDb(() => prisma.aiAuditLog.deleteMany({ where: { kind: { startsWith: 'OPERATOR_' }, actor_id: null, created_at: { gte: __start } } }));
    await retryDb(() => prisma.ambOperatorEvent.deleteMany({ where: { actor_id: null, created_at: { gte: __start } } }));
    const c2 = await retryDb(() => prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }));
    const left = { products: await prisma.product.count({ where: { product_name: { startsWith: T } } }), amb: await prisma.ambProduct.count({ where: { product_name: { startsWith: T } } }), opCfg: await prisma.ambOperatorProductConfig.count({ where: { product_id: { in: createdProducts } } }) };
    ok('cleanup: no fixtures left, global config (incl. productOverrides) restored byte-for-byte', Object.values(left).every((n) => n === 0) && c2.limits_json === origCfg.limits_json && c2.mode === origCfg.mode, JSON.stringify(left));
  } catch (e) { fail++; console.log('  ✗ cleanup failed —', e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
