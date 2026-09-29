import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { COLORS, drawOne, drawStrokes, usePen } from './DrawingPad.jsx';

const TOPIC = 'wb';
const enc = new TextEncoder();
const dec = new TextDecoder();

// Shared whiteboard for live sessions, synced over the LiveKit data channel
export default function Whiteboard({ room, me }) {
  const canvas = useRef(null);
  const box = useRef(null);
  const [pages, setPages] = useState([[]]);
  const [page, setPage] = useState(0);
  const [tool, setTool] = useState('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(3);
  const [grid, setGrid] = useState(true);
  const remoteLive = useRef({}); // participant -> stroke in progress
  const parts = useRef({});
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const pageRef = useRef(page);
  pageRef.current = page;

  const send = useCallback(
    (msg) => {
      if (!room) return;
      const data = enc.encode(JSON.stringify(msg));
      if (data.length > 14000) {
        // Split large messages (the full board) into parts
        const id = Math.random().toString(36).slice(2);
        const str = JSON.stringify(msg);
        const n = Math.ceil(str.length / 12000);
        for (let i = 0; i < n; i++) room.localParticipant.publishData(enc.encode(JSON.stringify({ t: 'part', id, i, n, d: str.slice(i * 12000, (i + 1) * 12000) })), { reliable: true, topic: TOPIC });
        return;
      }
      room.localParticipant.publishData(data, { reliable: msg.t !== 'live', topic: TOPIC });
    },
    [room],
  );

  const strokes = pages[page] || [];

  const redraw = useCallback(
    (extra) => {
      const c = canvas.current;
      if (!c) return;
      const ctx = c.getContext('2d');
      drawStrokes(ctx, strokes, c.width, c.height, { grid, extra });
      for (const s of Object.values(remoteLive.current)) if (s && s.page === page) drawOne(ctx, s, c.width, c.height);
    },
    [strokes, grid, page],
  );

  useEffect(() => {
    const c = canvas.current;
    const b = box.current;
    if (!c || !b) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(b.clientWidth * dpr);
      c.height = Math.round(b.clientHeight * dpr);
      redraw();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(b);
    return () => ro.disconnect();
  }, [redraw]);

  useEffect(() => redraw(), [redraw]);

  const apply = useCallback((msg) => {
    if (msg.t === 'stroke') {
      setPages((p) => {
        const next = p.map((x) => x);
        while (next.length <= msg.page) next.push([]);
        next[msg.page] = [...next[msg.page], msg.s];
        return next;
      });
    } else if (msg.t === 'undo') {
      setPages((p) => p.map((x, i) => (i === msg.page ? x.filter((s) => s.id !== msg.id) : x)));
    } else if (msg.t === 'clear') {
      setPages((p) => p.map((x, i) => (i === msg.page ? [] : x)));
    } else if (msg.t === 'addpage') {
      setPages((p) => (p.length < msg.n ? [...p, ...Array.from({ length: msg.n - p.length }, () => [])] : p));
    } else if (msg.t === 'goto') {
      setPage(msg.page);
    } else if (msg.t === 'state') {
      setPages((p) => (p.every((x) => x.length === 0) ? msg.pages : p));
      setPage(msg.page || 0);
    }
  }, []);

  useEffect(() => {
    if (!room) return;
    const onData = (payload, participant, _kind, topic) => {
      if (topic !== TOPIC) return;
      let msg;
      try {
        msg = JSON.parse(dec.decode(payload));
      } catch {
        return;
      }
      if (msg.t === 'part') {
        const bucket = (parts.current[msg.id] ||= []);
        bucket[msg.i] = msg.d;
        if (bucket.filter(Boolean).length === msg.n) {
          delete parts.current[msg.id];
          try {
            msg = JSON.parse(bucket.join(''));
          } catch {
            return;
          }
        } else return;
      }
      const who = participant?.identity || 'x';
      if (msg.t === 'live') {
        remoteLive.current[who] = { ...msg.s, page: msg.page };
        redraw();
        return;
      }
      if (msg.t === 'stroke') delete remoteLive.current[who];
      if (msg.t === 'hello') {
        // Someone joined: whoever has drawing sends the board
        if (pagesRef.current.some((x) => x.length)) send({ t: 'state', pages: pagesRef.current, page: pageRef.current });
        return;
      }
      apply(msg);
    };
    room.on('dataReceived', onData);
    send({ t: 'hello' });
    return () => room.off('dataReceived', onData);
  }, [room, apply, send, redraw]);

  const lastLive = useRef(0);
  usePen({
    canvas,
    strokes,
    tool,
    color,
    width,
    redraw,
    setStrokes: (f) =>
      setPages((p) => {
        const next = p.map((x) => x);
        next[page] = typeof f === 'function' ? f(next[page] || []) : f;
        return next;
      }),
    onStroke: (s) => {
      s.id = Math.random().toString(36).slice(2, 10);
      s.by = me;
      send({ t: 'stroke', page, s });
    },
    onLive: (s) => {
      const now = Date.now();
      if (now - lastLive.current > 60) {
        lastLive.current = now;
        send({ t: 'live', page, s: { ...s, p: s.p.slice(-400) } });
      }
    },
  });

  function undo() {
    const mine = [...strokes].reverse().find((s) => s.by === me);
    if (!mine) return;
    apply({ t: 'undo', page, id: mine.id });
    send({ t: 'undo', page, id: mine.id });
  }

  return (
    <div className="board">
      <div className="tools" role="toolbar" aria-label="Whiteboard tools">
        {[
          ['pen', 'pen', 'Pen'],
          ['highlighter', 'highlighter', 'Highlighter'],
          ['line', 'line', 'Line'],
          ['rect', 'square', 'Rectangle'],
          ['circle', 'circle', 'Circle'],
          ['eraser', 'eraser', 'Eraser'],
        ].map(([t, icon, label]) => (
          <button key={t} className="tool" aria-pressed={tool === t} onClick={() => setTool(t)} title={label} aria-label={label}>
            <Icon name={icon} size={18} />
          </button>
        ))}
        <span style={{ width: 6 }} />
        {COLORS.map((c) => (
          <button key={c} className="sw" style={{ background: c, width: 24, height: 24, borderRadius: 12, border: '2px solid #fff', boxShadow: color === c ? '0 0 0 2px var(--ink)' : '0 0 0 1px var(--line)', cursor: 'pointer', padding: 0 }} aria-label={`Colour ${c}`} onClick={() => (setColor(c), tool === 'eraser' && setTool('pen'))} />
        ))}
        <select className="select" style={{ width: 'auto', minHeight: 30, padding: '2px 6px', fontSize: 13 }} value={width} onChange={(e) => setWidth(Number(e.target.value))} aria-label="Pen size">
          <option value={2}>Thin</option>
          <option value={3}>Normal</option>
          <option value={6}>Thick</option>
        </select>
        <button className="tool" aria-pressed={grid} onClick={() => setGrid((g) => !g)}>
          Grid
        </button>
        <span className="grow" />
        <button className="tool" onClick={undo} title="Undo my last stroke" aria-label="Undo">
          <Icon name="undo" size={18} />
        </button>
        <button
          className="tool"
          onClick={() => {
            apply({ t: 'clear', page });
            send({ t: 'clear', page });
          }}
          title="Clear this page"
          aria-label="Clear page"
        >
          <Icon name="trash" size={18} />
        </button>
        <span className="small" style={{ margin: '0 4px' }}>
          Page {page + 1} / {pages.length}
        </span>
        <button
          className="tool"
          disabled={page === 0}
          onClick={() => {
            setPage(page - 1);
            send({ t: 'goto', page: page - 1 });
          }}
          aria-label="Previous page"
        >
          <Icon name="left" size={18} />
        </button>
        <button
          className="tool"
          onClick={() => {
            const n = page + 1;
            if (n >= pages.length) {
              setPages((p) => [...p, []]);
              send({ t: 'addpage', n: pages.length + 1 });
            }
            setPage(n);
            send({ t: 'goto', page: n });
          }}
          aria-label="Next page"
        >
          <Icon name={page + 1 >= pages.length ? 'plus' : 'right'} size={18} />
        </button>
      </div>
      <div className="surface" ref={box}>
        <canvas ref={canvas} aria-label="Whiteboard" />
      </div>
    </div>
  );
}
