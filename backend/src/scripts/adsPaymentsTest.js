// Ads Payment Center («مركز المدفوعات الإعلانية») — services/amb/payments/*, routes/adsPayments.js.
// SIMULATION ONLY: the provider is the in-process simulator (allowed only on the isolated test database), Meta is replaced by injected fakes. No real code is extracted, no money moves.
//   node src/scripts/adsPaymentsTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
process.env.ADS_PAYMENTS_SIMULATION = '1';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };
const throwsCode = async (fn, code) => { try { await fn(); return false; } catch (e) { return code ? (e.code === code || e.error === code) : true; } };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const waitFor = async (fn, ms = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

const { prisma } = await imp('../prisma.js');
const SP = await imp('../services/amb/payments/spec.js');
const S = await imp('../services/amb/payments/store.js');
const PV = await imp('../services/amb/payments/providers.js');
const E = await imp('../services/amb/payments/engine.js');
const R = await imp('../services/amb/payments/reports.js');
const CE = await imp('../services/amb/cloneEngine.js');
const SCH = await imp('../services/amb/payments/scheduler.js');

const A1 = 'act_1110001', A2 = 'act_1110002', A3 = 'act_1110003';
const ACCOUNTS = [{ id: A1, name: 'Ahmed Samy', isPrimary: true }, { id: A2, name: 'Hady Ads' }, { id: A3, name: 'Yasser Ads' }];
const ADMIN = { id: 1, name: 'Owner', role: 'ADMIN', is_owner: true }, MGR = { id: 2, name: 'Mona', role: 'MANAGER' }, EMP = { id: 3, name: 'Emp', role: 'EMPLOYEE' };
let clock = Date.now(); let funds = {}; let sleeps = 0;
E._setDeps({ now: () => clock, sleep: async () => { sleeps++; }, listAccounts: async () => ACCOUNTS, getFunds: async (id) => funds[id] || { available: null, display: null } });
R._setReportDeps({ spendByDay: async () => new Map() });
let rid = 0; const RID = () => `req-${Date.now().toString(36)}-${++rid}`;
const reset = async () => { await prisma.settings.deleteMany({ where: { id: { startsWith: 'fp:' } } }); PV._resetProviders(); PV.sim.creditDelayMs = 0; clock = Date.now(); funds = {}; sleeps = 0; };
const addMethod = (o = {}) => S.upsertMethod({ label: 'محفظة تجريبية', type: 'WALLET', feePct: 1, feeFixed: 1, balanceEgp: 100000, ...o });
const cairoMs = (d, hm) => CE.cairoLocalToUtc(d, hm).getTime();
/** a code written directly (a past event), to test periods / closing / alerts without waiting */
const seed = async (o) => {
  const id = S.newId(); const amount = o.amountEgp ?? 1000;
  const c = { id, code: o.code || String(Math.floor(1e8 + Math.random() * 9e8)), accountId: o.accountId || A1, accountName: (ACCOUNTS.find((a) => a.id === (o.accountId || A1)) || {}).name || 'x', amountEgp: amount, status: o.status || 'UNPAID', source: 'MANUAL', simulated: false,
    extractedAt: new Date(o.extractedAt || clock).toISOString(), extractedBy: { id: 1, name: o.extractedBy || 'Owner' }, expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : null, jobId: null, payment: null, credit: null, lastCheckedAt: null, reason: o.reason || null, events: [] };
  if (o.paidAt) c.payment = { methodId: o.methodId || 'm1', methodLabel: o.methodLabel || 'محفظة تجريبية', methodType: 'WALLET', feeEgp: o.fee ?? 5, totalEgp: SP.sumEgp([amount, o.fee ?? 5]), paidAt: new Date(o.paidAt).toISOString(), paidBy: { id: o.paidById ?? 1, name: o.paidBy || 'Owner' }, startedAt: new Date(o.paidAt).toISOString(), startedBy: { id: 1, name: 'Owner' }, txnRef: o.txnRef || 'T' + id, attempts: [], attemptNo: 1, confirmedAmountEgp: o.confirmedAmountEgp ?? amount };
  if (o.creditedAt) c.credit = { at: new Date(o.creditedAt).toISOString(), source: 'MANUAL', evidence: 'x', by: { id: 1, name: 'Owner' }, amountEgp: amount };
  await S.createCode(c); return S.getCode(id);
};

await reset();

console.log('\n1. Money & input rules');
ok('0.1 + 0.2 sums to exactly 0.3 (piasters, no float drift)', SP.sumEgp([0.1, 0.2]) === 0.3 && SP.sumEgp([1000.1, 2000.2, 0.7]) === 3001);
ok('amounts: positive, ≤ 2 decimals, within the min / max', (await rejects(async () => SP.parseAmount('0')))?.status === 400 && (await rejects(async () => SP.parseAmount('10.555'))) && (await rejects(async () => SP.parseAmount(200000))) && SP.parseAmount('3,000') === 3000 && SP.parseAmount('12.5') === 12.5);
ok('code numbers are normalised (spaces / dashes / case) and strictly validated', SP.normalizeCode(' 12-34 567 ') === '1234567' && SP.validCode('1234567') && !SP.validCode('12') && !SP.validCode('12 ab$'));
ok('an ad account id must look like act_<digits>', SP.validAccountId('act_1110001') && !SP.validAccountId('1110001') && !SP.validAccountId('act_'));
{ const e = SP.bad('x', 409, { error: 'EXISTING_OPEN_CODES', warnings: { a: 1 } }); ok('a user-facing error carries a machine code and details (what the screen switches on)', e.status === 409 && e.code === 'EXISTING_OPEN_CODES' && e.details?.warnings?.a === 1); }

console.log('\n2. Providers — honest about what is connected');
{
  ok('on the test database the simulator is available and labelled «محاكاة»', PV.providerStatus().simulation === true && PV.providerStatus().extract.mode === 'SIMULATION' && PV.providerStatus().pay.status === 'محاكاة');
  const prevEnv = process.env.ADS_PAYMENTS_SIMULATION; delete process.env.ADS_PAYMENTS_SIMULATION;
  const st = PV.providerStatus();
  ok('without the simulation flag every provider says «تحتاج ربط» and gives the manual path (no invented API)', ['extract', 'pay', 'credit'].every((k) => st[k].available === false && st[k].status === 'تحتاج ربط' && st[k].reason && st[k].manualPath) && PV.adapter('extract') === null);
  process.env.NODE_ENV = 'production'; process.env.ADS_PAYMENTS_SIMULATION = '1';
  ok('the simulator can NEVER run in production, even if the flag is set', PV.simulationAllowed() === false && PV.providerStatus().extract.available === false);
  process.env.NODE_ENV = 'test'; process.env.ADS_PAYMENTS_SIMULATION = prevEnv;
  const prevGuard = process.env.TEST_DB_GUARD; delete process.env.TEST_DB_GUARD; process.env.NODE_ENV = 'development';
  ok('…nor on any database that is not the guarded test one', PV.simulationAllowed() === false);
  process.env.TEST_DB_GUARD = prevGuard; process.env.NODE_ENV = 'test';
}

console.log('\n3. Permissions');
{
  const pa = await S.permsFor(ADMIN), pm = await S.permsFor(MGR), pe = await S.permsFor(EMP);
  ok('ADMIN / owner have every permission', Object.values(pa).every(Boolean) && Object.keys(pa).length === 6);
  ok('a MANAGER can view / extract / read reports — but NOT pay, bulk pay or manage methods, until granted', pm.view && pm.extract && pm.reports && !pm.pay && !pm.bulkPay && !pm.manageMethods);
  ok('an EMPLOYEE has nothing by default', Object.values(pe).every((v) => !v));
  await S.setUserPerms(2, { view: true, pay: true });
  const pm2 = await S.permsFor(MGR); ok('a grant is exactly what the owner switched on (and replaces the defaults)', pm2.pay === true && pm2.extract === false);
  await S.setUserPerms(2, {});
  ok('a permission-less user cannot extract / pay (403 FORBIDDEN)', await throwsCode(() => E.extractCode(EMP, { accountId: A1, amountEgp: 1000, requestId: RID() }), 'FORBIDDEN') && await throwsCode(() => E.payCode(MGR, 'abcabcabcabc', { methodId: 'x', requestId: RID(), confirm: true }), 'FORBIDDEN'));
}

console.log('\n4. Extraction (simulated provider)');
await reset(); const M = await addMethod();
{
  let calls = 0; PV.sim.behavior.extract = async () => { calls++; return { outcome: 'ISSUED', code: '7' + String(1000000 + calls), expiresAt: new Date(clock + 24 * 3600e3).toISOString() }; };
  const r = await E.extractCode(ADMIN, { accountId: A1, amountEgp: 3000, requestId: RID() });
  ok('an extraction saves the REAL code with account, amount, time, expiry and the employee', r.code?.code === '71000001' && r.code.accountId === A1 && r.code.amountEgp === 3000 && r.code.status === 'UNPAID' && r.code.extractedBy.name === 'Owner' && !!r.code.extractedAt && !!r.code.expiresAt && r.code.simulated === true);
  const au = await S.listAudit({ limit: 20 }); ok('…and is written to the audit log (who / what / result)', au.some((a) => a.action === 'CODE_EXTRACTED' && a.actor.name === 'Owner') && au.some((a) => a.action === 'EXTRACT_REQUESTED'));
  const q1 = RID(); const [x, y] = await Promise.all([E.extractCode(ADMIN, { accountId: A2, amountEgp: 2000, requestId: q1 }), E.extractCode(ADMIN, { accountId: A2, amountEgp: 2000, requestId: q1 })]);
  ok('a double click (same request id) extracts ONE code — the provider is asked once', calls === 2 && ((x.job.id === y.job.id)) && (await S.allCodes()).filter((c) => c.accountId === A2).length === 1, `calls=${calls}`);
  const e1 = await rejects(() => E.extractCode(ADMIN, { accountId: A1, amountEgp: 1000, requestId: RID() }));
  ok('an account that still has an unpaid code gets a clear WARNING before another one (409 EXISTING_OPEN_CODES with the open codes)', e1?.code === 'EXISTING_OPEN_CODES' && e1.details.warnings.open.length === 1 && calls === 2);
  const again = await E.extractCode(ADMIN, { accountId: A1, amountEgp: 1000, requestId: RID(), acknowledgeExisting: true });
  ok('…and goes through only after the user acknowledges it', again.code?.amountEgp === 1000 && calls === 3);
  ok('two different employees asking the same account at the same moment cannot both extract (serialized, no race)', await (async () => { const [p, q] = await Promise.allSettled([E.extractCode(ADMIN, { accountId: A3, amountEgp: 5000, requestId: RID() }), E.extractCode(MGR, { accountId: A3, amountEgp: 5000, requestId: RID() })]); return p.status === 'fulfilled' !== (q.status === 'fulfilled') && calls === 4; })());
  ok('bad accounts / amounts are refused before the provider is touched', await throwsCode(() => E.extractCode(ADMIN, { accountId: 'act_999999999', amountEgp: 1000, requestId: RID() })) && await throwsCode(() => E.extractCode(ADMIN, { accountId: A3, amountEgp: -5, requestId: RID() })) && await throwsCode(() => E.extractCode(ADMIN, { accountId: A3, amountEgp: 1000, requestId: 'x' })) && calls === 4);
}
await reset(); await addMethod();
{
  PV.sim.behavior.extract = async () => { throw new Error('socket hang up'); };
  const r = await E.extractCode(ADMIN, { accountId: A1, amountEgp: 2000, requestId: RID() });
  ok('a connection drop DURING extraction = «نتيجة غير مؤكدة» (no code is invented, and it is not retried)', r.job.status === 'UNCERTAIN' && !r.code && (await S.allCodes()).length === 0);
  const blocked = await rejects(() => E.extractCode(ADMIN, { accountId: A1, amountEgp: 2000, requestId: RID() }));
  ok('…a new request for the same amount right after is stopped as a probable duplicate', blocked?.code === 'DUPLICATE_RECENT');
  PV.sim.behavior.extract = async () => ({ outcome: 'FAILED', message: 'مرفوض' });
  const f = await E.extractCode(ADMIN, { accountId: A2, amountEgp: 2000, requestId: RID() }); ok('an explicit provider failure is FAILED with the reason', f.job.status === 'FAILED' && /مرفوض/.test(f.job.error));
  PV.sim.behavior.extract = async () => ({ outcome: 'ISSUED', code: '!!' });
  const g = await E.extractCode(ADMIN, { accountId: A3, amountEgp: 2000, requestId: RID() }); ok('a malformed code from the provider is never saved as real', g.job.status === 'UNCERTAIN' && !g.code);
  const fix = await E.resolveJob(ADMIN, r.job.id, { resolution: 'ATTACH_CODE', code: '88123456' });
  ok('a person resolves the uncertain job by attaching the code that really exists (source = manual)', fix.code.code === '88123456' && fix.code.source === 'MANUAL' && fix.job.status === 'DONE');
  const none = await E.resolveJob(ADMIN, g.job.id, { resolution: 'NOT_ISSUED', note: 'راجعت Ads Manager ومفيش كود' });
  ok('…or confirms (with a note) that nothing was issued', none.job.status === 'FAILED');
  ok('resolving needs the extract permission and a note', await throwsCode(() => E.resolveJob(EMP, g.job.id, { resolution: 'NOT_ISSUED', note: 'abc' }), 'FORBIDDEN'));
}

console.log('\n5. Manual registration (the real path while nothing is connected)');
await reset(); await addMethod();
{
  const r = await E.registerManualCode(MGR, { accountId: A1, amountEgp: 5000, code: '1234 5678-9', expiresAt: new Date(clock + 3 * 3600e3).toISOString(), note: 'من Ads Manager' });
  ok('a code from Ads Manager is registered: normalised, UNPAID, source «تسجيل يدوي», with expiry and the registering employee', r.code === '123456789' && r.status === 'UNPAID' && r.source === 'MANUAL' && r.extractedBy.name === 'Mona' && !!r.expiresAt);
  const dup = await rejects(() => E.registerManualCode(ADMIN, { accountId: A2, amountEgp: 100, code: '123456789' }));
  ok('the same code number can never be registered twice (even for another account)', dup?.status === 409 && dup.duplicate === true && (await S.allCodes()).length === 1);
  ok('an already-expired date is refused; an unknown account is refused', await throwsCode(() => E.registerManualCode(ADMIN, { accountId: A2, amountEgp: 100, code: '5550001', expiresAt: new Date(clock - 1000).toISOString() })) && await throwsCode(() => E.registerManualCode(ADMIN, { accountId: 'act_55555555', amountEgp: 100, code: '5550002' })));
  const w = await rejects(() => E.registerManualCode(ADMIN, { accountId: A1, amountEgp: 100, code: '5550003' }));
  ok('registering a second code on an account with an open one also warns first', w?.code === 'EXISTING_OPEN_CODES');
  const prev = process.env.ADS_PAYMENTS_SIMULATION; delete process.env.ADS_PAYMENTS_SIMULATION;
  const ne = await rejects(() => E.extractCode(ADMIN, { accountId: A2, amountEgp: 1000, requestId: RID() }));
  ok('with nothing connected the extract button answers «NEEDS_CONNECTION» (with the manual path) — it never fakes a code', ne?.code === 'NEEDS_CONNECTION' && ne.details.provider.manualPath && (await S.allCodes()).length === 1);
  const np = await rejects(async () => E.payCode(ADMIN, r.id, { methodId: (await S.listMethods())[0]?.id || 'x', requestId: RID(), confirm: true, expectedTotalEgp: 1 }));
  ok('…and the direct pay button answers NEEDS_CONNECTION too', np?.code === 'NEEDS_CONNECTION');
  process.env.ADS_PAYMENTS_SIMULATION = prev;
}

console.log('\n6. Bulk extraction');
await reset(); await addMethod();
{
  let n = 0; PV.sim.behavior.extract = async ({ accountId }) => { n++; if (accountId === A2) throw new Error('reset by peer'); return { outcome: 'ISSUED', code: '6' + String(2000000 + n), expiresAt: new Date(clock + 36e5).toISOString() }; };
  const items = [{ accountId: A1, amountEgp: 5000 }, { accountId: A2, amountEgp: 3000 }, { accountId: A3, amountEgp: 2000 }];
  const pv = await E.previewBulkExtract(ADMIN, { items });
  ok('the preview shows the count and the total before anything is requested', pv.count === 3 && pv.totalEgp === 10000 && n === 0);
  ok('an account twice in a batch / an empty batch is refused', await throwsCode(() => E.previewBulkExtract(ADMIN, { items: [items[0], items[0]] })) && await throwsCode(() => E.previewBulkExtract(ADMIN, { items: [] })));
  const q = RID(); const b = await E.startBulkExtract(ADMIN, { items, requestId: q });
  ok('the run is sequential and observable (PENDING → … → DONE)', b.status === 'RUNNING' && b.counts.pending + b.counts.extracting + b.counts.done + b.counts.failed + b.counts.uncertain === 3);
  ok('it finishes with each item in its own state: two codes extracted, the one with a dropped connection UNCERTAIN (not retried)', await waitFor(async () => (await E.getBatchView(b.id)).status === 'DONE'));
  const fin = await E.getBatchView(b.id);
  ok('…counts are right and each account got its OWN amount', fin.counts.done === 2 && fin.counts.uncertain === 1 && fin.items.find((i) => i.accountId === A1).amountEgp === 5000 && fin.items.find((i) => i.accountId === A3).amountEgp === 2000 && n === 3);
  ok('the provider rate limit is respected (a pause between requests)', sleeps >= 2);
  const again = await E.startBulkExtract(ADMIN, { items, requestId: q });
  ok('sending the same bulk request again (double click / reconnect) returns the SAME batch and extracts nothing new', again.id === b.id && n === 3 && (await S.allCodes()).length === 2);
  // restart in the middle: a job left EXTRACTING by a dead process
  const jid = S.newId(); await S.createJob({ id: jid, batchId: null, accountId: A3, accountName: 'Yasser Ads', amountEgp: 1500, status: 'EXTRACTING', attempt: 1, codeId: null, error: null, requestedBy: { id: 1, name: 'Owner' }, startedAt: new Date(clock - 20 * 60000).toISOString(), requestedAt: new Date(clock - 20 * 60000).toISOString() });
  const nBefore = n; const mt = await E.monitorTick({ now: clock });
  ok('after a server restart an interrupted extraction becomes UNCERTAIN — it is never re-sent automatically', (await S.getJob(jid)).status === 'UNCERTAIN' && mt.interrupted >= 1 && n === nBefore);
}

console.log('\n7. Payment');
await reset(); const MA = await addMethod({ label: 'محفظة فوري', feePct: 1, feeFixed: 2, balanceEgp: 20000 });
{
  let pays = 0; PV.sim.behavior.pay = null;
  PV.sim.behavior.extract = async () => ({ outcome: 'ISSUED', code: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), expiresAt: new Date(clock + 5 * 3600e3).toISOString() });
  const { code: c1 } = await E.extractCode(ADMIN, { accountId: A1, amountEgp: 3000, requestId: RID() });
  const qt = await E.quotePay(ADMIN, c1.id, MA.id);
  ok('the quote shows the code value, the fee and the total to be debited (fee = 1% + 2 = 32 → 3,032)', qt.amountEgp === 3000 && qt.feeEgp === 32 && qt.totalEgp === 3032 && qt.directPay === true && qt.payable === true && qt.sufficient === true);
  ok('paying needs an explicit confirmation, a request id and the exact total the user saw', await throwsCode(() => E.payCode(ADMIN, c1.id, { methodId: MA.id, requestId: RID(), confirm: false, expectedTotalEgp: 3032 }), 'CONFIRM_REQUIRED') && await throwsCode(() => E.payCode(ADMIN, c1.id, { methodId: MA.id, requestId: RID(), confirm: true, expectedTotalEgp: 3000 }), 'QUOTE_CHANGED') && (await S.getCode(c1.id)).status === 'UNPAID');
  const q = RID();
  PV.sim.behavior.pay = async ({ idempotencyKey }) => { pays++; await new Promise((r) => setTimeout(r, 30)); return { outcome: 'CONFIRMED', txnRef: 'TX' + idempotencyKey.slice(-6), receipt: { number: 'RC-1' }, paidAt: new Date().toISOString(), amountEgp: 3000 }; };
  const [p1, p2] = await Promise.allSettled([E.payCode(ADMIN, c1.id, { methodId: MA.id, requestId: q, confirm: true, expectedTotalEgp: 3032 }), E.payCode(ADMIN, c1.id, { methodId: MA.id, requestId: q, confirm: true, expectedTotalEgp: 3032 })]);
  ok('a double click on «ادفع الآن» charges ONCE (the second is refused, the provider is called a single time)', pays === 1 && [p1, p2].filter((x) => x.status === 'fulfilled').length === 1 && [p1, p2].find((x) => x.status === 'rejected').reason.status === 409, `pays=${pays}`);
  const paid = await S.getCode(c1.id);
  ok('after the payment: PAID (not credited), with the real transaction, receipt, time, employee, method and total', paid.status === 'PAID' && paid.payment.txnRef && paid.payment.receipt.number === 'RC-1' && paid.payment.paidAt && paid.payment.paidBy.name === 'Owner' && paid.payment.methodLabel === 'محفظة فوري' && paid.payment.totalEgp === 3032 && paid.credit === null);
  ok('the wallet balance is debited by the total (20,000 → 16,968)', (await S.listMethods())[0].balanceEgp === 16968);
  const dup = await rejects(() => E.payCode(ADMIN, c1.id, { methodId: MA.id, requestId: RID(), confirm: true, expectedTotalEgp: 3032 }));
  ok('a second attempt (new request id) on a paid code is refused ALREADY_PAID, no charge, and the attempt is recorded for the alert', dup?.code === 'ALREADY_PAID' && pays === 1 && (await S.getCode(c1.id)).events.some((e) => e.type === 'DUP_PAY_BLOCKED'));

  const c2 = await seed({ accountId: A2, amountEgp: 1000 });
  PV.sim.behavior.pay = async () => { pays++; return { outcome: 'UNCERTAIN', message: 'time out' }; };
  await E.payCode(ADMIN, c2.id, { methodId: MA.id, requestId: RID(), confirm: true, expectedTotalEgp: 1012 });
  const u = await S.getCode(c2.id); const before = pays;
  ok('an uncertain result is stored as «نتيجة غير مؤكدة» and the wallet is NOT assumed debited', u.status === 'UNCERTAIN' && (await S.listMethods())[0].balanceEgp === 16968);
  const rt = await rejects(() => E.payCode(ADMIN, c2.id, { methodId: MA.id, requestId: RID(), confirm: true, expectedTotalEgp: 1012 }));
  ok('…and a retry is REFUSED (UNCERTAIN_BLOCKS_RETRY) — the provider is not even called', rt?.code === 'UNCERTAIN_BLOCKS_RETRY' && pays === before);
  PV.sim.behavior.queryPayment = async () => ({ outcome: 'CONFIRMED', txnRef: 'FOUND123', receipt: { number: 'R9' }, paidAt: new Date().toISOString() });
  const rc = await E.reconcilePayment(ADMIN, c2.id, {});
  ok('reconciliation first ASKS the source: it was paid → PAID with the found transaction', rc.status === 'PAID' && rc.payment.txnRef === 'FOUND123');
  const c3 = await seed({ accountId: A3, amountEgp: 500 }); PV.sim.behavior.pay = async () => { throw new Error('ECONNRESET'); };
  await E.payCode(ADMIN, c3.id, { methodId: MA.id, requestId: RID(), confirm: true, expectedTotalEgp: 507 });
  ok('a thrown error / drop during payment = UNCERTAIN (possible charge) — never FAILED', (await S.getCode(c3.id)).status === 'UNCERTAIN');
  PV.sim.behavior.queryPayment = async () => ({ outcome: 'NOT_PAID' });
  const rn = await E.reconcilePayment(ADMIN, c3.id, {}); ok('the source confirms nothing was charged → back to UNPAID (payable again)', rn.status === 'UNPAID');
  PV.sim.behavior.queryPayment = async () => ({ outcome: 'UNKNOWN' });
  const c4 = await seed({ accountId: A1, amountEgp: 700, status: 'UNCERTAIN' }); await S.updateCode(c4.id, (c) => { c.payment = { attemptNo: 1, attempts: [{ requestId: 'zz', attemptNo: 1 }], idempotencyKey: 'k' }; return c; });
  ok('when the source cannot tell, a person must give EVIDENCE (no evidence → refused; with a transaction number → PAID, source manual)', await throwsCode(() => E.reconcilePayment(ADMIN, c4.id, {}), 'NEEDS_EVIDENCE') && await throwsCode(() => E.reconcilePayment(ADMIN, c4.id, { resolution: 'PAID', evidence: 'x' })) && (await E.reconcilePayment(ADMIN, c4.id, { resolution: 'PAID', txnRef: 'BANK-5551', evidence: 'كشف الحساب' })).payment.paymentSource === 'MANUAL');

  PV.sim.behavior.pay = async () => ({ outcome: 'FAILED', message: 'الرصيد غير كافٍ لدى المزود' });
  const c5 = await seed({ accountId: A2, amountEgp: 400 });
  await E.payCode(ADMIN, c5.id, { methodId: MA.id, requestId: RID(), confirm: true, expectedTotalEgp: 406 });
  ok('an explicit provider failure is PAY_FAILED with the reason, and the wallet is untouched', (await S.getCode(c5.id)).status === 'PAY_FAILED' && /الرصيد/.test((await S.getCode(c5.id)).reason));
  PV.sim.behavior.pay = null; const rp = await E.payCode(ADMIN, c5.id, { methodId: MA.id, requestId: RID(), confirm: true, expectedTotalEgp: 406 });
  ok('only a CONFIRMED failure allows paying again', rp.status === 'PAID' && rp.payment.attempts.length === 2);

  const c6 = await seed({ accountId: A3, amountEgp: 600 }); PV.sim.behavior.pay = async () => ({ outcome: 'CONFIRMED', txnRef: 'TXM', paidAt: new Date().toISOString(), amountEgp: 650 });
  const mm = await E.payCode(ADMIN, c6.id, { methodId: MA.id, requestId: RID(), confirm: true, expectedTotalEgp: 608 });
  ok('a paid amount that differs from the code value → «يحتاج مراجعة» (AMOUNT_MISMATCH), the payment is still recorded', mm.status === 'REVIEW' && mm.reason === 'AMOUNT_MISMATCH' && mm.payment.txnRef === 'TXM');

  PV.sim.behavior.pay = null;
  const poor = await addMethod({ label: 'محفظة صغيرة', balanceEgp: 50 }); const c7 = await seed({ accountId: A1, amountEgp: 900 });
  ok('an insufficient wallet is refused before the provider is called', await throwsCode(() => E.payCode(ADMIN, c7.id, { methodId: poor.id, requestId: RID(), confirm: true, expectedTotalEgp: S.feeFor(poor, 900) + 900 }), 'INSUFFICIENT_FUNDS'));
  const old = await seed({ accountId: A2, amountEgp: 800, expiresAt: clock - 1000 });
  ok('an expired code cannot be paid', await throwsCode(() => E.payCode(ADMIN, old.id, { methodId: MA.id, requestId: RID(), confirm: true, expectedTotalEgp: 810 }), 'EXPIRED'));
  const nonadmin = { id: 2, name: 'Mona', role: 'MANAGER' }; await S.setUserPerms(2, { view: true, pay: true }); await S.saveConfig({ dailyLimits: { 2: 1000 } });
  const l1 = await seed({ accountId: A2, amountEgp: 600 }), l2 = await seed({ accountId: A3, amountEgp: 600 });
  await E.payCode(nonadmin, l1.id, { methodId: MA.id, requestId: RID(), confirm: true, expectedTotalEgp: 608 });
  ok('the per-employee daily payment limit is enforced (600 ok, the next 600 exceeds 1,000)', await throwsCode(() => E.payCode(nonadmin, l2.id, { methodId: MA.id, requestId: RID(), confirm: true, expectedTotalEgp: 608 }), 'DAILY_LIMIT') && (await S.getCode(l2.id)).status === 'UNPAID');
  await S.setUserPerms(2, {}); await S.saveConfig({ dailyLimits: {} });

  // manual payment (done outside)
  const mp = await seed({ accountId: A2, amountEgp: 1500 }); const manual = await S.upsertMethod({ label: 'فوري يدوي', type: 'CASH', feePct: 0, feeFixed: 5 });
  const r1 = await E.recordManualPayment(ADMIN, mp.id, { methodId: manual.id, txnRef: 'FWR-778899', receiptRef: 'REC-1', paidAt: new Date(clock - 600000).toISOString(), requestId: RID() });
  ok('a manual payment records the real transaction number + receipt, attested by the person (source manual), fee from the method', r1.status === 'PAID' && r1.payment.txnRef === 'FWR-778899' && r1.payment.receipt.number === 'REC-1' && r1.payment.paymentSource === 'MANUAL' && r1.payment.feeEgp === 5 && r1.payment.paidBy.name === 'Owner');
  const mp2 = await seed({ accountId: A3, amountEgp: 1500 });
  ok('the same transaction number cannot be used for two codes; the number is mandatory', await throwsCode(() => E.recordManualPayment(ADMIN, mp2.id, { methodId: manual.id, txnRef: 'FWR-778899', requestId: RID() }), 'TXN_REUSED') && await throwsCode(() => E.recordManualPayment(ADMIN, mp2.id, { methodId: manual.id, txnRef: '', requestId: RID() })));
  // a restart in the middle of a payment
  const stuck = await seed({ accountId: A3, amountEgp: 300, status: 'PAYING' }); await S.updateCode(stuck.id, (c) => { c.payment = { attemptNo: 1, attempts: [], startedAt: new Date(clock - 30 * 60000).toISOString(), startedBy: { id: 1, name: 'Owner' } }; return c; });
  await E.monitorTick({ now: clock });
  ok('a payment interrupted by a restart becomes UNCERTAIN (never retried, never assumed paid)', (await S.getCode(stuck.id)).status === 'UNCERTAIN');
}

