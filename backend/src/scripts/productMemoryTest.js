// «ذاكرة المنتج» + AI Smart Targeting that learns from past tests — verification. Real maths on injected snapshots / launch jobs / Meta targeting (no network, no write): product isolation, verdicts that refuse small samples,
// set-level attribution of interests, the audience-type comparison, the learning log, and the recommendation that feeds the wizard.
//   node src/scripts/productMemoryTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const PM = await imp('../services/amb/productMemory.js'); const ST = await imp('../services/amb/smartTargeting.js');
const JS = JSON.stringify;

console.log('\n1. pure: targeting of an ad set, verdicts');
const t1 = PM.parseTargeting({ age_min: 26, age_max: 50, genders: [2], flexible_spec: [{ interests: [{ id: '1', name: 'Cooking' }, { id: '2', name: 'Kitchen' }] }], targeting_automation: { advantage_audience: 0 }, geo_locations: { regions: [{ key: '9' }] } });
ok('interests + gender + age read from Meta’s shape (type INTERESTS, FEMALE, 26-50, advantage 0, 1 region)', t1.type === 'INTERESTS' && t1.genders === 'FEMALE' && t1.ageMin === 26 && t1.ageMax === 50 && t1.interests.length === 2 && t1.advantage === 0 && t1.regions === 1);
ok('no restriction = BROAD · only age/gender = AGE_GENDER · nothing at all = BROAD', PM.parseTargeting({}).type === 'BROAD' && PM.parseTargeting({ genders: [1] }).type === 'AGE_GENDER' && PM.parseTargeting({ age_min: 25 }).type === 'AGE_GENDER' && PM.parseTargeting(null) === null);
const BASE = 150;
ok('WIN needs a real sample: CPA 100 vs 150 on 20 purchases → WIN / HIGH', (() => { const v = PM.verdictFor({ spend: 2000, purchases: 20, cpa: 100 }, BASE); return v.verdict === 'WIN' && v.confidence === 'HIGH'; })());
ok('a LOW CPA on a handful of purchases is NOT a win (3 purchases at CPA 40 → INCONCLUSIVE, «عينة صغيرة»)', (() => { const v = PM.verdictFor({ spend: 120, purchases: 3, cpa: 40 }, BASE); return v.verdict === 'INCONCLUSIVE' && v.why.includes('عينة صغيرة'); })());
ok('LOSS: a high CPA with a real sample, or a lot of spend with zero purchases', PM.verdictFor({ spend: 1500, purchases: 6, cpa: 250 }, BASE).verdict === 'LOSS' && PM.verdictFor({ spend: 500, purchases: 0, cpa: null }, BASE).verdict === 'LOSS' && PM.verdictFor({ spend: 100, purchases: 0, cpa: null }, BASE).verdict === 'INCONCLUSIVE');
ok('close to the average → NEUTRAL; no baseline (the product has no purchases) → nothing is judged', PM.verdictFor({ spend: 1500, purchases: 10, cpa: 150 }, BASE).verdict === 'NEUTRAL' && PM.verdictFor({ spend: 5000, purchases: 0 }, null).verdict === 'INCONCLUSIVE');

