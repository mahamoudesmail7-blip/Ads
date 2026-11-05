// مركز التنبيهات — everything that needs the owner's attention RIGHT NOW, computed from the real data (never from the legacy daily-orders trend):
//   1. Easy Orders stopped sending orders (the 2026-10-13 incident: 3 weeks of silence nobody noticed) / the webhook is rejecting deliveries
//   2. Meta sync is stale (every other number on screen is then old)
//   3. a live campaign whose CPA is above the product's reduce / hard-stop limit
//   4. a live campaign that spent with ZERO orders today (over the zero-spend limit)
//   5. a product that ran out of stock while its ads are still spending (or is low)
//   6. an ad account whose prepaid balance is under the threshold
// READ ONLY. Campaign facts come from the SAME rows as the campaigns board (campaignQuery.buildRows): policy limits, stock, links — nothing is re-derived or guessed.
// A fact that can't be read is reported as its own alert («تعذّر قراءة …»), never silently skipped.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getAmbSettings } from './settings.js';
import { listViewAccounts } from './viewAccounts.js';
import { buildRows, resolvePeriod } from './campaignQuery.js';
import { getSyncStatus } from './snapshotSync.js';
import { getAccountsToday } from './accountsToday.js';
import { cairoDate } from './dailyPlanTime.js';

