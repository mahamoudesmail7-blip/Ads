// Daily Tasks engine — orchestration over the pure core + the store. Every public function is safe to call twice (idempotent), and every change writes an activity-log line,
// which is what answers «هو عمل إيه ومعملش إيه». Nothing here ever touches Meta, ad accounts or stores.
import { logger } from '../../logger.js';
import { cairoDate, addDays as addDaysAmb } from '../amb/dailyPlanTime.js';
import * as C from './core.js';
import * as S from './store.js';
import { runGenerators, candidatesFromRoutines } from './generators.js';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const today = (now = new Date()) => cairoDate(now);
export const SEED_NAMES = ['Ahmed Samy', 'Samy', 'Mohamed 3sam', 'Hady'];

// ───────────── team ─────────────
export async function getConfig() {
  const cfg = await S.loadConfig();
  if (cfg.seeded || cfg.team.length) return cfg;
  return S.updateConfig((c) => { if (c.seeded || c.team.length) return c; c.seeded = true; c.team = SEED_NAMES.map((name) => ({ id: C.newId('m'), name, userId: null, active: true, off: [], createdAt: new Date().toISOString() })); return c; });
}
export async function addMember({ name, userId = null }) {
  const n = String(name || '').trim().slice(0, 60); if (!n) throw bad('اكتب اسم الشخص.');
  const cfg = await getConfig(); if (cfg.team.some((m) => m.name.toLowerCase() === n.toLowerCase() && m.active !== false)) throw bad('الاسم ده موجود بالفعل في الفريق.', 409);
  const m = { id: C.newId('m'), name: n, userId: userId ? Number(userId) : null, active: true, off: [], createdAt: new Date().toISOString() };
  await S.updateConfig((c) => { c.team.push(m); return c; });
  return m;
}
export async function updateMember(id, patch) {
  let out = null;
  await S.updateConfig((c) => {
    const m = c.team.find((x) => x.id === id); if (!m) throw bad('الشخص مش موجود.', 404);
    if (patch.name != null) { const n = String(patch.name).trim().slice(0, 60); if (!n) throw bad('الاسم فاضي.'); m.name = n; }
    if (patch.userId !== undefined) m.userId = patch.userId ? Number(patch.userId) : null;
    if (patch.active !== undefined) m.active = !!patch.active;
    out = m; return c;
  });
  return out;
}
/** Day off for one date (or back). The person's open tasks of that day go to the others right away. */
export async function setDayOff(memberId, date, off, actor) {
  if (!C.validDate(date)) throw bad('تاريخ غير صالح.');
  let member = null;
  await S.updateConfig((c) => { const m = c.team.find((x) => x.id === memberId); if (!m) throw bad('الشخص مش موجود.', 404); m.off = (m.off || []).filter((d) => d !== date); if (off) m.off.push(date); m.off = m.off.filter((d) => d >= addDaysAmb(today(), -30)); member = m; return c; });
  if (off) await redistributeFrom(date, memberId, actor, `${member.name} إجازة`);
  return member;
}
export async function removeMember(id, actor) {
  const cfg = await getConfig(); const m = cfg.team.find((x) => x.id === id); if (!m) throw bad('الشخص مش موجود.', 404);
  await updateMember(id, { active: false });
  await redistributeFrom(today(), id, actor, `${m.name} اتشال من الفريق`);
  return { ok: true };
}

// ───────────── generation ─────────────
const cap = (n, label) => { if (n > 0) logger.info(`[dailyTasks] ${label}: ${n}`); };

