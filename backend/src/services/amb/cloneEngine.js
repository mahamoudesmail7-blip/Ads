// AI Media Buyer — CAMPAIGN CLONE & SCHEDULE engine.
//
// Flow (mirrors the spec exactly):
//   FROM one source account → pick campaigns → pick destination accounts →
//   schedule (default 00:00 in each destination account's own timezone) →
//   REVIEW (source / campaigns / destinations / #copies / schedule / pre-flight)
//   → APPROVE & SCHEDULE → clone every campaign→adsets→ads→creatives into each
//   destination as PAUSED → a background job flips the good ones ACTIVE at the
//   scheduled time.
//
// Guarantees:
//   • The source campaigns are NEVER modified — this file only GETs from the
//     source account and POSTs to the destination account(s).
//   • Idempotent: batch_id is the operation key; every created object is
//     recorded in AmbCloneObjectMap with a UNIQUE (job,level,source_id) key,
//     so a refresh / retry / worker restart re-attaches instead of
//     re-creating. resume() only re-runs the PENDING/FAILED objects.
//   • Nothing is created before the owner's APPROVE & SCHEDULE.
//   • Only READY/WARNING jobs are cloned & scheduled; BLOCKED jobs are not
//     touched and show the exact blocking reason.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection, getDecryptedToken } from '../metaAuth.js';
import {
  getAllAccessibleAdAccounts, listCampaignsForClone, getCampaignNode, getAdSetNodes, getAdNodes,
  getCreativeNode, getAdImagesByHash, getVideoSourceUrl, getAccountAssetsForClone, getPagePostContent,
  uploadAdImageFromUrl, uploadAdVideoFromUrl, createCampaign, createAdSet, createAdCreative, createAd,
  setEntityStatus,
} from '../metaGraphClient.js';
import { getAmbSettings } from './settings.js';
import { raiseAlert } from './alerts.js';
import { preflightCampaignForDestination } from './clonePreflight.js';
import { libraryDestHints, registerClonedCreativeRef } from './mediaLibrary.js';
import { normalizeCreative } from './cloneAnalysis.js';
import { jobHasActiveSchedule, cancelSchedulesForBatch } from './campaignSchedule.js';

/** Lightweight "can this ad be copied at all?" check — no network. An ad is
 * NOT copyable only when its creative genuinely has nothing to reproduce (a
 * boosted post with no text/media) or needs a destination Page and none is
 * resolvable. A video with no downloadable source is still "copyable" — the
 * engine tries the shared reference first. */
function adCopyable(cr, { destPageId, identityMap }) {
  if (!cr || cr.__error) return false;
  let norm;
  try { norm = normalizeCreative(cr); } catch { return false; }
  if (norm.objectStoryId && !norm.hasObjectStorySpec && !(norm.body || norm.title || norm.images.length || norm.videos.length || norm.carouselCards.length)) return false;
  if (!norm.hasObjectStorySpec) {
    const src = norm.sourcePageId;
    const pg = (src && identityMap?.pages?.[String(src)]) || destPageId || null;
    if (!pg) return false;
  }
  return true;
}

const TERMINAL_JOB = new Set(['ACTIVATED', 'CANCELLED']);
const running = new Set(); // batch_ids with an in-flight runBatch()

function j(v, d = null) { try { return v ? JSON.parse(v) : d; } catch { return d; } }
function isoOrNull(d) { return d ? new Date(d).toISOString() : null; }

/** Full, un-generalised Meta error string (message + code/subcode/type/fbtrace + Meta's user-facing reason + blamed field) for the audit + job error. */
function metaErr(e) {
  const bits = [e?.message || String(e)];
  const tags = [];
  if (e?.graphCode != null) tags.push(`code=${e.graphCode}`);
  if (e?.graphSubcode != null) tags.push(`subcode=${e.graphSubcode}`);
  if (e?.graphType) tags.push(`type=${e.graphType}`);
  if (e?.graphBlameFields) tags.push(`blame=${JSON.stringify(e.graphBlameFields)}`);
  if (e?.fbtraceId) tags.push(`fbtrace_id=${e.fbtraceId}`);
  return tags.length ? `${bits[0]} [${tags.join(', ')}]` : bits[0];
}
function metaErrData(e) {
  return {
    message: e?.message || String(e), code: e?.graphCode ?? null, subcode: e?.graphSubcode ?? null,
    type: e?.graphType ?? null, userTitle: e?.graphUserTitle ?? null, userMsg: e?.graphUserMsg ?? null,
    blameFields: e?.graphBlameFields ?? null, fbtraceId: e?.fbtraceId ?? null,
  };
}
// Meta error subcodes that are PAYLOAD-STRUCTURE problems, not "asset not
// usable" — re-uploading would not help, so the re-upload retry must NOT fire.
const STRUCTURE_ERROR_SUBCODES = new Set([1443051, 1487472, 2446385, 1885183]);
/** Does this Meta error look like "the referenced image/video/creative asset isn't usable in this account"? (⇒ try a re-upload fallback) */
function isAssetRefError(e) {
  if (!e) return false;
  if (e.graphSubcode && STRUCTURE_ERROR_SUBCODES.has(Number(e.graphSubcode))) return false;
  const msg = (e.message || '') + ' ' + (e.graphUserMsg || '') + ' ' + (e.graphUserTitle || '');
  return /video|image_hash|image hash|not (be )?found|does not exist|cannot (be )?access|no permission|unsupported|invalid video|invalid image|media|being processed|not ready/i.test(msg);
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysAgoISO(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
// Timezone: next occurrence of HH:MM in an IANA timezone, as a UTC instant.
// ---------------------------------------------------------------------------
function tzOffsetMs(instant, timeZone) {
  // How far `timeZone` wall-clock is ahead of UTC at `instant`.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}
/** UTC Date for the next `hh:mm` in `timeZone` strictly after `from`. Falls back to a fixed offset if the tz is unknown. */
export function nextLocalTimeInTz(hhmm, timeZone, from = new Date()) {
  const [hh, mm] = String(hhmm || '00:00').split(':').map((x) => parseInt(x, 10) || 0);
  let tz = timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'Etc/UTC'; }
  const offset = tzOffsetMs(from, tz);
  // Wall-clock "now" in tz:
  const wall = new Date(from.getTime() + offset);
  const target = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hh, mm, 0));
  let utc = new Date(target.getTime() - offset);
  if (utc.getTime() <= from.getTime()) utc = new Date(utc.getTime() + 24 * 3600 * 1000);
  // Re-resolve the offset at the target instant (handles a DST jump between now and then).
  const offset2 = tzOffsetMs(utc, tz);
  if (offset2 !== offset) {
    utc = new Date(target.getTime() - offset2);
    if (utc.getTime() <= from.getTime()) utc = new Date(utc.getTime() + 24 * 3600 * 1000);
  }
  return utc;
}

// ---------------------------------------------------------------------------
// Source reads
// ---------------------------------------------------------------------------
async function readCampaignTree(token, campaignId) {
  const [campaign, adsets, ads] = await Promise.all([
    getCampaignNode(token, campaignId),
    getAdSetNodes(token, campaignId),
    getAdNodes(token, campaignId),
  ]);
  const creativeIds = [...new Set(ads.map((a) => a.creative?.id).filter(Boolean))];
  const creatives = new Map();
  for (const cid of creativeIds) {
    try { creatives.set(cid, await getCreativeNode(token, cid)); } catch (e) { creatives.set(cid, { id: cid, __error: e.message }); }
  }
  // SHARE / boosted Page-post creatives (object_story_id, no object_story_spec):
  // the URL / headline / description / CTA live on the underlying Page POST,
  // not the AdCreative. Recover them here so the reconstruction has real data.
  for (const cr of creatives.values()) {
    if (cr.__error) continue;
    const osid = cr.object_story_id || cr.effective_object_story_id;
    const hasSpec = !!cr.object_story_spec;
    const hasAfs = !!cr.asset_feed_spec && !!Object.keys(cr.asset_feed_spec).length;
    if (osid && !hasSpec && !hasAfs) {
      try { cr.__postContent = await getPagePostContent(token, osid); } catch { cr.__postContent = null; }
    }
  }
  return { campaign, adsets, ads, creatives };
}

/** Resolve every source image_hash → a downloadable URL and every source video_id → a source URL (for re-upload into a destination account). */
async function resolveSourceAssets(token, sourceAccountId, tree) {
  const hashes = new Set();
  const videoIds = new Set();
  for (const cr of tree.creatives.values()) {
    const oss = cr.object_story_spec || {};
    const link = oss.link_data || {};
    const vid = oss.video_data || {};
    for (const h of [cr.image_hash, link.image_hash, vid.image_hash]) if (h) hashes.add(h);
    for (const ch of link.child_attachments || []) if (ch.image_hash) hashes.add(ch.image_hash);
    for (const im of cr.asset_feed_spec?.images || []) if (im.hash) hashes.add(im.hash);
    for (const v of [cr.video_id, vid.video_id]) if (v) videoIds.add(String(v));
    for (const v of cr.asset_feed_spec?.videos || []) if (v.video_id) videoIds.add(String(v.video_id));
  }
  const imageUrls = {};
  if (hashes.size) {
    const byHash = await getAdImagesByHash(token, sourceAccountId, [...hashes]);
    for (const h of hashes) {
      const fromApi = byHash[h]?.url || byHash[h]?.permalink_url || null;
      // Fall back to a creative-level image_url when the adimages lookup is empty.
      let url = fromApi;
      if (!url) {
        for (const cr of tree.creatives.values()) {
          if (cr.image_hash === h && cr.image_url) { url = cr.image_url; break; }
        }
      }
      if (url) imageUrls[h] = url;
    }
  }
  const videoSources = {};
  for (const v of videoIds) videoSources[v] = await getVideoSourceUrl(token, v);
  return { imageUrls, videoSources };
}

// ---------------------------------------------------------------------------
// Preview (NO writes) — powers the wizard + REVIEW screen.
// ---------------------------------------------------------------------------
async function requireConnectedToken() {
  const connection = await getConnection();
  if (!connection || connection.status !== 'CONNECTED') { const e = new Error('اربط حساب Meta Ads الأول.'); e.status = 400; throw e; }
  return { connection, token: await getDecryptedToken() };
}

