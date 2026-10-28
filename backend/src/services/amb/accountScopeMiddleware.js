// AI Media Buyer — per-REQUEST ad-account scope. The owner works with several ad accounts (Ahmed Samy = the connected one, Hady, Yasser). The rest of the code reads
// "the ad account" from getConnection().selected_ad_account_id; this middleware makes that value the CHOSEN account for the duration of one request only
// (AsyncLocalStorage, see metaAuth.accountScope) — the stored connection, the executor/AI Operator/automation schedulers and every background job keep the connected account.
//
// Only the routes in SCOPED_PREFIXES follow the chosen account. The rest of AI Media Buyer keeps product-level state that spans accounts (Decision Center, product advisor, budget
// bumps, Operator…) and must never be computed from / persisted for a different account by accident, so a chosen account is ignored there (the screen says so).
import { accountScope } from '../metaAuth.js';
import { resolveViewAccountId } from './viewAccounts.js';

/** Route prefixes (inside /api/ai-media-buyer) that follow the chosen account. */
export const SCOPED_PREFIXES = ['/overview', '/hierarchy', '/winners', '/scale', '/recommendations', '/mapping', '/media-library', '/health', '/needs-attention', '/creative-analysis', '/sync'];
/** GET-only prefixes (their write routes are global product settings and stay unscoped). */
export const SCOPED_GET_PREFIXES = ['/products', '/product-images'];

const under = (p, x) => p === x || p.startsWith(x + '/');
export const isScopedRoute = (method, path) => SCOPED_PREFIXES.some((x) => under(path, x)) || (String(method).toUpperCase() === 'GET' && SCOPED_GET_PREFIXES.some((x) => under(path, x)));

/** For a router whose every route is account-bound (مركز التوسع): the chosen account applies to all of them. */
export async function ambAccountScopeAll(req, res, next) {
  try {
    const raw = req.get?.('x-amb-account') || req.query?.account || req.body?.account;
    if (!raw) return next();
    const id = await resolveViewAccountId(raw);
    if (!id) return next();
    return accountScope.run({ adAccountId: id }, () => next());
  } catch (e) {
    return next(e);
  }
}

/** The account the CURRENT request is scoped to (null = the connected account). */
export const currentScopedAccount = () => accountScope.getStore()?.adAccountId || null;

export async function ambAccountScope(req, res, next) {
  try {
    const raw = req.get?.('x-amb-account') || req.query?.account || req.body?.account;
    if (!raw || !isScopedRoute(req.method, req.path)) return next();
    const id = await resolveViewAccountId(raw); // 400 for an account that is not switchable — never a silent fallback to another account
    if (!id) return next();
    return accountScope.run({ adAccountId: id }, () => next());
  } catch (e) {
    return next(e);
  }
}
