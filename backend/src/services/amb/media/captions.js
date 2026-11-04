// AMB Media — Arabic caption images for the explainer video (transparent PNG, rendered with the same Cairo font the Creative Factory uses).
// ffmpeg's own text filter does not shape Arabic reliably, so each caption is drawn here with @napi-rs/canvas (proper RTL + letter joining)
// and overlaid. When the canvas/font stack is unavailable, the video is simply made WITHOUT captions (never with broken letters).
import { getCanvas, ensureFonts, FONT } from '../../creativeFactory/fonts.js';

export const captionsAvailable = () => !!getCanvas() && ensureFonts() === true;

/** Pure: split words into at most `maxLines` lines where each line's measured width fits; returns the lines. */
export function wrapWords(words, measure, maxWidth, maxLines = 2) {
  const lines = []; let cur = '';
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (measure(trial) <= maxWidth || !cur) cur = trial; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const head = lines.slice(0, maxLines - 1); head.push(lines.slice(maxLines - 1).join(' '));
  return head;
}

/** → { png: Buffer, width, height } or null when the text engine is unavailable / the text is empty. */
export function renderCaptionPng(text, { width = 640, fontSize = 46 } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || !captionsAvailable()) return null;
  const { createCanvas } = getCanvas();
  const probe = createCanvas(10, 10).getContext('2d');
  probe.font = `700 ${fontSize}px ${FONT.bold}`; probe.direction = 'rtl';
  const pad = 22, maxW = width - pad * 2;
  const lines = wrapWords(t.split(' '), (s) => probe.measureText(s).width, maxW, 2);
  const lh = Math.round(fontSize * 1.35), height = lines.length * lh + pad * 2;
  const canvas = createCanvas(width, height); const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(8, 10, 22, 0.72)';
  const r = 26; ctx.beginPath(); ctx.moveTo(r, 0); ctx.arcTo(width, 0, width, height, r); ctx.arcTo(width, height, 0, height, r); ctx.arcTo(0, height, 0, 0, r); ctx.arcTo(0, 0, width, 0, r); ctx.closePath(); ctx.fill();
  ctx.font = `700 ${fontSize}px ${FONT.bold}`; ctx.direction = 'rtl'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff';
  lines.forEach((ln, i) => ctx.fillText(ln, width / 2, pad + lh * i + lh / 2));
  return { png: canvas.toBuffer('image/png'), width, height };
}