export async function listCloneAccounts() {
  const { connection, token } = await requireConnectedToken();
  const accounts = await getAllAccessibleAdAccounts(token);
  return { accounts, selectedAdAccountId: connection.selected_ad_account_id || null };
}

export async function listSourceCampaigns({ accountId }) {
  if (!accountId) { const e = new Error('accountId مطلوب.'); e.status = 400; throw e; }
  const { token } = await requireConnectedToken();
  const campaigns = await listCampaignsForClone(token, accountId, { since: daysAgoISO(7), until: todayISO() });
  return { accountId, campaigns };
}

/**
 * Build the full REVIEW payload: resolves every (campaign × destination)
 * pre-flight and the per-destination scheduled activation instant. Pure read.
 */
export async function buildPreview({ sourceAccountId, destinationAccountIds, campaignIds, scheduleLocalTime, destinationPageId = null, recreateBoosted = false }) {
  if (!sourceAccountId) { const e = new Error('لازم تختار حساب مصدر واحد.'); e.status = 400; throw e; }
  const dests = [...new Set((destinationAccountIds || []).filter((x) => x && x !== sourceAccountId))];
  const camps = [...new Set((campaignIds || []).filter(Boolean))];
  if (!camps.length) { const e = new Error('لازم تختار حملة واحدة على الأقل.'); e.status = 400; throw e; }
  if (!dests.length) { const e = new Error('لازم تختار حساب وجهة واحد على الأقل (غير حساب المصدر).'); e.status = 400; throw e; }
  const settings = await getAmbSettings();
  const scheduleTime = /^\d{1,2}:\d{2}$/.test(scheduleLocalTime || '') ? scheduleLocalTime : (settings.ambCloneDefaultActivationTime || '00:00');
  const maxCamps = Number(settings.ambCloneMaxCampaignsPerBatch) || 20;
  if (camps.length > maxCamps) { const e = new Error(`أقصى عدد حملات في الدفعة الواحدة ${maxCamps}.`); e.status = 400; throw e; }

  const { token } = await requireConnectedToken();
  const allAccounts = await getAllAccessibleAdAccounts(token);
  const acctById = new Map(allAccounts.map((a) => [a.id, a]));
  const sourceAccount = acctById.get(sourceAccountId) || { id: sourceAccountId, name: sourceAccountId };

  // Read each source campaign tree + resolve its assets ONCE.
  const trees = new Map();
  const srcAssets = new Map();
  for (const cid of camps) {
    try {
      const tree = await readCampaignTree(token, cid);
      trees.set(cid, tree);
      srcAssets.set(cid, await resolveSourceAssets(token, sourceAccountId, tree));
    } catch (e) {
      trees.set(cid, { __error: e.message });
    }
  }

  // List each destination account's asset inventory ONCE.
  const destInv = new Map();
  for (const d of dests) destInv.set(d, await getAccountAssetsForClone(token, d));

  const rows = [];
  for (const cid of camps) {
    const tree = trees.get(cid);
    const campName = tree?.campaign?.name || `حملة ${cid}`;
    for (const d of dests) {
      const destAcct = acctById.get(d) || { id: d, name: d };
      const schedAt = nextLocalTimeInTz(scheduleTime, destAcct.timezoneName, new Date());
      if (tree?.__error) {
        rows.push({ campaignId: cid, campaignName: campName, destinationAccountId: d, destinationAccountName: destAcct.name, destinationTimezone: destAcct.timezoneName || null, scheduledActivationAt: schedAt.toISOString(), status: 'BLOCKED', checks: [{ name: 'قراءة الحملة المصدر', status: 'BLOCK', detail: tree.__error }], required: {}, currencyMismatch: false });
        continue;
      }
      const libHints = new Map();
      for (const [crId, crNode] of tree.creatives) {
        if (!crNode || crNode.__error) continue;
        libHints.set(crId, await libraryDestHints(crNode, d).catch(() => ({ reuseImageHashes: new Set(), videoBySrc: new Map(), assetId: null })));
      }
      const pf = preflightCampaignForDestination({ tree, sourceAssets: srcAssets.get(cid), destAssets: destInv.get(d), libraryHintsByCreative: libHints, pageIdOverride: destinationPageId, recreateBoosted });
      const currencyMismatch = !!(sourceAccount.currency && destAcct.currency && sourceAccount.currency !== destAcct.currency);
      if (currencyMismatch) pf.checks.push({ name: 'العملة', status: 'WARN', detail: `عملة المصدر (${sourceAccount.currency}) تختلف عن الوجهة (${destAcct.currency}) — سيتم نسخ قيمة الميزانية كما هي، راجعها.` });
      const status = pf.checks.some((c) => c.status === 'BLOCK') ? 'BLOCKED' : pf.checks.some((c) => c.status === 'WARN') ? 'WARNING' : 'READY';
      rows.push({
        campaignId: cid, campaignName: campName,
        adsetCount: (tree.adsets || []).length, adCount: (tree.ads || []).length,
        destinationAccountId: d, destinationAccountName: destAcct.name,
        destinationTimezone: destAcct.timezoneName || null,
        scheduledActivationAt: schedAt.toISOString(),
        status, checks: pf.checks, required: pf.required, currencyMismatch,
        _resolved: pf.resolved, // kept server-side only; stripped before the API response
      });
    }
  }

  const totalCopies = camps.length * dests.length;
  const blocked = rows.filter((r) => r.status === 'BLOCKED').length;
  return {
    source: { id: sourceAccount.id, name: sourceAccount.name, currency: sourceAccount.currency || null },
    destinations: dests.map((d) => { const a = acctById.get(d) || { id: d, name: d }; return { id: d, name: a.name, currency: a.currency || null, timezoneName: a.timezoneName || null }; }),
    campaigns: camps.map((cid) => { const t = trees.get(cid); return { id: cid, name: t?.campaign?.name || `حملة ${cid}`, error: t?.__error || null, adsetCount: (t?.adsets || []).length, adCount: (t?.ads || []).length }; }),
    scheduleLocalTime: scheduleTime,
    totalCopies,
    cloneableCopies: totalCopies - blocked,
    blockedCopies: blocked,
    sourceUnchanged: true,
    matrix: rows.map(({ _resolved, ...r }) => r),
  };
}

// ---------------------------------------------------------------------------
// Batch lifecycle
// ---------------------------------------------------------------------------
export async function createBatch({ batchId, sourceAccountId, destinationAccountIds, campaignIds, scheduleLocalTime, destinationPageId = null, destinationInstagramId = null, identityMap = null, pixelMap = null, allowPageOnlyIg = true, copyValidAdsOnly = false, recreateBoosted = false, userId }) {
  const bid = batchId && /^[a-z0-9-]{8,64}$/i.test(batchId) ? batchId : crypto.randomUUID();

  const existing = await prisma.ambCloneBatch.findUnique({ where: { batch_id: bid } });
  if (existing) return getBatch(bid); // idempotent — a retried submit returns the same batch

  // One read-only pass computes the pre-flight matrix + per-destination
  // schedule. The engine re-runs a fresh pre-flight per job at clone time, so
  // we only persist the API-safe rows here (no server-only `_resolved`).
  const destPage = destinationPageId && /^\d{5,}$/.test(String(destinationPageId)) ? String(destinationPageId) : null;
  const destIg = destinationInstagramId && /^\d{5,}$/.test(String(destinationInstagramId)) ? String(destinationInstagramId) : null;
  const idMap = identityMap && typeof identityMap === 'object' ? identityMap : null;
  const pxMap = pixelMap && typeof pixelMap === 'object' ? pixelMap : null;
  const preview = await buildPreview({ sourceAccountId, destinationAccountIds, campaignIds, scheduleLocalTime, destinationPageId: destPage, recreateBoosted: !!recreateBoosted && !!destPage });
  const dests = preview.destinations.map((d) => d.id);
  const camps = preview.campaigns.map((c) => c.id);

  const batch = await prisma.ambCloneBatch.create({
    data: {
      batch_id: bid,
      source_ad_account_id: preview.source.id,
      source_ad_account_name: preview.source.name,
      destination_account_ids_json: JSON.stringify(dests),
      campaign_ids_json: JSON.stringify(camps),
      schedule_local_time: preview.scheduleLocalTime,
      destination_page_id: destPage,
      destination_instagram_id: destIg,
      identity_map_json: JSON.stringify({ ...(idMap || {}), allowPageOnlyIg: allowPageOnlyIg !== false, copyValidAdsOnly: copyValidAdsOnly === true }),
      pixel_map_json: pxMap ? JSON.stringify(pxMap) : null,
      recreate_boosted: !!recreateBoosted && !!destPage,
      total_copies: preview.totalCopies,
      status: 'PENDING_APPROVAL',
      preflight_json: JSON.stringify(preview.matrix),
      created_by_id: userId || null,
    },
  });

  // One job per (campaign, destination): pre-flight snapshot + the scheduled
  // activation instant (resolved against the destination account's timezone).
  for (const cid of camps) {
    for (const d of dests) {
      const row = preview.matrix.find((r) => r.campaignId === cid && r.destinationAccountId === d);
      await prisma.ambCloneJob.create({
        data: {
          batch_id: bid,
          source_ad_account_id: preview.source.id,
          destination_ad_account_id: d,
          destination_account_name: row?.destinationAccountName || null,
          destination_timezone: row?.destinationTimezone || null,
          source_campaign_id: cid,
          source_campaign_name: preview.campaigns.find((c) => c.id === cid)?.name || null,
          destination_page_id: destPage,
          status: row?.status === 'BLOCKED' ? 'PREFLIGHT_BLOCKED' : 'PENDING',
          preflight_status: row?.status || 'READY',
          preflight_json: JSON.stringify(row || {}),
          scheduled_activation_at: row?.scheduledActivationAt ? new Date(row.scheduledActivationAt) : null,
        },
      });
    }
  }

  await audit(bid, null, 'PREFLIGHT', { detail: `دفعة اتجهزت: ${camps.length} حملة × ${dests.length} حساب = ${preview.totalCopies} نسخة (${preview.blockedCopies} محجوبة).`, actorId: userId });
  logger.info('AMB clone batch created', { batchId: bid, copies: preview.totalCopies, blocked: preview.blockedCopies });
  return getBatch(bid);
}

