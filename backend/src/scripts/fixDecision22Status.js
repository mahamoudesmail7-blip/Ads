// AmbScaleDecision id=22 was marked FAILED only because waitAndVerifyScale
// didn't recognize SCHEDULED_NATIVE as a success state (now fixed in
// scaleWinners.js). Verified live on Meta: campaign/ad set/ad all created and
// ACTIVE with existing_customer_budget_percentage=100 and the correct
// start_time. Correcting the bookkeeping only — no new Meta writes.
import 'dotenv/config';
import { prisma } from '../prisma.js';

const row = await prisma.ambScaleDecision.update({
  where: { id: 22 },
  data: { status: 'EXECUTED', error: null },
});
console.log(JSON.stringify(row, null, 2));
process.exit(0);
