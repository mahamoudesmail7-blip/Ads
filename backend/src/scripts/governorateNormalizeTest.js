// Regression test for the "Alexandria" class of bug found in production:
// EasyOrdersOrder.customer_government is stored verbatim with zero
// normalization, so real orders for the same governorate can be split
// across spelling variants (confirmed via a real production query: product
// 126's real orders are stored as "الاسكندرية", no hamza). This tests the
// exact real-world case plus the safety guarantee that unrecognized
// strings are never incorrectly merged.
//   node src/scripts/governorateNormalizeTest.js
import { normalizeGovernorateName } from '../services/amb/governorateNormalize.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

console.log('§1 the exact real production case — hamza vs no-hamza Alexandria spellings merge to the same canonical form:');
{
  ok('"الاسكندرية" (no hamza, the real stored value) -> canonical "الإسكندرية"', normalizeGovernorateName('الاسكندرية') === 'الإسكندرية');
  ok('"الإسكندرية" (with hamza, MSA-correct) -> itself, unchanged (already canonical)', normalizeGovernorateName('الإسكندرية') === 'الإسكندرية');
  ok('both spellings normalize to the IDENTICAL key, so a governorate breakdown never splits them', normalizeGovernorateName('الاسكندرية') === normalizeGovernorateName('الإسكندرية'));
}

console.log('\n§2 English transliteration variants map to the canonical Arabic name:');
{
  ok('"Alexandria" -> "الإسكندرية"', normalizeGovernorateName('Alexandria') === 'الإسكندرية');
  ok('"Cairo" -> "القاهرة"', normalizeGovernorateName('Cairo') === 'القاهرة');
  ok('"Giza" (any case/whitespace) -> "الجيزة"', normalizeGovernorateName('  GIZA  ') === 'الجيزة');
}

console.log('\n§3 all 27 canonical governorates round-trip to themselves:');
{
  const canonical = ['القاهرة', 'الجيزة', 'الإسكندرية', 'الدقهلية', 'البحيرة', 'الفيوم', 'الغربية', 'الإسماعيلية', 'المنوفية', 'المنيا', 'القليوبية', 'الوادي الجديد', 'السويس', 'اسوان', 'اسيوط', 'بني سويف', 'بورسعيد', 'دمياط', 'جنوب سيناء', 'كفر الشيخ', 'مطروح', 'الأقصر', 'قنا', 'شمال سيناء', 'سوهاج', 'الشرقية', 'البحر الأحمر'];
  ok('every canonical name maps to itself unchanged', canonical.every((g) => normalizeGovernorateName(g) === g), canonical.filter((g) => normalizeGovernorateName(g) !== g).join(', '));
}

console.log('\n§4 SAFETY — an unrecognized value is returned unchanged, never incorrectly merged with a real governorate:');
{
  ok('a city name ("طنطا", not a governorate) passes through unchanged, not merged into any governorate', normalizeGovernorateName('طنطا') === 'طنطا');
  ok('a garbage/typo string passes through unchanged rather than guessing', normalizeGovernorateName('xyz123') === 'xyz123');
  ok('two different unrecognized strings stay distinct from each other', normalizeGovernorateName('طنطا') !== normalizeGovernorateName('المحلة'));
}

console.log('\n§5 edge cases — empty/null/whitespace-only never crash and never fabricate a governorate:');
{
  ok('empty string -> empty string', normalizeGovernorateName('') === '');
  ok('null -> empty string, never throws', normalizeGovernorateName(null) === '');
  ok('undefined -> empty string, never throws', normalizeGovernorateName(undefined) === '');
  ok('whitespace-only -> empty string', normalizeGovernorateName('   ') === '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