export async function approveBatch({ batchId, userId }) {
  const batch = await prisma.ambCloneBatch.findUnique({ where: { batch_id: batchId } });
  if (!batch) { const e = new Error('الدفعة مش موجودة.'); e.status = 404; throw e; }
  if (batch.status === 'CANCELLED') { const e = new Error('الدفعة ملغاة.'); e.status = 409; throw e; }
  if (!['PENDING_APPROVAL', 'DRAFT'].includes(batch.status)) {
    // Already approved / running — treat approve as "make sure it's progressing".
    if (['APPROVED', 'CLONING'].includes(batch.status)) { kickRun(batchId); return getBatch(batchId); }
    const e = new Error(`الدفعة في حالة ${batch.status} — مش قابلة للموافقة.`); e.status = 409; throw e;
  }
  const settings = await getAmbSettings();
  if (settings.ambExecutionMode === 'ADVISORY') {
    const e = new Error('النظام في وضع "استشاري فقط" — غيّر الوضع من الإعدادات قبل الاستنساخ.'); e.status = 403; throw e;
  }
  await prisma.ambCloneBatch.update({ where: { batch_id: batchId }, data: { status: 'APPROVED', approved_by_id: userId || null, approved_at: new Date() } });
  await audit(batchId, null, 'APPROVAL', { detail: 'تمت الموافقة على الاستنساخ والجدولة.', actorId: userId });
  kickRun(batchId);
  return getBatch(batchId);
}

export async function resumeBatch({ batchId, userId }) {
  const batch = await prisma.ambCloneBatch.findUnique({ where: { batch_id: batchId } });
  if (!batch) { const e = new Error('الدفعة مش موجودة.'); e.status = 404; throw e; }
  if (batch.status === 'CANCELLED') { const e = new Error('الدفعة ملغاة.'); e.status = 409; throw e; }
  if (batch.status === 'COMPLETED') { const e = new Error('الدفعة مكتملة — لا يوجد ما يُستأنف.'); e.status = 409; throw e; }
  // APPROVED / CLONING / PARTIALLY_FAILED / SCHEDULED / FAILED are all
  // resumable — the object map + AmbCloneJob status make it idempotent, so a
  // retry re-attempts only PENDING/FAILED objects and never re-creates a
  // CREATED one.
  await audit(batchId, null, 'RETRY', { detail: 'إعادة تشغيل العناصر الفاشلة/الناقصة.', actorId: userId });
  kickRun(batchId);
  return getBatch(batchId);
}

/** Flip "copy valid ads only" on a pending/decision batch and re-run — copies the copyable ads, skips the rest, and never leaves an empty campaign. */
export async function setBatchCopyValidOnly({ batchId, copyValidAdsOnly = true, userId }) {
  const batch = await prisma.ambCloneBatch.findUnique({ where: { batch_id: batchId } });
  if (!batch) { const e = new Error('الدفعة مش موجودة.'); e.status = 404; throw e; }
  if (['CANCELLED', 'COMPLETED'].includes(batch.status)) { const e = new Error(`الدفعة في حالة ${batch.status}.`); e.status = 409; throw e; }
  const blob = j(batch.identity_map_json, {}) || {};
  blob.copyValidAdsOnly = copyValidAdsOnly === true;
  await prisma.ambCloneBatch.update({ where: { batch_id: batchId }, data: { identity_map_json: JSON.stringify(blob) } });
  // NEEDS_DECISION jobs go back to PENDING so the worker re-evaluates them.
  await prisma.ambCloneJob.updateMany({ where: { batch_id: batchId, status: 'NEEDS_DECISION' }, data: { status: 'PENDING', error: null } });
  await audit(batchId, null, 'RETRY', { detail: `«نسخ الإعلانات الصالحة فقط» = ${blob.copyValidAdsOnly}`, actorId: userId });
  if (copyValidAdsOnly) kickRun(batchId);
  return getBatch(batchId);
}

/**
 * Supply a destination URL for one ad that came back NEEDS_INPUT (its URL
 * couldn't be recovered from any Meta field or the underlying Page post).
 * Stores it in identity_map_json.adUrlOverrides, resets that ad's + its
 * creative's NEEDS_INPUT object rows to PENDING, and (optionally) re-runs so
 * the creative + ad are created. Reuses the existing Campaign / Ad Set.
 */
export async function setBatchAdUrl({ batchId, sourceAdId, url, resume = true, userId }) {
  const batch = await prisma.ambCloneBatch.findUnique({ where: { batch_id: batchId } });
  if (!batch) { const e = new Error('الدفعة مش موجودة.'); e.status = 404; throw e; }
  if (['CANCELLED', 'COMPLETED'].includes(batch.status)) { const e = new Error(`الدفعة في حالة ${batch.status}.`); e.status = 409; throw e; }
  const u = String(url || '').trim();
  if (!/^https?:\/\/.+/i.test(u)) { const e = new Error('رابط غير صالح — لازم يبدأ بـ http(s)://'); e.status = 400; throw e; }
  const sid = String(sourceAdId || '');
  if (!sid) { const e = new Error('sourceAdId مطلوب.'); e.status = 400; throw e; }

  const blob = j(batch.identity_map_json, {}) || {};
  blob.adUrlOverrides = { ...(blob.adUrlOverrides || {}), [sid]: u };
  await prisma.ambCloneBatch.update({ where: { batch_id: batchId }, data: { identity_map_json: JSON.stringify(blob) } });

  // Reset the NEEDS_INPUT rows for that ad (and its creative — parent_source_id = ad id) so resume retries them.
  await prisma.ambCloneObjectMap.updateMany({
    where: { batch_id: batchId, status: 'NEEDS_INPUT', OR: [{ level: 'AD', source_id: sid }, { level: 'CREATIVE', parent_source_id: sid }] },
    data: { status: 'PENDING', error: null },
  });
  await prisma.ambCloneJob.updateMany({ where: { batch_id: batchId, status: 'NEEDS_INPUT' }, data: { status: 'PENDING', error: null } });
  await audit(batchId, null, 'AD_URL_SET', { detail: `رابط الوجهة للإعلان ${sid}: ${u}`, actorId: userId, source_id: sid });
  if (resume) kickRun(batchId);
  return getBatch(batchId);
}

export async function cancelBatch({ batchId, userId }) {
  const batch = await prisma.ambCloneBatch.findUnique({ where: { batch_id: batchId }, include: { jobs: true } });
  if (!batch) { const e = new Error('الدفعة مش موجودة.'); e.status = 404; throw e; }
  if (['COMPLETED', 'CANCELLED'].includes(batch.status)) return getBatch(batchId);
  // Cancel scheduling for anything not already ACTIVATED. Already-cloned
  // campaigns stay in the destination account as PAUSED (harmless) — we just
  // guarantee the scheduler never activates them.
  await prisma.ambCloneJob.updateMany({
    where: { batch_id: batchId, status: { notIn: ['ACTIVATED'] } },
    data: { status: 'CANCELLED' },
  });
  await prisma.ambCloneBatch.update({ where: { batch_id: batchId }, data: { status: 'CANCELLED' } });
  const nSched = await cancelSchedulesForBatch(batchId, userId).catch(() => 0);
  await audit(batchId, null, 'CANCELLED', { detail: `أُلغيت الدفعة — النسخ المُنشأة تبقى متوقفة (PAUSED) ولن تُفعَّل.${nSched ? ` أُلغيت ${nSched} جدولة مرتبطة.` : ''}`, actorId: userId });
  return getBatch(batchId);
}

// ---------------------------------------------------------------------------
// The clone worker
// ---------------------------------------------------------------------------
function kickRun(batchId) {
  if (running.has(batchId)) return;
  running.add(batchId);
  setImmediate(async () => {
    try { await runBatch(batchId); }
    catch (err) { logger.error('AMB clone runBatch crashed', { batchId, message: err.message }); }
    finally { running.delete(batchId); }
  });
}

async function runBatch(batchId) {
  const batch = await prisma.ambCloneBatch.findUnique({ where: { batch_id: batchId }, include: { jobs: true } });
  if (!batch || batch.status === 'CANCELLED') return;
  const connection = await getConnection();
  if (!connection || connection.status !== 'CONNECTED') {
    await prisma.ambCloneBatch.update({ where: { batch_id: batchId }, data: { status: 'FAILED', error: 'مفيش اتصال Meta Ads.' } });
    return;
  }
  await prisma.ambCloneBatch.update({ where: { batch_id: batchId }, data: { status: 'CLONING' } });
  const token = await getDecryptedToken();

  const jobs = batch.jobs.filter((jb) => !TERMINAL_JOB.has(jb.status) && jb.preflight_status !== 'BLOCKED' && !['PREFLIGHT_BLOCKED', 'CANNOT_COPY'].includes(jb.status));
  for (const job of jobs) {
    if (['CLONED_PAUSED', 'ACTIVATION_PENDING'].includes(job.status)) continue; // done cloning, waiting for schedule
    try {
      await cloneJob(job.id, token);
    } catch (err) {
      logger.error('AMB clone job failed hard', { jobId: job.id, message: err.message });
      await prisma.ambCloneJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: (err.message || String(err)).slice(0, 800) } });
      await audit(batchId, job.id, 'JOB_FAILED', { detail: err.message });
    }
  }

  await recomputeBatchStatus(batchId);
}

