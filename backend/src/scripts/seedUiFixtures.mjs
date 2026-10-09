// UI fixtures for the ISOLATED test database only: today's OPEN / PAUSE plans with realistic-looking (fake) campaigns, so the workspaces can be reviewed on localhost.
//   node src/scripts/seedUiFixtures.mjs        (refuses to run unless the guard confirms the test database)
import './_testGuard.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (r) => import(pathToFileURL(join(__dirname, r)).href);
const { prisma } = await imp('../prisma.js'); const T = await imp('../services/amb/dailyPlanTime.js');
const date = T.cairoDate(new Date());
await prisma.ambDailyPlanItem.deleteMany({ where: { plan: { plan_date: date } } }); await prisma.ambDailyPlan.deleteMany({ where: { plan_date: date } });
const m = (spend, p) => ({ spend, purchases: p, cpa: p ? Math.round(spend / p) : null, ctr: 1.9, cpc: 3.4, cvr: 4.1 });
const open = [
  ['LumiMist', 'LumiMist _ scale 3', 600, 88, 18, 73, 112, 'CBO', 'ELIGIBLE', 78, 'روتين يومي', []], ['BackBrush', 'BackBrush - scale 2', 400, 72, 32, 68, 96, 'CBO', 'ELIGIBLE', 84, 'روتين يومي', []],
  ['Face Heir', 'Face-Heir - Test 4', 200, 96, 12, 144, 19, 'ABO', 'NEEDS_SPECIAL_APPROVAL', 41, 'MANUAL', []], ['Hair Remover', 'Hair-Remover _ scale 4', 300, 146, 8, 148, 59, 'CBO', 'ELIGIBLE', 68, 'روتين يومي', []],
  ['EarCleaner', 'Smart-EarCleaner _ scale - 2', 240, 120, 9, 110, 31, 'CBO', 'BLOCKED', 55, 'SYSTEM', ['MANUAL_OVERRIDE_COOLDOWN']], ['Air Blower', 'Air-Blower _ scale - 3', 250, 126, 15, 110, 55, 'CBO', 'ELIGIBLE', 78, 'روتين يومي', []],
];
const pause = [
  ['Hair Remover', 'Hair-Remover _ scale 4', 300, 265, 1, 146, 8, 148, 59, 'ELIGIBLE', 'HIGH', []], ['Air Blower', 'Air-Blower _ scale - 1', 150, 155, 3, 112, 10, 129, 43, 'ELIGIBLE', 'MEDIUM', []],
  ['Bed Wetting', 'Bed-Wetting _ scale -1', 600, 157, 9, 137, 26, 144, 40, 'ELIGIBLE', 'MEDIUM', []], ['Selicon', 'Selicon _ scale - 2', 500, 106, 15, 106, 15, 84, 77, 'PROTECTED', 'LOW', ['WINNER_PROTECTED']],
];
const mk = async (type, items) => {
  const p = await prisma.ambDailyPlan.create({ data: { plan_key: T.planKey(type, date), type, plan_date: date, scheduled_at: T.dueAt(type, date), expires_at: T.expiresAt(date), status: 'PREPARED', dismissed_at: process.argv.includes('--popup') ? null : new Date(), data_as_of: new Date(), data_state: 'FRESH', summary_json: '{}', evidence_json: '{}' } });
  let rank = 0; for (const it of items) { rank++; await prisma.ambDailyPlanItem.create({ data: { plan_id: p.id, rank, ...it } }); }
};
await mk('OPEN', open.map(([prod, name, budget, c7, p7, c30, p30, lvl, elig, score, by, blocks], i) => ({ campaign_id: `fx_open_${i + 1}`, campaign_name: name, product_name: prod, store_id: 'default', selected: elig === 'ELIGIBLE' && i < 4, selectable: elig !== 'BLOCKED', eligibility: elig, block_codes_json: JSON.stringify(blocks), risk: elig === 'ELIGIBLE' ? 'LOW' : 'MEDIUM', risk_score: 20 + i * 7, reason: `CPA ${c30} على ${p30} أوردر (مستقر بين 7 و30 يوم)`,
  evidence_json: JSON.stringify({ status: 'PAUSED', recommended: elig === 'ELIGIBLE', m7: m(c7 * p7, p7), m30: m(c30 * p30, p30), m3: m(0, 0), budget, budgetLevel: lvl, pausedBy: by === 'روتين يومي' ? 'DAILY_SCHEDULE' : by, priority: { score, band: score >= 75 ? 'STRONG' : score >= 55 ? 'GOOD' : 'FAIR', reasons: ['CPA مستقر', 'عينة كافية'], caveat: 'للترتيب والشرح فقط' }, warnings: [] }) })));
await mk('PAUSE', pause.map(([prod, name, budget, ct, pt, c7, p7, c30, p30, elig, risk, blocks], i) => ({ campaign_id: `fx_pause_${i + 1}`, campaign_name: name, product_name: prod, store_id: 'default', selected: elig === 'ELIGIBLE' && i === 0, selectable: elig === 'ELIGIBLE', eligibility: elig, block_codes_json: JSON.stringify(blocks), risk, risk_score: risk === 'HIGH' ? 78 : risk === 'MEDIUM' ? 50 : 20, reason: `CPA ${ct} > 200 لكن العينة صغيرة`,
  evidence_json: JSON.stringify({ status: 'ACTIVE', policyPause: i === 0, today: m(ct * pt, pt), m3: m(ct * pt, pt), m7: m(c7 * p7, p7), m30: m(c30 * p30, p30), budget, budgetLevel: 'CBO', priority: { score: 60 + i * 8, band: 'GOOD', reasons: [], caveat: '' } }) })));
