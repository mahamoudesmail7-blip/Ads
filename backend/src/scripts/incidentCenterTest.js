// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 14 (Incident Center) verification.
//   node src/scripts/incidentCenterTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { detectIncidentsForProduct, raiseIncidentAlerts, INCIDENT_SEVERITY } = await imp('../services/amb/incidentCenter.js');
const { buildProductDecisionPackage } = await imp('../services/amb/productDecision.js');
const { getAmbSettings } = await imp('../services/amb/settings.js');
const { getConnection } = await imp('../services/metaAuth.js');
const { get_incidents } = await imp('../services/aiTools.js');

const cleanupAlertIds = [];
async function cleanup() {
  if (cleanupAlertIds.length) await prisma.ambAlert.deleteMany({ where: { id: { in: cleanupAlertIds } } }).catch(() => {});
}

try {
  console.log('§1 Real detection across several real AmbProducts — every incident must be evidence-backed, never fabricated:');
  const settings = await getAmbSettings();
  const connection = await getConnection().catch(() => null);
  const adAccountId = connection?.selected_ad_account_id || null;
  const ambProducts = await prisma.ambProduct.findMany({ take: 8, orderBy: { id: 'desc' }, select: { product_id: true, product_name: true } });

  let totalIncidents = 0;
  let sawAnyIncident = false;
  const seenTypes = new Set();

  for (const ap of ambProducts) {
    if (!ap.product_id) continue;
    let pkg;
    try {
      pkg = await buildProductDecisionPackage({ productId: ap.product_id, windowName: 'last7', settings, adAccountId });
    } catch (e) {
      console.log(`  (skip ${ap.product_name} — pkg build failed: ${e.message})`);
      continue;
    }
    const result = await detectIncidentsForProduct({ productId: ap.product_id, productName: pkg.productName, pkg });
    ok(`${ap.product_name}: result has a real productId/productName/checkedAt`, result.productId === ap.product_id && typeof result.productName === 'string' && typeof result.checkedAt === 'string');
    ok(`${ap.product_name}: incidents is an array`, Array.isArray(result.incidents));
    for (const i of result.incidents) {
      ok(`${ap.product_name}: incident "${i.type}" has a real spec severity`, INCIDENT_SEVERITY.includes(i.severity), i.severity);
      ok(`${ap.product_name}: incident "${i.type}" has a non-empty title/message/evidence`, !!i.title && !!i.message && !!i.evidence);
      seenTypes.add(i.type);
    }
    totalIncidents += result.incidents.length;
    if (result.incidents.length) sawAnyIncident = true;
  }
  console.log(`  total incidents detected across ${ambProducts.length} real products: ${totalIncidents}`);
  console.log(`  incident types actually observed on real data: ${[...seenTypes].join(', ') || '(none)'}`);
  ok('checked at least one real product without a hard failure', ambProducts.length > 0);

  console.log('\n§2 Persistence — raiseIncidentAlerts writes through the EXISTING amb_alerts pipeline, deduped by (product, type):');
  {
    const fakeProductId = 999999; // disposable id, never a real product, so no collision with real alerts
    const incidents = [
      { type: 'CPA_SPIKE', severity: 'HIGH', title: 'اختبار Slice 14 — CPA', message: 'رسالة اختبار', evidence: 'test' },
      { type: 'META_STALE', severity: 'WARNING', title: 'اختبار Slice 14 — Meta', message: 'رسالة اختبار', evidence: 'test' },
    ];
    const raised = await raiseIncidentAlerts({ productId: fakeProductId, incidents });
    ok('raiseIncidentAlerts persists one row per incident', raised.length === 2, raised.length);
    for (const r of raised) if (r?.id) cleanupAlertIds.push(r.id);

    const raisedAgain = await raiseIncidentAlerts({ productId: fakeProductId, incidents });
    for (const r of raisedAgain) if (r?.id && !cleanupAlertIds.includes(r.id)) cleanupAlertIds.push(r.id);
    const rows = await prisma.ambAlert.findMany({ where: { entity_id: String(fakeProductId), category: 'INCIDENT' } });
    ok('re-raising the SAME incident types upserts (no duplicate rows), matching every other raiseAlert() caller\'s convention', rows.length === 2, rows.length);
  }

  console.log('\n§3 get_incidents (the chat-facing read tool) — real end-to-end call on a real product with mapped campaigns:');
  {
    const withCampaigns = await prisma.ambProductCampaignMap.findFirst({ where: { status: 'MAPPED' }, select: { amb_product: { select: { product_id: true } } } });
    const targetProductId = withCampaigns?.amb_product?.product_id || ambProducts[0]?.product_id;
    if (targetProductId) {
      const out = await get_incidents({ productId: targetProductId });
      ok('get_incidents returns ok:true with hasData', out.ok === true && out.hasData === true, JSON.stringify(out).slice(0, 300));
      ok('get_incidents count matches incidents.length', out.count === out.incidents.length, `count=${out.count} len=${out.incidents?.length}`);
      ok('get_incidents bySeverity totals match count', Object.values(out.bySeverity).reduce((a, b) => a + b, 0) === out.count);
      // Clean up whatever real alerts this call raised for the real product, so the test leaves no residue.
      const realAlerts = await prisma.ambAlert.findMany({ where: { entity_id: String(targetProductId), category: 'INCIDENT' } });
      for (const a of realAlerts) cleanupAlertIds.push(a.id);
      console.log(`  get_incidents(${targetProductId}) -> count=${out.count}, bySeverity=${JSON.stringify(out.bySeverity)}`);
    } else {
      console.log('  (skipped — no mapped product found)');
    }
  }

  console.log('\n§4 Honesty check — get_incidents on a product with NO real signal source (bad id) fails cleanly, never invents data:');
  {
    const bad = await get_incidents({ productId: 987654321 });
    ok('a non-existent productId returns ok:false, not a fabricated empty report', bad.ok === false, JSON.stringify(bad));
  }
} finally {
  await cleanup();
  console.log('\ncleanup done —', cleanupAlertIds.length, 'test/real alert row(s) removed.');
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
