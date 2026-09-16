// Backup & Recovery status page (Phase 7 of the disaster-recovery task,
// see docs/DISASTER_RECOVERY.md) — ADMIN-only, purely informational.
//
// NEVER returns a secret value — only whether a variable is SET (boolean).
// NEVER performs a destructive action; there is no restore/delete/migrate
// endpoint here, on purpose, in this first version.
import { Router } from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '../scripts');

// name -> required (app-critical) vs optional (a feature degrades honestly without it)
const ENV_VARS = [
  { name: 'DATABASE_URL', required: true },
  { name: 'JWT_SECRET', required: true },
  { name: 'FRONTEND_URL', required: true },
  { name: 'OPENAI_API_KEY', required: false },
  { name: 'EASYORDERS_API_KEY', required: false },
  { name: 'EASYORDERS_WEBHOOK_SECRET', required: false },
  { name: 'META_APP_ID', required: false },
  { name: 'META_APP_SECRET', required: false },
  { name: 'META_TOKEN_ENCRYPTION_KEY', required: false },
  { name: 'META_REDIRECT_URI', required: false },
  { name: 'SHADOW_DATABASE_URL', required: false, note: 'فقط لأمر migrate diff الآمن — طبيعي إنها غير مضبوطة في الإنتاج' },
  { name: 'ANTHROPIC_API_KEY', required: false },
  { name: 'SERPAPI_API_KEY', required: false },
  { name: 'GOOGLE_SEARCH_API_KEY', required: false },
  { name: 'YOUTUBE_API_KEY', required: false },
  { name: 'APIFY_API_TOKEN', required: false },
];

const SAFETY_GUARD_FILES = [
  'dbSafetyGuard.js',
  'prismaMigrateDiffSafe.js',
  'guardedPrismaCommand.js',
  'guardedDbExecute.js',
];

router.get('/', asyncRoute(async (req, res) => {
  // --- GitHub / code ---
  // Railway auto-injects these for deployments connected to a GitHub repo;
  // they're absent when running locally, which is reported honestly rather
  // than guessed.
  const github = {
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    branch: process.env.RAILWAY_GIT_BRANCH || null,
    repo: process.env.RAILWAY_GIT_REPO_NAME || null,
    source: process.env.RAILWAY_GIT_COMMIT_SHA ? 'RAILWAY_GIT_* environment variables' : 'not available in this environment (not deployed via Railway+GitHub, or running locally)',
  };

  // --- Database ---
  let dbConnected = false;
  try { await prisma.$queryRaw`SELECT 1`; dbConnected = true; } catch { /* left false */ }

  // --- Environment / secrets (presence only, NEVER values) ---
  const envStatus = ENV_VARS.map((v) => ({
    name: v.name,
    configured: !!process.env[v.name] && String(process.env[v.name]).trim() !== '',
    required: v.required,
    note: v.note || null,
  }));

  // --- Safety guards (file-presence check — this is a static, on-disk
  // check, not a claim about any running/enforced state, since these are
  // CLI-invoked wrappers rather than a background service) ---
  const safetyGuards = SAFETY_GUARD_FILES.map((f) => ({
    file: `backend/src/scripts/${f}`,
    present: existsSync(join(SCRIPTS_DIR, f)),
  }));

  res.json({
    checkedAtUtc: new Date().toISOString(),
    github,
    database: {
      connected: dbConnected,
      provider: 'Neon (PostgreSQL)',
      note: 'PITR retention and scheduled-snapshot availability depend on the Neon plan — verify in the Neon console. See docs/DISASTER_RECOVERY.md Phase 2.',
    },
    environment: envStatus,
    safetyGuards,
  });
}));

export default router;
