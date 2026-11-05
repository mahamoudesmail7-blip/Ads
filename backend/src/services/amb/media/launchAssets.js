// AMB Media — puts a server-made image/video INTO the wizard's creative pool.
// Same rows the browser upload route writes (AmbLaunchImageAsset / AmbLaunchVideoAsset), same Meta upload calls, so the wizard,
// the review step and the publish engine treat a generated asset exactly like one the owner dragged in.
// Slot keys start at 101 (I101 / C101 …) so they can never collide with the browser's own I1.. / C1.. keys.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { prisma } from '../../../prisma.js';
import * as launch from '../launchBuilder.js';
import { requireLaunchToken, streamUploadVideoToMeta } from '../launchVideoUpload.js';
import { uploadAdImageBuffer } from '../../metaGraphClient.js';
import { MediaError } from './mediaJobs.js';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const previewKey = (jobId, slotKey) => `lp/${jobId}/${slotKey}`;
/** A server-made image has no file in the owner's browser, so we keep a small JPEG copy (cf_blobs) the wizard can show and enlarge. Best effort: a failure only means "no preview". */
export async function savePreview(jobId, slotKey, buffer, mime = 'image/png') {
  try {
    let data = buffer, type = mime;
    try { // ~1 MB PNG → ~150 KB JPEG
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const img = await loadImage(buffer);
      const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
      const c = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale)); const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      data = c.toBuffer('image/jpeg', 85); type = 'image/jpeg';
    } catch { /* keep the original bytes */ }
    const key = previewKey(jobId, slotKey);
    await prisma.cfBlob.upsert({ where: { key }, create: { key, data, mime: type, bytes: data.length }, update: { data, mime: type, bytes: data.length } });
  } catch { /* no preview is not a failure of the upload */ }
}
export async function getPreview(jobId, slotKey) {
  if (!/^[a-z0-9_-]{8,80}$/i.test(String(jobId)) || !/^I\d{1,4}$/.test(String(slotKey))) return null;
  const row = await prisma.cfBlob.findUnique({ where: { key: previewKey(jobId, slotKey) } });
  return row ? { data: Buffer.from(row.data), mime: row.mime } : null;
}

async function nextKey(launchJobId, kind) {
  const prefix = kind === 'image' ? 'I' : 'C';
  const rows = kind === 'image'
    ? await prisma.ambLaunchImageAsset.findMany({ where: { job_id: launchJobId }, select: { slot_key: true } })
    : await prisma.ambLaunchVideoAsset.findMany({ where: { job_id: launchJobId }, select: { slot_key: true } });
  const used = new Set(rows.map((r) => r.slot_key));
  for (let n = 101; ; n++) { const k = `${prefix}${n}`; if (!used.has(k)) return k; }
}

const metaMessage = (e) => e?.metaError?.message || e?.message || 'فشل الرفع على Meta.';

/** Upload one image buffer to the job's ad account and register it. Returns { slotKey, imageHash }. */
export async function addImageToPool({ launchJobId, buffer, filename, mime = 'image/png', width = null, height = null, deps = {} }) {
  const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: launchJobId }, select: { ad_account_id: true } });
  if (!job) throw new MediaError('طلب الرفع مش موجود.', 'NOT_FOUND');
  const token = await (deps.token || requireLaunchToken)();
  const slotKey = await nextKey(launchJobId, 'image');
  const { row, duplicateOfSlotKey } = await launch.registerImageSlot({ jobId: launchJobId, slotKey, originalFilename: filename, contentHash: sha256(buffer), sizeBytes: buffer.length, mimeType: mime, width, height });
  if (duplicateOfSlotKey) { // same bytes already in this job: don't pay for / upload the identical image twice
    const dup = await prisma.ambLaunchImageAsset.findUnique({ where: { job_id_slot_key: { job_id: launchJobId, slot_key: duplicateOfSlotKey } } });
    if (dup?.status === 'UPLOADED' && dup.meta_image_hash) { await launch.markImageResult({ jobId: launchJobId, slotKey, status: 'UPLOADED', metaImageHash: dup.meta_image_hash }); return { slotKey, imageHash: dup.meta_image_hash, deduped: true }; }
  }
  void row;
  await savePreview(launchJobId, slotKey, buffer, mime);
  await launch.markImageResult({ jobId: launchJobId, slotKey, status: 'UPLOADING' }).catch(() => {});
  try {
    const { hash } = await (deps.uploadImage || uploadAdImageBuffer)(token, job.ad_account_id, buffer);
    await launch.markImageResult({ jobId: launchJobId, slotKey, status: 'UPLOADED', metaImageHash: hash });
    return { slotKey, imageHash: hash };
  } catch (e) {
    await launch.markImageResult({ jobId: launchJobId, slotKey, status: 'FAILED', error: metaMessage(e) }).catch(() => {});
    throw new MediaError(`رفع الصورة على Meta فشل: ${metaMessage(e)}`, 'META_UPLOAD');
  }
}

/** Stream a local video file to Meta (resumable upload) and register it. Returns { slotKey, videoId }. */
export async function addVideoFileToPool({ launchJobId, filePath, filename, mime = 'video/mp4', durationSeconds = null, deps = {} }) {
  const job = await prisma.ambLaunchJob.findUnique({ where: { job_id: launchJobId }, select: { ad_account_id: true } });
  if (!job) throw new MediaError('طلب الرفع مش موجود.', 'NOT_FOUND');
  const stat = await fs.promises.stat(filePath);
  if (!stat.size) throw new MediaError('الفيديو المنزّل فاضي.', 'EMPTY_FILE');
  const token = await (deps.token || requireLaunchToken)();
  const slotKey = await nextKey(launchJobId, 'video');
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => fs.createReadStream(filePath).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject));
  const contentHash = hash.digest('hex');
  const { duplicateOfSlotKey } = await launch.registerVideoSlot({ jobId: launchJobId, slotKey, originalFilename: filename, contentHash, sizeBytes: stat.size, mimeType: mime, durationSeconds });
  if (duplicateOfSlotKey) {
    const dup = await prisma.ambLaunchVideoAsset.findUnique({ where: { job_id_slot_key: { job_id: launchJobId, slot_key: duplicateOfSlotKey } } });
    if (dup?.status === 'UPLOADED' && dup.meta_video_id) { await launch.markVideoResult({ jobId: launchJobId, slotKey, status: 'UPLOADED', metaVideoId: dup.meta_video_id }); return { slotKey, videoId: dup.meta_video_id, deduped: true }; }
  }
  await launch.markVideoResult({ jobId: launchJobId, slotKey, status: 'UPLOADING' }).catch(() => {});
  try {
    const { videoId } = await (deps.uploadVideo || streamUploadVideoToMeta)({ req: fs.createReadStream(filePath), adAccountId: job.ad_account_id, fileSize: stat.size, token, jobId: launchJobId, slotKey });
    await launch.markVideoResult({ jobId: launchJobId, slotKey, status: 'UPLOADED', metaVideoId: videoId });
    return { slotKey, videoId };
  } catch (e) {
    await launch.markVideoResult({ jobId: launchJobId, slotKey, status: 'FAILED', error: metaMessage(e) }).catch(() => {});
    throw new MediaError(`رفع الفيديو على Meta فشل: ${metaMessage(e)}`, 'META_UPLOAD');
  }
}
