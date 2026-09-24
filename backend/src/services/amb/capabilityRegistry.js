// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 18: Capability Registry. A single, machine-readable list of every
// real capability in the system — what it does, whether it's READ/PREPARE/
// EXECUTE, who is allowed to use it, whether it needs human approval, and
// whether it passes through Money Guard / the Data Quality Gate.
//
// Chat-tool capabilities are DERIVED directly from the real, live
// TOOL_DEFINITIONS/WRITE_TOOL_DEFINITIONS/WRITE_TOOL_META arrays — never a
// hand-typed duplicate list that could silently drift out of sync when a
// new tool is added. Only the UI-only capabilities (pages/actions with no
// chat tool at all — Clone & Schedule, Settings, Media upload, etc.) are
// hand-catalogued below, since nothing else in the codebase enumerates them.
//
// "تقدر تعمل إيه؟" must always call get_capabilities (aiTools.js) and
// answer FROM this real, live list — never from memory or a static
// hardcoded reply (routes/aiAssistant.js system prompt rule enforces this).
import { TOOL_DEFINITIONS } from '../aiTools.js';
import { WRITE_TOOL_DEFINITIONS, WRITE_TOOL_META } from '../aiToolsWrite.js';

// Manual category + canonical-service map for chat tools — the ONE place
// that needs updating when a new tool's category isn't obvious from its
// name. Falls back to 'Growth Intelligence' (the majority case) when a
// name isn't listed, so a forgotten entry never disappears from the
// registry — it just gets a slightly generic category until fixed here.
const TOOL_CATEGORY = {
  get_campaign_performance: 'Reports', get_decisions_summary: 'Reports', get_product_profit: 'Reports',
  get_order_metrics: 'Reports', get_lost_orders_summary: 'Reports', get_inventory_status: 'Reports',
  get_amb_product_performance: 'Smart Decision Center', get_amb_product_decision: 'Smart Decision Center',
  get_testing_brain: 'Experiments', prepare_test: 'Experiments', prepare_price_test: 'Experiments', get_price_test_status: 'Experiments',
  get_product_playbook: 'Learning',
  get_scale_ladder: 'Scale Center', get_amb_audience_breakdown: 'Scale Center', get_amb_governorate_breakdown: 'Scale Center',
  get_amb_scale_center_product: 'Scale Center', get_amb_bump_preview: 'Scale Center', prepare_bump: 'Scale Center', prepare_scale: 'Scale Center',
  get_scale_winners: 'Scale Center', prepare_scale_winner: 'Scale Center',
  generate_angles: 'Creative Library', generate_hooks: 'Creative Library', generate_creative_brief: 'Creative Library', get_amb_creative_intel: 'Creative Library',
  prepare_pause: 'Action Plan', prepare_resume: 'Action Plan',
  prepare_campaign: 'Campaign Builder', generate_campaign_copy: 'Campaign Builder',
  get_incidents: 'Incidents',
  get_my_recent_tasks: 'Tasks', get_task_progress: 'Tasks', retry_task: 'Tasks', cancel_task: 'Tasks',
};
const TOOL_MONEY_GUARD = new Set(['prepare_bump', 'prepare_scale', 'prepare_test', 'prepare_campaign']);
const TOOL_DATA_QUALITY_GATE = new Set([
  'get_amb_product_decision', 'get_growth_plan', 'get_targeting_strategy', 'get_testing_brain', 'get_cod_quality',
  'get_product_playbook', 'get_scale_ladder', 'get_incidents', 'get_daily_brief', 'prepare_scale', 'prepare_test',
]);
// Only ADMIN can actually approve/execute a write; MANAGER can read and
// prepare (see /chat's own requireRole and the ADMIN-only approve route).
const WRITE_KIND_LABEL = { PREPARE: 'تجهيز يحتاج موافقتك', EXECUTE: 'تنفيذ فوري (بدون كتابة على Meta)', READ: 'قراءة فقط' };

function extractArabicName(description) {
  const m = /^\[([^\]]+)\]/.exec(description || '');
  return m ? m[1] : null;
}

