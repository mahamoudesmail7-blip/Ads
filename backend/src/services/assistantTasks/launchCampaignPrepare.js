// AI Media Buyer Operator — Phase 2 Slice 2. Campaign-creation-from-chat
// prepare logic. Genuinely new business logic is narrow and isolated here:
// everything else is a thin call into existing, unmodified
// services/amb/launchBuilder.js functions (getLaunchAccountAssets,
// searchLaunchGeoLocations, createDraftJob, getJob) — this file never
// re-implements Meta discovery/validation/creation, it only decides WHAT to
// call them with from a chat-extracted set of fields, refusing to guess
// whenever a choice is genuinely ambiguous (matching validateLaunchConfig's
// own stance: "the human picks it explicitly... never inferred").
import { prisma } from '../../prisma.js';
import { getConnection } from '../metaAuth.js';
import { getLaunchAccountAssets, searchLaunchGeoLocations, createDraftJob, getJob } from '../amb/launchBuilder.js';

/** Loops one real Meta geo-search call per governorate name and merges the best match for each — the one genuinely new piece of targeting logic (resolveRealTargeting in productDecisionExecution.js is single-governorate by design and shouldn't be repurposed). Never silently drops a name that fails to resolve. */
export async function resolveMultiGeoTargeting(names) {
  const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.trim()) : [];
  if (!list.length) return { ok: true, geoRegions: [] };
  const results = await Promise.all(list.map((n) => searchLaunchGeoLocations(n).catch(() => [])));
  const merged = [];
  const seenKeys = new Set();
  for (let i = 0; i < list.length; i++) {
    const matches = results[i];
    const best = matches.find((m) => m.type === 'region' || m.type === 'city') || matches[0];
    if (!best) return { ok: false, unresolved: list[i] };
    if (!seenKeys.has(best.key)) { seenKeys.add(best.key); merged.push({ key: best.key, name: best.name }); }
  }
  return { ok: true, geoRegions: merged };
}

/** Real connected ad account — throws a friendly Arabic error if none, matching the pattern every other assistantTasks prepare fn uses. */
export async function requireAdAccount() {
  const connection = await getConnection();
  if (!connection || connection.status !== 'CONNECTED' || !connection.selected_ad_account_id) {
    const e = new Error('مفيش حساب إعلاني Meta متصل.'); e.status = 400; throw e;
  }
  return connection;
}

/** Case-insensitive substring match by name/username against a real discovered list — never a guess beyond "the user typed something that clearly identifies one real option." Returns null (not an error) when no override was given or nothing matched, so the caller falls back to auto-pick/ask. */
function matchByName(list, nameField, wanted) {
  if (!wanted || !Array.isArray(list) || !list.length) return null;
  const w = String(wanted).trim().toLowerCase();
  if (!w) return null;
  const exact = list.find((o) => String(o[nameField] || '').trim().toLowerCase() === w);
  if (exact) return exact;
  const partial = list.filter((o) => String(o[nameField] || '').toLowerCase().includes(w));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Resolves page/pixel/instagram for one ad account. `overrides` (page/pixel
 * names or an instagram username the user NAMED, e.g. after being asked
 * "فيه أكتر من صفحة — عايز تستخدم أنهي واحدة؟") are matched against the
 * real discovered list first; only when no override is given (or none) does
 * this fall back to auto-pick-if-sole-option, and only asks (never guesses)
 * when a choice is genuinely ambiguous. Returns either
 * {ok:true, pageId, pageName, pixelId, pixelName, instagramId, instagramUsername, platforms, timezone, adAccountName}
 * or {ok:false, needsInput: 'page'|'pixel'|'instagram', options:[...], message}
 * — the caller (prepare_campaign) turns the latter into a WAITING_FOR_INPUT task.
 */
export async function autoResolveAccountAssets(adAccountId, overrides = {}) {
  const assets = await getLaunchAccountAssets(adAccountId);

  let page = matchByName(assets.pages, 'name', overrides.pageName);
  if (!page) {
    if (!assets.pages?.length) return { ok: false, needsInput: 'page', message: 'مفيش صفحة فيسبوك متصلة بالحساب الإعلاني ده.' };
    if (assets.pages.length === 1) page = assets.pages[0];
    else return { ok: false, needsInput: 'page', options: assets.pages, message: overrides.pageName ? `مفيش صفحة اسمها "${overrides.pageName}" بالظبط — فيه أكتر من صفحة، عايز تستخدم أنهي واحدة؟` : 'فيه أكتر من صفحة — عايز تستخدم أنهي واحدة؟' };
  }

  let pixel = matchByName(assets.pixels, 'name', overrides.pixelName);
  if (!pixel) {
    if (!assets.pixels?.length) return { ok: false, needsInput: 'pixel', message: 'مفيش Meta Pixel متاح على الحساب الإعلاني ده.' };
    if (assets.pixels.length === 1) pixel = assets.pixels[0];
    else return { ok: false, needsInput: 'pixel', options: assets.pixels, message: overrides.pixelName ? `مفيش Pixel اسمه "${overrides.pixelName}" بالظبط — فيه أكتر من Pixel، عايز تستخدم أنهي واحد؟` : 'فيه أكتر من Pixel — عايز تستخدم أنهي واحد؟' };
  }

  let instagramId = null, instagramUsername = null, platforms = ['facebook'];
  const igMatch = matchByName(assets.instagram, 'username', overrides.instagramUsername);
  if (igMatch) {
    instagramId = igMatch.id; instagramUsername = igMatch.username; platforms = ['facebook', 'instagram'];
  } else if (assets.instagram?.length === 1) {
    instagramId = assets.instagram[0].id; instagramUsername = assets.instagram[0].username; platforms = ['facebook', 'instagram'];
  } else if (assets.instagram?.length > 1) {
    return { ok: false, needsInput: 'instagram', options: assets.instagram, message: overrides.instagramUsername ? `مفيش حساب إنستجرام اسمه "${overrides.instagramUsername}" بالظبط — فيه أكتر من حساب، عايز تستخدم أنهي واحد؟` : 'فيه أكتر من حساب إنستجرام — عايز تستخدم أنهي واحد؟' };
  }
  // 0 Instagram identities: fall back to Facebook-only, same graceful path the wizard itself uses — never blocks.

  return {
    ok: true,
    adAccountName: assets.account?.name || null,
    timezone: assets.account?.timezoneName || 'Africa/Cairo',
    pageId: page.id, pageName: page.name,
    pixelId: pixel.id, pixelName: pixel.name,
    instagramId, instagramUsername, platforms,
  };
}

/** Real, non-historical, active Product row — re-verified server-side exactly like validateLaunchConfig() does (never trusted from the model/context as-is). */
export async function resolveProduct(productId) {
  const pid = Number(productId);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const product = await prisma.product.findUnique({ where: { id: pid }, select: { id: true, product_name: true, active: true, is_historical: true, store_id: true } });
  if (!product || !product.active || product.is_historical) return null;
  return product;
}

export { createDraftJob, getJob };
