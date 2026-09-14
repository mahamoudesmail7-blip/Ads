// Egyptian mobile phone normalization — the sole dedup key for the Customer
// Database (Customer.normalized_phone). Deterministic, never guesses: any
// input that isn't clearly a valid Egyptian mobile number after cleanup
// returns null rather than being forced into a normalized value, because a
// wrong merge would silently corrupt one real customer's order history
// with another's.
//
// Canonical output format: "20" + 10 digits, e.g. "201012345678" — no "+",
// no leading zeros, no spaces. Egyptian mobile numbers are 01[0125]XXXXXXXX
// (11 digits with the leading 0); the network-prefix digit right after the
// leading 1 must be one of 0/1/2/5 (010, 011, 012, 015) — anything else
// (including an 02/03/0xx landline) is rejected, never coerced.
const MOBILE_PATTERN = /^201[0125]\d{8}$/;

/**
 * @param {string|null|undefined} raw
 * @returns {string|null} the canonical "201XXXXXXXXX" form, or null if `raw`
 *   cannot be safely recognized as a valid Egyptian mobile number.
 */
export function normalizeEgyptianPhone(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Strip everything cosmetic first: spaces, dashes, parentheses, dots.
  s = s.replace(/[\s\-().]/g, '');
  if (!s) return null;

  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0020')) s = s.slice(2); // "0020XXXXXXXXXX" -> "20XXXXXXXXXX" (drop the international-dialing "00", keep the "20" country code)

  if (!/^\d+$/.test(s)) return null; // anything non-numeric left over (letters, stray symbols) -> refuse to guess

  let digits = s;
  if (digits.startsWith('20') && digits.length === 12) {
    // already "20" + 10 digits — nothing to do
  } else if (digits.startsWith('0') && digits.length === 11) {
    digits = `20${digits.slice(1)}`; // local "01XXXXXXXXX" -> "201XXXXXXXXX"
  } else if (digits.length === 10 && digits.startsWith('1')) {
    digits = `20${digits}`; // leading 0 (or country code) omitted entirely, e.g. "1012345678"
  } else {
    return null; // any other length/shape is not safely interpretable — never guessed
  }

  return MOBILE_PATTERN.test(digits) ? digits : null; // final gate: must be a real Egyptian mobile prefix, not a landline or malformed number
}
