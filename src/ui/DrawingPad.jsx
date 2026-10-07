import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import Icon from './Icon.jsx';

export const COLORS = ['#1C1F23', '#D93025', '#1A73E8', '#1F8A5B', '#E37400', '#8A4FBF'];

// Strokes are stored in 0..1 coordinates so they redraw at any size.
// Ink goes on its own transparent layer so the eraser never rubs out a background picture.
const layers = new WeakMap();
function inkLayer(strokes, w, h) {
  const hit = layers.get(strokes);
  if (hit && hit.width === w && hit.height === h) return hit;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  for (const s of strokes) drawOne(ctx, s, w, h);
  layers.set(strokes, c);
  return c;
}

// A drawn answer as a picture (for Prof to read, and to keep): white background, cropped to what was drawn
export async function strokesPicture(strokes, { aspect = 0.62, width = 1400, pad = 40 } = {}) {
  const ink = (strokes || []).filter((s) => !s.e && s.p?.length);
  if (!ink.length) return null;
  const w = width;
  const h = Math.round(width * aspect);
  const full = document.createElement('canvas');
  full.width = w;
  full.height = h;
  drawStrokes(full.getContext('2d'), strokes, w, h);
  let x0 = 1,
    y0 = 1,
    x1 = 0,
    y1 = 0;
  for (const s of ink)
    for (const [x, y] of s.p) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  const cx = Math.max(0, Math.floor(x0 * w) - pad);
  const cy = Math.max(0, Math.floor(y0 * h) - pad);
  const cw = Math.min(w, Math.ceil(x1 * w) + pad) - cx;
  const ch = Math.min(h, Math.ceil(y1 * h) + pad) - cy;
  // what's left after the rubber: count the inked pixels; almost none means nothing was really drawn
  const px = full.getContext('2d').getImageData(cx, cy, Math.max(1, cw), Math.max(1, ch)).data;
  let inked = 0;
  for (let i = 3; i < px.length && inked < 60; i += 4) if (px[i] > 40) inked++;
  if (inked < 60) return null;
  const out = document.createElement('canvas');
  out.width = Math.max(200, cw);
  out.height = Math.max(120, ch);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(full, cx, cy, cw, ch, 0, 0, cw, ch);
  return new Promise((r) => out.toBlob(r, 'image/png'));
}

export function drawStrokes(ctx, strokes, w, h, { grid = false, bg = null, extra = null } = {}) {
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  if (bg) ctx.drawImage(bg, 0, 0, w, h);
  if (grid) {
    ctx.strokeStyle = '#E6EEF0';
    ctx.lineWidth = 1;
    const step = w / 30;
    for (let x = step; x < w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = step; y < h; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }
  if (extra && extra.e) {
    // Preview the eraser on a copy of the ink
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const t = tmp.getContext('2d');
    t.drawImage(inkLayer(strokes, w, h), 0, 0);
    drawOne(t, extra, w, h);
    ctx.drawImage(tmp, 0, 0);
  } else {
    ctx.drawImage(inkLayer(strokes, w, h), 0, 0);
    if (extra) drawOne(ctx, extra, w, h);
  }
  ctx.restore();
}

export function drawOne(ctx, s, w, h) {
  const pts = s.p;
  if (!pts || !pts.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = (s.w || 3) * (w / 1000);
  ctx.strokeStyle = s.c || '#1C1F23';
  if (s.e) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000';
  }
  ctx.globalAlpha = s.h ? 0.35 : 1;
  if (s.t === 'line' || s.t === 'rect' || s.t === 'circle') {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    ctx.beginPath();
    if (s.t === 'line') {
      ctx.moveTo(a[0] * w, a[1] * h);
      ctx.lineTo(b[0] * w, b[1] * h);
    } else if (s.t === 'rect') {
      ctx.rect(a[0] * w, a[1] * h, (b[0] - a[0]) * w, (b[1] - a[1]) * h);
    } else {
      const rx = Math.abs(b[0] - a[0]) * w;
      const ry = Math.abs(b[1] - a[1]) * h;
      ctx.ellipse(a[0] * w, a[1] * h, rx, ry, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
    if (pts.length === 1) ctx.lineTo(pts[0][0] * w + 0.1, pts[0][1] * h + 0.1);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = ((pts[i][0] + pts[i + 1][0]) / 2) * w;
      const my = ((pts[i][1] + pts[i + 1][1]) / 2) * h;
      ctx.quadraticCurveTo(pts[i][0] * w, pts[i][1] * h, mx, my);
    }
    if (pts.length > 1) ctx.lineTo(pts[pts.length - 1][0] * w, pts[pts.length - 1][1] * h);
    ctx.stroke();
  }
  ctx.restore();
}

// Pen tool shared by drawing answers, marking annotations and the live whiteboard
export function usePen({ canvas, strokes, setStrokes, tool, color, width, onStroke, onLive, readOnly, redraw }) {
  const cur = useRef(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c || readOnly) return;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
    };
    const down = (e) => {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      c.setPointerCapture(e.pointerId);
      const shape = ['line', 'rect', 'circle'].includes(tool) ? tool : undefined;
      cur.current = { c: color, w: tool === 'eraser' ? 26 : tool === 'highlighter' ? 18 : width, e: tool === 'eraser' || undefined, h: tool === 'highlighter' || undefined, t: shape, p: [pos(e)] };
      redraw(cur.current);
    };
    const move = (e) => {
      if (!cur.current) return;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      if (cur.current.t) cur.current.p = [cur.current.p[0], pos(e)];
      else for (const ev of events) cur.current.p.push(pos(ev));
      redraw(cur.current);
      onLive?.(cur.current);
    };
    const up = () => {
      if (!cur.current) return;
      const s = cur.current;
      s.p = s.p.map(([x, y]) => [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]);
      cur.current = null;
      setStrokes((list) => [...list, s]);
      onStroke?.(s);
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    return () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
    };
  }, [canvas, tool, color, width, setStrokes, onStroke, onLive, readOnly, redraw, strokes]);
}

