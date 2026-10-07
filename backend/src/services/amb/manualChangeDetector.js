// ✋ Manual-change detector — recognises what the OWNER changed by hand in Meta Ads Manager and records it as MANUAL_OVERRIDE, so the AI never reverses it. 2026-10-07.
//
// The older detector (operatorEngine.detectManualOverrides) only noticed a manual edit made AFTER one of the Operator's own executed actions. This one is independent of any
// AI action: it diffs consecutive VALID synced snapshots of every ACTIVE campaign (campaign budget = CBO) and of its ad sets (ad-set budget = ABO), plus the
// ACTIVE <-> PAUSED status of both. A change is attributed to the SYSTEM only if the AMB executor / the Operator executed an action on that entity (or its campaign)
// around it; everything else is the owner's. Each manual change is stored once as an \`amb_operator_events\` row (kind MANUAL_OVERRIDE, created_at = when the sync first SAW the
// change) which (a) puts the campaign into the MANUAL_OVERRIDE_COOLDOWN guard (24h by default, all consequential actions) and (b) is read by the Dynamic Budget Optimizer as the
// "last change" of that entity, so its own cooldown (24h scale / 48h reduce) and the new-evidence-since-change rule apply to the owner's edit too.
// Read-only on Meta (uses only already-synced snapshots). Rows with a NULL status are failed-metadata rows (see snapshotSync) and are ignored.
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { getConnection } from '../metaAuth.js';
import { listCampaignsFromSnapshots } from './operatorContext.js';

const MS_H = 3_600_000, MS_M = 60_000;
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const RUNNING_STATES = new Set(['ACTIVE', 'PAUSED']);
export const MANUAL_DEFAULTS = { lookbackHours: 36, minBudgetDeltaPct: 1, systemWindowMin: 35, throttleMin: 30, patternDays: 7, patternMinDays: 2, patternMinCount: 3, patternLinkMin: 45 };

/**
 * PURE. rows = snapshots of ONE entity, any order: [{at: Date, status, budget}]. Returns the changes seen between consecutive valid rows:
 * [{field:'budget'|'status', from, to, prevAt, seenAt}]. A row with a null status is dropped; a null/zero budget is skipped (CBO campaign / ABO ad set carries none).
 * Status changes count only between ACTIVE and PAUSED (effective statuses such as WITH_ISSUES / CAMPAIGN_PAUSED are not owner actions).
 */
export function diffEntityRows(rows, { minBudgetDeltaPct = MANUAL_DEFAULTS.minBudgetDeltaPct } = {}) {
  const valid = rows.filter((r) => r.status != null).sort((a, b) => new Date(a.at) - new Date(b.at));
  const out = []; let prevS = null, prevB = null;
  for (const r of valid) {
    const at = new Date(r.at);
    if (prevS && RUNNING_STATES.has(prevS.v) && RUNNING_STATES.has(r.status) && prevS.v !== r.status) out.push({ field: 'status', from: prevS.v, to: r.status, prevAt: prevS.at, seenAt: at });
    prevS = { v: r.status, at };
    const b = Number(r.budget);
    if (Number.isFinite(b) && b > 0) {
      if (prevB && Math.abs(b - prevB.v) / prevB.v * 100 >= minBudgetDeltaPct) out.push({ field: 'budget', from: prevB.v, to: b, prevAt: prevB.at, seenAt: at });
      prevB = { v: b, at };
    }
  }
  return out;
}
/**
 * PURE. A RECURRING schedule is not an owner edit: on production the same campaigns were paused around 11:10 UTC and resumed around 21:30 UTC on several days in a row (a Meta rule /
 * day-parting / a fixed routine). Recording each of those as a manual override would keep every campaign in permanent cooldown. Status changes (field 'status') of the same direction
 * whose time-of-day clusters (gaps <= linkMin) over >= minDays DISTINCT days with >= minCount changes are flagged `recurring`. Budget edits are never treated as a schedule.
 * Returns a NEW array with `recurring: boolean` on every change.
 */
