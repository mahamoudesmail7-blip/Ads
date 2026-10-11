// 📋 ACTIVATION SHEET — everything the owner needs on ONE screen to decide a product's AUTOMATIC activation. READ-ONLY: it saves nothing, activates nothing, writes nothing to Meta.
//   · CONFIRMED values = what is already saved (economics, stock, target / max / hard-stop CPA) with their source. Nothing is invented and nothing is inferred.
//   · MAPPING PROPOSAL = how the saved Target / Maximum / Hard-Stop CPAs could map onto the policy's Scale / Reduce / Hard-Stop thresholds. It is a PROPOSAL: it never fills a policy field by itself.
//   · CAMPAIGNS = the product's mapped campaigns with 3 / 7 / 30-day orders + CPA, sorted by 7-day orders then CPA; the open candidates carry their LIVE budget (Meta read) and every guard.
//   · MISSING = the exact decisions only the owner can make (a missing value is a missing value — it is never defaulted).
import { prisma } from '../../prisma.js';
import { getOperatorConfig } from './operatorStore.js';

const round = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x)));
const cpaOf = (w) => (w && Number(w.purchases) > 0 ? Math.round(Number(w.spend || 0) / Number(w.purchases)) : null);
const winOf = (w) => ({ spend: round(w?.spend) ?? 0, orders: Number(w?.purchases) || 0, cpa: cpaOf(w) });

/** Pure. How the saved CPAs MAY map onto the policy thresholds — shown as a proposal, never applied. */
export function proposeCpaMapping({ targetCpa = null, maxCpa = null, hardStopCpa = null } = {}) {
  const rows = [
    { field: 'scale', label: 'حد الـScale (CPA ≤ يسمح بالزيادة)', source: 'targetCpa', sourceLabel: 'Target CPA', value: targetCpa, reason: 'الـTarget هو الـCPA المستهدف؛ تحته الحملة أحسن من المطلوب فتستحق زيادة.' },
    { field: 'reduce', label: 'حد الـReduce (CPA ≥ يقلّل الميزانية)', source: 'maxCpa', sourceLabel: 'Maximum CPA', value: maxCpa, reason: 'الـMaximum هو أقصى CPA مقبول؛ فوقه الحملة بتخسر عن الحد فتستحق تقليل.' },
    { field: 'hardStop', label: 'Hard Stop CPA (يوقف)', source: 'hardStopCpa', sourceLabel: 'Hard Stop CPA', value: hardStopCpa, reason: 'محفوظ بالفعل كـHard Stop — بيتنقل زي ما هو.' },
  ];
  const problems = [];
  if (targetCpa != null && maxCpa != null && targetCpa >= maxCpa) problems.push('Target لازم يكون أقل من Maximum.');
  if (maxCpa != null && hardStopCpa != null && maxCpa >= hardStopCpa) problems.push('Maximum لازم يكون أقل من Hard Stop.');
  return { status: 'PROPOSAL_REQUIRES_APPROVAL', applied: false, rows: rows.map((r) => ({ ...r, proposed: r.value != null, approved: false })), problems, note: 'ده اقتراح فقط. مفيش حقل بيتملّى لوحده — أنت اللي بتعتمد كل سطر أو بتكتب رقم تاني.' };
}

