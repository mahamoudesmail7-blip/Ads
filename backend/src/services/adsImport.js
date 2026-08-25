// AI Business Intelligence Phase 1 — file parsing, column guessing, and
// campaign->product matching for uploaded Meta Ads Manager exports.
//
// Deliberately imports the existing frontend modules directly rather than
// re-implementing them: both `js/csv.js`'s parseCSV() and
// `js/product-mapping.js`'s mapProductByName()/normalizeName() are pure
// functions with zero DOM/browser dependency, so they run identically in
// this Node/ESM backend — one algorithm, no drift risk between the two
// runtimes.
import ExcelJS from 'exceljs';
import { parseCSV } from '../../../js/csv.js';
import { mapProductByName } from '../../../js/product-mapping.js';

// Meta Ads Manager's well-documented standard export column names (plus a
// few common variants/currencies) mapped to our normalized field names.
// Deliberately excludes "Results" / "Cost per Result" — those are objective-
// dependent (could mean leads OR purchases OR something else entirely) and
// safer left for manual mapping than auto-guessed wrong.
const COLUMN_KEYWORDS = {
  date: ['reporting starts', 'day', 'date'],
  campaign_name: ['campaign name'],
  campaign_id: ['campaign id'],
  campaign_delivery: ['campaign delivery'],
  adset_name: ['ad set name', 'adset name'],
  adset_id: ['ad set id', 'adset id'],
  ad_name: ['ad name'],
  ad_id: ['ad id'],
  creative_name: ['ad creative name', 'creative name'],
  creative_id: ['ad creative id', 'creative id'],
  spend: ['amount spent', 'amount spend', 'spend'],
  impressions: ['impressions'],
  reach: ['reach'],
  frequency: ['frequency'],
  clicks: ['link clicks', 'clicks (all)', 'clicks'],
  ctr: ['ctr', 'click-through rate'],
  cpc: ['cpc', 'cost per link click', 'cost per click'],
  cpm: ['cpm', 'cost per 1,000'],
  landing_page_views: ['landing page views'],
  leads: ['leads'],
  add_to_cart: ['add to cart', 'adds to cart'],
  initiate_checkout: ['checkout initiated', 'checkouts initiated', 'initiate checkout'],
  meta_purchases: ['website purchases', 'purchases'],
  meta_revenue: ['purchases conversion value', 'website purchases conversion value', 'purchase value', 'conversion value'],
  meta_roas: ['purchase roas', 'roas', 'return on ad spend'],
  // Meta's own objective-agnostic "Results" / "Cost per results" — always
  // present in a standard export regardless of campaign objective, unlike
  // meta_purchases which only means something for purchase-objective
  // campaigns. result_indicator says what "Results" actually counted.
  results: ['results'],
  cost_per_result: ['cost per results', 'cost per result'],
  result_indicator: ['result indicator'],
};

const CANONICAL_FIELDS = Object.keys(COLUMN_KEYWORDS);
const NUMERIC_FIELDS = new Set([
  'spend', 'impressions', 'reach', 'frequency', 'clicks', 'ctr', 'cpc', 'cpm',
  'landing_page_views', 'leads', 'add_to_cart', 'initiate_checkout', 'meta_purchases', 'meta_revenue', 'meta_roas',
  'results', 'cost_per_result',
]);

export { CANONICAL_FIELDS };

/** Same technique as js/inventory-tracker.js's guessColumnMapping() — first header whose lowercased text contains one of a field's known keyword phrases. Never used to silently commit anything; always shown to the user for confirmation first. */
export function guessColumnMapping(headers) {
  const lower = headers.map((h) => String(h || '').trim().toLowerCase());
  const mapping = {};
  for (const field of CANONICAL_FIELDS) {
    const keywords = COLUMN_KEYWORDS[field];
    const idx = lower.findIndex((h) => keywords.some((k) => h.includes(k)));
    mapping[field] = idx === -1 ? null : headers[idx];
  }
  return mapping;
}

/** Parses an uploaded file buffer into {headers, rows: string[][]}. CSV via the existing shared parser; XLSX via exceljs (first worksheet, first row = headers). */
export async function parseFile(buffer, fileType) {
  if (fileType === 'csv') {
    const text = buffer.toString('utf-8');
    const rows = parseCSV(text);
    if (rows.length === 0) return { headers: [], rows: [] };
    const [headers, ...dataRows] = rows;
    return { headers, rows: dataRows };
  }

  if (fileType === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return { headers: [], rows: [] };
    const all = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      // row.values[0] is always undefined (ExcelJS is 1-indexed) — slice it off.
      all.push(row.values.slice(1).map((v) => (v && typeof v === 'object' && 'text' in v ? v.text : v ?? '')));
    });
    if (all.length === 0) return { headers: [], rows: [] };
    const [headers, ...dataRows] = all;
    return { headers: headers.map((h) => String(h ?? '')), rows: dataRows.map((r) => r.map((c) => String(c ?? ''))) };
  }

  throw new Error(`نوع ملف غير مدعوم: ${fileType}`);
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const cleaned = String(v).replace(/[,%\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toDateOnly(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Validates rows against a confirmed mapping (spec Step 1: never fail the
 * whole upload over one bad row — collect warnings per row index instead).
 * A row missing `date` or `spend`/`campaign_name` entirely is flagged
 * invalid (excluded from normalization) rather than silently zero-filled.
 */
export function validateRows(headers, rows, mapping) {
  const colIndex = {};
  for (const [field, header] of Object.entries(mapping)) {
    colIndex[field] = header ? headers.indexOf(header) : -1;
  }

  const warnings = [];
  let invalidCount = 0;
  const parsed = rows.map((row, i) => {
    const get = (field) => (colIndex[field] >= 0 ? row[colIndex[field]] : null);
    const date = toDateOnly(get('date'));
    const campaign_name = (get('campaign_name') || '').toString().trim() || null;
    const spend = toNumberOrNull(get('spend'));

    const rowWarnings = [];
    if (!date) rowWarnings.push('تاريخ غير صحيح أو فاضي');
    if (!campaign_name) rowWarnings.push('اسم الحملة فاضي');
    if (spend === null) rowWarnings.push('قيمة الصرف غير رقمية أو فاضية');

    const valid = date && campaign_name; // spend missing is a warning, not a hard invalidity — some export rows legitimately have 0/blank spend
    if (!valid) invalidCount++;
    if (rowWarnings.length) warnings.push({ row: i + 2, issues: rowWarnings }); // +2: 1-indexed + header row

    const record = { date, campaign_name, valid };
    for (const field of CANONICAL_FIELDS) {
      if (field === 'date' || field === 'campaign_name') continue;
      const raw = get(field);
      record[field] = NUMERIC_FIELDS.has(field) ? toNumberOrNull(raw) : (raw ? String(raw).trim() : null) || null;
    }
    return record;
  });

  return { parsed, warnings, invalidCount, totalRows: rows.length };
}

/** Confidence-gated Campaign Name -> Product match, reusing the exact same algorithm/threshold philosophy as the EasyOrders SKU-matching path (never auto-commits a low-confidence guess). */
export function matchCampaignToProduct(campaignName, products) {
  const result = mapProductByName(campaignName, products, 0.6);
  return {
    productId: result.productId,
    confidence: result.confidence,
    method: result.method, // exact_name | exact_sku | fuzzy | unmatched
  };
}
