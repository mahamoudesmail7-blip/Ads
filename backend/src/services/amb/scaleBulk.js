// Bulk Scale — the owner ticks several «جاهزة للاسكيل» campaigns, enters the budget / details once, approves once, and the system scales them ONE BY ONE
// (the first now, each next one `gapSeconds` after the previous started). It is only a sequencer around the EXISTING executeScale: every campaign still goes
// through the same validation, the same clone engine, the same decision row and the same «PAUSED + proof» verification as a single scale. Nothing new is
// written to Meta here and the single-scale flow is untouched.
//
// The queue lives in server memory (a status poll survives closing the tab; a server restart drops the campaigns that have not started yet — the ones already
// done are real and recorded in ambScaleDecision). A failure of one campaign never stops the others.
import crypto from 'node:crypto';

export const MAX_ITEMS = 12;
export const MIN_GAP_S = 30;
export const DEFAULT_GAP_S = 60;
export const MAX_GAP_S = 900;

const batches = new Map(); // id -> batch
let activeId = null;

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** Validate + normalise one item exactly like executeScale will need it (so an obviously broken campaign is rejected BEFORE anything starts). */
export function normaliseItem(raw, i) {
  const label = raw?.label ? String(raw.label).slice(0, 120) : String(raw?.sourceCampaignId || `#${i + 1}`);
  const sourceCampaignId = String(raw?.sourceCampaignId || '').trim();
  if (!sourceCampaignId) throw bad(`${label}: sourceCampaignId مطلوب.`);
  if (raw.budgetMode === 'ABO') {
    const adSets = (Array.isArray(raw.adSets) ? raw.adSets : []).map((s) => ({ dailyBudgetEgp: num(s?.dailyBudgetEgp), selectedAdIds: [...new Set((s?.selectedAdIds || []).map(String).filter(Boolean))] }));
    if (!adSets.length) throw bad(`${label}: لازم مجموعة إعلانية واحدة على الأقل.`);
    if (adSets.some((s) => !(s.dailyBudgetEgp > 0))) throw bad(`${label}: الميزانية اليومية لازم تكون أكبر من صفر.`);
    if (adSets.some((s) => !s.selectedAdIds.length)) throw bad(`${label}: اختر إعلانًا واحدًا على الأقل.`);
    return { sourceCampaignId, label, budgetMode: 'ABO', adSets };
  }
  if (raw.budgetMode === 'CBO') {
    const selectedAdIds = [...new Set((raw.selectedAdIds || []).map(String).filter(Boolean))];
    const campaignBudgetEgp = num(raw.campaignBudgetEgp);
    if (!selectedAdIds.length) throw bad(`${label}: اختر إعلانًا رابحًا واحدًا على الأقل.`);
    if (!(campaignBudgetEgp > 0)) throw bad(`${label}: ميزانية الحملة لازم تكون أكبر من صفر.`);
    return { sourceCampaignId, label, budgetMode: 'CBO', selectedAdIds, campaignBudgetEgp };
  }
  throw bad(`${label}: اختر نوع توزيع الميزانية: CBO أو ABO.`);
}

/** Cairo local "YYYY-MM-DDTHH:MM" → epoch ms (Egypt is UTC+2 / +3 with DST — the real conversion is done by executeScale; this is only the "is it still in the future for the LAST campaign" guard). */
export function validatePlan({ items, startMode, startAt, gapSeconds }, { now = Date.now(), toUtc = null } = {}) {
  if (!Array.isArray(items) || !items.length) throw bad('اختار كامبين واحد على الأقل للاسكيل.');
  if (items.length > MAX_ITEMS) throw bad(`الحد الأقصى ${MAX_ITEMS} كامبينات في المرة الواحدة.`);
  const ids = items.map((x) => String(x?.sourceCampaignId || ''));
  if (new Set(ids).size !== ids.length) throw bad('في كامبين متكرر في الاختيار.');
  const gap = Math.round(num(gapSeconds) || DEFAULT_GAP_S);
  if (gap < MIN_GAP_S || gap > MAX_GAP_S) throw bad(`الفاصل بين الكامبينات لازم بين ${MIN_GAP_S} و ${MAX_GAP_S} ثانية.`);
  const mode = startMode === 'SCHEDULE' ? 'SCHEDULE' : 'RUN_NOW';
  const normalised = items.map(normaliseItem);
  if (mode === 'SCHEDULE') {
    const [dp, tp] = String(startAt || '').split('T');
    const at = toUtc ? toUtc(dp, tp || '00:00') : null;
    if (!at || Number.isNaN(at.getTime())) throw bad('تاريخ/وقت البداية غير صالح.');
    // the LAST campaign is created (items-1)*gap seconds from now + its clone time; leave a 3-minute margin so it never lands in the past
    const lastCreatedAt = now + (normalised.length - 1) * gap * 1000 + 180000;
    if (at.getTime() <= lastCreatedAt) throw bad('وقت البداية قريب جدًا بالنسبة لعدد الكامبينات — اختار وقت أبعد (آخر كامبين بيتنشأ بعد ' + Math.ceil(((normalised.length - 1) * gap) / 60) + ' دقيقة تقريبًا).');
  }
  return { items: normalised, startMode: mode, startAt: mode === 'SCHEDULE' ? String(startAt) : null, gapSeconds: gap };
}

