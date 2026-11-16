// «إيه اللي عمله كل ميديا باير؟» — every CAMPAIGN created on one (Cairo) day, who created it, in which account, on which product — and, after the day, what it gave (orders / cost per order).
// READ ONLY: Meta's «Activity history» of each ad account (the list Ads Manager shows under «View history») + the system's own launch / clone records + the synced campaign snapshots. Nothing is written to Meta.
//   Who:  a campaign the SYSTEM created → the logged-in person who launched / cloned it (Meta would only show the connected token's owner);
//         a campaign created BY HAND in Ads Manager → the Facebook user in the activity history, matched to a media buyer by name (or by a link the owner sets once).
//   Type: «Scale» / «Test» in the campaign NAME decides (the owner's naming: «Cup - Test», «Cup - Scale»); else the system record (launch = test, clone = scale); else «كامبين».
// Results: a campaign made today starts at 12 AM tomorrow, so its first RESULT is the next day's (never the creation day). Meta purchases from the synced snapshots; a day without a snapshot is «مفيش بيانات لسه», never a zero.
import { prisma } from '../../prisma.js';
import { loadSnapshots, latestPerDayPerEntity, aggregateRows, todayISO } from './metricsEngine.js';
import { addDays, cairoDate } from './dailyPlanTime.js';
import { loadCampaignLinks } from './accountProductsToday.js';
import { listViewAccounts } from './viewAccounts.js';
import { getDecryptedToken } from '../metaAuth.js';
import { getAccountActivities } from '../metaGraphClient.js';
import { logger } from '../../logger.js';

const r2 = (n) => Math.round(n * 100) / 100;
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const ACCOUNT_TIMEOUT_MS = 15_000; const CACHE_TODAY_MS = 90_000; const CACHE_PAST_MS = 10 * 60_000; const RESULT_DAYS = 7; const ALIAS_ID = 'ba:aliases';
const cache = new Map(); // date -> { at, data }

// ───────────── pure helpers ─────────────
/** «Cup - Scale» → SCALE · «Cup - Test 2» → TEST · otherwise the system's own record decides, else OTHER. */
export function typeOfCampaign(name, systemKind = null) {
  const n = String(name || '');
  if (/scale|سكيل|اسكيل/i.test(n)) return 'SCALE';
  if (/test|تيست/i.test(n)) return 'TEST';
  return systemKind === 'SCALE' || systemKind === 'TEST' ? systemKind : 'OTHER';
}
/** The product part of the owner's naming: «Cup - Test 2» → «Cup». */
export function productFromName(name) { const first = clean(name).split(/\s[-–—|]\s/)[0].trim(); return first && first !== clean(name) ? first : null; }
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Which team member does a Facebook actor stand for? 1) the link the owner set (by actor id), 2) the member's whole name found inside the actor's name — only when ONE member is the most specific fit. */
export function matchMember(actor, team, aliases = {}) {
  if (!actor) return null;
  const linked = actor.id && aliases[actor.id] ? team.find((m) => m.id === aliases[actor.id]) : null; if (linked) return linked;
  const a = new Set(norm(actor.name).split(' ').filter(Boolean)); if (!a.size) return null;
  const hits = team.map((m) => ({ m, t: norm(m.name).split(' ').filter(Boolean) })).filter((x) => x.t.length > 0 && x.t.every((w) => a.has(w)));
  const best = Math.max(0, ...hits.map((x) => x.t.length)); const top = hits.filter((x) => x.t.length === best); // «Ahmed Samy» beats «Samy» for the actor «Ahmed Samy Ali»
  return top.length === 1 ? top[0].m : null;
}
/** Meta activity rows → the campaigns created in the window [{ id, name, accountId, at, actor:{id,name} }]. Only «campaign created» events; the earliest event per campaign. */
export function creationEvents(rows, accountId) {
  const out = new Map();
  for (const r of rows || []) {
    const isCampaign = String(r.object_type || '').toUpperCase() === 'CAMPAIGN' || /campaign/i.test(String(r.event_type || ''));
    if (!isCampaign || !/creat/i.test(`${r.event_type || ''} ${r.translated_event_type || ''}`) || !r.object_id) continue;
    const at = r.event_time ? new Date(r.event_time) : null; if (!at || Number.isNaN(at.getTime())) continue;
    const cur = out.get(String(r.object_id));
    if (!cur || at < cur.at) out.set(String(r.object_id), { id: String(r.object_id), name: clean(r.object_name), accountId, at, actor: r.actor_id || r.actor_name ? { id: r.actor_id ? String(r.actor_id) : null, name: clean(r.actor_name) } : null });
  }
  return [...out.values()];
}
/**
 * Pure: Meta's creation events + the system's own records → ONE list of campaigns. A campaign the system created keeps the system's person (the Meta actor would just be the connected token's owner);
 * a campaign only Meta knows about is the Facebook actor's. `system` = Map<campaignId, { userId, userName, kind, product, name, accountId, accountName, at }>.
 */
