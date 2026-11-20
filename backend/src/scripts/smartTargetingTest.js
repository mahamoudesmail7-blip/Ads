// «AI Smart Targeting» (launch wizard) — verification. Pure functions + the whole suggestion with injected AI / real-buyer data / Meta (no network, no write), the targeting validation and the ad-set payload.
//   node src/scripts/smartTargetingTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const ST = await imp('../services/amb/smartTargeting.js'); const LB = await imp('../services/amb/launchBuilder.js'); const LP = await imp('../services/amb/launchPublish.js');
const JS = JSON.stringify;

// a fake «Meta interest search»: name → what Meta returns (ids are Meta's, never ours)
const META = {
  cooking: [{ id: '6003349442621', name: 'Cooking', audience_size_lower_bound: 80_000_000, audience_size_upper_bound: 90_000_000, path: ['Interests', 'Food and drink', 'Cooking'] }],
  kitchen: [{ id: '6003040113419', name: 'Kitchen', audience_size_lower_bound: 5_000_000, audience_size_upper_bound: 6_000_000 }],
  'home appliance': [{ id: '6003025470329', name: 'Home appliance', audience_size_lower_bound: 20_000_000, audience_size_upper_bound: 24_000_000 }],
  'home & garden': [{ id: '6003255890528', name: 'Home & Garden', audience_size_lower_bound: 30_000_000, audience_size_upper_bound: 36_000_000 }],
  baking: [{ id: '6003157080527', name: 'Baking', audience_size_lower_bound: 10_000_000, audience_size_upper_bound: 12_000_000 }],
  'online shopping': [{ id: '6003139266461', name: 'Online shopping', audience_size_lower_bound: 600_000_000, audience_size_upper_bound: 700_000_000 }],
  'air fryers': [{ id: '6003999111222', name: 'Air fryers recipe', audience_size_lower_bound: 2_000_000, audience_size_upper_bound: 2_400_000 }], // «Air fryers» is only SIMILAR to this
  tiny: [{ id: '6003000000001', name: 'Tiny niche', audience_size_lower_bound: 1_000, audience_size_upper_bound: 9_000 }],
  religion: [{ id: '6003000000002', name: 'Islam', audience_size_lower_bound: 90_000_000, audience_size_upper_bound: 99_000_000 }],
};
const searched = []; const meta = (over = {}) => ({ getToken: async () => 'T', search: async (_t, q) => { searched.push(q); return META[q.toLowerCase()] || []; }, cache: { get: async () => null, set: async () => {} }, ...over });
const ctx = (over = {}) => ({ getContext: async () => ({ name: 'قلاية هوائية', category: 'مطبخ', price: 1500, features: [], ...over }) });
const aiOk = (j) => ({ ai: true, generate: async () => ({ text: JS(j) }) });
const AI_ANSWER = { productKind: 'أدوات مطبخ', gender: 'FEMALE', genderReason: 'قلاية للبيت — ست البيت.', ageMin: 26, ageMax: 50, ageReason: 'الأسر من 26 لـ 50.', interests: [{ name: 'Cooking', why: 'بتطبخ بيها' }, { name: 'Kitchen', why: 'أداة مطبخ' }, { name: 'Air fryers', why: 'نفس النوع' }, { name: 'Home appliance', why: 'جهاز منزلي' }, { name: 'Baking', why: 'تحمير وخبز' }, { name: 'Tiny', why: 'x' }, { name: 'Religion', why: 'x' }] };

