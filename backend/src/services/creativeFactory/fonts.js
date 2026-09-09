// AI Creative Factory — Arabic font registration for the text compositor.
//
// Fonts ship as an npm dependency (@expo-google-fonts/cairo — real .ttf
// files), so nothing binary lives in the repo and they resolve identically
// on every host. Registration is lazy + memoised; if @napi-rs/canvas or the
// font package is unavailable the compositor reports isAvailable()=false and
// the pipeline falls back to letting the image model render the text.
import { createRequire } from 'node:module';
import path from 'node:path';
import { logger } from '../../logger.js';

const require = createRequire(import.meta.url);

export const FONT = {
  black: 'CF Cairo Black',      // headlines / CTA
  bold: 'CF Cairo Bold',        // sub-headlines, badges
  semi: 'CF Cairo SemiBold',    // supporting lines
  regular: 'CF Cairo',          // fine print
};

let _canvas = null;
let _ready = null;

/** Returns the @napi-rs/canvas module, or null if it cannot be loaded. */
export function getCanvas() {
  if (_canvas !== null) return _canvas || null;
  try {
    _canvas = require('@napi-rs/canvas');
  } catch (err) {
    logger.error('CF_CANVAS_UNAVAILABLE', { message: err.message?.slice(0, 160) });
    _canvas = false;
  }
  return _canvas || null;
}

function ttf(weightDir, file) {
  const pkg = require.resolve('@expo-google-fonts/cairo/package.json');
  return path.join(path.dirname(pkg), weightDir, file);
}

/** Register the Cairo weights once. Idempotent; safe to call per request. */
export function ensureFonts() {
  if (_ready !== null) return _ready;
  const canvas = getCanvas();
  if (!canvas) { _ready = false; return _ready; }
  try {
    const G = canvas.GlobalFonts;
    G.registerFromPath(ttf('900Black', 'Cairo_900Black.ttf'), FONT.black);
    G.registerFromPath(ttf('700Bold', 'Cairo_700Bold.ttf'), FONT.bold);
    G.registerFromPath(ttf('600SemiBold', 'Cairo_600SemiBold.ttf'), FONT.semi);
    G.registerFromPath(ttf('400Regular', 'Cairo_400Regular.ttf'), FONT.regular);
    _ready = true;
    logger.info('CF_FONTS_REGISTERED', { families: [FONT.black, FONT.bold, FONT.semi, FONT.regular] });
  } catch (err) {
    logger.error('CF_FONTS_REGISTER_FAILED', { message: err.message?.slice(0, 160) });
    _ready = false;
  }
  return _ready;
}

export function textEngineAvailable() {
  return ensureFonts() === true;
}
