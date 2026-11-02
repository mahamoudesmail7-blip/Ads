// 🧪 «كسبان ولا خسران؟»: one product over a chosen period across every account — spend / orders / CPA / per-account split / daily series / estimated profit and its assumptions.
// Isolated test database only.   node src/scripts/productProfitTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const PP = await imp('../services/amb/productProfit.js');

const PRIMARY = 'act_1518142859790043', HADY = 'act_877011384919552', YASSER = 'act_1370863561334304';
const cairo = (offsetDays = 0) => new Date(Date.now() + 3 * 3600e3 - offsetDays * 24 * 3600e3).toISOString().slice(0, 10);
let conn = null, prevAcc = null, prevStatus = null; const runIds = []; const made = { products: [], amb: [], job: null };
try {
  console.log('\n1. Pure pieces: economics, verdict');
  const E = PP.buildEconomics;
  const full = { product_cost: 100, pricing_multiplier: 3, actual_selling_price: 450, shipping_cost: 30, packaging_cost: 0, other_cost: 0, rto_cost: 20, confirmation_rate: 0.8, delivery_rate: 0.5 };
  const e1 = E(full);
  ok('economics with rates: gross 320, share 0.4, contribution 0.4×320 − 0.4×20 = 120', e1.available && e1.grossPerDelivered === 320 && e1.deliveredShare === 0.4 && e1.deliveredShareSource === 'PRODUCT_RATES' && e1.contributionPerOrder === 120 && e1.breakEvenCpa === 120, JSON.stringify(e1));
  const e2 = E({ ...full, confirmation_rate: null, delivery_rate: null });
  ok('without rates: 100% assumed (flagged ASSUMED_100), contribution = gross 320', e2.available && e2.deliveredShareSource === 'ASSUMED_100' && e2.contributionPerOrder === 320, JSON.stringify(e2));
  const e3 = E({ ...full, confirmation_rate: 0.9, delivery_rate: null });
  ok('only ONE of the two rates known → not used (100% assumed, flagged)', e3.deliveredShareSource === 'ASSUMED_100' && e3.deliveredShare === 1, JSON.stringify(e3));
  ok('cost 0 (the unset default) → NOT available (no invented profit)', E({ ...full, product_cost: 0 }).available === false);
  ok('no selling price → NOT available; no product row → NOT available', E({ ...full, actual_selling_price: null, pricing_multiplier: null, product_cost: 100, suggested_selling_price: 0 }).available === false && E(null).available === false);
  const V = PP.verdictFor;
  ok('verdict: +/- 2% of spend (min 50) is break-even; beyond it WIN / LOSS; null → UNKNOWN; nothing ran → NO_DATA', V({ estimatedProfit: 500, spend: 1000 }) === 'WIN' && V({ estimatedProfit: -500, spend: 1000 }) === 'LOSS' && V({ estimatedProfit: 10, spend: 1000 }) === 'BREAKEVEN' && V({ estimatedProfit: null, spend: 1000 }) === 'UNKNOWN' && V({ estimatedProfit: 0, spend: 0 }) === 'NO_DATA');

  console.log('\n1b. Meta reads are bounded: date windows of at most 31 days');
  const MG = await imp('../services/metaGraphClient.js');
  ok('one window when the range fits', JSON.stringify(MG.dateWindows('2026-10-01', '2026-10-31', 31)) === JSON.stringify([{ since: '2026-10-01', until: '2026-10-31' }]));
  ok('a longer range is split into consecutive windows with no gap and no overlap', JSON.stringify(MG.dateWindows('2026-10-01', '2026-11-15', 31)) === JSON.stringify([{ since: '2026-10-01', until: '2026-10-31' }, { since: '2026-11-01', until: '2026-11-15' }]));
  const w60 = MG.dateWindows('2026-09-01', '2026-11-02', 31);
  ok('63 days → 3 windows, contiguous, ending exactly on the last day', w60.length === 3 && w60[0].since === '2026-09-01' && w60[2].until === '2026-11-02' && w60[1].since === '2026-10-02' && w60[2].since === '2026-11-02', JSON.stringify(w60));
  ok('a single day, and an empty range', MG.dateWindows('2026-11-02', '2026-11-02', 31).length === 1 && MG.dateWindows('2026-11-03', '2026-11-02', 31).length === 0);

  console.log('\n2. One product across accounts and periods');
  conn = await prisma.metaConnection.findFirst(); prevAcc = conn?.selected_ad_account_id; prevStatus = conn?.status;
  await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: PRIMARY, status: 'CONNECTED' } });
  const run = await prisma.ambSyncRun.create({ data: { trigger: 'VIEW', status: 'SUCCESS', ad_account_id: HADY, started_at: new Date(), finished_at: new Date() } }); runIds.push(run.id);
  const snap = (acc, cid, spend, purchases, date) => prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: run.id, ad_account_id: acc, level: 'campaign', date_start: date, date_stop: date, campaign_id: cid, campaign_name: cid, campaign_status: 'ACTIVE', spend, meta_purchases: purchases } });
  const P = await prisma.product.create({ data: { product_name: 'PP Product' } }); made.products.push(P.id);
  const A = await prisma.ambProduct.create({ data: { product_id: P.id, product_name: 'PP Product', product_cost: 100, pricing_multiplier: 3, actual_selling_price: 450, shipping_cost: 30, rto_cost: 20, confirmation_rate: 0.8, delivery_rate: 0.5 } }); made.amb.push(A.id);
  await prisma.ambProductCampaignMap.create({ data: { amb_product_id: A.id, ad_account_id: HADY, campaign_id: 'pp_h1', status: 'MAPPED' } });
  made.job = await prisma.ambLaunchJob.create({ data: { job_id: 'pp-test-job', ad_account_id: YASSER, budget_mode: 'CBO', config_json: '{}', product_id: P.id } });
  await prisma.ambLaunchCampaign.create({ data: { job_id: made.job.job_id, index: 0, name: 'pp launch', meta_campaign_id: 'pp_y1', status: 'COMPLETE' } });
  await snap(HADY, 'pp_h1', 300, 3, cairo(0));    // today
  await snap(YASSER, 'pp_y1', 100, 1, cairo(0));   // today, another account
  await snap(HADY, 'pp_h1', 200, 2, cairo(1));     // yesterday
  await snap(HADY, 'pp_h1', 500, 4, cairo(5));     // 5 days ago
  await snap(HADY, 'pp_h1', 900, 3, cairo(10));    // 10 days ago
  await snap(HADY, 'pp_h1', 1000, 0, cairo(40));   // 40 days ago
  await snap(HADY, 'pp_other', 777, 7, cairo(0));  // a campaign NOT linked to the product: never counted

  const list = await PP.listProfitProducts();
  ok('the selector lists the product (it has linked campaigns)', list.some((p) => p.productId === P.id && p.name === 'PP Product'), JSON.stringify(list.map((p) => p.name)));
  const g = (period) => PP.getProductProfit({ productId: P.id, period });
  const l3 = await g('last3'), l7 = await g('last7'), l30 = await g('last30'), all = await g('all');
  ok('last 3 days = today + yesterday: 600 spend / 6 orders / CPA 100', l3.totals.spend === 600 && l3.totals.orders === 6 && l3.totals.cpa === 100, JSON.stringify(l3.totals));
  ok('last 7 days adds the 5-days-ago row: 1100 / 10', l7.totals.spend === 1100 && l7.totals.orders === 10, JSON.stringify(l7.totals));
  ok('last 30 days adds the 10-days-ago row: 2000 / 13', l30.totals.spend === 2000 && l30.totals.orders === 13, JSON.stringify(l30.totals));
  ok('all = everything we hold (from the 40-days-ago row): 3000 / 13; window starts at that day', all.totals.spend === 3000 && all.totals.orders === 13 && all.window.from === cairo(40) && all.dataStart === cairo(40), JSON.stringify([all.totals, all.window, all.dataStart]));
  ok('the unlinked campaign (777 / 7) is never counted', l3.totals.spend === 600);
  ok('per-account split: Hady 500 / 5 and Yasser 100 / 1 for the last 3 days', l3.accounts.length === 2 && l3.accounts[0].id === HADY && l3.accounts[0].spend === 500 && l3.accounts[0].orders === 5 && l3.accounts[1].id === YASSER && l3.accounts[1].orders === 1, JSON.stringify(l3.accounts));
  ok('daily series has one entry per day of the window, with the right numbers', l3.daily.length === 3 && l3.daily[2].date === cairo(0) && l3.daily[2].spend === 400 && l3.daily[2].orders === 4 && l3.daily[1].spend === 200 && l3.daily[0].spend === 0 && l7.daily.length === 7 && all.daily.length === 41, JSON.stringify(l3.daily));
  ok('estimated profit = orders × 120 − spend (last 3 days: 6×120 − 600 = 120) → WIN', l3.economics.available && l3.profit.estimated === 120 && l3.profit.verdict === 'WIN', JSON.stringify([l3.economics, l3.profit]));
  ok('last 30 days: 13×120 − 2000 = −440 → LOSS', l30.profit.estimated === -440 && l30.profit.verdict === 'LOSS', JSON.stringify(l30.profit));
  ok('cost-per-order ceiling check present (CPA 100 <= 150 → ok)', l3.cpaCeiling.value === 150 && l3.cpaCeiling.ok === true && l30.cpaCeiling.ok === false, JSON.stringify([l3.cpaCeiling, l30.cpaCeiling]));

  console.log('\n2b. History straight from Meta for the days before an account\'s first snapshot');
  const calls = [];
  const hist = async ({ adAccountId, campaignIds, from, to }) => {
    calls.push({ adAccountId, campaignIds, from, to });
    if (adAccountId === YASSER) return [{ campaign_id: 'pp_y1', date_start: cairo(3), spend: 80, purchases: 2 }, { campaign_id: 'not_linked', date_start: cairo(3), spend: 999, purchases: 9 }, { campaign_id: 'pp_y1', date_start: cairo(50), spend: 1, purchases: 1 }];
    if (adAccountId === HADY) return [{ campaign_id: 'pp_h1', date_start: cairo(60), spend: 400, purchases: 5 }];
    return [];
  };
  const h7 = await PP.getProductProfit({ productId: P.id, period: 'last7', deps: { fetchHistory: hist } });
  ok('last 7 days: only Yasser (whose first snapshot is today) needs history; Hady already has snapshots that old → not asked', calls.length === 1 && calls[0].adAccountId === YASSER && calls[0].from === cairo(6) && calls[0].to === cairo(1) && JSON.stringify(calls[0].campaignIds) === JSON.stringify(['pp_y1']), JSON.stringify(calls));
  ok('history merged: totals 1100 + 80 = 1180 spend, 10 + 2 = 12 orders; unlinked campaign and out-of-window rows ignored', h7.totals.spend === 1180 && h7.totals.orders === 12 && h7.history.historyDays === 1 && h7.history.incomplete.length === 0, JSON.stringify([h7.totals, h7.history]));
  ok('history lands in the right day and account', h7.daily.find((d) => d.date === cairo(3)).spend === 80 && h7.accounts.find((a) => a.id === YASSER).orders === 3 && h7.accounts.find((a) => a.id === YASSER).spend === 180, JSON.stringify(h7.accounts));
  calls.length = 0;
  const hAll = await PP.getProductProfit({ productId: P.id, period: 'all', deps: { fetchHistory: hist } });
  ok('all: asks every account for everything older than its first snapshot (from the 2025 floor)', calls.length === 2 && calls.every((c) => c.from === '2025-01-01') && calls.find((c) => c.adAccountId === HADY).to === cairo(41), JSON.stringify(calls));
  ok('all: the window now starts at the earliest day we hold (60 days ago from Meta), totals 3000 + 400 + 80 + 1 (the 50-days-ago row) = 3481 / 13 + 5 + 2 + 1 = 21', hAll.window.from === cairo(60) && hAll.dataStart === cairo(60) && hAll.totals.spend === 3481 && hAll.totals.orders === 21 && hAll.daily.length === 61, JSON.stringify([hAll.window, hAll.totals, hAll.daily.length]));
  const hFail = await PP.getProductProfit({ productId: P.id, period: 'last7', deps: { fetchHistory: async () => { throw new Error('boom'); } } });
  ok('a failed history read never breaks the card: snapshot totals stay (1100 / 10) and the account is reported as incomplete', hFail.totals.spend === 1100 && hFail.totals.orders === 10 && hFail.history.incomplete.length === 1, JSON.stringify([hFail.totals, hFail.history]));

  console.log('\n3. Honest unknowns');
  const P2 = await prisma.product.create({ data: { product_name: 'PP No Costs' } }); made.products.push(P2.id);
  const A2 = await prisma.ambProduct.create({ data: { product_id: P2.id, product_name: 'PP No Costs' } }); made.amb.push(A2.id); // cost 0 = the unset default
  await prisma.ambProductCampaignMap.create({ data: { amb_product_id: A2.id, ad_account_id: HADY, campaign_id: 'pp_n1', status: 'MAPPED' } });
  await snap(HADY, 'pp_n1', 250, 2, cairo(0));
  const n = await PP.getProductProfit({ productId: P2.id, period: 'last7' });
  ok('a product with no cost / price still gets spend / orders / CPA, but profit is UNKNOWN (never invented)', n.totals.spend === 250 && n.totals.orders === 2 && n.totals.cpa === 125 && n.economics.available === false && n.profit.estimated === null && n.profit.verdict === 'UNKNOWN' && !!n.economics.reason, JSON.stringify([n.totals, n.economics, n.profit]));
  const P3 = await prisma.product.create({ data: { product_name: 'PP No Campaigns' } }); made.products.push(P3.id);
  const none = await PP.getProductProfit({ productId: P3.id, period: 'last30' });
  ok('a product with no linked campaigns → zero totals, linkedCampaigns 0, no verdict invented', none.linkedCampaigns === 0 && none.totals.spend === 0 && none.totals.orders === 0 && none.totals.cpa === null && ['UNKNOWN', 'NO_DATA'].includes(none.profit.verdict), JSON.stringify([none.totals, none.profit]));
  let e = null; try { await PP.getProductProfit({ productId: P.id, period: 'last99' }); } catch (x) { e = x; }
  ok('an unknown period is refused (400)', e && e.status === 400);
  e = null; try { await PP.getProductProfit({ productId: 'abc', period: 'last7' }); } catch (x) { e = x; }
  ok('a bad product id is refused (400)', e && e.status === 400);
  e = null; try { await PP.getProductProfit({ productId: 99999999, period: 'last7' }); } catch (x) { e = x; }
  ok('a product that does not exist is a 404', e && e.status === 404);
  await prisma.metaConnection.update({ where: { id: conn.id }, data: { status: prevStatus } });
} finally {
  if (conn) await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: prevAcc ?? null } }).catch(() => {});
  await prisma.metaPerformanceSnapshot.deleteMany({ where: { campaign_id: { startsWith: 'pp_' } } }).catch(() => {});
  await prisma.ambSyncRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => {});
  if (made.job) await prisma.ambLaunchJob.delete({ where: { job_id: made.job.job_id } }).catch(() => {});
  for (const id of made.amb) await prisma.ambProduct.delete({ where: { id } }).catch(() => {});
  for (const id of made.products) await prisma.product.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
