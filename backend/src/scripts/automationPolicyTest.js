// 🧪 Pause policy (versioned + approved), AUTOMATIC readiness (a product with anything missing is refused) and the activation summary. No Meta call.   node src/scripts/automationPolicyTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 600) : ''}`); } };
const { prisma } = await imp('../prisma.js'); const PP = await imp('../services/amb/pausePolicy.js'); const AR = await imp('../services/amb/automationReadiness.js'); const PO = await imp('../services/amb/productPolicy.js');
const ADMIN = { id: 1, role: 'ADMIN', status: 'ACTIVE' }; const MGR = { id: 9, role: 'MANAGER', status: 'ACTIVE' };
const cfg0 = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const limits0 = cfg0.limits_json;
const rej = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const m = (spend, purchases) => ({ spend, purchases, cpa: purchases ? spend / purchases : null });
const pol = (o = {}) => PP.normalizePause({ enabled: true, version: 1, approved: { version: 1 }, highCpa: { enabled: true, above: 300, minPurchases: 3, minSpend: 300 }, ...o });
const d = (o = {}) => PP.decidePause({ policy: pol(), campaignId: 'c', productId: 7, storeId: 's', m3: m(900, 4), stock: { status: 'IN_STOCK' }, winner: false, weekday: 3, ...o });