async function recomputeBatchStatus(batchId) {
  const jobs = await prisma.ambCloneJob.findMany({ where: { batch_id: batchId } });
  const relevant = jobs.filter((jb) => !['CANCELLED', 'PREFLIGHT_BLOCKED', 'CANNOT_COPY', 'NEEDS_DECISION', 'NEEDS_INPUT'].includes(jb.status) && jb.preflight_status !== 'BLOCKED');
  const failed = relevant.filter((jb) => jb.status === 'FAILED' || jb.status === 'ACTIVATION_FAILED');
  const cloned = relevant.filter((jb) => ['CLONED_PAUSED', 'ACTIVATION_PENDING', 'ACTIVATED'].includes(jb.status));
  const activated = relevant.filter((jb) => jb.status === 'ACTIVATED');
  const needsDecision = jobs.some((jb) => jb.status === 'NEEDS_DECISION');
  const needsInput = jobs.some((jb) => jb.status === 'NEEDS_INPUT');
  let status;
  if (!relevant.length) status = needsInput ? 'NEEDS_INPUT' : needsDecision ? 'NEEDS_DECISION' : 'FAILED';
  else if (activated.length === relevant.length) status = 'COMPLETED';
  else if (failed.length && cloned.length) status = 'PARTIALLY_FAILED';
  else if (failed.length && !cloned.length) status = 'FAILED';
  else if ((needsDecision || needsInput) && cloned.length) status = 'PARTIALLY_FAILED';
  else if (needsInput) status = 'NEEDS_INPUT';
  else status = 'SCHEDULED'; // everything copyable is copied & PAUSED
  await prisma.ambCloneBatch.update({ where: { batch_id: batchId }, data: { status } });
}

/** Find (or create) the object-map row for a given source object, honouring the resume rule. */
async function objRow(jobId, batchId, level, sourceId, extra = {}) {
  const found = await prisma.ambCloneObjectMap.findUnique({ where: { job_id_level_source_id: { job_id: jobId, level, source_id: String(sourceId) } } });
  if (found) return found;
  return prisma.ambCloneObjectMap.create({ data: { job_id: jobId, batch_id: batchId, level, source_id: String(sourceId), ...extra } });
}
async function markObj(id, data) { return prisma.ambCloneObjectMap.update({ where: { id }, data }); }