/** Pure. The exact list of values still missing for AUTOMATIC, with where each one is saved. `eff` = merged effective policy, `econ` = the product's economics, `pause`/`open`/`account` the global policies. */
export function missingDecisions({ eff, econ, stock, pause, open, account, mappedCampaigns = 0 }) {
  const b = eff?.budget || {}, c = eff?.cpa || {}, s = eff?.schedule || {}, z = eff?.zeroOrder || {};
  const M = []; const need = (scope, key, label, current, where, ok) => M.push({ scope, key, label, current: current ?? null, missing: !ok, where });
  need('PRODUCT', 'mode', 'وضع المنتج = AUTOMATIC (التفعيل نفسه خطوة منفصلة بعد اعتمادك)', eff?.mode || null, 'قواعد المنتج', eff?.mode === 'AUTOMATIC');
  need('PRODUCT', 'cpa.scale', 'CPA الزيادة (Scale)', c.scale, 'قواعد المنتج', c.scale != null);
  need('PRODUCT', 'cpa.reduce', 'CPA التقليل (Reduce)', c.reduce, 'قواعد المنتج', c.reduce != null);
  need('PRODUCT', 'cpa.hardStop', 'Hard Stop CPA', c.hardStop, 'قواعد المنتج', c.hardStop != null);
  need('PRODUCT', 'zeroOrder.spend', 'حد الصرف بدون أوردرات', z.spend, 'قواعد المنتج', z.spend != null);
  need('PRODUCT', 'zeroOrder.minAgeHours', 'أقل عمر للحملة قبل الإيقاف (ساعات)', z.minAgeHours, 'قواعد المنتج', z.minAgeHours != null);
  need('PRODUCT', 'budget.increasePct', 'نسبة الزيادة %', b.increasePct, 'قواعد المنتج', b.increasePct != null);
  need('PRODUCT', 'budget.decreasePct', 'نسبة التقليل %', b.decreasePct, 'قواعد المنتج', b.decreasePct != null);
  need('PRODUCT', 'budget.minPurchases', 'أقل عدد أوردرات للقرار', b.minPurchases, 'قواعد المنتج', b.minPurchases != null);
  need('PRODUCT', 'budget.cooldownHours', 'Cooldown بين تعديلين (ساعات)', b.cooldownHours, 'قواعد المنتج', b.cooldownHours != null);
  need('PRODUCT', 'budget.minBudget', 'أقل ميزانية للحملة', b.minBudget, 'قواعد المنتج', b.minBudget != null);
  need('PRODUCT', 'budget.maxBudget', 'أقصى ميزانية للحملة', b.maxBudget, 'قواعد المنتج', b.maxBudget != null);
  need('PRODUCT', 'budget.dailySpendCap', 'سقف التعرض اليومي للمنتج', b.dailySpendCap, 'قواعد المنتج', b.dailySpendCap != null);
  need('PRODUCT', 'schedule.openTime', 'وقت الفتح', s.openTime, 'قواعد المنتج', !!s.openTime);
  need('PRODUCT', 'schedule.closeTime', 'وقت الإيقاف', s.closeTime, 'قواعد المنتج', !!s.closeTime);
  need('PRODUCT', 'schedule.days', 'أيام التشغيل', s.days, 'قواعد المنتج', Array.isArray(s.days) && s.days.length > 0);
  need('PRODUCT', 'manualOverrideHours', 'حماية التعديل اليدوي (ساعات)', eff?.manualOverrideHours, 'قواعد المنتج', eff?.manualOverrideHours != null);
  need('PRODUCT', 'stock.minimum', 'الحد الأدنى للمخزون', stock?.minimum, 'التسعير / المخزون', stock?.minimum != null);
  need('PRODUCT', 'economics', 'الاقتصاديات (سعر + تكلفة + شحن)', econ?.complete ? 'مكتملة' : null, 'التسعير الذكي', !!econ?.complete);
  need('PRODUCT', 'mapping', 'حملات مربوطة بالمنتج', mappedCampaigns, 'ربط الحملات', mappedCampaigns >= 1);
  need('ACCOUNT', 'account.maxDailySpendUnderAi', 'سقف الصرف اليومي للحساب تحت الـAI', account?.maxDailySpendUnderAi, 'حدود الحساب', account?.maxDailySpendUnderAi != null);
  need('ACCOUNT', 'account.maxEnablesPerDay', 'أقصى عدد فتح في اليوم (الحساب)', account?.maxEnablesPerDay, 'حدود الحساب', account?.maxEnablesPerDay != null);
  need('ACCOUNT', 'account.maxPausesPerDay', 'أقصى عدد إيقاف في اليوم (الحساب)', account?.maxPausesPerDay, 'حدود الحساب', account?.maxPausesPerDay != null);
  need('ACCOUNT', 'account.maxBudgetIncreasePerDay', 'أقصى زيادة ميزانية في اليوم (الحساب)', account?.maxBudgetIncreasePerDay, 'حدود الحساب', account?.maxBudgetIncreasePerDay != null);
  need('GLOBAL', 'pause.approved', 'سياسة الإيقاف مفعّلة ومعتمدة', pause?.enabled ? `v${pause.version}` : null, 'الأتمتة ← سياسة الإيقاف', !!(pause?.enabled && pause.approved?.version === pause.version));
  need('GLOBAL', 'open.maxTotalExposure', 'سقف التعرض الإجمالي للفتح (كل المنتجات)', open?.maxTotalExposure, 'سياسة الفتح', open?.maxTotalExposure != null);
  need('GLOBAL', 'open.minStock', 'الحد الأدنى للمخزون المطلوب للفتح (سياسة الفتح)', open?.minStock, 'سياسة الفتح', open?.minStock != null);
  return M;
}

