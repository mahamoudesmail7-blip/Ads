// What a scale / clone failure MEANS for the owner and what to do about it, in plain Arabic. One place, so the bulk panel, the failed cards and the logs all say the same thing.
// Pure: text in → { kind, title, action, retry } out.
//   retry: 'WAIT'      — nothing was wrong with the campaign; Meta throttled the account → wait, then scale again
//          'RESUME'    — a campaign was (partly) created on Meta → RESUME that batch, never scale again (it would duplicate)
//          'FIX_INPUT' — the owner has to supply something (a landing URL) and then resume
//          'RESCALE'   — nothing was written to Meta → a normal new scale is safe
//          'NONE'      — nothing to do (already fine)
export const KINDS = ['THROTTLE', 'WAIT_TIMEOUT', 'MISSING_LINK', 'NO_CREATIVE', 'ADS_UNREADABLE', 'REPORT_ONLY', 'PERMISSION', 'UNKNOWN'];

const RULES = [
  { kind: 'THROTTLE', re: /request limit reached|rate limit|too many (api )?calls|\(#(?:4|17|32|613|80000|80003|80004)\)|حد مؤقت على الحساب/i, title: 'ميتا حاطّة حد طلبات مؤقت على الحساب', action: 'استنى 10–15 دقيقة من غير أي كلون أو مزامنة، وبعدها كمّل.', retry: 'WAIT' },
  { kind: 'WAIT_TIMEOUT', re: /انتهت مهلة الانتظار|المهلة والـ job لسه/i, title: 'النسخ لسه شغال على ميتا', action: 'ما تعيدش الاسكيل — النسخ بيخلص لوحده. راجع «استنساخ وجدولة».', retry: 'RESUME' },
  { kind: 'MISSING_LINK', re: /link field is required|Required Field Is Missing[\s\S]*link|رابط وجهة/i, title: 'ميتا طلبت رابط المنتج للإعلان ده', action: 'الكامبين اتعمل ناقص إعلان. اضغط «كمّل الناقص» (بيستخدم رابط المنتج من باقي الحملة)، ولو مفيش رابط أدخله مرة واحدة.', retry: 'RESUME' },
  { kind: 'NO_CREATIVE', re: /لا يوجد كرياتيف صالح/i, title: 'الإعلان ماتعملوش كرييتيف', action: 'الكامبين اتعمل ناقص. اضغط «كمّل الناقص».', retry: 'RESUME' },
  { kind: 'ADS_UNREADABLE', re: /تعذّر قراءة إعلانات الحملة|مقدرتش أقرأ إعلانات/i, title: 'مقدرتش أقرأ إعلانات الحملة من ميتا', action: 'ماحصلش أي كتابة على ميتا. جرّب تاني بعد دقايق.', retry: 'RESCALE' },
  { kind: 'PERMISSION', re: /permission|\(#200\)|\(#10\)|OAuthException.*(?:access|token)|Error validating access token/i, title: 'ميتا رفضت الصلاحية', action: 'راجع ربط ميتا / صلاحية الحساب الإعلاني من الإعدادات.', retry: 'NONE' },
];

export function classifyScaleError(message) {
  const text = String(message || '');
  for (const r of RULES) if (r.re.test(text)) return { kind: r.kind, title: r.title, action: r.action, retry: r.retry };
  return { kind: 'UNKNOWN', title: 'فشل غير متوقع', action: 'افتح «استنساخ وجدولة» وشوف لو كامبين اتعمل ناقص، لو آه اضغط «كمّل الناقص»، ولو لأ ابعتلي الرسالة.', retry: 'RESUME' };
}
