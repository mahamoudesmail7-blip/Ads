// AI Operator V2 — selection SNAPSHOTS («select all N matching across pages»). A snapshot freezes WHICH campaigns the user meant (ids + a fingerprint of each row) under an exact query; it carries no authority:
// every bulk action re-validates every campaign against LIVE data, and the snapshot is private to its owner, re-scoped to the owner's CURRENT account access every time it is read, and expires after 30 minutes.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { matchingRows, fingerprint } from './campaignQuery.js';

export const SNAPSHOT_TTL_MS = 30 * 60_000; export const MAX_SNAPSHOT_IDS = 5000;
const fail = (status, message, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export async function createSnapshot({ user, access, body, now = new Date() }) {
  const { q, built, rows } = await matchingRows({ access, body, now, noCache: true });
  if (rows.length > MAX_SNAPSHOT_IDS) throw fail(413, `النتائج المطابقة ${rows.length} حملة — أكتر من الحد (${MAX_SNAPSHOT_IDS}). ضيّق الفلاتر.`, 'TOO_MANY');
  const items = rows.map((r) => ({ c: r.campaignId, a: r.adAccountId, fp: fingerprint(r) }));
  const idsHash = crypto.createHash('sha256').update(items.map((i) => `${i.a}:${i.c}`).join('|')).digest('hex').slice(0, 32);
  const id = crypto.randomUUID(); const expiresAt = new Date(now.getTime() + SNAPSHOT_TTL_MS);
  const query = { period: { key: q.period.key, from: q.period.from, to: q.period.to }, compare: q.compare, view: q.view, logic: q.logic, conds: q.conds, search: q.search, sort: q.sort, accounts: q.accounts };
  await prisma.ambOperatorSelectionSnapshot.create({ data: { id, owner_id: user.id, scope: 'CAMPAIGNS', query_json: JSON.stringify(query), ids_json: JSON.stringify(items), total: items.length, ids_hash: idsHash, data_as_of: built.sync?.lastSuccessAt ? new Date(built.sync.lastSuccessAt) : null, created_at: now, expires_at: expiresAt } });
  prisma.ambOperatorSelectionSnapshot.deleteMany({ where: { expires_at: { lt: new Date(now.getTime() - 24 * 3_600_000) } } }).catch(() => {}); // tidy old ones, best effort
  return { snapshotId: id, total: items.length, idsHash, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(), query, dataAsOf: built.sync?.lastSuccessAt || null };
}

/** the stored snapshot, re-scoped to the user's CURRENT access. Not the owner → 404 (never revealed); expired → 410. */
export async function readSnapshot({ id, user, access, now = new Date() }) {
  const s = await prisma.ambOperatorSelectionSnapshot.findUnique({ where: { id: String(id) } });
  if (!s || s.owner_id !== user.id) throw fail(404, 'اللقطة غير موجودة.', 'SNAPSHOT_NOT_FOUND');
  if (s.expires_at.getTime() <= now.getTime()) throw fail(410, 'اللقطة انتهت (30 دقيقة) — اعمل تحديد جديد.', 'SNAPSHOT_EXPIRED');
  const all = j(s.ids_json, []); const items = all.filter((i) => access.accounts.includes(i.a));
  return { id: s.id, total: s.total, scopedTotal: items.length, droppedByAccess: all.length - items.length, idsHash: s.ids_hash, createdAt: s.created_at.toISOString(), expiresAt: s.expires_at.toISOString(), dataAsOf: s.data_as_of?.toISOString?.() || null, query: j(s.query_json, {}), items };
}
/** the SAME payload without the id list (what the browser needs to show the selection) */
export async function snapshotSummary(args) { const { items, ...rest } = await readSnapshot(args); return rest; }
