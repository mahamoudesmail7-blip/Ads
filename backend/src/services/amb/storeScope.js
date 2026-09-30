// Live Campaign Intelligence — store-scope guard.
//
// Audit finding (2026-09-30): resolveEffectiveProductId() in
// productMarketing.js is correctly store-filtered for EASY_ORDERS-sourced
// profiles (findInternalProductByName() takes a real storeId there), but for
// MANUAL_UPLOAD-sourced profiles it has NO store parameter anywhere in its
// call chain — it either does a fully global (every-store) name lookup, or
// silently falls back to defaultStoreId() on every re-resolution. Fixing
// that deep, pre-existing resolution/upload flow is a separate, larger
// change; this module is the surgical fix for the Live Campaign Intelligence
// surfaces specifically — every one of them must be explicitly told which
// store the caller is currently viewing, and must FAIL CLOSED (never
// silently guess or merge across stores) if the resolved product turns out
// to belong to a different one.
//
// This is a pure ADDITIVE safety check layered on top of the existing
// resolver — it never changes what resolveEffectiveProductId() returns, it
// only refuses to use the result when it doesn't match the caller's
// declared store.
import { prisma } from '../../prisma.js';

export const STORE_CONTEXT_REQUIRED = 'STORE_CONTEXT_REQUIRED';

/**
 * @param {{productId:number, storeId:string|null|undefined}} params
 * @returns {Promise<{ok:true}|{ok:false, code:string, reason:string}>}
 */
export async function verifyProductStoreScope({ productId, storeId }) {
  if (!storeId) {
    return { ok: false, code: STORE_CONTEXT_REQUIRED, reason: 'لازم يكون فيه متجر محدد حاليًا — مش هنعرض بيانات حيّة من غير سياق متجر واضح، لمنع خلط بيانات بين المتاجر.' };
  }
  const product = await prisma.product.findUnique({ where: { id: Number(productId) }, select: { store_id: true } });
  if (!product) {
    return { ok: false, code: STORE_CONTEXT_REQUIRED, reason: 'المنتج غير موجود.' };
  }
  // A legacy, untagged row (store_id: null) is treated as compatible with
  // any store — the SAME lenient convention findInternalProductByName()
  // already uses elsewhere in this codebase (OR [{store_id}, {store_id:null}]).
  // A row explicitly tagged to a DIFFERENT store than the one currently
  // selected is the real cross-store leak this guard exists to catch.
  if (product.store_id && product.store_id !== storeId) {
    return { ok: false, code: STORE_CONTEXT_REQUIRED, reason: 'هذا المنتج تابع لمتجر مختلف عن المتجر المختار حاليًا — تم رفض العرض لمنع خلط بيانات بين المتاجر.' };
  }
  return { ok: true };
}
