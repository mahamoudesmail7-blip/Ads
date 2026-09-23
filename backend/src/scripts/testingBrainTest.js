// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 3 (Testing Brain + prepare_test) verification. Real reads against
// production data + one real throwaway AssistantTask/AmbLaunchJob (cleaned
// up after) — NEVER approves, NEVER calls Meta.
//   node src/scripts/testingBrainTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { get_testing_brain } = await imp('../services/aiTools.js');
const { prepare_test } = await imp('../services/aiToolsWrite.js');
const { approveTask } = await imp('../services/assistantTasks/taskEngine.js');
const { parseAudienceTestValue } = await imp('../services/assistantTasks/testPrepare.js');
const { getConnection } = await imp('../services/metaAuth.js');

const cleanupTaskUuids = [];
const cleanupJobIds = [];
async function cleanup() {
  for (const taskUuid of cleanupTaskUuids) await prisma.assistantTask.deleteMany({ where: { task_uuid: taskUuid } }).catch(() => {});
  for (const jobId of cleanupJobIds) await prisma.ambLaunchJob.deleteMany({ where: { job_id: jobId } }).catch(() => {});
}

const VALID_STATUS = ['TESTED', 'TESTING', 'WON', 'LOST', 'INCONCLUSIVE', 'NOT_TESTED'];