function chatToolCapabilities() {
  const out = [];
  for (const def of TOOL_DEFINITIONS) {
    out.push({
      id: def.name,
      name: extractArabicName(def.description) || def.name,
      description: def.description,
      category: TOOL_CATEGORY[def.name] || 'Growth Intelligence',
      surface: 'CHAT_TOOL',
      tier: 'READ',
      authorization: 'ADMIN|MANAGER',
      requiresApproval: false,
      requiresMoneyGuard: TOOL_MONEY_GUARD.has(def.name),
      requiresDataQualityGate: TOOL_DATA_QUALITY_GATE.has(def.name),
      verificationMethod: 'real-data test script + production read',
    });
  }
  for (const def of WRITE_TOOL_DEFINITIONS) {
    const meta = WRITE_TOOL_META[def.name] || {};
    out.push({
      id: def.name,
      name: extractArabicName(def.description) || def.name,
      description: def.description,
      category: TOOL_CATEGORY[def.name] || 'Growth Intelligence',
      surface: 'CHAT_TOOL',
      tier: meta.tier || 'READ',
      authorization: meta.tier === 'READ' ? 'ADMIN|MANAGER' : 'MANAGER يجهّز، ADMIN يوافق وينفّذ',
      requiresApproval: !!meta.requiresApproval,
      requiresMoneyGuard: TOOL_MONEY_GUARD.has(def.name),
      requiresDataQualityGate: TOOL_DATA_QUALITY_GATE.has(def.name),
      verificationMethod: meta.writesToMeta === false && meta.tier !== 'READ' ? 'real prepare/approve cycle on disposable data + production verification' : 'real-data test script + production read',
    });
  }
  return out;
}

