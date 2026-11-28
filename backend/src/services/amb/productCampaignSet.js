// «كسبان ولا خسران؟» — WHICH campaigns, across every ad account, belong to what the owner picked.
// The system's own links (launch wizard / owner mapping) cover only part of the campaigns (the rest were made or duplicated directly in Ads Manager),
// so a product also collects the campaigns that share the same NAME FAMILY as its linked ones ("Radio _ scale 3", "Radio - NewTest", "Radio Scale (APO)" → "radio").
// Rules, in order:
//   1. a campaign linked to this product is always counted;
//   2. a campaign linked to ANOTHER product is never counted;
//   3. an unlinked campaign is counted when its family is selected. A family is selected by default when it holds linked campaigns of this product
//      and at least 80 % of the family's linked campaigns are this product's; the owner can tick / untick any family on the card.
// DISPLAY ONLY: nothing is persisted and nothing here feeds a decision (name matching stays out of every decision path).
// The pure functions take plain data so they can be tested without a database.
import { nameFamily } from './accountProductsToday.js';

export const OWN_SHARE_MIN = 0.8;
const MAX_SUGGESTIONS = 8;
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g; // direction marks and zero-width characters Meta names often carry

/** The grouping key of a campaign name: the same family rule as the Home account window, with hyphens / underscores / marks ignored. Pure. */
export function familyOf(campaignName) {
  const clean = String(campaignName || '').replace(INVISIBLE, '');
  const f = nameFamily(clean);
  const key = f.key.replace(/[\s_\-–—|]+/g, ' ').trim(); // '|' is the list separator of the request, so it never stays in a key
  return { key, label: f.label };
}

/** Two catalog rows with the same name (ignoring spaces / marks / hyphen style) are the same product to the owner. Pure. */
export const sameProductKey = (name) => String(name || '').replace(INVISIBLE, '').replace(/[\s_\-–—]+/g, ' ').trim().toLowerCase();

/** campaigns: [{ id, accountId, name }] -> Map(familyKey -> { key, label, campaigns: [], accounts: Set }). The label is the spelling most campaigns use. Pure. */
export function groupFamilies(campaigns) {
  const fams = new Map();
  for (const c of campaigns) {
    const f = familyOf(c.name);
    if (!f.key) continue;
    let g = fams.get(f.key);
    if (!g) { g = { key: f.key, labels: new Map(), campaigns: [], accounts: new Set() }; fams.set(f.key, g); }
    g.labels.set(f.label, (g.labels.get(f.label) || 0) + 1);
    g.campaigns.push(c); g.accounts.add(c.accountId);
  }
  for (const g of fams.values()) g.label = [...g.labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  return fams;
}

/** For one family: how many of its linked campaigns are this product's, and who holds the most. links: Map(campaignId -> { productKey, productName }). Pure. */
export function familyOwnership(family, links, ownKey) {
  const byProduct = new Map();
  for (const c of family.campaigns) {
    const l = links.get(c.id);
    if (!l) continue;
    const cur = byProduct.get(l.productKey) || { name: l.productName, n: 0 };
    cur.n += 1; byProduct.set(l.productKey, cur);
  }
  const linked = [...byProduct.values()].reduce((s, x) => s + x.n, 0);
  const own = ownKey ? (byProduct.get(ownKey)?.n || 0) : 0;
  const other = [...byProduct.entries()].filter(([k]) => k !== ownKey).sort((a, b) => b[1].n - a[1].n)[0];
  return { linked, own, share: linked ? own / linked : 0, otherName: other ? other[1].name : null };
}

const squash = (k) => k.replace(/\s+/g, '');
/** Families whose name contains a core family's name or the other way round ("fire radio", "radios" next to "radio"). Pure. */
export function similarFamilies(fams, coreKeys) {
  const cores = coreKeys.map(squash).filter((k) => k.length >= 4);
  const out = [];
  for (const f of fams.values()) {
    if (coreKeys.includes(f.key)) continue;
    const s = squash(f.key);
    if (s.length >= 4 && cores.some((c) => s.includes(c) || c.includes(s))) out.push(f.key);
  }
  return out.sort((a, b) => fams.get(b).campaigns.length - fams.get(a).campaigns.length).slice(0, MAX_SUGGESTIONS);
}

/**
 * @param {{ directory: {id,accountId,name}[], links: Map<string,{productKey,productName}>, ownKey?: string|null, familyKey?: string|null,
 *           include?: string[], exclude?: string[] }} p   ownKey = a product was picked; familyKey = a campaign family was picked
 * @returns {{ campaigns: {id,accountId,name,via:'LINK'|'NAME'}[], families: object[] }}
 */
export function selectCampaigns({ directory, links, ownKey = null, familyKey = null, include = [], exclude = [] }) {
  const fams = groupFamilies(directory);
  const linkedOwn = ownKey ? directory.filter((c) => links.get(c.id)?.productKey === ownKey) : [];
  const core = familyKey ? (fams.has(familyKey) ? [familyKey] : []) : [...new Set(linkedOwn.map((c) => familyOf(c.name).key).filter((k) => fams.has(k)))];
  const inc = new Set(include.filter((k) => fams.has(k))), exc = new Set(exclude);
  const defaults = core.filter((k) => familyKey ? true : familyOwnership(fams.get(k), links, ownKey).share >= OWN_SHARE_MIN);
  const selected = new Set([...defaults, ...inc].filter((k) => !exc.has(k)));

  const picked = new Map();
  for (const c of linkedOwn) picked.set(c.id, { ...c, via: 'LINK' });
  for (const k of selected) {
    for (const c of fams.get(k).campaigns) {
      if (picked.has(c.id)) continue;
      const l = links.get(c.id);
      if (!l) picked.set(c.id, { ...c, via: 'NAME' });
      else if (familyKey) picked.set(c.id, { ...c, via: 'LINK' }); // a picked family is the whole family, whatever each campaign is linked to
    }
  }

  const shown = [...new Set([...core, ...inc, ...similarFamilies(fams, core)])];
  const families = shown.map((k) => {
    const f = fams.get(k), o = familyOwnership(f, links, ownKey);
    return { key: k, label: f.label, campaigns: f.campaigns.length, accounts: f.accounts.size, selected: selected.has(k), core: core.includes(k), otherProduct: familyKey || o.share >= OWN_SHARE_MIN ? null : o.otherName };
  });
  return { campaigns: [...picked.values()], families };
}