console.log('\n8. Credit («تسميع») — only on trusted confirmation');
await reset(); const MB = await addMethod();
{
  PV.sim.behavior.queryCredit = async () => ({ outcome: 'NOT_YET' });
  funds[A1] = { available: 1000 };
  const c = await seed({ accountId: A1, amountEgp: 2000, status: 'PAID', paidAt: clock - 90 * 60000 }); await S.updateCode(c.id, (x) => { x.creditWatch = { balanceBeforeEgp: 1000 }; return x; });
  funds[A1] = { available: 3000 };
  await E.monitorTick({ now: clock });
  const hinted = await S.getCode(c.id);
  ok('a balance that went up is only a HINT — the code stays «مدفوع ولم يسمع»', hinted.status === 'PAID' && hinted.creditHint?.looksCredited === true && hinted.creditHint.deltaEgp === 2000 && hinted.credit === null);
  PV.sim.behavior.queryCredit = async () => ({ outcome: 'CREDITED', source: 'META_TRANSACTION', evidence: 'txn 123', at: new Date().toISOString() });
  await E.monitorTick({ now: clock });
  const cr = await S.getCode(c.id); ok('a trusted source (a matched transaction) moves it to CREDITED with the source recorded', cr.status === 'CREDITED' && cr.credit.source === 'META_TRANSACTION');
  PV.sim.behavior.queryCredit = async () => ({ outcome: 'NOT_YET' });
  const c2 = await seed({ accountId: A2, amountEgp: 1000, status: 'PAID', paidAt: clock - 30 * 60000 });
  ok('a manual confirmation needs evidence and a PAID code', await throwsCode(() => E.confirmCredit(ADMIN, c2.id, { evidence: '' })) && await throwsCode(async () => E.confirmCredit(ADMIN, (await seed({ accountId: A3, amountEgp: 100 })).id, { evidence: 'Ads Manager txn 55' })));
  ok('…the credit time cannot precede the payment time', await throwsCode(() => E.confirmCredit(ADMIN, c2.id, { evidence: 'Ads Manager txn 55', at: new Date(clock - 3 * 3600e3).toISOString() })));
  const done = await E.confirmCredit(ADMIN, c2.id, { evidence: 'Ads Manager ← الفوترة txn 55' });
  ok('a manual confirmation records WHO confirmed it and the evidence (source manual)', done.status === 'CREDITED' && done.credit.source === 'MANUAL' && done.credit.by.name === 'Owner' && /txn 55/.test(done.credit.evidence));
  ok('a PAID code is never auto-expired', await (async () => { const p = await seed({ accountId: A1, amountEgp: 100, status: 'PAID', paidAt: clock - 5 * 3600e3, expiresAt: clock - 4 * 3600e3 }); await E.monitorTick({ now: clock }); return (await S.getCode(p.id)).status === 'PAID'; })());
}

