import 'dotenv/config';
import { getDecryptedToken } from './src/services/metaAuth.js';
const token = await getDecryptedToken();
const DST = 'act_874732772237565';
const BASE = 'https://graph.facebook.com/v21.0';

async function tryCreate(label, extra) {
  const form = new URLSearchParams();
  form.set('name', 'ZZZ clone write-test probe (delete me)');
  form.set('objective', 'OUTCOME_SALES');
  form.set('status', 'PAUSED');
  form.set('buying_type', 'AUCTION');
  for (const [k, v] of Object.entries(extra)) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  form.set('access_token', token);
  const res = await fetch(`${BASE}/${DST}/campaigns`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const data = await res.json().catch(() => null);
  if (res.ok && data?.id) {
    console.log(`  [${label}] => CREATED id=${data.id}`);
    // delete it immediately — this was only a param probe
    const del = await fetch(`${BASE}/${data.id}?access_token=${encodeURIComponent(token)}`, { method: 'DELETE' });
    const dj = await del.json().catch(() => null);
    console.log(`      deleted: ${JSON.stringify(dj)}`);
    return data.id;
  }
  console.log(`  [${label}] => ERR: ${JSON.stringify(data?.error)}`);
  return null;
}

console.log('Probing special_ad_categories values on POST /' + DST + '/campaigns (creates a PAUSED probe campaign, deletes it right away):\n');
let done = await tryCreate('special_ad_categories=[]', { special_ad_categories: [] });
if (!done) done = await tryCreate('special_ad_categories=["NONE"]', { special_ad_categories: ['NONE'] });
if (!done) done = await tryCreate('special_ad_categories=[] + country=[]', { special_ad_categories: [], special_ad_category_country: [] });
if (!done) done = await tryCreate('special_ad_categories omitted entirely', {});
if (!done) done = await tryCreate('special_ad_categories="[]" string', { special_ad_categories: '[]' });
if (!done) done = await tryCreate('objective=OUTCOME_TRAFFIC + sac=[]', { objective: 'OUTCOME_TRAFFIC', special_ad_categories: [] });
