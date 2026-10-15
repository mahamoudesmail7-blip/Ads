// 🧪 Live Campaign Intelligence §33 — milestone alerts (sample reached · scale-eligible) from REAL numbers only. Pure signal function + once-only raising on the ISOLATED test database.
//   node src/scripts/liveMilestoneAlertsTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url)); const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`); } };
const A = await imp('../services/amb/liveCampaignAlerts.js'); const { prisma } = await imp('../prisma.js');
const eco = (o = {}) => ({ available: true, name: 'منتج اختبار', economicsComplete: true, breakEvenCpa: 240, cpa: { max: 150 }, performance: { orders7: 9, cpa7: 80 }, ...o });

console.log('\n1. Signals come only from real, complete numbers');
{
  const k = (e, n = 5) => A.evaluateLiveSignals({ economics: e, minSample: n }).map((x) => x.kind).join(',');
  ok('sample reached + CPA at/below 60% of max CPA (80 ≤ 90) + complete economics → both signals', k(eco()) === 'SAMPLE_REACHED,SCALE_ELIGIBLE');
  ok('CPA above the scale line (100 > 90) → sample signal only, never a scale signal', k(eco({ performance: { orders7: 9, cpa7: 100 } })) === 'SAMPLE_REACHED');
  ok('below the minimum sample (4 < 5) → nothing at all (no verdict on thin data)', k(eco({ performance: { orders7: 4, cpa7: 40 } })) === '');
  ok('economics incomplete (no margin) → no scale signal even with a great CPA', k(eco({ economicsComplete: false, breakEvenCpa: null })) === 'SAMPLE_REACHED');
  ok('no max CPA entered → no scale signal (the line is unknown, not assumed)', k(eco({ cpa: { max: null } })) === 'SAMPLE_REACHED');
  ok('CPA unknown (null) → no scale signal, orders alone give only the sample signal', k(eco({ performance: { orders7: 9, cpa7: null } })) === 'SAMPLE_REACHED');
  ok('product with no economics record → nothing', k({ available: false }) === '' && k(null) === '');
  ok('the minimum sample is the configured one (8): 9 orders still qualifies, 7 does not', k(eco(), 8) !== '' && k(eco({ performance: { orders7: 7, cpa7: 40 } }), 8) === '');
  const sc = A.evaluateLiveSignals({ economics: eco(), minSample: 5 }).find((x) => x.kind === 'SCALE_ELIGIBLE'); ok('the scale line is exactly 0.6 × max CPA = 90', sc.scaleLine === 90 && sc.max === 150);
}
console.log('\n2. A milestone is raised ONCE per key (an upsert would re-mark a read alert unread every 30 min)');
{
  const key = `__lm_test:${Date.now()}`; await prisma.ambAlert.deleteMany({ where: { dedupe_key: { startsWith: '__lm_test:' } } });
  const a = await A.raiseOnce({ severity: 'INFO', category: 'LIVE_CAMPAIGN', title: 't', message: 'm', dedupeKey: key }); ok('first raise creates the alert', a && a.id);
  await prisma.ambAlert.update({ where: { dedupe_key: key }, data: { read: true } });
  const b = await A.raiseOnce({ severity: 'INFO', category: 'LIVE_CAMPAIGN', title: 't2', message: 'm2', dedupeKey: key }); ok('second raise with the same key does nothing', b === null);
  const row = await prisma.ambAlert.findUnique({ where: { dedupe_key: key } }); ok('the read alert stays read and unchanged (title t, read=true)', row.read === true && row.title === 't');
  await prisma.ambAlert.deleteMany({ where: { dedupe_key: { startsWith: '__lm_test:' } } });
}
console.log(`\n${fail ? '❌' : '✅'} liveMilestoneAlertsTest: ${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
