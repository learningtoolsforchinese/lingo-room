// Handwriting board: the student draws, and the strokes are sent exactly as drawn.

/**
 * Turn a <canvas> into a drawing pad.
 * onChange() is called after every finished stroke, undo or clear.
 */
export function createBoard(canvas, onChange) {
  const ctx = canvas.getContext("2d");
  let strokes = [];   // [[ [x, y], ... ], ...] in CSS pixels
  let cur = null;

  const W = () => canvas.clientWidth;
  const H = () => canvas.clientHeight;
  const lineWidth = () => Math.max(6, W() / 32);

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W() * dpr);
    canvas.height = Math.round(H() * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function guide() {
    // 田字格 practice grid
    const w = W(), h = H();
    ctx.save();
    ctx.strokeStyle = "#e6ddd1";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    ctx.moveTo(0, 0); ctx.lineTo(w, h);
    ctx.moveTo(w, 0); ctx.lineTo(0, h);
    ctx.stroke();
    ctx.restore();
  }

  function drawStroke(s) {
    if (!s.length) return;
    ctx.beginPath();
    ctx.moveTo(s[0][0], s[0][1]);
    if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1] + 0.1);
    for (let i = 1; i < s.length; i++) ctx.lineTo(s[i][0], s[i][1]);
    ctx.stroke();
  }

  function redraw() {
    ctx.clearRect(0, 0, W(), H());
    guide();
    ctx.strokeStyle = "#2b2330";
    ctx.lineWidth = lineWidth();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    strokes.forEach(drawStroke);
    if (cur) drawStroke(cur);
  }

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    cur = [pos(e)];
    redraw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!cur) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) cur.push(pos(ev));
    redraw();
  });
  const end = (e) => {
    if (!cur) return;
    e?.preventDefault?.();
    strokes.push(cur);
    cur = null;
    redraw();
    onChange?.();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  window.addEventListener("resize", () => { if (canvas.isConnected) resize(); });

  resize();
  return {
    get strokes() { return strokes; },
    get width() { return W(); },
    get height() { return H(); },
    undo() { strokes.pop(); redraw(); onChange?.(); },
    clear() { strokes = []; cur = null; redraw(); onChange?.(); },
    resize,
  };
}

/**
 * Store strokes compactly: scaled to a 0–255 square, nearby points dropped.
 * Returns [[x, y, x, y, ...], ...]
 */
export function encodeStrokes(strokes, width, height) {
  const scale = 255 / Math.max(width, height, 1);
  return strokes.map((s) => {
    const out = [];
    let lx = -99, ly = -99;
    s.forEach((p, i) => {
      const x = Math.max(0, Math.min(255, Math.round(p[0] * scale)));
      const y = Math.max(0, Math.min(255, Math.round(p[1] * scale)));
      if (i === 0 || i === s.length - 1 || Math.hypot(x - lx, y - ly) >= 3) {
        out.push(x, y); lx = x; ly = y;
      }
    });
    return out;
  });
}
