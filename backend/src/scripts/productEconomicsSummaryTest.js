// 🧪 Product page ↔ «اقتصاديات المنتجات»: /profiles/:id/economics (getEconomicsSummary) shows the SAME real numbers as the economics screen — nothing assumed (missing = null), the readiness checklist, the lock, the link —
// behind the same fail-closed store isolation as every live endpoint. Disposable fixtures (`__pecs_`) on the ISOLATED test database.
//   node src/scripts/productEconomicsSummaryTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url)); const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
const { prisma } = await imp('../prisma.js'); const LCS = await imp('../services/amb/liveCampaignStatus.js'); const PEC = await imp('../services/amb/productEconomicsCenter.js'); const PP = await imp('../services/amb/productPolicy.js'); const { STORE_CONTEXT_REQUIRED } = await imp('../services/amb/storeScope.js');
const ADMIN_ID = (await prisma.user.findFirst({ where: { role: 'ADMIN', status: 'ACTIVE' } }))?.id ?? 1; const ST = 'trendy-storeee';
const limits0 = (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }))?.limits_json ?? null; const made = { products: [], ambs: [], profiles: [] };
const mkProduct = async (name, { amb = true } = {}) => { const p = await prisma.product.create({ data: { product_name: `__pecs_${name}_${Date.now()}`, selling_price: 1000, product_cost: 0, store_id: ST } }); made.products.push(p.id); if (amb) { const a = await prisma.ambProduct.create({ data: { product_id: p.id, product_name: p.product_name, product_cost: 0, active: true } }); made.ambs.push(a.id); } return p; };
const mkProfile = async (p) => { const f = await prisma.productMarketingProfile.create({ data: { product_id: p?.id ?? null, source: 'MANUAL_UPLOAD', locked_name: p?.product_name || `__pecs_unlinked_${Date.now()}` } }); made.profiles.push(f.id); return f; };
const later = () => new Date(Date.now() + 120_000); // past the 45 s cache
try {
  console.log('\n1. An incomplete product: the product page shows what the economics screen shows — nothing assumed');
  const A = await mkProduct('a'); const FA = await mkProfile(A);
  const s1 = await LCS.getEconomicsSummary({ profileId: FA.id, storeId: ST });
  ok('linked + available; cost not entered → economics incomplete, NO margin, NO profit, NO max CPA (all null, never 0)', s1.linked && s1.available && s1.economicsComplete === false && s1.unitMargin === null && s1.profit30 === null && s1.profit7 === null && s1.cpa.max === null && s1.marginPct === null, JSON.stringify(s1));
  ok('the readiness checklist is there: not ready, N/total, and the missing items are named (economics · spend limits · CPA limits)', s1.readiness.ready === false && s1.readiness.total >= 6 && s1.readiness.okCount < s1.readiness.total && ['SPEND_LIMITS', 'CPA_LIMITS'].every((k) => s1.readiness.missing.some((m) => m.key === k)) && !s1.readiness.missing.some((m) => m.key === 'ECONOMICS'), JSON.stringify(s1.readiness));
  ok('it carries the link to the economics screen (V2, section «prod») and says the policy status', s1.screen.section === 'prod' && /ui=v2/.test(s1.screen.path) && s1.policy.status === 'NONE' && s1.locked === false);

  console.log('\n2. After the owner enters real numbers the page follows (same engine as the screen)');
  await PEC.saveProductEconomics({ productId: A.id, userId: ADMIN_ID, economics: { cost: 400, shipping: 60, packaging: 40, currentStock: 150, minimumStock: 30 }, cpaLimits: { target: 120, max: 200, hardStop: 220 } });
  const same = await LCS.getEconomicsSummaryByProductId({ productId: A.id }); ok('within the short cache window the page still shows the previous answer (it is cheap to re-open)', same.unitMargin === null);
  const s2 = await LCS.getEconomicsSummaryByProductId({ productId: A.id, now: later() });
  ok('real margin 1000 − (400+60+40) = 500 (50% of the price), economics complete, max CPA 200, stock 150 / min 30', s2.economicsComplete === true && s2.unitMargin === 500 && s2.marginPct === 50 && s2.breakEvenCpa === 500 && s2.cpa.max === 200 && s2.cpa.target === 120 && s2.cpa.hardStop === 220 && s2.stock.current === 150 && s2.stock.minimum === 30, JSON.stringify(s2));
  ok('economics never appear as missing (optional) and CPA limits ✗ is still reported honestly until a policy draft exists', s2.readiness.okCount >= s1.readiness.okCount && s2.readiness.missing.every((m) => m.key !== 'ECONOMICS') && s2.readiness.missing.some((m) => m.key === 'CPA_LIMITS'), JSON.stringify(s2.readiness.missing.map((m) => m.key)));

  console.log('\n3. A product that already runs a policy is flagged LOCKED on the page too');
  const B = await mkProduct('b'); const FB = await mkProfile(B); const raw = JSON.parse((await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } })).limits_json || '{}');
  raw.productPolicies = { ...(raw.productPolicies || {}), [PP.policyKey(ST, B.id)]: { active: PEC.fromForm({ scale: 120, reduce: 180, hardStop: 200, minBudget: 200, maxBudget: 600, dailySpendCap: 2100 }), draft: null, version: 1, activatedAt: new Date().toISOString() } };
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify(raw) } });
  const s3 = await LCS.getEconomicsSummaryByProductId({ productId: B.id, now: later() }); ok('locked: true with the reason, and the policy status says ACTIVE', s3.locked === true && /مقفولة/.test(s3.lockedReason) && s3.policy.status === 'ACTIVE', JSON.stringify(s3.policy));
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } });

  console.log('\n4. Store isolation (fail-closed) and unlinked / unknown profiles');
  const wrong = await LCS.getEconomicsSummary({ profileId: FA.id, storeId: 'default' }); const miss = await LCS.getEconomicsSummary({ profileId: FA.id, storeId: null });
  ok('the WRONG store is refused (linked:false, STORE_CONTEXT_REQUIRED) — no numbers leak across stores', wrong.linked === false && wrong.code === STORE_CONTEXT_REQUIRED && wrong.unitMargin === undefined, JSON.stringify(wrong));
  ok('a MISSING store is refused the same way (never guessed)', miss.linked === false && miss.code === STORE_CONTEXT_REQUIRED);
  const FU = await mkProfile(null); const su = await LCS.getEconomicsSummary({ profileId: FU.id, storeId: ST }); ok('a profile not linked to a real catalogue product → linked:false with the reason, no numbers', su.linked === false && /مش مربوط/.test(su.reason));
  let e404 = null; try { await LCS.getEconomicsSummary({ profileId: 999999999, storeId: ST }); } catch (e) { e404 = e; } ok('an unknown profile → 404 (same as the other live endpoints)', e404?.status === 404);
  const C = await mkProduct('c', { amb: false }); const FC = await mkProfile(C); const sc = await LCS.getEconomicsSummary({ profileId: FC.id, storeId: ST });
  ok('a catalogue product with NO AMB record → linked, available:false, and it says how the record gets created (never an empty/zero card)', sc.linked === true && sc.available === false && /اقتصاديات المنتجات/.test(sc.reason), JSON.stringify(sc));
} finally {
  await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } }).catch(() => {});
  await prisma.productMarketingProfile.deleteMany({ where: { id: { in: made.profiles } } }).catch(() => {});
  await prisma.ambOperatorProductConfig.deleteMany({ where: { product_id: { in: made.products } } }).catch(() => {});
  await prisma.ambProduct.deleteMany({ where: { id: { in: made.ambs } } }).catch(() => {}); await prisma.product.deleteMany({ where: { id: { in: made.products } } }).catch(() => {});
}
await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`); setTimeout(() => process.exit(fail ? 1 : 0), 50);