const DrawingPad = forwardRef(function DrawingPad(
  { initial = [], onChange, background = null, aspect = 0.62, grid: gridDefault = false, defaultColor = COLORS[0], readOnly = false, label = 'Drawing area' },
  ref,
) {
  const canvas = useRef(null);
  const wrap = useRef(null);
  const [strokes, setStrokes] = useState(initial);
  const [undone, setUndone] = useState([]);
  const [tool, setTool] = useState('pen');
  const [color, setColor] = useState(defaultColor);
  const [width, setWidth] = useState(3);
  const [grid, setGrid] = useState(gridDefault);
  const [bg, setBg] = useState(null);
  const [ratio, setRatio] = useState(aspect);
  const first = useRef(true);

  useEffect(() => {
    if (!background) return;
    const img = new Image();
    img.onload = () => {
      setBg(img);
      setRatio(img.naturalHeight / img.naturalWidth);
    };
    img.src = background;
  }, [background]);

  const redraw = useCallback(
    (extra) => {
      const c = canvas.current;
      if (!c) return;
      const ctx = c.getContext('2d');
      drawStrokes(ctx, strokes, c.width, c.height, { grid, bg, extra });
    },
    [strokes, grid, bg],
  );

  // Size the canvas to its box
  useEffect(() => {
    const c = canvas.current;
    const box = wrap.current;
    if (!c || !box) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = box.clientWidth;
      const h = Math.round(w * ratio);
      c.style.height = h + 'px';
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      redraw();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [ratio, redraw]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    onChange?.(strokes);
  }, [strokes]); // eslint-disable-line react-hooks/exhaustive-deps

  usePen({ canvas, strokes, setStrokes: (f) => (setStrokes(f), setUndone([])), tool, color, width, readOnly, redraw });

  useImperativeHandle(ref, () => ({
    strokes: () => strokes,
    isEmpty: () => strokes.length === 0,
    // Flattened picture (for uploading)
    toBlob: () =>
      new Promise((resolve) => {
        const out = document.createElement('canvas');
        const w = bg ? Math.min(2000, bg.naturalWidth) : 1600;
        out.width = w;
        out.height = Math.round(w * ratio);
        drawStrokes(out.getContext('2d'), strokes, out.width, out.height, { grid, bg });
        out.toBlob(resolve, 'image/png');
      }),
  }));

  return (
    <div className="pad">
      {!readOnly && (
        <div className="tools" role="toolbar" aria-label="Drawing tools">
          <button className="tool" aria-pressed={tool === 'pen'} onClick={() => setTool('pen')} title="Pen">
            <Icon name="pen" size={18} />
          </button>
          <button className="tool" aria-pressed={tool === 'highlighter'} onClick={() => setTool('highlighter')} title="Highlighter">
            <Icon name="highlighter" size={18} />
          </button>
          <button className="tool" aria-pressed={tool === 'line'} onClick={() => setTool('line')} title="Straight line">
            <Icon name="line" size={18} />
          </button>
          <button className="tool" aria-pressed={tool === 'rect'} onClick={() => setTool('rect')} title="Rectangle">
            <Icon name="square" size={18} />
          </button>
          <button className="tool" aria-pressed={tool === 'circle'} onClick={() => setTool('circle')} title="Circle">
            <Icon name="circle" size={18} />
          </button>
          <button className="tool" aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')} title="Eraser">
            <Icon name="eraser" size={18} />
          </button>
          <span style={{ width: 8 }} />
          {COLORS.map((c) => (
            <button key={c} className="sw" style={{ background: c }} aria-label={`Colour ${c}`} aria-pressed={color === c && tool !== 'eraser'} onClick={() => (setColor(c), tool === 'eraser' && setTool('pen'))} />
          ))}
          <select className="select" style={{ width: 'auto', minHeight: 30, padding: '2px 6px', fontSize: 13 }} value={width} onChange={(e) => setWidth(Number(e.target.value))} aria-label="Pen size">
            <option value={2}>Thin</option>
            <option value={3}>Normal</option>
            <option value={6}>Thick</option>
          </select>
          <span className="grow" />
          {!background && (
            <button className="tool" aria-pressed={grid} onClick={() => setGrid((g) => !g)} title="Grid">
              Grid
            </button>
          )}
          <button
            className="tool"
            disabled={!strokes.length}
            onClick={() => {
              setUndone((u) => [...u, strokes[strokes.length - 1]]);
              setStrokes((s) => s.slice(0, -1));
            }}
            title="Undo"
          >
            <Icon name="undo" size={18} />
          </button>
          <button
            className="tool"
            disabled={!undone.length}
            onClick={() => {
              setStrokes((s) => [...s, undone[undone.length - 1]]);
              setUndone((u) => u.slice(0, -1));
            }}
            title="Redo"
          >
            <Icon name="redo" size={18} />
          </button>
          <button className="tool" disabled={!strokes.length} onClick={() => (setUndone([]), setStrokes([]))} title="Clear">
            <Icon name="trash" size={18} />
          </button>
        </div>
      )}
      <div ref={wrap}>
        <canvas ref={canvas} aria-label={label} role="img" />
      </div>
    </div>
  );
});

export default DrawingPad;
