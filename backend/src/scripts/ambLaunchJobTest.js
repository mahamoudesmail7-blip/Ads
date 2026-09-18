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
    instagramId: '17841400000000000',
    instagramUsername: 'trendy.store',
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
    const listedJob = listed.find((j) => j.job_id === jobId);
    ok('listJobs includes our job', !!listedJob);
    ok('listJobs enriches each campaign with name/status/human_action_required — the "الحملات السابقة" history panel needs these for a real summary without a second round-trip', listedJob?.campaigns[0]?.name === `${tag}_c1` && listedJob?.campaigns[0]?.status === 'PENDING' && listedJob?.campaigns[0]?.human_action_required === false);
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

console.log('\n§9 localWallClockToUtcDate — real IANA-timezone-aware conversion, no hardcoded offset:');
{
  // Africa/Cairo: UTC+3 year-round, no DST — confirmed live via Meta's own
  // timezone_offset_hours_utc on the real connected ad account.
  const cairoMidnight = launch.localWallClockToUtcDate('2026-09-18', '00:00', 'Africa/Cairo');
  ok('18 Sep 2026 00:00 Cairo -> 17 Sep 2026 21:00 UTC (the exact real production bug scenario)', cairoMidnight.toISOString() === '2026-09-17T21:00:00.000Z', cairoMidnight?.toISOString());

  // A real DST-observing zone in summer (EDT = UTC-4) vs winter (EST = UTC-5) — proves this
  // is a genuine timezone-database-aware conversion, not a fixed offset baked into the code.
  const nySummer = launch.localWallClockToUtcDate('2026-07-01', '09:00', 'America/New_York');
  ok('1 Jul 2026 09:00 New York (EDT, UTC-4 in summer) -> 13:00 UTC', nySummer.toISOString() === '2026-07-01T13:00:00.000Z', nySummer?.toISOString());
  const nyWinter = launch.localWallClockToUtcDate('2026-01-15', '09:00', 'America/New_York');
  ok('15 Jan 2026 09:00 New York (EST, UTC-5 in winter) -> 14:00 UTC — same local wall-clock time, DIFFERENT UTC offset than summer', nyWinter.toISOString() === '2026-01-15T14:00:00.000Z', nyWinter?.toISOString());

  // A southern-hemisphere DST zone (opposite season pattern) — Sydney is UTC+11 in its summer (Jan), UTC+10 in its winter (Jul).
  const sydneyJan = launch.localWallClockToUtcDate('2026-01-15', '10:00', 'Australia/Sydney');
  ok('15 Jan 2026 10:00 Sydney (AEDT, UTC+11) -> 23:00 UTC (14 Jan)', sydneyJan.toISOString() === '2026-01-14T23:00:00.000Z', sydneyJan?.toISOString());
  const sydneyJul = launch.localWallClockToUtcDate('2026-07-15', '10:00', 'Australia/Sydney');
  ok('15 Jul 2026 10:00 Sydney (AEST, UTC+10) -> 00:00 UTC same day', sydneyJul.toISOString() === '2026-07-15T00:00:00.000Z', sydneyJul?.toISOString());

  ok('an unrecognized timezone name returns null rather than guessing an offset', launch.localWallClockToUtcDate('2026-09-18', '00:00', 'Not/A_Real_Zone') === null);
  ok('missing date returns null', launch.localWallClockToUtcDate(null, '00:00', 'Africa/Cairo') === null);
}

console.log('\n§10 validateLaunchConfig — authoritative server-side schedule + Instagram-identity validation:');
{
  const withSchedule = (overrides = {}) => baseConfig({ startMode: 'SCHEDULED', startDate: '2026-09-18', startTime: '00:00', timezone: 'Africa/Cairo', ...overrides });

  const v = launch.validateLaunchConfig(withSchedule());
  ok('SCHEDULED with startDate/startTime/timezone computes the exact real UTC instant server-side', v.startAt.toISOString() === '2026-09-17T21:00:00.000Z', v.startAt?.toISOString());

  let threw = false;
  try { launch.validateLaunchConfig(withSchedule({ timezone: 'Nonexistent/Zone' })); } catch (e) { threw = true; ok('an invalid ad-account timezone name is rejected, never silently defaulted', /منطقة توقيت/.test(e.message)); }
  ok('unrecognized timezone throws', threw);

  threw = false;
  try { launch.validateLaunchConfig(baseConfig({ startMode: 'SCHEDULED' })); } catch (e) { threw = true; ok('SCHEDULED with no date/time/legacy startAt at all is rejected', /تاريخ ووقت بدء/.test(e.message)); }
  ok('missing schedule input throws', threw);

  // Backward-compat path: an already-computed ISO instant (older/internal callers) still works.
  const vLegacy = launch.validateLaunchConfig(baseConfig({ startMode: 'SCHEDULED', startAt: '2026-09-17T21:00:00.000Z' }));
  ok('legacy pre-computed startAt ISO string still accepted', vLegacy.startAt.toISOString() === '2026-09-17T21:00:00.000Z');

  threw = false;
  try { launch.validateLaunchConfig(baseConfig({ platforms: ['facebook', 'instagram'], instagramId: null })); } catch (e) { threw = true; ok('Instagram selected with no resolved identity is rejected — never silently falls back to Facebook-only', /حساب إنستجرام حقيقي/.test(e.message)); }
  ok('Instagram-without-identity throws (the real production bug this fixes)', threw);

  const vIg = launch.validateLaunchConfig(baseConfig({ platforms: ['facebook', 'instagram'], instagramId: '17841400000000000', instagramUsername: 'trendy.store' }));
  ok('Instagram selected WITH a real identity passes and is carried through', vIg.instagramId === '17841400000000000');
}

