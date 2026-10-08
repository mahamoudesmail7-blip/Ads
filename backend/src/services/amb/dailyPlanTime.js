// 🕛 Daily Operations Center — Africa/Cairo calendar helpers + the TEST CLOCK. Pure (no DB, no network). 2026-10-07.
//
// Cairo time is MANDATORY: every plan belongs to a Cairo calendar day (YYYY-MM-DD in Africa/Cairo) and is due at 00:00 (OPEN) / 13:00 (PAUSE) Cairo wall-clock, converted to a UTC instant with the DST-correct
// resolver already used by Campaign Schedules. The day changes at Cairo midnight, never at UTC midnight (UTC and Cairo dates differ for 2-3 hours every day).
import { localDateTimeToUtc } from './campaignSchedule.js';

export const CAIRO_TZ = 'Africa/Cairo';
export const SLOTS = { OPEN: '00:00', PAUSE: '13:00' };
export const TYPE_LABEL_AR = { OPEN: 'فتح الحملات — 12:00 صباحًا', PAUSE: 'إيقاف الحملات — 1:00 ظهرًا' };

/** Cairo calendar parts of an instant. */
export function cairoParts(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: CAIRO_TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const hour = +p.hour === 24 ? 0 : +p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, hour, minute: +p.minute, second: +p.second, hhmm: `${String(hour).padStart(2, '0')}:${p.minute}` };
}
export const cairoDate = (now = new Date()) => cairoParts(now).date;
export function addDays(dateStr, n) { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
/** The UTC instant at which `type`'s plan of Cairo day `date` is due. */
export const dueAt = (type, date) => localDateTimeToUtc(date, SLOTS[type], CAIRO_TZ);
/** The plan stays actionable until the END of its Cairo day (= 00:00 Cairo of the next day). After that it is MISSED — never executed late on its own. */
export const expiresAt = (date) => localDateTimeToUtc(addDays(date, 1), '00:00', CAIRO_TZ);
/** Next due instant of `type` strictly after `now`. */
export function nextDue(type, now = new Date()) {
  const today = cairoDate(now);
  for (const d of [today, addDays(today, 1)]) { const t = dueAt(type, d); if (t.getTime() > now.getTime()) return { date: d, at: t }; }
  const d = addDays(today, 2); return { date: d, at: dueAt(type, d) };
}
/** Plans that are DUE at `now`: the type's slot of the current Cairo day has arrived. */
export function dueTypes(now = new Date()) {
  const date = cairoDate(now);
  return Object.keys(SLOTS).filter((t) => now.getTime() >= dueAt(t, date).getTime()).map((type) => ({ type, date, at: dueAt(type, date) }));
}
export const planKey = (type, date, simulated = false, variant = null) => `${simulated ? 'SIM|' : ''}${type}|${date}${variant ? `|${variant}` : ''}`; // `variant` = an owner-ordered ONE-OFF plan (e.g. a single-campaign test): never touched by the scheduler

// ---------------------------------------------------------------------------------------------------------------------------------------------
// TEST CLOCK — lets the owner (and the tests) SEE the 00:00 / 13:00 plans appear without waiting. It is honoured ONLY when DAILY_PLAN_ALLOW_TEST_CLOCK=1 (never set in production), and everything made under
// it is stored as `simulated` plans that the real scheduler ignores and that can never execute.
// ---------------------------------------------------------------------------------------------------------------------------------------------
let testNow = null;
export const testClockAllowed = () => process.env.DAILY_PLAN_ALLOW_TEST_CLOCK === '1';
export function setTestClock(d) { if (!testClockAllowed()) { const e = new Error('الساعة الافتراضية مقفولة (DAILY_PLAN_ALLOW_TEST_CLOCK).'); e.status = 403; throw e; } testNow = d ? new Date(d) : null; return testNow; }
export const clockNow = () => (testClockAllowed() && testNow ? new Date(testNow) : new Date());
export const isTestClock = () => testClockAllowed() && !!testNow;