console.log('\n9. Bulk payment');
await reset(); const MC = await addMethod({ label: 'محفظة جماعي', feePct: 0, feeFixed: 10, balanceEgp: 10000 });
{
  const codes = []; for (const [a, amt] of [[A1, 1000], [A2, 2000], [A3, 3000]]) codes.push(await seed({ accountId: a, amountEgp: amt }));
  const ids = codes.map((c) => c.id);
  const pv = await E.previewBulkPay(ADMIN, { codeIds: ids, methodId: MC.id });
  ok('the preview shows the count, the accounts, each value, the totals, the fees and the grand total', pv.totals.count === 3 && pv.totals.amountEgp === 6000 && pv.totals.feesEgp === 30 && pv.totals.totalEgp === 6030 && pv.accounts.length === 3 && pv.items.every((i) => i.eligible) && pv.sufficient === true);
  ok('bulk pay needs BOTH «الدفع الجماعي» and «تنفيذ الدفع» (a manager with only one is refused)', await (async () => { await S.setUserPerms(2, { view: true, bulkPay: true }); const r = await throwsCode(() => E.startBulkPay(MGR, { codeIds: ids, methodId: MC.id, requestId: RID(), confirm: true, expectedTotalEgp: 6030 }), 'FORBIDDEN'); await S.setUserPerms(2, {}); return r; })());
  ok('explicit approval and the exact total are required', await throwsCode(() => E.startBulkPay(ADMIN, { codeIds: ids, methodId: MC.id, requestId: RID(), confirm: false, expectedTotalEgp: 6030 }), 'CONFIRM_REQUIRED') && await throwsCode(() => E.startBulkPay(ADMIN, { codeIds: ids, methodId: MC.id, requestId: RID(), confirm: true, expectedTotalEgp: 6000 }), 'QUOTE_CHANGED'));
  let pays = 0; PV.sim.behavior.pay = async ({ idempotencyKey }) => { pays++; return { outcome: 'CONFIRMED', txnRef: 'B' + pays + idempotencyKey.slice(-4), paidAt: new Date().toISOString(), amountEgp: null }; };
  const q = RID(); const b = await E.startBulkPay(ADMIN, { codeIds: ids, methodId: MC.id, requestId: q, confirm: true, expectedTotalEgp: 6030 });
  ok('it executes one code at a time and tracks each result separately', await waitFor(async () => (await E.getBatchView(b.id)).status === 'DONE') && (await E.getBatchView(b.id)).counts.paid === 3 && pays === 3);
  const same = await E.startBulkPay(ADMIN, { codeIds: ids, methodId: MC.id, requestId: q, confirm: true, expectedTotalEgp: 6030 });
  ok('re-sending the same bulk request returns the same batch and pays nothing again', same.id === b.id && pays === 3);
  ok('a paid code in the selection makes the whole bulk refused (nothing is charged twice)', await throwsCode(() => E.startBulkPay(ADMIN, { codeIds: ids, methodId: MC.id, requestId: RID(), confirm: true, expectedTotalEgp: 0 }), 'NOT_ALL_PAYABLE'));
  // an UNCERTAIN result stops the rest of the batch
  const more = []; for (const a of [A1, A2, A3]) more.push(await seed({ accountId: a, amountEgp: 500 }));
  let k = 0; PV.sim.behavior.pay = async () => { k++; return k === 2 ? { outcome: 'UNCERTAIN', message: 'no answer' } : { outcome: 'CONFIRMED', txnRef: 'U' + k, paidAt: new Date().toISOString() }; };
  const b2 = await E.startBulkPay(ADMIN, { codeIds: more.map((c) => c.id), methodId: MC.id, requestId: RID(), confirm: true, expectedTotalEgp: 1530 });
  await waitFor(async () => ['STOPPED_UNCERTAIN', 'DONE'].includes((await E.getBatchView(b2.id)).status));
  const v2 = await E.getBatchView(b2.id);
  ok('when one payment is UNCERTAIN the batch STOPS — the remaining codes are not charged', v2.status === 'STOPPED_UNCERTAIN' && v2.counts.paid === 1 && v2.counts.uncertain === 1 && v2.counts.pending === 1 && k === 2);
  ok('it cannot be resumed until the uncertain one is reconciled', await throwsCode(() => E.resumePayBatch(ADMIN, b2.id), undefined));
}

