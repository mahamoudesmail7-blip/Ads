// inventory-tracker.js — pure logic for the Daily Stock Tracking module.
// No DOM/IndexedDB. Distinct from inventory.js (the V2 "days of stock
// remaining, projected from sales velocity" layer, unchanged) — this module
// is about the INVENTORY MANAGER's own daily physical count: what the
// warehouse reports leaving each day, read from an uploaded spreadsheet.

/**
 * Classifies a stock change WITHOUT assuming every decrease is "out" or
 * every increase is a mistake (spec section 7's core requirement). This is
 * only the DEFAULT classification from the two numbers alone — a human can
 * always override it afterward (RETURNED/DAMAGED/ADJUSTMENT), which is why
 * this function only ever returns OUT/ADDED/NONE, never those three.
 */
export function classifyMovement(previousStock, currentStock) {
  if (previousStock === null || currentStock === null) {
    return { type: 'UNKNOWN', unitsOut: null, stockChange: null };
  }
  const change = currentStock - previousStock;
  if (change < 0) return { type: 'OUT', unitsOut: Math.abs(change), stockChange: change };
  if (change > 0) return { type: 'ADDED', unitsOut: 0, stockChange: change };
  return { type: 'NONE', unitsOut: 0, stockChange: 0 };
}

export const MOVEMENT_TYPES = {
  OUT: { code: 'OUT', icon: '📦', label: 'صادر' },
  ADDED: { code: 'ADDED', icon: '📥', label: 'مخزون جديد' },
  RETURNED: { code: 'RETURNED', icon: '↩️', label: 'مرتجع' },
  DAMAGED: { code: 'DAMAGED', icon: '💥', label: 'تالف' },
  ADJUSTMENT: { code: 'ADJUSTMENT', icon: '🖊️', label: 'تسوية يدوية' },
  NONE: { code: 'NONE', icon: '➖', label: 'بدون حركة' },
  UNKNOWN: { code: 'UNKNOWN', icon: '❔', label: 'غير معروف' },
};

/** ⚠️ Low stock — stock is above zero but at/under the threshold. */
export function lowStockAlert(currentStock, threshold) {
  if (currentStock === null || threshold === null) return false;
  return currentStock > 0 && currentStock <= threshold;
}

/** 🔴 Out of stock — exactly zero (not "no data"). */
export function outOfStockAlert(currentStock) {
  return currentStock === 0;
}

/**
 * 🔥 High outgoing movement — today's units-out is at least `multiplier`×
 * yesterday's, with a minimum absolute jump so a 1-unit-to-2-units blip on a
 * tiny product doesn't trigger a false "high demand" alert.
 */
export function highDemandAlert(yesterdayUnitsOut, todayUnitsOut, multiplier = 2, minAbsoluteJump = 5) {
  if (yesterdayUnitsOut === null || todayUnitsOut === null) return false;
  if (todayUnitsOut < yesterdayUnitsOut + minAbsoluteJump) return false;
  if (yesterdayUnitsOut === 0) return todayUnitsOut >= minAbsoluteJump;
  return todayUnitsOut >= yesterdayUnitsOut * multiplier;
}

/**
 * Aggregates one day's snapshots into the "Today's Warehouse Activity"
 * summary (spec section 4/13). `snapshots` = today's inventory_snapshots
 * rows; `lowStockThreshold` matches the alert threshold used elsewhere.
 */
export function buildWarehouseSummary(snapshots, lowStockThreshold) {
  const totalProducts = snapshots.length;
  const withMovement = snapshots.filter((s) => s.movement_type !== 'NONE' && s.movement_type !== 'UNKNOWN');
  const totalUnitsOutToday = snapshots.reduce((sum, s) => sum + (s.movement_type === 'OUT' ? s.units_out || 0 : 0), 0);
  const totalUnitsAvailable = snapshots.reduce((sum, s) => sum + (s.closing_stock ?? 0), 0);
  const noMovement = snapshots.filter((s) => s.movement_type === 'NONE').length;
  const lowStock = snapshots.filter((s) => lowStockAlert(s.closing_stock, lowStockThreshold)).length;
  const outOfStock = snapshots.filter((s) => outOfStockAlert(s.closing_stock)).length;

  return {
    totalProducts,
    productsWithMovement: withMovement.length,
    totalUnitsOutToday,
    totalUnitsAvailable,
    productsWithNoMovement: noMovement,
    lowStockProducts: lowStock,
    outOfStockProducts: outOfStock,
  };
}

/**
 * Reconciliation between orders received today and units physically marked
 * "out" in inventory today (spec section 12). A positive `diff` means more
 * orders than recorded outgoing units — a plausible pending/unpacked order
 * signal, never asserted as a definite cause.
 */
