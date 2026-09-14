// Regression test for the 2026-09-14 production incident: loadSnapshots()
// used to fetch EVERY historical snapshot row for a level+window+account
// (unbounded — one new row per entity per ~15-min sync cycle, forever) and
// reduce to "latest per entity per day" in JS afterward. On the real
// production account that meant a single level='ad' fetch for a 7-day
// window pulled 97,904 rows (~222MB) and took 88 seconds; done 3x
// concurrently inside buildHierarchy(), this OOM-killed the whole Node
// process. Fixed by pushing the "latest per entity per day" reduction into
// the SQL query itself (Postgres DISTINCT ON via Prisma's distinct+orderBy)
// instead of pulling every historical row into memory first.
//
// This test can't exercise a real Postgres DISTINCT ON without a live DB,
// so it does two things instead: (1) a CONTRACT test asserting
// loadSnapshots() actually asks Prisma to do the dedup (distinct+orderBy
// present, date range bounded, null entity ids excluded) rather than a
// plain unbounded findMany — this is exactly the shape that regressed
// before; (2) a mocked findMany that itself simulates real DISTINCT ON
// semantics (many rows per entity per day in the fake table, mock returns
// only the latest per group) to prove the full pipeline still produces
// correct aggregates when fed already-deduped rows, and that a large
// number of raw historical rows per entity never reaches JS.
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

// Simulate a heavily-synced entity: 40 raw snapshot rows per day (matching
// a sync job running every ~15-36 min) across 7 days for ONE ad — 280 raw
// rows for just this one entity, mirroring the real account's actual
// per-entity row density that caused the incident.
const RAW_ROWS = [];
let nextId = 1;
for (let day = 0; day < 7; day++) {
  const date = `2026-09-${String(8 + day).padStart(2, '0')}`;
  for (let cycle = 0; cycle < 40; cycle++) {
    // 36-min cycles (40 × 36min = 24h), each strictly later than the last — mirrors a real ~every-15-36-min sync job with a unique snapshot_at per cycle.
    const minutesIntoDay = cycle * 36;
    const hh = String(Math.floor(minutesIntoDay / 60)).padStart(2, '0');
    const mm = String(minutesIntoDay % 60).padStart(2, '0');
    RAW_ROWS.push({
      id: nextId++, level: 'ad', ad_account_id: 'act_1', ad_id: 'ad_1', campaign_id: null, adset_id: null,
      date_start: date, date_stop: date,
      snapshot_at: new Date(`${date}T${hh}:${mm}:00Z`),
      spend: cycle + 1, impressions: 100 * (cycle + 1), clicks: 5 * (cycle + 1), meta_purchases: cycle % 3,
    });
  }
}

let capturedArgs = null;
prisma.metaPerformanceSnapshot.findMany = async (args) => {
  capturedArgs = args;
  // Simulate a real Postgres DISTINCT ON (idField, date_start) ORDER BY idField, date_start, snapshot_at DESC:
  // keep only the row with the MAX snapshot_at per (idField, date_start) group.
  const { where, distinct } = args;
  let rows = RAW_ROWS.filter((r) => r.level === where.level && r.date_start >= where.date_start.gte && r.date_start <= where.date_start.lte);
  if (!distinct) return rows; // (would be the OLD unbounded behavior — a regression would land here)
  const [idField, dateField] = distinct;
  const groups = new Map();
  for (const r of rows) {
    const key = `${r[idField]}::${r[dateField]}`;
    const existing = groups.get(key);
    if (!existing || r.snapshot_at > existing.snapshot_at) groups.set(key, r);
  }
  return [...groups.values()];
};

const { loadSnapshots, resolveWindow, latestPerDayPerEntity, aggregateRows, entityWindowMetrics } =
  await import(pathToFileURL(join(__dirname, '../services/amb/metricsEngine.js')).href);

console.log('§1 CONTRACT — loadSnapshots() asks the DB to dedup (distinct+orderBy), never an unbounded fetch:');
{
  await loadSnapshots({ level: 'ad', from: '2026-09-08', to: '2026-09-14', adAccountId: 'act_1' });
  ok('where.date_start is a bounded range (never fetches all-time history)', capturedArgs.where.date_start?.gte === '2026-09-08' && capturedArgs.where.date_start?.lte === '2026-09-14', JSON.stringify(capturedArgs.where));
  ok('where excludes null entity ids (ad_id: {not: null})', capturedArgs.where.ad_id?.not === null, JSON.stringify(capturedArgs.where));
  ok('distinct is set on [ad_id, date_start] — the actual dedup key', JSON.stringify(capturedArgs.distinct) === JSON.stringify(['ad_id', 'date_start']), JSON.stringify(capturedArgs.distinct));
  ok('orderBy leads with ad_id, date_start, then snapshot_at DESC (required for Postgres DISTINCT ON to pick the LATEST row)', JSON.stringify(capturedArgs.orderBy) === JSON.stringify([{ ad_id: 'asc' }, { date_start: 'asc' }, { snapshot_at: 'desc' }]), JSON.stringify(capturedArgs.orderBy));
}

console.log('\n§2 VOLUME — 280 raw rows (40/day × 7 days) for one entity collapse to exactly 7 (one per day), never reaching JS as 280:');
{
  const rows = await loadSnapshots({ level: 'ad', from: '2026-09-08', to: '2026-09-14', adAccountId: 'act_1' });
  ok('exactly 7 rows returned (one per day), not 280', rows.length === 7, String(rows.length));
  const day1 = rows.find((r) => r.date_start === '2026-09-08');
  ok('the kept row for day 1 is the LATEST sync cycle (cycle 39, spend=40), never an arbitrary/earlier one', day1.spend === 40, JSON.stringify(day1));
}

console.log('\n§3 downstream pipeline (latestPerDayPerEntity + aggregateRows) still produces correct aggregates over the now-deduped rows:');
{
  const rows = await loadSnapshots({ level: 'ad', from: '2026-09-08', to: '2026-09-14', adAccountId: 'act_1' });
  const byEntity = latestPerDayPerEntity(rows, 'ad');
  ok('one entity in the map', byEntity.size === 1);
  const dayMap = byEntity.get('ad_1');
  ok('7 days for that entity', dayMap.size === 7);
  const agg = aggregateRows([...dayMap.values()]);
  ok('spend summed correctly across the 7 kept (latest-per-day) rows: 7 × 40 = 280', agg.spend === 280, String(agg.spend));
}

console.log('\n§4 entityWindowMetrics() end-to-end over the mocked dedup — never crashes, produces a bounded result:');
{
  const out = await entityWindowMetrics({ level: 'ad', from: '2026-09-08', to: '2026-09-14', adAccountId: 'act_1' }, { minSpend: 1, minPurchases: 1 });
  ok('exactly one entity in the result map', out.size === 1);
  const m = out.get('ad_1');
  ok('aggregated spend matches (280)', m.spend === 280, String(m.spend));
}

console.log('\n§5 zero writes anywhere in this file:');
ok('no guarded prisma write method was ever called', dbWriteAttempted === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
