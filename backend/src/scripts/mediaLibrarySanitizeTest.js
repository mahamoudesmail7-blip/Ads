// 🧼 MEDIA LIBRARY — Meta creative text can end in half an emoji (a lone UTF-16 surrogate, e.g. after a `.slice(0, N)`). Prisma's query engine rejects such a string with
//   «unexpected end of hex escape», so the creative was skipped and the warning repeated on every Meta sync. wellFormed() repairs the text; this test reproduces the failure first, then proves the fix.
//   node src/scripts/mediaLibrarySanitizeTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js'); const ML = await imp('../services/amb/mediaLibrary.js');
const T = '__optest_ml_';
const lone = 'عرض خاص 🔥'.slice(0, 'عرض خاص 🔥'.length - 1); // ends with a lone HIGH surrogate (half of 🔥)
try {
  await prisma.mediaLibraryAsset.deleteMany({ where: { fingerprint: { startsWith: T } } });
  ok('wellFormed repairs a lone surrogate (replacement character) and leaves normal text, emoji pairs and Arabic untouched', ML.wellFormed(lone).endsWith('�') && ML.wellFormed('عرض خاص 🔥') === 'عرض خاص 🔥' && ML.wellFormed('abc') === 'abc' && ML.wellFormed(null) === null && ML.wellFormed(undefined) === undefined);
  ok('a lone LOW surrogate is repaired too', ML.wellFormed('x\uDC00y') === 'x�y');
  ok('safeSlice never cuts an emoji in half', ML.safeSlice('ab🔥cd', 3) === 'ab' && ML.safeSlice('ab🔥cd', 4) === 'ab🔥' && ML.safeSlice('abc', 10) === 'abc' && ML.safeSlice(null, 5) === null);
  let raw = null; try { await prisma.mediaLibraryAsset.create({ data: { fingerprint: `${T}raw`, primary_format: 'IMAGE', asset_name: 'x', sample_body: lone } }); } catch (e) { raw = e; }
  ok('REPRODUCTION: writing the raw half-emoji text is what fails (this is the sync warning)', raw !== null && /hex escape|surrogate|Invalid .*invocation/i.test(String(raw.message)), raw ? raw.message.slice(0, 120) : 'it did NOT fail — the root cause is something else');
  let fixed = null; try { fixed = await prisma.mediaLibraryAsset.create({ data: ML.cleanStrings({ fingerprint: `${T}fixed`, primary_format: 'IMAGE', asset_name: 'x', sample_body: lone }) }); } catch (e) { fixed = e; }
  ok('the same text through cleanStrings is stored', fixed && fixed.id && fixed.sample_body.endsWith('�'), String(fixed?.message || '').slice(0, 160));
} finally { await prisma.mediaLibraryAsset.deleteMany({ where: { fingerprint: { startsWith: T } } }).catch(() => {}); }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
