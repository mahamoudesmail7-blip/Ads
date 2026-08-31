import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';

import { logger } from './logger.js';
import { errorHandler } from './middleware/errorHandler.js';

import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import orderRoutes from './routes/orders.js';
import settingsRoutes from './routes/settings.js';
import noteRoutes from './routes/notes.js';
import actionLogRoutes from './routes/actionLog.js';
import reportRoutes from './routes/reports.js';
import teamRoutes from './routes/team.js';
import assignmentRoutes from './routes/assignments.js';
import taskRoutes from './routes/tasks.js';
import inventoryRoutes from './routes/inventory.js';
import adminRoutes from './routes/admin.js';
import usersRoutes from './routes/users.js';
import webhookRoutes from './routes/webhooks.js';
import easyOrdersRoutes from './routes/easyorders.js';
import lostOrdersRoutes from './routes/lostOrders.js';
import adsIntelligenceRoutes from './routes/adsIntelligence.js';
import metaRoutes from './routes/meta.js';
import aiAssistantRoutes from './routes/aiAssistant.js';
import productResearchRoutes from './routes/productResearch.js';
import { startEasyOrdersReconciliation } from './services/easyOrdersReconcile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..'); // order-monitor/ (one level above backend/)

const app = express();
const PORT = process.env.PORT || 4000;

app.set('trust proxy', 1); // Render/other PaaS sit behind a proxy — needed for secure cookies to work.

app.use(helmet({ contentSecurityPolicy: false })); // CSP off: this app is plain multi-page HTML/JS with inline-free scripts already; a strict default CSP would need per-page tuning first.
app.use(
  cors({
    origin: process.env.FRONTEND_URL || true,
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json({ limit: '20mb' })); // 20mb: covers the IndexedDB export/import payload (admin.js) and base64-encoded Meta Ads export uploads (adsIntelligence.js).
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream: { write: (msg) => logger.info(msg.trim()) } }));

app.use('/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/action-log', actionLogRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/webhooks', webhookRoutes); // public — authenticated via the `secret` header EasyOrders sends, not a user session
app.use('/api/easyorders', easyOrdersRoutes);
app.use('/api/lost-orders', lostOrdersRoutes);
app.use('/api/ai-intelligence', adsIntelligenceRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/ai-assistant', aiAssistantRoutes);
app.use('/api/product-research', productResearchRoutes);

// Serve the existing static frontend (order-monitor/) from this same
// service, so there's a single public URL. `backend/`, `.env`, and `.git`
// must never be reachable as static files even though they live inside the
// same parent folder — blocked before express.static ever sees the request.
app.use((req, res, next) => {
  if (/^\/(backend|\.git|\.env)/i.test(req.path)) return res.status(404).end();
  next();
});
// no-store (not just no-cache): during active development the browser was
// observed serving a stale cached module/stylesheet even right after a
// fresh navigation — same issue already hit once with server.ps1's static
// serving. no-store forbids caching the response at all, which is the
// right trade-off for a tool where "did my edit actually apply?" must
// always be true.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});
app.use(express.static(FRONTEND_ROOT, { extensions: ['html'], cacheControl: false }));

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`Order Monitor backend listening on http://localhost:${PORT}`, { frontendRoot: FRONTEND_ROOT });
});

startEasyOrdersReconciliation();
