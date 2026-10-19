// 🩺 AUTOMATIC DIAGNOSTICS — «ليه AUTOMATIC ما نفّذش؟» answered from what is really stored, in plain language. READ-ONLY: no Meta call, no limit/permission/policy/mode change.
//   automationDiagnostics()  the whole engine at a glance: last cycle · evaluated / executed / blocked · blocked reasons (with the products they hit) · account + campaign + product limits (used / remaining) ·
//                            duplicates · expired · incomplete policies · pause-policy scope gaps · Meta sync.
//   productDiagnosis()       ONE product: the gate chain an AUTOMATIC action must pass (mode · lock · emergency · product policy · readiness · permission · Auto switch · scope · limits) and, per campaign, the latest decision
//                            with the real reason it did / did not run.
//   Limits keep their definitions: the per-campaign counter is the number of REAL changes in a rolling 24h (executed Operator decisions + manual/legacy AMB actions; never blocked / failed / duplicate / expired decisions).
import { prisma } from '../../prisma.js';
import { getOperatorConfig } from './operatorStore.js';
import { getPausePolicy, pausePolicyActive } from './pausePolicy.js';
import { scopeVerdict, describeScope } from './automationScope.js';
import { limitUsage, DIFFERENCE_NOTE } from './dailyLimits.js';
import { BLOCK_CODES } from './operatorGuards.js';
import { autoActionsState, missingAutoToggles, AUTO_ACTIONS } from './operatorAutoActions.js';

const MS_H = 3_600_000, MS_M = 60_000;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const ACTION_AR = { PAUSE: 'إيقاف', SCALE_UP: 'زيادة ميزانية', SCALE_DOWN: 'تقليل ميزانية', OPEN: 'فتح' };
const SEV = { B: 'BLOCK', D: 'DOWNGRADE', W: 'WARN' };
export const CURRENT_MINUTES = 30; // a decision the engine re-evaluated within this window is blocking something RIGHT NOW

