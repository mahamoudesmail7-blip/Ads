import { Router } from 'express';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

function parseRow(row) {
  return row ? { ...row, summary: JSON.parse(row.summary) } : null;
}

// GET /api/reports?date=&type=  (both -> single report; date only -> all types that day; neither -> all, optionally filtered by ?type=)
router.get('/', asyncRoute(async (req, res) => {
  const { date, type } = req.query;
  if (date && type) {
    const found = await prisma.dailyReport.findUnique({ where: { date_type: { date, type } } });
    return res.json(parseRow(found));
  }
  if (date) return res.json((await prisma.dailyReport.findMany({ where: { date } })).map(parseRow));
  const rows = await prisma.dailyReport.findMany({ where: type ? { type } : undefined, orderBy: { date: 'desc' } });
  res.json(rows.map(parseRow));
}));

router.post('/', asyncRoute(async (req, res) => {
  const { date, type, summary, reportText } = req.body;
  const existing = await prisma.dailyReport.findUnique({ where: { date_type: { date, type } } });
  const data = { summary: JSON.stringify(summary), report_text: reportText, generated_at: new Date() };
  const saved = existing
    ? await prisma.dailyReport.update({ where: { id: existing.id }, data })
    : await prisma.dailyReport.create({ data: { date, type, ...data } });
  res.json(parseRow(saved));
}));

export default router;
