// Prevent the old, pre-fix legacy-paused batch (decision 21) from also
// auto-activating at 2026-09-29 00:00 Cairo alongside the new, corrected
// native-scheduled duplicate (decision 22) — cancelling only stops the
// scheduler; the already-cloned campaign stays PAUSED on Meta (no delete,
// no Meta writes here at all).
import 'dotenv/config';
import { cancelBatch } from '../services/amb/cloneEngine.js';

const result = await cancelBatch({ batchId: '09295965-2eb0-4d79-b14a-6f57fa377fa5', userId: 1 });
console.log(JSON.stringify(result, null, 2));
process.exit(0);
