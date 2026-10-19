// launch-globe.js — the interactive 3D Earth of the launch wizard (step «المنصات والصفحة والجمهور»). PURE PRESENTATION: it never reads or writes the campaign targeting, Meta location ids or the payload —
// the wizard owns that state; this module only draws, flies the camera and reports what the user clicked.
//   · lazy: nothing is downloaded until the step is opened (globe.gl bundle ≈ 1.9 MB, textures ≈ 230 KB; the 1k texture is used on phones)
//   · real WebGL sphere (three.js inside globe.gl): drag / touch to rotate, wheel / pinch + the +/− buttons to zoom (clamped), slow auto-rotate that stops while the user interacts
//   · Egypt: glowing outline + pin + flag. No continent or country NAMES are drawn, and no fake links between countries.
//   · GPU-friendly: pixel ratio capped at 1.5, rendering paused when the globe is off-screen / the tab is hidden, disposed when the step closes; honours prefers-reduced-motion
//   · fails soft: if WebGL or a file is unavailable, mountLaunchGlobe() rejects and the wizard keeps every targeting tool working without it.
const BASE = '/vendor/globe/';
export const EGYPT_VIEW = { lat: 26.8, lng: 30.8, altitude: 1.9 };
const ZOOM = { min: 0.55, max: 4.2 };
// visual markers for well-known Egyptian governorates (coordinates only for DRAWING a dot; the targeting key always comes from Meta's own search)
export const GOV_COORDS = { 'القاهرة': [30.04, 31.24], 'Cairo': [30.04, 31.24], 'الإسكندرية': [31.2, 29.92], 'Alexandria': [31.2, 29.92], 'الجيزة': [30.01, 31.21], 'Giza': [30.01, 31.21], 'المنصورة': [31.04, 31.38], 'Mansoura': [31.04, 31.38], 'الدقهلية': [31.04, 31.38], 'Dakahlia': [31.04, 31.38], 'طنطا': [30.79, 31.0], 'Tanta': [30.79, 31.0], 'الغربية': [30.79, 31.0], 'Gharbia': [30.79, 31.0], 'الأقصر': [25.69, 32.64], 'Luxor': [25.69, 32.64], 'أسوان': [24.09, 32.9], 'Aswan': [24.09, 32.9], 'بورسعيد': [31.26, 32.3], 'Port Said': [31.26, 32.3], 'السويس': [29.97, 32.55], 'Suez': [29.97, 32.55], 'الإسماعيلية': [30.6, 32.27], 'Ismailia': [30.6, 32.27], 'أسيوط': [27.18, 31.18], 'Asyut': [27.18, 31.18], 'المنيا': [28.11, 30.75], 'Minya': [28.11, 30.75], 'الشرقية': [30.59, 31.5], 'Sharqia': [30.59, 31.5], 'القليوبية': [30.18, 31.2], 'Qalyubia': [30.18, 31.2], 'البحيرة': [30.85, 30.35], 'Beheira': [30.85, 30.35], 'الفيوم': [29.31, 30.84], 'Faiyum': [29.31, 30.84], 'سوهاج': [26.56, 31.69], 'Sohag': [26.56, 31.69], 'قنا': [26.16, 32.72], 'Qena': [26.16, 32.72], 'دمياط': [31.42, 31.82], 'Damietta': [31.42, 31.82], 'كفر الشيخ': [31.11, 30.94], 'Kafr El Sheikh': [31.11, 30.94], 'المنوفية': [30.47, 31.0], 'Monufia': [30.47, 31.0], 'بني سويف': [29.07, 31.1], 'Beni Suef': [29.07, 31.1], 'مطروح': [31.35, 27.24], 'Matrouh': [31.35, 27.24], 'جنوب سيناء': [28.24, 33.62], 'شمال سيناء': [31.13, 33.8], 'البحر الأحمر': [27.26, 33.81], 'Red Sea': [27.26, 33.81] };
export const coordsOfRegion = (name) => { const n = String(name || ''); const hit = Object.keys(GOV_COORDS).find((k) => n === k || n.includes(k)); return hit ? GOV_COORDS[hit] : null; };

