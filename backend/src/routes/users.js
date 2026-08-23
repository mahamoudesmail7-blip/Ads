// User management / approval queue — Owner-only (spec: "الـ Owner فقط
// يستطيع... قبول أو رفض المستخدمين... تحديد صلاحياتهم"). Gated on
// `is_owner`, not merely role === 'ADMIN' — if the Owner ever promotes a
// second account to ADMIN later, that account should NOT automatically
// inherit these owner-exclusive powers unless the Owner explicitly grants
// them. Every mutating route also refuses to target `is_owner` accounts and
// refuses self-targeting, so nobody (including the Owner acting on their
// own row by mistake) can self-approve, self-promote, or lock themselves out.
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';

const router = Router();

function requireOwner(req, res, next) {
  if (!req.user?.is_owner) return res.status(403).json({ error: 'FORBIDDEN', message: 'الإجراء ده متاح للـ Owner بس.' });
  next();
}

router.use(requireAuth, requireOwner);

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    date_of_birth: u.date_of_birth,
    permissions: JSON.parse(u.permissions || '{}'),
    is_owner: u.is_owner,
    created_at: u.created_at,
  };
}

async function loadTarget(req, res) {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'مينفعش تعدّل حسابك بنفسك من هنا.' });
    return null;
  }
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'المستخدم مش موجود.' });
    return null;
  }
  if (target.is_owner) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'مينفعش تعدّل حساب الـ Owner.' });
    return null;
  }
  return target;
}

router.get(
  '/pending',
  asyncRoute(async (req, res) => {
    const rows = await prisma.user.findMany({ where: { status: 'PENDING' }, orderBy: { created_at: 'asc' } });
    res.json(rows.map(publicUser));
  })
);

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const rows = await prisma.user.findMany({ orderBy: { created_at: 'desc' } });
    res.json(rows.map(publicUser));
  })
);

router.post(
  '/:id/approve',
  asyncRoute(async (req, res) => {
    const target = await loadTarget(req, res);
    if (!target) return;
    const { role, permissions } = req.body || {};
    const updated = await prisma.user.update({
      where: { id: target.id },
      data: {
        status: 'ACTIVE',
        role: role && ['ADMIN', 'MANAGER', 'EMPLOYEE'].includes(role) ? role : target.role,
        permissions: permissions ? JSON.stringify(permissions) : target.permissions,
      },
    });
    res.json(publicUser(updated));
  })
);

router.post(
  '/:id/reject',
  asyncRoute(async (req, res) => {
    const target = await loadTarget(req, res);
    if (!target) return;
    const updated = await prisma.user.update({ where: { id: target.id }, data: { status: 'REJECTED' } });
    res.json(publicUser(updated));
  })
);

router.post(
  '/:id/disable',
  asyncRoute(async (req, res) => {
    const target = await loadTarget(req, res);
    if (!target) return;
    const updated = await prisma.user.update({ where: { id: target.id }, data: { status: 'DISABLED' } });
    res.json(publicUser(updated));
  })
);

router.post(
  '/:id/reactivate',
  asyncRoute(async (req, res) => {
    const target = await loadTarget(req, res);
    if (!target) return;
    const updated = await prisma.user.update({ where: { id: target.id }, data: { status: 'ACTIVE' } });
    res.json(publicUser(updated));
  })
);

router.patch(
  '/:id/permissions',
  asyncRoute(async (req, res) => {
    const target = await loadTarget(req, res);
    if (!target) return;
    const { role, permissions } = req.body || {};
    const data = {};
    if (role) {
      if (!['ADMIN', 'MANAGER', 'EMPLOYEE'].includes(role)) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'دور غير معروف.' });
      }
      data.role = role;
    }
    if (permissions) data.permissions = JSON.stringify(permissions);
    const updated = await prisma.user.update({ where: { id: target.id }, data });
    res.json(publicUser(updated));
  })
);

export default router;
