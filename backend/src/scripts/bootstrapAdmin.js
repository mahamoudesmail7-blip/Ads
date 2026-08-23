// One-time CLI bootstrap for the very first Admin account, for when you'd
// rather not hit POST /api/auth/register manually. Usage:
//   node src/scripts/bootstrapAdmin.js you@example.com "Your Name" "a-strong-password"
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from '../prisma.js';

const [, , email, name, password] = process.argv;

if (!email || !name || !password) {
  console.error('Usage: node src/scripts/bootstrapAdmin.js <email> <name> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const existing = await prisma.user.findUnique({ where: { email } });
if (existing) {
  console.error(`A user with email ${email} already exists (role: ${existing.role}).`);
  process.exit(1);
}

const created = await prisma.user.create({
  data: { email, name, role: 'ADMIN', password_hash: await bcrypt.hash(password, 12) },
});

console.log(`Admin account created: ${created.email} (id ${created.id}).`);
await prisma.$disconnect();
