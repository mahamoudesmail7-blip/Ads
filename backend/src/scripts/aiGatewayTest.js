// Offline tests for the AI Gateway (OpenAI migration, §80). Mixes pure-logic
// checks (router/cache-hash/cost-estimator/budget-math — no network, no DB)
// with real-DB round-trips for the cache + usage log (cleaned up after).
// No real OpenAI call is made anywhere in this file.
//   node src/scripts/aiGatewayTest.js
import 'dotenv/config';
import fs from 'node:fs';
import { prisma } from '../prisma.js';
import { modelForTier, imageModel, TIERS } from '../services/aiGateway/router.js';
import { requestHash, cacheGet, cacheSet, cacheInvalidate } from '../services/aiGateway/cache.js';
import { estimateTextCostUsd } from '../services/aiGateway/costEstimator.js';
import { logUsage, usageSummary } from '../services/aiGateway/usageLog.js';
import { checkBudget } from '../services/aiGateway/budget.js';
import { anthropicEnabled, isAiConfigured } from '../services/aiGateway/index.js';
import { askClaude, runAgentTurn } from '../services/ai.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

console.log('§4 Model routing (env-driven, never hardcoded past the documented default):');
{
  const prevRoutine = process.env.AI_TEXT_ROUTINE_MODEL;
  delete process.env.AI_TEXT_ROUTINE_MODEL;
  ok('routine tier falls back to the documented default when unset', modelForTier(TIERS.ROUTINE) === 'gpt-5.6-luna');
  process.env.AI_TEXT_ROUTINE_MODEL = 'custom-routine-model';
  ok('routine tier honours an explicit env override', modelForTier(TIERS.ROUTINE) === 'custom-routine-model');
  if (prevRoutine === undefined) delete process.env.AI_TEXT_ROUTINE_MODEL; else process.env.AI_TEXT_ROUTINE_MODEL = prevRoutine;
  ok('unknown tier never throws — falls back to routine', modelForTier('nonsense') === modelForTier(TIERS.ROUTINE));
  ok('image model has a real default', typeof imageModel() === 'string' && imageModel().length > 0);
}

console.log('\n§32/§33 Cache request-hash (deterministic, order-independent):');
{
  const a = requestHash({ feature: 'x', model: 'm1', promptVersion: 'v1', parts: { b: 2, a: 1 } });
  const b = requestHash({ feature: 'x', model: 'm1', promptVersion: 'v1', parts: { a: 1, b: 2 } });
  ok('key order in `parts` never changes the hash', a === b);
  const c = requestHash({ feature: 'x', model: 'm1', promptVersion: 'v1', parts: { a: 1, b: 3 } });
  ok('a different input value changes the hash', a !== c);
  const d = requestHash({ feature: 'x', model: 'm1', promptVersion: 'v2', parts: { a: 1, b: 2 } });
  ok('a different prompt version changes the hash (§44)', a !== d);
}

console.log('\n§32/§34 Cache get/set/invalidate (real DB, cleaned up):');
{
  const key = requestHash({ feature: 'aiGatewayTest', model: 'test-model', parts: { probe: Date.now() } });
  const miss = await cacheGet(key);
  ok('a never-written key is a clean miss (null), never a crash', miss === null);
  await cacheSet({ cacheKey: key, feature: 'aiGatewayTest', data: 'hello world', ttlMs: null });
  const hit = await cacheGet(key);
  ok('a written key round-trips exactly', hit === 'hello world');
  await cacheInvalidate(key);
  const afterInvalidate = await cacheGet(key);
  ok('§77 "إعادة التحليل" invalidation actually clears the row', afterInvalidate === null);

  const shortLived = requestHash({ feature: 'aiGatewayTest', model: 'test-model', parts: { ttlProbe: Date.now() } });
  await cacheSet({ cacheKey: shortLived, feature: 'aiGatewayTest', data: 'expires soon', ttlMs: -1000 }); // already expired
  const expiredRead = await cacheGet(shortLived);
  ok('an expired TTL row reads as a miss, not stale data', expiredRead === null);
  await cacheInvalidate(shortLived);
}

console.log('\n§37 Cost estimation (never a guessed number when unpriced):');
{
  delete process.env.AI_PRICE_ROUTINE_INPUT_PER_1M;
  delete process.env.AI_PRICE_ROUTINE_OUTPUT_PER_1M;
  ok('no configured rate -> null, never invented', estimateTextCostUsd({ tier: 'routine', inputTokens: 1000, outputTokens: 500 }) === null);
  process.env.AI_PRICE_ROUTINE_INPUT_PER_1M = '1';
  process.env.AI_PRICE_ROUTINE_OUTPUT_PER_1M = '2';
  const cost = estimateTextCostUsd({ tier: 'routine', inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 });
  ok('configured rate -> real math ($1 + $2 = $3 for 1M/1M tokens)', cost === 3, String(cost));
  const costWithCache = estimateTextCostUsd({ tier: 'routine', inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 });
  ok('fully-cached input tokens are never billed again', costWithCache === 0);
  delete process.env.AI_PRICE_ROUTINE_INPUT_PER_1M;
  delete process.env.AI_PRICE_ROUTINE_OUTPUT_PER_1M;
}

