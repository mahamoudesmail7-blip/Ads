// 🧮 BULK AUTOMATION — the one-table overview (READY / NEEDS_CONFIGURATION / BLOCKED), bulk drafts, the read-only preview and the GATED bulk activation.
//   Nothing is ever sent to Meta; nothing is assumed (a missing limit keeps a product NEEDS_CONFIGURATION); the activation needs the EXACT confirmed numbers. Isolated TEST database only.
//   node src/scripts/bulkActivationTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
const rej = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const { prisma } = await imp('../prisma.js'); const PP = await imp('../services/amb/productPolicy.js'); const BK = await imp('../services/amb/bulkActivation.js');
const rawBefore = (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }))?.limits_json ?? null;
const cfgBefore = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } });
const ADMIN = { id: 1, role: 'ADMIN', status: 'ACTIVE' }; const MGR = { id: 9999, role: 'MANAGER', status: 'ACTIVE' };
const used = []; for (let n = 1; n <= 6; n++) used.push(await prisma.product.create({ data: { product_name: `__optest_bk_${n}__`, store_id: 'trendy-storeee', selling_price: 100 }, select: { id: true, store_id: true } })); const ids = used.map((p) => p.id);
const [A, B, C, D, E, F] = used; const key = (p) => PP.policyKey(p.store_id, p.id);
const GLOBAL = { cpa: { scale: 130, reduce: 170, hardStop: 200 }, zeroOrder: { spend: 150, minAgeHours: 6 }, budget: { increasePct: 20, decreasePct: 20, minPurchases: 3, cooldownHours: 24, minBudget: 100, maxBudget: 600, dailySpendCap: 1500, maxChangesPerDay: 4 }, schedule: { openTime: '00:00', closeTime: '13:00' }, manualOverrideHours: 48 };
const good = (p, extra = {}) => ({ productId: p.id, storeId: p.store_id, name: `P${p.id}`, economicsComplete: true, stockKnown: true, stock: 40, campaignsMapped: 2, ...extra });
const rows = [good(A), good(B, { stockKnown: false, stock: null }), good(C, { economicsComplete: false }), good(D, { campaignsMapped: 0 }), good(E), good(F)];
const camp = (id, p, status = 'ACTIVE', st = 'VERIFIED') => ({ campaignId: id, campaignName: `camp ${id}`, campaignStatus: status, spend7d: 100, state: st, excluded: false, product: st === 'VERIFIED' ? { ambProductId: 1, name: `P${p.id}`, productId: p.id } : null, detectedProductKey: null });
const mapRows = [camp('a1', A), camp('a2', A, 'PAUSED'), camp('b1', B), camp('c1', C), camp('e1', E), camp('f1', F), camp('u1', A, 'ACTIVE', 'UNMAPPED'), camp('s1', A, 'ACTIVE', 'SUGGESTED')];
const win = (m) => new Map(Object.entries(m).map(([id, [spend, purchases]]) => [id, { spend, purchases }]));
const world = { adAccountId: 'act_x', windows: { last3: win({ a1: [300, 3], b1: [200, 2], c1: [100, 1] }), last7: win({ a1: [900, 9], a2: [0, 0], b1: [700, 5], c1: [500, 2], e1: [400, 4], f1: [600, 6] }), last30: win({ a1: [3000, 30], b1: [2000, 15], c1: [1500, 8], e1: [1200, 12], f1: [1800, 18] }) } };
const exposure = new Map([['a1', 300], ['b1', 200], ['c1', 100], ['e1', 400], ['f1', 300]]);
const PAUSE_OK = { enabled: true, version: 1, approved: { version: 1 } }; const OPEN = { enabled: true, version: 1, approved: { version: 1 }, minCpa: 20, maxCpa: 150, window: '7', minPurchases: 5, minStock: null };
const config = (cap = 5000) => ({ mode: 'APPROVAL', writesLocked: true, emergency_stop: false, execPermissions: { open: false, pause: false, budgetIncrease: false, budgetDecrease: false }, limits: { account: { maxDailySpendUnderAi: cap } } });
const D0 = (o = {}) => ({ user: ADMIN, rows, mapRows, world, exposure, pause: PAUSE_OK, open: OPEN, config: config(), exceptions: [{ types: ['NO_AUTOMATION'], scope_type: 'PRODUCT', scope_id: String(E.id) }], noReconcile: true, readiness: async () => ({ ready: true, missing: [] }), ...o });
const restore = async () => { await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: rawBefore } }); await prisma.ambOperatorProductConfig.deleteMany({ where: { product_id: { in: ids } } }); await prisma.ambOperatorEvent.deleteMany({ where: { kind: { in: ['GLOBAL_RULES_SAVED', 'GLOBAL_RULES_ACTIVATED', 'PRODUCT_POLICY_SAVED', 'PRODUCT_POLICY_ACTIVATED', 'BULK_ACTIVATION'] } } }); };
const actions0 = await prisma.ambAction.count();
try {
  await restore();
  console.log('\n1. Without any approved limits nothing is READY (no number is invented)');
  let ov = await BK.bulkOverview({ deps: D0() });
  ok('no global rules, no product limits → every product with campaigns is NEEDS_CONFIGURATION (spend limits + CPA limits missing), never READY', ov.products.filter((p) => p.state === 'READY').length === 0 && ov.products.find((p) => p.productId === A.id).missing.some((m) => m.key === 'SPEND_LIMITS') && ov.products.find((p) => p.productId === A.id).missing.some((m) => m.key === 'CPA_LIMITS'));

  console.log('\n2. With the approved global rules: READY / NEEDS_CONFIGURATION / BLOCKED');
  await PP.saveGlobalDraft({ policy: GLOBAL, userId: 1, deps: { user: ADMIN } }); await PP.activateGlobalRules({ confirm: true, userId: 1, deps: { user: ADMIN } });
  ov = await BK.bulkOverview({ deps: D0() }); const by = (p) => ov.products.find((x) => x.productId === p.id);
  ok('A (complete economics, stock known, mapped, pause policy approved) → READY on INHERITED limits', by(A).state === 'READY' && by(A).limits.hardStop === 200 && by(A).limits.dailyCap === 1500 && by(A).limits.maxChangesPerDay === 4);
  ok('B (stock UNKNOWN) → still READY: unknown stock is only a warning by the owner\'s decision', by(B).state === 'READY' && by(B).stockKnown === false);
  ok('C (economics incomplete) → NEEDS_CONFIGURATION, naming ECONOMICS', by(C).state === 'NEEDS_CONFIGURATION' && by(C).missing.some((m) => m.key === 'ECONOMICS'));
  ok('D (no verified campaign) → BLOCKED', by(D) === undefined || by(D).state === 'BLOCKED');
  ok('E (NO_AUTOMATION exception on the product) → BLOCKED with the reason', by(E).state === 'BLOCKED' && /NO_AUTOMATION/.test(by(E).blockedReason));
  ok('totals add up and the table is ordered READY → NEEDS_CONFIGURATION → BLOCKED', ov.totals.READY === 3 && ov.totals.NEEDS_CONFIGURATION === 1 && ov.totals.BLOCKED >= 1 && ov.products[0].state === 'READY' && ov.products[ov.products.length - 1].state === 'BLOCKED');
  ok('unconfirmed mappings (UNMAPPED / SUGGESTED) are EXCLUDED and listed with the reason; they never count as a product\'s campaign', ov.excluded.some((x) => x.campaignId === 'u1' && /مش مربوطة/.test(x.reason)) && ov.excluded.some((x) => x.campaignId === 's1' && /اقتراح/.test(x.reason)) && by(A).campaigns.ids.join() === 'a1,a2');
  ok('performance per product: 7-day orders + CPA 3/7/30 from its verified campaigns only', by(A).orders7 === 9 && by(A).cpa.d7 === 100 && by(A).cpa.d30 === 100 && by(A).runningBudget === 300);

  console.log('\n3. Preview is read-only and refuses to be approved without the exposure caps');
  let pv = await BK.bulkPreview({ deps: D0({ config: config(null) }) });
  ok('account daily exposure cap NOT set → ACCOUNT_CAP_MISSING blocks the approval', pv.canActivate === false && pv.blockers.some((b) => b.code === 'ACCOUNT_CAP_MISSING'));
  pv = await BK.bulkPreview({ deps: D0({ config: config(700) }) }); ok('running exposure above the account cap → ACCOUNT_CAP_EXCEEDED', pv.blockers.some((b) => b.code === 'ACCOUNT_CAP_EXCEEDED') && pv.exposure.running === 800);
  pv = await BK.bulkPreview({ deps: D0({ pause: { enabled: false, version: 0, approved: null } }) }); ok('pause policy not approved → every product drops to NEEDS_CONFIGURATION (nothing included)', pv.included.length === 0 && pv.blockers.some((b) => b.code === 'NO_READY_PRODUCT'));
  pv = await BK.bulkPreview({ deps: D0() }); ok('all caps set and fitting: the preview lists ONLY the READY products with their campaigns and the exposure; others are listed as not included with why', pv.canActivate === true && pv.included.length === 3 && pv.notIncluded.every((n) => n.state !== 'READY') && pv.confirm.products === 3 && pv.confirm.runningExposure === 800 && pv.exposure.headroom === 4200);
  const pvOne = await BK.bulkPreview({ productKeys: [key(A)], deps: D0() }); ok('a selection restricts the scope; the confirmation hash differs from the full scope', pvOne.included.length === 1 && pvOne.confirm.hash !== pv.confirm.hash);
  ok('the preview wrote nothing: no policy was activated and no Meta action exists', (await PP.getProductPolicy({ productId: A.id, storeId: A.store_id })).status === 'NONE' && (await prisma.ambAction.count()) === actions0);

  console.log('\n4. Bulk configuration = DRAFTS only; an empty field never overwrites');
  ok('a MANAGER cannot configure (403)', (await rej(() => BK.bulkConfigure({ productKeys: [key(A)], patch: { cpa: { scale: 100 } }, userId: 9999, deps: { user: MGR } })))?.status === 403);
  ok('an incoherent patch is refused (Scale ≥ Reduce)', (await rej(() => BK.bulkConfigure({ productKeys: [key(A)], patch: { cpa: { scale: 200, reduce: 100 } }, userId: 1, deps: { user: ADMIN } })))?.code === 'INVALID_POLICY');
  await PP.saveDraft({ productId: B.id, storeId: B.store_id, policy: { cpa: { scale: 90 } }, userId: 1, deps: { user: ADMIN } });
  const cf = await BK.bulkConfigure({ productKeys: [key(A), key(B)], patch: { budget: { decreasePct: 15 }, cpa: { scale: null } }, userId: 1, deps: { user: ADMIN } });
  const gb = await PP.getProductPolicy({ productId: B.id, storeId: B.store_id }); const ga = await PP.getProductPolicy({ productId: A.id, storeId: A.store_id });
  ok('both products got the decrease % as a DRAFT; B kept its own Scale 90 (the empty patch field did not overwrite); nothing is ACTIVE', cf.drafted.length === 2 && gb.status === 'DRAFT' && gb.draft.budget.decreasePct === 15 && gb.draft.cpa.scale === 90 && ga.draft.budget.decreasePct === 15 && ga.active === null);

  console.log('\n5. Bulk activation: exact confirmation, caps, readiness — and still no Meta write');
  pv = await BK.bulkPreview({ deps: D0() });
  ok('without confirmAutomatic → refused', (await rej(() => BK.bulkActivate({ confirm: pv.confirm, userId: 1, deps: D0() })))?.code === 'CONFIRM_AUTOMATIC_REQUIRED');
  ok('without the confirmed numbers → refused', (await rej(() => BK.bulkActivate({ confirmAutomatic: true, userId: 1, deps: D0() })))?.code === 'CONFIRM_REQUIRED');
  ok('numbers that differ from the current preview (exposure 700 instead of 800) → CONFIRM_MISMATCH', (await rej(() => BK.bulkActivate({ confirm: { ...pv.confirm, runningExposure: 700 }, confirmAutomatic: true, userId: 1, deps: D0() })))?.code === 'CONFIRM_MISMATCH');
  ok('a MANAGER cannot activate (403)', (await rej(() => BK.bulkActivate({ confirm: pv.confirm, confirmAutomatic: true, userId: 9999, deps: D0({ user: MGR }) })))?.status === 403);
  ok('caps missing → BULK_BLOCKED even with correct numbers', (await rej(() => BK.bulkActivate({ confirm: pv.confirm, confirmAutomatic: true, userId: 1, deps: D0({ config: config(null) }) })))?.code === 'BULK_BLOCKED');
  const res = await BK.bulkActivate({ confirm: pv.confirm, confirmAutomatic: true, userId: 1, deps: D0() });
  ok('exact confirmation → the 3 READY products are activated as AUTOMATIC', res.activated.length === 3 && [A, B, F].every((p) => res.activated.includes(key(p))) && res.skipped.length === 0, JSON.stringify(res));
  const st = async (p) => PP.getProductPolicy({ productId: p.id, storeId: p.store_id });
  ok('A, B, F are ACTIVE with mode AUTOMATIC (inheriting the global limits); C (NEEDS_CONFIGURATION), D (BLOCKED) and E (BLOCKED) were NOT touched', (await st(A)).active?.mode === 'AUTOMATIC' && (await st(B)).active?.mode === 'AUTOMATIC' && (await st(F)).active?.mode === 'AUTOMATIC' && (await st(C)).status === 'NONE' && (await st(D)).status === 'NONE' && (await st(E)).status === 'NONE');
  ok('B kept its own Scale 90 and A\'s effective decrease is 15 (draft values), while the hard stop 200 is inherited from the global rules', (await st(B)).effective.cpa.scale === 90 && (await st(A)).effective.budget.decreasePct === 15 && (await st(A)).effective.cpa.hardStop === 200);
  const after = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } });
  ok('activation changed NOTHING else: system mode, execution permissions, Emergency Stop and the write lock are exactly as before, and ZERO Meta actions exist', after.mode === cfgBefore.mode && after.emergency_stop === cfgBefore.emergency_stop && JSON.stringify(JSON.parse(after.limits_json || '{}').execPermissions) === JSON.stringify(JSON.parse(cfgBefore.limits_json || '{}').execPermissions) && (await prisma.ambAction.count()) === actions0);
  ok('the bulk activation is audited', (await prisma.ambOperatorEvent.count({ where: { kind: 'BULK_ACTIVATION' } })) === 1);
  const again = await BK.bulkActivate({ confirm: (await BK.bulkPreview({ deps: D0() })).confirm, confirmAutomatic: true, userId: 1, deps: D0() });
  ok('running it again is idempotent: the already-AUTOMATIC products are skipped, nothing is activated twice', again.activated.length === 0 && again.skipped.length === 3 && again.skipped.every((x) => /بالفعل/.test(x.why)), JSON.stringify(again));
} finally { try { await restore(); await prisma.product.deleteMany({ where: { id: { in: ids } } }); } catch (e) { console.log('cleanup failed', e.message); } }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
