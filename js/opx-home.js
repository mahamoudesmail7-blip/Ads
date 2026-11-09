// opx-home.js — «الرئيسية»: the SIMPLE front door of AI Operator. One screen, plain Arabic, no jargon:
//   1) one sentence about the state (what the system does for you right now), 2) «محتاج منك دلوقتي» — only what really waits for a decision, each with ONE button,
//   3) the mode in three big choices, 4) one red stop button. Everything else lives one click away (the other workspaces / «أدوات متقدمة»).
// Presentation only: it reads the same /overview + /status-bar numbers the shell already loads, mode changes and Emergency Stop go through the shell's own (confirmed) handlers.
import { E, num, ICONS } from './opx-ui.js';

const MODES = [
  { key: 'OFF', title: 'يدوي', icon: '✋', line: 'النظام يراقب ويقترح بس. مفيش حاجة بتتنفّذ إلا لما تضغط إنت.' },
  { key: 'APPROVAL', title: 'بموافقتي', icon: '✅', line: 'النظام يجهّز الفتح والإيقاف والميزانيات، وإنت تعتمد قبل أي تنفيذ على Meta.' },
  { key: 'AUTOPILOT', title: 'تلقائي', icon: '🤖', line: 'النظام ينفّذ لوحده حسب السياسات اللي إنت وافقت عليها. بيطلب تفعيل خاص.' },
];

/** The one-sentence state + its tone. Pure (tested). */
export function describeState(ov) {
  if (!ov) return { tone: 'gray', title: 'بحمّل الحالة…', text: '' };
  if (ov.emergencyStop) return { tone: 'red', title: '🛑 الإيقاف الفوري شغّال', text: 'مفيش أي فتح أو إيقاف أو تغيير ميزانية. المراقبة شغّالة. ' + (ov.emergencyReason || '') };
  const locked = !!ov.writesLocked;
  if (ov.mode === 'AUTOPILOT') return { tone: locked ? 'amber' : 'green', title: locked ? 'تلقائي — بس الكتابة على Meta مقفولة' : 'تلقائي — النظام شغّال لوحده', text: locked ? 'النظام بيحاكي بس، مفيش تنفيذ فعلي لحد ما تفتح قفل النشر.' : 'بينفّذ حسب السياسات اللي وافقت عليها، وبيوقف نفسه لو حاجة غلط.' };
  if (ov.mode === 'APPROVAL') return { tone: locked ? 'amber' : 'green', title: locked ? 'بموافقتي — بس الكتابة على Meta مقفولة' : 'بموافقتي — النظام بيجهّز وإنت بتعتمد', text: locked ? 'تقدر تراجع وتعتمد، بس مفيش تنفيذ فعلي لحد ما تفتح قفل النشر.' : 'مفيش حاجة بتتغيّر على Meta من غير موافقتك.' };
  if (ov.mode === 'SHADOW') return { tone: 'amber', title: 'محاكاة', text: 'النظام بيجرّب القرارات من غير أي تنفيذ فعلي.' };
  return { tone: 'blue', title: 'يدوي', text: 'النظام بيراقب وبيقترح، وإنت اللي بتنفّذ.' };
}

/** What waits for the owner: only items with a count > 0. Pure (tested). */
export function attentionItems(ov, st) {
  const k = (ov && ov.kpis) || {}; const s = st || {};
  const rows = [
    { key: 'approvals', n: Number(s.pendingApprovals) || 0, icon: 'approve', tone: 'violet', text: (n) => `${n} قرار مستني موافقتك`, btn: 'راجع واعتمد' },
    { key: 'open', n: Number(k.readyToOpen) || 0, icon: 'play', tone: 'green', text: (n) => `${n} حملة جاهزة للفتح`, btn: 'افتح الحملات' },
    { key: 'pause', n: Number(k.proposedPause) || 0, icon: 'pause', tone: 'red', text: (n) => `${n} حملة مقترح إيقافها`, btn: 'راجع الإيقاف' },
    { key: 'budget', n: Number(k.scaleOpportunities) || 0, icon: 'budget', tone: 'blue', text: (n) => `${n} فرصة لزيادة الميزانية`, btn: 'راجع الميزانيات' },
    { key: 'alerts', n: Number(s.importantAlerts) || 0, icon: 'bell', tone: 'amber', text: (n) => `${n} تنبيه مهم`, btn: 'شوف التنبيهات' },
  ];
  return rows.filter((r) => r.n > 0);
}

export async function mountHomeWorkspace(host, ctx) {
  const ov = ctx.ov(); const st = ctx.status ? ctx.status() : null; const s = describeState(ov); const items = attentionItems(ov, st); const k = (ov && ov.kpis) || {};
  const cur = ov?.mode;
  host.innerHTML = `
    <div class="opx-card opx-home-state ${s.tone} opx-fade">
      <div class="opx-home-dot"></div>
      <div class="grow"><h1>${E(s.title)}</h1><p>${E(s.text)}</p></div>
      <button class="opx-btn danger" data-opxstop ${ov?.emergencyStop ? 'disabled' : ''}>${ICONS.stop} إيقاف فوري</button>
    </div>
    <div class="opx-card opx-home-todo opx-fade">
      <h2>محتاج منك دلوقتي</h2>
      ${items.length ? `<div class="opx-home-list">${items.map((i) => `<div class="opx-home-row"><span class="opx-head-icon ${i.tone}" style="width:40px;height:40px">${ICONS[i.icon]}</span><b>${E(i.text(num(i.n)))}</b><button class="opx-btn primary" data-go="${i.key}">${E(i.btn)}</button></div>`).join('')}</div>`
        : '<div class="opx-home-ok">✅ كل حاجة تمام. مفيش حاجة محتاجة منك دلوقتي.</div>'}
      <small class="opx-home-sub">النهارده: ${num(k.actionsToday || 0)} عملية اتنفّذت · ${num(k.monitored || 0)} حملة تحت المراقبة${Number(st?.scheduledPlans) ? ` · ${num(st.scheduledPlans)} خطة مجدولة` : ''}</small>
    </div>
    <div class="opx-card opx-home-modes opx-fade">
      <h2>النظام يشتغل إزاي؟</h2>
      <div class="opx-home-modegrid">${MODES.map((m) => `<button class="opx-home-mode ${cur === m.key ? 'on' : ''}" data-opxmode="${m.key}" ${ctx.isAdmin ? '' : 'disabled'}><span class="ic">${m.icon}</span><b>${m.title}</b><small>${E(m.line)}</small>${cur === m.key ? '<span class="tag">الحالي</span>' : ''}</button>`).join('')}</div>
    </div>
    <div class="opx-home-more opx-fade"><span>محتاج حاجة تانية؟</span>
      <button class="opx-btn" data-go="history">سجل التنفيذ</button><button class="opx-btn" data-go="rules">قواعد المنتجات</button><button class="opx-btn" data-go="automation">الأتمتة</button><button class="opx-btn" data-go="integration">مركز الربط</button></div>`;
  host.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => ctx.open?.(b.dataset.go); });
}
