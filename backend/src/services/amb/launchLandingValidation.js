// Campaign Launch Builder — MANDATORY PRE-LAUNCH PRODUCT / LANDING VALIDATION.
// Before ANY campaign is created (at wizard review AND again at publish), every campaign's landing page is resolved — through the page's own embedded
// identity, never the domain — to a verified { store, product } and compared with the product the owner selected:
//   correct product ................................ OK
//   wrong product (same store / duplicate name) ..... BLOCK
//   wrong store ..................................... BLOCK
//   unknown URL / unreachable page / unverifiable ... BLOCK   (unresolved identity is a BLOCK, never a warning)
// The evidence is stored with the launch job (config_json.landingValidation) so Campaign Mapping can later treat "launch product + verified landing page
// agree" as the strongest automatic evidence. Reads only (public storefront + our Easy Orders catalogue + our DB): no Meta call, nothing is created.
import { prisma } from '../../prisma.js';
import { resolveLandingIdentity, loadLandingCatalogues, fetchLandingPage } from './landingProof.js';
import { normalizeName } from '../../../../js/product-mapping.js';

export const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60_000;
export const LANDING_BLOCK = {
  PRODUCT_STORE_UNRESOLVED: 'المنتج المختار مالوش متجر معروف — مستحيل نتأكد من صفحة الهبوط.',
  PRODUCT_NOT_LINKED_TO_EASY_ORDERS: 'المنتج المختار مش مربوط بمنتج Easy Orders (مفيش uuid) — هويته غير مؤكدة، الإطلاق ممنوع.',
  WRONG_STORE: 'صفحة الهبوط تابعة لمتجر تاني غير متجر المنتج المختار.',
  WRONG_PRODUCT: 'صفحة الهبوط بتفتح منتج تاني غير المنتج المختار.',
  DUPLICATE_NAME_DIFFERENT_PRODUCT: 'صفحة الهبوط بتفتح منتج بنفس الاسم لكنه منتج مختلف (نسخة/متجر تاني) — مش هو المنتج المختار.',
  PAGE_UNREACHABLE: 'مقدرناش نفتح صفحة الهبوط للتحقق منها.',
  NO_SLUG: 'رابط الهبوط مش بيشاور على صفحة منتج.',
  PAGE_BELONGS_TO_A_STORE_WE_DO_NOT_OWN: 'صفحة الهبوط تابعة لمتجر Easy Orders مش بتاعنا.',
  SLUG_DOES_NOT_MATCH_PAGE_PRODUCT: 'رابط الهبوط مش بيطابق المنتج اللي الصفحة بتعرضه فعلًا.',
  PAGE_MATCHES_MORE_THAN_ONE_STORE: 'صفحة الهبوط بتطابق أكتر من متجر — هوية غير مؤكدة.',
  EO_PRODUCT_NOT_IN_PRODUCT_MASTER: 'منتج صفحة الهبوط مش موجود في كتالوج المنتجات عندنا.',
  CATALOGUE_UNAVAILABLE: 'كتالوج Easy Orders مش متاح دلوقتي للتحقق — أعد المحاولة بعد شوية.',
};

/**
 * product = { id, store_id, easy_orders_uuid, product_name }; campaigns = [{ name, websiteUrl }]. Returns { ok, errors[], evidence }.
 * deps (tests): { catalogues, fetchPage }.
 */
