// Smart Decision Center Phase 3 — services/amb/creativeIntel.js. Pure,
// offline tests (no Meta calls, no DB) for the two things that must be
// bullet-proof: (1) classifyCandidate()'s evidence gates — a low CPA from a
// tiny sample can never be WINNER, FATIGUED only ever comes from a real
// prior-window decline; (2) groupAdsByKey()'s stable-identity guarantee —
// two ads with DIFFERENT names/labels (simulating "C1" in two different
// launches) must still merge into ONE row when they resolve to the SAME
// underlying key, proving grouping never relies on a wizard slot label.
// Real buildHierarchy() integration is deliberately NOT re-mocked here,
// matching this codebase's own established convention (see
// productMarketingWinnerIntelTest.js) — it was verified live against real
// production data (Product 126) instead.
//   node src/scripts/creativeIntelTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { classifyCandidate, groupAdsByKey, pickBest, NO_WINNER_MSG } = await imp('../services/amb/creativeIntel.js');

const GATE = { targetCpa: 120, minSpend: 150, minPurchases: 5 };

console.log('§1 classifyCandidate — evidence gates run BEFORE any CPA/ratio reasoning:');
{
  const tiny = classifyCandidate({ spend: 20, purchases: 1, cpa: 20, ctr: 5, dataSufficiency: 'WEAK' }, GATE);
  ok('a suspiciously low CPA from tiny spend is INSUFFICIENT_DATA, never WINNER', tiny.classification === 'INSUFFICIENT_DATA', JSON.stringify(tiny));

  const zeroPurchases = classifyCandidate({ spend: 500, purchases: 0, cpa: null, ctr: 3, dataSufficiency: 'WEAK' }, GATE);
  ok('zero purchases is INSUFFICIENT_DATA regardless of spend', zeroPurchases.classification === 'INSUFFICIENT_DATA', JSON.stringify(zeroPurchases));

  const weakSufficiency = classifyCandidate({ spend: 100, purchases: 2, cpa: 50, ctr: 2, dataSufficiency: 'WEAK' }, GATE);
  ok('WEAK dataSufficiency below minSpend is INSUFFICIENT_DATA even with a cheap CPA', weakSufficiency.classification === 'INSUFFICIENT_DATA', JSON.stringify(weakSufficiency));
}

console.log('\n§2 classifyCandidate — WINNER requires STRONG sufficiency + a real CPA gap + enough purchases:');
{
  const winner = classifyCandidate({ spend: 5000, purchases: 50, cpa: 90, ctr: 3, dataSufficiency: 'STRONG' }, GATE);
  ok('cheap CPA + strong sample + enough purchases = WINNER', winner.classification === 'WINNER', JSON.stringify(winner));
  ok('WINNER carries HIGH confidence', winner.confidence === 'HIGH');
  ok('evidence names the real numbers, not a vague label', /90 ج/.test(winner.evidence) && /50 شراء/.test(winner.evidence));

  const goodNotWinner = classifyCandidate({ spend: 2000, purchases: 3, cpa: 115, ctr: 2, dataSufficiency: 'MODERATE' }, GATE);
  ok('close to target but MODERATE sufficiency / low purchase count is GOOD, not WINNER', goodNotWinner.classification === 'GOOD', JSON.stringify(goodNotWinner));

  const strongButNotCheapEnough = classifyCandidate({ spend: 5000, purchases: 50, cpa: 115, ctr: 3, dataSufficiency: 'STRONG' }, GATE);
  ok('STRONG sufficiency but not cheap enough vs target is GOOD, never WINNER just for having a strong sample', strongButNotCheapEnough.classification === 'GOOD', JSON.stringify(strongButNotCheapEnough));
}

console.log('\n§3 classifyCandidate — the explicit "high CTR + weak conversion" pattern the user asked to detect:');
{
  const attentionNotConversion = classifyCandidate({ spend: 3000, purchases: 8, cpa: 375, ctr: 4.5, dataSufficiency: 'STRONG' }, GATE);
  ok('high CTR (attention) + high CPA (weak conversion) is classified WEAK, not WINNER', attentionNotConversion.classification === 'WEAK', JSON.stringify(attentionNotConversion));
  ok('evidence explicitly names the attention-vs-conversion pattern', /مشاهدين مش بالضرورة عملاء/.test(attentionNotConversion.evidence), attentionNotConversion.evidence);

  const moderateCtrStrongConversion = classifyCandidate({ spend: 5000, purchases: 60, cpa: 85, ctr: 1.8, dataSufficiency: 'STRONG' }, GATE);
  ok('moderate CTR + strong conversion + strong CPA is a real WINNER (the stronger business creative)', moderateCtrStrongConversion.classification === 'WINNER', JSON.stringify(moderateCtrStrongConversion));
}

