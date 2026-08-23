// inventory-store.js — orchestration for the Daily Stock Tracking module:
// turns an uploaded CSV (an "Excel file" saved/exported as CSV — see the
// header comment in csv.js for why this app works from CSV, not raw .xlsx
// binary: no external library is available to parse the real Excel format,
// and CSV is what every other import in this app already uses) into a
// two-phase preview -> confirm import, keeps the remembered column mapping
// and unmatched-name overrides, and provides the read-side aggregations the
// UI needs (today's outgoing, warehouse summary, product history, reports).
import {
  Products,
  DailyOrders,
  Settings,
  InventorySnapshots,
  InventoryMovementLog,
  InventoryColumnMapping,
  InventoryNameMapping,
  InventoryImportBatches,
} from './db.js';
import { parseCSV } from './csv.js';
import { addDays } from './analytics.js';
import { normalizeName, mapProductByName } from './product-mapping.js';
import { parseRealStockList } from './real-stock-data.js';
import {
  classifyMovement,
  guessColumnMapping,
  parseImportRows,
  findDuplicateNames,
  buildWarehouseSummary,
  reconcileOrdersVsInventory,
  topOutgoingProducts,
  classifyProductStatus,
  computeNoMovementStreak,
  noMovementAlertLevel,
  isMeaningfulOutgoingDrop,
  combinedProductStatus,
  PRODUCT_STATUS,
} from './inventory-tracker.js';

// ---------------------------------------------------------------------------
// Import — preview, then confirm (spec section 11: never save automatically)
// ---------------------------------------------------------------------------

/**
 * Parses the uploaded CSV text and matches every row to a product, WITHOUT
 * writing anything — the admin reviews this result and calls confirmImport()
 * to actually commit it.
 */
export async function previewImport(csvText, date, mappingOverride) {
  const rows = parseCSV(csvText).filter((r) => r.some((cell) => String(cell || '').trim() !== ''));
  if (rows.length === 0) {
    return { date, headers: [], mapping: null, matched: [], unmatched: [], duplicates: [], invalid: [], totalRows: 0 };
  }
  const headers = rows[0].map((h) => String(h || '').trim());
  const dataRows = rows.slice(1);

  const savedMapping = await InventoryColumnMapping.get();
  const mapping =
    mappingOverride ||
    (savedMapping && headers.includes(savedMapping.productName) && headers.includes(savedMapping.quantity)
      ? savedMapping
      : guessColumnMapping(headers));

  const { valid, invalid } = parseImportRows(dataRows, headers, mapping);
  const duplicateNames = findDuplicateNames(valid);

  const products = await Products.all();
  const nameMappings = await InventoryNameMapping.all();
  const nameMapByKey = new Map(nameMappings.map((m) => [m.excel_name_key, m.product_id]));

  const matched = [];
  const unmatched = [];

  for (const row of valid) {
    const key = normalizeName(row.name);
    let productId = nameMapByKey.get(key) ?? null;
    let matchMethod = productId ? 'remembered' : null;

    if (!productId && row.sku) {
      const bySku = products.find((p) => p.sku && normalizeName(p.sku) === normalizeName(row.sku));
      if (bySku) {
        productId = bySku.id;
        matchMethod = 'sku';
      }
    }
    if (!productId) {
      const result = mapProductByName(row.name, products, 0.65);
      if (result.productId) {
        productId = result.productId;
        matchMethod = result.method;
      }
    }

    if (productId) {
      const product = products.find((p) => p.id === productId);
      const previousStock = await lastKnownStock(productId, date, product);
      const movement = classifyMovement(previousStock, row.quantity);
      matched.push({
        rowNumber: row.rowNumber,
        excelName: row.name,
        quantity: row.quantity,
        sku: row.sku,
        productId,
        productName: product.product_name,
        matchMethod,
        previousStock,
        movement,
      });
    } else {
      unmatched.push({ rowNumber: row.rowNumber, excelName: row.name, quantity: row.quantity, sku: row.sku });
    }
  }

  return {
    date,
    headers,
    mapping,
    matched,
    unmatched,
    duplicates: duplicateNames,
    invalid,
    totalRows: dataRows.length,
  };
}

