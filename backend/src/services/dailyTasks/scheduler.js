// Daily Tasks scheduler — makes sure every day's tasks are READY before anyone opens the app: builds the day once the Cairo clock passes the configured time, then refreshes it
// (new problems get a task, vanished problems are marked auto-resolved) every `refreshMinutes`. Reads + writes only its own settings rows; never touches Meta.
import { logger } from '../../logger.js';
import { cairoParts } from '../amb/dailyPlanTime.js';
import { getConfig, generateDay } from './engine.js';
import { loadDay } from './store.js';

let timer = null; let busy = false;

export async function tick({ now = new Date(), gen = generateDay } = {}) {
  if (busy) return { skipped: 'busy' };
  busy = true;
  try {
    const cfg = await getConfig(); const o = cfg.options;
    if (!o.autoGenerate) return { skipped: 'off' };
    const p = cairoParts(now); const day = await loadDay(p.date);
    if (!day || !day.generatedAt) { if (p.hhmm < o.generateAt) return { skipped: 'too-early' }; await gen(p.date, { now }); return { built: p.date }; }
    const age = (now.getTime() - Date.parse(day.refreshedAt || day.generatedAt)) / 60_000;
    if (age >= o.refreshMinutes) { await gen(p.date, { now }); return { refreshed: p.date }; }
    return { skipped: 'fresh' };
  } catch (e) { logger.warn('[dailyTasks] scheduler tick failed', { message: e.message }); return { error: e.message }; }
  finally { busy = false; }
}

export function startDailyTasksScheduler() {
  if (timer || process.env.NODE_ENV === 'test') return;
  setTimeout(() => tick().catch(() => {}), 90_000); // shortly after boot — a restart at 9am must not leave the day empty
  timer = setInterval(() => tick().catch(() => {}), 5 * 60_000);
  timer.unref?.();
}
