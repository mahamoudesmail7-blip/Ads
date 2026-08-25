// db.js — Data access layer (repository pattern), now backed by the
// backend REST API instead of IndexedDB. Every exported name, function
// signature, and return shape below is IDENTICAL to the IndexedDB version
// this replaces — every other page/module in the app (dashboard.js,
// products.js, tasks.js, manager.js, inventory-store.js, product-details.js,
// ...) calls these same functions and never notices the swap. This is
// exactly the migration path this file's own original header comment
// anticipated: "swapping this module for a real fetch()-based API client
// later will not require touching any page or business-logic code."
//
// All actual network calls go through js/api-client.js — nowhere else in
// the frontend calls fetch() against the backend.
import { api } from './api-client.js';

/** Number(v) if v was actually provided, else null (never 0) — keeps "not set" distinct from "set to zero". Same rule the IndexedDB version used for Products.create(). */
function optNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const Products = {
  async all() {
    return api.get('/api/products');
  },

  async get(id) {
    return api.get(`/api/products/${Number(id)}`);
  },

  async findBySku(sku) {
    const found = await api.get(`/api/products/by-sku/${encodeURIComponent(sku)}`);
    return found ?? null;
  },

  async findByCode(productCode) {
    if (!productCode) return null;
    const found = await api.get(`/api/products/by-code/${encodeURIComponent(productCode)}`);
    return found ?? null;
  },

  async findDuplicate({ product_name, sku }) {
    return api.get('/api/products/find-duplicate', { product_name, sku });
  },

  async nextProductCode() {
    const { code } = await api.get('/api/products/next-code');
    return code;
  },

  async create(product) {
    const record = {
      product_name: product.product_name.trim(),
      sku: (product.sku || '').trim(),
      product_code: product.product_code ? String(product.product_code).trim() : null,
      category: product.category ? String(product.category).trim() : null,
      selling_price: Number(product.selling_price) || 0,
      product_cost: Number(product.product_cost) || 0,
      active: product.active !== false,
      is_demo: product.is_demo === true,
      shipping_cost: optNum(product.shipping_cost),
      packaging_cost: optNum(product.packaging_cost),
      other_cost: optNum(product.other_cost),
      advertising_cost: optNum(product.advertising_cost),
      expected_return_cost: optNum(product.expected_return_cost),
      commission: optNum(product.commission),
      current_stock: optNum(product.current_stock),
      minimum_stock: optNum(product.minimum_stock),
      supplier: product.supplier ? String(product.supplier).trim() : null,
      restock_quantity: optNum(product.restock_quantity),
      last_restock_date: product.last_restock_date || null,
    };
    return api.post('/api/products', record);
  },

  async update(id, patch) {
    return api.patch(`/api/products/${Number(id)}`, patch);
  },

  async remove(id) {
    await api.delete(`/api/products/${Number(id)}`);
  },
};

// ---------------------------------------------------------------------------
// Daily Orders
// ---------------------------------------------------------------------------

export const DailyOrders = {
  async all() {
    return api.get('/api/orders');
  },

  async forProduct(productId) {
    return api.get('/api/orders', { productId: Number(productId) });
  },

  async forDate(date) {
    return api.get('/api/orders', { date });
  },

  async find(productId, date) {
    return api.get('/api/orders', { productId: Number(productId), date });
  },

  async upsert({ product_id, date, orders_count, delivered_count, returned_count, notes, is_demo = false, source }) {
    return api.post('/api/orders/upsert', { product_id, date, orders_count, delivered_count, returned_count, notes, is_demo, source });
  },

  async clearDemoOrders() {
    return api.post('/api/orders/clear-demo');
  },

  async remove(id) {
    await api.delete(`/api/orders/${Number(id)}`);
  },
};

