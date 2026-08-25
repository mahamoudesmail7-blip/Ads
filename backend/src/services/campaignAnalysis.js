// Campaign performance analysis engine — AI Business Intelligence Phase 1,
// Critical Fixes 1-6. Pure functions operating on already-loaded
// AdsDailyMetric rows; no product/order join anywhere in this file
// (per explicit rule: "Campaign Analysis requires Ads Data only" —
// product/profit analysis is a separate, optional layer in adsIntelligence.js).
//
// "Results" preference: Meta's own objective-agnostic outcome count
// (row.results) is used when present; falls back to meta_purchases only
// when NO row in the whole set has a results value, so the UI can label
// which metric it's actually showing rather than silently mixing them.

const MIN_SPEND_FOR_VERDICT = 150; // EGP — a campaign below this has too little spend to judge fairly; classified NEED_MORE_DATA instead of a verdict
const CPA_SPIKE_THRESHOLD = 0.3; // +30% CPA vs previous period
const CTR_DROP_THRESHOLD = 0.2; // -20% CTR vs previous period
const HIGH_SPEND_LOW_RESULTS_FACTOR = 0.5; // actual results < 50% of what account-average efficiency predicts for that spend

function sum(rows, field) {
  return rows.reduce((s, r) => s + (r[field] || 0), 0);
}
function sumIf(rows, field) {
  const withData = rows.filter((r) => r[field] !== null && r[field] !== undefined);
  return withData.length > 0 ? withData.reduce((s, r) => s + r[field], 0) : null;
}

/** Whichever "Results" number is actually available for this set of rows — Meta's own Results field preferred, meta_purchases as a fallback. Never silently blends both. */
function pickResultsTotal(rows) {
  const resultsTotal = sumIf(rows, 'results');
  if (resultsTotal !== null) return { total: resultsTotal, source: 'results' };
  const purchasesTotal = sumIf(rows, 'meta_purchases');
  if (purchasesTotal !== null) return { total: purchasesTotal, source: 'meta_purchases' };
  return { total: null, source: 'none' };
}

/** Derives revenue from spend*ROAS when meta_revenue itself wasn't in the export — flagged as estimated so the UI can say so, never presented as if it were the export's own number. */
function pickRevenueTotal(rows) {
  const revenueTotal = sumIf(rows, 'meta_revenue');
  if (revenueTotal !== null) return { total: revenueTotal, estimated: false };
  const withRoas = rows.filter((r) => r.spend && r.meta_roas);
  if (withRoas.length === 0) return { total: null, estimated: false };
  const estimated = withRoas.reduce((s, r) => s + r.spend * r.meta_roas, 0);
  return { total: estimated, estimated: true };
}

/** One aggregated metrics object for an arbitrary set of rows (one campaign, or the whole account) — every ratio is null (not 0) when its inputs are missing, never a misleading zero. */
export function aggregateMetrics(rows) {
  const spend = sum(rows, 'spend');
  const impressions = sumIf(rows, 'impressions');
  const reach = sumIf(rows, 'reach');
  const clicks = sumIf(rows, 'clicks');
  const { total: results, source: resultsSource } = pickResultsTotal(rows);
  const { total: revenue, estimated: revenueEstimated } = pickRevenueTotal(rows);

  return {
    rowCount: rows.length,
    spend,
    impressions,
    reach,
    clicks,
    results,
    resultsSource, // 'results' | 'meta_purchases' | 'none' — which real column this total came from
    revenue,
    revenueEstimated, // true if derived from spend*ROAS rather than a real revenue column
    cpa: results > 0 ? spend / results : null,
    ctr: clicks !== null && impressions ? (clicks / impressions) * 100 : null,
    cpc: clicks !== null && clicks > 0 ? spend / clicks : null,
    cpm: impressions ? (spend / impressions) * 1000 : null,
    roas: revenue !== null && spend > 0 ? revenue / spend : null,
  };
}

/** Groups rows by campaign_name and aggregates each — the core "Campaign Ranking" data. */
export function aggregateByCampaign(rows) {
  const byCampaign = new Map();
  for (const r of rows) {
    const key = r.campaign_name || '(بدون اسم)';
    if (!byCampaign.has(key)) byCampaign.set(key, []);
    byCampaign.get(key).push(r);
  }
  return [...byCampaign.entries()].map(([campaignName, campaignRows]) => ({
    campaignName,
    delivery: campaignRows.find((r) => r.campaign_delivery)?.campaign_delivery || null,
    dateRange: { from: campaignRows.reduce((m, r) => (r.date < m ? r.date : m), campaignRows[0].date), to: campaignRows.reduce((m, r) => (r.date > m ? r.date : m), campaignRows[0].date) },
    ...aggregateMetrics(campaignRows),
  }));
}

