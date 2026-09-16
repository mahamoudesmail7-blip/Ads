// Import historical orders from a merchant-exported Easy Orders Excel file.
// Easy Orders' real API has no bulk "list orders" endpoint at all (confirmed
// empirically — see routes/webhooks.js's header comment) and no way to
// replay past webhook events, so the merchant's own dashboard "Export"
// button is the ONLY real way historical orders can reach this system.
//
// Every parsed row is converted into the SAME shape a live webhook payload
// has, then run through the exact same ingestOrder() the webhook itself
// uses — an imported order gets identical customer-linking, daily-aggregate
// recompute, and lost-order detection, with zero duplicated logic.
// Idempotent via ingestOrder()'s own upsert-by-(order_id, cart_item_id):
// re-running the same file twice, or the server restarting mid-import,
// never creates a duplicate order or double-counts a customer's stats.
//
// Column positions below are confirmed against a REAL 6,988-row export
// (2026-09-16) — not guessed from a generic template. If Easy Orders ever
// changes their export's column order, parseExportBuffer will silently read
// the wrong field, so a spot-check of a fresh import's summary against a
// few real orders is worth doing after any long gap since this was written.
import ExcelJS from 'exceljs';
import { ingestOrder } from './easyOrders.js';
import { logger } from '../logger.js';

// The real export has exactly one row per order (confirmed: zero duplicate
// Order IDs across the 6,988-row sample) — every row becomes a single
// synthetic cart item. A genuinely multi-item order would only show its
// first product here; that is Easy Orders' own export's limitation, not
// something recoverable from this file.
const SYNTHETIC_CART_ITEM_ID = 'xlsx-import';

const COL = {
  ID: 1, STATUS: 2, FULL_NAME: 3, PHONE: 4, CITY: 5, ADDRESS: 6,
  TOTAL_COST: 7, PRODUCT_COST: 8, SHIPPING_COST: 9, PRODUCT_NAME: 12,
  QUANTITY: 14, SKU: 15, CREATED_AT: 17, PAYMENT_METHOD: 25, ORDER_ID: 28,
};

/**
 * "in_delivery" (out for delivery, not yet arrived) would otherwise match
 * easyOrders.js's normalizeStatus()'s generic `.includes('deliver')` rule
 * and get misclassified as DELIVERED — confirmed present in the real
 * export (3 of 6,988 rows). Corrected to the closest real meaning
 * (confirmed, en route — not yet actually delivered) ONLY for this
 * importer, without touching the shared normalizeStatus() every other
 * caller (the live webhook included) already relies on as-is.
 */
function correctedRawStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'in_delivery') return 'confirmed';
  return raw;
}

function cellText(v) {
  if (v == null) return null;
  if (typeof v === 'object' && v && 'text' in v) return String(v.text).trim() || null; // rich-text cells
  if (typeof v === 'object' && v && v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  return s || null;
}
function cellNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Reads the workbook and returns every row as a synthetic webhook-shaped order, plus any row skipped for lacking the one field nothing else can substitute for (the real Order ID). Never throws on a single bad row. */
export async function parseExportBuffer(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { rows: [], skipped: [{ row: 0, reason: 'الملف فارغ أو مش بصيغة Excel صحيحة.' }] };

  const rows = [];
  const skipped = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const get = (col) => row.getCell(col).value;
    const orderId = cellText(get(COL.ORDER_ID));
    if (!orderId) { skipped.push({ row: rowNumber, reason: 'لا يوجد Order ID (UUID) في هذا الصف — مش قادرين نستوردها من غيره.' }); return; }

    rows.push({
      id: orderId,
      status: correctedRawStatus(cellText(get(COL.STATUS))),
      full_name: cellText(get(COL.FULL_NAME)),
      phone: cellText(get(COL.PHONE)),
      government: cellText(get(COL.CITY)),
      address: cellText(get(COL.ADDRESS)),
      cost: cellNumber(get(COL.PRODUCT_COST)),
      shipping_cost: cellNumber(get(COL.SHIPPING_COST)),
      total_cost: cellNumber(get(COL.TOTAL_COST)),
      payment_method: cellText(get(COL.PAYMENT_METHOD)),
      created_at: cellText(get(COL.CREATED_AT)) || new Date().toISOString(),
      cart_items: [{
        id: SYNTHETIC_CART_ITEM_ID,
        quantity: cellNumber(get(COL.QUANTITY)) || 1,
        product: { sku: cellText(get(COL.SKU)), name: cellText(get(COL.PRODUCT_NAME)), id: null },
      }],
    });
  });
  return { rows, skipped };
}

// In-memory job registry — one Node process, no persistence. Acceptable for
// a rare admin-triggered one-off: a job lost to a server restart is safe to
// just re-run (idempotent upserts), never a duplicate or corrupted record.
const jobs = new Map();
let activeJobId = null;

export function getImportJob(jobId) {
  return jobs.get(jobId) || null;
}

export async function startImport({ buffer, storeId, userId }) {
  if (activeJobId) {
    const active = jobs.get(activeJobId);
    if (active?.status === 'RUNNING') {
      const e = new Error('فيه عملية استيراد شغالة بالفعل — لازم تستنى تخلص الأول.');
      e.status = 409;
      throw e;
    }
  }

  const { rows, skipped } = await parseExportBuffer(buffer);
  const jobId = `imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id: jobId, storeId, userId, status: 'RUNNING',
    totalRows: rows.length, processed: 0, imported: 0, failed: 0,
    parseSkipped: skipped, errors: [],
    startedAt: new Date().toISOString(), finishedAt: null,
  };
  jobs.set(jobId, job);
  activeJobId = jobId;

  // Fire-and-forget — the route responds immediately with jobId; the caller
  // polls GET .../:jobId for progress. Sequential (not parallel) so this
  // never floods the DB pool, and each row's own await naturally yields the
  // event loop, keeping the server responsive to other requests throughout.
  (async () => {
    for (const order of rows) {
      try {
        await ingestOrder(order, storeId);
        job.imported++;
      } catch (err) {
        job.failed++;
        if (job.errors.length < 50) job.errors.push({ orderId: order.id, message: err.message }); // capped so one systemic failure mode never blows up memory
        logger.warn('[EasyOrdersImport] row failed', { orderId: order.id, message: err.message });
      }
      job.processed++;
    }
    job.status = 'DONE';
    job.finishedAt = new Date().toISOString();
    if (activeJobId === jobId) activeJobId = null;
  })().catch((err) => {
    job.status = 'FAILED';
    job.finishedAt = new Date().toISOString();
    job.fatalError = err.message;
    logger.error('[EasyOrdersImport] job crashed', { jobId, message: err.message });
    if (activeJobId === jobId) activeJobId = null;
  });

  return { jobId, totalRows: rows.length, parseSkippedCount: skipped.length };
}
