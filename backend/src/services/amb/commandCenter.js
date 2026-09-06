// AI Media Buyer — daily command center: Account Health Score, "Needs Your
// Attention", and Autopilot Readiness. All DETERMINISTIC (no Claude). These
// power the top of the Overview tab so AI Media Buyer reads as a command
// center, not a report.
import { prisma } from '../../prisma.js';
import { getConnection } from '../metaAuth.js';
import { getAmbSettings } from './settings.js';
import { resolveWindow } from './metricsEngine.js';
import { buildHierarchy } from './hierarchyAnalysis.js';
import { economicsSummary, netProfitBundle } from './productEconomics.js';
import { codCountsForProduct } from './codOrders.js';
import { mappingOverview } from './mapping.js';
import { detectWinners } from './winnerDetection.js';

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function pct(x) { return Math.round(x * 100); }

/** Flatten every campaign/adset/ad node of a hierarchy. */
function nodes(tree) {
  const out = [];
  const walk = (node) => { out.push(node); for (const c of node.children || []) walk(c); };
  for (const p of tree.products || []) for (const c of p.children || []) walk(c);
  for (const c of tree.unmappedCampaigns || []) walk(c);
  return out;
}

/**
 * Account Health Score /100 — deterministic weighted factors, each returned
 * with its own sub-score + a plain reason, so the UI can show WHY.
 */
