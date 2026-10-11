// Single shared Prisma client instance — every route imports this, never
// creates its own PrismaClient (that would exhaust the DB connection pool).
import { PrismaClient } from '@prisma/client';

// Interactive transactions (daily-plan versioning, policy supersede…) must survive a slow round trip to a remote Postgres (Neon): the default 5 s window made a merely SLOW commit fail as "transaction already closed".
export const prisma = new PrismaClient({ transactionOptions: { maxWait: 10_000, timeout: 20_000 } });
