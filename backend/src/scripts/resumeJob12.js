// Resume ONLY Job 12 (batch c423adbc-a8e3-451f-b9b0-1a76e6a627ec):
// Ahmed Samy -> Hady, "Hair-Remover _ scale 4". Reuses the existing
// destination Campaign 120247856897870265 + Ad Set 120247856898340265,
// retries the 3 FAILED creatives, then creates their 3 ads. Everything PAUSED.
// Then verifies from Meta and prints the full result.
//
// User-approved (2026-09-08). No activation, no scheduling.
import 'dotenv/config';
import { prisma } from '../prisma.js';
import { resumeBatch, getBatch } from '../services/amb/cloneEngine.js';
import { getDecryptedToken } from '../services/metaAuth.js';

const BATCH = 'c423adbc-a8e3-451f-b9b0-1a76e6a627ec';
const JOB_ID = 12;
const EXPECT_CAMPAIGN = '120247856897870265';
const EXPECT_ADSET = '120247856898340265';
const P = (s = '') => process.stdout.write(s + '\n');
const G = 'https://graph.facebook.com/v21.0';

async function g(path, params = {}) {
  const u = new URL(G + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', TOKEN);
  const r = await fetch(u);
  const d = await r.json().catch(() => null);
  return { ok: r.ok && !d?.error, error: d?.error || null, d };
}
let TOKEN;

// ---- pre-resume snapshot ----
const pre = await prisma.ambCloneJob.findUnique({ where: { id: JOB_ID }, include: { objects: { orderBy: { id: 'asc' } } } });
P('================ PRE-RESUME ================');
P(`Job ${JOB_ID} status: ${pre.status}`);
P(`destination_campaign_id: ${pre.destination_campaign_id}`);
for (const o of pre.objects) P(`  ${o.level}  src ${o.source_id}  -> ${o.destination_id || '(none)'}  [${o.status}]`);
const preCampRow = pre.objects.find((o) => o.level === 'CAMPAIGN');
const preAdsetRow = pre.objects.find((o) => o.level === 'ADSET');
if (preCampRow?.destination_id !== EXPECT_CAMPAIGN) { P(`\nABORT: campaign object row is ${preCampRow?.destination_id}, expected ${EXPECT_CAMPAIGN}`); process.exit(1); }
if (preAdsetRow?.destination_id !== EXPECT_ADSET) { P(`\nABORT: adset object row is ${preAdsetRow?.destination_id}, expected ${EXPECT_ADSET}`); process.exit(1); }
P(`\n✓ existing Campaign ${EXPECT_CAMPAIGN} + Ad Set ${EXPECT_ADSET} object rows present (will be REUSED).`);

// ---- resume ----
P('\n================ RESUME ================');
await resumeBatch({ batchId: BATCH, userId: pre.batch_id ? null : null });
P('resumeBatch() called — worker running. Polling…');

const TERMINAL = new Set(['CLONED_PAUSED', 'FAILED', 'NEEDS_INPUT', 'ACTIVATED', 'CANCELLED']);
let job;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  job = await prisma.ambCloneJob.findUnique({ where: { id: JOB_ID }, include: { objects: { orderBy: { id: 'asc' } } } });
  const cs = job.objects.filter((o) => o.level === 'CREATIVE').map((o) => o.status).join(',');
  const as = job.objects.filter((o) => o.level === 'AD').map((o) => o.status).join(',');
  P(`  [${(i + 1) * 5}s] job=${job.status}  creatives=[${cs}]  ads=[${as}]`);
  if (TERMINAL.has(job.status) && job.status !== 'CLONING') break;
}

// ---- post-resume object map ----
P('\n================ POST-RESUME OBJECT MAP ================');
P(`Job ${JOB_ID} status: ${job.status}`);
P(`job.error: ${job.error || '(none)'}`);
P(`destination_campaign_id: ${job.destination_campaign_id}`);
const idMap = (() => { try { return JSON.parse(job.id_map_json || '{}'); } catch { return {}; } })();
P(`id_map: ${JSON.stringify(idMap)}`);
for (const o of job.objects) P(`  ${o.level}  src ${o.source_id}  -> ${o.destination_id || '(none)'}  [${o.status}]${o.error ? '  ERR: ' + o.error.slice(0, 160) : ''}`);