export function reconcileOrdersVsInventory(ordersToday, unitsOutToday) {
  if (ordersToday === null || unitsOutToday === null) return { diff: null, message: null };
  const diff = ordersToday - unitsOutToday;
  if (diff === 0) return { diff, message: null };
  if (diff > 0) {
    return { diff, message: `⚠️ فرق ملحوظ: ${diff} ${diff === 1 ? 'أوردر' : 'أوردرات'} لسه ما اتسجلش لهم خروج من المخزون.` };
  }
  return { diff, message: `⚠️ فرق ملحوظ: عدد الوحدات الخارجة من المخزون أكبر من عدد الأوردرات بـ${Math.abs(diff)}.` };
}

/**
 * Ranks today's snapshots by |units_out| for the "🥇🥈🥉 top outgoing
 * products" section of the daily report — importance/impact, not
 * alphabetical, matching the same convention used everywhere else in this
 * app (task lists, the dashboard comparison table).
 */
export function topOutgoingProducts(snapshots, max = 3) {
  return [...snapshots]
    .filter((s) => s.movement_type === 'OUT' && (s.units_out || 0) > 0)
    .sort((a, b) => (b.units_out || 0) - (a.units_out || 0))
    .slice(0, max);
}

// ---------------------------------------------------------------------------
// Flexible column mapping + row parsing (spec sections 9, 11) — pure, no
// DOM/IndexedDB, so the header-guessing heuristic and row validation are
// independently testable from the actual file-upload wiring.
// ---------------------------------------------------------------------------

const COLUMN_KEYWORDS = {
  productName: ['product', 'name', 'منتج', 'اسم', 'الصنف'],
  quantity: ['stock', 'qty', 'quantity', 'كمية', 'مخزون', 'رصيد', 'الكمية'],
  sku: ['sku', 'code', 'كود'],
  warehouse: ['warehouse', 'مخزن', 'فرع', 'store'],
};

/** Best-guess column mapping from a header row, so a well-labeled file never needs manual mapping at all. Returns {productName, quantity, sku, warehouse} as header strings or null. */
export function guessColumnMapping(headers) {
  const lower = headers.map((h) => String(h || '').trim().toLowerCase());
  const findFor = (keywords) => {
    const idx = lower.findIndex((h) => keywords.some((k) => h.includes(k)));
    return idx === -1 ? null : headers[idx];
  };
  return {
    productName: findFor(COLUMN_KEYWORDS.productName),
    quantity: findFor(COLUMN_KEYWORDS.quantity),
    sku: findFor(COLUMN_KEYWORDS.sku),
    warehouse: findFor(COLUMN_KEYWORDS.warehouse),
  };
}

/**
 * Applies a column mapping to raw CSV rows, validating each one. Never
 * matches against products here (that needs the live product list — see
 * inventory-store.js) — this only extracts and sanity-checks the row data
 * itself: a missing name or a non-numeric/negative quantity is invalid and
 * excluded from the importable set (spec section 11: "do not save
 * automatically if critical errors exist").
 */
export function parseImportRows(rows, headers, mapping) {
  const nameIdx = headers.indexOf(mapping.productName);
  const qtyIdx = headers.indexOf(mapping.quantity);
  const skuIdx = mapping.sku ? headers.indexOf(mapping.sku) : -1;
  const warehouseIdx = mapping.warehouse ? headers.indexOf(mapping.warehouse) : -1;

  const valid = [];
  const invalid = [];

  rows.forEach((row, i) => {
    const rowNumber = i + 2; // +1 for 0-index, +1 for the header row itself
    const name = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';
    const rawQty = qtyIdx >= 0 ? row[qtyIdx] : undefined;
    const qty = Number(String(rawQty ?? '').trim());
    const sku = skuIdx >= 0 ? String(row[skuIdx] || '').trim() : '';
    const warehouse = warehouseIdx >= 0 ? String(row[warehouseIdx] || '').trim() : '';

    if (!name) {
      invalid.push({ rowNumber, reason: 'اسم المنتج مفقود', raw: row });
      return;
    }
    if (rawQty === undefined || rawQty === '' || Number.isNaN(qty) || qty < 0) {
      invalid.push({ rowNumber, reason: `كمية غير صالحة: "${rawQty ?? ''}"`, raw: row, name });
      return;
    }
    valid.push({ rowNumber, name, quantity: qty, sku: sku || null, warehouse: warehouse || null });
  });

  return { valid, invalid };
}

