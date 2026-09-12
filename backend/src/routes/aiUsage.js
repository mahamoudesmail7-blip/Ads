// AI Gateway — admin usage/cost dashboard + health check (§38/§58/§59/§60).
// ADMIN-only, same auth tier as every other admin-only surface in the app.
// Read-only except two explicit, owner-triggered probes:
//   - /health: OpenAI's free model-list endpoint — never a generation call.
//   - /test-run: 3 tiny REAL text/structured/vision calls (§1/§83) — the
//     ONLY place in this file that spends real money, and only when an
//     admin explicitly clicks it. No image is generated for this — the
//     vision probe reuses an EXISTING Easy Orders product photo.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errorHandler.js';
import { usageSummary, checkBudget, healthCheck, allConfiguredModels, anthropicEnabled, generateText, TIERS } from '../services/aiGateway/index.js';
import { getEasyOrdersProducts } from '../services/amb/easyOrdersProducts.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

router.get('/summary', asyncRoute(async (req, res) => {
  const [usage, budget] = await Promise.all([usageSummary(), checkBudget()]);
  res.json({ usage, budget, models: allConfiguredModels(), anthropicEnabled: anthropicEnabled() });
}));

router.get('/health', asyncRoute(async (req, res) => {
  res.json(await healthCheck());
}));

/** One probe → {ok, model, latencyMs, ...} — never throws past this function; a failure is reported, not propagated, so one bad probe doesn't hide the other two. */
async function probe(fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    return { ok: true, latencyMs: Date.now() - startedAt, ...result };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: err.message };
  }
}

router.post('/test-run', asyncRoute(async (req, res) => {
  // A) tiny Luna text call — fixed cacheParts so calling this route TWICE
  // demonstrates §9's cache behaviour: 1st = a real call (cached:false),
  // 2nd = CACHE_HIT (cached:true, no new OpenAI spend).
  const luna = await probe(async () => {
    const r = await generateText({
      feature: 'diagnostic.luna_probe', tier: TIERS.ROUTINE,
      system: 'رد بكلمة واحدة فقط بالعربي، بدون أي شرح.',
      messages: [{ role: 'user', content: 'قول "تمام" وبس.' }],
      maxTokens: 20,
      cacheParts: { probe: 'luna-diagnostic-v1' }, // same key every call -> real proof of caching, not just a claim
      promptVersion: 'diagnostic-v1',
    });
    return { model: r.model, text: r.text, cached: r.cached, usage: r.usage, estimatedCostUsd: r.estimatedCostUsd };
  });

  // B) tiny structured JSON call — always fresh (no cacheParts), proves jsonMode works end to end.
  const structured = await probe(async () => {
    const r = await generateText({
      feature: 'diagnostic.structured_probe', tier: TIERS.ROUTINE,
      system: 'رجّع JSON فقط بالشكل: {"ok": true}',
      messages: [{ role: 'user', content: 'أكّد إنك شغال برجوع الـ JSON المطلوب.' }],
      maxTokens: 30,
      jsonMode: true,
    });
    let parsed = null; try { parsed = JSON.parse(r.text); } catch { /* reported as-is below */ }
    return { model: r.model, raw: r.text, parsed, validJson: parsed !== null, usage: r.usage, estimatedCostUsd: r.estimatedCostUsd };
  });

  // C) tiny vision call — reuses an EXISTING Easy Orders product image (no new upload, no image generated).
  const vision = await probe(async () => {
    const products = await getEasyOrdersProducts();
    const withImage = products.find((p) => p.thumb);
    if (!withImage) throw new Error('مفيش منتج له صورة في كتالوج Easy Orders لاختباره — الميزة نفسها سليمة، بس محتاج منتج حقيقي بصورة.');
    const imgRes = await fetch(withImage.thumb, { signal: AbortSignal.timeout(10000) });
    if (!imgRes.ok) throw new Error(`تعذّر تحميل صورة المنتج للاختبار: ${imgRes.status}`);
    const contentType = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const base64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
    const r = await generateText({
      feature: 'diagnostic.vision_probe', tier: TIERS.BALANCED,
      system: 'صف المنتج في الصورة بجملة واحدة قصيرة جدًا بالعربي.',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } }, { type: 'text', text: 'صف المنتج ده بسرعة.' }] }],
      maxTokens: 60,
    });
    return { model: r.model, productName: withImage.name, text: r.text, usage: r.usage, estimatedCostUsd: r.estimatedCostUsd };
  });

  res.json({ luna, structured, vision, ranAt: new Date().toISOString() });
}));

export default router;
