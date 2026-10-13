// 🧪 AI Operator V2 — SCALE and CONCURRENCY of the campaign center API (isolated test database, no Meta): 500 campaigns × 7 days.
//   bulk REVIEW previews over 1 / 10 / 100 / 500 campaigns (explicit ids and snapshot), paging stability, export of 500 rows, parallel queries, parallel saved-view creation (unique name → exactly one winner),
//   parallel snapshots, and a conflicting open decision (OPEN vs PAUSE) on the same campaign. Reads only — the counts of actions / decisions / plans / recommendations never move.
//   node src/scripts/campaignQueryScaleTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
const __dirname = dirname(fileURLToPath(import.meta.url)); const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js'); const TT = await imp('../services/amb/dailyPlanTime.js'); const CQ = await imp('../services/amb/campaignQuery.js');
const { default: v2Routes } = await imp('../routes/operatorV2.js'); const { errorHandler } = await imp('../middleware/errorHandler.js');
const T = '__optest_v2s_'; const A = `act_${T}A`; const now = new Date(); const today = TT.cairoDate(now); const day = (n) => TT.addDays(today, -n); const N = 500;
const app = express(); app.use(cookieParser()); app.use(express.json({ limit: '5mb' })); app.use('/api/operator-v2', v2Routes); app.use(errorHandler);
const server = await new Promise((rs) => { const s = app.listen(0, '127.0.0.1', () => rs(s)); }); const base = `http://127.0.0.1:${server.address().port}/api/operator-v2`;
const call = async (method, path, body, token) => { const x = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `token=${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await x.text(); let j = null; try { j = JSON.parse(text); } catch { /* csv */ } return { s: x.status, j, text, h: x.headers }; };
const users = []; const mkUser = async (role, tag) => { const u = await prisma.user.create({ data: { email: `${T}${tag}_${Date.now()}@example.invalid`, password_hash: 'x'.repeat(20), name: `${T}${tag}`, role, status: 'ACTIVE', permissions: '{}' } }); users.push(u.id); return { u, token: jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' }) }; };
const counts = async () => ({ actions: await prisma.ambAction.count(), decisions: await prisma.ambOperatorDecision.count(), plans: await prisma.ambDailyPlan.count(), recs: await prisma.ambRecommendation.count() });
const run = await prisma.ambSyncRun.create({ data: { status: 'SUCCESS', ad_account_id: A, finished_at: new Date() } });
const t0 = Date.now(); const batch = [];
for (let i = 0; i < N; i++) { const cid = `${T}c${i}`; const status = i % 3 === 0 ? 'PAUSED' : 'ACTIVE'; for (const d of [0, 1, 2, 4, 6, 12, 40]) batch.push({ sync_run_id: run.id, ad_account_id: A, level: 'campaign', date_start: day(d), date_stop: day(d), campaign_id: cid, campaign_name: `${T}camp ${i}`, campaign_status: status, campaign_budget: 100 + (i % 20) * 10, campaign_budget_type: 'DAILY', spend: 20 + (i % 50) + d, meta_purchases: i % 7 === 0 ? 0 : 1 + (i % 4), meta_revenue: i % 2 === 0 ? 350 : null, snapshot_at: new Date() }); }
for (let k = 0; k < batch.length; k += 1000) await prisma.metaPerformanceSnapshot.createMany({ data: batch.slice(k, k + 1000) });
const admin = await mkUser('ADMIN', 'admin'); const mgr = await mkUser('MANAGER', 'mgr'); const before = await counts();
console.log(`   seeded ${N} campaigns / ${batch.length} snapshot rows in ${Date.now() - t0} ms`);
try {
  console.log('\n1. Paging and filtering over 500 campaigns');
  { const t1 = Date.now(); const r = await call('POST', '/campaigns/query', { accounts: [A], pageSize: 50, period: 'last30', compare: true }, admin.token); const ms = Date.now() - t1;
    ok(`first page (50 of 500, last 30 days + comparison) answered in ${ms} ms (< 6 s) with exactly 50 rows`, r.s === 200 && r.j.total === N && r.j.rows.length === 50 && ms < 6000, `${r.s} ${ms}`);
    const seen = new Set(); let slow = 0; for (let p = 1; p <= 10; p++) { const t2 = Date.now(); const x = await call('POST', '/campaigns/query', { accounts: [A], pageSize: 50, page: p, period: 'last30', compare: true }, admin.token); if (Date.now() - t2 > 3000) slow++; for (const row of x.j.rows) seen.add(row.campaignId); }
    ok('walking all 10 pages yields 500 distinct campaigns (stable ordering, no duplicates, no gaps) and no page was slow (> 3 s)', seen.size === N && slow === 0, `${seen.size} slow=${slow}`);
    const f = await call('POST', '/campaigns/query', { accounts: [A], pageSize: 200, conds: [{ f: 'status', v: ['ACTIVE'] }, { f: 'cpaPeriod', op: 'between', v: [20, 40] }] }, admin.token); ok('a combined filter over 500 rows returns only matching rows, ≤ 200 per page', f.s === 200 && f.j.rows.length <= 200 && f.j.rows.every((x) => x.status === 'ACTIVE' && x.period.cpa >= 20 && x.period.cpa <= 40)); }

  console.log('\n2. Bulk REVIEW previews over 1 / 10 / 100 / 500 campaigns');
  { const snap = (await call('POST', '/campaigns/snapshot', { accounts: [A], view: 'all', sort: { k: 'name', d: 1 } }, mgr.token)).j; ok('a snapshot of all 500 matching campaigns is created (and it is a summary only)', snap.total === N && snap.items === undefined);
    for (const n of [1, 10, 100, 500]) {
      const ids = Array.from({ length: n }, (_, i) => ({ campaignId: `${T}c${i}`, adAccountId: A })); const t1 = Date.now();
      const r = n <= 500 ? await call('POST', '/campaigns/review-preview', { ids, action: 'PAUSE' }, mgr.token) : null; const ms = Date.now() - t1;
      const tt = r.j.totals; ok(`explicit selection of ${n}: totals add up (eligible + rejected + excluded + protected = ${n}) in ${ms} ms`, r.s === 200 && tt.selected === n && tt.eligible + tt.rejected + tt.excluded + tt.protected === n && r.j.items.length === n && ms < 8000, `${r.s} ${JSON.stringify(tt)} ${ms}`);
    }
    const t3 = Date.now(); const viaSnap = await call('POST', '/campaigns/review-preview', { snapshotId: snap.snapshotId, action: 'PAUSE', excluded: [`${T}c0`, `${T}c1`] }, mgr.token); ok(`snapshot of 500 minus 2 exclusions: 498 reviewed in ${Date.now() - t3} ms, each with its own verdict and reasons`, viaSnap.j.totals.selected === 498 && viaSnap.j.items.every((i) => i.kind && Array.isArray(i.reasons)) && Date.now() - t3 < 10000);
    ok('every campaign gets a SEPARATE result (no hidden aggregate): item count equals selection and every rejected item names its reason', viaSnap.j.items.length === 498 && viaSnap.j.items.filter((i) => i.kind === 'REJECTED').every((i) => i.reasons.length > 0));
    const over = await call('POST', '/campaigns/review-preview', { ids: Array.from({ length: 501 }, (_, i) => ({ campaignId: `${T}c${i}`, adAccountId: A })), action: 'PAUSE' }, mgr.token); ok('an explicit id list over 500 is refused (400) — the user must use the server snapshot instead', over.s === 400);
    const ex = await call('POST', '/campaigns/export', { accounts: [A], pageSize: 25 }, admin.token); ok('CSV export of all 500 rows is produced in one server call', ex.s === 200 && ex.h.get('x-row-count') === '500' && ex.text.split('\r\n').length === 501); }

  console.log('\n3. Concurrency');
  { const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => call('POST', '/campaigns/query', { accounts: [A], pageSize: 25, page: 1 + (i % 3), conds: i % 2 ? [{ f: 'status', v: ['PAUSED'] }] : [] }, admin.token)));
    ok('8 parallel queries (different pages / filters) all answer 200 with consistent totals', rs.every((r) => r.s === 200) && new Set(rs.filter((_, i) => i % 2 === 0).map((r) => r.j.total)).size === 1 && new Set(rs.filter((_, i) => i % 2 === 1).map((r) => r.j.total)).size === 1);
    const cfg = { view: 'all', period: { key: 'last7' }, conds: [], sort: { k: 'name', d: 1 } }; const vs = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/views', { name: 'مزامنة متوازية', config: cfg }, admin.token)));
    ok('6 parallel saves of the SAME view name: exactly ONE succeeds, the rest get 409 (unique name per owner, no duplicates)', vs.filter((r) => r.s === 200).length === 1 && vs.filter((r) => r.s === 409).length === 5 && (await prisma.ambOperatorSavedView.count({ where: { owner_id: admin.u.id, name: 'مزامنة متوازية' } })) === 1, vs.map((r) => r.s).join());
    const ss = await Promise.all(Array.from({ length: 4 }, () => call('POST', '/campaigns/snapshot', { accounts: [A], view: 'all' }, mgr.token))); ok('4 parallel snapshots: 4 distinct ids, identical ids-hash (same query → same set), each owned by its creator', new Set(ss.map((r) => r.j.snapshotId)).size === 4 && new Set(ss.map((r) => r.j.idsHash)).size === 1);
    const pre = await Promise.all(Array.from({ length: 4 }, () => call('POST', '/campaigns/review-preview', { snapshotId: ss[0].j.snapshotId, action: 'OPEN' }, mgr.token))); ok('parallel previews over the same snapshot give identical totals (the preview is a pure read)', pre.every((r) => r.s === 200) && new Set(pre.map((r) => JSON.stringify(r.j.totals))).size === 1); }

  console.log('\n4. A conflicting open decision on the same campaign');
  { const cid = `${T}c1`; await prisma.ambOperatorDecision.create({ data: { decision_key: `${T}dk_${Date.now()}`, store_id: 'default', ad_account_id: A, campaign_id: cid, campaign_name: cid, action: 'SCALE_UP', rule_name: 'AUTO:TEST', mode_at_decision: 'APPROVAL', status: 'PREPARED' } });
    const r = await call('POST', '/campaigns/review-preview', { ids: [{ campaignId: cid, adAccountId: A }], action: 'PAUSE' }, mgr.token); const it = r.j.items[0]; ok('pausing a campaign that has an open «increase budget» decision is rejected with the conflict named (OPEN vs PAUSE style conflict)', it.kind === 'REJECTED' && it.reasons.some((x) => /قرار مفتوح مختلف/.test(x)), JSON.stringify(it)); }

  const after = await counts(); console.log('\n5. Reads only'); ok('every call above wrote NOTHING to actions / plans / recommendations; decisions only gained the 1 fixture', after.actions === before.actions && after.plans === before.plans && after.recs === before.recs && after.decisions === before.decisions + 1, JSON.stringify([before, after]));
} finally {
  await prisma.ambOperatorSavedView.deleteMany({ where: { owner_id: { in: users } } }); await prisma.ambOperatorSelectionSnapshot.deleteMany({ where: { owner_id: { in: users } } }); await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { startsWith: T } } });
  await prisma.metaPerformanceSnapshot.deleteMany({ where: { ad_account_id: A } }); await prisma.ambSyncRun.deleteMany({ where: { ad_account_id: A } }); await prisma.user.deleteMany({ where: { id: { in: users } } }); server.close(); await prisma.$disconnect();
}
void CQ; console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
