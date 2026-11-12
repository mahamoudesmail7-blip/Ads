// Prompt for the "8 Meta interests" list. The AI only SUGGESTS candidates — the final list is decided by checking each one against Meta's own interest search (see engine.buildInterests).
export const INTERESTS_VERSION = 'ps-interests-2026-11-v1';
export const INTERESTS_SYSTEM = `You are a senior Meta (Facebook/Instagram) media buyer targeting Egypt. Your job: suggest candidate Detailed-Targeting INTEREST names for one product.
Rules:
- Output ENGLISH names only, exactly the way they appear in Meta Ads Manager's Detailed Targeting search (e.g. "Massage", "Home improvement", "Beauty salon", "Online shopping"). Short, common, real Meta interests — never invented phrases, never sentences.
- Suggest 16 different candidates ordered from the most relevant to the least. Mix: the product's own category, the problem it solves, the typical buyer's lifestyle, and complementary products buyers also like.
- Base them ONLY on the product data and the facts given (confirmed features, what the page says). Do not assume features that are not given.
- No sensitive categories (health conditions, diseases, religion, politics, sexual orientation, ethnicity, finances/debt). No brand names unless the product itself is clearly that brand's accessory.
- No guarantees, no claims that an interest will perform well.
Return JSON only: {"interests":[{"name":"English interest name","why":"one short Egyptian-Arabic reason tied to the product"}]}`;
export function interestsUser({ context, analysis, page }) {
  const feats = [...(analysis?.confirmed?.specs || []).map((x) => x.text), ...(context.features || [])].slice(0, 12);
  const lines = [`اسم المنتج: ${context.name}`, context.category ? `التصنيف: ${context.category}` : null, context.price != null ? `السعر: ${context.price} جنيه` : null, feats.length ? `مميزات مؤكدة:\n- ${feats.join('\n- ')}` : null,
    analysis?.summary ? `ملخص من تحليل الصور: ${analysis.summary}` : null, analysis?.inferred?.potentialBuyers?.length ? `مشترين محتملين (استنتاج): ${analysis.inferred.potentialBuyers.join('، ')}` : null,
    analysis?.inferred?.problemsSolved?.length ? `مشاكل ممكن يحلها (استنتاج): ${analysis.inferred.problemsSolved.join('، ')}` : null,
    page?.title ? `عنوان صفحة المنتج: ${page.title}` : null, page?.h1 ? `العنوان الرئيسي بالصفحة: ${page.h1}` : null, page?.textSample ? `مقتطف من نص الصفحة: ${String(page.textSample).slice(0, 600)}` : null].filter(Boolean);
  return `${lines.join('\n')}\n\nرشّح 16 اهتمام (Interest) بالإنجليزي موجودين في Meta Detailed Targeting. JSON فقط.`;
}