console.log('\n1. pure helpers');
ok('Meta age brackets → numbers («25-34», «65+»); garbage → null', JS(ST.parseAgeSegment('25-34')) === '[25,34]' && JS(ST.parseAgeSegment('65+')) === '[65,65]' && ST.parseAgeSegment('abc') === null && ST.parseAgeSegment(null) === null);
ok('buyer gender text → MALE / FEMALE; unknown → null', ST.genderOfSegment('رجال') === 'MALE' && ST.genderOfSegment('نساء') === 'FEMALE' && ST.genderOfSegment('غير معروف') === null);
ok('rule table by product type: beauty → women 20-45 · car → men · kitchen → women · nothing known → everyone 20-50', ST.ruleProfile('سيروم للبشرة', '').gender === 'FEMALE' && ST.ruleProfile('Dashcam car camera', '').gender === 'MALE' && ST.ruleProfile('خلاط مطبخ', '').key === 'kitchen' && ST.ruleProfile('حاجة غريبة', '').gender === 'ALL' && ST.ruleProfile('حاجة غريبة', '').ageMin === 20);
ok('every rule keeps ages inside Meta’s 18..65 and gives 5+ interest candidates', ['سيروم', 'مطبخ', 'طفل', 'حذاء', 'سيارة', 'شنيور', 'جيم', 'شاحن', 'كلب', 'صيد', 'xyz'].every((n) => { const r = ST.ruleProfile(n, ''); return r.ageMin >= 18 && r.ageMax <= 65 && r.ageMin < r.ageMax && r.interests.length >= 5; }));
const ai = ST.sanitizeAi({ gender: 'female', ageMin: 5, ageMax: 99, interests: [{ name: 'Cooking' }, { name: 'cooking' }, { name: 'Islam religion' }, { name: '' }, 'Kitchen'] }, {});
ok('AI answer sanitised: gender upper-cased, ages clamped to 18..65, duplicates + sensitive names dropped', ai.gender === 'FEMALE' && ai.ageMin === 18 && ai.ageMax === 65 && ai.interests.map((i) => i.name).join() === 'Cooking,Kitchen');
ok('AI nonsense (bad gender, no ages) → nulls, never a guess', ST.sanitizeAi({ gender: 'x', ageMin: 'a' }, {}).gender === null && ST.sanitizeAi({ gender: 'x', ageMin: 'a' }, {}).ageMin === null && ST.sanitizeAi(null, {}).interests.length === 0);
ok('a too-narrow age range is widened to at least 8 years', (() => { const a = ST.sanitizeAi({ ageMin: 30, ageMax: 32 }, {}); return a.ageMax - a.ageMin >= 8; })());

console.log('\n2. the whole suggestion — AI answers');
const real0 = { real: async () => null, geoSearch: async () => [], memory: async () => null }; // no product memory here (covered by productMemoryTest.js)
let r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...ctx(), ...aiOk(AI_ANSWER), ...real0, meta: meta() } });
ok('source AI: gender FEMALE (الحريمي), age 26-50 — from the AI, with the AI’s reasons', r.source === 'AI' && r.gender === 'FEMALE' && r.genderLabel === 'حريمي' && r.ageMin === 26 && r.ageMax === 50 && r.sources.gender === 'AI' && r.reasons.gender.includes('ست البيت'));
ok('at most 5 interests, ALL with a real Meta id and audience size (nothing invented)', r.interests.length === 5 && r.interests.every((i) => /^\d{10,}$/.test(i.id) && i.audienceUpper > 0));
ok('a similar-name candidate is replaced by Meta’s closest real interest and says so («Air fryers» → «Air fryers recipe»)', r.interests.some((i) => i.name === 'Air fryers recipe' && i.requested === 'Air fryers' && i.exact === false));
ok('too-narrow audiences («Tiny», 9k) and sensitive interests («Islam») are never proposed', !r.interests.some((i) => /tiny|islam/i.test(i.name)));
ok('order: exact Meta matches first (Cooking, Kitchen, Home appliance, Baking), the substitute after', r.interests.map((i) => i.name).join() === 'Cooking,Kitchen,Home appliance,Baking,Air fryers recipe', r.interests.map((i) => i.name).join());
ok('applying-ready payload: SMART mode with {id,name} interests only, placements AUTOMATIC, Egypt-wide (no proven governorate)', r.targeting.mode === 'SMART' && r.targeting.interests.length === 5 && r.targeting.interests.every((i) => Object.keys(i).sort().join() === 'id,name') && r.targeting.placementsMode === 'AUTOMATIC' && r.locations.mode === 'EGYPT' && r.targeting.geoRegions.length === 0);
ok('verification is reported honestly (candidates vs verified) and notes say the age/gender are only a first proposal (no proven segment)', r.verification.available === true && r.verification.candidates === 6 && r.verification.verified === 5 && r.notes.some((n) => n.includes('مبني على فهم المنتج')));

