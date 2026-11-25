// Sample SIMULATED data for the Ads Payment Center, written to the ISOLATED TEST database only (the guard refuses anything else).
// It exists so the screen can be reviewed on localhost. Every code is flagged simulated; nothing here ever reaches production, Meta or a real wallet.
//   node src/scripts/adsPaymentsDevSeed.js
import './_testGuard.js';
process.env.ADS_PAYMENTS_SIMULATION = '1';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
const { prisma } = await imp('../prisma.js');
const S = await imp('../services/amb/payments/store.js');
const SP = await imp('../services/amb/payments/spec.js');
const { saveAmbSettings } = await imp('../services/amb/settings.js');

await prisma.settings.deleteMany({ where: { id: { startsWith: 'fp:' } } });
const ACCTS = [['act_1518142859790043', 'Ahmed Samy'], ['act_9990000000012', 'Hady Ads'], ['act_9990000000013', 'Yasser Ads'], ['act_9990000000014', 'Boda Ads']]; // the first one is the test database's connected (primary) account
await saveAmbSettings({ ambViewAccountIds: ACCTS.map((a) => a[0]) });
await S.saveConfig({ accountNames: Object.fromEntries(ACCTS) });
const m1 = await S.upsertMethod({ label: 'فوري', type: 'FAWRY_BALANCE', feePct: 1, feeFixed: 2, balanceEgp: 480000 });
const m2 = await S.upsertMethod({ label: 'محفظة موبايل', type: 'WALLET', maskedRef: '••4821', feePct: 0.5, feeFixed: 0, balanceEgp: 150000 });
const people = [{ id: 1, name: 'TEST OWNER' }, { id: 2, name: 'Mona' }, { id: 3, name: 'Karim' }];
const AMOUNTS = [1000, 2000, 3000, 5000, 5000, 10000, 3000, 2000];
const now = Date.now(); const day = 86400000;
let seq = 0; const code = () => String(7000000000 + (++seq) * 137911 + 13);
const mk = async ({ acct, amt, ago, minsToPay, minsToCredit, status, method = m1, by = people[0], hours = 24 }) => {
  const extractedAt = now - ago; const paidAt = minsToPay != null ? extractedAt + minsToPay * 60000 : null; const creditedAt = minsToCredit != null && paidAt ? paidAt + minsToCredit * 60000 : null;
  const fee = S.feeFor(method, amt);
  const c = { id: S.newId(), code: code(), accountId: acct[0], accountName: acct[1], amountEgp: amt, status, source: 'SIMULATED', simulated: true, extractedAt: new Date(extractedAt).toISOString(), extractedBy: by, expiresAt: new Date(extractedAt + hours * 3600e3).toISOString(), jobId: null, payment: null, credit: null, lastCheckedAt: null, reason: null,
    events: [{ at: new Date(extractedAt).toISOString(), type: 'EXTRACTED', by, note: 'استخراج محاكاة' }] };
  if (paidAt) { c.payment = { methodId: method.id, methodLabel: method.label, methodType: method.type, feeEgp: fee, totalEgp: SP.sumEgp([amt, fee]), startedAt: new Date(paidAt).toISOString(), startedBy: by, paidAt: new Date(paidAt).toISOString(), paidBy: by, txnRef: 'SIM-' + (200000 + seq * 7), receipt: { number: 'SIM-R-' + (3000 + seq), note: 'إيصال محاكاة' }, paymentSource: 'SIMULATED', attempts: [{ requestId: 'seed' + seq, at: new Date(paidAt).toISOString(), by, attemptNo: 1, outcome: 'CONFIRMED' }], attemptNo: 1, confirmedAmountEgp: amt }; c.events.push({ at: c.payment.paidAt, type: 'PAID', by, note: method.label }); }
  if (creditedAt) { c.credit = { at: new Date(creditedAt).toISOString(), source: 'SIMULATED', evidence: 'تسميع محاكاة', by: null, amountEgp: amt }; c.events.push({ at: c.credit.at, type: 'CREDITED', by: null, note: 'تأكيد التسميع: SIMULATED' }); }
  await S.createCode(c); return c;
};
// the month so far: a steady flow of credited codes across the four accounts
let n = 0; const today0 = new Date(); today0.setHours(0, 0, 0, 0);
for (let d = 24; d >= 1; d--) {
  for (let k = 0; k < 2; k++) {
    const acct = ACCTS[(n + k) % 4]; const amt = AMOUNTS[(n * 3 + k) % AMOUNTS.length]; n++;
    const ago = now - (today0.getTime() - d * day + (9 + k * 4) * 3600e3);
    await mk({ acct, amt, ago, minsToPay: 12 + (n % 9) * 7, minsToCredit: 18 + (n % 5) * 11, status: 'CREDITED', method: n % 4 ? m1 : m2, by: people[n % 3] });
  }
}
// some older leftovers (they must stay in the follow-up list)
await mk({ acct: ACCTS[1], amt: 3000, ago: 2 * day + 5 * 3600e3, status: 'UNPAID', hours: 400 });
await mk({ acct: ACCTS[2], amt: 2000, ago: 3 * day, minsToPay: 40, status: 'PAID', method: m2 });
await mk({ acct: ACCTS[3], amt: 1000, ago: 6 * day, status: 'EXPIRED', hours: 24 });
// today
const at = (h) => Math.max(60000, now - (today0.getTime() + h * 3600e3)); // h hours after local midnight today
await mk({ acct: ACCTS[0], amt: 3000, ago: at(1.1), minsToPay: 5, minsToCredit: 3, status: 'CREDITED' });
await mk({ acct: ACCTS[1], amt: 3000, ago: at(1.4), minsToPay: 5, status: 'PAID', method: m2, by: people[1] });
await mk({ acct: ACCTS[2], amt: 3000, ago: at(1.8), status: 'UNPAID', hours: 40, by: people[2] });
await mk({ acct: ACCTS[3], amt: 3000, ago: at(2), minsToPay: 5, minsToCredit: 5, status: 'CREDITED', by: people[1] });
await mk({ acct: ACCTS[0], amt: 5000, ago: at(2.4), minsToPay: 3, minsToCredit: 4, status: 'CREDITED' });
await mk({ acct: ACCTS[1], amt: 5000, ago: at(2.9), status: 'UNPAID', hours: 40 });
const unc = await mk({ acct: ACCTS[3], amt: 1500, ago: at(0.6), status: 'UNCERTAIN' });
await S.updateCode(unc.id, (c) => { c.payment = { methodId: m1.id, methodLabel: m1.label, methodType: m1.type, feeEgp: 17, totalEgp: 1517, startedAt: new Date(now - 1500000).toISOString(), startedBy: people[0], attempts: [{ requestId: 'seedunc', attemptNo: 1, outcome: 'UNCERTAIN' }], attemptNo: 1, idempotencyKey: 'pay-seed-1' }; c.reason = 'نتيجة الدفع غير مؤكدة'; S.pushEvent(c, 'PAY_UNCERTAIN', people[0], c.reason); return c; });
console.log('seeded', (await S.allCodes()).length, 'simulated codes on the TEST database; methods:', m1.label, '/', m2.label);
await prisma.$disconnect();
process.exit(0);
