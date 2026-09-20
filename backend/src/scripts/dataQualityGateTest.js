// Smart Decision Center — services/amb/dataQualityGate.js. Pure logic,
// zero DB dependency. Proves the exact rule the user required: a
// CRITICAL failure (no deterministic product/campaign mapping, date range
// missing, duplicate campaign ids) blocks the decision outright
// (DECISION_BLOCKED_DATA_QUALITY); a WARNING (stale sync, missing Easy
// Orders block) never blocks by itself but is still surfaced; a fully
// healthy input reports VERIFIED.
//   node src/scripts/dataQualityGateTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { computeDataQualityGate } = await imp('../services/amb/dataQualityGate.js');

const healthyInput = {
  product: { id: 146, store_id: 'trendy-storeee' },
  campaigns: [{ campaignId: 'c1' }, { campaignId: 'c2' }],
  meta: { dataState: 'AVAILABLE', lastSyncAt: new Date().toISOString() },
  easyOrders: { dataState: 'AVAILABLE' },
  window: { from: '2026-09-01', to: '2026-09-20' },
};

console.log('§1 a fully healthy input reports VERIFIED, zero warnings/blockers:');
{
  const r = computeDataQualityGate(healthyInput);
  ok('status VERIFIED', r.status === 'VERIFIED', r.status);
  ok('zero critical failures', r.criticalFailures.length === 0);
  ok('zero warnings', r.warnings.length === 0);
}

console.log('\n§2 no product -> DECISION_BLOCKED_DATA_QUALITY (CRITICAL):');
{
  const r = computeDataQualityGate({ ...healthyInput, product: null });
  ok('status is DECISION_BLOCKED_DATA_QUALITY', r.status === 'DECISION_BLOCKED_DATA_QUALITY', r.status);
  ok('PRODUCT_MAPPING is the cited critical failure', r.criticalFailures.some((c) => c.name === 'PRODUCT_MAPPING'));
}

console.log('\n§3 no deterministic campaigns -> BLOCKED (never let a product-with-zero-campaigns through as VERIFIED):');
{
  const r = computeDataQualityGate({ ...healthyInput, campaigns: [] });
  ok('status is DECISION_BLOCKED_DATA_QUALITY', r.status === 'DECISION_BLOCKED_DATA_QUALITY');
  ok('CAMPAIGN_MAPPING is cited', r.criticalFailures.some((c) => c.name === 'CAMPAIGN_MAPPING'));
}

console.log('\n§4 duplicate campaign ids -> BLOCKED:');
{
  const r = computeDataQualityGate({ ...healthyInput, campaigns: [{ campaignId: 'c1' }, { campaignId: 'c1' }] });
  ok('status is DECISION_BLOCKED_DATA_QUALITY', r.status === 'DECISION_BLOCKED_DATA_QUALITY');
  ok('DUPLICATE_CAMPAIGNS is cited', r.criticalFailures.some((c) => c.name === 'DUPLICATE_CAMPAIGNS'));
}

console.log('\n§5 missing date range -> BLOCKED:');
{
  const r = computeDataQualityGate({ ...healthyInput, window: { from: null, to: null } });
  ok('status is DECISION_BLOCKED_DATA_QUALITY', r.status === 'DECISION_BLOCKED_DATA_QUALITY');
}

console.log('\n§6 Meta data unavailable -> WARNING, never a hard block by itself:');
{
  const r = computeDataQualityGate({ ...healthyInput, meta: { dataState: 'NOT_SYNCED' } });
  ok('status is DATA_QUALITY_WARNING, not BLOCKED', r.status === 'DATA_QUALITY_WARNING', r.status);
  ok('META_AVAILABILITY is the warning', r.warnings.some((w) => w.name === 'META_AVAILABILITY'));
}

console.log('\n§7 stale Meta sync -> WARNING (freshness must be visible, not silently ignored):');
{
  const staleTs = new Date(Date.now() - 200 * 60000).toISOString(); // 200 minutes old
  const r = computeDataQualityGate({ ...healthyInput, meta: { dataState: 'AVAILABLE', lastSyncAt: staleTs } });
  ok('status is DATA_QUALITY_WARNING for a 200-minute-old sync', r.status === 'DATA_QUALITY_WARNING');
  ok('META_FRESHNESS is the warning, with the real age cited', r.warnings.some((w) => w.name === 'META_FRESHNESS' && /200/.test(w.reason)), JSON.stringify(r.warnings));
}

console.log('\n§8 Easy Orders in an unexpected state -> WARNING:');
{
  const r = computeDataQualityGate({ ...healthyInput, easyOrders: { dataState: 'PROVIDER_ERROR' } });
  ok('status is DATA_QUALITY_WARNING', r.status === 'DATA_QUALITY_WARNING');
  ok('EASYORDERS_AVAILABILITY is the warning', r.warnings.some((w) => w.name === 'EASYORDERS_AVAILABILITY'));
}

console.log('\n§9 multiple simultaneous CRITICAL failures are all reported, not just the first:');
{
  const r = computeDataQualityGate({ product: null, campaigns: [], meta: { dataState: 'AVAILABLE' }, easyOrders: { dataState: 'AVAILABLE' }, window: { from: '2026-09-01', to: '2026-09-20' } });
  ok('status BLOCKED', r.status === 'DECISION_BLOCKED_DATA_QUALITY');
  ok('both PRODUCT_MAPPING and CAMPAIGN_MAPPING cited', r.criticalFailures.some((c) => c.name === 'PRODUCT_MAPPING') && r.criticalFailures.some((c) => c.name === 'CAMPAIGN_MAPPING'), JSON.stringify(r.criticalFailures));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