console.log('\n§39 Budget guard (real usage-log rows, cleaned up):');
{
  const prevBudget = process.env.OPENAI_MONTHLY_BUDGET_USD;
  const prevHard = process.env.OPENAI_HARD_LIMIT_ENABLED;
  delete process.env.OPENAI_MONTHLY_BUDGET_USD;
  const unconfigured = await checkBudget();
  ok('no budget configured -> never blocks, ok:true', unconfigured.configured === false && unconfigured.ok === true && unconfigured.blocked === false);

  process.env.OPENAI_MONTHLY_BUDGET_USD = '0.000001'; // effectively zero — any real spend this month trips it
  process.env.OPENAI_HARD_LIMIT_ENABLED = 'true';
  await logUsage({ feature: 'aiGatewayTest.budget_probe', tier: 'routine', model: 'test-model', status: 'SUCCESS', estimatedCostUsd: 5 });
  const blocked = await checkBudget();
  ok('spend past a tiny hard-limit budget -> blocked:true', blocked.configured === true && blocked.blocked === true);

  process.env.OPENAI_HARD_LIMIT_ENABLED = 'false';
  const warnOnly = await checkBudget();
  ok('hard limit disabled -> never blocks even over budget, still ok:true', warnOnly.blocked === false && warnOnly.ok === true);

  await prisma.aiUsageLog.deleteMany({ where: { feature: 'aiGatewayTest.budget_probe' } });
  if (prevBudget === undefined) delete process.env.OPENAI_MONTHLY_BUDGET_USD; else process.env.OPENAI_MONTHLY_BUDGET_USD = prevBudget;
  if (prevHard === undefined) delete process.env.OPENAI_HARD_LIMIT_ENABLED; else process.env.OPENAI_HARD_LIMIT_ENABLED = prevHard;
}

console.log('\n§37/§38 Usage logging + summary aggregation (real DB, cleaned up):');
{
  await logUsage({ feature: 'aiGatewayTest.summary_probe', tier: 'routine', model: 'test-model', status: 'SUCCESS', estimatedCostUsd: 1.5, cached: false });
  await logUsage({ feature: 'aiGatewayTest.summary_probe', tier: 'routine', model: 'test-model', status: 'SUCCESS', estimatedCostUsd: 0, cached: true });
  await logUsage({ feature: 'aiGatewayTest.summary_probe', tier: 'routine', model: 'test-model', status: 'FAILED', error: 'boom' });
  const summary = await usageSummary();
  ok('month-to-date call count includes the rows just logged', summary.month.calls >= 3);
  ok('a FAILED row is counted in the failed bucket somewhere in the window totals', summary.today.failed + summary.last7.failed + summary.month.failed >= 1);
  await prisma.aiUsageLog.deleteMany({ where: { feature: 'aiGatewayTest.summary_probe' } });
}

console.log('\n§47 Anthropic is disabled and unreachable (never a silent fallback):');
{
  ok('ANTHROPIC_ENABLED is not "true" in this environment', anthropicEnabled() === false, `(actual: ${process.env.ANTHROPIC_ENABLED})`);
  let threw = null;
  try { await askClaude({ system: 's', messages: [{ role: 'user', content: 'hi' }] }); } catch (err) { threw = err; }
  ok('askClaude() refuses to run (throws before any network call)', threw !== null && /Anthropic معطّل/.test(threw.message));
  let threw2 = null;
  try { await runAgentTurn({ system: 's', userMessage: 'hi', tools: [], executeTool: async () => ({}) }); } catch (err) { threw2 = err; }
  ok('runAgentTurn() refuses to run too', threw2 !== null && /Anthropic معطّل/.test(threw2.message));

  const gatewaySrc = fs.readFileSync(new URL('../services/aiGateway/index.js', import.meta.url), 'utf8');
  ok('the gateway\'s own source never imports the legacy Anthropic client', !/from ['"].*\/ai\.js['"]/.test(gatewaySrc));
  const openaiClientSrc = fs.readFileSync(new URL('../services/aiGateway/openaiClient.js', import.meta.url), 'utf8');
  ok('the low-level OpenAI client never imports the legacy Anthropic client either', !/from ['"].*\/ai\.js['"]/.test(openaiClientSrc));
}

console.log('\nisAiConfigured() reflects OPENAI_API_KEY only:');
{
  ok('isAiConfigured() matches OPENAI_API_KEY presence', isAiConfigured() === !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