// ---------------------------------------------------------------------------
// Settings (single record, id = 'default')
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  id: 'default',
  upThreshold: 15,
  downThreshold: -15,
  criticalThreshold: -35,
  consecutiveDeclineDays: 4,
  exitThreshold: -35,
  exitConsecutiveDays: 4,
  scaleThreshold: 15,
  scaleConsecutiveDays: 3,
  baselinePeriod: 7,
  minDataDaysForTrend: 7,
  lowStockDays: 7,
  criticalStockDays: 3,
  lowStockUnitsThreshold: 10,
  highDemandMultiplier: 2,
  defaultShippingCost: 0,
  defaultPackagingCost: 0,
  lastDemoGeneratedDate: null,
  // AI Intelligence — decision engine thresholds (EGP), spec section 26.
  aiScaleCpaThreshold: 100,
  aiOptimizeCpaThreshold: 130,
  aiMinSpendForDecision: 150,
  aiMinOrdersForDecision: 2,
};

export const Settings = {
  async get() {
    return api.get('/api/settings');
  },

  async save(patch) {
    return api.put('/api/settings', patch);
  },

  async reset() {
    return api.post('/api/settings/reset');
  },
};

// ---------------------------------------------------------------------------
// Product Notes
// ---------------------------------------------------------------------------

export const ProductNotes = {
  async forProduct(productId) {
    return api.get('/api/notes', { productId: Number(productId) });
  },

  async add(productId, text) {
    return api.post('/api/notes', { product_id: Number(productId), text: String(text).trim() });
  },

  async remove(id) {
    await api.delete(`/api/notes/${Number(id)}`);
  },
};

// ---------------------------------------------------------------------------
// Action Log
// ---------------------------------------------------------------------------

export const ACTION_STATUS = {
  COMPLETED: 'COMPLETED',
  NOT_COMPLETED: 'NOT_COMPLETED',
};

export const ActionLog = {
  async all() {
    return api.get('/api/action-log');
  },

  async forProduct(productId) {
    return api.get('/api/action-log', { productId: Number(productId) });
  },

  async get(productId, date) {
    const found = await api.get('/api/action-log', { productId: Number(productId), date });
    return found ?? null;
  },

  async forDate(date) {
    return api.get('/api/action-log', { date });
  },

  async markCompleted(productId, date, meta = {}) {
    return api.post('/api/action-log/complete', {
      productId: Number(productId), date, taskType: meta.taskType, priority: meta.priority, actionLabel: meta.actionLabel, reasonText: meta.reasonText,
    });
  },

  async markNotCompleted(productId, date, meta = {}) {
    return api.post('/api/action-log/not-completed', {
      productId: Number(productId), date, taskType: meta.taskType, priority: meta.priority, actionLabel: meta.actionLabel, reasonText: meta.reasonText, reason: meta.reason, note: meta.note,
    });
  },
};

// ---------------------------------------------------------------------------
// Daily Reports
// ---------------------------------------------------------------------------

export const DailyReports = {
  async get(date, type) {
    const found = await api.get('/api/reports', { date, type });
    return found ?? null;
  },

  async forDate(date) {
    return api.get('/api/reports', { date });
  },

  async all(type) {
    return api.get('/api/reports', { type });
  },

  async save(date, type, summary, reportText) {
    return api.post('/api/reports', { date, type, summary, reportText });
  },
};

// ---------------------------------------------------------------------------
// Team Members
// ---------------------------------------------------------------------------

export const TeamMembers = {
  async all() {
    return api.get('/api/team');
  },

  async create({ name, active = true, daily_task_target = 10 }) {
    return api.post('/api/team', { name, active, daily_task_target });
  },

  async seedDefaultTeam() {
    return api.post('/api/team/seed-default');
  },
};

// ---------------------------------------------------------------------------
// Task Assignments
// ---------------------------------------------------------------------------

export const TaskAssignments = {
  async forDate(date) {
    return api.get('/api/assignments', { date });
  },

  async get(productId, date) {
    const found = await api.get('/api/assignments', { productId: Number(productId), date });
    return found ?? null;
  },

  async assign(productId, date, employeeId) {
    return api.post('/api/assignments/assign', { productId: Number(productId), date, employeeId: Number(employeeId) });
  },

  async bulkAssignNew(date, assignmentMap, alreadyAssignedProductIds) {
    return api.post('/api/assignments/bulk', {
      date,
      assignments: Array.from(assignmentMap.entries()),
      alreadyAssignedProductIds: Array.from(alreadyAssignedProductIds),
    });
  },
};