console.log('\n§4 classifyCandidate — FATIGUED only ever from a real, corroborated prior-window decline:');
{
  const priorRow = { ctr: 4.0, dataSufficiency: 'STRONG' };
  const declined = classifyCandidate({ spend: 5000, purchases: 40, cpa: 100, ctr: 2.5, dataSufficiency: 'STRONG' }, { ...GATE, priorRow });
  ok('a real CTR decline vs the prior window is FATIGUED', declined.classification === 'FATIGUED', JSON.stringify(declined));
  ok('evidence names the real before/after CTR numbers', /4\.00%/.test(declined.evidence) && /2\.50%/.test(declined.evidence), declined.evidence);

  const noPrior = classifyCandidate({ spend: 5000, purchases: 40, cpa: 100, ctr: 2.5, dataSufficiency: 'STRONG' }, GATE);
  ok('the exact same row WITHOUT a prior window is never fatigued from nothing — falls through to normal CPA-based classification', noPrior.classification !== 'FATIGUED', JSON.stringify(noPrior));

  const stableCtr = classifyCandidate({ spend: 5000, purchases: 40, cpa: 100, ctr: 3.9, dataSufficiency: 'STRONG' }, { ...GATE, priorRow });
  ok('a near-identical CTR vs the prior window is NOT fatigue (needs a real decline, not noise)', stableCtr.classification !== 'FATIGUED', JSON.stringify(stableCtr));
}

console.log('\n§5 groupAdsByKey — stable identity: a "C1" label is NOT globally unique, grouping must go by the real resolved key:');
{
  // Simulates the exact real bug: two ads named "C1" from two DIFFERENT
  // launch jobs are actually different creatives — but here, the SAME
  // underlying Media Library asset was reused across two launches, so both
  // ads must merge into ONE row despite carrying unrelated raw creativeIds.
  const ads = [
    { id: 'ad_launchA_1', name: 'C1', creativeId: 'meta_creative_111', metrics: { spend: 500, purchases: 5, clicks: 100, impressions: 2000 } },
    { id: 'ad_launchB_1', name: 'C1', creativeId: 'meta_creative_999', metrics: { spend: 300, purchases: 3, clicks: 60, impressions: 1200 } },
    { id: 'ad_launchC_1', name: 'C1', creativeId: 'meta_creative_555', metrics: { spend: 100, purchases: 1, clicks: 20, impressions: 400 } },
  ];
  // The stable key resolver (what mediaLibraryIndex + the creative keyFn do
  // in the real pipeline) — both "C1" ads from launch A and B share the
  // SAME real Media Library asset id (42); the third, unrelated "C1" from
  // launch C resolves to a genuinely different asset (7).
  const assetByCreative = new Map([
    ['meta_creative_111', { id: 42 }],
    ['meta_creative_999', { id: 42 }],
    ['meta_creative_555', { id: 7 }],
  ]);
  const keyFn = (ad) => { const asset = assetByCreative.get(ad.creativeId); return asset ? { id: `asset:${asset.id}`, label: `Asset ${asset.id}` } : null; };

  const { rows } = groupAdsByKey(ads, keyFn);
  ok('exactly 2 real rows, not 3 — two "C1"s from different launches correctly merge into one stable identity', rows.length === 2, JSON.stringify(rows.map((r) => r.id)));
  const merged = rows.find((r) => r.id === 'asset:42');
  ok('the merged row sums BOTH launches\' spend/purchases, never just the last one seen', merged.spend === 800 && merged.purchases === 8, JSON.stringify(merged));
  ok('the merged row correctly counts 2 distinct ads', merged.adCount === 2);
  const distinct = rows.find((r) => r.id === 'asset:7');
  ok('the genuinely different "C1" (launch C) stays its own separate row', distinct.spend === 100 && distinct.purchases === 1);
}

console.log('\n§6 pickBest — the explicit "لا يوجد فائز مؤكد حتى الآن" fallback when no candidate has real evidence:');
{
  const onlyWeakRows = [
    { classification: 'WEAK', cpa: 200 },
    { classification: 'INSUFFICIENT_DATA', cpa: 5 }, // a suspiciously cheap CPA from a bad sample — must NEVER be picked
    { classification: 'TESTING', cpa: 130 },
  ];
  const best = pickBest(onlyWeakRows);
  ok('no WINNER/GOOD candidate exists -> pickBest returns null, never the cheapest-looking row', best === null, JSON.stringify(best));

  const mixedRows = [
    { classification: 'WEAK', cpa: 40 },
    { classification: 'GOOD', cpa: 100 },
    { classification: 'WINNER', cpa: 90 },
  ];
  const realBest = pickBest(mixedRows);
  ok('a real WINNER is picked over a cheaper-looking WEAK row', realBest.classification === 'WINNER' && realBest.cpa === 90, JSON.stringify(realBest));

  ok('NO_WINNER_MSG is the exact Arabic string the user specified', NO_WINNER_MSG === 'لا يوجد فائز مؤكد حتى الآن');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
