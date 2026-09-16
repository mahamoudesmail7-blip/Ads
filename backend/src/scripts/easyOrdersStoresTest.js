// Offline tests for the multi-store Easy Orders registry
// (services/easyOrdersStores.js). Pure config-parsing logic — no network
// call, no DB call, no real credential ever touched. Mutates process.env
// directly (this script's own process only) to exercise every
// configuration path, then restores it.
//   node src/scripts/easyOrdersStoresTest.js
import { pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const ORIGINAL_ENV = { ...process.env };
function resetEnv() {
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
  for (const k of Object.keys(ORIGINAL_ENV)) process.env[k] = ORIGINAL_ENV[k];
  delete process.env.EASYORDERS_STORES_JSON;
  delete process.env.EASYORDERS_API_KEY;
  delete process.env.EASYORDERS_API_KEY_TRENDY;
  delete process.env.EASYORDERS_API_KEY_SMART;
}

// Fresh module instance per scenario (env is read at call-time, not import
// time, so a single import is actually fine — but re-importing with a
// cache-busting query string keeps each block visually self-contained).
const mod = await import(pathToFileURL(process.cwd() + '/src/services/easyOrdersStores.js').href);
const { listStores, getStore, getStoreApiKey, defaultStoreId, storeConfigDiagnostics, storeConnectionsOverview } = mod;

console.log('§B1 Backward compatibility — only EASYORDERS_API_KEY set (today\'s real production shape):');
{
  resetEnv();
  process.env.EASYORDERS_API_KEY = 'fake-real-key-value';
  ok('exactly one default store is synthesized', listStores().length === 1 && listStores()[0].id === 'default');
  ok('default store name is set', typeof listStores()[0].name === 'string' && listStores()[0].name.length > 0);
  ok('defaultStoreId() resolves to "default"', defaultStoreId() === 'default');
  ok('getStoreApiKey resolves the real single key', getStoreApiKey('default') === 'fake-real-key-value');
  ok('getStoreApiKey never returns the key from listStores() output', !JSON.stringify(listStores()).includes('fake-real-key-value'));
}

console.log('\n§B2 No Easy Orders configured at all:');
{
  resetEnv();
  ok('listStores() is empty', listStores().length === 0);
  ok('getStore("default") is null', getStore('default') === null);
  ok('getStoreApiKey("default") is null, never throws', getStoreApiKey('default') === null);
}

console.log('\n§M1 Multi-store — EASYORDERS_STORES_JSON with two real stores:');
{
  resetEnv();
  process.env.EASYORDERS_API_KEY_TRENDY = 'trendy-real-key';
  process.env.EASYORDERS_API_KEY_SMART = 'smart-real-key';
  process.env.EASYORDERS_STORES_JSON = JSON.stringify([
    { id: 'trendy', name: 'Trendy Store', apiKeyEnv: 'EASYORDERS_API_KEY_TRENDY', domain: 'trendy.example.com' },
    { id: 'smart', name: 'Smart Store', apiKeyEnv: 'EASYORDERS_API_KEY_SMART' },
  ]);

  const list = listStores();
  ok('both stores listed', list.length === 2);
  ok('safe metadata only — no apiKeyEnv/apiKey field leaked', !('apiKeyEnv' in list[0]) && !('apiKey' in list[0]));
  ok('no real key VALUE anywhere in listStores() output', !JSON.stringify(list).includes('trendy-real-key') && !JSON.stringify(list).includes('smart-real-key'));
  ok('domain surfaced when configured', list.find((s) => s.id === 'trendy').domain === 'trendy.example.com');
  ok('domain is null when not configured', list.find((s) => s.id === 'smart').domain === null);

  ok('getStoreApiKey("trendy") resolves ONLY the Trendy key', getStoreApiKey('trendy') === 'trendy-real-key');
  ok('getStoreApiKey("smart") resolves ONLY the Smart key', getStoreApiKey('smart') === 'smart-real-key');
  ok('a store never resolves to a DIFFERENT store\'s key (strict isolation)', getStoreApiKey('trendy') !== getStoreApiKey('smart'));
  ok('getStoreApiKey("unknown") is null', getStoreApiKey('unknown-store-id') === null);
  ok('getStore("unknown") is null', getStore('unknown-store-id') === null);
}

console.log('\n§M2 One store misconfigured (its apiKeyEnv points at an unset env var):');
{
  resetEnv();
  process.env.EASYORDERS_API_KEY_TRENDY = 'trendy-real-key';
  process.env.EASYORDERS_STORES_JSON = JSON.stringify([
    { id: 'trendy', name: 'Trendy Store', apiKeyEnv: 'EASYORDERS_API_KEY_TRENDY' },
    { id: 'broken', name: 'Broken Store', apiKeyEnv: 'EASYORDERS_API_KEY_NEVER_SET' },
  ]);
  ok('both still listed (config exists even if the key is missing)', listStores().length === 2);
  ok('the misconfigured store\'s key resolves to null, never throws', getStoreApiKey('broken') === null);
  ok('the OTHER store is unaffected by its sibling\'s misconfiguration', getStoreApiKey('trendy') === 'trendy-real-key');
}

console.log('\n§M3 Malformed EASYORDERS_STORES_JSON falls back safely:');
{
  resetEnv();
  process.env.EASYORDERS_API_KEY = 'fallback-key';
  process.env.EASYORDERS_STORES_JSON = 'this is not valid json{{{';
  ok('invalid JSON -> falls back to single-default-store mode, never throws', listStores().length === 1 && listStores()[0].id === 'default');

  resetEnv();
  process.env.EASYORDERS_API_KEY = 'fallback-key-2';
  process.env.EASYORDERS_STORES_JSON = JSON.stringify({ not: 'an array' });
  ok('valid JSON but not an array -> falls back safely too', listStores().length === 1 && listStores()[0].id === 'default');

  resetEnv();
  process.env.EASYORDERS_API_KEY = 'fallback-key-3';
  process.env.EASYORDERS_STORES_JSON = JSON.stringify([{ id: 'x' }]); // missing name/apiKeyEnv
  ok('a malformed store entry is skipped, not crashed on', listStores().length === 1 && listStores()[0].id === 'default');
}

console.log('\n§M4 A store explicitly disabled:');
{
  resetEnv();
  process.env.EASYORDERS_API_KEY_TRENDY = 'trendy-real-key';
  process.env.EASYORDERS_STORES_JSON = JSON.stringify([{ id: 'trendy', name: 'Trendy Store', apiKeyEnv: 'EASYORDERS_API_KEY_TRENDY', enabled: false }]);
  ok('listStores() still shows it (with enabled:false) so the UI can grey it out', listStores()[0].enabled === false);
  ok('getStoreApiKey refuses to resolve a disabled store\'s key', getStoreApiKey('trendy') === null);
}

console.log('\n§M5 storeConfigDiagnostics() fingerprints prove key equality/inequality WITHOUT ever exposing the value:');
{
  resetEnv();
  process.env.EASYORDERS_API_KEY_TRENDY = 'real-key-for-trendy-store-AAAA';
  process.env.EASYORDERS_STORES_JSON = JSON.stringify([
    { id: 'trendy', name: 'Trendy Store', apiKeyEnv: 'EASYORDERS_API_KEY_TRENDY' },
    { id: 'other', name: 'Other Store', apiKeyEnv: 'EASYORDERS_API_KEY_OTHER' }, // unset on purpose
  ]);
  const diag = storeConfigDiagnostics();
  const trendy = diag.find((d) => d.id === 'trendy');
  const other = diag.find((d) => d.id === 'other');
  ok('a configured, present key gets a non-null fingerprint', typeof trendy.apiKeyFingerprint === 'string' && trendy.apiKeyFingerprint.length === 12);
  ok('the fingerprint never contains the raw key value as a substring', !trendy.apiKeyFingerprint.includes('real-key-for-trendy-store-AAAA'));
  ok('a missing/unset key fingerprints to null, never throws', other.apiKeyFingerprint === null);

  resetEnv();
  process.env.EASYORDERS_API_KEY_TRENDY = 'same-value-both-stores';
  process.env.EASYORDERS_API_KEY_OTHER = 'same-value-both-stores';
  process.env.EASYORDERS_STORES_JSON = JSON.stringify([
    { id: 'trendy', name: 'Trendy Store', apiKeyEnv: 'EASYORDERS_API_KEY_TRENDY' },
    { id: 'other', name: 'Other Store', apiKeyEnv: 'EASYORDERS_API_KEY_OTHER' },
  ]);
  const diagSame = storeConfigDiagnostics();
  ok('two DIFFERENT env vars holding the SAME real value -> identical fingerprint (proves misconfiguration detectable)', diagSame.find((d) => d.id === 'trendy').apiKeyFingerprint === diagSame.find((d) => d.id === 'other').apiKeyFingerprint);

  resetEnv();
  process.env.EASYORDERS_API_KEY_TRENDY = 'value-one';
  process.env.EASYORDERS_API_KEY_OTHER = 'value-two';
  process.env.EASYORDERS_STORES_JSON = JSON.stringify([
    { id: 'trendy', name: 'Trendy Store', apiKeyEnv: 'EASYORDERS_API_KEY_TRENDY' },
    { id: 'other', name: 'Other Store', apiKeyEnv: 'EASYORDERS_API_KEY_OTHER' },
  ]);
  const diagDiff = storeConfigDiagnostics();
  ok('two genuinely different values -> different fingerprints', diagDiff.find((d) => d.id === 'trendy').apiKeyFingerprint !== diagDiff.find((d) => d.id === 'other').apiKeyFingerprint);
}

console.log('\n§M6 storeConnectionsOverview() — the DEFAULT store\'s webhook secrets live in two SEPARATE global env vars (pre-multi-store), never in EASYORDERS_STORES_JSON, so this must check those directly instead of trusting storeConfigDiagnostics() alone:');
{
  resetEnv();
  process.env.EASYORDERS_API_KEY_TRENDY = 'trendy-real-key';
  process.env.EASYORDERS_STORES_JSON = JSON.stringify([
    { id: 'default', name: 'placeholder', apiKeyEnv: 'EASYORDERS_API_KEY' },
    { id: 'trendy', name: 'Trendy Store', apiKeyEnv: 'EASYORDERS_API_KEY_TRENDY', webhookSecretEnv: 'EASYORDERS_WEBHOOK_SECRET_TRENDY' },
  ]);
  process.env.EASYORDERS_WEBHOOK_SECRET_TRENDY = 'trendy-webhook-secret';
  // Neither legacy secret is set yet.
  let overview = storeConnectionsOverview();
  let def = overview.find((s) => s.id === 'default');
  let trendy = overview.find((s) => s.id === 'trendy');
  ok('default store is tagged legacy-split mode', def.webhookMode === 'legacy-split');
  ok('a non-default store is tagged per-store mode', trendy.webhookMode === 'per-store');
  ok('default\'s legacy order-created secret correctly reported unset', def.legacyOrderCreatedSecretConfigured === false);
  ok('default\'s legacy status-update secret correctly reported unset', def.legacyStatusUpdateSecretConfigured === false);
  ok('a per-store-mode entry has no legacy fields at all', !('legacyOrderCreatedSecretConfigured' in trendy));
  ok('per-store webhook secret presence still comes through normally', trendy.webhookSecretConfigured === true);

  process.env.EASYORDERS_WEBHOOK_SECRET = 'legacy-order-created-secret';
  overview = storeConnectionsOverview();
  def = overview.find((s) => s.id === 'default');
  ok('setting EASYORDERS_WEBHOOK_SECRET flips ONLY the order-created flag', def.legacyOrderCreatedSecretConfigured === true && def.legacyStatusUpdateSecretConfigured === false);

  process.env.EASYORDERS_STATUS_WEBHOOK_SECRET = 'legacy-status-update-secret';
  overview = storeConnectionsOverview();
  def = overview.find((s) => s.id === 'default');
  ok('setting EASYORDERS_STATUS_WEBHOOK_SECRET flips the status-update flag too, independently', def.legacyStatusUpdateSecretConfigured === true);

  ok('no real secret VALUE anywhere in the output', !JSON.stringify(overview).includes('legacy-order-created-secret') && !JSON.stringify(overview).includes('legacy-status-update-secret') && !JSON.stringify(overview).includes('trendy-webhook-secret'));
}

resetEnv();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
