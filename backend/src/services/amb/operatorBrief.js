// 📰 Daily AI Brief — a short, honest daily report where EVERY number states where it comes from and which period it covers. Reuses what already exists (buildDailyBrief for the account KPIs,
// the persisted optimizer decisions, the executed actions, the alert table); computes nothing a second way. Meta purchases are Pixel purchases — never presented as delivered orders.
import { prisma } from '../../prisma.js';
import { entityWindowMetrics, resolveWindow } from './metricsEngine.js';

const MS_H = 3_600_000;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const item = (key, label, value, source, window, extra = {}) => ({ key, label, value, source, window, ...extra });
let cache = null;

/** Pure: shapes the brief from already-gathered inputs (so it is testable and every number carries source + window). */
export function composeBrief({ now, kpis, freshness, campaignsToday, campaignsLast3, decisions, executed, pendingDecisions, pendingPlans, alerts, activeCampaigns, window }) {
  const winLabel = `${window?.from || 'اليوم'}${window?.to && window.to !== window.from ? ` → ${window.to}` : ''} (توقيت الحساب)`;
  const syncSrc = `Meta Insights — آخر مزامنة ناجحة ${freshness?.metaLastSuccessSyncAt ? new Date(freshness.metaLastSuccessSyncAt).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : 'غير معروفة'}`;
  const rank = (arr, by, dir) => [...arr].sort((a, b) => dir * (by(a) - by(b)));
  const best = rank(campaignsLast3.filter((c) => (c.purchases ?? 0) >= 3 && c.cpa > 0), (c) => c.cpa, 1).slice(0, 3);
  const worst = rank(campaignsLast3.filter((c) => (c.spend ?? 0) >= 200 && ((c.purchases ?? 0) === 0 || c.cpa > 200)), (c) => c.spend, -1).slice(0, 3);
  const by = (a) => decisions.filter((d) => d.action === a);
  const items = [
    item('activeCampaigns', 'الحملات النشطة', activeCampaigns, 'Meta Sync (حالة الحملات من آخر مزامنة)', 'الآن'),
    item('spend', 'إجمالي الإنفاق', kpis?.spend ?? null, syncSrc, winLabel),
    item('purchases', 'المشتريات المسجلة (Meta Pixel — مش أوردرات مسلّمة)', kpis?.metaPurchases ?? null, syncSrc, winLabel),
    item('avgCpa', 'متوسط CPA', kpis?.avgCpa ?? null, 'محسوب = الإنفاق ÷ مشتريات Meta من نفس المصدر', winLabel),
    item('bestCampaigns', 'أفضل الحملات (أقل CPA، 3+ أوردرات)', best.map((c) => ({ campaign: c.name, cpa: Math.round(c.cpa), purchases: c.purchases, spend: Math.round(c.spend) })), 'Meta Insights (snapshots)', 'آخر 3 أيام'),
    item('worstCampaigns', 'أسوأ الحملات (صرف ≥200 بدون أوردرات أو CPA>200)', worst.map((c) => ({ campaign: c.name, cpa: c.cpa ? Math.round(c.cpa) : null, purchases: c.purchases, spend: Math.round(c.spend) })), 'Meta Insights (snapshots)', 'آخر 3 أيام'),
    item('scaleOpportunities', 'فرص التوسع (قرارات زيادة مسجّلة)', by('SCALE_UP').length, 'قرارات Dynamic Budget المحفوظة (SHADOW/PREPARED)', 'آخر دورة تقييم'),
    item('pauseDecisions', 'قرارات الإيقاف المقترحة', by('PAUSE').length, 'قرارات Dynamic Budget المحفوظة (SHADOW/PREPARED)', 'آخر دورة تقييم'),
    item('reduceDecisions', 'قرارات تقليل الميزانية', by('SCALE_DOWN').length, 'قرارات Dynamic Budget المحفوظة (SHADOW/PREPARED)', 'آخر دورة تقييم'),
    item('executedActions', 'الإجراءات المنفذة فعليًا', executed.map((a) => ({ type: a.type, campaign: a.name, at: a.at, verified: a.verified })), 'سجل التنفيذ (AmbAction) — بقراءة Meta المستقلة', 'آخر 24 ساعة'),
    item('awaitingApproval', 'بانتظار موافقتك', { decisions: pendingDecisions, plans: pendingPlans }, 'مركز الموافقات (قرارات + خطط PREPARED)', 'الآن'),
    item('issues', 'مشاكل محتاجة تدخلك', alerts.map((a) => ({ severity: a.severity, title: a.title, at: a.at })), 'تنبيهات AmbAlert غير المقروءة (WARNING/CRITICAL)', 'آخر 24 ساعة'),
  ];
  return { generatedAt: now, items, caveat: 'مشتريات Meta ≠ أوردرات مسلّمة. الأرقام ديه للقراءة؛ أي تنفيذ بيمر بالموافقة والحواجز.' };
}

