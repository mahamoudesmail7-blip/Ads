// Lost Orders management — internal processing workflow layered on top of
// the real EasyOrders integration. "Lost" itself is not a real EasyOrders
// status (their full status enum has none) — it maps to our RETURNED bucket
// (real raw_status "returning_from_delivery"), per explicit user direction.
// Detection is automatic (services/lostOrders.js, hooked into
// services/easyOrders.js) — every route here only reads/manages state for
// orders already detected that way, or lets a human record a real action
// (status change, note) against one. Nothing here invents an order,
// customer, or history entry.
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { prisma } from '../prisma.js';
import { fetchOrderById, fetchOrderByShortId, ingestOrder } from '../services/easyOrders.js';
import { createManualLostOrder } from '../services/lostOrders.js';

const router = Router();
router.use(requireAuth);

const PROCESSING_STATUSES = ['NEW', 'PROCESSING', 'CONTACTED', 'CUSTOMER_APPROVED', 'CUSTOMER_REJECTED', 'REPLACEMENT_CREATED', 'CLOSED'];
const STATUS_LABELS_AR = {
  NEW: 'جديد',
  PROCESSING: 'قيد المعالجة',
  CONTACTED: 'تم التواصل',
  CUSTOMER_APPROVED: 'العميل وافق',
  CUSTOMER_REJECTED: 'العميل رفض',
  REPLACEMENT_CREATED: 'تم إنشاء بديل',
  CLOSED: 'مغلق',
};

/** The real order-level data (customer, product(s), quantity, dates) for one lost order_id — every EasyOrdersOrder row sharing that order_id carries the same customer fields, so the first row is enough for the order-level facts; cart items are collected separately. */
async function loadRealOrderData(orderId) {
  const items = await prisma.easyOrdersOrder.findMany({
    where: { order_id: orderId },
    include: { product: { select: { id: true, product_name: true } } },
    orderBy: { id: 'asc' },
  });
  if (items.length === 0) return null;
  const first = items[0];
  return {
    orderId,
    shortId: first.short_id,
    customerName: first.customer_name,
    customerPhone: first.customer_phone,
    customerAddress: first.customer_address,
    customerGovernment: first.customer_government,
    orderCost: first.order_cost,
    shippingCost: first.shipping_cost,
    currentStatus: first.status,
    rawStatus: first.raw_status,
    orderCreatedAt: first.created_at,
    items: items.map((r) => ({
      productId: r.product_id,
      productName: r.product?.product_name || r.product_name_raw || 'منتج غير معروف',
      sku: r.sku,
      quantity: r.quantity,
      matched: r.matched,
    })),
  };
}

function summarizeForList(lostOrder, realData) {
  return {
    id: lostOrder.id,
    orderId: lostOrder.order_id,
    shortId: realData?.shortId ?? null,
    customerName: realData?.customerName ?? null,
    customerPhone: realData?.customerPhone ?? null,
    customerGovernment: realData?.customerGovernment ?? null,
    productNames: realData?.items.map((i) => i.productName) ?? [],
    orderCreatedAt: realData?.orderCreatedAt ?? null,
    lostDetectedAt: lostOrder.detected_at,
    processingStatus: lostOrder.processing_status,
    processingStatusLabel: STATUS_LABELS_AR[lostOrder.processing_status],
    replacementOrderId: lostOrder.replacement_order_id,
    source: lostOrder.source,
    manualReason: lostOrder.manual_reason,
  };
}

router.get(
  '/summary',
  asyncRoute(async (req, res) => {
    const rows = await prisma.lostOrder.groupBy({ by: ['processing_status'], _count: true });
    const counts = Object.fromEntries(PROCESSING_STATUSES.map((s) => [s, 0]));
    for (const r of rows) counts[r.processing_status] = r._count;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    res.json({
      total,
      new: counts.NEW,
      processing: counts.PROCESSING + counts.CONTACTED + counts.CUSTOMER_APPROVED + counts.CUSTOMER_REJECTED,
      replacementCreated: counts.REPLACEMENT_CREATED,
      closed: counts.CLOSED,
    });
  })
);

router.get(
  '/new-count',
  asyncRoute(async (req, res) => {
    const count = await prisma.lostOrder.count({ where: { processing_status: 'NEW' } });
    res.json({ count });
  })
);

// Filter chips are the same 5 buckets as the summary cards (spec section 3) —
// coarser than the 7 actual processing statuses a row can hold (section 4).
const STATUS_FILTER_GROUPS = {
  NEW: ['NEW'],
  PROCESSING: ['PROCESSING', 'CONTACTED', 'CUSTOMER_APPROVED', 'CUSTOMER_REJECTED'],
  REPLACEMENT_CREATED: ['REPLACEMENT_CREATED'],
  CLOSED: ['CLOSED'],
};

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const { search, status, dateFrom, dateTo } = req.query;
    const where = {};
    if (status && status !== 'ALL' && STATUS_FILTER_GROUPS[status]) where.processing_status = { in: STATUS_FILTER_GROUPS[status] };
    if (dateFrom || dateTo) {
      where.detected_at = {};
      if (dateFrom) where.detected_at.gte = new Date(`${dateFrom}T00:00:00.000Z`);
      if (dateTo) where.detected_at.lte = new Date(`${dateTo}T23:59:59.999Z`);
    }

    const lostOrders = await prisma.lostOrder.findMany({ where, orderBy: { detected_at: 'desc' } });
    const withRealData = await Promise.all(lostOrders.map(async (lo) => ({ lo, realData: await loadRealOrderData(lo.order_id) })));

    let list = withRealData.map(({ lo, realData }) => summarizeForList(lo, realData));

    if (search) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (row) =>
          row.orderId.toLowerCase().includes(q) ||
          String(row.shortId || '').includes(q) ||
          (row.customerName || '').toLowerCase().includes(q) ||
          (row.customerPhone || '').includes(q)
      );
    }

    res.json(list);
  })
);

