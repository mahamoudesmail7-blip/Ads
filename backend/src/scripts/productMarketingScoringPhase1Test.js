// Phase 1 PMC scoring extensions — pure functions over plain objects, no
// prisma, no mocks needed (nothing here touches a DB or an AI call).
//   node src/scripts/productMarketingScoringPhase1Test.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const {
  healthBand, dataSufficiencyOf, bandMarket, bandCreativeLabel, prioritizeActions, computeDiagnosis,
} = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketingScoring.js')).href);

console.log('§1 healthBand — pure banding over an existing score:');
{
  ok('score 90, sufficient -> HEALTHY', healthBand(90, true) === 'HEALTHY');
  ok('score 75, sufficient -> GOOD', healthBand(75, true) === 'GOOD');
  ok('score 55, sufficient -> NEEDS_ATTENTION', healthBand(55, true) === 'NEEDS_ATTENTION');
  ok('score 35, sufficient -> AT_RISK', healthBand(35, true) === 'AT_RISK');
  ok('score 10, sufficient -> CRITICAL', healthBand(10, true) === 'CRITICAL');
  ok('dataSufficient false -> INSUFFICIENT_DATA regardless of score', healthBand(95, false) === 'INSUFFICIENT_DATA');
  ok('null score -> INSUFFICIENT_DATA', healthBand(null, true) === 'INSUFFICIENT_DATA');
}

console.log('\n§2 dataSufficiencyOf — matches the SAME thresholds used elsewhere (spend>=300&purchases>=5=STRONG, spend>=150=MODERATE):');
{
  ok('spend 400, purchases 6 -> STRONG', dataSufficiencyOf({ spend: 400, purchases: 6 }) === 'STRONG');
  ok('spend 200, purchases 2 -> MODERATE', dataSufficiencyOf({ spend: 200, purchases: 2 }) === 'MODERATE');
  ok('spend 50, purchases 0 -> WEAK', dataSufficiencyOf({ spend: 50, purchases: 0 }) === 'WEAK');
}

console.log('\n§3 bandMarket — never ranks by order count alone:');
{
  ok('below minOrders -> INSUFFICIENT_DATA', bandMarket({ orders: 3, delivered: 3, confirmed: 3 }, { minOrders: 10 }) === 'INSUFFICIENT_DATA');
  ok('high orders but low delivery rate -> REDUCE_PRIORITY (RTO signal), not SCALE just because orders are high', bandMarket({ orders: 100, confirmed: 80, delivered: 20 }, { minOrders: 10 }) === 'REDUCE_PRIORITY');
  ok('high orders + high delivery rate -> SCALE_MARKET', bandMarket({ orders: 30, confirmed: 25, delivered: 18 }, { minOrders: 10 }) === 'SCALE_MARKET');
  ok('moderate delivery rate, enough orders -> KEEP_TESTING', bandMarket({ orders: 12, confirmed: 10, delivered: 5 }, { minOrders: 10 }) === 'KEEP_TESTING');
}

console.log('\n§4 bandCreativeLabel — never labels WINNER from weak/untested data:');
{
  ok('zero purchases -> UNTESTED', bandCreativeLabel({ spend: 0, purchases: 0, cpa: null, dataSufficiency: 'WEAK' }, { targetCpa: 100 }) === 'UNTESTED');
  ok('WEAK dataSufficiency even with a good CPA -> never WINNER', bandCreativeLabel({ spend: 60, purchases: 2, cpa: 50, dataSufficiency: 'WEAK' }, { targetCpa: 100, minSpend: 150 }) !== 'WINNER');
  ok('STRONG data + CPA well under target + enough purchases -> WINNER', bandCreativeLabel({ spend: 500, purchases: 10, cpa: 60, dataSufficiency: 'STRONG' }, { targetCpa: 100, minSpend: 150, minPurchases: 5 }) === 'WINNER');
  ok('CPA roughly at target -> PROMISING, not WINNER', bandCreativeLabel({ spend: 500, purchases: 6, cpa: 98, dataSufficiency: 'MODERATE' }, { targetCpa: 100, minSpend: 150, minPurchases: 5 }) === 'PROMISING');
  ok('CPA well above target -> WEAK', bandCreativeLabel({ spend: 500, purchases: 6, cpa: 200, dataSufficiency: 'STRONG' }, { targetCpa: 100, minSpend: 150, minPurchases: 5 }) === 'WEAK');
}