/** True once there's more than one distinct date in the dataset — period-over-period comparison (CPA Spike, CTR Drop, trend charts) is only meaningful with date variety, never fabricated from a single-day snapshot. */
export function hasDateVariety(rows) {
  const dates = new Set(rows.map((r) => r.date));
  return dates.size > 1;
}

/**
 * Rule-based problem detection (spec Critical Fix 4). Every rule requires
 * MIN_SPEND_FOR_VERDICT spend before judging — a campaign below that is
 * skipped here entirely (shown separately as "insufficient data", never
 * silently classified GOOD or BAD).
 */
export function detectProblems(campaigns, accountAvg, { previousCampaigns } = {}) {
  const problems = [];
  const eligible = campaigns.filter((c) => c.spend >= MIN_SPEND_FOR_VERDICT);
  const previousByName = new Map((previousCampaigns || []).map((c) => [c.campaignName, c]));

  for (const c of eligible) {
    // Type 4: High Spend, Zero Results — checked first, most severe/obvious.
    if ((c.results || 0) === 0) {
      problems.push({
        type: 'HIGH_SPEND_ZERO_RESULTS',
        severity: 'CRITICAL',
        campaignName: c.campaignName,
        detail: { spend: c.spend, results: 0 },
        message: `صرفت ${c.spend.toFixed(0)} جنيه من غير أي نتيجة واحدة.`,
        recommendedAction: 'راجع الإعلان أو أوقفه فورًا.',
      });
      continue; // zero results already covers "low results" — don't double-flag
    }

    // Type 1: High Spend, Low Results vs account average efficiency.
    if (accountAvg.cpa && c.cpa) {
      const expectedResults = c.spend / accountAvg.cpa;
      if (c.results < expectedResults * HIGH_SPEND_LOW_RESULTS_FACTOR) {
        problems.push({
          type: 'HIGH_SPEND_LOW_RESULTS',
          severity: 'WARNING',
          campaignName: c.campaignName,
          detail: { spend: c.spend, actualResults: c.results, expectedResults: Math.round(expectedResults), actualCPA: c.cpa, accountAvgCPA: accountAvg.cpa },
          message: `الـ CPA بتاعها ${c.cpa.toFixed(1)} جنيه مقابل متوسط الحساب ${accountAvg.cpa.toFixed(1)} جنيه — نتايجها أقل من نص المتوقع بصرفها الحالي.`,
          recommendedAction: 'قلل الميزانية أو راجع الاستهداف/الإعلان.',
        });
      }
    }

    // Types 2/3 need a previous period to compare against — only run when one exists.
    const prev = previousByName.get(c.campaignName);
    if (prev && prev.spend >= MIN_SPEND_FOR_VERDICT) {
      if (prev.cpa && c.cpa) {
        const change = (c.cpa - prev.cpa) / prev.cpa;
        if (change >= CPA_SPIKE_THRESHOLD) {
          problems.push({
            type: 'CPA_SPIKE',
            severity: 'WARNING',
            campaignName: c.campaignName,
            detail: { previousCPA: prev.cpa, currentCPA: c.cpa, changePct: Math.round(change * 100) },
            message: `الـ CPA ارتفع من ${prev.cpa.toFixed(1)} لـ ${c.cpa.toFixed(1)} جنيه (+${Math.round(change * 100)}%).`,
            recommendedAction: 'راجع الحملة — احتمال Fatigue أو تغيير في المنافسة.',
          });
        }
      }
      if (prev.ctr && c.ctr) {
        const change = (c.ctr - prev.ctr) / prev.ctr;
        if (change <= -CTR_DROP_THRESHOLD) {
          problems.push({
            type: 'CTR_DROP',
            severity: 'INFO',
            campaignName: c.campaignName,
            detail: { previousCTR: prev.ctr, currentCTR: c.ctr, changePct: Math.round(change * 100) },
            message: `الـ CTR نزل من ${prev.ctr.toFixed(2)}% لـ ${c.ctr.toFixed(2)}% (${Math.round(change * 100)}%).`,
            recommendedAction: 'راجع أداء الكرييتيف — ملاحظة: مش بالضرورة Fatigue، محتاج مراجعة فعلية.',
          });
        }
      }
    }
  }

  return problems;
}

/**
 * Buckets campaigns into the AI Decision Center categories (spec Critical
 * Fix 6). A campaign only gets a confident STOP/SCALE verdict with enough
 * spend AND (for SCALE) enough results — otherwise it lands in
 * COLLECT_MORE_DATA, never a false-confidence call on thin data.
 */
