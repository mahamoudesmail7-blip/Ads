// 🎯 Daily Tasks (تاسكات اليوم) — the PURE core: task shape, fair distribution between media buyers, roll-over of what was not done, auto-resolve and the per-person statistics.
// No database, no network, no clock — everything that decides «who gets what» and «what happened» lives here so it can be tested exactly.
import crypto from 'node:crypto';

export const OPEN_STATUSES = ['PENDING', 'IN_PROGRESS'];
export const DONE_STATUSES = ['DONE', 'AUTO_RESOLVED'];
export const STATUS_LABEL = { PENDING: 'مستني', IN_PROGRESS: 'شغّال عليه', DONE: 'تم', NOT_DONE: 'ماتعملش', AUTO_RESOLVED: 'اتحل لوحده', CANCELLED: 'ملغي' };
export const PRIORITY_WEIGHT = { HIGH: 3, MED: 2, LOW: 1 };
export const TYPES = {
  ZERO_ORDERS: { label: 'بيصرف ومبيجيبش أوردرات', icon: '🔴' },
  CPA: { label: 'CPA فوق الحد', icon: '📈' },
  STOCK: { label: 'مخزون', icon: '📦' },
  FUNDS: { label: 'رصيد الحساب', icon: '💳' },
  SCALE: { label: 'فرصة اسكيل', icon: '🚀' },
  CLONE: { label: 'اسكيل/كلون محتاج تدخّل', icon: '🧩' },
  TEST: { label: 'تيست جديد', icon: '🧪' },
  REVIEW: { label: 'مراجعة منتج', icon: '🔍' },
  DECISIONS: { label: 'قرارات AI Operator', icon: '🤖' },
  OPEN_PLAN: { label: 'خطة فتح الحملات', icon: '🟢' },
  ROUTINE: { label: 'روتين يومي', icon: '🔁' },
  MANUAL: { label: 'مهمة يدوية', icon: '✍️' },
};
export const NOT_DONE_REASONS = {
  NEEDS_APPROVAL: 'محتاج موافقة المدير',
  MISSING_DATA: 'بيانات أو لينك ناقص',
  NO_TIME: 'ماكانش فيه وقت',
  NOT_RELEVANT: 'مش مناسب دلوقتي',
  OTHER: 'سبب تاني',
};
export const BUCKETS = ['SCALE', 'FIX', 'MIX'];
export const categoryOf = (type) => (type === 'SCALE' ? 'SCALE' : ['ZERO_ORDERS', 'CPA', 'TEST'].includes(type) ? 'FIX' : 'MIX');
export const MAX_CARRY = 3; // after this many roll-overs the task is flagged «متأخر جدًا» and bumped to HIGH
export const DEFAULT_CONFIG = {
  autoGenerate: true, generateAt: '00:05', refreshMinutes: 60, maxPerPerson: 15,
  types: { ZERO_ORDERS: true, CPA: true, TEST: true, REVIEW: true, STOCK: true, FUNDS: true, SCALE: true, CLONE: true, OPEN_PLAN: true, DECISIONS: true },
  scaleBudget: 500, strongCpa: 50, strongScales: 4, normalScales: 2, testMinOrders: 2, minTestStock: 30, testMaxCampaigns: 2, maxTest: 8, maxFix: 20, liteCpa: 100, perPersonTarget: 15, autoDistribute: false,
  routines: [], // [{ id, title, detail, priority, days: [0..6] | [] (every day), mode: 'SPREAD' | 'ALL' }]
};

export const newId = (p = 't') => `${p}_${crypto.randomBytes(4).toString('hex')}`;
export const isAdminUser = (u) => !!(u && (u.is_owner || u.role === 'ADMIN'));
/** Full access to «تاسكات اليوم» (everyone's tasks, distribution, team, settings) = the owner account ONLY (matched by e-mail; override with DAILY_TASKS_ADMIN_EMAILS=a@x,b@y). Every other account — whatever its role in the rest of the app — sees only its own tasks here. */
export const TASKS_ADMIN_EMAILS = String(process.env.DAILY_TASKS_ADMIN_EMAILS || 'mahamoudesmail7@gmail.com').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
export const seesAll = (u) => !!(u && u.email && TASKS_ADMIN_EMAILS.includes(String(u.email).trim().toLowerCase()));
export const isOpen = (t) => OPEN_STATUSES.includes(t.status);
export const weightOf = (t) => PRIORITY_WEIGHT[t.priority] || 2;
export const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
export const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const dayOfWeek = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

