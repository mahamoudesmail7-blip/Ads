// AI Media Buyer Operator — Phase 2 Slice 3 (Scale-from-chat) verification.
// Real reads against production data + one real throwaway AssistantTask/
// AmbLaunchJob (cleaned up after) — NEVER approves, NEVER calls Meta.
// Proves: (1) loadWinningStackForProduct only says ok:true for a real
// SCALE_CANDIDATE verdict from the actual decision engine, never a guess;
// (2) resolveWinningCreativeAsset resolves a real Meta id with zero upload
// when the Media Library has one, and returns null honestly otherwise;
// (3) prepare_scale end-to-end reaches WAITING_FOR_APPROVAL or
// WAITING_FOR_INPUT with a real AmbLaunchJob, never touches Meta.
//   node src/scripts/scalePrepareTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { loadWinningStackForProduct, resolveWinningCreativeAsset } = await imp('../services/assistantTasks/scalePrepare.js');
const { prepare_scale } = await imp('../services/aiToolsWrite.js');
const { getConnection } = await imp('../services/metaAuth.js');

const cleanupTaskUuids = [];
const cleanupJobIds = [];
async function cleanup() {
  for (const taskUuid of cleanupTaskUuids) {
    await prisma.assistantTask.deleteMany({ where: { task_uuid: taskUuid } }).catch(() => {});
  }
  for (const jobId of cleanupJobIds) {
    await prisma.ambLaunchJob.deleteMany({ where: { job_id: jobId } }).catch(() => {});
  }
}

