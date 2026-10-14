// «إيه اللي اتفتح» — read-only report of the OPEN plans that actually ran (automatic or approved by hand): one row per campaign with the result Meta confirmed, why a campaign was skipped, the CPA / orders the
// decision was based on, the daily budget and who approved. Reads the plan tables only (no Meta call, nothing written). Also the CSV of the same rows (Excel opens the UTF-8 BOM file directly; a cell that starts with = + - @ is
// prefixed so a spreadsheet can never run it as a formula).
import { prisma } from '../../prisma.js';
import { cairoDate } from './dailyPlanTime.js';

export const REPORT_MAX_DAYS = 92; export const REPORT_MAX_ROWS = 5000;
const YMD = /^\d{4}-\d{2}-\d{2}$/; const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const RESULT_AR = { VERIFIED: 'اتفتحت — Meta أكد', SENT: 'اتبعتت — مستنية تأكيد Meta', SIMULATED: 'محاكاة — مفيش كتابة على Meta', FAILED: 'فشلت', SKIPPED: 'اتخطّت', BLOCKED: 'اتمنعت', UNCERTAIN: 'غير مؤكدة — راجع Meta', REVALIDATING: 'جاري التحقق' };
export const REASON_AR = { ALREADY_ACTIVE: 'كانت شغالة أصلًا', STOCK_BELOW_MIN: 'المخزون أقل من الحد الأدنى', EXPOSURE_CAP: 'هتتجاوز سقف الميزانيات المعرضة', MANUAL_PAUSE_PROTECTED: 'اتقفلت يدويًا مؤخرًا', DAY_NOT_ALLOWED: 'اليوم مش ضمن أيام الفتح', OUT_OF_SCOPE: 'خارج نطاق السياسة', EXCLUDED_BY_POLICY: 'مستبعدة بالسياسة', DATA_STALE: 'بيانات Meta قديمة' };
const cpaOf = (m) => (m && m.cpa != null && Number.isFinite(Number(m.cpa)) ? Number(m.cpa) : m && Number(m.purchases) > 0 && m.spend != null ? Math.round(Number(m.spend) / Number(m.purchases)) : null);
const round = (v) => (v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));

/** @returns {{from,to,rows,totals}} — rows newest first. Only plans that STARTED executing (APPROVED / RUNNING / COMPLETED) and items that were actually attempted (status ≠ PENDING). Simulated plans are excluded. */
export async function openCpaReport({ from = null, to = null, now = new Date() } = {}) {
  const today = cairoDate(now); const end = to || today; const start = from || addDays(end, -6);
  if (!YMD.test(start) || !YMD.test(end)) { const e = new Error('التاريخ لازم يكون بصيغة YYYY-MM-DD.'); e.status = 400; throw e; }
  if (start > end) { const e = new Error('تاريخ البداية لازم يكون قبل أو يساوي النهاية.'); e.status = 400; throw e; }
  if ((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1 > REPORT_MAX_DAYS) { const e = new Error(`الفترة أطول من ${REPORT_MAX_DAYS} يوم.`); e.status = 400; throw e; }
  const plans = await prisma.ambDailyPlan.findMany({ where: { type: 'OPEN', simulated: false, plan_date: { gte: start, lte: end }, status: { in: ['APPROVED', 'RUNNING', 'COMPLETED'] } }, orderBy: [{ plan_date: 'desc' }, { id: 'desc' }], include: { items: { where: { status: { not: 'PENDING' } }, orderBy: { rank: 'asc' } } } });
  const rows = [];
  for (const p of plans) {
    const auto = p.approval_mode === 'AUTOPILOT'; const used = j(p.evidence_json, {})?.openCpa || null;
    for (const it of p.items) {
      const ev = j(it.evidence_json, {}) || {}; const cp = ev.cpaPolicy || null; const reasonCode = it.status_reason || '';
      rows.push({ date: p.plan_date, at: it.status_at || p.finished_at || p.approved_at, planId: p.id, planKey: p.plan_key, by: auto ? 'AUTOMATIC' : 'MANUAL', byLabel: auto ? 'تلقائي' : 'يدوي (بموافقتك)', executionMode: p.execution_mode,
        campaignId: it.campaign_id, campaignName: it.campaign_name, productId: it.product_id, productName: it.product_name, storeId: it.store_id,
        cpa: cp?.cpa ?? null, orders: cp?.purchases ?? null, cpaWindow: cp?.window ?? used?.window ?? null, cpa7: round(cpaOf(ev.m7)), orders7: ev.m7?.purchases ?? null, cpa30: round(cpaOf(ev.m30)), orders30: ev.m30?.purchases ?? null,
        budget: ev.budget ?? null, policyVersion: used?.version ?? cp?.version ?? null, status: it.status, result: RESULT_AR[it.status] || it.status, reason: REASON_AR[reasonCode] || reasonCode || '', ambActionId: it.amb_action_id ?? null });
    }
  }
  const by = (st) => rows.filter((r) => r.status === st).length; const opened = rows.filter((r) => r.status === 'VERIFIED');
  const totals = { rows: rows.length, opened: opened.length, alreadyActive: rows.filter((r) => r.status === 'SKIPPED' && r.reason === REASON_AR.ALREADY_ACTIVE).length, skipped: by('SKIPPED'), failed: by('FAILED'), blocked: by('BLOCKED'), uncertain: by('UNCERTAIN'), sent: by('SENT'),
    automatic: opened.filter((r) => r.by === 'AUTOMATIC').length, manual: opened.filter((r) => r.by === 'MANUAL').length, openedDailyBudget: opened.reduce((t, r) => t + (Number(r.budget) || 0), 0) };
  return { from: start, to: end, today, rows, totals };
}

const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
const COLS = [['التاريخ', (r) => r.date], ['الوقت (UTC)', (r) => (r.at ? new Date(r.at).toISOString().replace('T', ' ').slice(0, 19) : '')], ['اتنفذت بواسطة', (r) => r.byLabel], ['المنتج', (r) => r.productName], ['الحملة', (r) => r.campaignName], ['Campaign ID', (r) => r.campaignId], ['المتجر', (r) => r.storeId],
  ['CPA (فترة السياسة)', (r) => r.cpa], ['أوردرات (فترة السياسة)', (r) => r.orders], ['فترة السياسة', (r) => r.cpaWindow], ['CPA 7 أيام', (r) => r.cpa7], ['أوردرات 7 أيام', (r) => r.orders7], ['CPA 30 يوم', (r) => r.cpa30], ['أوردرات 30 يوم', (r) => r.orders30],
  ['الميزانية اليومية', (r) => r.budget], ['النتيجة', (r) => r.result], ['السبب', (r) => r.reason], ['نسخة السياسة', (r) => r.policyVersion], ['رقم الخطة', (r) => r.planId], ['رقم الإجراء', (r) => r.ambActionId]];
export async function openCpaReportCsv({ from = null, to = null, now = new Date() } = {}) {
  const rep = await openCpaReport({ from, to, now });
  if (rep.rows.length > REPORT_MAX_ROWS) { const e = new Error(`النتائج ${rep.rows.length} صف — أكتر من حد التصدير (${REPORT_MAX_ROWS}). ضيّق الفترة.`); e.status = 413; throw e; }
  const lines = [COLS.map(([h]) => cell(h)).join(','), ...rep.rows.map((r) => COLS.map(([, f]) => cell(f(r))).join(','))];
  return { csv: '﻿' + lines.join('\r\n'), count: rep.rows.length, filename: `open-by-cpa-${rep.from}_${rep.to}.csv`, report: rep };
}
