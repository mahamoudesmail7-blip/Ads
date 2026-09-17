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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