// Manual add — for a real problem EasyOrders' public API cannot signal at
// all (confirmed case: their dashboard-only "تحت المراجعة" data-validation
// flag has no field anywhere in the API response). Still 100% real order
// data — pulled live via their Get-Order-By-(Short-)ID API — only the
// *reason* for flagging it is a human observation rather than a status the
// API exposed.
router.post(
  '/manual-add',
  asyncRoute(async (req, res) => {
    const { orderNumber, reason } = req.body || {};
    const trimmedReason = (reason || '').trim();
    const trimmedNumber = (orderNumber || '').trim();
    if (!trimmedNumber || !trimmedReason) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'رقم الأوردر والسبب مطلوبين.' });
    }

    const order = /^\d+$/.test(trimmedNumber) ? await fetchOrderByShortId(trimmedNumber) : await fetchOrderById(trimmedNumber);
    if (!order) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'مقدرش ألاقي الأوردر ده على EasyOrders — تأكد من الرقم.' });
    }

    const alreadyTracked = await prisma.easyOrdersOrder.findFirst({ where: { order_id: order.id } });
    if (!alreadyTracked) await ingestOrder(order); // first time we've ever seen this order — pull it in with the same real ingest path the webhook uses

    const lostOrder = await createManualLostOrder(order.id, trimmedReason, req.user.id);
    res.status(201).json({ id: lostOrder.id, orderId: lostOrder.order_id, shortId: order.short_id });
  })
);

router.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const lostOrder = await prisma.lostOrder.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        notes: { orderBy: { created_at: 'desc' }, include: { author: { select: { name: true } } } },
        history: { orderBy: { created_at: 'desc' }, include: { actor: { select: { name: true } } } },
      },
    });
    if (!lostOrder) return res.status(404).json({ error: 'NOT_FOUND', message: 'الأوردر المفقود ده مش موجود.' });

    const realData = await loadRealOrderData(lostOrder.order_id);
    res.json({
      id: lostOrder.id,
      orderId: lostOrder.order_id,
      processingStatus: lostOrder.processing_status,
      processingStatusLabel: STATUS_LABELS_AR[lostOrder.processing_status],
      replacementOrderId: lostOrder.replacement_order_id,
      source: lostOrder.source,
      manualReason: lostOrder.manual_reason,
      lostDetectedAt: lostOrder.detected_at,
      realOrder: realData,
      notes: lostOrder.notes.map((n) => ({ id: n.id, text: n.text, author: n.author?.name || null, createdAt: n.created_at })),
      history: lostOrder.history.map((h) => ({ id: h.id, action: h.action, detail: h.detail, actor: h.actor?.name || null, createdAt: h.created_at })),
    });
  })
);

router.patch(
  '/:id/status',
  asyncRoute(async (req, res) => {
    const { status } = req.body || {};
    if (!PROCESSING_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'حالة غير معروفة.' });
    }
    const lostOrder = await prisma.lostOrder.findUnique({ where: { id: Number(req.params.id) } });
    if (!lostOrder) return res.status(404).json({ error: 'NOT_FOUND', message: 'الأوردر المفقود ده مش موجود.' });

    const updated = await prisma.lostOrder.update({ where: { id: lostOrder.id }, data: { processing_status: status } });
    await prisma.lostOrderHistory.create({
      data: {
        lost_order_id: lostOrder.id,
        action: 'STATUS_CHANGED',
        detail: `${STATUS_LABELS_AR[lostOrder.processing_status]} ← ${STATUS_LABELS_AR[status]}`,
        actor_id: req.user.id,
      },
    });
    res.json({ id: updated.id, processingStatus: updated.processing_status, processingStatusLabel: STATUS_LABELS_AR[updated.processing_status] });
  })
);

router.post(
  '/:id/notes',
  asyncRoute(async (req, res) => {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'الملاحظة مينفعش تكون فاضية.' });
    const lostOrder = await prisma.lostOrder.findUnique({ where: { id: Number(req.params.id) } });
    if (!lostOrder) return res.status(404).json({ error: 'NOT_FOUND', message: 'الأوردر المفقود ده مش موجود.' });

    const note = await prisma.lostOrderNote.create({ data: { lost_order_id: lostOrder.id, text, author_id: req.user.id } });
    await prisma.lostOrderHistory.create({
      data: { lost_order_id: lostOrder.id, action: 'NOTE_ADDED', detail: text.slice(0, 120), actor_id: req.user.id },
    });
    res.status(201).json({ id: note.id, text: note.text, createdAt: note.created_at });
  })
);

// Real order creation is not currently possible — EasyOrders' public API
// has no create-order endpoint (confirmed: their sitemap lists exactly 4
// order endpoints — get-by-id, get-by-short-id, update-status, add-notes —
// and their own dropshipping integration guide describes the order flow as
// receive-only). This route exists so the frontend has a real, honest
// endpoint to call rather than faking success client-side; it returns
// NOT_SUPPORTED until EasyOrders confirms an endpoint (contact
// info@easy-orders.net — see conversation).
router.post(
  '/:id/create-replacement',
  asyncRoute(async (req, res) => {
    res.status(501).json({
      error: 'NOT_SUPPORTED',
      message: 'EasyOrders مفيهاش API لإنشاء أوردر جديد حاليًا. تواصل مع info@easy-orders.net لتفعيل الإمكانية دي، وبعدها هنفعّل الزرار ده.',
    });
  })
);

export default router;