// campaigns mapped to the fixture products + 30 days of campaign-level snapshots (for the «قواعد المنتجات» list)
await prisma.ambProductCampaignMap.deleteMany({ where: { ad_account_id: 'act_9990000000001' } }); await prisma.metaPerformanceSnapshot.deleteMany({ where: { ad_account_id: 'act_9990000000001' } });
const run = await prisma.ambSyncRun.create({ data: { status: 'SUCCESS', ad_account_id: 'act_9990000000001', finished_at: new Date() } });
const prodRow = async (id) => prisma.ambProduct.findFirst({ where: { product_id: id } });
const defs = [[9001, 'fx_open_1', 'LumiMist _ scale 3', 'PAUSED', 18, 1588], [9001, 'fx_open_6', 'LumiMist _ scale 8', 'ACTIVE', 25, 2349], [9002, 'fx_open_2', 'BackBrush - scale 2', 'PAUSED', 32, 2304], [424, 'fx_pause_1', 'Hair-Remover _ scale 4', 'ACTIVE', 8, 1171], [424, 'fx_pause_2', 'Air-Blower _ scale - 1', 'ACTIVE', 10, 1118]];
for (const [pid, cid, name, status, p7, s7] of defs) {
  const ap = await prodRow(pid); await prisma.ambProductCampaignMap.create({ data: { amb_product_id: ap.id, ad_account_id: 'act_9990000000001', campaign_id: cid, campaign_name: name, status: 'MAPPED' } });
  for (let d = 0; d < 30; d++) { const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10); const k = d < 7 ? 1 : 0.6; await prisma.metaPerformanceSnapshot.create({ data: { sync_run_id: run.id, ad_account_id: 'act_9990000000001', level: 'campaign', date_start: day, date_stop: day, campaign_id: cid, campaign_name: name, campaign_status: status, spend: Math.round((s7 / 7) * k), meta_purchases: Math.round((p7 / 7) * k) } }); }
}
// the plan items carry the product ids (thumbnails + product rules)
for (const [pid, cid] of [[9001, 'fx_open_1'], [9001, 'fx_open_6'], [9002, 'fx_open_2'], [424, 'fx_pause_1'], [424, 'fx_pause_2'], [9002, 'fx_open_3'], [424, 'fx_open_4']]) await prisma.ambDailyPlanItem.updateMany({ where: { campaign_id: cid, plan: { plan_date: date } }, data: { product_id: pid } });
// execution history fixtures (4 actions: verified / uncertain / failed / blocked)
await prisma.ambAction.deleteMany({ where: { entity_id: { startsWith: 'fx_' } } }); await prisma.ambRecommendation.deleteMany({ where: { batch_id: 'fx-ui-history' } });
const hist = [['RESUME', 'LumiMist _ scale 3', 'fx_open_1', 'EXECUTED', { status: 'PAUSED' }, { status: 'ACTIVE' }, { ok: true }, { verified: true, observed: 'ACTIVE' }, null, 5], ['PAUSE', 'Hair-Remover _ scale 4', 'fx_pause_1', 'EXECUTED', { status: 'ACTIVE' }, { status: 'PAUSED' }, { ok: true }, { verified: false, observed: 'ACTIVE' }, null, 4], ['INCREASE_BUDGET', 'BackBrush - scale 2', 'fx_open_2', 'FAILED', { budget: 400 }, { budget: 480 }, { ok: true }, null, '(#17) User request limit reached', 3], ['DECREASE_BUDGET', 'Air-Blower _ scale - 1', 'fx_pause_2', 'ABORTED_REANALYSIS', { budget: 150 }, { budget: 120 }, { ok: false, reason: 'تعديل يدوي حديث على Meta' }, null, null, 2]];
for (const [type, name, cid, st, o, n, reval, verify, err, hAgo] of hist) {
  const rec = await prisma.ambRecommendation.create({ data: { batch_id: 'fx-ui-history', ad_account_id: 'act_9990000000001', level: 'campaign', entity_id: cid, entity_name: name, decision: type === 'RESUME' ? 'SCALE' : 'PAUSE', action_type: type, executable: true, status: 'APPROVED' } });
  await prisma.ambAction.create({ data: { recommendation_id: rec.id, mode: 'APPROVAL', action_type: type, ad_account_id: 'act_9990000000001', level: 'campaign', entity_id: cid, entity_name: name, campaign_id: cid, old_value_json: JSON.stringify(o), new_value_json: JSON.stringify(n), approval_status: 'APPROVED', execution_status: st, revalidation_json: JSON.stringify(reval), meta_request_json: st === 'ABORTED_REANALYSIS' ? null : JSON.stringify({ status: 'x' }), meta_response_json: st === 'EXECUTED' ? JSON.stringify({ success: true }) : null, meta_error: err, verify_json: verify ? JSON.stringify(verify) : null, verified_at: verify ? new Date() : null, executed_by_id: 1, created_at: new Date(Date.now() - hAgo * 3600000), executed_at: st === 'ABORTED_REANALYSIS' ? null : new Date(Date.now() - hAgo * 3600000 + 90000) } });
}
// product images: 9001 a real (local test) image, 9002 none (initial fallback), 424 a BROKEN url (the image fails to load → initial fallback)
for (const [pid, url] of [[9001, '/__test_img_9001.svg'], [9002, null], [424, '/__missing_424.png']]) await prisma.ambProduct.updateMany({ where: { product_id: pid }, data: { image_url: url } });
// start every UI run from the same state: no stored product policies
const cfgRow = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); if (cfgRow?.limits_json) { const l = JSON.parse(cfgRow.limits_json); delete l.productPolicies; await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: JSON.stringify(l) } }); }
console.log('UI fixtures created for', date, '(test database only)');
await prisma.$disconnect();
