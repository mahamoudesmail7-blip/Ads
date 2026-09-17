// Campaign Launch Builder — Phase B (services/amb/launchBuilder.js). Tests
// the state machine, config validation, idempotent job/object/video
// bookkeeping — all against real throwaway DB rows (tagged, cleaned up
// after), zero Meta calls anywhere in this phase.
//   node src/scripts/ambLaunchJobTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const launch = await imp('../services/amb/launchBuilder.js');
const { prisma } = await imp('../prisma.js');

function baseConfig(overrides = {}) {
  return {
    adAccountId: 'act_12345',
    adAccountName: 'Ahmed Samy',
    pageId: '999',
    pageName: 'Trendy Store',
    budgetMode: 'CBO',
    pixelId: 'pix_1',
    pixelName: 'Trendy Store Pixel',
    conversionEvent: 'PURCHASE',
    platforms: ['facebook', 'instagram'],
    adSetsPerCampaign: 2,
    adsPerAdSet: 3,
    campaignCount: 1,
    startMode: 'NOW',
    budget: { cbo: { dailyBudgetMinor: 200000 } },
    campaigns: [{ name: 'Cup - Test 1', websiteUrl: 'https://trendystore.com', primaryText: 'x', headline: 'y' }],
    ...overrides,
  };
}

console.log('§1 State machine — valid/invalid transitions:');
{
  ok('DRAFT -> VALIDATING allowed', launch.canTransitionJobStatus('DRAFT', 'VALIDATING'));
  ok('DRAFT -> PUBLISHING refused (must go through VALIDATING/READY)', !launch.canTransitionJobStatus('DRAFT', 'PUBLISHING'));
  ok('COMPLETE -> anything refused (terminal)', !launch.canTransitionJobStatus('COMPLETE', 'DRAFT') && !launch.canTransitionJobStatus('COMPLETE', 'PUBLISHING'));
  ok('FAILED -> PUBLISHING allowed (retry)', launch.canTransitionJobStatus('FAILED', 'PUBLISHING'));
  ok('FAILED -> COMPLETE refused (retry must go through PUBLISHING, never silently complete)', !launch.canTransitionJobStatus('FAILED', 'COMPLETE'));
  ok('campaign PENDING -> QUEUED allowed', launch.canTransitionCampaignStatus('PENDING', 'QUEUED'));
  ok('campaign COMPLETE -> anything refused', !launch.canTransitionCampaignStatus('COMPLETE', 'PUBLISHING'));
}

console.log('\n§2 validateLaunchConfig — rejects bad input, normalizes good input:');
{
  let threw = false;
  try { launch.validateLaunchConfig({}); } catch (e) { threw = true; ok('missing adAccountId rejected in Arabic', /حساب إعلاني/.test(e.message), e.message); }
  ok('empty config throws', threw);

  threw = false;
  try { launch.validateLaunchConfig(baseConfig({ budgetMode: 'WHATEVER' })); } catch (e) { threw = true; ok('invalid budgetMode rejected', /CBO أو ABO/.test(e.message), e.message); }
  ok('invalid budgetMode throws', threw);

  threw = false;
  try { launch.validateLaunchConfig(baseConfig({ conversionEvent: 'ViewContent' })); } catch (e) { threw = true; ok('casual/invented event spelling rejected, never silently accepted', /حدث التحويل/.test(e.message)); }
  ok('made-up conversion event throws (never invents/accepts an unverified enum)', threw);

  threw = false;
  try { launch.validateLaunchConfig(baseConfig({ campaignCount: 11 })); } catch (e) { threw = true; ok('campaignCount > 10 rejected', /1 و 10/.test(e.message)); }
  ok('campaignCount out of range throws', threw);

  threw = false;
  try { launch.validateLaunchConfig(baseConfig({ campaigns: [{ name: 'x', websiteUrl: 'not-a-url' }] })); } catch (e) { threw = true; ok('invalid URL rejected', /رابط الموقع/.test(e.message)); }
  ok('invalid website URL throws', threw);

  threw = false;
  try { launch.validateLaunchConfig(baseConfig({ pixelId: null })); } catch (e) { threw = true; ok('missing pixel rejected', /Meta Pixel/.test(e.message)); }
  ok('missing pixelId (perCampaignPixel off) throws', threw);

  threw = false;
  try { launch.validateLaunchConfig(baseConfig({ budgetMode: 'ABO', budget: { abo: { adSets: [{ dailyBudgetMinor: 10000 }] } } })); } catch (e) { threw = true; ok('ABO ad-set budget count mismatch rejected', /ميزانية لكل Ad Set/.test(e.message)); }
  ok('ABO with wrong number of per-ad-set budgets throws (adSetsPerCampaign=2 but only 1 given)', threw);

  const v = launch.validateLaunchConfig(baseConfig());
  ok('valid config normalizes cleanly', v.adAccountId === 'act_12345' && v.campaigns.length === 1 && v.campaigns[0].index === 0);
  ok('CTA defaults to ORDER_NOW when not given', v.raw.cta === 'ORDER_NOW');

  const perCampaignPixelCfg = baseConfig({
    perCampaignPixel: true,
    pixelId: null,
    campaignCount: 2,
    campaigns: [
      { name: 'A', websiteUrl: 'https://a.com', pixelId: 'pix_a' },
      { name: 'B', websiteUrl: 'https://b.com', pixelId: 'pix_b' },
    ],
  });
  const v2 = launch.validateLaunchConfig(perCampaignPixelCfg);
  ok('per-campaign pixel mode carries each campaign\'s own pixel, not the job-level one', v2.campaigns[0].pixelId === 'pix_a' && v2.campaigns[1].pixelId === 'pix_b');
}

