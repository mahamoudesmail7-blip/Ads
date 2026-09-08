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

// ---------------------------------------------------------------------------
// ABO slot synthesis — the exact logic from cloneJob (§4/§5/§15). Keys must be
// "<sourceId>#<slotIndex>" so replicated ads/ad sets are distinct object rows.
// ---------------------------------------------------------------------------
function synthAboTree(sourceAdsets, sourceAds, slotPlan) {
  const asById = new Map(sourceAdsets.map((a) => [String(a.id), a]));
  const adById = new Map(sourceAds.map((a) => [String(a.id), a]));
  const synthAdsets = [];
  const synthAds = [];
  slotPlan.forEach((slot, i) => {
    const realAs = asById.get(String(slot.sourceAdSetId));
    if (!realAs) return;
    synthAdsets.push({ ...realAs, id: `${slot.sourceAdSetId}#${i}`, __slotDailyBudgetMinor: Math.round(Number(slot.dailyBudgetMinor) || 0) });
    for (const rawAdId of slot.ads || []) {
      const realAd = adById.get(String(rawAdId));
      if (!realAd) continue;
      synthAds.push({ ...realAd, id: `${rawAdId}#${i}`, adset_id: `${slot.sourceAdSetId}#${i}` });
    }
  });
  return { synthAdsets, synthAds };
}

console.log('\nABO slot synthesis:');
{
  const sAdsets = [{ id: 'as1', name: 'A' }, { id: 'as2', name: 'B' }];
  const sAds = [{ id: 'A', adset_id: 'as1', creative: { id: 'crA' } }, { id: 'B', adset_id: 'as1', creative: { id: 'crB' } }];

  // D) 1 configured ad set, 1 ad → 1 / 1 / 1
  let t = synthAboTree(sAdsets, sAds, [{ sourceAdSetId: 'as1', dailyBudgetMinor: 30000, ads: ['A'] }]);
  ok('D: 1 slot / 1 ad → 1 ad set, 1 ad', t.synthAdsets.length === 1 && t.synthAds.length === 1 && t.synthAdsets[0].id === 'as1#0' && t.synthAds[0].id === 'A#0' && t.synthAds[0].adset_id === 'as1#0' && t.synthAdsets[0].__slotDailyBudgetMinor === 30000);

  // E) 3 slots, one unique ad each → 3 / 3
  t = synthAboTree(sAdsets, sAds, [
    { sourceAdSetId: 'as1', dailyBudgetMinor: 30000, ads: ['A'] },
    { sourceAdSetId: 'as1', dailyBudgetMinor: 50000, ads: ['B'] },
    { sourceAdSetId: 'as1', dailyBudgetMinor: 70000, ads: ['A'] },
  ]);
  ok('E: 3 slots / 1 ad each → 3 ad sets, 3 ads', t.synthAdsets.length === 3 && t.synthAds.length === 3 && new Set(t.synthAdsets.map((x) => x.id)).size === 3 && new Set(t.synthAds.map((x) => x.id)).size === 3);

  // F) same source ad in all 3 slots → 3 ad sets, 3 ad INSTANCES (distinct keys)
  t = synthAboTree(sAdsets, sAds, [
    { sourceAdSetId: 'as1', dailyBudgetMinor: 30000, ads: ['A'] },
    { sourceAdSetId: 'as1', dailyBudgetMinor: 30000, ads: ['A'] },
    { sourceAdSetId: 'as1', dailyBudgetMinor: 30000, ads: ['A'] },
  ]);
  ok('F: same ad × 3 slots → 3 ad sets, 3 distinct ad instances', t.synthAds.length === 3 && new Set(t.synthAds.map((x) => x.id)).size === 3 && t.synthAds.map((x) => x.id).sort().join(',') === 'A#0,A#1,A#2');

  // G) Ad Set 1 = A+B, Ad Set 2 = A → 2 ad sets, 3 instances
  t = synthAboTree(sAdsets, sAds, [
    { sourceAdSetId: 'as1', dailyBudgetMinor: 30000, ads: ['A', 'B'] },
    { sourceAdSetId: 'as1', dailyBudgetMinor: 50000, ads: ['A'] },
  ]);
  ok('G: [A,B] + [A] → 2 ad sets, 3 ad instances', t.synthAdsets.length === 2 && t.synthAds.length === 3 && t.synthAds.map((x) => x.id).sort().join(',') === 'A#0,A#1,B#0' && t.synthAds.filter((x) => x.adset_id === 'as1#0').length === 2 && t.synthAds.filter((x) => x.adset_id === 'as1#1').length === 1);
}