export async function buildOperatorBrief({ now = new Date(), deps = {}, force = false } = {}) {
  if (!force && !deps.kpis && cache && now.getTime() - cache.at < 5 * 60_000) return cache.v;
  const base = deps.base || await (await import('./dailyBrief.js')).buildDailyBrief({ windowName: 'today' }).catch(() => null);
  const adAccountId = deps.adAccountId || (await (await import('../metaAuth.js')).getConnection())?.selected_ad_account_id;
  const w3 = resolveWindow('last3');
  const m3 = deps.campaignsLast3 || (adAccountId ? await entityWindowMetrics({ level: 'campaign', from: w3.from, to: w3.to, adAccountId }, { minSpend: 0, minPurchases: 0 }).catch(() => new Map()) : new Map());
  const names = deps.names || new Map((await prisma.metaPerformanceSnapshot.findMany({ where: { level: 'campaign', ad_account_id: adAccountId || '' }, distinct: ['campaign_id'], orderBy: { snapshot_at: 'desc' }, select: { campaign_id: true, campaign_name: true }, take: 600 })).map((r) => [r.campaign_id, r.campaign_name]));
  const campaignsLast3 = deps.campaignsLast3Rows || [...m3.entries()].map(([id, m]) => ({ id, name: names.get(id) || id, spend: m.spend, purchases: m.purchases, cpa: m.cpa }));
  const dec = deps.decisions || (await prisma.ambOperatorDecision.findMany({ where: { rule_name: { startsWith: 'DYNAMIC_BUDGET:' }, status: { in: ['SHADOW', 'PREPARED'] } }, select: { action: true } }));
  const executedRows = deps.executed || (await prisma.ambAction.findMany({ where: { execution_status: 'EXECUTED', executed_at: { gte: new Date(now.getTime() - 24 * MS_H) }, action_type: { in: ['RESUME', 'PAUSE', 'INCREASE_BUDGET', 'DECREASE_BUDGET'] }, NOT: { OR: [{ entity_id: { startsWith: '__optest_' } }, { ad_account_id: { startsWith: '__optest_' } }] } }, select: { action_type: true, entity_name: true, executed_at: true, verify_json: true }, orderBy: { id: 'desc' }, take: 15 })).map((a) => ({ type: a.action_type, name: a.entity_name, at: a.executed_at, verified: j(a.verify_json, {})?.verified === true }));
  const pendingDecisions = deps.pendingDecisions ?? await prisma.ambOperatorDecision.count({ where: { status: 'PREPARED' } });
  const pendingPlans = deps.pendingPlans ?? await prisma.ambDailyPlan.count({ where: { status: 'PREPARED', simulated: false } });
  const alertRows = deps.alerts || (await prisma.ambAlert.findMany({ where: { read: false, severity: { in: ['CRITICAL', 'WARNING'] }, created_at: { gte: new Date(now.getTime() - 24 * MS_H) } }, orderBy: { created_at: 'desc' }, take: 6, select: { severity: true, title: true, created_at: true } })).map((a) => ({ severity: a.severity, title: a.title, at: a.created_at }));
  const activeCampaigns = deps.activeCampaigns ?? (adAccountId ? await (await import('./approvalCenter.js')).activeCampaignCount(adAccountId, { now }) : null);
  const v = composeBrief({ now, kpis: base?.ok === false ? null : base, freshness: base?.freshness, campaignsToday: null, campaignsLast3, decisions: dec, executed: executedRows, pendingDecisions, pendingPlans, alerts: alertRows, activeCampaigns, window: base?.window });
  if (!deps.kpis && !deps.base) cache = { at: now.getTime(), v };
  return v;
}
