// Daily Tasks — where the work comes from. Every source is an EXISTING, already-trusted read (the alerts center + its campaign rows, scale winners, clone batches, the daily open plan);
// the SMART builder (smart.js) turns them into product-level tasks. Nothing here writes to Meta or anywhere else. A source that fails reports `ok:false` so the engine never concludes
// «the problem disappeared» from a failed read.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { buildSmartCandidates, SMART_DEFAULTS } from './smart.js';

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timeout`)), ms))]);

/** Pure: FUNDS alerts → { id, name, accountId, balanceText }. */
export function fundsFromAlerts(alerts) {
  return (alerts || []).filter((a) => a.kind === 'FUNDS').map((a) => ({ id: a.entity?.adAccountId || a.id, name: String(a.title || '').replace(/^حساب\s+/, '').split(':')[0], accountId: a.entity?.adAccountId || null, balanceText: (a.facts || []).find((f) => /الرصيد/.test(f.l))?.v || null }));
}

/** Routine templates → candidates for `date` (days empty = every day; mode ALL = one copy per member, SPREAD = one shared). */
export function candidatesFromRoutines(routines, { date, dow, members }) {
  const out = [];
  for (const r of routines || []) {
    if (!r || !r.title) continue;
    if (Array.isArray(r.days) && r.days.length && !r.days.includes(dow)) continue;
    const base = { type: 'ROUTINE', category: 'MIX', priority: r.priority || 'LOW', title: String(r.title).slice(0, 200), why: String(r.detail || ''), product: null, link: null };
    if (r.mode === 'ALL') for (const m of members) out.push({ ...base, key: `routine:${r.id}:${date}:${m.id}`, assigneeId: m.id });
    else out.push({ ...base, key: `routine:${r.id}:${date}` });
  }
  return out;
}

/**
 * Read every source, build the tasks. Returns { candidates, okTypes, status } — status[type] = { ok, count, error? }.
 * `deps` lets tests inject fakes instead of the database: getAlerts, getRows, getWinners, getBatches, getPlan.
 */
export async function runGenerators({ date, options, members, deps = {} }) {
  const on = options.types || {};
  const status = {}; const okTypes = new Set(); const src = { rows: null, cards: [], funds: [], batches: [], plan: null, zeroLimit: 150, minSpend: 150 };
  const mark = (types, ok, extra = {}) => { for (const t of types) { status[t] = ok ? { ok: true, ...extra } : { ok: false, ...extra }; if (ok) okTypes.add(t); } };
  const ROW_TYPES = ['ZERO_ORDERS', 'CPA', 'TEST', 'STOCK', 'FUNDS', 'DECISIONS'];

  try {
    const getAlerts = deps.getAlerts || (async () => (await import('../amb/alertsCenter.js')).getAlertsCenter({ force: false }));
    const r = await withTimeout(getAlerts(), 120_000, 'alerts');
    if ((r.unavailable || []).includes('الحملات')) throw new Error('الحملات غير متاحة وقت القراءة'); // a partial read must not auto-resolve anything
    let last = deps.getRows ? await deps.getRows() : (await import('../amb/alertsCenter.js')).getLastCampaignRows();
    if (!last && !deps.getRows) { await (await import('../amb/alertsCenter.js')).getAlertsCenter({ force: true }); last = (await import('../amb/alertsCenter.js')).getLastCampaignRows(); }
    if (!last || !Array.isArray(last.rows)) throw new Error('صفوف الحملات مش متاحة');
    src.rows = last.rows; src.zeroLimit = last.zeroLimit || 150; src.minSpend = last.minSpend || 150; src.funds = fundsFromAlerts(r.alerts);
    mark(ROW_TYPES, true);
  } catch (e) { logger.warn('[dailyTasks] rows source failed', { message: e.message }); mark(ROW_TYPES, false, { error: e.message }); }

  try {
    const getWinners = deps.getWinners || (async () => (await import('../amb/scaleWinners.js')).listScaleWinners({ windowName: 'last3' }));
    const r = await withTimeout(getWinners(), 120_000, 'winners');
    if (r && r.connected === false) throw new Error('Meta غير متصل');
    src.cards = r.cards || []; mark(['SCALE'], src.rows != null);
  } catch (e) { logger.warn('[dailyTasks] winners source failed', { message: e.message }); mark(['SCALE'], false, { error: e.message }); }

  try {
    const getBatches = deps.getBatches || (async () => prisma.ambCloneBatch.findMany({ where: { status: { in: ['NEEDS_INPUT', 'FAILED'] }, created_at: { gte: new Date(Date.now() - 3 * 86_400_000) } }, select: { batch_id: true, status: true, error: true, total_copies: true, source_ad_account_id: true, source_ad_account_name: true }, take: 20, orderBy: { created_at: 'desc' } }));
    src.batches = await getBatches(); mark(['CLONE'], true);
  } catch (e) { logger.warn('[dailyTasks] clone source failed', { message: e.message }); mark(['CLONE'], false, { error: e.message }); }

  try {
    const getPlan = deps.getPlan || (async () => prisma.ambDailyPlan.findFirst({ where: { type: 'OPEN', plan_date: date, simulated: false, status: { in: ['PREPARED', 'APPROVED'] } }, include: { items: { select: { selected: true } } }, orderBy: { version: 'desc' } }));
    src.plan = await getPlan(); mark(['OPEN_PLAN'], true);
  } catch (e) { logger.warn('[dailyTasks] plan source failed', { message: e.message }); mark(['OPEN_PLAN'], false, { error: e.message }); }

  const smartOpts = { ...SMART_DEFAULTS, ...Object.fromEntries(Object.keys(SMART_DEFAULTS).filter((k) => Number.isFinite(Number(options[k]))).map((k) => [k, Number(options[k])])), types: on };
  const built = buildSmartCandidates({ ...src, rows: src.rows || [] }, smartOpts);
  // a type whose source failed produces nothing AND is never auto-resolved (okTypes excludes it)
  const candidates = built.candidates.filter((c) => on[c.type] !== false);
  for (const t of Object.keys(status)) if (status[t].ok) status[t].count = candidates.filter((c) => c.type === t).length;
  return { candidates, okTypes: [...okTypes], status };
}
