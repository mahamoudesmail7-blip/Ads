// One-off repair for the empty "microscope - Test - Scale" campaign
// (AmbScaleDecision id=3, batch e8b7afb5..., job 20). User-approved per §7.
//
//   1. Set the DESTINATION campaign's bid_strategy to LOWEST_COST_WITHOUT_CAP
//      (it was created — before the fix — with LOWEST_COST_WITH_BID_CAP and no
//      cap). Destination only; source untouched.
//   2. resumeBatch() the SAME batch — reuses the existing destination Campaign
//      (object-map CAMPAIGN row is CREATED) and creates only the missing Ad
//      Set + Ad. No duplicate campaign.
//   3. Verify from Meta + update AmbScaleDecision.
import 'dotenv/config';
import { prisma } from '../prisma.js';
import { getDecryptedToken } from '../services/metaAuth.js';
import { resumeBatch } from '../services/amb/cloneEngine.js';
import { waitAndVerifyScale } from '../services/amb/scaleWinners.js';

const BATCH = 'e8b7afb5-c812-44cc-82ec-ccf9bf673966';
const DEST_CAMPAIGN = '120252264551650205';
const REQUIRED_ADSETS = ['120249577592550205'];
const SELECTED_ADS = ['120249578534520205'];
const G = 'https://graph.facebook.com/v21.0';
const P = (s = '') => process.stdout.write(s + '\n');

const token = await getDecryptedToken();
async function gGet(path, fields) {
  const u = new URL(G + path); u.searchParams.set('fields', fields); u.searchParams.set('access_token', token);
  return (await fetch(u)).json();
}
async function gPost(path, body) {
  const u = new URL(G + path);
  const fd = new URLSearchParams({ ...body, access_token: token });
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: fd });
  return { ok: r.ok, d: await r.json().catch(() => null) };
}

// ---- pre ----
P('=== PRE ===');
const dec = await prisma.ambScaleDecision.findUnique({ where: { id: 3 } });
P(`AmbScaleDecision id=3 status=${dec.status} batch=${dec.clone_batch_id}`);
const job0 = await prisma.ambCloneJob.findFirst({ where: { batch_id: BATCH }, include: { objects: true } });
P(`job ${job0.id} status=${job0.status}`);
for (const o of job0.objects) P(`  ${o.level} ${o.source_id} -> ${o.destination_id || '(none)'} [${o.status}]`);
const c0 = await gGet(`/${DEST_CAMPAIGN}`, 'id,name,status,bid_strategy,daily_budget');
P(`dest campaign: ${JSON.stringify(c0)}`);

// ---- 1) repair bid_strategy on the destination campaign ----
P('\n=== STEP 1 — fix destination campaign bid_strategy ===');
if (c0.bid_strategy === 'LOWEST_COST_WITHOUT_CAP') {
  P('  already LOWEST_COST_WITHOUT_CAP — skip');
} else {
  const upd = await gPost(`/${DEST_CAMPAIGN}`, { bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
  P(`  update -> ${JSON.stringify(upd.d)}`);
  const c1 = await gGet(`/${DEST_CAMPAIGN}`, 'id,bid_strategy,daily_budget,status');
  P(`  now: ${JSON.stringify(c1)}`);
  if (c1.bid_strategy !== 'LOWEST_COST_WITHOUT_CAP') { P('  ✗ bid_strategy did not change — ABORT'); process.exit(1); }
}

// ---- 2) resume the SAME batch ----
P('\n=== STEP 2 — resumeBatch (reuse campaign, create missing children) ===');
await resumeBatch({ batchId: BATCH, userId: null });
const v = await waitAndVerifyScale({ batchId: BATCH, requiredAdSetIds: REQUIRED_ADSETS, selectedAdIds: SELECTED_ADS, timeoutMs: 150_000, pollMs: 3000 });
P(`verify: ${JSON.stringify(v)}`);

// ---- 3) post-state ----
P('\n=== STEP 3 — verify from Meta ===');
const job1 = await prisma.ambCloneJob.findFirst({ where: { batch_id: BATCH }, include: { objects: { orderBy: { id: 'asc' } } } });
P(`job ${job1.id} status=${job1.status} error=${job1.error || '(none)'}`);
for (const o of job1.objects) P(`  ${o.level} ${o.source_id} -> ${o.destination_id || '(none)'} [${o.status}]${o.error ? '  ERR ' + o.error.slice(0, 140) : ''}`);

const camp = await gGet(`/${DEST_CAMPAIGN}`, 'id,name,status,effective_status,bid_strategy,daily_budget,objective');
P(`\ncampaign: ${JSON.stringify(camp)}`);
const asets = await gGet(`/${DEST_CAMPAIGN}/adsets`, 'id,name,status,effective_status,optimization_goal,billing_event,bid_strategy,promoted_object');
P(`ad sets (${(asets.data || []).length}):`);
for (const a of asets.data || []) P(`  ${a.id} "${a.name}" ${a.status}/${a.effective_status} ${a.optimization_goal} pixel=${a.promoted_object?.pixel_id}`);
const aads = await gGet(`/${DEST_CAMPAIGN}/ads`, 'id,name,status,effective_status,adset_id,creative{id,call_to_action_type,object_story_spec}');
P(`ads (${(aads.data || []).length}):`);
for (const a of aads.data || []) {
  const ld = a.creative?.object_story_spec?.link_data || {};
  P(`  ${a.id} "${a.name}" ${a.status}/${a.effective_status} adset=${a.adset_id} creative=${a.creative?.id}`);
  P(`     cta=${ld.call_to_action?.type || a.creative?.call_to_action_type} link=${ld.call_to_action?.value?.link || ld.link || '-'} headline=${JSON.stringify(ld.name || null)}`);
}
const allPaused = [camp, ...(asets.data || []), ...(aads.data || [])].every((x) => x && x.status === 'PAUSED');
P(`\nall PAUSED: ${allPaused}`);

// ---- 4) update the scale decision ----
const done = v.ok && (aads.data || []).length === SELECTED_ADS.length && (asets.data || []).length === REQUIRED_ADSETS.length && allPaused;
await prisma.ambScaleDecision.update({ where: { id: 3 }, data: { status: done ? 'EXECUTED' : 'FAILED', error: done ? null : (v.error || 'incomplete').slice(0, 800) } });
P(`\nAmbScaleDecision id=3 -> ${done ? 'EXECUTED' : 'FAILED'}`);
P(`\nSUMMARY: campaign ${DEST_CAMPAIGN} · ${(asets.data || []).length} ad set(s) · ${(aads.data || []).length} ad(s) · resumed same batch (no duplicate)`);
process.exit(done ? 0 : 1);
