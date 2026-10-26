// 🔎 PRODUCT ACTIVATION PREVIEW — «لو فعّلت المنتج ده AUTOMATIC دلوقتي إيه اللي ممكن يحصل؟». READ-ONLY: never writes, never calls Meta (snapshots + the saved policies only).
//   · which of its ACTIVE campaigns the (auto-enrolled) pause policy would stop RIGHT AFTER activation, and which are protected (Winner / recent improvement / thin sample)
//   · which of its PAUSED campaigns the open policy could open (CPA range, sample, caps) and the daily budget they would add
//   · the money picture: running budget now, what opening + increasing could add, and the headroom under each cap (open exposure · account cap · AI cap · product daily cap)
//   · campaigns whose product mapping is NOT confirmed — listed and EXCLUDED (the engine never acts on them)
// The verdicts use the SAME pure functions as the engine (decidePause / evaluateCampaign). The live guards, cooldowns and a live Meta read still re-check everything at execution time.
import { buildOperatorWorld, loadRecentActions } from './operatorContext.js';
import { listProductRules, getProductPolicy, getGlobalRules, mergeEffective, overlayGlobal } from './productPolicy.js';
import { getPausePolicy, pausePolicyActive, decidePause, TRIGGER_AR } from './pausePolicy.js';
import { getOpenCpaPolicy, evaluateCampaign, loadWindowMetrics, applyCapToEvals } from './openCpaPolicy.js';
import { isWinner } from './dailyPlanCandidates.js';
import { activeExposure } from './automationScope.js';
import { mappingCenter } from './operatorReadiness.js';
import { getOperatorConfig } from './operatorStore.js';
import { getBudgetCaps } from './budgetCaps.js';
import { loadBudgetStructureFromSnapshots, discoverBudgetEntities, getBudgetPolicy } from './budgetOptimizer.js';
import { dayStartUtc, hoursSince, OBSERVATION_DEFAULT } from './dayEvaluation.js';

const round0 = (v) => Math.round(Number(v) || 0);
const slim = (m) => (m ? { spend: round0(m.spend ?? 0), purchases: m.purchases ?? 0, cpa: m.cpa == null ? null : round0(m.cpa) } : { spend: 0, purchases: 0, cpa: null });

