// metaGraphClient.js — thin wrapper around the real Meta Graph/Marketing
// API. No SDK dependency (matches this backend's existing "raw fetch, no
// extra HTTP client library" convention — see services/ai.js). Every
// function here makes a real network call; nothing in this file ever
// fabricates a response.
import { logger } from '../logger.js';

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Meta's error body is {error: {message, type, code, error_subcode,
 * fbtrace_id}} — type/code/error_subcode/fbtrace_id are Meta's own public
 * diagnostic identifiers (documented at developers.facebook.com/docs/
 * graph-api/guides/error-handling), never secrets, and are exactly what
 * Meta's own support asks for when reporting an OAuth issue. Logged
 * server-side in full, and attached to the thrown Error so the route can
 * surface the safe subset to the user — without ever touching
 * client_id/client_secret/code/token, which never appear in this object.
 */
function throwGraphOAuthError(data, res, context) {
  const e = data?.error || {};
  // error_user_title / error_user_msg carry Meta's human-facing reason for a
  // generic "Invalid parameter"; error_data.blame_field_specs names the exact
  // field. All are public diagnostics, not secrets.
  const userTitle = e.error_user_title ?? null;
  const userMsg = e.error_user_msg ?? null;
  const blameFields = e.error_data?.blame_field_specs ?? e.error_data?.blame_fields ?? null;
  logger.error(`Meta OAuth ${context} failed`, {
    status: res.status,
    errorType: e.type ?? null,
    errorCode: e.code ?? null,
    errorSubcode: e.error_subcode ?? null,
    message: e.message ?? null,
    userTitle,
    userMsg,
    blameFields,
    fbtraceId: e.fbtrace_id ?? null,
  });
  const detail = userMsg || userTitle ? ` — ${[userTitle, userMsg].filter(Boolean).join(': ')}` : '';
  const err = new Error((e.message || `Graph API error ${res.status}`) + detail);
  err.graphStatus = res.status;
  err.graphType = e.type ?? null;
  err.graphCode = e.code ?? null;
  err.graphSubcode = e.error_subcode ?? null;
  err.graphUserTitle = userTitle;
  err.graphUserMsg = userMsg;
  err.graphBlameFields = blameFields;
  err.fbtraceId = e.fbtrace_id ?? null;
  throw err;
}

export async function graphFetch(path, params, token) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  url.searchParams.set('access_token', token);

  const res = await fetch(url.toString());
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throwGraphOAuthError(data, res, `${path} call`);
  }
  return data;
}

/** Exchanges a real OAuth "code" (from the callback redirect) for a short-lived user access token. No access_token param on this call — the code itself is the credential. */
export async function exchangeCodeForToken({ code, appId, appSecret, redirectUri }) {
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code);
  const res = await fetch(url.toString());
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) throwGraphOAuthError(data, res, 'code->token exchange');
  return data; // {access_token, token_type, expires_in}
}

/** Exchanges a short-lived token for a long-lived one (~60 days) — a second real Graph API call, not a local extension of the expiry. */
export async function exchangeForLongLivedToken({ shortLivedToken, appId, appSecret }) {
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', shortLivedToken);
  const res = await fetch(url.toString());
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) throwGraphOAuthError(data, res, 'long-lived token exchange');
  return data; // {access_token, token_type, expires_in}
}

export async function getMe(token) {
  return graphFetch('/me', { fields: 'id,name' }, token);
}

export async function getBusinesses(token) {
  const data = await graphFetch('/me/businesses', { fields: 'id,name', limit: 100 }, token);
  return data.data || [];
}

/** Ad accounts owned by a specific Business Manager, or (no businessId) every ad account the logged-in user personally has access to. */
export async function getAdAccounts(token, businessId) {
  const path = businessId ? `/${businessId}/owned_ad_accounts` : '/me/adaccounts';
  const data = await graphFetch(path, { fields: 'id,account_id,name,currency,account_status', limit: 100 }, token);
  return data.data || [];
}

/**
 * The token's real granted scopes + granular targeting. Meta's Business Login
 * lets a user grant `business_management` (and other business-scoped perms)
 * for a CHOSEN SUBSET of their Business Portfolios — `granular_scopes[].
 * target_ids` lists exactly which. This is why one token can see Business A
 * but not Business B even though the user admins both: the grant was narrowed
 * at consent time. Returns `{ scopes:[], granular:{scope:[target_ids]}, appId }`.
 */
export async function getTokenDebug(token) {
  const d = await graphGetQuiet('/debug_token', { input_token: token }, token);
  const data = d?.data || {};
  const granular = {};
  for (const g of data.granular_scopes || []) granular[g.scope] = g.target_ids || null; // null ⇒ all
  return {
    appId: data.app_id || null,
    type: data.type || null,
    isValid: !!data.is_valid,
    expiresAt: data.expires_at ? new Date(data.expires_at * 1000).toISOString() : null,
    dataAccessExpiresAt: data.data_access_expires_at ? new Date(data.data_access_expires_at * 1000).toISOString() : null,
    scopes: data.scopes || [],
    granular, // { business_management: ['<biz id>', ...] | null, ... }
  };
}