let scriptPromise = null; let dataPromise = null;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = () => res(); s.onerror = () => rej(new Error('تعذّر تحميل مكتبة الكوكب')); document.head.appendChild(s); }); }
export const loadGlobeLib = () => { if (window.Globe) return Promise.resolve(window.Globe); if (!scriptPromise) scriptPromise = loadScript(`${BASE}globe.gl.min.js`).then(() => window.Globe).catch((e) => { scriptPromise = null; throw e; }); return scriptPromise; };
export function loadGlobeData() { if (!dataPromise) dataPromise = Promise.all([fetch(`${BASE}countries.json`).then((r) => r.json()), fetch(`${BASE}egypt.geo.json`).then((r) => r.json())]).then(([countries, egypt]) => ({ countries, egypt })).catch((e) => { dataPromise = null; throw e; }); return dataPromise; }
export function webglSupported() { try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); } catch { return false; } }

const FLAG_SVG = '<svg viewBox="0 0 30 20" width="30" height="20" aria-hidden="true"><rect width="30" height="20" fill="#fff" rx="2"/><rect width="30" height="6.7" fill="#ce1126" rx="2"/><rect y="13.3" width="30" height="6.7" fill="#000" rx="2"/><path d="M15 7.6l.9 2.2-.9 2.2-.9-2.2z" fill="#c09300"/></svg>';

/**
 * mountLaunchGlobe(host, { regions: [{name}], onError }) → controller
 *   controller: { flyToEgypt(), zoom(+1|-1), flyToLatLng(lat,lng,altitude), setRegions(regions), setVisible(bool), dispose(), info }
 */
