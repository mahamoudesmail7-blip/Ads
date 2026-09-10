// AI Media Buyer — ADVANCED CAMPAIGN SCHEDULING.
//
// A "copied campaign" (an AmbCloneJob that reached CLONED_PAUSED / ACTIVATED)
// stays PAUSED after the copy. The owner then configures exactly WHEN it runs:
//
//   RUN_NOW        — start immediately (after approval)
//   START_AT       — start at a specific local date/time
//   START_NO_END   — start at a specific time, no automatic stop
//   START_AND_END  — start and stop at specific local date/times
//
// Rules honoured verbatim from the spec:
//   • Scheduling ALWAYS requires the owner's explicit approval. Nothing is
//     activated before approval.
//   • The approval authorizes BOTH the future start and the future end. There
//     is no second approval at execution time — but the executor revalidates
//     the LIVE Meta state and refuses (status NEEDS_INTERVENTION) if the copied
//     campaign changed, vanished, or is unsafe to touch.
//   • Execution is 100% server-side (cloneScheduler.js 60s tick). It keeps
//     working with the browser closed / user logged out / computer off.
//   • Times are stored as UTC instants. The owner's wall-clock + IANA timezone
//     (default Africa/Cairo) are kept for display and DST-correct re-derivation.
//   • Any material edit before start returns the schedule to PENDING_APPROVAL.
//   • Full audit: who created, who approved, when, the window, actual start /
//     stop instants, the Meta responses, every edit, every cancellation and
//     every failure.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection, getDecryptedToken } from '../metaAuth.js';
import { setEntityStatus, getEntityLive, setAdSetSchedule } from '../metaGraphClient.js';
import { getAmbSettings } from './settings.js';
import { raiseAlert } from './alerts.js';

const DEFAULT_TZ = 'Africa/Cairo';
const SOON_MS = 15 * 60 * 1000; // "تبدأ قريباً" / "تنتهي قريباً" window
const MODES = new Set(['RUN_NOW', 'START_AT', 'START_NO_END', 'START_AND_END']);
const EDITABLE = new Set(['PENDING_APPROVAL', 'SCHEDULED', 'NEEDS_INTERVENTION']);
const ACTIVE_STATUSES = new Set(['PENDING_APPROVAL', 'SCHEDULED', 'RUNNING', 'NEEDS_INTERVENTION']);
const running = new Set(); // schedule ids with an in-flight execute()

function j(v, d = null) { try { return v ? JSON.parse(v) : d; } catch { return d; } }
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz || '' }); return !!tz; } catch { return false; } }

// ---------------------------------------------------------------------------
// Timezone: a local wall-clock (YYYY-MM-DD + HH:MM) in an IANA zone → UTC.
// ---------------------------------------------------------------------------
function tzOffsetMs(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}
/** UTC Date for `dateStr`T`timeStr` interpreted as wall-clock in `timeZone`. DST-correct (offset re-resolved at the target instant). */
export function localDateTimeToUtc(dateStr, timeStr, timeZone) {
  const tz = validTz(timeZone) ? timeZone : DEFAULT_TZ;
  const [y, mo, d] = String(dateStr || '').split('-').map((x) => parseInt(x, 10));
  const [hh, mm] = String(timeStr || '00:00').split(':').map((x) => parseInt(x, 10) || 0);
  if (!y || !mo || !d) throw badReq('تاريخ غير صالح — استخدم صيغة YYYY-MM-DD.');
  const naiveUTC = Date.UTC(y, mo - 1, d, hh, mm, 0);
  let utc = new Date(naiveUTC - tzOffsetMs(new Date(naiveUTC), tz));
  const off2 = tzOffsetMs(utc, tz);
  utc = new Date(naiveUTC - off2);
  return utc;
}