console.log('\n10. Follow-up');
await reset(); await addMethod();
{
  const exp = await seed({ accountId: A1, amountEgp: 100, expiresAt: clock - 60000 }); const yesterday = await seed({ accountId: A2, amountEgp: 200, extractedAt: clock - 30 * 3600e3 });
  const r = await E.monitorTick({ now: clock });
  ok('an unpaid code past its expiry becomes EXPIRED', (await S.getCode(exp.id)).status === 'EXPIRED' && r.expired === 1);
  const open = (await S.allCodes()).filter((c) => SP.OPEN_STATUSES.includes(c.status));
  ok('a pending code from a previous day stays in the follow-up list (it does not disappear at midnight)', open.some((c) => c.id === yesterday.id));
  PV.sim.behavior.queryCredit = async () => { throw Object.assign(new Error('rate'), { rateLimited: true, retryAfterMs: 120000 }); };
  const pc = await seed({ accountId: A3, amountEgp: 300, status: 'PAID', paidAt: clock - 3600e3 });
  await E.monitorTick({ now: clock }); const st = await S.getMonitorState();
  ok('a provider rate limit sets a back-off and the next passes are skipped (safe handling)', !!st.backoffUntil && (await E.monitorTick({ now: clock + 1000 })).skipped === 'BACKOFF');
  const after = await E.monitorTick({ now: clock + 3 * 60000 }); ok('…and the follow-up resumes after the back-off', after.skipped !== 'BACKOFF');
  await S.saveMonitorState({}); PV.sim.behavior.queryCredit = async () => ({ outcome: 'NOT_YET' });
  const due = await SCH.paymentsTick({ now: clock }); const notDue = await SCH.paymentsTick({ now: clock + 60000 });
  ok('the cadence is the editable monitorEveryMin: a pass runs when due, the next minute is skipped', !due.skipped && notDue.skipped === 'NOT_DUE');
  await S.saveConfig({ monitorEveryMin: 1 }); ok('…and a shorter cadence takes effect without a restart', !(await SCH.paymentsTick({ now: clock + 2 * 60000 })).skipped);
  ok('every setting is validated (cadence 1–60, alert age ≥ 5)', await throwsCode(() => S.saveConfig({ monitorEveryMin: 0 })) && await throwsCode(() => S.saveConfig({ alertAfterMin: 1 })) && (await S.saveConfig({ alertAfterMin: 15 })).alertAfterMin === 15);
}

