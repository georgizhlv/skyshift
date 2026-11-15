// Build a single-file version of SkyShift: dist/index.html (CSS + JS inlined) and dist/skyshift.bundle.js
// usage: node tools/build.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), web = path.join(root, 'web'), dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const order = ['core', 'fits', 'meta', 'process', 'analysis', 'render', 'plot', 'app'];
const js = order.map(n => `/* ---- ${n}.js ---- */\n` + fs.readFileSync(path.join(web, 'js', n + '.js'), 'utf8')).join('\n');
const css = fs.readFileSync(path.join(web, 'css', 'style.css'), 'utf8');
let html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="css\/style.css">/, `<style>\n${css}\n</style>`)
  .replace(/<script src="config.js"[^>]*><\/script>\n?/, '')
  .replace(/(<script src="js\/[a-z]+\.js"><\/script>\n?)+/, `<script>\n${js}\n</script>\n`);
fs.writeFileSync(path.join(dist, 'index.html'), html);
fs.writeFileSync(path.join(dist, 'skyshift.bundle.js'), js);
const body = html.split('<!--SKYSHIFT-BODY-START-->')[1].split('<!--SKYSHIFT-BODY-END-->')[0];
fs.writeFileSync(path.join(dist, 'body.html'), body);
fs.writeFileSync(path.join(dist, 'style.css'), css);
console.log('dist/index.html', (html.length / 1024).toFixed(0) + ' KB');
