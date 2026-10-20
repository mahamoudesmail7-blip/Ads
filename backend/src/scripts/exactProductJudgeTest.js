// 🎯 «نفس المنتج بالظبط» — the strict vision-AI judge for image searches (services/exactProductJudge.js). Fake AI + fake image downloads: nothing leaves the process.
//   1. decision bands: EXACT only for sameProduct && confidence >= 85; 60-84 = REVIEW; everything else REJECT
//   2. one batch = ONE AI call carrying the reference photo(s) first and every candidate numbered; verdicts map back to the right result ids
//   3. never promotes what it could not judge (image download failed / no verdict / AI error → decision null)
//   4. a look-alike that the model hedges on is REJECTED, a clear same-product is EXACT
//   5. many candidates: batches of 5, a circuit breaker after 3 AI failures in a row, cancellation, time budget
//   6. the pipeline wires it in: every thumbnail candidate is judged, the verdict overrides the local score, REJECT is hidden
//   node src/scripts/exactProductJudgeTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const { decideFromJudge, judgeBatch, judgeCandidates, JUDGE_BATCH_SIZE, EXACT_MIN_CONFIDENCE, REVIEW_MIN_CONFIDENCE } = await imp('../services/exactProductJudge.js');

console.log('\n1. Decision bands');
ok('same product at 85+ → EXACT', decideFromJudge({ sameProduct: true, confidence: 85 }) === 'EXACT' && decideFromJudge({ sameProduct: true, confidence: 100 }) === 'EXACT');
ok('same product at 60-84 → REVIEW (never a match)', decideFromJudge({ sameProduct: true, confidence: 84 }) === 'REVIEW' && decideFromJudge({ sameProduct: true, confidence: 60 }) === 'REVIEW');
ok('same product below 60 → REJECT', decideFromJudge({ sameProduct: true, confidence: 59 }) === 'REJECT');
ok('NOT the same product is REJECT even at 99% confidence', decideFromJudge({ sameProduct: false, confidence: 99 }) === 'REJECT');
ok('missing / non-boolean verdict is REJECT, not a match', decideFromJudge({ sameProduct: 'yes', confidence: 95 }) === 'REJECT' && decideFromJudge({}) === 'REJECT');
ok('the bands are the documented ones (85 / 60)', EXACT_MIN_CONFIDENCE === 85 && REVIEW_MIN_CONFIDENCE === 60);

console.log('\n2. One batch = one AI call; verdicts map back to the right ids');
const refs = [{ imageBase64: 'UkVG', imageMediaType: 'image/jpeg' }, { imageBase64: 'UkVGMg==', imageMediaType: 'image/png' }, { imageBase64: 'dGhpcmQ=', imageMediaType: 'image/png' }];
const cands = [{ id: 11, url: 'u11', text: 'حذاء رياضي أبيض' }, { id: 12, url: 'u12' }, { id: 13, url: 'u13' }, { id: 14, url: 'u14' }, { id: 15, url: 'u15' }];
let calls = 0; let lastContent = null;
const aiOk = async ({ messages }) => { calls++; lastContent = messages[0].content; return { text: JSON.stringify({ results: [
  { index: 1, sameProduct: true, confidence: 96, reason: 'نفس الشبك والنعل' }, { index: 2, sameProduct: false, confidence: 20, reason: 'ألوان مختلفة' },
  { index: 3, sameProduct: true, confidence: 70, reason: 'غالبًا نفسه' }, { index: 4, sameProduct: false, confidence: 95, reason: 'شبيه بس مختلف' }, { index: 5, sameProduct: true, confidence: 90, reason: 'نفس الموديل' }] }) }; };
const imgOk = async (u) => ({ base64: 'aW1n', mediaType: 'image/jpeg' });
const r1 = await judgeBatch({ references: refs, candidates: cands, generateTextFn: aiOk, fetchImageFn: imgOk });
ok('exactly ONE AI call for the 5 candidates', calls === 1);
ok('the reference photos come first (max 2 sent) and every candidate is numbered after them', lastContent.filter((c) => c.type === 'image').length === 2 + 5 && /CANDIDATE 1/.test(lastContent.find((c) => /CANDIDATE 1/.test(c.text || ''))?.text || '') && /CANDIDATE 5/.test(lastContent.map((c) => c.text || '').join(' ')));
ok('verdicts land on the right result ids: 11 EXACT · 12 REJECT · 13 REVIEW · 14 REJECT (look-alike, even at 95) · 15 EXACT', r1.map((r) => `${r.id}:${r.decision}`).join(' ') === '11:EXACT 12:REJECT 13:REVIEW 14:REJECT 15:EXACT', r1.map((r) => `${r.id}:${r.decision}`).join(' '));
ok('the Arabic reason and the confidence are kept for the UI', r1[0].reason === 'نفس الشبك والنعل' && r1[0].confidence === 96);

