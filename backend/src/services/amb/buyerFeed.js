// «تنبيه شغل الميديا باير» — the owner's live feed of what the media buyers just did, like Shopify's new-order alert:
//   • a new CAMPAIGN (test / scale / other) shows up in today's activity (Meta «View history» + the system's own launch / clone records), and
//   • a media buyer acted on HIS OWN task in «تاسكات اليوم»: started it, sent proof, or said it was not done.
// READ ONLY. It reuses the cached activity view (≈90 s) and the day's task log; nothing is written anywhere, nothing is sent to Meta. The browser decides what is NEW (ids it has not announced yet).
import { getTodayCampaigns } from './buyerActivity.js';
import { todayISO } from './metricsEngine.js';

const TASK_ACTIONS = new Set(['SUBMITTED', 'STARTED', 'NOT_DONE']);
const LIMIT = 60;

/** Pure: today's activity (people → campaigns) → one feed event per campaign. */
export function campaignEvents(activity) {
  const out = [];
  for (const p of activity?.people || []) for (const c of p.campaigns || []) {
    out.push({ id: `c:${c.id}`, kind: 'CAMPAIGN', type: c.type || 'OTHER', who: p.name || 'مش معروف', title: c.name || c.id, product: c.product || null, account: c.accountName || null, at: c.at });
  }
  return out;
}

/** Pure: a day's task log → events for what a media buyer did on HIS OWN task (the manager's approvals / reassignments never alert the owner about himself). `team` = [{ id, name, userId }]. */
export function taskEvents(day, team) {
  const byId = new Map((team || []).map((m) => [m.id, m]));
  const out = [];
  for (const e of day?.log || []) {
    if (!TASK_ACTIONS.has(e.action)) continue;
    const m = byId.get(e.memberId); if (!m || !m.userId || m.userId !== e.actorId) continue; // only the assignee himself
    out.push({ id: `t:${e.id}`, kind: 'TASK', action: e.action, who: m.name, title: e.taskTitle || 'مهمة', text: e.text || null, at: e.at });
  }
  return out;
}

/** Newest first, capped. Pure. */
export function mergeFeed(...lists) {
  return lists.flat().filter((e) => e && e.id && e.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, LIMIT);
}

/** fast: only what the system itself made + the task log (database only, answers in milliseconds — polled every few seconds). Otherwise Meta's «View history» is read too (at most every 15 s) to catch campaigns made by hand. */
export async function getFeed({ fast = false } = {}) {
  const today = todayISO();
  const S = await import('../dailyTasks/store.js'); const E = await import('../dailyTasks/engine.js');
  const [activity, day, cfg] = await Promise.all([
    getTodayCampaigns({ fast, maxAgeMs: 15_000 }).catch(() => null), // Meta slow / down: the task events still come
    S.loadDay(today).catch(() => null),
    E.getConfig().catch(() => ({ team: [] })),
  ]);
  const team = (cfg.team || []).filter((m) => m.active !== false).map((m) => ({ id: m.id, name: m.name, userId: m.userId || null }));
  return { date: today, now: new Date().toISOString(), events: mergeFeed(campaignEvents(activity), taskEvents(day, team)), meta: { ok: activity ? activity.meta?.ok !== false : false } };
}