try {
  console.log('§1 Pure fixture assertions — parseAudienceTestValue:');
  {
    ok('"25-34" parses as AGE', JSON.stringify(parseAudienceTestValue('25-34')) === JSON.stringify({ mode: 'AGE', ageMin: 25, ageMax: 34 }));
    ok('"65+" parses as AGE 65-65', JSON.stringify(parseAudienceTestValue('65+')) === JSON.stringify({ mode: 'AGE', ageMin: 65, ageMax: 65 }));
    ok('"رجال" parses as GENDER MALE', JSON.stringify(parseAudienceTestValue('رجال')) === JSON.stringify({ mode: 'GENDER', gender: 'MALE' }));
    ok('"نساء" parses as GENDER FEMALE', JSON.stringify(parseAudienceTestValue('نساء')) === JSON.stringify({ mode: 'GENDER', gender: 'FEMALE' }));
    ok('unrecognized value returns null (never guessed)', parseAudienceTestValue('حاجة غريبة') === null);
  }

  console.log('\n§2 Real reads — get_testing_brain across real products:');
  {
    const ambProducts = await prisma.ambProduct.findMany({ take: 15, orderBy: { id: 'desc' }, select: { product_id: true, product_name: true } });
    let checked = 0, sawMarketingTest = 0, sawNotAMarketingTest = 0;
    for (const ap of ambProducts) {
      if (!ap.product_id) continue;
      const out = await get_testing_brain({ productId: ap.product_id, window: 'last7' });
      if (!out.ok || !out.hasData) continue;
      checked++;
      ok(`${ap.product_name} testMatrix entries all have valid statuses`, (out.testMatrix || []).every((e) => VALID_STATUS.includes(e.status)), JSON.stringify(out.testMatrix?.find((e) => !VALID_STATUS.includes(e.status))));
      ok(`${ap.product_name} nextBestTest has a real recommendation type`, ['NONE', 'MARKETING_TEST', 'PRICE_TEST', 'NOT_A_MARKETING_TEST'].includes(out.nextBestTest?.recommendation), out.nextBestTest?.recommendation);
      if (out.nextBestTest?.recommendation === 'MARKETING_TEST') {
        sawMarketingTest++;
        ok(`${ap.product_name} MARKETING_TEST design has variableChanged matching its top candidate's dimension`, !out.nextBestTest.candidates?.[0] || out.controlledTestDesign?.variableChanged === out.nextBestTest.candidates[0].dimension, JSON.stringify({ top: out.nextBestTest.candidates?.[0], design: out.controlledTestDesign }));
        ok(`${ap.product_name} design carries a real successMetric/evaluationWindowDays`, typeof out.controlledTestDesign?.successMetric === 'string' && typeof out.controlledTestDesign?.evaluationWindowDays === 'number');
      }
      if (out.nextBestTest?.recommendation === 'NOT_A_MARKETING_TEST') sawNotAMarketingTest++;
    }
    ok('checked at least one real product', checked > 0, `checked=${checked}`);
    console.log(`  checked ${checked} products — ${sawMarketingTest} MARKETING_TEST, ${sawNotAMarketingTest} NOT_A_MARKETING_TEST recommendations seen.`);
  }

  console.log('\n§3 prepare_test end-to-end (real AmbLaunchJob written, ZERO Meta writes, never approved):');
  {
    const adminUser = await prisma.user.findFirst({ where: { role: { in: ['ADMIN', 'MANAGER'] } }, select: { id: true } });
    const connection = await getConnection();
    if (!adminUser || !connection?.selected_ad_account_id) {
      console.log('  (skipped — no admin user or connected ad account)');
    } else {
      // Find a real product with a resolvable creative winner via get_testing_brain's own pkg (any product with creativeIntel data works — prepare_test only requires SOME real winning creative, not a SCALE_CANDIDATE verdict).
      const ambProducts = await prisma.ambProduct.findMany({ take: 30, orderBy: { id: 'desc' }, select: { product_id: true, product_name: true } });
      let testProduct = null, testValue = null;
      for (const ap of ambProducts) {
        if (!ap.product_id) continue;
        const out = await get_testing_brain({ productId: ap.product_id, window: 'last7' });
        const audienceCandidate = out.testMatrix?.find((e) => e.dimension === 'AUDIENCE' && parseAudienceTestValue(e.key));
        if (out.ok && out.hasData && audienceCandidate) { testProduct = ap; testValue = audienceCandidate.key; break; }
      }
      if (!testProduct) {
        console.log('  (skipped — no real product with both a winning creative and a parseable AUDIENCE candidate found)');
      } else {
        console.log(`  using product "${testProduct.product_name}" (#${testProduct.product_id}), testValue="${testValue}"`);
        const out = await prepare_test({
          productId: testProduct.product_id, testDimension: 'AUDIENCE', testValue, budgetEgp: 50, websiteUrl: 'https://example.com/testing-brain-test',
          userId: adminUser.id, conversationRef: 'testingBrainTest-script', context: {},
        });
        ok('prepare_test returns ok:true (WAITING_FOR_APPROVAL/WAITING_FOR_INPUT) or a real BLOCKED, never a crash', out.ok === true || out.error === 'BLOCKED', JSON.stringify(out).slice(0, 300));
        if (out.task) {
          cleanupTaskUuids.push(out.task.taskUuid);
          if (out.task.launchJobId) cleanupJobIds.push(out.task.launchJobId);
          ok('task kind is TEST_CAMPAIGN', out.task.kind === 'TEST_CAMPAIGN', out.task.kind);
          if (out.task.status === 'WAITING_FOR_APPROVAL') {
            const p = out.task.preparedPayload;
            ok('preview carries a real testDesign block', !!p.testDesign && p.testDesign.dimension === 'AUDIENCE' && p.testDesign.variant === testValue, JSON.stringify(p.testDesign));
            ok('preview carries profitBrain', !!p.profitBrain && typeof p.profitBrain.state === 'string');
            const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: out.task.launchJobId } });
            ok('AmbLaunchJob exists and never left DRAFT/READY — no Meta write happened', !!job && !['PUBLISHING', 'COMPLETE', 'PARTIAL'].includes(job.status), job?.status);
            ok('approvalHash is present and deterministic-looking', typeof out.task.approvalHash === 'string' && out.task.approvalHash.length === 64);

            console.log('\n§4 approveTask with a deliberately WRONG hash (must refuse, never call Meta):');
            const wrongResult = await approveTask({ taskId: out.task.taskUuid, userId: adminUser.id, approvalHash: 'not-the-real-hash' });
            ok('rejected as STALE_APPROVAL', wrongResult.ok === false && wrongResult.error === 'STALE_APPROVAL', JSON.stringify(wrongResult));
            const afterWrong = await prisma.assistantTask.findUnique({ where: { task_uuid: out.task.taskUuid } });
            ok('task reverted to PREPARING, not RUNNING/VERIFYING/COMPLETED', afterWrong?.status === 'PREPARING', afterWrong?.status);
          } else {
            console.log(`  task landed in ${out.task.status} (${out.task.error || out.task.blockedReason || ''}) — real, honest gate behavior, not necessarily a bug.`);
          }
        } else if (out.error === 'BLOCKED') {
          console.log('  BLOCKED before any task/job was persisted:', out.message);
        }
      }
    }
  }
} finally {
  await cleanup();
  console.log('\ncleanup done —', cleanupTaskUuids.length, 'test task(s),', cleanupJobIds.length, 'test job(s) removed.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
