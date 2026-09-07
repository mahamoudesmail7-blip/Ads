// Self-contained lifecycle test for campaignSchedule.js. Creates a SYNTHETIC
// clone batch + job (CLONED_PAUSED, fake Meta ids) so no real Meta write ever
// happens, exercises create → approve → edit(re-approval) → cancel + the pure
// timezone/format helpers + the tick gating, then deletes everything it made.
//   node src/scripts/scheduleSelfTest.js
import 'dotenv/config';
import { prisma } from '../prisma.js';
import * as S from '../services/amb/campaignSchedule.js';

const TAG = `selftest-${Date.now()}`;
let batchId; let jobId; const madeScheduleIds = [];
function ok(name, cond, extra = '') { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!cond) process.exitCode = 1; }

try {
  // ---- pure helpers ----
  // Egypt observes DST (≈ last Fri Apr → last Thu Oct): September is UTC+3, January is UTC+2.
  const utc = S.localDateTimeToUtc('2026-09-08', '09:00', 'Africa/Cairo');
  ok('localDateTimeToUtc Cairo summer 09:00 → 06:00Z (DST, +3)', utc.toISOString() === '2026-09-08T06:00:00.000Z', utc.toISOString());
  const utcWinter = S.localDateTimeToUtc('2026-01-08', '09:00', 'Africa/Cairo');
  ok('localDateTimeToUtc Cairo winter 09:00 → 07:00Z (+2)', utcWinter.toISOString() === '2026-01-08T07:00:00.000Z', utcWinter.toISOString());
  ok('fmtLocalAr', /سبتمبر 2026 —/.test(S.fmtLocalAr(utc, 'Africa/Cairo')), S.fmtLocalAr(utc, 'Africa/Cairo'));
  ok('humanizeDurationAr 2d14h30m', S.humanizeDurationAr(((2 * 24 + 14) * 60 + 30) * 60 * 1000) === 'يومان و14 ساعة', S.humanizeDurationAr(((2 * 24 + 14) * 60 + 30) * 60 * 1000));
  ok('humanizeDurationAr 90m', S.humanizeDurationAr(90 * 60 * 1000) === 'ساعة واحدة و30 دقيقة', S.humanizeDurationAr(90 * 60 * 1000));

  // ---- synthetic batch + job ----
  batchId = `${TAG}-batch`;
  await prisma.ambCloneBatch.create({ data: {
    batch_id: batchId, source_ad_account_id: 'act_SELFTEST_SRC', source_ad_account_name: 'SelfTest Source',
    destination_account_ids_json: '["act_SELFTEST_DST"]', campaign_ids_json: '["cmp_src"]', total_copies: 1, status: 'SCHEDULED',
  } });
  const job = await prisma.ambCloneJob.create({ data: {
    batch_id: batchId, source_ad_account_id: 'act_SELFTEST_SRC', destination_ad_account_id: 'act_SELFTEST_DST',
    destination_account_name: 'SelfTest Dest', destination_timezone: 'Africa/Cairo',
    source_campaign_id: 'cmp_src', source_campaign_name: 'SelfTest Campaign', destination_campaign_id: 'cmp_dst_fake',
    status: 'CLONED_PAUSED', preflight_status: 'READY',
    id_map_json: JSON.stringify({ campaigns: { cmp_src: 'cmp_dst_fake' }, adsets: { as_src: 'as_dst_fake' }, ads: { ad_src: 'ad_dst_fake' } }),
  } });
  jobId = job.id;

  // ---- create (START_AND_END, future) ----
  const s1 = await S.createSchedule({ cloneJobId: jobId, mode: 'START_AND_END', timezone: 'Africa/Cairo', startDate: '2026-12-01', startTime: '09:00', endDate: '2026-12-03', endTime: '23:30', userId: null });
  madeScheduleIds.push(s1.id);
  ok('createSchedule → PENDING_APPROVAL', s1.status === 'PENDING_APPROVAL' && s1.approvalRequired === true);
  ok('createSchedule duration text', s1.durationText === 'يومان و14 ساعة', s1.durationText);
  ok('createSchedule start text', /1 ديسمبر 2026 — 9:00 ص/.test(s1.startLocalText), s1.startLocalText);
  ok('createSchedule not approved', s1.approved === false);

  // ---- duplicate active schedule rejected ----
  let dup = false;
  try { await S.createSchedule({ cloneJobId: jobId, mode: 'RUN_NOW', userId: null }); } catch (e) { dup = /جدولة شغالة/.test(e.message); }
  ok('second active schedule rejected', dup);

  // ---- approve ----
  const s2 = await S.approveSchedule({ id: s1.id, userId: null });
  ok('approveSchedule → SCHEDULED + approved', s2.status === 'SCHEDULED' && s2.approved === true && s2.approvalRequired === false);

  // ---- edit (material) → back to PENDING_APPROVAL ----
  const s3 = await S.editSchedule({ id: s1.id, startDate: '2026-12-02', startTime: '10:00', userId: null });
  ok('material edit → PENDING_APPROVAL again', s3.status === 'PENDING_APPROVAL' && s3.approvalRequired === true && s3.approved === false);
  ok('edit recorded in history', (s3.edits || []).length === 1 && s3.edits[0].material === true);

  // ---- tick must NOT act on an unapproved schedule ----
  const tick1 = await S.runDueCampaignSchedules();
  ok('tick ignores unapproved schedule', tick1.started === 0);

  // ---- re-approve, then cancel ----
  await S.approveSchedule({ id: s1.id, userId: null });
  const s4 = await S.cancelSchedule({ id: s1.id, userId: null });
  ok('cancelSchedule → CANCELLED', s4.status === 'CANCELLED');

  // ---- after cancel a new schedule is allowed ----
  const s5 = await S.createSchedule({ cloneJobId: jobId, mode: 'START_NO_END', timezone: 'Africa/Cairo', startDate: '2026-12-10', startTime: '08:00', userId: null });
  madeScheduleIds.push(s5.id);
  ok('new schedule allowed after cancel', s5.status === 'PENDING_APPROVAL' && s5.noAutoEnd === true);

  // ---- listSchedules + jobHasActiveSchedule ----
  const list = await S.listSchedules({ batchId });
  ok('listSchedules returns all', list.length === 2);
  ok('jobHasActiveSchedule true', (await S.jobHasActiveSchedule(jobId)) === true);

  // ---- cancelSchedulesForBatch ----
  const n = await S.cancelSchedulesForBatch(batchId, null);
  ok('cancelSchedulesForBatch cancelled the pending one', n === 1);

  console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
} catch (e) {
  console.error('THREW:', e);
  process.exitCode = 1;
} finally {
  // cleanup
  try {
    await prisma.ambCampaignSchedule.deleteMany({ where: { batch_id: batchId } });
    await prisma.ambCloneAudit.deleteMany({ where: { batch_id: batchId } });
    await prisma.ambCloneObjectMap.deleteMany({ where: { batch_id: batchId } });
    await prisma.ambCloneJob.deleteMany({ where: { batch_id: batchId } });
    await prisma.ambCloneBatch.deleteMany({ where: { batch_id: batchId } });
    console.log('cleanup done');
  } catch (e) { console.error('cleanup failed', e.message); }
  process.exit(process.exitCode || 0);
}