// ---------------------------------------------------------------------------
// Task Records — cancel is always a soft status change (spec section 26):
// enforced server-side too (no hard-delete route exists for task records).
// ---------------------------------------------------------------------------

export const TASK_STATUS = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  NOT_COMPLETED: 'NOT_COMPLETED',
  OVERDUE: 'OVERDUE',
  CANCELLED: 'CANCELLED',
};

export const TaskRecords = {
  async all() {
    return api.get('/api/tasks');
  },

  async get(id) {
    return api.get('/api/tasks', { id: Number(id) });
  },

  async forDate(date) {
    return api.get('/api/tasks', { date });
  },

  async forProductDate(productId, date) {
    return api.get('/api/tasks', { productId: Number(productId), date });
  },

  async pendingBefore(beforeDate) {
    return api.get(`/api/tasks/pending-before/${beforeDate}`);
  },

  async create(record) {
    return api.post('/api/tasks', record);
  },

  async update(id, patch) {
    return api.patch(`/api/tasks/${Number(id)}`, patch);
  },
};

export const TaskActivityLog = {
  async all() {
    return api.get('/api/tasks/activity');
  },

  async forDate(date) {
    return api.get('/api/tasks/activity', { date });
  },

  async log(entry) {
    return api.post('/api/tasks/activity', entry);
  },
};

// ---------------------------------------------------------------------------
// Inventory Snapshots
// ---------------------------------------------------------------------------

export const InventorySnapshots = {
  async all() {
    return api.get('/api/inventory/snapshots');
  },

  async forDate(date) {
    return api.get('/api/inventory/snapshots', { date });
  },

  async forProduct(productId) {
    return api.get('/api/inventory/snapshots', { productId: Number(productId) });
  },

  async find(productId, date) {
    const found = await api.get('/api/inventory/snapshots', { productId: Number(productId), date });
    return found ?? null;
  },

  async upsert(record) {
    return api.post('/api/inventory/snapshots/upsert', record);
  },
};

// ---------------------------------------------------------------------------
// Inventory Movement Log (append-only)
// ---------------------------------------------------------------------------

export const InventoryMovementLog = {
  async forDate(date) {
    return api.get('/api/inventory/movement-log', { date });
  },

  async forProduct(productId) {
    return api.get('/api/inventory/movement-log', { productId: Number(productId) });
  },

  async log(entry) {
    return api.post('/api/inventory/movement-log', entry);
  },
};

// ---------------------------------------------------------------------------
// Column mapping (remembered)
// ---------------------------------------------------------------------------

export const InventoryColumnMapping = {
  async get() {
    return api.get('/api/inventory/column-mapping');
  },

  async save(mapping) {
    return api.put('/api/inventory/column-mapping', mapping);
  },
};

// ---------------------------------------------------------------------------
// Name mapping (remembered unmatched-name -> product_id overrides)
// ---------------------------------------------------------------------------

export const InventoryNameMapping = {
  async all() {
    return api.get('/api/inventory/name-mapping');
  },

  async find(excelNameKey) {
    const found = await api.get(`/api/inventory/name-mapping/${encodeURIComponent(excelNameKey)}`);
    return found ?? null;
  },

  async save({ excelNameKey, excelNameOriginal, productId }) {
    return api.post('/api/inventory/name-mapping', { excelNameKey, excelNameOriginal, productId: Number(productId) });
  },
};

// ---------------------------------------------------------------------------
// Import batches
// ---------------------------------------------------------------------------

export const InventoryImportBatches = {
  async all() {
    return api.get('/api/inventory/batches');
  },

  async forDate(date) {
    return api.get('/api/inventory/batches', { date });
  },

  async create(record) {
    return api.post('/api/inventory/batches', record);
  },
};

// ---------------------------------------------------------------------------
// Danger-zone helpers (Settings page "reset demo data" action)
// ---------------------------------------------------------------------------

export async function clearAllData() {
  await api.post('/api/admin/clear-all');
}

export async function clearDemoData() {
  return api.post('/api/admin/clear-demo');
}