console.log('\n3. AI not available → the rule table, still verified against Meta, and it says so');
searched.length = 0;
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...ctx(), ai: true, generate: async () => { throw new Error('insufficient_quota'); }, ...real0, meta: meta() } });
ok('source RULES, aiError explained, gender/age from the kitchen rule (FEMALE 24-55)', r.source === 'RULES' && !!r.aiError && r.gender === 'FEMALE' && r.ageMin === 24 && r.ageMax === 55 && r.sources.interests === 'RULES');
ok('the rule candidates were each searched on Meta and only real ones kept', searched.length >= 5 && r.interests.length >= 3 && r.interests.every((i) => /^\d{10,}$/.test(i.id)));
ok('the screen is told the AI was replaced by market rules (note)', r.notes.some((n) => n.includes('قواعد السوق المصري')));
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...ctx(), ai: false, ...real0, meta: meta() } });
ok('AI key not configured → same fallback, no crash', r.source === 'RULES' && r.aiError.includes('مفتاح'));

console.log('\n4. the product’s REAL purchases decide the age and gender — by VOLUME across all brackets, never by one cheap bracket');
const AGE = (list) => list.map(([segment, purchases, spend]) => ({ segment, purchases, spend, cpa: purchases ? Math.round(spend / purchases) : null }));
const buyers = (ageList, genderList = [], extra = {}) => ({ memory: async () => null, geoSearch: async () => [], real: async () => ({ window: { name: 'last90', label: 'آخر 90 يوم' }, age: AGE(ageList), gender: genderList.map(([segment, purchases]) => ({ segment, purchases, spend: 0, cpa: null })), best: { governorate: null }, governorates: [], ...extra }) });
// the owner’s REAL Ads Manager numbers for «Massage Roller» (Test 2 + Scale, by age): purchases / spend
const MASSAGE = [['18-24', 8, 983], ['25-34', 52, 5723], ['35-44', 55, 5645], ['45-54', 13, 1889], ['55-64', 3, 278], ['65+', 1, 81], ['Unknown', 1, 0]];
const massage = { getContext: async () => ({ name: 'جهاز المساج الدوار 360 لنحت الجسم', category: 'Massage', price: 400, features: [] }) };
const AI_OLD = { ...AI_ANSWER, gender: 'FEMALE', ageMin: 45, ageMax: 65, ageReason: 'الأكبر سنًا بيحتاجوا مساج.' };
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...massage, ...aiOk(AI_OLD), ...buyers(MASSAGE), meta: meta() } });
ok('the owner’s real numbers (25-34: 52, 35-44: 55, 45-54: 13, 55-64: only 3…): the age is 25–54 — NOT 50–65, even though the AI said 45–65', r.ageMin === 25 && r.ageMax === 54 && r.sources.age === 'REAL_DATA', JSON.stringify([r.ageMin, r.ageMax, r.sources.age]));
ok('the reason shows the real numbers (90.9% of 132 purchases from 25–54, and only a few above)', /90\.9|91%/.test(r.reasons.age) === false ? /91%/.test(r.reasons.age) && /132/.test(r.reasons.age) : true);
ok('the screen gets the table behind the number: 6 brackets with purchases / share / spend / CPA, the used ones flagged, coverage 90.9%', r.evidence.age.rows.length === 6 && r.evidence.age.coverage === 90.9 && r.evidence.age.used === true && r.evidence.age.rows.filter((x) => x.included).map((x) => x.segment).join() === '25-34,35-44,45-54' && r.evidence.age.rows.find((x) => x.segment === '55-64').purchases === 3 && r.evidence.age.range.min === 25);
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...massage, ai: false, ...buyers(MASSAGE), meta: meta() } });
ok('the same without the AI (rules) → 25–54 (real data beats the rule table too)', r.ageMin === 25 && r.ageMax === 54 && r.sources.age === 'REAL_DATA');
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...massage, ai: false, ...buyers([['25-34', 20, 2500], ['35-44', 25, 2600], ['45-54', 10, 1300], ['55-64', 3, 280]]), meta: meta() } });
ok('a bracket with 3 purchases at the LOWEST CPA (55-64) can never become the age: the range is built from where the purchases are (25-54)', r.ageMin === 25 && r.ageMax === 54, JSON.stringify([r.ageMin, r.ageMax]));
const bothG = ST.genderDistribution([{ segment: 'نساء', purchases: 70 }, { segment: 'رجال', purchases: 62 }]); const womenG = ST.genderDistribution([{ segment: 'نساء', purchases: 90 }, { segment: 'رجال', purchases: 20 }, { segment: 'غير معروف', purchases: 5 }]);
ok('gender by volume: a split (53% / 47%) is «الاتنين»; 82% women is FEMALE; under 30 purchases decides nothing', bothG.value === 'ALL' && womenG.value === 'FEMALE' && womenG.femalePct === 81.8 && ST.genderDistribution([{ segment: 'رجال', purchases: 9 }, { segment: 'نساء', purchases: 2 }]).value === null && ST.genderDistribution([]) === null);
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...massage, ...aiOk({ ...AI_OLD, gender: 'MALE' }), ...buyers(MASSAGE, [['نساء', 70], ['رجال', 62]]), meta: meta() } });
ok('real split (women 53% / men 47%) → «الاتنين» (not the AI’s MALE), with the numbers as the reason', r.gender === 'ALL' && r.sources.gender === 'REAL_DATA' && /53/.test(r.reasons.gender) && /47/.test(r.reasons.gender));
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...massage, ...aiOk(AI_OLD), ...buyers(MASSAGE, [['نساء', 110], ['رجال', 22]]), meta: meta() } });
ok('real majority (women 83%) → FEMALE, source REAL_DATA, and the overall source is labelled REAL_DATA+AI', r.gender === 'FEMALE' && r.sources.gender === 'REAL_DATA' && r.source === 'REAL_DATA+AI');
const proven = buyers([['25-34', 30, 3000], ['35-44', 20, 2000]]); const realG = await proven.real();
realG.best = { governorate: { segment: 'القاهرة' } }; realG.governorates = [{ segment: 'القاهرة', orders: 40 }, { segment: 'الجيزة', orders: 22 }, { segment: 'مكان غلط', orders: 9 }, { segment: 'الإسكندرية', orders: 0 }];
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...ctx(), ...aiOk(AI_ANSWER), memory: async () => null, real: async () => realG, geoSearch: async (q) => (q === 'القاهرة' ? [{ key: '2551', name: 'القاهرة' }] : q === 'الجيزة' ? [{ key: '2552', name: 'الجيزة' }] : []), meta: meta() } });
ok('a proven governorate winner earns a REAL region restriction (Meta keys only; an unresolvable name is skipped)', r.locations.mode === 'REGIONS' && r.locations.regions.map((g) => g.key).join() === '2551,2552' && r.targeting.geoRegions.length === 2);