export function classifyRecurring(changes, { minDays = MANUAL_DEFAULTS.patternMinDays, minCount = MANUAL_DEFAULTS.patternMinCount, linkMin = MANUAL_DEFAULTS.patternLinkMin } = {}) {
  const out = changes.map((c) => ({ ...c, recurring: false }));
  const groups = new Map();
  out.forEach((c, i) => { if (c.field !== 'status') return; const d = new Date(c.seenAt); const key = `${c.from}>${c.to}`; (groups.get(key) || groups.set(key, []).get(key)).push({ i, min: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.toISOString().slice(0, 10) }); });
  for (const items of groups.values()) {
    items.sort((a, b) => a.min - b.min);
    let cluster = [];
    const flush = () => { if (cluster.length >= minCount && new Set(cluster.map((x) => x.day)).size >= minDays) for (const x of cluster) out[x.i].recurring = true; cluster = []; };
    for (const it of items) { if (cluster.length && it.min - cluster[cluster.length - 1].min > linkMin) flush(); cluster.push(it); }
    flush();
  }
  return out;
}
/** PURE. A change is the SYSTEM's when a system action executed on the entity / its campaign inside [prevAt - 5min, seenAt + windowMin]. */
export function isSystemChange(change, systemTimes, windowMin = MANUAL_DEFAULTS.systemWindowMin) {
  const a = new Date(change.prevAt).getTime() - 5 * MS_M, b = new Date(change.seenAt).getTime() + windowMin * MS_M;
  return systemTimes.some((t) => { const x = new Date(t).getTime(); return x >= a && x <= b; });
}
const eventKey = (campaignId, d) => `${campaignId}|${d.entityId}|${d.field}|${d.to}|${new Date(d.seenAt).toISOString()}`;

let lastRunAt = 0;
/**
 * Detects and (record=true) stores the owner's manual changes of the last `lookbackHours`. Idempotent. `throttleMin` (scheduler use) skips the run when the previous one is recent.
 * deps (tests): activeCampaigns, campaignRows, adsetRows, systemTimes(entityId, campaignId) => Date[], existingKeys:Set.
 */
