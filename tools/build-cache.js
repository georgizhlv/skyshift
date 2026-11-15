#!/usr/bin/env node
/**
 * Pre-fetch the SPHEREx exposure lists for the featured targets into web/data/cache/.
 * The app uses these when the proxy is missing or IRSA is slow — run it before a demo,
 * and again whenever a new data release appears (it always picks up the newest data).
 *
 *   node tools/build-cache.js
 */
const https = require('https'), fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, '..', 'web', 'data', 'cache');
fs.mkdirSync(OUT, { recursive: true });

// same values as SS.PRESETS in web/js/meta.js (J2000 position + proper motion in mas/yr)
const T = [
  ['wise0855', 133.81890825, -7.247048, -8123.7, 673.2],
  ['barnard', 269.452076, 4.693364, -801.551, 10362.394],
  ['epsindib', 331.0438, -56.7827, 3966.7, -2536.2],
  ['rwaur', 76.9564, 30.4014, 3.6, -25.8],
  ['rdra', 248.16742, 66.75494, -0.5, 0.2],
];
const prop = (ra, dec, pa, pd, y) => ({ ra: ra + pa * (y - 2000) / 3.6e6 / Math.cos(dec * Math.PI / 180), dec: dec + pd * (y - 2000) / 3.6e6 });
const get = (url) => new Promise((res, rej) => https.get(url, { headers: { 'User-Agent': 'SkyShift/1.0' } }, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => r.statusCode === 200 ? res(b) : rej(new Error('HTTP ' + r.statusCode))); }).on('error', rej));

(async () => {
  const index = [];
  for (const [id, ra0, dec0, pa, pd] of T) {
    const { ra, dec } = prop(ra0, dec0, pa, pd, 2026.0);
    const q = `SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid WHERE 1 = CONTAINS(POINT('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}), p.poly) ORDER BY p.time_bounds_lower`;
    process.stdout.write(`${id} … `);
    for (let k = 1; k <= 4; k++) {
      try {
        const csv = await get('https://irsa.ipac.caltech.edu/TAP/sync?LANG=ADQL&FORMAT=csv&QUERY=' + encodeURIComponent(q));
        const rows = csv.trim().split(/\r?\n/).slice(1).map(l => { const [u, t, b] = l.split(','); return [u, +t, b]; });
        fs.writeFileSync(path.join(OUT, id + '.json'), JSON.stringify({ created: new Date().toISOString().slice(0, 10), ra, dec, rows }));
        index.push({ id, ra, dec, radius: 0.05, file: id + '.json' });
        console.log(rows.length + ' exposures');
        break;
      } catch (e) { console.log(`retry ${k} (${e.message})`); await new Promise(r => setTimeout(r, 3000 * k)); }
    }
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  console.log('done →', OUT);
})();
