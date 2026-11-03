// AMB Media — Phase 2b: takes the candidates the owner PICKED from a finished search, downloads each one on this server
// (direct CDN file when Apify gave one, else yt-dlp) and uploads it to the job's ad account, registering it in the wizard's creative pool.
// Only ids that exist in the stored search result are accepted — the browser can never make the server fetch an arbitrary URL.
import { getJob, MediaError } from './mediaJobs.js';
import { downloadDirect, downloadVideo, isAllowedVideoUrl } from './ytdlp.js';
import { addVideoFileToPool } from './launchAssets.js';

export const MAX_IMPORT = 10;

async function fetchFile(c, deps) {
  const direct = deps.downloadDirect || downloadDirect, viaYt = deps.downloadVideo || downloadVideo;
  if (c.directUrl) { try { return await direct(c.directUrl); } catch (e) { if (!isAllowedVideoUrl(c.url)) throw e; /* fall back to yt-dlp below */ } }
  return viaYt(c.url);
}

export async function runImport({ launchJobId, findJobId, ids, ctx, deps = {} }) {
  const find = await getJob(findJobId);
  if (!find || find.kind !== 'VIDEO_FIND' || find.status !== 'SUCCEEDED') throw new MediaError('نتيجة البحث مش جاهزة أو انتهت — ابحث تاني.', 'BAD_INPUT');
  if (find.launchJobId !== launchJobId) throw new MediaError('نتيجة البحث دي تابعة لطلب كامبين تاني.', 'BAD_INPUT');
  const byId = new Map((find.result?.candidates || []).map((c) => [c.id, c]));
  const picked = [...new Set((ids || []).map(String))].filter((id) => byId.has(id)).slice(0, MAX_IMPORT);
  if (!picked.length) throw new MediaError('اختار فيديو واحد على الأقل.', 'BAD_INPUT');

  const added = [], failed = [];
  for (let i = 0; i < picked.length; i++) {
    const c = byId.get(picked[i]);
    await ctx.progress((i / picked.length) * 95, `بنزّل وبرفع ${i + 1} من ${picked.length}`);
    let file = null;
    try {
      file = await fetchFile(c, deps);
      const r = await (deps.addVideo || addVideoFileToPool)({ launchJobId, filePath: file.filePath, filename: `${c.source.toLowerCase()}-${c.id}.mp4`, durationSeconds: c.durationSec });
      added.push({ id: c.id, slotKey: r.slotKey, videoId: r.videoId, source: c.source });
    } catch (e) { failed.push({ id: c.id, error: e.message }); }
    finally { await file?.cleanup?.(); }
  }
  if (!added.length) throw new MediaError(failed[0]?.error || 'ما اتنزّلش أي فيديو.', 'IMPORT_FAILED');
  return { added, failed };
}