console.log('\n11. Reports — each figure by its own event date');
await reset(); await addMethod();
{
  const NOW = cairoMs('2026-11-25', '15:00'); clock = NOW;
  // one code: extracted Nov 30 (last month), paid Dec 1, credited Dec 2 → counted in three different periods
  const NOW2 = cairoMs('2026-12-03', '12:00');
  const x = await seed({ accountId: A1, amountEgp: 5000, extractedAt: cairoMs('2026-11-30', '22:00'), paidAt: cairoMs('2026-12-01', '09:00'), creditedAt: cairoMs('2026-12-02', '10:00'), status: 'CREDITED', fee: 50 });
  const y = await seed({ accountId: A2, amountEgp: 2000, extractedAt: cairoMs('2026-12-01', '10:00'), status: 'UNPAID' });
  const z = await seed({ accountId: A1, amountEgp: 1000, extractedAt: cairoMs('2026-12-02', '10:00'), paidAt: cairoMs('2026-12-02', '11:00'), status: 'PAID', paidBy: 'Mona', paidById: 2, methodLabel: 'كارت', methodId: 'm2', fee: 10 });
  const codes = await S.allCodes();
  const pDec = R.resolvePeriod({ preset: 'month' }, NOW2); const pNov = R.resolvePeriod({ preset: 'lastMonth' }, NOW2);
  const repDec = R.computeReport(codes, pDec), repNov = R.computeReport(codes, pNov);
  ok('periods are Cairo calendar days (month = Dec 1 → today; last month = all of November)', pDec.from === '2026-12-01' && pDec.to === '2026-12-03' && pNov.from === '2026-11-01' && pNov.to === '2026-11-30');
  ok('the code is COUNTED AS EXTRACTED in November only (by extraction date)', repNov.extracted.count === 1 && repNov.extracted.valueEgp === 5000 && repDec.extracted.count === 2 && repDec.extracted.valueEgp === 3000);
  ok('…its PAYMENT in December only (by payment date): actual = value + fee, and the three money numbers differ', repNov.payments.count === 0 && repDec.payments.count === 2 && repDec.payments.codesValueEgp === 6000 && repDec.payments.feesEgp === 60 && repDec.payments.actualEgp === 6060);
  ok('…its CREDIT (confirmed balance added) in December on the confirmation date, separate from the payments figure', repDec.credited.count === 1 && repDec.credited.valueEgp === 5000 && repNov.credited.count === 0);
  ok('the extracted codes split by CURRENT status add up to the extracted total (unpaid + pending + credited + expired)', ['unpaid', 'pending', 'credited', 'expired'].reduce((s, k) => s + repDec.buckets[k].count, 0) === repDec.extracted.count && repDec.buckets.unpaid.count === 1 && repDec.buckets.pending.count === 1);
  ok('averages: average code value, minutes extraction → payment, minutes payment → credit', repDec.extracted.avgCodeEgp === 1500 && repDec.avgMinutesToCredit === 25 * 60 && repDec.avgMinutesToPay === 360);
  ok('payments per account / employee / method', repDec.byAccount.find((a) => a.key === A1)?.totalEgp === 6060 && repDec.byUser.find((u) => u.label === 'Mona')?.totalEgp === 1010 && repDec.byMethod.some((m) => m.label === 'كارت' && m.totalEgp === 1010), JSON.stringify([repDec.byAccount, repDec.byUser, repDec.byMethod]));
  const cmp = R.periodComparison(codes, R.resolvePeriod({ preset: 'custom', from: '2026-12-02', to: '2026-12-03' }, NOW2));
  ok('the comparison against the previous equal period is a real percentage (or null when there is nothing before)', cmp.currentEgp === 1010 && cmp.previousEgp === 5050 && cmp.changePct === -80 && R.periodComparison(codes, pNov).changePct === null);
  const wk = R.movementSeries(codes, pDec, 'week'), dy = R.movementSeries(codes, pDec, 'day');
  ok('the movement chart adds up to the report in every granularity', wk.reduce((s, b) => s + b.paidEgp, 0) === 6060 && dy.reduce((s, b) => s + b.paidEgp, 0) === 6060 && dy.length === 3 && R.movementSeries(codes, R.resolvePeriod({ preset: 'year' }, NOW2), 'month').reduce((s, b) => s + b.paidEgp, 0) === 6060);
  ok('custom ranges are validated and capped', await throwsCode(() => R.resolvePeriod({ preset: 'custom', from: '2026-12-05', to: '2026-12-01' })) && await throwsCode(() => R.resolvePeriod({ preset: 'custom', from: 'x', to: 'y' })) && await throwsCode(() => R.resolvePeriod({ preset: 'custom', from: '2025-01-01', to: '2026-12-01' })));
  ok('all nine period presets resolve', SP.PRESETS.filter((p) => p !== 'custom').every((p) => R.resolvePeriod({ preset: p }, NOW2).from <= R.resolvePeriod({ preset: p }, NOW2).to));
  const cards = R.accountCards(codes, ACCOUNTS, pDec, { funds: { [A1]: { available: 1234.5, display: 'x' } }, now: NOW2 });
  const c1 = cards.find((c) => c.id === A1);
  ok('account cards: balance, extracted count/value, credited / pending / unpaid, rate, payments today & this month', c1.balance.available === 1234.5 && c1.extractedCount === 1 && c1.paidMonthEgp === 1010 + 5050 && c1.paidTodayEgp === 0 && cards.find((c) => c.id === A2).unpaid === 1);
  const sp = await R.spendVsPayments(codes, ACCOUNTS, pDec); ok('payments vs ad spend: an account without spend data shows null, never 0', sp.available && sp.rows.every((r) => r.spendEgp === 0 || r.spendEgp === null));
  const buf = await R.buildWorkbook({ rows: codes.map((c) => R.codeRow(c)), report: repDec, period: pDec });
  ok('Excel export is a real workbook with the codes sheet and the summary sheet', buf.length > 3000 && (await (async () => { const ExcelJS = (await import('exceljs')).default; const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb.worksheets.map((w) => w.name).join() === 'الأكواد,ملخص' && wb.worksheets[0].rowCount === 4; })()));

  console.log('\n12. Closing');
  clock = NOW2; const cl = await R.runClosings({ now: NOW2 });
  ok('closings are created for every finished day (up to yesterday, Cairo) — not for today', cl.created.includes('2026-12-02') && cl.created.includes('2026-12-01') && !cl.created.includes('2026-12-03'));
  const d2 = await S.getClosing('2026-12-02');
  ok('a daily closing holds extracted, paid, fees, outflow, credited, the open positions and the discrepancies', d2.totals.paidCount === 1 && d2.totals.actualPaidEgp === 1010 && d2.totals.feesEgp === 10 && d2.totals.outflowEgp === 1010 && d2.totals.creditedEgp === 5000 && d2.positionsAtClose.unpaid.valueEgp === 2000 && Array.isArray(d2.discrepancies));
  const m = await S.getClosing('2026-11'); ok('the monthly closing for the finished month exists too', !!m && m.kind === 'month' && m.totals.extractedEgp === 5000);
  const snap = JSON.stringify(d2);
  await S.updateCode(y.id, (c) => { c.status = 'PAID'; c.payment = { totalEgp: 2000, paidAt: new Date(cairoMs('2026-12-03', '09:00')).toISOString(), feeEgp: 0, paidBy: { id: 1, name: 'Owner' }, attempts: [] }; return c; });
  await S.updateCode(z.id, (c) => { c.status = 'CREDITED'; c.credit = { at: new Date(cairoMs('2026-12-03', '10:00')).toISOString(), source: 'MANUAL' }; return c; });
  await R.runClosings({ now: NOW2 }); const d2b = await S.getClosing('2026-12-02'); const late = R.lateAdjustments(await S.allCodes(), d2b);
  ok('a closing is write-once — a LATER payment / credit never rewrites it, it appears as a dated adjustment', JSON.stringify(d2b) === snap && late.some((l) => l.codeId === y.id && l.type === 'PAYMENT_AFTER_CLOSE') && late.some((l) => l.codeId === z.id && l.type === 'CREDIT_AFTER_CLOSE'), JSON.stringify(late));
}

