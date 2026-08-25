// Settings is a single JSON blob row (id='default'), same shape as
// db.js's DEFAULT_SETTINGS — stored as Json so new threshold fields never
// need a migration.
import { Router } from 'express';
import { prisma } from '../prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

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

router.get('/', asyncRoute(async (req, res) => {
  const row = await prisma.settings.findUnique({ where: { id: 'default' } });
  res.json(row ? { ...DEFAULT_SETTINGS, ...JSON.parse(row.data) } : { ...DEFAULT_SETTINGS });
}));

router.put('/', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const row = await prisma.settings.findUnique({ where: { id: 'default' } });
  const merged = { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.data) : {}), ...req.body, id: 'default' };
  await prisma.settings.upsert({
    where: { id: 'default' },
    create: { id: 'default', data: JSON.stringify(merged) },
    update: { data: JSON.stringify(merged) },
  });
  res.json(merged);
}));

router.post('/reset', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  await prisma.settings.upsert({
    where: { id: 'default' },
    create: { id: 'default', data: JSON.stringify(DEFAULT_SETTINGS) },
    update: { data: JSON.stringify(DEFAULT_SETTINGS) },
  });
  res.json({ ...DEFAULT_SETTINGS });
}));

export default router;
