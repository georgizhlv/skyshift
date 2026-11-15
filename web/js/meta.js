/* SkyShift — metadata: which SPHEREx frames cover a position; name resolver; Gaia */
(function (SS) {
  'use strict';
  const C = SS.C;

  function tapUrl(adql) {
    const q = encodeURIComponent(adql);
    if (location.hostname === 'irsa.ipac.caltech.edu') return `${C.IRSA_TAP}?LANG=ADQL&FORMAT=csv&QUERY=${q}`;
    if (C.PROXY) return `${C.PROXY.replace(/\/$/, '')}/tap?q=${q}`;
    return null;
  }
  SS.tapAvailable = () => !!tapUrl('x');

  async function tap(adql, timeoutMs = 240000) {
    const u = tapUrl(adql);
    if (!u) throw new Error('NO_PROXY');
    const r = await SS.fetchRetry(u, {}, 3, timeoutMs);
    return r.text();
  }
  function parseCSV(t) {
    const L = t.trim().split(/\r?\n/); const head = L.shift().split(',');
    return L.filter(Boolean).map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => o[h] = v[i]); return o; });
  }

  const RE = /^ibe\/data\/spherex\/(\w+)\/level2\/([^/]+)\/([^/]+)\/(\d)\/level2_\2_(\d+)_(\d+)D\4_spx_\3\.fits$/;
  function toFrames(rows) {
    const seen = new Map();
    for (const r of rows) {
      const uri = r.uri; const m = uri.match(RE);
      const det = m ? +m[4] : +(r.energy_bandpassname || '').replace(/\D/g, '');
      const key = m ? `${m[2]}_${m[5]}_${m[6]}D${m[4]}` : uri;
      const rel = m ? m[1] : (uri.split('/')[3] || '?');
      const f = { uri, url: C.S3 + uri.replace(/^ibe\/data\/spherex\//, ''), mjd: +r.time_bounds_lower, det, rel, key, week: m ? m[2] : '' };
      const prev = seen.get(key);
      if (!prev || (prev.rel !== 'dr1' && rel === 'dr1')) seen.set(key, f); // prefer DR1 processing
    }
    return [...seen.values()].sort((a, b) => a.mjd - b.mjd);
  }

  const frameADQL = (ra, dec) => `SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid WHERE 1 = CONTAINS(POINT('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}), p.poly) ORDER BY p.time_bounds_lower`;

  let staticIndex = null;
  async function staticCache(ra, dec) {
    try {
      if (!staticIndex) { const r = await fetch(C.CACHE_DIR + 'index.json'); staticIndex = r.ok ? await r.json() : []; }
      const hit = staticIndex.find(e => SS.angsep(ra, dec, e.ra, e.dec) < (e.radius || 0.05));
      if (!hit) return null;
      const r = await fetch(C.CACHE_DIR + hit.file); if (!r.ok) return null;
      const j = await r.json();
      return { rows: j.rows.map(([uri, t, b]) => ({ uri, time_bounds_lower: t, energy_bandpassname: b })), when: j.created };
    } catch (e) { staticIndex = staticIndex || []; return null; }
  }

  /** frames covering (ra, dec). Order: in-memory/IDB cache → static cache → live TAP */
  SS.meta = {
    async frames(ra, dec, { force = false, onStatus } = {}) {
      const ck = `tap:${ra.toFixed(3)}:${dec.toFixed(3)}`;
      if (!force) {
        const c = await SS.cache.get(ck);
        if (c && Date.now() - c.t < 3 * 86400e3) return { frames: toFrames(c.rows), source: 'browser cache · ' + new Date(c.t).toLocaleString() };
        const s = await staticCache(ra, dec);
        if (s && !SS.tapAvailable()) return { frames: toFrames(s.rows), source: 'bundled cache · ' + (s.when || '') };
        if (s && !force) { this._bg(ra, dec, ck); return { frames: toFrames(s.rows), source: 'bundled cache (refreshing in background)' }; }
      }
      onStatus && onStatus('Asking IRSA which SPHEREx exposures cover this spot… (IRSA can be slow during the hackathon)');
      const txt = await tap(frameADQL(ra, dec));
      const rows = parseCSV(txt);
      SS.cache.set(ck, { t: Date.now(), rows });
      return { frames: toFrames(rows), source: 'live IRSA TAP · ' + new Date().toLocaleString() };
    },
    async _bg(ra, dec, ck) { try { const rows = parseCSV(await tap(frameADQL(ra, dec))); SS.cache.set(ck, { t: Date.now(), rows }); } catch (e) { /* ignore */ } },
    seed(ra, dec, csv) { return SS.cache.set(`tap:${ra.toFixed(3)}:${dec.toFixed(3)}`, { t: Date.now(), rows: parseCSV(csv) }); },
    parseCSV, toFrames, frameADQL,

    /** Gaia DR3 stars (epoch 2016.0) around a position, via IRSA TAP */
    async gaia(ra, dec, radiusDeg, gmax = 19.5) {
      const ck = `gaia:${ra.toFixed(3)}:${dec.toFixed(3)}:${radiusDeg.toFixed(3)}`;
      const c = await SS.cache.get(ck); if (c) return c;
      const q = `SELECT ra,dec,pmra,pmdec,parallax,phot_g_mean_mag,bp_rp FROM gaia_dr3_source WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra.toFixed(6)},${dec.toFixed(6)},${radiusDeg.toFixed(4)})) AND phot_g_mean_mag < ${gmax}`;
      const rows = parseCSV(await tap(q, 120000)).map(r => ({ ra: +r.ra, dec: +r.dec, pmra: +r.pmra || 0, pmdec: +r.pmdec || 0, plx: +r.parallax || 0, g: +r.phot_g_mean_mag, bprp: +r.bp_rp }));
      SS.cache.set(ck, rows);
      return rows;
    },
  };

  /** CDS Sesame name resolver (CORS-enabled). Returns J2000-epoch position + proper motion. */
  SS.resolve = async function (name) {
    const ck = 'sesame:' + name.toLowerCase();
    const c = await SS.cache.get(ck); if (c) return c;
    const r = await SS.fetchRetry('https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?' + encodeURIComponent(name), {}, 2, 20000);
    const x = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const res = x.querySelector('Resolver'); if (!res || !res.querySelector('jradeg')) return null;
    const g = (s) => { const e = res.querySelector(s); return e ? e.textContent.trim() : null; };
    const o = { name: g('oname') || name, otype: g('otype'), ra: +g('jradeg'), dec: +g('jdedeg'), pmra: +(g('pm > pmRA') || 0), pmdec: +(g('pm > pmDE') || 0), plx: +(g('plx > v') || 0), sptype: g('spType'), epoch: 2000.0 };
    SS.cache.set(ck, o);
    return o;
  };

  /** demo targets from the challenge (positions at J2000 epoch from SIMBAD; proper motions in mas/yr) */
  SS.PRESETS = [
    { id: 'wise0855', label: 'WISE 0855−0714', note: 'Coldest known brown dwarf · moves 8″/yr', q: 'WISE J085510.83-071442.5', ra: 133.81890825, dec: -7.247048, pmra: -8123.7, pmdec: 673.2, plx: 439.0, fov: 4, dets: [4, 5, 6] },
    { id: 'barnard', label: "Barnard's Star", note: 'Fastest-moving star in the sky · 10.4″/yr', q: "Barnard's star", ra: 269.452076, dec: 4.693364, pmra: -801.551, pmdec: 10362.394, plx: 546.98, fov: 4, dets: [1, 2, 3, 4, 5, 6] },
    { id: 'epsindib', label: 'ε Indi B', note: 'Brown-dwarf pair orbiting a nearby star', q: 'eps Ind B', ra: 331.0438, dec: -56.7827, pmra: 3966.7, pmdec: -2536.2, plx: 274.8, fov: 4, dets: [3, 4, 5, 6] },
    { id: 'rwaur', label: 'RW Aurigae', note: 'Young variable star with a disk', q: 'RW Aur', ra: 76.9564, dec: 30.4014, pmra: 3.6, pmdec: -25.8, plx: 6.4, fov: 4, dets: [1, 2, 3, 4, 5, 6] },
    { id: 'rdra', label: 'R Draconis', note: 'Mira variable · 245-day pulsation', q: 'R Dra', ra: 248.16742, dec: 66.75494, pmra: -0.5, pmdec: 0.2, plx: 1.0, fov: 4, dets: [1, 2, 3, 4, 5, 6] },
  ];
})(window.SS);
