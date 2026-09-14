// Phase 1 PMC assemblers — pure functions over plain objects, no prisma, no
// mocks needed.
//   node src/scripts/productMarketingAssemblersTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { assembleNeedsAttention, assembleWinningComponents, labelCreativeIdeas, labelPostCopy } =
  await import(pathToFileURL(join(__dirname, '../services/amb/productMarketingAssemblers.js')).href);

console.log('§1 assembleNeedsAttention — ranks P0 first, skips HEALTHY_PRODUCT, includes winner opportunities:');
{
  const diagnosis = [
    { category: 'HEALTHY_PRODUCT', priority: 'P3', problem: 'ok', evidence: 'ok', action: 'ok', dataSufficiency: 'STRONG' },
    { category: 'CPA_PROBLEM', priority: 'P0', problem: 'CPA مرتفع', evidence: 'evidence', action: 'do X', dataSufficiency: 'STRONG' },
    { category: 'CREATIVE_PROBLEM', priority: 'P1', problem: 'CTR ضعيف', evidence: 'evidence2', action: 'do Y', dataSufficiency: 'MODERATE' },
  ];
  const actions = [{ priority: 'P2', title: 'اختبر Angle', reason: 'test', confidence: 'MEDIUM' }];
  const hookIntel = { winner: { label: 'سؤال', why: 'CPA منخفض' } };
  const out = assembleNeedsAttention({ diagnosis, actions, hookIntel });
  ok('HEALTHY_PRODUCT never appears in the list', !out.some((i) => i.what === 'ok'));
  ok('P0 item comes first', out[0].priority === 'P0' && out[0].what === 'CPA مرتفع', JSON.stringify(out[0]));
  ok('winner hook is surfaced as a P1 opportunity', out.some((i) => i.type === 'OPPORTUNITY' && i.what.includes('سؤال')));
  ok('list is sorted P0 -> P3', out.every((item, idx) => idx === 0 || (['P0', 'P1', 'P2', 'P3'].indexOf(out[idx - 1].priority) <= ['P0', 'P1', 'P2', 'P3'].indexOf(item.priority))));
}

console.log('\n§2 assembleWinningComponents — assembles from already-known pieces, dataSufficient reflects whether anything was found:');
{
  const markets = [
    { government: 'القاهرة', orders: 20, delivered: 15, band: 'SCALE_MARKET' },
    { government: 'الجيزة', orders: 10, delivered: 3, band: 'MONITOR' },
  ];
  const hookIntel = { winner: { label: 'مشكلة/وجع', why: 'أقل CPA' } };
  const out = assembleWinningComponents({ markets, hookIntel });
  ok('best market picked from SCALE_MARKET band, not just highest delivered', out.bestMarket.government === 'القاهرة', JSON.stringify(out.bestMarket));
  ok('best hook carried through with its why', out.bestHook.label === 'مشكلة/وجع');
  ok('dataSufficient true when something was found', out.dataSufficient === true);

  const empty = assembleWinningComponents({});
  ok('empty input -> dataSufficient false, no fabricated winners', empty.dataSufficient === false && empty.bestHook === null);
}

console.log('\n§3 labelCreativeIdeas — status derived from hook/angle band, no new AI call:');
{
  const ideas = [{ type: 'Demonstration' }, { type: 'UGC' }];
  const winnerLabeled = labelCreativeIdeas(ideas, { angleBand: 'WINNER' });
  ok('WINNER angle -> CREATE_MORE_LIKE_THIS', winnerLabeled.every((i) => i.status === 'CREATE_MORE_LIKE_THIS'));
  const weakLabeled = labelCreativeIdeas(ideas, { angleBand: 'WEAK' });
  ok('WEAK angle -> STOP_REPEATING', weakLabeled.every((i) => i.status === 'STOP_REPEATING'));
  const untestedLabeled = labelCreativeIdeas(ideas, {});
  ok('no band info -> NEW_TEST (never claims proven)', untestedLabeled.every((i) => i.status === 'NEW_TEST'));
}

console.log('\n§4 labelPostCopy — never claims WINNING_COPY without a real winner:');
{
  const post = { primaryText: 'x', headline: 'y' };
  ok('WINNER angle -> WINNING_COPY', labelPostCopy(post, { angleBand: 'WINNER' }).status === 'WINNING_COPY');
  ok('PROMISING angle -> VARIATION, not WINNING_COPY', labelPostCopy(post, { angleBand: 'PROMISING' }).status === 'VARIATION');
  ok('no angle band -> NEW_TEST', labelPostCopy(post, {}).status === 'NEW_TEST');
  ok('null post passed through unchanged', labelPostCopy(null, { angleBand: 'WINNER' }) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
