// OWNER'S SWITCHBOARD for the AI Operator — run by the OWNER from a terminal (Railway env injected by `railway run`). One step per call, each one verifies the state before and after and refuses unsafe orders.
//   status        read-only: mode, write lock, the four permissions, emergency stop, the autopilot gate, last action
//   perms-on      turns the four execution permissions ON (open · pause · budgetIncrease · budgetDecrease). Refuses while the emergency stop is on. Does NOT open the Meta lock and does NOT change the mode.
//   perms-off     turns them OFF again
//   mode-auto     global mode → AUTOPILOT. Needs: every gate check OK (including the Meta write lock opened by the owner on Railway), emergency stop off.
//   mode-approval global mode → APPROVAL (back to «prepare, owner approves»)
//   stop          EMERGENCY STOP ON (blocks every new Meta execution immediately; pauses nothing, changes no budget)
//   resume        emergency stop OFF
//   cpa-approve   approves the CURRENT saved version of «الفتح حسب CPA» (what the unattended opening uses). Opens nothing.
//   sched-on      «التنفيذ المجدول» ON: at the plan time (00:00 Cairo) the approved plans / the AUTOMATIC opening run without a click. Needs mode AUTOPILOT + every gate ✓.
//   sched-off     «التنفيذ المجدول» OFF again (plans are prepared only; nothing runs without an approve click)
//   node src/scripts/ownerOperatorSwitch.mjs <step>      (via:  railway run -s <service> node src/scripts/ownerOperatorSwitch.mjs <step>)
import { prisma } from '../prisma.js';
import * as S from '../services/amb/operatorStore.js';
import { setExecutionPermission } from '../services/amb/executionPermissions.js';
import * as OC from '../services/amb/openCpaPolicy.js';
import * as D from '../services/amb/dailyPlans.js';

const OWNER_EMAIL_ID = Number(process.env.OPERATOR_OWNER_USER_ID || 1); const step = process.argv[2];
const KEYS = ['open', 'pause', 'budgetIncrease', 'budgetDecrease'];
const show = async (label) => { const c = await S.getOperatorConfig(); const g = await S.autopilotGate(); const pol = await OC.getOpenCpaPolicy(); const dc = await D.getDailyPlanConfig(); const last = await prisma.ambAction.findFirst({ orderBy: { id: 'desc' }, select: { id: true, action_type: true, execution_status: true, entity_name: true } });
  console.log(`\n${label}\n  mode: ${c.mode === 'OFF' ? 'MANUAL' : c.mode}\n  Meta write lock: ${c.writesLocked ? 'LOCKED 🔒' : 'OPEN 🔓'}\n  permissions: ${KEYS.map((k) => `${k}=${c.execPermissions[k] ? 'ON' : 'off'}`).join('  ')}\n  open-by-CPA: v${pol.version} ${pol.minCpa ?? '—'}–${pol.maxCpa ?? '—'} (${pol.window}, min orders ${pol.minPurchases}) · ${pol.enabled ? 'ON' : 'off'} · approved v${pol.approved?.version ?? '—'}${pol.approved?.version === pol.version ? ' ✓' : ' ✗ (current version NOT approved)'}
  scheduled execution: ${dc.scheduledExecution?.enabled ? 'ON' : 'off'}
  emergency stop: ${c.emergency_stop ? 'ON 🛑' : 'off'}\n  gate: ${g.checks.map((x) => `${x.ok ? '✓' : '✗'} ${x.key}`).join(' · ')}\n  actions on Meta so far: ${await prisma.ambAction.count()} (last: #${last?.id} ${last?.action_type} ${last?.execution_status})`); return c; };
try {
  if (!['status', 'perms-on', 'perms-off', 'mode-auto', 'mode-approval', 'stop', 'resume', 'cpa-approve', 'sched-on', 'sched-off'].includes(step)) { console.log('usage: ownerOperatorSwitch.mjs status | perms-on | perms-off | mode-auto | mode-approval | stop | resume | cpa-approve | sched-on | sched-off'); process.exitCode = 1; }
  else {
    const c = await show('BEFORE');
    if (step === 'perms-on') { if (c.emergency_stop) throw new Error('الطوارئ مفعّل — ألغيه الأول (resume).'); for (const key of KEYS) await setExecutionPermission({ key, on: true, confirm: true, userId: OWNER_EMAIL_ID }); }
    if (step === 'perms-off') for (const key of KEYS) await setExecutionPermission({ key, on: false, confirm: true, userId: OWNER_EMAIL_ID });
    if (step === 'mode-auto') await S.setOperatorMode({ mode: 'AUTOPILOT', userId: OWNER_EMAIL_ID, confirmAutopilot: true });
    if (step === 'mode-approval') await S.setOperatorMode({ mode: 'APPROVAL', userId: OWNER_EMAIL_ID });
    if (step === 'stop') await S.setEmergencyStop({ on: true, reason: 'إيقاف يدوي من المالك (ownerOperatorSwitch)', userId: OWNER_EMAIL_ID });
    if (step === 'resume') await S.setEmergencyStop({ on: false, userId: OWNER_EMAIL_ID });
    if (step === 'cpa-approve') await OC.setOpenCpaEnabled({ enabled: true, confirm: true, userId: OWNER_EMAIL_ID });
    if (step === 'sched-on') { if (c.emergency_stop) throw new Error('الطوارئ مفعّل — ألغيه الأول (resume).'); if (c.mode !== 'AUTOPILOT') throw new Error('الوضع مش AUTOMATIC — شغّل mode-auto الأول.'); await D.setDailyPlanConfig({ patch: { scheduledExecution: { enabled: true } }, userId: OWNER_EMAIL_ID }); }
    if (step === 'sched-off') await D.setDailyPlanConfig({ patch: { scheduledExecution: { enabled: false } }, userId: OWNER_EMAIL_ID });
    if (step !== 'status') await show('AFTER');
  }
} catch (e) { console.log(`\n✗ ${e.message}`); process.exitCode = 1; }
finally { await prisma.$disconnect(); setTimeout(() => process.exit(process.exitCode || 0), 50); }
