// Smart Campaign → «النشر على المتجر»: update the linked Easy Orders product's TEXT (name / description / prices) from the journey.
// WRITES to the live store, so: only on the owner's explicit confirmation, only for the fields he ticks, only what he was shown (a hash of the exact body is
// checked), only PATCH (never PUT — a PUT could blank fields we did not send). Images are NOT sent: they would need permanent public hosting, which is not set up.
import crypto from 'node:crypto';
import { MediaError } from './mediaJobs.js';
import { getProject, mutateProject } from './pageProjects.js';
import { getEasyOrdersProductDetail, updateEasyOrdersProduct } from '../easyOrdersProducts.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Pure: the page copy as the simple HTML Easy Orders descriptions use (paragraphs, a feature list, numbered steps). No images, no scripts, everything escaped. */
export function buildDescriptionHtml(copy) {
  if (!copy) return '';
  const parts = [];
  if (copy.title) parts.push(`<p><strong>${esc(copy.title)}</strong></p>`);
  if (copy.subtitle) parts.push(`<p>${esc(copy.subtitle)}</p>`);
  for (const t of copy.paragraphs || []) parts.push(`<p>${esc(t)}</p>`);
  if ((copy.features || []).length) parts.push(`<p><strong>✨ أهم المميزات:</strong></p><ul>${copy.features.map((f) => `<li>✅ ${esc(f)}</li>`).join('')}</ul>`);
  if ((copy.steps || []).length) parts.push(`<p><strong>طريقة الاستخدام:</strong></p><ol>${copy.steps.map((s) => `<li><strong>${esc(s.title)}</strong>${s.text ? ` — ${esc(s.text)}` : ''}</li>`).join('')}</ol>`);
  return parts.join('');
}

/** Pure: which Easy Orders fields would change. Selling price = sale_price and the "before" price = price (Easy Orders' own meaning); with no "before" price the price fields are not touched. */
export function buildUpdate(project, { name = false, description = true, prices = false, settings = false } = {}) {
  const body = {}; const notes = [];
  if (name) { if (!project.name) throw new MediaError('اسم المنتج فاضي.', 'BAD_INPUT'); body.name = project.name; }
  if (description) {
    const html = buildDescriptionHtml(project.copy);
    if (!html) throw new MediaError('مفيش محتوى للصفحة لسه — اكتب المحتوى بالـ AI الأول (الخطوة 4).', 'NO_COPY');
    body.description = html;
  }
  if (prices) {
    if (project.price != null && project.oldPrice != null && project.oldPrice > project.price) { body.price = project.oldPrice; body.sale_price = project.price; }
    else notes.push('تحديث الأسعار اتخطّى: لازم يبقى فيه «سعر قبل الخصم» أعلى من سعر البيع.');
  }
  if (settings) {
    const s = project.smart?.pageSettings;
    if (!s) notes.push('إعدادات الصفحة اتخطّت: لسه ما اتحفظتش في خطوة «صفحة المنتج».');
    else Object.assign(body, { is_one_page_checkout: !!s.buyFromPage, is_skip_cart: !!s.skipCart, is_fixed_bottom_buy: !!s.fixedBuy, is_free_shipping: !!s.freeShipping, is_fake_visitors: !!s.visitors, buy_now_text: s.buyText || 'اضغط هنا للشراء' });
  }
  if (!Object.keys(body).length) throw new MediaError('مفيش حاجة تتحدّث — اختار حقل واحد على الأقل.', 'NOTHING_TO_UPDATE');
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24);
  return { body, hash, notes };
}

const rows = (body, current) => Object.keys(body).map((k) => ({ field: k, label: { name: 'الاسم', description: 'الوصف', price: 'السعر (قبل الخصم)', sale_price: 'سعر البيع', is_one_page_checkout: 'الشراء من نفس الصفحة', is_skip_cart: 'تخطي السلة', is_fixed_bottom_buy: 'زرار شراء ثابت', is_free_shipping: 'شحن مجاني', is_fake_visitors: 'عداد الزوار', buy_now_text: 'نص زرار الشراء' }[k] || k, before: k === 'description' ? String(current?.description ?? '').slice(0, 300) : current && { price: 'oldPrice', sale_price: 'price', name: 'name' }[k] ? String(current[{ price: 'oldPrice', sale_price: 'price', name: 'name' }[k]] ?? '') : '', after: k === 'description' ? String(body[k]).slice(0, 300) : String(body[k]) }));

export async function previewUpdate(projectId, options, { deps = {} } = {}) {
  const p = await getProject(projectId);
  if (!p) throw new MediaError('المشروع مش موجود.', 'NOT_FOUND');
  if (!p.eo?.id || !p.eo?.storeId) throw new MediaError('الصفحة دي مش مربوطة بمنتج من إيزي أوردر.', 'NOT_LINKED');
  const u = buildUpdate(p, options);
  const current = await (deps.getDetail || getEasyOrdersProductDetail)(p.eo.storeId, p.eo.id).catch(() => null);
  return { hash: u.hash, fields: rows(u.body, current), notes: u.notes, product: { id: p.eo.id, name: current?.name || p.eo.name }, htmlLength: u.body.description?.length || 0 };
}

export async function applyUpdate(projectId, options, { hash, confirm }, { deps = {} } = {}) {
  if (confirm !== true) throw new MediaError('لازم تأكيد صريح منك قبل ما أكتب على المتجر.', 'NOT_CONFIRMED');
  const p = await getProject(projectId);
  if (!p) throw new MediaError('المشروع مش موجود.', 'NOT_FOUND');
  if (!p.eo?.id || !p.eo?.storeId) throw new MediaError('الصفحة دي مش مربوطة بمنتج من إيزي أوردر.', 'NOT_LINKED');
  const u = buildUpdate(p, options);
  if (u.hash !== hash) throw new MediaError('المحتوى اتغيّر من ساعة المعاينة — اعمل معاينة جديدة وراجعها قبل التأكيد.', 'STALE_PREVIEW');
  try { await (deps.update || updateEasyOrdersProduct)(p.eo.storeId, p.eo.id, u.body); }
  catch (e) { throw new MediaError(`إيزي أوردر رفض التحديث: ${e.message}`, 'EO_REJECTED'); }
  const at = new Date().toISOString();
  await mutateProject(projectId, (proj) => { proj.smart = { ...(proj.smart || {}), publish: { at, fields: Object.keys(u.body), hash: u.hash } }; });
  return { ok: true, at, fields: Object.keys(u.body) };
}
