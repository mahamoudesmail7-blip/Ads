// indexeddb-export.js — ONE-TIME migration helper for the "📤 تصدير كل
// البيانات" button in Settings. Reads the browser's EXISTING IndexedDB
// directly (raw indexedDB calls, same DB_NAME/DB_VERSION the old db.js
// used) rather than going through js/db.js — db.js now talks to the new
// backend API instead of IndexedDB, so it can no longer see this data at
// all. This file is the only thing in the app that still touches
// IndexedDB, and it exists solely to get real historical data (the 127-
// product catalog, task/inventory history, …) out before the browser's
// copy becomes stale/unused.
const DB_NAME = 'order_monitor_db';
const DB_VERSION = 8;

// Store name -> key used in the export JSON, matching exactly what
// POST /api/admin/import expects.
const STORES = {
  products: 'products',
  daily_orders: 'daily_orders',
  settings: 'settings',
  product_notes: 'product_notes',
  action_log: 'action_log',
  daily_reports: 'daily_reports',
  team_members: 'team_members',
  task_assignments: 'task_assignments',
  task_records: 'task_records',
  task_activity_log: 'task_activity_log',
  inventory_snapshots: 'inventory_snapshots',
  inventory_movement_log: 'inventory_movement_log',
  inventory_column_mapping: 'inventory_column_mapping',
  inventory_name_mapping: 'inventory_name_mapping',
  inventory_import_batches: 'inventory_import_batches',
};

function openExistingDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // No onupgradeneeded handler on purpose — this only ever opens a DB
    // that's already at DB_VERSION (every browser that has real data to
    // export got there by using the app before this migration existed).
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB مقفولة من تبويب تاني — اقفل أي تبويبات تانية فاتحة للنظام وحاول تاني.'));
  });
}

function getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(storeName)) return resolve(storeName === 'settings' ? null : []);
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Dumps every IndexedDB store into the exact JSON shape POST /api/admin/import expects. `settings` and `inventory_column_mapping` come back as a single row (or null), not the array getAll() returns — matching how db.js's Settings.get()/InventoryColumnMapping.get() always exposed them. */
export async function exportAllDataForMigration() {
  const db = await openExistingDb();
  const raw = {};
  for (const storeName of Object.values(STORES)) {
    raw[storeName] = await getAll(db, storeName);
  }
  db.close();

  return {
    ...raw,
    settings: Array.isArray(raw.settings) ? raw.settings.find((s) => s.id === 'default') || null : raw.settings,
    inventory_column_mapping: Array.isArray(raw.inventory_column_mapping)
      ? raw.inventory_column_mapping.find((m) => m.id === 'default') || null
      : raw.inventory_column_mapping,
  };
}

/** Triggers a browser download of the export as a .json file — the admin then uploads/pastes it wherever the import flow needs it. */
export function downloadAsFile(data, filename = `order-monitor-export-${new Date().toISOString().slice(0, 10)}.json`) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