/** Build / refresh a day. First run for a date: roll over yesterday + generate + distribute. Later runs: only NEW problems are added, and problems that vanished are marked AUTO_RESOLVED. */
export async function generateDay(date, { actor = null, deps = {}, now = new Date() } = {}) {
  if (!C.validDate(date)) throw bad('تاريخ غير صالح.');
  const cfg = await getConfig(); const members = C.availableMembers(cfg.team, date);
  const prev = date > today(now) ? null : await S.loadDay(C.addDays(date, -1));
  const gen = await runGenerators({ date, options: cfg.options, members, deps }); // slow reads happen OUTSIDE the lock
  const routines = candidatesFromRoutines(cfg.options.routines, { date, dow: C.dayOfWeek(date), members });
  const stamp = now.toISOString();
  return S.updateDay(date, (day) => {
    const first = !day.generatedAt;
    let carriedIn = [];
    if (first && prev) {
      const r = C.rollOver(prev.tasks, { date, members, now: stamp });
      carriedIn = r.carriedIn;
      if (r.marked.length) S.updateDay(C.addDays(date, -1), (p) => { for (const t of p.tasks) if (r.marked.includes(t.id)) { t.carried = true; t.carriedTo = date; } }).catch((e) => logger.warn('[dailyTasks] mark carried failed', { message: e.message }));
    }
    // tasks written by the first (alert-level) version carry no `category`: while still untouched they are replaced by the product-level tasks below
    for (const t of day.tasks) if (!t.category && t.status === 'PENDING' && t.source === 'AUTO') { t.status = 'CANCELLED'; t.resolvedNote = 'اتبدّلت بمهام المنتجات الجديدة'; }
    const fresh = C.dedupeCandidates([...gen.candidates, ...routines], [...day.tasks, ...carriedIn]).map((c) => C.makeTask(c, { date, source: c.type === 'ROUTINE' ? 'ROUTINE' : 'AUTO', now: stamp }));
    // auto-resolve (open AUTO/CARRIED tasks whose condition is gone — only for generators that ran fine)
    const live = gen.candidates.map((c) => c.key);
    const resolved = C.findAutoResolved([...day.tasks, ...carriedIn], live, gen.okTypes);
    for (const t of [...day.tasks, ...carriedIn]) if (resolved.includes(t.id)) { t.status = 'AUTO_RESOLVED'; t.doneAt = stamp; t.resolvedNote = 'المشكلة اختفت (الحملة اتقفلت أو جابت أوردرات أو اتحلّت)'; S.logEntry(day, { action: 'AUTO_RESOLVED', taskId: t.id, taskTitle: t.title, memberId: t.assigneeId, text: 'السيستم لقى إن المشكلة اتحلّت لوحدها' }); }
    day.tasks.push(...carriedIn);
    const existing = day.tasks;
    const mustPlace = [...carriedIn.filter((t) => !t.assigneeId), ...fresh.filter((t) => !t.assigneeId)];
    day.tasks.push(...fresh);
    if (mustPlace.length) C.distribute(mustPlace, { members, existing: existing.filter((t) => !mustPlace.includes(t)), date });
    for (const t of carriedIn) S.logEntry(day, { action: 'CARRIED', taskId: t.id, taskTitle: t.title, memberId: t.assigneeId, text: `اتنقلت من ${t.carriedFromDate || 'إمبارح'} (مرة ${t.carryCount})` });
    for (const t of fresh) S.logEntry(day, { action: 'ASSIGNED', taskId: t.id, taskTitle: t.title, memberId: t.assigneeId, text: t.assigneeId ? 'اتوزّعت تلقائيًا' : 'مفيش حد متاح — مستنية توزيع' });
    day.generatedAt = day.generatedAt || stamp; day.refreshedAt = stamp;
    day.notes = { carriedIn: (day.notes?.carriedIn || 0) + carriedIn.length, generator: gen.status, lastAdded: fresh.length, lastResolved: resolved.length };
    cap(fresh.length, `${date} new`); return day;
  });
}

/** Take the open tasks of one person (for a date) and give them to the others. */
export async function redistributeFrom(date, memberId, actor, why = '') {
  const cfg = await getConfig(); const members = C.availableMembers(cfg.team, date).filter((m) => m.id !== memberId);
  return S.updateDay(date, (day) => {
    const mine = day.tasks.filter((t) => t.assigneeId === memberId && C.isOpen(t)); if (!mine.length) return day;
    for (const t of mine) t.assigneeId = null;
    if (members.length) C.distribute(mine, { members, existing: day.tasks.filter((t) => !mine.includes(t)), date });
    for (const t of mine) S.logEntry(day, { action: 'REASSIGNED', taskId: t.id, taskTitle: t.title, memberId: t.assigneeId, fromMemberId: memberId, actorName: actor?.name || 'السيستم', text: `اتنقلت لشخص تاني (${why})` });
    return day;
  });
}

/** Re-balance every not-yet-started task of the day between the available people (done / in-progress work stays where it is). */
export async function rebalance(date, actor) {
  const cfg = await getConfig(); const members = C.availableMembers(cfg.team, date);
  return S.updateDay(date, (day) => {
    const movable = day.tasks.filter((t) => t.status === 'PENDING' && t.source !== 'CARRIED_LOCKED');
    for (const t of movable) t.assigneeId = null;
    C.distribute(movable, { members, existing: day.tasks.filter((t) => !movable.includes(t)), date, stickyGap: 0 });
    S.logEntry(day, { action: 'REBALANCED', actorName: actor?.name || 'السيستم', text: `إعادة توزيع بالتساوي (${movable.length} مهمة)` });
    return day;
  });
}

