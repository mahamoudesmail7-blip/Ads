// 🧪 «الفتح حسب CPA» — owner's 2026-10-14 asks: (1) the lower limit may be 0 («من 0 لحد 150»); (2) the unattended opening says honestly what blocks it; (3) «إيه اللي اتفتح»: a report of the OPEN plans that really ran
//   (automatic vs approved by hand, the result Meta confirmed, the skip reason) + its CSV. Pure functions + disposable plan fixtures dated 2032-01-xx on the ISOLATED test database. No Meta call, nothing is opened.
//   node src/scripts/openCpaAutoReportTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url)); const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0; const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const OC = await imp('../services/amb/openCpaPolicy.js'); const D = await imp('../services/amb/dailyPlans.js'); const R = await imp('../services/amb/openCpaReport.js'); const { prisma } = await imp('../prisma.js');

console.log('\n1. The lower limit may be 0 — the upper limit may not');
const base = OC.normalizeOpenCpa({ minCpa: 0, maxCpa: 150, window: '7', minPurchases: 5 });
ok('min 0 / max 150 is a valid policy (even when a complete range is required)', OC.validateOpenCpa(base, { requireRange: true }).length === 0, JSON.stringify(OC.validateOpenCpa(base, { requireRange: true })));
ok('min 0 is kept as the number 0 (not turned into "empty")', base.minCpa === 0 && OC.normalizeOpenCpa({ minCpa: '0', maxCpa: '150' }).minCpa === 0);
ok('max 0 is still refused (must be above zero)', OC.validateOpenCpa(OC.normalizeOpenCpa({ minCpa: 0, maxCpa: 0 }), { requireRange: true }).length > 0);
ok('a negative minimum is refused', OC.validateOpenCpa(OC.normalizeOpenCpa({ minCpa: -5, maxCpa: 150 }), { requireRange: true }).length > 0);
ok('min above max is still refused', OC.validateOpenCpa(OC.normalizeOpenCpa({ minCpa: 200, maxCpa: 150 }), { requireRange: true }).length > 0);
ok('an empty minimum is still «no range» when a complete range is required', OC.validateOpenCpa(OC.normalizeOpenCpa({ minCpa: '', maxCpa: 150 }), { requireRange: true }).length > 0);
const ev = (cpa, purchases = 8) => OC.evaluateCampaign({ policy: base, item: { eligibility: 'ELIGIBLE', selectable: true, campaignId: 'c', evidence: {} }, metrics: { spend: cpa * purchases, purchases }, dataAgeMin: 1 });
ok('with 0–150: CPA 20 → ELIGIBLE, CPA 150 → ELIGIBLE, CPA 151 → above the maximum, no orders → unknown (never 0)', ev(20).verdict === 'ELIGIBLE' && ev(150).verdict === 'ELIGIBLE' && ev(151).codes.includes('CPA_ABOVE_MAX') && OC.evaluateCampaign({ policy: base, item: { eligibility: 'ELIGIBLE', selectable: true, campaignId: 'c', evidence: {} }, metrics: { spend: 300, purchases: 0 }, dataAgeMin: 1 }).verdict === 'UNKNOWN_CPA');
ok('a campaign below the minimum orders is still excluded even with min 0', ev(60, 3).codes.includes('SAMPLE_TOO_SMALL') && !ev(60, 3).eligible);

