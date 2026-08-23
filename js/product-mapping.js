// product-mapping.js — EasyOrders Product Mapping Layer (spec sections 12,
// 24, 62-64). Pure matching logic, no DOM/IndexedDB, NOT wired into
// anything yet — this exists so that when a real EasyOrders integration is
// built, "match this order's product name to an internal Product ID" is
// already a solved, tested problem instead of something improvised later.
//
// Why exact-string matching isn't enough: EasyOrders will hand back
// whatever product name a customer/agent typed on the order, which will
// not always be byte-identical to this app's product_name (extra/missing
// words, "ال" prefix differences, Arabic letter variants like أ/إ/آ vs ا).
// Naive `===` matching would silently fail to file the order under the
// right product the moment the text differs even slightly — and a wrong
// (over-eager) match is worse than no match, since it would corrupt that
// product's whole order history. So this errs toward returning `unmatched`
// over guessing.
//
// Pipeline this plugs into (per the architecture in orders-provider.js):
//   EasyOrders raw order -> normalizeOrder() -> mapProductByName() (here)
//   -> internal Product ID -> dedupeByOrderId() -> DailyOrders.upsert()

const ARABIC_DIACRITICS = /[ً-ٰٟ]/g;

/**
 * Normalizes an Arabic/mixed product-name string for comparison: strips
 * diacritics, unifies common alef/ya/ta-marbuta letter variants, collapses
 * whitespace, lowercases any Latin characters. Used on BOTH sides of a
 * comparison — never mutates stored product names, only comparison copies.
 */
export function normalizeName(s) {
  return String(s || '')
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[‏‎]/g, '') // stray RTL/LTR marks sometimes present in pasted text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(normalized) {
  return normalized.split(' ').filter((t) => t.length > 1); // drop single-letter noise tokens
}

/** Fraction of externalTokens also present in productTokens (order-independent). */
function tokenOverlapScore(externalTokens, productTokens) {
  if (externalTokens.length === 0) return 0;
  const productSet = new Set(productTokens);
  const shared = externalTokens.filter((t) => productSet.has(t)).length;
  return shared / externalTokens.length;
}

/**
 * @param {string} externalName the product name string as it arrives from EasyOrders
 * @param {object[]} products this app's Products.all() result
 * @param {number} fuzzyThreshold minimum token-overlap score (0-1) to accept a fuzzy match, default 0.6
 * @returns {{productId: number|null, method: 'exact_name'|'exact_sku'|'fuzzy'|'unmatched', confidence: number, candidate: object|null}}
 */
export function mapProductByName(externalName, products, fuzzyThreshold = 0.6) {
  const normExternal = normalizeName(externalName);
  if (!normExternal) return { productId: null, method: 'unmatched', confidence: 0, candidate: null };

  const exactName = products.find((p) => normalizeName(p.product_name) === normExternal);
  if (exactName) return { productId: exactName.id, method: 'exact_name', confidence: 1, candidate: exactName };

  const exactSku = products.find((p) => p.sku && normalizeName(p.sku) === normExternal);
  if (exactSku) return { productId: exactSku.id, method: 'exact_sku', confidence: 1, candidate: exactSku };

  const externalTokens = tokenize(normExternal);
  let best = null;
  let bestScore = 0;
  for (const p of products) {
    const score = tokenOverlapScore(externalTokens, tokenize(normalizeName(p.product_name)));
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  if (best && bestScore >= fuzzyThreshold) {
    return { productId: best.id, method: 'fuzzy', confidence: bestScore, candidate: best };
  }

  // Deliberately returns unmatched rather than the closest-but-below-
  // threshold guess — a future integration should route these to a manual
  // review queue, never silently misfile them under the wrong product.
  return { productId: null, method: 'unmatched', confidence: bestScore, candidate: best };
}

/**
 * NOT IMPLEMENTED — documents the intended next step once real EasyOrders
 * payloads exist: a persisted override table (external_name -> product_id)
 * so a human can fix an `unmatched`/low-confidence result once and have it
 * remembered. No DB store exists for this yet; its exact shape should be
 * designed from real payload examples rather than guessed now.
 */
export function applyManualAlias() {
  throw new Error('applyManualAlias غير مفعّل بعد — يحتاج تصميم جدول Aliases بعد رؤية بيانات EasyOrders فعلية.');
}
