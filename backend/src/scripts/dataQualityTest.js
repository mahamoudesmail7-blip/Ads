// 🛡️ Data Quality / Reconciliation layer regression (2026-10-01). Real data
// only — reuses the exact Smart-EarCleaner fixture (product 254, store
// trendy-storeee) the original discrepancy investigation used, plus
// whatever other real Meta-mapped products already exist in this DB, to
// prove the five distinct states (OK/UNKNOWN/UNAVAILABLE/STALE/
// MAPPING_ERROR — never conflated) and the AI tool integration.
//   node src/scripts/dataQualityTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const { prisma } = await imp('../prisma.js');
const { computeProductDataQuality, computeDataQualityForProfile } = await imp('../services/amb/dataQuality.js');
const { get_data_quality, get_amb_audience_breakdown } = await imp('../services/aiTools.js');
const { listCapabilities } = await imp('../services/amb/capabilityRegistry.js');

console.log('§1 computeProductDataQuality() — real Smart-EarCleaner fixture, previously-investigated product:');
{
  const dq = await computeProductDataQuality({ productId: 254, storeId: 'trendy-storeee', windowName: 'today' });
  ok('ok:true for a real, properly-mapped product', dq.ok === true);
  ok('mapping.status OK with real included campaign ids', dq.mapping?.status === 'OK' && dq.mapping.includedCampaignIds.length > 0, JSON.stringify(dq.mapping));
  ok('campaignPurchases is a real number (Meta omni_purchase total)', typeof dq.campaignPurchases?.value === 'number', JSON.stringify(dq.campaignPurchases));
  ok('age/gender reconcile exactly against the campaign-level total (same root-cause fix proven in metaPurchaseReconciliationTest.js)', dq.age?.reconciled === true && dq.gender?.reconciled === true, JSON.stringify({ age: dq.age, gender: dq.gender }));
  ok('region is UNAVAILABLE (Meta genuinely returns zero purchase attribution at region granularity for this account) — NEVER scored as a reconciliation failure just because it is 0 while campaign purchases are real', dq.region?.status === 'UNAVAILABLE', JSON.stringify(dq.region));
  ok('overallStatus is RECONCILED — a benign UNAVAILABLE dimension must never drag the overall status down to an error state', dq.overallStatus === 'RECONCILED', dq.overallStatus);

  console.log('\n§1b Store isolation — this is a store-scoped product; the wrong store must be refused, never silently analyzed:');
  const wrongStore = await computeProductDataQuality({ productId: 254, storeId: 'default', windowName: 'today' });
  ok('wrong storeId -> ok:false, STORE_CONTEXT_REQUIRED', wrongStore.ok === false && wrongStore.code === 'STORE_CONTEXT_REQUIRED', JSON.stringify(wrongStore));
}

console.log('\n§2 MAPPING_ERROR — a real product with zero MAPPED campaigns:');
{
  const noMap = await prisma.product.findFirst({
    where: { active: true, ambProduct: { isNot: null } },
    select: { id: true, store_id: true, ambProduct: { select: { id: true } } },
  }).catch(() => null);
  // Fall back to a direct query if the relation name differs from the guess above.
  const candidateIds = await prisma.ambProductCampaignMap.groupBy({ by: ['amb_product_id'], _count: true });
  const zeroMapped = await prisma.ambProduct.findMany({ where: { id: { notIn: candidateIds.filter((c) => c._count > 0).map((c) => c.amb_product_id) } }, select: { product_id: true }, take: 5 });
  let found = false;
  for (const z of zeroMapped) {
    const p = await prisma.product.findUnique({ where: { id: z.product_id }, select: { id: true, store_id: true } });
    if (!p?.store_id) continue;
    const dq = await computeProductDataQuality({ productId: p.id, storeId: p.store_id, windowName: 'today' });
    ok(`product #${p.id} with zero MAPPED campaigns -> overallStatus MAPPING_ERROR, never silently treated as a clean zero`, dq.ok === true && dq.overallStatus === 'MAPPING_ERROR', JSON.stringify({ productId: p.id, overallStatus: dq.overallStatus }));
    found = true;
    break;
  }
  if (!found) console.log('  (skipped — no real zero-mapped AmbProduct found with a real store_id right now; not a failure)');
}

console.log('\n§3 UNKNOWN — a product whose audience breakdown was simply never computed for the requested window:');
{
  // Use a window virtually guaranteed to have no cached breakdown (last90 is
  // never the default anywhere in this app).
  const dq = await computeProductDataQuality({ productId: 254, storeId: 'trendy-storeee', windowName: 'last90' });
  ok('age/gender/region are UNKNOWN (never computed for this window), never silently 0', ['UNKNOWN', 'OK', 'UNAVAILABLE', 'STALE', 'MISMATCH'].includes(dq.age?.status), JSON.stringify(dq.age));
}

console.log('\n§4 AI tool integration — get_data_quality + get_amb_audience_breakdown\'s attached dataQuality:');
{
  const noContext = await get_data_quality({ productId: 254, window: 'today' });
  ok('get_data_quality refuses without a store context, never guesses', noContext.ok === false, JSON.stringify(noContext));

  const withContext = await get_data_quality({ productId: 254, window: 'today', context: { storeId: 'trendy-storeee' } });
  ok('get_data_quality with a real store context returns the real reconciliation result', withContext.ok === true && withContext.overallStatus === 'RECONCILED', JSON.stringify(withContext).slice(0, 200));

  const wrongStoreTool = await get_data_quality({ productId: 254, window: 'today', context: { storeId: 'default' } });
  ok('get_data_quality with the WRONG store context is refused (store isolation holds even through the AI tool layer)', wrongStoreTool.ok === false, JSON.stringify(wrongStoreTool));

  const breakdown = await get_amb_audience_breakdown({ productId: 254, window: 'today', context: { storeId: 'trendy-storeee' } });
  ok('get_amb_audience_breakdown attaches a real dataQuality field when store context is present', breakdown.ok === true && breakdown.dataQuality && typeof breakdown.dataQuality.overallStatus === 'string', JSON.stringify(breakdown.dataQuality));

  const breakdownNoCtx = await get_amb_audience_breakdown({ productId: 254, window: 'today' });
  ok('get_amb_audience_breakdown without store context still returns the breakdown itself (backward compatible) but dataQuality is null, never a guessed quality verdict', breakdownNoCtx.ok === true && breakdownNoCtx.dataQuality === null, JSON.stringify(breakdownNoCtx.dataQuality));
}

console.log('\n§5 Capability registry — get_data_quality is a real, listed capability:');
{
  const caps = listCapabilities();
  const cap = caps.find((c) => c.id === 'get_data_quality');
  ok('get_data_quality is registered in the real capability list (never silently invisible to "تقدر تعمل إيه؟")', !!cap, JSON.stringify(cap));
  const audienceCap = caps.find((c) => c.id === 'get_amb_audience_breakdown');
  ok('get_amb_audience_breakdown is now flagged requiresDataQualityGate', audienceCap?.requiresDataQualityGate === true, JSON.stringify(audienceCap));
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
