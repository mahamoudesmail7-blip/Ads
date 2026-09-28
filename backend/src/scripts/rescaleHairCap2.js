// User-approved re-run of the Hair-Cap _ scale 2 Scale, now that two bugs are
// fixed in cloneEngine.js/scaleWinners.js:
//   1. buildAdSetPayload() now always sets existing_customer_budget_percentage:100
//      ("Customer lifecycle strategy: Get conversions from all audiences").
//   2. Scale's SCHEDULE mode now passes nativeSchedule:true, so the new
//      campaign/ad set/ad go ACTIVE immediately (Meta reviews now, zero spend)
//      with the ad set's start_time set to the requested instant — Meta itself
//      withholds delivery until then.
// This creates a NEW duplicate campaign with the fix applied, per the user's
// explicit instruction ("duplicate the campaign and apply this fix to it") —
// the earlier PAUSED campaign (120252552758360205) is left untouched.
import 'dotenv/config';
import { executeScale } from '../services/amb/scaleWinners.js';

const P = (s = '') => process.stdout.write(s + '\n');

const result = await executeScale({
  sourceCampaignId: '120252367248080205',
  budgetMode: 'CBO',
  campaignBudgetEgp: 200,
  selectedAdIds: ['120252367248090205'],
  startMode: 'SCHEDULE',
  startAt: '2026-09-29T00:00',
  windowName: 'today',
  userId: 1,
});

P('=== RESULT ===');
P(JSON.stringify(result, null, 2));
process.exit(0);
