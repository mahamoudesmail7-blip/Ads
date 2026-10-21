// reverseImageDiscovery.js — finds pages / ads / shops that show THE SAME PRODUCT straight from the owner's photo (Google Lens through SerpApi),
// instead of only guessing from text keywords (which is what returns look-alikes). Everything it returns is still verified by exactProductJudge.js —
// Lens itself only says «visually similar», the judge decides «the same product».
//   needs: SERPAPI_API_KEY, and a public https origin for the app (RAILWAY_PUBLIC_DOMAIN / PUBLIC_BASE_URL) so Lens can fetch the temporary photo URL.
//   When either is missing it SKIPS and says why — it never invents results.
import { logger } from '../logger.js';
import * as serpApi from './searchProviders/serpApiProvider.js';
import { hostReferenceImage, dropHostedImage } from './researchReferenceHost.js';

export const lensEnabled = () => (process.env.REVERSE_IMAGE_ENABLED || 'true').trim().toLowerCase() !== 'false';
const PER_TYPE_LIMIT = 40;
const TYPES = [['exact_matches', 'LENS_EXACT'], ['visual_matches', 'LENS_VISUAL']];

function normalizeLensItem(item, queryType) {
  let url;
  try { url = new URL(item.url); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  if (!item.thumbnail) return null; // no picture → the judge cannot verify it → it would only ever be «unverified»; not worth a row
  return {
    platform: 'google',
    content_type: 'Page',
    canonical_url: url.toString(),
    original_url: item.url,
    title: item.title || null,
    snippet: item.snippet || null,
    account_name: item.accountName || null,
    account_url: null,
    thumbnail: item.thumbnail,
    published_at: null,
    metrics_json: item.price ? JSON.stringify({ price: item.price }) : null,
    provider: 'serpapi_google_lens',
    raw_metadata_json: JSON.stringify(item.raw || {}).slice(0, 20000),
    discovered_by_queries_json: JSON.stringify([{ query: 'reverse-image (Google Lens)', queryType }]),
  };
}

/**
 * @param {{references:{imageBase64:string, imageMediaType?:string}[], country?:string}} p
 * @returns {Promise<{status:'OK'|'SKIPPED_DISABLED'|'SKIPPED_NO_KEY'|'SKIPPED_NO_PUBLIC_URL'|'FAILED', normalized:object[], counts:object, error:string|null}>}
 */
export async function discoverByImage({ references, country = 'EG', serp = serpApi, host = hostReferenceImage, drop = dropHostedImage }) {
  const empty = (status, error = null) => ({ status, normalized: [], counts: {}, error });
  if (!lensEnabled()) return empty('SKIPPED_DISABLED');
  if (!serp.isConfigured()) return empty('SKIPPED_NO_KEY');
  const ref = (references || [])[0];
  if (!ref?.imageBase64) return empty('SKIPPED_DISABLED');
  let hosted;
  try { hosted = host(ref.imageBase64, ref.imageMediaType); } catch (e) { return empty('FAILED', `reference image: ${e.message}`); }
  if (!hosted.url) { drop(hosted.token); return empty('SKIPPED_NO_PUBLIC_URL'); }

  const byUrl = new Map(); const counts = {}; let lastError = null; let anyOk = false;
  try {
    for (const [type, queryType] of TYPES) {
      try {
        const items = await serp.searchByImage({ imageUrl: hosted.url, type, country, resultsLimit: PER_TYPE_LIMIT });
        anyOk = true; counts[type] = items.length;
        for (const it of items) {
          const n = normalizeLensItem(it, queryType);
          if (!n) continue;
          const prev = byUrl.get(n.canonical_url);
          if (!prev) byUrl.set(n.canonical_url, n);
          else if (queryType === 'LENS_EXACT') byUrl.set(n.canonical_url, { ...prev, discovered_by_queries_json: n.discovered_by_queries_json }); // an exact-match hit is the stronger signal
        }
      } catch (e) {
        lastError = e.message; counts[type] = 0;
        logger.error('[ReverseImage] lens call failed', { type, message: e.message });
        if (/run out of searches|invalid api key|api_key/i.test(e.message || '')) break; // quota / key problem: the second call would fail the same way
      }
    }
  } finally { drop(hosted.token); }
  return { status: anyOk ? 'OK' : 'FAILED', normalized: [...byUrl.values()], counts, error: anyOk ? null : lastError };
}
