// Regression test for the PMC data-completeness diagnostic
// (assembleDataCompleteness). Pure function, no DB/AI — verifies every
// dimension classifies correctly from already-known signals, and that
// Block D's honest limitation (Meta demographics never collected) is
// always reported as MISSING with a clear reason, never silently hidden.
//   node src/scripts/dataCompletenessTest.js
import { assembleDataCompleteness } from '../services/amb/productMarketingAssemblers.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

console.log('§1 metaPerformance — AVAILABLE only with a real mapping AND real spend, PARTIAL when mapped but no spend yet, MISSING when unmapped:');
{
  const available = assembleDataCompleteness({ metaMapped: true, metrics: { totalSpend: 500 }, cod: {}, ai: { ok: true } });
  ok('mapped + real spend -> AVAILABLE', available.metaPerformance.status === 'AVAILABLE');
  const partial = assembleDataCompleteness({ metaMapped: true, metrics: { totalSpend: 0 }, cod: {}, ai: { ok: true } });
  ok('mapped but zero spend -> PARTIAL, not AVAILABLE', partial.metaPerformance.status === 'PARTIAL');
  const missing = assembleDataCompleteness({ metaMapped: false, metrics: {}, cod: {}, ai: { ok: true } });
  ok('no mapping at all -> MISSING', missing.metaPerformance.status === 'MISSING');
}

console.log('\n§2 easyOrders — AVAILABLE/PARTIAL/MISSING mirror the real cod.source:');
{
  ok('source easyorders -> AVAILABLE', assembleDataCompleteness({ cod: { source: 'easyorders' }, ai: { ok: true } }).easyOrders.status === 'AVAILABLE');
  ok('source daily_orders -> PARTIAL (less detail)', assembleDataCompleteness({ cod: { source: 'daily_orders' }, ai: { ok: true } }).easyOrders.status === 'PARTIAL');
  ok('source none -> MISSING', assembleDataCompleteness({ cod: { source: 'none' }, ai: { ok: true } }).easyOrders.status === 'MISSING');
}

console.log('\n§3 economics — mirrors the real revenueSource flag from netProfitBundle:');
{
  ok('revenueSource real -> AVAILABLE', assembleDataCompleteness({ cod: {}, revenueSource: 'real', ai: { ok: true } }).economics.status === 'AVAILABLE');
  ok('revenueSource estimated -> PARTIAL, honestly labeled', assembleDataCompleteness({ cod: {}, revenueSource: 'estimated', ai: { ok: true } }).economics.status === 'PARTIAL');
  ok('revenueSource null (no delivered orders known) -> MISSING', assembleDataCompleteness({ cod: {}, revenueSource: null, ai: { ok: true } }).economics.status === 'MISSING');
}

console.log('\n§4 demographics — ALWAYS MISSING with an honest reason (Block D: Meta breakdowns never collected), never fabricated or silently hidden:');
{
  const d = assembleDataCompleteness({ cod: {}, ai: { ok: true } });
  ok('demographics.status is always MISSING', d.demographics.status === 'MISSING');
  ok('reason explicitly explains WHY (Meta breakdowns not collected), not a vague "insufficient data"', d.demographics.reason.includes('breakdowns'), d.demographics.reason);
}

console.log('\n§5 geography — AVAILABLE when real markets/locations exist, MISSING otherwise:');
{
  ok('markets present -> AVAILABLE', assembleDataCompleteness({ cod: {}, markets: [{ government: 'القاهرة' }], ai: { ok: true } }).geography.status === 'AVAILABLE');
  ok('locations present (fallback) -> AVAILABLE', assembleDataCompleteness({ cod: {}, locations: [{ government: 'الجيزة' }], ai: { ok: true } }).geography.status === 'AVAILABLE');
  ok('neither -> MISSING', assembleDataCompleteness({ cod: {}, markets: [], locations: [], ai: { ok: true } }).geography.status === 'MISSING');
}

console.log('\n§6 creative — AVAILABLE with real analysis, PARTIAL with a best ad but no analysis, MISSING with no best ad:');
{
  ok('bestAd with analysis -> AVAILABLE', assembleDataCompleteness({ cod: {}, bestAd: { analysis: { hook: 'x' } }, ai: { ok: true } }).creative.status === 'AVAILABLE');
  ok('bestAd without analysis -> PARTIAL', assembleDataCompleteness({ cod: {}, bestAd: { analysis: null }, ai: { ok: true } }).creative.status === 'PARTIAL');
  ok('no bestAd -> MISSING', assembleDataCompleteness({ cod: {}, bestAd: null, ai: { ok: true } }).creative.status === 'MISSING');
}

console.log('\n§7 hooks — reflects whether hookAngleIntel is currently enabled (Block B re-enablement flag), never fakes AVAILABLE:');
{
  ok('disabled (default) -> MISSING with an honest reason', assembleDataCompleteness({ cod: {}, ai: { ok: true } }).hooks.status === 'MISSING');
  ok('enabled flag -> AVAILABLE', assembleDataCompleteness({ cod: {}, ai: { ok: true }, hookAngleIntelEnabled: true }).hooks.status === 'AVAILABLE');
}

console.log('\n§8 ai — reflects the real buildIntelligenceReport() outcome, ERROR (not MISSING) when it failed:');
{
  ok('ai.ok true -> AVAILABLE', assembleDataCompleteness({ cod: {}, ai: { ok: true } }).ai.status === 'AVAILABLE');
  const failed = assembleDataCompleteness({ cod: {}, ai: { ok: false, reason: 'مشكلة في الشبكة' } });
  ok('ai.ok false -> ERROR, with the real failure reason surfaced', failed.ai.status === 'ERROR' && failed.ai.reason === 'مشكلة في الشبكة');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
