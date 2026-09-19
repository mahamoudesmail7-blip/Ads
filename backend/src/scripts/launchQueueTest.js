// Campaign Launch Builder — Phase G bulk publish queue
// (services/amb/launchPublish.js: startLaunchQueue / getQueueProgress /
// runDueLaunchQueueTick). Real throwaway DB rows (tagged, cleaned up after),
// following the exact convention ambLaunchJobTest.js already established.
// Deliberately never exercises the actual Meta-object-creation loop inside
// publishCampaignFull — that requires a real connected Meta account and was
// already proven live during Phase F/G's own controlled test; this file
// covers everything AROUND it that's safe to verify offline: server-side
// re-validation before a job is ever allowed into PUBLISHING, idempotency
// of the start/resume entry point, live progress counts, and the durable
// 5-minute inter-campaign gate + job-level completion detection in the
// scheduler tick — the two tick code paths that never need to touch Meta.
//   node src/scripts/launchQueueTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const launch = await imp('../services/amb/launchBuilder.js');
const publish = await imp('../services/amb/launchPublish.js');
const { prisma } = await imp('../prisma.js');

// approved_by_id is a real FK to users — use an actual existing user (any
// one will do, this never touches their data) rather than a fabricated id.
const realUser = await prisma.user.findFirst({ select: { id: true } });
const realUserId = realUser?.id ?? null;

function baseConfig(overrides = {}) {
  return {
    adAccountId: 'act_queue_test',
    adAccountName: 'Ahmed Samy',
    pageId: '999',
    pageName: 'Trendy Store',
    budgetMode: 'ABO',
    pixelId: 'pix_1',
    pixelName: 'Trendy Store Pixel',
    conversionEvent: 'PURCHASE',
    platforms: ['facebook'],
    adSetsPerCampaign: 2,
    adsPerAdSet: 3,
    campaignCount: 2,
    startMode: 'NOW',
    budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }, { dailyBudgetMinor: 20000 }] } },
    campaigns: [
      { name: 'Q Test 1', websiteUrl: 'https://trendystore.com' },
      { name: 'Q Test 2', websiteUrl: 'https://trendystore.com' },
    ],
    ...overrides,
  };
}

async function cleanup(jobId) {
  await prisma.ambLaunchAudit.deleteMany({ where: { job_id: jobId } });
  await prisma.ambLaunchObjectMap.deleteMany({ where: { campaign: { job_id: jobId } } });
  await prisma.ambLaunchVideoAsset.deleteMany({ where: { job_id: jobId } });
  await prisma.ambLaunchCampaign.deleteMany({ where: { job_id: jobId } });
  await prisma.ambLaunchJob.deleteMany({ where: { job_id: jobId } });
}

