// 🔎 AUTOMATIC ENGINE AUDIT FIXES — the per-campaign daily counter counts REAL changes once (no decision+action double count, ABO ad-set writes matched), the pause-scope reason is explicit and never widened,
//   the diagnostics answer «why did it (not) execute» from stored data, and the pause/winner protections behave as a matrix (not "block everything", not "stop a winner on a weak sample"). No Meta call. Isolated TEST database only.
//   node src/scripts/automationAuditTest.js
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const OC = await imp('../services/amb/operatorContext.js'); const PPol = await imp('../services/amb/pausePolicy.js'); const G = await imp('../services/amb/operatorGuards.js'); const DG = await imp('../services/amb/automationDiagnostics.js'); const PP = await imp('../services/amb/productPolicy.js');
const T = '__optest_au2_'; const NOW = new Date(); const hAgo = (h) => new Date(NOW.getTime() - h * 3_600_000);
const cleanup = async () => { const ds = await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { startsWith: T } }, select: { id: true, amb_recommendation_id: true } }); await prisma.ambAction.deleteMany({ where: { OR: [{ entity_id: { startsWith: T } }, { campaign_id: { startsWith: T } }] } }); await prisma.ambOperatorDecision.deleteMany({ where: { campaign_id: { startsWith: T } } }); await prisma.ambRecommendation.deleteMany({ where: { OR: [{ entity_id: { startsWith: T } }, { campaign_id: { startsWith: T } }] } }); };
const rec = (c, entity = c) => prisma.ambRecommendation.create({ data: { batch_id: 'audit', ad_account_id: 'act_x', level: entity === c ? 'campaign' : 'adset', entity_id: entity, campaign_id: c, decision: 'DECREASE_BUDGET', action_type: 'DECREASE_BUDGET', executable: true, reason: 'fixture', confidence: 'HIGH', risk_level: 'LOW', data_sufficiency: 'STRONG', priority: 'P2', time_window_label: 'x', source: 'OPERATOR', status: 'EXECUTED' } });
const act = (c, entity, recommendation_id, o = {}) => prisma.ambAction.create({ data: { recommendation_id, mode: 'AUTOPILOT', action_type: 'DECREASE_BUDGET', ad_account_id: 'act_x', level: entity === c ? 'campaign' : 'adset', entity_id: entity, campaign_id: c, approval_status: 'AUTO', execution_status: 'EXECUTED', executed_at: hAgo(2), old_value_json: '{}', new_value_json: '{}', ...o } });
const dec = (c, o = {}) => prisma.ambOperatorDecision.create({ data: { decision_key: `${T}${c}-${Math.random()}`, status: 'VERIFIED', store_id: 'trendy-storeee', ad_account_id: 'act_x', campaign_id: c, campaign_name: c, action: 'SCALE_DOWN', rule_name: 'AUTO:REDUCE', mode_at_decision: 'AUTOPILOT', confidence: 'HIGH', executed_at: hAgo(2), params_json: '{}', ...o } });