async function cloneJob(jobId, token) {
  const job = await prisma.ambCloneJob.findUnique({ where: { id: jobId }, include: { batch: true } });
  if (!job || TERMINAL_JOB.has(job.status) || job.status === 'PREFLIGHT_BLOCKED') return;
  const batchId = job.batch_id;
  const dest = job.destination_ad_account_id;
  const src = job.source_ad_account_id;
  if (dest === src) throw new Error('حساب الوجهة لا يمكن أن يكون نفس المصدر.'); // hard guard — never write to source
  const destPageId = job.destination_page_id || job.batch?.destination_page_id || null;
  const destIgId = job.batch?.destination_instagram_id || null;
  const identityMap = j(job.batch?.identity_map_json, {}) || {};
  const pixelMap = j(job.batch?.pixel_map_json, {}) || {};
  const allowPageOnlyIg = identityMap.allowPageOnlyIg !== false;
  const recreateBoosted = !!job.batch?.recreate_boosted;

  await prisma.ambCloneJob.update({ where: { id: jobId }, data: { status: 'CLONING', attempts: { increment: 1 }, last_attempt_at: new Date(), error: null } });
  await audit(batchId, jobId, 'CLONE_START', { detail: `${job.source_campaign_name || job.source_campaign_id} → ${job.destination_account_name || dest}` });

  // Fresh pre-flight at clone time (state may have moved since REVIEW). This
  // also produces the `resolved` asset map — audience id remap + the source
  // image/video URLs needed for re-upload.
  const pf = j(job.preflight_json, {}) || {};
  const tree = await readCampaignTree(token, job.source_campaign_id);
  const sourceAssets = await resolveSourceAssets(token, src, tree);
  const destAssets = await getAccountAssetsForClone(token, dest);
  const libHints = new Map();
  for (const [crId, crNode] of tree.creatives) {
    if (!crNode || crNode.__error) continue;
    libHints.set(crId, await libraryDestHints(crNode, dest).catch(() => ({ reuseImageHashes: new Set(), videoBySrc: new Map(), assetId: null })));
  }
  const freshPf = preflightCampaignForDestination({ tree, sourceAssets, destAssets, libraryHintsByCreative: libHints, pageIdOverride: destPageId, recreateBoosted });
  if (freshPf.status === 'BLOCKED') {
    await prisma.ambCloneJob.update({ where: { id: jobId }, data: { status: 'PREFLIGHT_BLOCKED', preflight_status: 'BLOCKED', preflight_json: JSON.stringify({ ...pf, checks: freshPf.checks }), error: 'محجوب في إعادة فحص ما قبل الاستنساخ.' } });
    await audit(batchId, jobId, 'JOB_FAILED', { detail: 'إعادة فحص ما قبل الاستنساخ رجعت BLOCKED: ' + (freshPf.checks.find((c) => c.status === 'BLOCK')?.detail || '') });
    return;
  }
  const R = freshPf.resolved;

  // ---- EMPTY-CAMPAIGN GUARD ----
  // Never create a destination Campaign/AdSet and then find its ads can't be
  // copied. Classify every ad first; if none can be copied, write NOTHING.
  const copyValidAdsOnly = identityMap.copyValidAdsOnly === true;
  const adOk = new Map();
  for (const ad of tree.ads) {
    const cr = ad.creative?.id ? tree.creatives.get(ad.creative.id) : null;
    adOk.set(ad.id, adCopyable(cr, { destPageId, identityMap }));
  }
  const copyableAdIds = tree.ads.filter((ad) => adOk.get(ad.id)).map((ad) => ad.id);
  if (copyableAdIds.length === 0) {
    await prisma.ambCloneJob.update({ where: { id: jobId }, data: { status: 'CANNOT_COPY', error: 'مافيش أي إعلان قابل للنسخ في هذه الحملة — لم يُنشأ أي كائن في الحساب الوجهة.' } });
    await audit(batchId, jobId, 'JOB_FAILED', { detail: 'CANNOT_COPY: 0 إعلان قابل للنسخ — لم يُكتب أي شيء على Meta.' });
    return;
  }
  if (copyableAdIds.length < tree.ads.length && !copyValidAdsOnly) {
    await prisma.ambCloneJob.update({ where: { id: jobId }, data: { status: 'NEEDS_DECISION', error: `${tree.ads.length - copyableAdIds.length} إعلان مش قابل للنسخ. فعّل «نسخ الإعلانات الصالحة فقط» أو ألغِ — لم يُكتب أي شيء على Meta.` } });
    await audit(batchId, jobId, 'JOB_FAILED', { detail: `NEEDS_DECISION: ${copyableAdIds.length}/${tree.ads.length} قابل للنسخ — في انتظار قرارك.` });
    return;
  }
  // From here on the engine only builds the copyable ads (and skips ad sets
  // that would end up empty).
  const copyable = new Set(copyableAdIds);
  tree.ads = tree.ads.filter((ad) => copyable.has(ad.id));
  const keptAdsetIds = new Set(tree.ads.map((ad) => ad.adset_id));
  tree.adsets = tree.adsets.filter((as) => keptAdsetIds.has(as.id));

  const counts = { adsets: 0, ads: 0, creatives: 0 };
  const idMap = { campaigns: {}, adsets: {}, ads: {}, creatives: {}, images: {}, videos: {} };

  // ---- 1) Campaign shell (PAUSED) ----
  let newCampaignId;
  {
    const row = await objRow(jobId, batchId, 'CAMPAIGN', job.source_campaign_id, { source_name: tree.campaign?.name, parent_source_id: null });
    if (row.status === 'CREATED' && row.destination_id) {
      newCampaignId = row.destination_id;
    } else {
      const c = tree.campaign;
      // Meta deprecated "NONE": the "no special category" value is an EMPTY
      // ARRAY. The param is still required on campaign create.
      const srcSac = Array.isArray(c.special_ad_categories) ? c.special_ad_categories.filter((x) => x && x !== 'NONE') : [];
      const payload = {
        name: c.name,
        objective: c.objective,
        status: 'PAUSED',
        buying_type: c.buying_type || 'AUCTION',
        special_ad_categories: srcSac,
      };
      if (c.special_ad_category_country) payload.special_ad_category_country = c.special_ad_category_country;
      if (c.bid_strategy) payload.bid_strategy = c.bid_strategy;
      if (c.daily_budget) payload.daily_budget = Number(c.daily_budget);
      if (c.lifetime_budget) payload.lifetime_budget = Number(c.lifetime_budget);
      if (c.spend_cap && Number(c.spend_cap) > 0) payload.spend_cap = Number(c.spend_cap);
      if (c.pacing_type) payload.pacing_type = c.pacing_type;
      // ABO campaigns (no campaign-level budget): Meta requires this field
      // explicitly on create. Copy the source value; default false (standard
      // ABO — no cross-ad-set budget sharing).
      const cboBudget = !!(c.daily_budget || c.lifetime_budget);
      if (!cboBudget) payload.is_adset_budget_sharing_enabled = c.is_adset_budget_sharing_enabled === true;
      try {
        const res = await createCampaign(token, dest, payload);
        newCampaignId = res.id;
        await markObj(row.id, { status: 'CREATED', destination_id: newCampaignId, payload_json: JSON.stringify(payload) });
        await audit(batchId, jobId, 'OBJECT_CREATED', { level: 'CAMPAIGN', source_id: job.source_campaign_id, destination_id: newCampaignId });
      } catch (err) {
        await markObj(row.id, { status: 'FAILED', error: metaErr(err).slice(0, 500), payload_json: JSON.stringify(payload) });
        await audit(batchId, jobId, 'OBJECT_FAILED', { level: 'CAMPAIGN', source_id: job.source_campaign_id, detail: metaErr(err), data: metaErrData(err) });
        await prisma.ambCloneJob.update({ where: { id: jobId }, data: { status: 'FAILED', error: `فشل إنشاء الحملة: ${metaErr(err)}`.slice(0, 800) } });
        return; // no campaign ⇒ nothing else can be created
      }
    }
    idMap.campaigns[job.source_campaign_id] = newCampaignId;
    await prisma.ambCloneJob.update({ where: { id: jobId }, data: { destination_campaign_id: newCampaignId } });
  }

  // ---- destination-asset resolver (cached per job), reuse-first ----
  // Order (spec Phase 2): 1) an asset already in the destination (Media
  // Library dest ref) → no work; 2) a SHARED Meta asset referenced directly
  // (same image hash / same video_id — works across a Business Portfolio) →
  // provisional, confirmed when the creative create succeeds; 3) re-upload the
  // original; 4) only then the object FAILS. `assetTrace` records every
  // strategy tried per source id for the debug report.
  const assetTrace = { images: {}, videos: {} };
  async function destImageHash(srcHash, hints, { forceReupload } = {}) {
    if (!srcHash) return null;
    if (idMap.images[srcHash]) return idMap.images[srcHash];
    const tr = (assetTrace.images[srcHash] = assetTrace.images[srcHash] || { tried: [] });
    const row = await objRow(jobId, batchId, 'IMAGE', srcHash);
    if (row.status === 'CREATED' && row.destination_id) { idMap.images[srcHash] = row.destination_id; return row.destination_id; }
    if (!forceReupload) {
      // 1) already in the destination (library ref)
      if (hints?.reuseImageHashes?.has(srcHash)) {
        tr.tried.push('DEST_LIBRARY_REF'); tr.strategy = 'DEST_LIBRARY_REF';
        idMap.images[srcHash] = srcHash;
        await markObj(row.id, { status: 'CREATED', destination_id: srcHash, payload_json: JSON.stringify({ strategy: 'DEST_LIBRARY_REF' }) });
        await audit(batchId, jobId, 'OBJECT_CREATED', { level: 'IMAGE', source_id: srcHash, destination_id: srcHash, detail: 'الصورة متاحة بالفعل في الحساب الوجهة (المكتبة)' });
        return srcHash;
      }
      // 2) shared reference — image_hash is content-derived, so the source hash
      //    is valid in the destination if the bytes ever landed there. Provisional.
      tr.tried.push('SHARED_HASH'); tr.strategy = 'SHARED_HASH';
      await markObj(row.id, { status: 'PENDING', payload_json: JSON.stringify({ strategy: 'SHARED_HASH', provisional: true }) });
      idMap.images[srcHash] = srcHash;
      return srcHash;
    }
    // 3) re-upload
    tr.tried.push('REUPLOAD');
    const url = R.imageUrls[srcHash];
    if (!url) {
      tr.strategy = 'FAILED';
      await markObj(row.id, { status: 'FAILED', error: 'كل طرق إعادة الاستخدام فشلت ولا يوجد ملف/رابط مصدر لإعادة رفع الصورة.' });
      throw new Error(`صورة (${srcHash.slice(0, 12)}…) — تعذّرت إعادة الاستخدام وإعادة الرفع`);
    }
    const up = await uploadAdImageFromUrl(token, dest, url);
    tr.strategy = 'REUPLOAD';
    idMap.images[srcHash] = up.hash;
    await markObj(row.id, { status: 'CREATED', destination_id: up.hash, payload_json: JSON.stringify({ strategy: 'REUPLOAD', from: url }) });
    await audit(batchId, jobId, 'OBJECT_CREATED', { level: 'IMAGE', source_id: srcHash, destination_id: up.hash, detail: 'إعادة رفع الصورة الأصلية' });
    return up.hash;
  }
  async function destVideoId(srcId, hints, { forceReupload } = {}) {
    if (!srcId) return null;
    srcId = String(srcId);
    if (idMap.videos[srcId]) return idMap.videos[srcId];
    const tr = (assetTrace.videos[srcId] = assetTrace.videos[srcId] || { tried: [], libraryAssetId: hints?.assetId || null, knownDestVideoIds: hints?.videoBySrc ? [...hints.videoBySrc.values()] : [] });
    const row = await objRow(jobId, batchId, 'VIDEO', srcId);
    if (row.status === 'CREATED' && row.destination_id) { idMap.videos[srcId] = row.destination_id; return row.destination_id; }
    if (!forceReupload) {
      // 1) a copy already in the destination (Media Library dest ref)
      const reuse = hints?.videoBySrc?.get(srcId);
      if (reuse) {
        tr.tried.push('DEST_LIBRARY_REF'); tr.strategy = 'DEST_LIBRARY_REF';
        idMap.videos[srcId] = reuse;
        await markObj(row.id, { status: 'CREATED', destination_id: reuse, payload_json: JSON.stringify({ strategy: 'DEST_LIBRARY_REF' }) });
        await audit(batchId, jobId, 'OBJECT_CREATED', { level: 'VIDEO', source_id: srcId, destination_id: reuse, detail: 'فيديو له نسخة بالفعل في الحساب الوجهة (المكتبة)' });
        return reuse;
      }
      // 2) shared reference — try the SOURCE video_id directly (Page-owned /
      //    Business-Portfolio-shared videos are usable across accounts).
      //    Provisional: confirmed only if the creative create accepts it.
      tr.tried.push('SHARED_REFERENCE'); tr.strategy = 'SHARED_REFERENCE';
      await markObj(row.id, { status: 'PENDING', payload_json: JSON.stringify({ strategy: 'SHARED_REFERENCE', tried: 'source_video_id', provisional: true }) });
      idMap.videos[srcId] = srcId;
      return srcId;
    }
    // 3) re-upload from a real source file
    tr.tried.push('REUPLOAD');
    const url = R.videoSources[srcId];
    if (!url) {
      tr.strategy = 'FAILED';
      await markObj(row.id, { status: 'FAILED', error: metaTrace(tr, 'كل طرق إعادة الاستخدام فشلت (نسخة بالوجهة / مرجع مشترك / المكتبة) ولا يوجد ملف مصدر لإعادة الرفع.') });
      throw new Error(`فيديو (${srcId}) — تعذّرت كل طرق إعادة الاستخدام وإعادة الرفع`);
    }
    const up = await uploadAdVideoFromUrl(token, dest, url, `clone-${srcId}`);
    tr.strategy = 'REUPLOAD';
    idMap.videos[srcId] = up.id;
    await markObj(row.id, { status: 'CREATED', destination_id: up.id, payload_json: JSON.stringify({ strategy: 'REUPLOAD', from: url }) });
    await audit(batchId, jobId, 'OBJECT_CREATED', { level: 'VIDEO', source_id: srcId, destination_id: up.id, detail: 'إعادة رفع الفيديو الأصلي' });
    return up.id;
  }
  function metaTrace(tr, msg) { return `${msg} [tried=${(tr.tried || []).join('>')}]`; }
  /** Confirm every still-provisional shared reference as CREATED once the creative it feeds has been accepted by Meta. */
  async function confirmProvisionalAssets() {
    for (const [s, d] of Object.entries(idMap.images)) {
      if (String(s) !== String(d)) continue;
      const r = await objRow(jobId, batchId, 'IMAGE', s);
      if (r.status !== 'CREATED') { await markObj(r.id, { status: 'CREATED', destination_id: s, payload_json: JSON.stringify({ strategy: 'SHARED_HASH' }) }); await audit(batchId, jobId, 'OBJECT_CREATED', { level: 'IMAGE', source_id: s, destination_id: s, detail: 'مرجع مشترك — نفس image_hash' }); }
    }
    for (const [s, d] of Object.entries(idMap.videos)) {
      if (String(s) !== String(d)) continue;
      const r = await objRow(jobId, batchId, 'VIDEO', s);
      if (r.status !== 'CREATED') { await markObj(r.id, { status: 'CREATED', destination_id: s, payload_json: JSON.stringify({ strategy: 'SHARED_REFERENCE' }) }); await audit(batchId, jobId, 'OBJECT_CREATED', { level: 'VIDEO', source_id: s, destination_id: s, detail: 'مرجع مشترك — نفس video_id عبر Business Portfolio' }); }
    }
  }
  /** Drop the job cache + reset object rows for the still-provisional shared references (so a forced re-upload runs). */
  async function dropProvisionalAssets() {
    const dropped = { images: [], videos: [] };
    for (const [s, d] of Object.entries(idMap.images)) if (String(s) === String(d)) { dropped.images.push(s); delete idMap.images[s]; const r = await objRow(jobId, batchId, 'IMAGE', s); await markObj(r.id, { status: 'PENDING', error: null }); }
    for (const [s, d] of Object.entries(idMap.videos)) if (String(s) === String(d)) { dropped.videos.push(s); delete idMap.videos[s]; const r = await objRow(jobId, batchId, 'VIDEO', s); await markObj(r.id, { status: 'PENDING', error: null }); }
    return dropped;
  }

  // ---- 2) Ad sets ----
  const adsBySource = new Map();
  for (const ad of tree.ads) {
    if (!adsBySource.has(ad.adset_id)) adsBySource.set(ad.adset_id, []);
    adsBySource.get(ad.adset_id).push(ad);
  }
  const campaignHasBudget = !!(tree.campaign.daily_budget || tree.campaign.lifetime_budget);

  for (const as of tree.adsets) {
    let newAdsetId;
    const row = await objRow(jobId, batchId, 'ADSET', as.id, { source_name: as.name, parent_source_id: job.source_campaign_id });
    if (row.status === 'CREATED' && row.destination_id) {
      newAdsetId = row.destination_id;
      idMap.adsets[as.id] = newAdsetId;
    } else {
      try {
        const payload = buildAdSetPayload(as, { newCampaignId, campaignHasBudget, resolved: R, pixelMap });
        const res = await createAdSet(token, dest, payload);
        newAdsetId = res.id;
        idMap.adsets[as.id] = newAdsetId;
        counts.adsets++;
        await markObj(row.id, { status: 'CREATED', destination_id: newAdsetId, payload_json: JSON.stringify(payload).slice(0, 6000) });
        await audit(batchId, jobId, 'OBJECT_CREATED', { level: 'ADSET', source_id: as.id, destination_id: newAdsetId });
      } catch (err) {
        await markObj(row.id, { status: 'FAILED', error: metaErr(err).slice(0, 500) });
        await audit(batchId, jobId, 'OBJECT_FAILED', { level: 'ADSET', source_id: as.id, detail: metaErr(err), data: metaErrData(err) });
        continue; // skip this ad set's ads; other ad sets still try
      }
    }

    // ---- 3) Creatives + Ads under this ad set ----
    const adUrlOverrides = (identityMap && identityMap.adUrlOverrides) || {};
    for (const ad of adsBySource.get(as.id) || []) {
      const srcCreative = ad.creative?.id ? tree.creatives.get(ad.creative.id) : null;
      const adUrlOverride = adUrlOverrides[String(ad.id)] || null;
      let newCreativeId = null;
      let creativeNeedsInput = false;
      if (srcCreative && !srcCreative.__error) {
        const crow = await objRow(jobId, batchId, 'CREATIVE', srcCreative.id, { source_name: srcCreative.name, parent_source_id: ad.id });
        if (crow.status === 'CREATED' && crow.destination_id) {
          newCreativeId = crow.destination_id;
          idMap.creatives[srcCreative.id] = newCreativeId;
        } else {
          // Media Library: what does the destination account already have for this asset?
          const hints = await libraryDestHints(srcCreative, dest).catch(() => null);
          let payload = null; let res = null; let finalErr = null;
          try {
            payload = await buildCreativePayload(srcCreative, { destImageHash, destVideoId, hints, pageId: destPageId, igId: destIgId, identityMap, allowPageOnlyIg, recreateBoosted, adUrlOverride });
            res = await createAdCreative(token, dest, payload);
          } catch (err1) {
            const provisionalV = Object.entries(idMap.videos).filter(([s, d]) => String(s) === String(d)).map(([s]) => s);
            const provisionalI = Object.entries(idMap.images).filter(([s, d]) => String(s) === String(d)).map(([s]) => s);
            const stubAfs = payload && payload.asset_feed_spec && payload.object_story_spec && isStubAssetFeedSpec(payload.asset_feed_spec);
            if (isAssetRefError(err1) && (provisionalV.length || provisionalI.length)) {
              // A shared reference (same image_hash / video_id) was rejected —
              // re-upload exactly those assets and retry once.
              await audit(batchId, jobId, 'RETRY', { level: 'CREATIVE', source_id: srcCreative.id, detail: `المرجع المشترك اترفض (${metaErr(err1)}) — إعادة رفع ${provisionalV.length} فيديو / ${provisionalI.length} صورة`, data: { metaError: metaErrData(err1), provisionalVideos: provisionalV, provisionalImages: provisionalI } });
              await dropProvisionalAssets();
              try {
                payload = await buildCreativePayload(srcCreative, {
                  destImageHash: (h, hh, o) => destImageHash(h, hh, { ...o, forceReupload: true }),
                  destVideoId: (v, hh, o) => destVideoId(v, hh, { ...o, forceReupload: true }),
                  hints, pageId: destPageId, igId: destIgId, identityMap, allowPageOnlyIg, recreateBoosted, adUrlOverride,
                });
                res = await createAdCreative(token, dest, payload);
              } catch (err2) { finalErr = err2; }
            } else if (stubAfs) {
              // Meta rejected a full object_story_spec + a content-less
              // asset_feed_spec stub together — retry with the stub dropped.
              // (message_extensions is a Messenger-destination toggle, not
              // conversion/CTA/media — safe to omit; recorded, not silent.)
              await audit(batchId, jobId, 'RETRY', { level: 'CREATIVE', source_id: srcCreative.id, detail: `فشل مع asset_feed_spec مختصر (${metaErr(err1)}) — إعادة المحاولة بدونه`, data: { metaError: metaErrData(err1), droppedAssetFeedSpec: payload.asset_feed_spec } });
              const p2 = { ...payload }; delete p2.asset_feed_spec;
              try { res = await createAdCreative(token, dest, p2); payload = p2; }
              catch (err2) { finalErr = err2; }
            } else {
              finalErr = err1;
            }
          }

          if (res && !finalErr) {
            newCreativeId = res.id;
            idMap.creatives[srcCreative.id] = newCreativeId;
            counts.creatives++;
            await confirmProvisionalAssets();
            await markObj(crow.id, { status: 'CREATED', destination_id: newCreativeId, payload_json: JSON.stringify(payload).slice(0, 6000) });
            await audit(batchId, jobId, 'OBJECT_CREATED', { level: 'CREATIVE', source_id: srcCreative.id, destination_id: newCreativeId, data: { assetTrace } });
            const used = collectAssetIds(payload);
            registerClonedCreativeRef({ srcNode: srcCreative, destAccountId: dest, destCreativeId: newCreativeId, destImageHashes: used.imageHashes, destVideoIds: used.videoIds, cloneJobId: jobId }).catch(() => {});
          } else if (finalErr?.needsUserInput) {
            // The ONE ad needs a destination URL we couldn't recover from any
            // Meta field or the underlying Page post. Isolate it — do NOT fail
            // the campaign / ad set / other ads.
            creativeNeedsInput = true;
            await markObj(crow.id, { status: 'NEEDS_INPUT', error: (finalErr.message || '').slice(0, 400) });
            await audit(batchId, jobId, 'OBJECT_NEEDS_INPUT', { level: 'CREATIVE', source_id: srcCreative.id, detail: finalErr.message, data: { sourceAdId: ad.id } });
          } else {
            // Every reuse + re-upload path failed — record the EXACT Meta error
            // + the full attempt chain (Phase 4 debug requirement).
            const detail = metaErr(finalErr);
            const vFirst = Object.keys(assetTrace.videos)[0];
            await markObj(crow.id, { status: 'FAILED', error: detail.slice(0, 500) });
            await audit(batchId, jobId, 'OBJECT_FAILED', {
              level: 'CREATIVE', source_id: srcCreative.id, detail,
              data: {
                sourceCreativeId: srcCreative.id,
                destinationAccount: dest,
                libraryAssetId: hints?.assetId || null,
                assetTrace,
                sourceVideoIds: Object.keys(assetTrace.videos),
                sourceVideoId: vFirst || null,
                knownDestVideoIds: hints?.videoBySrc ? [...hints.videoBySrc.values()] : [],
                triedSharedReference: Object.values(assetTrace.videos).some((t) => (t.tried || []).includes('SHARED_REFERENCE')) || Object.values(assetTrace.images).some((t) => (t.tried || []).includes('SHARED_HASH')),
                triedLibraryReuse: Object.values(assetTrace.videos).some((t) => (t.tried || []).includes('DEST_LIBRARY_REF')) || Object.values(assetTrace.images).some((t) => (t.tried || []).includes('DEST_LIBRARY_REF')),
                triedReupload: Object.values(assetTrace.videos).some((t) => (t.tried || []).includes('REUPLOAD')) || Object.values(assetTrace.images).some((t) => (t.tried || []).includes('REUPLOAD')),
                metaError: metaErrData(finalErr),
              },
            });
          }
        }
      }

      const arow = await objRow(jobId, batchId, 'AD', ad.id, { source_name: ad.name, parent_source_id: as.id });
      if (arow.status === 'CREATED') continue;
      if (!newCreativeId) {
        if (creativeNeedsInput) {
          await markObj(arow.id, { status: 'NEEDS_INPUT', error: 'هذا الإعلان يحتاج رابط وجهة — أدخِله ثم استأنف. باقي الحملة تم نسخه.' });
          await audit(batchId, jobId, 'OBJECT_NEEDS_INPUT', { level: 'AD', source_id: ad.id, detail: 'destination URL required' });
        } else {
          await markObj(arow.id, { status: 'FAILED', error: 'لا يوجد كرياتيف صالح للإعلان.' });
          await audit(batchId, jobId, 'OBJECT_FAILED', { level: 'AD', source_id: ad.id, detail: 'creative missing' });
        }
        continue;
      }
      try {
        const payload = { name: ad.name, adset_id: newAdsetId, creative: { creative_id: newCreativeId }, status: 'PAUSED' };
        if (ad.tracking_specs) payload.tracking_specs = ad.tracking_specs;
        if (ad.conversion_domain) payload.conversion_domain = ad.conversion_domain;
        const res = await createAd(token, dest, payload);
        idMap.ads[ad.id] = res.id;
        counts.ads++;
        await markObj(arow.id, { status: 'CREATED', destination_id: res.id, payload_json: JSON.stringify(payload).slice(0, 4000) });
        await audit(batchId, jobId, 'OBJECT_CREATED', { level: 'AD', source_id: ad.id, destination_id: res.id });
      } catch (err) {
        await markObj(arow.id, { status: 'FAILED', error: metaErr(err).slice(0, 500) });
        await audit(batchId, jobId, 'OBJECT_FAILED', { level: 'AD', source_id: ad.id, detail: metaErr(err), data: metaErrData(err) });
      }
    }
  }

  // ---- job verdict ----
  const objs = await prisma.ambCloneObjectMap.findMany({ where: { job_id: jobId } });
  const anyFail = objs.some((o) => o.status === 'FAILED');
  const expectedAdsets = tree.adsets.length;
  const madeAdsets = objs.filter((o) => o.level === 'ADSET' && o.status === 'CREATED').length;
  const expectedAds = tree.ads.length;
  const madeAds = objs.filter((o) => o.level === 'AD' && o.status === 'CREATED').length;
  const needsInputAds = objs.filter((o) => o.level === 'AD' && o.status === 'NEEDS_INPUT').length;
  // NEEDS_INPUT ads are neither made nor failed — the campaign + ad sets + the
  // other ads are done; only those ads await a URL.
  const structureOk = madeAdsets >= expectedAdsets && (madeAds + needsInputAds) >= expectedAds && !anyFail;
  const complete = structureOk && needsInputAds === 0;
  const status = complete ? 'CLONED_PAUSED' : structureOk ? 'NEEDS_INPUT' : 'FAILED';

  await prisma.ambCloneJob.update({
    where: { id: jobId },
    data: {
      status,
      id_map_json: JSON.stringify(idMap),
      copies_created_json: JSON.stringify(counts),
      error: complete ? null
        : structureOk ? `تم نسخ الحملة والمجموعات و${madeAds}/${expectedAds} إعلان. ${needsInputAds} إعلان يحتاج رابط وجهة — أدخِله ثم استأنف.`
        : `اكتمل جزئيًا: ${madeAdsets}/${expectedAdsets} مجموعات، ${madeAds}/${expectedAds} إعلانات.`,
    },
  });
  await audit(batchId, jobId, complete ? 'JOB_DONE' : structureOk ? 'JOB_NEEDS_INPUT' : 'JOB_FAILED', {
    detail: complete
      ? `تم إنشاء الحملة كاملة (PAUSED): ${counts.adsets} مجموعة، ${counts.ads} إعلان.`
      : structureOk
        ? `تم نسخ الحملة + المجموعات + ${madeAds}/${expectedAds} إعلان (PAUSED). ${needsInputAds} إعلان بانتظار رابط الوجهة.`
        : `اكتمل جزئيًا — قابل للاستئناف.`,
    data: { counts, idMap, needsInputAds },
  });
}

