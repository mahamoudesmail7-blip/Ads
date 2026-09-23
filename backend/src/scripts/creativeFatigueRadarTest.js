// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 2 (Creative Fatigue Radar) verification. Real reads against
// production data + one real throwaway AssistantTask/AmbLaunchJob (cleaned
// up after) — NEVER approves, NEVER calls Meta.
//   node src/scripts/creativeFatigueRadarTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { classifyFatigueRadar } = await imp('../services/amb/creativeFatigueRadar.js');
const { creativeIntelForProduct } = await imp('../services/amb/creativeIntel.js');
const { getAmbSettings } = await imp('../services/amb/settings.js');
const { prepare_scale } = await imp('../services/aiToolsWrite.js');
const { get_amb_creative_intel } = await imp('../services/aiTools.js');
const { getConnection } = await imp('../services/metaAuth.js');

const cleanupTaskUuids = [];
const cleanupJobIds = [];
async function cleanup() {
  for (const taskUuid of cleanupTaskUuids) await prisma.assistantTask.deleteMany({ where: { task_uuid: taskUuid } }).catch(() => {});
  for (const jobId of cleanupJobIds) await prisma.ambLaunchJob.deleteMany({ where: { job_id: jobId } }).catch(() => {});
}

const VALID_STATES = ['NEW', 'LEARNING', 'HEALTHY', 'WATCH', 'FATIGUING', 'FATIGUED', 'INSUFFICIENT_DATA'];

