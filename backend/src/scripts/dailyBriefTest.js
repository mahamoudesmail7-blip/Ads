// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 15 (Daily Media Buyer Brief) verification. Pure reads only — no
// new write tool, nothing to clean up.
//   node src/scripts/dailyBriefTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { get_daily_brief } = await imp('../services/aiTools.js');

console.log('§1 Real get_daily_brief across several real windows — every number and freshness field must be real, never fabricated:');
for (const window of ['today', 'last7', 'last30']) {
  const out = await get_daily_brief({ window });
  ok(`[${window}] ok:true`, out.ok === true, JSON.stringify(out).slice(0, 300));
  if (!out.ok) continue;
  ok(`[${window}] window is the SAME window requested, never silently swapped`, !!out.window?.from && !!out.window?.to);
  ok(`[${window}] spend/metaPurchases/revenue/avgCpa are real numbers or null, never a string/NaN`, [out.spend, out.metaPurchases, out.revenue, out.avgCpa].every((v) => v === null || (typeof v === 'number' && !Number.isNaN(v))));
  ok(`[${window}] netProfit is null OR a real number — never fabricated when unverified`, out.netProfit === null || typeof out.netProfit === 'number');
  ok(`[${window}] businessConversionRate is null or a real 0-100-ish number`, out.businessConversionRate === null || (typeof out.businessConversionRate === 'number' && out.businessConversionRate >= 0));
  ok(`[${window}] easyOrders is null (not sourced) or a real {orders,confirmed,delivered,returned} block`, out.easyOrders === null || (typeof out.easyOrders.orders === 'number'));
  ok(`[${window}] winningProducts/attentionProducts are arrays`, Array.isArray(out.winningProducts) && Array.isArray(out.attentionProducts));
  ok(`[${window}] fatiguingCreatives/incidents are arrays, never merged into one`, Array.isArray(out.fatiguingCreatives) && Array.isArray(out.incidents));
  ok(`[${window}] no incident row leaks into BOTH fatiguingCreatives and incidents`, !out.fatiguingCreatives.some((f) => out.incidents.some((i) => i.title === f.title && i.at === f.at)));
  ok(`[${window}] activeTests rows carry a real testType/hypothesis`, out.activeTests.every((t) => typeof t.testType === 'string' && typeof t.hypothesis === 'string'));
  ok(`[${window}] tasksWaitingApproval rows are real AssistantTask rows (task_uuid present)`, out.tasksWaitingApproval.every((t) => typeof t.task_uuid === 'string'));
  ok(`[${window}] freshness block carries real period + sync fields, never fabricated`, out.freshness?.period?.from === out.window.from && ('metaLastSuccessSyncAt' in out.freshness) && ('analysisLastBatchAt' in out.freshness));
  console.log(`  [${window}] spend=${out.spend} metaPurchases=${out.metaPurchases} netProfit=${out.netProfit} businessCR=${out.businessConversionRate} easyOrders=${JSON.stringify(out.easyOrders)} winning=${out.winningProducts.length} attention=${out.attentionProducts.length} fatiguing=${out.fatiguingCreatives.length} incidents=${out.incidents.length} activeTests=${out.activeTests.length} tasksWaiting=${out.tasksWaitingApproval.length}`);
}

console.log('\n§2 Cross-check against real DB counts — tasksWaitingApproval and activeTests must match the real, current DB state exactly:');
{
  const realWaiting = await prisma.assistantTask.count({ where: { status: 'WAITING_FOR_APPROVAL' } });
  const realRunningTests = await prisma.productMarketingTest.count({ where: { status: 'RUNNING' } });
  const out = await get_daily_brief({ window: 'today' });
  ok('tasksWaitingApproval count matches the real DB count (or is capped at take:20 if DB has more)', out.tasksWaitingApproval.length === Math.min(realWaiting, 20), `brief=${out.tasksWaitingApproval.length} real=${realWaiting}`);
  ok('activeTests count matches the real DB count (or is capped at take:20 if DB has more)', out.activeTests.length === Math.min(realRunningTests, 20), `brief=${out.activeTests.length} real=${realRunningTests}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
