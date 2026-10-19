// 🤖 AUTOMATION ENGINE — automatic PAUSE and automatic budget INCREASE / REDUCE on the SAME approved policies and the SAME safety layers as the manual paths. 2026-10-11.
//
//   Meta (synced + live read) ──► candidates ──► ONE action per campaign per tick (precedence) ──► per-product opt-in + readiness ──► decision row (idempotent key) ──► central write gate ──► executor ──► read-back
//
//   WHAT decides:    pause  = pausePolicy (STOCK_OUT › ZERO_ORDER › HIGH_CPA, winner protection / precedence) · budget = the account budget policy + the product policy overrides (ABO + CBO, thresholds, cooldown,
//                    evidence only SINCE the last change = purchases are never reused, caps, min/max budget) · both stay under every Safety Guard (mapping, exceptions, recent purchase, manual override, limits…).
//   WHO may be automatic: ONLY a product whose ACTIVE policy is in mode AUTOMATIC *and* that is READY (economics, stock, mapping, spend limits, CPA limits, approved pause policy). Everything else is only PREPARED for the
//                    owner (APPROVAL) or recorded (SHADOW). The global mode caps everything: SHADOW → simulate · APPROVAL → prepare · AUTOPILOT (=AUTOMATIC) → execute for opted-in products · OFF/MANUAL → nothing here.
//   WHAT can stop it: Emergency Stop · deployment write lock · queue halted · stale Meta data · the autopilot readiness gate · the operation's own permission · hourly action limit · a Meta rate limit · a fresh LIVE re-evaluation
//                    that no longer gives the same decision (BUDGET_CHANGED / DECISION_CHANGED / EVIDENCE_DRIFT → EXPIRED, never executed).
//   Anti-oscillation: no change in the OPPOSITE direction within `flipHours` (72h default) of the last change.  Nothing is ever re-sent: an uncertain write is settled by an independent read-back only.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getOperatorConfig, autopilotGate } from './operatorStore.js';
import { evaluateWriteGate, GATE_PERMISSION } from './writeGate.js';
import { evaluateBudgetOptimization, getBudgetPolicy } from './budgetOptimizer.js';
import { buildOperatorWorld, buildCampaignContext, ensureHeavy, loadRecentActions, loadCounters, computeLastPurchaseAt } from './operatorContext.js';
import { evaluateGuards } from './operatorGuards.js';
import { loadActivePolicies, policyKey, mergeEffective } from './productPolicy.js';
import { getPausePolicy, pausePolicyActive, decidePause, TRIGGER_AR, pauseBlockMessage } from './pausePolicy.js';
import { automationReadinessMap } from './automationReadiness.js';
import { isWinner } from './dailyPlanCandidates.js';
import { checkBudgetCaps } from './budgetCaps.js';
import { dailyCapFromLimits } from './productPolicy.js';
import { raiseAlert } from './alerts.js';
import { recordAutomaticExecution, kindOfDecision } from './firstAutomatic.js';
import { cairoDate } from './dailyPlanTime.js';
import { cairoDayStart } from './executionHistory.js';
import { defaultReadBack } from './budgetExecution.js';
import { supersedeOlder, sweepStale, findAlreadyApplied } from './decisionHygiene.js';

