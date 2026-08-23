// product-import.js — pure product-import matching/planning logic. No
// DOM/IndexedDB — takes the already-loaded product list plus a batch of
// incoming rows and returns a plan {toCreate, toUpdate, duplicatesInFile,
// errors}. Used by both the CSV/Excel import screen (products.js) and the
// one-time real-catalog import (real-catalog.js), so both paths get the
// exact same duplicate-detection rule (spec section 13: "المنتج موجود
// بالفعل" -> update existing instead of creating a new row).
//
// Match priority: a non-empty SKU match wins; otherwise fall back to an
// exact (trimmed, case-insensitive) product name match. SKU is NOT a
// reliable primary key for real products — most of them have none — so
// name is the fallback, never the reverse.

export function normalizeImportRow(row) {
  return {
    product_name: String(row.product_name || '').trim(),
    sku: String(row.sku || '').trim(),
    category: String(row.category || '').trim() || null,
    // Passed through only when the caller supplied one (e.g. real-catalog.js's
    // hardcoded PRD-NNN codes) — a plain CSV upload never has this field, and
    // products.js generates a fresh code for those via nextProductCode().
    product_code: row.product_code ? String(row.product_code).trim() : undefined,
  };
}

function findMatch(pool, row) {
  if (row.sku) {
    const bySku = pool.find((p) => (p.sku || '').trim().toLowerCase() === row.sku.toLowerCase());
    if (bySku) return bySku;
  }
  const normName = row.product_name.toLowerCase();
  return pool.find((p) => (p.product_name || '').trim().toLowerCase() === normName) || null;
}

/**
 * @param {object[]} existingProducts already-loaded Products.all() result
 * @param {object[]} incomingRows raw rows, each roughly {product_name, sku, category}
 * @returns {{toCreate: object[], toUpdate: {existing: object, row: object}[], duplicatesInFile: object[], errors: {row: object, reason: string}[]}}
 */
export function buildImportPlan(existingProducts, incomingRows) {
  const toCreate = [];
  const toUpdate = [];
  const duplicatesInFile = [];
  const errors = [];
  const seenInBatch = [];

  for (const raw of incomingRows) {
    const row = normalizeImportRow(raw);
    if (!row.product_name) {
      errors.push({ row: raw, reason: 'اسم المنتج مفقود' });
      continue;
    }

    const dupInBatch = findMatch(seenInBatch, row);
    if (dupInBatch) {
      duplicatesInFile.push({ row, matchedName: dupInBatch.product_name });
      continue;
    }
    seenInBatch.push(row);

    const existing = findMatch(existingProducts, row);
    if (existing) toUpdate.push({ existing, row });
    else toCreate.push(row);
  }

  return { toCreate, toUpdate, duplicatesInFile, errors };
}

// ---------------------------------------------------------------------------
// Minimal CSV parsing for the Product Import screen. Deliberately simple
// (comma-separated, optional quoted fields) — matches the same practical
// "CSV, not a real .xlsx binary" approach already used by the Orders CSV
// importer (csv.js), since this environment has no Node/library to parse a
// real Excel binary.
// ---------------------------------------------------------------------------

const HEADER_ALIASES = {
  product_name: ['اسم المنتج', 'المنتج', 'product_name', 'name'],
  sku: ['sku', 'رمز المنتج', 'الرمز'],
  category: ['الفئة', 'التصنيف', 'category'],
};

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** @returns {{rows: object[], error: string|null}} */
export function parseProductsCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return { rows: [], error: 'الملف فارغ أو لا يحتوي على بيانات' };

  const headerCells = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const colIndex = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = headerCells.findIndex((h) => aliases.some((a) => a.toLowerCase() === h));
    if (idx !== -1) colIndex[field] = idx;
  }
  if (colIndex.product_name === undefined) {
    return { rows: [], error: 'لم يتم العثور على عمود "اسم المنتج" في الملف' };
  }

  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return {
      product_name: cells[colIndex.product_name] || '',
      sku: colIndex.sku !== undefined ? cells[colIndex.sku] || '' : '',
      category: colIndex.category !== undefined ? cells[colIndex.category] || '' : '',
    };
  });

  return { rows, error: null };
}