// ---- payload builders ----
function deepClone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

function transformTargeting(targeting, resolved) {
  const t = deepClone(targeting) || {};
  const remap = resolved?.audienceRemap || {};
  const fix = (arr) => (arr || []).map((a) => (a && a.id != null ? { id: String(remap[a.id] || a.id) } : a)).filter(Boolean);
  if (t.custom_audiences) t.custom_audiences = fix(t.custom_audiences);
  if (t.excluded_custom_audiences) t.excluded_custom_audiences = fix(t.excluded_custom_audiences);
  // Meta rejects these read-only/annotation fields on create.
  delete t.targeting_optimization_types;
  return t;
}

function buildAdSetPayload(as, { newCampaignId, campaignHasBudget, resolved, pixelMap = {} }) {
  const payload = {
    name: as.name,
    campaign_id: newCampaignId,
    status: 'PAUSED',
    billing_event: as.billing_event,
    optimization_goal: as.optimization_goal,
    targeting: transformTargeting(as.targeting, resolved),
  };
  if (as.bid_amount != null && Number(as.bid_amount) > 0) payload.bid_amount = Number(as.bid_amount);
  if (as.bid_strategy) payload.bid_strategy = as.bid_strategy;
  if (!campaignHasBudget) {
    if (as.daily_budget) payload.daily_budget = Number(as.daily_budget);
    else if (as.lifetime_budget) payload.lifetime_budget = Number(as.lifetime_budget);
  }
  if (as.promoted_object) {
    // Remap the source Pixel/Dataset id to one the destination account can
    // actually use, when a mapping was supplied. Never copy an inaccessible id
    // blindly — but if there's no map entry we keep the source id (the create
    // fails loudly if it's inaccessible, per "never silently drop").
    const po = { ...as.promoted_object };
    if (po.pixel_id && pixelMap[String(po.pixel_id)]) po.pixel_id = String(pixelMap[String(po.pixel_id)]);
    if (po.product_catalog_id && pixelMap[String(po.product_catalog_id)]) po.product_catalog_id = String(pixelMap[String(po.product_catalog_id)]);
    payload.promoted_object = po;
  }
  if (as.attribution_spec) payload.attribution_spec = as.attribution_spec;
  if (as.destination_type) payload.destination_type = as.destination_type;
  if (as.pacing_type) payload.pacing_type = as.pacing_type;
  if (as.is_dynamic_creative) payload.is_dynamic_creative = true;
  if (as.use_new_app_click != null) payload.use_new_app_click = as.use_new_app_click;
  if (as.dsa_beneficiary) payload.dsa_beneficiary = as.dsa_beneficiary;
  if (as.dsa_payor) payload.dsa_payor = as.dsa_payor;
  if (as.frequency_control_specs) payload.frequency_control_specs = as.frequency_control_specs;

  // Time: only keep a start/end that is still in the future. A lifetime-budget
  // ad set REQUIRES an end_time — if the source one has passed, push it out so
  // the clone is valid (it's PAUSED and won't spend until activated anyway).
  const now = Date.now();
  if (as.start_time && new Date(as.start_time).getTime() > now) payload.start_time = as.start_time;
  const usesLifetime = payload.lifetime_budget || (!campaignHasBudget && as.lifetime_budget);
  if (as.end_time && new Date(as.end_time).getTime() > now) payload.end_time = as.end_time;
  else if (usesLifetime) payload.end_time = new Date(now + 14 * 24 * 3600 * 1000).toISOString();
  return payload;
}

