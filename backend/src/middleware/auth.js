// Auth middleware — reads the JWT from the httpOnly `token` cookie (never
// from a header the frontend would have to store itself), verifies it, then
// re-checks the user's CURRENT status in the database (not just what the
// token claims) before attaching req.user. This matters because a JWT is
// stateless: without this DB check, an Admin disabling a user mid-session
// would have no effect until that user's token naturally expired (up to 7
// days) — re-checking status on every request closes that gap.
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma.js';

const JWT_SECRET = process.env.JWT_SECRET;

export async function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'لازم تسجل دخول أولاً.' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({ error: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', message: expired ? 'انتهت صلاحية الجلسة، سجل دخول تاني.' : 'جلسة غير صالحة.' });
  }

  // Wrapped explicitly: this middleware is mounted directly (`router.use(requireAuth)`)
  // rather than through asyncRoute() everywhere it's used, and Express 4 does not
  // auto-forward a rejected promise from middleware to the error handler.
  try {
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user || user.status !== 'ACTIVE') {
      return res.status(401).json({ error: 'ACCOUNT_NOT_ACTIVE', message: 'الحساب مش متاح حاليًا — سجل دخول تاني.' });
    }
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role, is_owner: user.is_owner, permissions: JSON.parse(user.permissions || '{}') };
    next();
  } catch (err) {
    next(err);
  }
}

/** requireRole('ADMIN') or requireRole('ADMIN', 'MANAGER') — any listed role passes. is_owner always passes regardless of role list. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'لازم تسجل دخول أولاً.' });
    if (req.user.is_owner || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'FORBIDDEN', message: 'مفيش صلاحية كافية لعمل ده.' });
  };
}
