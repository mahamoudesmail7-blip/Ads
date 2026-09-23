// AI Media Buyer Operator — Product Growth & Profit Intelligence, Phase 3
// Slice 12 (Price Testing Engine) verification. Unlike every Meta-write
// slice, this action is a LOCAL database write (Product.selling_price) —
// fully safe and reversible, so this script runs the REAL, COMPLETE
// prepare -> approve -> execute -> verify cycle (something every other
// slice this project deliberately stops short of for real Meta writes),
// then restores the original price no matter what happens.
//   node src/scripts/priceTestEngineTest.js
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imp = (rel) => import(pathToFileURL(join(__dirname, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

const { prisma } = await imp('../prisma.js');
const { prepare_price_test } = await imp('../services/aiToolsWrite.js');
const { get_price_test_status } = await imp('../services/aiTools.js');
const { approveTask } = await imp('../services/assistantTasks/taskEngine.js');

const cleanupTaskUuids = [];
let restoreProductId = null, restoreOriginalPrice = null;

async function cleanup() {
  for (const taskUuid of cleanupTaskUuids) await prisma.assistantTask.deleteMany({ where: { task_uuid: taskUuid } }).catch(() => {});
  if (restoreProductId != null && restoreOriginalPrice != null) {
    await prisma.product.update({ where: { id: restoreProductId }, data: { selling_price: restoreOriginalPrice } }).catch((e) => console.log('  ⚠️ FAILED TO RESTORE PRICE — MANUAL FIX NEEDED for product', restoreProductId, e.message));
  }
}

try {
  console.log('§1 Real prepare_price_test end-to-end on a real, disposable price change:');
  {
    const adminUser = await prisma.user.findFirst({ where: { role: { in: ['ADMIN', 'MANAGER'] } }, select: { id: true } });
    const product = await prisma.product.findFirst({ where: { active: true, is_historical: false, selling_price: { gt: 0 } }, select: { id: true, product_name: true, selling_price: true } });
    if (!adminUser || !product) {
      console.log('  (skipped — no admin user or no real priced product found)');
    } else {
      restoreProductId = product.id;
      restoreOriginalPrice = product.selling_price;
      const testPrice = Math.round((product.selling_price + 1) * 100) / 100; // smallest real, distinguishable change

      const prep = await prepare_price_test({ productId: product.id, newPrice: testPrice, userId: adminUser.id, conversationRef: 'priceTestEngineTest' });
      ok('prepare_price_test returns ok:true', prep.ok === true, JSON.stringify(prep).slice(0, 300));
      if (prep.task) {
        cleanupTaskUuids.push(prep.task.taskUuid);
        ok('task kind is PRICE_TEST', prep.task.kind === 'PRICE_TEST');
        ok('task reaches WAITING_FOR_APPROVAL with a real baseline + real hash', prep.task.status === 'WAITING_FOR_APPROVAL' && !!prep.task.preparedPayload?.baseline && typeof prep.task.approvalHash === 'string' && prep.task.approvalHash.length === 64, JSON.stringify(prep.task));
        ok('preview shows the real current price and the real proposed price', prep.task.preparedPayload?.currentPrice === product.selling_price && prep.task.preparedPayload?.newPrice === testPrice, JSON.stringify(prep.task.preparedPayload));

        if (prep.task.status === 'WAITING_FOR_APPROVAL') {
          console.log('\n§2 Wrong-hash rejection on this first task (must refuse, never write the price):');
          const wrongResult = await approveTask({ taskId: prep.task.taskUuid, userId: adminUser.id, approvalHash: 'not-the-real-hash' });
          ok('rejected as STALE_APPROVAL', wrongResult.ok === false && wrongResult.error === 'STALE_APPROVAL', JSON.stringify(wrongResult));
          const stillOriginal = await prisma.product.findUnique({ where: { id: product.id }, select: { selling_price: true } });
          ok('price NEVER changed after the wrong-hash attempt', stillOriginal.selling_price === product.selling_price, stillOriginal.selling_price);
          const afterWrong = await prisma.assistantTask.findUnique({ where: { task_uuid: prep.task.taskUuid } });
          ok('task reverted to PREPARING, not RUNNING/VERIFYING/COMPLETED', afterWrong?.status === 'PREPARING', afterWrong?.status);

          console.log('\n§3 Real approval on a FRESH task — the ONE deliberate real write this project ever exercises automatically, because it is 100% local and reversible:');
          // The first task is now stuck in PREPARING (entity-scoped findActiveTaskForEntity means re-calling
          // prepare_price_test would just return it as-is, same convention prepare_bump already uses) — cancel
          // it and prepare an independent second attempt to get a fresh, valid hash.
          await prisma.assistantTask.deleteMany({ where: { task_uuid: prep.task.taskUuid } });
          const attempt2 = await prepare_price_test({ productId: product.id, newPrice: testPrice, userId: adminUser.id, conversationRef: 'priceTestEngineTest-2' });
          ok('a fresh, independent prepare_price_test reaches WAITING_FOR_APPROVAL', attempt2.task?.status === 'WAITING_FOR_APPROVAL', JSON.stringify(attempt2).slice(0, 300));
          if (attempt2.task) {
            cleanupTaskUuids.push(attempt2.task.taskUuid);
            const correctResult = await approveTask({ taskId: attempt2.task.taskUuid, userId: adminUser.id, approvalHash: attempt2.task.approvalHash });
            ok('approveTask succeeds with the correct hash', correctResult.ok === true, JSON.stringify(correctResult));
            ok('task reaches a real terminal state (COMPLETED or PARTIALLY_COMPLETED)', ['COMPLETED', 'PARTIALLY_COMPLETED'].includes(correctResult.task?.status), correctResult.task?.status);

            const afterWrite = await prisma.product.findUnique({ where: { id: product.id }, select: { selling_price: true } });
            ok('the price genuinely changed in the database to the real proposed value', afterWrite.selling_price === testPrice, afterWrite.selling_price);

            console.log('\n§4 get_price_test_status reads back the real before/after comparison:');
            const status = await get_price_test_status({ productId: product.id });
            ok('get_price_test_status returns ok:true with hasActiveTest', status.ok === true && status.hasActiveTest === true, JSON.stringify(status).slice(0, 300));
            ok('verdict is one of the real spec-defined values', ['KEEP_NEW_PRICE', 'ROLLBACK_PRICE', 'CONTINUE_TEST', 'INCONCLUSIVE'].includes(status.verdict), status.verdict);
            ok('currentPrice reflects the real new price', status.currentPrice === testPrice, status.currentPrice);
            console.log('  verdict:', status.verdict, '| before.netProfit:', status.before?.netProfit, '| after.netProfit:', status.after?.netProfit);
          }
        }
      }
    }
  }
} finally {
  await cleanup();
  console.log('\ncleanup done —', cleanupTaskUuids.length, 'test task(s) removed, price restored to', restoreOriginalPrice, 'for product', restoreProductId);
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
