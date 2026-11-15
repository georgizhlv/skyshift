/* SkyShift — session state + science: spectra, light curves, astrometry, mover scan */
(function (SS) {
  'use strict';
  const ST = SS.stats, C = SS.C;

  class Session {
    constructor({ target, grid, epochs, frames, dets }) {
      Object.assign(this, { target, grid, epochs, frames, dets });
      this.cacheS = new Map(); this.wave = {}; this.loaded = [];
    }
    invalidate() { this.cacheS.clear(); this._reg = new Map(); }
    good(dets, epoch) { return this.loaded.filter(f => f.img && dets.includes(f.det) && (epoch == null || epoch < 0 || f.epoch === epoch)); }
    /** epoch < 0 → all epochs */
    stack(epoch, dets) {
      const k = epoch + '|' + dets.join('');
      if (!this.cacheS.has(k)) this.cacheS.set(k, SS.stack(this.good(dets, epoch), this.grid.N));
      return this.cacheS.get(k);
    }
    epochsWith(dets) { return this.epochs.filter(e => this.good(dets, e.i).length > 0); }
    /** where the target is at a given MJD (deg) */
    posAt(mjd, probe) {
      const t = probe || this.target;
      if (!t.pmra && !t.pmdec) return { ra: t.ra, dec: t.dec };
      return SS.propagate(t.ra, t.dec, t.pmra || 0, t.pmdec || 0, t.epoch || 2000, SS.mjdToYear(mjd));
    }
  }
  SS.Session = Session;

  /* ---------------- spectra ---------------- */
  const BANDS = [
    { lam: 1.4, name: 'H₂O' }, { lam: 1.65, name: 'CH₄' }, { lam: 1.9, name: 'H₂O' }, { lam: 2.2, name: 'CH₄' }, { lam: 2.3, name: 'CO' },
    { lam: 2.7, name: 'H₂O' }, { lam: 3.05, name: 'H₂O ice' }, { lam: 3.3, name: 'CH₄' }, { lam: 4.27, name: 'CO₂' }, { lam: 4.67, name: 'CO' }];
  SS.MOLECULES = BANDS;

  /** radius (arcsec) of the masked core if the source saturates SPHEREx, else 0 */
  SS.saturation = function (sess, probe) {
    const g = sess.grid, N = g.N; const F = sess.loaded.filter(f => f.img); const step = Math.max(1, Math.floor(F.length / 25)); const radii = [];
    for (let k = 0; k < F.length; k += step) {
      const f = F[k]; const p = sess.posAt(f.mjd, probe); const [x, y] = SS.skyToGrid(g, p.ra, p.dec);
      let nin = 0, nnan = 0, rmax = 0; const R = 60 / g.scale;
      for (let j = Math.max(0, Math.floor(y - R)); j <= Math.min(N - 1, Math.ceil(y + R)); j++) for (let i = Math.max(0, Math.floor(x - R)); i <= Math.min(N - 1, Math.ceil(x + R)); i++) {
        const d = Math.hypot(i - x, j - y) * g.scale; const v = f.img[j * N + i];
        if (d <= 12) { nin++; if (v !== v) nnan++; }
        if (v !== v && d <= 60) { // only count NaNs connected to the core region
          if (d < rmax + 9 || d <= 12) rmax = Math.max(rmax, d);
        }
      }
      radii.push(nin && nnan / nin > 0.15 ? rmax : 0);
    }
    radii.sort((a, b) => a - b);
    const sat = radii.filter(r => r > 0).length > radii.length * 0.4;
    return sat ? Math.min(60, ST.quantile(radii.filter(r => r > 0), 0.8)) : 0;
  };

  SS.spectrum = function (sess, probe) {
    const g = sess.grid; const pts = [];
    const sat = SS.saturation(sess, probe);
    const r1 = sat + 4, r2 = r1 + 18, b1 = r2 + 12, b2 = Math.min(r2 + 40, g.fov * 30 - 4);
    for (const f of sess.loaded) {
      if (!f.img) continue;
      const p = sess.posAt(f.mjd, probe);
      const [x, y] = SS.skyToGrid(g, p.ra, p.dec);
      if (x < 4 || y < 4 || x > g.N - 5 || y > g.N - 5) continue;
      const ph = sat ? (b2 > b1 + 6 ? SS.photRing(f.img, g, x, y, r1, r2, b1, b2) : null) : SS.phot(f.img, g, x, y); if (!ph) continue;
      const wt = sess.wave[f.det]; let lam = NaN, bw = NaN;
      if (wt) { const px = f.wcs.sky2pix(p.ra, p.dec); const w = SS.fits.waveAt(wt, px[0], px[1]); lam = w.lam; bw = w.bw; }
      pts.push({ lam, bw, flux: ph.flux, err: ph.err, snr: ph.snr, det: f.det, mjd: f.mjd, epoch: f.epoch, f });
    }
    // reject single-exposure spikes (cosmic rays / hot pixels in the aperture): compare with neighbours in wavelength
    for (let d = 1; d <= 6; d++) {
      const P = pts.filter(p => p.det === d && p.lam === p.lam).sort((a, b) => a.lam - b.lam);
      P.forEach((p, i) => { const w = P.slice(Math.max(0, i - 4), i + 5).filter(q => q !== p).map(q => q.flux); if (w.length < 3) return; const m = ST.median(w); const s = 1.4826 * ST.median(w.map(v => Math.abs(v - m))); if (Math.abs(p.flux - m) > 6 * Math.max(s, p.err) + 3 * Math.abs(m)) p.bad = true; });
    }
    for (let k = pts.length - 1; k >= 0; k--) if (pts[k].bad) pts.splice(k, 1);
    // 102 channels: 17 log-spaced bins per detector
    const bins = [];
    for (let d = 1; d <= 6; d++) {
      const D = C.DET[d]; const P = pts.filter(p => p.det === d && p.lam === p.lam);
      for (let b = 0; b < 17; b++) {
        const lo = D.lo * Math.pow(D.hi / D.lo, b / 17), hi = D.lo * Math.pow(D.hi / D.lo, (b + 1) / 17);
        let S = P.filter(p => p.lam >= lo && p.lam < hi);
        if (!S.length) continue;
        for (let it = 0; it < 2 && S.length > 3; it++) { const m = ST.median(S.map(p => p.flux)); const s = 1.4826 * ST.median(S.map(p => Math.abs(p.flux - m))) || Infinity; S = S.filter(p => Math.abs(p.flux - m) < 3.5 * s + 2 * p.err); }
        let sw = 0, sf = 0; S.forEach(p => { const w = 1 / Math.max(p.err, 1e-6) ** 2; sw += w; sf += w * p.flux; });
        bins.push({ lam: Math.sqrt(lo * hi), lo, hi, det: d, flux: sf / sw, err: 1 / Math.sqrt(sw), n: S.length });
      }
    }
    return { pts, bins, saturated: sat };
  };
  SS.modelAt = function (bins, lam) {
    if (!bins.length) return NaN;
    let k = bins.findIndex(b => b.lam >= lam);
    if (k <= 0) return bins[k === 0 ? 0 : bins.length - 1].flux;
    const a = bins[k - 1], b = bins[k]; const f = (lam - a.lam) / (b.lam - a.lam); return a.flux * (1 - f) + b.flux * f;
  };
  /** light curve: each frame's flux relative to the time-averaged spectrum at that wavelength */
  SS.lightcurve = function (spec) {
    return spec.pts.filter(p => p.lam === p.lam).map(p => { const m = SS.modelAt(spec.bins, p.lam); return { mjd: p.mjd, rel: p.flux / m, err: p.err / Math.abs(m), det: p.det, lam: p.lam, epoch: p.epoch }; }).filter(p => isFinite(p.rel) && p.err < 0.5);
  };

  /* ---------------- astrometry ---------------- */
  const FWHM = 7.5; // arcsec, typical SPHEREx PSF
  /** per-epoch registration offsets measured on field stars (grid px) */
  function registration(sess, dets, exclude) {
    const key = dets.join('') + '|' + (exclude ? exclude.map(v => v.toFixed(1)).join(',') : '');
    sess._reg = sess._reg || new Map();
    if (sess._reg.has(key)) return sess._reg.get(key);
    const g = sess.grid; const all = sess.stack(-1, dets);
    let refs = SS.findSources(all, g, 8, 40).filter(s => !exclude || Math.hypot(s.x - exclude[0], s.y - exclude[1]) * g.scale > 20);
    refs = refs.map(s => { const c = SS.centroid(all, g, s.x, s.y); return c ? Object.assign(s, { cx: c.x, cy: c.y }) : null; }).filter(Boolean);
    const out = {};
    for (const e of sess.epochsWith(dets)) {
      const st = sess.stack(e.i, dets); const dx = [], dy = [];
      for (const s of refs) { const c = SS.centroid(st, g, s.cx, s.cy); if (c && Math.hypot(c.x - s.cx, c.y - s.cy) * g.scale < 4) { dx.push(c.x - s.cx); dy.push(c.y - s.cy); } }
      out[e.i] = dx.length >= 3 ? { dx: ST.median(dx), dy: ST.median(dy), n: dx.length, scatter: 1.4826 * ST.median(dx.map(v => Math.abs(v - ST.median(dx)))) * g.scale } : { dx: 0, dy: 0, n: dx.length, scatter: 0.5 };
    }
    const r = { refs, out };
    sess._reg.set(key, r);
    return r;
  }
  SS.registration = registration;

  function fitMotion(pts, ra, dec, withPlx) {
    // pts: {t (yr), mjd, x, y (arcsec E,N), ex, ey}
    const tm = pts.reduce((s, p) => s + p.t, 0) / pts.length;
    const res = {};
    const lin = (key, ekey) => ST.lsq(pts.map(p => [1, p.t - tm]), pts.map(p => p[key]), pts.map(p => 1 / p[ekey] ** 2));
    const fx = lin('x', 'ex'), fy = lin('y', 'ey');
    if (fx && fy) {
      const sx = Math.sqrt(Math.max(1, fx.dof > 0 ? fx.chi2 / fx.dof : 1)), sy = Math.sqrt(Math.max(1, fy.dof > 0 ? fy.chi2 / fy.dof : 1));
      res.pmra = fx.b[1]; res.pmdec = fy.b[1]; res.epmra = Math.sqrt(fx.cov[1][1]) * sx; res.epmdec = Math.sqrt(fy.cov[1][1]) * sy;
      res.x0 = fx.b[0]; res.y0 = fy.b[0]; res.tm = tm;
    }
    if (withPlx && pts.length >= 3) {
      const X = [], Y = [], W = [];
      pts.forEach(p => { const [fa, fd] = SS.parallaxFactors(ra, dec, p.mjd); X.push([1, 0, p.t - tm, 0, fa]); Y.push(p.x); W.push(1 / p.ex ** 2); X.push([0, 1, 0, p.t - tm, fd]); Y.push(p.y); W.push(1 / p.ey ** 2); });
      const f = ST.lsq(X, Y, W);
      if (f) { const s = Math.sqrt(Math.max(1, f.dof > 0 ? f.chi2 / f.dof : 1)); res.plxFit = { pmra: f.b[2], pmdec: f.b[3], plx: f.b[4], eplx: Math.sqrt(f.cov[4][4]) * s, epm: Math.sqrt(f.cov[2][2]) * s }; }
    }
    return res;
  }

  /** stack with every frame shifted so a source moving like `probe` stays still ("shift and add") */
  SS.comovingStack = function (sess, dets, probe, refMjd) {
    const g = sess.grid, N = g.N; const t = probe || sess.target;
    const key = 'co|' + dets.join('') + '|' + (t.ra).toFixed(5) + (t.pmra || 0) + (t.pmdec || 0) + '|' + refMjd;
    if (sess.cacheS.has(key)) return sess.cacheS.get(key);
    const p0 = sess.posAt(refMjd, probe); const [x0, y0] = SS.skyToGrid(g, p0.ra, p0.dec);
    const sh = sess.good(dets, -1).map(f => {
      const p = sess.posAt(f.mjd, probe); const [x, y] = SS.skyToGrid(g, p.ra, p.dec); const dx = x - x0, dy = y - y0;
      const o = new Float32Array(N * N), im = f.img;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const sx = i + dx, sy = j + dy, a = Math.floor(sx), b = Math.floor(sy);
        if (a < 0 || b < 0 || a >= N - 1 || b >= N - 1) { o[j * N + i] = NaN; continue; }
        const fx = sx - a, fy = sy - b;
        o[j * N + i] = (1 - fx) * (1 - fy) * im[b * N + a] + fx * (1 - fy) * im[b * N + a + 1] + (1 - fx) * fy * im[(b + 1) * N + a] + fx * fy * im[(b + 1) * N + a + 1];
      }
      return { img: o, wt: f.wt, sig: f.sig };
    });
    const st = SS.stack(sh, N); st.ref = [x0, y0];
    sess.cacheS.set(key, st); return st;
  };

  /** detectors in which the (moving) probe dominates: shift-and-add beats a plain stack */
  SS.motionDets = function (sess, probe) {
    const g = sess.grid; const t = probe || sess.target; const moving = !!(t.pmra || t.pmdec);
    const ref = sess.epochs[Math.floor(sess.epochs.length / 2)].mjd; const p = sess.posAt(ref, probe); const [x, y] = SS.skyToGrid(g, p.ra, p.dec);
    const res = {};
    for (const d of [...(sess.loadedDets || new Set(sess.loaded.map(f => f.det)))]) {
      if (!sess.good([d], -1).length) continue;
      const st = sess.stack(-1, [d]); const a = SS.phot(st, g, x, y);
      const co = moving ? SS.comovingStack(sess, [d], probe, ref) : st; const b = SS.phot(co, g, co.ref ? co.ref[0] : x, co.ref ? co.ref[1] : y);
      res[d] = { st: a ? a.snr : 0, co: b ? b.snr : 0 };
    }
    const ds = Object.keys(res).map(Number);
    let pick = ds.filter(d => res[d].co > 5 && res[d].co >= 0.97 * res[d].st);
    if (!pick.length) { const best = ds.sort((a, b) => res[b].co - res[a].co)[0]; pick = best ? [best] : []; }
    return { dets: pick.sort(), snr: res };
  };

  /** joint PSF fit of the probe + fixed static neighbours across epochs (deblending) */
  function deblend(sess, dets, E, nbrs, guess) {
    const g = sess.grid, N = g.N, s = 3.4 / g.scale, R = 13 / g.scale;
    const G = (dx, dy) => Math.exp(-(dx * dx + dy * dy) / (2 * s * s));
    const ST = E.map(e => sess.stack(e.i, dets)); const sig = ST.map(st => SS.stats.robust(st).sig);
    const pos = guess.map(p => p.slice()); let amp = null;
    const pix = (e) => { const o = []; const [cx, cy] = guess[e]; for (let j = Math.max(0, Math.floor(cy - R)); j <= Math.min(N - 1, Math.ceil(cy + R)); j++) for (let i = Math.max(0, Math.floor(cx - R)); i <= Math.min(N - 1, Math.ceil(cx + R)); i++) { if ((i - cx) ** 2 + (j - cy) ** 2 > R * R) continue; const v = ST[e][j * N + i]; if (v === v) o.push([i, j, v]); } return o; };
    const P = E.map((_, e) => pix(e));
    const K = nbrs.length, nE = E.length;
    for (let it = 0; it < 5; it++) {
      // linear amplitudes: [At, An_1..An_K, b_1..b_E] shared across epochs (static stars do not change)
      const X = [], Y = [], W = [];
      P.forEach((px, e) => px.forEach(([i, j, v]) => { const row = new Array(1 + K + nE).fill(0); row[0] = G(i - pos[e][0], j - pos[e][1]); nbrs.forEach((n, k) => row[1 + k] = G(i - n.x, j - n.y)); row[1 + K + e] = 1; X.push(row); Y.push(v); W.push(1 / sig[e] ** 2); }));
      const f = SS.stats.lsq(X, Y, W); if (!f) return null; amp = f.b;
      if (it === 4) break;
      // position search per epoch with amplitudes fixed
      const span = it === 0 ? 7 / g.scale : it === 1 ? 2 / g.scale : 0.6 / g.scale, step = span / 14;
      P.forEach((px, e) => {
        const r = px.map(([i, j, v]) => v - amp[1 + K + e] - nbrs.reduce((q, n, k) => q + amp[1 + k] * G(i - n.x, j - n.y), 0));
        let best = [Infinity, pos[e][0], pos[e][1]]; const [cx, cy] = pos[e];
        for (let yy = cy - span; yy <= cy + span + 1e-9; yy += step) for (let xx = cx - span; xx <= cx + span + 1e-9; xx += step) {
          let c = 0; for (let k = 0; k < px.length; k++) { const d = r[k] - amp[0] * G(px[k][0] - xx, px[k][1] - yy); c += d * d; }
          if (c < best[0]) best = [c, xx, yy];
        }
        pos[e] = [best[1], best[2]];
      });
    }
    return E.map((e, k) => { const snr = amp[0] * Math.sqrt(P[k].reduce((q, [i, j]) => q + G(i - pos[k][0], j - pos[k][1]) ** 2, 0)) / sig[k]; return { x: pos[k][0], y: pos[k][1], snr: Math.abs(snr) }; });
  }

  /** measure the probe/target position in each epoch and fit proper motion (arcsec/yr) */
  SS.motion = function (sess, _dets, probe) {
    const g = sess.grid; const t = probe || sess.target;
    const md = SS.motionDets(sess, probe); const dets = md.dets;
    const E = sess.epochsWith(dets).filter(e => sess.good(dets, e.i).length >= 2); if (E.length < 2) return { error: 'Need at least two epochs with data.' };
    const p0 = sess.posAt(E[0].mjd, probe); const [gx0, gy0] = SS.skyToGrid(g, p0.ra, p0.dec);
    const reg = registration(sess, dets, [gx0, gy0]);
    const moving = !!(t.pmra || t.pmdec);
    const track = E.map(e => { const p = sess.posAt(e.mjd, probe); return SS.skyToGrid(g, p.ra, p.dec); });
    const mean = [track.reduce((q, p) => q + p[0], 0) / track.length, track.reduce((q, p) => q + p[1], 0) / track.length];
    // static neighbours: measured where the probe is faint (other detectors) or, failing that, in the same ones
    const other = [...(sess.loadedDets || [])].filter(d => !dets.includes(d) && sess.good([d], -1).length);
    const nst = sess.stack(-1, other.length ? other : dets);
    const nbrs = SS.findSources(nst, g, 6, 40).map(s => SS.centroid(nst, g, s.x, s.y)).filter(Boolean)
      .filter(c => Math.hypot(c.x - mean[0], c.y - mean[1]) * g.scale > (other.length ? 2 : 4) && track.some(p => Math.hypot(c.x - p[0], c.y - p[1]) * g.scale < 16))
      .filter(c => { if (!other.length) return true; const a = SS.phot(sess.stack(-1, dets), g, c.x, c.y); return a && a.snr > 3; });
    const pts = []; let method = 'centroid';
    let fits = null;
    if (nbrs.length && nbrs.length <= 4) {
      const guess = E.map((e, k) => { if (moving) return track[k].slice(); const pk = SS.peakNear(sess.stack(e.i, dets), g, track[k][0], track[k][1], 15 / g.scale); return [pk.x, pk.y]; });
      fits = deblend(sess, dets, E, nbrs, guess); if (fits) method = `joint PSF fit with ${nbrs.length} neighbour${nbrs.length > 1 ? 's' : ''}`;
    }
    E.forEach((e, k) => {
      let c, snr;
      if (fits) { c = fits[k]; snr = fits[k].snr; }
      else {
        const st = sess.stack(e.i, dets);
        const pk = SS.peakNear(st, g, track[k][0], track[k][1], (moving ? 9 : 15) / g.scale);
        c = SS.centroid(st, g, pk.x, pk.y); if (!c) return;
        const ph = SS.phot(st, g, c.x, c.y); if (!ph) return; snr = ph.snr;
      }
      if (!(snr >= 3)) return;
      const R = reg.out[e.i] || { dx: 0, dy: 0, scatter: 0.5, n: 0 };
      const x = c.x - R.dx, y = c.y - R.dy;
      const sigC = 0.6 * FWHM / snr; const sigR = R.n >= 3 ? R.scatter / Math.sqrt(R.n) : 0.5;
      const err = Math.max(0.05, Math.hypot(sigC, sigR));
      pts.push({ epoch: e.i, mjd: e.mjd, t: SS.mjdToYear(e.mjd), gx: x, gy: y, x: -(x - g.c) * g.scale, y: -(y - g.c) * g.scale, ex: err, ey: err, snr, nref: R.n });
    });
    if (pts.length < 2) return { error: 'The source is too faint in these detectors to centroid in two epochs.' };
    const fit = fitMotion(pts, t.ra, t.dec, pts.length >= 3);
    const out = { pts, fit, reg, dets, method, nbrs, detSnr: md.snr };
    if (t.pmra || t.pmdec) out.known = { pmra: t.pmra / 1000, pmdec: t.pmdec / 1000, plx: (t.plx || 0) / 1000 };
    return out;
  };

  /** scan every detected source in the field for motion between epochs */
  SS.moverScan = function (sess, dets) {
    const g = sess.grid; const E = sess.epochsWith(dets); if (E.length < 2) return { error: 'Need at least two epochs.' };
    const reg = registration(sess, dets, null); const all = sess.stack(-1, dets);
    const srcs = SS.findSources(all, g, 7, 60); const out = [];
    for (const s of srcs) {
      const c0 = SS.centroid(all, g, s.x, s.y); if (!c0) continue;
      // skip saturated stars (masked cores make centroids jump)
      let nan = 0; const r = 15 / g.scale; for (let j = Math.floor(c0.y - r); j <= Math.ceil(c0.y + r); j++) for (let i = Math.floor(c0.x - r); i <= Math.ceil(c0.x + r); i++) { if (i < 0 || j < 0 || i >= g.N || j >= g.N) continue; if (Math.hypot(i - c0.x, j - c0.y) <= r && all[j * g.N + i] !== all[j * g.N + i]) nan++; }
      if (nan > 2) continue;
      const pts = [];
      for (const e of E) {
        const st = sess.stack(e.i, dets);
        const pk = SS.peakNear(st, g, c0.x, c0.y, 12 / g.scale);
        const c = SS.centroid(st, g, pk.x, pk.y); if (!c) continue;
        const ph = SS.phot(st, g, c.x, c.y); if (!ph || ph.snr < 4) continue;
        const R = reg.out[e.i] || { dx: 0, dy: 0, scatter: 0.5, n: 0 };
        const err = Math.max(0.06, Math.hypot(0.6 * FWHM / ph.snr, R.n >= 3 ? R.scatter / Math.sqrt(R.n) : 0.5));
        pts.push({ mjd: e.mjd, t: SS.mjdToYear(e.mjd), x: -(c.x - R.dx - g.c) * g.scale, y: -(c.y - R.dy - g.c) * g.scale, ex: err, ey: err, gx: c.x - R.dx, gy: c.y - R.dy });
      }
      if (pts.length < 2) continue;
      const f = fitMotion(pts, sess.target.ra, sess.target.dec, false);
      if (f.pmra == null) continue;
      const pm = Math.hypot(f.pmra, f.pmdec), epm = Math.hypot(f.epmra * f.pmra, f.epmdec * f.pmdec) / (pm || 1);
      const [ra, dec] = SS.gridToSky(g, c0.x, c0.y);
      out.push({ x: c0.x, y: c0.y, ra, dec, snr: s.snr, pm, epm, sig: pm / (epm || 1), pmra: f.pmra, pmdec: f.pmdec, pts });
    }
    out.sort((a, b) => b.sig - a.sig);
    return { sources: out, reg };
  };
})(window.SS);
