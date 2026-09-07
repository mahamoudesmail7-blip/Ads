// AI Media Buyer — Campaign Clone CREATIVE RECONSTRUCTION ANALYSIS.
//
// READ-ONLY. For a (source campaign → destination account) pair it reads the
// real campaign / ad set / ad / creative from the Graph API, builds a
// NORMALIZED creative representation for every ad, and produces a concrete
// per-ad reconstruction plan:
//
//   • transfer mode   — REUSE_SAFE | REBUILD_FROM_SPEC | REUPLOAD_IMAGE
//                        | REUPLOAD_VIDEO | REBUILD_CAROUSEL | UNSUPPORTED
//   • identity need    — which destination Page / Instagram it will post as,
//                        and whether the user still has to choose one
//   • pixel need       — source Pixel → destination Pixel, mapped or not
//   • media plan       — per image / video: reuse-shared / re-upload / manual
//   • conversion_domain— derived from the destination URL host, flagged if a
//                        sales config will require it before activation
//   • readiness        — READY | READY_WITH_REBUILD | NEEDS_IDENTITY_MAPPING
//                        | NEEDS_PIXEL_MAPPING | NEEDS_MANUAL_MEDIA | UNSUPPORTED
//
// It never writes to Meta and never touches the source. The clone engine
// consumes the same normalization + mapping inputs when it actually builds.
import { getDecryptedToken, getConnection } from '../metaAuth.js';
import {
  getAllAccessibleAdAccounts, getCampaignNode, getAdSetNodes, getAdNodes, getCreativeNode,
  getAccountAssetsForClone, getAccountIdentities, getAdImagesByHash, getVideoSourceUrl, getPagePostContent,
} from '../metaGraphClient.js';

