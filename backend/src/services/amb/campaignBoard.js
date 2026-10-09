// AI Operator — campaign BOARD (read-only). Every campaign we have fresh data for (not only today's candidates), with Today / 7D / 30D numbers.
// "Today" is the Africa/Cairo calendar day; the last snapshot of each (campaign, day) is that day's final figure (no double counting); CPA = spend / purchases of the SAME window and is null (never 0) when there are no purchases.
// Reads only synced snapshots + saved settings. Never calls Meta, never writes.
import { prisma } from '../../prisma.js';
import { getConnection } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { getSyncStatus } from './snapshotSync.js';
import { entityWindowMetrics } from './metricsEngine.js';
import { listCampaignsFromSnapshots, buildCampaignProductIndex } from './operatorContext.js';
import { loadCampaignTags, listExceptions, exceptionsFor } from './operatorStore.js';
import { getBudgetPolicy } from './budgetOptimizer.js';
import { activePolicyFromLimits, applyToBudgetPolicy } from './productPolicy.js';
import { cairoDate } from './dailyPlanTime.js';

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** inclusive windows, "today" is day 1 — the same definition the plans and the optimizer use, but anchored on the CAIRO date */
export const boardWindows = (today) => ({ today: { from: today, to: today }, d7: { from: addDays(today, -6), to: today }, d30: { from: addDays(today, -29), to: today } });
export const cpaOf = (spend, purchases) => (Number(purchases) > 0 ? Math.round(Number(spend) / Number(purchases)) : null);
const slim = (m) => { if (!m) return { spend: 0, purchases: 0, cpa: null }; const spend = Math.round(Number(m.spend) || 0), purchases = Number(m.purchases) || 0; return { spend, purchases, cpa: cpaOf(m.spend, purchases) }; };
/** CPA colour zones from the REAL policy: the product's ACTIVE policy layered on the global budget policy. Null when neither defines them — the UI then shows no colour instead of inventing a limit. */
export function zonesFor(globalBudget, activePolicy) {
  if (!globalBudget?.scale || !globalBudget?.keep || !globalBudget?.reduce) return null;
  const eff = activePolicy ? applyToBudgetPolicy(globalBudget, activePolicy).policy : globalBudget;
  const good = Number(eff.scale?.maxCpa), mid = Number(eff.keep?.maxCpa), warn = Number(eff.reduce?.maxCpa);
  if (![good, mid, warn].every((n) => Number.isFinite(n) && n > 0)) return null;
  return { good, mid, warn, source: activePolicy ? 'PRODUCT_POLICY' : 'GLOBAL_POLICY' };
}

export async function buildCampaignBoard({ now = new Date() } = {}) {
  const connection = await getConnection(); const adAccountId = connection?.selected_ad_account_id || null;
  const today = cairoDate(now);
  if (!adAccountId) return { connected: false, today, rows: [], staleExcluded: 0 };
  const settings = await getAmbSettings(); const sync = await getSyncStatus().catch(() => null);
  const intervalMs = (Number(settings.ambSyncIntervalMinutes) || 15) * 60_000; const freshMs = intervalMs * 4;
  const all = (await listCampaignsFromSnapshots({ adAccountId })).filter((c) => ['ACTIVE', 'PAUSED'].includes(c.status));
  const fresh = all.filter((c) => now.getTime() - new Date(c.lastSeenAt).getTime() <= freshMs); const staleExcluded = all.length - fresh.length;
  const W = boardWindows(today); const maps = {};
  for (const k of Object.keys(W)) maps[k] = await entityWindowMetrics({ level: 'campaign', from: W[k].from, to: W[k].to, adAccountId });
  const prodIndex = await buildCampaignProductIndex({ adAccountId }); const tags = await loadCampaignTags(adAccountId); const exceptions = await listExceptions({ now });
  const ambIds = [...new Set([...prodIndex.values()].map((v) => v.ambProductId).filter(Boolean))];
  const ambs = ambIds.length ? await prisma.$queryRawUnsafe(`select ap.id as amb_id, p.id as product_id, p.product_name, p.store_id from amb_products ap join products p on p.id = ap.product_id where ap.id = any($1::int[])`, ambIds) : [];
  const ambBy = new Map(ambs.map((a) => [a.amb_id, a]));
  const ids = fresh.map((c) => c.id);
  const adsetRows = ids.length ? await prisma.$queryRawUnsafe(`select campaign_id, sum(adset_budget) filter (where adset_status = 'ACTIVE') as b, count(distinct adset_id)::int as n from (select distinct on (adset_id) campaign_id, adset_id, adset_budget, adset_status from meta_performance_snapshots where level = 'adset' and campaign_id = any($1::text[]) order by adset_id, snapshot_at desc) t group by campaign_id`, ids) : [];
  const adsetBy = new Map(adsetRows.map((r) => [r.campaign_id, { budget: Number(r.b || 0) || null, n: r.n }]));
  const globalBudget = await getBudgetPolicy().catch(() => null);
  const raw = (await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' }, select: { limits_json: true } }).catch(() => null)); const rawLimits = j(raw?.limits_json, {}) || {};
  const rows = fresh.map((c) => {
    const px = prodIndex.get(c.id); const amb = px ? ambBy.get(px.ambProductId) : null; const t = tags.get(c.id)?.tag || null;
    const exc = exceptionsFor({ exceptions, storeId: amb?.store_id ?? null, productId: amb?.product_id ?? null, campaignId: c.id, tag: t }).flatMap((e) => e.types || []);
    const cbo = Number(c.budget) > 0; const ab = adsetBy.get(c.id);
    const pol = amb ? activePolicyFromLimits(rawLimits, amb.store_id, amb.product_id) : null;
    return {
      campaignId: c.id, campaignName: c.name, status: c.status, productId: amb?.product_id ?? null, productName: amb?.product_name ?? null, storeId: amb?.store_id ?? null, mapping: px ? { via: px.via, verified: !!px.verified } : null,
      budget: cbo ? Number(c.budget) : ab?.budget ?? null, budgetLevel: cbo ? 'CBO' : ab?.budget ? 'ABO' : null, adsets: ab?.n ?? null, tag: t, exceptions: exc,
      today: slim(maps.today.get(c.id)), d7: slim(maps.d7.get(c.id)), d30: slim(maps.d30.get(c.id)), zones: zonesFor(globalBudget, pol), lastSeenAt: c.lastSeenAt,
    };
  });
  return { connected: true, today, windows: W, metaLastSyncAt: sync?.lastSuccessAt || null, staleExcluded, count: rows.length, rows, tz: 'Africa/Cairo' };
}
