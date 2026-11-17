// order-sound.js — the «new order» sound, rendered as PCM samples (no audio file to ship). The same function feeds the browser (AudioBuffer) and a test / preview WAV, so what you hear in the system is exactly what was previewed.
// variant 'register' (default): a cash-register «ka-CHING» — drawer thunk + click, a real-bell ring (inharmonic partials, two slightly detuned copies for shimmer) and a handful of coins settling, over a short room tail.
// variant 'pop': a short, soft, modern two-note glass «ding-ding».
const TAU = Math.PI * 2;

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const expEnv = (i, att, len, v) => (i < att ? v * (i / att) : v * Math.exp(-6.9 * ((i - att) / len))); // linear attack, exponential decay (-60 dB at `len`)

function tone(buf, sr, { f, at = 0, v = 0.3, len = 1, att = 0.004, detune = 0, harm = 0 }) {
  const s0 = Math.floor(at * sr), n = Math.floor(len * sr), a = Math.floor(att * sr);
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / sr; const e = expEnv(i, a, n, v);
    buf[s0 + i] += e * (Math.sin(TAU * f * t) + (harm ? harm * Math.sin(TAU * f * 2 * t) : 0) + (detune ? Math.sin(TAU * (f + detune) * t) : 0));
  }
}
function click(buf, sr, rnd, { at = 0, v = 0.5, len = 0.035, lp = 0.55 }) { // filtered noise burst
  const s0 = Math.floor(at * sr), n = Math.floor(len * sr); let y = 0;
  for (let i = 0; i < n && s0 + i < buf.length; i++) { y += lp * ((rnd() * 2 - 1) - y); buf[s0 + i] += y * v * (1 - i / n) ** 2; }
}
function reverb(buf, sr, mix) { // four feedback combs, cheap and clean
  const out = Float64Array.from(buf);
  for (const [ms, fb] of [[29.7, 0.5], [37.1, 0.46], [41.1, 0.42], [43.7, 0.4]]) {
    const d = Math.floor(sr * ms / 1000), line = new Float64Array(d); let p = 0;
    for (let i = 0; i < buf.length; i++) { const y = line[p]; line[p] = buf[i] + y * fb; out[i] += y * mix; p = (p + 1) % d; }
  }
  return out;
}

export function renderOrderSound(sr = 44100, variant = 'register') {
  const dur = variant === 'pop' ? 1.4 : 2.4; const buf = new Float64Array(Math.floor(sr * dur)); const rnd = mulberry(7);
  if (variant === 'pop') {
    tone(buf, sr, { f: 1318.5, at: 0, v: 0.34, len: 0.9, att: 0.003, harm: 0.18, detune: 1.3 }); // E6
    tone(buf, sr, { f: 1760, at: 0.11, v: 0.34, len: 1.1, att: 0.003, harm: 0.18, detune: 1.6 }); // A6
    tone(buf, sr, { f: 2637, at: 0.11, v: 0.07, len: 0.5, att: 0.003 });
  } else {
    // «ka»: the drawer — a low thunk and a dry click
    tone(buf, sr, { f: 170, at: 0, v: 0.5, len: 0.09, att: 0.002 }); tone(buf, sr, { f: 95, at: 0, v: 0.35, len: 0.12, att: 0.002 });
    click(buf, sr, rnd, { at: 0, v: 0.55, len: 0.03 }); click(buf, sr, rnd, { at: 0.045, v: 0.3, len: 0.02, lp: 0.8 });
    // «CHING»: a bell struck at 0.085 s — partials of a small metal bell, each copy detuned a few Hz so it shimmers
    const f0 = 1865; // ~A#6
    for (const [r, v, len] of [[1, 0.3, 1.9], [2.01, 0.2, 1.5], [2.76, 0.15, 1.15], [4.07, 0.1, 0.8], [5.43, 0.06, 0.5], [0.5, 0.12, 1.3]]) {
      tone(buf, sr, { f: f0 * r, at: 0.085, v, len, att: 0.0025, detune: 2.7 + r });
    }
    // coins settling: quick metallic pings that fall in level and spread out
    [[0.30, 4380, 0.1], [0.37, 5220, 0.085], [0.43, 3920, 0.075], [0.52, 5870, 0.06], [0.58, 4700, 0.05], [0.69, 5320, 0.04], [0.80, 4110, 0.03]].forEach(([at, f, v]) => { tone(buf, sr, { f, at, v, len: 0.16, att: 0.0015, detune: 11 }); click(buf, sr, rnd, { at, v: v * 0.6, len: 0.006, lp: 0.9 }); });
  }
  const wet = reverb(buf, sr, variant === 'pop' ? 0.2 : 0.16);
  // LOUD: normalise to full scale, then push it through a soft limiter (tanh) — the quiet tail comes up a lot while the peaks stay clean (no hard clipping), so it is clearly audible over a busy desk
  let peak = 0; for (const s of wet) peak = Math.max(peak, Math.abs(s)); const DRIVE = 3.2, CEIL = 0.98, norm = Math.tanh(DRIVE);
  const n = wet.length, fade = Math.floor(sr * 0.08), out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = CEIL * (Math.tanh(DRIVE * wet[i] / (peak || 1)) / norm) * (i > n - fade ? (n - i) / fade : 1);
  return out;
}