export async function detectManualChanges({ now = new Date(), lookbackHours = MANUAL_DEFAULTS.lookbackHours, record = true, throttleMin = 0, deps = {} } = {}) {
  if (throttleMin && now.getTime() - lastRunAt < throttleMin * MS_M) return { skipped: 'THROTTLED' };
  const conn = deps.adAccountId ? { selected_ad_account_id: deps.adAccountId, status: 'CONNECTED' } : await getConnection();
  const adAccountId = conn?.selected_ad_account_id; if (!adAccountId || conn.status !== 'CONNECTED') return { skipped: 'NOT_CONNECTED' };
  const recordSince = new Date(now.getTime() - lookbackHours * MS_H); // changes seen after this are candidates to RECORD
  const since = new Date(now.getTime() - Math.max(lookbackHours, MANUAL_DEFAULTS.patternDays * 24) * MS_H); // ...but a week of history is read so that a recurring schedule can be recognised
  const active = (deps.activeCampaigns || (await listCampaignsFromSnapshots({ adAccountId })).filter((c) => c.status === 'ACTIVE')).map((c) => ({ id: c.id, name: c.name }));
  const ids = active.map((c) => c.id); const nameOf = new Map(active.map((c) => [c.id, c.name]));
  if (!ids.length) return { checked: 0, changes: [], recorded: 0 };
  const campRows = deps.campaignRows || await prisma.metaPerformanceSnapshot.findMany({ where: { ad_account_id: adAccountId, level: 'campaign', campaign_id: { in: ids }, snapshot_at: { gte: since }, campaign_status: { not: null } }, orderBy: { snapshot_at: 'asc' }, select: { campaign_id: true, snapshot_at: true, campaign_status: true, campaign_budget: true } });
  const adsRows = deps.adsetRows || await prisma.metaPerformanceSnapshot.findMany({ where: { ad_account_id: adAccountId, level: 'adset', campaign_id: { in: ids }, adset_id: { not: null }, snapshot_at: { gte: since }, adset_status: { not: null } }, orderBy: { snapshot_at: 'asc' }, select: { campaign_id: true, adset_id: true, adset_name: true, snapshot_at: true, adset_status: true, adset_budget: true } });
  const entities = new Map(); // key -> {level, id, name, campaignId, rows[]}
  for (const r of campRows) { const e = entities.get(`c:${r.campaign_id}`) || entities.set(`c:${r.campaign_id}`, { level: 'campaign', id: r.campaign_id, name: nameOf.get(r.campaign_id) || null, campaignId: r.campaign_id, rows: [] }).get(`c:${r.campaign_id}`); e.rows.push({ at: r.snapshot_at, status: r.campaign_status, budget: r.campaign_budget }); }
  for (const r of adsRows) { const e = entities.get(`a:${r.adset_id}`) || entities.set(`a:${r.adset_id}`, { level: 'adset', id: r.adset_id, name: r.adset_name || null, campaignId: r.campaign_id, rows: [] }).get(`a:${r.adset_id}`); e.rows.push({ at: r.snapshot_at, status: r.adset_status, budget: r.adset_budget }); }
  const entityIds = [...entities.values()].map((e) => e.id);
  // system activity (executor / operator) in the window — attributed per entity or per campaign
  const sysByEntity = new Map(), sysByCampaign = new Map();
  if (!deps.systemTimes) {
    for (const a of await prisma.ambAction.findMany({ where: { entity_id: { in: [...entityIds, ...ids] }, execution_status: 'EXECUTED', executed_at: { gte: new Date(since.getTime() - MS_H) } }, select: { entity_id: true, executed_at: true } })) (sysByEntity.get(a.entity_id) || sysByEntity.set(a.entity_id, []).get(a.entity_id)).push(a.executed_at);
    for (const d of await prisma.ambOperatorDecision.findMany({ where: { campaign_id: { in: ids }, status: { in: ['EXECUTING', 'EXECUTED', 'VERIFIED'] }, executed_at: { gte: new Date(since.getTime() - MS_H) } }, select: { campaign_id: true, executed_at: true } })) (sysByCampaign.get(d.campaign_id) || sysByCampaign.set(d.campaign_id, []).get(d.campaign_id)).push(d.executed_at);
  }
  const sysTimes = (e) => (deps.systemTimes ? deps.systemTimes(e.id, e.campaignId) : [...(sysByEntity.get(e.id) || []), ...(sysByEntity.get(e.campaignId) || []), ...(sysByCampaign.get(e.campaignId) || [])]);
  const all = []; let systemAttributed = 0;
  for (const e of entities.values()) for (const ch of diffEntityRows(e.rows)) { if (isSystemChange(ch, sysTimes(e))) { systemAttributed++; continue; } all.push({ campaignId: e.campaignId, campaign: nameOf.get(e.campaignId) || null, level: e.level, entityId: e.id, entityName: e.name, ...ch }); }
  const classified = classifyRecurring(all);
  const recurring = classified.filter((c) => c.recurring);
  const found = classified.filter((c) => !c.recurring && c.seenAt >= recordSince); // genuine one-off owner edits inside the recording window
  let recorded = 0;
  if (record && found.length) {
    const existing = deps.existingKeys || new Set((await prisma.ambOperatorEvent.findMany({ where: { kind: 'MANUAL_OVERRIDE', campaign_id: { in: ids }, created_at: { gte: new Date(recordSince.getTime() - MS_H) } }, select: { campaign_id: true, data_json: true } })).map((r) => { const d = j(r.data_json, {}) || {}; return d.source === 'META_DIFF' ? eventKey(r.campaign_id, d) : null; }).filter(Boolean));
    for (const f of found) {
      const data = { source: 'META_DIFF', level: f.level, entityId: f.entityId, entityName: f.entityName, field: f.field, from: f.from, to: f.to, prevAt: f.prevAt.toISOString(), seenAt: f.seenAt.toISOString() };
      if (existing.has(eventKey(f.campaignId, data))) continue;
      const what = f.field === 'budget' ? `ميزانية ${f.from} → ${f.to}` : `حالة ${f.from} → ${f.to}`;
      if (deps.onRecord) await deps.onRecord({ campaignId: f.campaignId, data });
      else await prisma.ambOperatorEvent.create({ data: { kind: 'MANUAL_OVERRIDE', actor: 'USER', note: `تغيير يدوي من Meta على ${f.level === 'campaign' ? 'الحملة' : 'الـAd Set'} (${what}) — الأتمتة موقوفة عليها لفترة تهدئة`.slice(0, 480), data_json: JSON.stringify(data), campaign_id: f.campaignId, created_at: f.seenAt } });
      existing.add(eventKey(f.campaignId, data)); recorded++;
    }
  }
  lastRunAt = now.getTime();
  if (recorded) logger.info('[manualChangeDetector] manual Meta changes recorded as MANUAL_OVERRIDE', { recorded, changes: found.length });
  return { checked: entities.size, recurringSchedule: { changes: recurring.length, entities: new Set(recurring.map((c) => c.entityId)).size }, changes: found.map((f) => ({ campaign: f.campaign, level: f.level, entityId: f.entityId, field: f.field, from: f.from, to: f.to, seenAt: f.seenAt.toISOString() })), recorded, systemAttributed };
}
/** Test helper: forget the throttle. */
export const __resetManualDetectorThrottle = () => { lastRunAt = 0; };
