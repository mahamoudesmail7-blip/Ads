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

console.log('\n4. real buyers win over the AI (proven segments only)');
const realProven = { real: async () => ({ window: { name: 'last30' }, best: { gender: { segment: 'رجال' }, age: { segment: '25-34' }, governorate: { segment: 'القاهرة' } }, governorates: [{ segment: 'القاهرة', orders: 40 }, { segment: 'الجيزة', orders: 22 }, { segment: 'مكان غلط', orders: 9 }, { segment: 'الإسكندرية', orders: 0 }] }), memory: async () => null, geoSearch: async (q) => (q === 'القاهرة' ? [{ key: '2551', name: 'القاهرة' }] : q === 'الجيزة' ? [{ key: '2552', name: 'الجيزة' }] : []) };
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...ctx(), ...aiOk(AI_ANSWER), ...realProven, meta: meta() } });
ok('gender MALE + age 20-39 from the product’s own buyers (the AI said FEMALE 26-50) — labelled REAL_DATA', r.gender === 'MALE' && r.ageMin === 20 && r.ageMax === 39 && r.sources.gender === 'REAL_DATA' && r.sources.age === 'REAL_DATA' && r.source === 'REAL_DATA+AI' && r.reasons.gender.includes('رجال') && r.reasons.age.includes('25-34'));
ok('a proven governorate winner earns a REAL region restriction (Meta keys only; an unresolvable name is skipped)', r.locations.mode === 'REGIONS' && r.locations.regions.map((g) => g.key).join() === '2551,2552' && r.targeting.geoRegions.length === 2);
ok('with real data there is no «first proposal only» warning', !r.notes.some((n) => n.includes('اقتراح مبدئي')));

console.log('\n4b. a real age bracket that DISAGREES with the product’s usual age does not override it (a Broad campaign can simply deliver cheapest to 55-64)');
const realAge = (seg) => ({ real: async () => ({ window: { name: 'last30' }, best: { gender: null, age: { segment: seg }, governorate: null }, governorates: [] }), geoSearch: async () => [], memory: async () => null });
const massage = { getContext: async () => ({ name: 'Massage Roller', category: 'Massage', price: 400, features: [] }) };
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...massage, ai: false, ...realAge('55-64'), meta: meta() } });
ok('massage roller, sales say 55-64: the usual age (rules 20-45) is used, NOT 50-65 — source RULES', r.ageMin === 20 && r.ageMax === 45 && r.sources.age === 'RULES', JSON.stringify([r.ageMin, r.ageMax, r.sources.age]));
ok('…the sales age is offered as an alternative (50-65 for 55-64) and the note explains why it was not used', r.alternatives.age?.ageMin === 50 && r.alternatives.age?.ageMax === 65 && r.alternatives.age?.segment === '55-64' && r.notes.some((n) => n.includes('55-64') && n.includes('الأرخص')));
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...massage, ...aiOk(AI_ANSWER), ...realAge('55-64'), meta: meta() } });
ok('same with the AI’s range (26-50): 55-64 does not overlap it → the AI range stays', r.ageMin === 26 && r.ageMax === 50 && r.sources.age === 'AI' && !!r.alternatives.age);
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...massage, ai: false, ...realAge('35-44'), meta: meta() } });
ok('a sales bracket that AGREES (35-44 vs 20-45) is used: 30-49, source REAL_DATA, no alternative needed', r.ageMin === 30 && r.ageMax === 49 && r.sources.age === 'REAL_DATA' && !r.alternatives.age && r.reasons.age.includes('متوافقة'));
r = await ST.suggestSmartTargeting({ productId: 7, deps: { ...massage, ai: false, ...real0, meta: meta() } });
ok('no sales data: no alternatives at all', JSON.stringify(r.alternatives) === '{}');

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