/**
 * Every Business Portfolio the token can actually see, each with its
 * accessible ad accounts / Pages / Instagram identities / Pixels, plus a
 * synthetic bucket for ad accounts shared with the user individually (no
 * enumerable parent Business). Per-portfolio status:
 *   CONNECTED           — assets readable
 *   MISSING_PERMISSIONS — a page/pixel edge returned a permission error
 *   NEEDS_RECONNECT     — business_management was granted but NOT for this
 *                         portfolio (granular target list excludes it), or the
 *                         portfolio itself can't be read
 * READ ONLY. Best-effort per edge — a gap is reported, never silently assumed.
 */
export async function getBusinessPortfolios(token) {
  const me = await graphFetch('/me', { fields: 'id,name' }, token);
  const dbg = await getTokenDebug(token);
  const bmTargets = dbg.granular.business_management; // array of biz ids, or null = all, or undefined = not granular

  // Businesses the user is a member of.
  let businesses = [];
  try {
    businesses = (await graphFetch('/me/businesses', { fields: 'id,name,verification_status', limit: 100 }, token)).data || [];
  } catch { /* none */ }

  // The Facebook Pages the connected USER personally manages (from the FB
  // account itself, not any Business Portfolio) + their linked Instagram.
  const userIdent = await getUserPagesAndIg(token).catch(() => ({ pages: [], instagram: [], readable: false }));
  const userPages = (userIdent.pages || []).map((p) => ({ id: p.id, name: p.name }));
  const userInstagram = (userIdent.instagram || []).map((g) => ({ id: g.id, name: g.username || g.id }));

  // Every ad account reachable + which have an enumerable business parent.
  let allAccts = [];
  try {
    allAccts = (await graphFetch('/me/adaccounts', {
      fields: 'id,account_id,name,currency,account_status,timezone_name,business{id,name}', limit: 300,
    }, token)).data || [];
  } catch { /* none */ }

  const acctByBiz = new Map(); // bizId -> [acct]
  const orphanAccts = [];
  for (const a of allAccts) {
    const row = {
      id: a.id, accountId: a.account_id, name: a.name || a.id, currency: a.currency || null,
      accountStatus: a.account_status ?? null, timezoneName: a.timezone_name || null,
      businessId: a.business?.id || null, businessName: a.business?.name || null,
    };
    if (a.business?.id) {
      if (!acctByBiz.has(a.business.id)) acctByBiz.set(a.business.id, []);
      acctByBiz.get(a.business.id).push(row);
    } else {
      orphanAccts.push(row);
    }
  }

  async function bizAssets(bizId) {
    const [ownedAcc, clientAcc, pages, clientPages, pixels, ig] = await Promise.all([
      graphListQuiet(`/${bizId}/owned_ad_accounts`, { fields: 'id,account_id,name,currency,account_status,timezone_name' }, token),
      graphListQuiet(`/${bizId}/client_ad_accounts`, { fields: 'id,account_id,name,currency,account_status,timezone_name' }, token),
      graphListQuiet(`/${bizId}/owned_pages`, { fields: 'id,name' }, token),
      graphListQuiet(`/${bizId}/client_pages`, { fields: 'id,name' }, token),
      graphListQuiet(`/${bizId}/adspixels`, { fields: 'id,name' }, token),
      graphListQuiet(`/${bizId}/instagram_accounts`, { fields: 'id,username' }, token),
    ]);
    return { ownedAcc, clientAcc, pages: [...(pages || []), ...(clientPages || [])], pixels: pixels || [], ig: ig || [] };
  }

  const out = [];
  for (const b of businesses) {
    const notInGrant = Array.isArray(bmTargets) && !bmTargets.includes(String(b.id));
    let assets = { ownedAcc: [], clientAcc: [], pages: [], pixels: [], ig: [] };
    if (!notInGrant) { try { assets = await bizAssets(b.id); } catch { /* keep empty */ } }
    const acctMap = new Map();
    for (const a of [...(acctByBiz.get(b.id) || []), ...(assets.ownedAcc || []), ...(assets.clientAcc || [])]) {
      acctMap.set(a.id, {
        id: a.id, accountId: a.account_id || a.accountId, name: a.name || a.id,
        currency: a.currency || null, accountStatus: a.account_status ?? a.accountStatus ?? null,
        timezoneName: a.timezone_name || a.timezoneName || null, businessId: b.id, businessName: b.name,
      });
    }
    // Pages/Instagram shown for a portfolio = the user's OWN FB/IG accounts
    // first, then whatever the Business Portfolio owns.
    const pages = dedupById([...userPages, ...assets.pages]);
    const pixels = dedupById(assets.pixels);
    const ig = dedupById([...userInstagram, ...(assets.ig || []).map((g) => ({ id: g.id, name: g.username || g.id }))]);
    const status = notInGrant ? 'NEEDS_RECONNECT'
      : (!pages.length && !pixels.length && !acctMap.size) ? 'MISSING_PERMISSIONS'
      : 'CONNECTED';
    out.push({
      id: b.id, name: (b.name || '').trim() || b.id, verificationStatus: b.verification_status || null,
      inTokenGrant: !notInGrant,
      status,
      adAccounts: [...acctMap.values()],
      pages, instagram: ig, pixels,
    });
  }

  if (orphanAccts.length) {
    out.push({
      id: null, name: 'حسابات مشارَكة بشكل فردي (خارج Business Portfolio)',
      verificationStatus: null, inTokenGrant: true,
      status: 'CONNECTED',
      adAccounts: orphanAccts,
      pages: dedupById(userPages), instagram: dedupById(userInstagram), pixels: [],
      note: 'الحسابات دي اتشاركت مع المستخدم كأفراد. الصفحات وحسابات انستجرام هنا مسحوبة من حساب فيسبوك نفسه (اللي بتديره)، مش من Business Portfolio.',
    });
  }

  return {
    connectedUser: { id: me.id, name: me.name },
    token: {
      scopes: dbg.scopes,
      businessManagementTargets: bmTargets === undefined ? 'NOT_GRANTED' : (bmTargets === null ? 'ALL' : bmTargets),
      expiresAt: dbg.expiresAt,
      dataAccessExpiresAt: dbg.dataAccessExpiresAt,
      canListUserPages: !!userIdent.readable && userPages.length > 0,
    },
    // Pages/Instagram pulled from the connected Facebook account itself
    // (/me/accounts) — independent of any Business Portfolio.
    userPages,
    userInstagram,
    businesses: out,
  };
}

