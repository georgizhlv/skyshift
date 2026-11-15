/* SkyShift — core utilities, constants, caching, networking */
window.SS = window.SS || {};
(function (SS) {
  'use strict';
  const cfg = window.SKYSHIFT_CONFIG || {};

  const C = SS.C = {
    S3: 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/',
    IRSA_TAP: 'https://irsa.ipac.caltech.edu/TAP/sync',
    PROXY: cfg.proxy || '',            // e.g. https://skyshift-proxy.<you>.workers.dev
    CACHE_DIR: cfg.cacheDir || 'data/cache/',
    NX: 2040,
    ROWBYTES: 2040 * 4,
    IMG_HDR_OFF: 2880,
    DET: [null,
      { n: 1, lo: 0.75, hi: 1.09, R: 39, c: '#7d7cff', band: 'SWIR' },
      { n: 2, lo: 1.10, hi: 1.62, R: 41, c: '#4fa3ff', band: 'SWIR' },
      { n: 3, lo: 1.63, hi: 2.41, R: 41, c: '#3fd0c9', band: 'SWIR' },
      { n: 4, lo: 2.42, hi: 3.82, R: 35, c: '#9be15d', band: 'MWIR' },
      { n: 5, lo: 3.83, hi: 4.41, R: 112, c: '#ffb347', band: 'MWIR' },
      { n: 6, lo: 4.42, hi: 5.00, R: 128, c: '#ff5e5b', band: 'MWIR' }],
    FLAG_NAMES: { 0: 'TRANSIENT', 1: 'OVERFLOW', 2: 'SUR_ERROR', 6: 'NONFUNC', 7: 'DICHROIC', 9: 'MISSING_DATA', 10: 'HOT', 11: 'COLD', 12: 'FULLSAMPLE', 14: 'PHANMISS', 15: 'NONLINEAR', 17: 'PERSIST', 19: 'OUTLIER', 20: 'CROSSTALK', 21: 'SOURCE', 22: 'GHOST', 23: 'GHOST_FPA', 24: 'GHOST_EXT', 25: 'STREAK', 26: 'BLOOM', 27: 'SNOWBALL', 28: 'HALO' },
    // flags that mean "do not trust this pixel" (SOURCE/FULLSAMPLE are informational)
    BAD_MASK: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 6) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 15) | (1 << 17) | (1 << 19) | (1 << 25) | (1 << 26) | (1 << 27) | (1 << 28),
  };

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  SS.D2R = D2R; SS.R2D = R2D;

  /* ---------------- coordinates & time ---------------- */
  SS.parseCoords = function (s) {
    if (!s) return null;
    s = s.trim().replace(/[−–—]/g, '-').replace(/,/g, ' ');
    // pure decimal pair
    let m = s.match(/^([+-]?\d+(?:\.\d*)?)\s*(?:d|°)?\s+([+-]?\d+(?:\.\d*)?)\s*(?:d|°)?$/);
    if (m) {
      const ra = +m[1], dec = +m[2];
      if (ra >= 0 && ra < 360 && Math.abs(dec) <= 90) return { ra, dec };
    }
    // sexagesimal: h m s  d m s (separators : space h m s d ' ")
    const t = s.replace(/[hmsd:°'"′″]/gi, ' ').replace(/\s+/g, ' ').trim();
    m = t.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}(?:\.\d*)?) ([+-]?\d{1,2}) (\d{1,2}) (\d{1,2}(?:\.\d*)?)$/);
    if (m) {
      const ra = 15 * (+m[1] + m[2] / 60 + m[3] / 3600);
      const sgn = /^-/.test(m[4]) ? -1 : 1;
      const dec = sgn * (Math.abs(+m[4]) + m[5] / 60 + m[6] / 3600);
      if (ra < 360 && Math.abs(dec) <= 90) return { ra, dec };
    }
    return null;
  };
  const pad = (n, w, d) => { const s = d != null ? n.toFixed(d) : String(Math.floor(n)); const [i] = s.split('.'); return '0'.repeat(Math.max(0, w - i.length)) + s; };
  SS.fmtRA = function (ra) { let h = ((ra % 360) + 360) % 360 / 15; const H = Math.floor(h); let mm = (h - H) * 60; const M = Math.floor(mm); let ss = (mm - M) * 60; if (ss >= 59.995) { ss = 0; } return `${pad(H, 2)}h${pad(M, 2)}m${pad(ss, 2, 2)}s`; };
  SS.fmtDec = function (d) { const sg = d < 0 ? '−' : '+'; d = Math.abs(d); const D = Math.floor(d); const mm = (d - D) * 60; const M = Math.floor(mm); const ss = (mm - M) * 60; return `${sg}${pad(D, 2)}°${pad(M, 2)}′${pad(ss, 2, 1)}″`; };
  SS.mjdToDate = (mjd) => new Date((mjd - 40587) * 86400000);
  SS.mjdToYear = (mjd) => 2000 + (mjd - 51544.5) / 365.25;
  SS.yearToMjd = (y) => (y - 2000) * 365.25 + 51544.5;
  SS.fmtDate = (mjd) => SS.mjdToDate(mjd).toISOString().slice(0, 10);
  SS.angsep = function (ra1, d1, ra2, d2) {
    const a = Math.sin((d2 - d1) * D2R / 2) ** 2 + Math.cos(d1 * D2R) * Math.cos(d2 * D2R) * Math.sin((ra2 - ra1) * D2R / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(a))) * R2D;
  };
  /** propagate a position with proper motion (mas/yr) from epoch y0 to y1 (simple linear, fine for < few arcmin) */
  SS.propagate = function (ra, dec, pmra, pmdec, y0, y1) {
    const dt = y1 - y0;
    return { ra: ra + (pmra * dt / 3.6e6) / Math.cos(dec * D2R), dec: dec + pmdec * dt / 3.6e6 };
  };

  /* Sun geocentric rectangular coords (AU, equatorial J2000) — low precision (~0.01°), for parallax factors */
  SS.sunXYZ = function (mjd) {
    const n = mjd - 51544.5;
    const L = (280.460 + 0.9856474 * n) * D2R;
    const g = (357.528 + 0.9856003 * n) * D2R;
    const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
    const R = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
    const eps = 23.439 * D2R;
    return [R * Math.cos(lam), R * Math.cos(eps) * Math.sin(lam), R * Math.sin(eps) * Math.sin(lam)];
  };
  /** parallax factors: offsets (arcsec) per arcsec of parallax, in (ΔRA·cosδ, ΔDec) */
  SS.parallaxFactors = function (ra, dec, mjd) {
    const [X, Y, Z] = SS.sunXYZ(mjd); const a = ra * D2R, d = dec * D2R;
    return [X * Math.sin(a) - Y * Math.cos(a), X * Math.cos(a) * Math.sin(d) + Y * Math.sin(a) * Math.sin(d) - Z * Math.cos(d)];
  };

  /* ---------------- statistics ---------------- */
  SS.stats = {
    finite(arr) { const o = []; for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v === v && isFinite(v)) o.push(v); } return o; },
    quantile(sorted, q) { if (!sorted.length) return NaN; const p = (sorted.length - 1) * q; const i = Math.floor(p); const f = p - i; return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i]; },
    median(arr) { const a = SS.stats.finite(arr).sort((x, y) => x - y); return SS.stats.quantile(a, 0.5); },
    /** robust background & sigma from a (sub)sample */
    robust(arr, step) {
      step = step || Math.max(1, Math.floor(arr.length / 20000));
      const a = []; for (let i = 0; i < arr.length; i += step) { const v = arr[i]; if (v === v) a.push(v); }
      a.sort((x, y) => x - y);
      if (a.length < 5) return { med: 0, sig: 1, n: a.length };
      const med = SS.stats.quantile(a, 0.5);
      const dev = a.map(v => Math.abs(v - med)).sort((x, y) => x - y);
      const sig = 1.4826 * SS.stats.quantile(dev, 0.5) || 1e-6;
      return { med, sig, n: a.length };
    },
    /** weighted linear least squares: y = X·b, returns {b, cov, chi2} */
    lsq(X, y, w) {
      const n = y.length, k = X[0].length; const A = Array.from({ length: k }, () => new Float64Array(k)); const r = new Float64Array(k);
      for (let i = 0; i < n; i++) { const wi = w ? w[i] : 1; for (let a = 0; a < k; a++) { r[a] += wi * X[i][a] * y[i]; for (let b = 0; b < k; b++) A[a][b] += wi * X[i][a] * X[i][b]; } }
      const inv = SS.stats.invert(A); if (!inv) return null;
      const b = new Float64Array(k); for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) b[a] += inv[a][c] * r[c];
      let chi2 = 0; for (let i = 0; i < n; i++) { let m = 0; for (let a = 0; a < k; a++) m += X[i][a] * b[a]; chi2 += (w ? w[i] : 1) * (y[i] - m) ** 2; }
      return { b, cov: inv, chi2, dof: n - k };
    },
    invert(M) {
      const n = M.length; const A = M.map((row, i) => { const r = Array.from(row); for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0); return r; });
      for (let c = 0; c < n; c++) {
        let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        if (Math.abs(A[p][c]) < 1e-300) return null;
        [A[c], A[p]] = [A[p], A[c]];
        const d = A[c][c]; for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
        for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; if (f) for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j]; }
      }
      return A.map(r => r.slice(n));
    },
  };

  /* ---------------- IndexedDB key-value cache ---------------- */
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      try {
        const rq = indexedDB.open('skyshift', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  SS.cache = {
    enabled: true,
    async get(k) {
      if (!this.enabled) return undefined;
      const d = await db(); if (!d) return undefined;
      return new Promise((res) => { try { const r = d.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); } catch (e) { res(undefined); } });
    },
    async set(k, v) {
      if (!this.enabled) return;
      const d = await db(); if (!d) return;
      return new Promise((res) => { try { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); } catch (e) { res(); } });
    },
    async clear() { const d = await db(); if (!d) return; return new Promise((res) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').clear(); t.oncomplete = () => res(); t.onerror = () => res(); }); },
  };

  /* ---------------- networking ---------------- */
  SS.net = { bytes: 0, requests: 0 };
  SS.sleep = (ms) => new Promise(r => setTimeout(r, ms));
  SS.fetchRetry = async function (url, opts = {}, tries = 4, timeoutMs = 60000) {
    let lastErr;
    for (let k = 0; k < tries; k++) {
      const ac = new AbortController(); const to = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
        clearTimeout(to);
        if (r.ok) return r;
        lastErr = new Error('HTTP ' + r.status);
        if (r.status < 500 && r.status !== 429) throw lastErr;
      } catch (e) { clearTimeout(to); lastErr = e; if (/HTTP 4/.test(e.message) && !/429/.test(e.message)) throw e; }
      await SS.sleep(600 * Math.pow(2, k) + Math.random() * 300);
    }
    throw lastErr;
  };
  /** fetch bytes [a, b) */
  SS.range = async function (url, a, b) {
    const r = await SS.fetchRetry(url, { headers: { Range: `bytes=${a}-${b - 1}` } });
    const buf = await r.arrayBuffer();
    SS.net.bytes += buf.byteLength; SS.net.requests++;
    return buf;
  };
  /** run async jobs with limited concurrency */
  SS.pool = async function (items, n, fn, signal) {
    let i = 0; const out = new Array(items.length);
    async function worker() { while (i < items.length) { if (signal && signal.aborted) return; const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e }; } } }
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  };

  /* small event bus */
  const L = {};
  SS.on = (e, f) => (L[e] = L[e] || []).push(f);
  SS.emit = (e, d) => (L[e] || []).forEach(f => { try { f(d); } catch (x) { console.error(x); } });
})(window.SS);