const MS_H = 3_600_000;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const AUTO_PREFIX = 'AUTO:';
export const isAutoRule = (name) => String(name || '').startsWith(AUTO_PREFIX);
export const AMB_ACTION = { PAUSE: 'PAUSE', SCALE_UP: 'INCREASE_BUDGET', SCALE_DOWN: 'DECREASE_BUDGET' };
export const DEFAULT_AUTOMATION = Object.freeze({ flipHours: 72, maxActionsPerTick: 10, spacingSeconds: 3, metaMinDailyBudget: null });
export const KIND_LABEL = { DAILY_ZERO_SPEND: 'إيقاف: صرف بدون أوردرات (فحص يومي)', MANUAL_OPEN: 'فتح (يدوي)', MANUAL_PAUSE: 'إيقاف (يدوي)', MANUAL_INCREASE: 'زيادة ميزانية (يدوي)', MANUAL_REDUCE: 'تقليل ميزانية (يدوي)', STOCK_OUT: 'إيقاف: نفاد المخزون', ZERO_ORDER: 'إيقاف: صرف بدون أوردرات', HIGH_CPA: 'إيقاف: CPA عالي', REDUCE: 'تقليل ميزانية', INCREASE: 'زيادة ميزانية' };
const RATE_LIMIT_RE = /rate limit|request limit reached|too many (api )?calls|(#(4|17|32|613))/i; // Meta's throttling answers (also when the executor reports them as a plain failure message)
const round0 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const slim = (m) => (m ? { spend: round0(m.spend ?? 0), purchases: m.purchases ?? 0, cpa: m.cpa == null ? null : round0(m.cpa) } : { spend: 0, purchases: 0, cpa: null });
const settingsOf = (config) => ({ ...DEFAULT_AUTOMATION, ...(config?.limits?.automation || {}) });
/** a refused AUTOMATIC execution must never be silent: one deduplicated alert says what was NOT done and why */
const alertRefused = (row, params, code, message) => raiseAlert({ severity: 'WARNING', category: 'OPERATOR', title: `AUTOMATIC ما نفّذش — ${row.campaign_name || row.campaign_id}`, message: `${KIND_LABEL[params.kind] || row.action}: ${message}`.slice(0, 480), adAccountId: row.ad_account_id, entityId: row.campaign_id, dedupeKey: `operator:autorefused:${row.id}:${code}` }).catch(() => {});
const event = async (data) => { try { await prisma.ambOperatorEvent.create({ data }); } catch (e) { logger.warn('[automation] event write failed', { message: e.message }); } };
const transition = (decisionId, from, to, { actor = 'AUTOPILOT', actorId = null, note = null, data = null, campaignId = null } = {}) => event({ decision_id: decisionId, kind: 'TRANSITION', from_status: from, to_status: to, actor, actor_id: actorId, note, data_json: data ? JSON.stringify(data).slice(0, 3000) : null, campaign_id: campaignId });

// =====================================================================================================================
// tick-level gate (pure over config) — why the engine may NOT execute right now; it can still PREPARE
// =====================================================================================================================
export function tickGate({ config, dcfg = {}, metaStale = false, autopilotOk = true }) {
  const why = [];
  if (config.emergency_stop) why.push({ code: 'EMERGENCY_STOP', message: 'إيقاف الطوارئ مفعّل.' });
  if (config.mode !== 'AUTOPILOT') why.push({ code: 'MODE_NOT_AUTOMATIC', message: `الوضع الحالي ${config.mode === 'OFF' ? 'MANUAL' : config.mode} — التنفيذ التلقائي محتاج AUTOMATIC.` });
  if (config.writesLocked !== false) why.push({ code: 'META_WRITES_LOCKED', message: 'كتابة Meta مقفولة على مستوى النشر.' });
  if (dcfg.halted) why.push({ code: 'QUEUE_HALTED', message: 'الطابور موقوف (Kill Switch).' });
  if (metaStale) why.push({ code: 'DATA_STALE', message: 'بيانات Meta قديمة — مفيش تنفيذ على بيانات غير موثوقة.' });
  if (!autopilotOk) why.push({ code: 'AUTOPILOT_GATE_NOT_READY', message: 'شروط تفعيل AUTOMATIC (الاختبارات والتأكيدات) مش مكتملة.' });
  return why;
}

// =====================================================================================================================
// evaluation — READ ONLY. Returns every candidate with its blockers and the mode it would run in.
// =====================================================================================================================
/**
 * deps (tests): world, opt (a prebuilt evaluateBudgetOptimization result), readiness (Map), pause, policies (Map), budgetPolicy, stockOf(campaignId)->{status}, guardsOf(candidate)->blocks[], now.
 * only: { campaignIds } restricts everything to those campaigns (used by the execution-time live re-evaluation).
 */
export async function evaluateAutomation({ now = new Date(), live = false, only = null, deps = {} } = {}) {
  const config = deps.config || await getOperatorConfig(); const S = settingsOf(config);
  const pause = deps.pause || await getPausePolicy(); const pauseOn = pausePolicyActive(pause);
  const policies = deps.policies || await loadActivePolicies();
  const base = deps.budgetPolicy || await getBudgetPolicy();
  const budgetPolicy = pauseOn && pause.zeroOrder.enabled && pause.zeroOrder.spend != null ? { ...base, zeroOrders: { ...base.zeroOrders, spend: pause.zeroOrder.spend } } : base; // the pause policy's own zero-order limit is the ACCOUNT default (a product value still wins)
  if (!policies.size && !deps.world) return { at: now.toISOString(), mode: config.mode, emergencyStop: config.emergency_stop, metaStale: false, candidates: [], skipped: [{ code: 'NO_ACTIVE_PRODUCT_POLICIES' }], structureSource: null, adAccountId: null, summary: summarize([]) }; // nothing is opted in: no Meta-wide evaluation at all
  const ready = deps.readiness || await automationReadinessMap({ deps: { policies, pause } });
  const world = deps.world || await buildOperatorWorld({ windowKeys: ['today', 'last3', 'last7', 'last14', 'last30'], now, only });
  const out = { at: now.toISOString(), mode: config.mode, emergencyStop: config.emergency_stop, metaStale: !!world.metaStale, pausePolicy: { enabled: pause.enabled, version: pause.version, approvedVersion: pause.approved?.version ?? null, active: pauseOn }, candidates: [], skipped: [], structureSource: null, adAccountId: world.adAccountId || null };
  if (!world.adAccountId) return out;
  const opt = deps.opt || await evaluateBudgetOptimization({ now, persist: false, live, only, ruleMode: 'AUTOPILOT', deps: { world, policy: budgetPolicy } });
  out.structureSource = opt.structureSource;
  const byCamp = new Map(); for (const r of opt.rows) (byCamp.get(r.campaignId) || byCamp.set(r.campaignId, []).get(r.campaignId)).push(r);
  const weekday = new Date(`${cairoDate(now)}T12:00:00Z`).getUTCDay();
  const recent = deps.recent || await loadRecentActions({ campaignIds: [...byCamp.keys()], now, pendingHours: config.limits.pendingEvaluationHours });
  const counters = deps.counters || await loadCounters({ now, campaigns: world.campaigns });
  const globalMode = config.mode === 'AUTOPILOT' ? 'AUTOMATIC' : config.mode === 'APPROVAL' ? 'APPROVAL' : config.mode === 'SHADOW' ? 'SHADOW' : 'OFF';
  const perm = config.execPermissions || {};

  for (const c of world.campaigns.filter((x) => x.status === 'ACTIVE')) {
    const rows = byCamp.get(c.id) || []; if (!rows.length) continue;
    const r0 = rows[0]; if (r0.productId == null) { out.skipped.push({ campaignId: c.id, code: 'NO_PRODUCT' }); continue; }
    const pk = policyKey(r0.storeId, r0.productId); const pol = policies.get(pk) || null;
    if (!pol) { out.skipped.push({ campaignId: c.id, productKey: pk, code: 'NO_ACTIVE_PRODUCT_POLICY' }); continue; }
    const productMode = mergeEffective(pol, c.id).mode || pol.mode; if (!['AUTOMATIC', 'APPROVAL'].includes(productMode)) { out.skipped.push({ campaignId: c.id, productKey: pk, code: 'PRODUCT_MODE_MANUAL' }); continue; }
    const rd = ready.get(pk) || null;
    const m3 = slim(world.windows.last3?.get(c.id)), m7 = slim(world.windows.last7?.get(c.id)), m30 = slim(world.windows.last30?.get(c.id));
    const base0 = { campaignId: c.id, campaignName: (c.name || '').trim(), productId: r0.productId, productName: r0.product, storeId: r0.storeId, productKey: pk, productMode };
    // stock (heavy product facts) is needed only for the stock-out trigger: read it once per campaign of an opted-in product
    let stock = null, cx = null;
    if (deps.stockOf) stock = await deps.stockOf(c.id);
    else { cx = await buildCampaignContext({ world, campaign: c, recentByCampaign: recent }); await ensureHeavy(cx); stock = cx.stock ? { status: cx.stock.status, current: cx.stock.currentStock ?? null } : null; }
    const modeOf = (blockers, needsAutoOk = true) => {
      if (blockers.length) return 'BLOCKED';
      if (globalMode === 'OFF') return 'BLOCKED';
      if (globalMode === 'SHADOW') return 'SHADOW';
      if (globalMode === 'APPROVAL' || productMode === 'APPROVAL') return 'APPROVAL';
      return needsAutoOk ? 'AUTOMATIC' : 'APPROVAL';
    };
    const autoBlockers = []; // reasons this product may not be AUTOMATIC (it can still be PREPARED for the owner)
    if (productMode === 'AUTOMATIC' && (!rd || !rd.ready)) autoBlockers.push({ code: 'NEEDS_CONFIGURATION', message: `المنتج ناقص: ${(rd?.missing || [{ label: 'غير معروف' }]).map((m) => m.label).join(' · ')}` });

    // ---------------- pause ----------------
    const pauseRow = rows.find((x) => x.intended?.action === 'PAUSE') || null;
    const dp = pauseOn ? decidePause({ policy: pause, campaignId: c.id, productId: r0.productId, storeId: r0.storeId, optimizer: pauseRow?.intended || null, m3, mToday: slim(world.windows.today?.get(c.id)), productHighCpa: mergeEffective(pol, c.id).cpa.hardStop ?? null, stock, winner: isWinner({ m7, m30 }), weekday }) : { trigger: null, skipped: [], blockers: ['PAUSE_POLICY_NOT_APPROVED'], fired: [] };
    let chosen = null;
    if (dp.trigger) {
      const blockers = dp.blockers.map((code) => ({ code, message: pauseBlockMessage(code, pause) }));
      // guards: a zero-order pause carries the optimizer row's own verdict; the other triggers run the full guard chain here
      if (dp.trigger === 'ZERO_ORDER' && pauseRow) { for (const g of pauseRow.guards.filter((x) => /\[B\]/.test(x))) blockers.push({ code: g.split('[')[0], message: g }); if (rows.length > 1 && !rows.every((x) => x.intended?.action === 'PAUSE')) blockers.push({ code: 'PARTIAL_ADSETS', message: 'الصرف بدون أوردرات على بعض الـAd Sets فقط — إيقاف الحملة كلها محتاج موافقتك' }); }
      else {
        const gb = deps.guardsOf ? await deps.guardsOf({ ...base0, trigger: dp.trigger }) : await pauseGuards({ world, cx, c, config, counters, now, trigger: dp.trigger, m3 });
        blockers.push(...gb);
      }
      const entity = { level: 'campaign', id: c.id, budget: rows.reduce((t, x) => t + (Number(x.entity?.budget) || 0), 0) || null };
      chosen = { ...base0, kind: dp.trigger, action: 'PAUSE', entity, fromBudget: null, toBudget: null, pct: null, reason: `${TRIGGER_AR[dp.trigger]}${dp.trigger === 'ZERO_ORDER' ? `: صرف ${m3.spend} بدون أوردرات (3 أيام)` : dp.trigger === 'HIGH_CPA' ? `: CPA ${m3.cpa} > ${dp.threshold ?? pause.highCpa.above ?? '—'} (حد المنتج) على ${m3.purchases} أوردر` : ''}`, evidence: { m3, m7, m30, stock, trigger: dp.trigger, fired: dp.fired, skippedTriggers: dp.skipped, optimizer: pauseRow ? { zone: pauseRow.zone, reason: pauseRow.reason } : null }, blockers: [...blockers, ...(dp.trigger === 'STOCK_OUT' ? [] : [])], pausePolicyVersion: pause.version };
    } else if (dp.skipped.length) out.skipped.push({ campaignId: c.id, code: dp.skipped[0].code, detail: dp.skipped.map((s) => s.trigger).join(',') });

    // ---------------- budget (only if nothing is being paused) ----------------
    if (!chosen) {
      const cand = rows.filter((x) => x.intended && ['SCALE_UP', 'SCALE_DOWN'].includes(x.intended.action)).sort((a, b) => (a.intended.action === 'SCALE_DOWN' ? 0 : 1) - (b.intended.action === 'SCALE_DOWN' ? 0 : 1))[0];
      if (cand) {
        const act = cand.intended.action; const blockers = [];
        for (const g of cand.guards.filter((x) => /\[B\]/.test(x))) blockers.push({ code: g.split('[')[0], message: g });
        if (cand.decision === 'BLOCKED' || cand.decision === 'PROTECTED') if (!blockers.length) blockers.push({ code: cand.primaryBlock || 'BLOCKED', message: cand.reason || '' });
        const lc = cand.evidence?.lastChange; // anti-oscillation
        if (lc && lc.action && lc.action !== act && now.getTime() - new Date(lc.at).getTime() < S.flipHours * MS_H) blockers.push({ code: 'OSCILLATION_GUARD', message: `آخر تغيير ${lc.action === 'SCALE_UP' ? 'زيادة' : 'تقليل'} من ${Math.round((now.getTime() - new Date(lc.at).getTime()) / MS_H)}س — ممنوع الاتجاه العكسي قبل ${S.flipHours}س` });
        if (act === 'SCALE_DOWN' && S.metaMinDailyBudget != null && cand.intended.toBudget != null && cand.intended.toBudget < S.metaMinDailyBudget) blockers.push({ code: 'META_MIN_BUDGET', message: `الميزانية الجديدة ${cand.intended.toBudget} أقل من الحد الأدنى المسموح ${S.metaMinDailyBudget}` });
        if (cand.intended.toBudget == null || cand.intended.fromBudget == null) blockers.push({ code: 'BUDGET_UNKNOWN', message: 'الميزانية غير معروفة' });
        if (cand.requiresApproval) { const why = cand.guards.filter((x) => /\[D\]/.test(x)).map((x) => x.replace('[D]', '').replace(/^ADVISOR_DISAGREES:?/, 'المستشار الذكي مش موافق على التوسّع: ')); autoBlockers.push({ code: 'DOWNGRADE_TO_APPROVAL', message: `القرار محتاج موافقتك${why.length ? ' — السبب: ' + why.join(' · ') : ' (مخزون/ربحية غير مؤكدين)'}` }); } // say WHICH guard downgraded it (e.g. the Smart Advisor disagrees), not a generic guess
        chosen = { ...base0, kind: act === 'SCALE_UP' ? 'INCREASE' : 'REDUCE', action: act, entity: cand.entity, fromBudget: cand.intended.fromBudget, toBudget: cand.intended.toBudget, pct: cand.intended.pct, reason: cand.reason, evidence: { ...(cand.evidence || {}), m3: cand.m3, m7: cand.m7, zone: cand.zone, rule: cand.rule }, blockers, flagReview: !!cand.flagReview, requiresApproval: !!cand.requiresApproval };
      }
    }
    if (!chosen) continue;
    const gateKey = GATE_PERMISSION[AMB_ACTION[chosen.action]]; chosen.permission = gateKey; chosen.permissionOn = perm[gateKey] === true;
    chosen.effective = modeOf(chosen.blockers, !autoBlockers.length);
    chosen.autoBlockers = autoBlockers;
    chosen.canExecuteNow = chosen.effective === 'AUTOMATIC' && chosen.permissionOn;
    chosen.cooldownHours = chosen.action === 'SCALE_UP' ? budgetPolicy.scale.cooldownHours : chosen.action === 'SCALE_DOWN' ? budgetPolicy.reduce.cooldownHours : 24;
    chosen.key = crypto.createHash('sha1').update(`auto|${chosen.kind}|${chosen.entity.id}|${chosen.action}|${Math.floor(now.getTime() / (chosen.cooldownHours * MS_H))}`).digest('hex').slice(0, 24);
    out.candidates.push(chosen);
  }
  out.summary = summarize(out.candidates);
  return out;
}
export function summarize(cands) {
  const s = { total: cands.length, byKind: {}, byEffective: {}, wouldExecuteNow: 0 };
  for (const c of cands) { s.byKind[c.kind] = (s.byKind[c.kind] || 0) + 1; s.byEffective[c.effective] = (s.byEffective[c.effective] || 0) + 1; if (c.canExecuteNow) s.wouldExecuteNow++; }
  return s;
}
export async function pauseGuards({ world, cx, c, config, counters, now, trigger, m3 }) {
  try {
    const ctx = cx || await (async () => { const rc = await loadRecentActions({ campaignIds: [c.id], now, pendingHours: config.limits.pendingEvaluationHours }); const x = await buildCampaignContext({ world, campaign: c, recentByCampaign: rc }); await ensureHeavy(x); return x; })();
    if (!ctx.lastPurchaseLoaded) { ctx.lastPurchaseLoaded = true; ctx.lastPurchaseAt = await computeLastPurchaseAt({ campaignId: c.id, now }).catch(() => null); }
    const g = evaluateGuards({ decision: { action: 'PAUSE', params: {}, ruleMode: 'AUTOPILOT', confidence: 'HIGH', needs: {}, usesCod: false, cooldownHours: 12, ruleMinSpend: null, severeOverride: trigger === 'STOCK_OUT' }, ctx: { ...ctx, metrics: m3, ruleConflicts: [] }, config, settings: world.settings, now, counters: { ...counters, campaignActionsToday: ctx.recent.todayCount, loss: { campaign: 0, product: 0, account: 0 } } });
    return g.blocks.filter((b) => b.severity === 'BLOCK').map((b) => ({ code: b.code, message: b.message }));
  } catch (e) { return [{ code: 'GUARD_EVALUATION_FAILED', message: String(e.message).slice(0, 160) }]; }
}

// =====================================================================================================================
// persistence — one decision row per candidate (idempotent key), statuses SHADOW | PREPARED | BLOCKED
// =====================================================================================================================
const STATUS_OF = { SHADOW: 'SHADOW', APPROVAL: 'PREPARED', AUTOMATIC: 'PREPARED', BLOCKED: 'BLOCKED' };
export async function persistCandidates(cands, { adAccountId, mode, now = new Date() }) {
  let created = 0, updated = 0, merged = 0; const ids = new Map();
  for (const c of cands) {
    const status = STATUS_OF[c.effective] || 'BLOCKED';
    const data = { store_id: c.storeId || 'UNKNOWN', product_id: c.productId, ad_account_id: adAccountId, campaign_id: c.campaignId, campaign_name: c.campaignName, action: c.action, rule_id: null, rule_name: `${AUTO_PREFIX}${c.kind}`, mode_at_decision: mode, confidence: 'HIGH',
      blocked_codes_json: JSON.stringify([...c.blockers, ...c.autoBlockers].map((b) => ({ code: b.code, message: b.message }))), evidence_json: JSON.stringify({ ...c.evidence, history: { beforeBudget: c.fromBudget, afterBudget: c.toBudget, level: c.entity.level, entityId: c.entity.id, kind: c.kind, timestamp: now.toISOString() }, auto: { effective: c.effective, productMode: c.productMode, pausePolicyVersion: c.pausePolicyVersion ?? null, permission: c.permission, permissionOn: c.permissionOn } }),
      why_json: JSON.stringify({ what: `${KIND_LABEL[c.kind]} — ${c.campaignName}`, why: c.reason }), params_json: JSON.stringify({ kind: c.kind, level: c.entity.level, entityId: c.entity.id, entityName: c.entity.name || null, pct: c.pct, fromBudget: c.fromBudget, toBudget: c.toBudget, window: 'since-last-change' }) };
    const ex = await prisma.ambOperatorDecision.findUnique({ where: { decision_key: c.key } });
    // ONE pause request per campaign: if another rule already has a live pause decision on the table (prepared / being executed / executed in the last 24h), this rule's reasons are MERGED into it instead of creating a second request.
    // A stock-out is never merged (nothing to sell: it keeps its own decision; the executor's duplicate guard and the live status check still allow only one write).
    if (!ex && c.action === 'PAUSE' && c.kind !== 'STOCK_OUT') {
      const other = await prisma.ambOperatorDecision.findFirst({ where: { campaign_id: c.campaignId, action: 'PAUSE', rule_name: { startsWith: AUTO_PREFIX }, NOT: { rule_name: { startsWith: `${AUTO_PREFIX}MANUAL` } }, decision_key: { not: c.key }, status: { in: ['PREPARED', 'APPROVED', 'EXECUTING', 'EXECUTED', 'VERIFIED'] }, created_at: { gte: new Date(now.getTime() - 24 * MS_H) } }, orderBy: { id: 'asc' } });
      if (other) { const ev0 = j(other.evidence_json, {}) || {}; const also = Array.isArray(ev0.alsoFired) ? ev0.alsoFired : []; if (!also.some((x) => x.kind === c.kind)) also.push({ kind: c.kind, label: KIND_LABEL[c.kind] || c.kind, reason: c.reason, at: now.toISOString() }); await prisma.ambOperatorDecision.update({ where: { id: other.id }, data: { evidence_json: JSON.stringify({ ...ev0, alsoFired: also }) } }).catch(() => {}); ids.set(c.key, other.id); merged++; continue; }
    }
    if (!ex) { try { const row = await prisma.ambOperatorDecision.create({ data: { decision_key: c.key, status, before_json: JSON.stringify({ budget: c.fromBudget ?? c.entity.budget, level: c.entity.level, status: 'ACTIVE' }), ...data } }); await transition(row.id, 'CANDIDATE', status, { actor: 'SYSTEM', note: c.blockers[0]?.code || c.autoBlockers[0]?.code || null, campaignId: c.campaignId }); created++; ids.set(c.key, row.id); } catch (e) { if (e.code !== 'P2002') throw e; ids.set(c.key, (await prisma.ambOperatorDecision.findUnique({ where: { decision_key: c.key } }))?.id); } }
    else { ids.set(c.key, ex.id); if (['SHADOW', 'BLOCKED', 'PREPARED', 'EXPIRED'].includes(ex.status)) { await prisma.ambOperatorDecision.update({ where: { id: ex.id }, data: { ...data, status, error: null } }); updated++; } }
  }
  // a newer decision for the same campaign + action + rule replaces the older open ones (the cooldown bucket gives each window a new key) — duplicates never pile up in «الموافقات»
  let superseded = 0;
  for (const c of cands) { const id = ids.get(c.key); if (id) superseded += await supersedeOlder({ keepId: id, campaignId: c.campaignId, action: c.action, ruleName: `${AUTO_PREFIX}${c.kind}` }).catch(() => 0); }
  return { created, updated, merged, superseded, ids };
}

// =====================================================================================================================
// execution of ONE decision (AUTOPILOT = the engine, USER = an approval of a PREPARED automation decision)
// =====================================================================================================================
export async function executeAutoDecision({ decisionId, source = 'AUTOPILOT', userId = null, now = new Date(), deps = {} }) {
  const row = await prisma.ambOperatorDecision.findUnique({ where: { id: Number(decisionId) } });
  const out = { ok: false, executed: false, verified: false, decisionId: Number(decisionId), stages: { requested: null, sentToMeta: null, readBack: null, verified: null } };
  if (!row) return { ...out, status: 'NOT_FOUND', message: 'القرار غير موجود.' };
  if (!isAutoRule(row.rule_name)) return { ...out, status: 'NOT_AN_AUTOMATION_DECISION', message: 'ده مش قرار أتمتة.' };
  if (row.status !== 'PREPARED') return { ...out, status: row.status, message: `القرار في حالة ${row.status} — مش قابل للتنفيذ (بيتنفذ مرة واحدة بس).` };
  const params = j(row.params_json, {}) || {}; const ambAction = AMB_ACTION[row.action]; const actor = source === 'AUTOPILOT' ? 'AUTOPILOT' : 'USER';
  if (!ambAction) return { ...out, status: 'ACTION_NOT_SUPPORTED', message: `الأكشن ${row.action} مش مدعوم.` };
  const config = deps.config || await getOperatorConfig();
  const wg = evaluateWriteGate({ config, actionType: ambAction, mode: source === 'AUTOPILOT' ? 'AUTOPILOT' : 'HUMAN' });
  if (!wg.ok) { await transition(row.id, 'PREPARED', 'PREPARED', { actor, actorId: userId, note: `BLOCKED_AT_GATE ${wg.code}`, campaignId: row.campaign_id }); if (source === 'AUTOPILOT') await alertRefused(row, params, wg.code, wg.message); return { ...out, status: 'BLOCKED', blocked: wg.code, message: wg.message, reasons: wg.reasons }; }
  { const cf = await (deps.checkConflicts ? deps.checkConflicts({ campaignId: row.campaign_id, want: row.action, excludeDecisionId: row.id }) : (await import('./integration.js')).checkConflicts({ campaignId: row.campaign_id, want: row.action, excludeDecisionId: row.id, now })).catch(() => []); if (cf.length) { await transition(row.id, 'PREPARED', 'PREPARED', { actor, actorId: userId, note: `BLOCKED_AT_GATE ${cf[0].code}`, campaignId: row.campaign_id }); if (source === 'AUTOPILOT') await alertRefused(row, params, cf[0].code, `تعارض: ${cf[0].detail || cf[0].code}`); return { ...out, status: 'BLOCKED', blocked: cf[0].code, message: `تعارض: ${cf[0].detail || cf[0].code}` }; } }
  if (row.action === 'SCALE_UP') { const cap = await checkBudgetCaps({ action: 'SCALE_UP', delta: (params.toBudget ?? 0) - (params.fromBudget ?? 0), adAccountId: row.ad_account_id, campaignId: row.campaign_id, productId: row.product_id ?? null, productCapOverride: dailyCapFromLimits(config.limits, row.store_id, row.product_id, row.campaign_id), now, deps: deps.capsDeps || {} }); if (!cap.ok) { await transition(row.id, 'PREPARED', 'PREPARED', { actor, actorId: userId, note: 'BLOCKED_AT_GATE BUDGET_CAP', data: { violations: cap.violations }, campaignId: row.campaign_id }); if (source === 'AUTOPILOT') await alertRefused(row, params, 'BUDGET_CAP', 'الزيادة هتتجاوز حدّ الميزانية'); return { ...out, status: 'BLOCKED', blocked: 'BUDGET_CAP', message: `الزيادة هتتجاوز حدّ الميزانية: ${cap.violations.map((v) => `${v.label} (${v.after} > ${v.cap})`).join('، ')}`, violations: cap.violations }; } }

  if (row.action !== 'PAUSE') { const { preWriteBounds } = await import('./budgetChange.js'); const bb = await preWriteBounds({ operation: row.action === 'SCALE_UP' ? 'INCREASE' : 'REDUCE', from: params.fromBudget, to: params.toBudget, entityId: params.entityId || row.campaign_id, campaignId: row.campaign_id, config, now, deps: deps.boundsDeps || {} });
    if (!bb.ok) { await transition(row.id, 'PREPARED', 'PREPARED', { actor, actorId: userId, note: `BLOCKED_AT_GATE ${bb.blockers[0].code}`, data: { blockers: bb.blockers }, campaignId: row.campaign_id }); if (source === 'AUTOPILOT') await alertRefused(row, params, bb.blockers[0].code, bb.blockers[0].message); return { ...out, status: 'BLOCKED', blocked: bb.blockers[0].code, message: bb.blockers[0].message, blockers: bb.blockers }; } }
  // fresh LIVE re-evaluation: the SAME decision (same kind, entity, budgets) or nothing
  const fresh = await (deps.reevaluate ? deps.reevaluate({ row, params }) : params.kind === 'DAILY_ZERO_SPEND' ? (await import('./zeroSpendCheck.js')).reevaluateDecision({ row, params, now, deps: deps.zeroSpendDeps || {} }) : evaluateAutomation({ now, live: true, only: { campaignIds: [row.campaign_id] }, deps: deps.evalDeps || {} }));
  const f = (fresh.candidates || []).find((x) => x.campaignId === row.campaign_id && x.kind === params.kind && x.action === row.action && String(x.entity.id) === String(params.entityId));
  const reasons = [];
  { const dup = await findAlreadyApplied({ row, params, now }).catch(() => null); if (dup) reasons.push({ code: 'DUPLICATE_ALREADY_APPLIED', detail: `نفس التغيير اتنفّذ بقرار #${dup.id}` }); }
  if (fresh.structureSource && fresh.structureSource !== 'META_LIVE' && !deps.reevaluate && !deps.evalDeps) reasons.push({ code: 'NO_LIVE_DATA', detail: String(fresh.structureSource) });
  if (!f) reasons.push({ code: 'DECISION_CHANGED', detail: 'القرار مبقاش ينتج من التقييم الحي' });
  else {
    if (f.blockers.length) reasons.push({ code: 'GUARD_BLOCK', detail: f.blockers.map((b) => b.code).join(',') });
    if (source === 'AUTOPILOT' && f.effective !== 'AUTOMATIC') reasons.push({ code: 'NOT_AUTOMATIC_ANYMORE', detail: f.autoBlockers.map((b) => b.code).join(',') || f.effective });
    if (row.action !== 'PAUSE') { if (Math.abs((f.fromBudget ?? -1) - (params.fromBudget ?? -2)) > 0.5) reasons.push({ code: 'BUDGET_CHANGED', detail: `${params.fromBudget} → live ${f.fromBudget}` }); if (f.toBudget !== params.toBudget) reasons.push({ code: 'PROPOSAL_CHANGED', detail: `${params.toBudget} → ${f.toBudget}` }); }
    const oldCpa = j(row.evidence_json, {})?.m3?.cpa, newCpa = f.evidence?.m3?.cpa; if (oldCpa && newCpa && Math.abs(newCpa - oldCpa) / oldCpa > 0.3) reasons.push({ code: 'EVIDENCE_DRIFT', detail: `CPA ${oldCpa} → ${newCpa}` });
  }
  if (reasons.length) {
    const msg = `القرار اتبطل — الأدلة/الحالة اتغيّرت: ${reasons.map((r) => `${r.code}${r.detail ? ` (${r.detail})` : ''}`).join('، ')}`;
    await prisma.ambOperatorDecision.updateMany({ where: { id: row.id, status: 'PREPARED' }, data: { status: 'EXPIRED', error: msg, error_category: 'GUARD' } });
    await transition(row.id, 'PREPARED', 'EXPIRED', { actor, actorId: userId, note: msg, data: { reasons }, campaignId: row.campaign_id });
    if (source === 'AUTOPILOT') await alertRefused(row, params, 'EXPIRED', msg);
    return { ...out, status: 'EXPIRED', message: msg, reasons };
  }

  return performWrite({ row, params, ambAction, actor, source, userId, config, deps, out });
}

/** The shared WRITE stage: atomic claim → recommendation → the executor (central gate inside) → independent read-back → settle the decision. Used by the engine, by the owner's approval of a prepared decision and by MANUAL operations. */
export async function performWrite({ row, params, ambAction, actor, source, userId, config, deps = {}, out }) {
  const approvedAt = new Date();
  const claim = await prisma.ambOperatorDecision.updateMany({ where: { id: row.id, status: 'PREPARED' }, data: { status: 'EXECUTING', approval_source: source, approved_by_id: userId, approved_at: approvedAt } });
  if (claim.count !== 1) return { ...out, status: 'RACE', message: 'القرار بيتنفذ بالفعل.' };
  await transition(row.id, 'PREPARED', 'EXECUTING', { actor, actorId: userId, note: source === 'AUTOPILOT' ? 'AUTOMATIC' : 'APPROVED_BY_OWNER', campaignId: row.campaign_id });
  out.stages.requested = approvedAt.toISOString();

  const level = params.level === 'adset' ? 'adset' : 'campaign'; const entityId = params.entityId || row.campaign_id;
  const ev = j(row.evidence_json, {}) || {}; const amb = row.product_id != null ? await prisma.ambProduct.findFirst({ where: { product_id: row.product_id }, select: { id: true } }) : null;
  const polRef = await (deps.policyRef ? deps.policyRef({ productId: row.product_id, storeId: row.store_id, campaignId: row.campaign_id }) : (await import('./integration.js')).policyRefFor({ productId: row.product_id, storeId: row.store_id, campaignId: row.campaign_id })).catch(() => null);
  const rec = await prisma.ambRecommendation.create({ data: { batch_id: `operator-auto-${row.id}`, ad_account_id: row.ad_account_id, amb_product_id: amb?.id ?? null, product_name: row.product_id != null ? null : null, level, entity_id: entityId, entity_name: (level === 'adset' ? params.entityName : null) || row.campaign_name, campaign_id: row.campaign_id, campaign_name: row.campaign_name,
    adset_id: level === 'adset' ? entityId : null, decision: ambAction, action_type: ambAction, executable: true, current_metrics_json: JSON.stringify(ev.m3 || {}), current_budget: params.fromBudget ?? null, recommended_budget: params.toBudget ?? null, budget_change_pct: params.pct ? (row.action === 'SCALE_UP' ? params.pct : -params.pct) : null,
    reason: `AI Operator (${source === 'AUTOPILOT' ? 'AUTOMATIC' : String(params.kind || '').startsWith('MANUAL_') ? 'MANUAL' : 'APPROVED'}) — ${KIND_LABEL[params.kind] || row.rule_name}: ${j(row.why_json, {})?.why || ''}`.slice(0, 900), reason_facts_json: JSON.stringify({ ...ev, policyRef: polRef }), confidence: 'HIGH', risk_level: row.action === 'SCALE_UP' ? 'MEDIUM' : 'LOW', data_sufficiency: 'STRONG', priority: 'P2', time_window_label: 'آخر 3 أيام', source: String(params.kind || '').startsWith('MANUAL_') ? 'MANUAL' : 'OPERATOR', status: 'PENDING' } });
  await prisma.ambOperatorDecision.update({ where: { id: row.id }, data: { amb_recommendation_id: rec.id } });

  const exec = deps.approveAndExecute || (await import('./executor.js')).approveAndExecute; let result = null, err = null;
  try { result = await exec({ recId: rec.id, userId, mode: source === 'AUTOPILOT' ? 'AUTOPILOT' : 'HUMAN', deps: { config } }); } catch (e) { err = e; }
  const action = await prisma.ambAction.findFirst({ where: { recommendation_id: rec.id }, orderBy: { id: 'desc' } });
  let oldV = j(action?.old_value_json, null), newV = j(action?.new_value_json, null), verify = j(action?.verify_json, null);
  out.ambActionId = action?.id ?? null; out.recommendationId = rec.id; out.stages.sentToMeta = action?.meta_request_json ? { at: (action.executed_at || action.created_at)?.toISOString?.() || null, request: j(action.meta_request_json) } : null;
  const target = row.action === 'PAUSE' ? { status: 'PAUSED' } : { budget: params.toBudget };
  const base = { amb_action_id: action?.id ?? null, before_json: JSON.stringify(oldV || { level, entityId, budget: params.fromBudget ?? null, status: 'ACTIVE' }), after_json: newV ? JSON.stringify(newV) : null, rollback_json: oldV ? JSON.stringify({ capturedBeforeWrite: true, previous: oldV, actionId: action?.id, at: new Date().toISOString() }) : null };
  // the executor errored although a request may have gone out → ask Meta what it holds; never re-send
  let recon = null, reconDone = false;
  if ((err || !result?.ok) && !result?.aborted && action?.meta_request_json) { reconDone = true; recon = await (deps.readBack || defaultReadBack)({ entityId, level }); }
  const applied = !!(recon && (target.status ? recon.status === target.status : (recon.budget != null && Math.abs(recon.budget - target.budget) < 1)));
  if (applied) { verify = { verified: true, reconciled: true, live: { budgetMajor: recon.budget, status: recon.status }, executorError: (err?.message || result?.message || '').slice(0, 300) }; await prisma.ambAction.update({ where: { id: action.id }, data: { execution_status: 'EXECUTED', executed_at: action.executed_at || new Date(), verified_at: new Date(), verify_json: JSON.stringify(verify) } }).catch(() => {}); await prisma.ambRecommendation.update({ where: { id: rec.id }, data: { status: 'EXECUTED' } }).catch(() => {}); out.reconciled = true; }
  if ((err || !result?.ok) && !applied) {
    const msg = err?.message || result?.message || 'فشل التنفيذ.'; const status = result?.aborted ? 'BLOCKED' : (reconDone && !recon ? 'EXECUTED' : 'FAILED');
    const uncertain = reconDone && !recon;
    await prisma.ambOperatorDecision.update({ where: { id: row.id }, data: { ...base, status: uncertain ? 'EXECUTED' : status, executed_at: uncertain ? new Date() : undefined, error: uncertain ? 'الطلب ممكن يكون خرج وما قدرناش نقرأ Meta بعده — راجع الحملة يدويًا (مفيش إعادة إرسال)' : msg, error_category: result?.aborted ? 'GUARD' : 'EXECUTION' } });
    await transition(row.id, 'EXECUTING', uncertain ? 'EXECUTED' : status, { actor, actorId: userId, note: msg, campaignId: row.campaign_id });
    await raiseAlert({ severity: uncertain ? 'WARNING' : 'WARNING', category: 'OPERATOR', title: `AI Operator: ${uncertain ? 'غير مؤكد' : 'تنفيذ تلقائي لم يتم'} — ${row.campaign_name}`, message: `${KIND_LABEL[params.kind] || row.action}: ${msg}`.slice(0, 480), adAccountId: row.ad_account_id, entityId: row.campaign_id, dedupeKey: `operator:autofail:${row.id}` }).catch(() => {});
    out.stages.verified = uncertain ? 'UNCERTAIN' : 'FAILED'; out.stages.readBack = recon ? { verified: false, observed: recon, independent: true } : (reconDone ? { verified: null, unreadable: true, independent: true } : null);
    return { ...out, status: uncertain ? 'UNCERTAIN' : status, message: `${uncertain ? 'غير مؤكد' : status === 'FAILED' ? 'فشل' : 'اتمنع'}: ${msg}`, sentRequest: !!out.stages.sentToMeta, rateLimited: !!err?.isMetaRateLimit || RATE_LIMIT_RE.test(msg) };
  }
  const verified = !!verify?.verified; out.stages.readBack = verify ? { at: action?.verified_at?.toISOString?.() || new Date().toISOString(), verified, observed: verify.live || null, ...(verify.reconciled ? { independent: true } : {}) } : null;
  await prisma.ambOperatorDecision.update({ where: { id: row.id }, data: { ...base, status: verified ? 'VERIFIED' : 'EXECUTED', executed_at: action?.executed_at || new Date(), verified_at: verified ? (action?.verified_at || new Date()) : null, verify_json: verify ? JSON.stringify(verify) : (action?.verify_json || null), error: verified ? null : 'تم إرسال الطلب إلى Meta لكن القراءة الفورية لم تؤكد التغيير (Unverified).' } });
  await transition(row.id, 'EXECUTING', verified ? 'VERIFIED' : 'EXECUTED', { actor, actorId: userId, campaignId: row.campaign_id, data: { verified, before: oldV, after: newV } });
  await raiseAlert({ severity: verified ? 'INFO' : 'WARNING', category: 'OPERATOR', title: `${source === 'AUTOPILOT' ? 'AUTOMATIC نفّذ' : 'اتنفذ'}: ${KIND_LABEL[params.kind] || row.action} — ${row.campaign_name}`, message: verified ? `${row.action === 'PAUSE' ? 'اتوقفت' : `الميزانية ${params.fromBudget} → ${params.toBudget}`} — اتأكد من قراءة Meta.${j(row.why_json, {})?.why ? ` السبب: ${j(row.why_json, {}).why}` : ''}`.slice(0, 480) : 'الطلب اتبعت لكن القراءة ما أكدتش (Unverified).', adAccountId: row.ad_account_id, entityId: row.campaign_id, dedupeKey: `operator:autodone:${row.id}` }).catch(() => {});
  if (source === 'AUTOPILOT') await recordAutomaticExecution({ kind: kindOfDecision(row.action), campaignId: row.campaign_id, campaignName: row.campaign_name, reason: String(j(row.why_json, {})?.why || KIND_LABEL[params.kind] || ''), before: row.action === 'PAUSE' ? null : params.fromBudget, after: row.action === 'PAUSE' ? null : params.toBudget, verified, ambActionId: action?.id ?? null, decisionId: row.id, adAccountId: row.ad_account_id }); // log reason + real Meta result; the FIRST one of each kind raises its own alert
  out.stages.verified = verified ? 'VERIFIED' : 'UNVERIFIED';
  return { ...out, ok: true, executed: true, verified, status: verified ? 'VERIFIED' : 'EXECUTED', before: oldV, after: newV, message: verified ? 'تم التنفيذ — اتأكد من قراءة Meta.' : 'تم إرسال الطلب إلى Meta — لسه مفيش تأكيد بقراءة Meta (Unverified).' };
}

// =====================================================================================================================
// the tick
// =====================================================================================================================
let lastRun = null; let running = false;
export const getAutomationStatus = () => ({ running, lastRun });
export async function runAutomationTick({ now = new Date(), deps = {} } = {}) {
  if (running && !deps.allowConcurrent) return { skipped: 'ALREADY_RUNNING' };
  running = true;
  try {
    const config = deps.config || await getOperatorConfig();
    if (config.mode === 'OFF') return (lastRun = { at: now.toISOString(), skipped: 'MODE_MANUAL', note: 'MANUAL: الأتمتة لا تعمل — التشغيل يدوي فقط.' });
    const dcfg = deps.dcfg || await (await import('./dailyPlans.js')).getDailyPlanConfig();
    const ev = await evaluateAutomation({ now, live: false, deps: { ...(deps.evalDeps || {}), config } });
    const S = settingsOf(config);
    const apOk = deps.autopilotOk ?? (config.mode === 'AUTOPILOT' ? (await autopilotGate().catch(() => ({ ok: false }))).ok : true);
    const gate = tickGate({ config, dcfg, metaStale: ev.metaStale, autopilotOk: apOk });
    const out = { at: now.toISOString(), mode: config.mode, gate: gate.map((g) => g.code), evaluated: ev.candidates.length, summary: ev.summary, executed: [], deferred: [], skipped: ev.skipped.length };
    if (ev.metaStale) { out.stale = true; lastRun = out; return out; } // nothing is recorded or executed on untrusted data
    for (const c of ev.candidates.filter((x) => x.productMode === 'AUTOMATIC' && x.autoBlockers.some((b) => b.code === 'NEEDS_CONFIGURATION'))) await raiseAlert({ severity: 'WARNING', category: 'OPERATOR', title: `AUTOMATIC متوقف على منتج ناقص: ${c.productName || c.productKey}`, message: c.autoBlockers.find((b) => b.code === 'NEEDS_CONFIGURATION').message.slice(0, 460), entityId: c.campaignId, dedupeKey: `automation:needs:${c.productKey}:${cairoDate(now)}` }).catch(() => {});
    const p = await persistCandidates(ev.candidates, { adAccountId: ev.adAccountId, mode: config.mode, now }); out.persisted = { created: p.created, updated: p.updated, superseded: p.superseded || 0 };
    if ((deps.sweepStale ?? !deps.evalDeps) && ev.adAccountId && !ev.skipped.some((x) => x.code === 'NO_ACTIVE_PRODUCT_POLICIES')) { // only after a FULL evaluation (a test that injects a partial world must opt in with deps.sweepStale)
       try { const sw = await sweepStale({ seenKeys: new Set(ev.candidates.map((x) => x.key)), today: cairoDate(now) }); out.persisted.expiredStale = sw.expired; } catch (e) { logger.warn('[automation] stale sweep failed', { message: e.message }); } } // open AUTO decisions this full tick did not produce are closed, never left as «actionable»
    if (gate.length) { lastRun = out; return out; } // the owner still sees what WOULD run (PREPARED decisions), nothing executes
    const policies = deps.policies || await loadActivePolicies().catch(() => new Map()); const dayStart = cairoDayStart(now); const sentByProduct = new Map();
    const changesToday = deps.changesToday || ((productId) => (productId == null ? 0 : prisma.ambOperatorDecision.count({ where: { product_id: productId, rule_name: { startsWith: AUTO_PREFIX }, NOT: { rule_name: { startsWith: `${AUTO_PREFIX}MANUAL` } }, action: { in: ['SCALE_UP', 'SCALE_DOWN'] }, status: { in: ['EXECUTING', 'EXECUTED', 'VERIFIED', 'UNCERTAIN'] }, updated_at: { gte: dayStart } } })));
    let sent = 0; const counters = deps.counters || await loadCounters({ now, campaigns: [] }).catch(() => ({ actionsLastHour: 0 })); const hourly = config.limits.maxActionsPerHour || null;
    for (const c of ev.candidates.filter((x) => x.canExecuteNow)) {
      if (sent >= S.maxActionsPerTick) { out.deferred.push({ campaignId: c.campaignId, code: 'MAX_ACTIONS_PER_TICK' }); continue; }
      if (hourly && (counters.actionsLastHour || 0) + sent >= hourly) { out.deferred.push({ campaignId: c.campaignId, code: 'MAX_ACTIONS_PER_HOUR' }); continue; }
      const id = p.ids.get(c.key); if (!id) continue;
      { const cap = ['SCALE_UP', 'SCALE_DOWN'].includes(c.action) ? mergeEffective(policies.get(c.productKey), c.campaignId).budget.maxChangesPerDay : null; if (cap != null) { const done = await changesToday(c.productId) + (deps.changesToday ? (sentByProduct.get(c.productId) || 0) : 0); if (done >= cap) { out.deferred.push({ campaignId: c.campaignId, code: 'PRODUCT_MAX_CHANGES_PER_DAY', detail: `${done}/${cap}` }); continue; } } }
      if (sent > 0 && !deps.noSleep) await new Promise((r) => setTimeout(r, Math.max(3, S.spacingSeconds) * 1000));
      const r = await executeAutoDecision({ decisionId: id, source: 'AUTOPILOT', userId: null, now, deps: deps.execDeps || {} });
      out.executed.push({ decisionId: id, campaignId: c.campaignId, kind: c.kind, status: r.status, verified: r.verified, message: r.message }); if (r.sentRequest || r.executed) { sent++; sentByProduct.set(c.productId, (sentByProduct.get(c.productId) || 0) + 1); }
      if (r.rateLimited) { out.deferred.push({ code: 'META_RATE_LIMIT_STOP' }); break; } // one rate-limit answer stops the whole tick; the rest waits for the next one
    }
    lastRun = out; return out;
  } finally { running = false; }
}
