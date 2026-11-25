// Ads Payment Center — background follow-up. A 60 s heartbeat that runs the real work only when `monitorEveryMin` (editable in the settings, 1..60) has passed since the last pass, so the cadence
// can be changed without a restart. It survives restarts because the next-due time is derived from the saved `lastTickAt`; interrupted work is detected from the records, not from memory.
// It only READS (the payment provider status / Meta balance) and updates the records; it never extracts a code or moves money.
import { logger } from '../../../logger.js';
import * as S from './store.js';
import * as E from './engine.js';
import * as R from './reports.js';

export async function paymentsTick({ now = Date.now(), force = false } = {}) {
  const [state, cfg] = await Promise.all([S.getMonitorState(), S.getConfig()]);
  if (!force && state.lastTickAt && now - new Date(state.lastTickAt).getTime() < cfg.monitorEveryMin * 60_000 - 5_000) return { skipped: 'NOT_DUE' };
  const r = await E.monitorTick({ now });
  const closings = await R.runClosings({ now }).catch((e) => { logger.warn('[adsPayments] closing failed', { message: e.message }); return { created: [] }; });
  return { ...r, closings: closings.created };
}

let timer = null;
export function startAdsPaymentsMonitor() {
  if (timer) return;
  const tick = async () => { try { await paymentsTick(); } catch (err) { logger.error('[adsPayments] tick failed', { message: err.message }); } };
  setTimeout(tick, 45_000).unref?.();
  timer = setInterval(tick, 60_000);
  timer.unref?.();
  logger.info('Ads payments follow-up started');
}