/** Names appearing more than once in the SAME uploaded file (normalized, case-insensitive) — spec section 11's "duplicate products" check. */
export function findDuplicateNames(parsedRows) {
  const seen = new Map();
  for (const r of parsedRows) {
    const key = r.name.trim().toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Simple product status (spec: "simple on the surface, powerful underneath")
// — one glance-able badge per product, no percentages or multi-factor
// scores. OUT_OF_STOCK always wins regardless of movement; NO_MOVEMENT
// always wins over a movement-size tier since "zero" is qualitatively
// different from "a little."
// ---------------------------------------------------------------------------

export const PRODUCT_STATUS = {
  HIGH_MOVEMENT: { code: 'HIGH_MOVEMENT', icon: '🔥', label: 'حركة قوية' },
  NORMAL_MOVEMENT: { code: 'NORMAL_MOVEMENT', icon: '🟢', label: 'حركة طبيعية' },
  LOW_MOVEMENT: { code: 'LOW_MOVEMENT', icon: '🟡', label: 'حركة ضعيفة' },
  NO_MOVEMENT: { code: 'NO_MOVEMENT', icon: '⚪', label: 'بدون حركة' },
  OUT_OF_STOCK: { code: 'OUT_OF_STOCK', icon: '🔴', label: 'نفد من المخزون' },
  // A real product that exists in the system but has no inventory snapshot
  // for this date yet (never uploaded) — distinct from NO_MOVEMENT (which
  // means "we checked and it's zero"), never guessed as zero.
  NOT_TRACKED: { code: 'NOT_TRACKED', icon: '➖', label: 'لسه معملوش تتبع' },
};

/** @param {number|null} currentStock @param {number|null} unitsOut (0 when movement isn't OUT) */
export function classifyProductStatus(currentStock, unitsOut) {
  if (currentStock === 0) return PRODUCT_STATUS.OUT_OF_STOCK;
  const out = unitsOut || 0;
  if (out === 0) return PRODUCT_STATUS.NO_MOVEMENT;
  if (out >= 15) return PRODUCT_STATUS.HIGH_MOVEMENT;
  if (out >= 6) return PRODUCT_STATUS.NORMAL_MOVEMENT;
  return PRODUCT_STATUS.LOW_MOVEMENT;
}

// ---------------------------------------------------------------------------
// No-movement streak (spec section 6) — how many consecutive most-recent
// days (ending at the last one in `history`) had zero movement.
// ---------------------------------------------------------------------------

/** @param {{date:string, movement_type:string}[]} history sorted ascending by date, ending at "today" */
export function computeNoMovementStreak(history) {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].movement_type === 'NONE') streak++;
    else break;
  }
  return streak;
}

export const NO_MOVEMENT_LEVEL = {
  NORMAL: { code: 'NORMAL', icon: '⚪', label: 'عادي' },
  NEEDS_ATTENTION: { code: 'NEEDS_ATTENTION', icon: '🟡', label: 'يحتاج انتباه' },
  HIGH_PRIORITY: { code: 'HIGH_PRIORITY', icon: '🔴', label: 'أولوية عالية — بدون حركة منذ 7 أيام' },
};

export function noMovementAlertLevel(streakDays) {
  if (streakDays >= 7) return NO_MOVEMENT_LEVEL.HIGH_PRIORITY;
  if (streakDays >= 2) return NO_MOVEMENT_LEVEL.NEEDS_ATTENTION;
  return NO_MOVEMENT_LEVEL.NORMAL;
}

// ---------------------------------------------------------------------------
// 📉 كان بيخرج كتير وبقى قليل — a product whose OWN outgoing pace dropped
// meaningfully vs yesterday. Deliberately a higher bar than "any decrease"
// (spec: "Only show products where the decrease is meaningful. Do not show
// every tiny change.") — requires both a minimum absolute drop AND that
// today is at most half of yesterday's pace, so a 15→13 wobble on a
// naturally busy product doesn't qualify.
// ---------------------------------------------------------------------------

export function isMeaningfulOutgoingDrop(yesterdayOut, todayOut, minAbsoluteDrop = 5) {
  if (yesterdayOut === null || todayOut === null) return false;
  const drop = yesterdayOut - todayOut;
  if (drop < minAbsoluteDrop) return false;
  return todayOut <= yesterdayOut / 2;
}

// ---------------------------------------------------------------------------
// Combined status (spec section 13) — the ONE badge that folds inventory
// movement + order trend together for a product overview, so "is this
// product actually doing okay" doesn't require reading two separate
// numbers and doing the math yourself. Orders are the decisive signal
// (rising orders is good even if stock is depleting because of it); a
// product with NO inventory movement AND flat-or-falling orders is the
// one combination that specifically needs a human's attention.
// ---------------------------------------------------------------------------

export const COMBINED_STATUS = {
  GOOD: { code: 'GOOD', icon: '📈', label: 'كويس' },
  DOWN: { code: 'DOWN', icon: '📉', label: 'نازل' },
  NEEDS_ATTENTION: { code: 'NEEDS_ATTENTION', icon: '🚫', label: 'محتاج متابعة' },
  NORMAL: { code: 'NORMAL', icon: '➖', label: 'عادي' },
};

/** @param {boolean} hasInventoryMovement today's movement_type === 'OUT' (or any real movement) @param {number|null} orderDiff todayOrders - yesterdayOrders */
export function combinedProductStatus(hasInventoryMovement, orderDiff) {
  if (orderDiff === null || orderDiff === undefined) return COMBINED_STATUS.NORMAL;
  if (!hasInventoryMovement && orderDiff <= 0) return COMBINED_STATUS.NEEDS_ATTENTION;
  if (orderDiff > 0) return COMBINED_STATUS.GOOD;
  if (orderDiff < 0) return COMBINED_STATUS.DOWN;
  return COMBINED_STATUS.NORMAL;
}
