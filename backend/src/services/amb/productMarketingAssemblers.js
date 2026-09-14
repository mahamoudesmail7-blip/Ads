// Product Marketing Center — Phase 1 pure assemblers. Zero DB reads, zero AI
// calls: every function here only combines objects productMarketing.js's
// computeSnapshot() has already computed elsewhere (diagnosis, actions,
// hook/angle intel, markets, winning formula). No new signal is invented.

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * §4 "Needs Your Attention" — ranks already-computed diagnosis items and
 * prioritized actions into one P0->P3 list. Adds nothing the caller didn't
 * already compute; this is assembly + ranking only.
 */
export function assembleNeedsAttention({ diagnosis = [], actions = [], hookIntel = null, angleIntel = null } = {}) {
  const items = [];

  for (const d of diagnosis) {
    if (d.category === 'HEALTHY_PRODUCT') continue; // nothing to flag
    items.push({
      priority: d.priority || 'P3',
      type: d.category === 'INSUFFICIENT_DATA' || d.category === 'TRACKING_MAPPING_PROBLEM' ? 'MISSING_DATA' : 'PROBLEM',
      what: d.problem,
      why: d.evidence,
      action: d.action,
      confidence: d.dataSufficiency === 'STRONG' ? 'HIGH' : d.dataSufficiency === 'MODERATE' ? 'MEDIUM' : 'LOW',
      dataSufficiency: d.dataSufficiency,
    });
  }

  for (const a of actions) {
    items.push({
      priority: a.priority || 'P2',
      type: 'OPPORTUNITY',
      what: a.title,
      why: a.reason,
      action: a.expectedBenefit || a.title,
      confidence: a.confidence || 'MEDIUM',
      dataSufficiency: null,
    });
  }

  const winnerHook = hookIntel?.winner;
  if (winnerHook) {
    items.push({
      priority: 'P1', type: 'OPPORTUNITY',
      what: `Hook فائز موجود: ${winnerHook.label}`,
      why: winnerHook.why,
      action: 'استخدم نفس الـHook في كرياتيفات جديدة أو زوّد ميزانيته.',
      confidence: 'HIGH', dataSufficiency: 'STRONG',
    });
  }
  const winnerAngle = angleIntel?.winner;
  if (winnerAngle) {
    items.push({
      priority: 'P1', type: 'OPPORTUNITY',
      what: `Selling Angle فائز موجود: ${winnerAngle.label}`,
      why: winnerAngle.why,
      action: 'ابنِ Creative/Copy جديد حول نفس الـAngle.',
      confidence: 'HIGH', dataSufficiency: 'STRONG',
    });
  }

  items.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9));
  return items;
}

/**
 * §21 "Winning Components" — pulls together already-known winners into one
 * object with a `why` built from evidence already present on each piece.
 */
export function assembleWinningComponents({ bestAd = null, bestAdCreative = null, hookIntel = null, angleIntel = null, markets = [], winningFormula = null } = {}) {
  const bestMarket = (markets || []).filter((m) => m.band === 'SCALE_MARKET').sort((a, b) => (b.delivered || 0) - (a.delivered || 0))[0]
    || (markets || []).slice().sort((a, b) => (b.delivered || 0) - (a.delivered || 0))[0]
    || null;

  return {
    bestMarket: bestMarket ? { government: bestMarket.government, why: `${bestMarket.delivered} طلب مُستلم من ${bestMarket.orders}${bestMarket.band ? ` (${bestMarket.band})` : ''}.` } : null,
    bestHook: hookIntel?.winner ? { label: hookIntel.winner.label, why: hookIntel.winner.why } : null,
    bestSellingAngle: angleIntel?.winner ? { label: angleIntel.winner.label, why: angleIntel.winner.why } : null,
    bestAd: bestAd ? { id: bestAd.id, name: bestAd.name, why: bestAd.analysis ? `Hook: ${bestAd.analysis.hook || '—'} / Angle: ${bestAd.analysis.sellingAngle || '—'}` : 'أفضل إعلان حاليًا حسب الأداء الحقيقي.' } : null,
    bestCreative: bestAdCreative || null,
    bestOffer: winningFormula?.available ? { summary: winningFormula.narrative || null } : null,
    dataSufficient: Boolean(bestMarket || hookIntel?.winner || angleIntel?.winner || bestAd),
  };
}

const CREATIVE_IDEA_STATUS = {
  matchesWinner: 'CREATE_MORE_LIKE_THIS',
  newAngle: 'NEW_TEST',
  refreshWinner: 'REFRESH_WINNER',
  matchesWeak: 'STOP_REPEATING',
};

/** §12 — status labels for the EXISTING (ephemeral) generateCreativeIdeas() output, post-processing only. */
export function labelCreativeIdeas(ideas = [], { hookBand = null, angleBand = null } = {}) {
  return (ideas || []).map((idea) => {
    let status = CREATIVE_IDEA_STATUS.newAngle;
    if (angleBand === 'WINNER' || hookBand === 'WINNER') status = CREATIVE_IDEA_STATUS.matchesWinner;
    else if (angleBand === 'WEAK' || hookBand === 'WEAK') status = CREATIVE_IDEA_STATUS.matchesWeak;
    else if (angleBand === 'PROMISING' || hookBand === 'PROMISING') status = CREATIVE_IDEA_STATUS.refreshWinner;
    return { ...idea, status };
  });
}

/** §13 — status label for the EXISTING (ephemeral) generatePost() output, post-processing only. */
export function labelPostCopy(post, { angleBand = null } = {}) {
  if (!post) return post;
  let status = 'NEW_TEST';
  if (angleBand === 'WINNER') status = 'WINNING_COPY';
  else if (angleBand === 'PROMISING' || angleBand === 'AVERAGE') status = 'VARIATION';
  return { ...post, status };
}