export function publicBatch(b) {
  return {
    id: b.id, status: b.status, startedAt: b.startedAt, finishedAt: b.finishedAt, gapSeconds: b.gapSeconds, startMode: b.startMode, startAt: b.startAt,
    nextAt: b.nextAt || null,
    items: b.items.map((it) => ({ sourceCampaignId: it.sourceCampaignId, label: it.label, budgetMode: it.budgetMode, status: it.status, startedAt: it.startedAt || null, finishedAt: it.finishedAt || null, error: it.error || null, result: it.result || null })),
    counts: {
      total: b.items.length,
      done: b.items.filter((x) => x.status === 'DONE').length,
      failed: b.items.filter((x) => x.status === 'FAILED').length,
      skipped: b.items.filter((x) => x.status === 'CANCELED').length,
    },
  };
}

export function getBatch(id) { const b = batches.get(String(id)); return b ? publicBatch(b) : null; }
export function currentBatch() { return activeId ? getBatch(activeId) : null; }
export function latestBatch() { let last = null; for (const b of batches.values()) if (!last || b.startedAt > last.startedAt) last = b; return last ? publicBatch(last) : null; }

export function cancelBatch(id) {
  const b = batches.get(String(id)); if (!b) throw bad('الطلب مش موجود.', 404);
  if (b.status !== 'RUNNING') return publicBatch(b);
  b.cancel = true;
  if (b.wake) b.wake();
  return publicBatch(b);
}

/**
 * Start a bulk scale. `exec` = executeScale (injected for tests), `sleep(ms, wake)` resolves early when cancelled.
 * Returns immediately with the queued batch; the work continues in the background.
 */
export function startBulk({ items, startMode, startAt, gapSeconds, windowName = 'today', userId, adAccountId = null }, { exec, sleep = null, now = () => Date.now(), toUtc = null } = {}) {
  if (typeof exec !== 'function') throw new Error('exec required');
  if (activeId && batches.get(activeId)?.status === 'RUNNING') throw bad('في اسكيل مجمّع شغال دلوقتي — استنى لحد ما يخلص أو وقّفه.', 409);
  const plan = validatePlan({ items, startMode, startAt, gapSeconds }, { now: now(), toUtc });
  const id = crypto.randomBytes(6).toString('hex');
  const b = {
    id, status: 'RUNNING', startedAt: now(), finishedAt: null, gapSeconds: plan.gapSeconds, startMode: plan.startMode, startAt: plan.startAt, nextAt: null, cancel: false, wake: null,
    items: plan.items.map((x) => ({ ...x, status: 'QUEUED' })),
  };
  batches.set(id, b); activeId = id;
  // keep memory small: only the last 10 batches
  if (batches.size > 10) { const old = [...batches.keys()][0]; if (old !== id) batches.delete(old); }

  const doSleep = sleep || ((ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); b.wake = () => { clearTimeout(t); resolve(); }; }));
  (async () => {
    for (let i = 0; i < b.items.length; i++) {
      const it = b.items[i];
      if (b.cancel) { it.status = 'CANCELED'; continue; }
      it.status = 'RUNNING'; it.startedAt = now();
      try {
        const common = { sourceCampaignId: it.sourceCampaignId, budgetMode: it.budgetMode, startMode: b.startMode, startAt: b.startAt, windowName, userId, adAccountId };
        const r = await exec(it.budgetMode === 'ABO' ? { ...common, adSets: it.adSets } : { ...common, selectedAdIds: it.selectedAdIds, campaignBudgetEgp: it.campaignBudgetEgp });
        it.status = 'DONE'; it.result = { scaleCampaignName: r?.scaleCampaignName || null, adSetsCreated: r?.adSetsCreated ?? null, adsCreated: r?.adsCreated ?? null, decisionId: r?.decisionId ?? null };
      } catch (e) {
        it.status = 'FAILED'; it.error = String(e?.message || e).slice(0, 400);
      }
      it.finishedAt = now();
      if (i < b.items.length - 1 && !b.cancel) {
        b.nextAt = now() + b.gapSeconds * 1000;
        await doSleep(b.gapSeconds * 1000, true);
        b.nextAt = null;
      }
    }
    b.status = b.cancel ? 'CANCELED' : 'DONE'; b.finishedAt = now(); b.wake = null;
    if (activeId === id) activeId = null;
  })().catch((e) => { b.status = 'FAILED'; b.error = String(e?.message || e); b.finishedAt = now(); if (activeId === id) activeId = null; });
  return publicBatch(b);
}

/** test helper */
export function _resetForTests() { batches.clear(); activeId = null; }