console.log('\n§3 Real DB — createDraftJob idempotency + child campaign rows:');
{
  const tag = `__test_launch_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job1 = await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaigns: [{ name: `${tag}_c1`, websiteUrl: 'https://trendystore.com' }] }) });
    ok('job created in DRAFT', job1.status === 'DRAFT');
    ok('exactly 1 campaign row created', job1.campaigns.length === 1 && job1.campaigns[0].name === `${tag}_c1`);
    ok('campaign row starts PENDING', job1.campaigns[0].status === 'PENDING');

    // Idempotency — same jobId, even with a DIFFERENT (bogus) input, must return the ORIGINAL job untouched, never re-validate/re-create.
    const job2 = await launch.createDraftJob({ jobId, userId: null, input: {} });
    ok('re-submitting the same jobId returns the SAME job (idempotent, no duplicate, no re-validation)', job2.id === job1.id);
    const campaignRows = await prisma.ambLaunchCampaign.findMany({ where: { job_id: jobId } });
    ok('still exactly 1 campaign row after re-submit, never 2', campaignRows.length === 1);

    const audits = await prisma.ambLaunchAudit.findMany({ where: { job_id: jobId } });
    ok('exactly one JOB_CREATED audit row (not duplicated by the idempotent re-submit)', audits.filter((a) => a.event === 'JOB_CREATED').length === 1);

    const fetched = await launch.getJob(jobId);
    ok('getJob returns campaigns + videos + audits', Array.isArray(fetched.campaigns) && Array.isArray(fetched.videos) && Array.isArray(fetched.audits));

    const listed = await launch.listJobs({ limit: 5 });
    ok('listJobs includes our job', listed.some((j) => j.job_id === jobId));
  } finally {
    await prisma.ambLaunchAudit.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchObjectMap.deleteMany({ where: { campaign: { job_id: jobId } } });
    await prisma.ambLaunchVideoAsset.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchCampaign.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchJob.deleteMany({ where: { job_id: jobId } });
  }
}

console.log('\n§4 cancelJob — allowed from DRAFT, refused once terminal:');
{
  const tag = `__test_launchcancel_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaigns: [{ name: `${tag}_c1`, websiteUrl: 'https://trendystore.com' }] }) });
    const cancelled = await launch.cancelJob(jobId, null);
    ok('cancel from DRAFT succeeds', cancelled.status === 'CANCELLED');
    const camps = await prisma.ambLaunchCampaign.findMany({ where: { job_id: jobId } });
    ok('its PENDING campaign row is also cancelled', camps.every((c) => c.status === 'CANCELLED'));

    let threw = false;
    try { await launch.cancelJob(jobId, null); } catch (e) { threw = true; ok('cancelling an already-CANCELLED job is refused, not silently re-applied', /لا يمكن إلغاء/.test(e.message)); }
    ok('double-cancel throws', threw);
  } finally {
    await prisma.ambLaunchAudit.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchCampaign.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchJob.deleteMany({ where: { job_id: jobId } });
  }
}