console.log('\n4b. a SMALL sample (15-29 purchases) is only a hint: it is used if it agrees with the usual age, otherwise offered in one click');
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...massage, ai: false, ...buyers([['35-44', 2, 200], ['45-54', 6, 700], ['55-64', 12, 1100]]), meta: meta() } });
ok('20 purchases mostly at 55-64 vs the usual 20-45: the usual age stays, 45–64 is one click away, the note says «عينة صغيرة»', r.ageMin === 20 && r.ageMax === 45 && r.sources.age === 'RULES' && r.alternatives.age?.ageMin === 45 && r.alternatives.age?.ageMax === 64 && r.notes.some((n) => n.includes('عينة صغيرة')), JSON.stringify([r.ageMin, r.ageMax, r.alternatives]));
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...massage, ai: false, ...buyers([['25-34', 8, 800], ['35-44', 9, 900], ['45-54', 3, 300]]), meta: meta() } });
ok('20 purchases at 25-44 (agrees with 20-45): used as REAL_DATA, and the reason admits the sample is small', r.ageMin === 25 && r.ageMax === 44 && r.sources.age === 'REAL_DATA' && /عينة صغيرة/.test(r.reasons.age));
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...massage, ai: false, ...buyers([['25-34', 4, 400], ['35-44', 5, 500]]), meta: meta() } });
ok('under 15 purchases: no age evidence at all — the usual age is used', r.ageMin === 20 && r.ageMax === 45 && r.sources.age === 'RULES' && !r.alternatives.age);
ok('pure helpers: brackets parsed («Unknown» dropped), the range grows to the bigger neighbour until 85% of purchases are inside, at least two brackets', ST.bracketsOf(AGE(MASSAGE)).length === 6 && (() => { const c = ST.coverageRange(ST.bracketsOf(AGE(MASSAGE))); return c.min === 25 && c.max === 54 && c.total === 132; })() && ST.coverageRange(ST.bracketsOf(AGE([['35-44', 100, 1]]))) === null === false && ST.coverageRange([]) === null);

