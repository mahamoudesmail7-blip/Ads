// 🧪 «سياسة الفتح» — النطاق والأيام والمخزون وسقف التعرّض وحماية الإيقاف اليدوي: كلها جزء من نفس السياسة المُنسخة والمعتمدة، وبتتطبق (1) وقت التقييم (2) وقت التنفيذ.
//   node src/scripts/openPolicyScopeTest.js     (pure evaluation + the versioned save; no Meta call anywhere)
import './_testGuard.js'; // refuses to run unless DATABASE_URL is the isolated TEST database
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); } };
const { prisma } = await imp('../prisma.js');
const OC = await imp('../services/amb/openCpaPolicy.js'); const SC = await imp('../services/amb/automationScope.js');
const ADMIN_ID = (await prisma.user.findFirst({ where: { role: 'ADMIN', status: 'ACTIVE' } }))?.id ?? 1; const ADMIN = { id: ADMIN_ID, role: 'ADMIN', status: 'ACTIVE' };
const cfg0 = await prisma.ambOperatorConfig.findUnique({ where: { scope: 'GLOBAL' } }); const limits0 = cfg0.limits_json;
const NOW = new Date('2031-07-02T09:00:00Z'); // a Wednesday (Cairo)
const WED = 3;
const base = (o = {}) => OC.normalizeOpenCpa({ minCpa: 20, maxCpa: 150, window: '7', minPurchases: 3, ...o });
const item = (o = {}) => ({ campaignId: 'c1', productId: 7, storeId: 'trendy-storeee', eligibility: 'ELIGIBLE', selectable: true, blockCodes: [], evidence: { stock: { status: 'IN_STOCK', current: 40 }, budget: 100, pausedBy: 'DAILY_SCHEDULE' }, ...o });
const M = { spend: 400, purchases: 8 }; // CPA 50
const ev = (policy, it = item(), extra = {}) => OC.evaluateCampaign({ policy, item: it, metrics: M, dataAgeMin: 1, weekday: WED, now: NOW, ...extra });

console.log('\n1. Defaults: no new rule changes behaviour until the owner sets it');
{ const p = base(); ok('empty scope / every day / no cap / no min stock', JSON.stringify(p.scope) === JSON.stringify(SC.emptyScope()) && p.days === null && p.maxTotalExposure === null && p.minStock === null);
  ok('manual-pause protection is ON by default (48h)', p.protectManualPause.enabled === true && p.protectManualPause.hours === 48);
  ok('a normal campaign is ELIGIBLE under the defaults', ev(p).eligible === true, JSON.stringify(ev(p))); }

console.log('\n2. Scope: include / exclude products · stores · campaigns');
{ const inc = base({ scope: { includeProducts: ['7'] } }); ok('in the included product → eligible', ev(inc).eligible);
  ok('another product → OUT_OF_SCOPE (not eligible)', ev(inc, item({ productId: 8 })).codes.includes('OUT_OF_SCOPE') && !ev(inc, item({ productId: 8 })).eligible);
  const exc = base({ scope: { excludeProducts: ['7'] } }); ok('excluded product → EXCLUDED_BY_POLICY', ev(exc).codes.includes('EXCLUDED_BY_POLICY') && !ev(exc).eligible);
  const st = base({ scope: { includeStores: ['other-store'] } }); ok('store not included → OUT_OF_SCOPE', ev(st).codes.includes('OUT_OF_SCOPE'));
  const st2 = base({ scope: { excludeStores: ['trendy-storeee'] } }); ok('excluded store → EXCLUDED_BY_POLICY', ev(st2).codes.includes('EXCLUDED_BY_POLICY'));
  const cm = base({ scope: { includeCampaigns: ['c1'] } }); ok('included campaign → eligible; another campaign is not', ev(cm).eligible && !ev(cm, item({ campaignId: 'c2' })).eligible);
  const cx = base({ scope: { includeProducts: ['7'], excludeCampaigns: ['c1'] } }); ok('an exclude always wins over an include', ev(cx).codes.includes('EXCLUDED_BY_POLICY'));
  ok('include lists of different kinds combine with AND', !ev(base({ scope: { includeProducts: ['7'], includeStores: ['x'] } })).eligible);
  ok('the same id in include AND exclude is rejected when saving', OC.validateOpenCpa(base({ scope: { includeProducts: ['7'], excludeProducts: ['7'] } })).some((m) => /التضمين والاستبعاد/.test(m)));
  ok('scopeVerdict is pure and handles missing ids (fail closed on includes)', SC.scopeVerdict(SC.normalizeScope({ includeProducts: ['7'] }), { productId: null }) === 'OUT_OF_SCOPE'); }

