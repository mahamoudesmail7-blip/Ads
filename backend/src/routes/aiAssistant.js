// AI E-Commerce Operating System — the real AI Assistant (AI Command
// Center's chat + quick actions) and the deterministic Daily Briefing.
// Phase 1: read-only. The assistant NEVER touches Prisma directly — every
// fact it can cite comes from services/aiTools.js's tool layer, called
// through the central AI gateway's tool-use loop (services/aiGateway —
// OpenAI Responses API function-calling; services/aiTools.js's Anthropic-
// shaped tool defs are converted internally, unchanged here).
// Every tool call AND every assistant turn is written to AiAuditLog —
// this is the real audit trail the spec requires, not a UI mockup.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { runTools, TIERS } from '../services/aiGateway/index.js';
import { TOOL_DEFINITIONS, TOOL_IMPLS, get_decisions_summary, get_product_profit, get_order_metrics, get_lost_orders_summary, get_inventory_status } from '../services/aiTools.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'MANAGER'));

const SYSTEM_PROMPT = `إنت "محلل البزنس" — مساعد AI حقيقي جوه نظام إدارة تجارة إلكترونية (E-Commerce Operating System) لصاحب متجر مصري. بتتكلم عربي بس (مصري بسيط، مش فصحى).

قواعد صارمة:
1. أي رقم بتقوله (صرف، CPA، ROAS، أوردرات، ربح، ...) لازم يكون جاي من نتيجة استدعاء Tool حقيقي — ممنوع تمامًا تخترع أو تخمن رقم. لو مفيش بيانات كفاية، قول كده بصراحة.
2. لو السؤال محتاج بيانات، استدعي الـ Tool المناسب قبل ما ترد.
3. لو السؤال عن "أفضل حملة/منتج" أو "فين بنخسر" أو "فرص Scaling" أو أي تحليل قرار، رجّع الرد بالشكل ده بالظبط (بعد ما تجيب البيانات الحقيقية):

STATUS: [🟢 فرصة / 🔴 مشكلة / 🟡 تنبيه / ⚪ معلومة]
WHAT HAPPENED: [جملة أو اتنين تلخص اللي حصل]
DATA: [الأرقام الحقيقية اللي جبتها من الـ Tool]
WHY: [التفسير]
RECOMMENDATION: [توصية محددة وواضحة، مش عامة زي "راقب الأداء"]
CONFIDENCE: [عالية / متوسطة / منخفضة — حسب كفاية البيانات]

4. لو السؤال بسيط أو محادثة عادية، رد عادي من غير الشكل ده.
5. ممنوع تدّعي إنك نفّذت أي Action حقيقي (زي إيقاف حملة أو زيادة ميزانية) — النظام في المرحلة دي للقراءة والتحليل بس، مفيش Tools تنفيذية لسه. لو المستخدم طلب تنفيذ Action، قوله بصراحة إن ده مش متاح لسه في النظام.
6. لو Tool رجع hasData:false أو ok:false، قول للمستخدم بصراحة إن مفيش بيانات كفاية بدل ما تحاول تجاوب من غير بيانات.
7. فيه نوعين من الـ Tools: (أ) get_campaign_performance/get_decisions_summary/get_product_profit/get_order_metrics بتحسب من نظام تحليل عام للحملات، و(ب) get_amb_* (مركز القرار الذكي / مركز التوسّع) بتحسب من نظام تتبع منتج بمنتج منفصل وأدق. لو السؤال عن منتج معين وعن Scale/Bump/مركز القرار الذكي/مركز التوسّع، استخدم get_amb_* دايمًا وميزتها إنها الأحدث والأدق — ممنوع تخلط أرقام من النظامين في نفس الإجابة.
8. لو حابب تقترح تجهيز زيادة ميزانية (Bump) بعد ما تجيب get_amb_bump_preview وتلاقيه مناسب، ضيف سطر واحد بالظبط في آخر ردك بالشكل ده (JSON صالح، من غير أي نص زيادة فيه): ACTION_PROPOSAL: {"type":"PREPARE_BUMP","adSetId":"...","pct":25} — ده مجرد اقتراح يظهر زرار للمستخدم يوافق عليه بنفسه؛ إنت مش بتنفذ أي حاجة فعليًا وممنوع تدّعي إنك نفذتها.`;

