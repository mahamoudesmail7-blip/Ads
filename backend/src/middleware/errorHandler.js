import { logger } from '../logger.js';

/** Wraps an async route handler so a thrown/rejected error reaches errorHandler instead of hanging the request. */
export function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Central error handler — last middleware in the chain (see server.js).
// Prisma's known-error codes get a friendly Arabic message; everything else
// is logged with full detail server-side but never leaks internals (stack
// traces, SQL, connection strings) back to the client.
export function errorHandler(err, req, res, _next) {
  if (err?.code === 'P2002') {
    return res.status(409).json({ error: 'DUPLICATE', message: 'القيمة دي مستخدمة بالفعل.' });
  }
  if (err?.code === 'P2025') {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'العنصر مش موجود.' });
  }
  if (err?.name === 'ZodError') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'بيانات غير صحيحة.', details: err.issues });
  }

  // An error a service deliberately tagged with an HTTP status is a
  // user-facing, non-internal error — surface its real (Arabic) message
  // instead of a generic 500. Only trusted when `status` is set explicitly.
  const tagged = Number(err?.status || err?.statusCode);
  if (Number.isInteger(tagged) && tagged >= 400 && tagged <= 599 && tagged !== 500) {
    return res.status(tagged).json({ error: err.code || 'REQUEST_ERROR', message: err.message || 'الطلب غير صالح.', ...(err.details ? { details: err.details } : {}), ...(err.scale ? { scale: err.scale } : {}) });
  }

  logger.error('Unhandled error', { message: err?.message, stack: err?.stack, path: req.path, method: req.method });
  res.status(500).json({ error: 'SERVER_ERROR', message: 'حصل خطأ في السيرفر.' });
}
