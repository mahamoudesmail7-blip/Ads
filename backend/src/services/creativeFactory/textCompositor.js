// AI Creative Factory — deterministic Arabic text composition engine.
//
// The image model is asked to produce a TEXT-FREE composition with a clean
// reserved zone. This module renders the EXACT Claude-approved Arabic
// strings onto that image with real shaping + RTL via @napi-rs/canvas +
// Cairo, so the final Arabic is always 100% correct — never AI letterforms.
//
// It exposes visual TEXT LAYOUTS (not fixed creative templates); the
// Creative Director picks one per image. The engine owns font size, line
// spacing, wrapping, hierarchy, contrast scrim, padding, RTL alignment and
// keeps text off the product / inside safe margins.
import { getCanvas, ensureFonts, FONT, textEngineAvailable } from './fonts.js';
import { logger } from '../../logger.js';

export const TEXT_LAYOUTS = [
  'HEADLINE_TOP',      // headline band top, optional CTA bottom
  'HEADLINE_BOTTOM',   // headline band bottom
  'EDITORIAL_SPLIT',   // headline top-right, support under, product lower-left
  'CENTERED_HERO',     // centered headline over a soft scrim, minimal
  'FEATURE_CALLOUTS',  // small headline + 2–4 pill labels down one side
  'BOTTOM_CTA',        // thin bottom bar: short hook + CTA pill
  'SIDE_INFOGRAPHIC',  // headline top + stacked labels on the right third
  'MINIMAL_HERO',      // tiny headline in a corner, product does the talking
  'NONE',              // no text (pure product shot)
];

export function textCompositorAvailable() {
  return textEngineAvailable();
}

/**
 * @param {object} p
 * @param {Buffer} p.baseImageBuffer   PNG from the image provider (text-free)
 * @param {object} p.copy              { hook, supportingLine, cta, featureLabels:[] } — EXACT strings
 * @param {string} p.layout            one of TEXT_LAYOUTS
 * @param {'PRODUCT_PAGE'|'META_ADS'|string} [p.projectType]
 * @param {string} [p.textDensity]     MINIMAL | LOW | MEDIUM
 * @returns {Promise<{buffer:Buffer, applied:boolean, layout:string, note?:string}>}
 */
export async function composeText({ baseImageBuffer, copy = {}, layout = 'HEADLINE_TOP', projectType, textDensity = 'MINIMAL' }) {
  if (!baseImageBuffer?.length) return { buffer: baseImageBuffer, applied: false, layout, note: 'no base image' };
  if (layout === 'NONE' || (!copy.hook && !copy.headline && !(copy.featureLabels || []).length && !copy.cta)) {
    return { buffer: baseImageBuffer, applied: false, layout: 'NONE' };
  }
  const canvas = getCanvas();
  if (!canvas || !ensureFonts()) {
    return { buffer: baseImageBuffer, applied: false, layout, note: 'text engine unavailable — model text used' };
  }

  try {
    const img = await canvas.loadImage(baseImageBuffer);
    const W = img.width || 1024;
    const H = img.height || 1024;
    const c = canvas.createCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';

    const S = Math.min(W, H) / 1024;      // scale factor vs the 1024 baseline
    const pad = Math.round(64 * S);
    const hook = clean(copy.hook || copy.headline);
    const support = textDensity === 'MEDIUM' || textDensity === 'LOW' ? clean(copy.supportingLine) : '';
    const cta = clean(copy.cta);
    const labels = (copy.featureLabels || []).map(clean).filter(Boolean).slice(0, textDensity === 'MEDIUM' ? 4 : textDensity === 'LOW' ? 3 : 2);

    const zoneDark = sampleLuminance(ctx, W, H, layout) < 0.55;   // is the text zone dark?
    const ink = zoneDark ? '#ffffff' : '#141414';
    const sub = zoneDark ? 'rgba(255,255,255,.86)' : '#3a3a3a';
    const scrim = zoneDark ? 'rgba(0,0,0,.42)' : 'rgba(255,255,255,.82)';
    const accent = '#6c5ce7';

    const draw = LAYOUT_FN[layout] || LAYOUT_FN.HEADLINE_TOP;
    draw({ ctx, canvas, W, H, S, pad, hook, support, cta, labels, ink, sub, scrim, accent, rr });

    return { buffer: c.toBuffer('image/png'), applied: true, layout };
  } catch (err) {
    logger.error('CF_TEXT_COMPOSE_FAILED', { message: err.message?.slice(0, 160) });
    return { buffer: baseImageBuffer, applied: false, layout, note: err.message?.slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// layout implementations
// ---------------------------------------------------------------------------
function band(ctx, x, y, w, h, fill) { ctx.save(); ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); ctx.restore(); }
function gradientBand(ctx, canvas, x, y, w, h, from, to) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, from); g.addColorStop(1, to);
  ctx.save(); ctx.fillStyle = g; ctx.fillRect(x, y, w, h); ctx.restore();
}

