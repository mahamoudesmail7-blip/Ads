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
  logger.error(`Meta OAuth ${context} failed`, {
    status: res.status,
    errorType: e.type ?? null,
    errorCode: e.code ?? null,
    errorSubcode: e.error_subcode ?? null,
    message: e.message ?? null,
    fbtraceId: e.fbtrace_id ?? null,
  });
  const err = new Error(e.message || `Graph API error ${res.status}`);
  err.graphStatus = res.status;
  err.graphType = e.type ?? null;
  err.graphCode = e.code ?? null;
  err.graphSubcode = e.error_subcode ?? null;
  err.fbtraceId = e.fbtrace_id ?? null;
  throw err;
}

async function graphFetch(path, params, token) {
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
