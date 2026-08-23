// Mirrors the 5 inventory_* stores from db.js: snapshots (upserted),
// movement log (append-only), column mapping (remembered), name mapping
// (remembered unmatched-name overrides), import batches (audit trail).
import { Router } from 'express';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

// --- Snapshots ---
router.get('/snapshots', asyncRoute(async (req, res) => {
  const { date, productId } = req.query;
  if (productId && date) return res.json(await prisma.inventorySnapshot.findUnique({ where: { product_id_date: { product_id: Number(productId), date } } }));
  if (date) return res.json(await prisma.inventorySnapshot.findMany({ where: { date } }));
  if (productId) return res.json(await prisma.inventorySnapshot.findMany({ where: { product_id: Number(productId) }, orderBy: { date: 'asc' } }));
  res.json(await prisma.inventorySnapshot.findMany());
}));

router.post('/snapshots/upsert', asyncRoute(async (req, res) => {
  const r = req.body;
  const saved = await prisma.inventorySnapshot.upsert({
    where: { product_id_date: { product_id: Number(r.product_id), date: r.date } },
    create: { ...r, product_id: Number(r.product_id) },
    update: { ...r, product_id: Number(r.product_id) },
  });
  res.json(saved);
}));

// --- Movement log (append-only) ---
router.get('/movement-log', asyncRoute(async (req, res) => {
  const { date, productId } = req.query;
  if (date) return res.json(await prisma.inventoryMovementLog.findMany({ where: { date }, orderBy: { created_at: 'asc' } }));
  if (productId) return res.json(await prisma.inventoryMovementLog.findMany({ where: { product_id: Number(productId) }, orderBy: { created_at: 'asc' } }));
  res.json(await prisma.inventoryMovementLog.findMany());
}));

router.post('/movement-log', asyncRoute(async (req, res) => {
  const created = await prisma.inventoryMovementLog.create({ data: { ...req.body, product_id: Number(req.body.product_id) } });
  res.status(201).json(created);
}));

// --- Column mapping (single remembered record) ---
router.get('/column-mapping', asyncRoute(async (req, res) => {
  const found = await prisma.inventoryColumnMapping.findUnique({ where: { id: 'default' } });
  res.json(found ?? null);
}));

router.put('/column-mapping', asyncRoute(async (req, res) => {
  const saved = await prisma.inventoryColumnMapping.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...req.body },
    update: { ...req.body },
  });
  res.json(saved);
}));

// --- Name mapping (remembered unmatched-name -> product overrides) ---
router.get('/name-mapping', asyncRoute(async (req, res) => res.json(await prisma.inventoryNameMapping.findMany())));

router.get('/name-mapping/:key', asyncRoute(async (req, res) => {
  const found = await prisma.inventoryNameMapping.findUnique({ where: { excel_name_key: req.params.key } });
  res.json(found ?? null);
}));

router.post('/name-mapping', asyncRoute(async (req, res) => {
  const { excelNameKey, excelNameOriginal, productId } = req.body;
  const saved = await prisma.inventoryNameMapping.upsert({
    where: { excel_name_key: excelNameKey },
    create: { excel_name_key: excelNameKey, excel_name_original: excelNameOriginal, product_id: Number(productId) },
    update: { product_id: Number(productId) },
  });
  res.json(saved);
}));

// --- Import batches (permanent audit record) ---
function parseBatch(row) {
  return row ? { ...row, unmatched: row.unmatched ? JSON.parse(row.unmatched) : [] } : null;
}

router.get('/batches', asyncRoute(async (req, res) => {
  const { date } = req.query;
  const rows = await prisma.inventoryImportBatch.findMany({ where: date ? { date } : undefined, orderBy: { uploaded_at: 'desc' } });
  res.json(rows.map(parseBatch));
}));

router.post('/batches', asyncRoute(async (req, res) => {
  const created = await prisma.inventoryImportBatch.create({ data: { ...req.body, unmatched: JSON.stringify(req.body.unmatched ?? []) } });
  res.status(201).json(parseBatch(created));
}));

export default router;
