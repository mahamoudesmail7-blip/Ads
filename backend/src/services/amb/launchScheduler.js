// Campaign Launch Builder — Phase G durable bulk-publish scheduler. Mirrors
// cloneScheduler.js's exact setInterval tick pattern: a plain in-process
// timer that just calls a DB-driven function every tick. The timer itself
// holds NO state that matters — every fact that must survive a Railway
// restart (which campaign is next, whether a 5-minute gap is still pending)
// lives in the amb_launch_jobs/amb_launch_campaigns rows themselves, read
// fresh on every tick by runDueLaunchQueueTick().
import { logger } from '../../logger.js';
import { runDueLaunchQueueTick } from './launchPublish.js';

let timer = null;

export function startLaunchScheduler() {
  if (timer) return;
  const TICK_MS = 30 * 1000; // faster than cloneScheduler's 60s — a bulk publish run benefits from picking up the next ad set/campaign sooner, and each tick is a cheap DB read when nothing is due
  const tick = async () => {
    try { await runDueLaunchQueueTick(); }
    catch (err) { logger.error('AMB launch queue scheduler tick failed', { message: err.message }); }
  };
  timer = setInterval(tick, TICK_MS);
  logger.info('AMB launch (Campaign Launch Builder) bulk-publish scheduler started (30s tick)');
}