export async function mountLaunchGlobe(host, { regions = [] } = {}) {
  if (!webglSupported()) throw new Error('WEBGL_UNSUPPORTED');
  const [Globe, data] = await Promise.all([loadGlobeLib(), loadGlobeData()]);
  if (!host.isConnected) throw new Error('HOST_GONE');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const small = (host.clientWidth || 600) < 560; const tex = small ? 'earth-1k.jpg' : 'earth-2k.jpg';
  const w = host.clientWidth || 600, h = host.clientHeight || 520;
  const egyptPin = document.createElement('div'); egyptPin.className = 'lp-pin'; egyptPin.innerHTML = `<span class="lp-flag">${FLAG_SVG}</span><span class="lp-pinhead"></span><span class="lp-pinname">مصر</span>`;
  const globe = Globe({ rendererConfig: { antialias: true, alpha: true, powerPreference: 'low-power' } })(host)
    .width(w).height(h).backgroundColor('rgba(0,0,0,0)')
    .globeImageUrl(`${BASE}${tex}`).bumpImageUrl(`${BASE}earth-bump-1k.jpg`)
    .showAtmosphere(true).atmosphereColor('#6aa8ff').atmosphereAltitude(0.22)
    .showGraticules(false)
    .polygonsData(data.egypt.features).polygonCapColor(() => 'rgba(255,140,40,0.28)').polygonSideColor(() => 'rgba(255,170,60,0.55)').polygonStrokeColor(() => '#ffb454').polygonAltitude(0.012)
    .htmlElementsData([{ lat: 26.8, lng: 30.8 }]).htmlLat((d) => d.lat).htmlLng((d) => d.lng).htmlAltitude(0.02).htmlElement(() => egyptPin);
  const renderer = globe.renderer(); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); // GPU cap
  const scene = globe.scene(); // gentle light so the globe has a lit side and a soft shadow side (looks like the reference, never fully black)
  try { const mat = globe.globeMaterial(); mat.bumpScale = 6; mat.shininess = 8; } catch { /* material tweaks are cosmetic */ }
  const controls = globe.controls(); controls.enableDamping = true; controls.dampingFactor = 0.08; controls.rotateSpeed = 0.55; controls.zoomSpeed = 0.7; controls.enablePan = false;
  const R = globe.getGlobeRadius(); controls.minDistance = R * (1 + ZOOM.min); controls.maxDistance = R * (1 + ZOOM.max);
  controls.autoRotate = !reduced; controls.autoRotateSpeed = 0.35;
  let idleTimer = null; const stopAuto = () => { controls.autoRotate = false; clearTimeout(idleTimer); };
  const resumeAuto = () => { if (reduced) return; clearTimeout(idleTimer); idleTimer = setTimeout(() => { controls.autoRotate = true; }, 6000); }; // stops while the user interacts, resumes quietly after a pause
  controls.addEventListener('start', stopAuto); controls.addEventListener('end', resumeAuto);
  const dur = reduced ? 0 : 1100; const altitudeNow = () => globe.pointOfView().altitude;
  let visible = true; let disposed = false; let ro = null; let io = null;
  const onVis = () => { if (document.hidden) globe.pauseAnimation(); else if (visible) globe.resumeAnimation(); }; document.addEventListener('visibilitychange', onVis);
  io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { visible = es[0]?.isIntersecting !== false; if (!visible) globe.pauseAnimation(); else if (!document.hidden) globe.resumeAnimation(); }, { threshold: 0.01 }) : null; io?.observe(host);
  ro = 'ResizeObserver' in window ? new ResizeObserver(() => { if (disposed) return; globe.width(host.clientWidth || w).height(host.clientHeight || h); }) : null; ro?.observe(host);
  globe.pointOfView(reduced ? EGYPT_VIEW : { lat: 20, lng: 15, altitude: 3.0 }, 0); globe.pointOfView(EGYPT_VIEW, reduced ? 0 : 1800); // opens with a slow fly-in to Egypt
  const regionPoints = (rs) => (rs || []).map((r) => { const c = coordsOfRegion(r.name); return c ? { lat: c[0], lng: c[1], name: r.name } : null; }).filter(Boolean);
  const setRegions = (rs) => { globe.pointsData(regionPoints(rs)).pointLat('lat').pointLng('lng').pointColor(() => '#ffd27a').pointAltitude(0.03).pointRadius(0.45).pointsMerge(false); };
  setRegions(regions);
  const api = {
    info: { texture: tex, rendererPixelRatio: renderer.getPixelRatio() },
    flyToEgypt: () => { stopAuto(); globe.pointOfView(EGYPT_VIEW, dur); resumeAuto(); },
    flyToLatLng: (lat, lng, altitude = 1.6) => { stopAuto(); globe.pointOfView({ lat, lng, altitude }, dur); resumeAuto(); },
    zoom: (dir) => { stopAuto(); const pov = globe.pointOfView(); const next = Math.min(ZOOM.max, Math.max(ZOOM.min, pov.altitude * (dir > 0 ? 0.68 : 1.46))); globe.pointOfView({ ...pov, altitude: next }, reduced ? 0 : 450); resumeAuto(); },
    altitude: altitudeNow,
    pov: () => globe.pointOfView(),
    isAutoRotating: () => !!controls.autoRotate,
    frames: () => renderer.info.render.frame, // render-call counter (used to prove rendering pauses when hidden)
    pointCount: () => (globe.pointsData() || []).length,
    limits: { min: ZOOM.min, max: ZOOM.max },
    setRegions,
    setVisible: (v) => { visible = !!v; if (!v) globe.pauseAnimation(); else if (!document.hidden) globe.resumeAnimation(); },
    dispose: () => { if (disposed) return; disposed = true; clearTimeout(idleTimer); document.removeEventListener('visibilitychange', onVis); io?.disconnect(); ro?.disconnect(); try { globe.pauseAnimation(); controls.dispose?.(); renderer.dispose?.(); renderer.forceContextLoss?.(); scene.traverse?.((o) => { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : [m]).forEach((x) => { x?.map?.dispose?.(); x?.dispose?.(); }); }); } catch { /* best effort */ } host.replaceChildren(); },
    _globe: globe,
  };
  return api;
}
export function countryNameAr(code) { try { return new Intl.DisplayNames(['ar'], { type: 'region' }).of(code) || code; } catch { return code; } }