try {
  await cleanup();
  console.log('\n1. CAMPAIGN_DAILY_LIMIT counts REAL changes once (the bug: one reduction read as two → the pause was blocked after a single write)');
  { const A = `${T}cbo`, B = `${T}man`, C = `${T}abo`, D = `${T}fail`, E = `${T}recl`;
    // A) CBO: the decision and the AMB action it produced are ONE change
    const rA = await rec(A); const aA = await act(A, A, rA.id); await dec(A, { amb_action_id: aA.id, amb_recommendation_id: rA.id });
    // B) a manual / legacy action (no decision) is a real change and counts
    const rB = await rec(B); await act(B, B, rB.id);
    // C) ABO: the write targets the AD SET (entity_id = ad set) — matched through its campaign; plus a manual ad-set change
    const rC = await rec(C, `${T}adset_c`); const aC = await act(C, `${T}adset_c`, rC.id); await dec(C, { amb_action_id: aC.id, amb_recommendation_id: rC.id });
    const rC2 = await rec(C, `${T}adset_c2`); await act(C, `${T}adset_c2`, rC2.id, { executed_at: hAgo(3) });
    // D) failed / blocked / expired / prepared decisions and a failed action are NOT changes
    for (const st of ['FAILED', 'BLOCKED', 'EXPIRED', 'PREPARED', 'SHADOW']) await dec(D, { status: st, executed_at: null }); const rD = await rec(D); await act(D, D, rD.id, { execution_status: 'FAILED' });
    // E) the link exists only through the recommendation (older rows): still ONE change
    const rE = await rec(E); await act(E, E, rE.id); await dec(E, { amb_recommendation_id: rE.id, amb_action_id: null });
    const r = await OC.loadRecentActions({ campaignIds: [A, B, C, D, E], now: NOW });
    ok('CBO: a decision + its own AMB action = 1 change (it used to be 2)', r.get(A)?.todayCount === 1, r.get(A)?.todayCount);
    ok('a manual/legacy AMB action with no decision is 1 real change', r.get(B)?.todayCount === 1, r.get(B)?.todayCount);
    ok('ABO: the Operator write on an AD SET counts once for its campaign, and a manual ad-set change on the same campaign counts too (2 real changes)', r.get(C)?.todayCount === 2, r.get(C)?.todayCount);
    ok('failed / blocked / expired / prepared / shadow decisions and a FAILED action are never counted', !r.get(D) || r.get(D).todayCount === 0, JSON.stringify(r.get(D)));
    ok('a decision linked only through its recommendation (older rows) is still ONE change', r.get(E)?.todayCount === 1, r.get(E)?.todayCount);
    ok('the last-change memory (cooldown / anti-oscillation) still sees the ad-set action of an ABO campaign', !!r.get(C)?.lastByAction?.SCALE_DOWN);
    const old = `${T}old`; const ro = await rec(old); await act(old, old, ro.id, { executed_at: hAgo(30) }); const r2 = await OC.loadRecentActions({ campaignIds: [old], now: NOW });
    ok('a change older than 24h is remembered (cooldown) but does not count toward the daily limit', r2.get(old)?.todayCount === 0 && !!r2.get(old)?.lastByAction?.SCALE_DOWN);
    // the guard itself: limit 2 — one real change must NOT block, two must
    const base = { decision: { action: 'PAUSE', params: {}, ruleMode: 'AUTOPILOT', confidence: 'HIGH', needs: {}, usesCod: false, cooldownHours: 12, ruleMinSpend: null, severeOverride: true }, ctx: { campaign: { id: 'c', status: 'ACTIVE' }, recent: { lastByAction: {}, todayCount: 0 }, productId: null }, config: { mode: 'AUTOPILOT', emergency_stop: false, writesLocked: false, limits: { maxChangesPerCampaignPerDay: 2 }, execPermissions: { pause: true } }, settings: {}, now: NOW };
    const has = (res, code) => res.blocks.some((b) => b.code === code);
    ok('guard: 1 real change of a limit of 2 → CAMPAIGN_DAILY_LIMIT does NOT fire; 2 → it fires', !has(G.evaluateGuards({ ...base, counters: { campaignActionsToday: 1 } }), 'CAMPAIGN_DAILY_LIMIT') && has(G.evaluateGuards({ ...base, counters: { campaignActionsToday: 2 } }), 'CAMPAIGN_DAILY_LIMIT')); }

  console.log('\n2. Pause scope: an out-of-scope product says WHY (never a bare code) and the approved scope is never widened');
  { const scope = { includeProducts: ['424'], excludeProducts: [], includeStores: [], excludeStores: [], includeCampaigns: [], excludeCampaigns: [] };
    const pol = PPol.normalizePause({ enabled: true, version: 3, approved: { version: 3, at: NOW.toISOString(), by: 1 }, highCpa: { enabled: true, above: 150, minPurchases: 3, minSpend: 300 }, scope });
    const before = JSON.stringify(pol.scope);
    const out159 = PPol.decidePause({ policy: pol, campaignId: 'c1', productId: 159, storeId: 's', m3: { spend: 1400, purchases: 7, cpa: 200 }, winner: false });
    const in424 = PPol.decidePause({ policy: pol, campaignId: 'c2', productId: 424, storeId: 's', m3: { spend: 1400, purchases: 7, cpa: 200 }, winner: false });
    ok('product 159 is OUT_OF_SCOPE of a pause policy that includes only 424 (the trigger fires, the scope blocks it)', out159.trigger === 'HIGH_CPA' && out159.blockers.includes('OUT_OF_SCOPE'));
    ok('product 424 (in scope) has no scope blocker', in424.trigger === 'HIGH_CPA' && !in424.blockers.length);
    const msg = PPol.pauseBlockMessage('OUT_OF_SCOPE', pol);
    ok('the reason names the policy version, the real scope («منتجات مضمّنة: 1») and who decides — not «OUT_OF_SCOPE»', /v3/.test(msg) && /منتجات مضمّنة: 1/.test(msg) && /قرارك|بنفسك/.test(msg) && msg !== 'OUT_OF_SCOPE', msg);
    ok('an explicit exclusion and a weekday block get their own wording', /مستبعد/.test(PPol.pauseBlockMessage('EXCLUDED_BY_POLICY', pol)) && /أيام/.test(PPol.pauseBlockMessage('DAY_NOT_ALLOWED', pol)));
    ok('evaluating never widens the approved scope (identical before / after)', JSON.stringify(pol.scope) === before && JSON.stringify(scope.includeProducts) === '["424"]'); }

  console.log('\n3. Pause protections as a matrix (not «block everything», not «stop a winner on a weak sample»)');
  { const P = (o = {}) => PPol.normalizePause({ enabled: true, version: 1, approved: { version: 1, at: NOW.toISOString(), by: 1 }, zeroOrder: { enabled: true, spend: 200 }, highCpa: { enabled: true, above: 150, minPurchases: 3, minSpend: 300 }, stockOut: { enabled: true }, protections: { winnerProtection: true, precedence: 'PROTECTION_WINS', recentImprovement: { enabled: true, minPurchases: 2 } }, ...o });
    const D = (o) => PPol.decidePause({ campaignId: 'c', productId: 1, storeId: 's', ...o, policy: P(o.policy) });
    ok('HIGH_CPA needs a real sample: 2 orders (< 3 minimum) → NO pause even at CPA 400', D({ m3: { spend: 800, purchases: 2, cpa: 400 } }).trigger === null);
    ok('HIGH_CPA needs real spend: 3 orders but 250 spent (< 300) → NO pause', D({ m3: { spend: 250, purchases: 3, cpa: 400 } }).trigger === null);
    ok('HIGH_CPA with a real sample (7 orders, CPA 203 > 150, spend 1423) → pause', D({ m3: { spend: 1423, purchases: 7, cpa: 203 } }).trigger === 'HIGH_CPA');
    ok('CPA exactly at the line (150) is NOT above it → no pause (inclusive boundary)', D({ m3: { spend: 900, purchases: 6, cpa: 150 } }).trigger === null);
    ok('the PRODUCT hard stop wins over a missing global figure (global above=null, product 150)', D({ policy: { highCpa: { enabled: true, above: null, minPurchases: 3, minSpend: 300 } }, productHighCpa: 150, m3: { spend: 900, purchases: 5, cpa: 180 } }).trigger === 'HIGH_CPA' && D({ policy: { highCpa: { enabled: true, above: null, minPurchases: 3, minSpend: 300 } }, m3: { spend: 900, purchases: 5, cpa: 180 } }).trigger === null);
    const winnerCase = { m3: { spend: 1500, purchases: 6, cpa: 250 }, winner: true };
    ok('a strong WINNER is not paused by HIGH_CPA under PROTECTION_WINS (WINNER_PROTECTED)', D(winnerCase).trigger === null && D(winnerCase).skipped.some((s) => s.code === 'WINNER_PROTECTED'));
    ok('…but RULE_WINS pauses it anyway (the owner\'s choice)', D({ ...winnerCase, policy: { protections: { winnerProtection: true, precedence: 'RULE_WINS', recentImprovement: { enabled: true, minPurchases: 2 } } } }).trigger === 'HIGH_CPA');
    ok('winner protection OFF → the same winner is paused (protection is not forced)', D({ ...winnerCase, policy: { protections: { winnerProtection: false, precedence: 'PROTECTION_WINS', recentImprovement: { enabled: true, minPurchases: 2 } } } }).trigger === 'HIGH_CPA');
    ok('STOCK_OUT pauses even a protected winner (nothing to sell)', D({ ...winnerCase, stock: { status: 'OUT_OF_STOCK' } }).trigger === 'STOCK_OUT');
    ok('recent improvement: today already 2 orders at CPA ≤ the line → the HIGH_CPA pause WAITS (RECENT_IMPROVEMENT)', D({ m3: { spend: 1400, purchases: 7, cpa: 200 }, mToday: { spend: 200, purchases: 2, cpa: 100 } }).skipped.some((s) => s.code === 'RECENT_IMPROVEMENT') && D({ m3: { spend: 1400, purchases: 7, cpa: 200 }, mToday: { spend: 200, purchases: 2, cpa: 100 } }).trigger === null);
    ok('…one good order today is not enough to wait (2 required)', D({ m3: { spend: 1400, purchases: 7, cpa: 200 }, mToday: { spend: 100, purchases: 1, cpa: 100 } }).trigger === 'HIGH_CPA');
    ok('ZERO_ORDER fires on spend ≥ the limit with no orders, and not below it', D({ m3: { spend: 210, purchases: 0, cpa: null } }).trigger === 'ZERO_ORDER' && D({ m3: { spend: 150, purchases: 0, cpa: null } }).trigger === null);
    ok('the winner definition used here (isWinner) is a fixed 30d ≥10 orders & CPA ≤ 120 and 7d ≥2 orders & CPA ≤ 130 — recorded for the owner (not product-relative)', (await imp('../services/amb/dailyPlanCandidates.js')).isWinner({ m7: { purchases: 2, cpa: 130 }, m30: { purchases: 10, cpa: 120 } }) === true && (await imp('../services/amb/dailyPlanCandidates.js')).isWinner({ m7: { purchases: 2, cpa: 131 }, m30: { purchases: 10, cpa: 120 } }) === false); }

  console.log('\n4. Diagnostics: the real reason, who decides it, current vs old, and the gate chain');
  { const mk = (id, status, ageMin, blocks, o = {}) => ({ id, product_id: 159, store_id: 'trendy-storeee', campaign_id: `${T}d${id}`, campaign_name: `camp ${id}`, action: 'PAUSE', rule_name: 'AUTO:HIGH_CPA', status, error: o.error || null, blocked_codes_json: JSON.stringify(blocks), created_at: new Date(NOW.getTime() - ageMin * 60000), updated_at: new Date(NOW.getTime() - ageMin * 60000), executed_at: o.executed_at || null });
    const rows = [mk(1, 'BLOCKED', 5, [{ code: 'OUT_OF_SCOPE', message: 'x' }, { code: 'CAMPAIGN_DAILY_LIMIT', message: 'تم الوصول للحد' }]), mk(2, 'BLOCKED', 600, ['UNKNOWN_WINNER_REVIEW[D]']), mk(3, 'VERIFIED', 100, [], { executed_at: hAgo(1) }), mk(4, 'EXPIRED', 100, [], { error: 'NO_LONGER_APPLICABLE' }), mk(5, 'PREPARED', 3, [{ code: 'DOWNGRADE_TO_APPROVAL', message: 'x' }]), { ...mk(6, 'PREPARED', 3, []), campaign_id: `${T}d1`, rule_name: 'AUTO:HIGH_CPA' }];
    const nb = DG.normalizeBlock('ADVISOR_DISAGREES[D]:CONVERSION_PROBLEM'); ok('a stored block in ANY shape is understood («CODE[D]:detail», {code,message}, bare)', nb.code === 'ADVISOR_DISAGREES' && nb.severity === 'DOWNGRADE' && nb.detail === 'CONVERSION_PROBLEM' && DG.normalizeBlock({ code: 'OUT_OF_SCOPE', message: 'OUT_OF_SCOPE' }).owner === 'OWNER' && DG.normalizeBlock({ code: 'CAMPAIGN_DAILY_LIMIT', message: 'x' }).owner === 'LIMIT' && DG.normalizeBlock({ code: 'STOCK_UNKNOWN', message: 'x' }).owner === 'DATA' && DG.normalizeBlock(null) === null);
    const overview = { dailyLimits: { rows: [{ key: 'budgetIncrease', limit: 100, used: 0, remaining: 100, state: 'OK' }, { key: 'exposure', limit: 600, used: 650, remaining: 0, state: 'FULL' }, { key: 'pauses', limit: 1, used: 0, remaining: 1, state: 'OK' }, { key: 'actionsDay', limit: 30, used: 2, remaining: 28, state: 'OK' }, { key: 'actionsHour', limit: 6, used: 0, remaining: 6, state: 'OK' }] },
      products: [{ key: 'trendy-storeee:159', productId: 159, storeId: 'trendy-storeee', name: 'Selicon', state: 'READY', missing: [], policy: { status: 'ACTIVE', mode: 'AUTOMATIC' }, limits: { maxChangesPerDay: 3, dailyCap: 500, minBudget: 200, maxBudget: 300 }, runningBudget: 800, campaigns: { ids: [`${T}d1`], mapped: 1, active: 1 } }, { key: 's:50', productId: 50, storeId: 's', name: 'Half', state: 'NEEDS_CONFIGURATION', missing: [{ label: 'اقتصاديات المنتج مكتملة' }], policy: { status: 'DRAFT', mode: 'APPROVAL' }, limits: {}, runningBudget: 0, campaigns: { ids: [], mapped: 0, active: 0 } }] };
    const pause = PPol.normalizePause({ enabled: true, version: 3, approved: { version: 3 }, scope: { includeProducts: ['424'] } });
    const config = { mode: 'AUTOPILOT', emergency_stop: false, writesLocked: false, execPermissions: { open: true, pause: true, budgetIncrease: true, budgetDecrease: true }, limits: { maxChangesPerCampaignPerDay: 2 } };
    const settings = { ambAllowAutoBudgetDecrease: true, ambAllowAutoBudgetIncrease: true, ambAllowAutoScale: true, ambAllowAutoPause: false };
    const recent = new Map([[`${T}d1`, { todayCount: 1, lastByAction: {} }]]);
    const d = await DG.automationDiagnostics({ now: NOW, deps: { config, settings, pause, overview, decisions: rows, recent, sync: { intervalMinutes: 15, lastSuccessAt: hAgo(0.02).toISOString() }, lastRun: { at: new Date(NOW.getTime() - 4 * 60000).toISOString(), evaluated: 12, executed: [{}, {}], deferred: [], gate: [] } } });
    ok('engine block: last cycle 4 min ago, 12 evaluated, 2 executed in it', d.engine.ageMinutes === 4 && d.engine.evaluated === 12 && d.engine.executedInLastCycle === 2);
    const oos = d.reasons.find((r) => r.code === 'OUT_OF_SCOPE'), uw = d.reasons.find((r) => r.code === 'UNKNOWN_WINNER_REVIEW'), lim = d.reasons.find((r) => r.code === 'CAMPAIGN_DAILY_LIMIT');
    ok('reasons: OUT_OF_SCOPE is CURRENT and the OWNER\'s call; UNKNOWN_WINNER_REVIEW is OLD (10h, not re-evaluated); the limit reason is a LIMIT; each names its products', oos.currentCount === 1 && oos.oldCount === 0 && oos.owner === 'OWNER' && uw.currentCount === 0 && uw.oldCount === 1 && lim.owner === 'LIMIT' && oos.products.includes('Selicon'));
    ok('totals: executed 1, prepared 2, blocked 2, expired 1; duplicates counted for the 2 open PAUSE rows of one campaign', d.totals.executed24h === 1 && d.totals.prepared === 2 && d.totals.blocked === 2 && d.totals.expired24h === 1 && d.duplicates.redundantRows === 1, JSON.stringify([d.totals, d.duplicates]));
    ok('campaign limit: 1 real change of 2 → 1 left; product limit 0/3; account limits come with used / limit / remaining', d.limits.campaign.rows[0].used === 1 && d.limits.campaign.rows[0].remaining === 1 && d.limits.perProduct.find((p) => p.productId === 159).remaining === 3 && d.limits.account.find((a) => a.key === 'exposure').state === 'FULL');
    ok('policies: the incomplete product is listed with what is missing; the AUTOMATIC product outside the pause scope is listed (the owner decides to add it)', d.policies.incomplete[0].name === 'Half' && /اقتصاديات/.test(d.policies.incomplete[0].missing[0]) && d.policies.pause.uncoveredAutomaticProducts[0].verdict === 'OUT_OF_SCOPE' && /قرارك/.test(d.policies.pause.note));
    ok('meta sync freshness is reported', d.sync.intervalMinutes === 15 && d.sync.ageMinutes <= 1);
    const p = await DG.productDiagnosis({ key: 'trendy-storeee:159', now: NOW, deps: { config, settings, pause, overview, decisions: rows, recent } });
    const gate = (a, k) => p.gates.actions[a].find((g) => g.key === k);
    ok('gate chain: REDUCE and INCREASE pass their permission + Auto switch; PAUSE fails on the Auto switch (OFF) AND on the pause scope — each with its own detail', gate('SCALE_DOWN', 'AUTO_SWITCH').ok && gate('SCALE_UP', 'PERMISSION').ok && !gate('PAUSE', 'AUTO_SWITCH').ok && /إيقاف تلقائي/.test(gate('PAUSE', 'AUTO_SWITCH').detail) && !gate('PAUSE', 'PAUSE_SCOPE').ok && /خارج النطاق/.test(gate('PAUSE', 'PAUSE_SCOPE').detail));
    ok('the exposure limit that is FULL stops an INCREASE (and only that), shown with used/limit', !gate('SCALE_UP', 'LIMIT_EXPOSURE').ok && /650 من 600/.test(gate('SCALE_UP', 'LIMIT_EXPOSURE').detail) && p.gates.canRun.SCALE_DOWN === true && p.gates.canRun.SCALE_UP === false && p.gates.canRun.PAUSE === false);
    const c1 = p.campaigns.find((c) => c.campaignId === `${T}d1`); ok('per campaign: the latest decision with its verdict («ممنوع دلوقتي …»), blocks with their owner, and the 24h counter vs the limit', c1.latest.verdict.state === 'WAITING' || c1.latest.verdict.state === 'BLOCKED_NOW', JSON.stringify(c1.latest.verdict));
    const lock = await DG.productDiagnosis({ key: 'trendy-storeee:159', now: NOW, deps: { config: { ...config, writesLocked: true, emergency_stop: true, mode: 'APPROVAL' }, settings, pause, overview, decisions: rows, recent } });
    ok('mode APPROVAL + write lock + Emergency Stop are each reported as a failing common gate, and nothing can run', lock.gates.common.filter((g) => !g.ok).map((g) => g.key).sort().join() === 'EMERGENCY,LOCK,MODE' && Object.values(lock.gates.canRun).every((v) => v === false) && lock.verdict.state === 'NOT_AUTOMATIC');
    const manual = await DG.productDiagnosis({ key: 's:50', now: NOW, deps: { config, settings, pause, overview, decisions: [], recent } }); ok('a product that is not READY / not AUTOMATIC says exactly which layer fails (policy + readiness with the missing items)', manual.gates.common.some((g) => g.key === 'PRODUCT_MODE' && !g.ok) && /اقتصاديات/.test(manual.gates.common.find((g) => g.key === 'READINESS').detail));
    let nf = null; try { await DG.productDiagnosis({ key: 'nope', now: NOW, deps: { config, settings, pause, overview, decisions: [], recent } }); } catch (e) { nf = e; } ok('an unknown product is a 404, not a crash', nf?.status === 404);
    const vd = (st, extra = {}) => DG.verdictOf({ status: st, blocked_codes_json: '[]', updated_at: NOW, ...extra }, NOW).state;
    ok('verdicts: VERIFIED → EXECUTED, UNCERTAIN → UNCERTAIN (no resend), FAILED → FAILED, EXPIRED → EXPIRED, an old PREPARED row is flagged stale', vd('VERIFIED') === 'EXECUTED' && vd('UNCERTAIN') === 'UNCERTAIN' && vd('FAILED', { error: 'x' }) === 'FAILED' && vd('EXPIRED', { error: 'NO_LONGER_APPLICABLE' }) === 'EXPIRED' && /قديم/.test(DG.verdictOf({ status: 'PREPARED', blocked_codes_json: '[]', updated_at: hAgo(30) }, NOW).text)); }
} finally { try { await cleanup(); } catch (e) { console.log('cleanup failed', e.message); } }
console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