export async function getHealthScore({ windowName = 'last7' } = {}) {
  const connection = await getConnection();
  const settings = await getAmbSettings();
  if (!connection?.selected_ad_account_id) return { connected: false };
  const adAccountId = connection.selected_ad_account_id;
  const window = resolveWindow(windowName);

  const [tree, mapState, ambProducts, snapCount] = await Promise.all([
    buildHierarchy({ adAccountId, window, settings }),
    mappingOverview({ adAccountId }).catch(() => null),
    prisma.ambProduct.findMany({ where: { active: true } }),
    prisma.metaPerformanceSnapshot.count({ where: { ad_account_id: adAccountId } }),
  ]);
  const allNodes = nodes(tree);
  const activeNodes = allNodes.filter((x) => (x.metrics?.spend || 0) > 0);
  const totalSpend = activeNodes.reduce((s, x) => s + (x.metrics.spend || 0), 0) || 1;

  // Net profit across mapped products (real COD data).
  let productProfit = 0, productsWithNet = 0, productsProfitable = 0;
  for (const p of tree.products || []) {
    const prod = ambProducts.find((x) => String(x.id) === String(p.id));
    if (!prod?.product_id) continue;
    const cod = await codCountsForProduct({ productId: prod.product_id, from: window.from, to: window.to });
    const b = netProfitBundle(prod, { adSpend: p.metrics?.spend || 0, deliveredOrders: cod.delivered, returnedOrders: cod.returned });
    if (b.netProfit !== null) { productProfit += b.netProfit; productsWithNet++; if (b.netProfit >= 0) productsProfitable++; }
  }

  const colors = { GREEN: 0, YELLOW: 0, RED: 0, BLUE: 0, GRAY: 0 };
  for (const x of activeNodes) colors[x.status?.color || 'GRAY']++;
  const activeCount = activeNodes.length || 1;

  const wastedSpend = activeNodes.filter((x) => x.status?.color === 'RED').reduce((s, x) => s + (x.metrics.spend || 0), 0);
  const targetT = n(settings.ambDefaultTargetCpa) ?? 120;
  const withinTargetSpend = activeNodes.filter((x) => x.metrics.cpa !== null && x.metrics.cpa <= (n(x.econ?.targetCpa) ?? targetT) * 1.15).reduce((s, x) => s + (x.metrics.spend || 0), 0);

  // Fatigue: share of ad-level spend on FATIGUED/EARLY (from recommendations' reason_facts, cheap proxy: none computed here → use YELLOW ad nodes as a proxy).
  const adNodes = allNodes.filter((x) => x.level === 'ad' && (x.metrics?.spend || 0) > 0);
  const fatigueSpend = adNodes.filter((x) => x.status?.color === 'YELLOW').reduce((s, x) => s + (x.metrics.spend || 0), 0);
  const adSpend = adNodes.reduce((s, x) => s + (x.metrics.spend || 0), 0) || 1;

  const mappedSpendShare = mapState ? (() => {
    const mappedIds = new Set((mapState.mapped || []).map((m) => m.campaignId));
    const campNodes = allNodes.filter((x) => x.level === 'campaign' && (x.metrics?.spend || 0) > 0);
    const tot = campNodes.reduce((s, x) => s + x.metrics.spend, 0) || 1;
    const mapped = campNodes.filter((x) => mappedIds.has(x.id)).reduce((s, x) => s + x.metrics.spend, 0);
    return mapped / tot;
  })() : 0;

  const econComplete = ambProducts.length === 0 ? 0 : ambProducts.filter((p) => {
    const e = economicsSummary(p);
    return e.productCost > 0 && e.effectiveSellingPrice > 0 && e.targetCpa != null && (e.packagingCost != null || e.shippingCost != null);
  }).length / ambProducts.length;

  const factors = [
    { key: 'profitability', label: 'الربحية', weight: 20, score: productsWithNet === 0 ? 0.5 : clamp01(productsProfitable / productsWithNet),
      reason: productsWithNet === 0 ? 'مفيش بيانات ربح حقيقية لأي منتج مربوط.' : `${productsProfitable}/${productsWithNet} منتج مربوط رابح، صافي ${Math.round(productProfit)} ج.` },
    { key: 'cpa_health', label: 'صحة الـ CPA', weight: 20, score: clamp01(withinTargetSpend / totalSpend),
      reason: `${pct(withinTargetSpend / totalSpend)}% من الصرف على عناصر CPA بتاعها داخل الهدف.` },
    { key: 'wasted_spend', label: 'الصرف المهدر', weight: 15, score: clamp01(1 - wastedSpend / totalSpend),
      reason: wastedSpend > 0 ? `${Math.round(wastedSpend)} ج (${pct(wastedSpend / totalSpend)}%) صرف على عناصر خاسرة.` : 'مفيش صرف على عناصر خاسرة.' },
    { key: 'winner_pct', label: 'نسبة العناصر الرابحة', weight: 10, score: clamp01((colors.GREEN + colors.BLUE) / activeCount),
      reason: `${colors.GREEN + colors.BLUE}/${activeCount} عنصر نشط أخضر/أزرق.` },
    { key: 'stability', label: 'استقرار الحملات', weight: 10, score: clamp01(1 - colors.RED / activeCount),
      reason: `${colors.RED} عنصر نشط في المنطقة الحمراء.` },
    { key: 'creative_fatigue', label: 'إجهاد الكرييتف', weight: 10, score: clamp01(1 - fatigueSpend / adSpend),
      reason: `${pct(fatigueSpend / adSpend)}% من صرف الإعلانات على كرييتيفز مؤشراتها ضعيفة.` },
    { key: 'mapping', label: 'اكتمال ربط الحملات', weight: 8, score: clamp01(mappedSpendShare),
      reason: mapState ? `${pct(mappedSpendShare)}% من صرف الحملات مربوط بمنتج.` : 'مفيش بيانات ربط.' },
    { key: 'economics', label: 'اكتمال اقتصاديات المنتجات', weight: 7, score: clamp01(econComplete),
      reason: ambProducts.length === 0 ? 'مفيش منتجات معرّفة في AI Media Buyer.' : `${pct(econComplete)}% من المنتجات معرّف لها تكلفة+سعر+هدف CPA.` },
  ];

  const raw = factors.reduce((s, f) => s + f.score * f.weight, 0);
  const maxW = factors.reduce((s, f) => s + f.weight, 0);
  const score = Math.round((raw / maxW) * 100);
  const status = score >= 80 ? 'HEALTHY' : score >= 60 ? 'OK' : score >= 40 ? 'NEEDS_ATTENTION' : 'CRITICAL';
  const statusAr = { HEALTHY: 'صحّي', OK: 'مقبول', NEEDS_ATTENTION: 'يحتاج انتباه', CRITICAL: 'حرج' }[status];

  const topReasons = [...factors]
    .map((f) => ({ ...f, deduction: (1 - f.score) * f.weight }))
    .sort((a, b) => b.deduction - a.deduction)
    .slice(0, 4)
    .map((f) => ({ label: f.label, impact: Math.round(f.deduction), reason: f.reason }));

  return { connected: true, score, status, statusAr, window, factors: factors.map((f) => ({ key: f.key, label: f.label, weight: f.weight, scorePct: pct(f.score), reason: f.reason })), topReasons, snapshotRows: snapCount };
}

