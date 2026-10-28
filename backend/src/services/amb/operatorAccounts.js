// AI Operator on EVERY ad account (owner decision 2026-10-28: "كلهم زي بعض", every account has its OWN limits and plans).
//
// The connected account (Ahmed Samy) is processed exactly as before. When — and only when — settings.ambOperatorAllAccounts is ON, the schedulers ALSO run one pass per other switchable
// account (settings.ambViewAccountIds: Hady, Yasser…) inside that account's scope (metaAuth.accountScope), so:
//   · the rules / policies / limits VALUES are the same ones for every account (they are global config);
//   · every counter and sweep is evaluated for ONE account (acctFilter), so Hady's actions never use up Ahmed Samy's daily limits and vice versa;
//   · every account has its own OPEN / PAUSE daily plan (plan key suffix) and its own data-freshness gate (that account's read-only sync);
//   · all existing guards still apply (global mode, Emergency Stop, Meta write lock, permissions, per-product AUTOMATIC + READY, scope, central write gate).
// OFF by default: nothing about the other accounts changes until the owner switches it on.
import { logger } from '../../logger.js';
import { accountScope, getConnectionUnscoped } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { getViewAccountIds } from './snapshotSync.js';

/** The accounts (other than the connected one) the Operator should also run for — [] while the switch is OFF. */
export async function operatorExtraAccounts() {
  const settings = await getAmbSettings();
  if (settings.ambOperatorAllAccounts !== true) return [];
  const conn = await getConnectionUnscoped();
  if (!conn || conn.status !== 'CONNECTED') return [];
  return (await getViewAccountIds()).filter((id) => id !== conn.selected_ad_account_id);
}

/** Runs `fn(adAccountId)` once per extra account, sequentially, each inside that account's scope; one account failing never stops the next. Returns { [accountId]: result | { error } }. */
export async function forEachOperatorAccount(fn) {
  const out = {};
  for (const id of await operatorExtraAccounts()) {
    try { out[id] = await accountScope.run({ adAccountId: id }, () => fn(id)); }
    catch (err) { out[id] = { error: err.message }; logger.warn('[operator] extra-account pass failed', { adAccountId: id, message: err.message }); }
  }
  return out;
}