/** A task row from a generator candidate / manual entry. */
export function makeTask(c, { date, source = 'AUTO', now = new Date().toISOString() } = {}) {
  return {
    id: newId('t'), key: c.key || null, type: c.type || 'MANUAL', category: BUCKETS.includes(c.category) ? c.category : categoryOf(c.type || 'MANUAL'), source, priority: PRIORITY_WEIGHT[c.priority] ? c.priority : 'MED',
    title: String(c.title || '').trim().slice(0, 200), detail: String(c.detail || '').trim().slice(0, 600), why: String(c.why || '').trim().slice(0, 700), steps: Array.isArray(c.steps) ? c.steps.map((s) => String(s).slice(0, 300)).slice(0, 8) : [], plan: Array.isArray(c.plan) ? c.plan.slice(0, 8) : null, facts: Array.isArray(c.facts) ? c.facts.slice(0, 6) : [],
    product: c.product || null, accountId: c.accountId || null, campaignId: c.campaignId || null, link: c.link || null, action: c.action || null,
    assigneeId: c.assigneeId || null, status: 'PENDING', originDate: date, carryCount: 0, createdAt: now, startedAt: null, doneAt: null, doneBy: null, note: null, reason: null, resolvedNote: null, carried: false, filler: !!c.filler, meta: c.meta || null, numbersAt: now, priorityLocked: false,
  };
}

/** Members that can receive work on `date`: active and not on a day off. */
export function availableMembers(team, date) {
  return (team || []).filter((m) => m.active !== false && !(m.off || []).includes(date));
}

/** Current load of every member = weight of the open tasks they hold. */
export function loadsOf(tasks, members) {
  const load = new Map(members.map((m) => [m.id, { w: 0, n: 0, cat: { SCALE: 0, FIX: 0, MIX: 0 } }]));
  for (const t of tasks) { if (!isOpen(t) || !load.has(t.assigneeId)) continue; const l = load.get(t.assigneeId); l.w += weightOf(t); l.n += 1; l.cat[t.category || 'MIX'] = (l.cat[t.category || 'MIX'] || 0) + 1; }
  return load;
}

/**
 * Fair distribution. Tasks of the SAME product go together to one person (so one buyer owns a product's problems); groups go to whoever carries the least weight right now
 * (ties: fewer tasks, then a stable rotation seeded by the date so it is not always the same person first). A product that already has an open task today stays with its owner
 * unless that would make them more than `stickyGap` heavier than the lightest person. Mutates `toAssign[].assigneeId`; returns the same array.
 */
