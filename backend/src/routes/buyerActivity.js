// «اللي اتعمل النهارده حسب الميديا باير» — mounted at /api/ai-media-buyer/buyer-activity BEFORE the AI Media Buyer router (which is manager-only). Login required; WHAT is shown depends on who asks:
// the owner account sees every media buyer and their work; a media buyer sees only his own work (his login linked to his team card); anyone else gets 403. Read only (the alias link writes a settings row, owner only).
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { getBuyerActivity, getWeekStrip, setAlias, scopeActivity, resolveViewer } from '../services/amb/buyerActivity.js';
import { getBuyerReport, scopeReport } from '../services/amb/buyerReport.js';
import { getFeed } from '../services/amb/buyerFeed.js';

const router = Router();
router.use(requireAuth);
const dateOk = (d) => !d || /^\d{4}-\d{2}-\d{2}$/.test(String(d));
const bad = (res, msg) => res.status(400).json({ error: 'REQUEST_ERROR', message: msg });
router.use(asyncRoute(async (req, res, next) => {
  req.viewer = await resolveViewer(req.user);
  if (!req.viewer) return res.status(403).json({ error: 'NOT_LINKED', message: 'حسابك مش مربوط بميديا باير. اطلب من المدير يربطه من تبويب «الفريق» في تاسكات اليوم.' });
  next();
}));

router.get('/', asyncRoute(async (req, res) => {
  if (!dateOk(req.query.date)) return bad(res, 'التاريخ لازم يكون بصيغة YYYY-MM-DD.');
  res.json(scopeActivity(await getBuyerActivity({ date: req.query.date || null, force: req.query.force === '1' }), req.viewer.memberId));
}));
router.get('/report', asyncRoute(async (req, res) => {
  res.json(scopeReport(await getBuyerReport({ mode: String(req.query.mode || 'yesterday'), force: req.query.force === '1' }), req.viewer.memberId));
}));
// The owner's live alert feed (new campaigns + what media buyers did on their own tasks). Owner account only — a media buyer is never told about the others.
router.get('/feed', asyncRoute(async (req, res) => {
  if (!req.viewer.all) return res.status(403).json({ error: 'FORBIDDEN', message: 'تنبيهات شغل الميديا بايرز للمالك بس.' });
  res.json(await getFeed());
}));
router.get('/week', asyncRoute(async (req, res) => {
  if (!dateOk(req.query.date)) return bad(res, 'التاريخ لازم يكون بصيغة YYYY-MM-DD.');
  res.json(await getWeekStrip({ date: req.query.date || null, memberId: req.viewer.memberId }));
}));
// The owner links a Facebook name (as «View history» shows it) to a media buyer once. Settings table only — never touches Meta. Owner account only.
router.put('/aliases', asyncRoute(async (req, res) => {
  if (!req.viewer.all) return res.status(403).json({ error: 'FORBIDDEN', message: 'ربط الأسماء للمسؤول بس.' });
  await setAlias(req.body?.actorId, req.body?.memberId || null);
  res.json(await getBuyerActivity({ date: req.body?.date || null, force: true }));
}));
export default router;
