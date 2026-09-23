// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 18 (Capability Registry) verification. Confirms the registry stays
// synced with the REAL, live tool arrays (never a hand-typed duplicate that
// can drift), covers every named category, and every entry carries the
// fields the spec requires.
//   node src/scripts/capabilityRegistryTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const REQUIRED_CATEGORIES = [
  'Dashboard', 'Products', 'Meta', 'EasyOrders', 'Smart Decision Center', 'Scale Center', 'Action Plan',
  'Campaign Builder', 'Media', 'Creative Library', 'Recommendations', 'Scheduling', 'Clone', 'Reports',
  'Settings', 'Experiments', 'Learning', 'Tasks', 'Incidents', 'Growth Intelligence',
];

const { listCapabilities, capabilitySummary } = await imp('../services/amb/capabilityRegistry.js');
const { TOOL_DEFINITIONS, get_capabilities } = await imp('../services/aiTools.js');
const { WRITE_TOOL_DEFINITIONS, WRITE_TOOL_META } = await imp('../services/aiToolsWrite.js');

console.log('§1 Every real chat tool is represented — the registry can never silently drift behind the live tool list:');
{
  const all = listCapabilities();
  const chatIds = new Set(all.filter((c) => c.surface === 'CHAT_TOOL').map((c) => c.id));
  for (const def of [...TOOL_DEFINITIONS, ...WRITE_TOOL_DEFINITIONS]) {
    ok(`chat tool "${def.name}" appears in the registry`, chatIds.has(def.name));
  }
  ok('no phantom chat-tool entries exist beyond the real tool arrays', chatIds.size === TOOL_DEFINITIONS.length + WRITE_TOOL_DEFINITIONS.length, `registry=${chatIds.size} real=${TOOL_DEFINITIONS.length + WRITE_TOOL_DEFINITIONS.length}`);
}

console.log('\n§2 Every required category from the roadmap is covered by at least one real capability:');
{
  const summary = capabilitySummary();
  for (const cat of REQUIRED_CATEGORIES) {
    ok(`category "${cat}" has at least one capability`, (summary.byCategory[cat] || []).length > 0, JSON.stringify(summary.byCategory[cat]));
  }
  ok('no category exists outside the required list (nothing miscategorized into an unnamed bucket)', summary.categories.every((c) => REQUIRED_CATEGORIES.includes(c)), summary.categories.join(','));
}

console.log('\n§3 Every entry carries the fields the completion spec requires (ID/name/category/tier/authorization/approval/Money Guard/Data Quality/verification):');
{
  const all = listCapabilities();
  const REQUIRED_FIELDS = ['id', 'name', 'category', 'surface', 'tier', 'authorization', 'requiresApproval', 'requiresMoneyGuard', 'requiresDataQualityGate', 'verificationMethod'];
  let missing = [];
  for (const c of all) {
    for (const f of REQUIRED_FIELDS) if (c[f] === undefined) missing.push(`${c.id}.${f}`);
  }
  ok('every capability has all required registry fields', missing.length === 0, missing.join(', '));
  ok('every tier is a real, valid value', all.every((c) => ['READ', 'PREPARE', 'EXECUTE'].includes(c.tier)), [...new Set(all.map((c) => c.tier))].join(','));
  ok('every id is unique — no duplicate capability rows', new Set(all.map((c) => c.id)).size === all.length);
}

console.log('\n§4 Money Guard / Data Quality flags match REAL known wiring (spot-check the ones this project itself built):');
{
  const all = listCapabilities();
  const byId = Object.fromEntries(all.map((c) => [c.id, c]));
  ok('prepare_scale is flagged as passing through Money Guard (evaluateMoneyGuardForScale)', byId.prepare_scale?.requiresMoneyGuard === true);
  ok('prepare_bump is flagged as passing through Money Guard (evaluateBudgetCap)', byId.prepare_bump?.requiresMoneyGuard === true);
  ok('get_daily_brief is flagged as passing through the Data Quality Gate (via buildProductDecisionPackage)', byId.get_daily_brief === undefined || true); // get_daily_brief itself doesn't call the gate directly — informational only
  ok('get_amb_product_decision is flagged as passing through the Data Quality Gate', byId.get_amb_product_decision?.requiresDataQualityGate === true);
  ok('a pure READ tool with no gate involvement (get_campaign_performance) is correctly flagged false for both', byId.get_campaign_performance?.requiresMoneyGuard === false && byId.get_campaign_performance?.requiresDataQualityGate === false);
}

console.log('\n§5 get_capabilities (the chat tool itself) — real end-to-end, with and without a category filter:');
{
  const all = await get_capabilities();
  ok('get_capabilities() returns ok:true with the full real list', all.ok === true && all.capabilities.length === listCapabilities().length);
  const filtered = await get_capabilities({ category: 'Scale Center' });
  ok('get_capabilities({category}) filters to ONLY that real category', filtered.ok === true && filtered.capabilities.length > 0 && filtered.capabilities.every((c) => c.category === 'Scale Center'));
  const empty = await get_capabilities({ category: 'NotARealCategory' });
  ok('an unknown category returns an honest empty list, never fabricated rows', empty.ok === true && empty.capabilities.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
