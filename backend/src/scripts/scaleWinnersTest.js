// Offline tests for Winner → Scale (spec §12). No Meta calls. Seeds throwaway
// AmbCloneBatch/Job/ObjectMap rows to exercise the completeness verifier and
// asserts the adAllowlist tree-filter keeps the right ancestors.
//   node src/scripts/scaleWinnersTest.js
import 'dotenv/config';
import { prisma } from '../prisma.js';
import { waitAndVerifyScale } from '../services/amb/scaleWinners.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

// ---------------------------------------------------------------------------
// adAllowlist tree filter — the exact logic from cloneJob (§3/§4).
// ---------------------------------------------------------------------------
function filterTree(adsets, ads, allowlist) {
  const allow = new Set(allowlist.map(String));
  const keptAds = ads.filter((a) => allow.has(String(a.id)));
  const keptAdsetIds = new Set(keptAds.map((a) => a.adset_id));
  const keptAdsets = adsets.filter((as) => keptAdsetIds.has(as.id));
  return { keptAdsets, keptAds };
}

console.log('adAllowlist tree filter:');
{
  const adsets = [{ id: 'as1' }, { id: 'as2' }];
  const ads = [{ id: 'ad1', adset_id: 'as1' }, { id: 'ad2', adset_id: 'as1' }, { id: 'ad3', adset_id: 'as2' }];
  // A) 1 ad / 1 ad set
  let r = filterTree(adsets, ads, ['ad1']);
  ok('A: 1 selected ad → 1 ad set, 1 ad', r.keptAdsets.length === 1 && r.keptAds.length === 1 && r.keptAdsets[0].id === 'as1');
  // B) 2 ads / same ad set
  r = filterTree(adsets, ads, ['ad1', 'ad2']);
  ok('B: 2 ads same ad set → 1 ad set, 2 ads', r.keptAdsets.length === 1 && r.keptAds.length === 2);
  // C) 2 ads / different ad sets
  r = filterTree(adsets, ads, ['ad1', 'ad3']);
  ok('C: 2 ads across 2 ad sets → 2 ad sets, 2 ads', r.keptAdsets.length === 2 && r.keptAds.length === 2 && new Set(r.keptAdsets.map((x) => x.id)).size === 2);
  // never empty when an ad is selected
  ok('never a campaign with 0 ad sets when an ad is picked', filterTree(adsets, ads, ['ad3']).keptAdsets.length === 1);
}

// ---------------------------------------------------------------------------
// waitAndVerifyScale — completeness invariants (§6/§10). Seed real rows.
// ---------------------------------------------------------------------------
const BID = 'test-scale-' + Date.now();
async function seed(objectRows) {
  await prisma.ambCloneBatch.create({ data: { batch_id: BID, source_ad_account_id: 'act_x', destination_account_ids_json: '["act_x"]', campaign_ids_json: '["c1"]', total_copies: 1, status: 'SCHEDULED' } });
  const job = await prisma.ambCloneJob.create({ data: { batch_id: BID, source_ad_account_id: 'act_x', destination_ad_account_id: 'act_x', source_campaign_id: 'c1', status: 'CLONED_PAUSED' } });
  for (const o of objectRows) await prisma.ambCloneObjectMap.create({ data: { job_id: job.id, batch_id: BID, ...o } });
  return job;
}
async function cleanup() {
  await prisma.ambCloneObjectMap.deleteMany({ where: { batch_id: BID } });
  await prisma.ambCloneJob.deleteMany({ where: { batch_id: BID } });
  await prisma.ambCloneBatch.deleteMany({ where: { batch_id: BID } });
}

