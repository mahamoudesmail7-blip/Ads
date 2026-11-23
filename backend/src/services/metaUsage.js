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

// ---- WHO uses the quota? every Graph call is attributed to the code that made it (taken from the call stack: file:function ⇐ the route / scheduler at the start of the chain), with the Graph time it took.
const buckets = []; // [{ start, map: key -> { calls, ms, errors } }] 10-minute buckets, 2 hours kept
const meta = { lastLogAt: Date.now() };
const BUCKET_MS = 10 * 60_000;
const SKIP_FILE = /(metaGraphClient|metaUsage|metaAssetCache)\.js$/;
/** Pure: a V8 stack string -> a short label «top ⇐ origin» (files under services/ routes/ middleware/ only, the Graph client itself skipped). */
export function labelFromStack(stack) {
  const frames = [];
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = line.match(/at (?:async )?(?:(\S+) \()?.*?[\\/]((?:services|routes|middleware)[\\/][^:)]+?\.js):\d+:\d+\)?/);
    if (!m) continue; const path = m[2].replace(/\\/g, '/'); if (SKIP_FILE.test(path)) continue;
    frames.push({ path, name: path.split('/').pop().replace(/\.js$/, '') + ':' + (m[1] ? m[1].replace(/^Object\./, '') : 'anon') });
  }
  if (!frames.length) return 'unlabeled';
  const top = frames[0]; const origin = frames.find((f) => f.path.startsWith('routes/') || /(Scheduler|Sync|Watch|Alerts|Evaluator|Orchestrator|Analysis|Eval|Experiment)/i.test(f.path)) || frames[frames.length - 1];
  return origin === top ? top.name : top.name + ' ⇐ ' + origin.name;
}
export function callerLabel() { const old = Error.stackTraceLimit; Error.stackTraceLimit = 40; const st = new Error().stack; Error.stackTraceLimit = old; return labelFromStack(st); }
/** Remembers one Graph call (account = whatever account Meta's header named, else the act_ id in the URL, else «?»). */
export function recordCall({ label, account, ms, status, now = Date.now() }) {
  let b = buckets[buckets.length - 1];
  if (!b || now - b.start >= BUCKET_MS) { b = { start: now, map: new Map() }; buckets.push(b); while (buckets.length > 12) buckets.shift(); }
  const key = norm(account || '?') + '|' + label; const e = b.map.get(key) || { calls: 0, ms: 0, errors: 0 };
  e.calls += 1; e.ms += Math.max(0, ms || 0); if (!(status >= 200 && status < 300)) e.errors += 1; b.map.set(key, e);
}
/** The heaviest callers of the last N minutes (by Graph time), optionally for one account. Pure over the recorded buckets. */
export function topConsumers({ minutes = 60, account = null, limit = 25, now = Date.now() } = {}) {
  const agg = new Map(); const since = now - minutes * 60_000; const acct = account ? norm(account) : null;
  for (const b of buckets) { if (b.start + BUCKET_MS < since) continue; for (const [key, e] of b.map.entries()) { const [a, ...rest] = key.split('|'); if (acct && a !== acct) continue; const lbl = rest.join('|'); const x = agg.get(lbl) || { label: lbl, calls: 0, ms: 0, errors: 0 }; x.calls += e.calls; x.ms += e.ms; x.errors += e.errors; agg.set(lbl, x); } }
  const rows = [...agg.values()].sort((p, q) => q.ms - p.ms); const total = rows.reduce((t, r) => t + r.ms, 0) || 1;
  return rows.slice(0, limit).map((r) => ({ ...r, avgMs: Math.round(r.ms / Math.max(1, r.calls)), sharePct: Math.round((r.ms / total) * 100) }));
}
export function usageReadings() { const out = {}; for (const k of [...seen.keys()]) { const u = accountUsage(k); if (u) out['act_' + k] = { pct: u.pct, regainMin: Math.round(remainingRegainMs(k) / 6000) / 10, tier: u.tier, ageSec: Math.round((Date.now() - u.at) / 1000) }; } return out; }
/** A 10-minute line in the server log so the heaviest callers are visible without opening anything (no timer: it is written lazily by the next call). */
export function maybeLogConsumers(logger, now = Date.now()) { if (now - meta.lastLogAt < BUCKET_MS) return; meta.lastLogAt = now; const t = topConsumers({ minutes: 10, limit: 5, now }); if (t.length) logger.info('Meta usage — heaviest callers (last 10 min)', { top: t.map((r) => `${r.label} ${r.calls} calls ${Math.round(r.ms / 1000)}s ${r.sharePct}%`) }); }
export function _resetUsageForTests() { buckets.length = 0; for (const k of [...seen.keys()]) seen.delete(k); }
