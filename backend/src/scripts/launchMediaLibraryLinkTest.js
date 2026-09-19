// Smart Decision Center Phase 1 — services/amb/mediaLibrary.js's
// registerLaunchCreativeRef(). Proves the actual bug this phase exists to
// fix: a Campaign Launch Builder creative gets a STABLE identity that
// survives being reused across multiple jobs/ad accounts, exactly like the
// pre-existing DISCOVERED/CLONED paths already do for creatives found via
// sync or Clone & Schedule. Real throwaway DB rows (tagged, cleaned up
// after), zero Meta calls.
//   node src/scripts/launchMediaLibraryLinkTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { registerLaunchCreativeRef } = await imp('../services/amb/mediaLibrary.js');
const { prisma } = await imp('../prisma.js');

// Shaped exactly like buildCreativePayload()'s real output (launchPublish.js)
// — same object_story_spec.video_data nesting — so fingerprintCreative()
// needs zero adaptation between the real code path and this test.
function creativePayload(overrides = {}) {
  return {
    name: 'Cup - Test - Creative 1.1',
    object_story_spec: {
      page_id: '999',
      video_data: {
        video_id: 'vid_shared_001',
        image_url: 'https://scontent.example/thumb.jpg',
        message: 'نص إعلاني مشترك بين الحسابين',
        title: 'عنوان',
        call_to_action: { type: 'ORDER_NOW', value: { link: 'https://trendystore.com' } },
      },
    },
    ...overrides,
  };
}

const cleanupAssetIds = new Set();
const cleanupProductIds = new Set();
async function cleanup() {
  await prisma.mediaLibraryCreativeRef.deleteMany({ where: { asset_id: { in: [...cleanupAssetIds] } } });
  await prisma.mediaLibraryAsset.deleteMany({ where: { id: { in: [...cleanupAssetIds] } } });
  await prisma.product.deleteMany({ where: { id: { in: [...cleanupProductIds] } } });
}

try {
  console.log('§1 registerLaunchCreativeRef — cross-account stable identity (the actual bug this phase fixes):');
  {
    const product = await prisma.product.create({ data: { product_name: '__test_ml_product__', active: true } });
    cleanupProductIds.add(product.id);

    const assetId1 = await registerLaunchCreativeRef({
      payload: creativePayload(), adAccountId: 'act_A', creativeId: 'creative_A_1', productId: product.id, hook: 'H3 — فضول', sellingAngle: 'Problem/Solution',
    });
    ok('first registration creates a real MediaLibraryAsset', !!assetId1);
    cleanupAssetIds.add(assetId1);

    const asset1 = await prisma.mediaLibraryAsset.findUnique({ where: { id: assetId1 } });
    ok('the new asset carries the real product_id', asset1.product_id === product.id);
    ok('the new asset carries the real hook', asset1.hook === 'H3 — فضول');
    ok('the new asset carries the real selling_angle', asset1.selling_angle === 'Problem/Solution');
    ok('amb_product_id stays independently null — no AmbProduct exists for this product, and none is created implicitly', asset1.amb_product_id === null);

    // SAME content, DIFFERENT ad account + creative id — simulates the same
    // creative being reused in a second launch/campaign.
    const assetId2 = await registerLaunchCreativeRef({
      payload: creativePayload(), adAccountId: 'act_B', creativeId: 'creative_B_7', productId: product.id,
    });
    ok('a second launch reusing the identical content resolves to the SAME asset id, not a new one', assetId2 === assetId1, JSON.stringify({ assetId1, assetId2 }));

    const refs = await prisma.mediaLibraryCreativeRef.findMany({ where: { asset_id: assetId1 } });
    ok('two distinct per-account creative refs now point at the one shared asset', refs.length === 2, refs.length);
    ok('both refs are tagged origin LAUNCHED', refs.every((r) => r.origin === 'LAUNCHED'));

    // A later call with hook:null must never blank out the already-set hook.
    await registerLaunchCreativeRef({ payload: creativePayload(), adAccountId: 'act_B', creativeId: 'creative_B_7', productId: product.id, hook: null });
    const assetAfter = await prisma.mediaLibraryAsset.findUnique({ where: { id: assetId1 } });
    ok('a later call with hook:null never overwrites an already-set hook (sticky value)', assetAfter.hook === 'H3 — فضول');
  }

  console.log('\n§2 registerLaunchCreativeRef — never throws, degrades gracefully:');
  {
    let threw = false;
    let result;
    try { result = await registerLaunchCreativeRef({ payload: {}, adAccountId: 'act_X', creativeId: 'creative_no_content' }); } catch { threw = true; }
    ok('a content-free payload still resolves without throwing (falls back to a per-creative fingerprint)', !threw);
    if (result) cleanupAssetIds.add(result);
  }

  console.log('\n§3 registerLaunchCreativeRef — a genuinely different creative gets its own separate asset:');
  {
    const product = await prisma.product.create({ data: { product_name: '__test_ml_product_2__', active: true } });
    cleanupProductIds.add(product.id);
    const assetIdA = await registerLaunchCreativeRef({ payload: creativePayload({ object_story_spec: { page_id: '999', video_data: { video_id: 'vid_unique_A', image_url: 'https://x/a.jpg', message: 'نص أ مختلف تمامًا', title: 'عنوان أ', call_to_action: { type: 'ORDER_NOW', value: { link: 'https://a.example.com' } } } } }), adAccountId: 'act_C', creativeId: 'creative_C_1', productId: product.id });
    const assetIdB = await registerLaunchCreativeRef({ payload: creativePayload({ object_story_spec: { page_id: '999', video_data: { video_id: 'vid_unique_B', image_url: 'https://x/b.jpg', message: 'نص ب مختلف تمامًا خالص', title: 'عنوان ب', call_to_action: { type: 'ORDER_NOW', value: { link: 'https://b.example.com' } } } } }), adAccountId: 'act_C', creativeId: 'creative_C_2', productId: product.id });
    cleanupAssetIds.add(assetIdA); cleanupAssetIds.add(assetIdB);
    ok('two genuinely different creatives never collide onto one shared asset', assetIdA !== assetIdB);
  }
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
