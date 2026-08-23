// Admin-only: the one-time IndexedDB -> Postgres data migration, plus the
// old db.js "danger zone" helpers (clearAllData / clearDemoData).
//
// Migration design note: TaskAssignments (the older tasks.html/work.html
// auto-assignment system) keeps pointing at TeamMember rows, unchanged.
// TaskRecords (the newer 👑 manager system) now points at real login User
// accounts instead, because completing "your own" task requires an actual
// authenticated identity that didn't exist before this backend. So for each
// legacy TeamMember referenced by an old task_record, we create one matching
// User (EMPLOYEE role, a generated temp password) and remap employee_id to
// it. The generated temp passwords are returned once in the response so the
// admin can hand them out — there is no password-reset flow yet in Phase 1.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

// Postgres-only: after inserting rows with explicit ids (createMany
// preserving the old IndexedDB ids), the autoincrement sequence must be
// bumped past the highest inserted id or the next normal insert collides.
// SQLite (used for local dev — see schema.prisma) tracks its own rowid
// counter automatically and needs no equivalent step, so this is a no-op
// there.
const IS_SQLITE = (process.env.DATABASE_URL || '').startsWith('file:');

async function resetSequence(table) {
  if (IS_SQLITE) return;
  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1))`
  );
}

function tempPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

function slugEmail(name, suffix) {
  const slug = name.replace(/\s+/g, '.').toLowerCase();
  return `${slug}.${suffix}@imported.local`;
}

router.post(
  '/import',
  asyncRoute(async (req, res) => {
    const data = req.body || {};
    const counts = {};
    const generatedLogins = [];

    // 1. Products — preserve original ids (product.html?id=X links depend on them).
    if (Array.isArray(data.products) && data.products.length) {
      const rows = data.products.map((p) => ({ ...p, created_at: p.created_at ? new Date(p.created_at) : new Date() }));
      await prisma.product.createMany({ data: rows, skipDuplicates: true });
      await resetSequence('products');
      counts.products = rows.length;
    }

    // 2. Team members (unchanged concept — task_assignments keeps using these ids).
    let teamMemberIdToUserId = new Map();
    if (Array.isArray(data.team_members) && data.team_members.length) {
      const rows = data.team_members.map((m) => ({ ...m, created_at: m.created_at ? new Date(m.created_at) : new Date() }));
      await prisma.teamMember.createMany({ data: rows, skipDuplicates: true });
      await resetSequence('team_members');
      counts.team_members = rows.length;

      // One User per TeamMember, so legacy task_records.employee_id can be remapped.
      for (const m of data.team_members) {
        const email = slugEmail(m.name, 'employee');
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
          teamMemberIdToUserId.set(m.id, existing.id);
          continue;
        }
        const password = tempPassword();
        const created = await prisma.user.create({
          data: { email, name: m.name, role: 'EMPLOYEE', password_hash: await bcrypt.hash(password, 12) },
        });
        teamMemberIdToUserId.set(m.id, created.id);
        generatedLogins.push({ name: m.name, email, tempPassword: password });
      }
    }

    // 3. Daily orders — depends on products.
    if (Array.isArray(data.daily_orders) && data.daily_orders.length) {
      const rows = data.daily_orders.map((o) => ({
        ...o,
        created_at: o.created_at ? new Date(o.created_at) : new Date(),
        updated_at: o.updated_at ? new Date(o.updated_at) : new Date(),
      }));
      await prisma.dailyOrder.createMany({ data: rows, skipDuplicates: true });
      await resetSequence('daily_orders');
      counts.daily_orders = rows.length;
    }

    // 4. Settings (single row).
    if (data.settings) {
      await prisma.settings.upsert({
        where: { id: 'default' },
        create: { id: 'default', data: JSON.stringify(data.settings) },
        update: { data: JSON.stringify(data.settings) },
      });
      counts.settings = 1;
    }

    // 5. Product notes.
    if (Array.isArray(data.product_notes) && data.product_notes.length) {
      const rows = data.product_notes.map((n) => ({ ...n, created_at: n.created_at ? new Date(n.created_at) : new Date() }));
      await prisma.productNote.createMany({ data: rows, skipDuplicates: true });
      await resetSequence('product_notes');
      counts.product_notes = rows.length;
    }

    // 6. Action log.
    if (Array.isArray(data.action_log) && data.action_log.length) {
      const rows = data.action_log.map((r) => ({
        ...r,
        completed_at: r.completed_at ? new Date(r.completed_at) : null,
        created_at: r.created_at ? new Date(r.created_at) : new Date(),
        updated_at: r.updated_at ? new Date(r.updated_at) : new Date(),
      }));
      await prisma.actionLog.createMany({ data: rows, skipDuplicates: true });
      await resetSequence('action_log');
      counts.action_log = rows.length;
    }

    // 7. Daily reports.
    if (Array.isArray(data.daily_reports) && data.daily_reports.length) {
      const rows = data.daily_reports.map((r) => ({
        ...r,
        summary: JSON.stringify(r.summary),
        generated_at: r.generated_at ? new Date(r.generated_at) : new Date(),
      }));
      await prisma.dailyReport.createMany({ data: rows, skipDuplicates: true });
      await resetSequence('daily_reports');
      counts.daily_reports = rows.length;
    }

    // 8. Task assignments — employee_id stays pointing at TeamMember, unchanged.
    if (Array.isArray(data.task_assignments) && data.task_assignments.length) {
      const rows = data.task_assignments.map((a) => ({
        ...a,
        assigned_at: a.assigned_at ? new Date(a.assigned_at) : new Date(),
        updated_at: a.updated_at ? new Date(a.updated_at) : new Date(),
      }));
      await prisma.taskAssignment.createMany({ data: rows, skipDuplicates: true });
      await resetSequence('task_assignments');
      counts.task_assignments = rows.length;
    }

    // 9. Task records — employee_id remapped TeamMember.id -> User.id.
    let oldTaskIdToNewId = new Map();
    if (Array.isArray(data.task_records) && data.task_records.length) {
      for (const r of data.task_records) {
        const created = await prisma.taskRecord.create({
          data: {
            date: r.date,
            product_id: r.product_id ?? null,
            product_name: r.product_name ?? null,
            employee_id: r.employee_id != null ? teamMemberIdToUserId.get(r.employee_id) ?? null : null,
            created_by_id: null, // pre-migration tasks had no real creator account
            status: r.status || 'PENDING',
            task_type: r.task_type ?? null,
            priority: r.priority ?? null,
            title: r.title ?? null,
            details: r.details ?? null,
            manager_note: r.manager_note ?? null,
            related_campaign: r.related_campaign ?? null,
            source: r.source ?? null,
            assignment_source: r.assignment_source ?? null,
            assigned_by: r.assigned_by ?? null,
            assigned_at: r.assigned_at ? new Date(r.assigned_at) : null,
            today: r.today ?? null,
            yesterday: r.yesterday ?? null,
            diff: r.diff ?? null,
            due_date: r.due_date ?? null,
            execution_date: r.execution_date ?? null,
            completed_at: r.completed_at ? new Date(r.completed_at) : null,
            not_completed_reason: r.not_completed_reason ?? null,
            not_completed_note: r.not_completed_note ?? null,
            cancelled_at: r.cancelled_at ? new Date(r.cancelled_at) : null,
            cancelled_by: r.cancelled_by ?? null,
            cancel_reason: r.cancel_reason ?? null,
            created_at: r.created_at ? new Date(r.created_at) : new Date(),
          },
        });
        oldTaskIdToNewId.set(r.id, created.id);
      }
      counts.task_records = data.task_records.length;
    }

    // 10. Task activity log — same field names as the live app (action_type/employee_to/employee_from/details_text); actor_id left null since pre-migration entries had no real user identity.
    if (Array.isArray(data.task_activity_log) && data.task_activity_log.length) {
      for (const entry of data.task_activity_log) {
        await prisma.taskActivityLog.create({
          data: {
            date: entry.date || '',
            task_id: entry.task_id != null ? oldTaskIdToNewId.get(entry.task_id) ?? null : null,
            action_type: entry.action_type ?? null,
            employee_to: entry.employee_to != null ? teamMemberIdToUserId.get(entry.employee_to) ?? null : null,
            employee_from: entry.employee_from != null ? teamMemberIdToUserId.get(entry.employee_from) ?? null : null,
            details_text: entry.details_text ?? null,
            actor_id: null,
            created_at: entry.created_at ? new Date(entry.created_at) : new Date(),
          },
        });
      }
      counts.task_activity_log = data.task_activity_log.length;
    }

    // 11. Inventory — snapshots, movement log, column mapping, name mapping, batches.
    if (Array.isArray(data.inventory_snapshots) && data.inventory_snapshots.length) {
      const rows = data.inventory_snapshots.map((s) => ({
        ...s,
        created_at: s.created_at ? new Date(s.created_at) : new Date(),
        updated_at: s.updated_at ? new Date(s.updated_at) : new Date(),
      }));
      await prisma.inventorySnapshot.createMany({ data: rows, skipDuplicates: true });
      await resetSequence('inventory_snapshots');
      counts.inventory_snapshots = rows.length;
    }
    if (Array.isArray(data.inventory_movement_log) && data.inventory_movement_log.length) {
      const rows = data.inventory_movement_log.map((m) => ({ ...m, created_at: m.created_at ? new Date(m.created_at) : new Date() }));
      await prisma.inventoryMovementLog.createMany({ data: rows, skipDuplicates: true });
      await resetSequence('inventory_movement_log');
      counts.inventory_movement_log = rows.length;
    }
    if (data.inventory_column_mapping) {
      const m = data.inventory_column_mapping;
      await prisma.inventoryColumnMapping.upsert({
        where: { id: 'default' },
        create: { id: 'default', productName: m.productName, quantity: m.quantity, sku: m.sku, warehouse: m.warehouse },
        update: { productName: m.productName, quantity: m.quantity, sku: m.sku, warehouse: m.warehouse },
      });
      counts.inventory_column_mapping = 1;
    }
    if (Array.isArray(data.inventory_name_mapping) && data.inventory_name_mapping.length) {
      const rows = data.inventory_name_mapping.map((n) => ({
        ...n,
        created_at: n.created_at ? new Date(n.created_at) : new Date(),
        updated_at: n.updated_at ? new Date(n.updated_at) : new Date(),
      }));
      await prisma.inventoryNameMapping.createMany({ data: rows, skipDuplicates: true });
      await resetSequence('inventory_name_mapping');
      counts.inventory_name_mapping = rows.length;
    }
    if (Array.isArray(data.inventory_import_batches) && data.inventory_import_batches.length) {
      const rows = data.inventory_import_batches.map((b) => ({
        ...b,
        unmatched: JSON.stringify(b.unmatched ?? []),
        uploaded_at: b.uploaded_at ? new Date(b.uploaded_at) : new Date(),
      }));
      await prisma.inventoryImportBatch.createMany({ data: rows, skipDuplicates: true });
      await resetSequence('inventory_import_batches');
      counts.inventory_import_batches = rows.length;
    }

    res.json({ ok: true, counts, generatedLogins });
  })
);

router.post(
  '/clear-all',
  asyncRoute(async (req, res) => {
    await prisma.$transaction([
      prisma.taskActivityLog.deleteMany(),
      prisma.taskRecord.deleteMany(),
      prisma.taskAssignment.deleteMany(),
      prisma.teamMember.deleteMany(),
      prisma.inventoryImportBatch.deleteMany(),
      prisma.inventoryNameMapping.deleteMany(),
      prisma.inventoryColumnMapping.deleteMany(),
      prisma.inventoryMovementLog.deleteMany(),
      prisma.inventorySnapshot.deleteMany(),
      prisma.dailyReport.deleteMany(),
      prisma.actionLog.deleteMany(),
      prisma.productNote.deleteMany(),
      prisma.dailyOrder.deleteMany(),
      prisma.settings.deleteMany(),
      prisma.product.deleteMany(),
    ]);
    res.json({ ok: true });
  })
);

router.post(
  '/clear-demo',
  asyncRoute(async (req, res) => {
    const demoProducts = await prisma.product.findMany({ where: { is_demo: true } });
    for (const p of demoProducts) await prisma.product.delete({ where: { id: p.id } });
    res.json({ removedProducts: demoProducts.length });
  })
);

export default router;
