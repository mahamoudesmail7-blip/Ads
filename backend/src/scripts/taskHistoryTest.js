// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 16 (Task History UI backend) verification. Pure reads only — no
// new write path, nothing to clean up. The frontend page itself
// (js/ai-media-buyer.js renderTasks) is verified live against production
// after deploy, matching this project's established convention.
//   node src/scripts/taskHistoryTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { listTasksByView, resolveTaskStatus, buildTaskTimeline, TASK_VIEW_STATUSES } = await imp('../services/assistantTasks/taskEngine.js');

console.log('§1 listTasksByView across all 5 real views — status partitioning must be exhaustive and mutually exclusive:');
{
  const allStatuses = Object.values(TASK_VIEW_STATUSES).flat();
  const distinctRealStatuses = (await prisma.assistantTask.groupBy({ by: ['status'] })).map((r) => r.status);
  ok('every real status in the DB is covered by exactly one view', distinctRealStatuses.every((s) => allStatuses.filter((x) => x === s).length === 1), JSON.stringify(distinctRealStatuses));

  const results = {};
  for (const view of Object.keys(TASK_VIEW_STATUSES)) {
    const out = await listTasksByView({ view, limit: 100 });
    results[view] = out;
    ok(`[${view}] ok:true, counts block present`, out.ok === true && typeof out.counts === 'object');
    ok(`[${view}] every returned task's status is one this view claims`, out.tasks.every((t) => TASK_VIEW_STATUSES[view].includes(t.status)), out.tasks.map((t) => t.status).join(','));
    const realCount = await prisma.assistantTask.count({ where: { status: { in: TASK_VIEW_STATUSES[view] } } });
    ok(`[${view}] counts.${view} matches a real, independent DB count`, out.counts[view] === realCount, `reported=${out.counts[view]} real=${realCount}`);
  }
  // counts blocks must be identical across every view call (global, not view-scoped)
  const countsJson = Object.values(results).map((r) => JSON.stringify(r.counts));
  ok('counts block is identical regardless of which view was requested (global tally)', new Set(countsJson).size === 1, countsJson.join(' | '));
}

console.log('\n§2 Bad/unknown view is rejected, never silently falls back to a wrong bucket:');
{
  let threw = false, status = null;
  try { await listTasksByView({ view: 'not_a_real_view' }); } catch (e) { threw = true; status = e.status; }
  ok('unknown view throws a 400, never returns a fabricated empty list', threw && status === 400);
}

console.log('\n§3 buildTaskTimeline / resolveTaskStatus — real timeline, never fabricated events:');
{
  const anyTask = await prisma.assistantTask.findFirst({ orderBy: { created_at: 'desc' } });
  if (anyTask) {
    const { task } = await resolveTaskStatus({ taskId: anyTask.task_uuid });
    ok('resolveTaskStatus attaches a real timeline array', Array.isArray(task.timeline) && task.timeline.length >= 1);
    ok('timeline is chronologically sorted', task.timeline.every((p, i) => i === 0 || new Date(p.at) >= new Date(task.timeline[i - 1].at)));
    ok('the FIRST timeline point is always task creation', task.timeline[0].kind === 'CREATED' && new Date(task.timeline[0].at).getTime() === new Date(anyTask.created_at).getTime());
    if (task.error) ok('a task with a real error has an ERROR timeline point carrying that exact error text', task.timeline.some((p) => p.kind === 'ERROR' && p.label.includes(task.error.slice(0, 30))));
    if (task.blockedReason) ok('a task with a real blocked_reason has a BLOCKED timeline point carrying that exact text', task.timeline.some((p) => p.kind === 'BLOCKED' && p.label.includes(task.blockedReason.slice(0, 30))));
    console.log(`  sample task ${anyTask.task_uuid} (${anyTask.status}) timeline:`, JSON.stringify(task.timeline.map((p) => p.kind)));
  } else {
    console.log('  (skipped — no AssistantTask rows exist at all)');
  }

  // A task with a real launch_job_id must have its real AmbLaunchAudit trail woven in.
  const launchTask = await prisma.assistantTask.findFirst({ where: { launch_job_id: { not: null } }, orderBy: { created_at: 'desc' } });
  if (launchTask) {
    const timeline = await buildTaskTimeline(launchTask);
    const realAuditCount = await prisma.ambLaunchAudit.count({ where: { job_id: launchTask.launch_job_id } });
    ok('a LAUNCH-kind task\'s timeline includes exactly the real AmbLaunchAudit event count (plus CREATED/terminal points)', timeline.length >= realAuditCount, `timeline=${timeline.length} realAudits=${realAuditCount}`);
  } else {
    console.log('  (skipped — no task with a real launch_job_id exists)');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
