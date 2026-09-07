// AI Media Buyer — Campaign Clone pre-flight validation. PURE (no network):
// given one source campaign's already-read tree, its already-resolved source
// assets, and one destination account's already-listed inventory, it decides
// whether that (campaign → destination) clone is READY / WARNING / BLOCKED
// and lists exactly why.
//
// Hard rule from the spec: never silently replace or drop an unavailable
// asset. If a required Page / Pixel / Custom Audience / Catalog / image /
// video cannot be provided in the destination, the clone is BLOCKED with the
// exact reason — it is not cloned. WARNING means "clone it, but a human
// should look" (e.g. an asset we could not verify, or a special ad category).

/** whitespace/underscore/hyphen-insensitive, case-insensitive name key */
function nameKey(s) {
  return String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** Collect every {id,name} custom audience referenced anywhere in a targeting spec. */
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
 * @param {{campaign:object, adsets:object[], ads:object[], creatives:Map<string,object>}} p.tree source campaign tree
 * @param {{imageUrls:Object<string,string>, videoSources:Object<string,string|null>}} p.sourceAssets resolved re-upload sources
 * @param {{account:object|null, pages:{id,name}[], instagram:{id,username}[], pixels:{id,name}[], customAudiences:{id,name}[], catalogs:{id,name}[]}} p.destAssets
 * @returns {{status:'READY'|'WARNING'|'BLOCKED', checks:{name,status,detail}[], required:object, resolved:object}}
 */
export function preflightCampaignForDestination({ tree, sourceAssets, destAssets }) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const { campaign, adsets = [], ads = [], creatives = new Map() } = tree || {};
  const da = destAssets || {};
  const destPageIds = new Set((da.pages || []).map((x) => String(x.id)));
  const destIgIds = new Set((da.instagram || []).map((x) => String(x.id)));
  const destPixelIds = new Set((da.pixels || []).map((x) => String(x.id)));
  const destCatalogIds = new Set((da.catalogs || []).map((x) => String(x.id)));
  const destAudByName = new Map((da.customAudiences || []).map((x) => [nameKey(x.name), String(x.id)]));

  const required = { pages: [], instagram: [], pixels: [], audiences: [], catalogs: [], images: [], videos: [] };
  const resolved = { pageIds: [], igIds: [], imageUrls: {}, videoSources: {}, audienceRemap: {}, unmatchedAudiences: [] };

  // 1) Destination account usable.
  if (!da.account) {
    add('حساب الوجهة', 'WARN', 'تعذّر قراءة حالة الحساب الإعلاني الوجهة — سيتم المتابعة بحذر.');
  } else if (Number(da.account.status) !== 1) {
    add('حساب الوجهة', 'BLOCK', `الحساب الإعلاني الوجهة غير نشط (account_status=${da.account.status}).`);
  } else {
    add('حساب الوجهة', 'INFO', `${da.account.name || da.account.id} — نشط.`);
  }

  // 2) Special ad categories (copied verbatim; flag because targeting may be restricted).
  const sac = campaign?.special_ad_categories || [];
  if (Array.isArray(sac) && sac.length && !(sac.length === 1 && sac[0] === 'NONE')) {
    add('فئة إعلانية خاصة', 'WARN', `الحملة ضمن فئة خاصة (${sac.join(', ')}) — سيتم نسخها كما هي وقد تُقيّد Meta الاستهداف في الحساب الوجهة.`);
  }

  // 3) Facebook Pages referenced by the creatives.
  const pageIds = new Set();
  const igIds = new Set();
  for (const cr of creatives.values()) {
    const oss = cr.object_story_spec || {};
    if (oss.page_id) pageIds.add(String(oss.page_id));
    const ig = oss.instagram_user_id || oss.instagram_actor_id || cr.instagram_user_id;
    if (ig) igIds.add(String(ig));
  }
  for (const pid of pageIds) {
    required.pages.push(pid);
    resolved.pageIds.push(pid);
    if (destPageIds.size === 0) add('صفحة فيسبوك', 'WARN', `تعذّر التحقق من إتاحة صفحة فيسبوك (${pid}) في الحساب الوجهة.`);
    else if (!destPageIds.has(pid)) add('صفحة فيسبوك', 'BLOCK', `صفحة فيسبوك (${pid}) غير متاحة للنشر من الحساب الوجهة.`);
    else add('صفحة فيسبوك', 'INFO', `صفحة فيسبوك (${pid}) متاحة.`);
  }
  for (const ig of igIds) {
    required.instagram.push(ig);
    resolved.igIds.push(ig);
    if (destIgIds.size === 0) add('حساب انستجرام', 'WARN', `تعذّر التحقق من حساب انستجرام (${ig}) في الحساب الوجهة.`);
    else if (!destIgIds.has(ig)) add('حساب انستجرام', 'BLOCK', `حساب انستجرام (${ig}) غير مرتبط بالحساب الوجهة.`);
    else add('حساب انستجرام', 'INFO', `حساب انستجرام (${ig}) متاح.`);
  }

  // 4) Pixel / dataset + catalog from every ad set's promoted_object (deduped —
  //    many ad sets in one campaign share the same pixel).
  const seenPixel = new Set();
  const seenCatalog = new Set();
  for (const as of adsets) {
    const po = as.promoted_object || {};
    if (po.pixel_id && !seenPixel.has(String(po.pixel_id))) {
      const pid = String(po.pixel_id);
      seenPixel.add(pid);
      required.pixels.push(pid);
      if (destPixelIds.size === 0) add('Pixel / Dataset', 'WARN', `تعذّر التحقق من Pixel (${pid}) في الحساب الوجهة.`);
      else if (!destPixelIds.has(pid)) add('Pixel / Dataset', 'BLOCK', `Pixel/Dataset (${pid}) غير متاح في الحساب الوجهة — لن يُستبدل.`);
      else add('Pixel / Dataset', 'INFO', `Pixel (${pid}) متاح.`);
    }
    if (po.product_catalog_id && !seenCatalog.has(String(po.product_catalog_id))) {
      const cid = String(po.product_catalog_id);
      seenCatalog.add(cid);
      required.catalogs.push(cid);
      if (destCatalogIds.size === 0) add('كتالوج', 'WARN', `تعذّر التحقق من الكتالوج (${cid}) في الحساب الوجهة.`);
      else if (!destCatalogIds.has(cid)) add('كتالوج', 'BLOCK', `الكتالوج (${cid}) غير متاح في الحساب الوجهة.`);
      else add('كتالوج', 'INFO', `الكتالوج (${cid}) متاح.`);
    }
  }
  // product_set_id on a creative — we can only see catalogs, so flag it once.
  const seenPS = new Set();
  for (const cr of creatives.values()) {
    if (cr.product_set_id && !seenPS.has(cr.product_set_id)) {
      seenPS.add(cr.product_set_id);
      add('مجموعة منتجات', 'WARN', `الكرياتيف يستخدم Product Set (${cr.product_set_id}) — تأكد من وجود نفس الكتالوج/المجموعة في الحساب الوجهة.`);
    }
  }

  // 5) Custom audiences — matched by NAME across accounts (ids differ). No match ⇒ BLOCK.
  const seenAud = new Set();
  for (const as of adsets) {
    for (const a of audiencesInTargeting(as.targeting)) {
      if (seenAud.has(a.id)) continue;
      seenAud.add(a.id);
      required.audiences.push({ id: a.id, name: a.name });
      if (!a.name) { add('جمهور مخصص', 'BLOCK', `جمهور مخصص (${a.id}) بدون اسم يمكن مطابقته في الحساب الوجهة.`); resolved.unmatchedAudiences.push(a.id); continue; }
      const hit = destAudByName.get(nameKey(a.name));
      if (hit) { resolved.audienceRemap[a.id] = hit; add('جمهور مخصص', 'INFO', `«${a.name}» → (${hit}) في الحساب الوجهة.`); }
      else if (destAudByName.size === 0) { add('جمهور مخصص', 'WARN', `تعذّر التحقق من الجماهير المخصصة في الحساب الوجهة («${a.name}»).`); resolved.unmatchedAudiences.push(a.id); }
      else { add('جمهور مخصص', 'BLOCK', `الجمهور المخصص «${a.name}» غير موجود في الحساب الوجهة — لن يُحذف أو يُستبدل.`); resolved.unmatchedAudiences.push(a.id); }
    }
  }

  // 6) Creative images — need a URL to re-upload into the destination account.
  const imgHashes = new Set();
  const vidIds = new Set();
  for (const cr of creatives.values()) {
    const oss = cr.object_story_spec || {};
    const link = oss.link_data || {};
    const vid = oss.video_data || {};
    if (cr.image_hash) imgHashes.add(cr.image_hash);
    if (link.image_hash) imgHashes.add(link.image_hash);
    for (const ch of link.child_attachments || []) if (ch.image_hash) imgHashes.add(ch.image_hash);
    for (const im of cr.asset_feed_spec?.images || []) if (im.hash) imgHashes.add(im.hash);
    if (cr.video_id) vidIds.add(String(cr.video_id));
    if (vid.video_id) vidIds.add(String(vid.video_id));
    for (const v of cr.asset_feed_spec?.videos || []) if (v.video_id) vidIds.add(String(v.video_id));
  }
  const srcImgUrls = sourceAssets?.imageUrls || {};
  const srcVidUrls = sourceAssets?.videoSources || {};
  let imgOk = 0;
  let vidOk = 0;
  for (const h of imgHashes) {
    required.images.push(h);
    const url = srcImgUrls[h] || null;
    if (url) { resolved.imageUrls[h] = url; imgOk++; }
    else add('صورة الكرياتيف', 'BLOCK', `تعذّر الوصول لملف الصورة المصدر (${h.slice(0, 12)}…) لإعادة رفعها في الحساب الوجهة.`);
  }
  if (imgOk) add('صور الكرياتيف', 'INFO', `${imgOk} صورة سيُعاد رفعها إلى الحساب الوجهة.`);
  for (const v of vidIds) {
    required.videos.push(v);
    const url = srcVidUrls[v] || null;
    if (url) { resolved.videoSources[v] = url; vidOk++; }
    else add('فيديو الكرياتيف', 'BLOCK', `الفيديو (${v}) — Meta لا تتيح تنزيله عبر الـ API لإعادة رفعه في حساب آخر (قد يلزم مشاركة الأصول على مستوى Business Manager).`);
  }
  if (vidOk) add('فيديوهات الكرياتيف', 'INFO', `${vidOk} فيديو سيُعاد رفعه إلى الحساب الوجهة.`);

  // 7) Conversion domain (Meta increasingly rejects sales ads without it on activation).
  const salesish = /SALES|CONVERSION|OUTCOME_SALES|PRODUCT_CATALOG_SALES/i.test(campaign?.objective || '');
  if (salesish) {
    const missing = ads.filter((ad) => !ad.conversion_domain).length;
    if (missing) add('نطاق التحويل', 'WARN', `${missing} إعلان بدون conversion_domain — قد ترفض Meta التفعيل حتى يُضبط.`);
  }

  const hasBlock = checks.some((c) => c.status === 'BLOCK');
  const hasWarn = checks.some((c) => c.status === 'WARN');
  const status = hasBlock ? 'BLOCKED' : hasWarn ? 'WARNING' : 'READY';
  return { status, checks, required, resolved };
}
