// Phase 1 AI shaping — pure functions only (shapeMarketGaps/shapeStrategistBrief).
// No network call, no prisma: these test the validation/defaulting logic that
// runs on whatever the AI returns, using fixed fixture JSON (incl.
// malformed/missing confidence, missing status, banned-claim text).
//   node src/scripts/productMarketingAiShapingTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { shapeMarketGaps, shapeStrategistBrief } = await import(pathToFileURL(join(__dirname, '../services/amb/productMarketingAI.js')).href);

console.log('§1 shapeMarketGaps — "observed" is built from the real competitor rows, NEVER from the AI:');
{
  const competitors = [{ platform: 'facebook', accountName: 'Comp A', accountUrl: 'http://x', country: 'EG', followerCount: 5000 }];
  const rawFromAi = { gaps: [{ gap: 'مفيش عرض واضح', interpretation: 'فرصة نعمل عرض واضح', confidence: 'HIGH' }] };
  const out = shapeMarketGaps(rawFromAi, competitors);
  ok('observed matches the real competitor row verbatim, untouched by AI', out.observed[0].accountName === 'Comp A' && out.observed[0].followerCount === 5000, JSON.stringify(out.observed));
  ok('gaps are forced kind:HYPOTHESIS, never presented as fact', out.gaps[0].kind === 'HYPOTHESIS', JSON.stringify(out.gaps[0]));
  ok('confidence passed through when valid', out.gaps[0].confidence === 'HIGH');
}

console.log('\n§2 shapeMarketGaps — invalid/missing confidence defaults to LOW, never trusted blind:');
{
  const out = shapeMarketGaps({ gaps: [{ gap: 'x', interpretation: 'y', confidence: 'SUPER_SURE' }] }, []);
  ok('bogus confidence value defaults to LOW', out.gaps[0].confidence === 'LOW', JSON.stringify(out.gaps[0]));
}

console.log('\n§3 shapeMarketGaps — no gaps in AI response -> empty gaps array, never fabricated:');
{
  const out = shapeMarketGaps({}, [{ platform: 'tiktok', accountName: 'Comp B' }]);
  ok('gaps empty when AI returns none', out.gaps.length === 0);
  ok('observed still reflects the real competitor row', out.observed[0].accountName === 'Comp B');
}

console.log('\n§4 shapeStrategistBrief — always returns exactly the 14 fixed questions, in order, even from a malformed/partial AI response:');
{
  const partial = { answers: [{ question: 'مين أستهدف؟', answer: 'نساء 25-34', status: 'DATA_BACKED' }] };
  const out = shapeStrategistBrief(partial);
  ok('exactly 14 answers', out.answers.length === 14, String(out.answers.length));
  ok('first question answered with the AI-provided status', out.answers[0].status === 'DATA_BACKED' && out.answers[0].answer === 'نساء 25-34');
  ok('every unanswered question defaults to INSUFFICIENT_DATA with an honest fallback text, never fabricated', out.answers.slice(1).every((a) => a.status === 'INSUFFICIENT_DATA' && a.answer.includes('لا توجد')), JSON.stringify(out.answers[1]));
  ok('question text is always the exact fixed Arabic text, never altered', out.answers[13].question === 'إيه أعلى خطوة تأثيرًا نعملها دلوقتي؟');
}

console.log('\n§5 shapeStrategistBrief — an invalid status value from the AI is never trusted blind:');
{
  const out = shapeStrategistBrief({ answers: [{ question: 'مين أستهدف؟', answer: 'x', status: 'DEFINITELY_TRUE' }] });
  ok('bogus status defaults to AI_HYPOTHESIS, not DATA_BACKED', out.answers[0].status === 'AI_HYPOTHESIS', JSON.stringify(out.answers[0]));
}

console.log('\n§6 shapeStrategistBrief — completely empty/malformed AI response still returns a safe, honest 14-item structure:');
{
  const out = shapeStrategistBrief({});
  ok('14 answers, all INSUFFICIENT_DATA', out.answers.length === 14 && out.answers.every((a) => a.status === 'INSUFFICIENT_DATA'));
  const out2 = shapeStrategistBrief(null);
  ok('null input never throws', out2.answers.length === 14);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
