// 🤖 AI Operator — EVALUATION ENGINE + DECISION LIFECYCLE. 2026-10-03.
//
//   rules + campaigns + context  ->  candidates  ->  guard chain  ->  decision (SHADOW | BLOCKED | PREPARED | AUTO)
//   PREPARED --approve--> APPROVED --> EXECUTING --> EXECUTED --> VERIFIED   (or FAILED / REJECTED / SNOOZED / EXPIRED / ROLLED_BACK)
//
// Meta is written ONLY through the existing executor (AmbRecommendation -> approveAndExecute -> AmbAction): live revalidation, drift
// check, the real Meta write and verify-after-write all stay in ONE place. This module never calls Meta itself.
// Idempotent by construction: decision_key = hash(rule|campaign|action|cooldown-bucket) is UNIQUE, execution claims a decision with a
// conditional update, and the executor has its own duplicate window — retries can never pause/open/scale twice.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { raiseAlert } from './alerts.js';
import { ACTION_LABEL_AR, usesCodField, evaluateConditions, describeCondition, detectRuleConflicts, windowRange, WINDOW_LABEL_AR, FIELDS } from './operatorRules.js';
import { evaluateGuards, decisionConfidence, effectiveMode, BLOCK_CODES } from './operatorGuards.js';
import { listRules, getOperatorConfig } from './operatorStore.js';
import { lifecycleOf, riskRank, isHardSafetyRule, classifyError, evidenceDrift, expectedState, stateMatches, buildCanonical } from './operatorDecision.js';
import { buildOperatorWorld, buildCampaignContext, fieldsForRule, loadRecentActions, loadCounters, ensureHeavy, HEAVY_FIELDS, computeVelocity } from './operatorContext.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const round = (v, d = 2) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);
const MS_H = 3_600_000;
const AMB_ACTION = { PAUSE: 'PAUSE', OPEN: 'RESUME', SCALE_UP: 'INCREASE_BUDGET', SCALE_DOWN: 'DECREASE_BUDGET' };
const INVERSE = { OPEN: 'PAUSE', PAUSE: 'OPEN', SCALE_UP: 'SCALE_DOWN', SCALE_DOWN: 'SCALE_UP' };
const FAMILY_OPPOSED = (a, b) => ({ OPEN: ['PAUSE', 'SCALE_DOWN'], PAUSE: ['OPEN', 'SCALE_UP'], SCALE_UP: ['PAUSE', 'SCALE_DOWN'], SCALE_DOWN: ['OPEN', 'SCALE_UP'] }[a] || []).includes(b);
export const OPEN_STATUSES = ['SHADOW', 'BLOCKED', 'PREPARED', 'SNOOZED'];
/** EXPIRED decisions may be re-proposed in the same cooldown bucket (they never executed); REJECTED/FAILED/EXECUTED ones never are. */
const REOPEN_STATUSES = [...OPEN_STATUSES, 'EXPIRED'];
async function recordEvent(data) { try { await prisma.ambOperatorEvent.create({ data }); } catch (err) { logger.warn('[operator] event write failed', { message: err.message }); } }
const transition = (decisionId, from, to, { actor = 'SYSTEM', actorId = null, note = null, data = null, campaignId = null } = {}) => recordEvent({ decision_id: decisionId, kind: 'TRANSITION', from_status: from, to_status: to, actor, actor_id: actorId, note, data_json: data ? JSON.stringify(data).slice(0, 3000) : null, campaign_id: campaignId });
export const TERMINAL = ['EXECUTED', 'VERIFIED', 'FAILED', 'REJECTED', 'EXPIRED', 'ROLLED_BACK'];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
export function decisionKey({ ruleId, campaignId, action, cooldownHours, now = new Date() }) {
  const bucket = Math.floor(now.getTime() / (Math.max(1, cooldownHours) * MS_H));
  return crypto.createHash('sha1').update(`${ruleId ?? 'sys'}|${campaignId}|${action}|${bucket}`).digest('hex').slice(0, 24);
}

/** Does this rule apply to the campaign (store / product / key / campaign / tag scope)? Unscoped = everything in its store. */
export function ruleApplies(rule, ctx) {
  if (rule.store_id && rule.store_id !== ctx.storeId) return false;
  const s = rule.scope || {};
  if (s.productIds?.length && !s.productIds.includes(ctx.product?.id)) return false;
  if (s.productKeys?.length && !s.productKeys.some((k) => k && k === ctx.product?.productKey)) return false;
  if (s.campaignIds?.length && !s.campaignIds.includes(ctx.campaign?.id)) return false;
  if (s.tags?.length && !s.tags.includes(ctx.campaign?.tag)) return false;
  if (s.excludeTags?.length && s.excludeTags.includes(ctx.campaign?.tag)) return false;
  return true;
}
/** What the action needs to be KNOWN before it may run (drives which guards apply). */
export function dependenciesOf(rule) {
  const fields = new Set([...(rule.conditions?.all || []), ...(rule.conditions?.any || [])].map((c) => c.field));
  const refs = new Set([...(rule.conditions?.all || []), ...(rule.conditions?.any || [])].map((c) => c.value?.ref).filter(Boolean));
  const a = rule.action;
  return {
    dq: true,
    stock: a === 'OPEN' || a === 'SCALE_UP' || fields.has('stock') || fields.has('days_of_stock'),
    profit: a === 'OPEN' || a === 'SCALE_UP' || fields.has('profit_state') || fields.has('margin_pct'),
    hardStop: refs.has('hard_stop_cpa') || fields.has('hard_stop_cpa'),
    targetCpa: refs.has('target_cpa') || fields.has('target_cpa') || refs.has('max_cpa'),
  };
}
export function lossFor(metrics, econ) {
  const spend = metrics?.spend ?? 0, purchases = metrics?.purchases ?? 0;
  if (econ?.complete && econ.unitMargin != null) return Math.max(0, spend - purchases * econ.unitMargin);
  return purchases === 0 ? spend : 0; // economics unknown: only spend with NO result counts as (wasted) loss
}

