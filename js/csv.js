// csv.js — CSV/Excel-exported-as-CSV import for daily orders (spec section 3).
// Expects columns: Date | Product | Orders (header names are matched
// case-insensitively; a few Arabic synonyms are accepted too). No external
// parser library — this machine has no package manager, and the format
// needed here (flat, comma-separated, optionally quoted) is simple enough
// to parse by hand reliably.

/** RFC4180-ish tokenizer: handles quoted fields, embedded commas/newlines. */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',' || c === ';' || c === '\t') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const DATE_HEADERS = ['date', 'التاريخ'];
const PRODUCT_HEADERS = ['product', 'product_name', 'المنتج'];
const ORDERS_HEADERS = ['orders', 'orders_count', 'الأوردرات', 'اوردرات'];

function findColumn(headerRow, candidates) {
  const norm = headerRow.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const idx = norm.indexOf(c.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Rejects calendar-impossible dates (month 13, day 40, Feb 30, ...) by round-tripping through Date.UTC. */
function isRealCalendarDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function buildDateOrNull(y, m, d) {
  if (!isRealCalendarDate(y, m, d)) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Normalizes a date cell to 'YYYY-MM-DD'. Accepts ISO, or DD/MM/YYYY (common Excel export in this region). Returns null for anything that isn't a real calendar date. */
export function normalizeDate(raw) {
  const v = raw.trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return buildDateOrNull(y, m, d);
  }
  const m1 = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    const [, d, m, y] = m1.map(Number);
    return buildDateOrNull(y, m, d);
  }
  const m2 = v.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m2) {
    const [, d, m, y] = m2.map(Number);
    return buildDateOrNull(y, m, d);
  }
  return null;
}

/**
 * @param {string} text raw file contents
 * @param {{id:number, product_name:string}[]} products existing products, matched by name (case/whitespace-insensitive)
 * @returns {{valid: Array<{product_id:number, date:string, orders_count:number}>, errors: string[], unmatchedProducts: string[]}}
 */
export function parseOrdersCSV(text, products) {
  const rows = parseCSV(text);
  const errors = [];
  const valid = [];
  const unmatchedProducts = new Set();

  if (rows.length === 0) {
    return { valid, errors: ['الملف فارغ.'], unmatchedProducts: [] };
  }

  const header = rows[0];
  const dateIdx = findColumn(header, DATE_HEADERS);
  const productIdx = findColumn(header, PRODUCT_HEADERS);
  const ordersIdx = findColumn(header, ORDERS_HEADERS);

  if (dateIdx === -1 || productIdx === -1 || ordersIdx === -1) {
    return {
      valid,
      errors: ['لم يتم التعرف على الأعمدة المطلوبة. الأعمدة المتوقعة: Date | Product | Orders'],
      unmatchedProducts: [],
    };
  }

  const byName = new Map(products.map((p) => [p.product_name.trim().toLowerCase(), p]));

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const lineNo = i + 1;
    const rawDate = (r[dateIdx] || '').trim();
    const rawProduct = (r[productIdx] || '').trim();
    const rawOrders = (r[ordersIdx] || '').trim();

    if (!rawDate && !rawProduct && !rawOrders) continue;

    const date = normalizeDate(rawDate);
    if (!date) {
      errors.push(`سطر ${lineNo}: تاريخ غير صالح "${rawDate}"`);
      continue;
    }

    const product = byName.get(rawProduct.toLowerCase());
    if (!product) {
      unmatchedProducts.add(rawProduct);
      errors.push(`سطر ${lineNo}: منتج غير معروف "${rawProduct}"`);
      continue;
    }

    const orders = Number(rawOrders);
    if (rawOrders === '' || Number.isNaN(orders) || orders < 0) {
      errors.push(`سطر ${lineNo}: عدد أوردرات غير صالح "${rawOrders}"`);
      continue;
    }

    valid.push({ product_id: product.id, date, orders_count: Math.round(orders) });
  }

  return { valid, errors, unmatchedProducts: [...unmatchedProducts] };
}