console.log('\n§11 "➕ إنشاء كامبين جديد" — a brand-new job never touches a previous COMPLETE job\'s rows:');
{
  // Simulates the real scenario: Job A already reached COMPLETE (both its
  // campaigns COMPLETE), then the user starts a completely independent Job
  // B. Proves B gets its own distinct job_id/campaign rows and A's rows —
  // including its terminal COMPLETE status — are byte-for-byte unchanged.
  const tagA = `__test_jobA_${Date.now()}__`;
  const jobIdA = `test-${tagA}`;
  const tagB = `__test_jobB_${Date.now()}__`;
  const jobIdB = `test-${tagB}`;
  try {
    const jobA = await launch.createDraftJob({ jobId: jobIdA, userId: null, input: baseConfig({ campaignCount: 1, campaigns: [{ name: `${tagA}_c1`, websiteUrl: 'https://trendystore.com' }] }) });
    await prisma.ambLaunchCampaign.update({ where: { id: jobA.campaigns[0].id }, data: { status: 'COMPLETE', meta_campaign_id: 'meta_A_1' } });
    await prisma.ambLaunchJob.update({ where: { job_id: jobIdA }, data: { status: 'COMPLETE' } });
    const jobASnapshotBefore = await launch.getJob(jobIdA);

    // "New Campaign" never reuses jobIdA and never appends to it — a completely fresh id/config.
    const jobB = await launch.createDraftJob({ jobId: jobIdB, userId: null, input: baseConfig({ campaignCount: 1, campaigns: [{ name: `${tagB}_c1`, websiteUrl: 'https://another-store.com' }], adAccountId: 'act_different' }) });
    ok('Job B gets a genuinely different job_id, never A\'s', jobB.job_id !== jobA.job_id && jobB.job_id === jobIdB);
    ok('Job B starts in its own fresh DRAFT status, independent of A', jobB.status === 'DRAFT');
    ok('Job B has exactly its own 1 campaign row, never appended to A\'s', jobB.campaigns.length === 1 && jobB.campaigns[0].name === `${tagB}_c1`);

    const jobAAfter = await launch.getJob(jobIdA);
    ok('Job A\'s status is completely untouched by creating Job B', jobAAfter.status === 'COMPLETE');
    ok('Job A\'s campaign is still COMPLETE with its real meta_campaign_id intact', jobAAfter.campaigns[0].status === 'COMPLETE' && jobAAfter.campaigns[0].meta_campaign_id === 'meta_A_1');
    ok('Job A still has exactly 1 campaign — nothing from B leaked into it', jobAAfter.campaigns.length === 1);
    ok('Job A remains fully readable/viewable ("الحملات السابقة") after B exists', JSON.stringify(jobAAfter) === JSON.stringify(jobASnapshotBefore));

    const listed = await launch.listJobs({ limit: 50 });
    ok('both A and B independently appear in listJobs (the history panel source)', listed.some((j) => j.job_id === jobIdA) && listed.some((j) => j.job_id === jobIdB));
  } finally {
    for (const jobId of [jobIdA, jobIdB]) {
      await prisma.ambLaunchAudit.deleteMany({ where: { job_id: jobId } });
      await prisma.ambLaunchObjectMap.deleteMany({ where: { campaign: { job_id: jobId } } });
      await prisma.ambLaunchVideoAsset.deleteMany({ where: { job_id: jobId } });
      await prisma.ambLaunchCampaign.deleteMany({ where: { job_id: jobId } });
      await prisma.ambLaunchJob.deleteMany({ where: { job_id: jobId } });
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
