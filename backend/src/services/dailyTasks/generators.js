// Daily Tasks — where the work comes from. Every generator READS existing, already-trusted sources (alerts center, scale winners, clone batches, the daily open plan) and returns
// plain candidates { key, type, priority, title, detail, facts, product, … }. Nothing here writes to Meta or anywhere else. A generator that fails reports `ok:false` so the engine
// never concludes «the problem disappeared» from a failed read.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';

const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timeout`)), ms))]);

/** Pure: alerts-center alerts → task candidates (only the kinds a media buyer can act on). */
export function candidatesFromAlerts(alerts) {
  const out = [];
  for (const a of alerts || []) {
    const type = a.kind === 'ZERO_ORDERS' ? 'ZERO_ORDERS' : a.kind === 'CPA' ? 'CPA' : a.kind === 'STOCK' ? 'STOCK' : a.kind === 'FUNDS' ? 'FUNDS' : null;
    if (!type) continue;
    const e = a.entity || {};
    out.push({
      key: `alert:${a.id}`, type, priority: a.severity === 'CRITICAL' ? 'HIGH' : 'MED', title: a.title, detail: [a.detail, a.action ? `المطلوب: ${a.action}` : ''].filter(Boolean).join(' — '),
      facts: (a.facts || []).slice(0, 4), product: e.productId != null || e.productName ? { id: e.productId ?? null, name: e.productName || null } : null,
      accountId: e.adAccountId || null, campaignId: e.campaignId || null, link: { page: 'ai-media-buyer.html', label: 'افتح AI Media Buyer' }, action: a.action || null,
    });
  }
  return out;
}

/** Pure: scale-winner cards → candidates (pending winners + failed attempts that still wait for the owner). */
export function candidatesFromWinners(cards, { max = 8 } = {}) {
  const list = (cards || []).filter((c) => c.decisionStatus === 'PENDING' || c.decisionStatus === 'FAILED').sort((a, b) => (b.orders || 0) - (a.orders || 0)).slice(0, max);
  return list.map((c) => {
    const failed = c.decisionStatus === 'FAILED';
    return {
      key: `scale:${c.sourceCampaignId}`, type: 'SCALE', priority: failed ? 'HIGH' : 'MED',
      title: failed ? `${c.displayName}: الاسكيل فشل — كمّله` : `${c.displayName}: جاهز للاسكيل`,
      detail: failed ? (c.lastHint ? `${c.lastHint.title} — ${c.lastHint.action}` : c.lastError || 'راجع سبب الفشل وكمّل الناقص (من غير ما تكرّر الاسكيل).') : c.recommendation,
      facts: [{ l: 'أوردرات', v: String(c.orders ?? '—') }, { l: 'CPA', v: c.cpa != null ? `${fmt(c.cpa)} ج` : '—' }, { l: 'صرف', v: `${fmt(c.spend)} ج` }],
      product: c.productName ? { id: null, name: c.productName } : { id: null, name: c.displayName }, accountId: c.adAccountId || null, campaignId: c.sourceCampaignId, link: { page: 'ai-media-buyer.html#scale', label: 'افتح مركز التوسّع' },
      action: failed ? 'كمّل الاسكيل' : 'اسكيل بميزانية مناسبة',
    };
  });
}

export function candidatesFromBatches(batches) {
  return (batches || []).map((b) => ({
    key: `clone:${b.batch_id}`, type: 'CLONE', priority: 'HIGH', title: `${b.source_ad_account_name || 'حساب'}: عملية نسخ/اسكيل محتاجة تدخّل (${b.status === 'NEEDS_INPUT' ? 'بيانات ناقصة' : 'فشلت'})`,
    detail: String(b.error || 'افتح الدفعة وكمّل الناقص (لينك الإعلان غالبًا).').slice(0, 220), facts: [{ l: 'نُسخ', v: String(b.total_copies ?? '—') }, { l: 'الحالة', v: b.status }],
    product: null, accountId: b.source_ad_account_id || null, campaignId: null, link: { page: 'ai-media-buyer.html#clone', label: 'افتح الدفعات' }, action: 'كمّل الدفعة',
  }));
}

export function candidateFromPlan(plan) {
  const n = (plan?.items || []).filter((i) => i.selected).length;
  if (!plan || !n) return [];
  return [{ key: `plan:OPEN:${plan.plan_date}`, type: 'OPEN_PLAN', priority: 'HIGH', title: `راجع خطة فتح الحملات (${n} حملة)`, detail: 'خطة اليوم جاهزة — راجعها واعتمدها من AI Operator قبل الميعاد.', facts: [{ l: 'حملات', v: String(n) }], product: null, link: { page: 'ai-media-buyer.html', label: 'افتح AI Operator' }, action: 'راجع واعتمد' }];
}

/** Routine templates → candidates for `date` (days empty = every day; mode ALL = one copy per member, SPREAD = one shared). */
export function candidatesFromRoutines(routines, { date, dow, members }) {
  const out = [];
  for (const r of routines || []) {
    if (!r || !r.title) continue;
    if (Array.isArray(r.days) && r.days.length && !r.days.includes(dow)) continue;
    const base = { type: 'ROUTINE', priority: r.priority || 'LOW', title: String(r.title).slice(0, 200), detail: String(r.detail || ''), product: null, link: null };
    if (r.mode === 'ALL') for (const m of members) out.push({ ...base, key: `routine:${r.id}:${date}:${m.id}`, assigneeId: m.id });
    else out.push({ ...base, key: `routine:${r.id}:${date}` });
  }
  return out;
}

/**
 * Run every enabled generator. Returns { candidates, okTypes, status } — status[type] = { ok, count, error? }.
 * `deps` lets tests inject fakes instead of the database.
 */
export async function runGenerators({ date, options, members, deps = {} }) {
  const on = options.types || {};
  const status = {}; const candidates = []; const okTypes = new Set();
  const run = async (types, label, fn) => {
    if (!types.some((t) => on[t] !== false)) return;
    try { const got = await fn(); const filtered = got.filter((c) => on[c.type] !== false); candidates.push(...filtered); for (const t of types) { okTypes.add(t); status[t] = { ok: true, count: filtered.filter((c) => c.type === t).length }; } }
    catch (e) { logger.warn('[dailyTasks] generator failed', { label, message: e.message }); for (const t of types) status[t] = { ok: false, error: e.message }; }
  };
  await run(['ZERO_ORDERS', 'CPA', 'STOCK', 'FUNDS'], 'alerts', async () => {
    const getAlerts = deps.getAlerts || (async () => (await import('../amb/alertsCenter.js')).getAlertsCenter({ force: false }));
    const r = await withTimeout(getAlerts(), 60_000, 'alerts');
    if ((r.unavailable || []).includes('الحملات')) throw new Error('الحملات غير متاحة وقت القراءة'); // a partial read must not auto-resolve anything
    return candidatesFromAlerts(r.alerts);
  });
  await run(['SCALE'], 'winners', async () => {
    const getWinners = deps.getWinners || (async () => (await import('../amb/scaleWinners.js')).listScaleWinners({ windowName: 'today' }));
    const r = await withTimeout(getWinners(), 90_000, 'winners');
    if (r && r.connected === false) throw new Error('Meta غير متصل');
    return candidatesFromWinners(r.cards);
  });
  await run(['CLONE'], 'clone', async () => {
    const getBatches = deps.getBatches || (async () => prisma.ambCloneBatch.findMany({ where: { status: { in: ['NEEDS_INPUT', 'FAILED'] }, created_at: { gte: new Date(Date.now() - 3 * 86_400_000) } }, select: { batch_id: true, status: true, error: true, total_copies: true, source_ad_account_id: true, source_ad_account_name: true }, take: 20, orderBy: { created_at: 'desc' } }));
    return candidatesFromBatches(await getBatches());
  });
  await run(['OPEN_PLAN'], 'plan', async () => {
    const getPlan = deps.getPlan || (async () => prisma.ambDailyPlan.findFirst({ where: { type: 'OPEN', plan_date: date, simulated: false, status: { in: ['PREPARED', 'APPROVED'] } }, include: { items: { select: { selected: true } } }, orderBy: { version: 'desc' } }));
    return candidateFromPlan(await getPlan());
  });
  return { candidates, okTypes: [...okTypes], status };
}
