// Smart Decision Center UX overhaul — services/amb/productDossier.js. Pure
// composition layer over already-tested Phase 2-6/9/10 functions — this
// test proves the BUNDLING is correct (right shape, fast-path vs.
// first-analysis path, honest unlinked state), not the underlying analysis
// logic itself (already covered by each phase's own test file).
//   node src/scripts/productDossierTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { getProductDossier } = await imp('../services/amb/productDossier.js');
const { prisma } = await imp('../prisma.js');

try {
  console.log('§1 a product with zero resolvable campaigns returns an honest unlinked state, never fabricated analysis:');
  {
    const d = await getProductDossier({ productId: 90 });
    ok('linked:false', d.linked === false, JSON.stringify(d));
    ok('carries the real product name and store, even when unlinked', d.productName && d.storeId !== undefined);
    ok('no package/history/learning keys are present for an unlinked product (nothing to bundle yet)', d.package === undefined && d.history === undefined);
  }

  console.log('\n§2 a genuinely unknown product id fails loudly rather than returning an empty shell:');
  {
    let threw = false;
    try { await getProductDossier({ productId: 999999999 }); } catch (e) { threw = true; ok('error explicitly says the product does not exist', /غير موجود/.test(e.message), e.message); }
    ok('throws (404), never a silent fake dossier', threw);
  }

  console.log('\n§3 a real, previously-analyzed product (126) uses the FAST path — reads the persisted decision, does not recompute:');
  {
    const before = await prisma.ambRecommendation.count({ where: { level: 'product' } });
    const d = await getProductDossier({ productId: 126 });
    const after = await prisma.ambRecommendation.count({ where: { level: 'product' } });
    ok('linked:true for a real mapped product', d.linked === true);
    ok('no new recommendation row was created on a normal (non-refresh) open', after === before, `${before} -> ${after}`);
    ok('the bundled package carries a real decision + health score', typeof d.package.decision === 'string' && typeof d.package.health?.score === 'number', JSON.stringify(d.package.health));
    ok('history is a real array of past decisions for this product, most-recent first', Array.isArray(d.history) && d.history.length > 0);
    ok('learning memory is bundled (Phase 10)', d.learning && Array.isArray(d.learning.entries));
    ok('experiment tracking is bundled (Phase 9)', d.experiment && typeof d.experiment.hasExperiment === 'boolean');
    ok('stock summary is present and honest (STOCK_UNKNOWN when Product.current_stock is null, never a fabricated number)', ['SAFE', 'LOW', 'OUT_OF_STOCK', 'STOCK_UNKNOWN'].includes(d.stock.status));
    ok('the fast path still freshly attaches segmentIntel for the Audience/Geo tab (not just the persisted decision facts)', d.package.segmentIntel && typeof d.package.segmentIntel === 'object', JSON.stringify(Object.keys(d.package.segmentIntel || {})));
    ok('the fast path still freshly attaches creativeIntel for the Creative Leaderboard tab', d.package.creativeIntel && typeof d.package.creativeIntel === 'object', JSON.stringify(Object.keys(d.package.creativeIntel || {})));

    // MANDATORY window-alignment check: every tab of one dossier must be
    // computed for the EXACT SAME date range as the persisted funnel/
    // diagnosis — never a freshly re-resolved "last7" that silently drifts
    // away from the frozen decision window after a day boundary passes.
    ok('segmentIntel.window.from matches the persisted package window exactly', d.package.segmentIntel.window?.from === d.package.window.from, JSON.stringify({ pkg: d.package.window, seg: d.package.segmentIntel.window }));
    ok('segmentIntel.window.to matches the persisted package window exactly', d.package.segmentIntel.window?.to === d.package.window.to);
    ok('creativeIntel.window.from matches the persisted package window exactly', d.package.creativeIntel.window?.from === d.package.window.from, JSON.stringify({ pkg: d.package.window, cre: d.package.creativeIntel.window }));
    ok('creativeIntel.window.to matches the persisted package window exactly', d.package.creativeIntel.window?.to === d.package.window.to);
  }

  console.log('\n§4 forceRefresh:true always recomputes and persists a fresh recommendation ("إعادة التحليل"):');
  {
    const before = await prisma.ambRecommendation.count({ where: { level: 'product' } });
    const d = await getProductDossier({ productId: 126, forceRefresh: true });
    const after = await prisma.ambRecommendation.count({ where: { level: 'product' } });
    ok('a new recommendation row was created', after === before + 1, `${before} -> ${after}`);
    ok('the returned package reflects the freshly-created row\'s id', d.package.recommendationId != null);
  }
} finally {
  await prisma.$disconnect?.().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
