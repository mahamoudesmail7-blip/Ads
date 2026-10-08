// Deploy-time wrapper around `prisma migrate deploy` (`npm start` runs it before the server).
//
// What it does (logic lives in migrateDeployCore.js, which is unit-tested with mocks):
//  1. Migrations run ONLY over the direct Neon connection (DIRECT_DATABASE_URL) — never through the pooler. The app keeps using DATABASE_URL (pooler).
//     If DIRECT_DATABASE_URL is missing and DATABASE_URL is a pooler URL it stops with a clear configuration error (exit 78) instead of migrating via the pooler.
//  2. Prisma's advisory lock stays ON (it is never disabled here).
//  3. Retries a connection failure (Neon compute waking up — original purpose of this file) with back-off, and a leftover advisory lock (P1002 "advisory lock")
//     with a longer, bounded back-off while printing READ-ONLY info about who holds it. It never terminates a PostgreSQL session by itself.
// Never touches migrations/schema/data itself. No connection string is ever printed.
import 'dotenv/config'; // so a DIRECT_DATABASE_URL kept in backend/.env is honoured locally (on Railway the variables are already in the environment)
import { spawnSync } from 'node:child_process';
import { runMigrateDeploy, resolveMigrationUrl, describeLockHolders } from './migrateDeployCore.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function diagnoseLock() {
  const { url } = resolveMigrationUrl(process.env);
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url } }, log: [] });
  try { return await describeLockHolders((sql) => db.$queryRawUnsafe(sql)); } finally { await db.$disconnect(); }
}

const code = await runMigrateDeploy({
  env: process.env,
  spawn: spawnSync, // no kill-timeout on purpose: killing the schema engine mid-run is exactly what leaves an orphaned lock-holding session behind
  sleep,
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
  diagnoseLock,
});
process.exit(code);
