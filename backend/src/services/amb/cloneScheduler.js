// AI Media Buyer — Campaign Clone + Schedule server-side ticker. A single 60s
// tick drives BOTH:
//
//   1. activateDueJobs()          — the legacy batch-wide activation time
//      (only when ambCloneAutoActivate is on; skips any job that now has its
//      own per-campaign schedule).
//   2. runDueCampaignSchedules()  — the ADVANCED per-copied-campaign schedules:
//      activate at the approved start instant, pause at the approved end
//      instant, with a live Meta revalidation before every write.
//
// All the real work + guards live in the services. This file is just the
// heartbeat. It keeps working with the browser closed / user logged out.
import { logger } from '../../logger.js';
import { activateDueJobs, reconcileNativeScheduledJobs } from './cloneEngine.js';
import { runDueCampaignSchedules } from './campaignSchedule.js';

let timer = null;

export function startAmbCloneScheduler() {
  if (timer) return;
  const TICK_MS = 60 * 1000;
  const tick = async () => {
    try { await activateDueJobs(); }
    catch (err) { logger.error('AMB clone scheduler tick failed', { message: err.message }); }
    // Native-schedule watch: confirm delivery / catch a stray pause / surface a
    // Meta rejection for SCHEDULED_NATIVE jobs. Never recreates or republishes.
    try { await reconcileNativeScheduledJobs(); }
    catch (err) { logger.error('AMB native schedule reconcile failed', { message: err.message }); }
    try { await runDueCampaignSchedules(); }
    catch (err) { logger.error('AMB campaign schedule tick failed', { message: err.message }); }
  };
  timer = setInterval(tick, TICK_MS);
  logger.info('AMB clone + campaign-schedule scheduler started (60s tick)');
}
