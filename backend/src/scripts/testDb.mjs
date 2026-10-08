// 🧪 Isolated TEST database for the regression suites (a SEPARATE Neon branch — never the production database).
//
//   TEST_DATABASE_URL=postgresql://…   direct (non-pooler) connection of the Neon "test" branch, kept in backend/.env (git-ignored)
//
//   node src/scripts/testDb.mjs check   validate TEST_DATABASE_URL (set, separate from production, direct)
//   node src/scripts/testDb.mjs seed    write the test marker row + the minimal fixtures (user #1 ADMIN) into the TEST database ONLY
//   node src/scripts/testDb.mjs info    read-only: identity + row counts of the TEST database
//
// No migration is ever run here: the branch is created from production's schema ("schema only"), and the suites only need the tables.
// (The Neon pooler/pgbouncer does not keep search_path, which is why a same-database schema trick is NOT used.)
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { validateTestUrl, MARKER_ID } from './_testGuardCore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = (key) => { try { const m = readFileSync(join(__dirname, '../../.env'), 'utf8').match(new RegExp('^' + key + '="?([^"\\r\\n]*)"?\\s*$', 'm')); return m ? m[1] : ''; } catch { return ''; } };
const testUrl = () => (process.env.TEST_DATABASE_URL || dotenv('TEST_DATABASE_URL')).trim();
const prodUrls = () => [process.env.DATABASE_URL, process.env.DIRECT_DATABASE_URL, dotenv('DATABASE_URL'), dotenv('DIRECT_DATABASE_URL')];

/** Throws unless TEST_DATABASE_URL is a usable, clearly-separate test database. Returns the URL. */
export function assertSafeTestUrl(url = testUrl(), production = prodUrls()) {
  const problem = validateTestUrl(url, production);
  if (problem) throw new Error(problem);
  return url;
}

export async function seedTestDatabase({ log = console.log } = {}) {
  const url = assertSafeTestUrl();
  const db = new PrismaClient({ datasources: { db: { url } }, log: [] });
  try {
    const [{ n }] = await db.$queryRawUnsafe(`select count(*)::int n from public.users where id <> 1`);
    if (n > 0) throw new Error(`the target database has ${n} real-looking users besides #1 — refusing to mark it as a test database (is this production?)`);
    await db.settings.upsert({ where: { id: MARKER_ID }, update: {}, create: { id: MARKER_ID, data: JSON.stringify({ purpose: 'isolated regression-test database', seeded_at: new Date().toISOString() }) } });
    log('test marker row written');
    // A FAKE connected Meta account (never a real token): the Meta-mock suites need "a connected ad account" to exist; the mock Graph server is the only network target.
    if (!process.env.META_TOKEN_ENCRYPTION_KEY) process.env.META_TOKEN_ENCRYPTION_KEY = dotenv('META_TOKEN_ENCRYPTION_KEY');
    const { encrypt } = await import('../services/metaCrypto.js');
    await db.metaConnection.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default', status: 'CONNECTED', access_token_enc: encrypt('TEST-ONLY-FAKE-TOKEN'), token_expires_at: new Date('2036-01-01T00:00:00Z'), meta_user_id: 'test_user', meta_user_name: 'TEST (fake, isolated database)', selected_business_id: 'test_biz', selected_business_name: 'TEST BUSINESS', selected_ad_account_id: 'act_9990000000001', selected_ad_account_name: 'TEST AD ACCOUNT (fake)', connected_at: new Date() } });
    log('seeded a FAKE connected Meta account (test database only)');
    // Fixture catalog (fake products — the real-catalog suites need "a real product" and the Hair Cap #424 identity): TEST DATABASE ONLY, ids far from anything the suites auto-generate.
    const products = [
      { id: 424, product_name: 'Hair Cap (TEST FIXTURE #424)', product_code: 'TEST-FIXTURE-424', category: 'test', selling_price: 450, product_cost: 120, current_stock: 2000, minimum_stock: 600, store_id: 'trendy-storeee', easy_orders_uuid: '87163ecd-4260-498f-86ff-a07156a56f96' },
      { id: 9001, product_name: 'Fixture product A (TEST)', product_code: 'TEST-FIXTURE-9001', category: 'test', selling_price: 300, product_cost: 90, current_stock: null, minimum_stock: null, store_id: 'default' },
      { id: 9002, product_name: 'Fixture product B (TEST)', product_code: 'TEST-FIXTURE-9002', category: 'test', selling_price: 250, product_cost: 70, current_stock: 40, minimum_stock: 10, store_id: 'default' },
    ];
    for (const p of products) {
      await db.product.upsert({ where: { id: p.id }, update: {}, create: p });
      await db.ambProduct.upsert({ where: { product_id: p.id }, update: {}, create: { product_id: p.id, product_name: p.product_name, product_cost: p.product_cost } });
    }
    log('seeded 3 fixture products (+ ambProduct rows)');
    if (!(await db.user.findUnique({ where: { id: 1 } }))) {
      await db.user.create({ data: { id: 1, email: 'test-owner@example.invalid', password_hash: 'x'.repeat(20), name: 'TEST OWNER (isolated database)', role: 'ADMIN', status: 'ACTIVE', permissions: '{}', is_owner: true } });
      log('seeded user #1 (ADMIN, test account)');
    }
  } finally { await db.$disconnect(); }
}

/** Test-database ONLY: puts the shared mutable operator state back to factory defaults between suites (a suite that crashed mid-way must not poison the next one). */
export async function resetTestDatabaseState() {
  const url = assertSafeTestUrl();
  const db = new PrismaClient({ datasources: { db: { url } }, log: [] });
  try {
    const marker = await db.$queryRawUnsafe(`select 1 from public.settings where id = $1`, MARKER_ID);
    if (marker.length !== 1) throw new Error('refusing to reset: the target has no test marker');
    const defaults = { mode: 'SHADOW', emergency_stop: false, emergency_reason: null, emergency_by_id: null, emergency_at: null, limits_json: null, cooldowns_json: null, store_limits_json: null, autopilot_attest_json: null, schedule_json: null, updated_by_id: null };
    await db.ambOperatorConfig.upsert({ where: { scope: 'GLOBAL' }, update: defaults, create: { scope: 'GLOBAL', ...defaults } }); // factory defaults: SHADOW, all permissions OFF
  } finally { await db.$disconnect(); }
}

export async function describeTestDatabase() {
  const url = assertSafeTestUrl();
  const db = new PrismaClient({ datasources: { db: { url } }, log: [] });
  try {
    const marker = await db.$queryRawUnsafe(`select 1 from public.settings where id = $1`, MARKER_ID);
    const counts = {};
    for (const t of ['users', 'amb_alerts', 'amb_actions', 'amb_operator_decisions', 'amb_recommendations', 'ai_audit_log']) {
      try { counts[t] = (await db.$queryRawUnsafe(`select count(*)::int n from public."${t}"`))[0].n; } catch { counts[t] = 'n/a'; }
    }
    return { marker: marker.length === 1, counts };
  } finally { await db.$disconnect(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'check') { assertSafeTestUrl(); console.log('TEST_DATABASE_URL looks safe (separate endpoint, direct connection)'); }
    else if (cmd === 'seed') await seedTestDatabase();
    else if (cmd === 'info') console.log(JSON.stringify(await describeTestDatabase()));
    else console.log('usage: node src/scripts/testDb.mjs check | seed | info');
  } catch (e) { console.error('✗', e.message); process.exit(1); }
  process.exit(0);
}