// UI-only capabilities — pages/actions with no chat tool today. Hand-
// catalogued because nothing in the codebase enumerates these the way
// TOOL_DEFINITIONS does for chat. Kept intentionally short: one row per
// distinct real capability, not one per page/button.
const UI_CAPABILITIES = [
  { id: 'ui_dashboard_overview', name: 'لوحة التحكم الرئيسية (KPIs + توصيات AI)', category: 'Dashboard', surface: 'UI_PAGE', tier: 'READ', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/amb/overview.js', verificationMethod: 'production browser check' },
  { id: 'ui_products_management', name: 'إدارة المنتجات (تكلفة/سعر/مخزون)', category: 'Products', surface: 'UI_PAGE', tier: 'EXECUTE', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'routes/products.js', verificationMethod: 'production browser check' },
  { id: 'ui_meta_connect', name: 'ربط/اختيار حساب Meta Ads', category: 'Meta', surface: 'UI_PAGE', tier: 'EXECUTE', authorization: 'ADMIN', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/metaAuth.js', verificationMethod: 'production OAuth flow' },
  { id: 'ui_meta_sync', name: 'مزامنة بيانات Meta الدورية (كل 15 دقيقة)', category: 'Meta', surface: 'BACKGROUND_JOB', tier: 'READ', authorization: 'SYSTEM', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/amb/snapshotSync.js', verificationMethod: 'AmbSyncRun status checks' },
  { id: 'ui_easyorders_sync', name: 'مزامنة طلبات Easy Orders', category: 'EasyOrders', surface: 'BACKGROUND_JOB', tier: 'READ', authorization: 'SYSTEM', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/easyOrders.js', verificationMethod: 'EasyOrdersOrder row counts' },
  { id: 'ui_decision_center', name: '🧠 مركز القرار الذكي (تشخيص + قرار لكل منتج)', category: 'Smart Decision Center', surface: 'UI_PAGE', tier: 'READ', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: true, canonicalService: 'services/amb/productDecision.js', verificationMethod: 'production browser check' },
  { id: 'ui_decision_approve', name: 'اعتماد قرار من مركز القرار الذكي', category: 'Smart Decision Center', surface: 'UI_PAGE', tier: 'EXECUTE', authorization: 'ADMIN', requiresApproval: true, requiresMoneyGuard: false, requiresDataQualityGate: true, canonicalService: 'services/amb/productDecision.js#approveProductDecision', verificationMethod: 'production browser check' },
  { id: 'ui_scale_center', name: '🚀 مركز التوسّع (كل منتج/Ad Set وهل مؤهل للتوسّع)', category: 'Scale Center', surface: 'UI_PAGE', tier: 'READ', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: true, canonicalService: 'services/amb/scaleCenter.js', verificationMethod: 'production browser check' },
  { id: 'ui_action_plan', name: 'خطة العمل (Action Plan) لكل منتج', category: 'Action Plan', surface: 'UI_PAGE', tier: 'READ', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: true, canonicalService: 'services/amb/productActionPlan.js', verificationMethod: 'production browser check' },
  { id: 'ui_campaign_builder', name: 'رفع كامبين جديد من الواجهة (بدون شات)', category: 'Campaign Builder', surface: 'UI_PAGE', tier: 'PREPARE', authorization: 'MANAGER يجهّز، ADMIN يوافق', requiresApproval: true, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/assistantTasks/launchCampaignPrepare.js', verificationMethod: 'production browser check' },
  { id: 'ui_media_upload', name: 'رفع فيديو/صورة كرياتيف', category: 'Media', surface: 'UI_PAGE', tier: 'EXECUTE', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/amb/launchBuilder.js', verificationMethod: 'production browser check' },
  { id: 'ui_media_library', name: 'مكتبة الكرياتيفات (كل الكرياتيف + الأداء)', category: 'Creative Library', surface: 'UI_PAGE', tier: 'READ', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/amb/mediaLibraryIntel.js', verificationMethod: 'production browser check' },
  { id: 'ui_recommendations', name: 'التوصيات المقترحة من محرك التوصيات الدوري', category: 'Recommendations', surface: 'UI_PAGE', tier: 'READ', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/amb/recommendationEngine.js', verificationMethod: 'production browser check' },
  { id: 'ui_recommendation_approve', name: 'اعتماد/تنفيذ توصية (زيادة ميزانية/إيقاف)', category: 'Recommendations', surface: 'UI_PAGE', tier: 'EXECUTE', authorization: 'ADMIN', requiresApproval: true, requiresMoneyGuard: true, requiresDataQualityGate: false, canonicalService: 'services/amb/executor.js', verificationMethod: 'production browser check + AmbAction verify-after-write' },
  { id: 'ui_clone_schedule', name: 'استنساخ حملة وجدولتها (تشغيل الآن أو موعد محدد)', category: 'Clone', surface: 'UI_PAGE', tier: 'EXECUTE', authorization: 'ADMIN', requiresApproval: true, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/amb/cloneEngine.js', verificationMethod: 'production browser check + AmbCloneAudit trail' },
  { id: 'ui_scheduling_native', name: 'جدولة Meta الأصلية (start_time حقيقي، صفر إنفاق قبل الميعاد)', category: 'Scheduling', surface: 'UI_PAGE', tier: 'EXECUTE', authorization: 'ADMIN', requiresApproval: true, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/amb/campaignSchedule.js', verificationMethod: 'production browser check' },
  { id: 'ui_reports_history', name: 'التقارير وسجل التنفيذ (قبل/بعد كل أكشن)', category: 'Reports', surface: 'UI_PAGE', tier: 'READ', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'routes/aiMediaBuyer.js#execution-history', verificationMethod: 'production browser check' },
  { id: 'ui_settings', name: 'إعدادات AI Media Buyer (حدود الميزانية، الأهداف، الأوضاع)', category: 'Settings', surface: 'UI_PAGE', tier: 'EXECUTE', authorization: 'ADMIN', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/amb/settings.js', verificationMethod: 'production browser check' },
  { id: 'ui_pmc_tests', name: 'اختبارات مركز التسويق الذكي (زاوية/Hook/سعر/جمهور)', category: 'Experiments', surface: 'UI_PAGE', tier: 'EXECUTE', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/amb/productMarketingTests.js', verificationMethod: 'production browser check' },
  { id: 'ui_product_learning', name: 'ذاكرة تعلّم المنتج (إيه اتجرب واتعلمنا منه)', category: 'Learning', surface: 'UI_PAGE', tier: 'READ', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/amb/productLearning.js', verificationMethod: 'production browser check' },
  { id: 'ui_task_history', name: '📋 صفحة المهام (نشطة/تنتظر موافقة/مكتملة/فشلت/ملغاة)', category: 'Tasks', surface: 'UI_PAGE', tier: 'READ', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/assistantTasks/taskEngine.js#listTasksByView', verificationMethod: 'production browser check (Slice 16)' },
  { id: 'ui_incidents_alerts', name: 'جرس التنبيهات (حوادث/فرص/تحذيرات)', category: 'Incidents', surface: 'UI_PAGE', tier: 'READ', authorization: 'ADMIN|MANAGER', requiresApproval: false, requiresMoneyGuard: false, requiresDataQualityGate: false, canonicalService: 'services/amb/alerts.js', verificationMethod: 'production browser check' },
];

let _cache = null;
export function listCapabilities() {
  if (_cache) return _cache;
  _cache = [...chatToolCapabilities(), ...UI_CAPABILITIES];
  return _cache;
}

export function capabilitySummary() {
  const all = listCapabilities();
  const byCategory = {};
  for (const c of all) {
    byCategory[c.category] = byCategory[c.category] || [];
    byCategory[c.category].push({ id: c.id, name: c.name, surface: c.surface, tier: c.tier, requiresApproval: c.requiresApproval });
  }
  return { total: all.length, categories: Object.keys(byCategory).sort(), byCategory };
}
