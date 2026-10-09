// 🧪 Execution history: every stage is derived from what really happened — "Verified" only after the independent read-back confirmed it; Uncertain / Failed / Blocked never look like success.
//   node src/scripts/executionHistoryTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const H = await imp('../services/amb/executionHistory.js'); const { prisma } = await imp('../prisma.js');
const row = (o = {}) => ({ id: 1, created_at: new Date('2026-10-08T10:00:00Z'), executed_at: new Date('2026-10-08T10:01:30Z'), verified_at: null, mode: 'APPROVAL', action_type: 'RESUME', ad_account_id: 'a', level: 'campaign', entity_id: 'c1', entity_name: 'C1', campaign_id: 'c1', old_value_json: '{"status":"PAUSED"}', new_value_json: '{"status":"ACTIVE"}', approval_status: 'APPROVED', execution_status: 'EXECUTED', revalidation_json: '{"ok":true}', meta_request_json: '{"status":"ACTIVE"}', meta_response_json: '{"success":true}', meta_error: null, verify_json: null, executed_by: { name: 'Owner' }, ai_reason: 'r', ...o });
console.log('\n1. Stage derivation (pure)');
let r = H.shapeActionRow(row({ verify_json: '{"verified":true,"observed":"ACTIVE"}', verified_at: new Date() }));
ok('EXECUTED + read-back confirmed → VERIFIED with all six stages done', r.final === 'VERIFIED' && r.stages.filter((s) => s.done).length === 6 && r.verify.verified === true && r.before === 'PAUSED' && r.after === 'ACTIVE' && r.by === 'Owner');
r = H.shapeActionRow(row({ verify_json: '{"verified":false,"observed":"PAUSED"}' }));
ok('EXECUTED but the read-back did NOT confirm → UNCERTAIN (never success)', r.final === 'UNCERTAIN' && r.verify.verified === false);
r = H.shapeActionRow(row({ verify_json: null }));
ok('EXECUTED with no read-back at all → UNCERTAIN, the Read-back stage is not done', r.final === 'UNCERTAIN' && r.stages.find((s) => s.key === 'READ_BACK').done === false);
r = H.shapeActionRow(row({ execution_status: 'FAILED', meta_error: '(#17) rate limit', meta_response_json: null }));
ok('FAILED keeps the Meta error text and is not verified', r.final === 'FAILED' && /rate limit/.test(r.error) && r.stages.find((s) => s.key === 'FAILED').done);
r = H.shapeActionRow(row({ execution_status: 'ABORTED_REANALYSIS', meta_request_json: null, revalidation_json: '{"ok":false,"reason":"تعديل يدوي"}', executed_at: null }));
ok('ABORTED_REANALYSIS → BLOCKED before sending: no Sent stage, the revalidation reason is shown', r.final === 'BLOCKED' && r.stages.find((s) => s.key === 'SENT').done === false && /تعديل يدوي/.test(r.error) && r.stages.find((s) => s.key === 'VALIDATED').ok === false);
r = H.shapeActionRow(row({ execution_status: 'PENDING', meta_request_json: null, revalidation_json: null, executed_at: null }));
ok('PENDING → REQUESTED only (later stages are not invented)', r.final === 'REQUESTED' && r.stages.filter((s) => s.done).length === 2 /* requested + approved flag */);
r = H.shapeActionRow(row({ action_type: 'INCREASE_BUDGET', old_value_json: '{"budget":400}', new_value_json: '{"budget":480}', approval_status: 'AUTO', executed_by: null, verify_json: '{"verified":true}' }));
ok('budget actions carry before/after budget; an AUTO approval without a user is attributed to the system', r.budgetChange && r.before === 400 && r.after === 480 && /النظام/.test(r.by) && r.typeLabel === 'زيادة الميزانية');
console.log('\n2. DB listing (test fixtures from seedUiFixtures are optional)');
const l = await H.listExecutionHistory({ limit: 50 });
ok('listExecutionHistory returns rows + counts that add up', Array.isArray(l.rows) && l.counts.total === l.rows.length && Object.entries(l.counts).filter(([k]) => k !== 'total').reduce((t, [, v]) => t + v, 0) === l.counts.total);
ok('the type filter is honoured', (await H.listExecutionHistory({ type: 'PAUSE' })).rows.every((x) => x.type === 'PAUSE'));
ok('the final-state filter is honoured', (await H.listExecutionHistory({ final: 'VERIFIED' })).rows.every((x) => x.final === 'VERIFIED'));
await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
