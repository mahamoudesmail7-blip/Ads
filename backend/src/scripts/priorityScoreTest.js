// 🧪 AI Priority Score (0–100): additive, bounded, explained — and never an execution permission. Pure (no DB, no Meta).
//   node src/scripts/priorityScoreTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const { priorityScore, bandOf, SCORE_BANDS } = await imp('../services/amb/priorityScore.js');
const strong = { m3: { spend: 900, purchases: 12, cpa: 75 }, m7: { spend: 2100, purchases: 28, cpa: 75 }, m30: { spend: 8200, purchases: 112, cpa: 73 }, ageHours: 700, dataAgeMin: 10 };
const weak = { m3: { spend: 600, purchases: 0, cpa: null }, m7: { spend: 900, purchases: 2, cpa: 450 }, m30: { spend: 1500, purchases: 3, cpa: 500 }, ageHours: 200, dataAgeMin: 10 };

console.log('\n1. Range, bands, determinism');
const s = priorityScore(strong), w = priorityScore(weak);
ok('a strong, stable, deep-sample, fresh campaign scores in the STRONG band (≥75)', s.score >= 75 && s.band === 'STRONG', JSON.stringify([s.score, s.band]));
ok('a campaign with spend and almost no orders at CPA 450+ is WEAK (<35)', w.score < 35 && w.band === 'WEAK', JSON.stringify([w.score, w.band]));
ok('always within 0–100 (extreme inputs too)', [priorityScore({}), priorityScore({ blocks: Array(9).fill('X'), warnings: Array(9).fill('W') }), priorityScore({ ...strong, m30: { spend: 99999, purchases: 9999, cpa: 1 } })].every((x) => x.score >= 0 && x.score <= 100));
ok('deterministic: same input → same score and same reasons', JSON.stringify(priorityScore(strong)) === JSON.stringify(priorityScore(strong)));
ok('bands cover 0–100 without gaps and are ordered', bandOf(0).key === 'WEAK' && bandOf(34).key === 'WEAK' && bandOf(35).key === 'FAIR' && bandOf(55).key === 'GOOD' && bandOf(75).key === 'STRONG' && bandOf(100).key === 'STRONG' && SCORE_BANDS.length === 4);

console.log('\n2. Each ingredient moves the score the right way');
const base = priorityScore({ ...strong, m7: { spend: 2100, purchases: 28, cpa: 120 }, m30: { spend: 8200, purchases: 40, cpa: 120 } }).score;
ok('better CPA → higher score', priorityScore({ ...strong, m7: { spend: 2100, purchases: 28, cpa: 90 }, m30: { spend: 8200, purchases: 40, cpa: 90 } }).score > base);
ok('worse CPA → lower score', priorityScore({ ...strong, m7: { spend: 2100, purchases: 28, cpa: 180 }, m30: { spend: 8200, purchases: 40, cpa: 180 } }).score < base);
ok('more orders (stronger evidence) → higher score', priorityScore({ ...strong, m30: { spend: 8200, purchases: 100, cpa: 120 }, m7: { spend: 2100, purchases: 28, cpa: 120 } }).score > priorityScore({ ...strong, m30: { spend: 8200, purchases: 6, cpa: 120 }, m7: { spend: 2100, purchases: 28, cpa: 120 } }).score);
ok('ONE order never makes a strong campaign (CPA 40 on a single order < GOOD band)', priorityScore({ m3: { spend: 40, purchases: 1, cpa: 40 }, m7: { spend: 40, purchases: 1, cpa: 40 }, m30: { spend: 40, purchases: 1, cpa: 40 }, ageHours: 400, dataAgeMin: 5 }).score < 55);
ok('a bad recent 3 days lowers the score vs an improving trend', priorityScore({ ...strong, m3: { spend: 900, purchases: 5, cpa: 160 } }).score < priorityScore({ ...strong, m3: { spend: 900, purchases: 12, cpa: 60 } }).score);
ok('spend with zero orders in 3 days is flagged in the reasons', priorityScore({ ...strong, m3: { spend: 450, purchases: 0, cpa: null } }).reasons.some((r) => /بدون أوردرات/.test(r)));
ok('volatile CPA scores below stable CPA', priorityScore({ ...strong, m7: { spend: 2100, purchases: 6, cpa: 200 } }).score < s.score);
ok('stale Meta data lowers the score (freshness)', priorityScore({ ...strong, dataAgeMin: 400 }).score < priorityScore({ ...strong, dataAgeMin: 5 }).score);
ok('a brand-new campaign (<72h) scores below an established one with the same numbers (age / testing)', priorityScore({ ...strong, ageHours: 30 }).score < priorityScore({ ...strong, ageHours: 900 }).score);
ok('hard guards subtract 10 each (capped at 20); warnings 2 each (capped at 6)', priorityScore({ ...strong, blocks: ['A'] }).penalty === 10 && priorityScore({ ...strong, blocks: ['A', 'B', 'C'] }).penalty === 20 && priorityScore({ ...strong, warnings: ['W1', 'W2'] }).penalty === 4 && priorityScore({ ...strong, warnings: Array(9).fill('w') }).penalty === 6);
ok('missing data is neutral-low, never crashes (all null)', (() => { const r = priorityScore({ m3: null, m7: null, m30: null }); return r.score >= 0 && r.components.length === 8 && r.confidence === 'LOW'; })());

console.log('\n3. Explained, and NEVER an execution permission');
ok('8 transparent components, each with points ≤ max and a Arabic detail', s.components.length === 8 && s.components.every((c) => c.points <= c.max && c.points >= 0 && typeof c.detail === 'string' && c.detail.length > 0));
ok('components sum to the score (before the penalty)', s.components.reduce((t, c) => t + c.points, 0) - s.penalty === s.score || s.score === 100 || s.score === 0);
ok('reasons list the strong and weak ingredients (＋ / －)', s.reasons.some((r) => r.startsWith('＋')) && w.reasons.some((r) => r.startsWith('－')));
ok('usedForExecution is ALWAYS false and the caveat says it cannot allow an execution', [s, w, priorityScore({})].every((r) => r.usedForExecution === false && /مبيسمحش بتنفيذ/.test(r.caveat)));
ok('confidence reflects sample + freshness (HIGH only with 20+ orders and fresh data)', s.confidence === 'HIGH' && priorityScore({ ...strong, dataAgeMin: 500 }).confidence !== 'HIGH' && w.confidence === 'LOW');
const src = fs.readFileSync(join(__dirname, '../services/amb/priorityScore.js'), 'utf8');
ok('the module imports no executor / Meta client / permission code (it cannot execute anything)', !/executor|metaGraphClient|approveAndExecute|setEntity|graphPost|execPermissions|operatorEngine/.test(src.split('\n').filter((l) => /^\s*import\b/.test(l)).join(' ')) && !/setEntity|graphPost|approveAndExecute/.test(src));
const cand = fs.readFileSync(join(__dirname, '../services/amb/dailyPlanCandidates.js'), 'utf8');
ok('both candidate builders attach the score as evidence only (not to selectable/selected)', (cand.match(/priority: priorityScore\(/g) || []).length === 2 && !/selected:[^,]*priority/.test(cand) && !/selectable:[^,]*priority/.test(cand));

console.log(`\n${fail === 0 ? '✅' : '❌'} priorityScoreTest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
