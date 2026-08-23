// settings.js — page controller for settings.html (spec section 23) plus
// the demo-data generator entry point (spec section 27).
//
// IMPORTANT: this file used to also wire up a "مسح كل البيانات وإعادة
// التوليد" button (seedDemoData(force:true)) that called db.js's
// clearAllData() — a full wipe of every store, including real products.
// That button is REMOVED. It was a leftover from before the real-product
// catalog / demo-orders-on-real-products architecture existed, its
// wording didn't make the blast radius obvious, and it caused real data
// loss. Nothing in this file (or anywhere reachable from the UI) calls
// clearAllData() anymore — the only "clear" actions left are scoped
// (clearDemoData: only is_demo products; DailyOrders.clearDemoOrders: only
// is_demo orders).
import { Settings, clearDemoData } from './db.js';
import * as UI from './ui-common.js';
import { seedDecisionDemo } from './seed.js';
import { activeOrdersProvider } from './orders-provider.js';
import { exportAllDataForMigration, downloadAsFile } from './indexeddb-export.js';
import { api } from './api-client.js';

const FIELD_MAP = {
  sUp: 'upThreshold',
  sDown: 'downThreshold',
  sCritical: 'criticalThreshold',
  sConsecutive: 'consecutiveDeclineDays',
  sExitThreshold: 'exitThreshold',
  sExitDays: 'exitConsecutiveDays',
  sScaleThreshold: 'scaleThreshold',
  sScaleDays: 'scaleConsecutiveDays',
  sBaselinePeriod: 'baselinePeriod',
  sMinData: 'minDataDaysForTrend',
  sLowStockDays: 'lowStockDays',
  sCriticalStockDays: 'criticalStockDays',
  sDefaultShipping: 'defaultShippingCost',
  sDefaultPackaging: 'defaultPackagingCost',
};

async function init() {
  UI.renderSidebar('settings');
  document.getElementById('providerName').textContent = activeOrdersProvider.name;
  // Wrapped: this page is also opened on a legacy/no-backend origin purely
  // for the migration tools below (📥/📤/👁️) — if the API isn't reachable
  // from here, the threshold form just won't pre-fill, but every button
  // must still get wired up regardless.
  try {
    await loadIntoForm();
  } catch (err) {
    document.getElementById('settingsStatus').textContent = `⚠️ مقدرش أوصل للسيرفر (${err.message}) — لسه تقدر تستخدم أدوات نقل البيانات تحت.`;
  }

  document.getElementById('btnSaveSettings').onclick = saveSettings;
  document.getElementById('btnResetSettings').onclick = resetSettings;
  document.getElementById('btnSeedDownturn').onclick = runSeedDownturn;
  document.getElementById('btnClearDemo').onclick = runClearDemo;
  document.getElementById('btnDownloadBackup').onclick = runDownloadBackup;
  document.getElementById('btnMigrateNow').onclick = runMigrateNow;
  document.getElementById('btnPreviewLocal').onclick = runPreviewLocal;
  document.getElementById('btnImportBackup').onclick = () => document.getElementById('fileImportBackup').click();
  document.getElementById('fileImportBackup').onchange = runImportBackupFile;
}

const RECORD_LABELS_AR = {
  products: 'منتجات', daily_orders: 'سجلات أوردرات يومية', settings: 'إعدادات', product_notes: 'ملاحظات منتجات',
  action_log: 'سجل تنفيذ مهام', daily_reports: 'تقارير يومية', team_members: 'أعضاء الفريق', task_assignments: 'تكليفات مهام',
  task_records: 'مهام (تحكم المدير)', task_activity_log: 'سجل نشاط المهام', inventory_snapshots: 'لقطات مخزون يومية',
  inventory_movement_log: 'سجل حركة المخزون', inventory_column_mapping: 'ربط أعمدة الاستيراد', inventory_name_mapping: 'ربط أسماء منتجات',
  inventory_import_batches: 'دفعات استيراد المخزون',
};

