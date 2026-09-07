// AI Media Buyer — Campaign Clone pre-flight. PURE (no network): given one
// source campaign's already-read tree, its already-resolved source assets,
// one destination account's already-listed inventory, and (optionally) the
// Media Asset Library's destination hints, it reports whether that
// (campaign → destination) clone is READY / WARNING / BLOCKED and why.
//
// Pre-flight is ADVISORY for assets. It does NOT decide media/page/pixel
// BLOCKs from local id lists alone — a Business-Portfolio-shared asset is
// often usable without appearing in a per-account edge. The clone engine is
// the source of truth: it tries, in order, (1) an asset already in the
// destination, (2) a shared Meta asset referenced directly, (3) a Media
// Library destination mapping, (4) re-upload, and only BLOCKs the job when
// every path fails or Meta explicitly rejects the asset.
//
// So here:
//   INFO    — verified available (in the destination account's own list, or
//             the Media Library already has a destination mapping)
//   WARN    — not verifiable locally; the engine will attempt reuse → shared
//             reference → library → re-upload
//   BLOCK   — the destination account is disabled, or a creative genuinely
//             cannot be cloned (boosted existing post / no spec)

function nameKey(s) { return String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, ''); }

function audiencesInTargeting(t) {
  const out = [];
  if (!t || typeof t !== 'object') return out;
  for (const key of ['custom_audiences', 'excluded_custom_audiences']) {
    for (const a of t[key] || []) if (a && a.id) out.push({ id: String(a.id), name: a.name || null, excluded: key.startsWith('excluded') });
  }
  return out;
}

/**
 * @param {object} p
 * @param {{campaign,adsets,ads,creatives:Map}} p.tree
 * @param {{imageUrls,videoSources}} p.sourceAssets
 * @param {{account,pages,instagram,pixels,customAudiences,catalogs}} p.destAssets
 * @param {Map<string,{assetId:number|null, reuseImageHashes:Set<string>, videoBySrc:Map<string,string>}>} [p.libraryHintsByCreative]
 * @param {string|null} [p.pageIdOverride] post cloned ads as this destination page
 * @param {boolean} [p.recreateBoosted] recreate boosted-post creatives as fresh ads on pageIdOverride
 */
