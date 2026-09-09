// AI Creative Factory — background worker heartbeat. A single interval that
// drives the generation-job worker so image generation continues (and
// resumes after a restart) with the browser closed. No-ops when nothing is
// queued. Mirrors services/amb/cloneScheduler.js.
import { logger } from '../../logger.js';
import { processDueJobs } from './generationJob.js';
import { reconcileVariationChildren } from './variations.js';

let timer = null;

export function startCreativeFactoryScheduler() {
  if (timer) return;
  const TICK_MS = 8 * 1000;
  const tick = async () => {
    try { await processDueJobs(); }
    catch (err) { logger.error('CF scheduler tick failed', { message: err.message }); }
    try { await reconcileVariationChildren(); }
    catch (err) { logger.error('CF variation reconcile failed', { message: err.message }); }
  };
  timer = setInterval(tick, TICK_MS);
  logger.info('AI Creative Factory scheduler started (8s tick, no-op when idle)');
}