try {
  console.log('\n1. decidePause (pure)');
  ok('nothing fires inside the limits', d({ m3: m(400, 5) }).trigger === null);
  ok('zero-order from the optimizer row → ZERO_ORDER', d({ optimizer: { action: 'PAUSE' }, m3: m(260, 0) }).trigger === 'ZERO_ORDER');
  ok('zero-order account default 150 (policy) applies when no optimizer row is given', d({ policy: pol({ zeroOrder: { enabled: true, spend: 150 } }), m3: m(160, 0) }).trigger === 'ZERO_ORDER' && d({ policy: pol({ zeroOrder: { enabled: true, spend: 150 } }), m3: m(140, 0) }).trigger === null);
  ok('HIGH_CPA needs the sample: 2 orders → nothing, 4 orders at CPA 375 → HIGH_CPA', d({ m3: m(900, 2) }).trigger === null && d({ m3: m(1500, 4) }).trigger === 'HIGH_CPA');
  ok('STOCK_OUT first', d({ stock: { status: 'OUT_OF_STOCK' }, optimizer: { action: 'PAUSE' }, m3: m(1500, 4) }).trigger === 'STOCK_OUT');
  ok('a disabled trigger never fires', d({ policy: pol({ highCpa: { enabled: false, above: 300 } }), m3: m(1500, 4) }).trigger === null && d({ policy: pol({ stockOut: { enabled: false } }), stock: { status: 'OUT_OF_STOCK' } }).trigger === null);
  const r = d({ m3: m(1500, 4), winner: true }); ok('PROTECTION_WINS: a winner is protected from HIGH_CPA and the skip is reported', r.trigger === null && r.skipped[0]?.code === 'WINNER_PROTECTED');
  ok('RULE_WINS: the same winner is paused', d({ policy: pol({ protections: { winnerProtection: true, precedence: 'RULE_WINS' } }), m3: m(1500, 4), winner: true }).trigger === 'HIGH_CPA');
  ok('winnerProtection OFF: nothing protects it', d({ policy: pol({ protections: { winnerProtection: false, precedence: 'PROTECTION_WINS' } }), m3: m(1500, 4), winner: true }).trigger === 'HIGH_CPA');
  { const hi = d({ m3: m(1500, 4), mToday: m(300, 3) }); ok('RECENT IMPROVEMENT: a high 3-day CPA does NOT pause when TODAY already recovered (3 orders at CPA 100 ≤ the limit) — the skip is reported', hi.trigger === null && hi.skipped.some((s) => s.code === 'RECENT_IMPROVEMENT'), JSON.stringify(hi));
    ok('…but one lucky order is not a recovery (needs the configured minimum of 2) → still paused', d({ m3: m(1500, 4), mToday: m(100, 1) }).trigger === 'HIGH_CPA');
    ok('…and today\'s CPA must be inside the limit: 3 orders at CPA 400 → still paused', d({ m3: m(1500, 4), mToday: m(1200, 3) }).trigger === 'HIGH_CPA');
    ok('zero-order and stock-out are NEVER softened by a recent improvement', d({ optimizer: { action: 'PAUSE' }, m3: m(260, 0), mToday: m(300, 3) }).trigger === 'ZERO_ORDER' && d({ stock: { status: 'OUT_OF_STOCK' }, m3: m(1500, 4), mToday: m(300, 3) }).trigger === 'STOCK_OUT');
    ok('the protection can be switched off', d({ policy: pol({ protections: { winnerProtection: true, precedence: 'PROTECTION_WINS', recentImprovement: { enabled: false, minPurchases: 2 } } }), m3: m(1500, 4), mToday: m(300, 3) }).trigger === 'HIGH_CPA'); }
  { const own = (o = {}) => d({ policy: pol({ highCpa: { enabled: true, above: null, minPurchases: 3, minSpend: 300 } }), ...o });
    ok('PER-PRODUCT CPA: with no global figure, a product\'s own Hard Stop (200) pauses a 4-order CPA of 375; without one nothing fires (no number is invented)', own({ m3: m(1500, 4), productHighCpa: 200 }).trigger === 'HIGH_CPA' && own({ m3: m(1500, 4) }).trigger === null);
    ok('the product\'s Hard Stop wins over the global figure: global 300 but own 400 → 375 is fine; own 200 → paused', d({ m3: m(1500, 4), productHighCpa: 400 }).trigger === null && d({ m3: m(1500, 4), productHighCpa: 200 }).trigger === 'HIGH_CPA');
    ok('recent improvement uses the same per-product limit (today 3 orders at 150 ≤ own 200 → waits)', d({ m3: m(1500, 4), productHighCpa: 200, mToday: m(450, 3) }).trigger === null); }
  ok('scope / weekday are reported as blockers', d({ policy: pol({ scope: { excludeStores: ['s'] } }) }).blockers.includes('EXCLUDED_BY_POLICY') && d({ policy: pol({ days: [1] }) }).blockers.includes('DAY_NOT_ALLOWED'));

  console.log('\n2. Pause policy: versioned save, separate approval');
  try {
    const s1 = await PP.savePausePolicy({ patch: { scheduledClose: { enabled: true }, zeroOrder: { enabled: true, spend: 150 } }, userId: 1, deps: { user: ADMIN } });
    ok('first save → version 1, NOT enabled, not approved', s1.changed && s1.policy.version === 1 && s1.policy.enabled === false && !PP.pausePolicyActive(s1.policy));
    ok('saving the same values again is not a new version', (await PP.savePausePolicy({ patch: { zeroOrder: { spend: 150 } }, userId: 1, deps: { user: ADMIN } })).changed === false);
    ok('a MANAGER cannot save or enable it', (await rej(() => PP.savePausePolicy({ patch: {}, userId: 9, deps: { user: MGR } })))?.status === 403 && (await rej(() => PP.setPausePolicyEnabled({ enabled: true, confirm: true, userId: 9, deps: { user: MGR } })))?.status === 403);
    ok('enabling needs an explicit confirm', (await rej(() => PP.setPausePolicyEnabled({ enabled: true, userId: 1, deps: { user: ADMIN } })))?.code === 'CONFIRM_REQUIRED');
    const en = await PP.setPausePolicyEnabled({ enabled: true, confirm: true, userId: 1, deps: { user: ADMIN } });
    ok('enable records WHICH version was approved and makes it active', en.policy.approved.version === 1 && PP.pausePolicyActive(en.policy));
    const s2 = await PP.savePausePolicy({ patch: { highCpa: { enabled: true, above: 350 } }, userId: 1, deps: { user: ADMIN } });
    ok('a later change is version 2 but the APPROVED version is still 1 → NOT active until re-approved', s2.policy.version === 2 && s2.policy.approved.version === 1 && !PP.pausePolicyActive(s2.policy) && s2.policy.history.some((h) => h.version === 1));
    ok('high CPA enabled WITHOUT a global figure is accepted: it then covers only products that have their OWN Hard Stop CPA (each product has its own limit); an out-of-range figure is still refused', (await rej(() => PP.savePausePolicy({ patch: { highCpa: { enabled: true, above: null } }, userId: 1, deps: { user: ADMIN } }))) === null && (await rej(() => PP.savePausePolicy({ patch: { highCpa: { enabled: true, above: -5 } }, userId: 1, deps: { user: ADMIN } })))?.status === 400);
    ok('disabling an enabled policy cannot leave it without any trigger', (await rej(() => PP.savePausePolicy({ patch: { scheduledClose: { enabled: false }, zeroOrder: { enabled: false }, highCpa: { enabled: false }, stockOut: { enabled: false } }, userId: 1, deps: { user: ADMIN } })))?.status === 400);
  } finally { await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } }); await prisma.ambOperatorEvent.deleteMany({ where: { kind: { in: ['PAUSE_POLICY_SAVED', 'PAUSE_POLICY_ENABLED'] } } }); }

  console.log('\n3. AUTOMATIC readiness: a product with ANYTHING missing is refused');
  const good = { productId: 7, storeId: 's', name: 'P', economicsComplete: true, stockKnown: true, stock: 40, campaignsMapped: 2 };
  const full = { mode: 'AUTOMATIC', cpa: { scale: 80, reduce: 150, hardStop: 300 }, budget: { dailySpendCap: 2000, minBudget: 100, maxBudget: 600 } };
  const rd = (o = {}) => AR.evaluateReadiness({ row: good, policy: full, pause: pol(), open: null, ...o });
  ok('complete product → READY', rd().ready === true && rd().missing.length === 0);
  for (const [label, o, key] of [['no active policy', { policy: null }, 'POLICY_ACTIVE'], ['mode not AUTOMATIC', { policy: { ...full, mode: 'APPROVAL' } }, 'MODE_AUTOMATIC'], ['economics incomplete', { row: { ...good, economicsComplete: false } }, 'ECONOMICS'], ['stock unknown under STRICT stock protection', { policy: { ...full, stockPolicy: 'BLOCK' }, row: { ...good, stockKnown: false } }, 'STOCK'], ['no verified mapping', { row: { ...good, campaignsMapped: 0 } }, 'MAPPING'], ['no daily spend cap', { policy: { ...full, budget: { ...full.budget, dailySpendCap: null } } }, 'SPEND_LIMITS'], ['no min budget', { policy: { ...full, budget: { ...full.budget, minBudget: null } } }, 'SPEND_LIMITS'], ['no max budget', { policy: { ...full, budget: { ...full.budget, maxBudget: null } } }, 'SPEND_LIMITS'], ['no hard stop', { policy: { ...full, cpa: { ...full.cpa, hardStop: null } } }, 'CPA_LIMITS'], ['pause policy not approved', { pause: PP.normalizePause({ enabled: true, version: 2, approved: { version: 1 } }) }, 'PAUSE_POLICY'], ['no product row at all', { row: null }, 'ECONOMICS']]) {
    const x = rd(o); ok(`${label} → NOT ready (${key}) with a readable fix`, !x.ready && x.missing.some((mm) => mm.key === key) && x.missing.find((mm) => mm.key === key).fix?.label, JSON.stringify(x.missing.map((q) => q.key))); }
  ok('open-policy absence does not block AUTOMATIC (opening just stays manual)', rd({ open: null }).ready === true);
  { const x = rd({ row: { ...good, stockKnown: false, stock: null } }); const st = x.checks.find((c) => c.key === 'STOCK');
    ok('unknown stock is only a WARNING by the owner\'s decision: the product stays READY, the check is shown as not required with the reason', x.ready === true && st.ok === false && st.required === false && /تحذير/.test(st.detail));
    ok('strict stock protection (stockPolicy BLOCK, set explicitly) makes the stock check required again', rd({ policy: { ...full, stockPolicy: 'BLOCK' }, row: { ...good, stockKnown: false } }).ready === false);
    ok('known stock below the approved open-policy minimum still blocks (this is a different rule from «unknown»)', rd({ row: { ...good, stock: 10 }, open: { enabled: true, version: 1, approved: { version: 1 }, minStock: 50 }, minStockRequired: 50 }).ready === false); }
  ok('a minimum stock in the approved open policy is required to be met', !rd({ open: { enabled: true, version: 1, approved: { version: 1 }, minStock: 50 }, minStockRequired: 50 }).ready);

  console.log('\n4. Activation refuses an incomplete product (real path)');
  const PID = 880301, ST = 'trendy-storeee';
  await PO.saveDraft({ productId: PID, storeId: ST, policy: { mode: 'AUTOMATIC', cpa: { scale: 80, reduce: 150, hardStop: 300 }, budget: { dailySpendCap: 2000, minBudget: 100, maxBudget: 600 } }, userId: 1, deps: { user: ADMIN } });
  try { const e = await rej(() => PO.activatePolicy({ productId: PID, storeId: ST, confirm: true, confirmAutomatic: true, userId: 1, deps: { user: ADMIN, noReconcile: true } }));
    ok('real readiness: AUTOMATIC_NOT_READY with the missing list (no product row, no approved pause policy)', e?.code === 'AUTOMATIC_NOT_READY' && e.details.missing.length >= 2, JSON.stringify(e?.details?.missing?.map((q) => q.key)));
    const a = await PO.activatePolicy({ productId: PID, storeId: ST, confirm: true, userId: 1, deps: { user: ADMIN, noReconcile: true } }).catch((x) => x); ok('(the draft is AUTOMATIC so even without confirmAutomatic it is refused — 400)', a.status === 400);
    const s = await AR.activationSummary({ productId: PID, storeId: ST, deps: { rows: [good, { ...good, productId: PID, storeId: ST }], campaigns: [{ id: 'c1', name: 'one', status: 'ACTIVE' }, { id: 'c2', name: 'two', status: 'PAUSED' }], exposure: 700 } });
    ok('activation summary: policy versions, scope, four operations with permission/approval flags, exposure vs the cap, risk, readiness', s.policy.status === 'DRAFT' && s.scope.campaigns.length === 2 && s.operations.length === 4 && s.exposure.maxDailyCap === 2000 && s.exposure.headroom === 1300 && ['LOW', 'MEDIUM', 'HIGH'].includes(s.risk.level) && s.canActivate === false, JSON.stringify(s).slice(0, 300));
    ok('summary is honest that writes are locked / operations will not run while permissions are OFF', s.operations.every((o) => o.permissionOn === false || o.willRun === (o.permissionOn && o.policyApproved)) && s.risk.reasons.some((r) => /مقفولة|ناقص/.test(r)));
  } finally { await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } }); await prisma.ambOperatorProductConfig.deleteMany({ where: { product_id: PID } }).catch(() => {}); await prisma.ambOperatorEvent.deleteMany({ where: { kind: { in: ['PRODUCT_POLICY_SAVED', 'PRODUCT_POLICY_ACTIVATED'] }, created_at: { gte: new Date(Date.now() - 600_000) } } }); }
} finally { await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } }).catch(() => {}); }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
