// 🧪 مركز التنبيهات — the alert rules (pure) + the loader on an isolated database. No Meta / Easy Orders calls.
//   node src/scripts/alertsCenterTest.js
import './_testGuard.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const A = await imp('../services/amb/alertsCenter.js');

const NOON = new Date('2026-11-05T10:00:00Z'); // 12:00 Cairo
const NIGHT = new Date('2026-11-05T00:30:00Z'); // 02:30 Cairo
try {
  console.log('\n1. Easy Orders feed');
  const h = (hrs, now = NOON) => new Date(now.getTime() - hrs * 3_600_000);
  ok('a recent order → no alert', A.evalOrdersFeed({ lastOrderAt: h(0.5), now: NOON }).length === 0);
  ok('2h of silence in the day → WARNING', A.evalOrdersFeed({ lastOrderAt: h(2.5), now: NOON })[0]?.severity === 'WARNING');
  ok('4h+ in the day → CRITICAL, with the last-order time and the 24h count', (() => { const a = A.evalOrdersFeed({ lastOrderAt: h(5), now: NOON, last24h: 612 })[0]; return a.severity === 'CRITICAL' && /5 ساعة/.test(a.title) && a.facts.some((f) => /612/.test(f.v)); })());
  ok('3 weeks of silence (the real incident) reads in days', /\d+ يوم/.test(A.evalOrdersFeed({ lastOrderAt: h(24 * 23), now: NOON })[0].title));
  ok('at night the limits double (3h at 02:30 Cairo is normal)', A.evalOrdersFeed({ lastOrderAt: h(3, NIGHT), now: NIGHT }).length === 0 && A.evalOrdersFeed({ lastOrderAt: h(5, NIGHT), now: NIGHT })[0]?.severity === 'WARNING' && A.evalOrdersFeed({ lastOrderAt: h(9, NIGHT), now: NIGHT })[0]?.severity === 'CRITICAL');
  ok('an empty orders table → CRITICAL', A.evalOrdersFeed({ lastOrderAt: null, now: NOON })[0]?.severity === 'CRITICAL');
  const wh = A.evalOrdersFeed({ lastOrderAt: h(0.1), now: NOON, webhook: { rejected: 7, lastRejectedAt: h(0.2).toISOString() } });
  ok('recent webhook rejections → CRITICAL even though orders look fresh; an old rejection is ignored', wh.length === 1 && wh[0].id === 'eo-webhook-rejected' && A.evalOrdersFeed({ lastOrderAt: h(0.1), now: NOON, webhook: { rejected: 7, lastRejectedAt: h(5).toISOString() } }).length === 0);

  console.log('\n2. Meta sync freshness');
  ok('a fresh sync → nothing', A.evalSyncFreshness({ lastSuccessAt: h(0.2), intervalMinutes: 15, now: NOON }).length === 0);
  ok('4 missed cycles (60 min) → WARNING, 2x → CRITICAL, never synced → CRITICAL', A.evalSyncFreshness({ lastSuccessAt: h(1.2), intervalMinutes: 15, now: NOON })[0]?.severity === 'WARNING' && A.evalSyncFreshness({ lastSuccessAt: h(3), intervalMinutes: 15, now: NOON })[0]?.severity === 'CRITICAL' && A.evalSyncFreshness({ lastSuccessAt: null, now: NOON })[0]?.severity === 'CRITICAL');

  console.log('\n3. Campaign rules');
  const row = (o = {}) => ({ key: 'a:c1', campaignId: 'c1', adAccountId: 'a', name: 'Camp 1', status: 'ACTIVE', dataFresh: true, productId: 7, productName: 'Soleva', budget: 300, today: { spend: 200, orders: 2 }, period: { spend: 900, orders: 4, cpa: 225 }, limits: { target: 100, reduce: 150, hardStop: 220 }, cpaVsLimits: 'WITHIN_TARGET', stock: { status: 'SAFE', current: 40 }, ...o });
  ok('a healthy campaign raises nothing', A.evalCampaignAlerts([row()]).length === 0);
  const hard = A.evalCampaignAlerts([row({ cpaVsLimits: 'ABOVE_HARDSTOP' })]);
  ok('CPA above the hard stop → CRITICAL with the real numbers (225 vs 220, 900 spend)', hard.length === 1 && hard[0].severity === 'CRITICAL' && hard[0].kind === 'CPA' && hard[0].facts.some((f) => /225/.test(f.v)) && hard[0].facts.some((f) => /220/.test(f.v)), JSON.stringify(hard[0]));
  ok('above the reduce limit only → WARNING', A.evalCampaignAlerts([row({ cpaVsLimits: 'ABOVE_REDUCE' })])[0]?.severity === 'WARNING');
  ok('too little spend to judge (< min) → no CPA alert; not spending today → no CPA alert', A.evalCampaignAlerts([row({ cpaVsLimits: 'ABOVE_HARDSTOP', period: { spend: 60, orders: 0, cpa: null } })]).filter((a) => a.kind === 'CPA').length === 0 && A.evalCampaignAlerts([row({ cpaVsLimits: 'ABOVE_HARDSTOP', today: { spend: 0, orders: 0 } })]).filter((a) => a.kind === 'CPA').length === 0);
  ok('unknown limits (UNKNOWN) never raise a CPA alert', A.evalCampaignAlerts([row({ cpaVsLimits: 'UNKNOWN', limits: null })]).length === 0);
  const zero = A.evalCampaignAlerts([row({ today: { spend: 320, orders: 0 } })], { zeroLimit: 150 });
  ok('spent over the limit with 0 orders today → CRITICAL at 2x the limit, WARNING between', zero.length === 1 && zero[0].kind === 'ZERO_ORDERS' && zero[0].severity === 'CRITICAL' && A.evalCampaignAlerts([row({ today: { spend: 200, orders: 0 } })], { zeroLimit: 150 })[0].severity === 'WARNING');
  ok('0 orders but under the limit, or orders unknown (null) → nothing', A.evalCampaignAlerts([row({ today: { spend: 100, orders: 0 } })], { zeroLimit: 150 }).length === 0 && A.evalCampaignAlerts([row({ today: { spend: 500, orders: null } })], { zeroLimit: 150 }).length === 0);
  ok('paused campaigns and stale data are never a live alert', A.evalCampaignAlerts([row({ status: 'PAUSED', today: { spend: 900, orders: 0 } }), row({ dataFresh: false, today: { spend: 900, orders: 0 } })], { zeroLimit: 150 }).length === 0);

  console.log('\n4. Stock');
  const stock = A.evalCampaignAlerts([row({ key: 'a:c1', stock: { status: 'OUT_OF_STOCK', current: 0 } }), row({ key: 'a:c2', campaignId: 'c2', name: 'Camp 2', stock: { status: 'OUT_OF_STOCK', current: 0 } }), row({ key: 'a:c3', campaignId: 'c3', productId: 9, productName: 'Hifu', stock: { status: 'LOW', current: 3 } })]);
  const so = stock.filter((a) => a.kind === 'STOCK');
  ok('one alert per product however many campaigns: Soleva (out, 2 campaigns, CRITICAL) + Hifu (low, WARNING)', so.length === 2 && so.find((a) => a.id === 'stock:7').severity === 'CRITICAL' && so.find((a) => a.id === 'stock:7').facts.some((f) => f.l === 'حملات شغالة' && f.v === '2') && so.find((a) => a.id === 'stock:9').severity === 'WARNING', JSON.stringify(so.map((a) => [a.id, a.severity])));
  ok('unknown stock / safe stock → nothing; a product with no link never gets a stock alert', A.evalCampaignAlerts([row({ stock: { status: 'STOCK_UNKNOWN', current: null } }), row({ productId: null, stock: { status: 'OUT_OF_STOCK', current: 0 } })]).length === 0);

  console.log('\n5. Funds, sorting, summary');
  const funds = A.evalFunds([{ id: 'act_1', name: 'Hady', spend: 800, funds: { low: true, available: 450 } }, { id: 'act_2', name: 'Ok', funds: { low: false, available: 9000 } }, { id: 'act_3', name: 'Card', funds: { low: false, available: null } }], 2000);
  ok('only the low account raises a CRITICAL funds alert with its balance', funds.length === 1 && funds[0].severity === 'CRITICAL' && /450/.test(funds[0].title));
  const all = A.sortAlerts([{ severity: 'INFO', kind: 'SYSTEM', title: 'x' }, { severity: 'WARNING', kind: 'CPA', title: 'b' }, { severity: 'CRITICAL', kind: 'STOCK', title: 'a' }, { severity: 'CRITICAL', kind: 'CPA', title: 'z' }]);
  ok('most severe first, then by kind', all.map((a) => a.severity + a.kind).join() === 'CRITICALCPA,CRITICALSTOCK,WARNINGCPA,INFOSYSTEM');
  const sm = A.summarize(all);
  ok('summary counts by severity and kind', sm.total === 4 && sm.CRITICAL === 2 && sm.WARNING === 1 && sm.INFO === 1 && sm.kinds.CPA === 2);

  console.log('\n6. The loader on an isolated database');
  A._resetAlertsCache();
  const doc = await A.getAlertsCenter({ force: true });
  ok('returns a document and never throws, even with no Meta / orders data', doc && Array.isArray(doc.alerts) && doc.summary && typeof doc.generatedAt === 'string');
  ok('an empty orders table is reported as an alert (not silently skipped)', doc.alerts.some((a) => a.id === 'eo-feed-empty' || a.id === 'eo-feed-stalled'), JSON.stringify(doc.alerts.map((a) => a.id)));
  const again = await A.getAlertsCenter({});
  ok('served from the 60s cache on the second call', again === doc);
} finally {
  await prisma.$disconnect();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