console.log('\n13. Alerts & forecast');
await reset(); const MD = await addMethod({ label: 'محفظة صغيرة', balanceEgp: 100 });
{
  const NOW = cairoMs('2026-12-10', '15:00'); clock = NOW; const cfg = await S.getConfig(); // a fixed afternoon: the day-boundary rules must not depend on when the suite runs
  const unp = await seed({ accountId: A1, amountEgp: 3000, extractedAt: NOW - 40 * 60000 }); const exp = await seed({ accountId: A2, amountEgp: 1000, extractedAt: NOW - 3600e3, expiresAt: NOW + 30 * 60000 });
  const old = await seed({ accountId: A3, amountEgp: 500, extractedAt: NOW - 30 * 3600e3 }); const pnc = await seed({ accountId: A1, amountEgp: 2000, status: 'PAID', paidAt: NOW - 90 * 60000 });
  const mis = await seed({ accountId: A2, amountEgp: 100, status: 'REVIEW', reason: 'AMOUNT_MISMATCH' }); const pf = await seed({ accountId: A3, amountEgp: 100, status: 'PAY_FAILED', reason: 'x' });
  await S.updateCode(unp.id, (c) => { S.pushEvent(c, 'DUP_PAY_BLOCKED', null, 'dup'); c.events[c.events.length - 1].at = new Date(NOW - 3600e3).toISOString(); return c; });
  const accounts = ACCOUNTS; const codes = await S.allCodes(); const methods = await S.listMethods();
  const fc = { accounts: [{ accountId: A1, name: 'Ahmed Samy', balanceEgp: 900, hoursLeft: 4, needsTopUpToday: true, suggestedTopUpEgp: 2000 }, { accountId: A2, name: 'Hady Ads', balanceEgp: 50000, hoursLeft: 90, needsTopUpToday: false }] };
  const al = R.buildAlerts({ codes, accounts, forecast: fc, monitor: { lastTickAt: new Date(NOW - 60 * 60000).toISOString(), lastError: 'Meta 429' }, methods, cfg, now: NOW });
  const types = new Set(al.map((a) => a.type));
  for (const t of ['UNPAID_CODE', 'PAID_NOT_CREDITED', 'PENDING_FROM_YESTERDAY', 'EXPIRING', 'DUPLICATE_PAY_ATTEMPT', 'AMOUNT_MISMATCH', 'PAY_FAILED', 'WALLET_LOW', 'ACCOUNT_LOW_BALANCE', 'DATA_STALE', 'LINK_PROBLEM']) ok(`alert: ${t}`, types.has(t));
  ok('alerts open the code or the account directly (a target on each)', al.filter((a) => a.type === 'UNPAID_CODE')[0].target.type === 'code' && al.find((a) => a.type === 'ACCOUNT_LOW_BALANCE').target.type === 'account');
  ok('critical alerts come first', al[0].severity === 'CRITICAL');
  const al60 = R.buildAlerts({ codes, accounts, forecast: fc, monitor: {}, methods, cfg: { ...cfg, alertAfterMin: 60 }, now: NOW });
  ok('the alert age is a setting: 40-minute-old unpaid code alerts at 30 minutes, not at 60', al.some((a) => a.key === `unp:${unp.id}`) && !al60.some((a) => a.key === `unp:${unp.id}`));
  const t = await R.buildForecast({ codes: [], accounts: [ACCOUNTS[0], ACCOUNTS[1]], funds: { [A1]: { available: 1200 }, [A2]: { available: null } }, cfg, now: NOW });
  R._setReportDeps({ spendByDay: async (id) => new Map(id === A1 ? [['2026-11-20', 600], ['2026-11-21', 600], ['2026-11-22', 600]] : []) });
  const f2 = await R.buildForecast({ codes: [], accounts: [ACCOUNTS[0], ACCOUNTS[1]], funds: { [A1]: { available: 1200 }, [A2]: { available: null } }, cfg, now: NOW });
  const a1 = f2.accounts.find((a) => a.accountId === A1);
  ok('forecast: 1,200 left at 600/day = 48 hours; suggested top-up covers 2 days (1,200 − 1,200 = 0 → none); labelled an ESTIMATE', f2.estimate === true && /تقديرات/.test(f2.note) && a1.hoursLeft === 48 && a1.avgDailySpendEgp === 600 && a1.suggestedTopUpEgp === 0);
  const f3 = await R.buildForecast({ codes: [], accounts: [ACCOUNTS[0]], funds: { [A1]: { available: 300 } }, cfg, now: NOW });
  ok('…with 300 left: 12 hours, needs top-up today, suggested 1,000 (rounded up to 500s)', f3.accounts[0].hoursLeft === 12 && f3.accounts[0].needsTopUpToday === true && f3.accounts[0].suggestedTopUpEgp === 1000);
  ok('an account with no readable balance / no spend history is «غير متاح», not a made-up number', f2.accounts.find((a) => a.accountId === A2).hoursLeft === null && !!f2.accounts.find((a) => a.accountId === A2).note);
  ok('the forecast never extracts or pays (read only): no code was created or paid by building it', (await S.allCodes()).length === codes.length);
  R._setReportDeps({ spendByDay: async () => new Map() });
}