console.log('\n2. What blocks the unattended opening (one list for the runner and for the status)');
const pol = (o = {}) => ({ enabled: true, version: 3, approved: { version: 3 }, ...o }); const cfg = (o = {}) => ({ mode: 'AUTOPILOT', emergency_stop: false, writesLocked: false, execPermissions: { open: true }, ...o }); const dcfg = (o = {}) => ({ halted: false, scheduledExecution: { enabled: true }, ...o });
ok('everything clear → no blockers', D.openCpaAutomaticBlockers({ cfg: cfg(), dcfg: dcfg(), pol: pol() }).length === 0);
ok('scheduled execution OFF is reported (this is the real state in production today)', D.openCpaAutomaticBlockers({ cfg: cfg(), dcfg: dcfg({ scheduledExecution: { enabled: false } }), pol: pol() }).join() === 'SCHEDULED_EXECUTION_OFF');
ok('mode, emergency, lock, permission, halt and an un-approved policy version are each reported', D.openCpaAutomaticBlockers({ cfg: cfg({ mode: 'APPROVAL', emergency_stop: true, writesLocked: true, execPermissions: { open: false } }), dcfg: dcfg({ halted: true }), pol: pol({ version: 4 }) }).sort().join() === ['EMERGENCY_STOP', 'META_WRITES_LOCKED', 'MODE_NOT_AUTOMATIC', 'OPEN_PERMISSION_OFF', 'POLICY_NOT_APPROVED_AT_CURRENT_VERSION', 'QUEUE_HALTED'].sort().join());
ok('every blocker has an Arabic label', ['MODE_NOT_AUTOMATIC', 'EMERGENCY_STOP', 'META_WRITES_LOCKED', 'OPEN_PERMISSION_OFF', 'SCHEDULED_EXECUTION_OFF', 'QUEUE_HALTED', 'POLICY_NOT_APPROVED_AT_CURRENT_VERSION'].every((k) => D.AUTOMATIC_BLOCKER_AR[k]));
const st = await D.getOpenCpaAutomaticStatus({ deps: { config: async () => cfg(), dcfg: async () => dcfg({ scheduledExecution: { enabled: false } }) } });
ok('the read-only status lists the blocker with its label, says it cannot run unattended, and names the products (none cleared on an empty database)', st.canRunUnattended === false && st.blockers[0]?.code === 'SCHEDULED_EXECUTION_OFF' && /مقفول/.test(st.blockers[0].label) && Array.isArray(st.products) && st.unattendedProducts === 0 && /AUTOMATIC/.test(st.note), JSON.stringify(st).slice(0, 300));

console.log('\n3. «إيه اللي اتفتح» — the report of the plans that really ran');
const mk = async (key, date, status, approval, sim, items) => prisma.ambDailyPlan.create({ data: { plan_key: key, type: 'OPEN', plan_date: date, scheduled_at: new Date(`${date}T21:00:00Z`), expires_at: new Date(`${date}T23:59:00Z`), status, simulated: sim, approval_mode: approval, execution_mode: sim ? 'SIMULATION' : 'LIVE', approved_at: new Date(`${date}T22:05:00Z`), finished_at: new Date(`${date}T22:06:00Z`), evidence_json: JSON.stringify({ openCpa: { version: 2, window: '7' } }),
  items: { create: items.map((i, n) => ({ campaign_id: i.id, campaign_name: i.name, product_id: i.pid ?? null, product_name: i.product ?? null, store_id: 'trendy-storeee', rank: n + 1, selected: !!i.sel, status: i.status, status_reason: i.reason || null, status_at: new Date(`${date}T22:05:30Z`), evidence_json: JSON.stringify({ budget: i.budget ?? null, cpaPolicy: { cpa: i.cpa ?? null, purchases: i.orders ?? null, window: '7', version: 2 }, m7: { spend: (i.cpa || 0) * (i.orders || 0), purchases: i.orders ?? 0, cpa: i.cpa ?? null }, m30: { spend: 3000, purchases: 20 } }) })) } } });