export async function productActivationPreview({ productId, storeId = null, now = new Date(), deps = {} }) {
  const world = deps.world || await buildOperatorWorld({ windowKeys: ['today', 'last3', 'last7', 'last30'], now });
  const rules = deps.rules || await listProductRules({ now }); const rule = rules.find((r) => Number(r.productId) === Number(productId) && (!storeId || r.storeId === storeId));
  if (!rule) return { ok: false, productId: Number(productId), error: 'PRODUCT_NOT_FOUND', note: 'المنتج مش ظاهر في قواعد المنتجات (مفيش حملات مربوطة بيه).' };
  const sid = rule.storeId; const pp = deps.productPolicy || await getProductPolicy({ productId, storeId: sid }); const gl = deps.globalRules || await getGlobalRules().catch(() => ({ active: null }));
  const pol = pp.active ? pp.effective : pp.draft ? overlayGlobal(gl.active, pp.draft) : null;
  if (!pol) return { ok: true, productId: Number(productId), storeId: sid, name: rule.name, needsPolicy: true, note: 'مفيش سياسة (مسودة أو معتمدة) للمنتج — حدّد حدود الـCPA واحفظ مسودة الأول.' };
  const eff = mergeEffective(pol); const hardStop = eff.cpa.hardStop ?? null;
  const pause = deps.pause || await getPausePolicy(); const open = deps.open !== undefined ? deps.open : await getOpenCpaPolicy().catch(() => null);
  const config = deps.config || await getOperatorConfig(); const caps = deps.caps || await getBudgetCaps().catch(() => ({}));
  const campaigns = rule.campaigns || []; const active = campaigns.filter((c) => c.status === 'ACTIVE'); const paused = campaigns.filter((c) => c.status !== 'ACTIVE');
  const weekday = new Date(`${new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10)}T12:00:00Z`).getUTCDay();

  // ---- 1. mapping: only CONFIRMED campaigns are acted on; the rest is listed and excluded
  let mapRows = deps.mapRows; if (!mapRows) mapRows = world.adAccountId ? (await mappingCenter({ adAccountId: world.adAccountId, limit: 5000 }).catch(() => ({ rows: [] }))).rows : [];
  const excludedMap = mapRows.filter((r) => Number(r.product?.productId) === Number(productId) && r.state !== 'VERIFIED' && ['ACTIVE', 'PAUSED'].includes(r.campaignStatus)).map((r) => ({ campaignId: r.campaignId, name: r.campaignName, state: r.state, status: r.campaignStatus, spend7d: round0(r.spend7d) }));

  // ---- 2. pause: what the policy (auto-enrolled for an AUTOMATIC product) would stop right after activation
  const win = (k, id) => slim(world.windows?.[k]?.get(id));
  const pauseActive = pausePolicyActive(pause); const pauseRows = [];
  // DAY-BASED (owner decision 2026-10-26): the preview judges each campaign on TODAY (Cairo 00:00), exactly like the engine; 3-day numbers are shown for analysis only
  const bp = deps.budgetPolicy || await getBudgetPolicy().catch(() => null); const obsMinHours = { ...OBSERVATION_DEFAULT, ...(bp?.observation || {}) }.minHours; const dayHours = deps.dayHours ?? hoursSince(dayStartUtc(now), now); const lastActive = active.length <= 1;
  for (const c of active) {
    const m3 = win('last3', c.id), m7 = win('last7', c.id), m30 = win('last30', c.id), mToday = win('today', c.id);
    const dp = decidePause({ policy: pause, campaignId: c.id, productId, storeId: sid, optimizer: null, m3, mToday, productHighCpa: hardStop, stock: null, winner: isWinner({ m7, m30 }), weekday, automatic: true, mDay: mToday, dayHours, obsMinHours, lastActive });
    pauseRows.push({ campaignId: c.id, name: (c.name || '').trim(), m3, today: mToday, dayHours: Math.round(dayHours * 10) / 10, lastActive, trigger: dp.trigger, triggerAr: dp.trigger ? TRIGGER_AR[dp.trigger] : null, skipped: dp.skipped.map((s) => s.code), blockers: dp.blockers, fired: dp.fired, threshold: dp.threshold });
  }
  const pauseEligible = pauseRows.filter((r) => r.trigger && !r.blockers.length);
  const pauseProtected = pauseRows.filter((r) => !r.trigger && r.skipped.length);

  // ---- 3. open: paused + confirmed campaigns the open policy could open, in rank order, under the exposure cap
  let openOut = { policyActive: false, candidates: [], refused: [], addsBudget: 0, perDayLimit: config.limits?.account?.maxEnablesPerDay ?? null };
  const structure = deps.structure || await loadBudgetStructureFromSnapshots({ adAccountId: world.adAccountId, now }).catch(() => new Map());
  const budgetOf = deps.budgetOf || ((id) => { const s = structure.get(id); if (!s) return null; const b = (discoverBudgetEntities(s).entities || []).reduce((t, e) => t + (Number(e.budget) || 0), 0); return b > 0 ? b : null; });
  const exposure = deps.exposure || await activeExposure({ adAccountId: world.adAccountId, now, deps: { structure } }).catch(() => ({ total: null }));
  const openPolicyActive = !!(open?.enabled && open.approved?.version === open.version);
  if (open && paused.length) {
    const metrics = deps.openMetrics || await loadWindowMetrics({ policy: open, now, adAccountId: world.adAccountId }).catch(() => new Map());
    const recent = deps.recent || await loadRecentActions({ campaignIds: paused.map((c) => c.id), now }).catch(() => new Map());
    const items = paused.map((c) => { const rc = (recent.get ? recent.get(c.id) : recent[c.id]) || {}; const manualAt = rc.manualOverrideAt || null; const sysPerf = rc.pausedBySystemAt ? { kind: 'PERFORMANCE', at: rc.pausedBySystemAt } : null;
      return { campaignId: c.id, name: (c.name || '').trim(), productId: Number(productId), storeId: sid, eligibility: 'ELIGIBLE', selectable: true, blockCodes: [], rankScore: 0, evidence: { budget: budgetOf(c.id), productId: Number(productId), storeId: sid, pausedBy: manualAt ? 'MANUAL' : null, pausedAt: manualAt, systemPause: sysPerf, m7: win('last7', c.id) } }; });
    const rows = items.map((it) => { const m = metrics.get(it.campaignId); const ev = evaluateCampaign({ policy: open, item: it, metrics: m ? { spend: m.spend, purchases: m.purchases } : null, dataAgeMin: 0, weekday, now }); return { it, eval: ev }; });
    rows.sort((a, b) => (b.eval.eligible - a.eval.eligible) || ((a.eval.cpa ?? 1e9) - (b.eval.cpa ?? 1e9)));
    applyCapToEvals(rows, { policy: open, baseExposure: exposure.total || 0, budgetOf: (r) => r.it.evidence.budget, keyOf: (r) => r.it.campaignId });
    const cand = rows.filter((r) => r.eval.eligible).map((r) => ({ campaignId: r.it.campaignId, name: r.it.name, cpa: r.eval.cpa, purchases: r.eval.purchases, budget: r.it.evidence.budget }));
    openOut = { policyActive: openPolicyActive, candidates: cand, refused: rows.filter((r) => !r.eval.eligible && r.eval.matched).map((r) => ({ campaignId: r.it.campaignId, name: r.it.name, cpa: r.eval.cpa, reasons: r.eval.reasons })), notInRange: rows.filter((r) => !r.eval.matched).length, addsBudget: round0(cand.reduce((t, x) => t + (x.budget || 0), 0)), perDayLimit: config.limits?.account?.maxEnablesPerDay ?? null };
  } else openOut.policyActive = openPolicyActive;

  // ---- 4. money picture
  const productActive = round0(active.reduce((t, c) => t + (budgetOf(c.id) || 0), 0)); const incDay = config.limits?.account?.maxBudgetIncreasePerDay ?? null;
  const openCap = open?.maxTotalExposure ?? null; const accountNow = exposure.total == null ? null : round0(exposure.total); const aiCap = config.limits?.account?.maxDailySpendUnderAi ?? null; const productCap = eff.budget.dailySpendCap ?? null;
  const worstDay = productActive + openOut.addsBudget + (incDay ?? 0);
  const money = { productActiveBudget: productActive, accountActiveBudget: accountNow, opensWouldAdd: openOut.addsBudget, maxIncreasePerDay: incDay,
    worstCaseProductDay: productCap != null ? Math.min(worstDay, productCap) : worstDay, productDailyCap: productCap,
    headroom: { openExposure: openCap != null && accountNow != null ? Math.max(0, openCap - accountNow) : null, accountBudgetCap: caps.account != null && accountNow != null ? Math.max(0, caps.account - accountNow) : null, aiCap },
    caps: { openExposure: openCap, accountBudget: caps.account ?? null, ai: aiCap, product: productCap } };

  const notes = [];
  if (!pauseActive) notes.push('سياسة الإيقاف غير معتمدة — مفيش إيقاف تلقائي لأي منتج.');
  if (!openPolicyActive) notes.push('سياسة الفتح غير معتمدة — مفيش فتح تلقائي.');
  if (excludedMap.length) notes.push(`${excludedMap.length} حملة ربطها بالمنتج غير مؤكد — مستبعدة ومش هتتلمس.`);
  if (!hardStop) notes.push('المنتج مالوش Hard Stop CPA — إيقاف CPA العالي مش هيشتغل عليه (إيقاف الصرف بدون أوردرات والمخزون شغالين).');
  return { ok: true, productId: Number(productId), storeId: sid, name: rule.name, policySource: pp.active ? 'ACTIVE' : 'DRAFT', mode: eff.mode, hardStop, mapping: { verified: campaigns.length, excluded: excludedMap },
    pause: { policyActive: pauseActive, autoEnrolled: pause.autoEnrollAutomatic !== false, evaluated: pauseRows.length, eligibleNow: pauseEligible, protected: pauseProtected, rows: pauseRows },
    open: openOut, money, notes, generatedAt: now.toISOString(), readOnly: true };
}
