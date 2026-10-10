// 🛡️ The GLOBAL write guard (Emergency Stop + deployment write-lock) on EVERY path that reaches Meta — Clone, Launch, campaign schedules, uploads — Neon TEST database + a local Meta MOCK. NO real Meta call.
//   1. evaluateGlobalWriteGuard (pure)
//   2. metaGraphClient.graphPost = the single write primitive: every create/status/budget/schedule/upload function is refused (423 MetaWriteBlockedError, ZERO requests) while the lock is closed or Emergency Stop is on
//   3. launchVideoUpload (posts to Meta directly): refused before any network call
//   4. campaign schedules: a due START / END becomes NEEDS_INTERVENTION (alert, no write, no late run); manual run/pause and an immediate approval are refused 423
//   5. clone: approve / resume refused before the batch changes state; a due activation is parked as ACTIVATION_FAILED (never fires late); with the guard open the SAME flow still works
//   6. launch: start refused before the job flips; a PUBLISHING job is parked as PARTIAL by the tick (never resumes by itself)
//   7. audit: every refusal is a WRITE_GATE_BLOCK event, de-duplicated, never containing the token
//   8. tripwires: graphPost is guarded before its fetch; no other code POSTs to the Graph API; both upload POST sites are guarded
//   node src/scripts/externalWriteGuardTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };

// ---------------------------------------------------------------- the Meta mock
const world = { entities: new Map(), log: [] };
const setEntity = (id, o = {}) => world.entities.set(id, { id, name: `mock ${id}`, status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '30000', objective: 'OUTCOME_SALES', ...o });
const requestsFor = (ids) => world.log.filter((r) => ids.includes(r.id));
const posts = () => world.log.filter((r) => r.method === 'POST');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); const id = url.pathname.split('/').filter(Boolean)[1]; let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = Object.fromEntries(new URLSearchParams(raw)); delete body.access_token; world.log.push({ method: req.method, id, body, at: Date.now() });
    const send = (code, json) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); }; const e = world.entities.get(id);
    if (req.method === 'GET') { if (e) return send(200, e); if (/^(act_|__optest_acc)/.test(id || '')) return send(200, { id, account_id: id, name: 'mock account', currency: 'EGP', timezone_name: 'Africa/Cairo', account_status: 1 }); return send(404, { error: { message: 'Unsupported get request (mock)', type: 'GraphMethodException', code: 100 } }); }
    if (req.method === 'POST') { if (!e) return send(404, { error: { message: 'Unsupported post request (mock)', type: 'GraphMethodException', code: 100 } }); if (body.status) { e.status = body.status; e.effective_status = body.status; } if (body.daily_budget) e.daily_budget = String(body.daily_budget); return send(200, { success: true, id: `${id}_new` }); }
    return send(405, {});
  });
});
await new Promise((rs) => server.listen(0, '127.0.0.1', rs));
process.env.META_GRAPH_MOCK = '1'; process.env.META_GRAPH_MOCK_URL = `http://127.0.0.1:${server.address().port}`; // BEFORE the Meta client is imported
process.env.DAILY_PLAN_DISABLE_ALERTS = '1'; process.env.LAUNCH_LANDING_VALIDATION_TEST_BYPASS = '1'; // the landing validation is another suite's subject; here only the write guard matters
const lock = (open) => { process.env.OPERATOR_ALLOW_META_WRITES = open ? 'true' : 'false'; }; // the deployment lock (a Railway variable in production); anything but the literal 'true' = locked
lock(false);
const { prisma } = await imp('../prisma.js');
const WG = await imp('../services/amb/writeGate.js'); const MC = await imp('../services/metaGraphClient.js'); const S = await imp('../services/amb/operatorStore.js');
const LB = await imp('../services/amb/launchBuilder.js'); const CS = await imp('../services/amb/campaignSchedule.js'); const CE = await imp('../services/amb/cloneEngine.js'); const LP = await imp('../services/amb/launchPublish.js'); const VU = await imp('../services/amb/launchVideoUpload.js');
const T = '__optest_'; const TOKEN = 'tok-secret-ext-1234567890'; const created = { batches: [], launchJobs: [] };
const ids = { acc: `${T}acc_ext`, camp: `${T}ext_camp` };
const stop = (on) => S.setEmergencyStop({ on, reason: on ? 'externalWriteGuardTest' : null, userId: 1 });
const blockedErr = (e) => e && e.name === 'MetaWriteBlockedError' && e.code === 'META_WRITE_BLOCKED' && e.status === 423 && e.permanent === true;
const expectBlocked = async (fn) => { try { await fn(); return { threw: false }; } catch (e) { return { threw: true, blocked: blockedErr(e), reason: e.reasonCode, e }; } };
const events = (extra = {}) => prisma.ambOperatorEvent.findMany({ where: { kind: 'WRITE_GATE_BLOCK', ...extra }, orderBy: { id: 'asc' } });
const conn = await (await imp('../services/metaAuth.js')).getConnection();
const retryDb = async (fn) => { for (let i = 0; i < 6; i++) { try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 3000)); } } return fn(); };