const made = [];
try {
  made.push(await mk('OPEN|2032-01-10|FXR', '2032-01-10', 'COMPLETED', 'AUTOPILOT', false, [{ id: 'fxr_a', name: 'Alpha _ scale', product: 'منتج ألفا', pid: 901, status: 'VERIFIED', cpa: 90, orders: 12, budget: 300, sel: true }, { id: 'fxr_b', name: '=HYPERLINK("x")', product: 'منتج بيتا', pid: 902, status: 'SKIPPED', reason: 'ALREADY_ACTIVE', cpa: 100, orders: 9, budget: 200, sel: true }, { id: 'fxr_p', name: 'never attempted', status: 'PENDING', sel: false }]));
  made.push(await mk('OPEN|2032-01-11|FXR', '2032-01-11', 'COMPLETED', 'APPROVAL', false, [{ id: 'fxr_c', name: 'Gamma', product: 'منتج جاما', pid: 903, status: 'VERIFIED', cpa: 70, orders: 20, budget: 500, sel: true }, { id: 'fxr_d', name: 'Delta', product: 'منتج دلتا', pid: 904, status: 'FAILED', reason: 'META_ERROR', cpa: 80, orders: 7, budget: 250, sel: true }, { id: 'fxr_e', name: 'Eps', status: 'BLOCKED', reason: 'STOCK_BELOW_MIN', cpa: 60, orders: 6, budget: 150, sel: true }]));
  made.push(await mk('OPEN|2032-01-12|FXR', '2032-01-12', 'PREPARED', null, false, [{ id: 'fxr_f', name: 'waiting', status: 'PENDING', sel: true }]));
  made.push(await mk('SIM|OPEN|2032-01-12|FXR', '2032-01-12', 'COMPLETED', 'APPROVAL', true, [{ id: 'fxr_g', name: 'simulated', status: 'SIMULATED', cpa: 50, orders: 10, budget: 100, sel: true }]));
  const rep = await R.openCpaReport({ from: '2032-01-10', to: '2032-01-12', now: new Date('2032-01-13T10:00:00Z') });
  ok('only attempted items of plans that RAN appear (no PENDING item, no PREPARED plan, no simulated plan)', rep.rows.length === 5 && !rep.rows.some((r) => ['fxr_p', 'fxr_f', 'fxr_g'].includes(r.campaignId)), JSON.stringify(rep.rows.map((r) => r.campaignId)));
  ok('newest day first', rep.rows[0].date === '2032-01-11' && rep.rows[rep.rows.length - 1].date === '2032-01-10');
  ok('AUTOPILOT approval = «تلقائي», any other approval = «يدوي (بموافقتك)»', rep.rows.filter((r) => r.date === '2032-01-10').every((r) => r.by === 'AUTOMATIC' && r.byLabel === 'تلقائي') && rep.rows.filter((r) => r.date === '2032-01-11').every((r) => r.by === 'MANUAL'));
  ok('totals: 2 opened (one automatic, one manual), 1 already active, 1 failed, 1 blocked; opened daily budget = 300 + 500', rep.totals.opened === 2 && rep.totals.automatic === 1 && rep.totals.manual === 1 && rep.totals.alreadyActive === 1 && rep.totals.failed === 1 && rep.totals.blocked === 1 && rep.totals.openedDailyBudget === 800, JSON.stringify(rep.totals));
  const a = rep.rows.find((r) => r.campaignId === 'fxr_a'); ok('a row carries product, CPA / orders of the decision, 7d / 30d CPA, budget and the Arabic result', a.productName === 'منتج ألفا' && a.cpa === 90 && a.orders === 12 && a.cpa7 === 90 && a.cpa30 === 150 && a.budget === 300 && /اتفتحت/.test(a.result) && a.policyVersion === 2, JSON.stringify(a));
  ok('a skip carries its reason in Arabic (ALREADY_ACTIVE → كانت شغالة أصلًا) and a refusal its guard (STOCK_BELOW_MIN)', rep.rows.find((r) => r.campaignId === 'fxr_b').reason === 'كانت شغالة أصلًا' && /المخزون/.test(rep.rows.find((r) => r.campaignId === 'fxr_e').reason));
  const one = await R.openCpaReport({ from: '2032-01-10', to: '2032-01-10', now: new Date('2032-01-13T10:00:00Z') }); ok('the date range filters', one.rows.length === 2 && one.rows.every((r) => r.date === '2032-01-10'));
  const bad = async (f, t) => { try { await R.openCpaReport({ from: f, to: t, now: new Date('2032-01-13T10:00:00Z') }); return null; } catch (e) { return e.status; } };
  ok('bad dates are refused with 400: wrong format, start after end, more than 92 days', (await bad('10-01-2032', '2032-01-12')) === 400 && (await bad('2032-01-12', '2032-01-10')) === 400 && (await bad('2031-01-01', '2032-01-12')) === 400);
  const csv = await R.openCpaReportCsv({ from: '2032-01-10', to: '2032-01-12', now: new Date('2032-01-13T10:00:00Z') });
  ok('the CSV has a BOM (Excel), the Arabic header, one line per row, and the right file name', csv.csv.charCodeAt(0) === 0xFEFF && csv.csv.split('\r\n').length === 6 && /اتنفذت بواسطة/.test(csv.csv.split('\r\n')[0]) && csv.filename === 'open-by-cpa-2032-01-10_2032-01-12.csv' && csv.count === 5);
  ok('a campaign name that starts with = is neutralised so a spreadsheet cannot run it as a formula', csv.csv.includes(`"'=HYPERLINK(""x"")"`) && !csv.csv.includes(',"=HYPERLINK'), csv.csv.split('\r\n').find((l) => /HYPERLINK/.test(l)));
} finally {
  await prisma.ambDailyPlan.deleteMany({ where: { id: { in: made.map((p) => p.id) } } }).catch(() => {});
}
await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`); setTimeout(() => process.exit(fail ? 1 : 0), 50);
