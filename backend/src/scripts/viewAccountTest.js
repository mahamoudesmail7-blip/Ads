// 🧪 Home account switcher (VIEW only): an account other than the connected one can be viewed (overview / scale winners / recommendations read ITS snapshots), while
// the connected account's sync freshness, the validation of ?account= and the guards of the read-only sync stay exactly as strict as before. Isolated test database only.
//   node src/scripts/viewAccountTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const V = await imp('../services/amb/viewAccounts.js');
const S = await imp('../services/amb/snapshotSync.js');
const OV = await imp('../services/amb/overview.js');
const SW = await imp('../services/amb/scaleWinners.js');
const RE = await imp('../services/amb/recommendationEngine.js');
const settingsMod = await imp('../services/amb/settings.js');

const PRIMARY = 'act_1518142859790043', HADY = 'act_877011384919552', YASSER = 'act_1370863561334304', STRANGER = 'act_999000111222333';
let conn = null, prevAcc = null; const runIds = [];
const todayCairo = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
try {
  conn = await prisma.metaConnection.findFirst(); prevAcc = conn?.selected_ad_account_id; const prevStatus = conn?.status;
  await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: PRIMARY, status: 'CONNECTED' } });

  console.log('\n1. The default list is Ahmed Samy / Hady / Yasser, and ?account= is validated');
  const ids = await S.getViewAccountIds();
  ok('default view accounts = the three New Media 2 accounts', ids.length === 3 && ids.includes(PRIMARY) && ids.includes(HADY) && ids.includes(YASSER), ids.join(','));
  ok('no ?account= → the connected account (null, nothing overridden)', (await V.resolveViewAccountId('')) === null && (await V.resolveViewAccountId(undefined)) === null);
  ok('?account= = the connected account → null (not a "view" at all)', (await V.resolveViewAccountId(PRIMARY)) === null);
  ok('?account= = Hady → Hady', (await V.resolveViewAccountId(HADY)) === HADY);
  let err = null; try { await V.resolveViewAccountId(STRANGER); } catch (e) { err = e; }
  ok('an account outside the list is refused with a 400 (never a silent fallback)', err && err.status === 400, err?.message);
  err = null; try { await V.resolveViewAccountId("act_1';drop table x;--"); } catch (e) { err = e; }
  ok('a malformed id is refused too', err && err.status === 400);

  console.log('\n2. Read-only sync guards (nothing is fetched / written for these)');
  const g1 = await S.runViewAccountSync(STRANGER, { force: true });
  ok('an account outside the list → NOT_A_VIEW_ACCOUNT', g1.ok === false && g1.error === 'NOT_A_VIEW_ACCOUNT', JSON.stringify(g1));
  const g2 = await S.runViewAccountSync(PRIMARY, { force: true });
  ok('the connected account has its own full cycle → skipped PRIMARY_ACCOUNT', g2.ok === true && g2.skipped === 'PRIMARY_ACCOUNT', JSON.stringify(g2));
  const g3 = await S.runViewAccountSync(HADY, { now: new Date() }).catch((e) => ({ threw: e.message }));
  ok('a fresh-enough view account is not re-synced (FRESH) — here no run exists yet, so it tries and fails on the missing token instead of skipping', g3.threw || g3.ok === false || g3.skipped === 'FRESH', JSON.stringify(g3));
  await prisma.ambSyncRun.deleteMany({ where: { ad_account_id: HADY, trigger: 'VIEW', status: 'FAILED' } }); // the failed attempt of the line above (test db has no real token)

  console.log('\n3. VIEW sync runs never masquerade as the connected account\'s sync');
  const old = await prisma.ambSyncRun.create({ data: { trigger: 'MANUAL', status: 'SUCCESS', ad_account_id: PRIMARY, started_at: new Date(Date.now() - 3600e3), finished_at: new Date(Date.now() - 3600e3) } }); runIds.push(old.id);
  const viewRun = await prisma.ambSyncRun.create({ data: { trigger: 'VIEW', status: 'SUCCESS', ad_account_id: HADY, started_at: new Date(), finished_at: new Date() } }); runIds.push(viewRun.id);
  const st = await S.getSyncStatus();
  ok('getSyncStatus().lastSuccessAt is the connected account\'s run (1h ago), not the newer VIEW run', st.lastSuccessAt && Math.abs(new Date(st.lastSuccessAt).getTime() - old.finished_at.getTime()) < 2000, JSON.stringify(st.lastSuccessAt));
  ok('getSyncStatus().lastRun is not a VIEW run', st.lastRun && st.lastRun.trigger !== 'VIEW', JSON.stringify(st.lastRun));
  const hi = await S.getAccountSyncInfo(HADY);
  ok('the per-account info does see Hady\'s VIEW run', hi.lastSuccessAt && new Date(hi.lastSuccessAt).getTime() > Date.now() - 60_000 && hi.lastRun.trigger === 'VIEW', JSON.stringify(hi.lastRun));

  console.log('\n4. Overview / scale winners / recommendations read the VIEWED account only');
  const snap = (acc, cid, spend, purchases, extra = {}) => prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: viewRun.id, ad_account_id: acc, level: 'campaign', date_start: todayCairo, date_stop: todayCairo, campaign_id: cid, campaign_name: `vt ${cid}`, campaign_status: 'ACTIVE', spend, meta_purchases: purchases, campaign_budget: 300, campaign_budget_type: 'DAILY', ...extra } });
  await snap(HADY, 'vt_hady_1', 210, 3);   // CPA 70 → a scale winner
  await snap(HADY, 'vt_hady_2', 100, 0);
  await snap(YASSER, 'vt_yasser_1', 55, 1);
  const base = await OV.getOverview({ windowName: 'today' });
  const hady = await OV.getOverview({ windowName: 'today', adAccountId: HADY, syncStatusOverride: hi });
  const yas = await OV.getOverview({ windowName: 'today', adAccountId: YASSER });
  ok('Hady overview = 310 spend / 3 orders', hady.connected && hady.kpis.spend === 310 && hady.kpis.orders === 3, JSON.stringify(hady.kpis));
  ok('Yasser overview = 55 spend / 1 order (no Hady rows leak in)', yas.kpis.spend === 55 && yas.kpis.orders === 1, JSON.stringify(yas.kpis));
  ok('the connected account\'s overview does not include Hady\'s or Yasser\'s rows', !(base.kpis.spend === 310 || base.kpis.spend === 365), JSON.stringify(base.kpis));
  ok('the overview shows the sync info of the VIEWED account (syncStatusOverride)', hady.syncStatus === hi);
  const sw = await SW.listScaleWinners({ windowName: 'today', adAccountId: HADY });
  ok('scale winners for Hady: the CPA 70 / 3 orders campaign is a card, the 0-order one is not', sw.cards.some((c) => c.sourceCampaignId === 'vt_hady_1' && c.orders === 3) && !sw.cards.some((c) => c.sourceCampaignId === 'vt_hady_2'), JSON.stringify(sw.cards.map((c) => c.sourceCampaignId)));
  const swYas = await SW.listScaleWinners({ windowName: 'today', adAccountId: YASSER });
  ok('scale winners for Yasser never contain Hady\'s campaign', !swYas.cards.some((c) => c.sourceCampaignId === 'vt_hady_1'));
  const recs = await RE.getCurrentRecommendations({ adAccountId: HADY });
  ok('recommendations of a view account: ok, empty (none are generated for it), no Meta reconcile attempted', recs.ok === true && Array.isArray(recs.active) && recs.active.length === 0, JSON.stringify(recs).slice(0, 200));

  console.log('\n5. The switcher list');
  const orig = V.listViewAccounts; // Graph is unreachable in the test db → names fall back, the list must still be built
  const list = await V.listViewAccounts();
  ok('lists all three, the connected one first and flagged', list.primaryId === PRIMARY && list.accounts.length === 3 && list.accounts[0].id === PRIMARY && list.accounts[0].isPrimary && list.accounts.filter((a) => a.isPrimary).length === 1, JSON.stringify(list.accounts.map((a) => a.id)));
  ok('Hady\'s last sync comes from its VIEW run', list.accounts.find((a) => a.id === HADY)?.lastSuccessAt != null);
  ok('a custom list in settings is honoured (and nothing else is)', await (async () => { const saved = (await prisma.settings.findUnique({ where: { id: 'default' } }))?.data; try { await settingsMod.saveAmbSettings({ ambViewAccountIds: [HADY, 'not-an-id'] }); const x = await S.getViewAccountIds(); return x.length === 1 && x[0] === HADY; } finally { if (saved !== undefined) await prisma.settings.update({ where: { id: 'default' }, data: { data: saved } }); } })());
  void orig;
  await prisma.metaConnection.update({ where: { id: conn.id }, data: { status: prevStatus } });
} finally {
  if (conn) await prisma.metaConnection.update({ where: { id: conn.id }, data: { selected_ad_account_id: prevAcc ?? null } }).catch(() => {});
  await prisma.metaPerformanceSnapshot.deleteMany({ where: { campaign_id: { startsWith: 'vt_' } } }).catch(() => {});
  await prisma.ambSyncRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => {});
  await prisma.ambSyncRun.deleteMany({ where: { trigger: 'VIEW', ad_account_id: { in: [HADY, YASSER] } } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