try {
  console.log('\n1. evaluateGlobalWriteGuard — the pure rules');
  const cfg = (o = {}) => ({ emergency_stop: false, writesLocked: false, ...o });
  ok('lock open + no Emergency Stop → allowed', WG.evaluateGlobalWriteGuard({ config: cfg() }).ok === true);
  ok('deployment lock closed → refused (META_WRITES_LOCKED)', WG.evaluateGlobalWriteGuard({ config: cfg({ writesLocked: true }) }).code === 'META_WRITES_LOCKED');
  ok('Emergency Stop → refused, and it is the primary reason', WG.evaluateGlobalWriteGuard({ config: cfg({ emergency_stop: true, writesLocked: true }) }).code === 'EMERGENCY_STOP');
  ok('missing / undefined / null / "false" lock value is LOCKED (fail-closed); only an explicit false opens it', [undefined, null, 'false', 0].every((v) => !WG.evaluateGlobalWriteGuard({ config: { emergency_stop: false, writesLocked: v } }).ok));
  ok('no config → refused (fail-closed)', WG.evaluateGlobalWriteGuard({ config: null }).code === 'NO_CONFIG');
  ok('the global layer does NOT look at mode or permissions (those stay the Operator\'s own gate)', WG.evaluateGlobalWriteGuard({ config: { ...cfg(), mode: 'SHADOW', execPermissions: { open: false } } }).ok === true);

  console.log('\n2. graphPost — the ONE write primitive');
  setEntity(ids.acc); setEntity(ids.camp);
  const PRIMS = {
    createCampaign: () => MC.createCampaign(TOKEN, ids.acc, { name: 'x', objective: 'OUTCOME_SALES' }), createAdSet: () => MC.createAdSet(TOKEN, ids.acc, { name: 'x' }), createAdCreative: () => MC.createAdCreative(TOKEN, ids.acc, { name: 'x' }), createAd: () => MC.createAd(TOKEN, ids.acc, { name: 'x' }),
    setEntityStatus: () => MC.setEntityStatus(TOKEN, ids.camp, 'ACTIVE'), setEntityBudget: () => MC.setEntityBudget(TOKEN, ids.camp, { dailyBudgetMinor: 40000 }), setAdSetSchedule: () => MC.setAdSetSchedule(TOKEN, ids.camp, { startTime: new Date(Date.now() + 3_600_000).toISOString() }),
    uploadAdImageBuffer: () => MC.uploadAdImageBuffer(TOKEN, ids.acc, Buffer.from('x')), uploadAdVideoFromUrl: () => MC.uploadAdVideoFromUrl(TOKEN, ids.acc, 'https://example.invalid/v.mp4', 'v'),
  };
  WG.__resetGlobalAuditMemory(); const evBase = (await events()).length;
  lock(false); const before = world.log.length; const r1 = {};
  for (const [name, fn] of Object.entries(PRIMS)) r1[name] = await expectBlocked(fn);
  ok(`lock CLOSED: all ${Object.keys(PRIMS).length} write functions are refused with MetaWriteBlockedError (423, permanent)`, Object.values(r1).every((r) => r.threw && r.blocked && r.reason === 'META_WRITES_LOCKED'), JSON.stringify(Object.fromEntries(Object.entries(r1).map(([k, v]) => [k, v.reason || v.threw]))));
  ok('lock CLOSED: ZERO requests reached Meta (not even a read)', world.log.length === before);
  lock(true); await stop(true); const before2 = world.log.length; const r2 = {};
  for (const [name, fn] of Object.entries(PRIMS)) r2[name] = await expectBlocked(fn);
  ok('lock OPEN but Emergency Stop ON: all of them are refused (EMERGENCY_STOP)', Object.values(r2).every((r) => r.threw && r.blocked && r.reason === 'EMERGENCY_STOP'));
  ok('Emergency Stop: ZERO requests reached Meta', world.log.length === before2);
  await stop(false); lock(true); const before3 = world.log.length;
  await MC.setEntityStatus(TOKEN, ids.camp, 'ACTIVE'); await MC.setEntityBudget(TOKEN, ids.camp, { dailyBudgetMinor: 40000 });
  ok('lock OPEN + no Emergency Stop: the writes go through to the (mock) Meta, exactly one POST each', posts().length >= 2 && world.log.length - before3 === 2 && world.entities.get(ids.camp).status === 'ACTIVE' && world.entities.get(ids.camp).daily_budget === '40000');
  const ce = await MC.createCampaign(TOKEN, ids.acc, { name: 'ok' });
  ok('a create call reaches Meta too and returns its response', ce?.success === true);

  console.log('\n3. launchVideoUpload — posts to Meta directly (not through graphPost)');
  lock(false); const bv = world.log.length;
  const vu = await expectBlocked(() => VU.streamUploadVideoToMeta({ req: (async function* () { yield Buffer.from('x'); })(), adAccountId: ids.acc, fileSize: 1, token: TOKEN, jobId: `${T}vj`, slotKey: 's1' }));
  ok('lock CLOSED: the chunked video upload is refused before any network call', vu.threw && vu.blocked && world.log.length === bv);
  lock(true); await stop(true);
  const vu2 = await expectBlocked(() => VU.streamUploadVideoToMeta({ req: (async function* () { yield Buffer.from('x'); })(), adAccountId: ids.acc, fileSize: 1, token: TOKEN, jobId: `${T}vj`, slotKey: 's1' }));
  ok('Emergency Stop: refused too', vu2.threw && vu2.blocked && vu2.reason === 'EMERGENCY_STOP');
  await stop(false);

  console.log('\n4. Campaign schedules');
  const mkJobWithSchedule = async (tag, { schedule = {}, jobStatus = 'CLONED_PAUSED', entity = {} } = {}) => {
    const camp = `${T}sc_${tag}`; setEntity(camp, entity); const batchId = `${T}batch_${tag}_${Date.now()}`; created.batches.push(batchId);
    await retryDb(() => prisma.ambCloneBatch.create({ data: { batch_id: batchId, source_ad_account_id: `${T}src`, destination_account_ids_json: '[]', campaign_ids_json: '[]', status: 'SCHEDULED' } }));
    const job = await retryDb(() => prisma.ambCloneJob.create({ data: { batch_id: batchId, source_ad_account_id: `${T}src`, destination_ad_account_id: conn.selected_ad_account_id, source_campaign_id: `${T}srcc_${tag}`, source_campaign_name: `${T}clone ${tag}`, destination_campaign_id: camp, status: jobStatus, id_map_json: JSON.stringify({ adsets: {}, ads: {} }) } }));
    const sch = await retryDb(() => prisma.ambCampaignSchedule.create({ data: { clone_job_id: job.id, batch_id: batchId, destination_ad_account_id: conn.selected_ad_account_id, destination_campaign_id: camp, campaign_name: `${T}sched ${tag}`, mode: 'START_AT', start_at: new Date(Date.now() - 120_000), status: 'SCHEDULED', approval_required: false, approved_at: new Date(), ...schedule } }));
    return { camp, batchId, job, sch };
  };
  const schOf = (id) => prisma.ambCampaignSchedule.findUnique({ where: { id } });
  const s1 = await mkJobWithSchedule('start');
  lock(false); const bs = world.log.length; await CS.runDueCampaignSchedules(); const a1 = await schOf(s1.sch.id);
  ok('lock CLOSED: a due START is NOT executed — the schedule becomes NEEDS_INTERVENTION with the reason, ZERO requests', a1.status === 'NEEDS_INTERVENTION' && /كتابة Meta مقفولة/.test(a1.intervention_reason || '') && world.log.length === bs && world.entities.get(s1.camp).status === 'PAUSED', `${a1.status} ${a1.intervention_reason}`);
  ok('…and an alert + audit trail say so', (await prisma.ambAlert.count({ where: { dedupe_key: `sched-intervene:${s1.sch.id}` } })) >= 1 && (await prisma.ambCloneAudit.count({ where: { batch_id: s1.batchId, event: 'SCHEDULE_NEEDS_INTERVENTION' } })) === 1);
  const bs1 = world.log.length; await CS.runDueCampaignSchedules(); ok('it does NOT retry on the next tick, and it can never run late by itself (status is no longer SCHEDULED)', world.log.length === bs1 && (await schOf(s1.sch.id)).status === 'NEEDS_INTERVENTION');
  const s2 = await mkJobWithSchedule('stop'); lock(true); await stop(true);
  await CS.runDueCampaignSchedules(); const a2 = await schOf(s2.sch.id);
  ok('Emergency Stop (lock open): a due START is refused the same way', a2.status === 'NEEDS_INTERVENTION' && world.entities.get(s2.camp).status === 'PAUSED' && /إيقاف الطوارئ/.test(a2.intervention_reason || ''), `${a2.status} ${a2.intervention_reason}`);
  await stop(false); lock(true);
  const s3 = await mkJobWithSchedule('go'); const bg = posts().length; await CS.runDueCampaignSchedules(); const a3 = await schOf(s3.sch.id);
  ok('guard OPEN: the SAME flow still works exactly as before — the due START activates the campaign (RUNNING)', a3.status === 'RUNNING' && world.entities.get(s3.camp).status === 'ACTIVE' && posts().length - bg === 1, `${a3.status} ${a3.last_error || ''}`);
  const s4 = await mkJobWithSchedule('end', { schedule: { status: 'RUNNING', start_at: new Date(Date.now() - 3_600_000), end_at: new Date(Date.now() - 60_000), actual_start_at: new Date(Date.now() - 3_000_000) }, entity: { status: 'ACTIVE', effective_status: 'ACTIVE' } }); lock(false); const be = world.log.length;
  await CS.runDueCampaignSchedules(); const a4 = await schOf(s4.sch.id);
  ok('lock CLOSED: a due END (pause) is also refused → NEEDS_INTERVENTION + alert (the owner must act; consequence of the owner\'s decision to lock ALL Meta writes)', a4.status === 'NEEDS_INTERVENTION' && world.log.length === be && world.entities.get(s4.camp).status === 'ACTIVE', `${a4.status}`);
  const s5 = await mkJobWithSchedule('manual', { schedule: { status: 'PENDING_APPROVAL', approval_required: true, approved_at: null, start_at: new Date(Date.now() - 60_000) } }); const bm = world.log.length;
  const m1 = await expectBlocked(() => CS.runNowSchedule({ id: s5.sch.id, userId: 1 })); const m2 = await expectBlocked(() => CS.pauseNowSchedule({ id: s4.sch.id, userId: 1 })); const m3 = await expectBlocked(() => CS.approveSchedule({ id: s5.sch.id, userId: 1 }));
  ok('lock CLOSED: manual «run now», manual «pause now» and an approval whose start is already due are refused 423 BEFORE changing anything', m1.blocked && m2.blocked && m3.blocked && (await schOf(s5.sch.id)).status === 'PENDING_APPROVAL' && (await schOf(s4.sch.id)).status === 'NEEDS_INTERVENTION' && world.entities.get(s4.camp).status === 'ACTIVE' && world.log.length === bm, JSON.stringify([m1.reason, m2.reason, m3.reason]));
  const s6 = await mkJobWithSchedule('future', { schedule: { status: 'PENDING_APPROVAL', approval_required: true, approved_at: null, start_at: new Date(Date.now() + 6 * 3_600_000) } });
  const ap = await CS.approveSchedule({ id: s6.sch.id, userId: 1 });
  ok('approving a FUTURE schedule (a pure DB state, no Meta write now) is still allowed while locked — behaviour unchanged', (await schOf(s6.sch.id)).status === 'SCHEDULED' && !!ap && world.log.length === bm);

  console.log('\n5. Clone');
  const mkBatch = async (tag, status) => { const batchId = `${T}cb_${tag}_${Date.now()}`; created.batches.push(batchId); await retryDb(() => prisma.ambCloneBatch.create({ data: { batch_id: batchId, source_ad_account_id: `${T}src`, destination_account_ids_json: '[]', campaign_ids_json: '[]', status } })); return batchId; };
  const cb = await mkBatch('appr', 'PENDING_APPROVAL'); lock(false); const bc = world.log.length;
  const ca = await expectBlocked(() => CE.approveBatch({ batchId: cb, userId: 1 }));
  ok('lock CLOSED: approving a clone batch is refused 423 BEFORE the batch changes state', ca.blocked && (await prisma.ambCloneBatch.findUnique({ where: { batch_id: cb } })).status === 'PENDING_APPROVAL' && world.log.length === bc);
  const cr = await expectBlocked(() => CE.resumeBatch({ batchId: cb, userId: 1 }));
  ok('lock CLOSED: resuming / retrying a batch is refused 423 too', cr.blocked && world.log.length === bc);
  const dj = await mkJobWithSchedule('clonedue', { jobStatus: 'CLONED_PAUSED' });
  await prisma.ambCampaignSchedule.deleteMany({ where: { clone_job_id: dj.job.id } }); // no per-campaign schedule: the legacy batch-wide activation owns it
  await prisma.ambCloneJob.update({ where: { id: dj.job.id }, data: { scheduled_activation_at: new Date(Date.now() - 60_000) } }); await prisma.ambCloneBatch.update({ where: { batch_id: dj.batchId }, data: { identity_map_json: JSON.stringify({ autoActivate: true }), status: 'SCHEDULED' } });
  const bd = world.log.length; const ad = await CE.activateDueJobs(); const jd = await prisma.ambCloneJob.findUnique({ where: { id: dj.job.id } });
  ok('lock CLOSED: a due scheduled activation is NOT run — the job is parked as ACTIVATION_FAILED (+ audit + alert), so it can never fire late by itself', jd.status === 'ACTIVATION_FAILED' && /كتابة Meta مقفولة/.test(jd.error || '') && ad.skipped === 'META_WRITES_LOCKED' && world.log.length === bd && world.entities.get(dj.camp).status === 'PAUSED', `${jd.status} ${JSON.stringify(ad)}`);
  ok('…with an ACTIVATION_BLOCKED audit row and an alert', (await prisma.ambCloneAudit.count({ where: { batch_id: dj.batchId, event: 'ACTIVATION_BLOCKED' } })) === 1 && (await prisma.ambAlert.count({ where: { dedupe_key: `clone-activate-blocked:${dj.job.id}` } })) === 1);
  const bd2 = world.log.length; await CE.activateDueJobs(); ok('the next tick does nothing more for it (no retry, no late activation)', world.log.length === bd2);
  lock(true); const dg = await mkJobWithSchedule('clonego', { jobStatus: 'CLONED_PAUSED' }); await prisma.ambCampaignSchedule.deleteMany({ where: { clone_job_id: dg.job.id } });
  await prisma.ambCloneJob.update({ where: { id: dg.job.id }, data: { scheduled_activation_at: new Date(Date.now() - 60_000) } }); await prisma.ambCloneBatch.update({ where: { batch_id: dg.batchId }, data: { identity_map_json: JSON.stringify({ autoActivate: true }), status: 'SCHEDULED' } });
  const ag = await CE.activateDueJobs(); const jg = await prisma.ambCloneJob.findUnique({ where: { id: dg.job.id } });
  ok('guard OPEN: the same activation works as before (ACTIVATED, the campaign is ACTIVE on the mock Meta)', jg.status === 'ACTIVATED' && world.entities.get(dg.camp).status === 'ACTIVE' && ag.activated >= 1, `${jg.status} ${JSON.stringify(ag)}`);

  console.log('\n6. Launch');
  const mkLaunch = async (tag, status) => { const jobId = `${T}lj_${tag}_${Date.now()}`; created.launchJobs.push(jobId); await retryDb(() => prisma.ambLaunchJob.create({ data: { job_id: jobId, ad_account_id: conn.selected_ad_account_id, budget_mode: 'CBO', config_json: '{}', status } })); await prisma.ambLaunchCampaign.create({ data: { job_id: jobId, index: 0, name: `${T}launch ${tag}`, status: 'QUEUED' } }); return jobId; };
  const prod = await prisma.product.create({ data: { product_name: `${T}launch_product`, active: true } }); created.productId = prod.id;
  const validJob = async (tag) => { const jobId = `${T}vj_${tag}_${Date.now()}`; created.launchJobs.push(jobId); await LB.createDraftJob({ jobId, userId: null, input: { productId: prod.id, adAccountId: 'act_ext_test', adAccountName: 'x', pageId: '999', pageName: 'p', budgetMode: 'ABO', pixelId: 'pix_1', pixelName: 'px', conversionEvent: 'PURCHASE', platforms: ['facebook'], adSetsPerCampaign: 2, adsPerAdSet: 3, campaignCount: 1, startMode: 'NOW', budget: { abo: { adSets: [{ dailyBudgetMinor: 20000 }, { dailyBudgetMinor: 20000 }] } }, campaigns: [{ name: `${T}ext launch ${tag}`, websiteUrl: 'https://example.invalid' }] } }); await prisma.ambLaunchVideoAsset.create({ data: { job_id: jobId, slot_key: 'C1', original_filename: 'v.mp4', status: 'UPLOADED', meta_video_id: 'vid_1' } }); return jobId; };
  const lj = await validJob('start'); lock(false); const bl = world.log.length;
  const ls = await expectBlocked(() => LP.startLaunchQueue({ jobId: lj, userId: 1 }));
  ok('lock CLOSED: starting a launch queue (a fully VALID job — every validation passes) is refused 423 by the guard BEFORE the job flips to PUBLISHING', ls.blocked && (await prisma.ambLaunchJob.findUnique({ where: { job_id: lj } })).status === 'DRAFT' && world.log.length === bl, JSON.stringify([ls.threw, ls.reason, ls.e?.message]));
  const invalid = await mkLaunch('invalid', 'READY'); const lv = await expectBlocked(() => LP.startLaunchQueue({ jobId: invalid, userId: 1 }));
  ok('validation errors are still reported FIRST, unchanged (an incomplete job gets its own message, not the write guard)', lv.threw && !lv.blocked && /Facebook Page|ميزانية|فيديو|Pixel/.test(lv.e.message), lv.e?.message);
  const lp = await mkLaunch('tick', 'PUBLISHING'); const lt = await LP.runDueLaunchQueueTick(); const pj = await prisma.ambLaunchJob.findUnique({ where: { job_id: lp } });
  ok('lock CLOSED: the queue tick publishes NOTHING and parks the PUBLISHING job as PARTIAL (restartable by the owner, never resumes by itself)', pj.status === 'PARTIAL' && /كتابة Meta مقفولة/.test(pj.error || '') && lt.skipped === 'META_WRITES_LOCKED' && world.log.length === bl, `${pj.status} ${JSON.stringify(lt)}`);
  ok('…with a WRITE_GUARD_BLOCKED audit row on the job', (await prisma.ambLaunchAudit.count({ where: { job_id: lp, event: 'WRITE_GUARD_BLOCKED' } })) === 1);
  const bl2 = world.log.length; await LP.runDueLaunchQueueTick(); ok('the next tick does nothing for it', world.log.length === bl2 && (await prisma.ambLaunchJob.findUnique({ where: { job_id: lp } })).status === 'PARTIAL');
  lock(true); await stop(true); const lj2 = await validJob('start2'); const ls2 = await expectBlocked(() => LP.startLaunchQueue({ jobId: lj2, userId: 1 }));
  ok('Emergency Stop (lock open): a launch start is refused too', ls2.blocked && ls2.reason === 'EMERGENCY_STOP'); await stop(false);

  console.log('\n7. Audit');
  const ev = (await events()).slice(evBase); const glob = ev.filter((e) => JSON.parse(e.data_json || '{}').layer === 'GLOBAL');
  ok('every refusal is a WRITE_GATE_BLOCK operator event (layer GLOBAL) naming the source', glob.length >= 8 && glob.every((e) => /منع كتابة Meta/.test(e.note || '')) && ['graphPost', 'schedule:START', 'clone:approveBatch', 'launch:startQueue', 'launch:tick', 'launchVideoUpload:form'].every((src) => glob.some((e) => JSON.parse(e.data_json).source === src)), glob.map((e) => JSON.parse(e.data_json).source).join(','));
  const gp = glob.filter((e) => JSON.parse(e.data_json).source === 'graphPost');
  ok('de-duplicated: 9 refused writes while locked + 9 under Emergency Stop = ONE event per reason, not 18', gp.length === 2 && gp.some((e) => JSON.parse(e.data_json).codes[0] === 'META_WRITES_LOCKED') && gp.some((e) => JSON.parse(e.data_json).codes[0] === 'EMERGENCY_STOP'), String(gp.length));
  ok('the access token never appears in the audit (only the path with ids masked and the field NAMES)', ev.every((e) => !(e.data_json || '').includes(TOKEN) && !(e.note || '').includes(TOKEN)) && gp.every((e) => /fields/.test(e.data_json)));
  WG.__resetGlobalAuditMemory(); lock(false); await expectBlocked(PRIMS.setEntityStatus); await expectBlocked(PRIMS.setEntityStatus);
  ok('the de-duplication memory can be reset (a later refusal is audited again)', (await events()).length > ev.length + evBase - 1 && (await events()).slice(evBase + ev.length).length === 1);

  console.log('\n8. Tripwires');
  const SRC = join(__dirname, '..'); const files = []; const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) { if (f.name !== 'scripts' && f.name !== 'node_modules') walk(p); } else if (/\.(js|mjs)$/.test(f.name)) files.push(p); } }; walk(SRC);
  const rel = (f) => f.slice(SRC.length + 1).replace(/\\/g, '/'); const code = (f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const gpSrc = fs.readFileSync(join(SRC, 'services/metaGraphClient.js'), 'utf8'); const gpBody = gpSrc.slice(gpSrc.indexOf('export async function graphPost'), gpSrc.indexOf('export async function setEntityStatus'));
  ok('graphPost runs the global guard BEFORE it builds the request or calls fetch', gpBody.indexOf('assertMetaWritesAllowed(') > 0 && gpBody.indexOf('assertMetaWritesAllowed(') < gpBody.indexOf('new URLSearchParams') && gpBody.indexOf('assertMetaWritesAllowed(') < gpBody.indexOf('fetch('));
  ok('graphPost is used ONLY inside metaGraphClient.js (no feature builds its own write path around the guard)', files.filter((f) => /graphPost\s*\(/.test(code(f)) && !rel(f).endsWith('services/metaGraphClient.js')).length === 0, files.filter((f) => /graphPost\s*\(/.test(code(f))).map(rel).join(','));
  const directPosts = files.filter((f) => /graph\.facebook\.com/.test(code(f))).map(rel);
  ok('the only files that talk to graph.facebook.com are metaGraphClient.js and launchVideoUpload.js', directPosts.every((f) => ['services/metaGraphClient.js', 'services/amb/launchVideoUpload.js'].includes(f)), directPosts.join(','));
  const vuSrc = fs.readFileSync(join(SRC, 'services/amb/launchVideoUpload.js'), 'utf8');
  const sites = [...vuSrc.matchAll(/method: 'POST'/g)].map((m) => m.index); const guards = [...vuSrc.matchAll(/assertMetaWritesAllowed\(\{/g)].map((m) => m.index);
  ok('every POST in launchVideoUpload is preceded (in the same function) by the guard', sites.length === 2 && sites.every((p) => guards.some((g) => g < p && p - g < 1500)), JSON.stringify({ sites, guards }));
  for (const [file, fns] of Object.entries({ 'services/amb/cloneEngine.js': ['approveBatch', 'resumeBatch', 'runBatch', 'activateDueJobs'], 'services/amb/campaignSchedule.js': ['approveSchedule', 'runNowSchedule', 'pauseNowSchedule', 'execute'], 'services/amb/launchPublish.js': ['startLaunchQueue', 'publishSingleTestItem', 'runDueLaunchQueueTick'] })) {
    const src = fs.readFileSync(join(SRC, file), 'utf8'); ok(`${file}: the entry points carry the guard (${fns.join(', ')})`, fns.every((fn) => { const i = src.search(new RegExp(`(async )?function ${fn}\\(`)); if (i < 0) return false; const seg = src.slice(i, i + 9000); return /assertMetaWritesAllowed\(|checkGlobalMetaWrite\(/.test(seg); }));
  }
} catch (e) { fail++; console.log('✗ crashed:', e.stack || e.message); }
finally {
  try {
    lock(false); await stop(false).catch(() => {});
    if (created.batches.length) { await prisma.ambCloneAudit.deleteMany({ where: { batch_id: { in: created.batches } } }); await prisma.ambCampaignSchedule.deleteMany({ where: { batch_id: { in: created.batches } } }); await prisma.ambCloneObjectMap.deleteMany({ where: { batch_id: { in: created.batches } } }).catch(() => {}); await prisma.ambCloneJob.deleteMany({ where: { batch_id: { in: created.batches } } }); await prisma.ambCloneBatch.deleteMany({ where: { batch_id: { in: created.batches } } }); }
    if (created.launchJobs.length) { await prisma.ambLaunchAudit.deleteMany({ where: { job_id: { in: created.launchJobs } } }); await prisma.ambLaunchVideoAsset.deleteMany({ where: { job_id: { in: created.launchJobs } } }); await prisma.ambLaunchObjectMap.deleteMany({ where: { campaign: { job_id: { in: created.launchJobs } } } }).catch(() => {}); await prisma.ambLaunchCampaign.deleteMany({ where: { job_id: { in: created.launchJobs } } }); await prisma.ambLaunchJob.deleteMany({ where: { job_id: { in: created.launchJobs } } }); if (created.productId) await prisma.product.delete({ where: { id: created.productId } }).catch(() => {}); }
    await prisma.ambOperatorEvent.deleteMany({ where: { kind: 'WRITE_GATE_BLOCK', note: { contains: 'طبقة عامة' } } }); await prisma.ambAlert.deleteMany({ where: { OR: [{ dedupe_key: { startsWith: 'sched-intervene:' } }, { dedupe_key: { startsWith: 'clone-activate-blocked:' } }] } }).catch(() => {});
  } catch (e) { console.log('cleanup note:', e.message); }
  await prisma.$disconnect(); server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
