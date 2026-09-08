// AI Media Buyer — "AI Suggested Decisions" → Winner → Scale.
//
// Detects winning campaigns (>= 1 order AND CPA <= WINNER_CPA_EGP) from the
// SAME authoritative metrics pipeline the rest of the AMB uses (buildHierarchy
// over meta_performance_snapshots — no second analytics pipeline), prepares a
// per-ad winner panel, and — after the owner explicitly approves — executes
// the scale through the EXISTING clone engine (createBatch/approveBatch) with
// a small set of additive knobs: adAllowlist, campaignBudgetOverrideEgp,
// campaignNameOverride, allowSameAccount, executionMode/startAt.
//
// The source campaign / ad sets / ads / creatives are NEVER modified — the
// engine only CREATEs new objects. Nothing runs until Approve Scale.
import { prisma } from '../../prisma.js';
import { getConnection } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { resolveWindow } from './metricsEngine.js';
import { buildHierarchy } from './hierarchyAnalysis.js';
import { creativeLabelIndex } from './creativeAnalysis.js';
import { createBatch, approveBatch, cairoLocalToUtc } from './cloneEngine.js';
import { getDecryptedToken } from '../metaAuth.js';
import { getAdSetNodes } from '../metaGraphClient.js';

// Bid strategies that REQUIRE a bid_amount / cost cap / ROAS target.
const CAP_BID_STRATEGIES = new Set(['LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS', 'TARGET_COST']);

// ONLY this section uses this threshold. No other AMB threshold changes.
export const WINNER_CPA_EGP = 80;
const SCALE_TZ = 'Africa/Cairo';

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function round1(v) { return v == null ? null : Math.round(v * 10) / 10; }

/** Cairo-local "YYYY-MM-DD" for tomorrow (from the Cairo calendar date, not UTC). */
function cairoTomorrowDate() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: SCALE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date()).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function flattenAds(campNode) {
  const ads = [];
  for (const as of campNode.children || []) {
    for (const ad of as.children || []) {
      ads.push({ ...ad, adsetId: as.id, adsetName: as.name });
    }
  }
  return ads;
}

/**
 * Winner cards for the selected ad account + window.
 * @returns {{ window, winnerCpaEgp, count, resolvedCount, cards: [...] }}
 */