// ---------------------------------------------------------------------------
// waitAndVerifyScale with ABO instance keys (§14).
// ---------------------------------------------------------------------------
console.log('\nwaitAndVerifyScale — ABO instance keys:');
try {
  await cleanup();

  // G-shape complete: ADSET as1#0, as1#1 ; AD A#0, B#0, A#1
  await seed([
    { level: 'CAMPAIGN', source_id: 'c1', destination_id: 'dc1', status: 'CREATED' },
    { level: 'ADSET', source_id: 'as1#0', destination_id: 'das0', status: 'CREATED' },
    { level: 'ADSET', source_id: 'as1#1', destination_id: 'das1', status: 'CREATED' },
    { level: 'AD', source_id: 'A#0', destination_id: 'da0', status: 'CREATED' },
    { level: 'AD', source_id: 'B#0', destination_id: 'db0', status: 'CREATED' },
    { level: 'AD', source_id: 'A#1', destination_id: 'da1', status: 'CREATED' },
  ]);
  let v = await waitAndVerifyScale({
    batchId: BID,
    expectedAdSetSourceIds: ['as1#0', 'as1#1'],
    expectedAdSourceIds: ['A#0', 'B#0', 'A#1'],
    timeoutMs: 4000, pollMs: 500,
  });
  ok('ABO G complete → ok, 2 ad sets, 3 ad instances', v.ok && v.counts.adSetsCreated === 2 && v.counts.adsCreated === 3);
  await cleanup();

  // H) one ABO ad set fails → NOT ok
  await seed([
    { level: 'CAMPAIGN', source_id: 'c1', destination_id: 'dc1', status: 'CREATED' },
    { level: 'ADSET', source_id: 'as1#0', destination_id: 'das0', status: 'CREATED' },
    { level: 'ADSET', source_id: 'as1#1', destination_id: null, status: 'FAILED', error: 'targeting invalid' },
    { level: 'AD', source_id: 'A#0', destination_id: 'da0', status: 'CREATED' },
  ]);
  await prisma.ambCloneJob.updateMany({ where: { batch_id: BID }, data: { status: 'FAILED' } });
  v = await waitAndVerifyScale({ batchId: BID, expectedAdSetSourceIds: ['as1#0', 'as1#1'], expectedAdSourceIds: ['A#0', 'A#1'], timeoutMs: 4000, pollMs: 500 });
  ok('H: one ABO ad set fails → NOT ok, real error', !v.ok && /targeting invalid/.test(v.error), v.error);
  await cleanup();

  // I) one ABO ad instance fails → NOT ok
  await seed([
    { level: 'CAMPAIGN', source_id: 'c1', destination_id: 'dc1', status: 'CREATED' },
    { level: 'ADSET', source_id: 'as1#0', destination_id: 'das0', status: 'CREATED' },
    { level: 'AD', source_id: 'A#0', destination_id: 'da0', status: 'CREATED' },
    { level: 'AD', source_id: 'A#1', destination_id: null, status: 'FAILED', error: 'ad create failed' },
  ]);
  await prisma.ambCloneJob.updateMany({ where: { batch_id: BID }, data: { status: 'FAILED' } });
  v = await waitAndVerifyScale({ batchId: BID, expectedAdSetSourceIds: ['as1#0'], expectedAdSourceIds: ['A#0', 'A#1'], timeoutMs: 4000, pollMs: 500 });
  ok('I: one ABO ad instance fails → NOT ok', !v.ok && /ad create failed/.test(v.error), v.error);
  await cleanup();

  // K) resume: existing campaign + as1#0/A#0 already CREATED, as1#1/A#1 missing then created
  const job = await seed([
    { level: 'CAMPAIGN', source_id: 'c1', destination_id: 'dc1', status: 'CREATED' },
    { level: 'ADSET', source_id: 'as1#0', destination_id: 'das0', status: 'CREATED' },
    { level: 'AD', source_id: 'A#0', destination_id: 'da0', status: 'CREATED' },
  ]);
  v = await waitAndVerifyScale({ batchId: BID, expectedAdSetSourceIds: ['as1#0', 'as1#1'], expectedAdSourceIds: ['A#0', 'A#1'], timeoutMs: 3000, pollMs: 500 });
  ok('K1: partial ABO → NOT ok (missing as1#1 / A#1)', !v.ok && v.counts.adSetsCreated === 1);
  // "resume" creates the missing instances against the SAME job (no new campaign row)
  await prisma.ambCloneObjectMap.create({ data: { job_id: job.id, batch_id: BID, level: 'ADSET', source_id: 'as1#1', destination_id: 'das1', status: 'CREATED' } });
  await prisma.ambCloneObjectMap.create({ data: { job_id: job.id, batch_id: BID, level: 'AD', source_id: 'A#1', destination_id: 'da1', status: 'CREATED' } });
  const campRows = await prisma.ambCloneObjectMap.count({ where: { batch_id: BID, level: 'CAMPAIGN' } });
  v = await waitAndVerifyScale({ batchId: BID, expectedAdSetSourceIds: ['as1#0', 'as1#1'], expectedAdSourceIds: ['A#0', 'A#1'], timeoutMs: 3000, pollMs: 500 });
  ok('K2: after resume → ok, 2 ad sets, 2 ads, still ONE campaign row', v.ok && v.counts.adSetsCreated === 2 && v.counts.adsCreated === 2 && campRows === 1);
  await cleanup();
} finally {
  await cleanup();
}