// ---- no-duplicate check ----
const campRows = job.objects.filter((o) => o.level === 'CAMPAIGN');
const adsetRows = job.objects.filter((o) => o.level === 'ADSET');
P('\n================ DUPLICATE CHECK ================');
P(`CAMPAIGN object rows: ${campRows.length}  dest ids: ${JSON.stringify([...new Set(campRows.map((o) => o.destination_id))])}`);
P(`ADSET object rows:    ${adsetRows.length}  dest ids: ${JSON.stringify([...new Set(adsetRows.map((o) => o.destination_id))])}`);
P(`Campaign reused (unchanged): ${campRows.length === 1 && campRows[0].destination_id === EXPECT_CAMPAIGN ? 'YES' : 'NO'}`);
P(`Ad Set reused (unchanged):   ${adsetRows.length === 1 && adsetRows[0].destination_id === EXPECT_ADSET ? 'YES' : 'NO'}`);

// ---- verify from Meta ----
P('\n================ META VERIFICATION ================');
TOKEN = await getDecryptedToken();
const camp = await g(`/${EXPECT_CAMPAIGN}`, { fields: 'id,name,status,effective_status,objective' });
P(`Campaign ${EXPECT_CAMPAIGN}: ${camp.ok ? `"${camp.d.name}" status=${camp.d.status}/${camp.d.effective_status} objective=${camp.d.objective}` : 'READ FAIL ' + JSON.stringify(camp.error)}`);
const adsetsInCamp = await g(`/${EXPECT_CAMPAIGN}/adsets`, { fields: 'id,name,status,effective_status' });
P(`Ad Sets under the campaign in Meta: ${(adsetsInCamp.d?.data || []).length}`);
for (const as of adsetsInCamp.d?.data || []) P(`  ${as.id}  "${as.name}"  status=${as.status}/${as.effective_status}`);
const adsInCamp = await g(`/${EXPECT_CAMPAIGN}/ads`, { fields: 'id,name,status,effective_status,adset_id,creative{id,name,object_story_spec,call_to_action_type}' });
P(`Ads under the campaign in Meta: ${(adsInCamp.d?.data || []).length}`);
for (const ad of adsInCamp.d?.data || []) {
  const oss = ad.creative?.object_story_spec || {};
  const ld = oss.link_data || {};
  P(`  AD ${ad.id}  "${ad.name}"  status=${ad.status}/${ad.effective_status}  adset=${ad.adset_id}`);
  P(`     creative ${ad.creative?.id}  cta=${ld.call_to_action?.type || ad.creative?.call_to_action_type}  link=${ld.call_to_action?.value?.link || ld.link || '-'}`);
  P(`     name(headline)=${JSON.stringify(ld.name || null)}  message(first100)=${JSON.stringify((ld.message || '').slice(0, 100))}  image_hash=${ld.image_hash || '-'}`);
}
const allPaused = [camp.d, ...(adsetsInCamp.d?.data || []), ...(adsInCamp.d?.data || [])].every((x) => x && x.status === 'PAUSED');
P(`\nEVERY destination object PAUSED: ${allPaused ? 'YES' : 'NO'}`);

// ---- audit trail ----
P('\n================ AUDIT (this batch) ================');
const audits = await prisma.ambCloneAudit.findMany({ where: { batch_id: BATCH }, orderBy: { id: 'asc' } });
for (const a of audits) P(`  ${a.created_at.toISOString()}  ${a.event}${a.level ? ' ' + a.level : ''}${a.source_id ? ' src=' + a.source_id : ''}${a.destination_id ? ' -> ' + a.destination_id : ''}${a.detail ? '  ' + a.detail.slice(0, 200) : ''}`);

// ---- batch state ----
const batch = await getBatch(BATCH);
P('\n================ BATCH ================');
P(`batch status: ${batch.status}`);
P(`jobsSummary: ${JSON.stringify(batch.jobsSummary)}`);

P('\nDONE. No activation, no scheduling.');
process.exit(0);
