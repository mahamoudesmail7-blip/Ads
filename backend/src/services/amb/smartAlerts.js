// 🚨 Smart Alerts — ten operational situations the owner must know about, raised through the EXISTING AmbAlert system (raiseAlert) with a stable dedupe key so a still-true
// condition never produces a new alert every cycle. detectSmartAlerts() is PURE (inputs → alert specs); runSmartAlerts() gathers real inputs, detects and raises. Nothing here executes anything.
import { prisma } from '../../prisma.js';
import { raiseAlert } from './alerts.js';

const day = (now) => now.toISOString().slice(0, 10);
const bucket = (now, hours) => Math.floor(now.getTime() / (hours * 3_600_000));
export const SMART_ALERT_TYPES = ['CPA_SPIKE', 'ZERO_ORDERS_WITH_SPEND', 'META_SYNC_FAILURE', 'STALE_DATA', 'MANUAL_BUDGET_CHANGE', 'FAILED_OR_UNVERIFIED_ACTION', 'MISSING_PRODUCT_MAPPING', 'CONFIRMED_STOCK_OUT', 'ACCOUNT_SPEND_CAP_EXCEEDED', 'SCHEDULER_CONFLICT'];

/** Pure detection. rows = optimizer rows (active campaigns with m3/m7); everything else is plain data. Returns [{type, severity, key, title, message, campaignId?}] */
export function detectSmartAlerts({ now = new Date(), rows = [], zeroSpend = 200, syncRuns = [], syncStatus = null, syncIntervalMin = 15, manualBudgetEvents = [], actions = [], caps = null, accountBudgetTotal = null, external = null } = {}) {
  const out = []; const push = (a) => out.push({ category: 'OPERATOR', ...a });
  for (const r of rows) {
    const name = r.campaign || r.campaignId; const m3 = r.m3 || {}, m7 = r.m7 || {};
    if ((m3.purchases ?? 0) >= 3 && m7.cpa > 0 && m3.cpa >= m7.cpa * 1.5 && (m3.spend ?? 0) >= 300) push({ type: 'CPA_SPIKE', severity: 'WARNING', campaignId: r.campaignId, key: `smart:CPA_SPIKE:${r.campaignId}:${day(now)}`, title: `ارتفاع مفاجئ في CPA: ${name}`, message: `CPA آخر 3 أيام ${Math.round(m3.cpa)} مقابل ${Math.round(m7.cpa)} على 7 أيام (${m3.purchases} أوردر، صرف ${Math.round(m3.spend)}). راجع الحملة — ده مؤشر، مش سبب مؤكد.` });
    if ((m3.purchases ?? 0) === 0 && (m3.spend ?? 0) >= zeroSpend) push({ type: 'ZERO_ORDERS_WITH_SPEND', severity: 'WARNING', campaignId: r.campaignId, key: `smart:ZERO_ORDERS:${r.campaignId}:${day(now)}`, title: `صرف بدون أوردرات: ${name}`, message: `صرف ${Math.round(m3.spend)} في آخر 3 أيام بدون أي أوردر (الحد ${zeroSpend}). مرشحة للإيقاف حسب السياسة بعد فترة السماح.` });
    if ((r.guards || []).some((g) => /^STOCK_(OUT|TOO_LOW)\[B\]/.test(g))) push({ type: 'CONFIRMED_STOCK_OUT', severity: 'CRITICAL', campaignId: r.campaignId, key: `smart:STOCK_OUT:${r.campaignId}:${day(now)}`, title: `مخزون صفر مؤكد على حملة شغالة: ${name}`, message: 'المنتج مخزونه صفر (مؤكد) والحملة لسه شغالة — مفيش فتح أو توسع، وراجع الإيقاف.' });
  }
  const unmapped = rows.filter((r) => r.mapping && r.mapping !== 'VERIFIED' && (r.m3?.spend ?? 0) >= 200);
  if (unmapped.length) push({ type: 'MISSING_PRODUCT_MAPPING', severity: 'WARNING', key: `smart:MAPPING:${day(now)}`, title: `${unmapped.length} حملة بتصرف بدون ربط منتج موثّق`, message: `${unmapped.slice(0, 5).map((r) => r.campaign || r.campaignId).join('، ')}${unmapped.length > 5 ? ' …' : ''} — مفيش قرارات تنفيذ عليها لحد ما الربط يتوثّق.` });
  const last2 = syncRuns.slice(0, 2);
  if (last2.length === 2 && last2.every((s) => s.status === 'FAILED')) push({ type: 'META_SYNC_FAILURE', severity: 'CRITICAL', key: `smart:SYNC_FAIL:${bucket(now, 3)}`, title: 'فشل مزامنة Meta مرتين ورا بعض', message: `آخر خطأ: ${String(last2[0].error || '—').slice(0, 160)}. الأرقام اللي بتشوفها ممكن تكون قديمة.` });
  if (syncStatus?.lastSuccessAt) { const ageMin = (now.getTime() - new Date(syncStatus.lastSuccessAt).getTime()) / 60_000; if (ageMin > syncIntervalMin * 3) push({ type: 'STALE_DATA', severity: 'WARNING', key: `smart:STALE:${bucket(now, 3)}`, title: 'بيانات Meta قديمة', message: `آخر مزامنة ناجحة من ${Math.round(ageMin)} دقيقة (المتوقع كل ${syncIntervalMin}). التنفيذ والاعتماد بيتمنعوا على بيانات قديمة.` }); }
  for (const e of manualBudgetEvents) push({ type: 'MANUAL_BUDGET_CHANGE', severity: 'INFO', campaignId: e.campaignId, key: `smart:MANUAL_BUDGET:${e.id}`, title: `تعديل ميزانية يدوي: ${e.campaignName || e.campaignId}`, message: `${e.note || 'اتغيّرت الميزانية من Meta مباشرة'} — النظام سجّله كـManual Override وبدأ فترة تهدئة.` });
  for (const a of actions) push({ type: 'FAILED_OR_UNVERIFIED_ACTION', severity: a.failed ? 'CRITICAL' : 'WARNING', campaignId: a.campaignId, key: `smart:ACTION:${a.id}:${a.failed ? 'F' : 'U'}`, title: `${a.failed ? 'أكشن فشل' : 'أكشن غير مؤكد'}: ${a.name || a.campaignId}`, message: `${a.type} — ${a.failed ? 'فشل التنفيذ' : 'اتبعت لكن قراءة Meta ما أكدتش'}. راجع الحملة في Meta يدويًا؛ مفيش إعادة إرسال تلقائي.` });
  if (caps?.account != null && accountBudgetTotal != null && accountBudgetTotal > caps.account) push({ type: 'ACCOUNT_SPEND_CAP_EXCEEDED', severity: 'CRITICAL', key: `smart:ACCOUNT_CAP:${day(now)}`, title: 'إجمالي ميزانيات الحساب فوق الحد', message: `إجمالي الميزانيات اليومية للحملات الشغالة ${Math.round(accountBudgetTotal)} وحد الحساب ${caps.account}. أي زيادة هتتمنع.` });
  if (external?.detected) push({ type: 'SCHEDULER_CONFLICT', severity: 'INFO', key: `smart:SCHED_CONFLICT:${day(now)}`, title: 'روتين فتح/إيقاف يدوي ثابت التوقيت', message: `${external.changes} تغيير على ${external.campaigns} حملة آخر 7 أيام بتوقيت ثابت — نسّقه مع جدولي 12 ص و1 ظ عشان ما يتعارضوش.` });
  return out;
}

