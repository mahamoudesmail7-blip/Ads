// «نتايج شغل الميديا باير» — what the campaigns each media buyer CREATED actually gave, per product:
//   mode 'yesterday' = the campaigns created yesterday (scheduled, they started at 12 AM) → what they did TODAY so far (orders / spend / cost per order, per product, per buyer, campaign by campaign)
//   mode 'month'     = every campaign created this month → what each buyer's campaigns gave since they started (per product)
// Same sources and the same attribution as the daily view (Meta «View history» + the system's records). READ ONLY. A campaign's creation day is never counted (it starts the next day at 12 AM).
// Past days' creation lists never change, so they are stored once (settings rows) and never fetched again — the month view only reads what is missing (a few days at a time, in the background).
import { prisma } from '../../prisma.js';
import { loadSnapshots, latestPerDayPerEntity, aggregateRows, todayISO } from './metricsEngine.js';
import { addDays, cairoDate } from './dailyPlanTime.js';
import { loadCampaignLinks } from './accountProductsToday.js';
import { listViewAccounts } from './viewAccounts.js';
import { logger } from '../../logger.js';
import { mergeCampaigns, groupByPerson, loadAliases, systemRecords, metaEvents, sumResults, range } from './buyerActivity.js';

const r2 = (n) => Math.round(n * 100) / 100;
const EV_KEY = 'ba:ev:'; const CACHE_MS = { yesterday: 90_000, month: 5 * 60_000 }; const BUDGET_MS = 14_000; const CONCURRENCY = 3;
const cache = new Map(); // mode|today -> { at, data }
const building = new Map(); // mode|today -> { promise, progress }

// ───────────── pure ─────────────
/** Pure: one person's campaigns → one row per PRODUCT (best first): campaigns, tests, scales, orders, spend, cost per order. A campaign with no snapshot yet adds nothing (never a fake zero); a product where NO campaign has data shows «—». */
export function groupProducts(campaigns) {
  const by = new Map();
  for (const c of campaigns) {
    const name = c.product || 'منتج غير محدد'; const key = name.toLowerCase().replace(/\s+/g, ' ').trim();
    const row = by.get(key) || { key, name, campaigns: 0, tests: 0, scales: 0, other: 0, orders: 0, spend: 0, withData: 0, items: [] };
    row.campaigns += 1; if (c.type === 'TEST') row.tests += 1; else if (c.type === 'SCALE') row.scales += 1; else row.other += 1;
    if (c.perf) { row.orders += c.perf.orders; row.spend += c.perf.spend; row.withData += 1; }
    row.items.push(c); by.set(key, row);
  }
  return [...by.values()].map((r) => ({ ...r, spend: r2(r.spend), orders: r.withData ? r.orders : null, cpa: r.withData && r.orders > 0 ? r2(r.spend / r.orders) : null, spendKnown: r.withData > 0 }))
    .sort((a, b) => ((b.orders ?? -1) - (a.orders ?? -1)) || (b.spend - a.spend) || a.name.localeCompare(b.name, 'ar'));
}
/** Pure: the person's totals over all his campaigns. */
export function personTotals(campaigns) {
  let orders = 0, spend = 0, any = false; for (const c of campaigns) if (c.perf) { any = true; orders += c.perf.orders; spend += c.perf.spend; }
  return { campaigns: campaigns.length, tests: campaigns.filter((c) => c.type === 'TEST').length, scales: campaigns.filter((c) => c.type === 'SCALE').length, orders: any ? orders : null, spend: any ? r2(spend) : null, cpa: any && orders > 0 ? r2(spend / orders) : null };
}
/** Pure: the numbers of ONE campaign over the days AFTER its creation day (up to `last`). null = no snapshot at all. */
export function campaignPerf(byCamp, c, last) {
  const created = cairoDate(new Date(c.at)); const first = addDays(created, 1); if (first > last) return null;
  const days = range(first, Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1);
  return sumResults(byCamp, [c.id], days);
}

// ───────────── stored creation lists of past days ─────────────
const parseJson = (s) => { try { return JSON.parse(s || 'null'); } catch { return null; } };
async function loadStoredDay(day) { const row = await prisma.settings.findUnique({ where: { id: EV_KEY + day } }); const v = parseJson(row?.data); return v && Array.isArray(v.events) ? v.events.map((e) => ({ ...e, at: new Date(e.at) })) : null; }
async function saveStoredDay(day, events) { const data = JSON.stringify({ day, savedAt: new Date().toISOString(), events: events.map((e) => ({ ...e, at: e.at instanceof Date ? e.at.toISOString() : e.at })) }); await prisma.settings.upsert({ where: { id: EV_KEY + day }, create: { id: EV_KEY + day, data }, update: { data } }); }
async function mapLimit(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }

/** Meta's creation events of each day in [from, to]: a PAST day is read once and stored (only when every account answered); today is always read live. */
async function eventsOf(days, accounts, today, progress) {
  const all = []; let failed = []; let live = 0;
  await mapLimit(days, CONCURRENCY, async (d) => {
    let ev = d < today ? await loadStoredDay(d) : null;
    if (!ev) {
      const m = await metaEvents(d, d, accounts); live += 1; ev = m.events; if (!m.ok) failed = [...new Set([...failed, ...(m.failed || []), ...(m.reason ? [m.reason] : [])])];
      else if (d < today) await saveStoredDay(d, ev).catch((e) => logger.warn('[buyerReport] store day failed', { day: d, message: e.message }));
    }
    all.push(...ev); progress.done += 1;
  });
  // each day's read covers a window wider than the day (so no campaign is missed at the edges): the same event can sit in two days' lists → ONE per campaign, the earliest
  const one = new Map(); for (const e of all) { const k = `${e.accountId}:${e.id}`; const cur = one.get(k); if (!cur || new Date(e.at) < new Date(cur.at)) one.set(k, e); }
  return { events: [...one.values()], failed, liveReads: live };
}

