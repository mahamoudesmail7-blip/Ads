// Smart Decision Center Phase 8 — services/amb/productDecisionExecution.js.
// Real throwaway AmbRecommendation rows (tagged, cleaned up after). Proves
// the mandatory safety boundary: buildExecutionPlan() never writes to Meta
// under any circumstance, and executeApprovedDecision() refuses a real
// Meta write (PAUSE_CANDIDATE) without BOTH prior approval AND an explicit
// confirmRealExecution:true flag. Never calls Meta with a real, existing
// campaign id — PAUSE_CANDIDATE is only ever tested against a product with
// NO resolvable campaigns, so even a "confirmed" call has nothing to pause.
//   node src/scripts/productDecisionExecutionTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { buildExecutionPlan, executeApprovedDecision } = await imp('../services/amb/productDecisionExecution.js');
const { prisma } = await imp('../prisma.js');

const cleanupIds = [];
async function cleanup() {
  for (const id of cleanupIds) {
    await prisma.ambAction.deleteMany({ where: { recommendation_id: id } });
    await prisma.ambRecommendation.deleteMany({ where: { id } });
  }
}

function baseRecData(overrides = {}) {
  return {
    batch_id: `test-exec-${Date.now()}-${Math.random()}`,
    ad_account_id: 'act_test_exec',
    level: 'product',
    decision: 'KEEP_TESTING',
    action_type: 'DRAFT_PRODUCT_DECISION',
    executable: false,
    reason: 'test reason',
    reason_facts_json: JSON.stringify({ proposedChange: 'test proposed change', successMetric: 'CPA', winners: {}, losers: {} }),
    confidence: 'LOW',
    status: 'PENDING',
    ...overrides,
  };
}

