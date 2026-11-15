/* SkyShift — tiny canvas charting (scatter + lines + error bars + annotations) */
(function (SS) {
  'use strict';
  function niceTicks(lo, hi, n = 5) {
    const span = hi - lo || 1; const step0 = span / n; const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n) || 10 * mag;
    const t = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * step; v += step) t.push(+v.toPrecision(12));
    return t;
  }
  const fmt = (v) => { const a = Math.abs(v); if (a === 0) return '0'; if (a >= 1e4 || a < 1e-2) return v.toExponential(0); return +v.toPrecision(3) + ''; };

  SS.plot = function (canvas, spec) {
    const dpr = window.devicePixelRatio || 1; const W = canvas.clientWidth || 400, H = canvas.clientHeight || 240;
    canvas.width = W * dpr; canvas.height = H * dpr; const c = canvas.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--fg').trim() || '#e8ecf4', dim = css.getPropertyValue('--dim').trim() || '#8a93a8', grid = css.getPropertyValue('--grid').trim() || 'rgba(255,255,255,.07)';
    c.clearRect(0, 0, W, H); c.font = '11px Inter, system-ui, sans-serif';
    const m = { l: 54, r: 12, t: spec.title ? 22 : 10, b: 34 };
    const pts = []; (spec.series || []).forEach(s => s.pts.forEach(p => { if (isFinite(p.x) && isFinite(p.y)) pts.push(p); }));
    if (!pts.length) { c.fillStyle = dim; c.textAlign = 'center'; c.fillText(spec.empty || 'No data yet', W / 2, H / 2); return; }
    const ylog = !!spec.ylog;
    const tx = (v) => v, ty = (v) => ylog ? Math.log10(Math.max(v, 1e-12)) : v;
    let xlo = spec.xmin ?? Math.min(...pts.map(p => p.x)), xhi = spec.xmax ?? Math.max(...pts.map(p => p.x));
    let ys = pts.flatMap(p => [ty(p.y - (ylog ? 0 : (p.ey || 0))), ty(p.y + (p.ey || 0))]).filter(isFinite);
    ys.sort((a, b) => a - b);
    let ylo = spec.ymin ?? ys[Math.floor(ys.length * 0.01)], yhi = spec.ymax ?? ys[Math.ceil(ys.length * 0.99) - 1];
    if (spec.yzero && !ylog) { ylo = Math.min(ylo, 0); }
    const pxr = (xhi - xlo) * 0.04 || 1, pyr = (yhi - ylo) * 0.08 || 1; xlo -= pxr; xhi += pxr; ylo -= pyr; yhi += pyr;
    const X = (v) => m.l + (tx(v) - xlo) / (xhi - xlo) * (W - m.l - m.r);
    const Y = (v) => H - m.b - (ty(v) - ylo) / (yhi - ylo) * (H - m.t - m.b);
    // grid + ticks
    c.strokeStyle = grid; c.fillStyle = dim; c.lineWidth = 1;
    const xt = spec.xticks ? spec.xticks(xlo, xhi) : niceTicks(xlo, xhi, Math.max(3, Math.floor(W / 90)));
    c.textAlign = 'center';
    xt.forEach(v => { const x = X(v.v ?? v); if (x < m.l - 1 || x > W - m.r + 1) return; c.beginPath(); c.moveTo(x, m.t); c.lineTo(x, H - m.b); c.stroke(); c.fillText(v.label ?? fmt(v), x, H - m.b + 14); });
    c.textAlign = 'right';
    let yt = niceTicks(ylo, yhi, Math.max(3, Math.floor(H / 50)));
    if (ylog) { yt = []; for (let e = Math.floor(ylo); e <= Math.ceil(yhi); e++) yt.push(e); }
    yt.forEach(v => { const y = H - m.b - (v - ylo) / (yhi - ylo) * (H - m.t - m.b); if (y < m.t - 1 || y > H - m.b + 1) return; c.beginPath(); c.moveTo(m.l, y); c.lineTo(W - m.r, y); c.stroke(); c.fillText(ylog ? fmt(Math.pow(10, v)) : fmt(v), m.l - 6, y + 4); });
    // annotations (vertical markers)
    (spec.marks || []).forEach(a => { const x = X(a.x); if (x < m.l || x > W - m.r) return; c.strokeStyle = a.color || 'rgba(255,214,102,.35)'; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(x, m.t); c.lineTo(x, H - m.b); c.stroke(); c.setLineDash([]); c.save(); c.translate(x + 3, m.t + 4); c.rotate(Math.PI / 2); c.fillStyle = a.color || 'rgba(255,214,102,.8)'; c.textAlign = 'left'; c.fillText(a.label, 0, 0); c.restore(); });
    if (spec.hline != null) { const y = Y(spec.hline); c.strokeStyle = 'rgba(255,255,255,.25)'; c.beginPath(); c.moveTo(m.l, y); c.lineTo(W - m.r, y); c.stroke(); }
    // series
    c.save(); c.beginPath(); c.rect(m.l, m.t, W - m.l - m.r, H - m.t - m.b); c.clip();
    for (const s of spec.series) {
      if (s.type === 'line' || s.type === 'step') {
        c.strokeStyle = s.color || fg; c.lineWidth = s.width || 2; c.globalAlpha = s.alpha ?? 1; c.beginPath(); let started = false, prev = null;
        s.pts.forEach(p => { if (!isFinite(p.y)) { started = false; return; } const x = X(p.x), y = Y(p.y); if (!started || (s.gap && prev && p.x - prev.x > s.gap)) { c.moveTo(x, y); started = true; } else c.lineTo(x, y); prev = p; });
        c.stroke(); c.globalAlpha = 1;
      }
      if (s.type === 'scatter' || s.type === 'errorbar' || !s.type) {
        s.pts.forEach(p => {
          if (!isFinite(p.y)) return; const x = X(p.x), y = Y(p.y); const col = p.color || s.color || fg;
          c.globalAlpha = s.alpha ?? 0.85;
          if (p.ey && s.errors !== false) { c.strokeStyle = col; c.lineWidth = 1; c.beginPath(); c.moveTo(x, Y(Math.max(p.y - p.ey, ylog ? p.y * 0.2 : -Infinity))); c.lineTo(x, Y(p.y + p.ey)); c.stroke(); }
          if (p.ex && s.errors !== false) { c.strokeStyle = col; c.beginPath(); c.moveTo(X(p.x - p.ex), y); c.lineTo(X(p.x + p.ex), y); c.stroke(); }
          c.fillStyle = col; c.beginPath(); c.arc(x, y, p.r || s.r || 2.2, 0, 7); c.fill();
          if (p.ring) { c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, (p.r || s.r || 2.2) + 2, 0, 7); c.stroke(); }
        });
        c.globalAlpha = 1;
      }
    }
    c.restore();
    // axes labels
    c.fillStyle = dim; c.textAlign = 'center'; c.fillText(spec.xlabel || '', m.l + (W - m.l - m.r) / 2, H - 6);
    c.save(); c.translate(12, m.t + (H - m.t - m.b) / 2); c.rotate(-Math.PI / 2); c.fillText(spec.ylabel || '', 0, 0); c.restore();
    if (spec.title) { c.fillStyle = fg; c.textAlign = 'left'; c.font = '600 12px Inter, system-ui, sans-serif'; c.fillText(spec.title, m.l, 14); }
    return { X, Y };
  };
})(window.SS);