/** Who can resolve a reason: the OWNER (a policy / switch / permission he controls) · DATA (something to complete) · SAFETY (a guard that must stay) · LIMIT (a daily limit). */
const EXTRA = {
  OUT_OF_SCOPE: ['OWNER', 'خارج نطاق السياسة المعتمدة (المنتج/الحملة مش ضمن المضمّن فيها) — الإضافة قرارك أنت.'],
  EXCLUDED_BY_POLICY: ['OWNER', 'مستبعد بقرار صريح في السياسة.'],
  DAY_NOT_ALLOWED: ['OWNER', 'اليوم مش ضمن أيام التشغيل في السياسة.'],
  AUTO_ACTION_DISABLED: ['OWNER', 'مفتاح الـAuto لنوع الأكشن ده مقفول — القرار بيستنى موافقتك.'],
  DOWNGRADE_TO_APPROVAL: ['SAFETY', 'القرار محتاج موافقتك (مخزون/ربحية غير مؤكدين أو المستشار الذكي مش موافق).'],
  NEEDS_CONFIGURATION: ['DATA', 'المنتج ناقص إعداد (اقتصاديات / حدود) — AUTOMATIC لا يعمل عليه قبل ما يكتمل.'],
  WINNER_REVIEW: ['SAFETY', 'الحملة رابحة تاريخيًا — مفيش إيقاف تلقائي، محتاجة مراجعة يدوية.'],
  UNKNOWN_WINNER_REVIEW: ['SAFETY', 'تعذّر تحديد إذا كانت الحملة رابحة — مراجعة يدوية بدل إيقاف تلقائي.'],
  OSCILLATION_GUARD: ['SAFETY', 'ممنوع الاتجاه العكسي (زيادة بعد تقليل أو العكس) قبل انتهاء المدة المحمية.'],
  MAPPING_NOT_VERIFIED: ['DATA', 'ربط الحملة بالمنتج غير مؤكد.'], MAPPING_UNRELIABLE: ['DATA', 'ربط الحملة بالمنتج غير موثوق.'], STORE_AMBIGUOUS: ['DATA', 'المتجر غير محدد بشكل مؤكد.'],
  POST_OPEN_MONITORING: ['SAFETY', 'الحملة تحت مراقبة بعد الفتح.'], BUDGET_UNKNOWN: ['DATA', 'الميزانية الحالية غير معروفة.'], META_MIN_BUDGET: ['SAFETY', 'الميزانية الجديدة أقل من الحد الأدنى المسموح.'],
  STOCK_UNKNOWN: ['DATA', 'المخزون غير معروف.'], ECONOMICS_INCOMPLETE: ['DATA', 'اقتصاديات المنتج غير مكتملة.'], ADVISOR_PLAN_MISSING: ['DATA', 'خطة المستشار الذكي غير موجودة.'],
  BUDGET_CAP: ['LIMIT', 'الزيادة هتتجاوز حدّ الميزانية.'], PRODUCT_MAX_CHANGES_PER_DAY: ['LIMIT', 'المنتج استنفد أقصى عدد تعديلات ميزانية في اليوم.'], MAX_ACTIONS_PER_TICK: ['LIMIT', 'حد الأكشنز في الدورة الواحدة.'], MAX_ACTIONS_PER_HOUR: ['LIMIT', 'حد الأكشنز في الساعة.'],
  DUPLICATE_ALREADY_APPLIED: ['SAFETY', 'نفس التغيير اتنفّذ بقرار تاني — ما اتعادش.'], NO_LONGER_APPLICABLE: ['SAFETY', 'القرار القديم مبقاش بيطلع من التقييم الحالي.'], SUPERSEDED: ['SAFETY', 'قرار أحدث حلّ محله.'],
};
const LIMIT_CODES = ['CAMPAIGN_DAILY_LIMIT', 'ACCOUNT_DAILY_LIMIT', 'STORE_DAILY_LIMIT', 'RATE_LIMIT_DAY', 'RATE_LIMIT_HOUR'];