/** The "explain every decision" block (spec §54): ماذا / لماذا / بناءً على أي بيانات / أي Rule / ما يمنع / المخاطر / ماذا سيحدث. */
export function buildWhy({ action, rule, details, guards, ctx, params }) {
  const based = (details || []).map(describeCondition);
  const blocks = (guards.blocks || []).filter((b) => b.severity === 'BLOCK').map((b) => b.message + (b.detail ? ` (${b.detail})` : ''));
  const risks = [];
  if (action === 'PAUSE') risks.push('ممكن توقف حملة كانت هتجيب أوردر لاحقًا (الإيقاف مبني على عينة محددة).');
  if (action === 'OPEN') risks.push('الصرف هيبدأ تاني — لازم المخزون والربحية يفضلوا سليمين.');
  if (action === 'SCALE_UP') risks.push('زيادة الميزانية ممكن تغيّر أداء الحملة (Learning). الرجوع بيتجهز بموافقتك.');
  if ((guards.warnings || []).length) risks.push(...guards.warnings.map((w) => w.message));
  const after = { PAUSE: 'الحملة هتتوقف ويوقف الصرف.', OPEN: 'الحملة هتتفعّل وتكمل صرف.', SCALE_UP: `الميزانية هتزيد${params?.pct ? ` ${params.pct}%` : ''}${params?.toBudget ? ` (إلى ${params.toBudget})` : ''}.`, SCALE_DOWN: `الميزانية هتقل${params?.pct ? ` ${params.pct}%` : ''}.`, PREPARE_TEST: 'هيتجهز اختبار كرياتيف عبر المستشار الذكي (من غير نشر).' }[action];
  return {
    what: `${ACTION_LABEL_AR[action] || action} — ${ctx.campaign?.name || ctx.campaign?.id}`,
    why: rule ? `القاعدة "${rule.name}" اتحققت (${WINDOW_LABEL_AR[rule.window] || rule.window}).` : 'قرار نظام.',
    basedOn: based, rule: rule ? { id: rule.id, name: rule.name, mode: rule.mode, window: rule.window } : null,
    blocking: blocks, risks, afterExecution: after,
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
/**
 * Evaluates enabled rules (or `rules` override, used by simulation/draft rules) over every campaign. Returns candidates with their
 * guard results; with `persist` it upserts them as decisions (and, ONLY in Autopilot with every guard passing, executes via `deps`).
 */
export async function evaluateOperator({ rules = null, persist = false, only = null, now = new Date(), deps = {}, autoExecute = true } = {}) {
  const t0 = Date.now();
  const allRules = (rules || await listRules()).filter((r) => rules ? true : r.enabled);
  const world = deps.world || await buildOperatorWorld({ windowKeys: allRules.map((r) => r.window), now, only });
  const { config, settings } = world;
  const out = { evaluatedAt: now.toISOString(), mode: config.mode, emergencyStop: config.emergency_stop, rulesEvaluated: allRules.length, campaignsEvaluated: 0, candidates: [], conflicts: [], summary: null, world: { adAccountId: world.adAccountId, connected: world.connected, metaStale: world.metaStale } };
  if (!world.adAccountId || !allRules.length) { out.summary = summarize(out.candidates); out.ms = Date.now() - t0; return out; }

  const conflicts = detectRuleConflicts(allRules);
  out.conflicts = conflicts;
  const recent = await loadRecentActions({ campaignIds: world.campaigns.map((c) => c.id), now, pendingHours: config.limits.pendingEvaluationHours });
  const counters = await loadCounters({ now, campaigns: world.campaigns });

  // pass 1: contexts (+ loss aggregates)
  const ctxs = [];
  for (const campaign of world.campaigns) {
    if (!['ACTIVE', 'PAUSED'].includes(campaign.status)) continue;
    ctxs.push(await buildCampaignContext({ world, campaign, recentByCampaign: recent }));
  }
  const lossBy = { campaign: new Map(), product: new Map(), account: 0 };
  for (const c of ctxs) { const l = lossFor(c.metrics, c.econ); lossBy.campaign.set(c.campaign.id, l); if (c.product?.id != null) lossBy.product.set(c.product.id, (lossBy.product.get(c.product.id) || 0) + l); lossBy.account += l; }

  const sorted = [...allRules].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id - b.id);
  const run = { autoExecuted: 0, counters: { ...counters, byAction: { ...(counters.byAction || {}) } } };
  for (const ctx of ctxs) {
    out.campaignsEvaluated++;
    const perCampaign = [];
    for (const rule of sorted) {
      if (!ruleApplies(rule, ctx)) continue;
      const a = rule.action;
      // no-op candidates are silent (not recorded): OPEN on an active campaign, PAUSE/SCALE on a paused one
      if (a === 'OPEN' && ctx.campaign.status !== 'PAUSED') continue;
      if (['PAUSE', 'SCALE_UP', 'SCALE_DOWN'].includes(a) && ctx.campaign.status !== 'ACTIVE') continue;
      const windowMetrics = world.windows[rule.window]?.get(ctx.campaign.id) || null;
      // cheap-first: a DEFINITIVE failure on already-synced metrics skips the campaign without loading any heavy product facts
      let ev = evaluateConditions(rule.conditions, fieldsForRule({ ctx, windowMetrics }));
      const metricUnknown = (e) => e.details.some((d) => d.unknown && !HEAVY_FIELDS.has(d.field)); // e.g. no purchases => no CPA: a plain non-match
      if (!ev.matched && (!ev.unknown || metricUnknown(ev))) continue;
      await ensureHeavy(ctx);
      ev = evaluateConditions(rule.conditions, fieldsForRule({ ctx, windowMetrics }));
      if (!ev.matched && (!ev.unknown || metricUnknown(ev))) continue;
      // A missing METRIC (e.g. no purchases => no CPA) is a plain non-match. Missing PRODUCT FACTS (stock / economics / data quality) make the
      // rule undecidable: surface it as BLOCKED-by-unknown-data instead of silently dropping it (never converted to zero/pass).
      const unknownFields = ev.details.filter((d) => d.unknown).map((d) => d.field);
      const dataUnknown = !ev.matched && ev.unknown && unknownFields.length > 0 && unknownFields.every((f) => HEAVY_FIELDS.has(f));
      if (!ev.matched && !dataUnknown) continue;

      const params = {};
      let budgetBlock = false;
      if (['SCALE_UP', 'SCALE_DOWN'].includes(a)) {
        const pct = Number(rule.action_params?.pct) || 10;
        params.pct = pct; params.fromBudget = ctx.campaign.budget ?? null;
        if (ctx.campaign.budget == null) budgetBlock = true;
        else params.toBudget = round(a === 'SCALE_UP' ? ctx.campaign.budget * (1 + pct / 100) : ctx.campaign.budget * (1 - pct / 100));
      }
      const needs = dependenciesOf(rule);
      const spendCond = (rule.conditions?.all || []).find((c) => c.field === 'spend' && ['>=', '>'].includes(c.op) && typeof c.value === 'number');
      const confidence = decisionConfidence({ action: a, metrics: windowMetrics, settings, mappingVerified: !!ctx.product?.mappingVerified, dqOk: ctx.dq?.gate !== 'DECISION_BLOCKED_DATA_QUALITY' && !!ctx.dq?.gate, econKnown: !!ctx.econ?.complete, stockKnown: !!ctx.stock && ctx.stock.status !== 'STOCK_UNKNOWN', needs });
      const category = isHardSafetyRule(rule) ? 'HARD_SAFETY' : 'OPTIMIZATION';
      const myConflicts = conflicts.filter((c) => (c.a === rule.id || c.b === rule.id) && c.winner !== rule.id);
      if (a === 'SCALE_UP' && ctx.velocity === null && !ctx.velocityLoaded) { ctx.velocityLoaded = true; ctx.velocity = await computeVelocity({ campaignId: ctx.campaign.id, now, cfg: config.limits.spendVelocity }).catch(() => null); }
      const guardCtx = { ...ctx, metrics: windowMetrics || {}, ruleConflicts: myConflicts };
      const guards = evaluateGuards({
        decision: { action: a, params, ruleMode: rule.mode, confidence, needs, usesCod: usesCodField(rule), cooldownHours: rule.cooldown_hours, ruleMinSpend: spendCond?.value ?? null, severeOverride: category === 'HARD_SAFETY' },
        ctx: guardCtx, config, settings, now,
        counters: { ...run.counters, campaignActionsToday: ctx.recent.todayCount, loss: { campaign: lossBy.campaign.get(ctx.campaign.id) || 0, product: ctx.product?.id != null ? lossBy.product.get(ctx.product.id) || 0 : 0, account: lossBy.account } },
      });
      if (dataUnknown) { const labels = unknownFields.map((f) => FIELDS[f]?.label || f).join('، '); guards.blocks.unshift({ code: 'DATA_UNKNOWN', ...BLOCK_CODES.DATA_UNKNOWN, detail: labels }); guards.primary = guards.blocks.find((b) => b.severity === 'BLOCK'); guards.wouldBe = 'BLOCKED'; guards.canExecute = false; guards.canAutoExecute = false; }
      if (budgetBlock) { guards.blocks.unshift({ code: 'BUDGET_UNKNOWN', ...BLOCK_CODES.BUDGET_UNKNOWN }); guards.primary = guards.blocks[0]; guards.wouldBe = 'BLOCKED'; guards.canExecute = false; guards.canAutoExecute = false; }
      const eff = effectiveMode(config.mode, rule.mode);
      perCampaign.push({ rule, ctx, action: a, params, ev, windowMetrics, confidence, guards, eff, needs, category });
    }
    // rule-vs-rule on the SAME campaign: the lowest priority number wins, opposed lower-priority candidates are superseded
    perCampaign.sort((x, y) => (x.rule.priority ?? 100) - (y.rule.priority ?? 100));
    const winners = [];
    for (const c of perCampaign) {
      const loser = winners.find((w) => FAMILY_OPPOSED(w.action, c.action) && w.guards.wouldBe !== 'BLOCKED');
      if (loser) { c.guards.blocks.unshift({ code: 'SUPERSEDED_BY_RULE', ...BLOCK_CODES.SUPERSEDED_BY_RULE, detail: loser.rule.name }); c.guards.primary = c.guards.blocks.find((b) => b.severity === 'BLOCK'); c.guards.wouldBe = 'BLOCKED'; c.guards.canExecute = false; c.guards.canAutoExecute = false; }
      else winners.push(c);
    }
    for (const c of perCampaign) {
      const why = buildWhy({ action: c.action, rule: c.rule, details: c.ev.details, guards: c.guards, ctx: c.ctx, params: c.params });
      const key = decisionKey({ ruleId: c.rule.id, campaignId: c.ctx.campaign.id, action: c.action, cooldownHours: c.rule.cooldown_hours, now });
      out.candidates.push({
        key, ruleId: c.rule.id, ruleName: c.rule.name, ruleMode: c.rule.mode, effectiveMode: c.eff, action: c.action, params: c.params, confidence: c.confidence,
        wouldBe: c.guards.wouldBe, canAutoExecute: c.guards.canAutoExecute, blocks: c.guards.blocks, primaryBlock: c.guards.primary || null, warnings: c.guards.warnings,
        store: c.ctx.storeId, productId: c.ctx.product?.id ?? null, ambProductId: c.ctx.product?.ambProductId ?? null, productName: c.ctx.product?.name || null,
        campaign: { id: c.ctx.campaign.id, name: c.ctx.campaign.name, status: c.ctx.campaign.status, budget: c.ctx.campaign.budget, tag: c.ctx.campaign.tag },
        window: c.rule.window, windowRange: windowRange(c.rule.window, now.toISOString().slice(0, 10)),
        evidence: {
          metrics: pickMetrics(c.windowMetrics), todayMetrics: pickMetrics(world.windows.today?.get(c.ctx.campaign.id)), conditions: c.ev.details,
          economics: { complete: c.ctx.econ?.complete, profitState: c.ctx.econ?.profitState, targetCpa: c.ctx.econ?.targetCpa, maxCpa: c.ctx.econ?.maxCpa, hardStopCpa: c.ctx.econ?.hardStopCpa, unitMargin: c.ctx.econ?.unitMargin },
          stock: c.ctx.stock ? { status: c.ctx.stock.status, current: c.ctx.stock.currentStock, daysRemaining: c.ctx.stock.daysRemaining } : null,
          dataQuality: c.ctx.dq ? { gate: c.ctx.dq.gate, overall: c.ctx.dq.overall, statusTrust: c.ctx.dq.statusTrust?.state || null } : null,
          mapping: { via: c.ctx.product?.mappingSource, verified: !!c.ctx.product?.mappingVerified }, advisor: c.ctx.advisor, exceptionsApplied: (c.ctx.exceptions || []).map((e) => ({ id: e.id, types: e.types })),
          meta: { stale: world.metaStale, lastSyncAt: world.metaLastSyncAt },
        },
        why, advisor: c.ctx.advisor ? { stage: c.ctx.advisor.stage, primaryProblem: c.ctx.advisor.primaryProblem, planVersion: c.ctx.advisor.planVersion } : null,
        ruleVersion: c.rule.version ?? null, category: c.category, riskRank: riskRank({ action: c.action, category: c.category }),
        ruleSnapshot: { id: c.rule.id, version: c.rule.version ?? null, name: c.rule.name, window: c.rule.window, conditions: c.rule.conditions, action: c.rule.action, action_params: c.rule.action_params || {}, mode: c.rule.mode, cooldown_hours: c.rule.cooldown_hours, priority: c.rule.priority },
        expected: expectedState({ action: c.action, campaign: c.ctx.campaign, params: c.params }),
      });
      const cand = out.candidates[out.candidates.length - 1];
      cand.canonical = buildCanonical({ decisionKey: key, storeId: cand.store, productId: cand.productId, campaignId: cand.campaign.id, campaignName: cand.campaign.name, evaluatedAt: now.toISOString(), window: cand.window, windowRange: cand.windowRange,
        currentState: { status: cand.campaign.status, budget: cand.campaign.budget }, action: cand.action, params: cand.params, ruleId: cand.ruleId, ruleVersion: cand.ruleVersion, ruleName: cand.ruleName, category: cand.category,
        advisorPlanVersion: cand.advisor?.planVersion ?? null, evidence: cand.evidence, blocks: cand.blocks, confidence: cand.confidence, effectiveMode: cand.effectiveMode, status: cand.wouldBe, lifecycle: cand.wouldBe === 'BLOCKED' ? 'BLOCKED' : cand.wouldBe === 'SHADOW' ? 'SHADOW' : 'READY_FOR_APPROVAL' });
    }
  }
  out.candidates.sort((x, y) => x.riskRank - y.riskRank || (x.ruleId ?? 0) - (y.ruleId ?? 0));
  out.summary = summarize(out.candidates);
  out.ms = Date.now() - t0;
  if (!persist) return out;

  // ---- persistence (+ Autopilot execution, bounded by the SAME rate limits via run.counters)
  const seen = new Set();
  for (const c of out.candidates) {
    const row = await persistCandidate(c, { adAccountId: world.adAccountId, mode: config.mode, now });
    seen.add(c.key);
    c.decisionId = row?.id ?? null; c.status = row?.status ?? null;
    if (row && row.status === 'PREPARED' && c.canAutoExecute && autoExecute && config.mode === 'AUTOPILOT' && !config.emergency_stop) {
      if (config.limits.maxActionsPerHour && run.counters.actionsLastHour >= config.limits.maxActionsPerHour) continue;
      const res = await executeDecision({ decisionId: row.id, source: 'AUTOPILOT', userId: null, deps });
      c.execution = { ok: res.ok, status: res.status, message: res.message };
      if (res.executed) { run.counters.actionsLastHour++; run.counters.actionsToday++; run.autoExecuted++; run.counters.byAction[c.action] = (run.counters.byAction[c.action] || 0) + 1; }
    }
  }
  if (!only) out.expired = await expireStale({ seen, now });
  out.autoExecuted = run.autoExecuted;
  return out;
}

function pickMetrics(m) { return m ? { spend: round(m.spend), purchases: m.purchases, cpa: round(m.cpa), ctr: round(m.ctr), cvr: round(m.conversionRate), cpc: round(m.cpc), cpm: round(m.cpm), roas: round(m.roas), frequency: round(m.frequency) } : null; }
export function summarize(cands) {
  const by = { total: cands.length, byAction: {}, byStatus: {}, blockedByCode: {}, wouldOpen: 0, wouldPause: 0, wouldScale: 0, wouldReduce: 0, excluded: 0, unknown: 0, protected: 0, blockedByDataQuality: 0, blockedBySafety: 0 };
  for (const c of cands) {
    by.byAction[c.action] = (by.byAction[c.action] || 0) + 1; by.byStatus[c.wouldBe] = (by.byStatus[c.wouldBe] || 0) + 1;
    for (const b of c.blocks.filter((x) => x.severity === 'BLOCK')) by.blockedByCode[b.code] = (by.blockedByCode[b.code] || 0) + 1;
    if (c.wouldBe !== 'BLOCKED') { if (c.action === 'OPEN') by.wouldOpen++; if (c.action === 'PAUSE') by.wouldPause++; if (c.action === 'SCALE_UP') by.wouldScale++; if (c.action === 'SCALE_DOWN') by.wouldReduce++; }
    else {
      const p = c.primaryBlock;
      if (p?.group === 'EXCEPTION') by.excluded++;
      if (['DATA_UNKNOWN', 'ECONOMICS_INCOMPLETE', 'STOCK_UNKNOWN', 'MAPPING_UNRELIABLE', 'DATA_QUALITY_UNKNOWN'].includes(p?.code)) by.unknown++;
      if (p?.group === 'EXCEPTION' || p?.code === 'TESTING_PROTECTED') by.protected++;
      else if (p?.group === 'DATA_QUALITY') by.blockedByDataQuality++;
      else by.blockedBySafety++;
    }
  }
  return by;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
const STATUS_FROM_WOULDBE = { SHADOW: 'SHADOW', BLOCKED: 'BLOCKED', PREPARED: 'PREPARED', AUTO: 'PREPARED' };
async function persistCandidate(c, { adAccountId, mode, now }) {
  const status = STATUS_FROM_WOULDBE[c.wouldBe] || 'SHADOW';
  const data = {
    store_id: c.store || 'UNKNOWN', product_id: c.productId, amb_product_id: c.ambProductId, ad_account_id: adAccountId, campaign_id: c.campaign.id, campaign_name: c.campaign.name,
    action: c.action, rule_id: c.ruleId, rule_name: c.ruleName, mode_at_decision: c.effectiveMode, confidence: c.confidence,
    blocked_codes_json: JSON.stringify(c.blocks.map((b) => ({ code: b.code, group: b.group, severity: b.severity, message: b.message, detail: b.detail || null }))),
    evidence_json: JSON.stringify(c.evidence), why_json: JSON.stringify(c.why), params_json: JSON.stringify({ ...c.params, window: c.window }),
    advisor_plan_version: c.advisor?.planVersion ?? null,
    rule_version: c.ruleVersion ?? null, rule_snapshot_json: c.ruleSnapshot ? JSON.stringify(c.ruleSnapshot) : null, expected_state_json: JSON.stringify(c.expected || {}),
  };
  const existing = await prisma.ambOperatorDecision.findUnique({ where: { decision_key: c.key } });
  if (!existing) {
    try {
      const created = await prisma.ambOperatorDecision.create({ data: { decision_key: c.key, status, before_json: JSON.stringify({ status: c.campaign.status, budget: c.campaign.budget }), ...data } });
      await transition(created.id, 'CANDIDATE', status, { actor: 'SYSTEM', note: c.blocks.find((b) => b.severity === 'BLOCK')?.code || null, campaignId: c.campaign.id });
      return created;
    } catch (err) { if (err.code === 'P2002') return prisma.ambOperatorDecision.findUnique({ where: { decision_key: c.key } }); throw err; }
  }
  if (REOPEN_STATUSES.includes(existing.status)) {
    if (existing.status === 'SNOOZED' && existing.snoozed_until && existing.snoozed_until > now) return existing; // honour the snooze
    const upd = await prisma.ambOperatorDecision.update({ where: { id: existing.id }, data: { ...data, status, ...(existing.status === 'EXPIRED' ? { error: null } : {}) } });
    if (upd.status !== existing.status) await transition(existing.id, existing.status, upd.status, { actor: 'SYSTEM', note: c.blocks.find((b) => b.severity === 'BLOCK')?.code || null, campaignId: c.campaign.id });
    return upd;
  }
  return existing; // APPROVED / EXECUTING / terminal: never rewritten by a re-evaluation (idempotent)
}
/** Pre-execution decisions that stopped being produced are EXPIRED (context changed) — never silently left as "actionable". */
async function expireStale({ seen, now }) {
  const rows = await prisma.ambOperatorDecision.findMany({ where: { status: { in: ['SHADOW', 'BLOCKED', 'PREPARED'] } }, select: { id: true, decision_key: true } });
  const stale = rows.filter((r) => !seen.has(r.decision_key)).map((r) => r.id);
  if (!stale.length) return 0;
  const r = await prisma.ambOperatorDecision.updateMany({ where: { id: { in: stale }, status: { in: ['SHADOW', 'BLOCKED', 'PREPARED'] } }, data: { status: 'EXPIRED', error: 'NO_LONGER_APPLICABLE' } });
  for (const id of stale) await transition(id, null, 'EXPIRED', { actor: 'SYSTEM', note: 'NO_LONGER_APPLICABLE' });
  return r.count;
}

// ---------------------------------------------------------------------------
// Lifecycle: approve / reject / snooze / execute / rollback
// ---------------------------------------------------------------------------
/** Rejection is OPERATIONAL, not a verdict on the strategy: the reason is stored, nothing is learned from it automatically (spec 87). */
export async function rejectDecision({ decisionId, userId = null, reason = null }) {
  const r = await prisma.ambOperatorDecision.updateMany({ where: { id: Number(decisionId), status: { in: ['PREPARED', 'SHADOW', 'BLOCKED', 'SNOOZED'] } }, data: { status: 'REJECTED', error: 'REJECTED_BY_USER', reject_reason: reason ? String(reason).slice(0, 500) : null, approved_by_id: userId, approved_at: new Date() } });
  if (r.count === 1) await transition(Number(decisionId), null, 'REJECTED', { actor: 'USER', actorId: userId, note: reason || null });
  return { ok: r.count === 1 };
}
export async function snoozeDecision({ decisionId, hours = 24 }) {
  const until = new Date(Date.now() + Math.min(Math.max(1, Number(hours) || 24), 168) * MS_H);
  const r = await prisma.ambOperatorDecision.updateMany({ where: { id: Number(decisionId), status: { in: ['PREPARED', 'SHADOW', 'BLOCKED'] } }, data: { status: 'SNOOZED', snoozed_until: until } });
  if (r.count === 1) await transition(Number(decisionId), null, 'SNOOZED', { actor: 'USER', note: `until ${until.toISOString()}` });
  return { ok: r.count === 1, until };
}
export async function approveDecision({ decisionId, userId, deps = {} }) {
  const row = await prisma.ambOperatorDecision.findUnique({ where: { id: Number(decisionId) } });
  if (!row) { const e = new Error('القرار غير موجود.'); e.status = 404; throw e; }
  if (row.status !== 'PREPARED') { const e = new Error(`القرار في حالة ${row.status} — مش قابل للموافقة.`); e.status = 409; throw e; }
  const claimed = await prisma.ambOperatorDecision.updateMany({ where: { id: row.id, status: 'PREPARED' }, data: { status: 'APPROVED', approval_source: 'USER', approved_by_id: userId || null, approved_at: new Date() } });
  if (claimed.count !== 1) { const e = new Error('القرار اتغيّر في نفس اللحظة — حدّث الصفحة.'); e.status = 409; throw e; }
  await transition(row.id, 'PREPARED', 'APPROVED', { actor: 'USER', actorId: userId, campaignId: row.campaign_id });
  return executeDecision({ decisionId: row.id, source: 'USER', userId, deps });
}

/**
 * Executes ONE decision through the existing executor. Re-evaluates immediately before the write (spec 66/67): the campaign must still exist in
 * the expected state, the rule must be the same version and still active, no exception / Emergency Stop / data-quality / stock / price change may
 * have appeared, and the critical evidence must not have drifted. ANY of that => EXPIRE, never execute. The decision is then claimed atomically,
 * written through the existing executor (live revalidation + Meta write + verify-after-write all live there) and mapped back honestly:
 * "request sent" is not "executed" until the read-back verified it (spec 106). `deps.approveAndExecute` is injectable so tests never touch Meta.
 */
export async function executeDecision({ decisionId, source = 'USER', userId = null, deps = {} }) {
  const now = deps.now || new Date();
  const row = await prisma.ambOperatorDecision.findUnique({ where: { id: Number(decisionId) } });
  if (!row) return { ok: false, executed: false, status: 'NOT_FOUND', message: 'القرار غير موجود.' };
  if (!['PREPARED', 'APPROVED'].includes(row.status)) return { ok: false, executed: false, status: row.status, message: `القرار في حالة ${row.status} — مش قابل للتنفيذ.` };
  const actor = source === 'AUTOPILOT' ? 'AUTOPILOT' : 'USER';

  // 1. revalidate with a fresh single-campaign world (the rule must still match and every guard must still pass)
  const params = j(row.params_json, {});
  const isRollback = row.rule_id == null && params.rollbackOf != null;
  const rule = row.rule_id ? (await listRules()).find((r) => r.id === row.rule_id) : null;
  let cand;
  const expireReasons = [];
  if (isRollback) {
    // A rollback has no rule to re-match: it restores the state captured BEFORE the original write. Mode / Emergency Stop below still apply, and the
    // executor re-validates the write itself against live Meta state. Autopilot rollback is only possible when explicitly enabled in limits.
    cand = { action: row.action, ruleId: null, productName: null, blocks: [], primaryBlock: null, canAutoExecute: false, campaign: { status: null, budget: params.fromBudget ?? null }, evidence: { metrics: {} } };
  } else {
    if (row.rule_id && !rule) expireReasons.push({ code: 'RULE_REMOVED', detail: String(row.rule_id) });
    else if (rule && !rule.enabled) expireReasons.push({ code: 'RULE_DISABLED', detail: rule.name });
    else if (rule && row.rule_version != null && rule.version !== row.rule_version) expireReasons.push({ code: 'RULE_CHANGED', detail: `v${row.rule_version} → v${rule.version}` });
    const fresh = await evaluateOperator({ rules: rule ? [{ ...rule, enabled: true, mode: source === 'AUTOPILOT' ? rule.mode : 'APPROVAL' }] : [], only: { campaignIds: [row.campaign_id] }, now, deps: { world: deps.world }, persist: false });
    cand = fresh.candidates.find((c) => c.action === row.action && c.ruleId === row.rule_id);
    if (cand) {
      expireReasons.push(...stateMatches(j(row.expected_state_json, null), cand.campaign));
      expireReasons.push(...evidenceDrift(j(row.evidence_json, {}), cand.evidence, { action: row.action }));
    }
  }
  const config = await getOperatorConfig();
  let blockedReason = null, expire = false;
  if (config.emergency_stop) blockedReason = BLOCK_CODES.EMERGENCY_STOP.message;
  else if (config.mode === 'OFF') blockedReason = BLOCK_CODES.MODE_OFF.message;
  else if (config.mode === 'SHADOW') blockedReason = BLOCK_CODES.MODE_SHADOW_NO_EXECUTION.message;
  else if (!cand) { blockedReason = BLOCK_CODES.CONDITIONS_CHANGED.message; expire = true; }
  else if (expireReasons.length) { blockedReason = `القرار اتبطل — الأدلة/الحالة اتغيّرت: ${expireReasons.map((r) => `${r.code}${r.detail ? ` (${r.detail})` : ''}`).join('، ')}`; expire = true; }
  else if (cand.blocks.some((b) => b.severity === 'BLOCK' && b.code !== 'RULE_CONFLICT')) blockedReason = cand.primaryBlock?.message || 'ممنوع بحاجز أمان.';
  else if (isRollback && source === 'AUTOPILOT' && !config.limits.allowAutoRollback) blockedReason = 'الرجوع التلقائي مش مفعّل — محتاج موافقتك.';
  else if (!isRollback && source === 'AUTOPILOT' && !cand.canAutoExecute) blockedReason = 'Autopilot مش مسموح لهذا القرار (ثقة/أكشن/حد) — يفضل للموافقة.';
  if (blockedReason) {
    const keep = source === 'AUTOPILOT' && row.status === 'PREPARED' && !expire;
    const to = keep ? 'PREPARED' : (expire ? 'EXPIRED' : 'BLOCKED');
    await prisma.ambOperatorDecision.update({ where: { id: row.id }, data: { status: to, error: blockedReason, error_category: expire ? 'GUARD' : null, blocked_codes_json: JSON.stringify((cand?.blocks || []).map((b) => ({ code: b.code, specCodes: b.specCodes, group: b.group, severity: b.severity, message: b.message, detail: b.detail || null }))) } });
    if (to !== row.status) await transition(row.id, row.status, to, { actor, actorId: userId, note: blockedReason, data: expireReasons.length ? { expireReasons } : null, campaignId: row.campaign_id });
    return { ok: false, executed: false, status: expire ? 'EXPIRED' : 'BLOCKED', message: blockedReason, expireReasons };
  }

  // 2. atomic claim — a retried/duplicated call can never execute twice
  const claim = await prisma.ambOperatorDecision.updateMany({ where: { id: row.id, status: { in: ['PREPARED', 'APPROVED'] } }, data: { status: 'EXECUTING', approval_source: row.approval_source || source, approved_by_id: row.approved_by_id ?? userId ?? null, approved_at: row.approved_at || new Date() } });
  if (claim.count !== 1) return { ok: false, executed: false, status: 'RACE', message: 'القرار بيتنفذ بالفعل.' };
  await transition(row.id, row.status, 'EXECUTING', { actor, actorId: userId, campaignId: row.campaign_id });

  // 3. the executable recommendation the existing executor understands
  const m = cand.evidence.metrics || {};
  const rec = await prisma.ambRecommendation.create({ data: {
    batch_id: `operator-${row.id}`, ad_account_id: row.ad_account_id, amb_product_id: row.amb_product_id, product_name: cand.productName, level: 'campaign', entity_id: row.campaign_id, entity_name: row.campaign_name,
    campaign_id: row.campaign_id, campaign_name: row.campaign_name, decision: AMB_ACTION[row.action] || row.action, action_type: AMB_ACTION[row.action], executable: !!AMB_ACTION[row.action],
    current_metrics_json: JSON.stringify({ spend: m.spend ?? null, cpa: m.cpa ?? null, purchases: m.purchases ?? null }), current_budget: params.fromBudget ?? null, recommended_budget: params.toBudget ?? null,
    budget_change_pct: params.pct ? (row.action === 'SCALE_UP' ? params.pct : -params.pct) : null,
    reason: `AI Operator — ${row.rule_name || 'rule'}: ${j(row.why_json, {})?.why || ''}`.slice(0, 900), reason_facts_json: row.evidence_json, confidence: row.confidence, risk_level: row.action === 'SCALE_UP' || row.action === 'OPEN' ? 'MEDIUM' : 'LOW', data_sufficiency: 'STRONG', priority: 'P2',
    time_window_label: WINDOW_LABEL_AR[params.window] || 'اليوم', source: 'OPERATOR', status: 'PENDING',
  } });
  await prisma.ambOperatorDecision.update({ where: { id: row.id }, data: { amb_recommendation_id: rec.id, before_json: JSON.stringify({ status: cand.campaign.status, budget: cand.campaign.budget }) } });

  // 4. the guarded write (live revalidation + Meta write + verify-after-write all inside the existing executor)
  const exec = deps.approveAndExecute || (await import('./executor.js')).approveAndExecute;
  let result = null, err = null;
  try { result = await exec({ recId: rec.id, userId: userId || null, mode: source === 'AUTOPILOT' ? 'AUTOPILOT' : 'APPROVAL' }); }
  catch (e) { err = e; }
  const action = await prisma.ambAction.findFirst({ where: { recommendation_id: rec.id }, orderBy: { id: 'desc' } });
  const oldV = j(action?.old_value_json, null), newV = j(action?.new_value_json, null), verify = j(action?.verify_json, null);
  const base = { amb_action_id: action?.id ?? null, before_json: JSON.stringify(oldV || { status: cand.campaign.status, budget: cand.campaign.budget }), after_json: newV ? JSON.stringify(newV) : null, rollback_json: oldV ? JSON.stringify({ capturedBeforeWrite: true, previous: oldV, actionId: action?.id, at: new Date().toISOString() }) : null };
  if (err || !result?.ok) {
    const msg = err?.message || result?.message || 'فشل التنفيذ.';
    const category = result?.aborted ? 'GUARD' : classifyError(err || { message: msg });
    await prisma.ambOperatorDecision.update({ where: { id: row.id }, data: { ...base, status: result?.aborted ? 'BLOCKED' : 'FAILED', error: msg, error_category: category } });
    await transition(row.id, 'EXECUTING', result?.aborted ? 'BLOCKED' : 'FAILED', { actor, actorId: userId, note: msg, data: { category }, campaignId: row.campaign_id });
    await raiseAlert({ severity: 'WARNING', category: 'OPERATOR', title: `AI Operator: تنفيذ لم يتم — ${row.campaign_name || row.campaign_id}`, message: `${msg} (${category === 'RETRYABLE' ? 'ممكن تعيد المحاولة' : 'مش هيتعاد تلقائيًا'})`, adAccountId: row.ad_account_id, entityId: row.campaign_id, dedupeKey: `operator:fail:${row.id}` }).catch(() => {});
    return { ok: false, executed: false, status: 'FAILED', category, message: msg };
  }
  const verified = !!(verify?.verified ?? false);
  await prisma.ambOperatorDecision.update({ where: { id: row.id }, data: { ...base, status: verified ? 'VERIFIED' : 'EXECUTED', executed_at: action?.executed_at || new Date(), verified_at: verified ? (action?.verified_at || new Date()) : null, verify_json: action?.verify_json || null, error: verified ? null : 'تم إرسال الطلب إلى Meta لكن القراءة الفورية لم تؤكد التغيير بعد.' } });
  await transition(row.id, 'EXECUTING', verified ? 'VERIFIED' : 'EXECUTED', { actor, actorId: userId, campaignId: row.campaign_id, data: { verified } });
  if (!verified) await raiseAlert({ severity: 'WARNING', category: 'OPERATOR', title: `AI Operator: الطلب اتبعت ومفيش تأكيد — ${row.campaign_name || row.campaign_id}`, message: 'Meta قبلت الطلب لكن القراءة بعده لسه ما أكدتش التغيير. هنعيد الفحص ولن نعتبره "تم التنفيذ" قبل التأكيد.', adAccountId: row.ad_account_id, entityId: row.campaign_id, dedupeKey: `operator:unverified:${row.id}` }).catch(() => {});
  if (source === 'AUTOPILOT') await raiseAlert({ severity: 'INFO', category: 'OPERATOR', title: `Autopilot نفّذ: ${row.action} — ${row.campaign_name || row.campaign_id}`, message: `القاعدة: ${row.rule_name || '—'}`, adAccountId: row.ad_account_id, entityId: row.campaign_id, dedupeKey: `operator:auto:${row.id}` }).catch(() => {});
  await linkAdvisorAfterExecution({ row, cand }).catch((e) => logger.warn('[operator] advisor link failed', { message: e.message }));
  return { ok: true, executed: true, status: verified ? 'VERIFIED' : 'EXECUTED', verified, message: verified ? 'تم التنفيذ — اتأكد من قراءة Meta.' : 'تم إرسال الطلب إلى Meta — لسه مفيش تأكيد بقراءة Meta.', actionId: action?.id };
}

/** A FAILED decision may be retried by a human ONLY when its failure was RETRYABLE, and at most 3 times — never an automatic loop (spec 107). */
export async function retryFailedDecision({ decisionId, userId = null }) {
  const row = await prisma.ambOperatorDecision.findUnique({ where: { id: Number(decisionId) } });
  if (!row) { const e = new Error('القرار غير موجود.'); e.status = 404; throw e; }
  if (row.status !== 'FAILED' || row.error_category !== 'RETRYABLE') { const e = new Error('الفشل ده مش قابل لإعادة المحاولة (فشل دائم أو مش فاشل).'); e.status = 409; throw e; }
  const tries = await prisma.ambOperatorEvent.count({ where: { decision_id: row.id, kind: 'TRANSITION', from_status: 'FAILED', to_status: 'PREPARED' } });
  if (tries >= 3) { const e = new Error('وصلت لأقصى عدد محاولات (3).'); e.status = 409; throw e; }
  const r = await prisma.ambOperatorDecision.updateMany({ where: { id: row.id, status: 'FAILED' }, data: { status: 'PREPARED', error: null, error_category: null } });
  if (r.count === 1) await transition(row.id, 'FAILED', 'PREPARED', { actor: 'USER', actorId: userId, note: `retry #${tries + 1}`, campaignId: row.campaign_id });
  return { ok: r.count === 1, attempt: tries + 1 };
}

/** Smart Advisor link: an executed SCALE_UP is attached to the product's open SCALE recommendation so Advisor measures its real result. */
async function linkAdvisorAfterExecution({ row, cand }) {
  if (row.action !== 'SCALE_UP' || !row.product_id || !row.store_id) return;
  const rec = await prisma.ambAdvisorRecommendation.findFirst({ where: { product_id: row.product_id, store_id: row.store_id, rec_type: 'SCALE', status: { in: ['RECOMMENDED', 'PREPARED'] } }, orderBy: { created_at: 'desc' } });
  if (!rec) return;
  const T = await import('./advisorTracking.js');
  if (rec.status === 'RECOMMENDED') { const s = await T.startManualExecution({ recommendationId: rec.recommendation_id, storeId: row.store_id }); if (!s.ok) return; }
  await T.confirmManualExecution({ recommendationId: rec.recommendation_id, storeId: row.store_id, note: `AI Operator decision #${row.id}` });
  await prisma.ambOperatorDecision.update({ where: { id: row.id }, data: { advisor_rec_id: rec.recommendation_id } });
}

/**
 * Prepares the exact inverse of an executed decision from the state captured BEFORE the write. Never executes by itself: it is a new
 * PREPARED decision (autopilot rollback exists only when explicitly enabled in limits.allowAutoRollback).
 */
export async function prepareRollback({ decisionId, reason = 'MANUAL', now = new Date() }) {
  const row = await prisma.ambOperatorDecision.findUnique({ where: { id: Number(decisionId) } });
  if (!row) { const e = new Error('القرار غير موجود.'); e.status = 404; throw e; }
  if (!['EXECUTED', 'VERIFIED'].includes(row.status) || !row.rollback_json) { const e = new Error('مفيش حالة سابقة محفوظة قابلة للرجوع.'); e.status = 409; throw e; }
  const prev = j(row.rollback_json, {}).previous || {};
  const inverse = INVERSE[row.action];
  if (!inverse) { const e = new Error('الأكشن ده مفيش له رجوع تلقائي.'); e.status = 409; throw e; }
  const key = `rollback:${row.id}`;
  const existing = await prisma.ambOperatorDecision.findUnique({ where: { decision_key: key } });
  if (existing) return existing;
  const params = prev.budget != null ? { fromBudget: j(row.after_json, {})?.budget ?? null, toBudget: prev.budget, pct: j(row.after_json, {})?.budget ? Math.round(Math.abs(prev.budget - j(row.after_json, {}).budget) / j(row.after_json, {}).budget * 1000) / 10 : null, window: 'today' } : { window: 'today' };
  const created = await prisma.ambOperatorDecision.create({ data: {
    decision_key: key, store_id: row.store_id, product_id: row.product_id, amb_product_id: row.amb_product_id, ad_account_id: row.ad_account_id, campaign_id: row.campaign_id, campaign_name: row.campaign_name,
    action: inverse, rule_id: null, rule_name: `Rollback of #${row.id}`, mode_at_decision: 'APPROVAL', status: 'PREPARED', confidence: 'HIGH',
    why_json: JSON.stringify({ what: `${ACTION_LABEL_AR[inverse]} (رجوع للحالة السابقة)`, why: `رجوع عن القرار #${row.id} (${reason}).`, basedOn: [], blocking: [], risks: [], afterExecution: 'الحملة هترجع لحالتها قبل القرار.' }),
    params_json: JSON.stringify({ ...params, rollbackOf: row.id }), evidence_json: JSON.stringify({ rollbackOf: row.id, previous: prev }),
  } });
  await transition(created.id, 'CANDIDATE', 'PREPARED', { actor: 'SYSTEM', note: `rollback of #${row.id}: ${reason}`, campaignId: row.campaign_id });
  return created;
}

/**
 * Scheduler step (spec 98/99): after a sufficient sample, compare the campaign's CPA BEFORE vs AFTER an executed action and record an honest verdict.
 * SCALE_UP keeps its rollback logic (CPA worsened by >= worsePct => HARMFUL => a rollback is PREPARED, never executed). Other actions get an
 * IMPROVED / NO_CLEAR_CHANGE / WORSENED verdict. Causal honesty (Smart Advisor rule): if ANOTHER action touched the campaign in the window, the
 * verdict is CONFOUNDED — we say so instead of crediting/blaming this action. A PAUSE is never judged by CPA (it stops spend by design).
 */
export async function detectPostScaleDeterioration({ now = new Date(), deps = {} } = {}) {
  const config = await getOperatorConfig();
  const cfg = config.limits.postScale;
  const since = new Date(now.getTime() - 72 * MS_H), minAge = new Date(now.getTime() - cfg.checkAfterHours * MS_H);
  const rows = await prisma.ambOperatorDecision.findMany({ where: { action: { in: ['SCALE_UP', 'SCALE_DOWN', 'OPEN'] }, status: { in: ['EXECUTED', 'VERIFIED'] }, executed_at: { gte: since, lte: minAge }, outcome_json: null } });
  const prepared = []; let evaluated = 0;
  for (const r of rows) {
    const ev = j(r.evidence_json, {});
    const before = ev.metrics || {};
    const from = r.executed_at.toISOString().slice(0, 10), to = now.toISOString().slice(0, 10);
    const { entityWindowMetrics } = await import('./metricsEngine.js');
    const map = deps.metricsMap || await entityWindowMetrics({ level: 'campaign', from, to, adAccountId: r.ad_account_id });
    const post = map.get(r.campaign_id);
    if (!post || (post.purchases ?? 0) < cfg.minPurchases || before.cpa == null || post.cpa == null) continue;
    const confounders = await prisma.ambOperatorDecision.count({ where: { campaign_id: r.campaign_id, id: { not: r.id }, status: { in: ['EXECUTED', 'VERIFIED'] }, executed_at: { gte: r.executed_at, lte: now } } })
      + await prisma.ambAction.count({ where: { entity_id: r.campaign_id, execution_status: 'EXECUTED', executed_at: { gt: new Date(r.executed_at.getTime() + 60_000), lte: now }, recommendation: { batch_id: { not: `operator-${r.id}` } } } });
    const worse = ((post.cpa - before.cpa) / before.cpa) * 100;
    let verdict = confounders > 0 ? 'CONFOUNDED' : worse >= cfg.worsePct ? (r.action === 'SCALE_UP' ? 'HARMFUL' : 'WORSENED') : worse <= -cfg.worsePct ? 'IMPROVED' : 'NO_CLEAR_CHANGE';
    await prisma.ambOperatorDecision.update({ where: { id: r.id }, data: { outcome_json: JSON.stringify({ verdict, cpaBefore: before.cpa, cpaAfter: round(post.cpa), changePct: round(worse, 1), purchasesAfter: post.purchases, confounders, note: confounders > 0 ? 'أكشنز تانية اتعملت على نفس الحملة في الفترة — مينفعش ننسب الأثر لهذا القرار وحده.' : null, evaluatedAt: now.toISOString() }) } });
    evaluated++;
    await transition(r.id, 'VERIFIED', 'EVALUATED', { actor: 'SYSTEM', note: verdict, campaignId: r.campaign_id });
    if (verdict === 'HARMFUL') {
      const rb = await prepareRollback({ decisionId: r.id, reason: `CPA ساء ${round(worse, 1)}% بعد التوسع`, now });
      prepared.push(rb.id);
      await raiseAlert({ severity: 'WARNING', category: 'OPERATOR', title: `AI Operator: التوسع ضرّ — ${r.campaign_name || r.campaign_id}`, message: `CPA زاد ${round(worse, 1)}% بعد التوسع. اتجهز رجوع للميزانية السابقة (محتاج موافقتك).`, adAccountId: r.ad_account_id, entityId: r.campaign_id, dedupeKey: `operator:harmful:${r.id}` }).catch(() => {});
    }
  }
  return { checked: rows.length, evaluated, rollbacksPrepared: prepared };
}

/**
 * Scheduler step (spec 86): if the owner changed a campaign by hand after an AI action, record MANUAL_OVERRIDE (which puts the campaign into a
 * configurable cooldown). Never undoes anything. Compares the latest synced snapshot with the state the LAST executed decision left behind,
 * and only when no other AMB write happened after it (those are AI actions, not the owner).
 */
export async function detectManualOverrides({ now = new Date(), deps = {} } = {}) {
  const since = new Date(now.getTime() - 14 * 86_400_000);
  const rows = await prisma.ambOperatorDecision.findMany({ where: { status: { in: ['EXECUTED', 'VERIFIED'] }, executed_at: { gte: since, lte: new Date(now.getTime() - 30 * 60_000) } }, orderBy: { executed_at: 'desc' }, select: { id: true, campaign_id: true, action: true, executed_at: true, after_json: true, ad_account_id: true } });
  const latest = new Map(); for (const r of rows) if (!latest.has(r.campaign_id)) latest.set(r.campaign_id, r);
  const found = [];
  for (const r of latest.values()) {
    const after = j(r.after_json, null); if (!after) continue;
    const snap = deps.latestSnapshot ? deps.latestSnapshot(r.campaign_id) : await prisma.metaPerformanceSnapshot.findFirst({ where: { level: 'campaign', campaign_id: r.campaign_id, snapshot_at: { gt: new Date(r.executed_at.getTime() + 30 * 60_000) } }, orderBy: { snapshot_at: 'desc' }, select: { campaign_status: true, campaign_budget: true, snapshot_at: true } });
    if (!snap) continue;
    const laterAmb = await prisma.ambAction.count({ where: { entity_id: r.campaign_id, execution_status: 'EXECUTED', executed_at: { gt: r.executed_at } } });
    if (laterAmb > 0) continue;
    const mismatch = (after.status && snap.campaign_status && snap.campaign_status !== after.status) || (after.budget != null && snap.campaign_budget != null && after.budget > 0 && Math.abs(snap.campaign_budget - after.budget) / after.budget > 0.02);
    if (!mismatch) continue;
    const exists = await prisma.ambOperatorEvent.count({ where: { kind: 'MANUAL_OVERRIDE', campaign_id: r.campaign_id, created_at: { gte: r.executed_at } } });
    if (exists) continue;
    await recordEvent({ decision_id: r.id, kind: 'MANUAL_OVERRIDE', actor: 'USER', note: 'تغيير يدوي بعد أكشن AI', data_json: JSON.stringify({ expected: after, seen: { status: snap.campaign_status, budget: snap.campaign_budget }, at: snap.snapshot_at }), campaign_id: r.campaign_id });
    found.push(r.campaign_id);
  }
  return { checked: latest.size, overrides: found };
}
