#!/usr/bin/env node
/**
 * SkyShift local server — zero dependencies.
 * Serves the web app AND the /tap + /frames proxy on one origin, so everything works offline-from-proxy.
 *
 *   node proxy/server.js            → http://localhost:8080
 *   PORT=3000 node proxy/server.js
 */
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8080;
const ROOT = path.join(__dirname, '..', 'web');
const ALLOWED = /(\bspherex\.(plane|artifact)\b|\bgaia_dr3_source\b)/i;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
// Answers are kept in memory AND on disk (proxy/.cache), so anything loaded once keeps working
// after a restart — even if IRSA is completely down during the presentation.
const crypto = require('crypto');
const CACHE = path.join(__dirname, '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const memo = (() => {
  const m = new Map(), file = (k) => path.join(CACHE, crypto.createHash('sha1').update(k).digest('hex') + '.csv');
  return {
    has(k) { if (m.has(k)) return true; try { m.set(k, fs.readFileSync(file(k), 'utf8')); return true; } catch (e) { return false; } },
    get: (k) => m.get(k),
    set(k, v) { m.set(k, v); fs.writeFile(file(k), v, () => {}); },
  };
})();

const IRSA_SIA = 'https://irsa.ipac.caltech.edu/SIA';
const SIA_FALLBACK = ['spherex_dr1', 'spherex_qr3'];