// ───────────── task actions ─────────────
const findTask = (day, id) => { const t = day.tasks.find((x) => x.id === id); if (!t) throw bad('المهمة مش موجودة.', 404); return t; };
function canAct(user, task, cfg) {
  if (user.is_owner || ['ADMIN', 'MANAGER'].includes(user.role)) return true;
  const m = cfg.team.find((x) => x.userId === user.id); return !!m && m.id === task.assigneeId;
}
const nameOf = (cfg, id) => cfg.team.find((m) => m.id === id)?.name || '—';

export async function actOnTask(date, id, action, body, user) {
  const cfg = await getConfig();
  return S.updateDay(date, (day) => {
    const t = findTask(day, id); if (!canAct(user, t, cfg)) throw bad('المهمة دي مش بتاعتك.', 403);
    const now = new Date().toISOString(); const isMgr = user.is_owner || ['ADMIN', 'MANAGER'].includes(user.role);
    const log = (a, text) => S.logEntry(day, { action: a, taskId: t.id, taskTitle: t.title, memberId: t.assigneeId, actorName: user.name, actorId: user.id, text });
    if (action === 'start') { if (t.status !== 'PENDING') throw bad('المهمة مش في حالة «مستني».'); t.status = 'IN_PROGRESS'; t.startedAt = now; log('STARTED', 'بدأ الشغل عليها'); }
    else if (action === 'done') { if (['CANCELLED', 'AUTO_RESOLVED'].includes(t.status)) throw bad('المهمة اتقفلت قبل كده.'); t.status = 'DONE'; t.doneAt = now; t.doneBy = user.name; t.note = String(body.note || '').slice(0, 400) || null; t.reason = null; log('DONE', t.note ? `خلّصها — ${t.note}` : 'خلّصها'); }
    else if (action === 'notdone') { if (['CANCELLED', 'AUTO_RESOLVED'].includes(t.status)) throw bad('المهمة اتقفلت قبل كده.'); const reason = C.NOT_DONE_REASONS[body.reason] ? body.reason : 'OTHER'; t.status = 'NOT_DONE'; t.reason = reason; t.note = String(body.note || '').slice(0, 400) || null; t.doneAt = null; log('NOT_DONE', `ماتعملتش: ${C.NOT_DONE_REASONS[reason]}${t.note ? ` — ${t.note}` : ''}`); }
    else if (action === 'reopen') { if (!isMgr && t.status !== 'DONE') throw bad('مينفعش.'); t.status = 'PENDING'; t.doneAt = null; t.doneBy = null; t.reason = null; log('REOPENED', 'اتفتحت تاني'); }
    else if (action === 'cancel') { if (!isMgr) throw bad('الإلغاء للمدير بس.', 403); t.status = 'CANCELLED'; t.note = String(body.note || '').slice(0, 400) || t.note; log('CANCELLED', `اتلغت${body.note ? ` — ${String(body.note).slice(0, 120)}` : ''}`); }
    else if (action === 'assign') {
      if (!isMgr) throw bad('تغيير الشخص للمدير بس.', 403); const m = cfg.team.find((x) => x.id === body.memberId && x.active !== false); if (!m) throw bad('الشخص مش موجود في الفريق.');
      const from = t.assigneeId; t.assigneeId = m.id; S.logEntry(day, { action: 'REASSIGNED', taskId: t.id, taskTitle: t.title, memberId: m.id, fromMemberId: from, actorName: user.name, actorId: user.id, text: `اتحوّلت من ${nameOf(cfg, from)} لـ ${m.name}` });
    }
    else if (action === 'priority') { if (!isMgr) throw bad('للمدير بس.', 403); if (!C.PRIORITY_WEIGHT[body.priority]) throw bad('أولوية غير صالحة.'); t.priority = body.priority; log('PRIORITY', `الأولوية بقت ${body.priority}`); }
    else throw bad('إجراء غير معروف.');
    return day;
  });
}