// ---------------------------------------------------------------------------
// executeScale — reject invalid inputs BEFORE any Meta write (§11 / §J).
// ---------------------------------------------------------------------------
console.log('\nexecuteScale rejects (no Meta writes):');
{
  const { executeScale } = await import('../services/amb/scaleWinners.js');
  const rows0 = await prisma.ambScaleDecision.count();
  const cases = [
    ['no budgetMode', { sourceCampaignId: 'x', selectedAdIds: ['a'], campaignBudgetEgp: 100 }],
    ['bad budgetMode', { sourceCampaignId: 'x', budgetMode: 'FOO', selectedAdIds: ['a'], campaignBudgetEgp: 100 }],
    ['CBO no ads', { sourceCampaignId: 'x', budgetMode: 'CBO', selectedAdIds: [], campaignBudgetEgp: 100 }],
    ['CBO zero budget', { sourceCampaignId: 'x', budgetMode: 'CBO', selectedAdIds: ['a'], campaignBudgetEgp: 0 }],
    ['ABO no slots', { sourceCampaignId: 'x', budgetMode: 'ABO', adSets: [] }],
    ['ABO slot zero budget', { sourceCampaignId: 'x', budgetMode: 'ABO', adSets: [{ dailyBudgetEgp: 0, selectedAdIds: ['a'] }] }],
    ['ABO slot no ads', { sourceCampaignId: 'x', budgetMode: 'ABO', adSets: [{ dailyBudgetEgp: 300, selectedAdIds: [] }] }],
    ['schedule in the past', { sourceCampaignId: 'x', budgetMode: 'CBO', selectedAdIds: ['a'], campaignBudgetEgp: 100, startMode: 'SCHEDULE', startAt: '2020-01-01T10:00' }],
  ];
  for (const [name, args] of cases) {
    try { await executeScale({ ...args, windowName: 'today', userId: null }); ok(name + ' → rejected', false, 'did NOT throw'); }
    catch (e) { ok(name + ' → rejected', !!e.message, e.message.slice(0, 70)); }
  }
  const rows1 = await prisma.ambScaleDecision.count();
  ok('no AmbScaleDecision rows leaked by rejected inputs', rows1 === rows0, `${rows0} -> ${rows1}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