try {
  console.log('§1 buildExecutionPlan — always read-only, safe for any status:');
  {
    const rec = await prisma.ambRecommendation.create({ data: baseRecData() });
    cleanupIds.push(rec.id);
    const plan = await buildExecutionPlan({ recId: rec.id });
    ok('KEEP_TESTING resolves to MANUAL_NEXT_STEP', plan.actionKind === 'MANUAL_NEXT_STEP', JSON.stringify(plan));
    ok('never claims a real Meta write for a manual step', plan.realMetaWrite === false);
  }

  console.log('\n§2 PAUSE_CANDIDATE plan — names the real (or honestly empty) target list, never a vague claim:');
  {
    const rec = await prisma.ambRecommendation.create({ data: baseRecData({ decision: 'PAUSE_CANDIDATE', amb_product_id: null }) });
    cleanupIds.push(rec.id);
    const plan = await buildExecutionPlan({ recId: rec.id });
    ok('PAUSE_CANDIDATE with no linked AmbProduct resolves zero real targets, never a guess', plan.actionKind === 'META_WRITE' && plan.targets.length === 0, JSON.stringify(plan));
    ok('flags realMetaWrite:true so the UI knows to require extra confirmation', plan.realMetaWrite === true);
  }

  console.log('\n§3 executeApprovedDecision — refuses without prior approval, regardless of confirmRealExecution:');
  {
    const rec = await prisma.ambRecommendation.create({ data: baseRecData({ status: 'PENDING' }) });
    cleanupIds.push(rec.id);
    let threw = false;
    try { await executeApprovedDecision({ recId: rec.id, userId: null, confirmRealExecution: true }); } catch (e) { threw = true; ok('error explicitly says approval is required first', /الموافقة عليه أولاً/.test(e.message), e.message); }
    ok('PENDING (never approved) recommendation refuses execution even with confirmRealExecution:true', threw);
  }

  console.log('\n§4 executeApprovedDecision — a real Meta write is NEVER performed without the explicit confirmRealExecution flag:');
  {
    const rec = await prisma.ambRecommendation.create({ data: baseRecData({ decision: 'PAUSE_CANDIDATE', status: 'APPROVED' }) });
    cleanupIds.push(rec.id);
    const result = await executeApprovedDecision({ recId: rec.id, userId: null, confirmRealExecution: false });
    ok('without confirmRealExecution, the call returns requiresConfirmation, never executes', result.ok === false && result.requiresConfirmation === true, JSON.stringify(result));
    const after = await prisma.ambRecommendation.findUnique({ where: { id: rec.id } });
    ok('the recommendation status is untouched (still APPROVED, never silently EXECUTED)', after.status === 'APPROVED');
    const actions = await prisma.ambAction.findMany({ where: { recommendation_id: rec.id } });
    ok('zero AmbAction rows were created — no attempt was made', actions.length === 0);
  }

  console.log('\n§5 executeApprovedDecision — a decision with NO real Meta targets refuses even WITH confirmRealExecution:true (nothing to pause):');
  {
    const rec = await prisma.ambRecommendation.create({ data: baseRecData({ decision: 'PAUSE_CANDIDATE', status: 'APPROVED', amb_product_id: null }) });
    cleanupIds.push(rec.id);
    let threw = false;
    try { await executeApprovedDecision({ recId: rec.id, userId: null, confirmRealExecution: true }); } catch (e) { threw = true; ok('error explicitly says there is nothing real to act on', /لا يوجد إجراء ممكن/.test(e.message), e.message); }
    ok('refuses rather than silently no-op-succeeding', threw);
  }

  console.log('\n§6 executeApprovedDecision — MANUAL_NEXT_STEP decisions execute immediately (no Meta call is even possible for these):');
  {
    const rec = await prisma.ambRecommendation.create({ data: baseRecData({ decision: 'KEEP_TESTING', status: 'APPROVED' }) });
    cleanupIds.push(rec.id);
    const result = await executeApprovedDecision({ recId: rec.id, userId: null, confirmRealExecution: false });
    ok('a manual-step decision succeeds immediately, no confirmation gate needed (no Meta write exists for it)', result.ok === true, JSON.stringify(result));
    const after = await prisma.ambRecommendation.findUnique({ where: { id: rec.id } });
    ok('status correctly moves to EXECUTED', after.status === 'EXECUTED');
    const results = await prisma.ambActionResult.findMany({ where: { action_id: result.actionId } });
    ok('Phase 9: even a manual-step decision schedules the 3 H6/H12/H24 experiment checkpoints', results.length === 3, JSON.stringify(results));
    ok('all 3 checkpoints start unevaluated (retroactive evaluation happens later, at due_at)', results.every((r) => r.evaluated_at === null && r.result_class === null));
  }

  console.log('\n§7 executeApprovedDecision — SCALE_CANDIDATE prefill also requires explicit confirmation before touching anything:');
  {
    const rec = await prisma.ambRecommendation.create({ data: baseRecData({ decision: 'SCALE_CANDIDATE', status: 'APPROVED', amb_product_id: null }) });
    cleanupIds.push(rec.id);
    const result = await executeApprovedDecision({ recId: rec.id, userId: null, confirmRealExecution: false });
    ok('without confirmation, SCALE_CANDIDATE also just returns the plan, never acts', result.ok === false && result.requiresConfirmation === true, JSON.stringify(result));
    const after = await prisma.ambRecommendation.findUnique({ where: { id: rec.id } });
    ok('status stays APPROVED, never silently EXECUTED', after.status === 'APPROVED');
  }

  console.log('\n§8 Phase 9: a confirmed SCALE_CANDIDATE (real linked AmbProduct) becomes a measurable Experiment too:');
  {
    const realAmbProduct = await prisma.ambProduct.findFirst({ where: { product_id: { not: null } }, select: { id: true } });
    if (!realAmbProduct) {
      console.log('  (skipped — no real AmbProduct linked to a Product exists in this DB)');
    } else {
      const rec = await prisma.ambRecommendation.create({ data: baseRecData({ decision: 'SCALE_CANDIDATE', status: 'APPROVED', amb_product_id: realAmbProduct.id }) });
      cleanupIds.push(rec.id);
      const result = await executeApprovedDecision({ recId: rec.id, userId: null, confirmRealExecution: true });
      ok('a confirmed prefill decision executes (never touches real Meta — only creates a local draft reference)', result.ok === true, JSON.stringify(result));
      const results = result.actionId ? await prisma.ambActionResult.findMany({ where: { action_id: result.actionId } }) : [];
      ok('schedules the 3 H6/H12/H24 experiment checkpoints exactly like a real Meta write would', results.length === 3, JSON.stringify(results));
    }
  }
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
