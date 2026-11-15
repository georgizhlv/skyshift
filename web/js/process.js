/* SkyShift — loading, resampling, epoch stacking, photometry, astrometry */
(function (SS) {
  'use strict';
  const C = SS.C, ST = SS.stats;

  /* ---------- epochs ---------- */
  SS.groupEpochs = function (frames, gapDays = 20, maxSpan = 40) {
    const E = []; let cur = null;
    for (const f of frames) {
      if (!cur || f.mjd - cur.last > gapDays || f.mjd - cur.first > maxSpan) { cur = { first: f.mjd, last: f.mjd, frames: [] }; E.push(cur); }
      cur.frames.push(f); cur.last = f.mjd;
    }
    // fold tiny epochs (a few stray exposures) into their neighbour so every epoch is a solid stack
    for (let k = E.length - 1; k >= 0; k--) { const e = E[k]; if (E.length > 1 && e.frames.length < Math.max(6, 0.06 * frames.length)) { const prev = E[k - 1], next = E[k + 1]; const tgt = !prev ? next : !next ? prev : (e.first - prev.last < next.first - e.last ? prev : next); if (Math.abs(tgt.first - e.first) < 75) { tgt.frames = tgt.frames.concat(e.frames).sort((a, b) => a.mjd - b.mjd); tgt.first = Math.min(tgt.first, e.first); tgt.last = Math.max(tgt.last, e.last); E.splice(k, 1); } } }
    E.forEach((e, i) => { e.i = i; e.mjd = e.frames.reduce((s, f) => s + f.mjd, 0) / e.frames.length; e.frames.forEach(f => f.epoch = i); });
    return E;
  };

  /** choose up to maxFrames, spread evenly over (epoch × detector) buckets and in time */
  SS.selectFrames = function (epochs, dets, maxFrames) {
    const buckets = [];
    epochs.forEach(e => dets.forEach(d => { const b = e.frames.filter(f => f.det === d); if (b.length) buckets.push(b); }));
    if (!buckets.length) return [];
    const total = buckets.reduce((s, b) => s + b.length, 0);
    if (!maxFrames || total <= maxFrames) return buckets.flat().sort((a, b) => a.mjd - b.mjd);
    // water-filling quota
    let quota = Math.floor(maxFrames / buckets.length), left;
    for (let it = 0; it < 20; it++) { const used = buckets.reduce((s, b) => s + Math.min(b.length, quota), 0); left = maxFrames - used; if (left <= 0) break; quota++; }
    const out = [];
    buckets.forEach(b => { const n = Math.min(b.length, quota); for (let k = 0; k < n; k++) out.push(b[Math.floor((k + 0.5) * b.length / n)]); });
    return out.sort((a, b) => a.mjd - b.mjd);
  };

  /* ---------- the output grid: north up, east left ---------- */
  SS.makeGrid = function (ra, dec, fovArcmin) {
    const fov = fovArcmin * 60; const scale = Math.max(3, fov / 240); const N = Math.round(fov / scale) | 1;
    return { ra, dec, fov: fovArcmin, scale, N, tan: new SS.Tan(ra, dec), c: (N - 1) / 2, omega: (scale / 206264.806) ** 2 };
  };
  SS.gridToSky = (g, i, j) => g.tan.toSky((g.c - i) * g.scale / 3600, (g.c - j) * g.scale / 3600);
  SS.skyToGrid = (g, ra, dec) => { const [xi, eta] = g.tan.toPlane(ra, dec); return [g.c - xi * 3600 / g.scale, g.c - eta * 3600 / g.scale]; };

  /** estimated download size of one frame for this grid (bytes) */
  SS.frameBytes = (g) => Math.ceil(g.fov * 60 * 1.45 / 6.15 + 8) * C.ROWBYTES;

  /* ---------- load & resample one frame ---------- */
  SS.loadFrame = async function (f, g, target) {
    const hdr = await SS.fits.imageHeader(f.url);
    const H = hdr.H; const w = new SS.WCS(H);
    f.H = H; f.wcs = w; f.mjd = H['MJD-AVG'] || f.mjd; f.det = H.DETECTOR || f.det; f.exptime = H.XPOSURE; f.fwhm = H.PSF_FWHM;
    const N = g.N, step = 8, nc = Math.ceil((N - 1) / step) + 1;
    const cx = new Float64Array(nc * nc), cy = new Float64Array(nc * nc);
    let ymin = Infinity, ymax = -Infinity, xin = 0;
    for (let b = 0; b < nc; b++) for (let a = 0; a < nc; a++) {
      const [ra, dec] = SS.gridToSky(g, a * step, b * step);
      const p = w.sky2pix(ra, dec); if (!p) { cx[b * nc + a] = NaN; cy[b * nc + a] = NaN; continue; }
      cx[b * nc + a] = p[0] - 1; cy[b * nc + a] = p[1] - 1; // 0-based
      if (p[0] >= 1 && p[0] <= C.NX) { xin++; ymin = Math.min(ymin, p[1] - 1); ymax = Math.max(ymax, p[1] - 1); }
    }
    const pc = w.sky2pix(g.ra, g.dec);
    if (!pc || pc[0] < 1 || pc[0] > C.NX || pc[1] < 1 || pc[1] > C.NX || xin === 0) { f.skip = 'outside detector'; return f; }
    const y0 = Math.max(0, Math.floor(ymin) - 2), y1 = Math.min(C.NX - 1, Math.ceil(ymax) + 2);
    f.rows = [y0, y1];
    const strip = await SS.fits.imageRows(f.url, hdr.dataOff, y0, y1);
    const nrow = y1 - y0 + 1; const img = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      const fb = j / step, b = Math.floor(fb), tb = fb - b;
      for (let i = 0; i < N; i++) {
        const fa = i / step, a = Math.floor(fa), ta = fa - a;
        const k00 = b * nc + a, k10 = k00 + 1, k01 = k00 + nc, k11 = k01 + 1;
        const px = (1 - ta) * (1 - tb) * cx[k00] + ta * (1 - tb) * cx[k10] + (1 - ta) * tb * cx[k01] + ta * tb * cx[k11];
        const py = (1 - ta) * (1 - tb) * cy[k00] + ta * (1 - tb) * cy[k10] + (1 - ta) * tb * cy[k01] + ta * tb * cy[k11] - y0;
        const x0 = Math.floor(px), yy0 = Math.floor(py);
        if (!(x0 >= 0 && x0 < C.NX - 1 && yy0 >= 0 && yy0 < nrow - 1)) { img[j * N + i] = NaN; continue; }
        const fx = px - x0, fy = py - yy0, o = yy0 * C.NX + x0;
        img[j * N + i] = (1 - fx) * (1 - fy) * strip[o] + fx * (1 - fy) * strip[o + 1] + (1 - fx) * fy * strip[o + C.NX] + fx * fy * strip[o + C.NX + 1];
      }
    }
    const r = ST.robust(img);
    for (let k = 0; k < img.length; k++) img[k] -= r.med;
    f.img = img; f.bkg = r.med; f.sig = r.sig; f.pc = pc;
    f.wt = 1 / (r.sig * r.sig);
    return f;
  };

  /* ---------- stacks ---------- */
  /** inverse-variance weighted mean of frames with per-pixel outlier rejection
   *  (hot pixels, cosmic rays, single-frame asteroids are clipped against the median of the other frames) */
  SS.stack = function (frames, N) {
    const F = frames.filter(f => f.img); const n = F.length; const out = new Float32Array(N * N); out.nframes = n;
    if (!n) { out.fill(NaN); return out; }
    let wsum = 0; for (const f of F) wsum += f.wt;
    const vals = new Float64Array(n), idx = new Int32Array(n), tmp = new Float64Array(n);
    for (let k = 0; k < N * N; k++) {
      let m = 0;
      for (let i = 0; i < n; i++) { const v = F[i].img[k]; if (v === v) { vals[m] = v; idx[m] = i; m++; } }
      if (!m) { out[k] = NaN; continue; }
      let med = NaN;
      if (m >= 3) { for (let t = 0; t < m; t++) tmp[t] = vals[t]; const s = tmp.subarray(0, m).sort(); med = m & 1 ? s[m >> 1] : 0.5 * (s[m / 2 - 1] + s[m / 2]); }
      let s = 0, w = 0;
      for (let t = 0; t < m; t++) {
        const f = F[idx[t]], v = vals[t];
        if (med === med && Math.abs(v - med) > 5 * f.sig + 0.35 * Math.abs(med)) continue;
        s += v * f.wt; w += f.wt;
      }
      out[k] = w > 0.05 * wsum ? s / w : NaN;
    }
    return out;
  };

  /* ---------- photometry & centroids on grid images ---------- */
  /** aperture photometry: (x, y) grid pixel, radii in arcsec. returns mJy */
  SS.phot = function (img, g, x, y, rAp = 12, rIn = 24, rOut = 42) {
    const N = g.N, ra = rAp / g.scale, ri = rIn / g.scale, ro = rOut / g.scale;
    const ann = []; let sum = 0, nap = 0, bad = 0;
    const x0 = Math.max(0, Math.floor(x - ro)), x1 = Math.min(N - 1, Math.ceil(x + ro));
    const y0 = Math.max(0, Math.floor(y - ro)), y1 = Math.min(N - 1, Math.ceil(y + ro));
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const d = Math.hypot(i - x, j - y); const v = img[j * N + i];
      if (d <= ra) { if (v === v) { sum += v; nap++; } else bad++; }
      else if (d >= ri && d <= ro && v === v) ann.push(v);
    }
    if (nap < 3 || bad > nap * 0.3 || ann.length < 10) return null;
    ann.sort((a, b) => a - b);
    const b = ST.quantile(ann, 0.5); const mad = 1.4826 * ST.quantile(ann.map(v => Math.abs(v - b)).sort((p, q) => p - q), 0.5);
    const corr = 6.15 / g.scale; // resampling correlates noise
    const k = g.omega * 1e9; // MJy/sr * sr -> mJy
    const flux = (sum - b * nap) * k, err = mad * Math.sqrt(nap) * corr * k;
    return { flux, err, snr: flux / (err || 1e-30) };
  };

  /** ring ("wing") photometry for saturated stars: light between r1 and r2 arcsec, corrected for masked pixels */
  SS.photRing = function (img, g, x, y, r1, r2, b1, b2) {
    const N = g.N, s = g.scale; const ann = []; let sum = 0, nv = 0, nt = 0;
    const R = b2 / s;
    for (let j = Math.max(0, Math.floor(y - R)); j <= Math.min(N - 1, Math.ceil(y + R)); j++) for (let i = Math.max(0, Math.floor(x - R)); i <= Math.min(N - 1, Math.ceil(x + R)); i++) {
      const d = Math.hypot(i - x, j - y) * s; const v = img[j * N + i];
      if (d >= r1 && d <= r2) { nt++; if (v === v) { sum += v; nv++; } }
      else if (d >= b1 && d <= b2 && v === v) ann.push(v);
    }
    if (nv < 0.5 * nt || ann.length < 10) return null;
    ann.sort((a, b) => a - b); const b = ST.quantile(ann, 0.5); const mad = 1.4826 * ST.quantile(ann.map(v => Math.abs(v - b)).sort((p, q) => p - q), 0.5);
    const k = g.omega * 1e9 * nt / nv; const flux = (sum - b * nv) * k, err = mad * Math.sqrt(nv) * (6.15 / g.scale) * k;
    return { flux, err, snr: flux / (err || 1e-30), ring: true };
  };

  /** brightest pixel near (x, y) within r (grid px) */
  SS.peakNear = function (img, g, x, y, r) {
    const N = g.N; let best = -Infinity, bx = x, by = y;
    for (let j = Math.max(1, Math.floor(y - r)); j <= Math.min(N - 2, Math.ceil(y + r)); j++) for (let i = Math.max(1, Math.floor(x - r)); i <= Math.min(N - 2, Math.ceil(x + r)); i++) {
      if ((i - x) ** 2 + (j - y) ** 2 > r * r) continue;
      // 3x3 box-smoothed value to resist noise spikes
      let s = 0, n = 0; for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const v = img[(j + b) * N + i + a]; if (v === v) { s += v; n++; } }
      if (n > 5 && s / n > best) { best = s / n; bx = i; by = j; }
    }
    return { x: bx, y: by, v: best };
  };

  /** Gaussian-weighted iterative centroid. sigma in arcsec */
  SS.centroid = function (img, g, x, y, sigmaArcsec = 3.8, iters = 12) {
    const N = g.N, s = sigmaArcsec / g.scale, R = 3 * s;
    let cx = x, cy = y, ok = false;
    for (let it = 0; it < iters; it++) {
      let sw = 0, sx = 0, sy = 0;
      for (let j = Math.max(0, Math.floor(cy - R)); j <= Math.min(N - 1, Math.ceil(cy + R)); j++) for (let i = Math.max(0, Math.floor(cx - R)); i <= Math.min(N - 1, Math.ceil(cx + R)); i++) {
        const v = img[j * N + i]; if (!(v > 0)) continue;
        const wgt = v * Math.exp(-((i - cx) ** 2 + (j - cy) ** 2) / (2 * s * s));
        sw += wgt; sx += wgt * i; sy += wgt * j;
      }
      if (sw <= 0) return null;
      const nx = sx / sw, ny = sy / sw; const d = Math.hypot(nx - cx, ny - cy); cx = nx; cy = ny; ok = true;
      if (d < 0.002) break;
    }
    return ok ? { x: cx, y: cy } : null;
  };

  /** simple source finder on a stack: local maxima above nsig, sorted by brightness */
  SS.findSources = function (img, g, nsig = 6, max = 80) {
    const N = g.N; const r = ST.robust(img); const thr = r.med + nsig * r.sig; const out = [];
    const sep = Math.max(2, 9 / g.scale);
    for (let j = 3; j < N - 3; j++) for (let i = 3; i < N - 3; i++) {
      const v = img[j * N + i]; if (!(v > thr)) continue;
      let peak = true;
      for (let b = -2; b <= 2 && peak; b++) for (let a = -2; a <= 2; a++) { if (!a && !b) continue; const u = img[(j + b) * N + i + a]; if (u > v) { peak = false; break; } }
      if (peak) out.push({ x: i, y: j, v, snr: (v - r.med) / r.sig });
    }
    out.sort((a, b) => b.v - a.v);
    const kept = []; for (const s of out) { if (kept.every(k => Math.hypot(k.x - s.x, k.y - s.y) > sep)) kept.push(s); if (kept.length >= max) break; }
    return kept;
  };
})(window.SS);
