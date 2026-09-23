// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 1 (Profit Brain + Money Guard + Stock Guard) verification. Real
// reads against production data + one real throwaway AssistantTask/
// AmbLaunchJob (cleaned up after) — NEVER approves, NEVER calls Meta.
//   node src/scripts/profitMoneyStockGuardTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { classifyProfitState, economicsConfigState, getProductProfitBrain } = await imp('../services/amb/profitBrain.js');
const { evaluateBudgetCap, evaluateDailyCumulativeCap, evaluateMoneyGuardForScale } = await imp('../services/amb/moneyGuard.js');
const { stockGuardForProduct, stockStatus } = await imp('../services/amb/stockGuard.js');
const { getAmbSettings } = await imp('../services/amb/settings.js');
const { prepare_bump, prepare_scale } = await imp('../services/aiToolsWrite.js');
const { getConnection } = await imp('../services/metaAuth.js');
const { resolveWindow } = await imp('../services/amb/metricsEngine.js');
const { resolveOperationalWindowName } = await imp('../services/amb/productDossier.js');

const cleanupTaskUuids = [];
const cleanupJobIds = [];
async function cleanup() {
  for (const taskUuid of cleanupTaskUuids) await prisma.assistantTask.deleteMany({ where: { task_uuid: taskUuid } }).catch(() => {});
  for (const jobId of cleanupJobIds) await prisma.ambLaunchJob.deleteMany({ where: { job_id: jobId } }).catch(() => {});
}

