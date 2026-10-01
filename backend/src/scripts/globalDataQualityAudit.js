// Global Data Quality / Reconciliation Audit (2026-10-01) — runs
// computeProductDataQuality() (backend/src/services/amb/dataQuality.js) for
// EVERY real product that has a Meta campaign mapping, in EVERY real store,
// and tallies the result. Read-only: judges what's already synced/cached,
// never forces a fresh Meta call per product (that would be slow and risk
// rate-limiting across a whole account's catalogue) — staleness itself is
// one of the things being measured.
//   node src/scripts/globalDataQualityAudit.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

const { prisma } = await imp('../prisma.js');
const { computeProductDataQuality } = await imp('../services/amb/dataQuality.js');

// Every real product that has at least a Meta mapping attempt (an AmbProduct
// row) — a product with NO AmbProduct at all is out of scope for this audit
// (nothing to reconcile yet), same as the per-product service's own
// MAPPING_ERROR path would report if asked directly.
const ambProducts = await prisma.ambProduct.findMany({ where: { active: true }, select: { product_id: true } });
const products = await prisma.product.findMany({
  where: { id: { in: ambProducts.map((a) => a.product_id) } },
  select: { id: true, product_name: true, store_id: true },
});

console.log(`Auditing ${products.length} real, Meta-mapped products across every real store...\n`);

const tally = {
  total: 0, RECONCILED: 0, WARNING: 0, BLOCKED: 0, STALE: 0, MAPPING_ERROR: 0, PURCHASE_RECONCILIATION_ERROR: 0,
};
const byStore = new Map();
const problems = [];

for (const p of products) {
  const storeId = p.store_id || 'default';
  tally.total++;
  if (!byStore.has(storeId)) byStore.set(storeId, { total: 0, RECONCILED: 0, WARNING: 0, BLOCKED: 0, STALE: 0, MAPPING_ERROR: 0, PURCHASE_RECONCILIATION_ERROR: 0 });
  const storeTally = byStore.get(storeId);
  storeTally.total++;

  let dq;
  try {
    dq = await computeProductDataQuality({ productId: p.id, storeId: p.store_id, windowName: 'today' });
  } catch (err) {
    tally.MAPPING_ERROR++; storeTally.MAPPING_ERROR++;
    problems.push({ productId: p.id, productName: p.product_name, storeId, overallStatus: 'ERROR', detail: err.message });
    console.log(`✗ #${p.id} ${p.product_name} (${storeId}) — EXCEPTION: ${err.message}`);
    continue;
  }
  if (!dq.ok) {
    tally.MAPPING_ERROR++; storeTally.MAPPING_ERROR++;
    problems.push({ productId: p.id, productName: p.product_name, storeId, overallStatus: dq.code || 'ERROR', detail: dq.reason });
    console.log(`✗ #${p.id} ${p.product_name} (${storeId}) — ${dq.code}: ${dq.reason}`);
    continue;
  }

  const status = dq.overallStatus;
  if (tally[status] !== undefined) { tally[status]++; storeTally[status]++; }
  const icon = status === 'RECONCILED' ? '✓' : status === 'WARNING' || status === 'STALE' ? '~' : '✗';
  console.log(`${icon} #${p.id} ${p.product_name.slice(0, 50)} (${storeId}) — ${status}${dq.discrepancies.length ? ' | ' + dq.discrepancies.join(' / ') : ''}`);
  if (status !== 'RECONCILED') {
    problems.push({ productId: p.id, productName: p.product_name, storeId, overallStatus: status, detail: dq.discrepancies.join(' / ') || null, campaignPurchases: dq.campaignPurchases, age: dq.age?.status, gender: dq.gender?.status, region: dq.region?.status });
  }
}

console.log('\n========================= GLOBAL DATA ACCURACY REPORT =========================');
console.log(`Total Products audited:            ${tally.total}`);
console.log(`Fully Reconciled:                  ${tally.RECONCILED}`);
console.log(`Warnings:                          ${tally.WARNING}`);
console.log(`Blocked:                           ${tally.BLOCKED}`);
console.log(`Stale:                             ${tally.STALE}`);
console.log(`Mapping Errors:                    ${tally.MAPPING_ERROR}`);
console.log(`Purchase Reconciliation Errors:    ${tally.PURCHASE_RECONCILIATION_ERROR}`);

console.log('\n--- Per store ---');
for (const [storeId, t] of byStore.entries()) {
  console.log(`\n${storeId}: total=${t.total} reconciled=${t.RECONCILED} warning=${t.WARNING} blocked=${t.BLOCKED} stale=${t.STALE} mappingError=${t.MAPPING_ERROR} purchaseReconError=${t.PURCHASE_RECONCILIATION_ERROR}`);
}

if (problems.length) {
  console.log('\n--- All non-RECONCILED products (full detail) ---');
  for (const p of problems) console.log(JSON.stringify(p));
}

await prisma.$disconnect();
process.exit(0);
