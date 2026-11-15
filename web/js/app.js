/* SkyShift — UI controller  */
(function (SS) {
  'use strict';
  const $ = (s) => document.querySelector(s); const $$ = (s) => [...document.querySelectorAll(s)];
  const C = SS.C;
  const S = { sess: null, mode: 'blink', idx: 0, playing: false, timer: null, dets: [1, 2, 3, 4, 5, 6], probe: null, scan: null, motion: null, spec: null, gaia: null, run: 0, seq: [], target: null, allFrames: [] };
  SS.state = S;

  /* ---------------- helpers ---------------- */
  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), ms); }
  function modal(title, html) { $('#mTitle').textContent = title; $('#mBody').innerHTML = html; $('#modal').hidden = false; }
  function msg(html) { $('#stageMsg').innerHTML = html || ''; }
  function progress(f) { $('#progress i').style.width = (f * 100).toFixed(1) + '%'; if (f >= 1) setTimeout(() => { $('#progress i').style.width = '0'; }, 800); }
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtMB = (b) => (b / 1048576).toFixed(b > 1e8 ? 0 : 1) + ' MB';
  const detLabel = (d) => d.length === 6 ? 'all detectors' : d.length > 1 && d[d.length - 1] - d[0] === d.length - 1 ? `D${d[0]}–D${d[d.length - 1]}` : d.map(x => 'D' + x).join('+');
  const opts = () => ({ stretch: $('#stretch').value, cmap: $('#cmap').value, invert: $('#invert').checked });
  const hiQ = () => 1 - Math.pow(10, -(1.3 + (+$('#contrast').value) / 100 * 2.3));

  /* ---------------- boot ---------------- */
  function init() {
    // preset cards
    $('#presets').innerHTML = SS.PRESETS.map(p => `<button class="preset" data-id="${p.id}"><b>${esc(p.label)}</b><span>${esc(p.note)}</span></button>`).join('');
    $$('.preset').forEach(b => b.onclick = () => start(SS.PRESETS.find(p => p.id === b.dataset.id)));
    // detector chips
    $('#dets').innerHTML = '<span class="lab">Detectors</span>' + [1, 2, 3, 4, 5, 6].map(d => { const D = C.DET[d]; return `<span class="det" data-d="${d}" style="--c:${D.c}" title="${D.lo}–${D.hi} µm, R≈${D.R}">D${d} <small>${D.lo}–${D.hi}µm</small></span>`; }).join('');
    $$('.det').forEach(el => el.onclick = (ev) => toggleDet(+el.dataset.d, ev.shiftKey || ev.metaKey || ev.ctrlKey));
    paintDets();
    $('#search').onsubmit = (e) => { e.preventDefault(); const q = $('#q').value.trim(); if (q) start(q); };
    $('#btnOptions').onclick = () => { const o = $('#options'); o.hidden = !o.hidden; $('#btnOptions').setAttribute('aria-expanded', !o.hidden); };
    ['#fov', '#maxf', '#rel'].forEach(s => $(s).onchange = () => S.target && start(S.target, { keepProbe: false }));
    $('#useCache').onchange = (e) => { SS.cache.enabled = e.target.checked; };
    $('#btnClear').onclick = async () => { await SS.cache.clear(); toast('Browser cache cleared'); };
    $$('#modes button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
    $$('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
    ['#stretch', '#cmap', '#invert', '#contrast', '#smooth', '#oTarget', '#oGaia', '#oMovers', '#oFlags'].forEach(s => $(s).oninput = () => { if (s === '#oGaia' && $('#oGaia').checked) loadGaia(); draw(); });
    ['#specLog', '#specPts', '#specMol'].forEach(s => $(s).onchange = renderSpectrum);
    $('#play').onclick = togglePlay; $('#prev').onclick = () => step(-1); $('#next').onclick = () => step(1);
    $('#scrub').oninput = (e) => { S.idx = +e.target.value; draw(); };
    $('#speed').oninput = () => { if (S.playing) { stop(); play(); } };
    $('#mClose').onclick = () => { $('#modal').hidden = true; };
    $('#btnShare').onclick = share; $('#btnEmbed').onclick = embed;
    $('#copySpec').onclick = copySpectrum;
    $('#survey').onchange = () => S.aladin && S.aladin.setImageSurvey($('#survey').value);
    $('#skyGaia').onchange = () => updateAladin(true);
    document.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT' && e.target.type === 'text') return; if (e.code === 'Space') { e.preventDefault(); togglePlay(); } if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); });
    const ov = $('#ovl'); ov.onmousemove = hover; ov.onmouseleave = () => { $('#readout').textContent = ''; }; ov.onclick = clickImage;
    window.addEventListener('resize', () => { draw(); renderPanels(); });
    // URL parameters (query string or #hash)
    const P = new URLSearchParams(location.search.length > 1 ? location.search : location.hash.slice(1));
    if (P.get('embed') === '1') document.body.classList.add('embed');
    if (P.get('fov')) $('#fov').value = P.get('fov');
    if (P.get('max')) $('#maxf').value = P.get('max');
    if (P.get('dets')) S.dets = P.get('dets').split('').map(Number).filter(d => d >= 1 && d <= 6);
    if (P.get('mode')) S.mode = P.get('mode');
    const ra = parseFloat(P.get('ra')), dec = parseFloat(P.get('dec'));
    const pm = { pmra: +P.get('pmra') || 0, pmdec: +P.get('pmdec') || 0 };
    if (isFinite(ra) && isFinite(dec)) start(Object.assign({ label: P.get('name') || `${SS.fmtRA(ra)} ${SS.fmtDec(dec)}`, ra, dec, epoch: +P.get('epoch') || 2000 }, pm), { fromUrl: true });
    else if (P.get('q') || P.get('target')) start(P.get('q') || P.get('target'), { fromUrl: true });
    setMode(S.mode, true);
  }

  function paintDets() { $$('.det').forEach(el => { const d = +el.dataset.d; const on = S.dets.includes(d); el.classList.toggle('on', on); el.style.background = on ? C.DET[d].c : ''; el.style.borderColor = on ? C.DET[d].c : ''; }); }
  function toggleDet(d, solo) {
    if (solo) S.dets = [d]; else if (S.dets.includes(d)) { if (S.dets.length > 1) S.dets = S.dets.filter(x => x !== d); } else S.dets = [...S.dets, d].sort();
    paintDets();
    if (!S.sess) return;
    const missing = S.dets.filter(x => !S.sess.loadedDets.has(x));
    if (missing.length) loadMore(missing); else { rebuild(); analyses(); }
  }
  function setMode(m, quiet) {
    S.mode = m; $$('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $('#dets').style.opacity = m === 'ir' ? .45 : 1;
    if (!quiet) { rebuild(); }
  }
  function setTab(t) { $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); $$('.tab').forEach(el => el.hidden = el.id !== 'tab-' + t); S.tab = t; renderPanels(); if (t === 'sky') updateAladin(); }

  /* ---------------- start a search ---------------- */
  async function start(q, o = {}) {
    let t = null;
    if (typeof q === 'object') t = Object.assign({}, q);
    else {
      const c = SS.parseCoords(q);
      if (c) t = { label: q, ra: c.ra, dec: c.dec, pmra: 0, pmdec: 0, epoch: 2000 };
      else {
        const k = q.toLowerCase().replace(/[^a-z0-9]/g, '');
        const p = SS.PRESETS.find(p => p.id === k || p.label.toLowerCase().replace(/[^a-z0-9]/g, '').includes(k) || p.q.toLowerCase().replace(/[^a-z0-9]/g, '') === k);
        if (p) t = Object.assign({}, p);
        else {
          msg('<span class="big">Looking up “' + esc(q) + '”…</span>');
          try { const r = await SS.resolve(q); if (r) t = { label: r.name, ra: r.ra, dec: r.dec, pmra: r.pmra, pmdec: r.pmdec, plx: r.plx, epoch: 2000, otype: r.otype, sptype: r.sptype }; } catch (e) { /* fall through */ }
          if (!t) { toast('Could not find “' + q + '”. Planets, the Moon and asteroids move every day, so they cannot be searched by name. Try a star name or coordinates like 08 55 10.8 −07 14 42', 6000); msg(''); return; }
        }
      }
    }
    if (t.dets && !o.fromUrl) S.dets = t.dets.slice();
    if (t.fov && !o.fromUrl && !o.keepFov) $('#fov').value = t.fov;
    paintDets();
    run(t);
  }

  /* ---------------- run: metadata → frames → pixels ---------------- */
  async function run(t) {
    const my = ++S.run; stop();
    S.target = t; S.probe = null; S.scan = null; S.motion = null; S.spec = null; S.gaia = null; S.idx = 0;
    $('#landing').hidden = true; $('#work').hidden = false;
    $('#q').value = t.label || '';
    $('#tName').textContent = t.label || 'Custom position';
    const ref = (t.pmra || t.pmdec) ? SS.propagate(t.ra, t.dec, t.pmra, t.pmdec, t.epoch || 2000, 2026.0) : { ra: t.ra, dec: t.dec };
    $('#tCoords').textContent = `${SS.fmtRA(ref.ra)} ${SS.fmtDec(ref.dec)}  (${ref.ra.toFixed(5)}°, ${ref.dec.toFixed(5)}°)${t.pmra || t.pmdec ? ' · position in 2026' : ''}`;
    const pills = [];
    if (t.otype) pills.push(`<span class="pill">${esc(t.otype)}</span>`);
    if (t.sptype) pills.push(`<span class="pill">${esc(t.sptype)}</span>`);
    if (Math.hypot(t.pmra || 0, t.pmdec || 0) > 50) pills.push(`<span class="pill hot">μ ${(Math.hypot(t.pmra, t.pmdec) / 1000).toFixed(2)}″/yr</span>`);
    if (t.plx) pills.push(`<span class="pill">${(1000 / t.plx * 3.2616).toFixed(1)} light-years</span>`);
    $('#tPills').innerHTML = pills.join('');
    updateUrl();
    const g = SS.makeGrid(ref.ra, ref.dec, +$('#fov').value);
    clearViewer(); renderPanels();
    msg('<span class="big">Finding SPHEREx exposures…</span>Asking the archive which images cover this spot.');
    let res;
    try { res = await SS.meta.frames(ref.ra, ref.dec, { onStatus: (s) => my === S.run && msg('<span class="big">Finding SPHEREx exposures…</span>' + esc(s)) }); }
    catch (e) {
      if (my !== S.run) return;
      if (e.message === 'NO_PROXY') msg('<span class="big">Live search needs the SkyShift proxy</span>This position is not in the bundled cache. Set <code>proxy</code> in config.js (see README) — or try one of the featured targets.');
      else msg('<span class="big">The SPHEREx archive did not answer</span>' + esc(e.message) + '. IRSA is under heavy load during the hackathon — try again in a minute.');
      return;
    }
    if (my !== S.run) return;
    const rel = $('#rel').value;
    let frames = res.frames.filter(f => rel === 'all' || f.rel === rel);
    if (!frames.length) { msg('<span class="big">No SPHEREx exposures here yet</span>SPHEREx is still filling in the sky — new data arrive every week.'); return; }
    S.allFrames = frames;
    const epochs = SS.groupEpochs(frames);
    const sess = new SS.Session({ target: Object.assign({}, t, { ra: t.ra, dec: t.dec }), grid: g, epochs, frames: [], dets: S.dets });
    sess.metaSource = res.source; sess.loadedDets = new Set(); sess.bytes0 = SS.net.bytes;
    S.sess = sess;
    await loadMore(S.dets, my);
  }

  async function loadMore(dets, my = S.run) {
    const sess = S.sess; if (!sess) return;
    const maxf = +$('#maxf').value; const perDet = maxf ? Math.max(6, Math.round(maxf / 6)) : 0;
    let sel = [];
    for (const d of dets) { sel = sel.concat(SS.selectFrames(sess.epochs, [d], perDet ? perDet : 0)); sess.loadedDets.add(d); }
    sel = sel.filter(f => !sess.frames.includes(f));
    sess.frames = sess.frames.concat(sel);
    const est = sel.length * SS.frameBytes(sess.grid);
    $('#estimate').textContent = `${sess.frames.length} exposures · ≈${fmtMB(sess.frames.length * SS.frameBytes(sess.grid))}`;
    msg(`<span class="big">Streaming ${sel.length} exposures from NASA's archive…</span>≈${fmtMB(est)} · only the needed pixel rows are downloaded`);
    let done = 0, lastDraw = 0, waveReq = {};
    await SS.pool(sel, 6, async (f) => {
      if (my !== S.run) return;
      try { await SS.loadFrame(f, sess.grid, sess.target); } catch (e) { f.skip = e.message; }
      if (my !== S.run) return;
      done++;
      if (f.img) {
        sess.loaded.push(f);
        if (!sess.wave[f.det] && !waveReq[f.det]) { waveReq[f.det] = 1; SS.fits.waveTable(f.url).then(t => { sess.wave[f.det] = t; }).catch(() => { waveReq[f.det] = 0; }); }
      }
      progress(done / sel.length);
      const now = performance.now();
      if (now - lastDraw > 700) { lastDraw = now; msg(''); rebuild(true); $('#frameLabel').textContent += `\nloading ${done}/${sel.length} · ${fmtMB(SS.net.bytes - sess.bytes0)}`; }
    });
    if (my !== S.run) return;
    sess.loaded.sort((a, b) => a.mjd - b.mjd);
    // make sure every wavelength table is in
    await Promise.all([...new Set(sess.loaded.map(f => f.det))].filter(d => !sess.wave[d]).map(d => SS.fits.waveTable(sess.loaded.find(f => f.det === d).url).then(t => { sess.wave[d] = t; }).catch(() => { })));
    msg(sess.loaded.length ? '' : '<span class="big">No usable pixels</span>All exposures fell off the detector edge for this field.');
    rebuild();
    analyses();
    if (SS.tapAvailable()) loadGaia();
    if (!S.playing && S.seq.length > 1 && S.mode !== 'time') play();
  }

  /* ---------------- sequence & drawing ---------------- */
  function rebuild(quiet) {
    const sess = S.sess; if (!sess) return;
    sess.invalidate(); S.lim = {};
    const d = S.dets;
    if (S.mode === 'frames') S.seq = sess.loaded.filter(f => f.img && d.includes(f.det)).map(f => ({ kind: 'frame', f, mjd: f.mjd }));
    else if (S.mode === 'time') S.seq = [{ kind: 'time' }];
    else if (S.mode === 'ir') S.seq = sess.epochs.filter(e => sess.good([1, 2, 3, 4, 5, 6], e.i).length).map(e => ({ kind: 'ir', e, mjd: e.mjd }));
    else S.seq = sess.epochsWith(d).map(e => ({ kind: S.mode, e, mjd: e.mjd }));
    S.idx = Math.min(S.idx, Math.max(0, S.seq.length - 1));
    $('#scrub').max = Math.max(0, S.seq.length - 1); $('#scrub').value = S.idx;
    draw();
  }
  function clearViewer() { const c = $('#img'); c.getContext('2d').clearRect(0, 0, c.width, c.height); const o = $('#ovl'); o.getContext('2d').clearRect(0, 0, o.width, o.height); $('#frameLabel').textContent = ''; S.seq = []; }

  function limFor(key, img) { if (!S.lim[key]) S.lim[key] = SS.limits(img, 0.25, hiQ()); return S.lim[key]; }
  function othersStack(e) { const k = 'x' + e.i + S.dets.join(''); const c = S.sess.cacheS; if (!c.has(k)) c.set(k, SS.stack(S.sess.loaded.filter(f => f.img && S.dets.includes(f.det) && f.epoch !== e.i), S.sess.grid.N)); return c.get(k); }

  function draw() {
    const sess = S.sess; if (!sess || !S.seq.length) return;
    const g = sess.grid, N = g.N, it = S.seq[S.idx]; const d = S.dets; const o = opts(); let id, label;
    S.lim = S.lim && S.lim.hq === hiQ() ? S.lim : { hq: hiQ() };
    const nE = S.seq.length;
    if (it.kind === 'blink') {
      const st = sess.stack(it.e.i, d); id = SS.renderMono(st, N, limFor('all' + d.join(''), sess.stack(-1, d)), o);
      label = `Epoch ${S.idx + 1}/${nE} · ${SS.fmtDate(it.e.first)}${it.e.last - it.e.first > 1 ? ' → ' + SS.fmtDate(it.e.last).slice(5) : ''}\n${st.nframes} exposures stacked · ${detLabel(d)}`;
    } else if (it.kind === 'diff') {
      const st = sess.stack(it.e.i, d), ot = othersStack(it.e); const df = new Float32Array(N * N);
      for (let k = 0; k < df.length; k++) df[k] = st[k] - ot[k];
      const r = SS.stats.robust(df); id = SS.renderDiff(df, N, r.sig * (1.5 + 10 * (1 - (+$('#contrast').value) / 100)), o);
      label = `Epoch ${S.idx + 1}/${nE} minus all other epochs\nred = here now · blue = was here before`;
    } else if (it.kind === 'time') {
      const E = sess.epochsWith(d); const layers = E.map((e, i) => ({ img: sess.stack(e.i, d), color: SS.hueRGB(E.length > 1 ? i / (E.length - 1) : 0.5) }));
      layers.forEach((l, i) => l.lim = limFor('t' + i + d.join(''), l.img));
      id = SS.renderComposite(layers, N, Object.assign(o, { gain: 1.15 }));
      label = `Colour = time · ${E.map((e, i) => SS.fmtDate(e.mjd).slice(0, 7)).join(' → ')}\nwhite = still · rainbow trail = moving`;
    } else if (it.kind === 'ir') {
      const grp = [[[1, 2], [0.35, 0.55, 1]], [[3, 4], [0.35, 1, 0.45]], [[5, 6], [1, 0.35, 0.3]]].filter(([ds]) => sess.good(ds, -1).length);
      const layers = grp.map(([ds, col]) => ({ img: sess.stack(it.e.i, ds), color: col, lim: limFor('ir' + ds.join(''), sess.stack(-1, ds)) }));
      id = SS.renderComposite(layers, N, Object.assign(o, { gain: 1.2 }));
      label = `Epoch ${S.idx + 1}/${nE} · ${SS.fmtDate(it.e.mjd)} · infrared colour\nblue 0.75–1.6µm · green 1.6–3.8µm · red 3.8–5µm`;
    } else if (it.kind === 'frame') {
      const f = it.f; id = SS.renderMono(f.img, N, SS.limits(f.img, 0.25, hiQ()), o);
      const wt = sess.wave[f.det]; const lam = wt ? SS.fits.waveAt(wt, f.pc[0], f.pc[1]).lam : null;
      label = `${SS.mjdToDate(f.mjd).toISOString().slice(0, 16).replace('T', ' ')} UT · D${f.det}${lam ? ' · λ ' + lam.toFixed(3) + ' µm' : ''}\nexposure ${S.idx + 1}/${nE} · ${Math.round(f.exptime || 0)} s · ${f.rel.toUpperCase()}`;
    }
    const off = S.off || (S.off = document.createElement('canvas')); off.width = N; off.height = N; off.getContext('2d').putImageData(id, 0, 0);
    const cv = $('#img'), dpr = window.devicePixelRatio || 1; const W = Math.round(cv.clientWidth * dpr) || 600;
    if (cv.width !== W) { cv.width = W; cv.height = W; }
    const cx = cv.getContext('2d'); cx.imageSmoothingEnabled = $('#smooth').checked; cx.imageSmoothingQuality = 'high'; cx.drawImage(off, 0, 0, W, W);
    $('#frameLabel').textContent = label; $('#scrub').value = S.idx;
    overlay(it);
  }

  function overlay(it) {
    const sess = S.sess, g = sess.grid, N = g.N; const cv = $('#ovl'), dpr = window.devicePixelRatio || 1; const W = Math.round(cv.clientWidth * dpr) || 600;
    if (cv.width !== W) { cv.width = W; cv.height = W; }
    const c = cv.getContext('2d'); c.clearRect(0, 0, W, W);
    const P = (x, y) => [(x + 0.5) / N * W, (y + 0.5) / N * W]; const pxArc = W / N / g.scale; // canvas px per arcsec
    const mjd = it.mjd || (sess.epochs.length ? sess.epochs[Math.floor(sess.epochs.length / 2)].mjd : 61000);
    c.lineWidth = 1.5 * dpr;
    // Gaia
    if ($('#oGaia').checked && S.gaia) {
      const yr = SS.mjdToYear(mjd);
      c.strokeStyle = 'rgba(120,200,255,.75)';
      for (const s of S.gaia) { const p = SS.propagate(s.ra, s.dec, s.pmra, s.pmdec, 2016.0, yr); const [x, y] = SS.skyToGrid(g, p.ra, p.dec); if (x < 0 || y < 0 || x >= N || y >= N) continue; const [X, Y] = P(x, y); const r = Math.max(3, (21 - Math.min(20, s.g)) * 0.9) * dpr; c.beginPath(); c.arc(X, Y, r, 0, 7); c.stroke(); }
    }
    // movers
    if ($('#oMovers').checked && S.scan && S.scan.sources) {
      for (const s of S.scan.sources.filter(m => m.mover)) {
        const [X, Y] = P(s.x, s.y); const L = 6; // show 6 years of motion
        const ex = X - s.pmra * L * pxArc, ey = Y - s.pmdec * L * pxArc;
        c.strokeStyle = '#ffcf5c'; c.fillStyle = '#ffcf5c'; c.beginPath(); c.moveTo(X, Y); c.lineTo(ex, ey); c.stroke();
        const a = Math.atan2(ey - Y, ex - X); c.beginPath(); c.moveTo(ex, ey); c.lineTo(ex - 7 * dpr * Math.cos(a - .4), ey - 7 * dpr * Math.sin(a - .4)); c.lineTo(ex - 7 * dpr * Math.cos(a + .4), ey - 7 * dpr * Math.sin(a + .4)); c.closePath(); c.fill();
        c.beginPath(); c.arc(X, Y, 9 * dpr, 0, 7); c.stroke();
      }
    }
    // target track + ring
    if ($('#oTarget').checked) {
      const t = S.probe || sess.target; const moving = t.pmra || t.pmdec;
      if (moving && sess.epochs.length > 1) {
        const E = sess.epochs; E.forEach((e, i) => { const p = sess.posAt(e.mjd, S.probe); const [x, y] = SS.skyToGrid(g, p.ra, p.dec); const [X, Y] = P(x, y); const col = SS.hueRGB(E.length > 1 ? i / (E.length - 1) : .5).map(v => v * 255 | 0); c.fillStyle = `rgba(${col},.9)`; c.beginPath(); c.arc(X, Y, 2.2 * dpr, 0, 7); c.fill(); });
      }
      const p = sess.posAt(mjd, S.probe); const [x, y] = SS.skyToGrid(g, p.ra, p.dec); const [X, Y] = P(x, y); const r = 14 * pxArc;
      c.strokeStyle = S.probe ? '#7be07b' : '#ff7ab6'; c.lineWidth = 1.6 * dpr;
      for (const a of [0, 1, 2, 3]) { const ang = a * Math.PI / 2; c.beginPath(); c.moveTo(X + Math.cos(ang) * r, Y + Math.sin(ang) * r); c.lineTo(X + Math.cos(ang) * (r + 9 * dpr), Y + Math.sin(ang) * (r + 9 * dpr)); c.stroke(); }
    }
    // flags overlay (exposure mode)
    if ($('#oFlags').checked && it.kind === 'frame') drawFlags(it.f, c, W);
    // compass + scale bar
    c.lineWidth = 1.5 * dpr; c.strokeStyle = 'rgba(255,255,255,.8)'; c.fillStyle = 'rgba(255,255,255,.85)'; c.font = `${11 * dpr}px Inter, sans-serif`;
    const bx = W - 22 * dpr, by = 48 * dpr, L = 22 * dpr;
    c.beginPath(); c.moveTo(bx, by); c.lineTo(bx, by - L); c.moveTo(bx, by); c.lineTo(bx - L, by); c.stroke(); c.textAlign = 'center'; c.fillText('N', bx, by - L - 4 * dpr); c.fillText('E', bx - L - 8 * dpr, by + 4 * dpr);
    const bar = (g.fov >= 10 ? 120 : 60) * pxArc; c.beginPath(); c.moveTo(14 * dpr, W - 16 * dpr); c.lineTo(14 * dpr + bar, W - 16 * dpr); c.stroke(); c.textAlign = 'left'; c.fillText(g.fov >= 10 ? "2′" : "1′", 14 * dpr, W - 22 * dpr);
  }

  async function drawFlags(f, c, W) {
    if (!f.flagMask) {
      if (f._flagReq) return; f._flagReq = true;
      try {
        const fl = await SS.fits.flagRows(f.url, f.rows[0], f.rows[1]); const g = S.sess.grid, N = g.N; const m = new Uint8Array(N * N);
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const [ra, dec] = SS.gridToSky(g, i, j); const p = f.wcs.sky2pix(ra, dec); if (!p) continue; const x = Math.round(p[0] - 1), y = Math.round(p[1] - 1) - f.rows[0]; if (x < 0 || x >= C.NX || y < 0 || y > f.rows[1] - f.rows[0]) continue; const v = fl[y * C.NX + x]; m[j * N + i] = (v & C.BAD_MASK) ? 2 : (v & (1 << 21)) ? 1 : 0; }
        f.flagMask = m; f.flagStats = {}; for (let k = 0; k < fl.length; k++) { const v = fl[k]; if (!v) continue; for (let b = 0; b < 29; b++) if (v & (1 << b)) f.flagStats[b] = (f.flagStats[b] || 0) + 1; }
      } catch (e) { f.flagMask = new Uint8Array(0); toast('Could not read flags: ' + e.message); }
      draw(); return;
    }
    const N = S.sess.grid.N; if (!f.flagMask.length) return; const s = W / N;
    for (let k = 0; k < f.flagMask.length; k++) { const v = f.flagMask[k]; if (!v) continue; c.fillStyle = v === 2 ? 'rgba(255,60,60,.45)' : 'rgba(255,207,92,.16)'; c.fillRect((k % N) * s, Math.floor(k / N) * s, s + .5, s + .5); }
    const names = Object.entries(f.flagStats || {}).filter(([b]) => C.FLAG_NAMES[b] && +b !== 12).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([b, n]) => `${C.FLAG_NAMES[b]} ${n}`);
    if (names.length) $('#frameLabel').textContent += '\nflags: ' + names.join(' · ');
  }

  /* ---------------- playback ---------------- */
  function play() { if (S.seq.length < 2) return; S.playing = true; $('#play').textContent = '❚❚'; const ms = 1600 / (+$('#speed').value); S.timer = setInterval(() => step(1, true), ms); }
  function stop() { S.playing = false; clearInterval(S.timer); $('#play').textContent = '▶'; }
  function togglePlay() { S.playing ? stop() : play(); }
  function step(k, auto) { if (!S.seq.length) return; if (!auto) stop(); S.idx = (S.idx + k + S.seq.length) % S.seq.length; draw(); }

  /* ---------------- pointer ---------------- */
  function evGrid(e) { const r = $('#ovl').getBoundingClientRect(); const N = S.sess.grid.N; return [(e.clientX - r.left) / r.width * N - 0.5, (e.clientY - r.top) / r.height * N - 0.5]; }
  function hover(e) {
    if (!S.sess || !S.seq.length) return; const [x, y] = evGrid(e); const g = S.sess.grid; const [ra, dec] = SS.gridToSky(g, x, y);
    const it = S.seq[S.idx]; let img = it.kind === 'frame' ? it.f.img : it.e ? S.sess.stack(it.e.i, S.dets) : null; const k = Math.round(y) * g.N + Math.round(x);
    const v = img && img[k]; $('#readout').textContent = `${SS.fmtRA(ra)} ${SS.fmtDec(dec)}${v === v && v != null ? ` · ${v.toFixed(3)} MJy/sr` : ''}`;
  }
  function clickImage(e) {
    if (!S.sess) return; const g = S.sess.grid; let [x, y] = evGrid(e);
    const st = S.sess.stack(-1, S.dets); const pk = SS.peakNear(st, g, x, y, 8 / g.scale); const c = SS.centroid(st, g, pk.x, pk.y) || { x, y };
    // clicked a known mover? follow it
    const mv = S.scan && S.scan.sources && S.scan.sources.find(s => Math.hypot(s.x - c.x, s.y - c.y) * g.scale < 8);
    const [ra, dec] = SS.gridToSky(g, c.x, c.y);
    const tgt = S.sess.target; const pt = S.sess.posAt(S.sess.epochs[Math.floor(S.sess.epochs.length / 2)].mjd); const [tx, ty] = SS.skyToGrid(g, pt.ra, pt.dec);
    if (Math.hypot(tx - c.x, ty - c.y) * g.scale < 10) { S.probe = null; }
    else if (mv && mv.mover) { const ep = SS.mjdToYear(mv.pts.reduce((s, p) => s + p.mjd, 0) / mv.pts.length); S.probe = { label: 'Moving source', ra: mv.ra, dec: mv.dec, pmra: mv.pmra * 1000, pmdec: mv.pmdec * 1000, epoch: ep }; }
    else S.probe = { label: 'Clicked source', ra, dec, pmra: 0, pmdec: 0, epoch: 2000 };
    analyses(true); draw();
  }

  /* ---------------- science panels ---------------- */
  function analyses(probeOnly) {
    const sess = S.sess; if (!sess || !sess.loaded.length) return;
    S.spec = SS.spectrum(sess, S.probe);
    S.lc = SS.lightcurve(S.spec);
    S.motion = SS.motion(sess, null, S.probe);
    if (!probeOnly) {
      S.scan = SS.moverScan(sess, S.dets);
      if (S.scan.sources) S.scan.sources.forEach(s => { s.mover = s.sig > 4 && s.pm > 0.5 && s.pts.length >= 2; });
    }
    renderPanels(); draw();
  }
  function renderPanels() {
    const t = S.probe || (S.sess && S.sess.target) || {};
    $('#probeLine').innerHTML = S.sess ? `Analysing: <b>${esc(t.label || 'target')}</b> <span>${SS.fmtRA(t.ra)} ${SS.fmtDec(t.dec)}</span>${S.probe ? ' <button class="btn ghost small" id="resetProbe">back to target</button>' : ''}` : '';
    const rp = $('#resetProbe'); if (rp) rp.onclick = () => { S.probe = null; analyses(true); };
    const tab = S.tab || 'spec';
    if (tab === 'spec') renderSpectrum(); if (tab === 'lc') renderLC(); if (tab === 'motion') renderMotion(); if (tab === 'movers') renderMovers(); if (tab === 'data') renderData();
  }

  function renderSpectrum() {
    const cv = $('#cSpec'); const sp = S.spec;
    if (!sp || !sp.pts.length) { SS.plot(cv, { series: [], empty: S.sess ? 'Too faint for a spectrum here — click a brighter star' : 'Load a target to see its spectrum' }); $('#specText').innerHTML = ''; return; }
    const log = $('#specLog').checked; const pts = sp.pts.filter(p => p.lam === p.lam && (!log || p.flux > 0));
    const series = [];
    if ($('#specPts').checked) series.push({ type: 'scatter', alpha: .45, r: 1.8, pts: pts.map(p => ({ x: p.lam, y: p.flux, ey: p.err, color: C.DET[p.det].c })) });
    series.push({ type: 'line', color: '#fff', width: 2, gap: 0.3, pts: sp.bins.filter(b => !log || b.flux > 0).map(b => ({ x: b.lam, y: b.flux })) });
    series.push({ type: 'scatter', r: 2.6, alpha: 1, pts: sp.bins.filter(b => !log || b.flux > 0).map(b => ({ x: b.lam, y: b.flux, ey: b.err, color: '#fff' })) });
    SS.plot(cv, { series, ylog: log, xlabel: 'wavelength (µm)', ylabel: 'flux density (mJy)', xmin: 0.7, xmax: 5.05, marks: $('#specMol').checked ? SS.MOLECULES.map(m => ({ x: m.lam, label: m.name })) : [] });
    const F = (lo, hi) => { const b = sp.bins.filter(b => b.lam >= lo && b.lam <= hi); if (!b.length) return NaN; return b.reduce((s, x) => s + x.flux, 0) / b.length; };
    const blue = F(1.1, 1.4), red = F(4.3, 4.8), ratio = red / blue;
    let verdict = '';
    if (isFinite(ratio) && blue > 0) {
      if (ratio > 3) verdict = '<b class="warn">Extremely red.</b> Almost all its light comes out beyond 4 µm — the signature of a very cold brown dwarf, whose methane and water absorb the shorter wavelengths.';
      else if (ratio > 0.6) verdict = '<b class="warn">Very red.</b> Typical of cool brown dwarfs, dusty young stars or giant stars wrapped in dust.';
      else if (ratio > 0.15) verdict = '<b>Cool star colours</b> — redder than the Sun, like an M dwarf or a red giant.';
      else verdict = '<b>Normal star colours</b> — light falls off with wavelength like a hot stellar surface.';
    } else if (isFinite(red) && red > 0 && !(blue > 0)) verdict = '<b class="warn">Invisible at short wavelengths, bright at 4–5 µm</b> — exactly what a cold brown dwarf looks like.';
    if (sp.saturated) { $('#specText').innerHTML = `<p><b class="warn">This star is so bright it saturates SPHEREx</b> — the centre of its image is masked (OVERFLOW/BLOOM flags). SkyShift measures its light in a ring ${(sp.saturated + 4).toFixed(0)}–${(sp.saturated + 22).toFixed(0)}″ from the centre instead (the PSF wings). The shape above is therefore <i>relative</i>, but brightness changes over time are real — see the Brightness tab.</p>`; return; }
    $('#specText').innerHTML = `<p>${sp.pts.length} SPHEREx exposures saw this spot through different parts of the filter, so SkyShift could rebuild a <b>${sp.bins.length}-channel spectrum</b> from 0.75 to 5 µm on the fly. Coloured dots are single exposures (colour = detector); the white line is the combined spectrum.</p>${verdict ? '<p>' + verdict + (isFinite(ratio) && blue > 0 ? ` <span class="pill">F(4.5µm)/F(1.25µm) = ${ratio.toFixed(2)}</span>` : '') + '</p>' : ''}<p style="color:var(--dim)">Fluxes come from aperture photometry (12″ radius) without aperture correction — fine for shapes and colours, approximate in absolute terms.</p>`;
  }

  function renderLC() {
    const cv = $('#cLC'); const lc = S.lc;
    if (!lc || lc.length < 3) { SS.plot(cv, { series: [], empty: 'Not enough exposures for a light curve' }); $('#lcText').innerHTML = ''; return; }
    const series = [{ type: 'scatter', alpha: .55, r: 2, pts: lc.map(p => ({ x: p.mjd, y: p.rel, ey: p.err, color: C.DET[p.det].c })) }];
    // per-epoch means
    const E = {}; lc.forEach(p => { (E[p.epoch] = E[p.epoch] || []).push(p); });
    const em = Object.values(E).map(a => { let sw = 0, s = 0; a.forEach(p => { const w = 1 / Math.max(p.err, 0.01) ** 2; sw += w; s += w * p.rel; }); return { x: a.reduce((q, p) => q + p.mjd, 0) / a.length, y: s / sw, ey: 1 / Math.sqrt(sw), n: a.length }; }).sort((a, b) => a.x - b.x);
    series.push({ type: 'line', color: '#fff', width: 1.5, pts: em }); series.push({ type: 'scatter', r: 4, alpha: 1, pts: em.map(p => Object.assign({ color: '#fff', ring: true }, p)) });
    const xt = (lo, hi) => { const o = []; for (let y = Math.ceil(SS.mjdToYear(lo) * 4) / 4; y <= SS.mjdToYear(hi); y += 0.25) { const m = SS.yearToMjd(y); o.push({ v: m, label: SS.fmtDate(m).slice(0, 7) }); } return o; };
    SS.plot(cv, { series, xlabel: 'date', ylabel: 'brightness relative to average', hline: 1, xticks: xt });
    const ys = em.map(p => p.y); const amp = Math.max(...ys) - Math.min(...ys);
    let chi = 0; em.forEach(p => { chi += ((p.y - 1) / Math.max(p.ey, 0.005)) ** 2; }); const red = chi / Math.max(1, em.length - 1);
    const variable = em.length >= 2 && amp > 0.08 && red > 6;
    $('#lcText').innerHTML = `<p>${variable ? `<span class="big ok">Variable!</span><br>Brightness changed by <b>${(amp * 100).toFixed(0)}%</b> between epochs (χ²/dof = ${red.toFixed(0)}).` : `<b>No strong variation</b> detected between epochs (spread ${(amp * 100).toFixed(0)}%).`}</p>${S.spec && S.spec.saturated ? '<p class="warn">Saturated star: brightness measured from the PSF wings.</p>' : ''}<p>Because every SPHEREx exposure sees a slightly different wavelength, each point is divided by the object's average spectrum at that wavelength — what's left is the true change in brightness over time. White rings = epoch averages.</p>`;
  }

  function renderMotion() {
    const cv = $('#cMotion'); const m = S.motion;
    if (!m || m.error) { SS.plot(cv, { series: [], empty: m ? m.error : 'Load a target' }); $('#motionText').innerHTML = m && m.error ? `<p>${esc(m.error)}</p>` : ''; return; }
    const P = m.pts; const n = P.length; const series = [];
    const pts = P.map((p, i) => ({ x: -p.x, y: p.y, ex: p.ex, ey: p.ey, r: 4.5, color: `rgb(${SS.hueRGB(n > 1 ? i / (n - 1) : .5).map(v => v * 255 | 0)})` }));
    const f = m.fit;
    if (f.pmra != null) { const ts = [P[0].t - 0.15, P[n - 1].t + 0.15]; series.push({ type: 'line', color: 'rgba(255,255,255,.6)', width: 1.5, pts: ts.map(t => ({ x: -(f.x0 + f.pmra * (t - f.tm)), y: f.y0 + f.pmdec * (t - f.tm) })) }); }
    if (m.known) { const ts = [P[0].t, P[n - 1].t]; const k = m.known; series.push({ type: 'line', color: 'rgba(255,122,182,.8)', width: 1, pts: ts.map(t => ({ x: -(f.x0 + k.pmra * (t - f.tm)), y: f.y0 + k.pmdec * (t - f.tm) })) }); }
    series.push({ type: 'scatter', alpha: 1, pts });
    const all = pts.flatMap(p => [p.x, p.y]); const c0 = [(Math.min(...pts.map(p => p.x)) + Math.max(...pts.map(p => p.x))) / 2, (Math.min(...pts.map(p => p.y)) + Math.max(...pts.map(p => p.y))) / 2];
    const half = Math.max(1.5, ...pts.map(p => Math.max(Math.abs(p.x - c0[0]) + p.ex, Math.abs(p.y - c0[1]) + p.ey))) * 1.15;
    SS.plot(cv, { series, xmin: c0[0] - half, xmax: c0[0] + half, ymin: c0[1] - half, ymax: c0[1] + half, xlabel: '← East    offset (arcsec)    West →', ylabel: 'North offset (arcsec)', xticks: (lo, hi) => { const o = []; const st = half > 6 ? 5 : half > 3 ? 2 : 1; for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) o.push({ v, label: (-v).toFixed(0) }); return o; } });
    const pm = Math.hypot(f.pmra, f.pmdec), epm = Math.hypot(f.epmra, f.epmdec) / Math.SQRT2; const pa = (Math.atan2(f.pmra, f.pmdec) * 180 / Math.PI + 360) % 360;
    let html = `<p>SkyShift measured the position of the source in each epoch using ${detLabel(m.dets)} — the detectors where it outshines everything around it — with a ${esc(m.method)}, and corrected each epoch's pointing with ${m.reg.refs.length} field stars.</p>`;
    html += `<p><span class="big">${pm.toFixed(2)} ± ${epm.toFixed(2)} ″/yr</span><br>μα* = ${f.pmra.toFixed(2)} ± ${f.epmra.toFixed(2)} · μδ = ${f.pmdec.toFixed(2)} ± ${f.epmdec.toFixed(2)} ″/yr · towards PA ${pa.toFixed(0)}°</p>`;
    if (m.known) { const kp = Math.hypot(m.known.pmra, m.known.pmdec); const diff = Math.hypot(f.pmra - m.known.pmra, f.pmdec - m.known.pmdec); const ag = diff / Math.max(epm, 0.05); html += `<p>Catalogue value: <b>${kp.toFixed(2)} ″/yr</b> (pink line) → ${ag < 2 ? '<b class="ok">agrees</b>' : ag < 4 ? '<b class="warn">roughly agrees</b>' : '<b class="warn">differs</b>'} (${diff.toFixed(2)}″/yr apart, ${ag.toFixed(1)}σ). That is ${(kp / 6.15).toFixed(2)} SPHEREx pixels per year, recovered with sub-pixel precision.</p>`; }
    else html += `<p>${pm > 3 * epm && pm > 0.3 ? '<b class="ok">Significant motion!</b> Not known to move fast? Check the Movers tab and Gaia overlay — it could be a new nearby object.' : 'No significant motion — consistent with a distant star or galaxy.'}</p>`;
    if (f.plxFit && P.length >= 3 && f.plxFit.eplx < 0.15) html += `<p style="color:var(--dim)">Experimental parallax fit (Earth's orbit wobble): ϖ = ${(f.plxFit.plx * 1000).toFixed(0)} ± ${(f.plxFit.eplx * 1000).toFixed(0)} mas${m.known && m.known.plx ? ` (catalogue ${(m.known.plx * 1000).toFixed(0)} mas)` : ''}. Needs more epochs to be reliable — SPHEREx adds two per year.</p>`;
    html += '<div class="kv">' + P.map(p => `<span>${SS.fmtDate(p.mjd)}</span><span>E ${p.x.toFixed(2)}″ · N ${p.y.toFixed(2)}″ ± ${p.ex.toFixed(2)} · S/N ${p.snr.toFixed(0)} · ${p.nref} refs</span>`).join('') + '</div>';
    $('#motionText').innerHTML = html;
  }

  function renderMovers() {
    const sc = S.scan; const box = $('#moversList');
    if (!sc || sc.error) { $('#moversText').innerHTML = sc ? `<p>${esc(sc.error)}</p>` : '<p>Load a target to scan its field.</p>'; box.innerHTML = ''; return; }
    const src = sc.sources; const movers = src.filter(s => s.mover);
    $('#moversText').innerHTML = `<p>SkyShift tracked <b>${src.length}</b> sources across ${S.sess.epochsWith(S.dets).length} epochs and flags the ones that move. <b>${movers.length}</b> show significant motion${movers.length ? ' (yellow arrows on the image show 6 years of travel)' : ''}. Click one to follow it.</p>`;
    const gaiaMatch = (s) => { if (!S.gaia) return null; let best = null; for (const g of S.gaia) { const p = SS.propagate(g.ra, g.dec, g.pmra, g.pmdec, 2016, 2026); const d = SS.angsep(s.ra, s.dec, p.ra, p.dec) * 3600; if (d < 6 && (!best || d < best.d)) best = { d, g }; } return best; };
    box.innerHTML = src.slice(0, 40).map((s, i) => { const gm = gaiaMatch(s); const badge = !S.gaia ? '' : gm ? `<span class="badge g">Gaia G=${gm.g.g.toFixed(1)}${Math.hypot(gm.g.pmra, gm.g.pmdec) > 300 ? ` · μ ${(Math.hypot(gm.g.pmra, gm.g.pmdec) / 1000).toFixed(2)}″/yr` : ''}</span>` : '<span class="badge y">no Gaia match</span>'; return `<div class="item" data-i="${i}"><span class="sw" style="background:${s.mover ? '#ffcf5c' : '#3a4660'}"></span><div class="grow"><b>${s.pm.toFixed(2)} ± ${s.epm.toFixed(2)} ″/yr</b> <small>(${s.sig.toFixed(1)}σ) · S/N ${s.snr.toFixed(0)}</small><br><small>${SS.fmtRA(s.ra)} ${SS.fmtDec(s.dec)}</small></div>${badge}</div>`; }).join('') || '<div class="item">No sources detected.</div>';
    $$('#moversList .item').forEach(el => el.onclick = () => { const s = src[+el.dataset.i]; if (!s) return; const ep = SS.mjdToYear(s.pts.reduce((q, p) => q + p.mjd, 0) / s.pts.length); S.probe = { label: s.mover ? 'Moving source' : 'Field source', ra: s.ra, dec: s.dec, pmra: s.mover ? s.pmra * 1000 : 0, pmdec: s.mover ? s.pmdec * 1000 : 0, epoch: ep }; analyses(true); });
  }

  function renderData() {
    const sess = S.sess; if (!sess) { $('#dataText').innerHTML = ''; return; }
    const byE = sess.epochs.map(e => { const c = [0, 0, 0, 0, 0, 0, 0]; e.frames.forEach(f => c[f.det]++); return `<tr><td>${e.i + 1}</td><td>${SS.fmtDate(e.first)} → ${SS.fmtDate(e.last)}</td>${c.slice(1).map(n => `<td>${n || '·'}</td>`).join('')}</tr>`; }).join('');
    const rels = {}; S.allFrames.forEach(f => rels[f.rel] = (rels[f.rel] || 0) + 1);
    $('#dataText').innerHTML = `<div class="kv"><span>exposure list</span><span>${esc(sess.metaSource)}</span><span>available</span><span>${S.allFrames.length} exposures (${Object.entries(rels).map(([k, v]) => k.toUpperCase() + ' ' + v).join(', ')})</span><span>loaded</span><span>${sess.loaded.length} exposures · ${fmtMB(SS.net.bytes - sess.bytes0)} downloaded · grid ${sess.grid.N}² at ${sess.grid.scale.toFixed(1)}″/px</span></div>
      <table class="mini" style="width:100%;font-size:12px;margin-top:8px;border-collapse:collapse"><tr style="color:var(--dim)"><td>epoch</td><td>dates</td>${[1, 2, 3, 4, 5, 6].map(d => `<td style="color:${C.DET[d].c}">D${d}</td>`).join('')}</tr>${byE}</table>
      <p style="color:var(--dim)">Click an exposure to view it with its contamination flags.</p>`;
    $('#frameList').innerHTML = sess.loaded.map((f, i) => { const wt = sess.wave[f.det]; const lam = wt ? SS.fits.waveAt(wt, f.pc[0], f.pc[1]).lam.toFixed(3) + 'µm' : ''; return `<div class="item" data-i="${i}"><span class="sw" style="background:${C.DET[f.det].c}"></span><span class="grow">${SS.mjdToDate(f.mjd).toISOString().slice(0, 16).replace('T', ' ')} D${f.det} ${lam} ${f.rel}</span><a href="${f.url}" target="_blank" rel="noopener" title="Full FITS file (~66 MB)">fits</a></div>`; }).join('');
    $$('#frameList .item').forEach(el => el.onclick = (e) => { if (e.target.tagName === 'A') return; const f = sess.loaded[+el.dataset.i]; $('#oFlags').checked = true; setMode('frames'); S.idx = Math.max(0, S.seq.findIndex(s => s.f === f)); if (S.idx < 0) { S.dets = [...new Set([...S.dets, f.det])].sort(); paintDets(); rebuild(); S.idx = S.seq.findIndex(s => s.f === f); } stop(); draw(); });
  }

  /* ---------------- Gaia & sky map ---------------- */
  async function loadGaia() {
    if (!S.sess || S.gaia || S._gaiaReq || !SS.tapAvailable()) { if (!SS.tapAvailable() && $('#oGaia').checked) toast('Gaia overlay needs the SkyShift proxy (see README)'); return; }
    S._gaiaReq = true; const g = S.sess.grid;
    try { S.gaia = await SS.meta.gaia(g.ra, g.dec, g.fov / 60 * 0.75); renderPanels(); draw(); } catch (e) { /* ignore */ } finally { S._gaiaReq = false; }
  }
  function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
  async function updateAladin(force) {
    if (!S.sess) return; const g = S.sess.grid;
    try {
      if (!window.A) window.A = (await import('https://cdn.jsdelivr.net/npm/aladin-lite@3/dist/aladin.js')).default;
      await A.init;
      if (!S.aladin) S.aladin = A.aladin('#aladin', { survey: $('#survey').value, fov: g.fov / 60 * 3, target: `${g.ra} ${g.dec}`, cooFrame: 'ICRS', showReticle: true, showCooGrid: false });
      else S.aladin.gotoRaDec(g.ra, g.dec);
      if (S._alKey !== g.ra + ':' + g.fov || force) {
        S._alKey = g.ra + ':' + g.fov; S.aladin.removeLayers && S.aladin.removeLayers();
        const ov = A.graphicOverlay({ color: '#ffcf5c', lineWidth: 2 }); S.aladin.addOverlay(ov);
        const h = g.fov / 120; const corners = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => g.tan.toSky(x, y)); ov.add(A.polygon(corners));
        if ($('#skyGaia').checked) try { S.aladin.addCatalog(A.catalogFromVizieR('I/355/gaiadr3', `${g.ra} ${g.dec}`, g.fov / 60, { onClick: 'showTable', color: '#6cb6ff' })); } catch (e) { /* Gaia layer optional */ }
      }
    } catch (e) { $('#aladin').innerHTML = '<div style="padding:20px;color:var(--dim)">Sky map could not load right now (the CDS sky survey servers did not answer).</div>'; }
  }

  /* ---------------- sharing ---------------- */
  function viewUrl(extra = {}) {
    const t = S.target; if (!t) return location.href.split('?')[0];
    const p = new URLSearchParams();
    const preset = SS.PRESETS.find(x => x.label === t.label);
    if (preset) p.set('target', preset.id); else { p.set('ra', t.ra.toFixed(6)); p.set('dec', t.dec.toFixed(6)); if (t.label) p.set('name', t.label); if (t.pmra || t.pmdec) { p.set('pmra', t.pmra); p.set('pmdec', t.pmdec); p.set('epoch', t.epoch || 2000); } }
    p.set('fov', $('#fov').value); p.set('dets', S.dets.join('')); p.set('mode', S.mode);
    Object.entries(extra).forEach(([k, v]) => p.set(k, v));
    return location.origin + location.pathname + '?' + p.toString();
  }
  function updateUrl() { try { history.replaceState(null, '', viewUrl()); } catch (e) { /* sandboxed hosts */ } }
  async function share() { const u = viewUrl(); try { await navigator.clipboard.writeText(u); toast('Link copied — it opens this exact view'); } catch (e) { modal('Link to this view', `<textarea readonly>${esc(u)}</textarea>`); } }
  function embed() { const u = viewUrl({ embed: 1 }); modal('Embed SkyShift', `<p class="explain">Paste this into any web page. Coordinates live in the URL, so you can generate embeds for any object.</p><textarea readonly>&lt;iframe src="${esc(u)}" width="640" height="820" style="border:0;border-radius:12px" loading="lazy" title="SkyShift SPHEREx viewer"&gt;&lt;/iframe&gt;</textarea>`); }
  async function copySpectrum() {
    if (!S.spec) return; const rows = ['wavelength_um,flux_mJy,err_mJy,n_exposures,detector', ...S.spec.bins.map(b => `${b.lam.toFixed(4)},${b.flux.toExponential(4)},${b.err.toExponential(3)},${b.n},${b.det}`)].join('\n');
    try { await navigator.clipboard.writeText(rows); toast('Spectrum copied as CSV'); } catch (e) { modal('Spectrum (CSV)', `<textarea readonly>${esc(rows)}</textarea>`); }
  }

  SS.app = { start, run, draw, analyses, rebuild };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window.SS);