/**
 * The sheet. deps (tests): profile, policy, world, identity, openCandidates, structureOf, config, pause, open.
 * The only network read is `structureOf` (Meta GET) for at most `liveLimit` open candidates, so the budget shown is the LIVE one.
 */
export async function activationSheet({ productId, storeId = null, now = new Date(), liveLimit = 3, deps = {} }) {
  const RD = await import('./operatorReadiness.js'); const PP = await import('./productPolicy.js');
  const profile = deps.profile || await RD.getProductProfile({ productId: Number(productId) });
  const sid = storeId || profile.store || 'default';
  const pol = deps.policy || await PP.getProductPolicy({ productId: Number(productId), storeId: sid });
  const polSrc = pol.active || pol.draft || null; const eff = polSrc ? PP.mergeEffective(polSrc) : null;
  const config = deps.config || await getOperatorConfig();
  const ec = profile.economics || {};
  const confirmed = {
    sellingPrice: ec.sellingPrice, purchaseCost: ec.purchaseCost, shipping: ec.shipping, packaging: ec.packaging, other: ec.other, unitMargin: ec.unitMargin ?? null,
    stock: { current: profile.stock?.current ?? null, minimum: profile.stock?.minimum ?? null, source: profile.stock?.source ?? null, known: !!profile.stock?.known },
    targetCpa: ec.targetCpa, maxCpa: ec.maxCpa, hardStopCpa: ec.hardStopCpa, economicsComplete: !!ec.complete,
  };
  const mapping = proposeCpaMapping({ targetCpa: ec.targetCpa?.value ?? null, maxCpa: ec.maxCpa?.value ?? null, hardStopCpa: ec.hardStopCpa?.value ?? null });

  // campaigns of the product (verified mapping only) with 3 / 7 / 30-day performance
  const CTX = await import('./operatorContext.js'); const INT = await import('./integration.js');
  const world = deps.world || await CTX.buildOperatorWorld({ windowKeys: ['today', 'last3', 'last7', 'last30'], now });
  const campaigns = [];
  for (const c of world.campaigns) {
    const idn = deps.identity ? await deps.identity(c.id) : await INT.campaignIdentity(c.id).catch(() => null);
    if (!idn || Number(idn.productId) !== Number(productId) || !idn.verified) continue;
    const w = (k) => world.windows[k]?.get(c.id);
    campaigns.push({ id: c.id, name: c.name, status: c.status, budget: c.budget ?? null, d3: winOf(w('last3')), d7: winOf(w('last7')), d30: winOf(w('last30')) });
  }
  const byOrdersThenCpa = (k) => (a, b) => (b[k].orders - a[k].orders) || ((a[k].cpa ?? 1e9) - (b[k].cpa ?? 1e9));
  campaigns.sort(byOrdersThenCpa('d7'));
  const sum = (k) => campaigns.reduce((t, c) => ({ spend: t.spend + c[k].spend, orders: t.orders + c[k].orders }), { spend: 0, orders: 0 });
  const totals = Object.fromEntries(['d3', 'd7', 'd30'].map((k) => { const s = sum(k); return [k, { ...s, cpa: s.orders ? Math.round(s.spend / s.orders) : null }]; }));

  // open candidates: eligibility + guards from the same builder the daily plan uses; the top ones get their LIVE structure
  let open = [];
  try {
    const DC = await import('./dailyPlanCandidates.js'); const oc = deps.openCandidates || await DC.buildOpenCandidates({ now, deps: { world } });
    const ids = new Set(campaigns.map((c) => c.id)); open = oc.items.filter((i) => ids.has(i.campaignId)).slice(0, 12).map((i) => ({ campaignId: i.campaignId, name: i.campaignName, eligibility: i.eligibility, blocks: i.blockCodes || [], warnings: (i.warnings || []).filter((w) => { const code = w?.code || w; return !((code === 'STOCK_UNKNOWN' && confirmed.stock.known) || (code === 'ECONOMICS_INCOMPLETE' && confirmed.economicsComplete)); }), selected: !!i.selected, risk: i.risk, reason: i.reason, snapshotBudget: i.evidence?.budget ?? null, live: null }));
  } catch { open = []; }
  const structureOf = deps.structureOf || (async (campaignId) => { const MO = await import('./manualOperations.js'); const adm = await prisma.user.findFirst({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { id: true, role: true, status: true } }); return MO.manualStructure({ campaignId, userId: adm?.id, deps: { user: adm } }); });
  for (const o of open.filter((x) => x.selected || x.eligibility === 'ELIGIBLE').slice(0, liveLimit)) {
    try { const st = await structureOf(o.campaignId); o.live = { level: st.level, status: st.campaignStatus ?? st.campaign?.status ?? null, campaignBudget: st.totals?.campaignBudget ?? null, adsets: (st.entities || []).filter((e) => e.level === 'adset').map((e) => ({ id: e.id, name: e.name, status: e.status, budget: e.budget })), readAt: now.toISOString() }; }
    catch (e) { o.live = { error: String(e.message || e).slice(0, 140) }; }
  }
  const exposure = { openCandidatesWithBudget: open.filter((o) => o.eligibility === 'ELIGIBLE').reduce((t, o) => t + (o.live?.campaignBudget ?? o.live?.adsets?.filter((a) => a.status === 'ACTIVE').reduce((s, a) => s + (a.budget || 0), 0) ?? o.snapshotBudget ?? 0), 0), productDailyCap: eff?.budget?.dailySpendCap ?? null, accountCap: config.limits?.account?.maxDailySpendUnderAi ?? null, openPolicyCap: null };
  const PAU = await import('./pausePolicy.js'); const OPN = await import('./openCpaPolicy.js');
  const pause = deps.pause || await PAU.getPausePolicy(); const openPol = deps.open !== undefined ? deps.open : await OPN.getOpenCpaPolicy().catch(() => null); exposure.openPolicyCap = openPol?.maxTotalExposure ?? null;
  const missing = missingDecisions({ eff, econ: ec, stock: profile.stock, pause, open: openPol, account: config.limits?.account || {}, mappedCampaigns: campaigns.length });
  return {
    product: { id: Number(productId), name: profile.product?.name || null, storeId: sid }, at: now.toISOString(),
    global: { writesLocked: config.writesLocked !== false, mode: config.mode, emergencyStop: !!config.emergency_stop, permissions: config.execPermissions || {}, allPermissionsOff: !Object.values(config.execPermissions || {}).some(Boolean), pausePolicy: { enabled: !!pause.enabled, version: pause.version, approvedVersion: pause.approved?.version ?? null }, openPolicy: openPol && { enabled: !!openPol.enabled, version: openPol.version, approvedVersion: openPol.approved?.version ?? null, minCpa: openPol.minCpa, maxCpa: openPol.maxCpa, window: openPol.window, minPurchases: openPol.minPurchases, protectManualPauseHours: openPol.protectManualPause?.hours ?? null }, account: config.limits?.account || {}, cooldownDefaults: { manualOverrideCooldownHours: config.limits?.manualOverrideCooldownHours ?? null } },
    confirmed, mapping, policy: { status: pol.status, version: pol.version, mode: polSrc?.mode || null, effective: eff, draftValuesFromConfirmedOnly: { cpa: { hardStop: ec.hardStopCpa?.value ?? null } } },
    campaigns: { count: campaigns.length, active: campaigns.filter((c) => c.status === 'ACTIVE').length, totals, rows: campaigns.slice(0, 25), byCpa7: [...campaigns].filter((c) => c.d7.orders > 0).sort((a, b) => (a.d7.cpa ?? 1e9) - (b.d7.cpa ?? 1e9)).slice(0, 10).map((c) => c.id) },
    openCandidates: open, exposure, missing, missingCount: missing.filter((m) => m.missing).length,
    verdict: missing.some((m) => m.missing) ? 'NEEDS_CONFIGURATION' : 'COMPLETE_PENDING_OWNER_ACTIVATION',
  };
}
