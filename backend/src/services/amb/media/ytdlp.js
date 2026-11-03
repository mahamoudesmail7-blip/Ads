// AMB Media — yt-dlp wrapper (downloads ONE public video to a temp file). No shell, host allow-list, size/time caps.
// The binary is found (YTDLP_PATH → PATH → backend/.data/bin) or fetched once from the official yt-dlp releases into backend/.data/bin.
// Railway's disk is ephemeral, so a redeploy simply downloads it again on first use.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { MediaError } from './mediaJobs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.resolve(HERE, '../../../../.data/bin');
const IS_WIN = process.platform === 'win32';
const RELEASE = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${IS_WIN ? 'yt-dlp.exe' : 'yt-dlp_linux'}`;
export const ALLOWED_HOSTS = /(^|\.)(tiktok\.com|instagram\.com|youtube\.com|youtu\.be|facebook\.com|fb\.watch)$/i;
export const MAX_FILE = '300M';
export const TIMEOUT_MS = 4 * 60_000;

/** Pure: is this a public video page we are willing to hand to yt-dlp? (https only, known hosts, no credentials in the URL) */
export function isAllowedVideoUrl(raw) {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && ALLOWED_HOSTS.test(u.hostname); } catch { return false; }
}

let cached = null;
export async function ensureYtDlp({ fetchImpl = fetch } = {}) {
  if (cached && fs.existsSync(cached)) return cached;
  const candidates = [process.env.YTDLP_PATH, path.join(BIN_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp')].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return (cached = c);
  const onPath = await new Promise((resolve) => { const p = spawn(IS_WIN ? 'where' : 'which', ['yt-dlp']); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => resolve(code === 0 ? out.split(/\r?\n/)[0].trim() : null)); p.on('error', () => resolve(null)); });
  if (onPath) return (cached = onPath);
  await fs.promises.mkdir(BIN_DIR, { recursive: true });
  const dest = path.join(BIN_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
  const res = await fetchImpl(RELEASE, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new MediaError('تعذّر تنزيل أداة yt-dlp من GitHub.', 'YTDLP_INSTALL', { user: true });
  await fs.promises.writeFile(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  return (cached = dest);
}

function run(bin, args, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new MediaError('التنزيل أخد وقت طويل وانلغى.', 'YTDLP_TIMEOUT')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; if (out.length > 2_000_000) out = out.slice(-1_000_000); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20_000) err = err.slice(-10_000); });
    p.on('error', (e) => { clearTimeout(timer); reject(new MediaError(`yt-dlp مش شغال: ${e.message}`, 'YTDLP_SPAWN')); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve({ out, err }) : reject(new MediaError(`yt-dlp فشل: ${err.trim().split('\n').pop()?.slice(0, 200) || code}`, 'YTDLP_FAIL')); });
  });
}

/** Download one video into a fresh temp dir. Returns { filePath, dir, cleanup() }. The caller MUST call cleanup(). */
export async function downloadVideo(url, { runner = run, ensure = ensureYtDlp } = {}) {
  if (!isAllowedVideoUrl(url)) throw new MediaError('الرابط ده مش مسموح (لازم https من تيك توك أو انستجرام أو يوتيوب أو فيسبوك).', 'BAD_URL');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amb-media-'));
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    const bin = await ensure();
    await runner(bin, ['--no-playlist', '--no-warnings', '--max-filesize', MAX_FILE, '-f', 'mp4/best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', path.join(dir, 'video.%(ext)s'), '--', url]);
    const file = (await fs.promises.readdir(dir)).find((f) => f.startsWith('video.'));
    if (!file) throw new MediaError('التنزيل خلص من غير ملف (الفيديو غالبًا خاص أو محذوف).', 'YTDLP_NOFILE');
    return { filePath: path.join(dir, file), dir, cleanup };
  } catch (e) { await cleanup(); throw e; }
}

export const DIRECT_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net|fbcdn\.com|tiktokcdn\.com|tiktokcdn-us\.com)$/i;

/** Download a direct file URL (Instagram reels / Ad Library "directUrl") — https, CDN host allow-list, streamed to disk with a hard size cap. */
export async function downloadDirect(url, { fetchImpl = fetch, maxBytes = 300 * 1024 * 1024 } = {}) {
  let u; try { u = new URL(url); } catch { throw new MediaError('رابط الفيديو غير صالح.', 'BAD_URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || !DIRECT_HOSTS.test(u.hostname)) throw new MediaError('رابط الفيديو المباشر مش من سيرفرات معروفة.', 'BAD_URL');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amb-media-'));
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new MediaError(`تنزيل الفيديو فشل (${res.status}) — الرابط المؤقت غالبًا انتهى.`, 'DIRECT_FAIL');
    if (Number(res.headers.get('content-length')) > maxBytes) throw new MediaError('الفيديو أكبر من 300MB.', 'TOO_BIG');
    const filePath = path.join(dir, 'video.mp4');
    const out = fs.createWriteStream(filePath);
    let size = 0;
    await new Promise((resolve, reject) => {
      const rd = Readable.fromWeb(res.body);
      rd.on('data', (c) => { size += c.length; if (size > maxBytes) { rd.destroy(new MediaError('الفيديو أكبر من 300MB.', 'TOO_BIG')); } });
      rd.on('error', reject); out.on('error', reject); out.on('finish', resolve);
      rd.pipe(out);
    });
    if (!size) throw new MediaError('الفيديو فاضي.', 'EMPTY_FILE');
    return { filePath, dir, cleanup };
  } catch (e) { await cleanup(); throw e; }
}