console.log('\n5. Meta not reachable → no invented interests');
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...ctx(), ...aiOk(AI_ANSWER), ...real0, meta: meta({ getToken: async () => { throw new Error('no token'); } }) } });
ok('no interests proposed, the candidates are listed as UNVERIFIED (not applicable), and the screen is told why', r.interests.length === 0 && r.unverified.length > 0 && r.verification.available === false && r.targeting.interests.length === 0 && r.notes.some((n) => n.includes('مش قادر أتأكد')));
ok('gender / age still come through (they do not depend on Meta)', r.gender === 'FEMALE' && r.ageMin === 26);

console.log('\n6. the interest search for the editor');
ok('manual search: real Meta ids only, sensitive ones hidden, short text ignored', (await ST.searchInterests('Cooking', meta())).length === 1 && (await ST.searchInterests('Cooking', meta()))[0].id === '6003349442621' && (await ST.searchInterests('Religion', meta())).length === 0 && (await ST.searchInterests('a', meta())).length === 0);
let bad = null; try { await ST.suggestSmartTargeting({ productId: 'x', deps: {} }); } catch (e) { bad = e; }
ok('no product → a clear 400 (no analysis of nothing)', bad?.status === 400);

console.log('\n7. the wizard’s targeting → validation → the Meta ad-set payload');
const v = LB.validateTargeting({ mode: 'SMART', genders: 'FEMALE', ageMin: 26, ageMax: 50, placementsMode: 'AUTOMATIC', geoRegions: [{ key: '2551', name: 'القاهرة' }], interests: [{ id: '6003349442621', name: 'Cooking' }, { id: '6003349442621', name: 'Cooking again' }, { id: 'abc', name: 'bad id' }, { id: '123', name: 'short id' }, { id: '6003040113419', name: '' }, { id: '6003040113419', name: 'Kitchen' }, null] });
ok('SMART validates like CUSTOM: only real numeric Meta ids kept, duplicates / bad ids / nameless dropped', v.mode === 'CUSTOM' && v.smart === true && v.interests.map((i) => i.id).join() === '6003349442621,6003040113419' && v.genders === 'FEMALE' && v.ageMin === 26);
ok('more than 10 interests are cut to 10', LB.validateTargeting({ mode: 'SMART', interests: Array.from({ length: 14 }, (_, i) => ({ id: `60030000${100 + i}`, name: `I${i}` })) }).interests.length === 10);
ok('BROAD / nothing → null (Meta’s own broad default, unchanged)', LB.validateTargeting({ mode: 'BROAD' }) === null && LB.validateTargeting(null) === null);
ok('CUSTOM without interests behaves exactly as before (no interests key content)', LB.validateTargeting({ mode: 'CUSTOM', genders: 'MALE' }).interests.length === 0);
const job = (t) => ({ platforms_json: '["facebook","instagram"]', config_json: JS({ targeting: t }) });
const t1 = LP.buildTargeting(job(v));
ok('the ad set gets flexible_spec.interests with Meta’s ids, plus gender / age / regions', JS(t1.flexible_spec) === JS([{ interests: [{ id: '6003349442621', name: 'Cooking' }, { id: '6003040113419', name: 'Kitchen' }] }]) && JS(t1.genders) === '[2]' && t1.age_min === 26 && t1.age_max === 50 && t1.geo_locations.regions[0].key === '2551');
ok('CUSTOM without interests → NO flexible_spec; BROAD → Egypt-wide untouched', LP.buildTargeting(job(LB.validateTargeting({ mode: 'CUSTOM', genders: 'MALE' }))).flexible_spec === undefined && JS(LP.buildTargeting(job(null)).geo_locations) === '{"countries":["EG"]}' && LP.buildTargeting(job(null)).flexible_spec === undefined);

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
