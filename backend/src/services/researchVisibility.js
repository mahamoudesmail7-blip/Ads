// researchVisibility.js — «راجع الداتا قبل ما تديني نتايج»: for an IMAGE search nothing is shown until it has been checked against the owner's photo.
//   • while the search is still running (collecting / ranking / judging) the results list is EMPTY and the counters are 0 — raw candidates are never shown;
//   • afterwards ONLY results the exact-product judge verified are shown: EXACT («🎯 مطابق للمنتج») and REVIEW («🔍 محتاج مراجعة», its own tab);
//   • everything else (rejected look-alikes, and anything that could not be verified) stays stored but hidden, and is only COUNTED in `verification`.
// Text-only searches (no reference photo) are untouched.
export const RUNNING_STATUSES = ['PENDING', 'ANALYZING', 'GENERATING_QUERIES', 'SEARCHING', 'RANKING'];
export const SHOWN_DECISIONS = ['EXACT', 'REVIEW'];

export function visibilityFor(search) {
  const isImageSearch = Boolean(search?.product_image);
  const verificationPending = isImageSearch && RUNNING_STATUSES.includes(search?.status);
  return {
    isImageSearch,
    verificationPending,
    /** extra Prisma `where` fragment for any read of this search's results (null = no restriction) */
    resultFilter: isImageSearch ? { match_decision: { in: SHOWN_DECISIONS } } : null,
  };
}

/** @param {{match_decision:string|null}[]} decisionRows every stored result (hidden ones included) */
export function verificationInfo(search, decisionRows) {
  const v = visibilityFor(search);
  if (!v.isImageSearch) return null;
  const n = (d) => decisionRows.filter((r) => r.match_decision === d).length;
  const exact = n('EXACT'); const review = n('REVIEW'); const rejected = n('REJECT');
  const unverified = decisionRows.filter((r) => r.match_decision === null).length;
  let state; let messageAr;
  if (v.verificationPending) { state = 'PENDING'; messageAr = 'جاري البحث والتحقق من النتائج بصورة المنتج — مش هتتعرض نتيجة غير متأكد منها.'; }
  else if (exact + review === 0) { state = 'DONE_EMPTY'; messageAr = 'خلص البحث والتحقق: مفيش نتيجة اتأكدنا إنها نفس المنتج بالظبط.'; }
  else { state = 'DONE'; messageAr = `خلص التحقق: ${exact} نتيجة مطابقة للمنتج${review ? ` و${review} محتاجة مراجعة` : ''}. النتائج الشبيهة أو غير المتأكد منها مخفية.`; }
  return { state, pending: v.verificationPending, exact, review, hiddenRejected: rejected, hiddenUnverified: unverified, messageAr };
}