function dedupById(arr) {
  const m = new Map();
  for (const x of arr || []) if (x && x.id && !m.has(x.id)) m.set(x.id, { id: x.id, name: x.name || x.username || x.id });
  return [...m.values()];
}

/** Real campaign objectives — needed to interpret which `actions` entry actually represents this campaign's "Results" (Meta's UI concept, not a single fixed field in the API). */
export async function getCampaignObjectives(token, adAccountId) {
  const data = await graphFetch(`/${adAccountId}/campaigns`, { fields: 'id,objective', limit: 500 }, token);
  const map = new Map();
  for (const c of data.data || []) map.set(c.id, c.objective);
  return map;
}

/** Real daily, ad-level Insights for a date range — spend/impressions/reach/clicks/ctr/cpc/cpm/actions, one row per (ad, day). Follows real pagination (paging.next) rather than silently truncating. */
export async function getInsights(token, adAccountId, dateFrom, dateTo) {
  const fields = [
    'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
    'spend', 'impressions', 'reach', 'frequency', 'clicks', 'ctr', 'cpc', 'cpm',
    'actions', 'action_values', 'cost_per_action_type', 'purchase_roas', 'date_start', 'date_stop',
  ].join(',');

  let url = `${GRAPH_BASE}/${adAccountId}/insights`;
  let params = {
    level: 'ad',
    time_increment: 1,
    time_range: { since: dateFrom, until: dateTo },
    fields,
    limit: 500,
    access_token: token,
  };

  const rows = [];
  let next = null;
  do {
    const target = next || (() => {
      const u = new URL(url);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      return u.toString();
    })();
    const res = await fetch(target);
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) throw new Error(data?.error?.message || `Graph API error ${res.status}`);
    rows.push(...(data.data || []));
    next = data.paging?.next || null;
  } while (next);

  return rows;
}

/**
 * Real Meta Ad Library API (/ads_archive) — used by
 * services/searchProviders/metaAdLibraryProvider.js. Requires an access
 * token with ads_read (already requested by this app's existing Meta OAuth
 * scopes). Meta's own documented, real limitation: full-text keyword
 * search across ALL commercial advertisers is only unrestricted in regions
 * covered by the EU's DSA transparency rules — for most other countries
 * (Egypt included) a commercial-ads search commonly comes back empty or
 * error-restricted even with a valid token. That's Meta's own API
 * behavior, not a bug here — the caller (metaAdLibraryProvider.js) treats
 * an empty/restricted response as "try the fallback provider", never as a
 * reason to fabricate a result.
 */
export async function searchAdLibrary(token, { searchTerms, countries, limit = 25 }) {
  const fields = [
    'id', 'ad_creation_time', 'ad_creative_bodies', 'ad_creative_link_titles',
    'ad_creative_link_descriptions', 'ad_creative_link_captions',
    'ad_delivery_start_time', 'ad_delivery_stop_time', 'ad_snapshot_url',
    'page_id', 'page_name', 'publisher_platforms',
  ].join(',');
  const data = await graphFetch('/ads_archive', {
    search_terms: searchTerms,
    ad_reached_countries: countries,
    ad_active_status: 'ALL',
    ad_type: 'ALL',
    fields,
    limit,
  }, token);
  return data.data || [];
}

