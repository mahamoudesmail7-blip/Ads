// Starts the real server on the ISOLATED test database (UI/API checks without touching production).
//   node src/scripts/serveOnTestDb.js      (login: test-owner@example.invalid / TEST_ADMIN_PASSWORD from backend/.env, created by `testDb.mjs seed`)
import './_testGuard.js'; // rebinds DATABASE_URL to the test DB and refuses anything else
// No real Graph API from this server: Meta calls go to a dead loopback port and simply fail.
process.env.META_GRAPH_MOCK = '1'; process.env.META_GRAPH_MOCK_URL = process.env.UI_META_MOCK_URL || 'http://127.0.0.1:9'; // the budget UI journey points this at its own loopback Meta mock; otherwise a dead port
if (process.env.UI_META_MOCK_URL) process.env.OPERATOR_ALLOW_META_WRITES = 'true'; // ONLY together with a loopback Meta mock: the writes can reach nothing but the mock (the guard above removes the variable otherwise)
process.env.PORT = process.env.PORT || '4000';
await import('../server.js');
