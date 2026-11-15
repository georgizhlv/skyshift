/* SkyShift — image rendering: stretches, colour maps, composites */
(function (SS) {
  'use strict';
  const ST = SS.stats;

  /** display limits from robust stats */
  SS.limits = function (img, loQ = 0.25, hiQ = 0.997) {
    const step = Math.max(1, Math.floor(img.length / 40000)); const a = [];
    for (let i = 0; i < img.length; i += step) { const v = img[i]; if (v === v) a.push(v); }
    a.sort((x, y) => x - y);
    const lo = ST.quantile(a, loQ), hi = ST.quantile(a, hiQ);
    return { lo, hi: hi > lo ? hi : lo + 1e-6 };
  };
  const STRETCH = {
    linear: (t) => t,
    sqrt: (t) => Math.sqrt(Math.max(0, t)),
    asinh: (t) => Math.asinh(t * 12) / Math.asinh(12),
    log: (t) => Math.log10(1 + 300 * Math.max(0, t)) / Math.log10(301),
  };
  SS.stretchFn = (name) => STRETCH[name] || STRETCH.asinh;
  const clamp = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

  // perceptual colour maps (compact control points)
  const CMAPS = {
    gray: [[0, 0, 0, 0], [1, 255, 255, 255]],
    inferno: [[0, 0, 0, 4], [0.25, 87, 16, 110], [0.5, 188, 55, 84], [0.75, 249, 142, 9], [1, 252, 255, 164]],
    ice: [[0, 2, 6, 18], [0.35, 20, 70, 140], [0.7, 120, 200, 235], [1, 245, 255, 255]],
    diverge: [[0, 30, 120, 255], [0.5, 12, 14, 22], [1, 255, 90, 60]],
  };
  function lut(name) {
    const P = CMAPS[name] || CMAPS.gray; const L = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) { const t = i / 255; let k = 0; while (k < P.length - 2 && t > P[k + 1][0]) k++; const a = P[k], b = P[k + 1]; const f = (t - a[0]) / (b[0] - a[0]); for (let c = 0; c < 3; c++) L[i * 3 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * f; }
    return L;
  }
  const LUTS = {}; SS.lut = (n) => LUTS[n] || (LUTS[n] = lut(n));
  SS.CMAP_NAMES = Object.keys(CMAPS);

  /** single-channel image → RGBA */
  SS.renderMono = function (img, N, lim, opt) {
    const out = new ImageData(N, N); const d = out.data; const fn = SS.stretchFn(opt.stretch); const L = SS.lut(opt.cmap || 'gray');
    const span = lim.hi - lim.lo;
    for (let k = 0; k < N * N; k++) {
      const v = img[k]; let t;
      if (v !== v) { d[k * 4] = 18; d[k * 4 + 1] = 20; d[k * 4 + 2] = 30; d[k * 4 + 3] = 255; continue; }
      t = clamp(fn(clamp((v - lim.lo) / span))); if (opt.invert) t = 1 - t;
      const i = (t * 255) | 0; d[k * 4] = L[i * 3]; d[k * 4 + 1] = L[i * 3 + 1]; d[k * 4 + 2] = L[i * 3 + 2]; d[k * 4 + 3] = 255;
    }
    return out;
  };
  /** signed difference image → diverging colours, symmetric limit */
  SS.renderDiff = function (img, N, s, opt) {
    const out = new ImageData(N, N); const d = out.data; const L = SS.lut('diverge');
    for (let k = 0; k < N * N; k++) {
      const v = img[k]; if (v !== v) { d[k * 4] = 18; d[k * 4 + 1] = 20; d[k * 4 + 2] = 30; d[k * 4 + 3] = 255; continue; }
      const t = clamp(0.5 + 0.5 * Math.sign(v) * Math.asinh(Math.abs(v) / s * 3) / Math.asinh(3));
      const i = (t * 255) | 0; d[k * 4] = L[i * 3]; d[k * 4 + 1] = L[i * 3 + 1]; d[k * 4 + 2] = L[i * 3 + 2]; d[k * 4 + 3] = 255;
    }
    return out;
  };
  /** colour composite: layers [{img, color:[r,g,b] (0..1), lim}] summed then normalised so equal signals give white */
  SS.renderComposite = function (layers, N, opt) {
    const out = new ImageData(N, N); const d = out.data; const fn = SS.stretchFn(opt.stretch);
    const norm = [0, 0, 0]; layers.forEach(l => { for (let c = 0; c < 3; c++) norm[c] += l.color[c]; });
    for (let k = 0; k < N * N; k++) {
      let r = 0, g = 0, b = 0, any = false;
      for (const l of layers) { const v = l.img[k]; if (v !== v) continue; any = true; const t = clamp(fn(clamp((v - l.lim.lo) / (l.lim.hi - l.lim.lo)))); r += t * l.color[0]; g += t * l.color[1]; b += t * l.color[2]; }
      if (!any) { d[k * 4] = 18; d[k * 4 + 1] = 20; d[k * 4 + 2] = 30; d[k * 4 + 3] = 255; continue; }
      d[k * 4] = clamp(r / norm[0] * (opt.gain || 1)) * 255; d[k * 4 + 1] = clamp(g / norm[1] * (opt.gain || 1)) * 255; d[k * 4 + 2] = clamp(b / norm[2] * (opt.gain || 1)) * 255; d[k * 4 + 3] = 255;
    }
    return out;
  };
  /** hue (0..1) → rgb 0..1, used for "colour = time" */
  SS.hueRGB = function (h) {
    // blue → cyan → green → yellow → red
    const P = [[0, 0.25, 0.45, 1], [0.25, 0.1, 0.9, 1], [0.5, 0.2, 1, 0.3], [0.75, 1, 0.9, 0.1], [1, 1, 0.25, 0.2]];
    let k = 0; while (k < P.length - 2 && h > P[k + 1][0]) k++; const a = P[k], b = P[k + 1]; const f = (h - a[0]) / (b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
  };
})(window.SS);