function fitText(ctx, text, family, maxPx, maxWidth, minPx = 18) {
  let size = maxPx;
  while (size > minPx) {
    ctx.font = `700 ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}
function wrapLines(ctx, text, family, size, maxWidth, maxLines = 2) {
  ctx.font = `700 ${size}px ${family}`;
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(trial).width > maxWidth && cur) { lines.push(cur); cur = w; }
    else cur = trial;
    if (lines.length === maxLines - 1 && ctx.measureText(`${cur} …`).width > maxWidth) break;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

function drawHeadline(ctx, { hook, support, W, S, pad, ink, sub, yTop }) {
  const maxW = W - pad * 2;
  const size = fitText(ctx, hook, FONT.black, Math.round(78 * S), maxW, Math.round(34 * S));
  const lines = wrapLines(ctx, hook, FONT.black, size, maxW, 2);
  let y = yTop;
  ctx.fillStyle = ink;
  for (const ln of lines) { ctx.font = `700 ${size}px ${FONT.black}`; ctx.fillText(ln, W - pad, y); y += size * 1.18; }
  if (support) {
    const ss = Math.round(size * 0.5);
    ctx.font = `600 ${ss}px ${FONT.semi}`;
    ctx.fillStyle = sub;
    ctx.fillText(ellipsize(ctx, support, maxW), W - pad, y + ss * 0.2);
    y += ss * 1.3;
  }
  return y;
}

function ctaPill({ ctx, W, H, S, pad, cta, accent, rr, bottom = true }) {
  if (!cta) return;
  const fs = Math.round(38 * S);
  ctx.font = `700 ${fs}px ${FONT.black}`;
  const tw = ctx.measureText(cta).width;
  const pw = tw + pad * 1.4;
  const ph = fs + pad * 0.7;
  const x = W - pad - pw;
  const y = bottom ? H - pad - ph : pad;
  ctx.save();
  ctx.fillStyle = accent;
  rr(ctx, x, y, pw, ph, ph * 0.28); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(cta, x + pw / 2, y + ph / 2 + fs * 0.34);
  ctx.restore();
  ctx.textAlign = 'right';
}

function featurePills({ ctx, W, H, S, pad, labels, accent, rr, zoneRightThird = false }) {
  if (!labels.length) return;
  const fs = Math.round(26 * S);
  ctx.font = `700 ${fs}px ${FONT.bold}`;
  let y = zoneRightThird ? Math.round(H * 0.30) : Math.round(H * 0.42);
  for (const lab of labels) {
    const tw = ctx.measureText(lab).width;
    const pw = tw + pad * 0.9;
    const ph = fs + pad * 0.5;
    const x = W - pad - pw;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    rr(ctx, x, y, pw, ph, ph * 0.5); ctx.fill();
    ctx.fillStyle = '#20202a';
    ctx.fillText(lab, x + pw - pad * 0.45, y + ph / 2 + fs * 0.34);
    // accent dot
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(x + pad * 0.4, y + ph / 2, fs * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    y += ph + pad * 0.35;
  }
}

const LAYOUT_FN = {
  HEADLINE_TOP(a) {
    const h = Math.round(a.H * (a.support ? 0.26 : 0.20));
    gradientBand(a.ctx, a.canvas, 0, 0, a.W, h, a.scrim, 'rgba(0,0,0,0)');
    drawHeadline(a.ctx, { ...a, yTop: a.pad + Math.round(56 * a.S) });
    ctaPill(a);
  },
  HEADLINE_BOTTOM(a) {
    const h = Math.round(a.H * (a.support ? 0.30 : 0.24));
    gradientBand(a.ctx, a.canvas, 0, a.H - h, a.W, h, 'rgba(0,0,0,0)', a.scrim);
    const yTop = a.H - h + a.pad * 0.8 + Math.round(46 * a.S);
    drawHeadline(a.ctx, { ...a, yTop });
    ctaPill({ ...a, bottom: false });
  },
  EDITORIAL_SPLIT(a) {
    gradientBand(a.ctx, a.canvas, 0, 0, a.W, Math.round(a.H * 0.34), a.scrim, 'rgba(0,0,0,0)');
    drawHeadline(a.ctx, { ...a, yTop: a.pad + Math.round(60 * a.S) });
    ctaPill(a);
  },
  CENTERED_HERO(a) {
    const { ctx, W, H, S, pad } = a;
    band(ctx, 0, Math.round(H * 0.30), W, Math.round(H * 0.24), a.scrim);
    const maxW = W - pad * 2;
    const size = fitText(ctx, a.hook, FONT.black, Math.round(88 * S), maxW, Math.round(40 * S));
    const lines = wrapLines(ctx, a.hook, FONT.black, size, maxW, 2);
    ctx.save(); ctx.textAlign = 'center'; ctx.fillStyle = a.ink;
    let y = Math.round(H * 0.40);
    for (const ln of lines) { ctx.font = `700 ${size}px ${FONT.black}`; ctx.fillText(ln, W / 2, y); y += size * 1.15; }
    if (a.support) { ctx.font = `600 ${Math.round(size * 0.46)}px ${FONT.semi}`; ctx.fillStyle = a.sub; ctx.fillText(ellipsize(ctx, a.support, maxW), W / 2, y); }
    ctx.restore();
  },
  FEATURE_CALLOUTS(a) {
    gradientBand(a.ctx, a.canvas, 0, 0, a.W, Math.round(a.H * 0.18), a.scrim, 'rgba(0,0,0,0)');
    a.ctx.fillStyle = a.ink;
    const size = fitText(a.ctx, a.hook, FONT.black, Math.round(58 * a.S), a.W - a.pad * 2, Math.round(30 * a.S));
    a.ctx.font = `700 ${size}px ${FONT.black}`;
    a.ctx.fillText(ellipsize(a.ctx, a.hook, a.W - a.pad * 2), a.W - a.pad, a.pad + size);
    featurePills(a);
    ctaPill(a);
  },
  BOTTOM_CTA(a) {
    const h = Math.round(110 * a.S);
    band(a.ctx, 0, a.H - h, a.W, h, a.scrim);
    a.ctx.fillStyle = a.ink;
    const size = fitText(a.ctx, a.hook, FONT.black, Math.round(40 * a.S), a.W * 0.55, Math.round(24 * a.S));
    a.ctx.font = `700 ${size}px ${FONT.black}`;
    a.ctx.fillText(ellipsize(a.ctx, a.hook, a.W * 0.55), a.W - a.pad, a.H - h / 2 + size * 0.34);
    ctaPill(a);
  },
  SIDE_INFOGRAPHIC(a) {
    gradientBand(a.ctx, a.canvas, 0, 0, a.W, Math.round(a.H * 0.16), a.scrim, 'rgba(0,0,0,0)');
    a.ctx.fillStyle = a.ink;
    const size = fitText(a.ctx, a.hook, FONT.black, Math.round(52 * a.S), a.W - a.pad * 2, Math.round(28 * a.S));
    a.ctx.font = `700 ${size}px ${FONT.black}`;
    a.ctx.fillText(ellipsize(a.ctx, a.hook, a.W - a.pad * 2), a.W - a.pad, a.pad + size);
    featurePills({ ...a, zoneRightThird: true });
  },
  MINIMAL_HERO(a) {
    const size = Math.round(34 * a.S);
    a.ctx.save();
    a.ctx.fillStyle = 'rgba(255,255,255,.9)';
    a.ctx.font = `700 ${size}px ${FONT.bold}`;
    const tw = a.ctx.measureText(a.hook).width;
    rr(a.ctx, a.W - a.pad - tw - a.pad * 0.8, a.pad, tw + a.pad * 0.8, size + a.pad * 0.5, 12); a.ctx.fill();
    a.ctx.fillStyle = '#20202a';
    a.ctx.fillText(a.hook, a.W - a.pad - a.pad * 0.4, a.pad + size + a.pad * 0.08);
    a.ctx.restore();
  },
};

// ---------------------------------------------------------------------------
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 4 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t.trim()}…`;
}
function sampleLuminance(ctx, W, H, layout) {
  try {
    const region = layout.includes('BOTTOM') || layout === 'BOTTOM_CTA'
      ? { x: 0, y: Math.round(H * 0.78), w: W, h: Math.round(H * 0.2) }
      : { x: 0, y: 0, w: W, h: Math.round(H * 0.2) };
    const d = ctx.getImageData(region.x, region.y, region.w, region.h).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) { // sparse sample
      sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      n++;
    }
    return n ? sum / n : 0.7;
  } catch { return 0.7; }
}
