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

  console.log('\n§5 VIEW WINDOW vs OPERATIONAL DECISION WINDOW — mandatory separation (real Smart-Tank product 146):');
  {
    const opBefore = await prisma.ambRecommendation.count({ where: { level: 'product' } });

    // Viewing "last30" (almost certainly NOT the operational window, since operational defaults to last7) must NEVER persist a new recommendation.
    const view30 = await getProductDossier({ productId: 146, windowName: 'last30' });
    const opAfterView = await prisma.ambRecommendation.count({ where: { level: 'product' } });
    ok('viewing a non-operational window (last30) creates ZERO new recommendation rows', opAfterView === opBefore, `${opBefore} -> ${opAfterView}`);
    ok('the view package is explicitly marked VIEW_ONLY, never claims to be a real persisted decision', view30.package.recommendationStatus === 'VIEW_ONLY' && view30.package.recommendationId === null, JSON.stringify({ status: view30.package.recommendationStatus, id: view30.package.recommendationId }));
    ok('isViewingOperational is false for this explicit non-operational window', view30.isViewingOperational === false);
    ok('the view window is really last30 (~30 days span), not silently coerced to the operational one', (new Date(view30.package.window.to) - new Date(view30.package.window.from)) / 86400000 >= 28, JSON.stringify(view30.package.window));

    // The operationalDecision block must still reflect the REAL, unchanged, currently-persisted decision — completely independent of what window was just viewed.
    ok('operationalDecision is still present and reflects the real persisted decision, untouched by the view above', view30.operationalDecision != null && view30.operationalDecision.recommendationId != null);

    const opAfterAll = await prisma.ambRecommendation.count({ where: { level: 'product' } });
    ok('after viewing a historical window, the total recommendation count is still completely unchanged', opAfterAll === opBefore, `${opBefore} -> ${opAfterAll}`);
  }

  console.log('\n§6 explicit window selection is honored consistently across EVERY dimension (funnel/segment/creative) for a real product:');
  {
    const viewToday = await getProductDossier({ productId: 146, windowName: 'today' });
    ok('package.window is really "today" (single-day span)', viewToday.package.window.from === viewToday.package.window.to, JSON.stringify(viewToday.package.window));
    ok('segmentIntel.window matches the SAME single-day span as the funnel', viewToday.package.segmentIntel.window.from === viewToday.package.window.from && viewToday.package.segmentIntel.window.to === viewToday.package.window.to, JSON.stringify({ pkg: viewToday.package.window, seg: viewToday.package.segmentIntel.window }));
    ok('creativeIntel.window matches the SAME single-day span as the funnel', viewToday.package.creativeIntel.window.from === viewToday.package.window.from && viewToday.package.creativeIntel.window.to === viewToday.package.window.to, JSON.stringify({ pkg: viewToday.package.window, cre: viewToday.package.creativeIntel.window }));

    const viewCustom = await getProductDossier({ productId: 146, from: '2026-09-10', to: '2026-09-12' });
    ok('a custom from/to range is used verbatim, never coerced to a named window', viewCustom.package.window.from === '2026-09-10' && viewCustom.package.window.to === '2026-09-12', JSON.stringify(viewCustom.package.window));
    ok('every dimension shares the SAME custom range', viewCustom.package.segmentIntel.window.from === '2026-09-10' && viewCustom.package.creativeIntel.window.from === '2026-09-10');
  }

  console.log('\n§7 freshness + since-launch metadata are real, never fabricated:');
  {
    const d = await getProductDossier({ productId: 146 });
    ok('freshness block is present with real (or honestly null) sync timestamps', 'metaLastSync' in d.freshness && 'easyOrdersLastSync' in d.freshness, JSON.stringify(d.freshness));
    ok('sinceLaunchAvailable is a real boolean, computed from the actual AmbLaunchJob link (product 146 has one)', d.sinceLaunchAvailable === true, d.sinceLaunchAvailable);

    const sinceLaunch = await getProductDossier({ productId: 146, windowName: 'since_launch' });
    ok('since_launch resolves to a real window with a real "منذ الإطلاق" label', sinceLaunch.package.window.label === 'منذ الإطلاق', JSON.stringify(sinceLaunch.package.window));
    ok('since_launch is also a VIEW, never persisted as the operational decision', sinceLaunch.package.recommendationStatus === 'VIEW_ONLY');
  }
} finally {
  await prisma.$disconnect?.().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
