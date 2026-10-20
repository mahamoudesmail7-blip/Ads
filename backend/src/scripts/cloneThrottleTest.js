// 🧯 Clone & Schedule × Meta throttle («User request limit reached — Ad Account Has Too Many API Calls»): a TEMPORARY Meta limit must never become a permanent «محجوبة» verdict.
//   1. isMetaThrottle classifies the throttle codes / messages (and nothing else)
//   2. a copy that was blocked ONLY by a throttled source read is put back to PENDING (so «استئناف» re-reads it) — real blocks stay blocked
//   3. the preview turns a throttled read into a WARNING row (never BLOCKED), a real read error still blocks
//   node src/scripts/cloneThrottleTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };

const { prisma } = await imp('../prisma.js');
const { isMetaThrottle, rearmThrottleBlockedJobs } = await imp('../services/amb/cloneEngine.js');

console.log('\n1. Throttle classification');
const err = (message, extra = {}) => Object.assign(new Error(message), extra);
ok('the exact message from the owner’s screenshot is a throttle', isMetaThrottle(err('User request limit reached — Ad Account Has Too Many API Calls: There have been too many calls from this ad-account. Please wait a bit and try again.')));
ok('graph codes 4 / 17 / 32 / 613 / 80004 are throttles', [4, 17, 32, 613, 80004].every((c) => isMetaThrottle(err('x', { graphCode: c }))));
ok('the graph client’s own isMetaRateLimit flag counts', isMetaThrottle(err('x', { isMetaRateLimit: true })));
ok('real problems are NOT throttles (permissions, bad payload, unknown object, auth)', [err('Unsupported get request. Object with ID does not exist', { graphCode: 100 }), err('Invalid OAuth access token', { graphCode: 190 }), err('(#200) Requires ads_management permission', { graphCode: 200 }), err('Invalid parameter', { graphCode: 100, graphSubcode: 1487 })].every((e) => !isMetaThrottle(e)));
ok('null / undefined are safe', !isMetaThrottle(null) && !isMetaThrottle(undefined));

console.log('\n2. Copies blocked only by a throttled read are re-armed; real blocks are left alone');
const bid = `throttle-test-${Date.now()}`;
await prisma.ambCloneBatch.create({ data: { batch_id: bid, source_ad_account_id: 'act_1', destination_account_ids_json: '["act_2"]', campaign_ids_json: '["c1","c2","c3","c4"]', status: 'FAILED', total_copies: 4 } });
const mk = (cid, checks) => prisma.ambCloneJob.create({ data: { batch_id: bid, source_ad_account_id: 'act_1', destination_ad_account_id: 'act_2', source_campaign_id: cid, status: 'PREFLIGHT_BLOCKED', preflight_status: 'BLOCKED', preflight_json: JSON.stringify({ status: 'BLOCKED', checks }), error: 'محجوب' } });
const THR = 'User request limit reached — Ad Account Has Too Many API Calls: There have been too many calls from this ad-account. Please wait a bit and try again.';
const jThrottle = await mk('c1', [{ name: 'قراءة الحملة المصدر', status: 'BLOCK', detail: THR }]);
const jRealRead = await mk('c2', [{ name: 'قراءة الحملة المصدر', status: 'BLOCK', detail: 'Unsupported get request. Object with ID does not exist' }]);
const jInactive = await mk('c3', [{ name: 'حساب الوجهة', status: 'BLOCK', detail: 'الحساب الإعلاني الوجهة غير نشط (account_status=2).' }]);
const jMixed = await mk('c4', [{ name: 'قراءة الحملة المصدر', status: 'BLOCK', detail: THR }, { name: 'حساب الوجهة', status: 'BLOCK', detail: 'غير نشط' }]);
const n = await rearmThrottleBlockedJobs(bid);
const st = async (j) => (await prisma.ambCloneJob.findUnique({ where: { id: j.id } }));
const a = await st(jThrottle);
ok('exactly one job was re-armed', n === 1, String(n));
ok('the throttle-blocked copy is PENDING / WARNING again with its error cleared', a.status === 'PENDING' && a.preflight_status === 'WARNING' && a.error === null, JSON.stringify([a.status, a.preflight_status, a.error]));
ok('a real source-read failure (object missing) stays blocked', (await st(jRealRead)).status === 'PREFLIGHT_BLOCKED');
ok('an inactive destination account stays blocked', (await st(jInactive)).status === 'PREFLIGHT_BLOCKED');
ok('a job with a throttle block AND a real block stays blocked', (await st(jMixed)).status === 'PREFLIGHT_BLOCKED');
ok('re-arming is audited', (await prisma.ambCloneAudit.count({ where: { batch_id: bid, event: 'JOB_REARMED' } })) === 1);
ok('running it again changes nothing (idempotent)', (await rearmThrottleBlockedJobs(bid)) === 0);
await prisma.ambCloneBatch.delete({ where: { batch_id: bid } }).catch(() => {});

console.log('\n3. The preview never turns a throttle into a permanent BLOCK');
const src = fs.readFileSync(join(__dirname, '../services/amb/cloneEngine.js'), 'utf8');
ok('the source-campaign read is retried on a throttle (preview + clone time)', /withThrottleRetry\(\(\) => readCampaignTree\(token, cid\)/.test(src) && /withThrottleRetry\(\(\) => readCampaignTree\(token, job\.source_campaign_id\)/.test(src));
ok('a throttled read is tagged and becomes a WARNING row with a WARN check; a real error still BLOCKs', /__throttled: isMetaThrottle\(e\)/.test(src) && /status: tree\.__throttled \? 'WARNING' : 'BLOCKED'/.test(src) && /tree\.__throttled \? \{ name: 'قراءة الحملة المصدر', status: 'WARN'/.test(src));
ok('a run / resume re-arms old throttle-blocked copies first', /async function runBatch\(batchId\) \{\s*await rearmThrottleBlockedJobs\(batchId\)/.test(src));

await prisma.$disconnect();
console.log(`\n${fail ? '❌' : '✅'} cloneThrottleTest: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