export function mergeCampaigns(events, system, { day, accountNames = {} } = {}) {
  const out = []; const seen = new Set();
  for (const e of events) {
    if (cairoDate(e.at) !== day) continue;
    const s = system.get(e.id); seen.add(e.id);
    const name = e.name || s?.name || e.id;
    out.push({ id: e.id, name, accountId: e.accountId, accountName: accountNames[e.accountId] || s?.accountName || e.accountId, at: e.at.toISOString(), type: typeOfCampaign(name, s?.kind), product: s?.product || productFromName(name), source: s ? 'SYSTEM' : 'META', by: s ? { userId: s.userId, name: s.userName } : null, actor: e.actor });
  }
  for (const [id, s] of system) {
    if (seen.has(id) || cairoDate(s.at) !== day) continue; // the system made it but Meta's history did not list it (yet / not readable)
    out.push({ id, name: s.name || id, accountId: s.accountId, accountName: accountNames[s.accountId] || s.accountName || s.accountId, at: new Date(s.at).toISOString(), type: typeOfCampaign(s.name, s.kind), product: s.product || productFromName(s.name), source: 'SYSTEM', by: { userId: s.userId, name: s.userName }, actor: null });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
/** Pure: the numbers of a set of campaigns over some days. `byCampaign` = Map<campaignId, Map<date, {spend, orders}>>. No snapshot at all → null (unknown, not zero). */
export function sumResults(byCampaign, ids, dates) {
  let spend = 0, orders = 0, any = false;
  for (const id of ids) { const m = byCampaign.get(id); if (!m) continue; for (const d of dates) { const v = m.get(d); if (!v) continue; any = true; spend += v.spend || 0; orders += v.orders || 0; } }
  return any ? { spend: r2(spend), orders, cpa: orders > 0 ? r2(spend / orders) : null } : null;
}
export const range = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));

/** Pure: campaigns → one row per person. `team` = [{ id, name, userId }] (listed even with nothing created); anyone not in the team gets their own «غير مربوط» row (a Facebook actor) or «مش معروف». */
export function groupByPerson(campaigns, team, aliases = {}) {
  const rows = new Map(team.map((m) => [`m:${m.id}`, { key: `m:${m.id}`, memberId: m.id, name: m.name, linked: true, actor: null, campaigns: [] }]));
  for (const c of campaigns) {
    let member = null;
    if (c.by) member = team.find((m) => m.userId && m.userId === c.by.userId) || team.find((m) => norm(m.name) === norm(c.by.name)) || null;
    else if (c.actor) member = matchMember(c.actor, team, aliases);
    let key;
    if (member) key = `m:${member.id}`;
    else if (c.by) key = `u:${c.by.userId ?? c.by.name}`;
    else if (c.actor) key = `a:${c.actor.id || c.actor.name}`;
    else key = 'none';
    if (!rows.has(key)) rows.set(key, { key, memberId: null, name: c.by?.name || c.actor?.name || 'مش معروف', linked: false, actor: c.by ? null : c.actor, campaigns: [] });
    rows.get(key).campaigns.push(c);
  }
  return [...rows.values()].map((p) => ({ ...p, tests: p.campaigns.filter((c) => c.type === 'TEST').length, scales: p.campaigns.filter((c) => c.type === 'SCALE').length, other: p.campaigns.filter((c) => c.type === 'OTHER').length, total: p.campaigns.length, idle: p.campaigns.length === 0 }))
    .sort((a, b) => (b.total - a.total) || (Number(b.linked) - Number(a.linked)) || a.name.localeCompare(b.name, 'ar'));
}

