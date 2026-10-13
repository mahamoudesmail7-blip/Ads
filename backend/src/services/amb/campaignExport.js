// AI Operator V2 — CSV export of the campaigns that match a query (server-side, same scoping and same numbers as the table; never more than 5000 rows).
// A cell that starts with = + - @ is prefixed so a spreadsheet can never run it as a formula. Excel opens the UTF-8 BOM file directly.
import { matchingRows } from './campaignQuery.js';

export const EXPORT_MAX = 5000;
const n = (v) => (v == null ? '' : v);
export const EXPORT_COLUMNS = {
  name: ['اسم الحملة', (r) => r.name], id: ['Campaign ID', (r) => r.campaignId], account: ['الحساب', (r) => r.adAccountId], store: ['المتجر', (r) => n(r.storeId)], product: ['المنتج', (r) => n(r.productName)], status: ['الحالة', (r) => r.status],
  budget: ['الميزانية اليومية', (r) => n(r.budget)], budgetLevel: ['ABO/CBO', (r) => n(r.budgetLevel)], spendToday: ['صرف اليوم', (r) => r.today.spend], ordersToday: ['أوردرات اليوم', (r) => n(r.today.orders)], cpaToday: ['CPA اليوم', (r) => n(r.today.cpa)],
  spendPeriod: ['صرف الفترة', (r) => r.period.spend], ordersPeriod: ['أوردرات الفترة', (r) => n(r.period.orders)], cpaPeriod: ['CPA الفترة', (r) => n(r.period.cpa)], roas: ['ROAS (Meta)', (r) => n(r.period.roas)],
  cpa7: ['CPA 7 أيام', (r) => n(r.cpa.d7)], cpa14: ['CPA 14 يوم', (r) => n(r.cpa.d14)], cpa30: ['CPA 30 يوم', (r) => n(r.cpa.d30)], cpa60: ['CPA 60 يوم', (r) => n(r.cpa.d60)],
  winner: ['Winner', (r) => r.winner.status], target: ['Target CPA', (r) => n(r.limits?.target)], reduce: ['Reduce CPA', (r) => n(r.limits?.reduce)], hardStop: ['Hard Stop CPA', (r) => n(r.limits?.hardStop)], stock: ['المخزون', (r) => n(r.stock?.status)], profit: ['الربح التقديري', (r) => n(r.profit?.value)], automation: ['حالة الأتمتة', (r) => r.automation], lastRunDays: ['مدة آخر تشغيل (أيام)', (r) => n(r.lastRun?.days)], losingDays: ['أيام خسارة', (r) => n(r.losingDays)], approval: ['حالة الموافقة', (r) => r.approval.label], eligibility: ['الأهلية (خطة اليوم)', (r) => r.eligibility], lastSyncMin: ['عمر آخر مزامنة (د)', (r) => r.dataAgeMin], fresh: ['حداثة البيانات', (r) => (r.dataFresh ? 'حديثة' : 'قديمة')],
  lastPause: ['آخر إيقاف (قبل أيام)', (r) => n(r.lastPause?.daysAgo)], pauseReason: ['سبب آخر إيقاف', (r) => n(r.lastPause?.reason)], lastBudgetChange: ['آخر تعديل ميزانية (قبل أيام)', (r) => n(r.lastBudgetChange?.daysAgo)],
};
const DEFAULT_COLS = ['name', 'id', 'account', 'product', 'status', 'budget', 'spendToday', 'ordersToday', 'spendPeriod', 'ordersPeriod', 'cpaPeriod', 'winner', 'approval', 'eligibility', 'fresh'];
const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
export async function exportCampaignsCsv({ access, body, now = new Date() }) {
  const cols = (Array.isArray(body?.columns) ? body.columns : DEFAULT_COLS).filter((k) => EXPORT_COLUMNS[k]); const useCols = cols.length ? cols : DEFAULT_COLS;
  const { q, rows } = await matchingRows({ access, body, now, noCache: true });
  let list = rows; if (Array.isArray(body?.campaignIds) && body.campaignIds.length) { const want = new Set(body.campaignIds.map(String)); list = rows.filter((r) => want.has(r.campaignId)); }
  if (Array.isArray(body?.excludeIds) && body.excludeIds.length) { const no = new Set(body.excludeIds.map(String)); list = list.filter((r) => !no.has(r.campaignId)); } // «all matching, except these»
  if (list.length > EXPORT_MAX) { const e = new Error(`النتائج ${list.length} حملة — أكتر من حد التصدير (${EXPORT_MAX}). ضيّق الفلاتر.`); e.status = 413; e.code = 'TOO_MANY'; throw e; }
  const lines = [useCols.map((k) => cell(EXPORT_COLUMNS[k][0])).join(','), ...list.map((r) => useCols.map((k) => cell(EXPORT_COLUMNS[k][1](r))).join(','))];
  return { csv: '﻿' + lines.join('\r\n'), count: list.length, filename: `campaigns-${q.period.from}_${q.period.to}.csv` };
}