/** Small, structured, per-page context the frontend bubble sends — appended to the system prompt as a clearly-labeled block, NEVER merged into the user's own message text, so the model can never confuse "what the user typed" with "what page they're on". */
function contextBlock(context) {
  if (!context || typeof context !== 'object') return '';
  const safe = JSON.stringify(context).slice(0, 1000);
  return `\n\nسياق الصفحة الحالية (بيانات حقيقية من الواجهة، مش من المستخدم): ${safe}`;
}

const MAX_HISTORY_TURNS = 12;
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 4000) }));
}

async function logAudit({ actorId, kind, action = 'READ', toolName = null, input, output, success = true, error = null }) {
  try {
    await prisma.aiAuditLog.create({
      data: {
        actor_id: actorId,
        kind,
        action,
        tool_name: toolName,
        input_json: input !== undefined ? JSON.stringify(input).slice(0, 4000) : null,
        output_json: output !== undefined ? JSON.stringify(output).slice(0, 4000) : null,
        success,
        error,
      },
    });
  } catch (err) {
    // Audit logging must never break the actual feature — log locally and move on.
    logger.error('AiAuditLog write failed', { message: err.message });
  }
}

router.post(
  '/chat',
  asyncRoute(async (req, res) => {
    // Legacy shape: {message}. New (floating global bubble) shape adds
    // optional history/context/image — all backward-compatible, so
    // js/ai-command-center.js's existing {message}-only calls are untouched.
    const { message, history, context, image } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'اكتب سؤال أو طلب الأول.' });
    }

    const safeHistory = sanitizeHistory(history);
    const system = SYSTEM_PROMPT + contextBlock(context);
    let userMessage = message.trim();
    if (image && typeof image.base64 === 'string' && image.base64) {
      userMessage = [
        { type: 'text', text: message.trim() },
        { type: 'image', source: { type: 'base64', media_type: image.mediaType || 'image/jpeg', data: image.base64 } },
      ];
    }

    logger.info('AI_REQUEST_STARTED', { actorId: req.user.id, messageLength: message.trim().length, historyTurns: safeHistory.length, hasImage: !!image, hasContext: !!context });

    let result;
    try {
      result = await runTools({
        feature: 'assistant.chat',
        tier: TIERS.BALANCED, // interactive multi-tool reasoning over real business data
        system,
        userMessage,
        history: safeHistory,
        tools: TOOL_DEFINITIONS,
        userId: req.user.id,
        executeTool: async (name, input) => {
          const impl = TOOL_IMPLS[name];
          if (!impl) throw new Error(`Tool غير معروف: ${name}`);
          const output = await impl(input);
          await logAudit({ actorId: req.user.id, kind: 'TOOL_CALL', toolName: name, input, output, success: output?.ok !== false, error: output?.ok === false ? output.error : null });
          return output;
        },
      });
    } catch (err) {
      logger.error('AI_REQUEST_FAILED', { actorId: req.user.id, message: err.message });
      await logAudit({ actorId: req.user.id, kind: 'ASSISTANT_TURN', input: { message, context }, success: false, error: err.message });
      return res.status(400).json({ error: 'AI_ERROR', message: err.message });
    }

    logger.info('AI_RESPONSE_COMPLETED', { actorId: req.user.id, toolCallCount: result.toolCalls.length, replyLength: result.text.length });

    await logAudit({ actorId: req.user.id, kind: 'ASSISTANT_TURN', input: { message, context }, output: { toolCalls: result.toolCalls.map((c) => c.name), textLength: result.text.length } });

    res.json({ reply: result.text, toolCalls: result.toolCalls.map((c) => c.name) });
  })
);