console.log('\n2. the memory of one product — real numbers, its own campaigns only');
const TODAY = '2026-11-20'; const days = (n) => Array.from({ length: n }, (_, i) => { const d = new Date(`${TODAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - i * 4); return d.toISOString().slice(0, 10); }); // 10 sample days
const mkRows = (level, cid, cname, aid, aname, spend, purchases) => days(10).map((d, i) => ({ level, ad_account_id: 'act_1', date_start: d, date_stop: d, campaign_id: cid, campaign_name: cname, adset_id: aid, adset_name: aname, spend: spend / 10, meta_purchases: Math.floor(purchases / 10) + (i < purchases % 10 ? 1 : 0), meta_revenue: null, impressions: 1000, snapshot_at: new Date(`${d}T20:00:00Z`) }));
const camp = [['C1', 'Cup - Broad', 'A1', 'Broad set', 3000, 20], ['C2', 'Cup - Interests', 'A2', 'Cooking+Kitchen women', 2000, 20], ['C3', 'Cup - Gym', 'A3', 'Gym only', 1500, 0]];
const rows = { campaign: [], adset: [] };
for (const [c, cn, a, an, sp, pu] of camp) { rows.campaign.push(...mkRows('campaign', c, cn, null, null, sp, pu)); rows.adset.push(...mkRows('adset', c, cn, a, an, sp, pu)); }
rows.adset.push(...mkRows('adset', 'C3', 'Cup - Gym', 'A4', 'Small women set', 100, 2)); rows.campaign.push(...mkRows('campaign', 'C3', 'Cup - Gym', null, null, 100, 2).map((r) => ({ ...r, campaign_name: 'Cup - Gym' })));
rows.campaign.push(...mkRows('campaign', 'ZZ', 'ANOTHER PRODUCT', null, null, 9999, 1)); rows.adset.push(...mkRows('adset', 'ZZ', 'ANOTHER PRODUCT', 'AZ', 'other', 9999, 1)); // NOT this product's campaign
// C3's two ad sets share one campaign row total (spend 1600 / 2 purchases): fold the campaign rows so the campaign total equals its ad sets
rows.campaign = rows.campaign.filter((r) => r.campaign_id !== 'C3'); rows.campaign.push(...mkRows('campaign', 'C3', 'Cup - Gym', null, null, 1600, 2));
const jobs = [
  { jobId: 'j1', createdAt: new Date('2026-09-01'), targeting: { mode: 'BROAD' }, campaigns: [{ id: 'C1', name: 'Cup - Broad' }] },
  { jobId: 'j2', createdAt: new Date('2026-10-01'), targeting: { mode: 'SMART', smart: true, genders: 'FEMALE', ageMin: 26, ageMax: 50, interests: [{ id: '6003349442621', name: 'Cooking' }, { id: '6003040113419', name: 'Kitchen' }], geoRegions: [] }, campaigns: [{ id: 'C2', name: 'Cup - Interests' }] },
];
const metaTargeting = new Map([['A3', { flexible_spec: [{ interests: [{ id: '6003107902433', name: 'Gym' }] }] }], ['A4', { genders: [2], age_min: 30, age_max: 45 }]]);
const journalStore = { events: [], final: {} }; const saved = [];
const memDeps = { today: TODAY, campaigns: async () => [{ campaignId: 'C1', adAccountId: 'act_1', via: 'LAUNCH' }, { campaignId: 'C2', adAccountId: 'act_1', via: 'LAUNCH' }, { campaignId: 'C3', adAccountId: 'act_1', via: 'MAPPING' }], jobs: async () => jobs,
  snapshots: async (level) => rows[level], adSetTargeting: async () => metaTargeting, journal: async () => JSON.parse(JS(journalStore)), saveJournal: async (_id, j) => { journalStore.events = j.events; journalStore.final = j.final; saved.push(j); } };
const mem = await PM.getProductMemory(7, { deps: memDeps, persist: true });
ok('history found: 3 tests (campaigns with spend), product totals over 90 days = 6600 ج / 42 purchases / CPA 157.14 — the other product’s 9999 is NOT in it', mem.hasHistory && mem.tests === 3 && mem.windows.w90.spend === 6600 && mem.windows.w90.purchases === 42 && mem.windows.w90.cpa === 157.14, JS(mem.windows.w90));
ok('all five windows are computed (7 / 14 / 30 / 60 / 90 days) and a shorter window never exceeds a longer one', ['w7', 'w14', 'w30', 'w60', 'w90'].every((k) => mem.windows[k]) && mem.windows.w7.spend <= mem.windows.w30.spend && mem.windows.w30.spend <= mem.windows.w90.spend);
const by = Object.fromEntries(mem.adSets.map((a) => [a.id, a]));
ok('ad set targeting known: A1 BROAD (from our launch job), A2 INTERESTS + smart (job), A3 INTERESTS (Meta), A4 AGE_GENDER (Meta)', by.A1.type === 'BROAD' && by.A1.source === 'WIZARD' && by.A2.type === 'INTERESTS' && by.A2.smart === true && by.A3.type === 'INTERESTS' && by.A3.source === 'META' && by.A4.type === 'AGE_GENDER');
ok('verdicts on real samples: A2 WIN (CPA 100, HIGH) · A3 LOSS (1500 ج, no purchases) · A1 NEUTRAL (150) · A4 INCONCLUSIVE (2 purchases)', by.A2.verdict === 'WIN' && by.A2.confidence === 'HIGH' && by.A3.verdict === 'LOSS' && by.A1.verdict === 'NEUTRAL' && by.A4.verdict === 'INCONCLUSIVE', JS(Object.values(by).map((a) => [a.id, a.verdict, a.cpa])));
ok('another product’s ad set never appears', !by.AZ && !mem.adSets.some((a) => a.campaignName === 'ANOTHER PRODUCT'));
ok('audience types compared: BROAD 20 purchases / CPA 150 · INTERESTS 20 purchases / CPA 175 (A2 + A3 together)', mem.audienceTypes.BROAD.cpa === 150 && mem.audienceTypes.INTERESTS.cpa === 175 && mem.audienceTypes.INTERESTS.adSets === 2, JS(mem.audienceTypes));
const ints = Object.fromEntries(mem.interests.map((i) => [i.name, i]));
ok('interests are judged AS SETS: Cooking/Kitchen (one ad set of two) are «GROUP» — never credited singly; Gym (alone) is a real LOSS', ints.Cooking.attribution === 'GROUP' && ints.Cooking.verdict === 'GROUP' && ints.Kitchen.verdict === 'GROUP' && ints.Gym.attribution === 'SINGLE' && ints.Gym.verdict === 'LOSS');
ok('the smart-targeting test of the past is evaluated like any other test (A2: WIN)', mem.smartTests.length === 1 && mem.smartTests[0].verdict === 'WIN');
ok('the learnings are written from these numbers only (Arabic, with CPA / purchases) and the limits warn about interest attribution', mem.learnings.length >= 5 && mem.learnings.some((l) => /CPA 100/.test(l.text)) && mem.limits.some((l) => l.includes('أكتر من اهتمام')) && /3 حملة/.test(mem.summary) && /157\.14/.test(mem.summary));
ok('the learning log remembers the two FINAL verdicts (A2 win, A3 loss) — small / neutral ones are not logged', saved.length === 1 && Object.keys(journalStore.final).sort().join() === 'A2,A3' && journalStore.events.length === 2);
await PM.getProductMemory(7, { deps: memDeps, persist: true });
ok('asking again adds NOTHING to the log (idempotent)', saved.length === 1 && journalStore.events.length === 2);
const none = await PM.getProductMemory(8, { deps: { ...memDeps, campaigns: async () => [] } });
ok('a new product (no campaigns): no history, an honest summary, nothing invented', none.hasHistory === false && none.tests === 0 && none.summary.includes('معندوش حملات سابقة') && none.adSets.length === 0);
const noSpend = await PM.getProductMemory(8, { deps: { ...memDeps, snapshots: async () => [] } });
ok('campaigns linked but no spend recorded → no history either', noSpend.hasHistory === false);

console.log('\n3. the recommendation');
const rec = PM.recommendFromMemory(mem);
ok('Broad 150 vs interests 175: neither is clearly better → run BOTH (a Broad control + interests), confidence MEDIUM', rec.strategy.mode === 'BOTH' && rec.strategy.confidence === 'MEDIUM' && rec.adSetsPlan.map((p) => p.type).join() === 'BROAD,INTERESTS');
ok('the proven audience is the A2 set; Gym (single-interest loser) is to be avoided', rec.proven.length === 1 && rec.proven[0].id === 'A2' && rec.avoid.map((x) => x.name).join() === 'Gym');
const mk2 = (b, i) => ({ hasHistory: true, adSets: [], interests: [], audienceTypes: { BROAD: { purchases: 20, cpa: b }, INTERESTS: { purchases: 20, cpa: i } } });
ok('interests clearly better (100 vs 150) → INTERESTS only; Broad clearly better → BROAD only', PM.recommendFromMemory(mk2(150, 100)).strategy.mode === 'INTERESTS' && PM.recommendFromMemory(mk2(100, 150)).strategy.mode === 'BROAD');
ok('only Broad was ever tested → BOTH (the interests are the experiment); nothing evaluable → BOTH with LOW confidence', PM.recommendFromMemory({ hasHistory: true, adSets: [], interests: [], audienceTypes: { BROAD: { purchases: 20, cpa: 150 } } }).strategy.mode === 'BOTH' && PM.recommendFromMemory({ hasHistory: true, adSets: [], interests: [], audienceTypes: { BROAD: { purchases: 2, cpa: 50 } } }).strategy.confidence === 'LOW');
ok('no history → no recommendation', PM.recommendFromMemory({ hasHistory: false }) === null);

console.log('\n4. the Smart Targeting proposal USES the memory');
const META = { cooking: [{ id: '6003349442621', name: 'Cooking', audience_size_upper_bound: 90e6 }], kitchen: [{ id: '6003040113419', name: 'Kitchen', audience_size_upper_bound: 6e6 }], 'home appliance': [{ id: '6003025470329', name: 'Home appliance', audience_size_upper_bound: 24e6 }], 'home & garden': [{ id: '6003255890528', name: 'Home & Garden', audience_size_upper_bound: 36e6 }], baking: [{ id: '6003157080527', name: 'Baking', audience_size_upper_bound: 12e6 }], 'online shopping': [{ id: '6003139266461', name: 'Online shopping', audience_size_upper_bound: 700e6 }] };
const meta = () => ({ getToken: async () => 'T', search: async (_t, q) => META[q.toLowerCase()] || [], cache: { get: async () => null, set: async () => {} } });
const relatedStub = async () => [{ id: '6003349442621', name: 'Cooking' }, { id: '6003157080527', name: 'Baking', audienceUpper: 12e6 }, { id: '6003025470329', name: 'Home appliance', audienceUpper: 24e6 }, { id: '6003107902433', name: 'Gym', audienceUpper: 300e6 }];
const ctx = { getContext: async () => ({ name: 'قلاية هوائية', category: 'مطبخ', price: 1500, features: [] }) };
const dp = { ...ctx, ai: false, real: async () => null, geoSearch: async () => [], meta: meta(), related: relatedStub, memory: async () => PM.getProductMemory(7, { deps: memDeps }) };
let r = await ST.suggestSmartTargeting({ productId: 7, deps: dp });
ok('basis HISTORY, source HISTORY+RULES; the proposal carries the memory (tests, CPA, windows, learnings)', r.basis === 'HISTORY' && r.source === 'HISTORY+RULES' && r.memory.tests === 3 && r.memory.windows.w90.cpa === 157.14 && r.memory.learnings.length >= 5);
ok('gender FEMALE + age 26-50 come from the WINNING test (source HISTORY, with its numbers as the reason)', r.gender === 'FEMALE' && r.sources.gender === 'HISTORY' && r.ageMin === 26 && r.ageMax === 50 && r.sources.age === 'HISTORY' && /CPA 100/.test(r.reasons.gender) && /CPA 100/.test(r.reasons.age), JS([r.gender, r.ageMin, r.ageMax, r.sources]));
ok('interests: first the audience that won (origin PROVEN, said to be a SET result), then NEW related ones, then fresh candidates — 5 max, all with Meta ids', r.interests.length === 5 && r.interests.slice(0, 2).every((i) => i.origin === 'PROVEN') && r.interests.slice(0, 2).map((i) => i.name).join() === 'Cooking,Kitchen' && r.interests.filter((i) => i.origin === 'NEW_RELATED').length === 2 && /للمجموعة كلها/.test(r.interests[0].why) && r.interests.every((i) => /^\d{10,}$/.test(i.id)), r.interests.map((i) => i.name + ':' + i.origin).join());
ok('the loser (Gym) is never proposed and nothing already tested is offered as «new» (Cooking appears once, as PROVEN)', !r.interests.some((i) => i.name === 'Gym') && r.interests.filter((i) => i.name === 'Cooking').length === 1);
ok('strategy BOTH + an Ad Set plan (Broad control + interests), confidence HIGH (42 purchases in 90 days)', r.strategy.mode === 'BOTH' && r.adSetsPlan.some((p) => p.type === 'BROAD') && r.adSetsPlan.some((p) => p.type === 'INTERESTS') && r.confidence.level === 'HIGH');
ok('the screen is told the audience is applied as a RESTRICTION (Advantage audience off) and what that means', r.advantage.mode === 'RESTRICT' && /Advantage/.test(r.advantage.text));
r = await ST.suggestSmartTargeting({ productId: 8, deps: { ...dp, memory: async () => PM.getProductMemory(8, { deps: { ...memDeps, campaigns: async () => [] } }) } });
ok('a NEW product: basis EXPLORATORY, says so plainly, confidence LOW, an exploratory plan (interests + a Broad control)', r.basis === 'EXPLORATORY' && r.notes.some((n) => n.includes('مبني على فهم المنتج مش على نتايج')) && r.confidence.level === 'LOW' && r.strategy.mode === 'EXPLORE' && r.adSetsPlan.length === 2);
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...dp, memory: async () => { throw new Error('db down'); } } });
ok('the memory failing never breaks the proposal (falls back to the exploratory one)', r.ok && r.basis === 'EXPLORATORY' && r.interests.length > 0);

console.log('\n5. a past winner with a very different age does not override the usual age (history is guarded like sales data)');
const memOld = await PM.getProductMemory(7, { deps: { ...memDeps, jobs: async () => [jobs[0], { ...jobs[1], targeting: { ...jobs[1].targeting, ageMin: 55, ageMax: 65 } }], journal: async () => ({ events: [], final: {} }) } });
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...dp, memory: async () => memOld } });
ok('the winning ad set ran at 55-65 (far from the usual 24-55 kitchen age): the usual age stays, 55–65 is one click away, and the screen explains', r.sources.age !== 'HISTORY' && r.ageMin === 24 && r.alternatives.age?.ageMin === 55 && r.alternatives.age?.ageMax === 65 && r.notes.some((n) => n.includes('التيستات')), JS([r.ageMin, r.ageMax, r.alternatives]));

console.log('\n6. slow / failing parts never hang or break the proposal («Failed to fetch» in production)');
{
  const never = () => new Promise(() => {}); const fast = { real: 40, memory: 40, related: 40, ai: 40, verify: 40 };
  const t0 = Date.now();
  r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...dp, memory: never, real: never, timeouts: fast } });
  ok('the memory AND the live buyer data hanging forever: the proposal still comes (within the time limits), exploratory, with a note about the memory', r.ok && Date.now() - t0 < 5000 && r.basis === 'EXPLORATORY' && r.notes.some((n) => n.includes('ذاكرة المنتج مقدرتش تتحمّل')) && r.interests.length > 0, JS([Date.now() - t0, r.basis, r.notes]));
  r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...dp, related: never, timeouts: fast } });
  ok('Meta’s «related interests» hanging: the proposal still comes with the winning audience + verified candidates', r.ok && r.interests.length >= 3 && r.interests.slice(0, 2).every((i) => i.origin === 'PROVEN'));
  r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...dp, ai: true, generate: never, timeouts: fast } });
  ok('the AI hanging: falls back to the rules (labelled), nothing hangs', r.ok && r.source.endsWith('RULES') && !!r.aiError);
}

console.log('\n7. the real database loader reads ONLY the product’s campaigns and only the needed columns');
{
  const { prisma } = await imp('../prisma.js'); const T = 'PMT' + Date.now(); const run = await prisma.ambSyncRun.create({ data: { trigger: 'TEST', status: 'SUCCESS', ad_account_id: 'act_pm', started_at: new Date(), finished_at: new Date() } });
  try {
    const mk = (level, cid, aid, day, sp, pu, extra = {}) => prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: run.id, ad_account_id: 'act_pm', level, date_start: day, date_stop: day, campaign_id: cid, campaign_name: cid, adset_id: aid, adset_name: aid, spend: sp, meta_purchases: pu, snapshot_at: new Date(`${day}T10:00:00Z`), actions_json: '[{"big":"payload"}]', ...extra } });
    await mk('campaign', T + 'P', null, TODAY, 100, 2); await mk('campaign', T + 'P', null, TODAY, 150, 3, { snapshot_at: new Date(`${TODAY}T20:00:00Z`) }); // two snapshots of one day: the LATEST wins
    await mk('adset', T + 'P', T + 'A1', TODAY, 150, 3); await mk('campaign', T + 'OTHER', null, TODAY, 9999, 1); await mk('adset', T + 'OTHER', T + 'A9', TODAY, 9999, 1);
    const rowsC = await PM.loadProductSnapshots({ level: 'campaign', campaignIds: [T + 'P'], from: TODAY, to: TODAY }); const rowsA = await PM.loadProductSnapshots({ level: 'adset', campaignIds: [T + 'P'], from: TODAY, to: TODAY });
    ok('only the product’s campaign comes back (the other campaign of the same account never does); one row per day — the latest snapshot (150 / 3)', rowsC.length === 1 && rowsC[0].campaign_id === T + 'P' && Number(rowsC[0].spend) === 150 && Number(rowsC[0].meta_purchases) === 3, JS(rowsC));
    ok('ad set level the same, and the heavy actions_json column is NOT read', rowsA.length === 1 && rowsA[0].adset_id === T + 'A1' && !('actions_json' in rowsA[0]));
    const memDb = await PM.getProductMemory(7, { deps: { today: TODAY, campaigns: async () => [{ campaignId: T + 'P', adAccountId: 'act_pm', via: 'LAUNCH' }], jobs: async () => [], adSetTargeting: async () => new Map(), journal: async () => ({ events: [], final: {} }) } });
    ok('getProductMemory with the real loader: product totals 150 ج / 3 purchases (the other campaign’s 9999 is not in it)', memDb.hasHistory && memDb.windows.w90.spend === 150 && memDb.windows.w90.purchases === 3, JS(memDb.windows.w90));
  } finally {
    await prisma.metaPerformanceSnapshot.deleteMany({ where: { campaign_id: { startsWith: T } } }).catch(() => {}); await prisma.ambSyncRun.delete({ where: { id: run.id } }).catch(() => {}); await prisma.$disconnect();
  }
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
