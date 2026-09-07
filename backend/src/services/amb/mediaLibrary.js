// AI Media Buyer — MEDIA ASSET LIBRARY.
//
// One deduplicated catalogue of every advertising creative running across the
// connected Meta ad accounts. Discovery is automatic: it piggy-backs the
// existing snapshot sync (and an on-demand per-account scan) and reads each
// ad's real creative via the Graph API, then folds it into the library by a
// CONTENT FINGERPRINT so the same underlying creative — reused inside one
// account or re-uploaded into another — is one library asset with a
// per-account id map (MediaLibraryCreativeRef).
//
// No performance is stored here: it is aggregated on read from the
// append-only meta_performance_snapshots by creative_id (per account + total),
// and profit reuses the product economics + COD engine exactly as
// winnerDetection does. Nothing in this file writes to Meta.
import crypto from 'node:crypto';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getCreativeNode } from '../metaGraphClient.js';
import { mappedCampaignIndex } from './mapping.js';
import { creativeLabelIndex } from './creativeAnalysis.js';
import { resolveWindow } from './metricsEngine.js';
import { netProfitBundle } from './productEconomics.js';
import { codCountsForProduct } from './codOrders.js';

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function urlPathKey(u) {
  try { const x = new URL(u); return (x.host + x.pathname).toLowerCase().replace(/\/+$/, ''); } catch { return norm(u); }
}
function j(v, d) { try { return v ? JSON.parse(v) : d; } catch { return d; } }
function daysAgoISO(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
function firstSentence(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const cut = t.search(/[.!؟?\n]/);
  return (cut > 8 ? t.slice(0, cut) : t).slice(0, 70).trim();
}
/** Best human name for an asset: the analyzed hook wins (it's what distinguishes two ads that share boilerplate primary text), then title, then the first line of the body. */
function deriveAssetName({ hook, sampleTitle, sampleBody, nodeName, creativeId }) {
  return (hook && hook.length > 3 ? hook
    : sampleTitle && sampleTitle.length > 3 ? sampleTitle
    : firstSentence(sampleBody)
    || nodeName
    || `Creative ${creativeId}`).slice(0, 200);
}
const GENERIC_NAME_RE = /^(🔥|خصم|عرض|offer|sale|discount|creative\s)/i;

// ---------------------------------------------------------------------------
// Fingerprint — the dedup key
// ---------------------------------------------------------------------------
/** Pull every asset reference + copy sample out of a Graph creative node. */
export function extractCreativeContent(node) {
  const oss = node.object_story_spec || {};
  const link = oss.link_data || {};
  const video = oss.video_data || {};
  const photo = oss.photo_data || {};
  const afs = node.asset_feed_spec || {};

  const imageHashes = new Set();
  const videoIds = new Set();
  for (const h of [node.image_hash, link.image_hash, video.image_hash, photo.image_hash]) if (h) imageHashes.add(h);
  for (const ch of link.child_attachments || []) { if (ch.image_hash) imageHashes.add(ch.image_hash); if (ch.video_id) videoIds.add(String(ch.video_id)); }
  for (const im of afs.images || []) if (im.hash) imageHashes.add(im.hash);
  for (const v of [node.video_id, video.video_id]) if (v) videoIds.add(String(v));
  for (const v of afs.videos || []) { if (v.video_id) videoIds.add(String(v.video_id)); if (v.thumbnail_hash) imageHashes.add(v.thumbnail_hash); }

  const bodies = [node.body, link.message, video.message, ...(afs.bodies || []).map((b) => b.text)].filter(Boolean).map(String);
  const titles = [node.title, link.name, video.title, ...(afs.titles || []).map((t) => t.text)].filter(Boolean).map(String);
  const links = [node.link_url, link.link, ...(afs.link_urls || []).map((l) => l.website_url)].filter(Boolean).map(String);
  const cta = node.call_to_action_type || link.call_to_action?.type || video.call_to_action?.type || (afs.call_to_action_types || [])[0] || null;
  const pageId = oss.page_id || null;

  const childCount = (link.child_attachments || []).length;
  const feedAssets = (afs.images || []).length + (afs.videos || []).length;
  const isCarousel = childCount > 1 || feedAssets > 1;
  const format = isCarousel ? 'CAROUSEL' : videoIds.size ? 'VIDEO' : imageHashes.size ? 'IMAGE' : 'OTHER';
  const thumb = node.thumbnail_url || video.image_url || link.picture || node.image_url || null;

  return {
    imageHashes: [...imageHashes], videoIds: [...videoIds], bodies, titles, links, cta, pageId, format, thumb,
    sampleBody: bodies[0] || null, sampleTitle: titles[0] || null, sampleLink: links[0] || null,
  };
}

/**
 * Content fingerprint. Image hashes are content-derived (identical bytes →
 * identical hash in any account), so a creative reused or re-uploaded
 * elsewhere lands on the same fingerprint. A creative with NO shareable
 * content (no copy, no image hash) gets a per-creative fingerprint instead —
 * never falsely merged with a different one.
 */
export function fingerprintCreative(node, { adAccountId, creativeId }) {
  const c = extractCreativeContent(node);
  const body = norm(c.bodies.join(' ␟ '));
  const title = norm(c.titles.join(' ␟ '));
  const linkKey = c.links.length ? urlPathKey(c.links[0]) : '';
  const imgKey = [...c.imageHashes].sort().join(',');
  const hasContent = body.length >= 8 || title.length >= 4 || c.imageHashes.length > 0;
  const fingerprint = hasContent
    ? 'fp1:' + sha1([norm(c.pageId), linkKey, norm(c.cta), body, title, imgKey].join('|'))
    : 'raw:' + adAccountId + ':' + creativeId;
  return { fingerprint, ...c };
}

// ---------------------------------------------------------------------------
// Discovery / sync
// ---------------------------------------------------------------------------
/**
 * Fold every recently-seen creative for ONE ad account into the library.
 * Cache-first (skips (account, creative_id) pairs already mapped), bounded,
 * never throws. Called opportunistically from snapshotSync + on demand.
 */
export async function syncMediaLibraryForAccount({ adAccountId, token, sinceDays = 30, maxNew = 40 }) {
  if (!adAccountId || !token) return { ok: false, error: 'MISSING_ARGS' };
  const from = daysAgoISO(sinceDays);
  let groups;
  try {
    groups = await prisma.metaPerformanceSnapshot.groupBy({
      by: ['creative_id', 'campaign_id'],
      where: { level: 'ad', ad_account_id: adAccountId, creative_id: { not: null }, date_start: { gte: from } },
      _sum: { spend: true },
    });
  } catch (err) { return { ok: false, error: err.message }; }

  const creativeIds = [...new Set(groups.map((g) => g.creative_id).filter(Boolean))];
  if (!creativeIds.length) return { ok: true, scanned: 0, newAssets: 0, newRefs: 0, remaining: 0, total: 0 };

  const existing = await prisma.mediaLibraryCreativeRef.findMany({
    where: { ad_account_id: adAccountId, creative_id: { in: creativeIds } },
    select: { creative_id: true },
  });
  const have = new Set(existing.map((e) => e.creative_id));
  const todo = creativeIds.filter((id) => !have.has(id)).slice(0, maxNew);
  if (!todo.length) return { ok: true, scanned: 0, newAssets: 0, newRefs: 0, remaining: 0, total: creativeIds.length };

  const campMap = await mappedCampaignIndex({ adAccountId }).catch(() => new Map());
  const campByCreative = new Map();
  for (const g of groups) {
    if (!g.creative_id) continue;
    if (!campByCreative.has(g.creative_id)) campByCreative.set(g.creative_id, new Set());
    if (g.campaign_id) campByCreative.get(g.creative_id).add(g.campaign_id);
  }
  const labels = await creativeLabelIndex(todo).catch(() => new Map());

  let newAssets = 0, newRefs = 0, failed = 0;
  for (const cid of todo) {
    try {
      const node = await getCreativeNode(token, cid).catch(() => null);
      if (!node || !node.id) { failed++; continue; }
      const fp = fingerprintCreative(node, { adAccountId, creativeId: cid });
      const ca = labels.get(cid);

      let asset = await prisma.mediaLibraryAsset.findUnique({ where: { fingerprint: fp.fingerprint } });
      const autoProduct = () => {
        const prods = new Set([...(campByCreative.get(cid) || [])].map((c) => campMap.get(c)?.ambProductId).filter(Boolean));
        return prods.size === 1 ? [...prods][0] : null;
      };
      if (!asset) {
        const pid = autoProduct();
        asset = await prisma.mediaLibraryAsset.create({
          data: {
            fingerprint: fp.fingerprint,
            primary_format: fp.format,
            asset_name: deriveAssetName({ hook: ca?.hook, sampleTitle: fp.sampleTitle, sampleBody: fp.sampleBody, nodeName: node.name, creativeId: cid }),
            amb_product_id: pid,
            link_source: pid ? 'AUTO_CAMPAIGN_MAP' : 'NONE',
            hook: ca?.hook || null,
            hook_types_json: ca?.hook_types_json || null,
            selling_angle: ca?.selling_angle || null,
            creative_type: ca?.creative_type || null,
            sample_body: fp.sampleBody?.slice(0, 600) || null,
            sample_title: fp.sampleTitle?.slice(0, 300) || null,
            sample_cta: fp.cta || null,
            sample_link_url: fp.sampleLink?.slice(0, 500) || null,
            thumbnail_url: fp.thumb || null,
            page_id: fp.pageId || null,
          },
        });
        newAssets++;
      } else {
        const patch = { last_seen_at: new Date() };
        if (ca?.hook && !asset.hook) patch.hook = ca.hook;
        if (ca?.hook_types_json && !asset.hook_types_json) patch.hook_types_json = ca.hook_types_json;
        if (ca?.selling_angle && !asset.selling_angle) patch.selling_angle = ca.selling_angle;
        if (ca?.creative_type && !asset.creative_type) patch.creative_type = ca.creative_type;
        if (!asset.thumbnail_url && fp.thumb) patch.thumbnail_url = fp.thumb;
        // Upgrade a generic name once a real hook is available (never override a manual rename — heuristic: manual names rarely match the boilerplate pattern).
        if (ca?.hook && GENERIC_NAME_RE.test(asset.asset_name || '')) patch.asset_name = deriveAssetName({ hook: ca.hook });
        if (!asset.amb_product_id && asset.link_source !== 'MANUAL') {
          const pid = autoProduct();
          if (pid) { patch.amb_product_id = pid; patch.link_source = 'AUTO_CAMPAIGN_MAP'; }
        }
        await prisma.mediaLibraryAsset.update({ where: { id: asset.id }, data: patch });
      }

      await prisma.mediaLibraryCreativeRef.upsert({
        where: { ad_account_id_creative_id: { ad_account_id: adAccountId, creative_id: cid } },
        create: {
          asset_id: asset.id, ad_account_id: adAccountId, creative_id: cid, creative_name: node.name || null,
          format: fp.format, image_hashes_json: JSON.stringify(fp.imageHashes), video_ids_json: JSON.stringify(fp.videoIds),
          origin: 'DISCOVERED',
        },
        update: {
          asset_id: asset.id, last_seen_at: new Date(), format: fp.format,
          image_hashes_json: JSON.stringify(fp.imageHashes), video_ids_json: JSON.stringify(fp.videoIds),
        },
      });
      newRefs++;
    } catch (err) {
      failed++;
      logger.warn('AMB media library: creative fold failed', { creativeId: cid, message: err.message });
    }
  }
  logger.info('AMB media library sync', { adAccountId, scanned: todo.length, newAssets, newRefs, failed });
  return { ok: true, scanned: todo.length, newAssets, newRefs, failed, total: creativeIds.length, remaining: Math.max(0, creativeIds.length - have.size - todo.length) };
}

// ---------------------------------------------------------------------------
// Performance attribution (read-only, from snapshots)
// ---------------------------------------------------------------------------
function emptyPerf() { return { spend: 0, impressions: null, clicks: null, purchases: null, revenue: null, cpa: null, ctr: null, cpc: null, roas: null }; }
function aggPerf(rows) {
  let spend = 0, impressions = 0, clicks = 0, purchases = 0, revenue = 0;
  let hi = false, hc = false, hp = false, hr = false;
  for (const r of rows) {
    spend += Number(r.spend) || 0;
    if (r.impressions != null) { impressions += Number(r.impressions); hi = true; }
    if (r.clicks != null) { clicks += Number(r.clicks); hc = true; }
    if (r.meta_purchases != null) { purchases += Number(r.meta_purchases); hp = true; }
    if (r.meta_revenue != null) { revenue += Number(r.meta_revenue); hr = true; }
  }
  return {
    spend,
    impressions: hi ? impressions : null,
    clicks: hc ? clicks : null,
    purchases: hp ? purchases : null,
    revenue: hr ? revenue : null,
    cpa: hp && purchases > 0 ? spend / purchases : null,
    ctr: hc && hi && impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: hc && clicks > 0 ? spend / clicks : null,
    roas: hr && spend > 0 ? revenue / spend : null,
  };
}

/** Aggregate one asset's performance from ad-level snapshots, total + per ad account. */
export async function assetPerformance({ creativeIds, from, to }) {
  const ids = [...new Set((creativeIds || []).filter(Boolean))];
  if (!ids.length) return { total: emptyPerf(), byAccount: [], usage: { accounts: [], campaigns: [], adsets: [], ads: [] } };
  const rows = await prisma.metaPerformanceSnapshot.findMany({
    where: { level: 'ad', creative_id: { in: ids }, date_start: { gte: from, lte: to } },
    orderBy: { snapshot_at: 'asc' },
  });
  // latest snapshot per (ad_id, date_start)
  const latest = new Map();
  for (const r of rows) { if (r.ad_id) latest.set(`${r.ad_id}|${r.date_start}`, r); }
  const dayRows = [...latest.values()];

  const byAcct = new Map();
  for (const r of dayRows) {
    if (!byAcct.has(r.ad_account_id)) byAcct.set(r.ad_account_id, []);
    byAcct.get(r.ad_account_id).push(r);
  }
  const byAccount = [...byAcct.entries()].map(([adAccountId, list]) => ({ adAccountId, ...aggPerf(list) }));

  // Usage (distinct entities that ran this asset in the window)
  const uAcc = new Set(), uCamp = new Map(), uAdset = new Map(), uAd = new Map();
  for (const r of dayRows) {
    if (r.ad_account_id) uAcc.add(r.ad_account_id);
    if (r.campaign_id) uCamp.set(r.campaign_id, r.campaign_name || r.campaign_id);
    if (r.adset_id) uAdset.set(r.adset_id, r.adset_name || r.adset_id);
    if (r.ad_id) uAd.set(r.ad_id, r.ad_name || r.ad_id);
  }
  return {
    total: aggPerf(dayRows),
    byAccount,
    usage: {
      accounts: [...uAcc],
      campaigns: [...uCamp.entries()].map(([id, name]) => ({ id, name })),
      adsets: [...uAdset.entries()].map(([id, name]) => ({ id, name })),
      ads: [...uAd.entries()].map(([id, name]) => ({ id, name })),
    },
  };
}

/** Product-economics profit for an asset, applied to that asset's ad spend. COD orders are product-level (not creative-attributed) — labelled as such. */
export async function assetProfit({ ambProductId, spend, from, to }) {
  if (!ambProductId) return { netProfit: null, deliveredCpa: null, revenue: null, source: 'NO_PRODUCT' };
  const prod = await prisma.ambProduct.findUnique({ where: { id: ambProductId } });
  if (!prod?.product_id) return { netProfit: null, deliveredCpa: null, revenue: null, source: 'NO_COD_LINK' };
  const cod = await codCountsForProduct({ productId: prod.product_id, from, to });
  const bundle = netProfitBundle(prod, { adSpend: spend, deliveredOrders: cod.delivered, returnedOrders: cod.returned });
  return {
    netProfit: bundle.netProfit,
    deliveredCpa: cod.delivered ? spend / cod.delivered : null,
    revenue: bundle.revenue,
    source: 'PRODUCT_ECONOMICS',
    scopeNote: 'الربح محسوب من اقتصاديات المنتج ومطبَّق على صرف هذا الكرياتيف (أوردرات COD على مستوى المنتج، مش مقسّمة لكل كرياتيف).',
  };
}

// ---------------------------------------------------------------------------
// List / detail / correction
// ---------------------------------------------------------------------------
function serializeAssetLite(a) {
  return {
    id: a.id,
    name: a.asset_name || `Creative ${a.id}`,
    format: a.primary_format,
    thumbnailUrl: a.thumbnail_url || null,
    ambProductId: a.amb_product_id || null,
    productName: a.amb_product?.product_name || null,
    linkSource: a.link_source,
    hook: a.hook || null,
    sellingAngle: a.selling_angle || null,
    creativeType: a.creative_type || null,
    accountCount: new Set((a.refs || []).map((r) => r.ad_account_id)).size,
    refCount: a.refs?.length || 0,
    sampleBody: a.sample_body || null,
    sampleCta: a.sample_cta || null,
    firstSeenAt: a.first_seen_at,
    lastSeenAt: a.last_seen_at,
  };
}

export async function listAssets({ productId, accountId, format, q, windowName } = {}) {
  const window = resolveWindow(windowName || 'last7');
  const where = {};
  if (productId === 'none') where.amb_product_id = null;
  else if (productId) where.amb_product_id = Number(productId);
  if (format) where.primary_format = String(format).toUpperCase();
  if (accountId) where.refs = { some: { ad_account_id: accountId } };
  if (q) {
    const s = String(q).trim();
    where.OR = [
      { asset_name: { contains: s, mode: 'insensitive' } },
      { sample_body: { contains: s, mode: 'insensitive' } },
      { hook: { contains: s, mode: 'insensitive' } },
      { selling_angle: { contains: s, mode: 'insensitive' } },
    ];
  }
  const assets = await prisma.mediaLibraryAsset.findMany({
    where,
    include: { amb_product: { select: { product_name: true } }, refs: { select: { ad_account_id: true, creative_id: true } } },
    orderBy: { last_seen_at: 'desc' },
    take: 400,
  });

  // Light perf for the whole visible set in one snapshot query.
  const allCreativeIds = [...new Set(assets.flatMap((a) => a.refs.map((r) => r.creative_id)))];
  const perfByCreative = new Map();
  if (allCreativeIds.length) {
    const rows = await prisma.metaPerformanceSnapshot.findMany({
      where: { level: 'ad', creative_id: { in: allCreativeIds }, date_start: { gte: window.from, lte: window.to } },
      orderBy: { snapshot_at: 'asc' },
      select: { ad_id: true, date_start: true, creative_id: true, spend: true, meta_purchases: true, meta_revenue: true, impressions: true, clicks: true },
    });
    const latest = new Map();
    for (const r of rows) if (r.ad_id) latest.set(`${r.ad_id}|${r.date_start}`, r);
    for (const r of latest.values()) {
      if (!perfByCreative.has(r.creative_id)) perfByCreative.set(r.creative_id, []);
      perfByCreative.get(r.creative_id).push(r);
    }
  }

  return {
    window,
    assets: assets.map((a) => {
      const rowsForAsset = a.refs.flatMap((r) => perfByCreative.get(r.creative_id) || []);
      return { ...serializeAssetLite(a), performance: rowsForAsset.length ? aggPerf(rowsForAsset) : emptyPerf() };
    }),
  };
}

export async function getAssetDetail({ assetId, windowName }) {
  const window = resolveWindow(windowName || 'last7');
  const a = await prisma.mediaLibraryAsset.findUnique({
    where: { id: Number(assetId) },
    include: { amb_product: { select: { id: true, product_name: true, product_id: true } }, refs: true, scalings: { orderBy: { id: 'desc' } } },
  });
  if (!a) { const e = new Error('الكرياتيف مش موجود في المكتبة.'); e.status = 404; throw e; }

  const creativeIds = a.refs.map((r) => r.creative_id);
  const perf = await assetPerformance({ creativeIds, from: window.from, to: window.to });
  const profit = await assetProfit({ ambProductId: a.amb_product_id, spend: perf.total.spend, from: window.from, to: window.to });

  // Scaling history joined with live batch status.
  const batchIds = a.scalings.map((s) => s.clone_batch_id).filter(Boolean);
  const batches = batchIds.length ? await prisma.ambCloneBatch.findMany({ where: { batch_id: { in: batchIds } }, select: { batch_id: true, status: true, total_copies: true, created_at: true } }) : [];
  const batchById = new Map(batches.map((b) => [b.batch_id, b]));

  return {
    window,
    asset: {
      ...serializeAssetLite(a),
      pageId: a.page_id || null,
      sampleTitle: a.sample_title || null,
      sampleLinkUrl: a.sample_link_url || null,
      fingerprint: a.fingerprint,
    },
    performance: { total: perf.total, byAccount: perf.byAccount, profit },
    usage: perf.usage,
    crossAccountMap: a.refs.map((r) => ({
      adAccountId: r.ad_account_id,
      creativeId: r.creative_id,
      creativeName: r.creative_name,
      format: r.format,
      imageHashes: j(r.image_hashes_json, []),
      videoIds: j(r.video_ids_json, []),
      origin: r.origin,
      cloneJobId: r.clone_job_id,
      firstSeenAt: r.first_seen_at,
    })),
    cloneHistory: a.refs.filter((r) => r.origin === 'CLONED').map((r) => ({ adAccountId: r.ad_account_id, creativeId: r.creative_id, cloneJobId: r.clone_job_id, at: r.created_at })),
    scalingHistory: a.scalings.map((s) => ({
      id: s.id,
      sourceAdAccountId: s.source_ad_account_id,
      destinationAccountIds: j(s.destination_account_ids_json, []),
      sourceCampaignIds: j(s.source_campaign_ids_json, []),
      cloneBatchId: s.clone_batch_id,
      status: batchById.get(s.clone_batch_id)?.status || s.status,
      reason: s.reason,
      createdAt: s.created_at,
    })),
  };
}

export async function updateAsset({ assetId, patch, userId }) {
  const a = await prisma.mediaLibraryAsset.findUnique({ where: { id: Number(assetId) } });
  if (!a) { const e = new Error('الكرياتيف مش موجود في المكتبة.'); e.status = 404; throw e; }
  const data = {};
  if ('ambProductId' in patch) {
    if (patch.ambProductId === null || patch.ambProductId === '') { data.amb_product_id = null; data.link_source = 'NONE'; }
    else {
      const prod = await prisma.ambProduct.findUnique({ where: { id: Number(patch.ambProductId) } });
      if (!prod) { const e = new Error('المنتج مش موجود.'); e.status = 400; throw e; }
      data.amb_product_id = prod.id;
      data.link_source = 'MANUAL'; // sticky — auto discovery never overwrites this
    }
  }
  if (typeof patch.assetName === 'string') data.asset_name = patch.assetName.slice(0, 200);
  if (typeof patch.hook === 'string') data.hook = patch.hook.slice(0, 300) || null;
  if (typeof patch.sellingAngle === 'string') data.selling_angle = patch.sellingAngle.slice(0, 200) || null;
  const updated = await prisma.mediaLibraryAsset.update({ where: { id: a.id }, data });
  logger.info('AMB media library asset corrected', { assetId: a.id, by: userId, fields: Object.keys(data) });
  return serializeAssetLite({ ...updated, amb_product: data.amb_product_id ? await prisma.ambProduct.findUnique({ where: { id: data.amb_product_id }, select: { product_name: true } }) : null, refs: [] });
}

// ---------------------------------------------------------------------------
// Clone & Schedule integration helpers (called from cloneEngine.js)
// ---------------------------------------------------------------------------
/**
 * For a SOURCE creative node about to be cloned into `destAccountId`, return
 * what the destination account ALREADY has for the same underlying asset:
 *   { reuseImageHashes:Set<hash>,  — hashes valid as-is in the destination
 *     videoBySrc:Map<srcVideoId,dstVideoId> } — already-present videos
 * Empty when the library has nothing — the cloner then re-uploads as before.
 */
export async function libraryDestHints(node, destAccountId) {
  try {
    const fp = fingerprintCreative(node, { adAccountId: 'src', creativeId: node.id });
    const asset = await prisma.mediaLibraryAsset.findUnique({
      where: { fingerprint: fp.fingerprint },
      include: { refs: { where: { ad_account_id: destAccountId } } },
    });
    if (!asset || !asset.refs.length) return { reuseImageHashes: new Set(), videoBySrc: new Map(), assetId: asset?.id || null };
    const ref = asset.refs[0];
    const destHashes = new Set(j(ref.image_hashes_json, []));
    const destVideos = j(ref.video_ids_json, []);
    const srcVideos = fp.videoIds.map(String);
    const videoBySrc = new Map();
    if (srcVideos.length === destVideos.length) srcVideos.forEach((s, i) => videoBySrc.set(s, destVideos[i]));
    else if (srcVideos.length === 1 && destVideos.length === 1) videoBySrc.set(srcVideos[0], destVideos[0]);
    return { reuseImageHashes: destHashes, videoBySrc, assetId: asset.id };
  } catch (err) {
    logger.warn('AMB media library: libraryDestHints failed (non-fatal)', { message: err.message });
    return { reuseImageHashes: new Set(), videoBySrc: new Map(), assetId: null };
  }
}

/** Register the creative Clone & Schedule just created in a destination account, so the next clone reuses it (and the cross-account map grows). Non-fatal. */
export async function registerClonedCreativeRef({ srcNode, destAccountId, destCreativeId, destImageHashes, destVideoIds, cloneJobId }) {
  try {
    const fp = fingerprintCreative(srcNode, { adAccountId: 'src', creativeId: srcNode.id });
    let asset = await prisma.mediaLibraryAsset.findUnique({ where: { fingerprint: fp.fingerprint } });
    if (!asset) {
      asset = await prisma.mediaLibraryAsset.create({
        data: {
          fingerprint: fp.fingerprint, primary_format: fp.format,
          asset_name: (fp.sampleTitle || fp.sampleBody?.slice(0, 60) || srcNode.name || `Creative ${srcNode.id}`).slice(0, 200),
          sample_body: fp.sampleBody?.slice(0, 600) || null, sample_title: fp.sampleTitle?.slice(0, 300) || null,
          sample_cta: fp.cta || null, sample_link_url: fp.sampleLink?.slice(0, 500) || null,
          thumbnail_url: fp.thumb || null, page_id: fp.pageId || null,
        },
      });
    }
    await prisma.mediaLibraryCreativeRef.upsert({
      where: { ad_account_id_creative_id: { ad_account_id: destAccountId, creative_id: String(destCreativeId) } },
      create: {
        asset_id: asset.id, ad_account_id: destAccountId, creative_id: String(destCreativeId),
        format: fp.format, image_hashes_json: JSON.stringify(destImageHashes || []), video_ids_json: JSON.stringify(destVideoIds || []),
        origin: 'CLONED', clone_job_id: cloneJobId || null,
      },
      update: { asset_id: asset.id, last_seen_at: new Date(), image_hashes_json: JSON.stringify(destImageHashes || []), video_ids_json: JSON.stringify(destVideoIds || []), origin: 'CLONED', clone_job_id: cloneJobId || null },
    });
    return asset.id;
  } catch (err) {
    logger.warn('AMB media library: registerClonedCreativeRef failed (non-fatal)', { message: err.message });
    return null;
  }
}
