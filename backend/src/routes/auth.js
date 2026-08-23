// Auth routes. Password hashing via bcrypt, session via a JWT in an
// httpOnly SameSite cookie (never readable by frontend JS — safer against
// XSS than storing the token in localStorage).
//
// Registration is PUBLIC — anyone can create an account — but a new account
// starts with status: PENDING and gets NO session cookie and NO access
// until the Owner/an Admin approves it via /api/users/:id/approve. role and
// status are always hard-coded server-side here (EMPLOYEE / PENDING),
// regardless of what the request body contains — a self-registering caller
// must never be able to grant themselves a role, a status, or permissions.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET;
const IS_PROD = process.env.NODE_ENV === 'production';

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

const registerSchema = z
  .object({
    name: z.string().trim().min(1, 'الاسم مطلوب.'),
    email: z.string().trim().email('صيغة البريد الإلكتروني غير صحيحة.'),
    password: z
      .string()
      .min(8, 'كلمة المرور لازم تكون 8 أحرف على الأقل.')
      .regex(/[a-zA-Z]/, 'كلمة المرور لازم تحتوي على حرف واحد على الأقل.')
      .regex(/[0-9]/, 'كلمة المرور لازم تحتوي على رقم واحد على الأقل.'),
    confirmPassword: z.string(),
    date_of_birth: z
      .string()
      .refine((v) => !Number.isNaN(new Date(v).getTime()), 'تاريخ الميلاد غير صحيح.')
      .refine((v) => new Date(v).getTime() <= Date.now(), 'تاريخ الميلاد مينفعش يكون في المستقبل.'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'كلمة المرور وتأكيدها مش متطابقين.',
    path: ['confirmPassword'],
  });

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function setSessionCookie(res, user) {
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    is_owner: u.is_owner,
    permissions: JSON.parse(u.permissions || '{}'),
  };
}

const STATUS_MESSAGES = {
  PENDING: 'تم إنشاء حسابك بنجاح وهو الآن في انتظار موافقة إدارة النظام.',
  REJECTED: 'تم رفض طلب انضمامك. تواصل مع إدارة النظام لمزيد من التفاصيل.',
  DISABLED: 'حسابك معطّل حاليًا. تواصل مع إدارة النظام.',
};

// Public — the login page needs to know whether to show first-time setup
// before anyone can log in. Never exposes anything about specific accounts.
router.get(
  '/bootstrap-status',
  asyncRoute(async (req, res) => {
    const count = await prisma.user.count();
    res.json({ hasUsers: count > 0 });
  })
);

// Public self-registration. Always PENDING/EMPLOYEE/no-permissions — never
// trusts role/status/permissions from the request body. No session cookie
// is issued here; the account has zero access until an Admin approves it.
router.post(
  '/register',
  authLimiter,
  asyncRoute(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: first.message, details: parsed.error.issues });
    }
    const { name, email, password, date_of_birth } = parsed.data;

    const created = await prisma.user.create({
      data: {
        email,
        name,
        date_of_birth,
        role: 'EMPLOYEE',
        status: 'PENDING',
        permissions: '{}',
        password_hash: await bcrypt.hash(password, 12),
      },
    });

    res.status(201).json({ status: created.status, message: STATUS_MESSAGES.PENDING });
  })
);

router.post(
  '/login',
  authLimiter,
  asyncRoute(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'الإيميل أو الباسورد غلط.' });
    }
    const ok = await bcrypt.compare(body.password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'الإيميل أو الباسورد غلط.' });

    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: `ACCOUNT_${user.status}`, message: STATUS_MESSAGES[user.status] || 'الحساب مش متاح حاليًا.' });
    }

    setSessionCookie(res, user);
    res.json(publicUser(user));
  })
);

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get(
  '/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    res.json(publicUser(user));
  })
);

export default router;
