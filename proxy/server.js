#!/usr/bin/env node
/**
 * SkyShift local server — zero dependencies.
 * Serves the web app AND the /tap proxy on one origin, so everything works offline-from-proxy.
 *
 *   node proxy/server.js            → http://localhost:8080
 *   PORT=3000 node proxy/server.js
 */
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8080;
const ROOT = path.join(__dirname, '..', 'web');
const ALLOWED = /(\bspherex\.(plane|artifact)\b|\bgaia_dr3_source\b)/i;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const memo = new Map();

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