try {
  console.log('§1 Pure fixture assertions — classifyFatigueRadar:');
  {
    const insufficient = classifyFatigueRadar({ ctr: 2 }, null, { classification: 'INSUFFICIENT_DATA', signalStrength: 'NO_SIGNAL', evidence: 'x' });
    ok('INSUFFICIENT_DATA verdict passes through unchanged', insufficient.state === 'INSUFFICIENT_DATA');

    const fatigued = classifyFatigueRadar({ ctr: 1 }, { ctr: 2, dataSufficiency: 'STRONG' }, { classification: 'FATIGUED', signalStrength: 'OBSERVED', evidence: 'real decline' });
    ok('FATIGUED verdict passes through unchanged', fatigued.state === 'FATIGUED' && fatigued.evidence === 'real decline');

    const noPriorHealthy = classifyFatigueRadar({ ctr: 3 }, null, { classification: 'WINNER', signalStrength: 'OBSERVED', evidence: 'x' });
    ok('no priorRow + WINNER -> HEALTHY', noPriorHealthy.state === 'HEALTHY');
    const noPriorNew = classifyFatigueRadar({ ctr: 3 }, null, { classification: 'TESTING', signalStrength: 'EARLY_SIGNAL', evidence: 'x' });
    ok('no priorRow + EARLY_SIGNAL -> NEW', noPriorNew.state === 'NEW');
    const noPriorLearning = classifyFatigueRadar({ ctr: 3 }, null, { classification: 'TESTING', signalStrength: 'NO_SIGNAL', evidence: 'x' });
    ok('no priorRow + no signal -> LEARNING', noPriorLearning.state === 'LEARNING');

    const watch = classifyFatigueRadar({ ctr: 1.8 }, { ctr: 2, dataSufficiency: 'STRONG' }, { classification: 'WINNER', signalStrength: 'OBSERVED', evidence: 'x' });
    ok('WINNER + 10% CTR decline -> WATCH (not yet the 15% FATIGUED cliff)', watch.state === 'WATCH', JSON.stringify(watch));
    const healthySteady = classifyFatigueRadar({ ctr: 2.1 }, { ctr: 2, dataSufficiency: 'STRONG' }, { classification: 'WINNER', signalStrength: 'OBSERVED', evidence: 'x' });
    ok('WINNER + stable/improving CTR -> HEALTHY', healthySteady.state === 'HEALTHY');

    const fatiguing = classifyFatigueRadar({ ctr: 1.8 }, { ctr: 2, dataSufficiency: 'STRONG' }, { classification: 'WEAK', signalStrength: 'OBSERVED', evidence: 'x' });
    ok('WEAK + 10% CTR decline -> FATIGUING', fatiguing.state === 'FATIGUING', JSON.stringify(fatiguing));
    const learningWeak = classifyFatigueRadar({ ctr: 2.1 }, { ctr: 2, dataSufficiency: 'STRONG' }, { classification: 'TESTING', signalStrength: 'OBSERVED', evidence: 'x' });
    ok('TESTING + stable CTR -> LEARNING', learningWeak.state === 'LEARNING');
  }

  console.log('\n§2 Real reads — creativeIntelForProduct(compareToPrior:true) against real products:');
  {
    const settings = await getAmbSettings();
    const connection = await getConnection();
    if (!connection?.selected_ad_account_id) {
      console.log('  (skipped — no connected ad account)');
    } else {
      const ambProducts = await prisma.ambProduct.findMany({ take: 15, orderBy: { id: 'desc' }, select: { id: true, product_name: true } });
      let checked = 0, sawFatigued = 0;
      for (const ap of ambProducts) {
        const data = await creativeIntelForProduct({ adAccountId: connection.selected_ad_account_id, windowName: 'last7', settings, ambProductId: ap.id, compareToPrior: true }).catch(() => null);
        if (!data?.dataAvailable) continue;
        for (const dim of ['creative', 'hooks', 'angles', 'primaryTexts', 'headlines']) {
          for (const row of data[dim]?.table || []) {
            checked++;
            ok(`${ap.product_name} / ${dim} row "${row.label?.slice(0, 30)}" has a valid fatigueRadar state`, !!row.fatigueRadar && VALID_STATES.includes(row.fatigueRadar.state), JSON.stringify(row.fatigueRadar));
            if (row.fatigueRadar?.state === 'FATIGUED') {
              sawFatigued++;
              ok(`${ap.product_name} / ${dim} FATIGUED row cites real evidence`, typeof row.fatigueRadar.evidence === 'string' && row.fatigueRadar.evidence.length > 5);
            }
          }
        }
      }
      ok('checked at least one real classified row', checked > 0, `checked=${checked}`);
      console.log(`  checked ${checked} real rows across ${ambProducts.length} products, ${sawFatigued} already FATIGUED.`);
    }
  }

  console.log('\n§3 get_amb_creative_intel now returns fatigueRadar:');
  {
    const ambProduct = await prisma.ambProduct.findFirst({ select: { product_id: true, product_name: true } });
    if (!ambProduct?.product_id) {
      console.log('  (skipped — no AmbProduct with a linked product_id found)');
    } else {
      const out = await get_amb_creative_intel({ productId: ambProduct.product_id, window: 'last7' });
      ok('tool call succeeds', out.ok === true, JSON.stringify(out).slice(0, 200));
      if (out.hasData) {
        const row = out.creative?.table?.[0];
        ok('first creative row (if any) carries a valid fatigueRadar', !row || (!!row.fatigueRadar && VALID_STATES.includes(row.fatigueRadar.state)), JSON.stringify(row?.fatigueRadar));
      }
    }
  }

  console.log('\n§4 prepare_scale — sourceWinner carries fatigue state:');
  {
    const adminUser = await prisma.user.findFirst({ where: { role: { in: ['ADMIN', 'MANAGER'] } }, select: { id: true } });
    const connection = await getConnection();
    if (!adminUser || !connection?.selected_ad_account_id) {
      console.log('  (skipped — no admin user or connected ad account)');
    } else {
      const { loadWinningStackForProduct } = await imp('../services/assistantTasks/scalePrepare.js');
      const ambProducts = await prisma.ambProduct.findMany({ take: 40, orderBy: { id: 'desc' }, select: { product_id: true, product: { select: { id: true, product_name: true, active: true, is_historical: true } } } });
      const candidates = ambProducts.filter((a) => a.product?.active && !a.product?.is_historical).map((a) => a.product);
      let scaleCandidate = null;
      for (const p of candidates) {
        const r = await loadWinningStackForProduct({ productId: p.id, adAccountId: connection.selected_ad_account_id }).catch(() => ({ ok: false }));
        if (r.ok) { scaleCandidate = p; break; }
      }
      if (!scaleCandidate) {
        console.log('  (skipped — no real SCALE_CANDIDATE product found)');
      } else {
        const out = await prepare_scale({ productId: scaleCandidate.id, budgetEgp: 100, websiteUrl: 'https://example.com/fatigue-radar-test', userId: adminUser.id, conversationRef: 'creativeFatigueRadarTest', context: {} });
        ok('prepare_scale returns ok:true or a real BLOCKED (never a crash)', out.ok === true || out.error === 'BLOCKED', JSON.stringify(out).slice(0, 300));
        if (out.task) {
          cleanupTaskUuids.push(out.task.taskUuid);
          if (out.task.launchJobId) cleanupJobIds.push(out.task.launchJobId);
          if (out.task.status === 'WAITING_FOR_APPROVAL') {
            const sw = out.task.preparedPayload?.sourceWinner;
            ok('sourceWinner carries a valid fatigueState (or null)', !!sw && (sw.fatigueState === null || VALID_STATES.includes(sw.fatigueState)), JSON.stringify(sw));
            console.log('  sourceWinner:', JSON.stringify(sw));
            if (['WATCH', 'FATIGUING'].includes(sw?.fatigueState)) {
              ok('a WATCH/FATIGUING winner surfaces a moneyGuardWarning mentioning the creative', typeof out.task.preparedPayload.moneyGuardWarning === 'string' && out.task.preparedPayload.moneyGuardWarning.includes('الكرياتيف'), out.task.preparedPayload.moneyGuardWarning);
            }
          }
        }
      }
    }
  }
} finally {
  await cleanup();
  console.log('\ncleanup done —', cleanupTaskUuids.length, 'test task(s),', cleanupJobIds.length, 'test job(s) removed.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
