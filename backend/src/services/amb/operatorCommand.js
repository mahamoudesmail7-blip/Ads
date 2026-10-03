// 💬 AI Operator — COMMAND CENTER. A command is NEVER executed raw: it compiles into exactly one of
//   QUERY        a read-only answer from persisted decisions / config
//   RULE_DRAFT   a disabled SHADOW rule shown for the owner's confirmation (same path as the Arabic rule builder)
//   EMERGENCY    a proposal the UI must confirm before the stop is applied
//   UNSUPPORTED  an honest "I can't do that from here"
// Nothing here writes or calls Meta.
import { parseArabicRule, validateRule } from './operatorRules.js';
import { listDecisions, operatorOverview } from './operatorReports.js';
import { getOperatorConfig, listRules, listExceptions } from './operatorStore.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[ً-ٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim();
const has = (t, ...ws) => ws.some((w) => t.includes(norm(w)));

export async function interpretCommand(text) {
  const raw = String(text || '').trim();
  const t = norm(raw);
  if (!t) return { kind: 'UNSUPPORTED', message: 'اكتب أمر أو سؤال.' };

  if (has(t, 'ايقاف فوري', 'وقف الطوارئ', 'وقف كل الاتمته', 'وقف الاتمته', 'emergency')) {
    return { kind: 'EMERGENCY', requiresConfirmation: true, message: 'ده هيوقف كل التنفيذ التلقائي فورًا (المراقبة بتكمل). أكد عشان يتفعّل.' };
  }
  // a rule-looking sentence ("لو ... وقف / افتح / زوّد ...") becomes a DRAFT rule, never a live one
  if (has(t, 'لو ', 'اذا ', 'عندما ', 'if ') && has(t, 'وقف', 'اقفل', 'افتح', 'شغل', 'زود', 'قلل', 'pause', 'open', 'scale')) {
    const p = parseArabicRule(raw);
    if (p.ok && p.rule) {
      const v = validateRule(p.rule);
      return { kind: 'RULE_DRAFT', requiresConfirmation: true, rule: p.rule, validation: v, notes: p.notes, message: 'اتحوّلت لقاعدة مسودّة (متوقفة + Shadow). راجعها وأكّد لو عايز تحفظها.' };
    }
    return { kind: 'UNSUPPORTED', message: `مقدرتش أحوّل الجملة لقاعدة واضحة. ${p.notes?.join(' ') || ''}`.trim(), notes: p.notes };
  }
  if (has(t, 'ايه', 'اي', 'عرض', 'وريني', 'فين') && has(t, 'اتوقف', 'ايقاف', 'وقف', 'pause')) {
    const rows = await listDecisions({ bucket: 'pause', limit: 20 });
    return { kind: 'QUERY', title: 'الحملات المقترح إيقافها', decisions: rows, message: rows.length ? `${rows.length} قرار إيقاف مقترح (مش بيتنفذ تلقائيًا إلا في Autopilot وبعد كل الحواجز).` : 'مفيش قرارات إيقاف مفتوحة دلوقتي.' };
  }
  if (has(t, 'توسع', 'scale', 'زياده الميزانيه', 'ينفع اوسع', 'فرص')) {
    const rows = await listDecisions({ bucket: 'scale', limit: 20 });
    return { kind: 'QUERY', title: 'فرص التوسّع', decisions: rows, message: rows.length ? `${rows.length} فرصة توسّع مرصودة.` : 'مفيش فرص توسّع مرصودة دلوقتي.' };
  }
  if (has(t, 'ممنوع', 'متوقف', 'محظور', 'blocked', 'ليه ما') ) {
    const rows = await listDecisions({ bucket: 'blocked', limit: 30 });
    return { kind: 'QUERY', title: 'قرارات ممنوعة بحاجز أمان', decisions: rows, message: `${rows.length} قرار ممنوع — كل واحد له سبب واضح.` };
  }
  if (has(t, 'حاله', 'وضع', 'status', 'ملخص', 'النهارده', 'اليوم')) {
    const [cfg, ov] = await Promise.all([getOperatorConfig(), operatorOverview({})]);
    return { kind: 'QUERY', title: 'ملخص الحالة', overview: ov, message: `الوضع: ${cfg.mode}${cfg.emergency_stop ? ' — ⛔ إيقاف الطوارئ مفعّل' : ''}.` };
  }
  if (has(t, 'قواعد', 'rules')) {
    const rules = await listRules();
    return { kind: 'QUERY', title: 'القواعد', rules, message: `${rules.length} قاعدة (${rules.filter((r) => r.enabled).length} مفعّلة).` };
  }
  if (has(t, 'استثناءات', 'مستثنى', 'exceptions')) {
    const ex = await listExceptions({});
    return { kind: 'QUERY', title: 'الاستثناءات', exceptions: ex, message: `${ex.length} استثناء فعّال.` };
  }
  return { kind: 'UNSUPPORTED', message: 'مقدرتش أفهم الأمر ده. جرّب: "إيه الحملات اللي هتتوقف؟" أو "فرص التوسع" أو "لو CPA أعلى من 150 وقف الحملة" أو "إيقاف فوري". أوامر التنفيذ المباشر على حملة معيّنة مش متاحة من هنا — لازم قرار مجهّز وموافقة.' };
}