export async function addManualTask(date, body, user) {
  const cfg = await getConfig(); const title = String(body.title || '').trim(); if (!title) throw bad('اكتب عنوان المهمة.');
  const members = C.availableMembers(cfg.team, date);
  return S.updateDay(date, (day) => {
    const t = C.makeTask({ type: 'MANUAL', category: body.category, key: null, title, why: body.detail, priority: body.priority, product: body.productName ? { id: null, name: String(body.productName).slice(0, 80) } : null }, { date, source: 'MANUAL' });
    const pick = body.memberId && cfg.team.find((m) => m.id === body.memberId && m.active !== false);
    if (pick) t.assigneeId = pick.id; else C.distribute([t], { members, existing: day.tasks, date });
    day.tasks.push(t); S.logEntry(day, { action: 'CREATED', taskId: t.id, taskTitle: t.title, memberId: t.assigneeId, actorName: user.name, actorId: user.id, text: `${user.name} أضاف المهمة وسلّمها لـ ${nameOf(cfg, t.assigneeId)}` });
    return day;
  });
}

// ───────────── read models ─────────────
export async function getDayView(date, user) {
  const cfg = await getConfig(); let day = await S.loadDay(date);
  const mine = cfg.team.find((m) => m.userId && user && m.userId === user.id)?.id || null;
  const d = day || S.emptyDay(date);
  const members = cfg.team.filter((m) => m.active !== false || d.tasks.some((t) => t.assigneeId === m.id));
  const perMember = C.memberStats([d], members);
  return { date, exists: !!day, today: today(), generatedAt: d.generatedAt, refreshedAt: d.refreshedAt || null, notes: d.notes || null, team: members.map((m) => ({ id: m.id, name: m.name, userId: m.userId || null, active: m.active !== false, off: (m.off || []).includes(date), load: d.tasks.filter((t) => t.assigneeId === m.id && C.isOpen(t)).length })), tasks: d.tasks, log: d.log.slice(-200).reverse(), summary: C.daySummary(d.tasks), perMember, mineId: mine, options: cfg.options, types: C.TYPES, reasons: C.NOT_DONE_REASONS };
}

export async function getReport(from, to) {
  if (!C.validDate(from) || !C.validDate(to) || to < from) throw bad('نطاق تاريخ غير صالح.');
  if (Date.parse(to) - Date.parse(from) > 31 * 86_400_000) throw bad('أقصى نطاق 31 يوم.');
  const cfg = await getConfig(); const days = await S.loadRange(from, to);
  const members = cfg.team.filter((m) => m.active !== false || days.some((d) => d.tasks.some((t) => t.assigneeId === m.id)));
  return { from, to, days: days.map((d) => ({ date: d.date, ...C.daySummary(d.tasks) })), perMember: C.memberStats(days, members), team: members };
}

export async function getEodText(date) { const cfg = await getConfig(); const day = (await S.loadDay(date)) || S.emptyDay(date); return C.eodText({ date, team: cfg.team, tasks: day.tasks }); }

export async function saveOptions(patch) {
  return S.updateConfig((c) => {
    const o = c.options;
    if (typeof patch.autoGenerate === 'boolean') o.autoGenerate = patch.autoGenerate;
    if (/^\d{2}:\d{2}$/.test(patch.generateAt || '')) o.generateAt = patch.generateAt;
    if (Number.isFinite(+patch.refreshMinutes) && +patch.refreshMinutes >= 15) o.refreshMinutes = Math.min(720, Math.round(+patch.refreshMinutes));
    for (const [k, lo, hi] of [['scaleBudget', 100, 5000], ['strongCpa', 10, 500], ['strongScales', 1, 8], ['normalScales', 1, 8], ['testMinOrders', 1, 50], ['minTestStock', 0, 5000], ['testMaxCampaigns', 1, 20], ['maxTest', 0, 40], ['maxFix', 0, 60]]) if (Number.isFinite(+patch[k]) && patch[k] !== '' && patch[k] !== null) o[k] = Math.min(hi, Math.max(lo, Math.round(+patch[k])));
    if (patch.types && typeof patch.types === 'object') for (const k of Object.keys(C.DEFAULT_CONFIG.types)) if (typeof patch.types[k] === 'boolean') o.types[k] = patch.types[k];
    if (Array.isArray(patch.routines)) o.routines = patch.routines.slice(0, 20).map((r) => ({ id: r.id || C.newId('r'), title: String(r.title || '').trim().slice(0, 160), detail: String(r.detail || '').slice(0, 300), priority: C.PRIORITY_WEIGHT[r.priority] ? r.priority : 'LOW', days: Array.isArray(r.days) ? r.days.filter((d) => d >= 0 && d <= 6) : [], mode: r.mode === 'ALL' ? 'ALL' : 'SPREAD' })).filter((r) => r.title);
    return c;
  }).then((c) => c.options);
}
