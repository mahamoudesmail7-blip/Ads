// Egyptian phone normalization — pure function tests, no DB/network at all.
//   node src/scripts/phoneNormalizeTest.js
import { normalizeEgyptianPhone } from '../services/phoneNormalize.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

console.log('§1 the four documented equivalent formats all normalize to the same value:');
{
  const expected = '201012345678';
  ok('01012345678', normalizeEgyptianPhone('01012345678') === expected, normalizeEgyptianPhone('01012345678'));
  ok('201012345678', normalizeEgyptianPhone('201012345678') === expected, normalizeEgyptianPhone('201012345678'));
  ok('+201012345678', normalizeEgyptianPhone('+201012345678') === expected, normalizeEgyptianPhone('+201012345678'));
  ok('00201012345678', normalizeEgyptianPhone('00201012345678') === expected, normalizeEgyptianPhone('00201012345678'));
}

console.log('\n§2 cosmetic formatting is stripped (spaces, dashes, parens, dots):');
{
  const expected = '201012345678';
  ok('010 1234 5678', normalizeEgyptianPhone('010 1234 5678') === expected, normalizeEgyptianPhone('010 1234 5678'));
  ok('010-1234-5678', normalizeEgyptianPhone('010-1234-5678') === expected, normalizeEgyptianPhone('010-1234-5678'));
  ok('+20 (10) 1234-5678', normalizeEgyptianPhone('+20 (10) 1234-5678') === expected, normalizeEgyptianPhone('+20 (10) 1234-5678'));
  ok('010.1234.5678', normalizeEgyptianPhone('010.1234.5678') === expected, normalizeEgyptianPhone('010.1234.5678'));
}

console.log('\n§3 bare 10-digit form (leading 0/country code omitted) still resolves:');
{
  ok('1012345678 -> 201012345678', normalizeEgyptianPhone('1012345678') === '201012345678', normalizeEgyptianPhone('1012345678'));
}

console.log('\n§4 all four real Egyptian mobile network prefixes accepted (010/011/012/015):');
{
  ok('010...', normalizeEgyptianPhone('01012345678') === '201012345678');
  ok('011...', normalizeEgyptianPhone('01112345678') === '201112345678');
  ok('012...', normalizeEgyptianPhone('01212345678') === '201212345678');
  ok('015...', normalizeEgyptianPhone('01512345678') === '201512345678');
}

console.log('\n§5 invalid input -> null, never guessed:');
{
  ok('null', normalizeEgyptianPhone(null) === null);
  ok('undefined', normalizeEgyptianPhone(undefined) === null);
  ok('empty string', normalizeEgyptianPhone('') === null);
  ok('whitespace only', normalizeEgyptianPhone('   ') === null);
  ok('letters', normalizeEgyptianPhone('not-a-phone') === null);
  ok('too short', normalizeEgyptianPhone('0101234') === null);
  ok('too long', normalizeEgyptianPhone('010123456789999') === null);
  ok('Egyptian landline (02, Cairo) -> not a mobile, rejected', normalizeEgyptianPhone('0223456789') === null, normalizeEgyptianPhone('0223456789'));
  ok('invalid mobile network prefix (019 is not a real Egyptian mobile prefix)', normalizeEgyptianPhone('01912345678') === null, normalizeEgyptianPhone('01912345678'));
  ok('mixed digits and letters', normalizeEgyptianPhone('0101234abcd') === null);
}

console.log('\n§6 idempotent — normalizing an already-normalized number returns the same value:');
{
  const once = normalizeEgyptianPhone('01012345678');
  const twice = normalizeEgyptianPhone(once);
  ok('normalize(normalize(x)) === normalize(x)', once === twice, `${once} vs ${twice}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
