// Automatic Lost Order detection. EasyOrders has no native "Lost/مفقود"
// status (confirmed against their full published status enum) — this maps
// our own RETURNED bucket (real raw_status "returning_from_delivery": a
// failed delivery attempt, package on its way back — the closest real
// EasyOrders state to what a COD seller calls "lost") to an internal
// tracking row, per explicit user direction. Called from services/easyOrders.js
// right after a status change lands on RETURNED, so detection happens the
// same way whether the change arrived via webhook or the reconciliation poll.
import { prisma } from '../prisma.js';

export async function ensureLostOrderTracking(orderId) {
  const rows = await prisma.easyOrdersOrder.findMany({ where: { order_id: orderId } });
  if (rows.length === 0) return;
  const isLost = rows.every((r) => r.status === 'RETURNED');
  if (!isLost) return;

  const existing = await prisma.lostOrder.findUnique({ where: { order_id: orderId } });
  if (existing) return; // already tracked — never re-create or reset an existing processing state

  const lostOrder = await prisma.lostOrder.create({ data: { order_id: orderId, processing_status: 'NEW' } });
  await prisma.lostOrderHistory.create({
    data: { lost_order_id: lostOrder.id, action: 'DETECTED', detail: 'تم اكتشاف الأوردر كمفقود تلقائيًا (الحالة الحقيقية من EasyOrders: راجع من التوصيل)' },
  });
}
