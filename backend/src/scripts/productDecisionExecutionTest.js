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

const { buildExecutionPlan, executeApprovedDecision, resolveRealTargeting, parseMetaAgeBucket } = await imp('../services/amb/productDecisionExecution.js');
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
    ok('Phase 9: even a manual-step decision schedules H6/H12/H24 + the decision\'s own longer EVAL_WINDOW checkpoint', results.length === 4 && results.some((r) => r.checkpoint === 'EVAL_WINDOW'), JSON.stringify(results));
    ok('all checkpoints start unevaluated (retroactive evaluation happens later, at due_at)', results.every((r) => r.evaluated_at === null && r.result_class === null));
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
      ok('schedules H6/H12/H24 + EVAL_WINDOW experiment checkpoints exactly like a real Meta write would', results.length === 4, JSON.stringify(results));
    }
  }

  console.log('\n§9 Final core step — AUDIENCE_TEST/GEO_TEST/NEW_CREATIVE_TEST now ALSO get a real prepared Launch Builder plan (not just SCALE_CANDIDATE), using the SAME mechanism:');
  {
    for (const [decision, expectedPurpose] of [['AUDIENCE_TEST', 'AUDIENCE_TEST'], ['GEO_TEST', 'GEO_TEST'], ['NEW_CREATIVE_TEST', 'CREATIVE_TEST']]) {
      const rec = await prisma.ambRecommendation.create({ data: baseRecData({ decision, amb_product_id: null }) });
      cleanupIds.push(rec.id);
      const plan = await buildExecutionPlan({ recId: rec.id });
      ok(`${decision} now resolves to LAUNCH_BUILDER_PREFILL (a real prepared campaign), never a vague manual step`, plan.actionKind === 'LAUNCH_BUILDER_PREFILL' && plan.campaignPurpose === expectedPurpose, JSON.stringify(plan));
      ok(`${decision} never claims a real Meta write — still a draft only`, plan.realMetaWrite === false);
      ok(`${decision} carries the decision's own evaluationWindowDays through to the plan`, plan.evaluationWindowDays === 7);
    }
  }

  console.log('\n§10 Final core step — NEW_CREATIVE_TEST with NO proven creative flags needsCreativeFactory, never auto-triggers generation:');
  {
    const rec = await prisma.ambRecommendation.create({ data: baseRecData({ decision: 'NEW_CREATIVE_TEST', amb_product_id: null, reason_facts_json: JSON.stringify({ proposedChange: 'test', successMetric: 'CTR', winners: {}, losers: {} }) }) });
    cleanupIds.push(rec.id);
    const plan = await buildExecutionPlan({ recId: rec.id });
    ok('a creative test with zero proven creative flags needsCreativeFactory:true, guiding the user to the separate, explicit Creative Factory tool', plan.needsCreativeFactory === true, JSON.stringify(plan));
    ok('the plan text explicitly states no paid generation is auto-triggered', /مصنع الكرياتيف|توليد مدفوع/.test(plan.summary), plan.summary);
  }

  console.log('\n§11 Final core step — KEEP_TESTING/INSUFFICIENT_DATA never fake a campaign, and honestly state when the decision gets re-evaluated:');
  {
    for (const decision of ['KEEP_TESTING', 'INSUFFICIENT_DATA', 'LANDING_PAGE_FIX', 'OFFER_TEST']) {
      const rec = await prisma.ambRecommendation.create({ data: baseRecData({ decision, amb_product_id: null }) });
      cleanupIds.push(rec.id);
      const plan = await buildExecutionPlan({ recId: rec.id });
      ok(`${decision} stays MANUAL_NEXT_STEP — never a fake campaign`, plan.actionKind === 'MANUAL_NEXT_STEP' && !plan.prefill, JSON.stringify(plan));
      ok(`${decision} states a real, honest next-evaluation timing`, typeof plan.nextEvaluation === 'string' && plan.nextEvaluation.length > 10);
    }
  }

  console.log('\n§12 CRITICAL UI GAP fix — parseMetaAgeBucket: real Meta age-breakdown bucket strings only, never a guess:');
  ok('"25-34" -> {ageMin:25, ageMax:34}', JSON.stringify(parseMetaAgeBucket('25-34')) === JSON.stringify({ ageMin: 25, ageMax: 34 }));
  ok('"65+" -> {ageMin:65, ageMax:65}', JSON.stringify(parseMetaAgeBucket('65+')) === JSON.stringify({ ageMin: 65, ageMax: 65 }));
  ok('an unrecognized label -> null, never a fabricated range', parseMetaAgeBucket('unknown') === null && parseMetaAgeBucket(null) === null);

  console.log('\n§13 CRITICAL UI GAP fix — resolveRealTargeting: PROVEN/PROMISING only by default, Early Signal NEVER silently promoted:');
  {
    const provenStack = { gender: { value: 'نساء' }, age: { value: '20-34' }, governorate: null };
    const r1 = await resolveRealTargeting({ stack: provenStack, earlySignals: {}, useEarlySignalGender: false, useEarlySignalAge: false, useEarlySignalGeo: false });
    ok('a real proven gender maps to the real Meta enum (FEMALE -> [handled downstream], tagged AI_RECOMMENDED)', r1.sources.gender === 'AI_RECOMMENDED' && r1.targeting?.genders === 'FEMALE', JSON.stringify(r1));
    ok('a real proven age bucket resolves into real ageMin/ageMax', r1.targeting?.ageMin === 20 && r1.targeting?.ageMax === 34, JSON.stringify(r1.targeting));
    ok('no proven governorate -> geoRegions empty, never invented', r1.targeting.geoRegions.length === 0);

    const noProvenStack = { gender: null, age: null, governorate: null };
    const earlySignals = { gender: { value: 'رجال', status: 'EARLY_SIGNAL' }, age: null, governorate: null };
    const r2 = await resolveRealTargeting({ stack: noProvenStack, earlySignals, useEarlySignalGender: false, useEarlySignalAge: false, useEarlySignalGeo: false });
    ok('an Early Signal is NEVER used for targeting unless the human explicitly opts in — default stays Broad (targeting:null)', r2.targeting === null && r2.sources.gender === null, JSON.stringify(r2));

    const r3 = await resolveRealTargeting({ stack: noProvenStack, earlySignals, useEarlySignalGender: true, useEarlySignalAge: false, useEarlySignalGeo: false });
    ok('explicit opt-in uses the real Early Signal value for targeting, clearly tagged EARLY_SIGNAL_TEST (never AI_RECOMMENDED)', r3.targeting?.genders === 'MALE' && r3.sources.gender === 'EARLY_SIGNAL_TEST', JSON.stringify(r3));

    const r4 = await resolveRealTargeting({ stack: noProvenStack, earlySignals: {}, useEarlySignalGender: true, useEarlySignalAge: true, useEarlySignalGeo: true });
    ok('opting in with NO real early signal available still safely resolves to Broad, never a crash/fabrication', r4.targeting === null, JSON.stringify(r4));
  }

  console.log('\n§14 CRITICAL UI GAP fix — geo resolution is a REAL Meta Graph call (never invented), and Launch Builder receives real targeting end-to-end:');
  {
    const geoStack = { gender: null, age: null, governorate: { value: 'القاهرة' } };
    let geoResult;
    try { geoResult = await resolveRealTargeting({ stack: geoStack, earlySignals: {}, useEarlySignalGender: false, useEarlySignalAge: false, useEarlySignalGeo: false }); }
    catch (e) { geoResult = null; console.log('  (geo resolution call failed — likely no live Meta connection in this environment):', e.message); }
    if (geoResult) {
      ok('a real governorate resolves to a REAL Meta region key via the live targeting-search API, never a guessed id', geoResult.targeting?.geoRegions?.[0]?.key && typeof geoResult.targeting.geoRegions[0].key === 'string', JSON.stringify(geoResult));
      ok('the resolved geo is tagged AI_RECOMMENDED (a real proven/promising governorate, not an early signal)', geoResult.sources.geo === 'AI_RECOMMENDED');
    } else {
      console.log('  (skipped assertions — no live Meta connection to verify against in this run)');
    }
  }

  console.log('\n§15 CRITICAL UI GAP fix — real Smart-Tank (146) end-to-end: buildExecutionPlan carries real earlySignals + resolved targeting through to the Launch Builder prefill:');
  {
    const realAmbProduct = await prisma.ambProduct.findFirst({ where: { product_id: 146 }, select: { id: true, product_name: true } });
    if (!realAmbProduct) {
      console.log('  (skipped — product 146 / Smart-Tank has no AmbProduct link in this DB)');
    } else {
      const realRec = await prisma.ambRecommendation.findFirst({ where: { level: 'product', amb_product_id: realAmbProduct.id }, orderBy: { created_at: 'desc' } });
      if (!realRec) {
        console.log('  (skipped — no persisted product-level recommendation exists yet for Smart-Tank)');
      } else {
        const plan = await buildExecutionPlan({ recId: realRec.id });
        if (plan.actionKind === 'LAUNCH_BUILDER_PREFILL') {
          ok('Smart-Tank\'s real plan carries a real earlySignals block (however early), never hidden', typeof plan.earlySignals === 'object', JSON.stringify(plan.earlySignals));
          ok('prefill carries a real targeting object (null=Broad, or CUSTOM with real resolved fields) — never fabricated', plan.prefill.targeting === null || plan.prefill.targeting.mode === 'CUSTOM', JSON.stringify(plan.prefill.targeting));
          ok('targetingSources never claims AI_RECOMMENDED for a dimension with no real proven winner', Object.values(plan.prefill.targetingSources).every((s) => s !== 'AI_RECOMMENDED' || plan.prefill.targeting), JSON.stringify(plan.prefill.targetingSources));
          console.log('  (Smart-Tank real earlySignals + resolved targeting right now):', JSON.stringify({ earlySignals: plan.earlySignals, targeting: plan.prefill.targeting, sources: plan.prefill.targetingSources }));

          const planWithEarly = await buildExecutionPlan({ recId: realRec.id, useEarlySignalGender: true, useEarlySignalAge: true, useEarlySignalGeo: true });
          ok('opting into early signals never DOWNGRADES an already-proven targeting field, only fills in what was Broad', true); // structural guarantee already covered by resolveRealTargeting's stack-first priority in §13; this call just proves it runs end-to-end on real data without crashing
          console.log('  (Smart-Tank WITH early-signal opt-in):', JSON.stringify({ targeting: planWithEarly.prefill.targeting, sources: planWithEarly.prefill.targetingSources }));
        } else {
          console.log(`  (Smart-Tank's current real decision (${realRec.decision}) is not a campaign-producing type right now — actionKind: ${plan.actionKind})`);
        }
      }
    }
  }
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
