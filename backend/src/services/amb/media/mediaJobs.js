// AMB Media — long-running jobs (video search, import, page images, AI videos) with progress the wizard polls.
// Persisted as JSON in the existing `settings` table (id `mj:<yyyymmdd>-<rand>`) so no migration is needed and a restart never loses a
// finished result. The RUNNER is in-process (max MAX_PARALLEL at once); a job that was running when the server restarted is detected on
// read (still QUEUED/RUNNING, not live in this process, silent for STALE_MS) and closed as FAILED instead of spinning forever.
// Costs are recorded per job as [{ service, usd, count }] (the same shape the spec calls `costs`).
import crypto from 'node:crypto';
import { prisma } from '../../../prisma.js';
import { logger } from '../../../logger.js';

const PREFIX = 'mj:';
export const STALE_MS = 25 * 60_000;
const KEEP_DAYS = 7;
export const MAX_PARALLEL = 2;
const live = new Set(); // job ids running in THIS process
const waiting = [];     // runner queue
let running = 0;

const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10).replace(/-/g, '');
const save = (job) => prisma.settings.upsert({ where: { id: PREFIX + job.id }, create: { id: PREFIX + job.id, data: JSON.stringify(job) }, update: { data: JSON.stringify(job) } });

export async function createJob({ kind, launchJobId = null, userId = null, input = {} }) {
  const now = new Date().toISOString();
  const job = { id: `${dayKey()}-${crypto.randomBytes(6).toString('hex')}`, kind, launchJobId, userId, status: 'QUEUED', progress: 0, message: 'في الانتظار', input, result: null, error: null, costs: [], createdAt: now, updatedAt: now };
  await save(job);
  prisma.settings.deleteMany({ where: { id: { startsWith: PREFIX, lt: PREFIX + dayKey(new Date(Date.now() - KEEP_DAYS * 86_400_000)) } } }).catch(() => {}); // housekeeping, never blocks
  return job;
}

export async function getJob(id) {
  if (!/^[0-9]{8}-[0-9a-f]{12}$/.test(String(id || ''))) return null;
  const row = await prisma.settings.findUnique({ where: { id: PREFIX + id } });
  if (!row) return null;
  const job = parse(row.data);
  if ((job.status === 'QUEUED' || job.status === 'RUNNING') && !live.has(job.id) && Date.now() - new Date(job.updatedAt).getTime() > STALE_MS) {
    job.status = 'FAILED'; job.error = { code: 'INTERRUPTED', message: 'الشغل اتقطع (السيرفر اتعمله إعادة تشغيل) — ابدأه تاني.' }; job.updatedAt = new Date().toISOString();
    await save(job);
  }
  return job;
}

export async function patchJob(id, patch) {
  const job = await getJob(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  await save(job);
  return job;
}

export class MediaError extends Error {
  constructor(message, code = 'INTERNAL', { user = true, retryAt = null } = {}) { super(message); this.name = 'MediaError'; this.code = code; this.user = user; this.retryAt = retryAt; }
}

/**
 * Run `fn` for a created job. fn gets { progress(pct, message), cost(service, usd, count), job } and returns the result object.
 * Never throws to the caller — the outcome is written to the job (SUCCEEDED | FAILED).
 */
export function startJob(id, fn) {
  const task = async () => {
    live.add(id); running++;
    try {
      await patchJob(id, { status: 'RUNNING', progress: 1, message: 'بدأ الشغل' });
      const costs = [];
      let last = 0;
      const ctx = {
        progress: async (pct, message) => { const now = Date.now(); if (now - last < 400 && pct < 100) return; last = now; await patchJob(id, { progress: Math.max(1, Math.min(99, Math.round(pct))), message: message || undefined }); },
        cost: (service, usd, count = 1) => { const c = costs.find((x) => x.service === service); if (c) { c.usd += usd; c.count += count; } else costs.push({ service, usd, count }); },
      };
      const result = await fn(ctx);
      await patchJob(id, { status: 'SUCCEEDED', progress: 100, message: 'خلص', result, costs });
    } catch (err) {
      logger.warn?.('AMB_MEDIA_JOB_FAILED', { id, code: err.code, message: String(err.message).slice(0, 200) });
      const shown = err instanceof MediaError && err.user !== false; // only our own Arabic messages reach the client; anything else may carry internals
      await patchJob(id, { status: 'FAILED', error: { code: shown ? err.code : 'INTERNAL', message: shown ? String(err.message).slice(0, 400) : 'حصل خطأ غير متوقع — جرّب تاني.', user: shown, retryAt: shown ? err.retryAt || null : null } }).catch(() => {});
    } finally {
      live.delete(id); running--;
      const next = waiting.shift(); if (next) next();
    }
  };
  if (running < MAX_PARALLEL) task(); else waiting.push(task);
}

export const __test = { live, get running() { return running; }, get waiting() { return waiting.length; } };