const URL_RE = /(https?:\/\/[^\s"'<>)]+)/;

async function buildCreativePayload(cr, { destImageHash, destVideoId, hints, pageId = null, igId = null, identityMap = {}, allowPageOnlyIg = true, recreateBoosted = false, adUrlOverride = null }) {
  void recreateBoosted; // reconstruction is now the default when a destination identity is resolvable
  const pc = cr.__postContent || null; // recovered underlying Page-post copy fields (SHARE creatives)
  const img = (h, opt) => destImageHash(h, hints, opt);
  const vid = (v, opt) => destVideoId(v, hints, opt);
  const pageMap = identityMap?.pages || {};
  const igMap = identityMap?.instagram || {};
  const resolvePage = (src) => (src && pageMap[String(src)]) || pageId || src || null;
  // null result ⇒ post as the Page identity only (Meta-supported for video/image link ads).
  const resolveIg = (src) => (src && igMap[String(src)]) || igId || (allowPageOnlyIg ? null : src) || null;
  const applyIdentity = (oss) => {
    const pg = resolvePage(oss.page_id);
    if (pg) oss.page_id = pg;
    const ig = resolveIg(oss.instagram_user_id || oss.instagram_actor_id);
    if (ig) { oss.instagram_user_id = ig; delete oss.instagram_actor_id; }
    else { delete oss.instagram_user_id; delete oss.instagram_actor_id; }
    return oss;
  };

  const payload = {};
  if (cr.name) payload.name = cr.name;
  if (cr.url_tags) payload.url_tags = cr.url_tags;
  if (cr.product_set_id) payload.product_set_id = cr.product_set_id;
  if (cr.degrees_of_freedom_spec) payload.degrees_of_freedom_spec = cr.degrees_of_freedom_spec;
  if (cr.contextual_multi_ads) payload.contextual_multi_ads = cr.contextual_multi_ads;
  if (cr.authorization_category && cr.authorization_category !== 'NONE') payload.authorization_category = cr.authorization_category;

  // ---- has a real object_story_spec ----
  if (cr.object_story_spec) {
    const oss = applyIdentity(deepClone(cr.object_story_spec));
    // Meta returns BOTH image_hash and image_url on read, but a creative CREATE
    // rejects "only one of image_url and image_hash should be specified". Keep
    // the (remapped) hash, drop the URL.
    const dedupeThumb = (obj) => { if (obj && obj.image_hash && obj.image_url) delete obj.image_url; };
    if (oss.link_data) {
      if (oss.link_data.image_hash) oss.link_data.image_hash = await img(oss.link_data.image_hash);
      dedupeThumb(oss.link_data);
      for (const ch of oss.link_data.child_attachments || []) {
        if (ch.image_hash) ch.image_hash = await img(ch.image_hash);
        if (ch.video_id) ch.video_id = await vid(ch.video_id);
        dedupeThumb(ch);
      }
    }
    if (oss.video_data) {
      if (oss.video_data.video_id) oss.video_data.video_id = await vid(oss.video_data.video_id);
      if (oss.video_data.image_hash) oss.video_data.image_hash = await img(oss.video_data.image_hash);
      dedupeThumb(oss.video_data);
    }
    if (oss.photo_data && oss.photo_data.image_hash) { oss.photo_data.image_hash = await img(oss.photo_data.image_hash); dedupeThumb(oss.photo_data); }
    payload.object_story_spec = oss;
  }

  // ---- Advantage+ asset_feed_spec (needs a page via object_story_spec) ----
  if (cr.asset_feed_spec) {
    const afs = deepClone(cr.asset_feed_spec);
    for (const im of afs.images || []) if (im.hash) im.hash = await img(im.hash);
    for (const v of afs.videos || []) {
      if (v.video_id) v.video_id = await vid(v.video_id);
      if (v.thumbnail_hash) v.thumbnail_hash = await img(v.thumbnail_hash);
    }
    payload.asset_feed_spec = afs;
    if (!payload.object_story_spec) {
      const pg = resolvePage(cr.object_story_spec?.page_id || (cr.object_story_id ? String(cr.object_story_id).split('_')[0] : null) || cr.actor_id);
      if (!pg) throw new Error('كرياتيف Advantage+ (asset_feed_spec) بدون page_id — حدّد صفحة وجهة (identity mapping).');
      payload.object_story_spec = applyIdentity({ page_id: pg, instagram_user_id: cr.instagram_user_id });
    }
  }

  // ---- REBUILD_FROM_SPEC: reconstruct a NEW creative from the underlying
  //      text / media when there's no re-usable object_story_spec (a boosted
  //      organic post — object_story_id only — or a bare flat creative).
  if (!payload.object_story_spec && !payload.asset_feed_spec) {
    const pg = resolvePage((cr.object_story_id ? String(cr.object_story_id).split('_')[0] : null) || pc?.pageId || cr.actor_id);
    if (!pg) throw new Error('لا يمكن تحديد صفحة وجهة لإعادة بناء الكرياتيف — اختر صفحة في خطوة ربط الهوية (identity mapping).');
    // URL priority: an explicit per-ad override → the recovered Page-post link
    // (with utm) → a URL embedded in the body text → the flat creative fields.
    const link = adUrlOverride || cr.link_url || pc?.link || (cr.body && (cr.body.match(URL_RE) || [])[1]) || cr.template_url || null;
    const oss = applyIdentity({ page_id: pg, instagram_user_id: cr.instagram_user_id });
    const ctaType = cr.call_to_action_type || pc?.ctaType || 'LEARN_MORE';
    const body = cr.body || pc?.description || undefined;      // primary text
    const headline = cr.title || pc?.title || undefined;       // headline
    const descr = cr.link_description || pc?.description || undefined;
    if (cr.video_id) {
      const dv = await vid(cr.video_id);
      oss.video_data = { video_id: dv, title: headline, message: body, link_description: descr };
      if (cr.image_hash) oss.video_data.image_hash = await img(cr.image_hash);
      else if (cr.thumbnail_url || pc?.imageUrl) oss.video_data.image_url = cr.thumbnail_url || pc.imageUrl;
      if (link) oss.video_data.call_to_action = { type: ctaType, value: { link } };
      else if (ctaType !== 'LEARN_MORE') { const e = new Error(`لا يوجد رابط وجهة قابل للاستخراج لهذا الإعلان (CTA ${ctaType}) — أدخله يدويًا.`); e.needsUserInput = true; throw e; }
    } else if (cr.image_hash || cr.image_url || pc?.imageUrl) {
      if (!link) { const e = new Error('لا يوجد رابط وجهة قابل للاستخراج لهذا الإعلان — أدخله يدويًا.'); e.needsUserInput = true; throw e; }
      oss.link_data = { link, message: body, name: headline, description: descr, call_to_action: { type: ctaType, value: { link } } };
      if (cr.image_hash) oss.link_data.image_hash = await img(cr.image_hash);
      else oss.link_data.picture = cr.image_url || pc?.imageUrl;
    } else {
      throw new Error('الكرياتيف بلا وسائط (فيديو/صورة) يمكن إعادة بنائها — يلزم رفع ميديا يدويًا (NEEDS_MANUAL_MEDIA).');
    }
    payload.object_story_spec = oss;
  }

  return payload;
}

/** An asset_feed_spec with no bodies/titles/descriptions/images/videos/link_urls/CTAs of its own — carries only a Messenger toggle or similar. */
function isStubAssetFeedSpec(afs) {
  if (!afs || typeof afs !== 'object') return true;
  const content = ['bodies', 'titles', 'descriptions', 'images', 'videos', 'link_urls', 'call_to_action_types', 'ad_formats'];
  return !content.some((k) => Array.isArray(afs[k]) && afs[k].length);
}

/** Collect the destination image_hash / video_id values actually present in a built creative payload (for Media Library registration). */
function collectAssetIds(payload) {
  const imageHashes = new Set();
  const videoIds = new Set();
  const scan = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if ((k === 'image_hash' || k === 'thumbnail_hash') && typeof v === 'string') imageHashes.add(v);
      else if (k === 'video_id' && (typeof v === 'string' || typeof v === 'number')) videoIds.add(String(v));
      else if (v && typeof v === 'object') scan(v);
    }
  };
  scan(payload.object_story_spec);
  scan(payload.asset_feed_spec);
  return { imageHashes: [...imageHashes], videoIds: [...videoIds] };
}

