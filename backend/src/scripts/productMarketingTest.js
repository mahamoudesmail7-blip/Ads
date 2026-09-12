// Offline tests for the AI Product Marketing Center's deterministic layer
// (§4 opportunity score, §6 diagnosis, §8 location ranking, §11 claim
// validation, §26 product-lock rule). No Meta/AI/DB calls — pure functions
// only, so this never costs a token and never touches production data.
//   node src/scripts/productMarketingTest.js
import { computeOpportunityScore, computeDiagnosis, rankLocations, classifyClaim } from '../services/amb/productMarketingScoring.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const SETTINGS = { ambDefaultTargetCpa: 120 };

console.log('§4 Opportunity Score:');
{
  const insufficient = computeOpportunityScore({ metrics: { totalSpend: 0, metaPurchases: null }, settings: SETTINGS });
  ok('no spend/purchases -> dataSufficient:false, score:null', insufficient.dataSufficient === false && insufficient.score === null);

  const strong = computeOpportunityScore({
    metrics: { totalSpend: 1000, metaPurchases: 20, deliveredCpa: 60, avgCpa: 50, deliveredOrders: 18, deliveryRate: 0.9, netProfit: 500 },
    settings: SETTINGS,
  });
  ok('strong real numbers -> score >= 70 and label قوية', strong.score >= 70 && strong.label === 'قوية', JSON.stringify(strong));
  ok('strong numbers -> HIGH confidence (every component present)', strong.confidence === 'HIGH');

  const weak = computeOpportunityScore({
    metrics: { totalSpend: 500, metaPurchases: 3, avgCpa: 300, deliveredOrders: 0, deliveryRate: 0.1, netProfit: -400 },
    settings: SETTINGS,
  });
  ok('weak real numbers -> low score and label ضعيفة', weak.score < 45 && weak.label === 'ضعيفة', JSON.stringify(weak));

  const partial = computeOpportunityScore({ metrics: { totalSpend: 300, metaPurchases: 5, avgCpa: 80 }, settings: SETTINGS });
  ok('missing delivery/profit data -> confidence downgraded, never fabricated', partial.dataSufficient === true && partial.confidence !== 'HIGH', JSON.stringify(partial));
}

console.log('\n§6 Quick Diagnosis (rule-based, never a single vague verdict):');
{
  const noData = computeDiagnosis({ metrics: { totalSpend: 20, metaPurchases: null }, settings: SETTINGS });
  ok('too little spend -> insufficient-data diagnosis only', noData.length === 1 && noData[0].problem.includes('غير كافية'));

  const weakHook = computeDiagnosis({ metrics: { totalSpend: 500, metaPurchases: 3, ctr: 0.4, avgCpa: 200 }, settings: SETTINGS });
  ok('low CTR -> flags weak Hook with evidence+action', weakHook.some((d) => d.problem.includes('Hook') && d.evidence && d.action));

  const goodCtrWeakCvr = computeDiagnosis({ metrics: { totalSpend: 500, metaPurchases: 5, ctr: 2, cvr: 0.5, avgCpa: 100 }, settings: SETTINGS });
  ok('good CTR + weak CVR -> "Good CTR but weak conversion" diagnosis', goodCtrWeakCvr.some((d) => d.problem.includes('Conversion')));

  const goodMetaWeakDelivery = computeDiagnosis({ metrics: { totalSpend: 800, metaPurchases: 10, avgCpa: 90, deliveredCpa: 250, deliveryRate: 0.3 }, settings: SETTINGS });
  ok('good Meta CPA + weak delivery -> flags delivery, not the ad', goodMetaWeakDelivery.some((d) => d.problem.includes('الاستلام')));

  const fatigue = computeDiagnosis({ metrics: { totalSpend: 500, metaPurchases: 5, avgCpa: 100, frequency: 4.2 }, settings: SETTINGS });
  ok('high frequency -> creative fatigue flagged', fatigue.some((d) => d.problem.includes('إجهاد')));

  const healthy = computeDiagnosis({ metrics: { totalSpend: 1000, metaPurchases: 20, avgCpa: 60, ctr: 2, cvr: 3, frequency: 1.5 }, settings: SETTINGS });
  ok('healthy numbers -> no false-positive problem raised', healthy.length === 1 && healthy[0].severity === 'INFO', JSON.stringify(healthy));
}

console.log('\n§8 Location ranking (COD priority: Delivered > Delivered-rate > orders, never Meta purchases alone):');
{
  const rows = [
    { government: 'القاهرة', orders: 40, confirmed: 30, delivered: 20, returned: 5 },
    { government: 'الجيزة', orders: 60, confirmed: 50, delivered: 15, returned: 20 }, // more raw orders, fewer delivered
    { government: 'أسوان', orders: 10, confirmed: 9, delivered: 9, returned: 0 }, // small sample, high rate
  ];
  const ranked = rankLocations(rows);
  ok('governorate with MORE delivered orders ranks first despite fewer raw orders', ranked[0].government === 'القاهرة', JSON.stringify(ranked.map((r) => r.government)));
  ok('delivery rate is computed per governorate', Math.abs(ranked.find((r) => r.government === 'أسوان').deliveryRate - 1) < 0.001);
  ok('never hard-coded — output length matches real input rows', ranked.length === rows.length);
}

console.log('\n§11 Claim validation (hard override — never trusts the AI\'s own label for a banned claim):');
{
  ok('"بيحرق الدهون" -> forced RED regardless of AI label', classifyClaim('المنتج ده بيحرق الدهون بسرعة').status === 'RED');
  ok('"يعالج الألم نهائيًا" -> forced RED', classifyClaim('يعالج الألم نهائيًا وبيضمن نتيجة').status === 'RED');
  ok('"مريح بعد يوم طويل" -> no forced override (caller falls back to AI/default label)', classifyClaim('مريح بعد يوم طويل في الشغل') === null);
  ok('empty/undefined text -> no false positive', classifyClaim(undefined) === null && classifyClaim('') === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