/**
 * "Needs Your Attention" — the prioritised daily to-do. Pulls the newest
 * recommendation batch + real data-gap checks and orders them P0..P3.
 */
export async function getNeedsAttention({ windowName = 'last7' } = {}) {
  const connection = await getConnection();
  if (!connection?.selected_ad_account_id) return { connected: false, items: [] };
  const adAccountId = connection.selected_ad_account_id;
  const settings = await getAmbSettings();

  const newest = await prisma.ambRecommendation.findFirst({ where: { ad_account_id: adAccountId }, orderBy: { created_at: 'desc' }, select: { batch_id: true } });
  const recs = newest ? await prisma.ambRecommendation.findMany({ where: { batch_id: newest.batch_id, status: 'PENDING' }, orderBy: [{ priority: 'asc' }] }) : [];

  const items = [];
  for (const r of recs) {
    const P = { P0: 'P0', P1: 'P1', P2: 'P2', P3: 'P3' }[r.priority] || 'P3';
    const head = r.priority === 'P0' ? 'خسارة فلوس' : r.decision === 'INCREASE_BUDGET' ? 'فرصة توسّع' : r.decision === 'DUPLICATE_WINNER' ? 'بطل اتكشف' : r.decision === 'TEST_NEW_CREATIVE' ? 'إجهاد كرييتف' : r.decision === 'REDUCE_BUDGET' ? 'تحسين مطلوب' : 'متابعة';
    items.push({
      priority: P, kind: 'RECOMMENDATION', recommendationId: r.id,
      title: `${head} — ${r.entity_name}`,
      detail: r.reason || `${r.decision} · CPA ${JSON.parse(r.current_metrics_json || '{}').cpa?.toFixed?.(1) || '—'} ج`,
      action: r.executable ? 'راجع التوصية واعمل موافقة/رفض' : 'راجع الخطة (أكشن مسودة)',
      cta: { tab: 'plan', recId: r.id },
    });
  }

  // Winner found (informational P1).
  try {
    const w = await detectWinners({ adAccountId, window: resolveWindow(windowName), settings });
    for (const [lvl, node] of Object.entries(w.winners)) {
      if (!node) continue;
      if (['creative', 'hook', 'ad'].includes(lvl)) {
        items.push({
          priority: 'P1', kind: 'WINNER',
          title: `بطل — ${{ creative: 'كرييتف', hook: 'هوك', ad: 'إعلان' }[lvl]}: ${node.name || node.label}`,
          detail: node.why || `CPA ${node.cpa?.toFixed?.(1) || '—'} ج`,
          action: 'اعمل نسخ/توسيع للعنصر الرابح',
          cta: { tab: 'winners' },
        });
        break; // one winner nudge is enough
      }
    }
  } catch { /* non-fatal */ }

  // Data-gap checks (P3).
  const products = await prisma.ambProduct.findMany({ where: { active: true } });
  for (const p of products) {
    const e = economicsSummary(p);
    const missing = [];
    if (!(e.productCost > 0)) missing.push('تكلفة المنتج');
    if (!(e.effectiveSellingPrice > 0)) missing.push('سعر البيع');
    if (e.targetCpa == null) missing.push('Target CPA');
    if (e.shippingCost == null && e.packagingCost == null) missing.push('تكلفة الشحن/التغليف');
    if (missing.length) items.push({ priority: 'P3', kind: 'DATA_GAP', title: `بيانات ناقصة — ${p.product_name}`, detail: `مفيش: ${missing.join('، ')}`, action: 'كمّل اقتصاديات المنتج', cta: { tab: 'products', productId: p.id } });
  }
  const mo = await mappingOverview({ adAccountId }).catch(() => null);
  if (mo && mo.unmapped.filter((c) => c.spend > 0).length) {
    const un = mo.unmapped.filter((c) => c.spend > 0).sort((a, b) => b.spend - a.spend);
    items.push({ priority: 'P3', kind: 'MAPPING', title: `${un.length} حملة عليها صرف مش مربوطة بمنتج`, detail: un.slice(0, 3).map((c) => c.campaignName).join('، '), action: 'اربط الحملات بمنتجاتها', cta: { tab: 'campaigns' } });
  }

  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  items.sort((a, b) => order[a.priority] - order[b.priority]);
  return { connected: true, count: items.length, items };
}

/**
 * Autopilot Readiness — informational %; NEVER enables autopilot. A checklist
 * of what should be true before autopilot is trusted, each weighted.
 */
