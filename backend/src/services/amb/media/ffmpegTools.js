// AMB Media — ffmpeg helpers (no shell, bounded time). The binary comes from FFMPEG_PATH, else the optional `ffmpeg-static` package, else PATH.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { MediaError } from './mediaJobs.js';

const require = createRequire(import.meta.url);
let cached;

export function ffmpegPath() {
  if (cached) return cached;
  const env = String(process.env.FFMPEG_PATH || '').trim();
  if (env) return (cached = env);
  try { const p = require('ffmpeg-static'); if (p) return (cached = p); } catch { /* optional dependency not installed */ }
  return (cached = 'ffmpeg');
}
export const __resetFfmpegCache = () => { cached = undefined; };

/** Runs ffmpeg; resolves { stderr } (ffmpeg writes its log there). Rejects with a MediaError on a non-zero exit or a spawn failure. */
export function runFfmpeg(args, { timeoutMs = 5 * 60_000, bin = ffmpegPath() } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-hide_banner', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new MediaError('تجميع الفيديو أخد وقت طويل وانلغى.', 'FFMPEG_TIMEOUT')); }, timeoutMs);
    p.stderr.on('data', (d) => { err += d; if (err.length > 200_000) err = err.slice(-100_000); });
    p.on('error', (e) => { clearTimeout(timer); reject(new MediaError(e.code === 'ENOENT' ? 'أداة ffmpeg مش متاحة على السيرفر.' : `ffmpeg فشل في التشغيل: ${e.message}`, 'FFMPEG_MISSING')); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve({ stderr: err }) : reject(new MediaError(`تجميع الفيديو فشل: ${err.trim().split('\n').slice(-2).join(' ').slice(0, 220)}`, 'FFMPEG_FAIL')); });
  });
}

/** Media duration in seconds (reads the "Duration:" line ffmpeg prints for an input). null when unreadable. */
export async function probeDuration(file, { bin = ffmpegPath() } = {}) {
  const out = await new Promise((resolve) => {
    const p = spawn(bin, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => resolve('')); p.on('close', () => resolve(err));
  });
  return parseDuration(out);
}
/** Pure: "Duration: 00:00:05.04," → 5.04 */
export function parseDuration(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(text || ''));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