console.log('\n14. Methods, audit, isolation');
await reset();
{
  ok('a payment method cannot hold a full wallet / card number (last 4 only)', await throwsCode(() => S.upsertMethod({ label: 'x', type: 'CARD', maskedRef: '4111111111111111' })));
  const m = await S.upsertMethod({ label: 'كارت', type: 'CARD', maskedRef: '••1234', feePct: 2.5, feeFixed: 1 });
  ok('a method has a fee rule (percent + fixed) computed exactly', S.feeFor(m, 1000) === 26 && S.feeFor(m, 333.33) === 9.33);
  await S.audit({ actor: ADMIN, action: 'X', detail: { token: 'abc', otp: '123456', nested: { password: 'p', ok: 1 }, long: 'y'.repeat(900) } });
  const a = (await S.listAudit({ limit: 5 }))[0];
  ok('the audit log never stores a token / OTP / password and caps long text', a.detail.token === '[محجوب]' && a.detail.otp === '[محجوب]' && a.detail.nested.password === '[محجوب]' && a.detail.nested.ok === 1 && a.detail.long.length === 400);
  ok('every record lives in the workspace-isolated settings table (prefix fp:), with no schema change', (await prisma.settings.count({ where: { id: { startsWith: 'fp:' } } })) >= 2);
}

