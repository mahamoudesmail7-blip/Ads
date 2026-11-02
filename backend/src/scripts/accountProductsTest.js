// 🧪 «نظرة سريعة» → click an account → its products for the day (orders / spend / cost per order, best first). Product links come from LAUNCH + MAPPING only; unlinked campaigns are grouped
// by name family for DISPLAY only (source NAME). Isolated test database only.
//   node src/scripts/accountProductsTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const AP = await imp('../services/amb/accountProductsToday.js');

const PRIMARY = 'act_1518142859790043', HADY = 'act_877011384919552', YASSER = 'act_1370863561334304';
const todayCairo = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() + 3 * 3600e3 - 24 * 3600e3).toISOString().slice(0, 10);
let conn = null, prevAcc = null, prevStatus = null; const runIds = []; const made = { product: null, ambProduct: null, job: null };
try {
  console.log('\n1. nameFamily (display grouping only)');
  const fam = (n) => AP.nameFamily(n).label;
  ok('"Nail-clipper _ scale - 2" → Nail-clipper', fam('Nail-clipper _ scale - 2') === 'Nail-clipper', fam('Nail-clipper _ scale - 2'));
  ok('"nail-clipper-Test-talbaq" → nail-clipper', fam('nail-clipper-Test-talbaq') === 'nail-clipper');
  ok('"foot-file _ test talbq - 2" → foot-file', fam('foot-file _ test talbq - 2') === 'foot-file');
  ok('"Soleva - Test - 3" → Soleva', fam('Soleva - Test - 3') === 'Soleva');
  ok('"smart-ring-Scale-25/10" → smart-ring', fam('smart-ring-Scale-25/10') === 'smart-ring');
  ok('"Fawa7a - Mix - Carousel" → Fawa7a', fam('Fawa7a - Mix - Carousel') === 'Fawa7a');
  ok('"Massage-Roller- 7" → Massage-Roller (trailing number)', fam('Massage-Roller- 7') === 'Massage-Roller');
  ok('"Calm-Light- ph" → Calm-Light', fam('Calm-Light- ph') === 'Calm-Light');
  ok('same family, different case / spacing → the SAME key', AP.nameFamily('Nail-clipper - Test 2').key === AP.nameFamily('nail-clipper-Test 4').key);
  ok('a name with no marker stays whole; Arabic untouched; empty is safe', fam('massge جهاز الضغط') === 'massge جهاز الضغط' && fam('') === '' && fam('New Media thing') === 'New Media thing');

  console.log('\n2. Products of an account for the day');
  conn = await prisma.metaConnection.findFirst(); prevAcc = conn?.selected_ad_account_id; prevStatus = conn?.status;
  await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: PRIMARY, status: 'CONNECTED' } });
  const run = await prisma.ambSyncRun.create({ data: { trigger: 'VIEW', status: 'SUCCESS', ad_account_id: HADY, started_at: new Date(), finished_at: new Date() } }); runIds.push(run.id);
  const snap = (acc, cid, name, spend, purchases, date = todayCairo, snapshot_at = new Date()) => prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: run.id, ad_account_id: acc, level: 'campaign', date_start: date, date_stop: date, campaign_id: cid, campaign_name: name, campaign_status: 'ACTIVE', spend, meta_purchases: purchases, snapshot_at } });
  await snap(HADY, 'ap_n1', 'Nail-clipper - Test 1', 300, 3);
  await snap(HADY, 'ap_n2', 'nail-clipper-Test 2', 100, 1);
  await snap(HADY, 'ap_n2', 'nail-clipper-Test 2', 60, 0, todayCairo, new Date(Date.now() - 3600e3)); // older snapshot of the same campaign: ignored
  await snap(HADY, 'ap_f1', 'Fishingnet - Test', 80, 0);
  await snap(HADY, 'ap_s1', 'Soleva - Test', 90, 6);
  await snap(HADY, 'ap_m1', 'whatever name', 200, 2);       // mapped to a product by the owner
  await snap(HADY, 'ap_l1', 'launch campaign x', 150, 5);   // created by the launch wizard
  await snap(HADY, 'ap_old', 'Old - Test', 500, 9, yesterday); // another day: never counted
  await snap(YASSER, 'ap_y1', 'Soleva - Test', 40, 1);       // another account: never counted
  made.product = await prisma.product.create({ data: { product_name: 'AP Launch Product' } });
  made.ambProduct = await prisma.ambProduct.create({ data: { product_name: 'AP Mapped Product' } });
  await prisma.ambProductCampaignMap.create({ data: { amb_product_id: made.ambProduct.id, ad_account_id: HADY, campaign_id: 'ap_m1', status: 'MAPPED' } });
  made.job = await prisma.ambLaunchJob.create({ data: { job_id: 'ap-test-job', ad_account_id: HADY, budget_mode: 'CBO', config_json: '{}', product_id: made.product.id } });
  await prisma.ambLaunchCampaign.create({ data: { job_id: made.job.job_id, index: 0, name: 'launch campaign x', meta_campaign_id: 'ap_l1', status: 'COMPLETE' } });

  const r = await AP.getAccountProductsToday({ adAccountId: HADY });
  const names = r.products.map((p) => p.name);
  ok('best first: Soleva 6 orders, then the launch product 5, then Nail-clipper 4, then the mapped product 2', JSON.stringify(r.products.map((p) => [p.name, p.orders])) === JSON.stringify([['Soleva', 6], ['AP Launch Product', 5], ['Nail-clipper', 4], ['AP Mapped Product', 2]]), JSON.stringify(r.products.map((p) => [p.name, p.orders, p.source])));
  const nail = r.products.find((p) => p.name === 'Nail-clipper');
  ok('Nail-clipper = 2 campaigns, 400 spend (older snapshot ignored), cost per order 100', nail.campaigns === 2 && nail.spend === 400 && nail.cpa === 100, JSON.stringify(nail));
  ok('sources: LAUNCH for the wizard product, MAPPING for the mapped one, NAME for the family groups', r.products.find((p) => p.name === 'AP Launch Product').source === 'LAUNCH' && r.products.find((p) => p.name === 'AP Mapped Product').source === 'MAPPING' && nail.source === 'NAME');
  ok('a product with spend and NO orders is listed apart (Fishingnet 80), not among the winners', !names.includes('Fishingnet') && r.noOrders.length === 1 && r.noOrders[0].name === 'Fishingnet' && r.noOrders[0].spend === 80, JSON.stringify(r.noOrders));
  ok('totals = every campaign of the day on THIS account only (900 spend / 17 orders), yesterday and another account excluded', r.totals.spend === 920 && r.totals.orders === 17, JSON.stringify(r.totals));
  ok('order share adds up to ~100%', Math.abs(r.products.reduce((s, p) => s + p.orderShare, 0) - 100) < 0.1, String(r.products.reduce((s, p) => s + p.orderShare, 0)));
  const y = await AP.getAccountProductsToday({ adAccountId: YASSER });
  ok('another account sees only its own campaigns', y.products.length === 1 && y.products[0].orders === 1 && y.totals.spend === 40, JSON.stringify(y.totals));
  const past = await AP.getAccountProductsToday({ adAccountId: HADY, date: yesterday });
  ok('another day: only that day\'s rows', past.products.length === 1 && past.products[0].orders === 9);
  const none = await AP.getAccountProductsToday({ adAccountId: PRIMARY });
  ok('an account with nothing today → empty lists and null CPA, never a fabricated row', none.products.length === 0 && none.noOrders.length === 0 && none.totals.cpa === null);
  ok('a malformed date falls back to today', (await AP.getAccountProductsToday({ adAccountId: HADY, date: "2026-01-01';--" })).date === todayCairo);
  await prisma.metaConnection.update({ where: { id: conn.id }, data: { status: prevStatus } });
} finally {
  if (conn) await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: prevAcc ?? null } }).catch(() => {});
  await prisma.metaPerformanceSnapshot.deleteMany({ where: { campaign_id: { startsWith: 'ap_' } } }).catch(() => {});
  await prisma.ambSyncRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => {});
  if (made.job) await prisma.ambLaunchJob.delete({ where: { job_id: made.job.job_id } }).catch(() => {});
  if (made.ambProduct) await prisma.ambProduct.delete({ where: { id: made.ambProduct.id } }).catch(() => {});
  if (made.product) await prisma.product.delete({ where: { id: made.product.id } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
