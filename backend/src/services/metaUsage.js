// What META says about its own quota. Every Graph response of the Marketing API carries x-business-use-case-usage:
//   { "<ad account id>": [ { type: "ads_management", call_count, total_cputime, total_time (all in % of the limit), estimated_time_to_regain_access (MINUTES), ads_api_access_tier } ] }
// This app is on «development_access» (the smallest quota): measured on production the limit that is hit is total_cputime / total_time (heavy reads), NOT the number of calls.
// The newest reading per ad account is kept here so (a) the scale / clone can wait EXACTLY as long as Meta says before it starts, and (b) the optional background readers (syncs, alerts) stay off an account that is near its limit.
const seen = new Map(); // numeric account id -> { pct, regainMs, tier, at }
const norm = (id) => String(id ?? '').replace(/^act_/, '');

/** Pure: the header value -> [{ id, pct, regainMs, tier }] (the worst figure per account). Never throws. */
export function parseUsage(value) {
  const out = [];
  try {
    const o = JSON.parse(value || 'null');
    if (o && typeof o === 'object') for (const [id, arr] of Object.entries(o)) {
      let pct = 0, regain = 0, tier = null;
      for (const u of Array.isArray(arr) ? arr : []) {
        pct = Math.max(pct, Number(u?.call_count) || 0, Number(u?.total_cputime) || 0, Number(u?.total_time) || 0);
        regain = Math.max(regain, (Number(u?.estimated_time_to_regain_access) || 0) * 60_000);
        tier = u?.ads_api_access_tier || tier;
      }
      out.push({ id: norm(id), pct, regainMs: Math.round(regain), tier });
    }
  } catch { /* header is optional */ }
  return out;
}
export function noteUsageHeader(value) { const at = Date.now(); for (const u of parseUsage(value)) seen.set(u.id, { ...u, at }); }
/** Meta's newest reading for the account (≤ 10 min old) or null. */
export function accountUsage(accountId) { const u = seen.get(norm(accountId)); return u && Date.now() - u.at <= 10 * 60_000 ? u : null; }
/** Milliseconds Meta still needs before the account's quota is back (0 = free / unknown). */
export function remainingRegainMs(accountId) { const u = accountUsage(accountId); return u ? Math.max(0, u.regainMs - (Date.now() - u.at)) : 0; }
/** Near the limit (or blocked) in a reading younger than 5 minutes → optional background reads leave the account alone. */
export function isAccountBusy(accountId, pct = 85) { const u = seen.get(norm(accountId)); return !!u && Date.now() - u.at <= 5 * 60_000 && (remainingRegainMs(accountId) > 0 || u.pct >= pct); }
export function _resetUsageForTests() { for (const k of [...seen.keys()]) seen.delete(k); }