/** A stored block in ANY of its shapes ({code,message}, "CODE[B]:detail", {code,severity,detail}) → { code, severity, detail, message, owner, label }. */
export function normalizeBlock(b) {
  if (b == null) return null;
  const text = typeof b === 'string' ? b : String(b.message || b.code || '');
  const m = text.match(/^([A-Z][A-Z0-9_]+)\[(B|D|W)\](?::(.*))?$/);
  const code = (typeof b === 'object' && b.code && !/\[/.test(b.code)) ? b.code : (m ? m[1] : (text.match(/^[A-Z][A-Z0-9_]+$/) ? text : null));
  if (!code) return null;
  const severity = (typeof b === 'object' && b.severity) || (m ? SEV[m[2]] : (BLOCK_CODES[code]?.severity || 'BLOCK'));
  const detail = (typeof b === 'object' && b.detail) || (m ? m[3] || null : null);
  const x = EXTRA[code]; const bc = BLOCK_CODES[code];
  const owner = LIMIT_CODES.includes(code) ? 'LIMIT' : x ? x[0] : (bc?.group === 'DATA_QUALITY' ? 'DATA' : 'SAFETY');
  const label = bc?.message || (x && x[1]) || (typeof b === 'object' && b.message && !/^[A-Z][A-Z0-9_]+(\[|$)/.test(b.message) ? b.message : code);
  return { code, severity, detail, owner, label, message: typeof b === 'object' && b.message && !/^[A-Z][A-Z0-9_]+(\[|$)/.test(b.message) ? b.message : label };
}
export const blocksOf = (row) => (j(row?.blocked_codes_json, []) || []).map(normalizeBlock).filter(Boolean);
const isOpen = (s) => ['PREPARED', 'BLOCKED', 'SHADOW'].includes(s);
const isCurrent = (row, now) => isOpen(row.status) && (now.getTime() - new Date(row.updated_at).getTime()) <= CURRENT_MINUTES * MS_M;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the gate chain (pure): every layer an AUTOMATIC action has to pass, each with its real state
// ---------------------------------------------------------------------------------------------------------------------------------------------
export function gateChain({ config, settings, pause, product, usage = [], scope = null }) {
  const perm = config?.execPermissions || {}; const common = [], by = {};
  const g = (key, label, ok, detail) => ({ key, label, ok, detail });
  common.push(g('MODE', 'وضع النظام', config?.mode === 'AUTOPILOT', config?.mode === 'AUTOPILOT' ? 'AUTOMATIC (AUTOPILOT)' : `الوضع ${config?.mode === 'OFF' ? 'MANUAL' : config?.mode} — التنفيذ التلقائي محتاج AUTOMATIC`));
  common.push(g('LOCK', 'قفل كتابة Meta على مستوى النشر', config?.writesLocked === false, config?.writesLocked === false ? 'مفتوح' : 'مقفول'));
  common.push(g('EMERGENCY', 'إيقاف الطوارئ', !config?.emergency_stop, config?.emergency_stop ? 'مفعّل — بيكسب على أي حاجة' : 'مش مفعّل'));
  const pm = product?.policy?.mode, ps = product?.policy?.status;
  common.push(g('PRODUCT_MODE', 'سياسة المنتج', pm === 'AUTOMATIC' && String(ps).startsWith('ACTIVE'), pm === 'AUTOMATIC' && String(ps).startsWith('ACTIVE') ? 'AUTOMATIC ومعتمدة' : ps === 'NONE' || !ps ? 'مفيش سياسة معتمدة' : `${ps} / ${pm || '—'} — لازم ACTIVE + AUTOMATIC`));
  common.push(g('READINESS', 'جاهزية المنتج', product?.state === 'READY', product?.state === 'READY' ? 'READY' : `${product?.state || '—'}: ${(product?.missing || []).map((m) => m.label).join(' · ') || product?.blockedReason || ''}`));
  const switchOf = (action) => { const miss = missingAutoToggles(action, settings); return miss.length ? `مقفول: ${miss.map((k) => AUTO_ACTIONS.find((t) => t.key === k)?.label_ar).join(' + ')}` : 'مفتوح'; };
  const permKey = { PAUSE: 'pause', SCALE_UP: 'budgetIncrease', SCALE_DOWN: 'budgetDecrease', OPEN: 'open' };
  for (const action of ['SCALE_DOWN', 'SCALE_UP', 'PAUSE']) {
    const rows = []; const miss = missingAutoToggles(action, settings);
    rows.push(g('PERMISSION', 'صلاحية التنفيذ', perm[permKey[action]] === true, perm[permKey[action]] === true ? 'ON' : 'OFF'));
    rows.push(g('AUTO_SWITCH', 'مفتاح Auto', miss.length === 0, switchOf(action)));
    if (action === 'PAUSE') { const sv = scope && pause ? scopeVerdict(pause.scope, scope) : null; const active = pausePolicyActive(pause); rows.push(g('PAUSE_POLICY', 'سياسة الإيقاف', active, active ? `معتمدة v${pause.version}` : 'غير مفعّلة/غير معتمدة')); rows.push(g('PAUSE_SCOPE', 'نطاق سياسة الإيقاف', !sv, sv ? `${sv === 'OUT_OF_SCOPE' ? 'المنتج خارج النطاق' : 'مستبعد'} — النطاق: ${describeScope(pause?.scope)}` : 'داخل النطاق')); }
    const lim = (k) => usage.find((u) => u.key === k);
    if (action === 'SCALE_UP') { const a = lim('budgetIncrease'), e = lim('exposure'); rows.push(g('LIMIT_INCREASE', 'حد زيادة الميزانية (24س)', !a || a.state !== 'FULL', a?.limit == null ? 'مفيش حد' : `${a.used} من ${a.limit} (المتبقي ${a.remaining})`)); rows.push(g('LIMIT_EXPOSURE', 'حد التعرض المالي', !e || e.state !== 'FULL', e?.limit == null ? 'مفيش حد' : `${e.used} من ${e.limit} (المتبقي ${e.remaining})`)); }
    if (action === 'PAUSE') { const p = lim('pauses'); rows.push(g('LIMIT_PAUSES', 'حد الإيقاف (24س)', !p || p.state !== 'FULL', p?.limit == null ? 'مفيش حد' : `${p.used} من ${p.limit} (المتبقي ${p.remaining})`)); }
    const d = lim('actionsDay'), h = lim('actionsHour'); rows.push(g('LIMIT_ACTIONS', 'حد الأكشنز (يوم/ساعة)', (!d || d.state !== 'FULL') && (!h || h.state !== 'FULL'), `${d?.used ?? 0}/${d?.limit ?? '—'} يوم · ${h?.used ?? 0}/${h?.limit ?? '—'} ساعة`));
    by[action] = rows;
  }
  const blocking = (rows) => rows.filter((r) => !r.ok);
  const commonBlock = blocking(common);
  return { common, actions: by, canRun: Object.fromEntries(Object.entries(by).map(([a, rows]) => [a, commonBlock.length === 0 && blocking(rows).length === 0])), firstBlock: Object.fromEntries(Object.entries(by).map(([a, rows]) => [a, (commonBlock[0] || blocking(rows)[0] || null)])) };
}

/** What happened to a decision, in words. */
export function verdictOf(row, now = new Date()) {
  if (!row) return { state: 'NONE', text: 'مفيش قرار حديث لهذه الحملة.' };
  const b = blocksOf(row).filter((x) => x.severity !== 'WARN'); const first = b[0];
  if (['VERIFIED', 'EXECUTED'].includes(row.status)) return { state: 'EXECUTED', text: `نُفّذ ${row.status === 'VERIFIED' ? 'واتأكد من Meta' : '(لم يُؤكَّد بقراءة Meta بعد)'}.` };
  if (row.status === 'UNCERTAIN') return { state: 'UNCERTAIN', text: 'الطلب ممكن يكون خرج — راجع الحملة يدويًا (مفيش إعادة إرسال).' };
  if (row.status === 'FAILED') return { state: 'FAILED', text: `فشل التنفيذ: ${String(row.error || '').slice(0, 120)}` };
  if (row.status === 'EXPIRED') return { state: 'EXPIRED', text: `انتهى: ${String(row.error || 'لم يعد ينطبق').slice(0, 120)}` };
  if (row.status === 'PREPARED' && !first) return { state: 'WAITING', text: isCurrent(row, now) ? 'جاهز — بيتنفّذ في دورة المحرك الجاية لو كل الشروط لسه سليمة.' : 'مجهّز لكن لم يُعد المحرك تقييمه من فترة (قديم).' };
  if (first) return { state: isCurrent(row, now) ? 'BLOCKED_NOW' : 'BLOCKED_OLD', text: `${isCurrent(row, now) ? 'ممنوع دلوقتي' : 'منع قديم (القرار لم يُعد تقييمه)'}: ${first.label}${first.detail ? ` — ${first.detail}` : ''}` };
  return { state: row.status, text: row.status };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the engine at a glance
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function load(deps, now) {
  const config = deps.config || await getOperatorConfig();
  const settings = deps.settings || await (await import('./settings.js')).getAmbSettings().catch(() => ({}));
  const pause = deps.pause || await getPausePolicy();
  const overview = deps.overview || await (await import('./bulkActivation.js')).bulkOverview({ now });
  return { config, settings, pause, overview };
}
const productsOf = (overview) => overview.products || [];

export async function automationDiagnostics({ now = new Date(), deps = {} } = {}) {
  const { config, settings, pause, overview } = await load(deps, now);
  const dayAgo = new Date(now.getTime() - 24 * MS_H);
  const rows = deps.decisions || await prisma.ambOperatorDecision.findMany({ where: { OR: [{ updated_at: { gte: dayAgo } }, { status: { in: ['PREPARED', 'BLOCKED'] } }] }, select: { id: true, product_id: true, store_id: true, campaign_id: true, campaign_name: true, action: true, rule_name: true, status: true, error: true, blocked_codes_json: true, created_at: true, updated_at: true, executed_at: true }, take: 3000 });
  const byStatus = {}; for (const r of rows) if (new Date(r.updated_at) >= dayAgo || isOpen(r.status)) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const names = new Map(productsOf(overview).map((p) => [p.productId, p.name]));
  const prodName = (r) => (r.product_id != null ? names.get(r.product_id) : null) || (r.campaign_name || '').split(' _')[0].split(' -')[0] || '—';
  // blocked reasons — CURRENT (re-evaluated in the last 30 min) apart from OLD (nobody re-evaluated them)
  const reasons = new Map();
  for (const r of rows.filter((x) => ['BLOCKED', 'PREPARED'].includes(x.status))) {
    const cur = isCurrent(r, now); for (const b of blocksOf(r).filter((x) => x.severity !== 'WARN')) {
      const e = reasons.get(b.code) || { code: b.code, label: b.label, owner: b.owner, currentCount: 0, oldCount: 0, products: new Set() };
      cur ? e.currentCount++ : e.oldCount++; e.products.add(prodName(r)); reasons.set(b.code, e);
    }
  }
  const reasonList = [...reasons.values()].map((e) => ({ ...e, products: [...e.products].slice(0, 12) })).sort((a, b) => b.currentCount - a.currentCount || b.oldCount - a.oldCount);
  // duplicates + stale
  const open = rows.filter((r) => isOpen(r.status)); const g = new Map(); for (const r of open) { const k = `${r.campaign_id}|${r.action}|${r.rule_name}`; g.set(k, (g.get(k) || 0) + 1); }
  const dupGroups = [...g.values()].filter((n) => n > 1); const staleOpen = open.filter((r) => r.status === 'PREPARED' && (now.getTime() - new Date(r.updated_at).getTime()) > 24 * MS_H).length;
  const expired = rows.filter((r) => r.status === 'EXPIRED' && new Date(r.updated_at) >= dayAgo); const expiredBy = {}; for (const r of expired) { const k = String(r.error || '').split(':')[0] || 'OTHER'; expiredBy[k] = (expiredBy[k] || 0) + 1; }
  // limits
  const usage = deps.usage || (overview.dailyLimits?.rows?.length ? overview.dailyLimits.rows : limitUsage({ config, counters: deps.counters || {} })); // the overview already computed them with the live campaign list
  const campLimit = Number(config?.limits?.maxChangesPerCampaignPerDay) || null;
  const ids = productsOf(overview).flatMap((p) => p.campaigns?.ids || []);
  const recent = deps.recent || (ids.length ? await (await import('./operatorContext.js')).loadRecentActions({ campaignIds: ids, now }).catch(() => new Map()) : new Map());
  const campaignCounters = [...recent.entries()].filter(([, e]) => e.todayCount > 0).map(([cid, e]) => ({ campaignId: cid, name: rows.find((r) => r.campaign_id === cid)?.campaign_name || null, used: e.todayCount, limit: campLimit, remaining: campLimit == null ? null : Math.max(0, campLimit - e.todayCount) })).sort((a, b) => b.used - a.used).slice(0, 30);
  const dayStart = deps.dayStart || new Date(new Date(now.getTime() + 3 * MS_H).toISOString().slice(0, 10) + 'T00:00:00Z').getTime() - 3 * MS_H;
  const budgetToday = rows.filter((r) => String(r.rule_name || '').startsWith('AUTO:') && !String(r.rule_name).startsWith('AUTO:MANUAL') && ['SCALE_UP', 'SCALE_DOWN'].includes(r.action) && ['EXECUTING', 'EXECUTED', 'VERIFIED', 'UNCERTAIN'].includes(r.status) && new Date(r.updated_at).getTime() >= dayStart);
  const perProduct = productsOf(overview).filter((p) => ['AUTOMATIC', 'APPROVAL'].includes(p.policy?.mode)).map((p) => { const used = budgetToday.filter((r) => r.product_id === p.productId).length; const lim = p.limits?.maxChangesPerDay ?? null; return { key: p.key, productId: p.productId, name: p.name, mode: p.policy.mode, state: p.state, dailyCap: p.limits?.dailyCap ?? null, minBudget: p.limits?.minBudget ?? null, maxBudget: p.limits?.maxBudget ?? null, maxChangesPerDay: lim, changesToday: used, remaining: lim == null ? null : Math.max(0, lim - used), runningBudget: p.runningBudget }; });
  // policies + scope gaps + sync
  const incomplete = productsOf(overview).filter((p) => ['AUTOMATIC', 'APPROVAL'].includes(p.policy?.mode) && p.state !== 'READY').map((p) => ({ key: p.key, name: p.name, state: p.state, mode: p.policy.mode, missing: (p.missing || []).map((m) => m.label), blockedReason: p.blockedReason }));
  const pauseActive = pausePolicyActive(pause);
  const uncovered = productsOf(overview).filter((p) => p.policy?.mode === 'AUTOMATIC' && String(p.policy.status).startsWith('ACTIVE')).map((p) => ({ key: p.key, name: p.name, verdict: scopeVerdict(pause.scope, { productId: p.productId, storeId: p.storeId }) })).filter((x) => x.verdict);
  const sync = deps.sync || await (await import('./snapshotSync.js')).getSyncStatus().catch(() => null);
  const last = deps.lastRun !== undefined ? deps.lastRun : (await import('./automationEngine.js')).getAutomationStatus().lastRun;
  const lastAt = last?.at ? new Date(last.at) : null;
  return {
    generatedAt: now.toISOString(),
    engine: { lastRunAt: last?.at || null, ageMinutes: lastAt ? Math.round((now.getTime() - lastAt.getTime()) / MS_M) : null, evaluated: last?.evaluated ?? null, executedInLastCycle: (last?.executed || []).length, deferred: last?.deferred || [], gate: last?.gate || [], skipped: last?.skipped ?? null, stale: !!last?.stale, note: lastAt ? null : 'الدورة الأخيرة بتتحفظ في ذاكرة السيرفر — لسه ما اشتغلتش من آخر تشغيل للسيرفر.', mode: config.mode },
    totals: { products: productsOf(overview).length, enrolled: perProduct.length, automatic: perProduct.filter((p) => p.mode === 'AUTOMATIC').length, executed24h: (byStatus.VERIFIED || 0) + (byStatus.EXECUTED || 0), uncertain24h: byStatus.UNCERTAIN || 0, failed24h: byStatus.FAILED || 0, prepared: byStatus.PREPARED || 0, blocked: byStatus.BLOCKED || 0, expired24h: expired.length, byStatus },
    reasons: reasonList,
    limits: { window: 'ROLLING_24H', account: usage, differenceNote: DIFFERENCE_NOTE, campaign: { limit: campLimit, counts: 'تغييرات فعلية في آخر 24 ساعة (قرارات Operator منفّذة + إجراءات يدوية/قديمة) — القرارات الممنوعة والفاشلة والمكررة والمنتهية مش بتتحسب.', rows: campaignCounters }, perProduct },
    duplicates: { openGroups: dupGroups.length, redundantRows: dupGroups.reduce((t, n) => t + n - 1, 0), staleOpenOver24h: staleOpen }, expired: { total: expired.length, byReason: expiredBy },
    policies: { incomplete, pause: { active: pauseActive, version: pause.version, approvedVersion: pause.approved?.version ?? null, scope: describeScope(pause.scope), uncoveredAutomaticProducts: uncovered, note: uncovered.length ? 'منتجات AUTOMATIC لكن سياسة الإيقاف لا تشملها — مفيش إيقاف تلقائي ليها. إضافتها للنطاق قرارك.' : null } },
    sync: sync ? { intervalMinutes: sync.intervalMinutes ?? null, lastSuccessAt: sync.lastSuccessAt ?? null, nextSyncAt: sync.nextSyncAt ?? null, ageMinutes: sync.lastSuccessAt ? Math.round((now.getTime() - new Date(sync.lastSuccessAt).getTime()) / MS_M) : null } : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// one product: «ليه ما اتنفذش؟»
// ---------------------------------------------------------------------------------------------------------------------------------------------
export async function productDiagnosis({ key, now = new Date(), deps = {} } = {}) {
  const { config, settings, pause, overview } = await load(deps, now);
  const product = productsOf(overview).find((p) => p.key === key) || null;
  if (!product) { const e = new Error('المنتج غير موجود في لوحة الأتمتة.'); e.status = 404; throw e; }
  const usage = deps.usage || (overview.dailyLimits?.rows?.length ? overview.dailyLimits.rows : limitUsage({ config, counters: deps.counters || {} }));
  const chain = gateChain({ config, settings, pause, product, usage, scope: { productId: product.productId, storeId: product.storeId } });
  const since = new Date(now.getTime() - 48 * MS_H);
  const rows = deps.decisions || await prisma.ambOperatorDecision.findMany({ where: { product_id: product.productId, store_id: product.storeId, updated_at: { gte: since } }, orderBy: { id: 'desc' }, take: 200 });
  const ids = product.campaigns?.ids || [];
  const recent = deps.recent || (ids.length ? await (await import('./operatorContext.js')).loadRecentActions({ campaignIds: ids, now }).catch(() => new Map()) : new Map());
  const limit = Number(config?.limits?.maxChangesPerCampaignPerDay) || null;
  const byCamp = new Map(); for (const r of rows) { const a = byCamp.get(r.campaign_id) || []; a.push(r); byCamp.set(r.campaign_id, a); }
  const campaigns = [...byCamp.entries()].map(([cid, list]) => {
    const latest = list[0]; const used = recent.get(cid)?.todayCount ?? 0; const bs = blocksOf(latest);
    return { campaignId: cid, name: latest.campaign_name, changes24h: used, changeLimit: limit, remaining: limit == null ? null : Math.max(0, limit - used), latest: { id: latest.id, action: latest.action, actionLabel: ACTION_AR[latest.action] || latest.action, status: latest.status, rule: latest.rule_name, at: latest.updated_at, current: isCurrent(latest, now), blocks: bs.map((b) => ({ code: b.code, severity: b.severity, owner: b.owner, label: b.label, detail: b.detail })), verdict: verdictOf(latest, now) }, history: list.slice(1, 6).map((r) => ({ id: r.id, action: r.action, status: r.status, at: r.updated_at, rule: r.rule_name })) };
  }).sort((a, b) => new Date(b.latest.at) - new Date(a.latest.at));
  const summary = chain.common.filter((g) => !g.ok)[0];
  const verdict = summary ? { state: 'NOT_AUTOMATIC', text: `AUTOMATIC مش شغال على المنتج ده: ${summary.label} — ${summary.detail}` } : { state: 'READY_FOR_AUTOMATIC', text: 'كل شروط المنتج العامة سليمة — القرارات بتتوقف بحسب كل أكشن/حملة (شوف التفاصيل).' };
  return { generatedAt: now.toISOString(), product: { key: product.key, productId: product.productId, name: product.name, state: product.state, mode: product.policy?.mode || null, policyStatus: product.policy?.status || 'NONE', runningBudget: product.runningBudget, campaigns: product.campaigns }, verdict, gates: chain, campaigns, limits: { account: usage, campaignLimit: limit } };
}
