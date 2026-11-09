// Daily Tasks storage — settings rows only (no schema change): `dtk:cfg` = team + options, `dtk:day:YYYY-MM-DD` = that day's tasks + activity log.
// Every read-modify-write of a day goes through `withLock` (one chain per key) so two clicks / the scheduler can never overwrite each other.
import { prisma } from '../../prisma.js';
import { DEFAULT_CONFIG, validDate, newId } from './core.js';

const CFG = 'dtk:cfg'; const DAY = 'dtk:day:';
const parse = (s) => { try { return JSON.parse(s || 'null'); } catch { return null; } };
const chains = new Map();
export function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  chains.set(key, run.catch(() => {}));
  return run;
}

const mergeCfg = (c) => ({ team: Array.isArray(c?.team) ? c.team : [], options: { ...DEFAULT_CONFIG, ...(c?.options || {}), quota: { ...DEFAULT_CONFIG.quota, ...(c?.options?.quota || {}) }, types: { ...DEFAULT_CONFIG.types, ...(c?.options?.types || {}) }, routines: Array.isArray(c?.options?.routines) ? c.options.routines : [] }, seeded: !!c?.seeded, updatedAt: c?.updatedAt || null });

export async function loadConfig() { const row = await prisma.settings.findUnique({ where: { id: CFG } }); return mergeCfg(parse(row?.data)); }
export async function saveConfig(cfg) { const c = { ...cfg, updatedAt: new Date().toISOString() }; const data = JSON.stringify(c); await prisma.settings.upsert({ where: { id: CFG }, create: { id: CFG, data }, update: { data } }); return mergeCfg(c); }
/** Read-modify-write of the config under the lock. */
export const updateConfig = (fn) => withLock(CFG, async () => { const cur = await loadConfig(); const next = (await fn(cur)) || cur; return saveConfig(next); });

export async function loadDay(date) {
  if (!validDate(date)) return null;
  const row = await prisma.settings.findUnique({ where: { id: DAY + date } });
  const d = parse(row?.data); return d && Array.isArray(d.tasks) ? d : null;
}
export async function saveDay(day) { const data = JSON.stringify(day); await prisma.settings.upsert({ where: { id: DAY + day.date }, create: { id: DAY + day.date, data }, update: { data } }); return day; }
export const emptyDay = (date) => ({ date, generatedAt: null, tasks: [], log: [], notes: { carriedIn: 0, generator: {} } });
/** Read-modify-write of a day under its lock. `fn(day)` may mutate and return nothing / return a replacement. */
export const updateDay = (date, fn) => withLock(DAY + date, async () => { const day = (await loadDay(date)) || emptyDay(date); const out = (await fn(day)) || day; await saveDay(out); return out; });
export async function loadRange(from, to) {
  const rows = await prisma.settings.findMany({ where: { id: { gte: DAY + from, lte: DAY + to } } });
  return rows.map((r) => parse(r.data)).filter((d) => d && validDate(d.date) && d.date >= from && d.date <= to).sort((a, b) => a.date.localeCompare(b.date));
}
export const logEntry = (day, e) => { day.log.push({ id: newId('l'), at: new Date().toISOString(), ...e }); if (day.log.length > 800) day.log.splice(0, day.log.length - 800); };