// ============================================================================
// AI Media Buyer additions. Read helpers for multi-level insights + entity
// metadata/budgets, and a tightly-scoped set of WRITE helpers used only by
// the AI Media Buyer execution layer (services/amb/executor.js) AFTER owner
// approval + a deterministic rule-engine pass + a pre-execute revalidation.
// Nothing here is ever called directly from a Claude response.
// ============================================================================

/** Real ad-account currency/timezone/name — needed to convert Meta's minor-unit budgets to EGP and back. */
export async function getAdAccountInfo(token, adAccountId) {
  return graphFetch(`/${adAccountId}`, { fields: 'id,account_id,name,currency,timezone_name,account_status' }, token);
}

/**
 * Daily Insights at an explicit level (campaign | adset | ad) for a date
 * range — same field set + real pagination as getInsights(), plus the id/
 * name columns for every level so a snapshot row is self-describing.
 */
export async function getInsightsByLevel(token, adAccountId, level, dateFrom, dateTo) {
  const fields = [
    'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
    'spend', 'impressions', 'reach', 'frequency', 'clicks', 'ctr', 'cpc', 'cpm',
    'actions', 'action_values', 'cost_per_action_type', 'purchase_roas', 'date_start', 'date_stop',
  ].join(',');

  let params = {
    level,
    time_increment: 1,
    time_range: { since: dateFrom, until: dateTo },
    fields,
    limit: 500,
    access_token: token,
  };
  const base = `${GRAPH_BASE}/${adAccountId}/insights`;

  const rows = [];
  let next = null;
  do {
    const target = next || (() => {
      const u = new URL(base);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      return u.toString();
    })();
    const res = await fetch(target);
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) throwGraphOAuthError(data, res, `insights(level=${level})`);
    rows.push(...(data.data || []));
    next = data.paging?.next || null;
  } while (next);

  return rows;
}

/**
 * Low-noise GET — a plain fetch that returns `null` on any error instead of
 * logging at ERROR + throwing. For best-effort probes (clone pre-flight asset
 * checks, "is this video downloadable") where a permission/existence failure
 * is an EXPECTED, information-carrying outcome, not a fault.
 */
export async function graphGetQuiet(path, params, token) {
  try {
    const url = new URL(`${GRAPH_BASE}${path}`);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    url.searchParams.set('access_token', token);
    const res = await fetch(url.toString());
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) return null;
    return data;
  } catch { return null; }
}

/** Like graphGetQuiet but follows paging.next and concatenates `data`. Returns [] on any error. */
async function graphListQuiet(path, params, token) {
  const rows = [];
  const first = await graphGetQuiet(path, { ...params, limit: 200 }, token);
  if (!first) return [];
  rows.push(...(first.data || []));
  let next = first.paging?.next || null;
  let guard = 0;
  while (next && guard++ < 20) {
    try {
      const res = await fetch(next);
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.error) break;
      rows.push(...(data.data || []));
      next = data.paging?.next || null;
    } catch { break; }
  }
  return rows;
}