// ---------------------------------------------------------------------------
// Scheduled activation (called from cloneScheduler.js)
// ---------------------------------------------------------------------------
export async function activateDueJobs() {
  const settings = await getAmbSettings();
  if (settings.ambCloneAutoActivate === false) return { activated: 0, skipped: 'AUTO_ACTIVATE_OFF' };
  if (settings.ambExecutionMode === 'ADVISORY') return { activated: 0, skipped: 'ADVISORY' };

  const due = await prisma.ambCloneJob.findMany({
    where: {
      status: 'CLONED_PAUSED',
      scheduled_activation_at: { lte: new Date() },
      batch: { status: { in: ['SCHEDULED', 'APPROVED', 'CLONING', 'PARTIALLY_FAILED'] } },
    },
    take: 50,
    include: { batch: true },
  });
  if (!due.length) return { activated: 0 };

  let token;
  try { token = await getDecryptedToken(); } catch { return { activated: 0, skipped: 'NO_TOKEN' }; }
  let activated = 0;

  for (const job of due) {
    // A copied campaign that now has its own per-campaign schedule is owned by
    // campaignSchedule.js — the legacy batch-wide time must never race it.
    if (await jobHasActiveSchedule(job.id)) continue;
    await prisma.ambCloneJob.update({ where: { id: job.id }, data: { status: 'ACTIVATION_PENDING' } });
    const idMap = j(job.id_map_json, {}) || {};
    // Activate top-down: campaign → ad sets → ads, so a child is never set
    // ACTIVE under a still-PAUSED parent. Every id here was created by THIS job
    // in the DESTINATION account (never a source id).
    const ids = [
      ...(job.destination_campaign_id ? [job.destination_campaign_id] : []),
      ...Object.values(idMap.adsets || {}),
      ...Object.values(idMap.ads || {}),
    ];
    const errors = [];
    for (const id of ids) {
      try { await setEntityStatus(token, id, 'ACTIVE'); }
      catch (err) { errors.push(`${id}: ${err.message}`); }
    }
    if (errors.length) {
      await prisma.ambCloneJob.update({ where: { id: job.id }, data: { status: 'ACTIVATION_FAILED', error: errors.join(' | ').slice(0, 800) } });
      await audit(job.batch_id, job.id, 'ACTIVATION_FAILED', { detail: errors.join(' | ') });
      await raiseAlert({
        severity: 'WARNING', category: 'EXECUTION',
        title: `تفعيل مجدول فشل جزئيًا: ${job.source_campaign_name || job.source_campaign_id}`,
        message: `في الحساب ${job.destination_account_name || job.destination_ad_account_id}: ${errors[0]}`,
        dedupeKey: `clone-activate-fail:${job.id}`,
      }).catch(() => {});
    } else {
      await prisma.ambCloneJob.update({ where: { id: job.id }, data: { status: 'ACTIVATED', activated_at: new Date() } });
      await audit(job.batch_id, job.id, 'ACTIVATION', { detail: `تم تفعيل الحملة المستنسخة في ${job.destination_account_name || job.destination_ad_account_id}.` });
      activated++;
    }
    await recomputeBatchStatus(job.batch_id);
  }
  if (activated) logger.info('AMB clone scheduled activation', { activated });
  return { activated, due: due.length };
}

// ---------------------------------------------------------------------------
// Serialization for the API
// ---------------------------------------------------------------------------
async function audit(batchId, jobId, event, { level, source_id, destination_id, detail, data, actorId } = {}) {
  try {
    await prisma.ambCloneAudit.create({
      data: { batch_id: batchId, job_id: jobId || null, event, level: level || null, source_id: source_id ? String(source_id) : null, destination_id: destination_id ? String(destination_id) : null, detail: detail ? String(detail).slice(0, 900) : null, data_json: data ? JSON.stringify(data).slice(0, 4000) : null, actor_id: actorId || null },
    });
  } catch (e) { logger.warn('AMB clone audit write failed', { message: e.message }); }
}

export async function listBatches({ limit = 25 } = {}) {
  const rows = await prisma.ambCloneBatch.findMany({
    orderBy: { created_at: 'desc' }, take: Math.min(limit, 100),
    include: { _count: { select: { jobs: true } }, jobs: { select: { status: true, preflight_status: true } } },
  });
  return rows.map((b) => ({
    batchId: b.batch_id,
    sourceAccountId: b.source_ad_account_id,
    sourceAccountName: b.source_ad_account_name,
    destinationCount: (j(b.destination_account_ids_json, []) || []).length,
    campaignCount: (j(b.campaign_ids_json, []) || []).length,
    totalCopies: b.total_copies,
    scheduleLocalTime: b.schedule_local_time,
    status: b.status,
    jobs: summarizeJobs(b.jobs),
    createdAt: b.created_at,
    approvedAt: b.approved_at,
  }));
}

function summarizeJobs(jobs) {
  const s = { total: jobs.length, blocked: 0, pending: 0, cloning: 0, clonedPaused: 0, activated: 0, failed: 0, cancelled: 0, cannotCopy: 0, needsDecision: 0, needsInput: 0 };
  for (const jb of jobs) {
    if (jb.preflight_status === 'BLOCKED' || jb.status === 'PREFLIGHT_BLOCKED') s.blocked++;
    else if (jb.status === 'CANNOT_COPY') s.cannotCopy++;
    else if (jb.status === 'NEEDS_DECISION') s.needsDecision++;
    else if (jb.status === 'NEEDS_INPUT') s.needsInput++;
    else if (jb.status === 'PENDING') s.pending++;
    else if (jb.status === 'CLONING') s.cloning++;
    else if (jb.status === 'CLONED_PAUSED' || jb.status === 'ACTIVATION_PENDING') s.clonedPaused++;
    else if (jb.status === 'ACTIVATED') s.activated++;
    else if (jb.status === 'FAILED' || jb.status === 'ACTIVATION_FAILED') s.failed++;
    else if (jb.status === 'CANCELLED') s.cancelled++;
  }
  return s;
}

export async function getBatch(batchId) {
  const b = await prisma.ambCloneBatch.findUnique({
    where: { batch_id: batchId },
    include: {
      jobs: { orderBy: { id: 'asc' }, include: { objects: { orderBy: { id: 'asc' } } } },
      audits: { orderBy: { id: 'desc' }, take: 200 },
      created_by: { select: { name: true } },
      approved_by: { select: { name: true } },
    },
  });
  if (!b) { const e = new Error('الدفعة مش موجودة.'); e.status = 404; throw e; }
  return {
    batchId: b.batch_id,
    status: b.status,
    source: { id: b.source_ad_account_id, name: b.source_ad_account_name },
    destinationAccountIds: j(b.destination_account_ids_json, []),
    campaignIds: j(b.campaign_ids_json, []),
    scheduleLocalTime: b.schedule_local_time,
    destinationPageId: b.destination_page_id || null,
    destinationInstagramId: b.destination_instagram_id || null,
    identityMap: j(b.identity_map_json, null),
    pixelMap: j(b.pixel_map_json, null),
    recreateBoosted: b.recreate_boosted,
    totalCopies: b.total_copies,
    sourceUnchanged: true,
    preflight: j(b.preflight_json, []),
    error: b.error,
    createdBy: b.created_by?.name || null,
    approvedBy: b.approved_by?.name || null,
    createdAt: b.created_at,
    approvedAt: b.approved_at,
    jobsSummary: summarizeJobs(b.jobs),
    jobs: b.jobs.map((jb) => ({
      id: jb.id,
      destinationAccountId: jb.destination_ad_account_id,
      destinationAccountName: jb.destination_account_name,
      destinationTimezone: jb.destination_timezone,
      sourceCampaignId: jb.source_campaign_id,
      sourceCampaignName: jb.source_campaign_name,
      destinationCampaignId: jb.destination_campaign_id,
      status: jb.status,
      preflightStatus: jb.preflight_status,
      preflightChecks: (j(jb.preflight_json, {}) || {}).checks || [],
      scheduledActivationAt: isoOrNull(jb.scheduled_activation_at),
      activatedAt: isoOrNull(jb.activated_at),
      attempts: jb.attempts,
      error: jb.error,
      copiesCreated: j(jb.copies_created_json, null),
      idMap: j(jb.id_map_json, null),
      objects: jb.objects.map((o) => ({ level: o.level, sourceId: o.source_id, sourceName: o.source_name, destinationId: o.destination_id, status: o.status, error: o.error })),
    })),
    audit: b.audits.map((a) => ({ at: a.created_at, event: a.event, level: a.level, sourceId: a.source_id, destinationId: a.destination_id, detail: a.detail })),
  };
}