console.log('\n§5 Object map — idempotent get-or-create, mark result, audit trail:');
{
  const tag = `__test_launchobj_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job = await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaigns: [{ name: `${tag}_c1`, websiteUrl: 'https://trendystore.com' }] }) });
    const campaignId = job.campaigns[0].id;

    const row1 = await launch.getOrCreateObjectMapRow({ campaignId, level: 'ADSET', localKey: 'adset:0' });
    ok('first call creates a PENDING row', row1.status === 'PENDING');
    const row2 = await launch.getOrCreateObjectMapRow({ campaignId, level: 'ADSET', localKey: 'adset:0' });
    ok('second call with the same local_key returns the SAME row (idempotent, never a duplicate)', row2.id === row1.id);
    const allRows = await prisma.ambLaunchObjectMap.findMany({ where: { campaign_id: campaignId, level: 'ADSET', local_key: 'adset:0' } });
    ok('exactly one row exists in the DB for this (campaign, level, local_key)', allRows.length === 1);

    await launch.markObjectResult({ campaignId, level: 'ADSET', localKey: 'adset:0', destinationId: '120999888', status: 'CREATED' });
    const updated = await prisma.ambLaunchObjectMap.findUnique({ where: { campaign_id_level_local_key: { campaign_id: campaignId, level: 'ADSET', local_key: 'adset:0' } } });
    ok('markObjectResult sets destination_id and status', updated.destination_id === '120999888' && updated.status === 'CREATED');

    const audits = await prisma.ambLaunchAudit.findMany({ where: { job_id: jobId, event: 'OBJECT_CREATED' } });
    ok('an OBJECT_CREATED audit row was written', audits.length === 1 && audits[0].destination_id === '120999888');

    await launch.getOrCreateObjectMapRow({ campaignId, level: 'AD', localKey: 'ad:0:0', parentLocalKey: 'adset:0' });
    await launch.markObjectResult({ campaignId, level: 'AD', localKey: 'ad:0:0', destinationId: null, status: 'FAILED', error: 'transient network error' });
    const failedRow = await prisma.ambLaunchObjectMap.findUnique({ where: { campaign_id_level_local_key: { campaign_id: campaignId, level: 'AD', local_key: 'ad:0:0' } } });
    ok('a FAILED object keeps its error message and parent_local_key link', failedRow.status === 'FAILED' && failedRow.error === 'transient network error' && failedRow.parent_local_key === 'adset:0');

    let updateThrew = false;
    try { await launch.markObjectResult({ campaignId, level: 'CREATIVE', localKey: 'never-registered', status: 'CREATED' }); } catch { updateThrew = true; }
    ok('marking a result for a local_key that was never registered via getOrCreateObjectMapRow throws, rather than silently fabricating a row', updateThrew);
  } finally {
    await prisma.ambLaunchAudit.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchObjectMap.deleteMany({ where: { campaign: { job_id: jobId } } });
    await prisma.ambLaunchCampaign.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchJob.deleteMany({ where: { job_id: jobId } });
  }
}

console.log('\n§6 Video slots — idempotent registration + duplicate-content detection:');
{
  const tag = `__test_launchvid_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaigns: [{ name: `${tag}_c1`, websiteUrl: 'https://trendystore.com' }] }) });

    const { row: v1, duplicateOfSlotKey: dup1 } = await launch.registerVideoSlot({ jobId, slotKey: 'C1', originalFilename: 'cup-black.mp4', contentHash: 'hash-A', sizeBytes: 123, durationSeconds: 12.5 });
    ok('first video slot registered PENDING', v1.status === 'PENDING');
    ok('no duplicate flagged yet (only one file so far)', dup1 === null);
    ok('client-probed duration is actually persisted (Phase E fix — was silently dropped before)', v1.duration_seconds === 12.5, String(v1.duration_seconds));

    const { row: v1again } = await launch.registerVideoSlot({ jobId, slotKey: 'C1', originalFilename: 'cup-black.mp4', contentHash: 'hash-A', sizeBytes: 123 });
    ok('re-registering the same slot_key is idempotent (same row, not a new one)', v1again.id === v1.id);

    const { row: v2, duplicateOfSlotKey: dup2 } = await launch.registerVideoSlot({ jobId, slotKey: 'C2', originalFilename: 'cup-black-copy.mp4', contentHash: 'hash-A', sizeBytes: 123 });
    ok('a second slot with the SAME content hash is flagged as a duplicate of C1', dup2 === 'C1');
    ok('but still gets its own row (duplicate detection is informational, not a hard block)', v2.slot_key === 'C2');

    await launch.markVideoResult({ jobId, slotKey: 'C1', status: 'UPLOADED', metaVideoId: 'vid_999' });
    const updated = await prisma.ambLaunchVideoAsset.findUnique({ where: { job_id_slot_key: { job_id: jobId, slot_key: 'C1' } } });
    ok('markVideoResult sets meta_video_id + status', updated.status === 'UPLOADED' && updated.meta_video_id === 'vid_999');

    const allVideos = await prisma.ambLaunchVideoAsset.findMany({ where: { job_id: jobId } });
    ok('exactly 2 distinct video rows exist for this job', allVideos.length === 2);
  } finally {
    await prisma.ambLaunchAudit.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchVideoAsset.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchCampaign.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchJob.deleteMany({ where: { job_id: jobId } });
  }
}