console.log('\n3. It never promotes what it could not judge');
const imgSomeFail = async (u) => { if (u === 'u12' || u === 'u14') throw new Error('HTTP 403'); return { base64: 'aW1n', mediaType: 'image/jpeg' }; };
let seen = 0; const aiThree = async ({ messages }) => { seen = messages[0].content.filter((c) => c.type === 'image').length - 2; return { text: JSON.stringify({ results: [{ index: 1, sameProduct: true, confidence: 92, reason: 'a' }, { index: 2, sameProduct: false, confidence: 5, reason: 'b' }, { index: 3, sameProduct: true, confidence: 90, reason: 'c' }] }) }; };
const r2 = await judgeBatch({ references: refs.slice(0, 2), candidates: cands, generateTextFn: aiThree, fetchImageFn: imgSomeFail });
ok('candidates whose image could not be downloaded get NO decision (they stay unverified) and are not sent to the AI', seen === 3 && r2.find((r) => r.id === 12).decision === null && r2.find((r) => r.id === 14).decision === null && /image/.test(r2.find((r) => r.id === 12).error));
ok('the rest are judged normally (11 → EXACT, 13 → REJECT, 15 → EXACT)', r2.find((r) => r.id === 11).decision === 'EXACT' && r2.find((r) => r.id === 13).decision === 'REJECT' && r2.find((r) => r.id === 15).decision === 'EXACT');
const r3 = await judgeBatch({ references: refs, candidates: cands, generateTextFn: async () => { throw new Error('insufficient_quota'); }, fetchImageFn: imgOk });
ok('an AI error leaves every candidate unjudged (decision null, flagged aiFailed) — nothing is guessed', r3.every((r) => r.decision === null && r3.every((x) => x.aiFailed === true)));
const r4 = await judgeBatch({ references: refs, candidates: cands, generateTextFn: async () => ({ text: '{"results":[{"index":1,"sameProduct":true,"confidence":99}]}' }), fetchImageFn: imgOk });
ok('a candidate the model gave no verdict for stays unjudged (never defaults to a match)', r4[0].decision === 'EXACT' && r4.slice(1).every((r) => r.decision === null));
const r5 = await judgeBatch({ references: refs, candidates: cands.slice(0, 2), generateTextFn: async () => ({ text: 'not json at all' }), fetchImageFn: imgOk });
ok('a garbled model answer judges nothing', r5.every((r) => r.decision === null));

console.log('\n4. Many candidates');
const many = Array.from({ length: 23 }, (_, i) => ({ id: 100 + i, url: 'u' + i }));
let batchCalls = 0; const aiEcho = async ({ messages }) => { batchCalls++; const n = messages[0].content.filter((c) => c.type === 'image').length - 1; return { text: JSON.stringify({ results: Array.from({ length: n }, (_, k) => ({ index: k + 1, sameProduct: false, confidence: 10, reason: 'x' })) }) }; };
const j1 = await judgeCandidates({ references: refs.slice(0, 1), candidates: many, generateTextFn: aiEcho, fetchImageFn: imgOk });
ok(`23 candidates → ${Math.ceil(23 / JUDGE_BATCH_SIZE)} calls of ≤ ${JUDGE_BATCH_SIZE}, all judged, no abort`, batchCalls === 5 && j1.judged.length === 23 && j1.aborted === null && j1.batches === 5, JSON.stringify({ batchCalls, n: j1.judged.length, ab: j1.aborted }));
let failCalls = 0; const j2 = await judgeCandidates({ references: refs, candidates: Array.from({ length: 60 }, (_, i) => ({ id: i, url: 'u' })), concurrency: 1, generateTextFn: async () => { failCalls++; throw new Error('insufficient_quota'); }, fetchImageFn: imgOk });
ok('circuit breaker: 3 AI failures in a row stop the run (3 calls, not 12) and report AI_UNAVAILABLE', failCalls === 3 && j2.aborted === 'AI_UNAVAILABLE', JSON.stringify({ failCalls, ab: j2.aborted }));
let cancelAfter = 0; const j3 = await judgeCandidates({ references: refs, candidates: many, concurrency: 1, isCancelled: () => cancelAfter++ >= 2, generateTextFn: aiEcho, fetchImageFn: imgOk });
ok('a cancelled search stops judging', j3.aborted === 'CANCELLED' && j3.judged.length < 23);
const j4 = await judgeCandidates({ references: refs, candidates: many, concurrency: 1, budgetMs: -1, generateTextFn: aiEcho, fetchImageFn: imgOk });
ok('an exhausted time budget stops judging and says so', j4.aborted === 'BUDGET' && j4.judged.length === 0);

console.log('\n5. The search pipeline uses it');
const src = fs.readFileSync(join(__dirname, '../services/experimentalCreativeDiscovery.js'), 'utf8');
ok('every candidate with a real thumbnail (not just the first 60) goes to the judge, from the reference photos, up to EXACT_JUDGE_MAX', src.includes('judgeCandidates({') && src.includes('references: referenceInputImages') && src.includes('take: judgeMaxCandidates()') && src.includes("thumbnail: { not: null }"));
ok('its verdict overrides the local score and REJECT is hidden (ignored), EXACT / REVIEW are shown in their tabs', src.includes('match_decision: v.decision') && src.includes("ignored: v.decision === 'REJECT'"));
ok('it can be switched off with EXACT_JUDGE_ENABLED=false, and what it could not judge is never promoted', src.includes('exactJudgeEnabled()') && src.includes('if (!v.decision) { unverified++; continue; }'));

console.log(`\n${fail ? '❌' : '✅'} exactProductJudgeTest: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 300).unref?.();
