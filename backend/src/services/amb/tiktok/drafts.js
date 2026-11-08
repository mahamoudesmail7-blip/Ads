// TikTok campaign drafts — one settings row per draft (`tt:<12hex>`), no schema change. A draft holds the wizard config AND the launch progress (which remote objects already exist), which is what makes a
// launch resumable without ever creating anything twice.
import crypto from 'node:crypto';
import { prisma } from '../../../prisma.js';
import { normalizeConfig } from './builder.js';
import { defaultConfig, PRESETS } from './spec.js';

const PREFIX = 'tt:';
const now = () => new Date().toISOString();
export const validDraftId = (id) => /^[0-9a-f]{12}$/.test(String(id || ''));
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const parse = (s) => { try { return JSON.parse(s || 'null'); } catch { return null; } };

const emptyProgress = () => ({ identityId: null, uploads: {}, campaignId: null, adgroupId: null, adIds: [], enabled: false, steps: [] });

export async function createDraft({ config = null, preset = null, userId = null, mode = 'REAL' } = {}) {
  const base = { ...defaultConfig(), ...(PRESETS[preset]?.config || {}), ...(config || {}) };
  const cfg = normalizeConfig(base);
  const d = { id: crypto.randomBytes(6).toString('hex'), name: cfg.name || 'كامبين تيك توك جديد', status: 'DRAFT', mode, config: cfg, progress: emptyProgress(), error: null, createdBy: userId, createdAt: now(), updatedAt: now() };
  await write(d); return d;
}
async function write(d) { d.updatedAt = now(); const data = JSON.stringify(d); await prisma.settings.upsert({ where: { id: PREFIX + d.id }, create: { id: PREFIX + d.id, data }, update: { data } }); return d; }
export const saveDraftRow = write;

export async function getDraft(id) {
  if (!validDraftId(id)) return null;
  const row = await prisma.settings.findUnique({ where: { id: PREFIX + id } });
  return row ? parse(row.data) : null;
}
export async function listDrafts() {
  const rows = await prisma.settings.findMany({ where: { id: { startsWith: PREFIX } } });
  return rows.map((r) => parse(r.data)).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((d) => ({ id: d.id, name: d.name, status: d.status, mode: d.mode, objective: d.config?.objective, dailyBudget: d.config?.dailyBudget, videos: d.config?.videos?.length || 0, campaignId: d.progress?.campaignId || null, enabled: !!d.progress?.enabled, error: d.error?.message || null, updatedAt: d.updatedAt, createdAt: d.createdAt }));
}

/** Edit the wizard config. Once ANYTHING exists on TikTok the structure is frozen (changing it would not change the real campaign) — only a new draft can. */
export async function updateDraftConfig(id, config) {
  const d = await getDraft(id); if (!d) throw bad('الكامبين مش موجود.', 404);
  if (d.status === 'LAUNCHING') throw bad('الكامبين بيتم رفعه دلوقتي — استنى لحد ما يخلص.', 409);
  if (d.progress.campaignId || d.progress.adgroupId || d.progress.adIds.length) throw bad('الكامبين اتعمل على تيك توك بالفعل، فمينفعش نعدّل إعداداته من هنا. اعمل نسخة جديدة منه أو عدّله من تيك توك.', 409);
  d.config = normalizeConfig({ ...d.config, ...config }); d.name = d.config.name || d.name; d.error = null; if (d.status === 'FAILED') d.status = 'DRAFT';
  return write(d);
}
export async function duplicateDraft(id, userId = null) {
  const d = await getDraft(id); if (!d) throw bad('الكامبين مش موجود.', 404);
  return createDraft({ config: { ...d.config, name: `${d.config.name || d.name} (نسخة)` }, userId, mode: d.mode });
}
export async function deleteDraft(id) {
  const d = await getDraft(id); if (!d) return { deleted: false };
  if (d.status === 'LAUNCHING') throw bad('الكامبين بيتم رفعه دلوقتي.', 409);
  if (d.progress.campaignId) throw bad('الكامبين اتعمل على تيك توك — حذف السجل من هنا مش بيحذفه من تيك توك. احذفه من Ads Manager.', 409);
  await prisma.settings.deleteMany({ where: { id: PREFIX + id } }); return { deleted: true };
}