/** Yesterday's closing_stock if a snapshot exists, else the product's current on-record stock (first-ever import for this product). */
async function lastKnownStock(productId, date, product) {
  const history = await InventorySnapshots.forProduct(productId);
  const before = history.filter((s) => s.date < date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (before) return before.closing_stock;
  return product && product.current_stock !== null && product.current_stock !== undefined ? product.current_stock : null;
}

/** Commits a previewed import: upserts one snapshot per matched product, appends a movement-log entry each, updates each product's current_stock, and records the batch. */
export async function confirmImport(preview, { uploadedBy, filename }) {
  const batch = await InventoryImportBatches.create({
    date: preview.date,
    filename: filename || null,
    uploaded_by: uploadedBy || 'admin',
    total_rows: preview.totalRows,
    matched_count: preview.matched.length,
    unmatched_count: preview.unmatched.length,
    duplicate_count: preview.duplicates.length,
    invalid_count: preview.invalid.length,
    // Kept so ❓ Unmatched Products stays a durable, reviewable list (spec
    // section 10) rather than only existing while the preview modal is open.
    unmatched: preview.unmatched,
  });

  if (preview.mapping) await InventoryColumnMapping.save(preview.mapping);

  for (const row of preview.matched) {
    await InventorySnapshots.upsert({
      product_id: row.productId,
      product_name: row.productName,
      date: preview.date,
      opening_stock: row.previousStock,
      closing_stock: row.quantity,
      units_out: row.movement.type === 'OUT' ? row.movement.unitsOut : 0,
      stock_change: row.movement.stockChange,
      movement_type: row.movement.type,
      source: 'excel',
      batch_id: batch.id,
      notes: null,
      updated_by: uploadedBy || 'admin',
    });
    await InventoryMovementLog.log({
      date: preview.date,
      product_id: row.productId,
      product_name: row.productName,
      previous_qty: row.previousStock,
      new_qty: row.quantity,
      diff: row.movement.stockChange,
      movement_type: row.movement.type,
      notes: `استيراد من ملف${filename ? ' — ' + filename : ''}`,
      updated_by: uploadedBy || 'admin',
      batch_id: batch.id,
    });
    await Products.update(row.productId, { current_stock: row.quantity });
  }

  return { batchId: batch.id, imported: preview.matched.length };
}

/**
 * Imports the inventory manager's real current-stock reading
 * (real-stock-data.js) through the SAME preview/confirm pipeline as a file
 * upload — no separate code path, so it's matched, deduplicated, and
 * logged exactly like any other import. Since this is a single point-in-
 * time reading (no prior day to diff against for most products), the
 * first import naturally lands as UNKNOWN movement for everything, which
 * is the honest result — day-over-day "خرج النهارده" starts working from
 * the NEXT real upload onward, never fabricated for this first one.
 */
export async function importRealStockList(date, uploadedBy) {
  const rows = parseRealStockList();
  const header = ['Product Name', 'Current Stock', 'SKU'];
  const csvLines = [header.join(',')];
  for (const r of rows) {
    csvLines.push([r.name, r.quantity, r.sku].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
  }
  const csv = csvLines.join('\n');

  const preview = await previewImport(csv, date, { productName: 'Product Name', quantity: 'Current Stock', sku: 'SKU', warehouse: null });
  const result = await confirmImport(preview, { uploadedBy: uploadedBy || 'مدير المخزون', filename: 'real_stock_list.csv' });
  return { ...result, totalRows: rows.length, matched: preview.matched.length, unmatched: preview.unmatched };
}

// ---------------------------------------------------------------------------
// Unmatched-product manual connection (spec section 10) — remembered for
// every future upload via InventoryNameMapping.
// ---------------------------------------------------------------------------

export async function connectUnmatchedProduct(excelName, productId) {
  return InventoryNameMapping.save({ excelNameKey: normalizeName(excelName), excelNameOriginal: excelName, productId });
}

/** Every unmatched name from any past import batch that hasn't since been connected to a product — the durable ❓ Unmatched Products list (spec section 10). */
export async function getUnresolvedUnmatched() {
  const [batches, nameMappings] = await Promise.all([InventoryImportBatches.all(), InventoryNameMapping.all()]);
  const resolvedKeys = new Set(nameMappings.map((m) => m.excel_name_key));
  const seen = new Map();
  for (const batch of batches) {
    for (const row of batch.unmatched || []) {
      const key = normalizeName(row.excelName);
      if (resolvedKeys.has(key) || seen.has(key)) continue;
      seen.set(key, { ...row, batchDate: batch.date });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Manual reclassification (spec section 7) — after import, the admin can
// correct a plain OUT/ADDED guess to RETURNED/DAMAGED/ADJUSTMENT once they
// know the real reason. Always logged, so the correction itself is
// traceable, not just the resulting number.
// ---------------------------------------------------------------------------

export async function reclassifySnapshot(productId, date, movementType, notes, updatedBy) {
  const existing = await InventorySnapshots.find(productId, date);
  if (!existing) throw new Error('لا يوجد سجل مخزون لهذا المنتج في هذا التاريخ.');
  const updated = await InventorySnapshots.upsert({ ...existing, movement_type: movementType, notes, updated_by: updatedBy || 'admin' });
  await InventoryMovementLog.log({
    date,
    product_id: productId,
    product_name: existing.product_name,
    previous_qty: existing.opening_stock,
    new_qty: existing.closing_stock,
    diff: existing.stock_change,
    movement_type: movementType,
    notes: notes || `أعيد تصنيفها يدويًا`,
    updated_by: updatedBy || 'admin',
    batch_id: null,
  });
  return updated;
}

/** Manual, no-Excel snapshot entry — same pipeline as an import row of one, for a single product without waiting for the next file upload. */
export async function manualSnapshot(productId, date, newStock, movementType, notes, updatedBy) {
  const product = await Products.get(productId);
  const previousStock = await lastKnownStock(productId, date, product);
  const auto = classifyMovement(previousStock, newStock);
  const finalType = movementType || auto.type;
  const updated = await InventorySnapshots.upsert({
    product_id: productId,
    product_name: product.product_name,
    date,
    opening_stock: previousStock,
    closing_stock: newStock,
    units_out: finalType === 'OUT' ? auto.unitsOut : 0,
    stock_change: auto.stockChange,
    movement_type: finalType,
    source: 'manual',
    batch_id: null,
    notes: notes || null,
    updated_by: updatedBy || 'admin',
  });
  await InventoryMovementLog.log({
    date,
    product_id: productId,
    product_name: product.product_name,
    previous_qty: previousStock,
    new_qty: newStock,
    diff: auto.stockChange,
    movement_type: finalType,
    notes: notes || 'إدخال يدوي',
    updated_by: updatedBy || 'admin',
    batch_id: null,
  });
  await Products.update(productId, { current_stock: newStock });
  return updated;
}

// ---------------------------------------------------------------------------
// Read-side aggregations for the UI
// ---------------------------------------------------------------------------

export async function getTodaysOutgoing(date) {
  const snapshots = await InventorySnapshots.forDate(date);
  return snapshots.filter((s) => s.movement_type === 'OUT' && (s.units_out || 0) > 0).sort((a, b) => (b.units_out || 0) - (a.units_out || 0));
}

export async function getWarehouseSummary(date) {
  const [snapshots, settings] = await Promise.all([InventorySnapshots.forDate(date), Settings.get()]);
  return buildWarehouseSummary(snapshots, settings.lowStockUnitsThreshold);
}

export async function getLowStockAndOutOfStock(date) {
  const [snapshots, settings] = await Promise.all([InventorySnapshots.forDate(date), Settings.get()]);
  return {
    lowStock: snapshots.filter((s) => s.closing_stock > 0 && s.closing_stock <= settings.lowStockUnitsThreshold),
    outOfStock: snapshots.filter((s) => s.closing_stock === 0),
  };
}

export async function getHighDemandProducts(date) {
  const settings = await Settings.get();
  const todaySnapshots = await InventorySnapshots.forDate(date);
  const results = [];
  for (const s of todaySnapshots) {
    if (s.movement_type !== 'OUT') continue;
    const history = await InventorySnapshots.forProduct(s.product_id);
    const yesterday = history.filter((h) => h.date < date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const yesterdayOut = yesterday && yesterday.movement_type === 'OUT' ? yesterday.units_out : 0;
    if (s.units_out >= (yesterdayOut || 0) * settings.highDemandMultiplier && s.units_out - (yesterdayOut || 0) >= 5) {
      results.push({ ...s, yesterdayOut });
    }
  }
  return results;
}

/** 📉 كان بيخرج كتير وبقى قليل — products whose own outgoing pace dropped meaningfully vs yesterday (spec section 5). */
export async function getDecliningOutgoing(date) {
  const todaySnapshots = (await InventorySnapshots.forDate(date)).filter((s) => s.movement_type === 'OUT');
  const results = [];
  for (const s of todaySnapshots) {
    const history = await InventorySnapshots.forProduct(s.product_id);
    const yesterday = history.filter((h) => h.date < date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const yesterdayOut = yesterday && yesterday.movement_type === 'OUT' ? yesterday.units_out : null;
    if (isMeaningfulOutgoingDrop(yesterdayOut, s.units_out)) {
      results.push({ ...s, yesterdayOut, drop: yesterdayOut - s.units_out });
    }
  }
  return results.sort((a, b) => b.drop - a.drop);
}

/** 🛒 الأوردرات — yesterday vs today orders for every product tracked in inventory today, joined by the SAME product_id (spec section 6/12: one product identity everywhere). */
export async function getOrdersComparison(date) {
  const snapshots = await InventorySnapshots.forDate(date);
  const yesterday = addDays(date, -1);
  const results = [];
  for (const s of snapshots) {
    const [todayOrders, yesterdayOrders] = await Promise.all([DailyOrders.find(s.product_id, date), DailyOrders.find(s.product_id, yesterday)]);
    const todayCount = todayOrders ? todayOrders.orders_count : null;
    const yesterdayCount = yesterdayOrders ? yesterdayOrders.orders_count : null;
    const diff = todayCount !== null && yesterdayCount !== null ? todayCount - yesterdayCount : null;
    results.push({
      product_id: s.product_id,
      product_name: s.product_name,
      yesterdayOrders: yesterdayCount,
      todayOrders: todayCount,
      diff,
      combinedStatus: combinedProductStatus(s.movement_type === 'OUT', diff),
    });
  }
  return results;
}

export async function getProductInventoryHistory(productId) {
  return InventorySnapshots.forProduct(productId);
}

export async function getReconciliation(date) {
  const [orders, snapshots] = await Promise.all([DailyOrders.forDate(date), InventorySnapshots.forDate(date)]);
  const ordersToday = orders.reduce((sum, o) => sum + (o.orders_count || 0), 0);
  const unitsOutToday = snapshots.reduce((sum, s) => sum + (s.movement_type === 'OUT' ? s.units_out || 0 : 0), 0);
  return { ordersToday, unitsOutToday, ...reconcileOrdersVsInventory(ordersToday, unitsOutToday) };
}

/**
 * The full 📦 المخزون list — EVERY active product from the single Products
 * source of truth, left-joined with today's snapshot if one exists. A
 * product with no snapshot yet shows as "not tracked" (never a fabricated
 * zero) rather than being invisible — this is what makes Inventory pull
 * automatically from the existing product list instead of only showing
 * whatever happened to be in the last uploaded file (spec: "if a product
 * exists in the main system it should automatically appear in Inventory").
 * Deleting/deactivating a product removes it from here too, since this
 * always reads the live Products list fresh — there is no separate
 * inventory-product table to fall out of sync.
 */
export async function getFullComparison(date) {
  const [products, snapshots] = await Promise.all([Products.all(), InventorySnapshots.forDate(date)]);
  const snapshotByProduct = new Map(snapshots.map((s) => [s.product_id, s]));

  const rows = products
    .filter((p) => p.active)
    .map((p) => {
      const s = snapshotByProduct.get(p.id);
      if (s) {
        return { ...s, status: classifyProductStatus(s.closing_stock, s.movement_type === 'OUT' ? s.units_out : 0), tracked: true };
      }
      return {
        product_id: p.id,
        product_name: p.product_name,
        opening_stock: null,
        closing_stock: null,
        units_out: null,
        movement_type: 'UNKNOWN',
        status: PRODUCT_STATUS.NOT_TRACKED,
        tracked: false,
      };
    });

  // Tracked-with-movement first (highest out first), then tracked-no-movement, then not-tracked — mirrors what a manager actually cares about, top to bottom.
  return rows.sort((a, b) => {
    if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
    return (b.units_out || 0) - (a.units_out || 0);
  });
}

/** No-movement products today, each with its consecutive-day streak and alert level (spec section 6). */
export async function getNoMovementWithStreaks(date) {
  const snapshots = await InventorySnapshots.forDate(date);
  const noMovement = snapshots.filter((s) => s.movement_type === 'NONE');
  const results = [];
  for (const s of noMovement) {
    const history = await InventorySnapshots.forProduct(s.product_id);
    const upToToday = history.filter((h) => h.date <= date);
    const streak = computeNoMovementStreak(upToToday);
    results.push({ ...s, streak, alertLevel: noMovementAlertLevel(streak) });
  }
  return results.sort((a, b) => b.streak - a.streak);
}

export async function buildDailyInventoryReport(date) {
  const [snapshots, summary, reconciliation] = await Promise.all([InventorySnapshots.forDate(date), getWarehouseSummary(date), getReconciliation(date)]);
  const top = topOutgoingProducts(snapshots, 3);
  const stockAdded = snapshots.filter((s) => s.movement_type === 'ADDED');
  const returned = snapshots.filter((s) => s.movement_type === 'RETURNED');
  const damaged = snapshots.filter((s) => s.movement_type === 'DAMAGED');

  return { date, summary, top, stockAdded, returned, damaged, reconciliation };
}
