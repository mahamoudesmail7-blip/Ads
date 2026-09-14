// Egyptian governorate name normalization. Fixes the exact class of bug
// found in production: EasyOrdersOrder.customer_government is stored
// verbatim from Easy Orders' API with zero normalization (confirmed in
// easyOrders.js's ingestOrder()), and codOrders.js/customerQuality.js
// group by that raw trimmed string. A real product's orders were found
// stored as "الاسكندرية" (no hamza) — a common vernacular spelling — which
// would never match a lookup keyed on the MSA-correct "الإسكندرية" (with
// hamza), or any other governorate whose orders happen to use a different
// spelling. Reuses the EXISTING Arabic-folding normalizeName() from
// js/product-mapping.js (already handles hamza/alef-form/ta-marbuta
// folding for product-name matching) — this file only adds the canonical-
// governorate lookup table on top, it does not reinvent folding.
//
// Safety: an unrecognized string is returned UNCHANGED, trimmed — never
// merged with a governorate it doesn't actually match. This can only ever
// combine two real rows that represent the same real place under a known
// spelling variant; it never drops or fabricates a location.
import { normalizeName } from '../../../../js/product-mapping.js';

const CANONICAL_GOVERNORATES = [
  'القاهرة', 'الجيزة', 'الإسكندرية', 'الدقهلية', 'البحيرة', 'الفيوم', 'الغربية', 'الإسماعيلية',
  'المنوفية', 'المنيا', 'القليوبية', 'الوادي الجديد', 'السويس', 'اسوان', 'اسيوط', 'بني سويف',
  'بورسعيد', 'دمياط', 'جنوب سيناء', 'كفر الشيخ', 'مطروح', 'الأقصر', 'قنا', 'شمال سيناء',
  'سوهاج', 'الشرقية', 'البحر الأحمر',
];

// Common English transliteration variants -> canonical Arabic name. Not
// exhaustive by design — only real, commonly-seen spellings; an unlisted
// variant simply passes through unchanged rather than risk a wrong merge.
const ENGLISH_VARIANTS = {
  cairo: 'القاهرة',
  giza: 'الجيزة', gizah: 'الجيزة',
  alexandria: 'الإسكندرية', alex: 'الإسكندرية',
  dakahlia: 'الدقهلية', dakahleya: 'الدقهلية',
  beheira: 'البحيرة', buhayrah: 'البحيرة',
  fayoum: 'الفيوم', faiyum: 'الفيوم',
  gharbia: 'الغربية', gharbeya: 'الغربية',
  ismailia: 'الإسماعيلية',
  monufia: 'المنوفية', menoufia: 'المنوفية',
  minya: 'المنيا', menia: 'المنيا',
  qalyubia: 'القليوبية', qalyoubia: 'القليوبية',
  'new valley': 'الوادي الجديد',
  suez: 'السويس',
  aswan: 'اسوان',
  asyut: 'اسيوط', assiut: 'اسيوط',
  'beni suef': 'بني سويف', 'bani suef': 'بني سويف',
  portsaid: 'بورسعيد', 'port said': 'بورسعيد',
  damietta: 'دمياط',
  'south sinai': 'جنوب سيناء',
  'kafr el sheikh': 'كفر الشيخ', 'kafr al sheikh': 'كفر الشيخ', 'kafr al-sheikh': 'كفر الشيخ',
  matrouh: 'مطروح', matruh: 'مطروح',
  luxor: 'الأقصر',
  qena: 'قنا', kena: 'قنا',
  'north sinai': 'شمال سيناء',
  sohag: 'سوهاج',
  sharqia: 'الشرقية', sharkia: 'الشرقية',
  'red sea': 'البحر الأحمر',
};

const canonicalByFoldedKey = new Map();
for (const gov of CANONICAL_GOVERNORATES) canonicalByFoldedKey.set(normalizeName(gov), gov);
for (const [variant, canonical] of Object.entries(ENGLISH_VARIANTS)) canonicalByFoldedKey.set(normalizeName(variant), canonical);

/**
 * Folds a raw Egyptian governorate string (Arabic spelling variants +
 * common English transliterations) to its canonical Arabic name. Returns
 * the original trimmed string UNCHANGED when it doesn't match any known
 * governorate — never merges two genuinely different/unrecognized values.
 */
export function normalizeGovernorateName(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return trimmed;
  const key = normalizeName(trimmed);
  return canonicalByFoldedKey.get(key) || trimmed;
}