/** Paginated GET of a node's edge (e.g. /act_x/campaigns) returning every page's `data` concatenated. */
export async function graphList(path, params, token) {
  const rows = [];
  let url = new URL(`${GRAPH_BASE}${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  url.searchParams.set('access_token', token);
  url.searchParams.set('limit', '500');
  let target = url.toString();
  do {
    const res = await fetch(target);
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) throwGraphOAuthError(data, res, `list ${path}`);
    rows.push(...(data.data || []));
    target = data.paging?.next || null;
  } while (target);
  return rows;
}

/**
 * Live entity metadata for a level: effective_status (real delivery state),
 * plus the budget fields that live at that level (campaign CBO budget, or
 * adset ABO budget). Budgets come back as Meta minor-unit STRINGS — the
 * caller converts using the account currency.
 */
export async function getEntitiesMeta(token, adAccountId, level) {
  if (level === 'campaign') {
    return graphList(`/${adAccountId}/campaigns`, { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time' }, token);
  }
  if (level === 'adset') {
    return graphList(`/${adAccountId}/adsets`, { fields: 'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,start_time,end_time' }, token);
  }
  if (level === 'ad') {
    return graphList(`/${adAccountId}/ads`, { fields: 'id,name,status,effective_status,adset_id,campaign_id,creative{id}' }, token);
  }
  throw new Error(`getEntitiesMeta: unknown level ${level}`);
}

/** Single-entity read for the pre-execute revalidation step — the exact current status/budget of the thing we're about to change. */
export async function getEntity(token, entityId, fields) {
  return graphFetch(`/${entityId}`, { fields }, token);
}

/**
 * Real ad-creative details for AI Media Buyer's creative analysis — body
 * copy, title, CTA type, link, and the nested object_story_spec where the
 * real message/headline/description usually live for a link ad. Returns
 * `null` on a per-creative failure so the caller can mark that creative
 * NOT_ANALYZED rather than aborting the whole batch.
 */
export async function getCreativeDetails(token, creativeId) {
  try {
    return await graphFetch(`/${creativeId}`, {
      fields: [
        'id', 'name', 'title', 'body', 'call_to_action_type', 'object_type',
        'link_url', 'image_url', 'video_id', 'thumbnail_url',
        'object_story_spec', 'asset_feed_spec', 'effective_object_story_id',
      ].join(','),
    }, token);
  } catch (err) {
    logger.warn('getCreativeDetails failed', { creativeId, message: err.message });
    return null;
  }
}

/** Raw POST to the Graph API (form-encoded, as Meta expects for writes). Returns Meta's parsed JSON response; throws a diagnostic-rich error on failure. */
export async function graphPost(path, body, token) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body || {})) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  form.set('access_token', token);
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) throwGraphOAuthError(data, res, `POST ${path}`);
  return data;
}

/** WRITE — pause/resume. status must be 'ACTIVE' or 'PAUSED'. Works for campaign, adset, or ad ids (Meta's status field is the same on all three). */
export async function setEntityStatus(token, entityId, status) {
  if (!['ACTIVE', 'PAUSED'].includes(status)) throw new Error(`setEntityStatus: invalid status ${status}`);
  return graphPost(`/${entityId}`, { status }, token);
}

/**
 * READ (quiet) — the live state of one campaign / ad set / ad. Returns
 * `{ id, name, status, effectiveStatus }` or `null` if the id can't be read
 * (deleted, no permission). Used by the schedule executor to revalidate the
 * DESTINATION campaign right before it activates / pauses it.
 */
export async function getEntityLive(token, entityId) {
  const d = await graphGetQuiet(`/${entityId}`, { fields: 'id,name,status,effective_status' }, token);
  if (!d || !d.id) return null;
  return { id: d.id, name: d.name || null, status: d.status || null, effectiveStatus: d.effective_status || null };
}

/** WRITE — budget change. Amount is in MINOR units of the account currency (e.g. EGP → piasters, ×100). Pass exactly one of dailyBudgetMinor / lifetimeBudgetMinor, matching the budget type the entity already uses. */
export async function setEntityBudget(token, entityId, { dailyBudgetMinor, lifetimeBudgetMinor }) {
  const body = {};
  if (dailyBudgetMinor != null) body.daily_budget = Math.round(dailyBudgetMinor);
  if (lifetimeBudgetMinor != null) body.lifetime_budget = Math.round(lifetimeBudgetMinor);
  if (Object.keys(body).length !== 1) throw new Error('setEntityBudget: pass exactly one of dailyBudgetMinor / lifetimeBudgetMinor');
  return graphPost(`/${entityId}`, body, token);
}

// ============================================================================
// CAMPAIGN CLONE & SCHEDULE — deep READ helpers (any ad account the connected
// user can access, not just the selected one) + a tightly-scoped set of
// CREATE helpers used only by services/amb/cloneEngine.js AFTER owner
// approval + a pre-flight validation. Every create here forces status:PAUSED
// at the call site; nothing in this file ever activates anything, and no
// helper here ever writes to a SOURCE entity.
// ============================================================================

/** Every ad account the token can reach (personal + each business), de-duplicated, with currency + timezone + status. */
export async function getAllAccessibleAdAccounts(token) {
  const fields = 'id,account_id,name,currency,account_status,timezone_name,timezone_offset_hours_utc,business{id,name}';
  const byId = new Map();
  for (const a of (await graphFetch('/me/adaccounts', { fields, limit: 200 }, token)).data || []) byId.set(a.id, a);
  let businesses = [];
  try { businesses = (await graphFetch('/me/businesses', { fields: 'id,name', limit: 100 }, token)).data || []; } catch { /* personal only */ }
  for (const b of businesses) {
    try {
      for (const a of await graphList(`/${b.id}/owned_ad_accounts`, { fields }, token)) byId.set(a.id, a);
      for (const a of await graphList(`/${b.id}/client_ad_accounts`, { fields }, token)) byId.set(a.id, a);
    } catch { /* skip a business we can't enumerate */ }
  }
  return [...byId.values()].map((a) => ({
    id: a.id,
    accountId: a.account_id,
    name: a.name || a.id,
    currency: a.currency || null,
    accountStatus: a.account_status ?? null,
    timezoneName: a.timezone_name || null,
    timezoneOffsetHours: a.timezone_offset_hours_utc ?? null,
    businessId: a.business?.id || null,
    businessName: a.business?.name || null,
  }));
}

/** Campaigns of ONE ad account with the full transferable config + a live insights slice (spend/purchases/CPA) for the picker. */
export async function listCampaignsForClone(token, adAccountId, { since, until } = {}) {
  const campaigns = await graphList(`/${adAccountId}/campaigns`, {
    fields: [
      'id', 'name', 'status', 'effective_status', 'objective', 'buying_type', 'bid_strategy',
      'daily_budget', 'lifetime_budget', 'budget_remaining', 'spend_cap', 'special_ad_categories',
      'special_ad_category_country', 'pacing_type', 'start_time', 'stop_time', 'created_time',
    ].join(','),
  }, token);

  // Ad set + ad counts (one cheap call each, summary only).
  const [adsetRows, adRows] = await Promise.all([
    graphList(`/${adAccountId}/adsets`, { fields: 'id,campaign_id' }, token).catch(() => []),
    graphList(`/${adAccountId}/ads`, { fields: 'id,campaign_id' }, token).catch(() => []),
  ]);
  const adsetCount = new Map();
  const adCount = new Map();
  for (const r of adsetRows) adsetCount.set(r.campaign_id, (adsetCount.get(r.campaign_id) || 0) + 1);
  for (const r of adRows) adCount.set(r.campaign_id, (adCount.get(r.campaign_id) || 0) + 1);

  // Insights per campaign for the requested window (best-effort — an account
  // with zero delivery just returns nothing, which is fine).
  let insightsById = new Map();
  if (since && until) {
    try {
      const rows = await graphList(`/${adAccountId}/insights`, {
        level: 'campaign', time_range: { since, until },
        fields: 'campaign_id,spend,actions,cost_per_action_type', limit: 500,
      }, token);
      insightsById = new Map(rows.map((r) => [r.campaign_id, r]));
    } catch { /* leave metrics null */ }
  }

  const PURCHASE = new Set(['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase', 'onsite_conversion.purchase']);
  return campaigns.map((c) => {
    const ins = insightsById.get(c.id);
    const spend = ins ? Number(ins.spend) || 0 : null;
    const pAction = ins?.actions?.find((a) => PURCHASE.has(a.action_type));
    const purchases = pAction ? Math.round(Number(pAction.value) || 0) : null;
    return {
      id: c.id,
      name: c.name || c.id,
      status: c.effective_status || c.status || null,
      configuredStatus: c.status || null,
      objective: c.objective || null,
      buyingType: c.buying_type || null,
      bidStrategy: c.bid_strategy || null,
      dailyBudgetMinor: c.daily_budget ? Number(c.daily_budget) : null,
      lifetimeBudgetMinor: c.lifetime_budget ? Number(c.lifetime_budget) : null,
      budgetMode: c.daily_budget || c.lifetime_budget ? 'CBO' : 'ABO',
      specialAdCategories: c.special_ad_categories || [],
      adsetCount: adsetCount.get(c.id) || 0,
      adCount: adCount.get(c.id) || 0,
      spend,
      purchases,
      cpa: spend != null && purchases ? spend / purchases : null,
    };
  });
}

/** Full campaign node (every transferable field) for the deep clone. */
export async function getCampaignNode(token, campaignId) {
  return graphFetch(`/${campaignId}`, {
    fields: [
      'id', 'name', 'objective', 'buying_type', 'status', 'bid_strategy', 'daily_budget', 'lifetime_budget',
      'spend_cap', 'special_ad_categories', 'special_ad_category_country', 'pacing_type', 'start_time', 'stop_time',
      'campaign_group_active_time', 'is_skadnetwork_attribution', 'is_adset_budget_sharing_enabled',
    ].join(','),
  }, token);
}

/** Ad sets of one campaign, full config. */
export async function getAdSetNodes(token, campaignId) {
  return graphList(`/${campaignId}/adsets`, {
    fields: [
      'id', 'name', 'status', 'campaign_id', 'daily_budget', 'lifetime_budget', 'billing_event', 'optimization_goal',
      'bid_amount', 'bid_strategy', 'targeting', 'promoted_object', 'attribution_spec', 'start_time', 'end_time',
      'destination_type', 'pacing_type', 'is_dynamic_creative', 'use_new_app_click', 'dsa_beneficiary', 'dsa_payor',
      'optimization_sub_event', 'multi_optimization_goal_weight', 'frequency_control_specs',
    ].join(','),
  }, token);
}

/** Ads of one campaign, with the linked creative id. */
export async function getAdNodes(token, campaignId) {
  return graphList(`/${campaignId}/ads`, {
    fields: 'id,name,status,adset_id,campaign_id,creative{id},tracking_specs,conversion_domain,display_sequence',
  }, token);
}

/** Full ad-creative spec for the deep clone. Includes object_story_id /
 * effective_object_story_id / actor_id so a "flat" creative (a boosted
 * organic post, or an Advantage+ creative with no object_story_spec) can be
 * detected and reconstructed correctly. */
export async function getCreativeNode(token, creativeId) {
  return graphFetch(`/${creativeId}`, {
    fields: [
      'id', 'name', 'object_story_spec', 'asset_feed_spec', 'degrees_of_freedom_spec', 'object_type',
      'title', 'body', 'image_hash', 'image_url', 'video_id', 'thumbnail_url', 'call_to_action_type',
      'link_url', 'url_tags', 'template_url_spec', 'product_set_id', 'instagram_user_id',
      'instagram_permalink_url', 'effective_instagram_media_id', 'contextual_multi_ads', 'authorization_category',
      'object_story_id', 'effective_object_story_id', 'actor_id', 'template_url',
    ].join(','),
  }, token);
}

/** Resolve a source account's image hashes to downloadable URLs (for re-upload into a destination account). */
export async function getAdImagesByHash(token, adAccountId, hashes) {
  if (!hashes?.length) return {};
  const rows = await graphListQuiet(`/${adAccountId}/adimages`, { fields: 'hash,url,permalink_url,width,height,name', hashes }, token);
  const out = {};
  for (const r of rows) out[r.hash] = r;
  return out;
}

/** Destination-account asset inventory used by the clone pre-flight. Every list is best-effort (low-noise) — a permission gap yields [] and is surfaced as a WARNING upstream, never a silent pass. */
export async function getAccountAssetsForClone(token, adAccountId) {
  const [account, pages, igA, igB, pixels, audiences, catViaBiz] = await Promise.all([
    graphGetQuiet(`/${adAccountId}`, { fields: 'id,name,account_status,timezone_name,currency' }, token),
    graphListQuiet(`/${adAccountId}/promote_pages`, { fields: 'id,name' }, token),
    graphListQuiet(`/${adAccountId}/instagram_accounts`, { fields: 'id,username' }, token),
    graphListQuiet(`/${adAccountId}/connected_instagram_accounts`, { fields: 'id,username' }, token),
    graphListQuiet(`/${adAccountId}/adspixels`, { fields: 'id,name' }, token),
    graphListQuiet(`/${adAccountId}/customaudiences`, { fields: 'id,name' }, token),
    // Catalogs are Business-owned — reach them through the ad account's business.
    graphGetQuiet(`/${adAccountId}`, { fields: 'business{owned_product_catalogs.limit(200){id,name},client_product_catalogs.limit(200){id,name}}' }, token),
  ]);
  const igMap = new Map();
  for (const g of [...(igA || []), ...(igB || [])]) igMap.set(g.id, g.username || g.id);
  const catalogs = [
    ...(catViaBiz?.business?.owned_product_catalogs?.data || []),
    ...(catViaBiz?.business?.client_product_catalogs?.data || []),
  ];
  return {
    account: account && account.id ? { id: account.id, name: account.name, status: account.account_status, timezoneName: account.timezone_name, currency: account.currency } : null,
    pages: (pages || []).map((p) => ({ id: p.id, name: p.name })),
    instagram: [...igMap.entries()].map(([id, username]) => ({ id, username })),
    pixels: (pixels || []).map((p) => ({ id: p.id, name: p.name })),
    customAudiences: (audiences || []).map((a) => ({ id: a.id, name: a.name })),
    catalogs: catalogs.map((c) => ({ id: c.id, name: c.name })),
  };
}

/**
 * The Facebook Pages the CONNECTED USER personally manages (from /me/accounts,
 * i.e. the Facebook account itself — NOT scoped to any Business Portfolio),
 * and, best-effort, the Instagram professional account linked to each.
 *
 * Pages need only `pages_show_list`. Instagram is discovered WITHOUT any
 * instagram_* OAuth scope — this app can't request one — by reading each
 * Page's `connected_instagram_account` / `instagram_business_account` edge
 * with a QUIET per-Page GET that returns null on a permission gap. So a
 * missing IG never blocks Page discovery. Returns `{pages:[], instagram:[]}`
 * cleanly when `pages_show_list` isn't granted.
 */
export async function getUserPagesAndIg(token) {
  const rows = await graphListQuiet('/me/accounts', { fields: 'id,name' }, token);
  const pages = (rows || []).map((p) => ({ id: String(p.id), name: p.name || p.id, source: 'user_account', verified: true }));

  const igMap = new Map();
  // Bounded per-Page IG probe (quiet — a permission gap yields null, not an error).
  await Promise.all(pages.slice(0, 30).map(async (pg) => {
    const d = await graphGetQuiet(`/${pg.id}`, { fields: 'connected_instagram_account{id,username},instagram_business_account{id,username}' }, token);
    const ig = d?.connected_instagram_account || d?.instagram_business_account;
    if (ig?.id) igMap.set(String(ig.id), { id: String(ig.id), username: ig.username || ig.id, source: 'user_account', pageId: pg.id });
  }));

  return { pages, instagram: [...igMap.values()], readable: pages.length > 0 };
}

/**
 * Facebook Pages + Instagram professional accounts an ad account can post as.
 * Sources, in priority order:
 *   1. the connected user's OWN Pages (/me/accounts — the Facebook account
 *      itself) + their linked Instagram accounts  ← preferred
 *   2. the ad account's promote_pages
 *   3. the owning Business Portfolio's owned/client pages
 * Best-effort per edge (the token may lack pages_* / instagram_basic — a gap
 * is reported, never silently assumed). Used by the clone identity step.
 */
export async function getAccountIdentities(token, adAccountId) {
  const [userIdent, promotePages, bizPages, igA, igB, bizIg] = await Promise.all([
    getUserPagesAndIg(token),
    graphListQuiet(`/${adAccountId}/promote_pages`, { fields: 'id,name' }, token),
    graphGetQuiet(`/${adAccountId}`, { fields: 'business{id,name,owned_pages.limit(200){id,name,is_published},client_pages.limit(200){id,name}}' }, token),
    graphListQuiet(`/${adAccountId}/instagram_accounts`, { fields: 'id,username' }, token),
    graphListQuiet(`/${adAccountId}/connected_instagram_accounts`, { fields: 'id,username' }, token),
    graphGetQuiet(`/${adAccountId}`, { fields: 'business{instagram_business_accounts.limit(100){id,username}}' }, token),
  ]);
  const pageMap = new Map();
  // 1) the user's own Facebook Pages first
  for (const p of userIdent.pages || []) pageMap.set(String(p.id), { id: String(p.id), name: p.name || p.id, source: 'user_account', verified: true });
  // 2) pages the ad account can already promote
  for (const p of promotePages || []) if (!pageMap.has(String(p.id))) pageMap.set(String(p.id), { id: String(p.id), name: p.name || p.id, source: 'promote_pages', verified: true });
  // 3) pages owned by the ad account's Business Portfolio
  for (const p of [...(bizPages?.business?.owned_pages?.data || []), ...(bizPages?.business?.client_pages?.data || [])]) {
    if (!pageMap.has(String(p.id))) pageMap.set(String(p.id), { id: String(p.id), name: p.name || p.id, source: 'business_portfolio', verified: false });
  }
  const igMap = new Map();
  for (const g of userIdent.instagram || []) igMap.set(String(g.id), { id: String(g.id), username: g.username || g.id });
  for (const g of [...(igA || []), ...(igB || []), ...(bizIg?.business?.instagram_business_accounts?.data || [])]) {
    if (!igMap.has(String(g.id))) igMap.set(String(g.id), { id: String(g.id), username: g.username || g.id });
  }
  return {
    pages: [...pageMap.values()],
    instagram: [...igMap.values()],
    pagesVerified: (userIdent.pages || []).length > 0 || (promotePages || []).length > 0 || Array.isArray(promotePages),
    instagramReadable: (userIdent.instagram || []).length > 0 || (igA || []).length > 0 || (igB || []).length > 0 || !!(bizIg?.business),
  };
}

/** Best-effort downloadable URL for one image_hash in an account (for re-upload elsewhere). */
export async function resolveImageUrlByHash(token, adAccountId, hash) {
  const rows = await graphListQuiet(`/${adAccountId}/adimages`, { fields: 'hash,url,permalink_url', hashes: [hash] }, token);
  const r = rows[0];
  return r?.url || r?.permalink_url || null;
}

/** Poll a video's processing status until READY (or timeout). Returns 'ready' | 'processing' | 'error' | 'unknown'. */
export async function pollVideoReady(token, videoId, { tries = 12, intervalMs = 5000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await graphGetQuiet(`/${videoId}`, { fields: 'status' }, token);
    const s = v?.status?.video_status || v?.status;
    if (s === 'ready') return 'ready';
    if (s === 'error') return 'error';
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return 'processing';
}

/** Re-upload one image into a destination ad account from a URL; returns the new image_hash. */
export async function uploadAdImageFromUrl(token, adAccountId, imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`تعذّر تحميل الصورة المصدر (${resp.status})`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error('حجم الصورة أكبر من 8MB — لا يمكن رفعها تلقائيًا.');
  const data = await graphPost(`/${adAccountId}/adimages`, { bytes: buf.toString('base64') }, token);
  const first = data?.images ? Object.values(data.images)[0] : null;
  if (!first?.hash) throw new Error('Meta لم تُرجع hash للصورة المرفوعة.');
  return { hash: first.hash, url: first.url || null };
}

/** Re-upload one video into a destination ad account by URL (Meta fetches it). Returns the new video id (may still be processing — fine for a PAUSED clone). */
export async function uploadAdVideoFromUrl(token, adAccountId, fileUrl, name) {
  const data = await graphPost(`/${adAccountId}/advideos`, { file_url: fileUrl, name: name || undefined }, token);
  if (!data?.id) throw new Error('Meta لم تُرجع id للفيديو المرفوع.');
  return { id: data.id };
}

/** Best-effort downloadable source URL for a video. Low-noise: Meta returns `source` only for videos the connected user/app owns — a null here is expected, not an error. */
export async function getVideoSourceUrl(token, videoId) {
  const v = await graphGetQuiet(`/${videoId}`, { fields: 'source,permalink_url,title' }, token);
  return v?.source || null;
}

/** CREATE (destination account only). Caller always passes status:'PAUSED'. */
export async function createCampaign(token, adAccountId, payload) {
  return graphPost(`/${adAccountId}/campaigns`, payload, token);
}
export async function createAdSet(token, adAccountId, payload) {
  return graphPost(`/${adAccountId}/adsets`, payload, token);
}
export async function createAdCreative(token, adAccountId, payload) {
  return graphPost(`/${adAccountId}/adcreatives`, payload, token);
}
export async function createAd(token, adAccountId, payload) {
  return graphPost(`/${adAccountId}/ads`, payload, token);
}
