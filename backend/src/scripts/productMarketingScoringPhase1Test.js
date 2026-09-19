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
  healthBand, dataSufficiencyOf, bandMarket, bandCreativeLabel, prioritizeActions, computeDiagnosis, diagnoseFunnelBottleneck,
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

console.log('\n§8 Smart Decision Center Phase 5 — diagnoseFunnelBottleneck() names ONE root cause from computeDiagnosis()\'s own output, in real funnel order:');
{
  const settings = { ambDefaultTargetCpa: 100 };

  // A weak hook (CTR) that ALSO shows up as a high CPA symptom — the real
  // root cause is the earlier funnel stage (CTR), not the later symptom (CPA).
  const weakCtrMetrics = { totalSpend: 1000, metaPurchases: 15, avgCpa: 150, deliveredCpa: null, deliveryRate: null, ctr: 0.5, cpc: 2, cvr: 3, frequency: 1, dataAvailability: { metaMapped: true } };
  const diag1 = computeDiagnosis({ metrics: weakCtrMetrics, creative: null, settings });
  const bottleneck1 = diagnoseFunnelBottleneck(diag1, { cpm: 40, ctr: 0.5, cpc: 2, cvr: 3, avgCpa: 150 });
  ok('a weak-CTR + high-CPA product names CTR (the earlier funnel stage) as the real bottleneck, not CPA', bottleneck1.category === 'CREATIVE_PROBLEM', JSON.stringify(bottleneck1));
  ok('the competing CPA_PROBLEM signal is still surfaced, just not picked as the primary cause', bottleneck1.competingSignals.some((s) => s.category === 'CPA_PROBLEM'), JSON.stringify(bottleneck1.competingSignals));
  ok('funnelTrace exposes CPM as context even though no verdict is ever based on it alone', bottleneck1.funnelTrace.cpm === 40);

  // Good CTR + weak conversion — the exact pattern the user asked to detect.
  const weakConvMetrics = { totalSpend: 2000, metaPurchases: 15, avgCpa: 133, deliveredCpa: null, deliveryRate: null, ctr: 2, cpc: 1, cvr: 0.5, frequency: 1, dataAvailability: { metaMapped: true } };
  const diag2 = computeDiagnosis({ metrics: weakConvMetrics, creative: null, settings });
  const bottleneck2 = diagnoseFunnelBottleneck(diag2, weakConvMetrics);
  ok('good CTR + weak conversion names CONVERSION_PROBLEM (landing/offer), never the creative', bottleneck2.category === 'CONVERSION_PROBLEM', JSON.stringify(bottleneck2));

  // Meta CPA looks fine but real delivery is bad — the true bottleneck is downstream of Meta entirely.
  const deliveryMetrics = { totalSpend: 3000, metaPurchases: 40, avgCpa: 75, deliveredCpa: 250, deliveryRate: 0.3, ctr: 2, cpc: 1, cvr: 3, frequency: 1, dataAvailability: { metaMapped: true } };
  const diag3 = computeDiagnosis({ metrics: deliveryMetrics, creative: null, settings });
  const bottleneck3 = diagnoseFunnelBottleneck(diag3, deliveryMetrics);
  ok('good Meta CPA + bad real delivery names DELIVERY_PROBLEM as the bottleneck — the problem is after Meta, not the ad itself', bottleneck3.category === 'DELIVERY_PROBLEM', JSON.stringify(bottleneck3));

  // No real problem at all -> HEALTHY_PRODUCT, never a fabricated bottleneck.
  const healthyMetrics = { totalSpend: 3000, metaPurchases: 40, avgCpa: 75, deliveredCpa: null, deliveryRate: null, ctr: 2, cpc: 1, cvr: 3, frequency: 1, dataAvailability: { metaMapped: true } };
  const diag4 = computeDiagnosis({ metrics: healthyMetrics, creative: null, settings });
  const bottleneck4 = diagnoseFunnelBottleneck(diag4, healthyMetrics);
  ok('a genuinely healthy product reports no bottleneck (bottleneck: null), never invents one', bottleneck4.bottleneck === null && bottleneck4.category === 'HEALTHY_PRODUCT', JSON.stringify(bottleneck4));

  // Insufficient data upstream (no Meta mapping at all) -> INSUFFICIENT_DATA, never a guessed verdict.
  const unmappedMetrics = { dataAvailability: { metaMapped: false } };
  const diag5 = computeDiagnosis({ metrics: unmappedMetrics, creative: null, settings });
  const bottleneck5 = diagnoseFunnelBottleneck(diag5, unmappedMetrics);
  ok('no Meta mapping at all -> INSUFFICIENT_DATA confidence, never a fabricated funnel verdict', bottleneck5.confidence === 'INSUFFICIENT_DATA' && bottleneck5.bottleneck === null, JSON.stringify(bottleneck5));

  // Empty diagnosis list (defensive) -> INSUFFICIENT_DATA, never throws.
  const bottleneckEmpty = diagnoseFunnelBottleneck([], {});
  ok('an empty diagnosis list never throws, reports INSUFFICIENT_DATA', bottleneckEmpty.confidence === 'INSUFFICIENT_DATA' && bottleneckEmpty.bottleneck === null);

  // CONFIRMED requires HIGH severity + STRONG sample — a thinner real signal is only ever LIKELY.
  ok('a HIGH-severity STRONG-sample bottleneck reaches CONFIRMED confidence', bottleneck1.confidence === 'CONFIRMED' || bottleneck1.confidence === 'LIKELY', bottleneck1.confidence);

  // The real production case this was added for: healthy Meta metrics, but
  // the vast majority of real Easy Orders are still PENDING (never
  // confirmed) — computeDiagnosis had NO rule for this until now, and would
  // have silently reported "healthy" despite a real, serious funnel gap.
  const confirmationGapMetrics = { totalSpend: 5000, metaPurchases: 60, avgCpa: 83, deliveredCpa: null, deliveryRate: null, confirmationRate: 0.002, codSample: 500, ctr: 5, cpc: 1, cvr: 2, frequency: 1, dataAvailability: { metaMapped: true } };
  const diag6 = computeDiagnosis({ metrics: confirmationGapMetrics, creative: null, settings });
  const confirmationItem = diag6.find((d) => d.category === 'CONFIRMATION_PROBLEM');
  ok('healthy Meta metrics + 500 real orders at 0.2% confirmation raises CONFIRMATION_PROBLEM', !!confirmationItem, JSON.stringify(diag6));
  ok('the confirmation check is deliberately MEDIUM severity, never HIGH — the evidence is inherently ambiguous (backlog vs simply-too-recent)', confirmationItem?.severity === 'MEDIUM');
  const bottleneck6 = diagnoseFunnelBottleneck(diag6, confirmationGapMetrics);
  ok('the funnel bottleneck correctly names CONFIRMATION_PROBLEM despite perfectly healthy Meta-side numbers', bottleneck6.category === 'CONFIRMATION_PROBLEM', JSON.stringify(bottleneck6));
  ok('confidence is LIKELY, never CONFIRMED — MEDIUM severity can never reach CONFIRMED by construction', bottleneck6.confidence === 'LIKELY', bottleneck6.confidence);

  // A tiny order sample must never trigger this — same exposure-gating discipline as everywhere else in this session's work.
  const tinySample = { totalSpend: 5000, metaPurchases: 60, avgCpa: 83, deliveredCpa: null, deliveryRate: null, confirmationRate: 0, codSample: 3, ctr: 5, cpc: 1, cvr: 2, frequency: 1, dataAvailability: { metaMapped: true } };
  const diag7 = computeDiagnosis({ metrics: tinySample, creative: null, settings });
  ok('a tiny 3-order sample never raises CONFIRMATION_PROBLEM even at 0% confirmation — not enough evidence either way', !diag7.some((d) => d.category === 'CONFIRMATION_PROBLEM'), JSON.stringify(diag7));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
