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
console.log('\nAutomation decisions that never reached Meta are still in the history');
{ const d = await prisma.ambOperatorDecision.create({ data: { decision_key: `__optest_hist_${Date.now()}`, status: 'EXPIRED', store_id: 'x', ad_account_id: 'x', campaign_id: '__optest_hist_c', campaign_name: 'hist fixture', action: 'PAUSE', rule_name: 'AUTO:ZERO_ORDER', mode_at_decision: 'AUTOPILOT', confidence: 'HIGH', error: 'القرار اتبطل — DECISION_CHANGED', params_json: JSON.stringify({ kind: 'ZERO_ORDER', level: 'campaign' }), why_json: JSON.stringify({ why: 'صرف 260 بدون أوردرات' }), evidence_json: JSON.stringify({ history: { kind: 'ZERO_ORDER' } }) } });
  try { const l2 = await H.listExecutionHistory({ limit: 300 }); const r2 = l2.rows.find((x) => x.decisionId === d.id);
    ok('an EXPIRED automatic decision appears (negative id, origin AUTOMATIC, final BLOCKED, with the decision reason and why it did not happen)', !!r2 && r2.id === -d.id && r2.origin === 'AUTOMATIC' && r2.final === 'BLOCKED' && /DECISION_CHANGED/.test(r2.error) && /260/.test(r2.decisionReason) && r2.kind === 'ZERO_ORDER' && r2.stages.find((s) => s.key === 'SENT').done === false);
    ok('it respects the type filter and the final filter', (await H.listExecutionHistory({ type: 'PAUSE', limit: 300 })).rows.some((x) => x.decisionId === d.id) && !(await H.listExecutionHistory({ type: 'RESUME', limit: 300 })).rows.some((x) => x.decisionId === d.id) && (await H.listExecutionHistory({ final: 'BLOCKED', limit: 300 })).rows.some((x) => x.decisionId === d.id)); }
  finally { await prisma.ambOperatorDecision.delete({ where: { id: d.id } }); } }
console.log('\nToday summary (Africa/Cairo day)');
ok('Cairo day start in winter (UTC+2) is 22:00Z of the previous day', H.cairoDayStart(new Date('2026-01-15T10:00:00Z')).toISOString() === '2026-01-14T22:00:00.000Z', H.cairoDayStart(new Date('2026-01-15T10:00:00Z')).toISOString());
ok('Cairo day start in summer (UTC+3) is 21:00Z of the previous day', H.cairoDayStart(new Date('2026-07-15T10:00:00Z')).toISOString() === '2026-07-14T21:00:00.000Z', H.cairoDayStart(new Date('2026-07-15T10:00:00Z')).toISOString());
ok('00:30 Cairo still belongs to the new Cairo day (22:30Z in winter)', H.cairoDayStart(new Date('2026-01-14T22:30:00Z')).toISOString() === '2026-01-14T22:00:00.000Z');
const sm = await H.todaySummary({ now: new Date(), deps: { config: { mode: 'APPROVAL', emergency_stop: false, writesLocked: true, execPermissions: { open: false, pause: false, budgetIncrease: false, budgetDecrease: false } } } });
ok('summary has the four operation counters (sent vs Meta-verified), failed/blocked/uncertain and exposure', ['opened', 'paused', 'increased', 'reduced'].every((k) => typeof sm[k].sent === 'number' && sm[k].verified <= sm[k].sent) && ['failed', 'blocked', 'uncertain', 'exposureAdded', 'budgetReleased'].every((k) => typeof sm[k] === 'number'));
ok('a locked-writes config is reported as WRITES_LOCKED (never as ready)', sm.health.status === 'WRITES_LOCKED' && sm.health.mode === 'APPROVAL');
const sm2 = await H.todaySummary({ now: new Date(), deps: { config: { mode: 'APPROVAL', emergency_stop: true, writesLocked: false, execPermissions: {} } } });
ok('Emergency Stop wins over every other health state', sm2.health.status === 'EMERGENCY_STOP');

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
