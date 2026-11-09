// 🧪 AI Operator «الرئيسية» (simple view) — the two pure functions that decide what the owner reads (state sentence + «محتاج منك دلوقتي»), plus tripwires that keep the simple view presentation-only.
//   node src/scripts/opxHomeTest.js        (no database needed)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(join(__dirname, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } };

const homeSrc = read('../../../js/opx-home.js');
const body = homeSrc.replace(/^import .*$/m, '').replace(/export /g, '').split('async function mountHomeWorkspace')[0];
const { describeState, attentionItems } = new Function(`${body}\nreturn { describeState, attentionItems };`)();

console.log('\n1. the state sentence');
ok('emergency stop → red, says nothing can change', describeState({ emergencyStop: true, emergencyReason: 'x' }).tone === 'red' && /مفيش أي فتح/.test(describeState({ emergencyStop: true }).text));
ok('approval + writes open → green («مفيش حاجة بتتغيّر من غير موافقتك»)', describeState({ mode: 'APPROVAL', writesLocked: false }).tone === 'green' && /من غير موافقتك/.test(describeState({ mode: 'APPROVAL', writesLocked: false }).text));
ok('approval + writes LOCKED → amber and honest that nothing real runs', describeState({ mode: 'APPROVAL', writesLocked: true }).tone === 'amber' && /مفيش تنفيذ فعلي/.test(describeState({ mode: 'APPROVAL', writesLocked: true }).text));
ok('autopilot is green only when writes are open; locked → amber', describeState({ mode: 'AUTOPILOT', writesLocked: false }).tone === 'green' && describeState({ mode: 'AUTOPILOT', writesLocked: true }).tone === 'amber');
ok('manual → blue, shadow → amber, nothing loaded → gray', describeState({ mode: 'OFF' }).tone === 'blue' && describeState({ mode: 'SHADOW' }).tone === 'amber' && describeState(null).tone === 'gray');

console.log('\n2. «محتاج منك دلوقتي»');
const it = attentionItems({ kpis: { readyToOpen: 3, proposedPause: 0, scaleOpportunities: 2 } }, { pendingApprovals: 5, importantAlerts: 0 });
ok('only things with a count > 0, approvals first', it.map((x) => x.key).join() === 'approvals,open,budget');
ok('every item is one plain sentence with ONE button', it.every((x) => /\d/.test(x.text(x.n)) && x.btn.length > 3) && it[0].text(5) === '5 قرار مستني موافقتك');
ok('nothing pending → empty (the screen says «كل حاجة تمام»)', attentionItems({ kpis: {} }, {}).length === 0 && attentionItems(null, null).length === 0);

console.log('\n3. the simple view is presentation only');
const css = read('../../../css/opx.css'); const plan = read('../../../js/opx-plan.js'); const shell = read('../../../js/opx-shell.js');
ok('the simple view hides with CSS only (display:none on .opx-adv — nothing is removed, so every handler keeps working)', /\.opx\[data-simple="1"\] \.opx-adv \{ display: none !important; \}/.test(css));
ok('«عرض كامل» exists and is remembered', /id="opxSimple"/.test(shell) && /store\.set\('opx\.simple'/.test(shell));
ok('the plan workspace only gained CSS classes (its approve / select / preview handlers are untouched)', (plan.match(/opx-adv/g) || []).length >= 9 && /data-act="approve"/.test(plan) && /data-act="preview"/.test(plan));
ok('mode changes and Emergency Stop still go through the shell’s confirmed handlers (Home only renders buttons carrying data-opxmode / data-opxstop)', /data-opxmode=/.test(homeSrc) && /data-opxstop/.test(homeSrc) && !/api\.(put|post|delete)/.test(homeSrc));
ok('Home never talks to the server itself', !/from '\.\/api-client\.js'/.test(homeSrc));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
