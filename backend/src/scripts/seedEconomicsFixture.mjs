// Fixtures for the «اقتصاديات المنتجات» UI test — ISOLATED test database only (the guard refuses anything else):
//   UIPEC Alpha  — price 1000, no cost yet (the incomplete product the test fills in from the screen)
//   UIPEC Beta   — price 800 · cost 300 · shipping 50 · packaging 30 (complete economics, no policy)
//   UIPEC Locked — already running an ACTIVE policy (the Hair-Cap situation): must be shown LOCKED and refuse every edit
//   node src/scripts/seedEconomicsFixture.mjs
import './_testGuard.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url)); const imp = (r) => import(pathToFileURL(join(__dirname, r)).href);
const { prisma } = await imp('../prisma.js'); const PP = await imp('../services/amb/productPolicy.js'); const PEC = await imp('../services/amb/productEconomicsCenter.js');
const ST = 'trendy-storeee'; const NAMES = ['UIPEC Alpha', 'UIPEC Beta', 'UIPEC Locked'];
const old = await prisma.product.findMany({ where: { product_name: { startsWith: 'UIPEC ' } }, select: { id: true } }); const oldIds = old.map((p) => p.id);
if (oldIds.length) { await prisma.ambOperatorProductConfig.deleteMany({ where: { product_id: { in: oldIds } } }); await prisma.ambProduct.deleteMany({ where: { product_id: { in: oldIds } } }); await prisma.product.deleteMany({ where: { id: { in: oldIds } } }); }
const row = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const raw = JSON.parse(row?.limits_json || '{}'); for (const k of Object.keys(raw.productPolicies || {})) if (k.startsWith(`${ST}:`) && oldIds.includes(Number(k.split(':')[1]))) delete raw.productPolicies[k];
const mk = async (name, price, cost, ship, pack) => { const p = await prisma.product.create({ data: { product_name: name, selling_price: price, product_cost: cost, shipping_cost: ship, packaging_cost: pack, store_id: ST } }); await prisma.ambProduct.create({ data: { product_id: p.id, product_name: name, product_cost: cost, shipping_cost: ship ?? 0, packaging_cost: pack ?? 0, active: true } }); return p; };
await mk(NAMES[0], 1000, 0, null, null); await mk(NAMES[1], 800, 300, 50, 30); const locked = await mk(NAMES[2], 1500, 500, 60, 40);
raw.productPolicies = { ...(raw.productPolicies || {}), [PP.policyKey(ST, locked.id)]: { active: PEC.fromForm({ scale: 120, reduce: 180, hardStop: 200, zeroSpend: 200, zeroMinAgeHours: 24, increasePct: 20, decreasePct: 20, minPurchases: 5, cooldownHours: 24, minBudget: 200, maxBudget: 600, dailySpendCap: 2100, maxChangesPerDay: 4 }), draft: null, version: 1, activatedAt: new Date().toISOString() } };
await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify(raw) } });
console.log('seeded', NAMES.join(', '));
await prisma.$disconnect(); process.exit(0);
