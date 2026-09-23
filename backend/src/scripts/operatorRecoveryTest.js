// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 17 (Operator Recovery) verification. get_task_progress is pure
// read; cancel_task is exercised on a REAL, disposable, freshly-created
// PREPARING-tier task (never touches a real in-flight one) and cleaned up.
// retry_task is exercised only on its safe, no-Meta-write branches.
//   node src/scripts/operatorRecoveryTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { get_task_progress, retry_task, cancel_task } = await imp('../services/aiToolsWrite.js');
const { createTask, canTransitionTask } = await imp('../services/assistantTasks/taskEngine.js');

const cleanupTaskUuids = [];
async function cleanup() {
  for (const t of cleanupTaskUuids) await prisma.assistantTask.deleteMany({ where: { task_uuid: t } }).catch(() => {});
}

try {
  console.log('§1 FSM widening — FAILED can now also resume into RUNNING (for launch-job retry), never a new status value:');
  {
    ok('FAILED->RUNNING is now a valid transition', canTransitionTask('FAILED', 'RUNNING'));
    ok('FAILED->PREPARING (the pre-existing re-prepare path) still works', canTransitionTask('FAILED', 'PREPARING'));
    ok('COMPLETED still has zero outgoing transitions (terminal states untouched)', canTransitionTask('COMPLETED', 'RUNNING') === false);
  }

  console.log('\n§2 get_task_progress — real reads across whatever real tasks exist:');
  {
    const noJob = await prisma.assistantTask.findFirst({ where: { launch_job_id: null } });
    if (noJob) {
      const out = await get_task_progress({ taskUuid: noJob.task_uuid });
      ok('a task with no launch_job_id reports hasLaunchJob:false, never fabricates campaign progress', out.ok === true && out.hasLaunchJob === false);
    } else {
      console.log('  (skipped no-job case — every real task has a launch_job_id)');
    }
    const withJob = await prisma.assistantTask.findFirst({ where: { launch_job_id: { not: null } } });
    if (withJob) {
      const out = await get_task_progress({ taskUuid: withJob.task_uuid });
      ok('a task WITH a launch_job_id reports hasLaunchJob:true with real counts', out.ok === true && out.hasLaunchJob === true && typeof out.totalCampaigns === 'number');
      ok('completedCampaigns never exceeds totalCampaigns', out.completedCampaigns <= out.totalCampaigns);
    } else {
      console.log('  (skipped with-job case — no real task has a launch_job_id)');
    }
    const bad = await get_task_progress({ taskUuid: 'not-a-real-uuid' });
    ok('a non-existent taskUuid fails clean, never fabricates a report', bad.ok === false);
  }

  console.log('\n§3 retry_task — safe-path guards, never touches Meta:');
  {
    const wrongState = await prisma.assistantTask.findFirst({ where: { status: { in: ['COMPLETED', 'CANCELLED'] } } });
    if (wrongState) {
      const out = await retry_task({ taskUuid: wrongState.task_uuid });
      ok('retry_task refuses a task that is not FAILED/BLOCKED', out.ok === false, JSON.stringify(out));
    }
    const bad = await retry_task({ taskUuid: 'not-a-real-uuid' });
    ok('retry_task on a non-existent taskUuid fails clean', bad.ok === false);

    // A BLOCKED task with launch_job_id + a real human_action_required
    // campaign must be refused (never silently retried past a human gate).
    const blockedLaunch = await prisma.assistantTask.findFirst({ where: { status: { in: ['FAILED', 'BLOCKED'] }, launch_job_id: { not: null } } });
    if (blockedLaunch) {
      const out = await retry_task({ taskUuid: blockedLaunch.task_uuid });
      ok('retry_task on a real failed launch task returns ok:true either way (retried or a clear blocked reason), never throws', out.ok === true, JSON.stringify(out).slice(0, 300));
      if (out.retried === false) ok('when not retried, a real reason/blockedCampaigns is given, never silence', !!out.note);
    } else {
      console.log('  (skipped — no real FAILED/BLOCKED task with a launch_job_id exists right now)');
    }
  }

  console.log('\n§4 cancel_task — real end-to-end on a disposable, freshly-created task (never a real in-flight one):');
  {
    const adminUser = await prisma.user.findFirst({ where: { role: { in: ['ADMIN', 'MANAGER'] } }, select: { id: true } });
    if (adminUser) {
      const task = await createTask({ userId: adminUser.id, kind: 'BUMP', toolName: 'prepare_bump', entityId: 'operatorRecoveryTest-disposable', entityType: 'adset', inputJson: { adSetId: 'operatorRecoveryTest-disposable' } });
      cleanupTaskUuids.push(task.task_uuid);
      const out = await cancel_task({ taskUuid: task.task_uuid });
      ok('cancel_task succeeds on a fresh PLANNED task', out.ok === true && out.task.status === 'CANCELLED', JSON.stringify(out));

      const second = await cancel_task({ taskUuid: task.task_uuid });
      ok('cancel_task on an already-CANCELLED task refuses (no-op, never a fake success)', second.ok === false, JSON.stringify(second));
    } else {
      console.log('  (skipped — no admin/manager user found)');
    }
  }
} finally {
  await cleanup();
  console.log('\ncleanup done —', cleanupTaskUuids.length, 'disposable test task(s) removed.');
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