console.log('\n§7 Phase C discovery — connection-required guard + input validation (offline, no real Meta call reached):');
{
  const origFindUnique = prisma.metaConnection.findUnique;
  prisma.metaConnection.findUnique = async () => null; // simulate DISCONNECTED
  try {
    let threw = false;
    try { await launch.discoverLaunchAdAccounts(); } catch (e) { threw = true; ok('discoverLaunchAdAccounts refuses when not connected, in Arabic, before touching Meta', /اربط حساب/.test(e.message), e.message); }
    ok('discoverLaunchAdAccounts throws when disconnected', threw);

    threw = false;
    try { await launch.getLaunchAccountAssets('act_123'); } catch (e) { threw = true; ok('getLaunchAccountAssets refuses when not connected', /اربط حساب/.test(e.message)); }
    ok('getLaunchAccountAssets throws when disconnected', threw);

    threw = false;
    try { await launch.getLaunchAccountAssets(); } catch (e) { threw = true; ok('missing adAccountId rejected before even checking the connection', /adAccountId/.test(e.message)); }
    ok('getLaunchAccountAssets with no adAccountId throws', threw);
  } finally {
    prisma.metaConnection.findUnique = origFindUnique;
  }
}

console.log('\n§8 Phase E foundation — startLaunchJob shell + createDraftJob finalizing it later:');
{
  const tag = `__test_launchshell_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const shell1 = await launch.startLaunchJob({ jobId, userId: null, adAccountId: 'act_shell', adAccountName: 'Shell Account' });
    ok('startLaunchJob creates a bare shell in DRAFT with zero campaigns', shell1.status === 'DRAFT' && shell1.ad_account_id === 'act_shell');

    const shell2 = await launch.startLaunchJob({ jobId, userId: null, adAccountId: 'act_DIFFERENT', adAccountName: 'x' });
    ok('startLaunchJob is idempotent — same jobId returns the SAME shell untouched, even with different input', shell2.id === shell1.id && shell2.ad_account_id === 'act_shell');

    const rowsBeforeFinalize = await prisma.ambLaunchCampaign.count({ where: { job_id: jobId } });
    ok('shell has zero campaign rows before finalizing', rowsBeforeFinalize === 0);

    const finalized = await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ adAccountId: 'act_shell', campaigns: [{ name: `${tag}_final`, websiteUrl: 'https://trendystore.com' }] }) });
    ok('createDraftJob finalizes the existing shell (same job_id, now has real config)', finalized.job_id === jobId && finalized.pixel_id === 'pix_1');
    ok('finalizing creates the real campaign row(s)', finalized.campaigns.length === 1 && finalized.campaigns[0].name === `${tag}_final`);

    const again = await launch.createDraftJob({ jobId, userId: null, input: {} });
    ok('calling createDraftJob again on an already-finalized job is idempotent — returns as-is, never re-validates (would have thrown on empty input otherwise)', again.id === finalized.id);
    const campaignsAfterSecondCall = await prisma.ambLaunchCampaign.count({ where: { job_id: jobId } });
    ok('still exactly 1 campaign row — finalizing twice never duplicates', campaignsAfterSecondCall === 1);
  } finally {
    await prisma.ambLaunchAudit.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchCampaign.deleteMany({ where: { job_id: jobId } });
    await prisma.ambLaunchJob.deleteMany({ where: { job_id: jobId } });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
