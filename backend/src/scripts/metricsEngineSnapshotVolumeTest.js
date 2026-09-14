// Regression test for the 2026-09-14 production incident (two rounds):
// (1) loadSnapshots() fetched EVERY historical snapshot row for a
// level+window+account with no bound (one new row per entity per ~15-36
// min sync cycle, forever) and reduced to "latest per entity per day" in
// JS afterward. On the real production account (~218k total rows) a
// single level='ad' fetch for a 7-day window pulled 97,904 rows (~222MB)
// and took 88s; done 3x concurrently inside buildHierarchy(), this
// OOM-killed the whole Node process.
// (2) First fix attempt pushed the dedup into Prisma's findMany({distinct,
// orderBy}) — this DID cut the row count (97,904 -> 669, verified live)
// but a live retest still crashed: EXPLAIN ANALYZE showed the equivalent
// raw SQL executes in ~400ms, while the identical logical query through
// Prisma's ORM `distinct` took 30-50 SECONDS — Prisma's `distinct` was not
// pushing a real DISTINCT ON down to Postgres the way this needed.
// Final fix: loadSnapshots() now runs a genuine parameterized $queryRaw
// with the exact SQL shape already proven fast against production.
//
// This test can't spin up a real Postgres DISTINCT ON, so it verifies the
// CONTRACT instead — the exact regression surface for both incidents:
// (a) loadSnapshots() must call prisma.$queryRaw, never
// prisma.metaPerformanceSnapshot.findMany (guarded — throws if a future
// edit reverts to the slow ORM path); (b) the query is parameterized with
// a bounded date range (never an unbounded historical fetch); (c) the
// rows loadSnapshots() returns flow correctly through the existing
// downstream pipeline (latestPerDayPerEntity/aggregateRows/
// entityWindowMetrics), which is unit-tested directly against a
// large multi-row-per-entity-per-day fixture to prove it still handles
// real sync-job volume correctly regardless of where the dedup happens.
//   node src/scripts/metricsEngineSnapshotVolumeTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

let dbWriteAttempted = false;
for (const model of ['metaPerformanceSnapshot', 'ambProduct', 'ambProductCampaignMap']) {
  for (const method of ['upsert', 'update', 'create', 'updateMany', 'createMany', 'delete', 'deleteMany']) {
    const orig = prisma[model]?.[method]?.bind(prisma[model]);
    if (!orig) continue;
    prisma[model][method] = async () => { dbWriteAttempted = true; throw new Error(`TEST DESIGN VIOLATION: prisma.${model}.${method}() was called — this must be read-only.`); };
  }
}

// A regression back to the ORM path (findMany, even with distinct/orderBy)
// is exactly what silently reintroduced the 30-50s query — guard it hard.
let findManyCalled = false;
prisma.metaPerformanceSnapshot.findMany = async () => { findManyCalled = true; throw new Error('TEST DESIGN VIOLATION: loadSnapshots() must use $queryRaw, not findMany — this exact regression caused a live production crash.'); };

// A small, already-deduped fixture — exactly the shape a real DISTINCT ON
// query returns (one row per entity per day, latest snapshot_at already
// picked by Postgres).
const DEDUPED_FIXTURE = [
  { id: 1, level: 'ad', ad_account_id: 'act_1', ad_id: 'ad_1', campaign_id: null, adset_id: null, date_start: '2026-09-08', date_stop: '2026-09-08', snapshot_at: new Date('2026-09-08T23:24:00Z'), spend: 40, impressions: 4000, clicks: 200, meta_purchases: 1 },
  { id: 2, level: 'ad', ad_account_id: 'act_1', ad_id: 'ad_1', campaign_id: null, adset_id: null, date_start: '2026-09-09', date_stop: '2026-09-09', snapshot_at: new Date('2026-09-09T23:24:00Z'), spend: 40, impressions: 4000, clicks: 200, meta_purchases: 1 },
];

