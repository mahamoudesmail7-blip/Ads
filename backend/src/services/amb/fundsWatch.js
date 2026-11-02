// Funds watch (owner request 2026-11-02): any ad account whose AVAILABLE prepaid balance is below the threshold (settings.ambLowFundsThreshold, default 2,000 EGP) raises a CRITICAL
// alert in the system — "this account has only X left, it may stop for lack of funds". READ ONLY (one cached Graph read per account, the same one the «نظرة سريعة» card uses).
//   · one alert per account (dedupeKey), re-raised at most every 6 hours while it stays low (a read alert reappears as a reminder);
//   · when the balance is back above the threshold the alert is marked read (resolved);
//   · accounts whose payment method is not a prepaid balance (a card) or whose balance can't be read are skipped — never guessed.
import { logger } from '../../logger.js';
import { prisma } from '../../prisma.js';
import { getDecryptedToken, getConnectionUnscoped } from '../metaAuth.js';
import { raiseAlert } from './alerts.js';
import { getAmbSettings } from './settings.js';
import { listViewAccounts } from './viewAccounts.js';
import { accountFunds, classifyFunds, spendingRecently as spendingRecentlyDb } from './accountsToday.js';

const REMIND_EVERY_MS = 6 * 3_600_000;
const WATCH_EVERY_MS = 15 * 60_000;
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

/**
 * @param {{ now?: Date, accounts?: {id:string,name?:string}[], getFunds?: (id:string)=>Promise<{available:number|null,currency:string,error?:any}>, threshold?: number }} [p] accounts/getFunds/threshold are injectable for tests
 * @returns {Promise<{ threshold:number, checked:object[] }>}
 */
export async function runFundsWatch({ now = new Date(), accounts = null, getFunds = null, threshold = null, reportOnly = null, recentSpend = null } = {}) {
  const settings = await getAmbSettings();
  const limit = threshold ?? (Number(settings.ambLowFundsThreshold) || 2000);
  // Report-only accounts are only alerted while they are actually spending (last 3 days): an idle watched account with an empty balance is not a problem.
  const watched = new Set((reportOnly ?? settings.ambReportOnlyAccountIds ?? []).map(String));
  const spendingRecently = recentSpend || ((id) => spendingRecentlyDb(id, now));
  const list = accounts || (await listViewAccounts()).accounts;
  let fetchFunds = getFunds;
  if (!fetchFunds) {
    const token = await getDecryptedToken();
    fetchFunds = (id) => accountFunds(token, id, false);
  }

  const checked = [];
  for (const a of list) {
    const f = await fetchFunds(a.id).catch((err) => ({ available: null, currency: 'EGP', error: err.message }));
    const name = a.name || a.id;
    const w = watched.has(a.id);
    const cls = classifyFunds({ funds: f, threshold: limit, watchedOnly: w, spendingRecently: w ? await spendingRecently(a.id) : true }); // the same rule as the card
    if (cls === 'UNKNOWN') { checked.push({ id: a.id, name, state: 'UNKNOWN' }); continue; }
    if (cls === 'IDLE') { checked.push({ id: a.id, name, state: 'IDLE', available: f.available }); continue; }
    const key = `funds:low:${a.id}`;
    const existing = await prisma.ambAlert.findUnique({ where: { dedupe_key: key } });

    if (cls === 'LOW') {
      const recent = existing && now.getTime() - new Date(existing.created_at).getTime() < REMIND_EVERY_MS;
      if (!recent) {
        await raiseAlert({
          severity: 'CRITICAL', category: 'FUNDS',
          title: `⚠️ فاند منخفض — ${name}`,
          message: `الحساب الإعلاني «${name}» رصيده المتاح ${fmt(f.available)} ج بس (أقل من ${fmt(limit)} ج) — ممكن الحساب يقف فاند. اشحنه قبل ما الإعلانات توقف.`,
          adAccountId: a.id, dedupeKey: key,
        });
      }
      checked.push({ id: a.id, name, state: 'LOW', available: f.available, raised: !recent });
    } else {
      if (existing && !existing.read) await prisma.ambAlert.update({ where: { id: existing.id }, data: { read: true } }); // back above the threshold: resolved
      checked.push({ id: a.id, name, state: 'OK', available: f.available, resolved: !!(existing && !existing.read) });
    }
  }
  return { threshold: limit, checked };
}

let timer = null;
/** Every 15 min (first pass ~90 s after boot). A failure never reaches the process. */
export function startFundsWatch() {
  if (timer) return;
  const tick = async () => {
    try {
      const conn = await getConnectionUnscoped();
      if (!conn || conn.status !== 'CONNECTED') return;
      const r = await runFundsWatch();
      const low = r.checked.filter((c) => c.state === 'LOW');
      if (low.length) logger.warn('[fundsWatch] low funds', { accounts: low.map((c) => `${c.name}:${c.available}`) });
    } catch (err) {
      logger.error('[fundsWatch] tick failed', { message: err.message });
    }
  };
  setTimeout(tick, 90_000).unref?.();
  timer = setInterval(tick, WATCH_EVERY_MS);
  timer.unref?.();
  logger.info('Funds watch started (15 min)');
}