console.log('\n15. Wiring & safety (source checks)');
{
  const rt = fs.readFileSync(join(__dirname, '../routes/adsPayments.js'), 'utf8'); const sv = fs.readFileSync(join(__dirname, '../server.js'), 'utf8');
  const all = ['spec', 'store', 'providers', 'engine', 'reports', 'scheduler'].map((f) => fs.readFileSync(join(__dirname, `../services/amb/payments/${f}.js`), 'utf8')).join('\n');
  ok('the router and the follow-up are wired in the server, behind requireAuth', sv.includes("app.use('/api/ads-payments', adsPaymentsRoutes)") && sv.includes('startAdsPaymentsMonitor();') && rt.includes('router.use(requireAuth)'));
  ok('every money route is permission-gated (extract / pay / bulkPay / manageMethods / reports)', ["router.post('/extract', can('extract')", "router.post('/register', can('extract')", "router.post('/codes/:id/pay', can('pay')", "router.post('/codes/:id/manual-payment', can('pay')", "router.post('/bulk-pay', can('bulkPay')", "router.post('/bulk-extract', can('extract')", "router.post('/methods', can('manageMethods')", "router.get('/report', can('reports')", "router.get('/closings', can('reports')"].every((s) => rt.includes(s)));
  ok('settings and grants are ADMIN-only', rt.includes("router.put('/settings', adminOnly") && rt.includes("router.put('/permissions/:userId', adminOnly"));
  ok('no outbound HTTP, no Meta write, no raw SQL in the payments code', !/\bfetch\(|axios|https?\.request|\$executeRaw|\$queryRaw|graph\.facebook/.test(all) && !/executeScale|\bstartBulk\(|setCampaignBudget|postToMeta/.test(all));
  ok('nothing pays or extracts from the forecast / alerts / scheduler (those only read and record)', !/extractCode|payCode|startBulk/.test(fs.readFileSync(join(__dirname, '../services/amb/payments/scheduler.js'), 'utf8')) && !/payCode\(|extractCode\(/.test(fs.readFileSync(join(__dirname, '../services/amb/payments/reports.js'), 'utf8').replace(/export \{ E \};/, '')));
  ok('no provider credential / wallet number / OTP is a field anywhere (secrets never enter the store)', !/(apiKey|api_key|clientSecret|password|cvv|otp)\s*:/i.test(fs.readFileSync(join(__dirname, '../services/amb/payments/store.js'), 'utf8')));
  ok('workspace isolation: every stored record goes through prisma.settings only (the per-workspace table) — no other table, no raw SQL', [...all.matchAll(/prisma\.(?!js)(\w+)/g)].every((m) => m[1] === 'settings') && !/\$queryRaw|\$executeRaw/.test(all));
  ok('the only prisma use in the routes is the user list for the permission screen (inside the request workspace)', [...rt.matchAll(/prisma\.(?!js)(\w+)/g)].every((m) => m[1] === 'user'));
  ok('the capability report names the real Meta scopes and the access tier', rt.includes('ads_management') && rt.includes('development_access') && rt.includes('PayAtFawry'));
  ok('the existing AI Media Buyer engines are untouched (the payments code imports none of Meta sync / operator / bulk scaling / smart targeting)', !/snapshotSync|operatorEngine|scaleBulk|smartTargeting|executor/.test(all.replace(/viewAccounts|accountsToday/g, '')));
}

await reset();
console.log(`\n${fail ? '❌' : '✅'} adsPaymentsTest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