console.log('§1 startLaunchQueue — server-side re-validation, never trusts the DB row blindly:');
{
  const tag = `__test_queue1_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    await launch.createDraftJob({ jobId, userId: null, input: baseConfig() });

    let threw = false;
    try { await publish.startLaunchQueue({ jobId, userId: null }); } catch (e) { threw = true; ok('rejects with no uploaded video yet', /فيديو/.test(e.message), e.message); }
    ok('startLaunchQueue throws when zero videos are UPLOADED', threw);

    await prisma.ambLaunchVideoAsset.create({ data: { job_id: jobId, slot_key: 'C1', original_filename: 'v.mp4', status: 'UPLOADED', meta_video_id: 'vid_1' } });

    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { page_id: null } });
    threw = false;
    try { await publish.startLaunchQueue({ jobId, userId: null }); } catch (e) { threw = true; ok('rejects with no Facebook Page even though the video is ready', /Facebook Page/.test(e.message), e.message); }
    ok('startLaunchQueue throws when page_id is missing', threw);
    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { page_id: '999' } });

    // Simulate a corrupted/drifted config_json (one ad set's budget silently missing) — proves
    // startLaunchQueue independently re-checks the real persisted config rather than trusting
    // that createDraftJob's earlier validation still holds true forever.
    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { config_json: JSON.stringify({ budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }] } } }) } });
    threw = false;
    try { await publish.startLaunchQueue({ jobId, userId: null }); } catch (e) { threw = true; ok('rejects a drifted ABO budget config missing an ad set\'s amount', /ميزانية صحيحة لكل Ad Set/.test(e.message), e.message); }
    ok('startLaunchQueue throws on a config_json/ad_sets_per_campaign mismatch', threw);
    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { config_json: JSON.stringify({ budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }, { dailyBudgetMinor: 20000 }] } } }) } });

    // Confirmed live against real Meta: a SCHEDULED start_time already in the
    // past is never honored (Meta substitutes the creation moment instead) —
    // block publish rather than silently letting the schedule drift.
    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { start_mode: 'SCHEDULED', start_at: new Date(Date.now() - 60_000) } });
    threw = false;
    try { await publish.startLaunchQueue({ jobId, userId: null }); } catch (e) { threw = true; ok('rejects a SCHEDULED start already in the past — Meta itself would silently substitute "now"', /الموعد المطلوب فات/.test(e.message), e.message); }
    ok('startLaunchQueue throws on an already-elapsed schedule', threw);
    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { start_mode: 'NOW', start_at: null } });

    const started = await publish.startLaunchQueue({ jobId, userId: realUserId });
    ok('a fully valid job is accepted and flipped to PUBLISHING', started.status === 'PUBLISHING');
    ok('approved_by_id is stamped from the real actor, never left null', started.approved_by_id === realUserId, String(started.approved_by_id));
    ok('approved_at is stamped', started.approved_at instanceof Date);
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§2 startLaunchQueue — idempotent: a double-click never restarts or re-stamps an already-running job:');
{
  const tag = `__test_queue2_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaignCount: 1, campaigns: [{ name: 'Q Solo', websiteUrl: 'https://trendystore.com' }], adSetsPerCampaign: 1, budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }] } } }) });
    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { page_id: '999' } });
    await prisma.ambLaunchVideoAsset.create({ data: { job_id: jobId, slot_key: 'C1', original_filename: 'v.mp4', status: 'UPLOADED', meta_video_id: 'vid_1' } });

    const first = await publish.startLaunchQueue({ jobId, userId: realUserId });
    ok('first call starts the queue', first.status === 'PUBLISHING');

    const second = await publish.startLaunchQueue({ jobId, userId: null });
    ok('a second call (double-click, different/absent actor even) is a pure no-op — same approved_by_id preserved, never overwritten', second.approved_by_id === realUserId, String(second.approved_by_id));

    const audits = await prisma.ambLaunchAudit.findMany({ where: { job_id: jobId, event: 'PUBLISH_APPROVED' } });
    ok('exactly one PUBLISH_APPROVED audit row, never duplicated by the repeated call', audits.length === 1);

    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { status: 'COMPLETE' } });
    const afterComplete = await publish.startLaunchQueue({ jobId, userId: realUserId });
    ok('calling it again once the job is already COMPLETE is also a safe no-op', afterComplete.status === 'COMPLETE');
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§3 getQueueProgress — real counts computed fresh from amb_launch_object_map:');
{
  const tag = `__test_queue3_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job = await launch.createDraftJob({ jobId, userId: null, input: baseConfig() });
    const [c0, c1] = job.campaigns;

    // Simulate campaign 0 partially built: 1 of 2 ad sets, 2 of 6 ads.
    await launch.getOrCreateObjectMapRow({ campaignId: c0.id, level: 'ADSET', localKey: 'adset:0' });
    await launch.markObjectResult({ campaignId: c0.id, level: 'ADSET', localKey: 'adset:0', destinationId: 'as_0', status: 'CREATED' });
    for (const localKey of ['ad:0:0', 'ad:0:1']) {
      await launch.getOrCreateObjectMapRow({ campaignId: c0.id, level: 'AD', localKey, parentLocalKey: 'adset:0' });
      await launch.markObjectResult({ campaignId: c0.id, level: 'AD', localKey, destinationId: `ad_${localKey}`, status: 'CREATED' });
    }
    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { status: 'ADSETS_CREATED', meta_campaign_id: 'meta_c0' } });

    const progress = await publish.getQueueProgress(jobId);
    ok('progress found for the job', progress && progress.jobId === jobId);
    ok('campaign 0 shows 1/2 ad sets created', progress.campaigns[0].adSetsCreated === 1 && progress.campaigns[0].adSetsTotal === 2);
    ok('campaign 0 shows 2/6 ads created (adSetsPerCampaign x adsPerAdSet)', progress.campaigns[0].adsCreated === 2 && progress.campaigns[0].adsTotal === 6);
    ok('campaign 0 status reflects its real DB status', progress.campaigns[0].status === 'ADSETS_CREATED');
    ok('campaign 0 carries its real meta_campaign_id', progress.campaigns[0].metaCampaignId === 'meta_c0');
    ok('campaign 1 (untouched) shows 0/2 ad sets and 0/6 ads', progress.campaigns[1].adSetsCreated === 0 && progress.campaigns[1].adsCreated === 0);

    ok('getQueueProgress returns null for a job that does not exist, never throws', await publish.getQueueProgress('does-not-exist') === null);
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§4 runDueLaunchQueueTick — the durable 5-minute gate genuinely blocks the next campaign:');
{
  const tag = `__test_queue4_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job = await launch.createDraftJob({ jobId, userId: null, input: baseConfig() });
    const [c0, c1] = job.campaigns;
    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { status: 'COMPLETE', meta_campaign_id: 'meta_c0' } });
    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { status: 'PUBLISHING', next_campaign_at: new Date(Date.now() + 10 * 60 * 1000) } });

    await publish.runDueLaunchQueueTick();

    const c1After = await prisma.ambLaunchCampaign.findUnique({ where: { id: c1.id } });
    ok('campaign 2 is left completely untouched while the 5-minute gate is still in the future (no Meta call ever attempted)', c1After.status === 'PENDING', c1After.status);
    const jobAfter = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId } });
    ok('job stays PUBLISHING — the tick does not fail or complete it early', jobAfter.status === 'PUBLISHING');
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§5 runDueLaunchQueueTick — a job with every campaign COMPLETE/CANCELLED is itself marked COMPLETE:');
{
  const tag = `__test_queue5_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job = await launch.createDraftJob({ jobId, userId: null, input: baseConfig() });
    const [c0, c1] = job.campaigns;
    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { status: 'COMPLETE', meta_campaign_id: 'meta_c0' } });
    await prisma.ambLaunchCampaign.update({ where: { id: c1.id }, data: { status: 'COMPLETE', meta_campaign_id: 'meta_c1' } });
    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { status: 'PUBLISHING' } });

    await publish.runDueLaunchQueueTick();

    const jobAfter = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId } });
    ok('job is transitioned PUBLISHING -> COMPLETE once every campaign has reached a terminal COMPLETE state', jobAfter.status === 'COMPLETE', jobAfter.status);
    const audits = await prisma.ambLaunchAudit.findMany({ where: { job_id: jobId, event: 'JOB_COMPLETE' } });
    ok('a JOB_COMPLETE audit row is written exactly once', audits.length === 1);

    // Re-running the tick again must be a safe no-op — job is no longer PUBLISHING, so it's not even selected.
    await publish.runDueLaunchQueueTick();
    const auditsAfterSecondTick = await prisma.ambLaunchAudit.findMany({ where: { job_id: jobId, event: 'JOB_COMPLETE' } });
    ok('a later tick never re-fires JOB_COMPLETE for an already-COMPLETE job', auditsAfterSecondTick.length === 1);
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§6 THE PRODUCTION BUG — a campaign stuck FAILED with 100% of its real objects already CREATED must be able to reach COMPLETE again:');
{
  // Reproduces exactly what happened live on job bfad0a63's Campaign 1: every
  // ad set/creative/ad already exists CREATED in amb_launch_object_map (and
  // meta_campaign_id is already set, so ensureCampaign() would short-circuit
  // instantly on a real resume), but campaign.status itself is stuck at
  // FAILED from an earlier transient hiccup. advanceCampaignStatus() alone
  // can never move a FAILED campaign anywhere (FAILED isn't in its linear
  // CAMPAIGN_STATUS_ORDER, so indexOf() is -1 and it silently no-ops) —
  // ensurePublishingStatus() is the fix: it must run first on every entry.
  const tag = `__test_queue6_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job = await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaignCount: 1, campaigns: [{ name: 'Q Stuck', websiteUrl: 'https://trendystore.com' }], adSetsPerCampaign: 1, budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }] } } }) });
    const c0 = job.campaigns[0];
    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { status: 'FAILED', error: 'فيديو C8 لسه مفيهوش صورة مصغّرة جاهزة من Meta — جرب تاني بعد شوية.', meta_campaign_id: 'meta_stuck_campaign' } });

    let stuck = await prisma.ambLaunchCampaign.findUnique({ where: { id: c0.id } });
    ok('setup: campaign really is FAILED with a real meta_campaign_id already set (matches production exactly)', stuck.status === 'FAILED' && stuck.meta_campaign_id === 'meta_stuck_campaign');

    // Reproduce the BUG in isolation first: without the fix, this call is silently a no-op.
    await publish.advanceCampaignStatus(c0.id, 'COMPLETE');
    stuck = await prisma.ambLaunchCampaign.findUnique({ where: { id: c0.id } });
    ok('confirms the bug: advanceCampaignStatus() alone can never move a FAILED campaign — it stays FAILED forever', stuck.status === 'FAILED', stuck.status);

    // Now apply the actual fix: ensurePublishingStatus() walks FAILED back onto the linear order first.
    await publish.ensurePublishingStatus(c0.id);
    stuck = await prisma.ambLaunchCampaign.findUnique({ where: { id: c0.id } });
    ok('ensurePublishingStatus() moves a resumed FAILED campaign to PUBLISHING', stuck.status === 'PUBLISHING', stuck.status);

    await publish.advanceCampaignStatus(c0.id, 'COMPLETE');
    stuck = await prisma.ambLaunchCampaign.findUnique({ where: { id: c0.id } });
    ok('advanceCampaignStatus() now walks all the way through to COMPLETE, exactly matching real Meta state', stuck.status === 'COMPLETE', stuck.status);

    // A campaign that was never FAILED (fresh PENDING) must still work exactly as before — no regression.
    const tag2 = `__test_queue6b_${Date.now()}__`;
    const jobId2 = `test-${tag2}`;
    const job2 = await launch.createDraftJob({ jobId: jobId2, userId: null, input: baseConfig({ campaignCount: 1, campaigns: [{ name: 'Q Fresh', websiteUrl: 'https://trendystore.com' }], adSetsPerCampaign: 1, budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }] } } }) });
    const cFresh = job2.campaigns[0];
    await publish.ensurePublishingStatus(cFresh.id);
    let fresh = await prisma.ambLaunchCampaign.findUnique({ where: { id: cFresh.id } });
    ok('a fresh PENDING campaign still correctly reaches PUBLISHING (no regression from the fix)', fresh.status === 'PUBLISHING', fresh.status);
    await publish.ensurePublishingStatus(cFresh.id);
    fresh = await prisma.ambLaunchCampaign.findUnique({ where: { id: cFresh.id } });
    ok('calling ensurePublishingStatus() again once already PUBLISHING is a safe no-op, never regresses', fresh.status === 'PUBLISHING', fresh.status);
    await cleanup(jobId2);
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§7 getQueueProgress — surfaces transient-retry bookkeeping so the UI can distinguish "auto-retrying" from a real terminal failure:');
{
  const tag = `__test_queue7_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job = await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaignCount: 1, campaigns: [{ name: 'Q Retry', websiteUrl: 'https://trendystore.com' }], adSetsPerCampaign: 1, budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }] } } }) });
    const c0 = job.campaigns[0];
    const retryAt = new Date(Date.now() + 90_000);
    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { status: 'ADSETS_CREATED', error: 'فيديو C3 لسه Meta بيعالجه (processing) — هيتعاد المحاولة تلقائيًا لحد ما يجهز.', next_retry_at: retryAt, transient_retry_count: 3 } });

    const progress = await publish.getQueueProgress(jobId);
    ok('nextRetryAt is surfaced on the campaign', progress.campaigns[0].nextRetryAt?.getTime() === retryAt.getTime());
    ok('transientRetryCount is surfaced on the campaign', progress.campaigns[0].transientRetryCount === 3);
    ok('status stays at its real last progress point (ADSETS_CREATED), never forced to FAILED for a transient condition', progress.campaigns[0].status === 'ADSETS_CREATED');
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§8 runDueLaunchQueueTick — respects next_retry_at exactly like the inter-campaign gate, never hammering Meta while a video is still processing:');
{
  const tag = `__test_queue8_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job = await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaignCount: 1, campaigns: [{ name: 'Q Backoff', websiteUrl: 'https://trendystore.com' }], adSetsPerCampaign: 1, budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }] } } }) });
    const c0 = job.campaigns[0];
    const beforeTick = await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { status: 'ADSETS_CREATED', next_retry_at: new Date(Date.now() + 5 * 60_000) } });
    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { status: 'PUBLISHING' } });

    await publish.runDueLaunchQueueTick();

    const after = await prisma.ambLaunchCampaign.findUnique({ where: { id: c0.id } });
    ok('the campaign is left completely untouched while next_retry_at is still in the future (no publishCampaignFull invocation attempted)', after.status === 'ADSETS_CREATED' && after.updated_at.getTime() === beforeTick.updated_at.getTime());
    const jobAfter = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId } });
    ok('job stays PUBLISHING — a transient backoff never flips the job to PARTIAL', jobAfter.status === 'PUBLISHING');
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§9 acquireJobLease/releaseJobLease — cross-instance concurrency protection (real DB, no Meta):');
{
  const tag = `__test_queue9_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaignCount: 1, campaigns: [{ name: 'Q Lease', websiteUrl: 'https://trendystore.com' }], adSetsPerCampaign: 1, budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }] } } }) });

    const won1 = await publish.acquireJobLease(jobId);
    ok('the first caller (this worker) wins the lease', won1 === true);

    // Simulate a SECOND Railway worker/instance trying to act on the SAME job at the same moment.
    const won2 = await publish.acquireJobLease(jobId);
    ok('a second concurrent attempt while the lease is still held is refused (count=0, matches the WHERE clause)', won2 === false);

    const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId } });
    ok('the lease is really persisted in the DB (not just in-memory) — real cross-instance visibility', typeof job.locked_by === 'string' && job.lock_expires_at instanceof Date);

    await publish.releaseJobLease(jobId);
    const afterRelease = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId } });
    ok('releasing clears both columns so the NEXT tick (any worker) can acquire it again', afterRelease.locked_by === null && afterRelease.lock_expires_at === null);

    const won3 = await publish.acquireJobLease(jobId);
    ok('a fresh acquire succeeds again after release', won3 === true);
    await publish.releaseJobLease(jobId);

    // An expired (stale, e.g. from a crashed worker) lease must be stealable, never wedge the job forever.
    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { locked_by: 'some-crashed-worker', lock_expires_at: new Date(Date.now() - 60_000) } });
    const wonAfterExpiry = await publish.acquireJobLease(jobId);
    ok('a stale/expired lease from a crashed worker can be stolen by a new attempt — never wedges the job forever', wonAfterExpiry === true);
    await publish.releaseJobLease(jobId);
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§10 retryLaunchCampaignNow — a safe scheduling nudge only, never creates anything itself:');
{
  const tag = `__test_queue10_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job = await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaignCount: 1, campaigns: [{ name: 'Q RetryNow', websiteUrl: 'https://trendystore.com' }], adSetsPerCampaign: 1, budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }] } } }) });
    const c0 = job.campaigns[0];
    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { status: 'ADSETS_CREATED', next_retry_at: new Date(Date.now() + 4 * 60_000) } });

    await publish.retryLaunchCampaignNow({ jobId, campaignIndex: 0 });
    const after = await prisma.ambLaunchCampaign.findUnique({ where: { id: c0.id } });
    ok('next_retry_at is cleared so the next tick acts immediately', after.next_retry_at === null);

    let threw = false;
    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { human_action_required: true, error_classification: 'CONFIGURATION_REQUIRED', next_retry_at: null } });
    try { await publish.retryLaunchCampaignNow({ jobId, campaignIndex: 0 }); } catch (e) { threw = true; ok('refuses with a clear message when the campaign is genuinely ACTION_REQUIRED', /تدخل يدوي/.test(e.message)); }
    ok('retryLaunchCampaignNow throws for an ACTION_REQUIRED campaign — a human decision, not a timer, is blocking it', threw);

    let threw2 = false;
    try { await publish.retryLaunchCampaignNow({ jobId, campaignIndex: 99 }); } catch { threw2 = true; }
    ok('retryLaunchCampaignNow throws for a campaign index that does not exist', threw2);
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§11 getQueueProgress — computed "phase" vocabulary (§10 of the self-healing spec) matches real campaign state:');
{
  const tag = `__test_queue11_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job = await launch.createDraftJob({ jobId, userId: null, input: baseConfig() });
    const [c0, c1] = job.campaigns;

    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { status: 'ADSETS_CREATED', next_retry_at: new Date(Date.now() + 60_000), error_classification: 'PROCESSING_WAIT' } });
    let progress = await publish.getQueueProgress(jobId);
    ok('a PROCESSING_WAIT retry-in-progress campaign phases as WAITING_FOR_META', progress.campaigns[0].phase === 'WAITING_FOR_META', progress.campaigns[0].phase);

    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { error_classification: 'RATE_LIMITED' } });
    progress = await publish.getQueueProgress(jobId);
    ok('a RATE_LIMITED retry-in-progress campaign phases as RETRY_SCHEDULED (distinct from a video-processing wait)', progress.campaigns[0].phase === 'RETRY_SCHEDULED', progress.campaigns[0].phase);

    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { next_retry_at: null, status: 'FAILED', human_action_required: true, error_classification: 'AUTH_REFRESH_REQUIRED' } });
    progress = await publish.getQueueProgress(jobId);
    ok('a human_action_required campaign phases as ACTION_REQUIRED regardless of the underlying status', progress.campaigns[0].phase === 'ACTION_REQUIRED', progress.campaigns[0].phase);

    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { human_action_required: false } });
    progress = await publish.getQueueProgress(jobId);
    ok('a plain FAILED (no human action needed, e.g. mid-exhaustion edge case) phases as FAILED_TERMINAL', progress.campaigns[0].phase === 'FAILED_TERMINAL', progress.campaigns[0].phase);

    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { status: 'COMPLETE', error_classification: null } });
    progress = await publish.getQueueProgress(jobId);
    ok('COMPLETE always phases as COMPLETE even if stale classification fields were somehow left behind', progress.campaigns[0].phase === 'COMPLETE');

    ok('a fresh PENDING campaign phases as QUEUED', progress.campaigns[1].phase === 'QUEUED', progress.campaigns[1].phase);
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§12 runDueLaunchQueueTick — respects the job lease: a concurrent tick never touches a job another worker already holds:');
{
  const tag = `__test_queue12_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job = await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaignCount: 1, campaigns: [{ name: 'Q Concurrent', websiteUrl: 'https://trendystore.com' }], adSetsPerCampaign: 1, budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }] } } }) });
    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { status: 'PUBLISHING' } });

    // Simulate ANOTHER worker's tick already holding the lease (mid-processing).
    await prisma.ambLaunchJob.update({ where: { job_id: jobId }, data: { locked_by: 'other-worker-xyz', lock_expires_at: new Date(Date.now() + 60_000) } });
    const c0Before = job.campaigns[0];

    await publish.runDueLaunchQueueTick();

    const c0After = await prisma.ambLaunchCampaign.findUnique({ where: { id: c0Before.id } });
    ok('the campaign is completely untouched — this tick never even attempted publishCampaignFull while another worker holds the lease', c0After.status === 'PENDING' && c0After.updated_at.getTime() === c0Before.updated_at.getTime());
    const jobAfter = await prisma.ambLaunchJob.findUnique({ where: { job_id: jobId } });
    ok('the lease is left exactly as the other worker set it — this tick never stole or cleared it', jobAfter.locked_by === 'other-worker-xyz');
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§13 Auth self-heal recovery — a resumed ACTION_REQUIRED(AUTH_REFRESH_REQUIRED) campaign runs a real read-only probe FIRST and clears stale state on success:');
{
  // Real production incident: a plain Meta payload-validation error had been
  // misclassified as AUTH_REFRESH_REQUIRED (fixed separately in
  // launchErrorPlaybook.js), and the user reconnected Meta multiple times
  // with zero effect — because the underlying problem was never auth. This
  // proves the NEW recovery gate itself: given a campaign resuming from a
  // stale AUTH_REFRESH_REQUIRED flag, publishCampaignFull() runs a real
  // (read-only, no write) probe against the REAL currently-connected Meta
  // account BEFORE attempting anything else, and — since this environment's
  // real connection genuinely works — clears the stale flags immediately,
  // proven via the RECONCILED audit row, never requiring a second reconnect.
  const tag = `__test_queue13_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job = await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaignCount: 1, campaigns: [{ name: 'Q AuthHeal', websiteUrl: 'https://trendystore.com' }], adSetsPerCampaign: 1, budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }] } } }) });
    const c0 = job.campaigns[0];
    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { status: 'FAILED', error: 'اتصال Meta يحتاج إعادة ربط — التوكن منتهي أو اتلغى.', error_classification: 'AUTH_REFRESH_REQUIRED', human_action_required: true } });
    await prisma.ambLaunchVideoAsset.create({ data: { job_id: jobId, slot_key: 'C1', original_filename: 'v.mp4', status: 'UPLOADED', meta_video_id: 'vid_1' } });

    // ad_account_id is deliberately fake (baseConfig's 'act_queue_test') so the
    // REAL Meta write attempt right after the probe fails harmlessly and
    // predictably — the point of this test is only what happens BEFORE that.
    try { await publish.publishCampaignFull({ jobId, campaignIndex: 0 }); } catch { /* expected — fake ad account id */ }

    const audits = await prisma.ambLaunchAudit.findMany({ where: { job_id: jobId, event: 'RECONCILED' } });
    ok('a RECONCILED audit row proves the real auth probe ran and succeeded against the live connected account', audits.some((a) => /auth probe نجح|اتأكد إنه شغال/.test(a.detail || '')), JSON.stringify(audits.map((a) => a.detail)));

    const after = await prisma.ambLaunchCampaign.findUnique({ where: { id: c0.id } });
    ok('the campaign is NEVER left showing the stale AUTH_REFRESH_REQUIRED classification once the probe has succeeded — whatever happens next gets its own fresh, correct classification', after.error_classification !== 'AUTH_REFRESH_REQUIRED', after.error_classification);
  } finally {
    await cleanup(jobId);
  }
}

console.log('\n§14 reconcileNativeScheduledLaunchCampaigns — the native-schedule safety net only ever watches, never recreates:');
{
  const tag = `__test_queue14_${Date.now()}__`;
  const jobId = `test-${tag}`;
  try {
    const job = await launch.createDraftJob({ jobId, userId: null, input: baseConfig({ campaignCount: 1, campaigns: [{ name: 'Q NativeReconcile', websiteUrl: 'https://trendystore.com' }], adSetsPerCampaign: 1, budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }] } }, launchMode: 'SCHEDULED', startMode: 'SCHEDULED', startAt: new Date(Date.now() + 3600_000).toISOString() }) });
    const c0 = job.campaigns[0];

    const before = await publish.reconcileNativeScheduledLaunchCampaigns();
    ok('a campaign with no natively_activated_at is never picked up at all', before.checked === 0, JSON.stringify(before));

    // Fake meta_campaign_id (never a real Meta write) — proves the read-only
    // reconcile pass degrades gracefully (skips, never throws, never marks
    // "confirmed") when the live Graph read itself fails.
    await prisma.ambLaunchCampaign.update({ where: { id: c0.id }, data: { status: 'COMPLETE', meta_campaign_id: 'fake_native_campaign_id', natively_activated_at: new Date() } });
    let threw = false;
    let result;
    try { result = await publish.reconcileNativeScheduledLaunchCampaigns(); } catch { threw = true; }
    ok('a natively-activated campaign with an unreachable Meta id never throws — always degrades gracefully', !threw);
    ok('it is genuinely picked up for watching (not silently skipped)', result && result.checked >= 1, JSON.stringify(result));

    const confirmedAudit = await prisma.ambLaunchAudit.findFirst({ where: { job_id: jobId, event: 'SCHEDULE_CONFIRMED_DELIVERING' } });
    ok('an unreachable campaign is never falsely marked as confirmed-delivering', !confirmedAudit);

    // Simulate an already-confirmed campaign from an earlier tick — must be
    // skipped entirely on the next pass (no redundant Meta reads forever).
    await prisma.ambLaunchAudit.create({ data: { job_id: jobId, campaign_id: c0.id, event: 'SCHEDULE_CONFIRMED_DELIVERING', detail: 'test-seeded' } });
    const after = await publish.reconcileNativeScheduledLaunchCampaigns();
    ok('once confirmed-delivering, the SAME campaign is excluded from future watching passes', after.watching === 0 || after.checked === 0, JSON.stringify(after));
  } finally {
    await cleanup(jobId);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
