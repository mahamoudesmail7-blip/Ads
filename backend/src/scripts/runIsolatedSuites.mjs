// Runs the regression suites SEQUENTIALLY, each as its own process, against the isolated TEST database only (every suite's first import is _testGuard.js).
//   node src/scripts/runIsolatedSuites.mjs [suiteName …]      npm run test:isolated
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertSafeTestUrl, describeTestDatabase, resetTestDatabaseState, withRetry } from './testDb.mjs';
const __dirname = dirname(fileURLToPath(import.meta.url));

const SUITES = ['migrateDeployCoreTest', 'testGuardTest', 'operatorTest', 'operatorSetupTest', 'operatorSetupGridTest', 'operatorIntegrationTest', 'operatorControlTest', 'advisorTest', 'stockIntelligenceTest', 'productActionPlanTest', 'operatorLandingEvidenceTest', 'launchLandingValidationTest', 'ambLaunchJobTest', 'launchQueueTest', 'inventoryWebhookTest', 'inventoryDiagnosticsTest', 'researchPipelineFixesTest', 'operatorWritePathTest', 'budgetOptimizerTest', 'manualChangeAndSyncTest', 'budgetExecutionTest', 'budgetApprovalRouteTest', 'executorDuplicateGuardTest', 'ruleEngineTest', 'dailyPlanTest', 'productionReadinessTest', 'executionPermissionsTest', 'operationsMockTest', 'priorityScoreTest', 'postActionMonitoringTest', 'budgetCapsAndAlertsTest', 'approvalCenterTest', 'productPolicyTest', 'executionHistoryTest', 'productGuardsTest', 'productSchedulingTest', 'campaignBoardTest', 'smartPricingTest', 'openCpaPolicyTest', 'integrationE2ETest'];
// suites with a read-only "real synced world" part skip it here: the isolated database has no synced Meta world (that part stays a manual check)
const skipsWorld = (f) => readFileSync(f, 'utf8').includes('skip-world');
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : SUITES;

assertSafeTestUrl(); // refuses early (before anything runs) if TEST_DATABASE_URL is missing / production-like
const before = await withRetry(describeTestDatabase);
if (!before.marker) { console.error('✗ the target database has no test marker — run: node src/scripts/testDb.mjs seed'); process.exit(3); }
const rows = [];
for (const name of wanted) {
  const file = join(__dirname, `${name}.js`);
  if (!existsSync(file)) { console.log(`- ${name}: not in this checkout — skipped`); continue; } // suites that belong to a later commit simply don't exist yet
  await resetTestDatabaseState(); // every suite starts from factory-default operator state
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file, ...(skipsWorld(file) ? ['--skip-world'] : [])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000, env: process.env });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const sum = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
  const failedLines = out.split('\n').filter((l) => /✗|crashed|TEST GUARD/.test(l)).slice(0, 5);
  rows.push({ name, status: r.status === 0 ? 'ok' : 'FAIL', passed: sum ? +sum[1] : null, failed: sum ? +sum[2] : null, secs: Math.round((Date.now() - t0) / 1000), failedLines });
  console.log(`${r.status === 0 ? '✓' : '✗'} ${name}: ${sum ? `${sum[1]} passed, ${sum[2]} failed` : `exit ${r.status}`} (${rows.at(-1).secs}s)`);
  for (const l of failedLines) console.log('     ', l.slice(0, 220));
}
const after = await withRetry(describeTestDatabase);
console.log('\nTEST database rows before:', JSON.stringify(before.counts), '\nTEST database rows after: ', JSON.stringify(after.counts));
const bad = rows.filter((x) => x.status !== 'ok');
console.log(`\n${bad.length ? '❌' : '✅'} ${rows.length - bad.length}/${rows.length} suites green${bad.length ? ' — failing: ' + bad.map((x) => x.name).join(', ') : ''}`);
process.exit(bad.length ? 1 : 0);
