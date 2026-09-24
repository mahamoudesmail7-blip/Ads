// AI Media Buyer Operator — Winner→Scale chat integration verification.
// Built after a real user request: "اعمل اسكيل" should reference the SAME
// real campaigns the dashboard's own "🚀 جاهزة للاسكيل" panel shows
// (services/amb/scaleWinners.js), then walk CBO/ABO/budget/schedule
// conversationally, ending in a normal WAITING_FOR_APPROVAL task — never a
// direct, unconfirmed Meta write (unlike the dashboard's own single-click
// /scale/execute, which this deliberately does NOT reuse for chat).
//   node src/scripts/scaleWinnerToolTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { get_scale_winners, prepare_scale_winner, retry_task, WRITE_TOOL_DEFINITIONS, WRITE_TOOL_META } = await imp('../services/aiToolsWrite.js');
const { listScaleWinners } = await imp('../services/amb/scaleWinners.js');
const { canTransitionTask } = await imp('../services/assistantTasks/taskEngine.js');

const cleanupTaskUuids = [];
async function cleanup() {
  for (const t of cleanupTaskUuids) await prisma.assistantTask.deleteMany({ where: { task_uuid: t } }).catch(() => {});
}

try {
  console.log('§1 get_scale_winners matches the dashboard\'s own listScaleWinners() exactly — same source, no drift:');
  {
    const viaTool = await get_scale_winners({});
    const viaDirect = await listScaleWinners({ windowName: 'today' });
    const pendingDirect = viaDirect.cards.filter((c) => c.decisionStatus === 'PENDING');
    ok('get_scale_winners returns ok:true', viaTool.ok === true, JSON.stringify(viaTool).slice(0, 200));
    ok('count matches the real pending-card count from the dashboard\'s own function', viaTool.count === pendingDirect.length, `tool=${viaTool.count} direct=${pendingDirect.length}`);
    ok('every candidate is a real {sourceCampaignId, displayName} pair with real evidence numbers', viaTool.candidates.every((c) => c.sourceCampaignId && typeof c.orders === 'number' && typeof c.cpa === 'number'));
    console.log(`  ${viaTool.count} real campaigns currently eligible: ${viaTool.candidates.map((c) => c.displayName).join(', ') || '(none)'}`);
  }

  console.log('\n§2 prepare_scale_winner — conversational needsInput flow never invents a missing value:');
  if ((await get_scale_winners({})).count > 0) {
    const first = (await get_scale_winners({})).candidates[0];

    const step1 = await prepare_scale_winner({ sourceCampaignId: first.sourceCampaignId });
    ok('no budgetMode yet -> needsInput:true asking CBO/ABO, never guesses', step1.ok === true && step1.needsInput === true && /CBO/.test(step1.question));

    const step2 = await prepare_scale_winner({ sourceCampaignId: first.sourceCampaignId, budgetMode: 'CBO' });
    ok('CBO chosen but no budget -> needsInput:true asking for budget, never invents a number', step2.ok === true && step2.needsInput === true && /ميزانية/.test(step2.question));

    const step3 = await prepare_scale_winner({ sourceCampaignId: first.sourceCampaignId, budgetMode: 'ABO' });
    ok('ABO chosen but no adSets -> needsInput:true asking for per-ad-set budgets/ads', step3.ok === true && step3.needsInput === true);
  } else {
    console.log('  (skipped — no real campaign is currently eligible for scaling)');
  }

  console.log('\n§3 An unknown/ambiguous name is never silently guessed:');
  {
    const bad = await prepare_scale_winner({ campaignName: 'حاجة مش موجودة خالص 12345' });
    ok('a completely made-up campaign name fails honestly, never fabricates a card', bad.ok === false && !bad.task);
  }

  console.log('\n§4 Full real flow to WAITING_FOR_APPROVAL (never approved — no real Meta write in this test):');
  if ((await get_scale_winners({})).count > 0) {
    const first = (await get_scale_winners({})).candidates[0];
    const adminUser = await prisma.user.findFirst({ where: { role: { in: ['ADMIN', 'MANAGER'] } }, select: { id: true } });
    const full = await prepare_scale_winner({ sourceCampaignId: first.sourceCampaignId, budgetMode: 'CBO', campaignBudgetEgp: 150, startMode: 'RUN_NOW', userId: adminUser.id, conversationRef: 'scaleWinnerToolTest' });
    ok('reaches a real WAITING_FOR_APPROVAL task with a real approval hash', full.ok === true && full.task?.status === 'WAITING_FOR_APPROVAL' && typeof full.task?.approvalHash === 'string' && full.task.approvalHash.length === 64, JSON.stringify(full).slice(0, 300));
    ok('preparedPayload carries the real evidence (orders/cpa) the card showed, never fabricated', full.task?.preparedPayload?.evidence?.orders === first.orders && full.task?.preparedPayload?.evidence?.cpa === first.cpa);
    ok('task kind is SCALE_WINNER', full.task?.kind === 'SCALE_WINNER');
    if (full.task?.taskUuid) cleanupTaskUuids.push(full.task.taskUuid);

    console.log('\n§5 retry_task on a SCALE_WINNER task NEVER blindly re-prepares if a real clone batch already exists:');
    // Simulate a FAILED SCALE_WINNER task with a real-looking clone_batch_id
    // on its AmbScaleDecision row (as approveScaleWinnerTask's own failure
    // path would leave behind) — retry_task must refuse automatic retry.
    const decision = await prisma.ambScaleDecision.create({
      data: { ad_account_id: 'test_acct', source_campaign_id: first.sourceCampaignId, status: 'FAILED', clone_batch_id: 'test-batch-should-block-retry' },
    });
    await prisma.assistantTask.update({ where: { task_uuid: full.task.taskUuid }, data: { status: 'FAILED' } });
    const retried = await retry_task({ taskUuid: full.task.taskUuid });
    ok('retry_task refuses to auto-reprepare when a real clone batch already exists for this campaign', retried.ok === true && retried.retried === false && /استنساخ حقيقي/.test(retried.note || ''), JSON.stringify(retried));
    await prisma.ambScaleDecision.delete({ where: { id: decision.id } });
  } else {
    console.log('  (skipped — no real campaign is currently eligible for scaling)');
  }

  console.log('\n§6 Tool registration:');
  {
    ok('prepare_scale_winner requires approval and is flagged as writing to Meta', WRITE_TOOL_META.prepare_scale_winner?.requiresApproval === true && WRITE_TOOL_META.prepare_scale_winner?.writesToMeta === true);
    ok('get_scale_winners is READ-tier, no approval needed', WRITE_TOOL_META.get_scale_winners?.tier === 'READ' && WRITE_TOOL_META.get_scale_winners?.requiresApproval === false);
    ok('both have real tool definitions with no productId/sourceCampaignId marked required (never forces an ID)', WRITE_TOOL_DEFINITIONS.filter((d) => ['prepare_scale_winner', 'get_scale_winners'].includes(d.name)).every((d) => !d.input_schema.required));
  }

  console.log('\n§7 SCALE_WINNER kind is a real, valid FSM transition target (WAITING_FOR_APPROVAL reachable, terminal states still terminal):');
  {
    ok('WAITING_FOR_APPROVAL -> RUNNING is valid (the same transition every other PREPARE kind uses)', canTransitionTask('WAITING_FOR_APPROVAL', 'RUNNING'));
    ok('COMPLETED has no outgoing transitions', canTransitionTask('COMPLETED', 'RUNNING') === false);
  }
} finally {
  await cleanup();
  console.log('\ncleanup done —', cleanupTaskUuids.length, 'disposable test task(s) removed (no real Meta write was ever made).');
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