export async function listScaleWinners({ windowName = 'today', includeResolved = false } = {}) {
  const conn = await getConnection();
  if (!conn || conn.status !== 'CONNECTED' || !conn.selected_ad_account_id) {
    return { connected: false, cards: [], count: 0, winnerCpaEgp: WINNER_CPA_EGP };
  }
  const adAccountId = conn.selected_ad_account_id;
  const settings = await getAmbSettings();
  const window = resolveWindow(windowName);
  const tree = await buildHierarchy({ adAccountId, window, settings });

  // Every campaign node, carrying its product name when mapped.
  const campEntries = [];
  for (const p of tree.products || []) for (const c of p.children || []) campEntries.push({ camp: c, productName: p.name || null });
  for (const c of tree.unmappedCampaigns || []) campEntries.push({ camp: c, productName: null });

  // Prior decisions for dedup (Reject / Execute is sticky).
  const priorDecisions = await prisma.ambScaleDecision.findMany({
    where: { ad_account_id: adAccountId, source_campaign_id: { in: campEntries.map((e) => e.camp.id) } },
    orderBy: { id: 'desc' },
  });
  const latestByCamp = new Map();
  for (const d of priorDecisions) if (!latestByCamp.has(d.source_campaign_id)) latestByCamp.set(d.source_campaign_id, d);

  // Creative-type labels (best-effort; never invented).
  const allCreativeIds = [...new Set(campEntries.flatMap((e) => flattenAds(e.camp).map((a) => a.creativeId).filter(Boolean)))];
  const labelIdx = await creativeLabelIndex(allCreativeIds).catch(() => new Map());

  const cards = [];
  let resolvedCount = 0;

  for (const { camp, productName } of campEntries) {
    const m = camp.metrics || {};
    const orders = n(m.purchases) || 0;
    const cpa = n(m.cpa);
    if (orders < 1 || cpa == null || cpa > WINNER_CPA_EGP) continue; // <-- the ONLY rule for this section

    const prior = latestByCamp.get(camp.id);
    if (prior && ['REJECTED', 'EXECUTED', 'APPROVED'].includes(prior.status)) {
      resolvedCount++;
      if (!includeResolved) continue;
    }

    const ads = flattenAds(camp).map((a) => {
      const am = a.metrics || {};
      const o = n(am.purchases) || 0;
      const c = n(am.cpa);
      return {
        adId: a.id,
        adName: a.name,
        adsetId: a.adsetId,
        adsetName: a.adsetName || null,
        creativeId: a.creativeId || null,
        creativeType: (a.creativeId && labelIdx.get(a.creativeId)?.creative_type) || null,
        orders: o,
        cpa: round1(c),
        spend: round1(n(am.spend) || 0),
        qualifies: o >= 1 && c != null && c <= WINNER_CPA_EGP,
      };
    });

    // Winner ranking: ORDERS first, then CPA (never CTR/clicks).
    const eligible = ads.filter((a) => a.qualifies)
      .sort((x, y) => (y.orders - x.orders) || ((x.cpa ?? 1e9) - (y.cpa ?? 1e9)));
    const bestWinnerAdId = eligible[0]?.adId || null;
    const winningAdIds = eligible.map((a) => a.adId);
    for (const a of ads) a.bestWinner = a.adId === bestWinnerAdId;

    const winningCreativeCount = new Set(eligible.map((a) => a.creativeId).filter(Boolean)).size || eligible.length;
    const best = eligible[0];
    const recommendation = `الحملة جابت ${orders} ${orders === 1 ? 'أوردر' : 'أوردر'} بمتوسط تكلفة ${Math.round(cpa)} ج.م`
      + (best ? `، وأفضل كرياتيف «${best.adName}» بـ${best.orders} أوردر و CPA ${Math.round(best.cpa)} ج.م` : '')
      + `، و${winningCreativeCount} كرياتيف رابح — مؤهلة للاسكيل.`;

    cards.push({
      adAccountId,
      sourceCampaignId: camp.id,
      sourceCampaignName: camp.name,           // EXACT Meta name
      productName,                              // AmbProduct name when mapped, else null (never invented)
      displayName: productName || camp.name,
      proposedScaleCampaignName: `${camp.name} - Scale`, // exact source name + existing suffix
      sourceBudgetType: camp.budget != null ? 'CBO' : 'ABO', // preselect in the UI; the owner is authoritative
      window: { from: window.from, to: window.to, label: window.label },
      orders,
      cpa: round1(cpa),
      spend: round1(n(m.spend) || 0),
      status: 'RECOMMENDED_FOR_SCALING',
      decisionStatus: prior?.status || 'PENDING',
      decisionId: prior && !['REJECTED', 'EXECUTED', 'APPROVED'].includes(prior.status) ? prior.id : null,
      winningAdCount: eligible.length,
      winningCreativeCount,
      bestWinnerAdId,
      winningAdIds,
      ads,
      recommendation,
      defaults: {
        selectedAdIds: winningAdIds,
        budgetEgp: null,                        // owner must enter
        startMode: 'RUN_NOW',
        startDate: cairoTomorrowDate(),
        startTime: '00:00',
        timezone: SCALE_TZ,
      },
    });
  }

  return {
    connected: true,
    window: { from: window.from, to: window.to, label: window.label },
    winnerCpaEgp: WINNER_CPA_EGP,
    count: cards.filter((c) => c.decisionStatus === 'PENDING').length,
    resolvedCount,
    cards,
  };
}