function badReq(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

// ---------------------------------------------------------------------------
// Arabic display helpers
// ---------------------------------------------------------------------------
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
export function fmtLocalAr(instant, timeZone) {
  if (!instant) return null;
  const tz = validTz(timeZone) ? timeZone : DEFAULT_TZ;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(instant)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  let h = +p.hour % 24;
  const ampm = h < 12 ? 'ص' : 'م';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${+p.day} ${AR_MONTHS[+p.month - 1]} ${p.year} — ${h12}:${p.minute} ${ampm}`;
}
export function humanizeDurationAr(ms) {
  if (ms == null) return null;
  let s = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(s / 86400); s -= days * 86400;
  const hours = Math.floor(s / 3600); s -= hours * 3600;
  const mins = Math.floor(s / 60);
  const parts = [];
  const dW = days === 1 ? 'يوم واحد' : days === 2 ? 'يومان' : days >= 3 && days <= 10 ? `${days} أيام` : days > 10 ? `${days} يومًا` : null;
  const hW = hours === 1 ? 'ساعة واحدة' : hours === 2 ? 'ساعتان' : hours >= 3 && hours <= 10 ? `${hours} ساعات` : hours > 10 ? `${hours} ساعة` : null;
  const mW = mins === 1 ? 'دقيقة واحدة' : mins === 2 ? 'دقيقتان' : mins >= 3 && mins <= 10 ? `${mins} دقائق` : mins > 10 ? `${mins} دقيقة` : null;
  if (dW) parts.push(dW);
  if (hW) parts.push(hW);
  if (mW && days === 0) parts.push(mW); // omit minutes when we're already talking days
  if (!parts.length) return 'أقل من دقيقة';
  return parts.join(' و');
}

// ---------------------------------------------------------------------------
// Audit (reuses the append-only amb_clone_audit table)
// ---------------------------------------------------------------------------
async function audit(batchId, jobId, event, { detail, data, actorId } = {}) {
  try {
    await prisma.ambCloneAudit.create({
      data: {
        batch_id: batchId, job_id: jobId || null, event,
        detail: detail ? String(detail).slice(0, 900) : null,
        data_json: data ? JSON.stringify(data).slice(0, 4000) : null,
        actor_id: actorId || null,
      },
    });
  } catch (e) { logger.warn('AMB schedule audit write failed', { message: e.message }); }
}

function appendEdit(row, edit) {
  const arr = j(row.edits_json, []) || [];
  arr.push({ at: new Date().toISOString(), ...edit });
  return JSON.stringify(arr).slice(0, 8000);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export async function createSchedule({
  cloneJobId, mode, timezone = DEFAULT_TZ,
  startDate, startTime, endDate, endTime,
  userId,
}) {
  if (!MODES.has(mode)) throw badReq('نوع الجدولة غير معروف.');
  const tz = validTz(timezone) ? timezone : DEFAULT_TZ;
  const job = await prisma.ambCloneJob.findUnique({ where: { id: Number(cloneJobId) }, include: { batch: true } });
  if (!job) throw badReq('الحملة المنسوخة مش موجودة.', 404);
  if (!['CLONED_PAUSED', 'ACTIVATION_FAILED', 'ACTIVATED'].includes(job.status)) {
    throw badReq(`لا يمكن جدولة حملة حالتها ${job.status} — لازم تكون اتنسخت (متوقفة) بنجاح.`);
  }
  if (job.batch?.status === 'CANCELLED') throw badReq('دفعة النسخ اتلغت.');

  const existing = await prisma.ambCampaignSchedule.findFirst({
    where: { clone_job_id: job.id, status: { in: [...ACTIVE_STATUSES] } },
  });
  if (existing) throw badReq('فيه جدولة شغالة للحملة دي بالفعل — عدّلها أو ألغِها الأول.', 409);

  const now = new Date();
  let startAt; let endAt = null; let startLocal = null; let endLocal = null;
  if (mode === 'RUN_NOW') {
    startAt = now;
  } else {
    if (!startDate || !startTime) throw badReq('حدّد تاريخ ووقت التشغيل.');
    startAt = localDateTimeToUtc(startDate, startTime, tz);
    startLocal = `${startDate} ${startTime}`;
  }
  if (mode === 'START_AND_END') {
    if (!endDate || !endTime) throw badReq('حدّد تاريخ ووقت الإيقاف، أو اختر "تشغيل بدون وقت إيقاف".');
    endAt = localDateTimeToUtc(endDate, endTime, tz);
    endLocal = `${endDate} ${endTime}`;
    if (endAt.getTime() <= startAt.getTime()) throw badReq('وقت الإيقاف لازم يكون بعد وقت التشغيل.');
  }

  const row = await prisma.ambCampaignSchedule.create({
    data: {
      clone_job_id: job.id,
      batch_id: job.batch_id,
      destination_ad_account_id: job.destination_ad_account_id,
      destination_account_name: job.destination_account_name,
      source_account_name: job.batch?.source_ad_account_name || job.source_ad_account_id,
      destination_campaign_id: job.destination_campaign_id,
      campaign_name: job.source_campaign_name,
      mode, timezone: tz,
      start_at: startAt, end_at: endAt, start_local: startLocal, end_local: endLocal,
      status: 'PENDING_APPROVAL', approval_required: true,
      created_by_id: userId || null,
    },
  });
  await audit(job.batch_id, job.id, 'SCHEDULE_CREATED', {
    actorId: userId,
    detail: `جدولة (${mode}) — تشغيل ${fmtLocalAr(startAt, tz)}${endAt ? ` · إيقاف ${fmtLocalAr(endAt, tz)}` : ' · بدون إيقاف تلقائي'} — بانتظار الموافقة.`,
    data: { scheduleId: row.id, mode, timezone: tz, startAt: startAt.toISOString(), endAt: endAt?.toISOString() || null },
  });
  return getSchedule(row.id);
}

// ---------------------------------------------------------------------------
// Approve — authorizes the future start AND end. Fires an immediate start when
// the start instant is already due.
// ---------------------------------------------------------------------------
export async function approveSchedule({ id, userId }) {
  const row = await prisma.ambCampaignSchedule.findUnique({ where: { id: Number(id) } });
  if (!row) throw badReq('الجدولة مش موجودة.', 404);
  if (row.status === 'CANCELLED') throw badReq('الجدولة ملغاة.', 409);
  if (!['PENDING_APPROVAL', 'NEEDS_INTERVENTION'].includes(row.status)) throw badReq(`الجدولة حالتها ${row.status} — مش محتاجة موافقة.`, 409);

  const settings = await getAmbSettings();
  if (settings.ambExecutionMode === 'ADVISORY') throw badReq('النظام في وضع "استشاري فقط" — غيّر الوضع من الإعدادات قبل جدولة تنفيذ فعلي.', 403);

  await prisma.ambCampaignSchedule.update({
    where: { id: row.id },
    data: { status: 'SCHEDULED', approval_required: false, approved_by_id: userId || null, approved_at: new Date(), intervention_reason: null, last_error: null },
  });
  await audit(row.batch_id, row.clone_job_id, 'SCHEDULE_APPROVED', {
    actorId: userId,
    detail: `تمت الموافقة على الجدولة — تشغيل ${fmtLocalAr(row.start_at, row.timezone)}${row.end_at ? ` · إيقاف ${fmtLocalAr(row.end_at, row.timezone)}` : ' · بدون إيقاف تلقائي'}. التشغيل والإيقاف مصرّح بهما.`,
  });

  // Start instant already reached (RUN_NOW or a past START_AT) → don't wait for the tick.
  if (row.start_at.getTime() <= Date.now()) {
    kick(row.id, 'START');
  } else if (settings.ambCloneNativeSchedule === true) {
    // OPT-IN native Meta scheduling: stamp the destination ad sets with the
    // approved start instant and activate campaign → ad sets → ads NOW so Meta
    // reviews the ads immediately and holds ALL delivery (zero spend) until
    // start_at. The tick's execute('START') at start_at then only revalidates.
    await preStageNativeStart(row, userId).catch((e) => logger.warn('AMB schedule native pre-stage failed', { id: row.id, message: e.message }));
  }
  return getSchedule(row.id);
}

/** Native pre-stage for a future-dated schedule: set ad-set start_time and flip
 *  campaign → ad sets → ads ACTIVE so Meta reviews now, zero spend until start. */
async function preStageNativeStart(row, actorId) {
  const settings = await getAmbSettings();
  if (settings.ambExecutionMode === 'ADVISORY') return;
  const conn = await getConnection();
  if (!conn || conn.status !== 'CONNECTED') return;
  const job = await prisma.ambCloneJob.findUnique({ where: { id: row.clone_job_id } });
  const destCampaignId = row.destination_campaign_id || job?.destination_campaign_id || null;
  if (!destCampaignId || !job) return;
  const idMap = j(job.id_map_json, {}) || {};
  const adsetIds = Object.values(idMap.adsets || {});
  const adIds = Object.values(idMap.ads || {});
  const token = await getDecryptedToken();
  const startIso = row.start_at.toISOString();
  const endIso = row.end_at ? row.end_at.toISOString() : null;

  const errs = [];
  for (const asId of adsetIds) {
    try { await setAdSetSchedule(token, asId, { startTime: startIso, endTime: endIso }); }
    catch (e) { errs.push(`start_time ${asId}: ${e.message}`); }
  }
  // top-down activate so a child is never ACTIVE under a paused parent
  for (const id of [destCampaignId, ...adsetIds, ...adIds]) {
    try { await setEntityStatus(token, id, 'ACTIVE'); }
    catch (e) { errs.push(`activate ${id}: ${e.message}`); }
  }
  await prisma.ambCampaignSchedule.update({
    where: { id: row.id },
    data: { start_meta_response_json: JSON.stringify({ nativePrestaged: true, at: new Date().toISOString(), startTime: startIso, endTime: endIso, errors: errs }).slice(0, 4000) },
  });
  await audit(row.batch_id, row.clone_job_id, 'SCHEDULE_NATIVE_PRESTAGE', {
    actorId,
    detail: errs.length
      ? `تجهيز جدولة Meta الأصلية مع ${errs.length} خطأ: ${errs[0]}`
      : `تم ضبط start_time=${startIso} على ${adsetIds.length} مجموعة وتفعيل الحملة/المجموعات/الإعلانات — Meta يراجع الآن ولا صرف قبل الموعد.`,
    data: { startTime: startIso, endTime: endIso, adsets: adsetIds.length, ads: adIds.length, errors: errs },
  });
  if (errs.length) {
    await raiseAlert({
      severity: 'WARNING', category: 'EXECUTION',
      title: `تجهيز جدولة Meta الأصلية جزئي: ${row.campaign_name || destCampaignId}`,
      message: errs[0], dedupeKey: `sched-native-prestage:${row.id}`,
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Edit (before start) — a material change re-arms approval.
// ---------------------------------------------------------------------------
export async function editSchedule({ id, mode, timezone, startDate, startTime, endDate, endTime, removeEnd, userId }) {
  const row = await prisma.ambCampaignSchedule.findUnique({ where: { id: Number(id) } });
  if (!row) throw badReq('الجدولة مش موجودة.', 404);
  if (!EDITABLE.has(row.status)) throw badReq(`لا يمكن تعديل جدولة حالتها ${row.status} (بدأت بالفعل أو انتهت).`, 409);

  const tz = timezone !== undefined ? (validTz(timezone) ? timezone : DEFAULT_TZ) : row.timezone;
  const nextMode = mode || row.mode;
  if (!MODES.has(nextMode)) throw badReq('نوع الجدولة غير معروف.');

  let startAt = row.start_at; let startLocal = row.start_local;
  let endAt = row.end_at; let endLocal = row.end_local;

  if (nextMode === 'RUN_NOW') { startAt = new Date(); startLocal = null; }
  else if (startDate && startTime) { startAt = localDateTimeToUtc(startDate, startTime, tz); startLocal = `${startDate} ${startTime}`; }
  else if (timezone !== undefined && row.start_local) {
    const [d, t] = row.start_local.split(' '); startAt = localDateTimeToUtc(d, t, tz); startLocal = row.start_local;
  }

  if (removeEnd || nextMode === 'START_NO_END' || nextMode === 'START_AT' || nextMode === 'RUN_NOW') {
    endAt = null; endLocal = null;
  } else if (endDate && endTime) {
    endAt = localDateTimeToUtc(endDate, endTime, tz); endLocal = `${endDate} ${endTime}`;
  } else if (timezone !== undefined && row.end_local) {
    const [d, t] = row.end_local.split(' '); endAt = localDateTimeToUtc(d, t, tz); endLocal = row.end_local;
  }
  if (endAt && endAt.getTime() <= startAt.getTime()) throw badReq('وقت الإيقاف لازم يكون بعد وقت التشغيل.');

  const material = startAt.getTime() !== row.start_at.getTime()
    || (endAt ? endAt.getTime() : null) !== (row.end_at ? row.end_at.getTime() : null)
    || tz !== row.timezone || nextMode !== row.mode;

  const edits_json = appendEdit(row, {
    byId: userId || null,
    from: { mode: row.mode, tz: row.timezone, startAt: row.start_at.toISOString(), endAt: row.end_at?.toISOString() || null },
    to: { mode: nextMode, tz, startAt: startAt.toISOString(), endAt: endAt?.toISOString() || null },
    material,
  });

  // A material edit un-approves the schedule. If it was already native
  // pre-staged (ACTIVE, holding on the old start_time), pull it back to PAUSED
  // so a stale start_time can't fire before the owner re-approves.
  if (material) await revertNativePrestage(row, 'تعديل جوهري على الجدولة', userId);

  await prisma.ambCampaignSchedule.update({
    where: { id: row.id },
    data: {
      mode: nextMode, timezone: tz, start_at: startAt, end_at: endAt, start_local: startLocal, end_local: endLocal,
      edits_json,
      ...(material ? { status: 'PENDING_APPROVAL', approval_required: true, approved_at: null, approved_by_id: null, intervention_reason: null, last_error: null, start_meta_response_json: null } : {}),
    },
  });
  await audit(row.batch_id, row.clone_job_id, 'SCHEDULE_EDITED', {
    actorId: userId,
    detail: material
      ? `تعديل جوهري على الجدولة — رجعت لـ "بانتظار الموافقة". تشغيل ${fmtLocalAr(startAt, tz)}${endAt ? ` · إيقاف ${fmtLocalAr(endAt, tz)}` : ' · بدون إيقاف تلقائي'}.`
      : 'تعديل غير جوهري على الجدولة.',
  });
  return getSchedule(row.id);
}

/** Undo a native pre-stage: pause campaign → ad sets → ads back down so nothing
 *  delivers at the (now stale/cancelled) start_time. Best-effort. */
async function revertNativePrestage(row, reason, actorId) {
  const pre = j(row.start_meta_response_json, {}) || {};
  if (pre.nativePrestaged !== true) return;
  try {
    const conn = await getConnection();
    if (!conn || conn.status !== 'CONNECTED') return;
    const job = await prisma.ambCloneJob.findUnique({ where: { id: row.clone_job_id } });
    const destCampaignId = row.destination_campaign_id || job?.destination_campaign_id || null;
    if (!destCampaignId || !job) return;
    const idMap = j(job.id_map_json, {}) || {};
    const token = await getDecryptedToken();
    // ads → ad sets → campaign (bottom-up on the way down)
    for (const id of [...Object.values(idMap.ads || {}), ...Object.values(idMap.adsets || {}), destCampaignId]) {
      try { await setEntityStatus(token, id, 'PAUSED'); } catch { /* best-effort */ }
    }
    await audit(row.batch_id, row.clone_job_id, 'SCHEDULE_NATIVE_REVERT', { actorId, detail: `${reason} — أُعيدت الحملة/المجموعات/الإعلانات إلى PAUSED.` });
  } catch (e) { logger.warn('AMB schedule native revert failed', { id: row.id, message: e.message }); }
}

// ---------------------------------------------------------------------------
// Cancel (before start) — campaign stays PAUSED.
// ---------------------------------------------------------------------------
export async function cancelSchedule({ id, userId }) {
  const row = await prisma.ambCampaignSchedule.findUnique({ where: { id: Number(id) } });
  if (!row) throw badReq('الجدولة مش موجودة.', 404);
  if (['CANCELLED', 'ENDED'].includes(row.status)) return getSchedule(row.id);
  if (row.status === 'RUNNING') throw badReq('الحملة شغالة — استخدم "إيقاف الآن" بدل إلغاء الجدولة.', 409);
  await revertNativePrestage(row, 'أُلغيت الجدولة', userId);
  await prisma.ambCampaignSchedule.update({
    where: { id: row.id },
    data: { status: 'CANCELLED', cancelled_by_id: userId || null, cancelled_at: new Date() },
  });
  await audit(row.batch_id, row.clone_job_id, 'SCHEDULE_CANCELLED', { actorId: userId, detail: 'أُلغيت الجدولة — الحملة تبقى متوقفة (PAUSED).' });
  return getSchedule(row.id);
}

// ---------------------------------------------------------------------------
// Manual controls — same "review → approve & execute → live revalidation →
// execute → audit" pattern. The API call itself is the approval; the service
// still revalidates the live Meta state before it writes.
// ---------------------------------------------------------------------------
export async function runNowSchedule({ id, userId }) {
  const row = await prisma.ambCampaignSchedule.findUnique({ where: { id: Number(id) } });
  if (!row) throw badReq('الجدولة مش موجودة.', 404);
  if (['CANCELLED'].includes(row.status)) throw badReq('الجدولة ملغاة.', 409);
  if (row.status === 'RUNNING') throw badReq('الحملة شغالة بالفعل.', 409);
  const settings = await getAmbSettings();
  if (settings.ambExecutionMode === 'ADVISORY') throw badReq('النظام في وضع "استشاري فقط".', 403);
  // Manual run = implicit approval + immediate start. A past/near end_at is dropped.
  const keepEnd = row.end_at && row.end_at.getTime() > Date.now() + 60_000 ? row.end_at : null;
  await prisma.ambCampaignSchedule.update({
    where: { id: row.id },
    data: {
      status: 'SCHEDULED', approval_required: false, approved_by_id: row.approved_by_id || userId || null, approved_at: row.approved_at || new Date(),
      start_at: new Date(), end_at: keepEnd, end_local: keepEnd ? row.end_local : null,
      intervention_reason: null, last_error: null,
    },
  });
  await audit(row.batch_id, row.clone_job_id, 'SCHEDULE_MANUAL_START', { actorId: userId, detail: 'طلب تشغيل الآن — سيُنفَّذ فورًا بعد إعادة التحقق من حالة Meta.' });
  await execute(row.id, 'START', userId);
  return getSchedule(row.id);
}

export async function pauseNowSchedule({ id, userId }) {
  const row = await prisma.ambCampaignSchedule.findUnique({ where: { id: Number(id) } });
  if (!row) throw badReq('الجدولة مش موجودة.', 404);
  if (['CANCELLED', 'ENDED', 'PAUSED'].includes(row.status)) throw badReq(`الجدولة حالتها ${row.status}.`, 409);
  if (!['RUNNING', 'NEEDS_INTERVENTION', 'SCHEDULED'].includes(row.status)) throw badReq(`لا يمكن الإيقاف من حالة ${row.status}.`, 409);
  const settings = await getAmbSettings();
  if (settings.ambExecutionMode === 'ADVISORY') throw badReq('النظام في وضع "استشاري فقط".', 403);
  await audit(row.batch_id, row.clone_job_id, 'SCHEDULE_MANUAL_PAUSE', { actorId: userId, detail: 'طلب إيقاف الآن — سيُنفَّذ فورًا بعد إعادة التحقق من حالة Meta.' });
  await execute(row.id, 'END', userId, { manual: true });
  return getSchedule(row.id);
}

// ---------------------------------------------------------------------------
// Server-side executor — the ONLY thing that writes to Meta for a schedule.
// ---------------------------------------------------------------------------
function kick(scheduleId, phase) {
  const key = `${scheduleId}:${phase}`;
  if (running.has(key)) return;
  running.add(key);
  setImmediate(async () => {
    try { await execute(scheduleId, phase); }
    catch (e) { logger.error('AMB schedule execute crashed', { scheduleId, phase, message: e.message }); }
    finally { running.delete(key); }
  });
}

/** phase: 'START' activates the copied campaign (+ its ad sets + ads); 'END' pauses it. */
async function execute(scheduleId, phase, actorId = null, { manual = false } = {}) {
  const key = `${scheduleId}:${phase}`;
  running.add(key);
  try {
    const row = await prisma.ambCampaignSchedule.findUnique({ where: { id: Number(scheduleId) }, include: { clone_job: { include: { batch: true } } } });
    if (!row) return;
    if (phase === 'START' && !['SCHEDULED'].includes(row.status)) return;
    if (phase === 'END' && !['RUNNING', 'NEEDS_INTERVENTION', 'SCHEDULED'].includes(row.status)) return;

    const conn = await getConnection();
    if (!conn || conn.status !== 'CONNECTED') {
      await intervene(row, 'مفيش اتصال Meta Ads — لن يُنفَّذ أي تغيير.', actorId);
      return;
    }
    const settings = await getAmbSettings();
    if (settings.ambExecutionMode === 'ADVISORY') { logger.info('AMB schedule skipped (ADVISORY)', { scheduleId }); return; }

    const job = row.clone_job;
    const batch = job?.batch;
    const destCampaignId = row.destination_campaign_id || job?.destination_campaign_id || null;

    // ---- LIVE revalidation (spec) ----
    if (batch?.status === 'CANCELLED') { await intervene(row, 'دفعة النسخ اتلغت — لن يُنفَّذ التفعيل/الإيقاف.', actorId); return; }
    if (!destCampaignId) { await intervene(row, 'الحملة المنسوخة لسه ماتكوّنتش في الحساب الوجهة.', actorId); return; }

    const token = await getDecryptedToken();
    const live = await getEntityLive(token, destCampaignId);
    if (!live) { await intervene(row, `مش لاقيين الحملة (${destCampaignId}) في Meta — يمكن تكون اتحذفت.`, actorId); return; }
    const eff = (live.effectiveStatus || live.status || '').toUpperCase();
    if (['DELETED', 'ARCHIVED', 'DISAPPROVED', 'WITH_ISSUES', 'PENDING_REVIEW'].includes(eff) && phase === 'START') {
      await intervene(row, `حالة الحملة في Meta (${eff}) لا تسمح بالتفعيل الآمن.`, actorId);
      return;
    }

    if (phase === 'START') {
      const idMap = j(job.id_map_json, {}) || {};
      const ids = [
        { level: 'CAMPAIGN', id: destCampaignId },
        ...Object.values(idMap.adsets || {}).map((id) => ({ level: 'ADSET', id })),
        ...Object.values(idMap.ads || {}).map((id) => ({ level: 'AD', id })),
      ];
      const okIds = []; const errs = [];
      // Campaign first — if it fails, this is a hard FAILED (nothing is live).
      try {
        if (eff !== 'ACTIVE') await setEntityStatus(token, destCampaignId, 'ACTIVE');
        okIds.push({ level: 'CAMPAIGN', id: destCampaignId });
      } catch (e) {
        await fail(row, `فشل تفعيل الحملة: ${e.message}`, actorId);
        return;
      }
      for (const it of ids.slice(1)) {
        try { await setEntityStatus(token, it.id, 'ACTIVE'); okIds.push(it); }
        catch (e) { errs.push(`${it.level} ${it.id}: ${e.message}`); }
      }
      await prisma.ambCampaignSchedule.update({
        where: { id: row.id },
        data: {
          status: 'RUNNING', actual_start_at: new Date(),
          start_meta_response_json: JSON.stringify({ activated: okIds, errors: errs, liveBefore: eff }).slice(0, 4000),
          last_error: errs.length ? `تم تفعيل الحملة، لكن ${errs.length} عنصر فشل: ${errs[0]}` : null,
        },
      });
      await prisma.ambCloneJob.update({ where: { id: job.id }, data: { status: 'ACTIVATED', activated_at: new Date() } }).catch(() => {});
      await audit(row.batch_id, job.id, 'SCHEDULE_START', {
        actorId,
        detail: `${manual ? '(يدوي) ' : ''}تم تفعيل الحملة المنسوخة "${row.campaign_name || destCampaignId}" في ${row.destination_account_name || row.destination_ad_account_id} — ${okIds.length} عنصر.${errs.length ? ` (${errs.length} فشل)` : ''}`,
        data: { activated: okIds.length, errors: errs },
      });
      if (errs.length) {
        await raiseAlert({
          severity: 'WARNING', category: 'EXECUTION',
          title: `تفعيل مجدول جزئي: ${row.campaign_name || destCampaignId}`,
          message: errs[0], dedupeKey: `sched-start-partial:${row.id}`,
        }).catch(() => {});
      }
      return;
    }

    // phase === 'END'
    try {
      if (eff !== 'PAUSED') await setEntityStatus(token, destCampaignId, 'PAUSED');
    } catch (e) {
      await fail(row, `فشل إيقاف الحملة: ${e.message}`, actorId);
      return;
    }
    await prisma.ambCampaignSchedule.update({
      where: { id: row.id },
      data: {
        status: manual ? 'PAUSED' : 'ENDED', actual_end_at: new Date(),
        end_meta_response_json: JSON.stringify({ paused: destCampaignId, liveBefore: eff, manual }).slice(0, 2000),
        last_error: null, intervention_reason: null,
      },
    });
    await audit(row.batch_id, job.id, 'SCHEDULE_END', {
      actorId,
      detail: `${manual ? '(يدوي) تم إيقاف' : 'انتهى وقت التشغيل — تم إيقاف'} الحملة "${row.campaign_name || destCampaignId}" في ${row.destination_account_name || row.destination_ad_account_id}.`,
    });
  } finally {
    running.delete(key);
  }
}

async function intervene(row, reason, actorId) {
  await prisma.ambCampaignSchedule.update({ where: { id: row.id }, data: { status: 'NEEDS_INTERVENTION', intervention_reason: reason } });
  await audit(row.batch_id, row.clone_job_id, 'SCHEDULE_NEEDS_INTERVENTION', { actorId, detail: `تحتاج تدخل: ${reason}` });
  await raiseAlert({
    severity: 'WARNING', category: 'EXECUTION',
    title: `جدولة تحتاج تدخل: ${row.campaign_name || row.destination_campaign_id || row.id}`,
    message: reason, dedupeKey: `sched-intervene:${row.id}`,
  }).catch(() => {});
}
async function fail(row, msg, actorId) {
  await prisma.ambCampaignSchedule.update({ where: { id: row.id }, data: { status: 'FAILED', last_error: String(msg).slice(0, 800) } });
  await audit(row.batch_id, row.clone_job_id, 'SCHEDULE_FAILED', { actorId, detail: msg });
  await raiseAlert({
    severity: 'CRITICAL', category: 'EXECUTION',
    title: `فشل تنفيذ جدولة: ${row.campaign_name || row.destination_campaign_id || row.id}`,
    message: String(msg).slice(0, 300), dedupeKey: `sched-fail:${row.id}`,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// The 60s tick entry point (cloneScheduler.js)
// ---------------------------------------------------------------------------
export async function runDueCampaignSchedules() {
  const settings = await getAmbSettings();
  if (settings.ambExecutionMode === 'ADVISORY') return { started: 0, ended: 0, skipped: 'ADVISORY' };
  const conn = await getConnection();
  if (!conn || conn.status !== 'CONNECTED') return { started: 0, ended: 0, skipped: 'NO_CONNECTION' };

  const now = new Date();
  const toStart = await prisma.ambCampaignSchedule.findMany({
    where: { status: 'SCHEDULED', approval_required: false, approved_at: { not: null }, start_at: { lte: now } },
    take: 25,
  });
  const toEnd = await prisma.ambCampaignSchedule.findMany({
    where: { status: 'RUNNING', end_at: { not: null, lte: now } },
    take: 25,
  });

  let started = 0; let ended = 0;
  for (const s of toStart) { await execute(s.id, 'START').catch((e) => logger.error('schedule start failed', { id: s.id, message: e.message })); started++; }
  for (const s of toEnd) { await execute(s.id, 'END').catch((e) => logger.error('schedule end failed', { id: s.id, message: e.message })); ended++; }
  if (started || ended) logger.info('AMB campaign schedules executed', { started, ended });
  return { started, ended };
}

/** True when a clone job has a schedule that owns its activation (so the legacy batch-time activateDueJobs must not race it). */
export async function jobHasActiveSchedule(cloneJobId) {
  const n = await prisma.ambCampaignSchedule.count({
    where: { clone_job_id: Number(cloneJobId), status: { in: ['PENDING_APPROVAL', 'SCHEDULED', 'RUNNING', 'NEEDS_INTERVENTION', 'PAUSED', 'ENDED'] } },
  });
  return n > 0;
}

/** Cancel every non-terminal schedule under a clone batch (called when the batch is cancelled). */
export async function cancelSchedulesForBatch(batchId, userId) {
  const rows = await prisma.ambCampaignSchedule.findMany({ where: { batch_id: batchId, status: { in: ['PENDING_APPROVAL', 'SCHEDULED', 'NEEDS_INTERVENTION'] } } });
  for (const r of rows) {
    await prisma.ambCampaignSchedule.update({ where: { id: r.id }, data: { status: 'CANCELLED', cancelled_by_id: userId || null, cancelled_at: new Date() } });
    await audit(batchId, r.clone_job_id, 'SCHEDULE_CANCELLED', { actorId: userId, detail: 'أُلغيت الجدولة تبعًا لإلغاء دفعة النسخ.' });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------
export function displayStatus(row, now = Date.now()) {
  if (row.status === 'SCHEDULED') {
    if (row.start_at && row.start_at.getTime() - now <= SOON_MS && row.start_at.getTime() - now > -SOON_MS) return 'STARTING_SOON';
    return 'SCHEDULED';
  }
  if (row.status === 'RUNNING') {
    if (row.end_at && row.end_at.getTime() - now <= SOON_MS) return 'ENDING_SOON';
    return 'RUNNING';
  }
  return row.status;
}

async function serialize(row, userNames) {
  const now = Date.now();
  const nm = (id) => (id && userNames.get(id)) || null;
  return {
    id: row.id,
    cloneJobId: row.clone_job_id,
    batchId: row.batch_id,
    campaignName: row.campaign_name,
    destinationCampaignId: row.destination_campaign_id,
    destinationAccountId: row.destination_ad_account_id,
    destinationAccountName: row.destination_account_name,
    sourceAccountName: row.source_account_name,
    mode: row.mode,
    timezone: row.timezone,
    startAt: row.start_at?.toISOString() || null,
    endAt: row.end_at?.toISOString() || null,
    startLocalText: fmtLocalAr(row.start_at, row.timezone),
    endLocalText: row.end_at ? fmtLocalAr(row.end_at, row.timezone) : null,
    noAutoEnd: !row.end_at,
    durationText: row.end_at ? humanizeDurationAr(row.end_at.getTime() - row.start_at.getTime()) : null,
    status: row.status,
    displayStatus: displayStatus(row, now),
    approvalRequired: row.approval_required,
    approved: !!row.approved_at,
    approvedByName: nm(row.approved_by_id),
    createdByName: nm(row.created_by_id),
    cancelledByName: nm(row.cancelled_by_id),
    approvedAt: row.approved_at?.toISOString() || null,
    cancelledAt: row.cancelled_at?.toISOString() || null,
    actualStartAt: row.actual_start_at?.toISOString() || null,
    actualEndAt: row.actual_end_at?.toISOString() || null,
    actualStartText: row.actual_start_at ? fmtLocalAr(row.actual_start_at, row.timezone) : null,
    actualEndText: row.actual_end_at ? fmtLocalAr(row.actual_end_at, row.timezone) : null,
    startsInMs: row.status === 'SCHEDULED' && row.start_at ? row.start_at.getTime() - now : null,
    endsInMs: row.status === 'RUNNING' && row.end_at ? row.end_at.getTime() - now : null,
    interventionReason: row.intervention_reason,
    lastError: row.last_error,
    edits: j(row.edits_json, []) || [],
    nativePrestaged: (j(row.start_meta_response_json, {}) || {}).nativePrestaged === true,
    startMetaResponse: j(row.start_meta_response_json, null),
    endMetaResponse: j(row.end_meta_response_json, null),
    createdAt: row.created_at?.toISOString() || null,
    updatedAt: row.updated_at?.toISOString() || null,
  };
}

async function withUserNames(rows) {
  const ids = [...new Set(rows.flatMap((r) => [r.created_by_id, r.approved_by_id, r.cancelled_by_id]).filter(Boolean))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  return new Map(users.map((u) => [u.id, u.name]));
}

export async function getSchedule(id) {
  const row = await prisma.ambCampaignSchedule.findUnique({ where: { id: Number(id) } });
  if (!row) throw badReq('الجدولة مش موجودة.', 404);
  const names = await withUserNames([row]);
  return serialize(row, names);
}

export async function listSchedules({ batchId, status, cloneJobId, includeTerminal = true, limit = 100 } = {}) {
  const where = {};
  if (batchId) where.batch_id = batchId;
  if (cloneJobId) where.clone_job_id = Number(cloneJobId);
  if (status) where.status = status;
  if (!includeTerminal) where.status = { notIn: ['CANCELLED', 'ENDED'] };
  const rows = await prisma.ambCampaignSchedule.findMany({ where, orderBy: [{ status: 'asc' }, { start_at: 'asc' }], take: Math.min(limit, 300) });
  const names = await withUserNames(rows);
  return Promise.all(rows.map((r) => serialize(r, names)));
}

/** Pending-approval schedules — for the dashboard "بانتظار موافقتك" area. */
export async function listPendingApprovalSchedules() {
  return listSchedules({ status: 'PENDING_APPROVAL' });
}
