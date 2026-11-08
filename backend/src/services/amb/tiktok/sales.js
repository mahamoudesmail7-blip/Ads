// TikTok «Sales» campaigns — the foundation for the modern Sales objective and Smart+ (PREVIEW ONLY: nothing here talks to TikTok, nothing is created).
// What is known (TikTok's v1.3 docs): Ads Manager's «Website conversions» is the API's «Sales» objective with sales destination WEBSITE; the older WEB_CONVERSIONS objective_type is still accepted on /campaign/create;
// Smart+ web campaigns are Sales + Website with Smart+ switched on and work best with a Pixel (+ Events API), broad targeting and ≥ 6 creatives. The exact «upgraded Smart+» endpoint names / enums could not be
// confirmed from the public pages (they are rendered client-side), so Smart+ is exposed as a READINESS report + the Sales payload variants below, and its create call is NOT wired until it is verified on a sandbox advertiser.
import { OBJECTIVES, EVENTS, LIMITS } from './spec.js';
import { normalizeConfig, buildCampaignPayload, buildAdGroupPayload, buildAdPayload } from './builder.js';

export const SALES_VARIANTS = {
  LEGACY_WEB_CONVERSIONS: { label: 'WEB_CONVERSIONS (الصيغة المستخدمة حاليًا)', campaignPatch: {} },
  SALES_WEBSITE: { label: 'SALES + sales_destination=WEBSITE (الصيغة الأحدث)', campaignPatch: { objective_type: 'SALES', sales_destination: 'WEBSITE' } },
};
export const SMART_PLUS_MIN_CREATIVES = 6;

/** Is this config a Smart+-style Sales campaign candidate, and what is missing? Plain Arabic. */
export function smartPlusReadiness(raw) {
  const c = normalizeConfig(raw); const o = OBJECTIVES[c.objective]; const items = []; const add = (key, ok, text) => items.push({ key, ok, text });
  add('sales', c.objective === 'CONVERSIONS', 'الهدف «مبيعات على الموقع» (Sales + Website).');
  add('pixel', !!c.pixelId, 'Pixel مربوط بالحملة (ضروري لتحسين المبيعات).');
  add('event', !!c.event && !!EVENTS[c.event], 'حدث التحسين مختار (إتمام الطلب).');
  add('landing', /^https:\/\//.test(c.landingUrl || ''), 'لينك صفحة المنتج https.');
  add('creatives', c.videos.length * c.adsPerVideo >= SMART_PLUS_MIN_CREATIVES, `${SMART_PLUS_MIN_CREATIVES} كريتيف أو أكتر (تيك توك بتوصي بيها لـ Smart+) — عندك ${c.videos.length * c.adsPerVideo}.`);
  add('broad', c.ageGroups.length >= 4 && !c.interestIds.length, 'استهداف واسع (أعمار كتير ومن غير اهتمامات) عشان Smart+ يلاقي الجمهور لوحده.');
  add('budget', Number(c.dailyBudget) > 0, 'ميزانية يومية محددة.');
  const required = ['sales', 'pixel', 'event', 'landing', 'budget'];
  return { eligible: !!o && required.every((k) => items.find((i) => i.key === k)?.ok), recommendedOk: items.every((i) => i.ok), items, note: 'Smart+ بيتفعّل من تيك توك نفسها للحملات اللي بالمواصفات دي. طلب إنشاء Smart+ المخصوص لسه مش موصول هنا لحد ما نتأكد من شكله الرسمي على حساب تجريبي.' };
}

/** The exact request bodies a launch would send — built with placeholder ids, never sent. Both Sales variants for the campaign. */
export function previewPayloads(raw, { advertiserId = '<ADVERTISER_ID>', timeZone = 'Africa/Cairo', now = new Date() } = {}) {
  const c = normalizeConfig(raw); const base = buildCampaignPayload(c, { advertiserId });
  const variants = Object.fromEntries(Object.entries(SALES_VARIANTS).map(([k, v]) => [k, { label: v.label, campaign: { ...base, ...v.campaignPatch } }]));
  const adgroup = buildAdGroupPayload(c, { advertiserId, campaignId: '<CAMPAIGN_ID>', timeZone, now });
  const uploads = c.videos.map((v, i) => ({ videoId: `<VIDEO_ID_${i + 1}>`, coverImageId: `<COVER_ID_${i + 1}>`, name: v.name || `فيديو ${i + 1}` }));
  const ads = buildAdPayload(c, { advertiserId, adgroupId: '<ADGROUP_ID>', identityId: '<IDENTITY_ID>', uploads });
  return { variants, adgroup, ads, writesSent: 0 };
}
export const MAX_ADS = LIMITS.maxAdsPerGroup;
