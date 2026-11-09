// Daily Tasks (تاسكات اليوم) — mounted at /api/daily-tasks. Everyone signed in can READ the board; managers/admins manage; an employee can only act on tasks assigned to them
// (their account is linked to a team member in the «الفريق» tab). Never writes to Meta.
import { Router } from 'express';
import { prisma } from '../prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import * as E from '../services/dailyTasks/engine.js';
import * as C from '../services/dailyTasks/core.js';
import { cairoDate } from '../services/amb/dailyPlanTime.js';

const router = Router();
router.use(requireAuth);
// only the owner account (Mahmoud Esmail) manages and sees everyone in «تاسكات اليوم»; every other account keeps its normal access to the rest of the app but sees only its OWN tasks here
const mgr = (req, res, next) => (C.seesAll(req.user) ? next() : res.status(403).json({ error: 'FORBIDDEN', message: 'مفيش صلاحية كافية لعمل ده.' }));
const building = new Map(); // dates whose first build is running in the background
const dateOf = (req) => { const d = String(req.query.date || req.body?.date || cairoDate()); if (!C.validDate(d)) { const e = new Error('تاريخ غير صالح.'); e.status = 400; throw e; } return d; };

router.get('/day', asyncRoute(async (req, res) => {
  const date = dateOf(req);
  // today's board is always ready: if the scheduler has not built it yet (first visit, restart) it is built now
  const view = await E.getDayView(date, req.user);
  if (!view.exists && date === cairoDate()) {
    if (!building.has(date)) { building.set(date, true); E.generateDay(date, { actor: req.user }).catch(() => {}).finally(() => building.delete(date)); }
    return res.json({ ...view, building: true });
  }
  res.json({ ...view, building: building.has(date) });
}));

router.post('/generate', mgr, asyncRoute(async (req, res) => { const date = dateOf(req); await E.generateDay(date, { actor: req.user }); res.json(await E.getDayView(date, req.user)); }));
router.get('/rebalance/preview', mgr, asyncRoute(async (req, res) => res.json(await E.previewRebalance(dateOf(req)))));
router.post('/rebalance', mgr, asyncRoute(async (req, res) => { const date = dateOf(req); await E.rebalance(date, req.user); res.json(await E.getDayView(date, req.user)); }));
router.post('/tasks', mgr, asyncRoute(async (req, res) => { const date = dateOf(req); await E.addManualTask(date, req.body || {}, req.user); res.status(201).json(await E.getDayView(date, req.user)); }));
router.post('/tasks/:id/:action', asyncRoute(async (req, res) => { const date = dateOf(req); await E.actOnTask(date, req.params.id, req.params.action, req.body || {}, req.user); res.json(await E.getDayView(date, req.user)); }));

router.get('/report', asyncRoute(async (req, res) => { const to = String(req.query.to || cairoDate()); const from = String(req.query.from || C.addDays(to, -6)); res.json(await E.getReport(from, to, req.user)); }));
router.get('/eod', mgr, asyncRoute(async (req, res) => res.json({ text: await E.getEodText(dateOf(req)) })));

router.get('/team', mgr, asyncRoute(async (req, res) => {
  const cfg = await E.getConfig();
  const users = await prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true, role: true }, orderBy: { name: 'asc' } });
  res.json({ team: cfg.team, users, options: cfg.options });
}));
router.post('/team', mgr, asyncRoute(async (req, res) => res.status(201).json(await E.addMember(req.body || {}))));
router.patch('/team/:id', mgr, asyncRoute(async (req, res) => res.json(await E.updateMember(req.params.id, req.body || {}))));
router.post('/team/:id/day-off', mgr, asyncRoute(async (req, res) => res.json(await E.setDayOff(req.params.id, dateOf(req), req.body?.off !== false, req.user))));
router.delete('/team/:id', mgr, asyncRoute(async (req, res) => res.json(await E.removeMember(req.params.id, req.user))));
router.put('/options', mgr, asyncRoute(async (req, res) => res.json(await E.saveOptions(req.body || {}))));

export default router;
