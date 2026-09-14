// Safe, resumable, batch-based backfill: links every EXISTING
// EasyOrdersOrder row (customer_id still null) to its Customer, using the
// SAME linkOrderToCustomer() the live webhook/reconciliation path already
// uses — no duplicate pipeline. Reuses only fields already stored on
// EasyOrdersOrder from the ORIGINAL ingestion (customer_phone/name/
// government/address) — does NOT re-fetch historical orders from the live
// Easy Orders API (no rate-limit risk, no repeated full-history fetch);
// the newer raw fields (guest_id, ip, tracking_json, ...) simply stay null
// on pre-existing rows, exactly like any other additive column addition in
// this codebase (see schema.prisma's Customer Database comment) — every
// NEW order from this point on gets them.
//
// Idempotent + resumable: repeatedly re-queries rows still missing a
// customer_id (no `skip` — a successfully linked row naturally leaves this
// filter on the very next query, so the window never has to be advanced
// past it). A row that fails to link THIS RUN (no usable phone, or a real
// failure) is explicitly excluded via `order_id NOT IN (...)` for the rest
// of this run only — so it's visited exactly once per run (never an
// infinite loop) but its customer_id is never set, so it correctly
// reappears on the NEXT separate run (or immediately if the underlying
// data is fixed first). Re-running this script is always safe and never
// creates a duplicate Customer (normalized_phone's real DB unique
// constraint is what guarantees that). One order's failure never stops
// the batch.
//
//   node src/scripts/backfillCustomers.js
import { pathToFileURL } from 'node:url';
import { prisma } from '../prisma.js';
import { normalizeEgyptianPhone } from '../services/phoneNormalize.js';
import { linkOrderToCustomer } from '../services/customers.js';

const BATCH_SIZE = 200;

async function run() {
  const customersBefore = await prisma.customer.count();
  let ordersProcessed = 0;
  let ordersLinked = 0;
  let ordersSkippedNoPhone = 0;
  let failures = 0;
  const excludedThisRun = []; // order_ids that didn't link this run — excluded so this run doesn't loop on them forever, but customer_id stays null for the next run

  for (;;) {
    const rows = await prisma.easyOrdersOrder.findMany({
      where: { customer_id: null, ...(excludedThisRun.length ? { order_id: { notIn: excludedThisRun } } : {}) },
      distinct: ['order_id'],
      select: { order_id: true, customer_phone: true, customer_name: true, customer_government: true, customer_address: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      ordersProcessed++;
      try {
        if (!normalizeEgyptianPhone(row.customer_phone)) { ordersSkippedNoPhone++; excludedThisRun.push(row.order_id); continue; }
        const customerId = await linkOrderToCustomer({
          orderId: row.order_id,
          rawPhone: row.customer_phone,
          fullName: row.customer_name,
          government: row.customer_government,
          address: row.customer_address,
        });
        if (customerId) ordersLinked++; else { failures++; excludedThisRun.push(row.order_id); } // a valid-looking phone that still failed to link is a real (logged, PII-safe) failure, not a "no phone" case
      } catch (err) {
        failures++;
        excludedThisRun.push(row.order_id);
        console.error(`[backfillCustomers] unexpected error for order_id=${row.order_id}: ${err.message}`); // never logs raw phone/name/address
      }
    }
    console.log(`[backfillCustomers] batch complete — ${ordersProcessed} orders processed so far`);
  }

  const customersAfter = await prisma.customer.count();
  const summary = {
    ordersProcessed,
    ordersLinked,
    ordersSkippedNoUsablePhone: ordersSkippedNoPhone,
    failures,
    customersCreatedThisRun: customersAfter - customersBefore,
    customersTotalNow: customersAfter,
  };
  console.log('\n[backfillCustomers] SUMMARY:', JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(() => process.exit(0)).catch((err) => { console.error('[backfillCustomers] fatal:', err.message); process.exit(1); });
}

export { run };