// Health scoring is deliberately deterministic (not an LLM call) — same
// principle as decisionEngine.js: the system computes the real classification,
// the AI (in /chat) only ever narrates on top of it. A health tier here is
// a plain threshold read on real numbers, never a guess.
// Generic 0-100 score → tier mapping, reused for both the marketing score
// (% of active entities that are SCALE/OPTIMIZE) and the orders score
// (confirmation rate %) — same thresholds fit both honestly.
function healthTier(scorePercent) {
  if (scorePercent === null || scorePercent === undefined) return { tier: 'UNKNOWN', label: 'مفيش بيانات كفاية' };
  if (scorePercent >= 70) return { tier: 'GOOD', label: 'كويس' };
  if (scorePercent >= 40) return { tier: 'WARN', label: 'محتاج انتباه' };
  return { tier: 'BAD', label: 'محتاج تدخل' };
}

router.get(
  '/daily-briefing',
  asyncRoute(async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const [decisions, profit, orders, lost, inventory] = await Promise.all([
      get_decisions_summary({}),
      get_product_profit({}),
      get_order_metrics({ dateFrom: today, dateTo: today }),
      get_lost_orders_summary(),
      get_inventory_status(),
    ]);

    const opportunities = [];
    const problems = [];

    if (decisions.ok && decisions.hasData && decisions.buckets) {
      for (const e of decisions.buckets.scale.slice(0, 3)) {
        opportunities.push({ type: 'SCALE', title: e.name, detail: `CPA ${e.cpa ?? '—'} جنيه`, reason: e.reason, action: e.recommendedAction });
      }
      for (const e of decisions.buckets.stop.slice(0, 3)) {
        problems.push({ type: 'STOP', title: e.name, detail: `صرف ${e.spend ?? '—'} جنيه`, reason: e.reason, action: e.recommendedAction });
      }
    }

    if (lost.ok && lost.new > 0) {
      problems.push({ type: 'LOST_ORDERS', title: `${lost.new} أوردر مفقود جديد`, detail: 'محتاج معالجة', reason: null, action: 'راجع صفحة الأوردرات المفقودة' });
    }
    if (inventory.ok && inventory.lowStockCount > 0) {
      problems.push({ type: 'INVENTORY', title: `${inventory.lowStockCount} منتج مخزونه منخفض`, detail: inventory.lowStock.slice(0, 3).map((p) => p.productName).join('، '), reason: null, action: 'راجع صفحة المخزون' });
    }

    const marketingScore = decisions.ok && decisions.hasData && decisions.totalEntities > 0
      ? Math.round(((decisions.buckets.scale.length + decisions.buckets.optimize.length) / decisions.totalEntities) * 100)
      : null;
    const ordersScore = orders.ok && orders.hasData && orders.confirmationRate !== null ? Math.round(orders.confirmationRate) : null;

    res.json({
      date: today,
      health: {
        marketing: { ...healthTier(marketingScore), score: marketingScore },
        orders: { ...healthTier(ordersScore), score: ordersScore },
        profit: { tier: profit.ok && profit.products?.length > 0 ? 'GOOD' : 'UNKNOWN', label: profit.ok && profit.products?.length > 0 ? `${profit.products.length} منتج ليه بيانات ربح حقيقية` : 'مفيش بيانات ربط كفاية' },
        inventory: inventory.ok ? { tier: inventory.lowStockCount === 0 ? 'GOOD' : 'WARN', label: inventory.lowStockCount === 0 ? 'كل المنتجات فوق الحد الأدنى' : `${inventory.lowStockCount} منتج تحت الحد الأدنى`, score: null } : { tier: 'UNKNOWN', label: 'مفيش بيانات' },
        lostOrders: lost.ok ? { tier: lost.new === 0 ? 'GOOD' : 'WARN', label: lost.new === 0 ? 'مفيش أوردرات مفقودة جديدة' : `${lost.new} أوردر مفقود جديد محتاج معالجة`, score: null } : { tier: 'UNKNOWN', label: 'مفيش بيانات' },
      },
      opportunities,
      problems,
    });
  })
);

export default router;
