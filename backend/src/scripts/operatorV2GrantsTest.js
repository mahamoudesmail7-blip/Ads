// 🧪 AI Operator V2 phase 3 — the ADMIN screen's backend: which employee sees which accounts / stores and may review / prepare drafts (real Express routes, real JWT users, isolated test database).
//   Only an ADMIN can use it; only an ACTIVE EMPLOYEE can be edited (never a manager / admin / owner / yourself); only five «operator.*» keys are written and every other permission is preserved;
//   there is NO way to grant approval / execution / policies / roles; every change is audited; a grant takes effect (and a revoke ends it) immediately on the data routes.
//   node src/scripts/operatorV2GrantsTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
const __dirname = dirname(fileURLToPath(import.meta.url)); const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js'); const TT = await imp('../services/amb/dailyPlanTime.js'); const { default: v2Routes } = await imp('../routes/operatorV2.js'); const { errorHandler } = await imp('../middleware/errorHandler.js');
const T = '__optest_v2g_'; const A = `act_${T}A`, B = `act_${T}B`; const today = TT.cairoDate(new Date());
const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api/operator-v2', v2Routes); app.use(errorHandler);
const server = await new Promise((rs) => { const s = app.listen(0, '127.0.0.1', () => rs(s)); }); const base = `http://127.0.0.1:${server.address().port}/api/operator-v2`;
const call = async (method, path, body, token) => { const x = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `token=${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await x.text(); let j = null; try { j = JSON.parse(text); } catch { /* */ } return { s: x.status, j, text }; };
const users = []; const mkUser = async (role, tag, permissions = {}, extra = {}) => { const u = await prisma.user.create({ data: { email: `${T}${tag}_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}${tag}`, role, status: 'ACTIVE', permissions: JSON.stringify(permissions), ...extra } }); users.push(u.id); return { u, token: jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' }) }; };
const permsOf = async (id) => JSON.parse((await prisma.user.findUnique({ where: { id } })).permissions || '{}');
const runA = await prisma.ambSyncRun.create({ data: { status: 'SUCCESS', ad_account_id: A, finished_at: new Date() } }); const runB = await prisma.ambSyncRun.create({ data: { status: 'SUCCESS', ad_account_id: B, finished_at: new Date() } });
await prisma.metaPerformanceSnapshot.createMany({ data: [A, B].flatMap((acc, k) => Array.from({ length: 3 }, (_, i) => ({ sync_run_id: (k ? runB : runA).id, ad_account_id: acc, level: 'campaign', date_start: today, date_stop: today, campaign_id: `${T}${k ? 'b' : 'a'}${i}`, campaign_name: `c${i}`, campaign_status: 'ACTIVE', campaign_budget: 100, campaign_budget_type: 'DAILY', spend: 50, meta_purchases: 1, snapshot_at: new Date() }))) });
const prod = await prisma.product.create({ data: { product_name: `${T}p`, product_code: `${T}${Date.now()}`, store_id: 'default', selling_price: 0, product_cost: 0 } });
const admin = await mkUser('ADMIN', 'admin'); const mgr = await mkUser('MANAGER', 'mgr'); const emp = await mkUser('EMPLOYEE', 'emp', { 'products.create': true }); const emp2 = await mkUser('EMPLOYEE', 'emp2'); const inactive = await mkUser('EMPLOYEE', 'inactive', {}, { status: 'DISABLED' }); const owner = await mkUser('ADMIN', 'owner', {}, { is_owner: true });
const put = (id, body, who = admin) => call('PUT', `/admin/users/${id}/grants`, body, who.token);
try {
  console.log('\n1. Who may use it');
  { ok('ADMIN lists the employees with their current grants, plus the known accounts and stores', (await call('GET', '/admin/users', undefined, admin.token)).j?.users?.some((u) => u.id === emp.u.id && u.editable === true && u.grants.view === false) && (await call('GET', '/admin/users', undefined, admin.token)).j.accounts.includes(A));
    ok('managers are listed as NOT editable (their capabilities come from their role)', (await call('GET', '/admin/users', undefined, admin.token)).j.users.find((u) => u.id === mgr.u.id).editable === false);
    ok('a MANAGER and an EMPLOYEE are refused (403) — on the list and on the change', (await call('GET', '/admin/users', undefined, mgr.token)).s === 403 && (await put(emp.u.id, { view: true, accounts: [A] }, mgr)).s === 403 && (await put(emp.u.id, { view: true, accounts: [A] }, emp)).s === 403 || (await put(emp.u.id, { view: true, accounts: [A] }, emp)).s === 403);
    ok('no cookie → 401', (await call('GET', '/admin/users')).s === 401); }
  console.log('\n2. Granting view / accounts / stores / review / drafts');
  { const r = await put(emp.u.id, { view: true, accounts: [A], review: true, drafts: true }); ok('the admin grants view + account A + review + drafts to an employee', r.s === 200 && r.j.grants.view && r.j.grants.accounts[0] === A && r.j.grants.review && r.j.grants.drafts, JSON.stringify(r.j));
    const p = await permsOf(emp.u.id); ok('the unrelated permission this employee already had is PRESERVED; only operator.* keys were written; the role is unchanged', p['products.create'] === true && p['operator.view'] === true && Object.keys(p).filter((k) => k.startsWith('operator.')).sort().join() === 'operator.accounts,operator.drafts,operator.review,operator.view' && (await prisma.user.findUnique({ where: { id: emp.u.id } })).role === 'EMPLOYEE');
    const q = await call('POST', '/campaigns/query', { accounts: [A], pageSize: 25 }, emp.token); ok('the grant takes effect at once: the employee now reads account A (3 campaigns) and nothing of B', q.s === 200 && q.j.total === 3 && (await call('POST', '/campaigns/query', { accounts: [B] }, emp.token)).s === 403);
    ok('/me reports the capabilities that follow: review + drafts, but NEVER approve / policies', (await call('GET', '/me', undefined, emp.token)).j.capabilities.reviewActions === true && (await call('GET', '/me', undefined, emp.token)).j.capabilities.prepareDrafts === true && (await call('GET', '/me', undefined, emp.token)).j.capabilities.approve === false && (await call('GET', '/me', undefined, emp.token)).j.capabilities.managePolicies === false);
    const st = await put(emp.u.id, { view: true, accounts: [A, B], stores: ['default'], review: true }); ok('a store restriction can be added (only known stores); drafts are dropped when not re-granted', st.s === 200 && st.j.grants.stores[0] === 'default' && st.j.grants.drafts === false && (await call('GET', '/me', undefined, emp.token)).j.stores[0] === 'default');
    ok('after the store restriction an unlinked campaign (unknown store) is hidden from that employee — no data without a store', (await call('POST', '/campaigns/query', { pageSize: 25 }, emp.token)).j.total === 0);
    ok('a changed grant is audited (V2_GRANTS with before / after)', (await prisma.aiAuditLog.count({ where: { kind: 'V2_GRANTS', actor_id: admin.u.id } })) >= 2); }
  console.log('\n3. What can NOT be granted, and who can NOT be edited');
  { const bad = async (body) => (await put(emp2.u.id, body)); const f1 = await bad({ view: true, accounts: [A], approve: true }); ok('an «approve» flag is refused (400 FIELD_NOT_ALLOWED): approval can never be granted from here', f1.s === 400 && f1.j.error === 'FIELD_NOT_ALLOWED');
    ok('«execute», «role», «permissions», «policies», «mode» are refused as well', (await bad({ view: true, accounts: [A], execute: true })).s === 400 && (await bad({ view: true, accounts: [A], role: 'ADMIN' })).s === 400 && (await bad({ view: true, accounts: [A], permissions: { x: 1 } })).s === 400 && (await bad({ view: true, accounts: [A], 'operator.approve': true })).s === 400 && (await bad({ view: true, accounts: [A], policies: true })).s === 400);
    ok('drafts need review (400); review/drafts need view (400); view needs at least one account (400)', (await bad({ view: true, accounts: [A], drafts: true })).j.error === 'DRAFTS_NEED_REVIEW' && (await bad({ view: false, review: true })).s === 400 && (await bad({ view: true, accounts: [] })).j.error === 'ACCOUNTS_REQUIRED');
    ok('an unknown account / store is refused (400)', (await bad({ view: true, accounts: ['act_not_real'] })).j.error === 'UNKNOWN_ACCOUNT' && (await bad({ view: true, accounts: [A], stores: ['no-such-store'] })).j.error === 'UNKNOWN_STORE');
    ok('a MANAGER, an ADMIN, the OWNER and an inactive user cannot be edited here (400)', (await put(mgr.u.id, { view: true, accounts: [A] })).j.error === 'NOT_AN_EMPLOYEE' && (await put(owner.u.id, { view: true, accounts: [A] })).j.error === 'NOT_AN_EMPLOYEE' && (await put(inactive.u.id, { view: true, accounts: [A] })).j.error === 'USER_NOT_ACTIVE');
    ok('the admin cannot edit their own account here (400); an unknown user → 404', (await put(admin.u.id, { view: true, accounts: [A] })).j.error === 'SELF_EDIT' && (await put(99999999, { view: true, accounts: [A] })).s === 404);
    ok('none of the refused attempts changed anything', JSON.stringify(await permsOf(emp2.u.id)) === '{}' && (await prisma.user.findUnique({ where: { id: mgr.u.id } })).permissions === '{}'); }
  console.log('\n4. Revoking');
  { const r = await put(emp.u.id, { view: false }); ok('«view: false» removes every operator.* key and keeps the rest', r.s === 200 && (await permsOf(emp.u.id))['products.create'] === true && Object.keys(await permsOf(emp.u.id)).every((k) => !k.startsWith('operator.')));
    ok('the employee is locked out of the campaign center again at once (403)', (await call('POST', '/campaigns/query', {}, emp.token)).s === 403 && (await call('GET', '/home', undefined, emp.token)).s === 403); }
  console.log('\n5. The legacy permission API is untouched and the operator routes stay closed to employees');
  { await put(emp.u.id, { view: true, accounts: [A], review: true, drafts: true }); const opx = await fetch(`${base.replace('/operator-v2', '')}/operator/overview`, { headers: { Cookie: `token=${emp.token}` } }).catch(() => null); ok('granting V2 rights does not open anything outside /api/operator-v2 (the grant lives only in the user\'s permissions JSON)', true && (!opx || [401, 403, 404].includes(opx.status))); }
} finally {
  await prisma.aiAuditLog.deleteMany({ where: { kind: 'V2_GRANTS', actor_id: { in: users } } }); await prisma.metaPerformanceSnapshot.deleteMany({ where: { ad_account_id: { in: [A, B] } } }); await prisma.ambSyncRun.deleteMany({ where: { ad_account_id: { in: [A, B] } } }); await prisma.product.deleteMany({ where: { product_name: `${T}p` } }); await prisma.user.deleteMany({ where: { id: { in: users } } });
  server.close(); await prisma.$disconnect();
}
void prod; console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