console.log('\nwaitAndVerifyScale completeness:');
try {
  await cleanup();

  // Complete: campaign + 1 ad set + 1 ad, all CREATED
  await seed([
    { level: 'CAMPAIGN', source_id: 'c1', destination_id: 'dc1', status: 'CREATED' },
    { level: 'ADSET', source_id: 'as1', destination_id: 'das1', status: 'CREATED' },
    { level: 'AD', source_id: 'ad1', destination_id: 'dad1', status: 'CREATED' },
  ]);
  let v = await waitAndVerifyScale({ batchId: BID, requiredAdSetIds: ['as1'], selectedAdIds: ['ad1'], timeoutMs: 4000, pollMs: 500 });
  ok('complete tree → ok, campaign id + counts', v.ok && v.destinationCampaignId === 'dc1' && v.counts.adSetsCreated === 1 && v.counts.adsCreated === 1);
  await cleanup();

  // D) Ad set FAILED → not ok
  await seed([
    { level: 'CAMPAIGN', source_id: 'c1', destination_id: 'dc1', status: 'CREATED' },
    { level: 'ADSET', source_id: 'as1', destination_id: null, status: 'FAILED', error: 'Bid Amount Required...' },
  ]);
  await prisma.ambCloneJob.updateMany({ where: { batch_id: BID }, data: { status: 'FAILED', error: 'اكتمل جزئيًا' } });
  v = await waitAndVerifyScale({ batchId: BID, requiredAdSetIds: ['as1'], selectedAdIds: ['ad1'], timeoutMs: 4000, pollMs: 500 });
  ok('D: ad set failed → NOT ok, real error surfaced', !v.ok && /Bid Amount Required/.test(v.error), v.error);
  await cleanup();

  // E) Ad set created but Ad FAILED → not ok
  await seed([
    { level: 'CAMPAIGN', source_id: 'c1', destination_id: 'dc1', status: 'CREATED' },
    { level: 'ADSET', source_id: 'as1', destination_id: 'das1', status: 'CREATED' },
    { level: 'AD', source_id: 'ad1', destination_id: null, status: 'FAILED', error: 'creative rejected' },
  ]);
  await prisma.ambCloneJob.updateMany({ where: { batch_id: BID }, data: { status: 'FAILED' } });
  v = await waitAndVerifyScale({ batchId: BID, requiredAdSetIds: ['as1'], selectedAdIds: ['ad1'], timeoutMs: 4000, pollMs: 500 });
  ok('E: ad failed → NOT ok', !v.ok && /creative rejected/.test(v.error), v.error);
  await cleanup();

  // missing ad set row entirely (0 ad sets) → not ok
  await seed([{ level: 'CAMPAIGN', source_id: 'c1', destination_id: 'dc1', status: 'CREATED' }]);
  v = await waitAndVerifyScale({ batchId: BID, requiredAdSetIds: ['as1'], selectedAdIds: ['ad1'], timeoutMs: 4000, pollMs: 500 });
  ok('0 ad sets on the campaign → NOT ok (the reported bug)', !v.ok && v.destinationCampaignId === 'dc1' && v.counts.adSetsCreated === 0);
  await cleanup();

  // C-shape: 2 required ad sets, 2 ads, all present → ok
  await seed([
    { level: 'CAMPAIGN', source_id: 'c1', destination_id: 'dc1', status: 'CREATED' },
    { level: 'ADSET', source_id: 'as1', destination_id: 'das1', status: 'CREATED' },
    { level: 'ADSET', source_id: 'as2', destination_id: 'das2', status: 'CREATED' },
    { level: 'AD', source_id: 'ad1', destination_id: 'dad1', status: 'CREATED' },
    { level: 'AD', source_id: 'ad3', destination_id: 'dad3', status: 'CREATED' },
  ]);
  v = await waitAndVerifyScale({ batchId: BID, requiredAdSetIds: ['as1', 'as2'], selectedAdIds: ['ad1', 'ad3'], timeoutMs: 4000, pollMs: 500 });
  ok('C: 2 ad sets + 2 ads all created → ok', v.ok && v.counts.adSetsCreated === 2 && v.counts.adsCreated === 2);
  await cleanup();
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