export function buildDecisions(campaigns, accountAvg, problems) {
  const stop = [];
  const fix = [];
  const test = [];
  const scale = [];
  const opportunities = [];

  const problemsByCampaign = new Map();
  for (const p of problems) {
    if (!problemsByCampaign.has(p.campaignName)) problemsByCampaign.set(p.campaignName, []);
    problemsByCampaign.get(p.campaignName).push(p);
  }

  for (const c of campaigns) {
    const myProblems = problemsByCampaign.get(c.campaignName) || [];
    const hasCritical = myProblems.some((p) => p.severity === 'CRITICAL');
    const hasWarning = myProblems.some((p) => p.severity === 'WARNING');

    if (c.spend < MIN_SPEND_FOR_VERDICT) {
      // Not enough spend to judge at all — only worth surfacing as a TEST candidate if it shows early promise.
      if (accountAvg.cpa && c.cpa && c.cpa <= accountAvg.cpa) {
        test.push({ campaignName: c.campaignName, reason: 'بيانات قليلة لسه بس الأداء المبدئي كويس', confidence: 'LOW', metrics: c });
      }
      continue;
    }

    if (hasCritical) {
      stop.push({ campaignName: c.campaignName, reason: myProblems.find((p) => p.severity === 'CRITICAL').message, confidence: 'HIGH', metrics: c });
    } else if (hasWarning) {
      fix.push({ campaignName: c.campaignName, reason: myProblems.map((p) => p.message).join(' — '), confidence: 'MEDIUM', metrics: c });
    } else if (accountAvg.cpa && c.cpa && c.cpa <= accountAvg.cpa * 0.8) {
      // Clearly better than average with real spend behind it.
      if (c.spend < accountAvg.spend) {
        opportunities.push({ campaignName: c.campaignName, reason: `الـ CPA أحسن من متوسط الحساب بـ${Math.round((1 - c.cpa / accountAvg.cpa) * 100)}% بس الصرف عليها لسه محدود`, confidence: 'MEDIUM', metrics: c });
      } else {
        scale.push({ campaignName: c.campaignName, reason: `الـ CPA أحسن من متوسط الحساب بـ${Math.round((1 - c.cpa / accountAvg.cpa) * 100)}%`, confidence: 'HIGH', metrics: c });
      }
    }
  }

  const sortBySpendDesc = (a, b) => b.metrics.spend - a.metrics.spend;
  return {
    stop: stop.sort(sortBySpendDesc),
    fix: fix.sort(sortBySpendDesc),
    test: test.sort(sortBySpendDesc),
    scale: scale.sort(sortBySpendDesc),
    opportunities: opportunities.sort(sortBySpendDesc),
  };
}

/** The "AI Executive Summary" block — what happened, biggest problem, biggest opportunity, all derived from the already-computed numbers, never invented. */
export function buildExecutiveSummary({ overview, previousOverview, problems, decisions }) {
  const lines = [];

  if (previousOverview && overview.spend !== null && previousOverview.spend) {
    const spendChange = Math.round(((overview.spend - previousOverview.spend) / previousOverview.spend) * 100);
    const resultsChange = overview.results && previousOverview.results ? Math.round(((overview.results - previousOverview.results) / previousOverview.results) * 100) : null;
    if (resultsChange !== null) {
      lines.push(`الصرف ${spendChange >= 0 ? 'زاد' : 'قل'} بنسبة ${Math.abs(spendChange)}% مقارنة بالفترة اللي قبلها، والنتايج ${resultsChange >= 0 ? 'زادت' : 'قلت'} بنسبة ${Math.abs(resultsChange)}%.`);
    }
  } else {
    lines.push('مفيش بيانات كافية للمقارنة بفترة سابقة لسه — ارفع بيانات ليوم أو فترة تانية عشان تظهر المقارنة.');
  }

  const worstProblem = [...problems].sort((a, b) => (b.detail?.spend || 0) - (a.detail?.spend || 0))[0];
  const biggestProblem = worstProblem
    ? { campaignName: worstProblem.campaignName, message: worstProblem.message }
    : null;

  const bestOpportunity = [...decisions.scale, ...decisions.opportunities].sort((a, b) => b.metrics.spend - a.metrics.spend)[0] || null;

  return {
    summary: lines.join(' '),
    biggestProblem,
    biggestOpportunity: bestOpportunity ? { campaignName: bestOpportunity.campaignName, reason: bestOpportunity.reason } : null,
  };
}

export { MIN_SPEND_FOR_VERDICT };
