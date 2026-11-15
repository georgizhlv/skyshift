/**
 * SkyShift proxy — Cloudflare Worker (free tier is plenty).
 *
 * Why it exists: the NASA/IPAC IRSA TAP service (which lists the SPHEREx exposures covering a
 * position, and hosts Gaia DR3) does not send CORS headers, so a browser cannot call it directly.
 * When TAP is overloaded, /frames answers the same question through IRSA's SIA service.
 * Pixels do NOT go through here: they stream straight from the public AWS S3 bucket.
 *
 * Only read-only SELECT queries on the SPHEREx metadata tables and Gaia DR3 are forwarded.
 * Responses are cached at the edge for 24 h, which also shields the demo from IRSA slowdowns.
 *
 * Deploy: dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker →
 *         paste this file → Deploy. Put the worker URL into web/config.js.
 */
const IRSA_TAP = 'https://irsa.ipac.caltech.edu/TAP/sync';
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
const ALLOWED = /(\bspherex\.(plane|artifact)\b|\bgaia_dr3_source\b)/i;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/frames' || url.pathname === '/gaia') { // TAP-independent routes (SIA / SCS)
      const ra = +url.searchParams.get('ra'), dec = +url.searchParams.get('dec');
      const r = +url.searchParams.get('r') || 0.05, gmax = +url.searchParams.get('gmax') || 19.5;
      if (!isFinite(ra) || !isFinite(dec) || Math.abs(dec) > 90) return new Response('ra/dec required', { status: 400, headers: CORS });
      const isGaia = url.pathname === '/gaia';
      if (isGaia && !(r > 0 && r <= GAIA_MAX_R)) return new Response(`r must be in (0, ${GAIA_MAX_R}]`, { status: 400, headers: CORS });
      const key = new Request(`https://skyshift.cache${url.pathname}/${ra.toFixed(4)}/${dec.toFixed(4)}` + (isGaia ? `/${r.toFixed(4)}/${gmax}` : ''));
      let res = await caches.default.match(key);
      if (!res) {
        try { res = new Response(await (isGaia ? scsGaia(ra, dec, r, gmax) : siaFrames(ra, dec)), { headers: { 'Cache-Control': 'public, max-age=86400' } }); }
        catch (e) { return new Response(String(e.message || e), { status: 502, headers: CORS }); }
        ctx.waitUntil(caches.default.put(key, res.clone()));
      }
      const out = new Response(res.body, res);
      Object.entries(CORS).forEach(([k, v]) => out.headers.set(k, v));
      out.headers.set('Content-Type', 'text/csv; charset=utf-8');
      return out;
    }
    if (url.pathname === '/tap') {
      const q = url.searchParams.get('q') || '';
      if (!q || q.length > 4000 || !/^\s*SELECT\b/i.test(q) || q.includes(';') || !ALLOWED.test(q)) {
        return new Response('Only SELECT queries on SPHEREx metadata or Gaia DR3 are allowed', { status: 403, headers: CORS });
      }
      const target = `${IRSA_TAP}?LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(q)}`;
      const cache = caches.default;
      const key = new Request(target, { method: 'GET' });
      let res = await cache.match(key);
      if (!res) {
        let upstream;
        for (let i = 0; i < 3; i++) { // IRSA is busy during the hackathon: retry 5xx
          upstream = await fetch(target, { headers: { 'User-Agent': 'SkyShift/1.0 (NASA Space Apps 2026)' } });
          if (upstream.ok || upstream.status < 500) break;
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
        if (!upstream.ok) return new Response(`IRSA answered ${upstream.status}`, { status: 502, headers: CORS });
        res = new Response(upstream.body, upstream);
        res.headers.set('Cache-Control', 'public, max-age=86400');
        ctx.waitUntil(cache.put(key, res.clone()));
      }
      const out = new Response(res.body, res);
      Object.entries(CORS).forEach(([k, v]) => out.headers.set(k, v));
      out.headers.set('Content-Type', 'text/csv; charset=utf-8');
      return out;
    }
    return new Response('SkyShift proxy is running. Use /tap?q=<ADQL> or /frames?ra=<deg>&dec=<deg>', { headers: Object.assign({ 'Content-Type': 'text/plain' }, CORS) });
  },
};