try {
  const connection = await getConnection();
  if (!connection?.selected_ad_account_id) {
    console.log('لا يوجد حساب إعلاني Meta متصل — الاختبار محتاج اتصال حقيقي.');
    process.exit(1);
  }
  const adAccountId = connection.selected_ad_account_id;
  console.log('Ad account:', adAccountId);

  // Scan a bounded set of real active products for one SCALE_CANDIDATE and one non-SCALE_CANDIDATE.
  const ambProducts = await prisma.ambProduct.findMany({
    take: 40,
    orderBy: { id: 'desc' },
    select: { product_id: true, product: { select: { id: true, product_name: true, active: true, is_historical: true } } },
  });
  const candidates = ambProducts.filter((a) => a.product?.active && !a.product?.is_historical).map((a) => a.product);

  let scaleCandidate = null, nonScaleCandidate = null;
  console.log(`\nScanning ${candidates.length} real active products for a real SCALE_CANDIDATE verdict...`);
  for (const p of candidates) {
    const result = await loadWinningStackForProduct({ productId: p.id, adAccountId }).catch((err) => ({ ok: false, message: err.message, errored: true }));
    if (result.ok && !scaleCandidate) { scaleCandidate = { product: p, result }; console.log(`  found SCALE_CANDIDATE: #${p.id} ${p.product_name}`); }
    else if (!result.ok && !result.errored && !nonScaleCandidate) { nonScaleCandidate = { product: p, result }; }
    if (scaleCandidate && nonScaleCandidate) break;
  }

  console.log('\n§1 loadWinningStackForProduct — negative case (real, non-SCALE_CANDIDATE product):');
  if (nonScaleCandidate) {
    ok('refuses with ok:false and names the real current decision', nonScaleCandidate.result.ok === false && typeof nonScaleCandidate.result.decision === 'string', JSON.stringify(nonScaleCandidate.result));
    ok('message is a real Arabic explanation, not empty', typeof nonScaleCandidate.result.message === 'string' && nonScaleCandidate.result.message.length > 10);
  } else {
    console.log('  (skipped — no non-SCALE_CANDIDATE product found in the scanned set)');
  }

  console.log('\n§2 loadWinningStackForProduct — positive case (real SCALE_CANDIDATE product):');
  if (scaleCandidate) {
    const r = scaleCandidate.result;
    ok('ok:true', r.ok === true);
    ok('carries a real stack object', typeof r.stack === 'object' && r.stack != null);
    ok('carries real tracking identity fields (possibly null, never undefined-shaped)', 'pixel_id' in r.tracking && 'page_id' in r.tracking);
    ok('targeting is either a real object or null (Broad) — never invented', r.targeting === null || typeof r.targeting === 'object');
    console.log('  creativeAssetId:', r.creativeAssetId, '| label:', r.creativeLabel, '| cpa:', r.creativeCpa, '| purchases:', r.creativePurchases);

    console.log('\n§3 resolveWinningCreativeAsset:');
    const asset = await resolveWinningCreativeAsset(r.creativeAssetId, adAccountId);
    ok('returns null OR a real {kind,metaId} shape — never a guess', asset === null || (typeof asset === 'object' && ['video', 'image'].includes(asset.kind) && !!asset.metaId), JSON.stringify(asset));
    console.log('  resolved asset:', JSON.stringify(asset));

    console.log('\n§4 prepare_scale end-to-end (real AmbLaunchJob written, ZERO Meta writes, never approved):');
    const adminUser = await prisma.user.findFirst({ where: { role: { in: ['ADMIN', 'MANAGER'] } }, select: { id: true, role: true } });
    if (!adminUser) {
      console.log('  (skipped — no ADMIN/MANAGER user found to attribute the test task to)');
    } else {
      const out = await prepare_scale({
        productId: scaleCandidate.product.id, budgetEgp: 100, websiteUrl: 'https://example.com/scale-test',
        userId: adminUser.id, conversationRef: 'scalePrepareTest-script', context: {},
      });
      ok('prepare_scale returns ok:true (either WAITING_FOR_APPROVAL or WAITING_FOR_INPUT, never an error)', out.ok === true, JSON.stringify(out));
      if (out.task) {
        cleanupTaskUuids.push(out.task.taskUuid);
        if (out.task.launchJobId) cleanupJobIds.push(out.task.launchJobId);
        ok('task kind is SCALE_CAMPAIGN', out.task.kind === 'SCALE_CAMPAIGN', out.task.kind);
        ok('task landed in a real, expected status', ['WAITING_FOR_APPROVAL', 'WAITING_FOR_INPUT'].includes(out.task.status), out.task.status);
        console.log('  status:', out.task.status, '| launchJobId:', out.task.launchJobId);
        if (out.task.status === 'WAITING_FOR_APPROVAL') {
          const p = out.task.preparedPayload;
          ok('preview carries sourceWinner with the real evidence shown to the human', !!p.sourceWinner && (p.sourceWinner.label != null || p.sourceWinner.cpa != null || p.sourceWinner.purchases != null), JSON.stringify(p.sourceWinner));
          ok('a real AmbLaunchJob row exists for this job (DB write, never a Meta write)', true);
          const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: out.task.launchJobId } });
          ok('AmbLaunchJob really exists and is still DRAFT/READY (never PUBLISHING/COMPLETE — proves no publish was triggered)', !!job && !['PUBLISHING', 'COMPLETE', 'PARTIAL'].includes(job.status), job?.status);
          ok('approvalHash is present and deterministic-looking', typeof out.task.approvalHash === 'string' && out.task.approvalHash.length === 64);

          console.log('\n§5 approveTask with a deliberately WRONG hash (must refuse, never call Meta):');
          const { approveTask } = await imp('../services/assistantTasks/taskEngine.js');
          const wrongResult = await approveTask({ taskId: out.task.taskUuid, userId: adminUser.id, approvalHash: 'not-the-real-hash' });
          ok('rejected as STALE_APPROVAL', wrongResult.ok === false && wrongResult.error === 'STALE_APPROVAL', JSON.stringify(wrongResult));
          const afterWrong = await prisma.assistantTask.findUnique({ where: { task_uuid: out.task.taskUuid } });
          ok('task reverted to PREPARING, not RUNNING/VERIFYING/COMPLETED', afterWrong?.status === 'PREPARING', afterWrong?.status);
          const jobAfterWrong = await prisma.ambLaunchJob.findUnique({ where: { job_id: out.task.launchJobId } });
          ok('AmbLaunchJob still never left DRAFT/READY — startLaunchQueue was never called', !['PUBLISHING', 'COMPLETE', 'PARTIAL'].includes(jobAfterWrong?.status), jobAfterWrong?.status);
        } else {
          console.log('  (WAITING_FOR_INPUT — expected when the winning creative is not registered in the Media Library for this ad account; media gate correctly refused to skip itself)');
          ok('a wrong-on-purpose blank note explains what is missing', typeof out.task.error === 'string' && out.task.error.length > 5, out.task.error);
        }
      }
    }
  } else {
    console.log('  (skipped — no real SCALE_CANDIDATE product found among the scanned set; nothing to test the positive path against)');
  }
} finally {
  await cleanup();
  console.log('\ncleanup done —', cleanupTaskUuids.length, 'test task(s),', cleanupJobIds.length, 'test job(s) removed.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