export function preflightCampaignForDestination({ tree, sourceAssets, destAssets, libraryHintsByCreative, pageIdOverride = null, recreateBoosted = false }) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const { campaign, adsets = [], ads = [], creatives = new Map() } = tree || {};
  const da = destAssets || {};
  const destPageIds = new Set((da.pages || []).map((x) => String(x.id)));
  const destIgIds = new Set((da.instagram || []).map((x) => String(x.id)));
  const destPixelIds = new Set((da.pixels || []).map((x) => String(x.id)));
  const destCatalogIds = new Set((da.catalogs || []).map((x) => String(x.id)));
  const destAudByName = new Map((da.customAudiences || []).map((x) => [nameKey(x.name), String(x.id)]));
  const lib = libraryHintsByCreative || new Map();
  const libVals = [...lib.values()];

  const required = { pages: [], instagram: [], pixels: [], audiences: [], catalogs: [], images: [], videos: [] };
  const resolved = { pageIds: [], igIds: [], imageUrls: {}, videoSources: {}, audienceRemap: {}, unmatchedAudiences: [] };

  // 1) Destination account usable — the ONE hard infra BLOCK.
  if (!da.account) add('حساب الوجهة', 'WARN', 'تعذّر قراءة حالة الحساب الإعلاني الوجهة — سيتم المتابعة بحذر.');
  else if (Number(da.account.status) !== 1) add('حساب الوجهة', 'BLOCK', `الحساب الإعلاني الوجهة غير نشط (account_status=${da.account.status}).`);
  else add('حساب الوجهة', 'INFO', `${da.account.name || da.account.id} — نشط.`);

  // 2) Special ad categories (copied verbatim; targeting may be restricted).
  const sac = campaign?.special_ad_categories || [];
  if (Array.isArray(sac) && sac.length && !(sac.length === 1 && sac[0] === 'NONE')) {
    add('فئة إعلانية خاصة', 'WARN', `الحملة ضمن فئة خاصة (${sac.join(', ')}) — تُنسخ كما هي وقد تُقيّد Meta الاستهداف في الحساب الوجهة.`);
  }

  // 3) Pages / Instagram identities referenced by the creatives. "In the
  //    destination account's own list" ⇒ verified (INFO). Not in it ⇒ WARN
  //    (may be shared via the Business Portfolio; the ad create is the real
  //    test) — never a BLOCK from a local id list.
  const pageIds = new Set();
  const igIds = new Set();
  for (const cr of creatives.values()) {
    const oss = cr.object_story_spec || {};
    if (oss.page_id) pageIds.add(String(oss.page_id));
    const ig = oss.instagram_user_id || oss.instagram_actor_id || cr.instagram_user_id;
    if (ig) igIds.add(String(ig));
  }
  for (const pid of pageIds) {
    required.pages.push(pid); resolved.pageIds.push(pid);
    if (destPageIds.has(pid)) add('صفحة فيسبوك', 'INFO', `صفحة فيسبوك (${pid}) متاحة للنشر من الحساب الوجهة.`);
    else add('صفحة فيسبوك', 'WARN', `صفحة فيسبوك (${pid}) مش ظاهرة في قائمة الحساب الوجهة — غالبًا متاحة عبر Business Portfolio؛ إنشاء الإعلان هو الاختبار الفعلي.`);
  }
  for (const ig of igIds) {
    required.instagram.push(ig); resolved.igIds.push(ig);
    if (destIgIds.has(ig)) add('حساب انستجرام', 'INFO', `حساب انستجرام (${ig}) متاح للحساب الوجهة.`);
    else add('حساب انستجرام', 'WARN', `حساب انستجرام (${ig}) مش ظاهر في قائمة الحساب الوجهة — قد يكون متاحًا عبر Business Portfolio.`);
  }

  // 4) Pixel / catalog from promoted_object.
  const seenPixel = new Set();
  const seenCatalog = new Set();
  for (const as of adsets) {
    const po = as.promoted_object || {};
    if (po.pixel_id && !seenPixel.has(String(po.pixel_id))) {
      const pid = String(po.pixel_id); seenPixel.add(pid); required.pixels.push(pid);
      if (destPixelIds.has(pid)) add('Pixel / Dataset', 'INFO', `Pixel (${pid}) متاح في الحساب الوجهة.`);
      else add('Pixel / Dataset', 'WARN', `Pixel/Dataset (${pid}) مش ظاهر في قائمة الحساب الوجهة — قد يكون مشتركًا عبر Business Portfolio؛ إنشاء المجموعة الإعلانية هو الاختبار الفعلي. لن يُستبدل بأي حال.`);
    }
    if (po.product_catalog_id && !seenCatalog.has(String(po.product_catalog_id))) {
      const cid = String(po.product_catalog_id); seenCatalog.add(cid); required.catalogs.push(cid);
      if (destCatalogIds.has(cid)) add('كتالوج', 'INFO', `الكتالوج (${cid}) متاح في الحساب الوجهة.`);
      else add('كتالوج', 'WARN', `الكتالوج (${cid}) مش ظاهر في قائمة الحساب الوجهة — قد يكون مشتركًا عبر Business Portfolio.`);
    }
  }
  const seenPS = new Set();
  for (const cr of creatives.values()) {
    if (cr.product_set_id && !seenPS.has(cr.product_set_id)) {
      seenPS.add(cr.product_set_id);
      add('مجموعة منتجات', 'WARN', `الكرياتيف يستخدم Product Set (${cr.product_set_id}) — تأكد من وجود نفس الكتالوج/المجموعة في الحساب الوجهة.`);
    }
  }

  // 5) Custom audiences — remapped by NAME across accounts (ids differ). A
  //    name match ⇒ remap (INFO). No match ⇒ WARN: the original id is kept
  //    (never silently dropped); if it turns out invalid the ad-set create
  //    fails loudly and is resumable — it is not a pre-flight BLOCK.
  const seenAud = new Set();
  for (const as of adsets) {
    for (const a of audiencesInTargeting(as.targeting)) {
      if (seenAud.has(a.id)) continue;
      seenAud.add(a.id);
      required.audiences.push({ id: a.id, name: a.name });
      const hit = a.name ? destAudByName.get(nameKey(a.name)) : null;
      if (hit) { resolved.audienceRemap[a.id] = hit; add('جمهور مخصص', 'INFO', `«${a.name}» → (${hit}) في الحساب الوجهة.`); }
      else {
        resolved.unmatchedAudiences.push(a.id);
        add('جمهور مخصص', 'WARN', a.name
          ? `الجمهور المخصص «${a.name}» مالوش نظير بالاسم في الحساب الوجهة — هيُحتفظ بالـ id الأصلي؛ لو مشترك عبر Business Portfolio هيشتغل، وإلا هتفشل المجموعة الإعلانية بوضوح (قابلة للاستئناف).`
          : `جمهور مخصص (${a.id}) بدون اسم للمطابقة — هيُحتفظ بالـ id الأصلي.`);
      }
    }
  }

  // 6) Creatives — structural checks, page-override aware.
  for (const [cid, cr] of creatives) {
    if (!cr || cr.__error) continue;
    const boosted = !!cr.object_story_id && !cr.object_story_spec && !cr.asset_feed_spec;
    const hasMedia = !!(cr.video_id || cr.image_hash || cr.image_url);
    if (boosted) {
      // A boosted organic post is REBUILD_FROM_SPEC: the underlying text /
      // media are reconstructed onto a destination identity. This is never a
      // global BLOCK — it's a per-ad "needs a destination page/identity" that
      // the identity-mapping step resolves.
      if (pageIdOverride) add('كرياتيف', 'WARN', `الكرياتيف (${cid}) منشور مروّج (object_story_id) — هيُعاد بناؤه ككرياتيف جديد على الهوية الوجهة (فقدان التفاعل العضوي للمنشور الأصلي).`);
      else if (hasMedia || cr.body || cr.title) add('كرياتيف', 'WARN', `الكرياتيف (${cid}) منشور مروّج (object_story_id) — قابل لإعادة البناء؛ اختر صفحة وجهة في خطوة ربط الهوية.`);
      else add('كرياتيف', 'BLOCK', `الكرياتيف (${cid}) منشور مروّج بدون نص/عنوان/وسائط يمكن استخراجها — غير مدعوم.`);
    } else if (!cr.object_story_spec && cr.asset_feed_spec) {
      const pg = pageIdOverride || cr.object_story_spec?.page_id;
      if (!pg) add('كرياتيف', 'WARN', `الكرياتيف (${cid}) من نوع Advantage+ (asset_feed_spec) بدون page_id — لازم تحدّد صفحة وجهة (destination_page_id) وإلا هيفشل إنشاء الكرياتيف.`);
    } else if (!cr.object_story_spec && !cr.asset_feed_spec) {
      if (!hasMedia) add('كرياتيف', 'BLOCK', `الكرياتيف (${cid}) بلا object_story_spec/asset_feed_spec ولا وسائط قابلة لإعادة البناء.`);
      else if (!pageIdOverride && !cr.object_story_id && !cr.actor_id) add('كرياتيف', 'WARN', `الكرياتيف (${cid}) مسطّح بدون صفحة يمكن استنتاجها — حدّد صفحة وجهة.`);
      else if (!pageIdOverride) add('كرياتيف', 'WARN', `الكرياتيف (${cid}) هيُعاد بناؤه؛ يُفضّل تحديد صفحة وجهة صريحة بدل استنتاجها من object_story_id.`);
    }
  }

  // 6b) Media — reuse-first, never a pre-flight BLOCK. The engine tries:
  //     existing dest asset → shared Meta asset (same hash / same video_id) →
  //     Media Library mapping → re-upload → BLOCK.
  const imgHashes = new Set();
  const vidIds = new Set();
  for (const cr of creatives.values()) {
    const oss = cr.object_story_spec || {};
    const link = oss.link_data || {};
    const vid = oss.video_data || {};
    for (const h of [cr.image_hash, link.image_hash, vid.image_hash]) if (h) imgHashes.add(h);
    for (const ch of link.child_attachments || []) { if (ch.image_hash) imgHashes.add(ch.image_hash); if (ch.video_id) vidIds.add(String(ch.video_id)); }
    for (const im of cr.asset_feed_spec?.images || []) if (im.hash) imgHashes.add(im.hash);
    for (const v of [cr.video_id, vid.video_id]) if (v) vidIds.add(String(v));
    for (const v of cr.asset_feed_spec?.videos || []) if (v.video_id) vidIds.add(String(v.video_id));
  }
  const srcImgUrls = sourceAssets?.imageUrls || {};
  const srcVidUrls = sourceAssets?.videoSources || {};
  for (const h of imgHashes) {
    required.images.push(h);
    if (srcImgUrls[h]) resolved.imageUrls[h] = srcImgUrls[h];
    const inLib = libVals.some((x) => x.reuseImageHashes?.has(h));
    if (inLib) add('صورة الكرياتيف', 'INFO', `الصورة (${h.slice(0, 10)}…) متاحة في الحساب الوجهة (المكتبة) — إعادة استخدام مباشرة.`);
    else add('صورة الكرياتيف', 'WARN', `الصورة (${h.slice(0, 10)}…) — هيُجرَّب: نفس الـ hash (محتوى مشترك) → المكتبة${srcImgUrls[h] ? ' → إعادة رفع' : ''}.`);
  }
  for (const v of vidIds) {
    required.videos.push(v);
    if (srcVidUrls[v]) resolved.videoSources[v] = srcVidUrls[v];
    const libV = libVals.map((x) => x.videoBySrc?.get(v)).find(Boolean);
    if (libV) add('فيديو الكرياتيف', 'INFO', `الفيديو (${v}) له نسخة في الحساب الوجهة (${libV}) — إعادة استخدام.`);
    else add('فيديو الكرياتيف', 'WARN', `الفيديو (${v}) — هيُجرَّب بالترتيب: نسخة موجودة بالوجهة → مرجع مشترك (نفس video_id عبر Business Portfolio) → المكتبة${srcVidUrls[v] ? ' → إعادة رفع' : ''}. لن يُحجب إلا لو فشلت كل الطرق.`);
  }

  // 7) Conversion domain (Meta often rejects sales ads without it on activation).
  const salesish = /SALES|CONVERSION|OUTCOME_SALES|PRODUCT_CATALOG_SALES/i.test(campaign?.objective || '');
  if (salesish) {
    const missing = ads.filter((ad) => !ad.conversion_domain).length;
    if (missing) add('نطاق التحويل', 'WARN', `${missing} إعلان بدون conversion_domain — قد ترفض Meta التفعيل حتى يُضبط.`);
  }

  const hasBlock = checks.some((c) => c.status === 'BLOCK');
  const hasWarn = checks.some((c) => c.status === 'WARN');
  return { status: hasBlock ? 'BLOCKED' : hasWarn ? 'WARNING' : 'READY', checks, required, resolved };
}