const URL_RE = /(https?:\/\/[^\s"'<>)]+)/;
function hostOf(u) { try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; } }
function firstUrlIn(...vals) { for (const v of vals) { const m = String(v || '').match(URL_RE); if (m) return m[1]; } return null; }

// ---------------------------------------------------------------------------
// 1. Normalized creative representation
// ---------------------------------------------------------------------------
/** Flatten a Graph creative node into one shape, regardless of link/video/carousel/AFS/boosted form. */
export function normalizeCreative(cr) {
  const oss = cr.object_story_spec || {};
  const link = oss.link_data || {};
  const video = oss.video_data || {};
  const photo = oss.photo_data || {};
  const afs = cr.asset_feed_spec || {};
  const children = link.child_attachments || [];

  // Recovered copy fields from the underlying Page post (SHARE / boosted-post
  // creatives: object_story_id, no object_story_spec). Attached by the caller.
  const pc = cr.__postContent || {};

  const bodies = [link.message, video.message, cr.body, pc.description, ...(afs.bodies || []).map((b) => b.text)].filter(Boolean);
  const titles = [link.name, video.title, cr.title, pc.title, ...(afs.titles || []).map((t) => t.text)].filter(Boolean);
  const descriptions = [link.description, video.link_description, cr.link_description, pc.description, ...(afs.descriptions || []).map((d) => d.text)].filter(Boolean);
  const ctaType = link.call_to_action?.type || video.call_to_action?.type || cr.call_to_action_type || pc.ctaType || (afs.call_to_action_types || [])[0] || null;
  const ctaLink = link.call_to_action?.value?.link || video.call_to_action?.value?.link || link.link || cr.link_url
    || (afs.link_urls || [])[0]?.website_url || pc.link || firstUrlIn(bodies[0]) || null;
  const displayLink = link.caption || video.caption || (afs.link_urls || [])[0]?.display_url || (ctaLink ? hostOf(ctaLink) : null);

  const images = [];
  for (const h of [link.image_hash, video.image_hash, photo.image_hash, cr.image_hash]) if (h) images.push({ hash: h, url: null });
  for (const im of afs.images || []) if (im.hash) images.push({ hash: im.hash, url: im.url || null });
  const rootImageUrl = video.image_url || link.picture || cr.image_url || cr.thumbnail_url || pc.imageUrl || null;
  if (!images.length && rootImageUrl) images.push({ hash: null, url: rootImageUrl });
  else if (images.length && !images[0].url && rootImageUrl) images[0].url = rootImageUrl;

  const videos = [];
  for (const v of [video.video_id, cr.video_id]) if (v) videos.push({ id: String(v), thumbHash: video.image_hash || null, thumbUrl: video.image_url || cr.thumbnail_url || null });
  for (const v of afs.videos || []) if (v.video_id) videos.push({ id: String(v.video_id), thumbHash: v.thumbnail_hash || null, thumbUrl: v.thumbnail_url || null });

  const carouselCards = children.map((c) => ({
    name: c.name || null, description: c.description || null, link: c.link || null,
    imageHash: c.image_hash || null, imageUrl: c.picture || null, videoId: c.video_id ? String(c.video_id) : null,
    cta: c.call_to_action?.type || null,
  }));

  const pageId = oss.page_id || (cr.object_story_id ? String(cr.object_story_id).split('_')[0] : null) || cr.actor_id || null;
  const igId = oss.instagram_user_id || oss.instagram_actor_id || cr.instagram_user_id || null;

  let format = 'UNKNOWN';
  if (carouselCards.length > 1) format = 'CAROUSEL';
  else if (videos.length) format = 'VIDEO';
  else if (images.length) format = 'IMAGE';

  return {
    creativeId: cr.id || null,
    objectStoryId: cr.object_story_id || cr.effective_object_story_id || null,
    hasObjectStorySpec: !!cr.object_story_spec,
    hasAssetFeedSpec: !!cr.asset_feed_spec && !!Object.keys(cr.asset_feed_spec).length,
    assetFeedIsStub: !!cr.asset_feed_spec && !['bodies', 'titles', 'descriptions', 'images', 'videos', 'link_urls', 'call_to_action_types', 'ad_formats'].some((k) => (cr.asset_feed_spec[k] || []).length),
    format,
    body: bodies[0] || null,
    title: titles[0] || null,
    description: descriptions[0] || null,
    ctaType,
    destinationUrl: ctaLink,
    displayLink,
    urlTags: cr.url_tags || null,
    images,
    videos,
    carouselCards,
    sourcePageId: pageId,
    sourceInstagramId: igId,
    productSetId: cr.product_set_id || null,
    degreesOfFreedomSpec: cr.degrees_of_freedom_spec || null,
    contextualMultiAds: cr.contextual_multi_ads || null,
    isDynamic: (cr.asset_feed_spec?.images || []).length + (cr.asset_feed_spec?.videos || []).length > 1,
  };
}

// ---------------------------------------------------------------------------
// 2. Per-ad reconstruction plan
// ---------------------------------------------------------------------------
// Video / single-image link ads can run with Facebook-Page identity for
// Instagram placements when no IG account is available (Meta-supported).
const PAGE_ONLY_IG_OK = new Set(['VIDEO', 'IMAGE', 'UNKNOWN']);

function resolveIdentity(norm, { destinationPageId, destinationInstagramId, identityMap, allowPageOnlyIg, destIdentities }) {
  const idm = identityMap || {};
  const wantPage = norm.sourcePageId;
  const wantIg = norm.sourceInstagramId;

  const mappedPage = (wantPage && idm.pages?.[wantPage]) || destinationPageId || null;
  const mappedIg = (wantIg && idm.instagram?.[wantIg]) || destinationInstagramId || null;

  const pageInList = !!mappedPage && destIdentities.pages.some((p) => String(p.id) === String(mappedPage));
  const pageStatus = !mappedPage ? 'MISSING'
    : pageInList ? 'RESOLVED'
    : destIdentities.pagesVerified ? 'ASSUMED_PORTFOLIO' // owned by the portfolio, promote_pages just not enumerable with this token scope
    : 'ASSUMED';

  const igInList = !!mappedIg && destIdentities.instagram.some((g) => String(g.id) === String(mappedIg));
  let igStatus;
  if (!wantIg) igStatus = 'NOT_REQUIRED';
  else if (mappedIg) igStatus = igInList ? 'RESOLVED' : 'ASSUMED';
  else if (allowPageOnlyIg && PAGE_ONLY_IG_OK.has(norm.format)) igStatus = 'PAGE_ONLY';
  else igStatus = 'NEEDS_CHOICE'; // user must pick a dest IG or explicitly accept page-only

  const pageOptions = destIdentities.pages.map((p) => ({ id: p.id, label: `${p.name}`, source: p.source, verified: p.verified }));
  const instagramOptions = [
    ...destIdentities.instagram.map((g) => ({ id: g.id, label: `@${g.username}` })),
    { id: 'PAGE_ONLY', label: 'هوية الصفحة فقط (لا يوجد حساب انستجرام في الوجهة)' },
  ];
  return { sourcePageId: wantPage, destPageId: mappedPage, pageStatus, sourceInstagramId: wantIg, destInstagramId: igStatus === 'PAGE_ONLY' ? null : mappedIg, igStatus, pageOptions, instagramOptions };
}

function resolvePixel(adsetPromotedObject, { pixelMap, destAssets }) {
  const src = adsetPromotedObject?.pixel_id ? String(adsetPromotedObject.pixel_id) : null;
  if (!src) return { sourcePixelId: null, destPixelId: null, status: 'NOT_REQUIRED', customEventType: adsetPromotedObject?.custom_event_type || null };
  const mapped = (pixelMap || {})[src] || null;
  const inDest = destAssets?.pixels?.some((p) => String(p.id) === src);
  let status;
  let destPixelId;
  if (inDest) { status = 'RESOLVED_SHARED'; destPixelId = src; }        // same id already usable in destination
  else if (mapped) { status = 'RESOLVED_MAPPED'; destPixelId = mapped; }
  else { status = 'NEEDS_PIXEL_MAPPING'; destPixelId = null; }
  return { sourcePixelId: src, destPixelId, status, customEventType: adsetPromotedObject?.custom_event_type || null };
}

/** Choose a transfer mode + media plan for one normalized creative. Pure. */
function planCreative(norm, { srcImgUrlByHash, srcVideoHasSource }) {
  const checks = [];
  let mode;

  if (norm.format === 'CAROUSEL') mode = 'REBUILD_CAROUSEL';
  else if (norm.objectStoryId && !norm.hasObjectStorySpec && !(norm.body || norm.title || norm.images.length || norm.videos.length)) mode = 'UNSUPPORTED';
  else mode = 'REBUILD_FROM_SPEC';

  // media plan
  const media = { images: [], videos: [] };
  const cardList = norm.format === 'CAROUSEL' ? norm.carouselCards : null;
  const imgHashes = cardList ? cardList.map((c) => c.imageHash).filter(Boolean) : norm.images.map((i) => i.hash).filter(Boolean);
  const imgUrls = cardList ? cardList.map((c) => c.imageUrl).filter(Boolean) : norm.images.map((i) => i.url).filter(Boolean);
  const vidIds = cardList ? cardList.map((c) => c.videoId).filter(Boolean) : norm.videos.map((v) => v.id);

  for (const h of imgHashes) {
    const url = srcImgUrlByHash[h] || null;
    media.images.push({ sourceHash: h, plan: url ? 'REUPLOAD_IMAGE' : 'SHARED_HASH_THEN_MANUAL', sourceUrl: url ? true : false });
  }
  // pure-url image (no hash) — still re-uploadable
  for (let i = imgHashes.length; i < Math.max(imgHashes.length, imgUrls.length); i++) media.images.push({ sourceHash: null, plan: 'REUPLOAD_IMAGE', sourceUrl: true });

  for (const v of vidIds) {
    const hasSrc = !!srcVideoHasSource[v];
    media.videos.push({ sourceVideoId: v, plan: hasSrc ? 'REUPLOAD_VIDEO' : 'SHARED_REFERENCE_THEN_MANUAL', sourceFile: hasSrc });
  }

  const anyManualImage = media.images.some((m) => m.plan === 'SHARED_HASH_THEN_MANUAL');
  const anyManualVideo = media.videos.some((m) => m.plan === 'SHARED_REFERENCE_THEN_MANUAL');

  if (mode === 'UNSUPPORTED') checks.push({ level: 'BLOCK', field: 'creative', detail: 'الكرياتيف منشور مروّج (object_story_id) بدون نص/عنوان/وسائط يمكن استخراجها لإعادة البناء.' });
  if (!norm.destinationUrl && /ORDER_NOW|SHOP_NOW|BUY_NOW|SIGN_UP|LEARN_MORE|GET_OFFER|SUBSCRIBE/.test(norm.ctaType || '')) checks.push({ level: 'WARN', field: 'destination_url', detail: `نوع الـ CTA (${norm.ctaType}) يحتاج رابطًا ولا يوجد رابط قابل للاستخراج — يلزم إدخاله يدويًا.` });

  return { mode, media, anyManualImage, anyManualVideo, checks };
}

function overallReadiness({ creativePlan, identity, pixel }) {
  if (creativePlan.mode === 'UNSUPPORTED') return 'UNSUPPORTED';
  if (identity.pageStatus === 'MISSING' || identity.pageStatus === 'INVALID') return 'NEEDS_IDENTITY_MAPPING';
  if (identity.igStatus === 'NEEDS_CHOICE' || identity.igStatus === 'INVALID') return 'NEEDS_IDENTITY_MAPPING';
  if (pixel.status === 'NEEDS_PIXEL_MAPPING') return 'NEEDS_PIXEL_MAPPING';
  if (creativePlan.anyManualImage || creativePlan.anyManualVideo) return 'NEEDS_MANUAL_MEDIA';
  return 'READY_WITH_REBUILD'; // PAGE_ONLY / ASSUMED_PORTFOLIO are OK to proceed (surfaced as WARN checks)
}

/**
 * Plain "Duplicate to another ad account" view for one ad:
 *   READY         — Meta lets us copy the exact ad now (assets reused or
 *                   re-uploaded verbatim; identity + pixel resolved)
 *   NEEDS_MAPPING — one destination-specific choice is missing (Page / IG /
 *                   Pixel) — a dropdown in the review screen
 *   CANNOT_COPY   — an asset genuinely can't be reached by the destination
 *                   and can't be re-uploaded (e.g. a video with no source
 *                   file and no shared reference), or a boosted post with no
 *                   recoverable content
 * `assetAction` is the honest description of what Meta will do with the media:
 *   REUSE (same id/hash works in the destination) · REUPLOAD (Meta requires
 *   destination ownership — same file, uploaded again) · MANUAL (you provide
 *   the file) · NONE.
 */
function simplifyCopy({ readiness, creativePlan, identity, pixel, convDomain }) {
  const reasons = [];
  let status = 'READY';
  if (readiness === 'UNSUPPORTED') { status = 'CANNOT_COPY'; reasons.push('إعلان يعتمد على منشور صفحة موجود بدون نص/عنوان/وسائط يمكن نسخها.'); }
  if (identity.pageStatus === 'MISSING' || identity.pageStatus === 'INVALID') { status = status === 'CANNOT_COPY' ? status : 'NEEDS_MAPPING'; reasons.push('اختر صفحة فيسبوك للوجهة.'); }
  if (identity.igStatus === 'NEEDS_CHOICE' || identity.igStatus === 'INVALID') { status = status === 'CANNOT_COPY' ? status : 'NEEDS_MAPPING'; reasons.push('اختر حساب انستجرام للوجهة أو "هوية الصفحة فقط".'); }
  if (pixel.status === 'NEEDS_PIXEL_MAPPING') { status = status === 'CANNOT_COPY' ? status : 'NEEDS_MAPPING'; reasons.push(`اربط Pixel/Dataset المصدر (${pixel.sourcePixelId}) بواحد في الوجهة.`); }

  const badVideo = creativePlan.media.videos.find((m) => m.plan === 'SHARED_REFERENCE_THEN_MANUAL' && !m.sourceFile);
  const badImage = creativePlan.media.images.find((m) => m.plan === 'SHARED_HASH_THEN_MANUAL');
  let assetAction = 'REUSE';
  if (creativePlan.media.videos.some((m) => m.plan === 'REUPLOAD_VIDEO') || creativePlan.media.images.some((m) => m.plan === 'REUPLOAD_IMAGE')) assetAction = 'REUPLOAD';
  if (badVideo || badImage) {
    // Not an immediate CANNOT_COPY — the same video_id / image_hash may be
    // usable across the Business Portfolio. Only if that reuse is rejected at
    // copy time does the ad become "provide the file manually".
    assetAction = 'REUSE_OR_MANUAL';
    reasons.push(badVideo
      ? `الفيديو (${badVideo.sourceVideoId}) — Meta لا تتيح تنزيله. سيُجرَّب نفس المعرف عبر Business Portfolio؛ لو رفضته Meta، هذا الإعلان يحتاج رفع الفيديو يدويًا (باقي الحملة تُنسخ عادي).`
      : `صورة بدون رابط مصدر — سيُجرَّب نفس الـ hash؛ لو فشل يلزم رفع الصورة يدويًا.`);
  }
  if (convDomain?.status === 'REQUIRED_MANUAL') reasons.push('إعلان مبيعات بدون رابط وجهة — حدّد نطاق التحويل قبل التفعيل.');

  return { copyStatus: status, assetAction, copyReasons: reasons };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function analyzeClone({ sourceAccountId, destinationAccountIds, campaignIds, destinationPageId, destinationInstagramId, identityMap, pixelMap, allowPageOnlyIg = true }) {
  const conn = await getConnection();
  if (!conn || conn.status !== 'CONNECTED') { const e = new Error('اربط حساب Meta Ads الأول.'); e.status = 400; throw e; }
  const dests = [...new Set((destinationAccountIds || []).filter((x) => x && x !== sourceAccountId))];
  const camps = [...new Set((campaignIds || []).filter(Boolean))];
  if (!camps.length || !dests.length) { const e = new Error('لازم تختار حملة وحساب وجهة.'); e.status = 400; throw e; }

  const token = await getDecryptedToken();
  const accounts = await getAllAccessibleAdAccounts(token);
  const acctById = new Map(accounts.map((a) => [a.id, a]));

  // Source trees + resolved source asset URLs (once per campaign).
  const campData = new Map();
  for (const cid of camps) {
    try {
      const [campaign, adsets, ads] = await Promise.all([getCampaignNode(token, cid), getAdSetNodes(token, cid), getAdNodes(token, cid)]);
      const adsetById = new Map(adsets.map((a) => [a.id, a]));
      const creativeIds = [...new Set(ads.map((a) => a.creative?.id).filter(Boolean))];
      const creatives = new Map();
      for (const crid of creativeIds) creatives.set(crid, await getCreativeNode(token, crid).catch((e) => ({ id: crid, __error: e.message })));

      // SHARE / boosted Page-post creatives: recover the real URL / headline /
      // description / CTA from the underlying Page post (same as the engine).
      for (const c of creatives.values()) {
        if (c.__error) continue;
        const osid = c.object_story_id || c.effective_object_story_id;
        const hasSpec = !!c.object_story_spec;
        const hasAfs = !!c.asset_feed_spec && !!Object.keys(c.asset_feed_spec).length;
        if (osid && !hasSpec && !hasAfs) {
          try { c.__postContent = await getPagePostContent(token, osid); } catch { c.__postContent = null; }
        }
      }

      // resolve image hashes → source URLs + which videos have a downloadable source
      const allHashes = new Set(); const allVideos = new Set();
      for (const c of creatives.values()) {
        const n = c.__error ? null : normalizeCreative(c);
        if (!n) continue;
        for (const im of n.images) if (im.hash) allHashes.add(im.hash);
        for (const card of n.carouselCards) if (card.imageHash) allHashes.add(card.imageHash);
        for (const v of n.videos) allVideos.add(v.id);
        for (const card of n.carouselCards) if (card.videoId) allVideos.add(card.videoId);
      }
      const imgByHash = allHashes.size ? await getAdImagesByHash(token, sourceAccountId, [...allHashes]) : {};
      const srcImgUrlByHash = {};
      for (const h of allHashes) {
        srcImgUrlByHash[h] = imgByHash[h]?.url || imgByHash[h]?.permalink_url || null;
        if (!srcImgUrlByHash[h]) {
          for (const c of creatives.values()) { const n = c.__error ? null : normalizeCreative(c); const hit = n?.images.find((i) => i.hash === h && i.url); if (hit) { srcImgUrlByHash[h] = hit.url; break; } }
        }
      }
      const srcVideoHasSource = {};
      for (const v of allVideos) srcVideoHasSource[v] = !!(await getVideoSourceUrl(token, v));

      campData.set(cid, { campaign, adsets, adsetById, ads, creatives, srcImgUrlByHash, srcVideoHasSource });
    } catch (e) {
      campData.set(cid, { __error: e.message });
    }
  }

  // Per destination: identities + assets once.
  const destInfo = new Map();
  for (const d of dests) {
    destInfo.set(d, { identities: await getAccountIdentities(token, d), assets: await getAccountAssetsForClone(token, d) });
  }

  const salesRe = /SALES|CONVERSION|OUTCOME_SALES|PRODUCT_CATALOG_SALES/i;
  const results = [];
  for (const cid of camps) {
    const cd = campData.get(cid);
    for (const d of dests) {
      const destAcct = acctById.get(d) || { id: d, name: d };
      if (cd?.__error) {
        results.push({
          campaignId: cid, campaignName: `حملة ${cid}`, destinationAccountId: d, destinationAccountName: destAcct.name,
          error: cd.__error, readiness: 'UNSUPPORTED',
          adSetCount: 0, adCount: 0,
          copySummary: { totalAds: 0, ready: 0, needsMapping: 0, cannotCopy: 0 },
          copyableAds: 0, canCopyCompletely: false, copyStatus: 'CANNOT_COPY',
          identityRequired: { pages: [], instagram: [] }, pixelRequired: [],
          destinationIdentities: { pages: [], instagram: [], pagesVerified: false, instagramReadable: false },
          destinationPixels: [], tally: {}, transferModes: {}, ads: [],
        });
        continue;
      }
      const di = destInfo.get(d);
      const salesish = salesRe.test(cd.campaign.objective || '');
      const adPlans = [];
      for (const ad of cd.ads) {
        const cr = ad.creative?.id ? cd.creatives.get(ad.creative.id) : null;
        const adset = cd.adsetById.get(ad.adset_id) || {};
        if (!cr || cr.__error) {
          adPlans.push({
            adId: ad.id, adName: ad.name, readiness: 'UNSUPPORTED', transferMode: 'UNSUPPORTED',
            copyStatus: 'CANNOT_COPY', assetAction: 'NONE',
            copyReasons: [`تعذّرت قراءة كرياتيف الإعلان من Meta${cr?.__error ? ` (${cr.__error})` : ''} — جرّب تحديث المعاينة.`],
            reason: cr?.__error || 'لا يمكن قراءة الكرياتيف',
            checks: [{ level: 'BLOCK', field: 'creative', detail: cr?.__error || 'creative unreadable' }],
          });
          continue;
        }
        const norm = normalizeCreative(cr);
        const identity = resolveIdentity(norm, { destinationPageId, destinationInstagramId, identityMap, allowPageOnlyIg, destIdentities: di.identities });
        const pixel = resolvePixel(adset.promoted_object, { pixelMap, destAssets: di.assets });
        const creativePlan = planCreative(norm, { srcImgUrlByHash: cd.srcImgUrlByHash, srcVideoHasSource: cd.srcVideoHasSource });
        if (identity.pageStatus === 'ASSUMED_PORTFOLIO') creativePlan.checks.push({ level: 'WARN', field: 'page', detail: `الصفحة (${identity.destPageId}) مملوكة لنفس Business Portfolio لكن التوكن الحالي مايقدرش يتحقق من صلاحية النشر — إنشاء الكرياتيف هو الاختبار الفعلي.` });
        if (identity.igStatus === 'PAGE_ONLY') creativePlan.checks.push({ level: 'WARN', field: 'instagram', detail: 'مافيش حساب انستجرام في الحساب الوجهة — أماكن انستجرام هتستخدم هوية صفحة الفيسبوك. اربط حساب انستجرام لو عايز هوية IG أصلية.' });
        if (identity.igStatus === 'NEEDS_CHOICE') creativePlan.checks.push({ level: 'BLOCK', field: 'instagram', detail: 'لازم تختار حساب انستجرام للوجهة أو تقبل "هوية الصفحة فقط".' });
        for (const mv of creativePlan.media.videos) if (mv.plan === 'SHARED_REFERENCE_THEN_MANUAL') creativePlan.checks.push({ level: 'WARN', field: 'video', detail: `الفيديو ${mv.sourceVideoId}: Meta مابتتيحش تنزيله. هيُجرَّب مرجع مشترك (نفس video_id عبر Portfolio)؛ لو Meta رفضته الإعلان ده هيتعلّم NEEDS_MANUAL_MEDIA (رفع يدوي) بدون ما يفشل باقي الحملة.` });
        for (const mi of creativePlan.media.images) if (mi.plan === 'SHARED_HASH_THEN_MANUAL') creativePlan.checks.push({ level: 'WARN', field: 'image', detail: `الصورة ${mi.sourceHash?.slice(0, 10)}…: مافيش رابط مصدر — هيُجرَّب نفس الـ hash؛ لو فشل → رفع يدوي.` });
        const convDomain = (() => {
          const host = norm.destinationUrl ? hostOf(norm.destinationUrl) : null;
          if (!salesish) return { status: 'NOT_REQUIRED', domain: host };
          if (host) return { status: 'DERIVED', domain: host, note: 'سيُشتق من رابط الوجهة؛ راجعه قبل التفعيل.' };
          return { status: 'REQUIRED_MANUAL', domain: null, note: 'إعلان مبيعات بدون رابط وجهة — لازم تحدد نطاق التحويل قبل التفعيل.' };
        })();
        const readiness = overallReadiness({ creativePlan, identity, pixel });
        const simple = simplifyCopy({ readiness, creativePlan, identity, pixel, convDomain });
        adPlans.push({
          adId: ad.id, adName: ad.name, adStatus: ad.status,
          transferMode: creativePlan.mode,
          copyStatus: simple.copyStatus,     // READY | NEEDS_MAPPING | CANNOT_COPY
          assetAction: simple.assetAction,   // REUSE | REUPLOAD | REUSE_OR_MANUAL | NONE
          copyReasons: simple.copyReasons,
          normalized: {
            format: norm.format, body: norm.body?.slice(0, 220) || null, title: norm.title, description: norm.description,
            ctaType: norm.ctaType, destinationUrl: norm.destinationUrl, displayLink: norm.displayLink,
            objectStoryId: norm.objectStoryId, hasObjectStorySpec: norm.hasObjectStorySpec, assetFeedIsStub: norm.assetFeedIsStub,
            imageCount: norm.images.length, videoCount: norm.videos.length, carouselCards: norm.carouselCards.length,
          },
          identity, pixel,
          media: creativePlan.media,
          conversionDomain: convDomain,
          checks: creativePlan.checks,
          readiness,
        });
      }
      const tally = adPlans.reduce((a, p) => { a[p.readiness] = (a[p.readiness] || 0) + 1; return a; }, {});
      const modes = adPlans.reduce((a, p) => { a[p.transferMode] = (a[p.transferMode] || 0) + 1; return a; }, {});
      // Plain 3-state roll-up (the "Duplicate to another account" view).
      const copySummary = {
        totalAds: adPlans.length,
        ready: adPlans.filter((p) => p.copyStatus === 'READY').length,
        needsMapping: adPlans.filter((p) => p.copyStatus === 'NEEDS_MAPPING').length,
        cannotCopy: adPlans.filter((p) => p.copyStatus === 'CANNOT_COPY').length,
      };
      const copyableAds = copySummary.ready + copySummary.needsMapping;
      results.push({
        campaignId: cid, campaignName: cd.campaign.name,
        objective: cd.campaign.objective, buyingType: cd.campaign.buying_type,
        budgetMode: (cd.campaign.daily_budget || cd.campaign.lifetime_budget) ? 'CBO' : 'ABO',
        destinationAccountId: d, destinationAccountName: destAcct.name,
        adSetCount: cd.adsets.length, adCount: cd.ads.length,
        copySummary,
        copyableAds,
        canCopyCompletely: copySummary.cannotCopy === 0 && copySummary.needsMapping === 0,
        copyStatus: copyableAds === 0 ? 'CANNOT_COPY' : copySummary.needsMapping || copySummary.cannotCopy ? 'NEEDS_MAPPING' : 'READY',
        readiness: adPlans.every((p) => p.readiness === 'UNSUPPORTED') ? 'UNSUPPORTED'
          : adPlans.some((p) => ['NEEDS_IDENTITY_MAPPING', 'NEEDS_PIXEL_MAPPING', 'NEEDS_MANUAL_MEDIA', 'UNSUPPORTED'].includes(p.readiness)) ? 'NEEDS_INPUT' : 'READY_WITH_REBUILD',
        tally, transferModes: modes,
        identityRequired: {
          pages: [...new Set(adPlans.map((p) => p.identity?.sourcePageId).filter(Boolean))],
          instagram: [...new Set(adPlans.map((p) => p.identity?.sourceInstagramId).filter(Boolean))],
        },
        pixelRequired: [...new Set(adPlans.map((p) => p.pixel?.sourcePixelId).filter(Boolean))],
        destinationIdentities: { pages: di.identities.pages, instagram: di.identities.instagram, pagesVerified: di.identities.pagesVerified, instagramReadable: di.identities.instagramReadable },
        destinationPixels: di.assets.pixels || [],
        ads: adPlans,
      });
    }
  }

  const totals = results.reduce((a, c) => {
    const cs = c.copySummary || { ready: 0, needsMapping: 0, cannotCopy: 0 };
    a.campaigns++; a.adSets += c.adSetCount || 0; a.ads += c.adCount || 0;
    a.ready += cs.ready || 0; a.needsMapping += cs.needsMapping || 0; a.cannotCopy += cs.cannotCopy || 0;
    if (c.copyStatus === 'CANNOT_COPY') a.campaignsCannotCopy++;
    return a;
  }, { campaigns: 0, adSets: 0, ads: 0, ready: 0, needsMapping: 0, cannotCopy: 0, campaignsCannotCopy: 0 });

  return {
    source: { id: sourceAccountId, name: acctById.get(sourceAccountId)?.name || sourceAccountId },
    destinations: dests.map((d) => ({ id: d, name: acctById.get(d)?.name || d })),
    overallCopySummary: totals,
    metaDuplicationNote: 'Meta Marketing API لا توفر endpoint لنسخ حملة من حساب إعلاني لآخر (زر Duplicate في Ads Manager ينسخ داخل نفس الحساب فقط). النسخ عبر الحسابات يتم بإعادة إنشاء الحملة/المجموعات/الإعلانات بنفس الإعدادات، وإنشاء كائن AdCreative في الحساب الوجهة يحمل نفس النص/العنوان/الوسائط/الرابط/الـ CTA — نسخة حرفية، بلا أي تعديل أو ذكاء اصطناعي.',
    appModeWarning: 'إنشاء الإعلانات على Meta يتطلب أن يكون تطبيق Meta في وضع Live مع Advanced Access لـ ads_management. هذا التحليل قراءة فقط ولا يتأثر بذلك.',
    campaigns: results,
  };
}
