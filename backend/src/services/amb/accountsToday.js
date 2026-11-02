// "نظرة سريعة" — every ad account side by side for ONE day: spend, orders (Meta-reported purchases), CPA and the account's funds, plus an overall total.
// READ ONLY. Spend/orders come from our own synced snapshots (the same numbers the AI Media Buyer Home shows for that account, up to one sync cycle old);
// funds are the only live Meta read (one light call per account, cached 5 min, a failure in one account never hides the others).
import { logger } from '../../logger.js';
import { getDecryptedToken } from '../metaAuth.js';
import { getAdAccountFunds } from '../metaGraphClient.js';
import { cachedMetaFetch } from '../metaAssetCache.js';
import { prisma } from '../../prisma.js';
import { loadSnapshots, latestPerDayPerEntity, aggregateRows, todayISO, addDaysISO } from './metricsEngine.js';
import { currencyFactor } from './snapshotSync.js';
import { listViewAccounts } from './viewAccounts.js';
import { getAmbSettings } from './settings.js';

const FUNDS_TTL_MS = 5 * 60_000;
/**
 * The prepaid "available balance" out of the payment-method line Meta shows ("Available Balance (EGP38,097.03)" / the Arabic wording), in the account currency.
 * null for anything that isn't such a line (a card, "Visa ••4242") — never a number guessed from an unrelated string.
 */
export function parseAvailableBalance(display) {
  if (typeof display !== 'string' || !/(available|balance|رصيد)/i.test(display)) return null;
  const s = display.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/٬/g, ',').replace(/٫/g, '.');
  const m = s.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
/** Has the account spent anything in the last 3 days (our synced snapshots)? An idle account with an empty balance is not a problem. */
export async function spendingRecently(adAccountId, now = new Date()) {
  const since = addDaysISO(todayISO(now), -3);
  return !!(await prisma.metaPerformanceSnapshot.findFirst({ where: { ad_account_id: adAccountId, spend: { gt: 0 }, date_start: { gte: since } }, select: { id: true } }));
}

/**
 * THE low-funds rule, shared by the funds watch (alerts) and the «نظرة سريعة» card so they can never disagree:
 * UNKNOWN (no readable EGP prepaid balance) · IDLE (a report-only account that isn't spending) · LOW (< threshold) · OK.
 */
export function classifyFunds({ funds, threshold, watchedOnly = false, spendingRecently: spending = true }) {
  if (!funds || funds.error || funds.available === null || funds.available === undefined || funds.currency !== 'EGP') return 'UNKNOWN';
  if (watchedOnly && !spending) return 'IDLE';
  return funds.available < threshold ? 'LOW' : 'OK';
}
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** One account's day from the snapshots: latest snapshot per campaign for that day, summed. Never a fabricated 0 for an account that has no rows (hasData=false). */
async function dayTotals(adAccountId, date) {
  const rows = await loadSnapshots({ level: 'campaign', from: date, to: date, adAccountId });
  const byCampaign = latestPerDayPerEntity(rows, 'campaign');
  let spend = 0, orders = 0, hasData = false, hasOrders = false, campaigns = 0;
  for (const days of byCampaign.values()) {
    const m = aggregateRows([...days.values()]);
    if (!m) continue;
    hasData = true;
    spend += m.spend || 0;
    if (m.purchases !== null) { orders += m.purchases; hasOrders = true; }
    if ((m.spend || 0) > 0) campaigns += 1;
  }
  return { hasData, spend, orders: hasOrders ? orders : 0, campaigns, cpa: orders > 0 ? spend / orders : null };
}

/** Funds of one account as the owner reads them: the payment-method line Meta shows (prepaid balance) when it gives one, else the outstanding balance. */
export async function accountFunds(token, adAccountId, force) {
  try {
    const f = await cachedMetaFetch(`accountFunds:${adAccountId}`, () => getAdAccountFunds(token, adAccountId), { ttlMs: FUNDS_TTL_MS, force });
    const factor = currencyFactor(f.currency);
    const balance = num(f.balance);
    const spendCap = num(f.spend_cap);
    return {
      currency: f.currency || 'EGP',
      display: f.funding_source_details?.display_string || null, // e.g. the prepaid "available balance" line, exactly as Meta words it
      available: parseAvailableBalance(f.funding_source_details?.display_string), // that line's number (EGP), null when it isn't a prepaid-balance line
      isPrepay: f.is_prepay_account === true ? true : f.is_prepay_account === false ? false : null,
      balance: balance === null ? null : balance / factor, // outstanding bills (postpaid) — NOT the prepaid available balance
      spendCap: spendCap && spendCap > 0 ? spendCap / factor : null,
      error: null,
    };
  } catch (err) {
    logger.warn('[accountsToday] funds read failed', { adAccountId, message: err.message });
    return { currency: 'EGP', display: null, available: null, isPrepay: null, balance: null, spendCap: null, error: err.message };
  }
}

/**
 * @param {{ date?: string, force?: boolean }} p  date = YYYY-MM-DD (default: today, Cairo)
 */
export async function getAccountsToday({ date = null, force = false } = {}) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : todayISO();
  const { accounts } = await listViewAccounts();
  let token = null;
  try { token = await getDecryptedToken(); } catch { /* funds stay "unavailable"; spend/orders still show */ }

  const out = await Promise.all(accounts.map(async (a) => {
    const [t, funds] = await Promise.all([
      dayTotals(a.id, day).catch((err) => { logger.warn('[accountsToday] totals failed', { adAccountId: a.id, message: err.message }); return null; }),
      token ? accountFunds(token, a.id, force) : Promise.resolve({ currency: 'EGP', display: null, available: null, isPrepay: null, balance: null, spendCap: null, error: 'NO_TOKEN' }),
    ]);
    return {
      id: a.id, name: a.name, isPrimary: a.isPrimary, active: a.active,
      lastSyncAt: a.lastSuccessAt || null,
      hasData: t?.hasData || false,
      spend: t?.spend ?? null, orders: t?.orders ?? null, cpa: t?.cpa ?? null, activeCampaigns: t?.campaigns ?? 0,
      funds,
    };
  }));

  let spend = 0, orders = 0;
  for (const a of out) { spend += a.spend || 0; orders += a.orders || 0; }
  const threshold = Number((await getAmbSettings()).ambLowFundsThreshold) || 2000;
  const watched = new Set(((await getAmbSettings()).ambReportOnlyAccountIds || []).map(String));
  for (const a of out) { // the SAME rule the funds watch alerts on (classifyFunds), so the card and the alert always agree
    const w = watched.has(a.id);
    a.funds.low = classifyFunds({ funds: a.funds, threshold, watchedOnly: w, spendingRecently: w ? await spendingRecently(a.id) : true }) === 'LOW';
  }
  return {
    date: day,
    lowFundsThreshold: threshold,
    accounts: out,
    total: { spend, orders, cpa: orders > 0 ? spend / orders : null },
    note: 'الأوردرات = مشتريات Meta (Purchases) لكل حساب، محسوبة من آخر مزامنة (كل 15 دقيقة).',
  };
}
