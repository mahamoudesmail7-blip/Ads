// AI Media Buyer Operator — Phase 2 Slice 3. Scale-from-chat prepare logic.
// Thin composition of EXISTING, unmodified Decision Center read functions
// (buildProductDecisionPackage, buildWinningStack, resolveTrackingIdentity,
// resolveRealTargeting) — never a second evidence engine, never a new
// SCALE_CANDIDATE threshold. Gates on decideProductAction()'s OWN
// SCALE_CANDIDATE verdict (the exact same real-money gate the Decision
// Center UI itself uses) rather than re-deriving hasWinner()/
// anyCreativeWinner, which are intentionally unexported — re-implementing
// them here would risk silently drifting from the real rule engine.
//
// SECURITY BOUNDARY (mandatory, never relaxed): this file NEVER calls
// persistProductDecision/approveProductDecision/executeApprovedDecision —
// those routes are requireRole('ADMIN')-gated (aiMediaBuyer.js:253/272/295)
// while chat itself is requireRole('ADMIN','MANAGER') (aiAssistant.js:20).
// Calling them from here would let a MANAGER-role chat user perform an
// ADMIN-only action — a real privilege-escalation bug. Only read-only
// functions are called; the actual draft is built via the same safe
// createDraftJob() Slice 2 already uses.
import { prisma } from '../../prisma.js';
import { buildProductDecisionPackage } from '../amb/productDecision.js';
import { buildWinningStack, resolveTrackingIdentity } from '../amb/productActionPlan.js';
import { resolveRealTargeting } from '../amb/productDecisionExecution.js';
import { getAmbSettings } from '../amb/settings.js';

/** `"asset:<id>"` (creativeIntel.js's own MediaLibraryAsset-keyed id format) -> the numeric id, or null for `"raw:..."`/missing (never registered in the Media Library yet — caller falls back to manual media attach). */
function parseAssetId(rawId) {
  if (typeof rawId !== 'string' || !rawId.startsWith('asset:')) return null;
  const n = Number(rawId.slice('asset:'.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The winning creative's already-live Meta asset for THIS ad account, if
 * any — lets the draft job reuse it with zero upload (registerVideoSlot/
 * registerImageSlot are pure DB writes with no dependency on upload
 * provenance; launchPublish.js's ensureCreative() trusts whatever
 * meta_video_id/meta_image_hash is already stored). Returns null (never
 * guesses) when the asset was never linked to a real creative_id on this
 * account — the caller must then fall back to the normal 📎 upload gate.
 */
export async function resolveWinningCreativeAsset(assetId, adAccountId) {
  if (!assetId || !adAccountId) return null;
  const refs = await prisma.mediaLibraryCreativeRef.findMany({
    where: { asset_id: assetId, ad_account_id: adAccountId },
    orderBy: { last_seen_at: 'desc' },
  });
  for (const ref of refs) {
    const videoIds = ref.video_ids_json ? JSON.parse(ref.video_ids_json) : [];
    if (videoIds[0]) return { kind: 'video', metaId: videoIds[0] };
    const imageHashes = ref.image_hashes_json ? JSON.parse(ref.image_hashes_json) : [];
    if (imageHashes[0]) return { kind: 'image', metaId: imageHashes[0] };
  }
  return null;
}

/**
 * The full read-only "is this product a proven winner, and what does its
 * winning stack look like" bundle for Scale-from-chat. Refuses (ok:false)
 * for anything short of a real SCALE_CANDIDATE verdict — an EARLY_SIGNAL or
 * PROMISING-tier product can never reach here, matching the rule reaffirmed
 * across this whole spec: EARLY_SIGNAL must never be silently promoted to
 * Scale targeting.
 */
export async function loadWinningStackForProduct({ productId, adAccountId }) {
  const settings = await getAmbSettings();
  const pkg = await buildProductDecisionPackage({ productId: Number(productId), windowName: undefined, settings, adAccountId });
  if (pkg.decision !== 'SCALE_CANDIDATE') {
    return {
      ok: false,
      decision: pkg.decision,
      productName: pkg.productName,
      message: `المنتج "${pkg.productName}" لسه مش "فائز مثبت" بالأدلة الحالية (القرار الحالي من محرك القرار: ${pkg.decision}) — الـ Scale من الشات متاح بس للمنتجات اللي وصلت لقرار SCALE_CANDIDATE في مركز القرار الذكي.`,
    };
  }

  const stack = buildWinningStack(pkg.winners);
  const tracking = await resolveTrackingIdentity({ productId: Number(productId), adAccountId });
  // Scale-from-chat NEVER opts into Early Signal targeting — only the
  // already-PROVEN/PROMISING dimensions buildWinningStack() itself carries.
  const { targeting, sources } = await resolveRealTargeting({
    stack, earlySignals: null, useEarlySignalGender: false, useEarlySignalAge: false, useEarlySignalGeo: false,
  });

  return {
    ok: true,
    productName: pkg.productName,
    stack, tracking, targeting, targetingSources: sources,
    creativeAssetId: parseAssetId(pkg.winners?.creative?.id),
    creativeLabel: stack.creative?.value || null,
    creativeCpa: pkg.winners?.creative?.cpa ?? null,
    creativePurchases: pkg.winners?.creative?.purchases ?? null,
  };
}