/** Gathers the real inputs, detects, raises (deduped). deps lets tests inject every input. */
export async function runSmartAlerts({ now = new Date(), rows = [], policy = null, deps = {} } = {}) {
  const [{ getSyncStatus }, { getBudgetCaps, currentBudgetTotals }, { detectExternalSchedule }] = await Promise.all([import('./snapshotSync.js'), import('./budgetCaps.js'), import('./dailyPlans.js')]);
  const since = new Date(now.getTime() - 70 * 60_000);
  const syncRuns = deps.syncRuns || await prisma.ambSyncRun.findMany({ orderBy: { id: 'desc' }, take: 3, select: { status: true, error: true } });
  const syncStatus = deps.syncStatus || await getSyncStatus().catch(() => null);
  const manualBudgetEvents = deps.manualBudgetEvents || (await prisma.ambOperatorEvent.findMany({ where: { kind: 'MANUAL_OVERRIDE', created_at: { gte: since } }, select: { id: true, campaign_id: true, note: true, data_json: true } })).filter((e) => { try { return JSON.parse(e.data_json || '{}').field === 'budget'; } catch { return false; } }).map((e) => ({ id: e.id, campaignId: e.campaign_id, note: e.note }));
  const actionRows = deps.actions || (await prisma.ambAction.findMany({ where: { created_at: { gte: new Date(now.getTime() - 24 * 3_600_000) }, action_type: { in: ['RESUME', 'PAUSE', 'INCREASE_BUDGET', 'DECREASE_BUDGET'] }, NOT: { OR: [{ entity_id: { startsWith: '__optest_' } }, { ad_account_id: { startsWith: '__optest_' } }] } }, select: { id: true, action_type: true, execution_status: true, verify_json: true, entity_name: true, campaign_id: true } }))
    .filter((a) => a.execution_status === 'FAILED' || (a.execution_status === 'EXECUTED' && (() => { try { return JSON.parse(a.verify_json || '{}').verified === false; } catch { return false; } })()))
    .map((a) => ({ id: a.id, type: a.action_type, failed: a.execution_status === 'FAILED', name: a.entity_name, campaignId: a.campaign_id }));
  const caps = deps.caps || await getBudgetCaps();
  let accountBudgetTotal = deps.accountBudgetTotal ?? null;
  if (accountBudgetTotal == null && caps.account != null && rows.length) { try { accountBudgetTotal = (await currentBudgetTotals({ adAccountId: rows[0].adAccountId, campaignId: rows[0].campaignId, now })).account; } catch { /* no totals — no cap alert */ } }
  const external = deps.external !== undefined ? deps.external : await detectExternalSchedule({}).catch(() => null);
  const specs = detectSmartAlerts({ now, rows, zeroSpend: policy?.zeroOrders?.spend ?? 200, syncRuns, syncStatus, syncIntervalMin: syncStatus?.intervalMinutes ?? 15, manualBudgetEvents, actions: actionRows, caps, accountBudgetTotal, external });
  const raised = [];
  for (const s of specs) { const a = await raiseAlert({ severity: s.severity, category: s.category, title: s.title, message: s.message, campaignId: s.campaignId, entityId: s.campaignId, dedupeKey: s.key }); if (a) raised.push({ type: s.type, key: s.key }); }
  return { detected: specs.length, raised: raised.length, types: [...new Set(specs.map((s) => s.type))], keys: specs.map((s) => s.key) };
}
