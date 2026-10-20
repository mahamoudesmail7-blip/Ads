// exactProductJudge.js — «نفس المنتج بالظبط»: a strict vision-AI judge that looks at the user's reference photo(s) next to each candidate result image
// and answers ONE question: is this THE SAME PRODUCT (same model / design / colorway), not a similar one?
//
// WHY: the local embedding score alone can't tell «the same shoe» from «a similar shoe» — in every past image search not one result ever reached EXACT
// (95) and only the first 60 results were compared at all; the other 250-380 stayed unverified, so the owner kept seeing look-alikes. This judge compares
// every candidate that has a real thumbnail (up to EXACT_JUDGE_MAX), 5 per call, and decides:
//   EXACT   — same product, confidence >= 85
//   REVIEW  — probably the same product (60-84): shown only in the «محتاج مراجعة» tab, never as a match
//   REJECT  — anything else (similar / different colour or pattern / other product / unreadable) — hidden
// Anything it could not judge (no thumbnail, image download failed, AI unavailable) stays UNVERIFIED — never promoted, never faked.
import { logger } from '../logger.js';
import { generateText, TIERS } from './aiGateway/index.js';

export const JUDGE_BATCH_SIZE = 5;
export const EXACT_MIN_CONFIDENCE = 85;
export const REVIEW_MIN_CONFIDENCE = 60;
export const judgeMaxCandidates = () => Math.max(10, Number(process.env.EXACT_JUDGE_MAX) || 300);
export const exactJudgeEnabled = () => (process.env.EXACT_JUDGE_ENABLED || 'true').trim().toLowerCase() !== 'false';

const SYSTEM = `You are a STRICT product-identity inspector for an e-commerce media buyer.
You get the REFERENCE photo(s) of the exact product the buyer wants, then numbered CANDIDATE images from ads / videos / posts.
For EACH candidate decide whether it shows THE SAME PRODUCT as the reference — the same make/model/design.

SAME product means the same design: overall shape and proportions, sole / handle / buttons / ports / strap layout, pattern, mesh or texture, logo placement and the same colour combination.
Photo angle, lighting, background, packaging, a person holding or wearing it, or a different crop may differ.

NOT the same (answer sameProduct=false): a similar product of the same category or style; a different colour combination; a different pattern / mesh / sole / shape; a look-alike or another brand;
a collage or ad showing several products; a person/scene without the product clearly visible; a logo, text-only image or screenshot.
If you cannot clearly see the product, or you have ANY real doubt, answer sameProduct=false. Being wrong by accepting a look-alike is much worse than missing a match.

confidence = 0-100, how sure you are that the candidate is the exact same product.
Answer with JSON ONLY: {"results":[{"index":1,"sameProduct":false,"confidence":12,"reason":"سطر قصير بالعربي"}]} — one entry per candidate, using the candidate numbers you were given.`;

export function decideFromJudge({ sameProduct, confidence }) {
  const c = Number(confidence);
  if (sameProduct === true && c >= EXACT_MIN_CONFIDENCE) return 'EXACT';
  if (sameProduct === true && c >= REVIEW_MIN_CONFIDENCE) return 'REVIEW';
  return 'REJECT';
}

function parseJson(text) { try { return JSON.parse(text); } catch { const m = /\{[\s\S]*\}/.exec(text || ''); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } } }

/** Downloads one candidate thumbnail as base64 (bounded). Throws on anything that is not a real, reasonably small image. */
export async function fetchImageBase64(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0];
  if (!type.startsWith('image/')) throw new Error('not an image');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) throw new Error('image too large');
  if (buf.length < 800) throw new Error('image too small');
  return { base64: buf.toString('base64'), mediaType: type };
}

/**
 * Judges ONE batch (<= JUDGE_BATCH_SIZE candidates) with ONE AI call.
 * @param {{imageBase64:string, imageMediaType?:string}[]} references the uploaded reference photo(s) (max 2 are sent)
 * @param {{id:number, url:string, text?:string}[]} candidates
 * @returns {Promise<{id:number, decision:'EXACT'|'REVIEW'|'REJECT'|null, confidence:number|null, reason:string|null, error?:string}[]>}
 */