export function distribute(toAssign, { members, existing = [], date = '', stickyGap = 3 } = {}) {
  if (!members.length) return toAssign;
  const load = loadsOf(existing, members);
  const seed = [...String(date)].reduce((a, c) => a + c.charCodeAt(0), 0);
  const order = new Map(members.map((m, i) => [m.id, (i + seed) % members.length]));
  const owner = new Map(); // product key -> member currently holding an open task of it
  for (const t of existing) { const pk = t.product?.id != null ? `p:${t.product.id}` : t.product?.name ? `n:${t.product.name}` : null; if (pk && isOpen(t) && load.has(t.assigneeId)) owner.set(pk, t.assigneeId); }
  const groups = new Map();
  toAssign.forEach((t, i) => { const pk = t.product?.id != null ? `p:${t.product.id}` : t.product?.name ? `n:${t.product.name}` : `solo:${i}`; const gk = `${t.category || 'MIX'}|${pk}`; if (!groups.has(gk)) groups.set(gk, { pk, cat: t.category || 'MIX', ts: [] }); groups.get(gk).ts.push(t); });
  const catRank = { SCALE: 0, FIX: 1, MIX: 2 };
  const list = [...groups.values()].map((g) => ({ ...g, w: g.ts.reduce((a, t) => a + weightOf(t), 0) })).sort((a, b) => (catRank[a.cat] ?? 3) - (catRank[b.cat] ?? 3) || b.w - a.w || String(a.pk).localeCompare(String(b.pk)));
  // each bucket is spread evenly first (so everyone gets a similar share of scale / fix / mix), then the total weight, then task count
  const lightest = (cat) => [...members].sort((a, b) => (load.get(a.id).cat[cat] || 0) - (load.get(b.id).cat[cat] || 0) || load.get(a.id).w - load.get(b.id).w || load.get(a.id).n - load.get(b.id).n || order.get(a.id) - order.get(b.id))[0];
  for (const g of list) {
    let pick = lightest(g.cat); const sticky = owner.get(g.pk);
    if (sticky && load.has(sticky) && (load.get(sticky).cat[g.cat] || 0) - (load.get(pick.id).cat[g.cat] || 0) <= (stickyGap > 0 ? 1 : 0) && load.get(sticky).w - load.get(pick.id).w <= stickyGap) pick = members.find((m) => m.id === sticky) || pick;
    for (const t of g.ts) t.assigneeId = pick.id;
    const l = load.get(pick.id); l.w += g.w; l.n += g.ts.length; l.cat[g.cat] = (l.cat[g.cat] || 0) + g.ts.length; if (g.pk && !g.pk.startsWith('solo:')) owner.set(g.pk, pick.id);
  }
  return toAssign;
}

/**
 * Yesterday → today: every task that is still open or was reported «ماتعملش» (and not cancelled/finished) is copied to today for the SAME person (the one who did not do it),
 * with carryCount+1. The yesterday row keeps its own status and gets `carried: true` so the report can say «ما اتعملش ← اتنقل».
 * If the person is gone / inactive / off today, the task is left unassigned here and the caller distributes it. Pure: returns { carriedIn, marked }.
 */
export function rollOver(prevTasks, { date, members, now = new Date().toISOString() } = {}) {
  const ids = new Set(members.map((m) => m.id)); const carriedIn = []; const marked = [];
  for (const t of prevTasks || []) {
    if (t.carried || !(isOpen(t) || t.status === 'NOT_DONE')) continue;
    marked.push(t.id);
    const n = { ...t, id: newId('t'), source: 'CARRIED', status: 'PENDING', carried: false, carryCount: (t.carryCount || 0) + 1, carriedFromId: t.id, carriedFromDate: t.originDateOfCarry || t.originDate, createdAt: now, startedAt: null, doneAt: null, doneBy: null, reason: null, note: null, assigneeId: ids.has(t.assigneeId) ? t.assigneeId : null };
    n.originDate = t.originDate; // the day the problem FIRST appeared stays visible («متأخر من 3 أيام»)
    if (n.carryCount >= MAX_CARRY) n.priority = 'HIGH';
    carriedIn.push(n);
  }
  return { carriedIn, marked };
}

/** Candidates that are not already represented: an open/finished task today with the same key blocks a new one (carried tasks count). */
export function dedupeCandidates(cands, existing) {
  const seen = new Set((existing || []).filter((t) => t.key && t.status !== 'CANCELLED').map((t) => t.key));
  const out = [];
  for (const c of cands) { if (!c.key || seen.has(c.key)) continue; seen.add(c.key); out.push(c); }
  return out;
}

/** Open AUTO tasks whose condition is gone (their key is no longer produced by a generator that ran fine) → resolved by the system. `okTypes` = types whose generator succeeded. */
export function findAutoResolved(existing, liveKeys, okTypes) {
  const live = new Set(liveKeys); const ok = new Set(okTypes);
  return (existing || []).filter((t) => isOpen(t) && t.key && t.category && !t.filler && (t.source === 'AUTO' || t.source === 'CARRIED') && ok.has(t.type) && !live.has(t.key)).map((t) => t.id); // `category` = a task built by the product-level builder (older rows are never auto-judged)
}

