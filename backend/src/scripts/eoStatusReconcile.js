// Easy Orders status reconciliation CLI (localhost). Never prints keys/secrets. Every status write is preceded by a JSONL backup of the row(s).
//   node src/scripts/eoStatusReconcile.js --remap [--apply]
//   node src/scripts/eoStatusReconcile.js --reconcile --limit 300 [--apply] [--store trendy-storeee]
//   node src/scripts/eoStatusReconcile.js --audit-tags --per-store 10
import 'dotenv/config';
import fs from 'node:fs';
import { prisma } from '../prisma.js';
import { reconcileOrders, remapStoredStatuses, auditStoreTags, getStoreStatusTrust, invalidateStatusTrustCache } from '../services/easyOrdersStatus.js';
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const apply = has('--apply');
const backup = val('--backup', null);
const beforeApply = async (orderId, rows) => { if (backup) fs.appendFileSync(backup, JSON.stringify({ at: new Date().toISOString(), orderId, before: rows }) + String.fromCharCode(10)); };
const out = {};
out.trustBefore = Object.fromEntries(await Promise.all(['default', 'trendy-storeee'].map(async (s) => [s, (await getStoreStatusTrust(s, { force: true })).state])));
if (has('--audit-tags')) out.tagAudit = await auditStoreTags({ perStore: Number(val('--per-store', 10)), deps: { maxRetries: 4 } });
if (has('--remap')) out.remap = await remapStoredStatuses({ dryRun: !apply, beforeApply });
if (has('--reconcile')) {
  const limit = Number(val('--limit', 100)); const only = val('--store', null) ? { storeId: val('--store') } : null;
  const batch = Number(val('--batch', 25)); const agg = { checked: 0, changed: 0, notFound: 0, rateLimited: 0, errors: 0, tagMismatch: {}, eoStatuses: {}, storeIdFilled: 0, changes: [], batches: 0 };
  for (let done = 0; done < limit; done += batch) {
    const s = await reconcileOrders({ limit: Math.min(batch, limit - done), dryRun: !apply, only, fillStoreId: has('--fill-store-ids'), deps: { maxRetries: 4, beforeApply } });
    agg.batches++; for (const k of ['checked', 'changed', 'notFound', 'rateLimited', 'errors', 'storeIdFilled']) agg[k] += s[k];
    for (const [k, v] of Object.entries(s.tagMismatch)) agg.tagMismatch[k] = (agg.tagMismatch[k] || 0) + v;
    for (const [k, v] of Object.entries(s.eoStatuses)) agg.eoStatuses[k] = (agg.eoStatuses[k] || 0) + v;
    agg.changes.push(...s.changes);
    console.error(`batch ${agg.batches}: checked=${agg.checked} changed=${agg.changed} notFound=${agg.notFound} rateLimited=${agg.rateLimited}${s.stoppedEarly ? ' STOPPED_EARLY' : ''}`);
    if (s.stoppedEarly) { agg.stoppedEarly = s.stoppedEarly; break; }
    if (s.checked + s.notFound + s.errors === 0) break;
  }
  out.reconcile = { mode: apply ? 'APPLY' : 'DRY_RUN', ...agg, changes: agg.changes.slice(0, 25) };
}
invalidateStatusTrustCache();
out.trustAfter = Object.fromEntries(await Promise.all(['default', 'trendy-storeee'].map(async (s) => [s, (await getStoreStatusTrust(s, { force: true })).state])));
console.log(JSON.stringify(out, null, 1));
await prisma.$disconnect();