export async function judgeBatch({ references, candidates, generateTextFn = generateText, fetchImageFn = fetchImageBase64 }) {
  const loaded = [];
  const out = new Map();
  await Promise.all(candidates.map(async (c) => {
    try { loaded.push({ ...c, img: await fetchImageFn(c.url) }); }
    catch (e) { out.set(c.id, { id: c.id, decision: null, confidence: null, reason: null, error: `image: ${e.message}` }); }
  }));
  loaded.sort((a, b) => candidates.findIndex((x) => x.id === a.id) - candidates.findIndex((x) => x.id === b.id));
  if (loaded.length === 0) return candidates.map((c) => out.get(c.id));

  const content = [{ type: 'text', text: 'REFERENCE product photo(s) — the exact product the buyer wants:' }];
  for (const r of (references || []).slice(0, 2)) content.push({ type: 'image', source: { type: 'base64', media_type: r.imageMediaType || 'image/jpeg', data: r.imageBase64 } });
  loaded.forEach((c, i) => {
    content.push({ type: 'text', text: `CANDIDATE ${i + 1}${c.text ? ` (its own title: ${String(c.text).slice(0, 120)})` : ''}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: c.img.mediaType, data: c.img.base64 } });
  });
  content.push({ type: 'text', text: `Judge candidates 1..${loaded.length} now. JSON only.` });

  let parsed = null;
  try {
    const { text } = await generateTextFn({ feature: 'research.exact_product_judge', tier: TIERS.BALANCED, system: SYSTEM, messages: [{ role: 'user', content }], maxTokens: 900, jsonMode: true });
    parsed = parseJson(text);
  } catch (e) {
    for (const c of loaded) out.set(c.id, { id: c.id, decision: null, confidence: null, reason: null, error: `ai: ${e.message}`, aiFailed: true });
    return candidates.map((c) => out.get(c.id));
  }
  const rows = Array.isArray(parsed?.results) ? parsed.results : [];
  loaded.forEach((c, i) => {
    const row = rows.find((r) => Number(r?.index) === i + 1);
    if (!row || typeof row.sameProduct !== 'boolean') { out.set(c.id, { id: c.id, decision: null, confidence: null, reason: null, error: 'ai: no verdict for this candidate' }); return; }
    const confidence = Math.max(0, Math.min(100, Math.round(Number(row.confidence) || 0)));
    out.set(c.id, { id: c.id, decision: decideFromJudge({ sameProduct: row.sameProduct, confidence }), confidence, reason: row.reason ? String(row.reason).slice(0, 220) : null });
  });
  return candidates.map((c) => out.get(c.id));
}

/**
 * Judges many candidates: batches of JUDGE_BATCH_SIZE, a few batches in parallel, with a time budget, cancellation, and a circuit breaker
 * (3 consecutive AI failures → stop and say so, instead of grinding through hundreds of doomed calls).
 * @returns {Promise<{judged: object[], aborted: null|'AI_UNAVAILABLE'|'BUDGET'|'CANCELLED', batches:number}>}
 */
export async function judgeCandidates({ references, candidates, concurrency = 3, budgetMs = 7 * 60 * 1000, isCancelled = () => false, onBatch = null, generateTextFn, fetchImageFn }) {
  const batches = [];
  for (let i = 0; i < candidates.length; i += JUDGE_BATCH_SIZE) batches.push(candidates.slice(i, i + JUDGE_BATCH_SIZE));
  const judged = []; let next = 0; let aiFailStreak = 0; let aborted = null; let done = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (!aborted) {
      if (isCancelled()) { aborted = 'CANCELLED'; return; }
      if (Date.now() - t0 > budgetMs) { aborted = 'BUDGET'; return; }
      const mine = next++; if (mine >= batches.length) return;
      const res = await judgeBatch({ references, candidates: batches[mine], generateTextFn, fetchImageFn });
      judged.push(...res);
      if (res.some((r) => r.aiFailed)) { aiFailStreak++; if (aiFailStreak >= 3) { aborted = 'AI_UNAVAILABLE'; logger.error('[ExactJudge] AI unavailable — stopping', { sample: res.find((r) => r.aiFailed)?.error }); return; } }
      else aiFailStreak = 0;
      done++; if (onBatch) await onBatch({ done, total: batches.length }).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { judged, aborted, batches: done };
}