export const SEVERITY_ORDER = { CRITICAL: 0, WARNING: 1, INFO: 2 };
const CACHE_MS = 60_000;
let CACHE = null;
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const hoursText = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} دقيقة` : h < 48 ? `${Math.round(h * 10) / 10} ساعة`.replace('.0', '') : `${Math.round(h / 24)} يوم`);
export const cairoHour = (d) => (new Date(d.getTime() + 3 * 3_600_000).getUTCHours());

/** 1. Easy Orders feed. Orders arrive ~20-40 an hour in the day; a long silence is the signal. At night (01-08 Cairo) the gaps are naturally longer, so the limits double. */
export function evalOrdersFeed({ lastOrderAt, now = new Date(), last24h = null, webhook = null }) {
  const out = [];
  const night = cairoHour(now) >= 1 && cairoHour(now) < 8;
  const warnH = night ? 4 : 2, critH = night ? 8 : 4;
  if (webhook && webhook.rejected > 0 && webhook.lastRejectedAt && now - new Date(webhook.lastRejectedAt) < 30 * 60_000) {
    out.push({ id: 'eo-webhook-rejected', kind: 'ORDERS_FEED', severity: 'CRITICAL', title: 'Easy Orders بيبعت أوردرات والسيرفر بيرفضها',
      detail: `${webhook.rejected} طلب اترفض بسبب الـ secret (آخر واحد ${new Date(webhook.lastRejectedAt).toISOString().slice(11, 16)} UTC). راجع متغيرات EASYORDERS_*_WEBHOOK_SECRET في Railway.`,
      facts: [{ l: 'مرفوض', v: String(webhook.rejected) }], action: 'صحّح الـ secret في Railway' });
  }
  if (!lastOrderAt) {
    out.push({ id: 'eo-feed-empty', kind: 'ORDERS_FEED', severity: 'CRITICAL', title: 'مفيش ولا أوردر من Easy Orders في السيستم', detail: 'الجدول فاضي — الـ webhook مش متوصّل.', facts: [], action: 'راجع ربط Easy Orders' });
    return out;
  }
  const hours = (now - new Date(lastOrderAt)) / 3_600_000;
  if (hours >= warnH) {
    out.push({ id: 'eo-feed-stalled', kind: 'ORDERS_FEED', severity: hours >= critH ? 'CRITICAL' : 'WARNING',
      title: `Easy Orders مبعتش أوردرات من ${hoursText(hours)}`,
      detail: 'لو الإعلانات شغالة والأوردرات مش بتنزل، يبقى الـ webhook واقف أو بيتم رفضه. كل أرقام الأوردرات في السيستم هتبقى ناقصة لحد ما يرجع.',
      facts: [{ l: 'آخر أوردر', v: new Date(lastOrderAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' }, ...(last24h != null ? [{ l: 'آخر 24 ساعة', v: `${fmt(last24h)} أوردر` }] : [])],
      action: 'راجع الـ webhook في Easy Orders ولوج Railway' });
  }
  return out;
}

/** 2. Meta sync freshness (the sync runs every N minutes; 4 missed cycles = stale). */
export function evalSyncFreshness({ lastSuccessAt, intervalMinutes = 15, now = new Date() }) {
  if (!lastSuccessAt) return [{ id: 'meta-sync-never', kind: 'SYNC', severity: 'CRITICAL', title: 'مزامنة Meta عمرها ما نجحت', detail: 'مفيش أرقام صرف أو أوردرات من Meta.', facts: [], action: 'اتأكد من ربط حساب Meta' }];
  const mins = (now - new Date(lastSuccessAt)) / 60_000;
  const limit = Math.max(5, Number(intervalMinutes) || 15) * 4;
  if (mins < limit) return [];
  return [{ id: 'meta-sync-stale', kind: 'SYNC', severity: mins >= limit * 2 ? 'CRITICAL' : 'WARNING', title: `مزامنة Meta واقفة من ${hoursText(mins / 60)}`,
    detail: 'أرقام الصرف والأوردرات والـ CPA على الشاشة قديمة، فأي قرار عليها ممكن يبقى غلط.', facts: [{ l: 'آخر مزامنة ناجحة', v: new Date(lastSuccessAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' }], action: 'شغّل المزامنة أو راجع التوكن' }];
}

/** 3-5. Campaign rows (campaignQuery.buildRows shape) → alerts. Only ACTIVE campaigns with fresh data; paused ones are not a live problem. */
export function evalCampaignAlerts(rows, { zeroLimit = 150, minSpend = 150 } = {}) {
  const out = [];
  const stockByProduct = new Map();
  for (const r of rows || []) {
    if (r.status !== 'ACTIVE' || !r.dataFresh) continue;
    const name = r.productName || r.name;
    const spendToday = Number(r.today?.spend) || 0;
    const ordersToday = r.today?.orders;
    const base = { entity: { campaignId: r.campaignId, adAccountId: r.adAccountId, productId: r.productId ?? null, productName: r.productName ?? null, campaignName: r.name } };
    // 3. CPA above the product's limits — judged on the 3-day window (stable), and only when it has really spent
    const spendP = Number(r.period?.spend) || 0;
    if (r.cpaVsLimits === 'ABOVE_HARDSTOP' || r.cpaVsLimits === 'ABOVE_REDUCE') {
      if (spendP >= minSpend && spendToday > 0) {
        const hard = r.cpaVsLimits === 'ABOVE_HARDSTOP';
        out.push({ id: `cpa:${r.key}`, kind: 'CPA', severity: hard ? 'CRITICAL' : 'WARNING', ...base,
          title: `${name}: الـ CPA فوق ${hard ? 'حد الإيقاف' : 'حد التخفيض'} والحملة لسه شغالة`,
          detail: `${r.name}`,
          facts: [{ l: 'CPA آخر 3 أيام', v: `${fmt(r.period.cpa)} ج` }, { l: hard ? 'حد الإيقاف' : 'حد التخفيض', v: `${fmt(hard ? r.limits.hardStop : r.limits.reduce)} ج` }, { l: 'صرف 3 أيام', v: `${fmt(spendP)} ج` }, { l: 'صرف النهارده', v: `${fmt(spendToday)} ج` }],
          action: hard ? 'اقفل الحملة أو قلّل الميزانية' : 'قلّل الميزانية وراقب' });
      }
    }
    // 4. spent with no orders today
    if (ordersToday === 0 && spendToday > zeroLimit) {
      out.push({ id: `zero:${r.key}`, kind: 'ZERO_ORDERS', severity: spendToday >= zeroLimit * 2 ? 'CRITICAL' : 'WARNING', ...base,
        title: `${name}: صرفت ${fmt(spendToday)} ج النهارده من غير ولا أوردر`,
        detail: `${r.name}`, facts: [{ l: 'صرف النهارده', v: `${fmt(spendToday)} ج` }, { l: 'حد الصرف بدون أوردر', v: `${fmt(zeroLimit)} ج` }, ...(r.budget ? [{ l: 'الميزانية', v: `${fmt(r.budget)} ج` }] : [])],
        action: 'راجع الحملة أو أوقفها' });
    }
    // 5. stock — one alert per product, however many campaigns it has
    const st = r.stock?.status;
    if (r.productId != null && (st === 'OUT_OF_STOCK' || st === 'LOW') && (spendToday > 0 || st === 'OUT_OF_STOCK')) {
      const cur = stockByProduct.get(r.productId) || { productId: r.productId, productName: r.productName, status: st, current: r.stock.current, campaigns: [], spend: 0 };
      cur.campaigns.push(r.name); cur.spend += spendToday; stockByProduct.set(r.productId, cur);
    }
  }
  for (const p of stockByProduct.values()) {
    const out0 = p.status === 'OUT_OF_STOCK';
    out.push({ id: `stock:${p.productId}`, kind: 'STOCK', severity: out0 ? 'CRITICAL' : 'WARNING', entity: { productId: p.productId, productName: p.productName },
      title: out0 ? `${p.productName}: المخزون خلص والإعلان شغال` : `${p.productName}: المخزون قرب يخلص`,
      detail: out0 ? 'كل أوردر جديد ممكن يتبعت ومفيش بضاعة. وقّف الحملات أو زوّد المخزون.' : 'راجع الكمية قبل ما تزوّد الميزانية.',
      facts: [{ l: 'المخزون', v: p.current == null ? '—' : String(p.current) }, { l: 'حملات شغالة', v: String(p.campaigns.length) }, { l: 'صرف النهارده', v: `${fmt(p.spend)} ج` }], action: out0 ? 'وقّف الحملات أو زوّد المخزون' : 'خطّط لإعادة الطلب' });
  }
  return out;
}

/** 6. Ad-account funds (the card's own low-funds rule — classifyFunds — already marked funds.low). */
export function evalFunds(accounts, threshold = 2000) {
  const out = [];
  for (const a of accounts || []) {
    if (!a.funds?.low) continue;
    out.push({ id: `funds:${a.id}`, kind: 'FUNDS', severity: 'CRITICAL', entity: { adAccountId: a.id },
      title: `حساب ${a.name || a.id}: الرصيد المتاح ${fmt(a.funds.available ?? 0)} ج بس`,
      detail: 'الحساب ممكن يقف إعلاناته لو الرصيد خلص.', facts: [{ l: 'الرصيد المتاح', v: `${fmt(a.funds.available ?? 0)} ج` }, { l: 'الحد الأدنى', v: `${fmt(threshold)} ج` }, ...(a.spend ? [{ l: 'صرف النهارده', v: `${fmt(a.spend)} ج` }] : [])], action: 'اشحن الحساب' });
  }
  return out;
}

export function sortAlerts(list) {
  return [...list].sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
}

export function summarize(list) {
  const by = { CRITICAL: 0, WARNING: 0, INFO: 0 }; const kinds = {};
  for (const a of list) { by[a.severity] = (by[a.severity] || 0) + 1; kinds[a.kind] = (kinds[a.kind] || 0) + 1; }
  return { total: list.length, ...by, kinds };
}

async function ordersFeedFacts(now) {
  const [last, c24] = await Promise.all([
    prisma.easyOrdersOrder.aggregate({ _max: { created_at: true } }),
    prisma.easyOrdersOrder.count({ where: { created_at: { gte: new Date(now.getTime() - 24 * 3_600_000) } } }),
  ]);
  let webhook = null;
  try { webhook = (await import('../../routes/webhooks.js')).webhookAuthHealth; } catch { /* diagnostics only */ }
  return { lastOrderAt: last._max.created_at, last24h: c24, webhook };
}

/** @param {{ force?: boolean, now?: Date }} [p] */
export async function getAlertsCenter({ force = false, now = new Date() } = {}) {
  if (!force && CACHE && now - CACHE.at < CACHE_MS) return CACHE.data;
  const alerts = []; const unavailable = [];
  const settings = await getAmbSettings();

  try { alerts.push(...evalOrdersFeed({ ...(await ordersFeedFacts(now)), now })); } catch (e) { logger.warn('[alertsCenter] orders feed', { message: e.message }); unavailable.push('أوردرات Easy Orders'); }
  try { const s = await getSyncStatus(); alerts.push(...evalSyncFreshness({ lastSuccessAt: s?.lastSuccessAt, intervalMinutes: s?.intervalMinutes, now })); } catch (e) { logger.warn('[alertsCenter] sync', { message: e.message }); unavailable.push('حالة المزامنة'); }

  let accounts = [];
  try { accounts = (await listViewAccounts()).accounts; } catch (e) { logger.warn('[alertsCenter] accounts', { message: e.message }); unavailable.push('الحسابات الإعلانية'); }
  if (accounts.length) {
    try {
      const today = cairoDate(now);
      const built = await buildRows({ accounts: accounts.map((a) => a.id), period: resolvePeriod({ key: 'last3' }, today), now });
      const zeroLimit = Number(built.zero?.limit) > 0 ? Number(built.zero.limit) : Number(settings.ambMinSpendBeforeDecision) || 150;
      alerts.push(...evalCampaignAlerts(built.rows, { zeroLimit, minSpend: Number(settings.ambMinSpendBeforeDecision) || 150 }));
    } catch (e) { logger.warn('[alertsCenter] campaigns', { message: e.message }); unavailable.push('الحملات'); }
    try {
      const at = await getAccountsToday({});
      alerts.push(...evalFunds(at.accounts, at.lowFundsThreshold));
    } catch (e) { logger.warn('[alertsCenter] funds', { message: e.message }); unavailable.push('أرصدة الحسابات'); }
  }
  for (const what of unavailable) alerts.push({ id: `unavailable:${what}`, kind: 'SYSTEM', severity: 'INFO', title: `تعذّر قراءة ${what}`, detail: 'التنبيهات المتعلقة بيها مش ظاهرة دلوقتي — مش معناه إن مفيش مشاكل.', facts: [], action: 'حدّث الصفحة بعد شوية' });

  const sorted = sortAlerts(alerts);
  const data = { generatedAt: now.toISOString(), summary: summarize(sorted), alerts: sorted, unavailable };
  CACHE = { at: now.getTime(), data };
  return data;
}

export const _resetAlertsCache = () => { CACHE = null; };