let capturedCallCount = 0;
let capturedContainsLevel = null, capturedContainsFrom = null, capturedContainsTo = null;
prisma.$queryRaw = async (strings, ...values) => {
  capturedCallCount++;
  // level/from/to are plain interpolated strings; the id-column and the
  // optional ad_account_id fragment are Prisma.raw()/Prisma.sql() objects,
  // not plain strings — filter to what we can safely assert on generically.
  const plainStrings = values.filter((v) => typeof v === 'string');
  capturedContainsLevel = plainStrings.includes('ad');
  capturedContainsFrom = plainStrings.includes('2026-09-08');
  capturedContainsTo = plainStrings.includes('2026-09-14');
  return DEDUPED_FIXTURE;
};

const { loadSnapshots, resolveWindow, latestPerDayPerEntity, aggregateRows, entityWindowMetrics } =
  await import(pathToFileURL(join(__dirname, '../services/amb/metricsEngine.js')).href);

console.log('§1 CONTRACT — loadSnapshots() uses $queryRaw (a real DISTINCT ON), never Prisma\'s findMany({distinct}) ORM path:');
{
  const rows = await loadSnapshots({ level: 'ad', from: '2026-09-08', to: '2026-09-14', adAccountId: 'act_1' });
  ok('$queryRaw was called exactly once', capturedCallCount === 1, String(capturedCallCount));
  ok('findMany was never called (the exact regression that caused a second live crash)', findManyCalled === false);
  ok('the query is parameterized with the requested level', capturedContainsLevel === true);
  ok('the query is parameterized with a bounded from-date (never an unbounded historical fetch)', capturedContainsFrom === true);
  ok('the query is parameterized with a bounded to-date', capturedContainsTo === true);
  ok('loadSnapshots() returns exactly the (already-deduped) rows the query produced', rows.length === 2, String(rows.length));
}

console.log('\n§2 downstream pipeline correctness — latestPerDayPerEntity/aggregateRows over the deduped rows:');
{
  const rows = await loadSnapshots({ level: 'ad', from: '2026-09-08', to: '2026-09-14', adAccountId: 'act_1' });
  const byEntity = latestPerDayPerEntity(rows, 'ad');
  ok('one entity in the map', byEntity.size === 1);
  const dayMap = byEntity.get('ad_1');
  ok('2 days for that entity', dayMap.size === 2);
  const agg = aggregateRows([...dayMap.values()]);
  ok('spend summed correctly: 40 + 40 = 80', agg.spend === 80, String(agg.spend));
}

console.log('\n§3 entityWindowMetrics() end-to-end — never crashes, produces a bounded result:');
{
  const out = await entityWindowMetrics({ level: 'ad', from: '2026-09-08', to: '2026-09-14', adAccountId: 'act_1' }, { minSpend: 1, minPurchases: 1 });
  ok('exactly one entity in the result map', out.size === 1);
  const m = out.get('ad_1');
  ok('aggregated spend matches (80)', m.spend === 80, String(m.spend));
}

console.log('\n§4 VOLUME — latestPerDayPerEntity/aggregateRows still handle real sync-job volume correctly if ever fed un-deduped rows directly (defense in depth; the actual fix is at the query layer, verified live against production at ~600ms for the real account):');
{
  const rawRows = [];
  let nextId = 100;
  for (let day = 0; day < 7; day++) {
    const date = `2026-09-${String(8 + day).padStart(2, '0')}`;
    for (let cycle = 0; cycle < 40; cycle++) {
      const minutesIntoDay = cycle * 36;
      const hh = String(Math.floor(minutesIntoDay / 60)).padStart(2, '0');
      const mm = String(minutesIntoDay % 60).padStart(2, '0');
      rawRows.push({ id: nextId++, ad_id: 'ad_2', date_start: date, snapshot_at: new Date(`${date}T${hh}:${mm}:00Z`), spend: cycle + 1 });
    }
  }
  ok('280 raw rows constructed (40/day x 7 days) — the real incident\'s per-entity density', rawRows.length === 280);
  const byEntity = latestPerDayPerEntity(rawRows, 'ad');
  const dayMap = byEntity.get('ad_2');
  ok('collapses to exactly 7 (one per day), never 280, even when fed directly', dayMap.size === 7, String(dayMap.size));
  const agg = aggregateRows([...dayMap.values()]);
  ok('keeps the LATEST cycle per day (spend=40 x 7 = 280), never an arbitrary earlier one', agg.spend === 280, String(agg.spend));
}

console.log('\n§5 zero writes anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