// ───────────── the report ─────────────
async function compute(mode, today, progress) {
  const from = mode === 'yesterday' ? addDays(today, -1) : `${today.slice(0, 7)}-01`; const to = mode === 'yesterday' ? addDays(today, -1) : today;
  const days = range(from, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1); progress.total = days.length;
  const accounts = (await listViewAccounts()).accounts; const accountNames = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const [sys, ev, aliases] = await Promise.all([systemRecords(from, to), eventsOf(days, accounts, today, progress), loadAliases()]);
  const list = []; for (const d of days) list.push(...mergeCampaigns(ev.events, sys, { day: d, accountNames }));
  // products linked by the system (names stay the owner's «Product - Test» naming otherwise)
  const byAcc = new Map(); for (const c of list) if (!c.product) { if (!byAcc.has(c.accountId)) byAcc.set(c.accountId, []); byAcc.get(c.accountId).push(c.id); }
  for (const [acc, ids] of byAcc) { try { const links = await loadCampaignLinks(acc, ids); for (const c of list) if (c.accountId === acc && !c.product && links.get(c.id)?.name) c.product = links.get(c.id).name; } catch { /* name stays unknown */ } }
  // results: the days after each campaign's creation day, up to today
  const idsByAcc = new Map(); for (const c of list) { if (!idsByAcc.has(c.accountId)) idsByAcc.set(c.accountId, new Set()); idsByAcc.get(c.accountId).add(c.id); }
  const perAcc = new Map(); const resFrom = addDays(from, 1);
  if (resFrom <= today) for (const [acc, ids] of idsByAcc) {
    try {
      const rows = await loadSnapshots({ level: 'campaign', from: resFrom, to: today, adAccountId: acc }); const byCamp = new Map();
      for (const [cid, dayMap] of latestPerDayPerEntity(rows, 'campaign').entries()) { if (!ids.has(cid)) continue; const m = new Map(); for (const [d, row] of dayMap.entries()) { const a = aggregateRows([row]); if (a) m.set(d, { spend: a.spend || 0, orders: a.purchases || 0 }); } byCamp.set(cid, m); }
      perAcc.set(acc, byCamp);
    } catch (e) { logger.warn('[buyerReport] results failed', { account: acc, message: e.message }); }
  }
  for (const c of list) c.perf = campaignPerf(perAcc.get(c.accountId) || new Map(), c, today);
  let team = []; try { const E = await import('../dailyTasks/engine.js'); team = ((await E.getConfig()).team || []).filter((m) => m.active !== false).map((m) => ({ id: m.id, name: m.name, userId: m.userId || null })); } catch (e) { logger.warn('[buyerReport] team failed', { message: e.message }); }
  const people = groupByPerson(list, team, aliases).map((p) => ({
    key: p.key, memberId: p.memberId, name: p.name, linked: p.linked, actor: p.actor, idle: p.idle, totals: personTotals(p.campaigns), products: groupProducts(p.campaigns).map((r) => ({ ...r, items: r.items.map((c) => ({ id: c.id, name: c.name, type: c.type, accountName: c.accountName, at: c.at, source: c.source, perf: c.perf })) })),
  }));
  const all = personTotals(list);
  return { ready: true, mode, from, to, today, firstResultDay: addDays(from, 1), people, team: team.map((m) => ({ id: m.id, name: m.name })), totals: all, meta: { ok: ev.failed.length === 0, failed: ev.failed }, computedAt: new Date().toISOString(),
    note: mode === 'yesterday' ? 'كامبينات امبارح (اتعملت Scheduled وبدأت 12 ص). الأرقام دي لحد دلوقتي النهارده، وبتكبر على مدار اليوم.' : 'كل كامبين اتعمل من أول الشهر، وأرقامه من تاني يوم لإنشائه لحد دلوقتي. الكامبين اللي معندوش مزامنة لسه مش بيتحسب (مش بيتحسب صفر).' };
}

/** Pure: the report as ONE media buyer may see it — his own card only, his own totals, no team list. */
export function scopeReport(r, memberId) {
  if (!memberId || !r?.ready) return r;
  const people = r.people.filter((p) => p.memberId === memberId); const mine = people.flatMap((p) => p.products.flatMap((x) => x.items));
  return { ...r, scope: 'SELF', people, team: [], totals: personTotals(mine), meta: { ...r.meta, failed: [] } };
}

/** @param {{ mode?: 'yesterday'|'month', force?: boolean }} p — returns { ready:false, progress } while a big month is still being read (the page asks again in a few seconds). */
export async function getBuyerReport({ mode = 'yesterday', force = false } = {}) {
  if (!['yesterday', 'month'].includes(mode)) { const e = new Error('نوع التقرير غير معروف.'); e.status = 400; throw e; }
  const today = todayISO(); const key = `${mode}|${today}`;
  const hit = cache.get(key); if (!force && hit && Date.now() - hit.at < CACHE_MS[mode]) return hit.data;
  let job = building.get(key);
  if (!job) {
    const progress = { done: 0, total: 0 };
    const promise = compute(mode, today, progress).then((data) => { cache.set(key, { at: Date.now(), data }); if (cache.size > 6) cache.delete(cache.keys().next().value); return data; }).finally(() => building.delete(key));
    job = { promise, progress }; building.set(key, job); promise.catch((e) => logger.warn('[buyerReport] failed', { message: e.message }));
  }
  const timeout = new Promise((r) => setTimeout(() => r(null), BUDGET_MS));
  const data = await Promise.race([job.promise, timeout]);
  return data || { ready: false, mode, progress: { ...job.progress } };
}
