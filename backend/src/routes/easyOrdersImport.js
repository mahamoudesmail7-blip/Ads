// Historical order import from a merchant-exported Easy Orders Excel file —
// see services/easyOrdersImport.js for why this exists (Easy Orders has no
// bulk "list orders" API at all). ADMIN only: this writes real orders/
// customers, unlike every read-only route in routes/customers.js.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { startImport, getImportJob } from '../services/easyOrdersImport.js';
import { getStore } from '../services/easyOrdersStores.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

router.post('/', asyncRoute(async (req, res) => {
  const { storeId, fileBase64 } = req.body || {};
  if (!storeId || !getStore(storeId)) { const e = new Error('المتجر غير معروف — اختر متجرًا متظبطًا.'); e.status = 400; throw e; }
  if (!fileBase64 || typeof fileBase64 !== 'string') { const e = new Error('لازم ترفع ملف Excel.'); e.status = 400; throw e; }

  let buffer;
  try { buffer = Buffer.from(fileBase64, 'base64'); } catch { const e = new Error('الملف غير صالح — تأكد إنه ملف Excel حقيقي.'); e.status = 400; throw e; }
  if (!buffer.length) { const e = new Error('الملف فارغ.'); e.status = 400; throw e; }

  const result = await startImport({ buffer, storeId, userId: req.user.id });
  res.status(202).json(result);
}));

router.get('/:jobId', asyncRoute(async (req, res) => {
  const job = getImportJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'NOT_FOUND', message: 'لا توجد عملية استيراد بهذا المعرّف — لو السيرفر عمل ريستارت، لازم تعيد رفع الملف.' });
  res.json(job);
}));

export default router;
