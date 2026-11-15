/* SkyShift — minimal FITS reader over HTTP range requests + RICE_1 decoder + TAN-SIP WCS */
(function (SS) {
  'use strict';
  const C = SS.C, D2R = SS.D2R, R2D = SS.R2D;
  const dec = new TextDecoder('latin1');

  function parseHeader(u8) {
    const t = dec.decode(u8); const H = {}; let end = -1;
    for (let i = 0; i + 80 <= t.length; i += 80) {
      const c = t.slice(i, i + 80);
      const k = c.slice(0, 8).trim();
      if (k === 'END') { end = i + 80; break; }
      if (c[8] === '=' && c[9] === ' ') {
        let v = c.slice(10).trim();
        if (v[0] === "'") { const j = v.indexOf("'", 1); v = v.slice(1, j < 0 ? undefined : j).trim(); }
        else { v = v.split('/')[0].trim(); if (v === 'T') v = true; else if (v === 'F') v = false; else if (v !== '' && !isNaN(+v)) v = +v; }
        H[k] = v;
      }
    }
    return { H, end, hlen: end < 0 ? -1 : Math.ceil(end / 2880) * 2880 };
  }

  /** read an extension header starting at byte `off` */
  async function readHeader(url, off, guess = 28800) {
    let n = guess;
    for (let k = 0; k < 5; k++) {
      const buf = await SS.range(url, off, off + n);
      const p = parseHeader(new Uint8Array(buf));
      if (p.end >= 0) return p;
      n *= 2;
    }
    throw new Error('FITS header END not found');
  }

  const KEEP = /^(A_|B_|AP_|BP_|PC\d_\d|CRPIX|CRVAL|CDELT|CTYPE|MJD-|DATE-AVG|DETECTOR|XPOSURE|PSF_FWHM|BUNIT|NAXIS|LONPOLE|OBSID|EXPIDN|SPS_E)/;
  /** IMAGE header of a SPHEREx L2 file (cached in IndexedDB as a compact key subset) */
  async function imageHeader(url) {
    const ck = 'hdr:' + url;
    const c = await SS.cache.get(ck);
    if (c) return c;
    const p = await readHeader(url, C.IMG_HDR_OFF);
    const H = {}; for (const k in p.H) if (KEEP.test(k)) H[k] = p.H[k];
    const o = { H, dataOff: C.IMG_HDR_OFF + p.hlen };
    SS.cache.set(ck, o);
    return o;
  }

  /** float32 big-endian rows y0..y1 (0-based, inclusive), full width */
  async function imageRows(url, dataOff, y0, y1) {
    const ck = `rows:${url}:${y0}:${y1}`;
    let buf = await SS.cache.get(ck);
    if (!buf) {
      buf = await SS.range(url, dataOff + y0 * C.ROWBYTES, dataOff + (y1 + 1) * C.ROWBYTES);
      SS.cache.set(ck, buf);
    }
    const dv = new DataView(buf); const n = buf.byteLength >> 2; const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, false);
    return out;
  }

  /* walk the extension chain to locate FLAGS / WCS-WAVE (headers only) */
  async function extMap(url) {
    const ck = 'ext2:' + url;
    const c = await SS.cache.get(ck); if (c) return c;
    const map = {}; let off = C.IMG_HDR_OFF;
    for (let i = 0; i < 6; i++) {
      const p = await readHeader(url, off, i === 0 ? 28800 : 23040);
      const H = p.H; let ds = Math.abs(H.BITPIX) / 8; for (let a = 1; a <= H.NAXIS; a++) ds *= H['NAXIS' + a]; if (!H.NAXIS) ds = 0; ds += (H.PCOUNT || 0);
      map[H.EXTNAME] = { hdrOff: off, dataOff: off + p.hlen, H };
      off += p.hlen + Math.ceil(ds / 2880) * 2880;
    }
    // keep only small header subsets
    for (const k in map) { const H = map[k].H; map[k].H = { NAXIS1: H.NAXIS1, NAXIS2: H.NAXIS2, PCOUNT: H.PCOUNT, ZCMPTYPE: H.ZCMPTYPE, TFORM1: H.TFORM1, TFORM2: H.TFORM2, TFORM3: H.TFORM3 }; }
    SS.cache.set(ck, map);
    return map;
  }

  /** wavelength lookup table (11x11 bilinear control grid) for one file */
  async function waveTable(url) {
    const ck = 'wave2:' + url;
    const c = await SS.cache.get(ck); if (c) return c;
    const map = await extMap(url);
    const e = map['WCS-WAVE'];
    const nX = parseInt(e.H.TFORM1) || 11, nY = parseInt(e.H.TFORM2) || 11, nV = parseInt(e.H.TFORM3) || 2 * nX * nY;
    const buf = await SS.range(url, e.dataOff, e.dataOff + (e.H.NAXIS1 || 4 * (nX + nY + nV)));
    const dv = new DataView(buf);
    const X = [], Y = [], V = [];
    for (let i = 0; i < nX; i++) X.push(dv.getInt32(i * 4, false));
    for (let i = 0; i < nY; i++) Y.push(dv.getInt32((nX + i) * 4, false));
    for (let i = 0; i < nV; i++) V.push(dv.getFloat32((nX + nY + i) * 4, false));
    const t = { X, Y, V };
    SS.cache.set(ck, t);
    return t;
  }
  /** wavelength & bandwidth (µm) at 1-based FITS pixel (x,y) */
  function waveAt(t, x, y) {
    const seg = (arr, v) => { let i = 0; while (i < arr.length - 2 && v > arr[i + 1]) i++; const f = (v - arr[i]) / (arr[i + 1] - arr[i]); return [i, Math.max(0, Math.min(1, f))]; };
    const [i, fx] = seg(t.X, x), [j, fy] = seg(t.Y, y);
    const nx = t.X.length; const val = (ii, jj, k) => t.V[(jj * nx + ii) * 2 + k];
    const out = [0, 0];
    for (let k = 0; k < 2; k++) out[k] = (1 - fx) * (1 - fy) * val(i, j, k) + fx * (1 - fy) * val(i + 1, j, k) + (1 - fx) * fy * val(i, j + 1, k) + fx * fy * val(i + 1, j + 1, k);
    return { lam: out[0], bw: out[1] };
  }

  /* ---------------- RICE_1 decompression (port of cfitsio fits_rdecomp, 32-bit) ---------------- */
  const NZC = new Uint8Array(256); for (let i = 1; i < 256; i++) NZC[i] = 32 - Math.clz32(i);
  function riceDecode32(c, nx, nblock) {
    const out = new Int32Array(nx); const fsbits = 5, fsmax = 25, bbits = 32;
    let ci = 0; let lastpix = (c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]; ci = 4;
    let b = c[ci++], nbits = 8;
    for (let i = 0; i < nx;) {
      nbits -= fsbits;
      while (nbits < 0) { b = (b << 8) | c[ci++]; nbits += 8; }
      const fs = (b >>> nbits) - 1;
      b &= (1 << nbits) - 1;
      const imax = Math.min(i + nblock, nx);
      if (fs < 0) { for (; i < imax; i++) out[i] = lastpix; }
      else if (fs === fsmax) {
        for (; i < imax; i++) {
          let k = bbits - nbits; let diff = k >= 32 ? 0 : (b << k) >>> 0;
          for (k -= 8; k >= 0; k -= 8) { b = c[ci++]; diff = (diff | (b << k)) >>> 0; }
          if (nbits > 0) { b = c[ci++]; diff = (diff | (b >>> (-k))) >>> 0; b &= (1 << nbits) - 1; } else b = 0;
          const d = (diff & 1) === 0 ? (diff >>> 1) : ~(diff >>> 1);
          out[i] = (d + lastpix) | 0; lastpix = out[i];
        }
      } else {
        for (; i < imax; i++) {
          while (b === 0) { nbits += 8; b = c[ci++]; }
          const nzero = nbits - NZC[b];
          nbits -= nzero + 1;
          b ^= 1 << nbits;
          nbits -= fs;
          while (nbits < 0) { b = (b << 8) | c[ci++]; nbits += 8; }
          const diff = ((nzero << fs) | (b >>> nbits)) >>> 0;
          b &= (1 << nbits) - 1;
          const d = (diff & 1) === 0 ? (diff >>> 1) : ~(diff >>> 1);
          out[i] = (d + lastpix) | 0; lastpix = out[i];
        }
      }
    }
    return out;
  }

  /** FLAGS bitmask rows y0..y1 (0-based) as Int32Array (rows*2040) */
  async function flagRows(url, y0, y1) {
    const ck = `flags:${url}:${y0}:${y1}`;
    const c = await SS.cache.get(ck); if (c) return new Int32Array(c);
    const map = await extMap(url);
    const e = map.FLAGS; const nrow = e.H.NAXIS2, rowlen = e.H.NAXIS1; // 8 bytes: (count, offset)
    const desc = new DataView(await SS.range(url, e.dataOff + y0 * rowlen, e.dataOff + (y1 + 1) * rowlen));
    const heapOff = e.dataOff + nrow * rowlen;
    const ds = []; let lo = Infinity, hi = 0;
    for (let r = 0; r <= y1 - y0; r++) { const n = desc.getInt32(r * 8, false), o = desc.getInt32(r * 8 + 4, false); ds.push([n, o]); lo = Math.min(lo, o); hi = Math.max(hi, o + n); }
    const heap = new Uint8Array(await SS.range(url, heapOff + lo, heapOff + hi));
    const out = new Int32Array((y1 - y0 + 1) * C.NX);
    ds.forEach(([n, o], r) => { out.set(riceDecode32(heap.subarray(o - lo, o - lo + n), C.NX, 32), r * C.NX); });
    SS.cache.set(ck, out.buffer);
    return out;
  }

  /* ---------------- TAN-SIP WCS ---------------- */
  class WCS {
    constructor(H) {
      this.crpix = [H.CRPIX1, H.CRPIX2]; this.ra0 = H.CRVAL1; this.dec0 = H.CRVAL2;
      const c1 = H.CDELT1 || 1, c2 = H.CDELT2 || 1;
      this.M = [[c1 * (H.PC1_1 ?? 1), c1 * (H.PC1_2 ?? 0)], [c2 * (H.PC2_1 ?? 0), c2 * (H.PC2_2 ?? 1)]];
      const det = this.M[0][0] * this.M[1][1] - this.M[0][1] * this.M[1][0];
      this.Mi = [[this.M[1][1] / det, -this.M[0][1] / det], [-this.M[1][0] / det, this.M[0][0] / det]];
      this.pixArea = Math.abs(det); // deg^2
      this.scale = Math.sqrt(this.pixArea) * 3600; // arcsec/px
      const terms = (pfx) => { const o = []; const ord = H[pfx + 'ORDER'] || 0; for (let p = 0; p <= ord; p++) for (let q = 0; q <= ord - p; q++) { const v = H[`${pfx}${p}_${q}`]; if (v) o.push([p, q, v]); } return o; };
      this.A = terms('A_'); this.B = terms('B_'); this.AP = terms('AP_'); this.BP = terms('BP_');
      this.sd0 = Math.sin(this.dec0 * D2R); this.cd0 = Math.cos(this.dec0 * D2R);
    }
    static poly(T, u, v) { let s = 0; for (let k = 0; k < T.length; k++) { const t = T[k]; s += t[2] * Math.pow(u, t[0]) * Math.pow(v, t[1]); } return s; }
    static dpoly(T, u, v) { let du = 0, dv = 0; for (let k = 0; k < T.length; k++) { const [p, q, c] = T[k]; if (p) du += c * p * Math.pow(u, p - 1) * Math.pow(v, q); if (q) dv += c * q * Math.pow(u, p) * Math.pow(v, q - 1); } return [du, dv]; }
    /** 1-based FITS pixel -> [ra, dec] deg */
    pix2sky(x, y) {
      const u = x - this.crpix[0], v = y - this.crpix[1];
      const U = u + WCS.poly(this.A, u, v), V = v + WCS.poly(this.B, u, v);
      const xi = (this.M[0][0] * U + this.M[0][1] * V) * D2R, eta = (this.M[1][0] * U + this.M[1][1] * V) * D2R;
      const den = this.cd0 - eta * this.sd0;
      let ra = this.ra0 + Math.atan2(xi, den) * R2D;
      const dec = Math.atan2(this.sd0 + eta * this.cd0, Math.hypot(xi, den)) * R2D;
      ra = ((ra % 360) + 360) % 360;
      return [ra, dec];
    }
    /** [ra, dec] deg -> 1-based FITS pixel [x, y] (null if behind tangent plane) */
    sky2pix(ra, dec) {
      const a = (ra - this.ra0) * D2R, d = dec * D2R;
      const sd = Math.sin(d), cdd = Math.cos(d), ca = Math.cos(a);
      const cosc = this.sd0 * sd + this.cd0 * cdd * ca;
      if (cosc <= 0) return null;
      const xi = cdd * Math.sin(a) / cosc * R2D, eta = (this.cd0 * sd - this.sd0 * cdd * ca) / cosc * R2D;
      const U = this.Mi[0][0] * xi + this.Mi[0][1] * eta, V = this.Mi[1][0] * xi + this.Mi[1][1] * eta;
      let u = U + WCS.poly(this.AP, U, V), v = V + WCS.poly(this.BP, U, V);
      for (let it = 0; it < 4; it++) { // Newton refine against forward SIP
        const fu = u + WCS.poly(this.A, u, v) - U, fv = v + WCS.poly(this.B, u, v) - V;
        if (Math.abs(fu) < 1e-6 && Math.abs(fv) < 1e-6) break;
        const [au, av] = WCS.dpoly(this.A, u, v), [bu, bv] = WCS.dpoly(this.B, u, v);
        const j11 = 1 + au, j12 = av, j21 = bu, j22 = 1 + bv; const dt = j11 * j22 - j12 * j21;
        u -= (j22 * fu - j12 * fv) / dt; v -= (-j21 * fu + j11 * fv) / dt;
      }
      return [u + this.crpix[0], v + this.crpix[1]];
    }
  }

  /** tangent plane around (ra0, dec0) for the output grid: xi east, eta north (deg) */
  class Tan {
    constructor(ra0, dec0) { this.ra0 = ra0; this.dec0 = dec0; this.sd0 = Math.sin(dec0 * D2R); this.cd0 = Math.cos(dec0 * D2R); }
    toSky(xi, eta) { xi *= D2R; eta *= D2R; const den = this.cd0 - eta * this.sd0; let ra = this.ra0 + Math.atan2(xi, den) * R2D; ra = ((ra % 360) + 360) % 360; return [ra, Math.atan2(this.sd0 + eta * this.cd0, Math.hypot(xi, den)) * R2D]; }
    toPlane(ra, dec) { const a = (ra - this.ra0) * D2R, d = dec * D2R; const sd = Math.sin(d), cd = Math.cos(d), ca = Math.cos(a); const cc = this.sd0 * sd + this.cd0 * cd * ca; return [cd * Math.sin(a) / cc * R2D, (this.cd0 * sd - this.sd0 * cd * ca) / cc * R2D]; }
  }

  SS.fits = { parseHeader, readHeader, imageHeader, imageRows, extMap, waveTable, waveAt, flagRows, riceDecode32 };
  SS.WCS = WCS; SS.Tan = Tan;
})(window.SS);