/** Per-member numbers for a set of day docs (each { date, tasks }). A carried copy is counted on the day it was worked, the original on its own day as «ما اتعملش». */
export function memberStats(days, team) {
  const rows = new Map((team || []).map((m) => [m.id, { memberId: m.id, name: m.name, assigned: 0, done: 0, notDone: 0, missed: 0, autoResolved: 0, open: 0, cancelled: 0, doneHours: [] }]));
  for (const d of days) for (const t of d.tasks || []) {
    const r = rows.get(t.assigneeId); if (!r) continue;
    if (t.status === 'CANCELLED') { r.cancelled++; continue; }
    r.assigned++;
    if (t.status === 'DONE') { r.done++; if (t.doneAt && t.createdAt) r.doneHours.push((Date.parse(t.doneAt) - Date.parse(t.createdAt)) / 3.6e6); }
    else if (t.status === 'AUTO_RESOLVED') r.autoResolved++;
    else if (t.status === 'NOT_DONE') r.notDone++;
    else if (t.carried) r.missed++;
    else r.open++;
  }
  return [...rows.values()].map((r) => {
    const base = r.assigned - r.autoResolved; // what the person was actually accountable for
    const avg = r.doneHours.length ? r.doneHours.reduce((a, b) => a + b, 0) / r.doneHours.length : null;
    return { ...r, doneHours: undefined, avgHours: avg == null ? null : Math.round(avg * 10) / 10, rate: base > 0 ? Math.round((r.done / base) * 100) : null };
  });
}

/** Day summary for the header. */
export function daySummary(tasks) {
  const live = (tasks || []).filter((t) => t.status !== 'CANCELLED');
  const c = (f) => live.filter(f).length;
  const done = c((t) => t.status === 'DONE'); const auto = c((t) => t.status === 'AUTO_RESOLVED');
  const accountable = live.length - auto;
  const byCat = Object.fromEntries(BUCKETS.map((b) => [b, { total: live.filter((t) => (t.category || 'MIX') === b).length, done: live.filter((t) => (t.category || 'MIX') === b && ['DONE', 'AUTO_RESOLVED'].includes(t.status)).length }]));
  return { byCat, total: live.length, done, autoResolved: auto, pending: c((t) => t.status === 'PENDING'), inProgress: c((t) => t.status === 'IN_PROGRESS'), notDone: c((t) => t.status === 'NOT_DONE'), carried: c((t) => t.source === 'CARRIED'), unassigned: c((t) => !t.assigneeId && isOpen(t)), rate: accountable > 0 ? Math.round((done / accountable) * 100) : null };
}

/** A plain-Arabic end-of-day text (copy → WhatsApp). */
export function eodText({ date, team, tasks }) {
  const lines = [`📋 تقرير تاسكات يوم ${date}`]; const s = daySummary(tasks);
  lines.push(`الإجمالي ${s.total} · تم ${s.done} · اتحل لوحده ${s.autoResolved} · لسه ${s.pending + s.inProgress} · ماتعملش ${s.notDone}${s.rate != null ? ` · نسبة الإنجاز ${s.rate}%` : ''}`);
  for (const m of team) {
    const mine = tasks.filter((t) => t.assigneeId === m.id && t.status !== 'CANCELLED'); if (!mine.length) continue;
    const d = mine.filter((t) => t.status === 'DONE').length;
    lines.push('', `👤 ${m.name} — ${d}/${mine.length}`);
    for (const t of mine) lines.push(`  ${t.status === 'DONE' ? '✅' : t.status === 'AUTO_RESOLVED' ? '🤖' : t.status === 'NOT_DONE' ? '❌' : '⏳'} ${t.title}${t.status === 'NOT_DONE' && t.reason ? ` (${NOT_DONE_REASONS[t.reason] || t.reason})` : ''}`);
  }
  return lines.join('\n');
}