export async function validateLaunchLanding({ product, campaigns, deps = {} }) {
  const errors = []; const results = [];
  const add = (code, extra = {}) => errors.push({ code, message: LANDING_BLOCK[code] || code, ...extra });
  if (process.env.LAUNCH_LANDING_VALIDATION_TEST_BYPASS === '1' && process.env.NODE_ENV !== 'production') return { ok: true, errors: [], evidence: { version: 1, bypassed: true, validatedAt: new Date().toISOString(), productId: product?.id ?? null, ok: true, results: [] } };
  if (!product?.store_id) add('PRODUCT_STORE_UNRESOLVED');
  else if (!product.easy_orders_uuid) add('PRODUCT_NOT_LINKED_TO_EASY_ORDERS');
  let cat = deps.catalogues || null;
  if (!errors.length && !cat) { try { cat = await loadLandingCatalogues(); } catch { add('CATALOGUE_UNAVAILABLE'); } }
  if (!errors.length) {
    const seen = new Map();
    for (const c of campaigns || []) {
      const url = String(c.websiteUrl || '').split('?')[0];
      let r = seen.get(url);
      if (!r) { r = await resolveLandingIdentity(url, { ...cat, fetchPage: deps.fetchPage || fetchLandingPage }); seen.set(url, r); results.push({ url, status: r.status, reason: r.reason || null, store: r.store || null, productId: r.productId ?? null, eoProductId: r.eoProductId || null, productName: r.productName || null }); }
      const where = { campaign: c.name, url };
      if (r.status !== 'VERIFIED') { add(r.reason in LANDING_BLOCK ? r.reason : 'PAGE_UNREACHABLE', where); continue; }
      if (r.store !== product.store_id) { add('WRONG_STORE', { ...where, pageStore: r.store, productStore: product.store_id, pageProduct: r.productName }); continue; }
      if (r.productId !== product.id) {
        const sameName = normalizeName(r.productName || '') === normalizeName(product.product_name || '');
        add(sameName ? 'DUPLICATE_NAME_DIFFERENT_PRODUCT' : 'WRONG_PRODUCT', { ...where, pageProduct: r.productName, pageProductId: r.productId, selectedProductId: product.id });
      }
    }
  }
  const evidence = { version: 1, validatedAt: new Date().toISOString(), productId: product?.id ?? null, productStore: product?.store_id ?? null, productEoUuid: product?.easy_orders_uuid ?? null, ok: errors.length === 0, results, errors: errors.map((e) => ({ code: e.code, campaign: e.campaign || null, url: e.url || null })) };
  return { ok: errors.length === 0, errors, evidence };
}

/** Human-readable BLOCK message (Arabic) for the wizard / API. */
export function landingBlockMessage(errors) {
  const lines = errors.slice(0, 6).map((e) => `• ${e.campaign ? `«${e.campaign}»: ` : ''}${e.message}${e.pageProduct ? ` (الصفحة بتعرض: ${e.pageProduct})` : ''}`);
  return `🚫 الإطلاق ممنوع — التحقق من صفحة الهبوط فشل:\n${lines.join('\n')}${errors.length > 6 ? `\n… و${errors.length - 6} مشكلة تانية` : ''}`;
}

/**
 * Publish-time gate (re-checked before any Meta write). Uses the evidence saved with the job when it is fresh and still describes exactly the job's
 * product + campaign URLs; otherwise re-validates live and persists the new evidence. Anything unverified throws (status 400) — publishing stops.
 */
export async function assertLaunchLandingVerified(job, { deps = {}, now = Date.now() } = {}) {
  if (process.env.LAUNCH_LANDING_VALIDATION_TEST_BYPASS === '1' && process.env.NODE_ENV !== 'production') return { bypassed: true };
  let cfg = {}; try { cfg = JSON.parse(job.config_json || '{}'); } catch { /* */ }
  const ev = cfg.landingValidation;
  const urls = (job.campaigns || []).map((c) => String(c.website_url || '').split('?')[0]);
  const fresh = ev && ev.ok === true && ev.productId === job.product_id && now - new Date(ev.validatedAt).getTime() < EVIDENCE_MAX_AGE_MS
    && urls.every((u) => (ev.results || []).some((r) => r.url === u && r.status === 'VERIFIED' && r.productId === job.product_id));
  if (fresh) return { cached: true, evidence: ev };
  const product = job.product_id ? await prisma.product.findUnique({ where: { id: job.product_id }, select: { id: true, store_id: true, easy_orders_uuid: true, product_name: true } }) : null;
  const v = await validateLaunchLanding({ product, campaigns: (job.campaigns || []).map((c) => ({ name: c.name, websiteUrl: c.website_url })), deps });
  cfg.landingValidation = v.evidence;
  await prisma.ambLaunchJob.update({ where: { job_id: job.job_id }, data: { config_json: JSON.stringify(cfg) } });
  if (!v.ok) { const e = new Error(landingBlockMessage(v.errors)); e.status = 400; e.code = 'LANDING_VALIDATION_BLOCK'; e.details = v.errors; throw e; }
  return { cached: false, evidence: v.evidence };
}