console.log('\n§5 prioritizeActions — deterministic P0-P3 by cross-referencing diagnosis, no new AI call:');
{
  const diagnosis = [{ severity: 'HIGH', category: 'CPA_PROBLEM' }];
  const actions = [
    { actionKey: 'reduce_cpa', title: 'قلل الـCPA', reason: 'تكلفة الشراء مرتفعة' },
    { actionKey: 'scale_winner', title: 'وسّع الحملة الفائزة', reason: 'دي حملة كسب' },
    { actionKey: 'wait_more_data', title: 'انتظر بيانات أكتر', reason: 'مفيش بيانات كفاية' },
  ];
  const out = prioritizeActions(actions, diagnosis);
  ok('CPA-related action tied to a HIGH CPA_PROBLEM diagnosis -> P0', out[0].priority === 'P0', JSON.stringify(out[0]));
  ok('winner/scale action -> P1', out[1].priority === 'P1', JSON.stringify(out[1]));
  ok('data-gap action with an insufficient-data diagnosis -> not P0', out[2].priority !== 'P0', JSON.stringify(out[2]));
}

console.log('\n§6 computeDiagnosis — every item now carries category/priority/dataSufficiency, same real conditions as before:');
{
  const metrics = { totalSpend: 1000, metaPurchases: 20, avgCpa: 200, deliveredCpa: null, deliveryRate: null, ctr: 2, cpc: 1, cvr: 3, frequency: 1, dataAvailability: { metaMapped: true } };
  const out = computeDiagnosis({ metrics, creative: null, settings: { ambDefaultTargetCpa: 100 } });
  const cpaItem = out.find((d) => d.category === 'CPA_PROBLEM');
  ok('CPA-above-target item exists and is tagged CPA_PROBLEM/P0', cpaItem && cpaItem.priority === 'P0', JSON.stringify(cpaItem));
  ok('every item has a category, priority, and dataSufficiency', out.every((d) => d.category && d.priority && d.dataSufficiency), JSON.stringify(out));
}

console.log('\n§7 computeDiagnosis fatigue — requires a second corroborating signal when a prior window is available:');
{
  const baseMetrics = { totalSpend: 1000, metaPurchases: 20, avgCpa: 90, deliveredCpa: null, deliveryRate: null, ctr: 2, cpc: 1, cvr: 3, frequency: 4, dataAvailability: { metaMapped: true } };
  const settings = { ambDefaultTargetCpa: 100 };

  const noPrior = computeDiagnosis({ metrics: baseMetrics, creative: null, settings });
  const fatigueNoPrior = noPrior.find((d) => d.category === 'CREATIVE_FATIGUE');
  ok('no prior window -> fatigue still surfaced but at WEAK dataSufficiency (single signal, not silently upgraded)', fatigueNoPrior && fatigueNoPrior.dataSufficiency === 'WEAK', JSON.stringify(fatigueNoPrior));

  const priorMetricsStable = { ctr: 2, avgCpa: 90 }; // no decline/rise
  const stable = computeDiagnosis({ metrics: baseMetrics, creative: null, priorMetrics: priorMetricsStable, settings });
  ok('prior window stable (no CTR decline, no CPA rise) -> fatigue NOT raised', !stable.some((d) => d.category === 'CREATIVE_FATIGUE'), JSON.stringify(stable));

  const priorMetricsDeclining = { ctr: 3, avgCpa: 90 }; // CTR was much higher before -> declining now
  const declining = computeDiagnosis({ metrics: baseMetrics, creative: null, priorMetrics: priorMetricsDeclining, settings });
  const fatigueDeclining = declining.find((d) => d.category === 'CREATIVE_FATIGUE');
  ok('prior window shows CTR decline -> fatigue raised at full (non-WEAK) dataSufficiency', fatigueDeclining && fatigueDeclining.dataSufficiency !== 'WEAK', JSON.stringify(fatigueDeclining));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
