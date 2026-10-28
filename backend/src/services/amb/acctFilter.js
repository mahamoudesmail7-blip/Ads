// The ad account the running code is working for: the connected account, or — inside a request / scheduler pass scoped with metaAuth.accountScope — the chosen account.
// The AI Operator keeps its state (decisions, daily limits, plans) PER ACCOUNT: every daily limit, "stale decision" sweep and plan lookup is evaluated for ONE account only, so an
// action taken on Hady never counts against Ahmed Samy's limits (and vice versa).
import { getConnection } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';

/** The current account id (null when nothing is connected). */
export async function currentAccountId() {
  return (await getConnection())?.selected_ad_account_id || null;
}

/** `{ ad_account_id }` to spread into the `where` of a model that has that column ({} when nothing is connected). */
export async function acctWhere() {
  const id = await currentAccountId();
  return id ? { ad_account_id: id } : {};
}

/** where-fragment (put it in an AND array) limiting daily plans to the current account: plans of other accounts carry a "|A-<id>" key suffix, the connected account's plans have none. */
export async function planAcctWhere() {
  const c = await getConnection();
  return c?.scopedView ? { plan_key: { endsWith: `|A-${c.selected_ad_account_id}` } } : { NOT: { plan_key: { contains: '|A-' } } };
}

/**
 * Same idea for DASHBOARDS / lists (what the Operator screens show): inside another account's scope = that account only; for the connected account = everything EXCEPT the other switchable accounts' rows
 * (so a decision taken on Hady never shows up in Ahmed Samy's lists). Lenient on purpose: rows of an unknown account are still listed.
 */
export async function dashAcctWhere() {
  const c = await getConnection();
  if (!c?.selected_ad_account_id) return {};
  if (c.scopedView) return { ad_account_id: c.selected_ad_account_id };
  const others = ((await getAmbSettings()).ambViewAccountIds || []).filter((x) => x !== c.selected_ad_account_id);
  return others.length ? { ad_account_id: { notIn: others } } : {};
}
