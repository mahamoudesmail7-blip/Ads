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
export async function waitAndVerifyScale({ batchId, requiredAdSetIds, selectedAdIds, timeoutMs = 120_000, pollMs = 2500 }) {
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
  const missingAdsets = requiredAdSetIds.filter((id) => !destAdsetSrcIds.has(String(id)));
  const missingAds = selectedAdIds.filter((id) => !destAdSrcIds.has(String(id)));

  const counts = {
    adSetsCreated: created('ADSET').length,
    adsCreated: created('AD').length,
    creativesCreated: created('CREATIVE').length,
  };

  if (!campRow) return { ok: false, error: firstErr(job, failed, 'لم تُنشأ حملة الوجهة.'), counts };
  if (missingAdsets.length || missingAds.length || failed.length || ['FAILED', 'ACTIVATION_FAILED', 'PREFLIGHT_BLOCKED', 'CANNOT_COPY', 'NEEDS_DECISION', 'NEEDS_INPUT'].includes(job.status)) {
    const bits = [];
    if (missingAdsets.length) bits.push(`مجموعات إعلانية ناقصة: ${missingAdsets.length}/${requiredAdSetIds.length}`);
    if (missingAds.length) bits.push(`إعلانات ناقصة: ${missingAds.length}/${selectedAdIds.length}`);
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

/**
 * Approve + execute a scale. Validates, then runs the EXISTING clone engine
 * in same-account mode restricted to the selected winning ads, with the
 * owner's budget and Run Now / Schedule Start choice. Nothing is created
 * before this call; the source hierarchy is never written.
 */
export async function executeScale({
  sourceCampaignId, selectedAdIds, budgetEgp, startMode, startAt,
  windowName = 'today', userId,
}) {
  const conn = await getConnection();
  if (!conn || conn.status !== 'CONNECTED' || !conn.selected_ad_account_id) {
    const e = new Error('اربط حساب Meta Ads الأول.'); e.status = 400; throw e;
  }
  const adAccountId = conn.selected_ad_account_id;
  const settings = await getAmbSettings();

  // ---- validation (spec §22) ----
  if (!sourceCampaignId) { const e = new Error('sourceCampaignId مطلوب.'); e.status = 400; throw e; }
  const picked = [...new Set((selectedAdIds || []).map(String).filter(Boolean))];
  if (!picked.length) { const e = new Error('اختر إعلانًا رابحًا واحدًا على الأقل.'); e.status = 400; throw e; }
  const budget = Number(budgetEgp);
  if (!(budget > 0)) { const e = new Error('ميزانية الاسكيل لازم تكون رقم أكبر من صفر.'); e.status = 400; throw e; }
  const mode = startMode === 'SCHEDULE' ? 'SCHEDULE' : 'RUN_NOW';
  if (mode === 'SCHEDULE') {
    const [dp, tp] = String(startAt || '').split('T');
    const at = cairoLocalToUtc(dp, tp || '00:00');
    if (!at) { const e = new Error('تاريخ/وقت البداية غير صالح.'); e.status = 400; throw e; }
    if (at.getTime() <= Date.now()) {
      const e = new Error('لازم يكون تاريخ ووقت البداية في المستقبل. — The selected start date and time must be in the future.');
      e.status = 400; throw e;
    }
  }

  // Re-detect winners on the CURRENT window to confirm the campaign + ads still exist
  // in the source hierarchy and to snapshot the panel.
  const window = resolveWindow(windowName);
  const tree = await buildHierarchy({ adAccountId, window, settings });
  const campEntries = [];
  for (const p of tree.products || []) for (const c of p.children || []) campEntries.push({ camp: c, productName: p.name || null });
  for (const c of tree.unmappedCampaigns || []) campEntries.push({ camp: c, productName: null });
  const entry = campEntries.find((e) => String(e.camp.id) === String(sourceCampaignId));
  if (!entry) { const e = new Error('حملة المصدر مش موجودة في بيانات الحساب الحالية.'); e.status = 404; throw e; }

  const sourceAds = flattenAds(entry.camp);
  const sourceAdIds = new Set(sourceAds.map((a) => String(a.id)));
  const notInHierarchy = picked.filter((id) => !sourceAdIds.has(id));
  if (notInHierarchy.length) { const e = new Error(`إعلانات مش تابعة لحملة المصدر: ${notInHierarchy.join(', ')}`); e.status = 400; throw e; }
  const missingCreative = picked.filter((id) => { const a = sourceAds.find((x) => String(x.id) === id); return !a || !a.creativeId; });
  if (missingCreative.length) { const e = new Error(`إعلانات بدون كرياتيف صالح: ${missingCreative.join(', ')}`); e.status = 400; throw e; }

  const m = entry.camp.metrics || {};
  const nameOverride = `${entry.camp.name} - Scale`;
  // Ancestors of the selected ads that MUST be cloned (spec §3/§4).
  const requiredAdSetIds = [...new Set(sourceAds.filter((a) => picked.includes(String(a.id))).map((a) => String(a.adsetId)).filter(Boolean))];

  // ---- pending decision row (APPROVED, not EXECUTED — success is proven below) ----
  const decision = await prisma.ambScaleDecision.create({
    data: {
      ad_account_id: adAccountId,
      source_campaign_id: String(sourceCampaignId),
      source_campaign_name: entry.camp.name,
      product_name: entry.productName || null,
      window_label: window.label,
      status: 'APPROVED',
      orders: Math.round(n(m.purchases) || 0),
      cpa: round1(n(m.cpa)),
      spend: round1(n(m.spend) || 0),
      winner_ads_json: JSON.stringify(sourceAds.filter((a) => picked.includes(String(a.id))).map((a) => ({
        adId: a.id, adName: a.name, orders: Math.round(n(a.metrics?.purchases) || 0), cpa: round1(n(a.metrics?.cpa)),
      }))),
      budget_egp: budget,
      exec_mode: mode,
      start_at_cairo: mode === 'SCHEDULE' ? String(startAt || '') : null,
      reviewed_by_id: userId || null,
      reviewed_at: new Date(),
    },
  });

  // ---- run the EXISTING clone engine, then PROVE it finished the whole tree ----
  let batchId = null;
  try {
    const batch = await createBatch({
      sourceAccountId: adAccountId,
      destinationAccountIds: [adAccountId],
      allowSameAccount: true,
      campaignIds: [String(sourceCampaignId)],
      adAllowlist: picked,
      campaignBudgetOverrideEgp: budget,
      campaignNameOverride: nameOverride,
      executionMode: mode,
      startAt: mode === 'SCHEDULE' ? startAt : null,
      allowPageOnlyIg: true,
      userId,
    });
    batchId = batch.batchId;
    await prisma.ambScaleDecision.update({ where: { id: decision.id }, data: { clone_batch_id: batchId } });
    await approveBatch({ batchId, userId }); // kicks the async clone worker

    const verdict = await waitAndVerifyScale({ batchId, requiredAdSetIds, selectedAdIds: picked });
    if (!verdict.ok) {
      await prisma.ambScaleDecision.update({ where: { id: decision.id }, data: { status: 'FAILED', error: verdict.error.slice(0, 800) } });
      const e = new Error(`فشل إنشاء حملة الاسكيل: ${verdict.error}`);
      e.status = 502; e.scale = { decisionId: decision.id, batchId, ...verdict.counts };
      throw e;
    }
    await prisma.ambScaleDecision.update({ where: { id: decision.id }, data: { status: 'EXECUTED' } });
    return {
      decisionId: decision.id, batchId, status: 'EXECUTED', scaleCampaignName: nameOverride,
      destinationCampaignId: verdict.destinationCampaignId,
      adSetsCreated: verdict.counts.adSetsCreated,
      adsCreated: verdict.counts.adsCreated,
    };
  } catch (err) {
    if (err.scale) throw err; // already recorded FAILED above
    await prisma.ambScaleDecision.update({
      where: { id: decision.id },
      data: { status: 'FAILED', error: (err.message || String(err)).slice(0, 800), clone_batch_id: batchId },
    });
    throw err;
  }
}