// ───────────── data ─────────────
// ───────────── who may see what ─────────────
/** The viewer of the section: the OWNER account (same rule as «تاسكات اليوم») sees everyone; a media buyer (his login linked to his team card) sees only himself; anyone else: null (no access). */
export async function resolveViewer(user) {
  const C = await import('../dailyTasks/core.js'); if (C.seesAll(user)) return { all: true, memberId: null };
  if (!user) return null;
  const E = await import('../dailyTasks/engine.js'); const cfg = await E.getConfig(); const m = (cfg.team || []).find((x) => x.userId && x.userId === user.id && x.active !== false);
  return m ? { all: false, memberId: m.id, name: m.name } : null;
}
/** Pure: the day view as ONE media buyer may see it — only his own card and campaigns, totals of his own work, no team list (nobody else's name), strip counts left for the own-counts call. */
export function scopeActivity(data, memberId) {
  if (!memberId) return data;
  const people = data.people.filter((p) => p.memberId === memberId); const mine = people.flatMap((p) => p.campaigns);
  return { ...data, scope: 'SELF', people, team: [], week: (data.week || []).map((w) => ({ date: w.date, selected: w.selected, today: w.today, campaigns: 0, approx: true })),
    totals: { campaigns: mine.length, tests: mine.filter((c) => c.type === 'TEST').length, scales: mine.filter((c) => c.type === 'SCALE').length, people: people.filter((p) => !p.idle).length } };
}
export async function loadAliases() { try { const row = await prisma.settings.findUnique({ where: { id: ALIAS_ID } }); const v = JSON.parse(row?.data || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
/** The owner links a Facebook actor to a media buyer once (memberId null = remove the link). Stored in the settings table only. */
export async function setAlias(actorId, memberId) {
  const id = String(actorId || '').slice(0, 64); if (!id) { const e = new Error('اسم الحساب على فيسبوك مطلوب.'); e.status = 400; throw e; }
  const cur = await loadAliases();
  if (memberId) { const E = await import('../dailyTasks/engine.js'); const cfg = await E.getConfig(); if (!cfg.team.some((m) => m.id === memberId)) { const e = new Error('الميديا باير مش موجود في الفريق.'); e.status = 400; throw e; } cur[id] = memberId; } else delete cur[id];
  const data = JSON.stringify(cur); await prisma.settings.upsert({ where: { id: ALIAS_ID }, create: { id: ALIAS_ID, data }, update: { data } }); cache.clear?.();
  return cur;
}

export async function systemRecords(fromDay, toDay = fromDay) {
  const from = new Date(`${addDays(fromDay, -1)}T00:00:00Z`), to = new Date(`${addDays(toDay, 2)}T00:00:00Z`);
  const [jobs, batches] = await Promise.all([
    prisma.ambLaunchJob.findMany({ where: { created_at: { gte: from, lt: to } }, select: { ad_account_id: true, ad_account_name: true, created_at: true, created_by: { select: { id: true, name: true } }, product: { select: { product_name: true } }, campaigns: { select: { name: true, meta_campaign_id: true } } } }),
    prisma.ambCloneBatch.findMany({ where: { created_at: { gte: from, lt: to } }, select: { created_at: true, created_by: { select: { id: true, name: true } }, jobs: { select: { source_campaign_name: true, destination_ad_account_id: true, destination_account_name: true, destination_campaign_id: true } } } }),
  ]);
  const sys = new Map();
  for (const j of jobs) for (const c of j.campaigns) if (c.meta_campaign_id) sys.set(String(c.meta_campaign_id), { userId: j.created_by?.id ?? null, userName: clean(j.created_by?.name) || null, kind: 'TEST', product: j.product?.product_name || null, name: clean(c.name), accountId: j.ad_account_id, accountName: clean(j.ad_account_name) || null, at: j.created_at });
  for (const b of batches) for (const jb of b.jobs) if (jb.destination_campaign_id) sys.set(String(jb.destination_campaign_id), { userId: b.created_by?.id ?? null, userName: clean(b.created_by?.name) || null, kind: 'SCALE', product: null, name: clean(jb.source_campaign_name), accountId: jb.destination_ad_account_id, accountName: clean(jb.destination_account_name) || null, at: b.created_at });
  for (const [id, s] of sys) if (!s.userId && !s.userName) s.userName = null; // creator unknown: stays «system, unknown person»
  return sys;
}

const EVENTS_CACHE = new Map(); // 'first|end' -> { at, v }
export async function metaEvents(first, end, accounts) {
  const key = `${first}|${end}`; const hit = EVENTS_CACHE.get(key); if (hit && Date.now() - hit.at < CACHE_TODAY_MS) return hit.v;
  let token = null; try { token = await getDecryptedToken(); } catch { return { events: [], ok: false, reason: 'مفيش اتصال Meta دلوقتي' }; }
  const since = new Date(`${addDays(first, -1)}T12:00:00Z`).toISOString(), until = new Date(`${addDays(end, 1)}T12:00:00Z`).toISOString(); // wide window; each Cairo day is cut afterwards
  const events = []; const failed = [];
  const withLimit = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  await Promise.all(accounts.map(async (a) => { // every account at the same time, each with its own time limit — one slow account never holds the page
    try { events.push(...creationEvents(await withLimit(getAccountActivities(token, a.id, { since, until }), ACCOUNT_TIMEOUT_MS), a.id)); }
    catch (e) { failed.push(a.name || a.id); logger.warn('[buyerActivity] activity history failed', { account: a.id, message: e.message }); }
  }));
  const v = { events, ok: failed.length === 0, failed }; EVENTS_CACHE.set(key, { at: Date.now(), v }); if (EVENTS_CACHE.size > 6) EVENTS_CACHE.delete(EVENTS_CACHE.keys().next().value);
  return v;
}

async function resultsFor(list, day, today) {
  const first = addDays(day, 1); const started = first <= today; const last = [addDays(day, RESULT_DAYS), today].sort()[0];
  const idsByAcc = new Map(); for (const c of list) { if (!idsByAcc.has(c.accountId)) idsByAcc.set(c.accountId, new Set()); idsByAcc.get(c.accountId).add(c.id); }
  const perAcc = new Map();
  if (started) for (const [acc, ids] of idsByAcc) {
    try {
      const rows = await loadSnapshots({ level: 'campaign', from: first, to: last, adAccountId: acc }); const byCamp = new Map();
      for (const [cid, dayMap] of latestPerDayPerEntity(rows, 'campaign').entries()) { if (!ids.has(cid)) continue; const m = new Map(); for (const [d, row] of dayMap.entries()) { const a = aggregateRows([row]); if (a) m.set(d, { spend: a.spend || 0, orders: a.purchases || 0 }); } byCamp.set(cid, m); }
      perAcc.set(acc, byCamp);
    } catch (e) { logger.warn('[buyerActivity] results failed', { account: acc, message: e.message }); }
  }
  const span = started ? Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1 : 0;
  for (const c of list) {
    const byCamp = perAcc.get(c.accountId) || new Map();
    c.results = { started, firstDay: first, firstDayIsToday: first === today, first: started ? sumResults(byCamp, [c.id], [first]) : null, total: started && span > 1 ? sumResults(byCamp, [c.id], range(first, span)) : null, totalDays: span };
  }
}

/** The day strip: how many campaigns each day created — from the same Meta history + system records as the cards, so every chip is honest (not only the selected day). Ends on today; an older selected day extends it. */
function weekStrip(day, today, first, events, sys, accountNames, { exact = true } = {}) {
  const n = Math.min(60, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1);
  return range(first, n).map((d) => { const known = exact || d === day; return { date: d, campaigns: mergeCampaigns(known ? events : [], sys, { day: d, accountNames }).length, selected: d === day, today: d === today, approx: !known }; });
}

/** The 7-day strip with EVERY day counted from Meta's history + the system records (one wider read, cached). The page asks for it after the cards are already on screen. */
export async function getWeekStrip({ date = null, memberId = null } = {}) {
  const today = todayISO(); let day = validDate(date) ? String(date) : today; if (day > today) day = today;
  const first = day < addDays(today, -6) ? day : addDays(today, -6);
  const accounts = (await listViewAccounts()).accounts; const accountNames = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const [sys, meta] = await Promise.all([systemRecords(first, today), metaEvents(first, today, accounts)]);
  if (memberId) { // a media buyer: the chips count ONLY his own campaigns
    let team = []; try { const E = await import('../dailyTasks/engine.js'); team = ((await E.getConfig()).team || []).filter((m) => m.active !== false).map((m) => ({ id: m.id, name: m.name, userId: m.userId || null })); } catch { /* none */ }
    const aliases = await loadAliases(); const n = Math.min(60, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1);
    const week = range(first, n).map((d) => ({ date: d, campaigns: groupByPerson(mergeCampaigns(meta.events, sys, { day: d, accountNames }), team, aliases).find((p) => p.memberId === memberId)?.total || 0, selected: d === day, today: d === today, approx: false }));
    return { date: day, week, ok: meta.ok, scope: 'SELF' };
  }
  return { date: day, week: weekStrip(day, today, first, meta.events, sys, accountNames, { exact: true }), ok: meta.ok };
}

/** @param {{ date?: string|null, force?: boolean }} p */
export async function getBuyerActivity({ date = null, force = false } = {}) {
  const today = todayISO(); let day = validDate(date) ? String(date) : today; if (day > today) day = today;
  const hit = cache.get(day); if (!force && hit && Date.now() - hit.at < (day === today ? CACHE_TODAY_MS : CACHE_PAST_MS)) return hit.data;
  const accounts = (await listViewAccounts()).accounts; const accountNames = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const first = day < addDays(today, -6) ? day : addDays(today, -6);
  const [sys, meta, aliases] = await Promise.all([systemRecords(first, today), metaEvents(day, day, accounts), loadAliases()]); // Meta: the selected day only (fast); the strip's other days are filled by getWeekStrip
  const list = mergeCampaigns(meta.events, sys, { day, accountNames });
  // product of the campaigns the system links to a product (never guessed beyond the owner's «Product - Test» naming)
  const byAcc = new Map(); for (const c of list) if (!c.product) { if (!byAcc.has(c.accountId)) byAcc.set(c.accountId, []); byAcc.get(c.accountId).push(c.id); }
  for (const [acc, ids] of byAcc) { try { const links = await loadCampaignLinks(acc, ids); for (const c of list) if (c.accountId === acc && !c.product && links.get(c.id)?.name) c.product = links.get(c.id).name; } catch { /* name stays unknown */ } }
  await resultsFor(list, day, today);
  let team = []; try { const E = await import('../dailyTasks/engine.js'); team = ((await E.getConfig()).team || []).filter((m) => m.active !== false).map((m) => ({ id: m.id, name: m.name, userId: m.userId || null })); } catch (e) { logger.warn('[buyerActivity] team failed', { message: e.message }); }
  const people = groupByPerson(list, team, aliases);
  const data = {
    date: day, today, isToday: day === today, people, team: team.map((m) => ({ id: m.id, name: m.name })), week: weekStrip(day, today, first, meta.events, sys, accountNames, { exact: false }),
    totals: { campaigns: list.length, tests: list.filter((c) => c.type === 'TEST').length, scales: list.filter((c) => c.type === 'SCALE').length, people: people.filter((p) => !p.idle).length },
    meta: { ok: meta.ok, failed: meta.failed || [], reason: meta.reason || null },
    note: 'الكامبينات دي من «View history» في كل أكونت (نفس اللي بيظهر في Ads Manager)، فيها اللي اتعمل من جوه السيستم واللي اتعمل بإيدك في Meta. نوع الكامبين (تيست / اسكيل) من اسمه. النتايج = مشتريات Meta من آخر مزامنة، وبتبدأ من تاني يوم لأن الكامبين بيشتغل 12 ص بعد ما بيتعمل.',
  };
  cache.set(day, { at: Date.now(), data }); if (cache.size > 10) cache.delete(cache.keys().next().value);
  return data;
}