console.log('\n3. Weekdays (Cairo)');
{ const p = base({ days: [0, 1, 2] }); ok('Wednesday is not in [Sun,Mon,Tue] → DAY_NOT_ALLOWED', ev(p).codes.includes('DAY_NOT_ALLOWED') && !ev(p).eligible);
  ok('Wednesday allowed when listed', ev(base({ days: [3] })).eligible);
  ok('an empty list means every day', base({ days: [] }).days === null && ev(base({ days: [] })).eligible);
  ok('invalid weekday numbers are rejected', OC.validateOpenCpa({ ...base(), days: [9] }).length > 0); }

console.log('\n4. Minimum stock');
{ const p = base({ minStock: 50 }); ok('stock 40 < min 50 → STOCK_BELOW_MIN', ev(p).codes.includes('STOCK_BELOW_MIN') && !ev(p).eligible);
  ok('stock 40 ≥ min 30 → eligible', ev(base({ minStock: 30 })).eligible);
  ok('unknown stock with a minimum set → STOCK_UNKNOWN_FOR_MIN (never assumed)', ev(p, item({ evidence: { stock: { status: 'STOCK_UNKNOWN', current: null }, budget: 100 } })).codes.includes('STOCK_UNKNOWN_FOR_MIN'));
  ok('no minimum configured: unknown stock does not block (existing guards still apply)', ev(base(), item({ evidence: { budget: 100 } })).eligible); }

console.log('\n5. Manual-pause protection');
{ const p = base(); const recent = item({ evidence: { stock: { status: 'IN_STOCK', current: 40 }, budget: 100, pausedBy: 'MANUAL', pausedAt: new Date(NOW.getTime() - 5 * 3_600_000).toISOString() } });
  ok('paused by the owner 5h ago → MANUAL_PAUSE_PROTECTED', ev(p, recent).codes.includes('MANUAL_PAUSE_PROTECTED') && !ev(p, recent).eligible);
  const old = item({ evidence: { stock: { status: 'IN_STOCK', current: 40 }, budget: 100, pausedBy: 'MANUAL', pausedAt: new Date(NOW.getTime() - 100 * 3_600_000).toISOString() } });
  ok('paused by the owner 100h ago (> 48h) → not protected by this rule', !ev(p, old).codes.includes('MANUAL_PAUSE_PROTECTED'));
  ok('protection can be switched off', !ev(base({ protectManualPause: { enabled: false, hours: 48 } }), recent).codes.includes('MANUAL_PAUSE_PROTECTED'));
  ok('a system / daily-routine pause is never treated as a manual one', !ev(p, item({ evidence: { budget: 100, pausedBy: 'SYSTEM', pausedAt: NOW.toISOString() } })).codes.includes('MANUAL_PAUSE_PROTECTED')); }

console.log('\n6. Total exposure ceiling (money running today + what the opening adds)');
{ const p = base({ maxTotalExposure: 1000 });
  const mk = (id, budget, score) => ({ it: item({ campaignId: id, rankScore: score, evidence: { stock: { status: 'IN_STOCK', current: 40 }, budget } }) });
  const rows = [mk('a', 300, 90), mk('b', 300, 80), mk('c', 300, 70), mk('d', 100, 60)].map((r) => ({ ...r, eval: ev(p, r.it) }));
  const r = OC.applyCapToEvals(rows, { policy: p, baseExposure: 200, budgetOf: (x) => x.it.evidence.budget, keyOf: (x) => x.it.campaignId });
  ok('base 200 + a300 + b300 + (c300 refused: 1100>1000) + d100 = 900', rows[0].eval.eligible && rows[1].eval.eligible && !rows[2].eval.eligible && rows[3].eval.eligible && Math.round(r.exposure) === 900, JSON.stringify([...r.refused]));
  ok('the refused one says EXPOSURE_CAP', rows[2].eval.codes.includes('EXPOSURE_CAP') && rows[2].eval.verdict === 'EXCLUDED');
  const unknown = [{ it: item({ campaignId: 'u', evidence: { budget: null } }) }].map((x) => ({ ...x, eval: ev(p, x.it) }));
  OC.applyCapToEvals(unknown, { policy: p, baseExposure: 0, budgetOf: (x) => x.it.evidence.budget, keyOf: (x) => x.it.campaignId });
  ok('an unknown campaign budget is refused (fail closed) with BUDGET_UNKNOWN', !unknown[0].eval.eligible && unknown[0].eval.codes.includes('BUDGET_UNKNOWN'));
  const none = [{ it: item({ campaignId: 'n' }) }].map((x) => ({ ...x, eval: ev(base(), x.it) })); OC.applyCapToEvals(none, { policy: base(), baseExposure: 9e9, budgetOf: () => 100, keyOf: (x) => x.it.campaignId });
  ok('no cap configured → the cap never refuses anything', none[0].eval.eligible);
  ok('applyExposureCap: running exposure already above the cap refuses everything', SC.applyExposureCap([{ key: 'x', budget: 10, eligible: true }], { cap: 100, base: 150 }).refused.has('x')); }