/* ---- SIA path: an independent IRSA service that answers in seconds when TAP is overloaded ---- */
const TD = /<TD(?:\/>|>([\s\S]*?)<\/TD>)/g;
const unesc = (s) => (s || '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** SIA VOTable → the same CSV the TAP query returns (uri,time_bounds_lower,energy_bandpassname) */
function siaToRows(xml) {
  const fields = [...xml.matchAll(/<FIELD name="([^"]+)"/g)].map(m => m[1]);
  const iu = fields.indexOf('access_url'), it = fields.indexOf('t_min'), ib = fields.indexOf('energy_bandpassname'), is = fields.indexOf('dataproduct_subtype');
  const out = [];
  for (const tr of xml.matchAll(/<TR>([\s\S]*?)<\/TR>/g)) {
    const v = [...tr[1].matchAll(TD)].map(m => unesc(m[1]));
    const url = v[iu] || '';
    if (is >= 0 && v[is] && v[is] !== 'science') continue;
    const k = url.indexOf('ibe/data/spherex/');
    if (k < 0 || !url.includes('/level2/')) continue;
    out.push(`${url.slice(k)},${v[it]},${v[ib]}`);
  }
  return out;
}
/** all single-exposure SPHEREx collections IRSA currently serves (dr1, qr3, and any future release) */
function siaCollections(xml) {
  const c = [...xml.matchAll(/OPTION value="(spherex_[a-z]+\d+)"/g)].map(m => m[1]);
  return c.length ? [...new Set(c)] : SIA_FALLBACK;
}
async function fetchRetry(url, tries = 6) { // IRSA flickers between 502 and 200 under load: be patient
  let r, err;
  for (let i = 0; i < tries; i++) {
    try {
      r = await fetch(url, { headers: { 'User-Agent': 'SkyShift/1.0 (NASA Space Apps 2026)' } });
      if (r.ok || r.status < 500) return r;
    } catch (e) { err = e; }
    await new Promise(z => setTimeout(z, 1500 * (i + 1)));
  }
  if (r) return r; throw err;
}
let collections = null, collectionsAt = 0;
async function siaFrames(ra, dec) {
  if (!collections || Date.now() - collectionsAt > 6 * 3600e3) { // re-discover releases every 6 h
    const meta = await fetchRetry(`${IRSA_SIA}?COLLECTION=spherex_dr1&POS=${encodeURIComponent('CIRCLE 0 0 0.0001')}&MAXREC=0`).then(r => r.ok ? r.text() : '').catch(() => '');
    collections = siaCollections(meta); collectionsAt = Date.now();
  }
  const pos = `CIRCLE ${ra.toFixed(6)} ${dec.toFixed(6)} 0.0005`;
  const parts = await Promise.allSettled(collections.map(async (c) => {
    const r = await fetchRetry(`${IRSA_SIA}?COLLECTION=${c}&POS=${encodeURIComponent(pos)}&RESPONSEFORMAT=VOTABLE`);
    if (!r.ok) throw new Error(`IRSA SIA ${c} answered ${r.status}`);
    return siaToRows(await r.text());
  }));
  const bad = parts.find(p => p.status === 'rejected');
  if (bad) throw bad.reason; // never return (and cache) a list with a release missing
  const ok = parts;
  return 'uri,time_bounds_lower,energy_bandpassname\n' + ok.flatMap(p => p.value).join('\n') + '\n';
}

/* ---- Gaia DR3 via IRSA Simple Cone Search (also TAP-independent) ---- */
const GAIA_COLS = ['ra', 'dec', 'pmra', 'pmdec', 'parallax', 'phot_g_mean_mag', 'bp_rp'];
const GAIA_MAX_R = 0.2; // deg — SCS returns every Gaia column (~4 kB/star), keep downloads sane
async function scsGaia(ra, dec, r, gmax) {
  const res = await fetchRetry(`https://irsa.ipac.caltech.edu/SCS?table=gaia_dr3_source&RA=${ra.toFixed(6)}&DEC=${dec.toFixed(6)}&SR=${r.toFixed(4)}`);
  if (!res.ok) throw new Error(`IRSA SCS answered ${res.status}`);
  const xml = await res.text();
  const fields = [...xml.matchAll(/<FIELD [^>]*?name="([^"]+)"/g)].map(m => m[1]);
  const idx = GAIA_COLS.map(c => fields.indexOf(c));
  if (idx.some(i => i < 0)) throw new Error('IRSA SCS: unexpected Gaia columns');
  const ig = idx[5], out = [GAIA_COLS.join(',')];
  for (const tr of xml.matchAll(/<TR>([\s\S]*?)<\/TR>/g)) {
    const v = [...tr[1].matchAll(TD)].map(m => (m[1] || '').trim());
    if (!(+v[ig] < gmax)) continue;
    out.push(idx.map(i => v[i]).join(','));
  }
  return out.join('\n') + '\n';
}
function tap(q, res) {
  if (!/^\s*SELECT\b/i.test(q) || q.includes(';') || !ALLOWED.test(q)) { res.writeHead(403); return res.end('forbidden'); }
  if (memo.has(q)) { res.writeHead(200, { 'Content-Type': 'text/csv', 'Access-Control-Allow-Origin': '*' }); return res.end(memo.get(q)); }
  const url = 'https://irsa.ipac.caltech.edu/TAP/sync?LANG=ADQL&FORMAT=csv&QUERY=' + encodeURIComponent(q);
  const attempt = (n) => https.get(url, { headers: { 'User-Agent': 'SkyShift/1.0' } }, (up) => {
    let body = ''; up.setEncoding('utf8'); up.on('data', (c) => body += c);
    up.on('end', () => {
      if (up.statusCode >= 500 && n < 3) return setTimeout(() => attempt(n + 1), 1500 * n);
      if (up.statusCode === 200) memo.set(q, body);
      res.writeHead(up.statusCode === 200 ? 200 : 502, { 'Content-Type': 'text/csv', 'Access-Control-Allow-Origin': '*' }); res.end(body);
    });
  }).on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  attempt(1);
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/tap') return tap(u.searchParams.get('q') || '', res);
  if (u.pathname === '/frames' || u.pathname === '/gaia') { // TAP-independent routes: SIA (exposures), SCS (Gaia)
    const ra = +u.searchParams.get('ra'), dec = +u.searchParams.get('dec');
    const r = +u.searchParams.get('r') || 0.05, gmax = +u.searchParams.get('gmax') || 19.5;
    const hdr = { 'Content-Type': 'text/csv', 'Access-Control-Allow-Origin': '*' };
    const isGaia = u.pathname === '/gaia';
    if (!isFinite(ra) || !isFinite(dec) || Math.abs(dec) > 90 || (isGaia && !(r > 0 && r <= GAIA_MAX_R))) { res.writeHead(400, hdr); return res.end('bad ra/dec/r'); }
    const k = `${u.pathname}:${ra.toFixed(4)}:${dec.toFixed(4)}` + (isGaia ? `:${r.toFixed(4)}:${gmax}` : '');
    if (memo.has(k)) { res.writeHead(200, hdr); return res.end(memo.get(k)); }
    (isGaia ? scsGaia(ra, dec, r, gmax) : siaFrames(ra, dec)).then((csv) => { memo.set(k, csv); res.writeHead(200, hdr); res.end(csv); })
      .catch((e) => { res.writeHead(502, hdr); res.end(String(e.message || e)); });
    return;
  }
  let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, '');
  let f = path.join(ROOT, p || 'index.html');
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (path.basename(f) === 'config.js') { // point the app at this server's own /tap
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`window.SKYSHIFT_CONFIG = Object.assign(window.SKYSHIFT_CONFIG || {}, { proxy: location.origin });`);
  }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(data);
  });
}).listen(PORT, () => console.log(`SkyShift running at http://localhost:${PORT}`));
