// Pure helpers shared by _testGuard.js (side-effecting, imported first by every suite) and testDb.mjs. No env access, no DB, no exit.
export const MARKER_ID = '__TEST_DATABASE_MARKER__';
// Production endpoints that are never acceptable as a test target (endpoint host without the "-pooler" suffix; not a secret).
export const KNOWN_PRODUCTION_ENDPOINTS = ['ep-solitary-cell-b22g00vo'];
export const endpointOf = (url) => { try { return new URL(url).hostname.replace('-pooler', '').split('.')[0]; } catch { return null; } };

/** Returns a human-readable problem, or null when `testUrl` is an acceptable, clearly separate test database. */
export function validateTestUrl(testUrl, productionUrls = []) {
  if (!testUrl) return 'TEST_DATABASE_URL is not set (create the Neon "test" branch and put its direct connection string in backend/.env)';
  let u; try { u = new URL(testUrl); } catch { return 'TEST_DATABASE_URL is not a valid URL'; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return 'TEST_DATABASE_URL is not a postgres:// URL';
  if (/-pooler(\.|$)/.test(u.hostname)) return 'TEST_DATABASE_URL must be the DIRECT connection (no -pooler)';
  const ep = endpointOf(testUrl);
  if (KNOWN_PRODUCTION_ENDPOINTS.includes(ep)) return 'TEST_DATABASE_URL points at the PRODUCTION endpoint';
  for (const p of productionUrls.filter(Boolean)) if (endpointOf(p) === ep) return 'TEST_DATABASE_URL has the same endpoint as a production connection string';
  return null;
}
