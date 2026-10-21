// 🔒 «راجع الداتا قبل ما تديني نتايج» — an IMAGE search shows nothing until it was checked against the photo, then ONLY judge-verified results (services/researchVisibility.js).
//   1. visibilityFor / verificationInfo: pending while running, verified-only afterwards, text-only searches untouched
//   2. against the real (test) database: the exact `where` the routes use returns EXACT + REVIEW only — never null / REJECT / look-alikes
//   3. the routes use it for the counters, the list, the «unverified» group and the search-term breakdown
//   node src/scripts/researchVisibilityTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const { visibilityFor, verificationInfo, RUNNING_STATUSES } = await imp('../services/researchVisibility.js');
const { prisma } = await imp('../prisma.js');

console.log('\n1. Rules');
ok('an image search that is still running is «pending» — nothing shown', RUNNING_STATUSES.every((st) => visibilityFor({ product_image: 'data:x', status: st }).verificationPending === true));
ok('a finished image search is not pending and is restricted to EXACT / REVIEW', ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].every((st) => { const v = visibilityFor({ product_image: 'data:x', status: st }); return !v.verificationPending && JSON.stringify(v.resultFilter) === JSON.stringify({ match_decision: { in: ['EXACT', 'REVIEW'] } }); }));
ok('a TEXT-only search is untouched (never pending, no restriction)', (() => { const v = visibilityFor({ product_image: null, status: 'SEARCHING' }); return !v.isImageSearch && !v.verificationPending && v.resultFilter === null; })());
const rows = [...Array(3).fill({ match_decision: 'EXACT' }), ...Array(2).fill({ match_decision: 'REVIEW' }), ...Array(7).fill({ match_decision: 'REJECT' }), ...Array(5).fill({ match_decision: null })];
const run = verificationInfo({ product_image: 'x', status: 'SEARCHING' }, rows);
ok('while running the info says PENDING with the Arabic «checking» message', run.state === 'PENDING' && run.pending === true && /التحقق/.test(run.messageAr));
const done = verificationInfo({ product_image: 'x', status: 'COMPLETED' }, rows);
ok('when done it reports exact / review and how many look-alikes + unverified are HIDDEN', done.state === 'DONE' && done.exact === 3 && done.review === 2 && done.hiddenRejected === 7 && done.hiddenUnverified === 5 && /3 نتيجة مطابقة/.test(done.messageAr));
const none = verificationInfo({ product_image: 'x', status: 'COMPLETED' }, [{ match_decision: 'REJECT' }, { match_decision: null }]);
ok('when nothing was verified it says so plainly (no look-alikes offered instead)', none.state === 'DONE_EMPTY' && /مفيش نتيجة/.test(none.messageAr));
ok('a text search has no verification block', verificationInfo({ product_image: null, status: 'COMPLETED' }, rows) === null);

console.log('\n2. The real database filter');
const user = await prisma.user.findFirst();
if (!user) { console.log('  (no user in the test database — section skipped)'); }
else {
  const s = await prisma.experimentalCreativeSearch.create({ data: { user_id: user.id, search_mode: 'IMAGE_ONLY', product_name: 'visibility-test', product_image: 'data:image/png;base64,AAAA', platforms_json: '["instagram"]', status: 'COMPLETED' } });
  const mk = (i, dec, extra = {}) => ({ search_id: s.id, platform: 'instagram', canonical_url: `https://x.example/${i}`, original_url: `https://x.example/${i}`, provider: 't', match_decision: dec, ...extra });
  await prisma.experimentalCreativeResult.createMany({ data: [mk(1, 'EXACT'), mk(2, 'EXACT'), mk(3, 'REVIEW'), mk(4, 'REJECT', { ignored: true }), mk(5, null), mk(6, null), mk(7, 'REJECT', { ignored: true }), mk(8, 'REJECT')] });
  const v = visibilityFor({ product_image: 'x', status: 'COMPLETED' });
  const shown = await prisma.experimentalCreativeResult.findMany({ where: { search_id: s.id, ignored: false, ...v.resultFilter }, select: { canonical_url: true, match_decision: true } });
  ok('the list/counter filter returns ONLY the 2 EXACT + 1 REVIEW — not the unverified, not the rejected (hidden or not)', shown.length === 3 && shown.every((r) => ['EXACT', 'REVIEW'].includes(r.match_decision)), JSON.stringify(shown));
  const all = await prisma.experimentalCreativeResult.count({ where: { search_id: s.id } });
  ok('the other 5 rows are still stored (nothing deleted) — only hidden', all === 8);
  const info = verificationInfo({ product_image: 'x', status: 'COMPLETED' }, await prisma.experimentalCreativeResult.findMany({ where: { search_id: s.id }, select: { match_decision: true } }));
  ok('the verification block counts them honestly (2 exact · 1 review · 3 rejected hidden · 2 unverified hidden)', info.exact === 2 && info.review === 1 && info.hiddenRejected === 3 && info.hiddenUnverified === 2, JSON.stringify(info));
  await prisma.experimentalCreativeSearch.delete({ where: { id: s.id } });
}

console.log('\n3. The routes use it');
const route = fs.readFileSync(join(__dirname, '../routes/productResearchExperimental.js'), 'utf8');
ok('the search status counters + per-platform counts come from verified results only, and are 0 while pending', route.includes('const vis = visibilityFor(search);') && route.includes('vis.verificationPending ? 0 :') && route.includes('where: visibleWhere'));
ok('the status response carries the `verification` block and an image search never reports «unverified»', route.includes('verification, // null for a text-only search') && route.includes('unverified: 0,'));
ok('the results list is restricted to EXACT / REVIEW, empty while pending, and the «unverified» group is empty', route.includes('where.AND = [...(where.AND || []), vis.resultFilter]') && route.includes('where.id = -1'));
ok('the search-term breakdown only credits verified results (nothing while pending)', route.includes('visibilityFor(search).verificationPending ? Promise.resolve([])'));

await prisma.$disconnect();
console.log(`\n${fail ? '❌' : '✅'} researchVisibilityTest: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 300).unref?.();
