// Smart Decision Center Phase 10 — Product Learning Memory. Reuses the
// EXISTING productMarketingTests.js recordLearning()/listLearning() write
// path (pmc_learning + pmc_memory tables) as-is — no new schema, no second
// write path. The only new pieces:
//  (1) resolving a real Product.id (the Smart Decision Center's own root
//      entity) to the ProductMarketingProfile learning has always been
//      scoped to — Phase 1-9 work by product, PMC learning is profile-based;
//  (2) translating a Phase 9 experiment outcome into a WORKS/DOES_NOT_WORK
//      verdict per winning dimension, following the exact rule
//      productMarketingTests.js's own recordTestResult() already
//      established: a NEUTRAL/INCONCLUSIVE result never overwrites an
//      earlier confirmed verdict with a weaker or absent signal;
//  (3) a presentation-only vocabulary reconciliation (PROVEN/PROMISING/
//      REJECTED/STALE) for the Smart Decision Center, layered over the
//      existing WORKS/DOES_NOT_WORK/INCONCLUSIVE storage — never a second
//      classification, never a schema change.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { recordLearning, listLearning } from './productMarketingTests.js';

const PROVEN_SAMPLE_THRESHOLD = 20; // mirrors productMarketingScoring.js's own CONFIRMATION_PROBLEM evidence gate (codSample>=20)
const STALE_AFTER_DAYS = 45; // a marketing conclusion not reconfirmed in this long needs re-verification before being trusted again

/** Learning is profile-scoped; Smart Decision Center decisions are product-scoped. Resolves the most recently touched real profile for a product — NEVER creates one implicitly (no fabricated profile). */
export async function resolveProfileForProduct(productId) {
  return prisma.productMarketingProfile.findFirst({ where: { product_id: Number(productId) }, orderBy: { created_at: 'desc' }, select: { id: true } });
}

// Matches productDecision.js's OWN winners object shape exactly
// (winners.creative/hook/angle/primaryText/headline/age/gender/governorate)
// and productMarketingTests.js's pre-existing dimension mapping convention
// (its own COPY -> CREATIVE precedent is why primaryText/headline land on
// CREATIVE here too, rather than inventing a new dimension name).
const WINNER_DIMENSION = { creative: 'CREATIVE', hook: 'HOOK', angle: 'ANGLE', primaryText: 'CREATIVE', headline: 'CREATIVE', gender: 'AUDIENCE', age: 'AUDIENCE', governorate: 'MARKET' };

/**
 * Called after a Phase 9 experiment is evaluated. Translates the Decision
 * Package's OWN named winners (facts.winners, from productDecision.js) into
 * learning verdicts — only for a genuinely resolved IMPROVED/WORSE outcome,
 * mirroring the pre-existing "a NEUTRAL result teaches nothing" rule so a
 * shaky, inconclusive experiment can never quietly overwrite real evidence.
 */
export async function applyLearningFromExperiment({ productId, facts, resultClass, evidence }) {
  if (resultClass !== 'SUCCESSFUL' && resultClass !== 'FAILED') return { written: [] };
  const profile = await resolveProfileForProduct(productId);
  if (!profile) return { written: [], reason: 'NO_PROFILE' };

  const verdict = resultClass === 'SUCCESSFUL' ? 'WORKS' : 'DOES_NOT_WORK';
  const winners = facts?.winners || {};
  const written = [];
  for (const [field, dimension] of Object.entries(WINNER_DIMENSION)) {
    const w = winners[field];
    const key = w?.label || w?.segment;
    if (!key) continue;
    const sampleSize = w.sampleSize ?? w.orders ?? w.purchases ?? 0;
    try {
      // recordLearning() only ever upserts pmc_learning (it's shared with
      // productMarketingTests.js's own unrelated callers) — the full
      // previous/new audit trail this Phase requires is written separately
      // here, scoped to decision-driven learning changes only.
      const existing = await prisma.productMarketingLearning.findUnique({ where: { profile_id_dimension_key: { profile_id: profile.id, dimension, key } } });
      await recordLearning({ profileId: profile.id, dimension, key, verdict, sampleSize, evidence: { ...evidence, field } });
      await prisma.productMarketingMemoryEntry.create({
        data: {
          profile_id: profile.id, field: `${dimension}:${key}`,
          previous_json: existing ? JSON.stringify({ verdict: existing.verdict, sample_size: existing.sample_size }) : null,
          new_json: JSON.stringify({ verdict, sample_size: sampleSize }),
          evidence: JSON.stringify({ ...evidence, field }),
        },
      });
      written.push({ dimension, key, verdict });
    } catch (err) {
      logger.warn('[productLearning] recordLearning failed', { productId, dimension, key, message: err.message });
    }
  }
  return { written };
}

/** PROVEN/PROMISING/REJECTED/STALE — presentation only; the stored verdict/sample_size/computed_at are never mutated here. */
function reconcile(row) {
  const ageDays = (Date.now() - new Date(row.computed_at).getTime()) / 86400000;
  if (ageDays > STALE_AFTER_DAYS) return 'STALE';
  if (row.verdict === 'DOES_NOT_WORK') return 'REJECTED';
  if (row.verdict === 'WORKS' && row.sample_size >= PROVEN_SAMPLE_THRESHOLD) return 'PROVEN';
  return 'PROMISING';
}

/** The Smart Decision Center's read view of a product's accumulated marketing memory. */
export async function getProductLearningMemory({ productId }) {
  const profile = await resolveProfileForProduct(productId);
  if (!profile) return { hasProfile: false, entries: [] };
  const rows = await listLearning(profile.id);
  return {
    hasProfile: true, profileId: profile.id,
    entries: rows.map((r) => ({
      dimension: r.dimension, key: r.key, state: reconcile(r),
      verdict: r.verdict, sampleSize: r.sample_size, computedAt: r.computed_at,
      evidence: r.evidence_json ? JSON.parse(r.evidence_json) : null,
    })),
  };
}
