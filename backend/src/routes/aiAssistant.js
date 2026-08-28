// AI E-Commerce Operating System — the real AI Assistant (AI Command
// Center's chat + quick actions) and the deterministic Daily Briefing.
// Phase 1: read-only. The assistant NEVER touches Prisma directly — every
// fact it can cite comes from services/aiTools.js's tool layer, called
// through a real Anthropic tool-use loop (services/ai.js runAgentTurn).
// Every tool call AND every assistant turn is written to AiAuditLog —
// this is the real audit trail the spec requires, not a UI mockup.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { runAgentTurn } from '../services/ai.js';
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
6. لو Tool رجع hasData:false أو ok:false، قول للمستخدم بصراحة إن مفيش بيانات كفاية بدل ما تحاول تجاوب من غير بيانات.`;

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
    const { message } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'اكتب سؤال أو طلب الأول.' });
    }

    let result;
    try {
      result = await runAgentTurn({
        system: SYSTEM_PROMPT,
        userMessage: message.trim(),
        tools: TOOL_DEFINITIONS,
        executeTool: async (name, input) => {
          const impl = TOOL_IMPLS[name];
          if (!impl) throw new Error(`Tool غير معروف: ${name}`);
          const output = await impl(input);
          await logAudit({ actorId: req.user.id, kind: 'TOOL_CALL', toolName: name, input, output, success: output?.ok !== false, error: output?.ok === false ? output.error : null });
          return output;
        },
      });
    } catch (err) {
      await logAudit({ actorId: req.user.id, kind: 'ASSISTANT_TURN', input: { message }, success: false, error: err.message });
      return res.status(400).json({ error: 'AI_ERROR', message: err.message });
    }

    await logAudit({ actorId: req.user.id, kind: 'ASSISTANT_TURN', input: { message }, output: { toolCalls: result.toolCalls.map((c) => c.name), textLength: result.text.length } });

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