console.log('\n7. Execution-time re-check (the SAME approved snapshot stored on the plan)');
{ const snap = { scope: SC.normalizeScope({ excludeProducts: ['7'] }), days: [3], minStock: 30, protectManualPause: { enabled: true, hours: 48 } };
  const run = (s, o = {}, ctx = {}) => OC.runtimeBlock(s, { campaignId: 'c1', productId: 7, storeId: 'trendy-storeee', evidence: { stock: { status: 'IN_STOCK', current: 40 }, ...o } }, { weekday: WED, now: NOW, ...ctx });
  ok('excluded product is blocked at execution time too', run(snap) === 'EXCLUDED_BY_POLICY');
  ok('weekday no longer allowed → DAY_NOT_ALLOWED', run({ ...snap, scope: SC.emptyScope(), days: [1] }) === 'DAY_NOT_ALLOWED');
  ok('stock fell below the minimum → STOCK_BELOW_MIN', run({ ...snap, scope: SC.emptyScope() }, { stock: { status: 'IN_STOCK', current: 5 } }) === 'STOCK_BELOW_MIN');
  ok('everything fine → null', run({ ...snap, scope: SC.emptyScope() }) === null);
  ok('a plan without a snapshot (old plans) is not blocked by the new rules', OC.runtimeBlock(null, { campaignId: 'c1' }, { weekday: WED, now: NOW }) === null); }

console.log('\n8. The new fields are part of the versioned policy (saving creates a new version; approval is separate)');
{ try {
    await OC.saveOpenCpaPolicy({ patch: { minCpa: 20, maxCpa: 150, window: '7', minPurchases: 3, scope: { includeProducts: ['7', '8'] }, days: [0, 1, 2, 3], maxTotalExposure: 2000, minStock: 25, protectManualPause: { enabled: true, hours: 72 } }, userId: ADMIN_ID, now: NOW, deps: { user: ADMIN } });
    const a = await OC.getOpenCpaPolicy(); const v1 = a.version;
    ok('saved: scope / days / cap / min stock / protection persisted', JSON.stringify(a.scope.includeProducts) === '["7","8"]' && JSON.stringify(a.days) === '[0,1,2,3]' && a.maxTotalExposure === 2000 && a.minStock === 25 && a.protectManualPause.hours === 72);
    const same = await OC.saveOpenCpaPolicy({ patch: { scope: { includeProducts: ['8', '7'] }, days: [3, 2, 1, 0] }, userId: ADMIN_ID, now: NOW, deps: { user: ADMIN } });
    ok('saving the same values (different order) is NOT a new version', same.changed === false && (await OC.getOpenCpaPolicy()).version === v1);
    const r2 = await OC.saveOpenCpaPolicy({ patch: { maxTotalExposure: 2500 }, userId: ADMIN_ID, now: NOW, deps: { user: ADMIN } });
    const b = await OC.getOpenCpaPolicy();
    ok('changing only the exposure cap creates version +1 and keeps the previous one in the history', r2.changed && b.version === v1 + 1 && b.history.some((h) => h.version === v1 && h.maxTotalExposure === 2000));
    ok('the approved version does not move by itself (still not approved)', b.approved === null || b.approved.version !== b.version);
    let bad = null; try { await OC.saveOpenCpaPolicy({ patch: { scope: { includeProducts: ['7'], excludeProducts: ['7'] } }, userId: ADMIN_ID, now: NOW, deps: { user: ADMIN } }); } catch (e) { bad = e; }
    ok('an invalid scope is refused with 400 and nothing is saved', bad?.status === 400 && (await OC.getOpenCpaPolicy()).version === b.version);
  } finally { await prisma.ambOperatorConfig.update({ where: { scope: 'GLOBAL' }, data: { limits_json: limits0 } }); await prisma.ambOperatorEvent.deleteMany({ where: { kind: 'OPEN_CPA_POLICY_SAVED', created_at: { gte: new Date(Date.now() - 600_000) } } }); } }

console.log(`\n${pass} passed, ${fail} failed`); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