try {
  console.log('§1 Pure fixture assertions — classifyProfitState / economicsConfigState:');
  {
    const settings = { ambProfitMarginThinPct: 15, ambProfitBreakEvenBandPct: 3 };
    ok('NOT_CONFIGURED when selling_price is 0', economicsConfigState({ selling_price: 0, product_cost: 50 }) === 'NOT_CONFIGURED');
    ok('NOT_CONFIGURED when product_cost is 0', economicsConfigState({ selling_price: 500, product_cost: 0 }) === 'NOT_CONFIGURED');
    ok('ESTIMATED when a secondary cost is still at its 0 default', economicsConfigState({ selling_price: 500, product_cost: 100, shipping_cost: 0, packaging_cost: 10, other_cost: 5, commission: 5, expected_return_cost: 5 }) === 'ESTIMATED');
    ok('KNOWN when every cost field is a real non-zero value', economicsConfigState({ selling_price: 500, product_cost: 100, shipping_cost: 30, packaging_cost: 10, other_cost: 5, commission: 5, expected_return_cost: 20 }) === 'KNOWN');

    const noOrders = classifyProfitState({ real: { actualOrders: 0 } }, { selling_price: 500, product_cost: 100 }, settings);
    ok('0 real orders -> INSUFFICIENT_DATA, marginPct null', noOrders.state === 'INSUFFICIENT_DATA' && noOrders.marginPct === null, JSON.stringify(noOrders));

    const notConfigured = classifyProfitState({ real: { actualOrders: 10, netProfit: 500, actualRevenue: 5000 } }, { selling_price: 0, product_cost: 0 }, settings);
    ok('orders exist but cost unset -> PARTIAL_DATA', notConfigured.state === 'PARTIAL_DATA', JSON.stringify(notConfigured));

    const profitable = classifyProfitState({ real: { actualOrders: 10, netProfit: 1000, actualRevenue: 5000 } }, { selling_price: 500, product_cost: 100, shipping_cost: 20, packaging_cost: 10, other_cost: 5, commission: 5, expected_return_cost: 10 }, settings);
    ok('20% real margin -> PROFITABLE', profitable.state === 'PROFITABLE' && Math.abs(profitable.marginPct - 20) < 0.01, JSON.stringify(profitable));

    const thin = classifyProfitState({ real: { actualOrders: 10, netProfit: 500, actualRevenue: 5000 } }, { selling_price: 500, product_cost: 100, shipping_cost: 20, packaging_cost: 10, other_cost: 5, commission: 5, expected_return_cost: 10 }, settings);
    ok('10% real margin -> MARGIN_THIN', thin.state === 'MARGIN_THIN' && Math.abs(thin.marginPct - 10) < 0.01, JSON.stringify(thin));

    const breakEven = classifyProfitState({ real: { actualOrders: 10, netProfit: 100, actualRevenue: 5000 } }, { selling_price: 500, product_cost: 100, shipping_cost: 20, packaging_cost: 10, other_cost: 5, commission: 5, expected_return_cost: 10 }, settings);
    ok('2% real margin -> BREAK_EVEN (inside the 3% band)', breakEven.state === 'BREAK_EVEN', JSON.stringify(breakEven));

    const unprofitable = classifyProfitState({ real: { actualOrders: 10, netProfit: -1000, actualRevenue: 5000 } }, { selling_price: 500, product_cost: 100, shipping_cost: 20, packaging_cost: 10, other_cost: 5, commission: 5, expected_return_cost: 10 }, settings);
    ok('-20% real margin -> UNPROFITABLE', unprofitable.state === 'UNPROFITABLE', JSON.stringify(unprofitable));
  }

  console.log('\n§2 Pure fixture assertions — Money Guard:');
  {
    const overCap = evaluateBudgetCap({ requestedPct: 80, maxSingleActionPct: 25 });
    ok('80% vs 25% max -> BLOCKED citing both numbers', overCap.decision === 'BLOCKED' && overCap.reason.includes('80%') && overCap.reason.includes('25%'), overCap.reason);
    const underCap = evaluateBudgetCap({ requestedPct: 20, maxSingleActionPct: 25 });
    ok('20% vs 25% max -> ALLOWED', underCap.decision === 'ALLOWED');

    const overDaily = evaluateDailyCumulativeCap({ cumulativePctLast24h: 30, requestedPct: 25, maxDailyPct: 50 });
    ok('30% already used + 25% requested vs 50% daily cap -> BLOCKED', overDaily.decision === 'BLOCKED' && overDaily.projected === 55, overDaily.reason);

    const scaleBlocked = evaluateMoneyGuardForScale({ profitState: 'UNPROFITABLE', stockGuard: { status: 'SAFE' }, settings: {} });
    ok('UNPROFITABLE -> BLOCKED', scaleBlocked.decision === 'BLOCKED');
    const scaleBlockedStock = evaluateMoneyGuardForScale({ profitState: 'PROFITABLE', stockGuard: { status: 'OUT_OF_STOCK' }, settings: {} });
    ok('OUT_OF_STOCK -> BLOCKED even if profitable', scaleBlockedStock.decision === 'BLOCKED');
    const scaleWarn = evaluateMoneyGuardForScale({ profitState: 'MARGIN_THIN', stockGuard: { status: 'SAFE', daysRemaining: 30 }, settings: {} });
    ok('MARGIN_THIN -> WARN, not BLOCKED', scaleWarn.decision === 'WARN', JSON.stringify(scaleWarn));
    const scaleClean = evaluateMoneyGuardForScale({ profitState: 'PROFITABLE', stockGuard: { status: 'SAFE', daysRemaining: 30 }, settings: { ambStockGuardMinDaysForScale: 14 } });
    ok('PROFITABLE + healthy stock -> ALLOWED', scaleClean.decision === 'ALLOWED');
  }

  console.log('\n§3 Real reads — getProductProfitBrain / stockGuardForProduct against real products:');
  {
    const settings = await getAmbSettings();
    const win = resolveWindow(resolveOperationalWindowName(settings));
    const products = await prisma.product.findMany({ where: { active: true, is_historical: false }, take: 8, orderBy: { id: 'desc' }, select: { id: true, current_stock: true } });
    let checked = 0;
    for (const p of products) {
      const brain = await getProductProfitBrain({ productId: p.id, dateFrom: win.from, dateTo: win.to });
      const validStates = ['PROFITABLE', 'MARGIN_THIN', 'BREAK_EVEN', 'UNPROFITABLE', 'PARTIAL_DATA', 'INSUFFICIENT_DATA'];
      ok(`product #${p.id} profitState is a valid enum value`, validStates.includes(brain.state), brain.state);
      ok(`product #${p.id} marginPct is null iff data-insufficient`, (brain.marginPct === null) === ['PARTIAL_DATA', 'INSUFFICIENT_DATA'].includes(brain.state), JSON.stringify(brain));

      const stock = await stockGuardForProduct({ productId: p.id, days: settings.ambStockGuardVelocityWindowDays });
      ok(`product #${p.id} stock status matches independent stockStatus()`, stock.status === stockStatus({ current_stock: p.current_stock, minimum_stock: null }).status || p.current_stock == null, JSON.stringify(stock));
      ok(`product #${p.id} daysRemaining is null or a non-negative number`, stock.daysRemaining === null || stock.daysRemaining >= 0, stock.daysRemaining);
      checked++;
    }
    ok('checked at least one real product', checked > 0);
  }

  console.log('\n§4 prepare_bump — Money Guard replaces the silent clamp:');
  {
    const adminUser = await prisma.user.findFirst({ where: { role: { in: ['ADMIN', 'MANAGER'] } }, select: { id: true } });
    const connection = await getConnection();
    if (!adminUser || !connection?.selected_ad_account_id) {
      console.log('  (skipped — no admin user or connected ad account)');
    } else {
      // Find a real active ad set via the same metricsEngine path prepare_bump itself uses.
      const { entityWindowMetrics } = await imp('../services/amb/metricsEngine.js');
      const window = resolveWindow('last3');
      const adsetMetrics = await entityWindowMetrics({ level: 'adset', from: window.from, to: window.to, adAccountId: connection.selected_ad_account_id });
      const firstAdSet = [...adsetMetrics.keys()][0];
      if (!firstAdSet) {
        console.log('  (skipped — no real ad set with recent activity found)');
      } else {
        const settings = await getAmbSettings();
        const maxPct = settings.ambMaxBudgetIncreasePct;
        const overResult = await prepare_bump({ adSetId: firstAdSet, pct: maxPct + 60, userId: adminUser.id, conversationRef: 'profitMoneyStockGuardTest' });
        ok('requesting far above the cap returns BLOCKED, not a silently smaller value', overResult.ok === false && overResult.error === 'BLOCKED' && overResult.message.includes(String(maxPct)), JSON.stringify(overResult));
        if (overResult.task) cleanupTaskUuids.push(overResult.task.taskUuid);

        // Regression guard — a normal request should still reach the pre-existing behavior (WAITING_FOR_APPROVAL or a legitimate BLOCKED for lifecycle/cooldown reasons, never a crash).
        const validResult = await prepare_bump({ adSetId: firstAdSet, pct: 1, userId: adminUser.id, conversationRef: 'profitMoneyStockGuardTest-2' });
        ok('a small, valid pct still returns ok:true (happy path not broken by the retrofit)', validResult.ok === true, JSON.stringify(validResult));
        if (validResult.task) cleanupTaskUuids.push(validResult.task.taskUuid);
      }
    }
  }

  console.log('\n§5 prepare_scale — Profit Brain / Stock Guard surfaced on the preview:');
  {
    const adminUser = await prisma.user.findFirst({ where: { role: { in: ['ADMIN', 'MANAGER'] } }, select: { id: true } });
    const connection = await getConnection();
    if (!adminUser || !connection?.selected_ad_account_id) {
      console.log('  (skipped — no admin user or connected ad account)');
    } else {
      const { loadWinningStackForProduct } = await imp('../services/assistantTasks/scalePrepare.js');
      const ambProducts = await prisma.ambProduct.findMany({ take: 40, orderBy: { id: 'desc' }, select: { product_id: true, product: { select: { id: true, product_name: true, active: true, is_historical: true } } } });
      const candidates = ambProducts.filter((a) => a.product?.active && !a.product?.is_historical).map((a) => a.product);
      let scaleCandidate = null;
      for (const p of candidates) {
        const r = await loadWinningStackForProduct({ productId: p.id, adAccountId: connection.selected_ad_account_id }).catch(() => ({ ok: false }));
        if (r.ok) { scaleCandidate = p; break; }
      }
      if (!scaleCandidate) {
        console.log('  (skipped — no real SCALE_CANDIDATE product found)');
      } else {
        const out = await prepare_scale({ productId: scaleCandidate.id, budgetEgp: 100, websiteUrl: 'https://example.com/pgi-test', userId: adminUser.id, conversationRef: 'profitMoneyStockGuardTest', context: {} });
        ok('prepare_scale still returns ok:true or a real BLOCKED (never a crash)', out.ok === true || out.error === 'BLOCKED', JSON.stringify(out));
        if (out.task) {
          cleanupTaskUuids.push(out.task.taskUuid);
          if (out.task.launchJobId) cleanupJobIds.push(out.task.launchJobId);
          if (out.task.status === 'WAITING_FOR_APPROVAL') {
            const p = out.task.preparedPayload;
            ok('preview carries profitBrain', !!p.profitBrain && typeof p.profitBrain.state === 'string', JSON.stringify(p.profitBrain));
            ok('preview carries stockGuard', !!p.stockGuard && typeof p.stockGuard.status === 'string', JSON.stringify(p.stockGuard));
            console.log('  profitBrain:', JSON.stringify(p.profitBrain), '| stockGuard:', JSON.stringify(p.stockGuard), '| moneyGuardWarning:', p.moneyGuardWarning);
          } else if (out.task.status === 'BLOCKED') {
            ok('a real Money Guard BLOCKED cites a real reason', typeof out.task.blockedReason === 'string' && out.task.blockedReason.length > 5, out.task.blockedReason);
            console.log('  BLOCKED by Money Guard:', out.task.blockedReason);
          }
        } else if (out.error === 'BLOCKED') {
          console.log('  BLOCKED before any task/job was persisted:', out.message);
        }
      }
    }
  }
} finally {
  await cleanup();
  console.log('\ncleanup done —', cleanupTaskUuids.length, 'test task(s),', cleanupJobIds.length, 'test job(s) removed.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
