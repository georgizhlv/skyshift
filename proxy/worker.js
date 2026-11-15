/**
 * SkyShift proxy — Cloudflare Worker (free tier is plenty).
 *
 * Why it exists: the NASA/IPAC IRSA TAP service (which lists the SPHEREx exposures covering a
 * position, and hosts Gaia DR3) does not send CORS headers, so a browser cannot call it directly.
 * Pixels do NOT go through here: they stream straight from the public AWS S3 bucket.
 *
 * Only read-only SELECT queries on the SPHEREx metadata tables and Gaia DR3 are forwarded.
 * Responses are cached at the edge for 24 h, which also shields the demo from IRSA slowdowns.
 *
 * Deploy: dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker →
 *         paste this file → Deploy. Put the worker URL into web/config.js.
 */
const IRSA_TAP = 'https://irsa.ipac.caltech.edu/TAP/sync';
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
    return new Response('SkyShift proxy is running. Use /tap?q=<ADQL>', { headers: Object.assign({ 'Content-Type': 'text/plain' }, CORS) });
  },
};
