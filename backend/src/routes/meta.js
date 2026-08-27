// Meta Ads OAuth connect + sync — Facebook Login for Business
// (config_id-based), real Graph/Marketing API calls throughout. ADMIN-only,
// same tier as /api/settings — connecting a real ad-spend-visible business
// account is at least as sensitive as the system-config page.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { logger } from '../logger.js';
import * as metaAuth from '../services/metaAuth.js';
import * as metaGraph from '../services/metaGraphClient.js';
import { runSync } from '../services/metaSync.js';

// Every error thrown by metaAuth/metaGraphClient/metaSync already carries a
// clear, honest, user-facing Arabic message ("مفيش حساب متصل", "انتهت
// الصلاحية", a real Graph API error message, ...) — routes here must
// surface that message as a clean 400, not let it fall through to the
// generic "حصل خطأ في السيرفر" 500 the app-wide error handler gives every
// other uncaught error (that's a real bug this caught during testing: the
// honest reason was getting silently swallowed).
function metaRoute(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      logger.error('Meta Ads route error', { message: err.message, path: req.path });
      res.status(400).json({ error: 'META_ERROR', message: err.message });
    }
  };
}

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

const STATE_COOKIE = 'meta_oauth_state';
const IS_PROD = process.env.NODE_ENV === 'production';

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Starts the real OAuth dance — a redirect, not a fetch, since the browser must actually land on facebook.com for the user to log in themselves. buildAuthUrl() throws a clear error if META_APP_ID isn't configured yet — caught here and turned into an honest redirect-with-reason instead of a raw 500, same as every other failure mode in this flow. */
router.get(
  '/connect',
  asyncRoute(async (req, res) => {
    const frontendBase = process.env.FRONTEND_URL || '';
    const state = metaAuth.generateState();
    let authUrl;
    try {
      authUrl = metaAuth.buildAuthUrl(state); // throws if META_APP_ID isn't configured yet
    } catch (err) {
      return res.redirect(`${frontendBase}/ai-intelligence.html?${new URLSearchParams({ meta: 'error', reason: err.message }).toString()}`);
    }
    res.cookie(STATE_COOKIE, state, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.redirect(authUrl);
  })
);

/** Facebook redirects the user's browser here after they log in and grant/deny permissions — always ends in a redirect back to the frontend, success or failure, never a bare JSON error on a page navigation. */
router.get(
  '/callback',
  asyncRoute(async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;
    const frontendBase = process.env.FRONTEND_URL || '';
    const redirectTo = (params) => res.redirect(`${frontendBase}/ai-intelligence.html?${new URLSearchParams(params).toString()}`);

    if (error) return redirectTo({ meta: 'error', reason: errorDescription || error });

    const cookieState = req.cookies?.[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE);
    if (!code || !state || state !== cookieState) {
      return redirectTo({ meta: 'error', reason: 'طلب اتصال غير صالح — حاول تاني.' });
    }

    try {
      await metaAuth.completeOAuth({ code, connectedById: req.user.id });
      return redirectTo({ meta: 'connected' });
    } catch (err) {
      return redirectTo({ meta: 'error', reason: err.message });
    }
  })
);

router.get(
  '/status',
  metaRoute(async (req, res) => {
    res.json(await metaAuth.getStatus());
  })
);

/** Real businesses + every ad account reachable (personally-owned and business-owned), de-duplicated by id. */
router.get(
  '/ad-accounts',
  metaRoute(async (req, res) => {
    const token = await metaAuth.getDecryptedToken();
    const businesses = await metaGraph.getBusinesses(token);

    const byId = new Map();
    for (const a of await metaGraph.getAdAccounts(token)) {
      byId.set(a.id, { id: a.id, accountId: a.account_id, name: a.name, currency: a.currency, status: a.account_status, businessId: null, businessName: null });
    }
    for (const b of businesses) {
      for (const a of await metaGraph.getAdAccounts(token, b.id)) {
        byId.set(a.id, { id: a.id, accountId: a.account_id, name: a.name, currency: a.currency, status: a.account_status, businessId: b.id, businessName: b.name });
      }
    }

    res.json({ businesses, adAccounts: [...byId.values()] });
  })
);

router.post(
  '/select-ad-account',
  metaRoute(async (req, res) => {
    const { adAccountId, adAccountName, businessId, businessName } = req.body || {};
    if (!adAccountId) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'adAccountId مطلوب.' });
    const updated = await metaAuth.selectAdAccount({ adAccountId, adAccountName: adAccountName || null, businessId: businessId || null, businessName: businessName || null });
    res.json({ selected: true, adAccountId: updated.selected_ad_account_id, adAccountName: updated.selected_ad_account_name });
  })
);

/** Manual sync (spec explicit: a button, not a background job). Defaults to since-last-sync (or the last 7 days on a first sync) when no explicit range is given. */
router.post(
  '/sync',
  metaRoute(async (req, res) => {
    const { dateFrom, dateTo } = req.body || {};
    const connection = await metaAuth.getConnection();
    const today = new Date().toISOString().slice(0, 10);
    const from = dateFrom || (connection?.last_synced_at ? new Date(connection.last_synced_at).toISOString().slice(0, 10) : addDays(today, -7));
    const to = dateTo || today;
    const result = await runSync({ dateFrom: from, dateTo: to, triggeredById: req.user.id });
    res.json(result);
  })
);

router.post(
  '/disconnect',
  metaRoute(async (req, res) => {
    await metaAuth.disconnect();
    res.json({ disconnected: true });
  })
);

export default router;
