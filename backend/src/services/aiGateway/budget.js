// AI Gateway — monthly budget guard (§39/§40). Blocks non-essential
// generation at the hard limit; never blocks deterministic calculations,
// viewing cached analysis, or any other non-AI feature (the gateway is the
// ONLY thing this touches — nothing else in the app calls into it).
import { monthToDateCostUsd } from './usageLog.js';

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}
function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

export async function checkBudget() {
  const budgetUsd = envNum('OPENAI_MONTHLY_BUDGET_USD', null);
  if (budgetUsd === null) return { configured: false, ok: true, warning: false, blocked: false, spentUsd: null, budgetUsd: null, remainingUsd: null };

  const warningPct = envNum('OPENAI_WARNING_PERCENT', 80);
  const hardLimitEnabled = envBool('OPENAI_HARD_LIMIT_ENABLED', true);
  const spentUsd = await monthToDateCostUsd();
  const pct = budgetUsd > 0 ? (spentUsd / budgetUsd) * 100 : 0;
  const warning = pct >= warningPct;
  const blocked = hardLimitEnabled && pct >= 100;
  return { configured: true, ok: !blocked, warning, blocked, spentUsd: Math.round(spentUsd * 100) / 100, budgetUsd, remainingUsd: Math.max(0, Math.round((budgetUsd - spentUsd) * 100) / 100), pct: Math.round(pct * 10) / 10 };
}