export async function getAutopilotReadiness() {
  const connection = await getConnection();
  const settings = await getAmbSettings();
  if (!connection?.selected_ad_account_id) return { connected: false, readinessPct: 0, checklist: [] };
  const adAccountId = connection.selected_ad_account_id;

  const [execCount, execOk, execFail, h24Count, products, mo, snapAgg] = await Promise.all([
    prisma.ambAction.count(),
    prisma.ambAction.count({ where: { execution_status: 'EXECUTED' } }),
    prisma.ambAction.count({ where: { execution_status: 'FAILED' } }),
    prisma.ambActionResult.count({ where: { checkpoint: 'H24', result_class: { not: null } } }),
    prisma.ambProduct.findMany({ where: { active: true } }),
    mappingOverview({ adAccountId }).catch(() => null),
    prisma.metaPerformanceSnapshot.aggregate({ where: { ad_account_id: adAccountId }, _count: true, _min: { date_start: true }, _max: { date_start: true } }),
  ]);

  const econOk = products.filter((p) => { const e = economicsSummary(p); return e.productCost > 0 && e.effectiveSellingPrice > 0 && e.targetCpa != null; }).length;
  const mappedShare = mo ? (mo.counts.mapped / Math.max(1, mo.counts.mapped + mo.counts.suggested + mo.counts.unmapped)) : 0;
  const failRate = execCount > 0 ? execFail / execCount : 0;
  const daysCovered = snapAgg._min.date_start && snapAgg._max.date_start
    ? Math.round((new Date(snapAgg._max.date_start) - new Date(snapAgg._min.date_start)) / 86400000) + 1 : 0;

  const checklist = [
    { key: 'executed_decisions', label: '≥ 10 قرار اتنفّذ في وضع الموافقة', weight: 20, met: execOk >= 10, progress: Math.min(1, execOk / 10), detail: `${execOk}/10` },
    { key: 'h24_evals', label: '≥ 10 تقييم نتيجة H24', weight: 15, met: h24Count >= 10, progress: Math.min(1, h24Count / 10), detail: `${h24Count}/10` },
    { key: 'write_path', label: 'مسار الكتابة على Meta متحقق منه (≥ 1 تنفيذ ناجح)', weight: 15, met: execOk >= 1, progress: execOk >= 1 ? 1 : 0, detail: execOk >= 1 ? 'متحقق' : 'لسه' },
    { key: 'low_failure', label: 'نسبة فشل التنفيذ < 20%', weight: 15, met: execCount >= 3 && failRate < 0.2, progress: execCount >= 3 ? clamp01(1 - failRate / 0.2) : 0, detail: execCount >= 3 ? `${pct(failRate)}%` : 'عينة قليلة' },
    { key: 'product_economics', label: '≥ 1 منتج باقتصاديات كاملة', weight: 10, met: econOk >= 1, progress: econOk >= 1 ? 1 : 0, detail: `${econOk} منتج` },
    { key: 'target_cpa', label: 'Target CPA افتراضي معرّف', weight: 5, met: n(settings.ambDefaultTargetCpa) > 0, progress: n(settings.ambDefaultTargetCpa) > 0 ? 1 : 0, detail: `${settings.ambDefaultTargetCpa} ج` },
    { key: 'mapping', label: 'ربط الحملات مكتمل ≥ 80%', weight: 10, met: mappedShare >= 0.8, progress: clamp01(mappedShare / 0.8), detail: `${pct(mappedShare)}%` },
    { key: 'snapshots', label: 'تاريخ snapshots كافٍ (≥ 3 أيام و ≥ 200 صف)', weight: 10, met: daysCovered >= 3 && snapAgg._count >= 200, progress: clamp01(Math.min(daysCovered / 3, snapAgg._count / 200)), detail: `${daysCovered} يوم / ${snapAgg._count} صف` },
  ];
  const readinessPct = Math.round(checklist.reduce((s, c) => s + c.progress * c.weight, 0) / checklist.reduce((s, c) => s + c.weight, 0) * 100);

  return {
    connected: true,
    readinessPct,
    autopilotEnabled: settings.ambExecutionMode === 'AUTOPILOT', // for display only; the module never auto-flips this
    note: 'مؤشر إعلامي فقط — مش بيفعّل الأوتوبايلوت. التفعيل يدوي من الإعدادات بعد اختبار كافٍ في وضع الموافقة.',
    checklist,
  };
}
