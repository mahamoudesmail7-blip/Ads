// AI Media Buyer — Campaign Clone activation scheduler. A lightweight 60s
// tick that flips successfully-cloned (PAUSED) campaigns to ACTIVE once their
// per-destination scheduled time passes. All the real work + guards live in
// cloneEngine.activateDueJobs():
//   • only jobs whose batch was APPROVED and is still SCHEDULED/APPROVED
//   • only jobs in status CLONED_PAUSED (never PREFLIGHT_BLOCKED / FAILED /
//     CANCELLED)
//   • honours ambCloneAutoActivate + ambExecutionMode=ADVISORY
// No-ops cleanly when Meta isn't connected.
import { logger } from '../../logger.js';
import { activateDueJobs } from './cloneEngine.js';

let timer = null;

export function startAmbCloneScheduler() {
  if (timer) return;
  const TICK_MS = 60 * 1000;
  timer = setInterval(() => {
    activateDueJobs().catch((err) => logger.error('AMB clone scheduler tick failed', { message: err.message }));
  }, TICK_MS);
  logger.info('AMB clone activation scheduler started (60s tick)');
}
