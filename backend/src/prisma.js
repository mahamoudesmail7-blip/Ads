// Single shared Prisma client instance — every route imports this, never
// creates its own PrismaClient (that would exhaust the DB connection pool).
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