const JOB_TERMINAL = new Set(['CLONED_PAUSED', 'ACTIVATED', 'FAILED', 'ACTIVATION_FAILED', 'NEEDS_INPUT', 'NEEDS_DECISION', 'CANCELLED', 'PREFLIGHT_BLOCKED', 'CANNOT_COPY']);

/**
 * Wait for the clone worker to finish the batch, then PROVE the whole scale
 * tree was built (spec §6/§10): destination Campaign + one destination Ad Set
 * per required source Ad Set + one destination Ad per selected source Ad, with
 * no FAILED object-map rows. Returns { ok, error, counts, destinationCampaignId }.
 * Never trusts "createBatch/approveBatch didn't throw".
 */
export async function waitAndVerifyScale({
  batchId,
  // exact object-map source_id strings the engine will use:
  //   CBO -> raw source ids;  ABO -> "<sourceId>#<slotIndex>" instance keys
  expectedAdSetSourceIds, expectedAdSourceIds,
  // legacy aliases (CBO callers / repair script)
  requiredAdSetIds, selectedAdIds,
  timeoutMs = 120_000, pollMs = 2500,
}) {
  const wantAdSets = (expectedAdSetSourceIds || requiredAdSetIds || []).map(String);
  const wantAds = (expectedAdSourceIds || selectedAdIds || []).map(String);
  const deadline = Date.now() + timeoutMs;
  let jobs = [];
  while (Date.now() < deadline) {
    jobs = await prisma.ambCloneJob.findMany({ where: { batch_id: batchId } });
    if (jobs.length && jobs.every((j) => JOB_TERMINAL.has(j.status))) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const job = jobs[0];
  if (!job) return { ok: false, error: 'لم يُنشأ أي job للاستنساخ.', counts: { adSetsCreated: 0, adsCreated: 0 } };
  if (!JOB_TERMINAL.has(job.status)) return { ok: false, error: `انتهت المهلة والـ job لسه في حالة ${job.status}.`, counts: { adSetsCreated: 0, adsCreated: 0 } };

  const objs = await prisma.ambCloneObjectMap.findMany({ where: { job_id: job.id } });
  const created = (level) => objs.filter((o) => o.level === level && o.status === 'CREATED' && o.destination_id);
  const failed = objs.filter((o) => o.status === 'FAILED');

  const campRow = created('CAMPAIGN')[0] || null;
  const destAdsetSrcIds = new Set(created('ADSET').map((o) => String(o.source_id)));
  const destAdSrcIds = new Set(created('AD').map((o) => String(o.source_id)));
  const missingAdsets = wantAdSets.filter((id) => !destAdsetSrcIds.has(id));
  const missingAds = wantAds.filter((id) => !destAdSrcIds.has(id));

  const counts = {
    adSetsCreated: created('ADSET').length,
    adsCreated: created('AD').length,
    creativesCreated: created('CREATIVE').length,
  };

  if (!campRow) return { ok: false, error: firstErr(job, failed, 'لم تُنشأ حملة الوجهة.'), counts };
  if (missingAdsets.length || missingAds.length || failed.length || ['FAILED', 'ACTIVATION_FAILED', 'PREFLIGHT_BLOCKED', 'CANNOT_COPY', 'NEEDS_DECISION', 'NEEDS_INPUT'].includes(job.status)) {
    const bits = [];
    if (missingAdsets.length) bits.push(`مجموعات إعلانية ناقصة: ${missingAdsets.length}/${wantAdSets.length}`);
    if (missingAds.length) bits.push(`إعلانات ناقصة: ${missingAds.length}/${wantAds.length}`);
    return { ok: false, error: firstErr(job, failed, bits.join(' · ') || `job status ${job.status}`), counts, destinationCampaignId: campRow.destination_id };
  }
  return { ok: true, counts, destinationCampaignId: campRow.destination_id };
}
function firstErr(job, failed, fallback) {
  return (failed.find((o) => o.error)?.error) || job?.error || fallback;
}

/** Mark a winner campaign's scale suggestion as REJECTED so it is not re-surfaced. */
export async function rejectScaleWinner({ sourceCampaignId, sourceCampaignName, productName, windowLabel, userId }) {
  const conn = await getConnection();
  if (!conn?.selected_ad_account_id) { const e = new Error('اربط حساب Meta Ads الأول.'); e.status = 400; throw e; }
  if (!sourceCampaignId) { const e = new Error('sourceCampaignId مطلوب.'); e.status = 400; throw e; }
  const row = await prisma.ambScaleDecision.create({
    data: {
      ad_account_id: conn.selected_ad_account_id,
      source_campaign_id: String(sourceCampaignId),
      source_campaign_name: sourceCampaignName || null,
      product_name: productName || null,
      window_label: windowLabel || null,
      status: 'REJECTED',
      reviewed_by_id: userId || null,
      reviewed_at: new Date(),
    },
  });
  return { id: row.id, status: row.status };
}

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/**
 * Approve + execute a scale. The owner's explicit budgetMode (CBO | ABO) is
 * authoritative — the system NEVER silently converts. Validates everything
 * against the current source hierarchy, then runs the EXISTING clone engine
 * (same-account) with the appropriate additive knobs, and only marks the
 * decision EXECUTED after waitAndVerifyScale proves the full tree exists.
 *
 * CBO: { budgetMode:'CBO', campaignBudgetEgp, selectedAdIds }
 * ABO: { budgetMode:'ABO', adSets:[{ dailyBudgetEgp, selectedAdIds }] }
 */
export async function executeScale({
  sourceCampaignId, budgetMode, campaignBudgetEgp, selectedAdIds, adSets,
  budgetEgp, // legacy alias for campaignBudgetEgp
  startMode, startAt, windowName = 'today', userId,
}) {
  const conn = await getConnection();
  if (!conn || conn.status !== 'CONNECTED' || !conn.selected_ad_account_id) throw bad('اربط حساب Meta Ads الأول.');
  const adAccountId = conn.selected_ad_account_id;
  const settings = await getAmbSettings();

  if (!sourceCampaignId) throw bad('sourceCampaignId مطلوب.');
  const mode = startMode === 'SCHEDULE' ? 'SCHEDULE' : 'RUN_NOW';
  if (mode === 'SCHEDULE') {
    const [dp, tp] = String(startAt || '').split('T');
    const at = cairoLocalToUtc(dp, tp || '00:00');
    if (!at) throw bad('تاريخ/وقت البداية غير صالح.');
    if (at.getTime() <= Date.now()) throw bad('لازم يكون تاريخ ووقت البداية في المستقبل. — The selected start date and time must be in the future.');
  }
  const bm = budgetMode === 'CBO' || budgetMode === 'ABO' ? budgetMode : null;
  if (!bm) throw bad('اختر نوع توزيع الميزانية: CBO أو ABO.');

  // ---- current source hierarchy (confirm campaign + ads still exist) ----
  const window = resolveWindow(windowName);
  const tree = await buildHierarchy({ adAccountId, window, settings });
  const campEntries = [];
  for (const p of tree.products || []) for (const c of p.children || []) campEntries.push({ camp: c, productName: p.name || null });
  for (const c of tree.unmappedCampaigns || []) campEntries.push({ camp: c, productName: null });
  const entry = campEntries.find((e) => String(e.camp.id) === String(sourceCampaignId));
  if (!entry) throw bad('حملة المصدر مش موجودة في بيانات الحساب الحالية.', 404);

  const sourceAds = flattenAds(entry.camp);
  const adById = new Map(sourceAds.map((a) => [String(a.id), a]));
  const sourceAdSetIds = new Set(sourceAds.map((a) => String(a.adsetId)));
  const requireAdsValid = (ids, ctx) => {
    const notIn = ids.filter((id) => !adById.has(id));
    if (notIn.length) throw bad(`${ctx}: إعلانات مش تابعة لحملة المصدر: ${notIn.join(', ')}`);
    const noCr = ids.filter((id) => !adById.get(id)?.creativeId);
    if (noCr.length) throw bad(`${ctx}: إعلانات بدون كرياتيف صالح: ${noCr.join(', ')}`);
  };

  const m = entry.camp.metrics || {};
  const nameOverride = `${entry.camp.name} - Scale`;

  // ---- build the engine call + the exact expected object-map keys ----
  let batchArgs; let expectedAdSetSourceIds; let expectedAdSourceIds;
  let planForRow = null; let allPickedForSnapshot = [];

  if (bm === 'CBO') {
    const picked = [...new Set((selectedAdIds || []).map(String).filter(Boolean))];
    if (!picked.length) throw bad('اختر إعلانًا رابحًا واحدًا على الأقل.');
    const campBudget = Number(campaignBudgetEgp ?? budgetEgp);
    if (!(campBudget > 0)) throw bad('ميزانية الحملة لازم تكون رقم أكبر من صفر.');
    requireAdsValid(picked, 'CBO');
    // spec §7 — required parent ad sets = unique parents of the selected ads.
    const requiredAdSetIds = [...new Set(picked.map((id) => String(adById.get(id).adsetId)))];
    batchArgs = { adAllowlist: picked, campaignBudgetOverrideEgp: campBudget, budgetMode: 'CBO' };
    expectedAdSetSourceIds = requiredAdSetIds;
    expectedAdSourceIds = picked;
    allPickedForSnapshot = picked;
  } else {
    // ABO
    const slotsIn = Array.isArray(adSets) ? adSets : [];
    if (!slotsIn.length) throw bad('لازم مجموعة إعلانية واحدة على الأقل.');
    const slotPlan = [];
    slotsIn.forEach((slot, i) => {
      const b = Number(slot?.dailyBudgetEgp);
      if (!(b > 0)) throw bad(`Ad Set ${i + 1}: الميزانية اليومية لازم تكون رقم أكبر من صفر.`);
      const picks = [...new Set((slot?.selectedAdIds || []).map(String).filter(Boolean))];
      if (!picks.length) throw bad(`Ad Set ${i + 1}: اختر إعلانًا واحدًا على الأقل.`);
      requireAdsValid(picks, `Ad Set ${i + 1}`);
      // Template = the parent source ad set of this slot's FIRST selected ad (spec §6).
      const sourceAdSetId = String(adById.get(picks[0]).adsetId);
      if (!sourceAdSetIds.has(sourceAdSetId)) throw bad(`Ad Set ${i + 1}: مجموعة المصدر غير صالحة.`);
      slotPlan.push({ sourceAdSetId, dailyBudgetMinor: Math.round(b * 100), ads: picks, dailyBudgetEgp: b });
    });
    // §13 bid-strategy safety: a source ad set with a cap strategy but no bid_amount can't be cloned into ABO.
    const token = await getDecryptedToken();
    const srcAdSetNodes = await getAdSetNodes(token, String(sourceCampaignId)).catch(() => []);
    const nodeById = new Map((srcAdSetNodes || []).map((a) => [String(a.id), a]));
    for (const s of slotPlan) {
      const node = nodeById.get(s.sourceAdSetId);
      if (node && CAP_BID_STRATEGIES.has(node.bid_strategy) && !(Number(node.bid_amount) > 0)) {
        throw bad(`مجموعة المصدر «${node.name || s.sourceAdSetId}» تستخدم استراتيجية مزايدة (${node.bid_strategy}) تتطلب حد مزايدة (bid_amount) غير متوفر — لا يمكن نسخها في وضع ABO دون تعديل الاستراتيجية.`);
      }
    }
    batchArgs = { slotPlan: slotPlan.map(({ dailyBudgetEgp, ...s }) => s), budgetMode: 'ABO' };
    expectedAdSetSourceIds = slotPlan.map((s, i) => `${s.sourceAdSetId}#${i}`);
    expectedAdSourceIds = slotPlan.flatMap((s, i) => s.ads.map((a) => `${a}#${i}`));
    planForRow = slotPlan.map((s) => ({ sourceAdSetId: s.sourceAdSetId, dailyBudgetEgp: s.dailyBudgetEgp, selectedAdIds: s.ads }));
    allPickedForSnapshot = [...new Set(slotPlan.flatMap((s) => s.ads))];
  }

  // ---- pending decision row (never EXECUTED before proof) ----
  const decision = await prisma.ambScaleDecision.create({
    data: {
      ad_account_id: adAccountId,
      source_campaign_id: String(sourceCampaignId),
      source_campaign_name: entry.camp.name,
      product_name: entry.productName || null,
      window_label: window.label,
      status: 'APPROVED',
      budget_mode: bm,
      orders: Math.round(n(m.purchases) || 0),
      cpa: round1(n(m.cpa)),
      spend: round1(n(m.spend) || 0),
      winner_ads_json: JSON.stringify(allPickedForSnapshot.map((id) => {
        const a = adById.get(id);
        return { adId: id, adName: a?.name, orders: Math.round(n(a?.metrics?.purchases) || 0), cpa: round1(n(a?.metrics?.cpa)) };
      })),
      budget_egp: bm === 'CBO' ? Number(campaignBudgetEgp ?? budgetEgp) : null,
      plan_json: planForRow ? JSON.stringify(planForRow) : null,
      exec_mode: mode,
      start_at_cairo: mode === 'SCHEDULE' ? String(startAt || '') : null,
      reviewed_by_id: userId || null,
      reviewed_at: new Date(),
    },
  });

  // ---- run the EXISTING clone engine, then PROVE the full tree exists ----
  let batchId = null;
  try {
    const batch = await createBatch({
      sourceAccountId: adAccountId,
      destinationAccountIds: [adAccountId],
      allowSameAccount: true,
      campaignIds: [String(sourceCampaignId)],
      campaignNameOverride: nameOverride,
      executionMode: mode,
      startAt: mode === 'SCHEDULE' ? startAt : null,
      allowPageOnlyIg: true,
      userId,
      ...batchArgs,
    });
    batchId = batch.batchId;
    await prisma.ambScaleDecision.update({ where: { id: decision.id }, data: { clone_batch_id: batchId } });
    await approveBatch({ batchId, userId }); // kicks the async clone worker

    const verdict = await waitAndVerifyScale({ batchId, expectedAdSetSourceIds, expectedAdSourceIds });
    if (!verdict.ok) {
      await prisma.ambScaleDecision.update({ where: { id: decision.id }, data: { status: 'FAILED', error: verdict.error.slice(0, 800) } });
      const e = new Error(`فشل إنشاء حملة الاسكيل: ${verdict.error}`);
      e.status = 502; e.scale = { decisionId: decision.id, batchId, ...verdict.counts };
      throw e;
    }
    await prisma.ambScaleDecision.update({ where: { id: decision.id }, data: { status: 'EXECUTED' } });
    return {
      decisionId: decision.id, batchId, status: 'EXECUTED', budgetMode: bm, scaleCampaignName: nameOverride,
      destinationCampaignId: verdict.destinationCampaignId,
      adSetsCreated: verdict.counts.adSetsCreated,
      adsCreated: verdict.counts.adsCreated,
    };
  } catch (err) {
    if (err.scale) throw err;
    await prisma.ambScaleDecision.update({
      where: { id: decision.id },
      data: { status: 'FAILED', error: (err.message || String(err)).slice(0, 800), clone_batch_id: batchId },
    });
    throw err;
  }
}
