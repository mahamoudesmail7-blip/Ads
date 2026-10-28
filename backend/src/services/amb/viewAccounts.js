// AI Media Buyer — VIEW accounts. The Home dashboard can be switched between the ad accounts the owner works with (Ahmed Samy / Hady / Yasser …) and shows the
// same picture for each one (KPIs, scale winners, products, decisions that exist for it).
//
// It is a VIEW only: the connected account (metaConnection.selected_ad_account_id) is untouched, so the executor, the AI Operator, every automation and every
// Meta write keep running on exactly the account they ran on before. A view account is read through a read-only sync (snapshotSync.runViewAccountSync).
import { getConnectionUnscoped as getConnection, getDecryptedToken } from '../metaAuth.js'; // always the stored (connected) account, never a request scope
import { getAdAccountInfo } from '../metaGraphClient.js';
import { getViewAccountIds, getAccountSyncInfo } from './snapshotSync.js';

/**
 * Resolves the optional ?account= of a Home request.
 * @returns {Promise<string|null>} null = the connected account (nothing to override); an act_… id = a validated VIEW account. Throws a clean 400 otherwise.
 */
export async function resolveViewAccountId(raw) {
  const id = String(raw || '').trim();
  if (!id) return null;
  const conn = await getConnection();
  if (conn?.selected_ad_account_id && id === conn.selected_ad_account_id) return null;
  if (!(await getViewAccountIds()).includes(id)) {
    const e = new Error('الحساب الإعلاني ده مش ضمن الحسابات المتاحة للعرض.');
    e.status = 400;
    throw e;
  }
  return id;
}

const NAME_CACHE = new Map(); // adAccountId -> { at, v } (Graph account info)

/** The switchable accounts, the connected one first, with real names (Graph, cached) and the last successful sync of each. */
export async function listViewAccounts() {
  const conn = await getConnection();
  const primaryId = conn?.selected_ad_account_id || null;
  const ids = await getViewAccountIds();
  if (primaryId && !ids.includes(primaryId)) ids.unshift(primaryId);

  // one light call per account (name + status), in parallel and cached 10 min — never the full accessible-accounts crawl, which made the Home page slow when Meta throttled
  const names = new Map();
  try {
    const token = await getDecryptedToken();
    await Promise.all(ids.map(async (id) => {
      const hit = NAME_CACHE.get(id);
      if (hit && Date.now() - hit.at < 10 * 60_000) { names.set(id, hit.v); return; }
      try { const v = await getAdAccountInfo(token, id); NAME_CACHE.set(id, { at: Date.now(), v }); names.set(id, v); } catch { if (hit) names.set(id, hit.v); /* else: name falls back to the stored / raw id */ }
    }));
  } catch { /* no token: the list must still be built */ }

  const accounts = [];
  for (const id of ids) {
    const info = await getAccountSyncInfo(id);
    const g = names.get(id);
    accounts.push({
      id,
      name: g?.name || (id === primaryId ? conn?.selected_ad_account_name : null) || id,
      isPrimary: id === primaryId,
      active: g ? Number(g.account_status) === 1 : null,
      lastSuccessAt: info.lastSuccessAt,
      lastRunStatus: info.lastRun?.status || null,
    });
  }
  accounts.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  return { primaryId, accounts };
}
