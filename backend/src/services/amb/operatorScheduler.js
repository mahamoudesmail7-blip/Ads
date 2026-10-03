// 🤖 AI Operator — SCHEDULER. ONE bounded timer (never one per campaign), never overlapping, default no-op.
//   OFF       -> nothing runs.
//   SHADOW    -> evaluates + records decisions (never executes), reconciles old shadow decisions with hindsight.
//   APPROVAL  -> evaluates + PREPARES decisions for the owner. Never executes by itself.
//   AUTOPILOT -> evaluates; only rules marked AUTOPILOT whose every guard passes execute (see operatorEngine).
// Emergency Stop does NOT stop monitoring: evaluation continues so the dashboard stays truthful, but every guard blocks execution.
// Safety rails (spec 93): one tick at a time, a hard timeout per tick, exponential backoff after consecutive failures, reads synced snapshots only
// (never a Meta call per campaign), sequential awaits (small shared Prisma pool), candidates processed highest-risk first (spec 94).
import { logger } from '../../logger.js';
import { getOperatorConfig, listRules } from './operatorStore.js';
import { evaluateOperator, detectPostScaleDeterioration, detectManualOverrides } from './operatorEngine.js';
import { reconcileShadowOutcomes } from './operatorReports.js';
import { emitOperatorNotifications } from './operatorOps.js';

const INTERVAL_MS = 10 * 60_000;
const TICK_TIMEOUT_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
let timer = null;
let running = false;
let lastRun = null;
let consecutiveFailures = 0;
let nextRunAt = 0;

export function getOperatorSchedulerStatus() {
  return { running, lastRun, intervalMinutes: INTERVAL_MS / 60_000, started: !!timer, consecutiveFailures, nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : null };
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`operator tick timed out after ${ms}ms`)), ms).unref?.())]);

export async function runOperatorTick({ now = new Date(), deps = {} } = {}) {
  const config = await getOperatorConfig();
  if (config.mode === 'OFF') return { skipped: 'MODE_OFF' };
  const rules = (await listRules()).filter((r) => r.enabled);
  const out = { mode: config.mode, emergencyStop: config.emergency_stop, rules: rules.length };
  if (rules.length) {
    const res = await evaluateOperator({ persist: true, now, deps, autoExecute: config.mode === 'AUTOPILOT' });
    out.evaluated = res.campaignsEvaluated; out.candidates = res.candidates.length; out.autoExecuted = res.autoExecuted || 0; out.summary = res.summary; out.expired = res.expired || 0;
  }
  // monitoring-side jobs always run (they only write the Operator's own rows / prepare rollbacks, never execute)
  out.manualOverrides = await detectManualOverrides({ now }).catch((e) => ({ error: e.message }));
  out.shadow = await reconcileShadowOutcomes({ now }).catch((e) => ({ error: e.message }));
  out.postScale = await detectPostScaleDeterioration({ now }).catch((e) => ({ error: e.message }));
  out.notifications = await emitOperatorNotifications({ now, result: out }).catch((e) => ({ error: e.message }));
  return out;
}

export function startOperatorScheduler() {
  if (timer) return;
  timer = setInterval(async () => {
    if (running || Date.now() < nextRunAt) return; // never overlap; honour the backoff window
    running = true;
    try {
      lastRun = { at: new Date().toISOString(), result: await withTimeout(runOperatorTick(), TICK_TIMEOUT_MS) };
      consecutiveFailures = 0; nextRunAt = 0;
    } catch (err) {
      consecutiveFailures++;
      nextRunAt = Date.now() + Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 5));
      lastRun = { at: new Date().toISOString(), error: err.message };
      logger.error('AI Operator tick failed', { message: err.message, consecutiveFailures });
    } finally { running = false; }
  }, INTERVAL_MS);
  timer.unref?.();
  logger.info('AI Operator scheduler started (10-min tick; no-op while mode=OFF; SHADOW by default; backoff on failures)');
}