/** No network call at all — pure read of THIS browser's IndexedDB, purely informational (counts before any transfer). */
async function runPreviewLocal() {
  const btn = document.getElementById('btnPreviewLocal');
  btn.disabled = true;
  const status = document.getElementById('migrateStatus');
  status.textContent = 'بيقرأ البيانات المحلية...';
  try {
    const data = await exportAllDataForMigration();
    const lines = [`📍 الرابط الحالي: ${location.origin}`, '', 'عدد السجلات الموجودة فعليًا في متصفحك دلوقتي:'];
    for (const [key, label] of Object.entries(RECORD_LABELS_AR)) {
      const v = data[key];
      const count = Array.isArray(v) ? v.length : v ? 1 : 0;
      lines.push(`  ${label} (${key}): ${count}`);
    }
    status.textContent = lines.join('\n');
  } catch (err) {
    status.textContent = `❌ فشلت المعاينة: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

/** Reads an uploaded backup JSON file (produced by "تنزيل نسخة احتياطية" on a possibly-different origin) and imports it via the CURRENT origin's API — sidesteps the fact that IndexedDB data doesn't travel between different localhost ports/origins. */
async function runImportBackupFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('هينقل كل البيانات اللي في الملف ده للسيرفر الجديد. اتأكد إن ده الملف الصح. متابعة؟')) {
    e.target.value = '';
    return;
  }
  const status = document.getElementById('migrateStatus');
  status.textContent = 'بيقرأ الملف...';
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    status.textContent = 'بينقل البيانات للسيرفر...';
    const result = await api.post('/api/admin/import', data);
    const lines = [`✅ تم النقل بنجاح من الملف.`, ...Object.entries(result.counts).map(([k, v]) => `  ${k}: ${v}`)];
    if (result.generatedLogins?.length) {
      lines.push('', '👤 حسابات دخول جديدة اتعملت للموظفين (بيانات دخول مؤقتة):');
      for (const l of result.generatedLogins) lines.push(`  ${l.name} — ${l.email} — كلمة السر: ${l.tempPassword}`);
    }
    status.textContent = lines.join('\n');
    UI.toast('✅ تم نقل البيانات من الملف');
  } catch (err) {
    status.textContent = `❌ فشل النقل من الملف: ${err.message}`;
  } finally {
    e.target.value = '';
  }
}

async function loadIntoForm() {
  const s = await Settings.get();
  for (const [elId, key] of Object.entries(FIELD_MAP)) {
    document.getElementById(elId).value = s[key];
  }
}

async function saveSettings() {
  const patch = {};
  for (const [elId, key] of Object.entries(FIELD_MAP)) {
    patch[key] = Number(document.getElementById(elId).value);
  }
  await Settings.save(patch);
  document.getElementById('settingsStatus').textContent = `تم الحفظ ✓ (${new Date().toLocaleTimeString('ar-EG')})`;
  UI.toast('تم حفظ الإعدادات');
}

async function resetSettings() {
  if (!confirm('استعادة كل القيم إلى الإعدادات الافتراضية؟')) return;
  await Settings.reset();
  await loadIntoForm();
  UI.toast('تم استعادة الإعدادات الافتراضية');
}

async function runSeedDownturn() {
  const btn = document.getElementById('btnSeedDownturn');
  btn.disabled = true;
  const result = await seedDecisionDemo();
  btn.disabled = false;
  document.getElementById('downturnStatus').textContent = `✅ تم تحميل البيانات التجريبية بنجاح — ${result.productsCreated} منتج جديد / ${result.productsReused} معاد استخدامه، ${result.ordersWritten} سجل أوردر.`;
  UI.toast('✅ تم تحميل البيانات التجريبية بنجاح');
}

async function runClearDemo() {
  if (!confirm('سيتم حذف كل المنتجات التجريبية وبياناتها فقط. أي منتج أضفته يدويًا لن يُحذف. متابعة؟')) return;
  const btn = document.getElementById('btnClearDemo');
  btn.disabled = true;
  const result = await clearDemoData();
  btn.disabled = false;
  document.getElementById('downturnStatus').textContent = `تم حذف ${result.removedProducts} منتج تجريبي وكل بياناته.`;
  UI.toast('تم حذف البيانات التجريبية فقط');
}

async function runDownloadBackup() {
  const btn = document.getElementById('btnDownloadBackup');
  btn.disabled = true;
  const status = document.getElementById('migrateStatus');
  status.textContent = 'بيجهز النسخة الاحتياطية...';
  try {
    const data = await exportAllDataForMigration();
    downloadAsFile(data);
    status.textContent = '✅ اتنزلت النسخة الاحتياطية.';
    UI.toast('✅ اتنزلت النسخة الاحتياطية');
  } catch (err) {
    status.textContent = `❌ فشل التصدير: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function runMigrateNow() {
  if (!confirm('هينقل كل البيانات الحقيقية من المتصفح ده للسيرفر الجديد. اتأكد إنك عملت نسخة احتياطية الأول. متابعة؟')) return;
  const btn = document.getElementById('btnMigrateNow');
  btn.disabled = true;
  const status = document.getElementById('migrateStatus');
  status.textContent = 'بيقرأ البيانات من المتصفح...';
  try {
    const data = await exportAllDataForMigration();
    status.textContent = 'بينقل البيانات للسيرفر...';
    const result = await api.post('/api/admin/import', data);
    const lines = [`✅ تم النقل بنجاح.`, ...Object.entries(result.counts).map(([k, v]) => `  ${k}: ${v}`)];
    if (result.generatedLogins?.length) {
      lines.push('', '👤 حسابات دخول جديدة اتعملت للموظفين (بيانات دخول مؤقتة):');
      for (const l of result.generatedLogins) lines.push(`  ${l.name} — ${l.email} — كلمة السر: ${l.tempPassword}`);
    }
    status.textContent = lines.join('\n');
    UI.toast('✅ تم نقل البيانات للسيرفر الجديد');
  } catch (err) {
    status.textContent = `❌ فشل النقل: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

init();
