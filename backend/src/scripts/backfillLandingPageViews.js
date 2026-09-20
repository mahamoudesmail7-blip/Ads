// One-time backfill: re-derive landing_page_views for every already-synced
// MetaPerformanceSnapshot row from its OWN already-stored actions_json —
// never a new Meta API call, never touching any other column. Purely
// additive (only ever sets a currently-NULL value from real, already-
// captured data). Safe to re-run: rows that already have a value, or that
// genuinely never had a landing_page_view action, are left untouched.
//   node src/scripts/backfillLandingPageViews.js            (dry run — counts only)
//   node src/scripts/backfillLandingPageViews.js --apply     (real UPDATE)
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { prisma } = await import(pathToFileURL(join(__dirname, '../prisma.js')).href);

const apply = process.argv.includes('--apply');

const [{ c: eligible }] = await prisma.$queryRaw`
  SELECT COUNT(*)::int AS c
  FROM meta_performance_snapshots
  WHERE landing_page_views IS NULL
    AND actions_json LIKE '%landing_page_view%'
`;
console.log(`Rows eligible for backfill (landing_page_views IS NULL, actions_json has a real landing_page_view entry): ${eligible}`);

if (!apply) {
  console.log('Dry run only — pass --apply to actually update these rows.');
  process.exit(0);
}

const result = await prisma.$executeRaw`
  UPDATE meta_performance_snapshots t
  SET landing_page_views = sub.val::int
  FROM (
    SELECT s.id, (elem->>'value')::numeric AS val
    FROM meta_performance_snapshots s,
         jsonb_array_elements(s.actions_json::jsonb) AS elem
    WHERE s.landing_page_views IS NULL
      AND s.actions_json LIKE '%landing_page_view%'
      AND elem->>'action_type' = 'landing_page_view'
  ) sub
  WHERE t.id = sub.id
`;
console.log(`Updated ${result} rows.`);
process.exit(0);
