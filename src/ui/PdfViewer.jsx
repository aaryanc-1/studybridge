import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]).then(([lib, w]) => {
      lib.GlobalWorkerOptions.workerSrc = w.default;
      return lib;
    });
  }
  return pdfjsP;
}

// Where pdf.js finds fonts that aren't inside the PDF, character maps for other alphabets, and image decoders
function pdfAssets() {
  const base = new URL('./pdfjs/', document.baseURI).href;
  return {
    standardFontDataUrl: base + 'standard_fonts/',
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    wasmUrl: base + 'wasm/',
    iccUrl: base + 'iccs/',
    useSystemFonts: true,
  };
}

// Pictures of chosen pages (for Prof to read). Returns [{ page, blob }] as JPEGs about 1200px tall (sharp enough to read, about a third cheaper for Prof than 1500px).
export async function renderPdfPages(blob, pages, { maxSide = 1200, quality = 0.82 } = {}) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), ...pdfAssets() });
  const doc = await task.promise;
  const out = [];
  try {
    for (const n of pages) {
      if (n < 1 || n > doc.numPages) continue;
      const pg = await doc.getPage(n);
      const v1 = pg.getViewport({ scale: 1 });
      const scale = Math.min(3, maxSide / Math.max(v1.width, v1.height));
      const vp = pg.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
      const jpg = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
      out.push({ page: n, blob: jpg });
      pg.cleanup();
    }
    return { pages: out, total: doc.numPages };
  } finally {
    try {
      await task.destroy();
    } catch {}
  }
}

// A book's size and outline (bookmarks), so Prof can find the right pages itself.
// Outline lines look like "  Simultaneous equations → 112" (PDF page numbers).
export async function pdfBookInfo(blob) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), ...pdfAssets() });
  const doc = await task.promise;
  const lines = [];
  try {
    const walk = async (items, depth) => {
      for (const it of items || []) {
        if (lines.length >= 250) return;
        let page = null;
        try {
          const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
          if (dest && dest[0]) page = (await doc.getPageIndex(dest[0])) + 1;
        } catch {}
        lines.push(`${'  '.repeat(depth)}${String(it.title || '').trim()}${page ? ` → ${page}` : ''}`);
        if (depth < 2) await walk(it.items, depth + 1);
      }
    };
    await walk(await doc.getOutline().catch(() => null), 0);
    return { pages: doc.numPages, outline: lines.join('\n').slice(0, 6000) };
  } finally {
    try {
      await task.destroy();
    } catch {}
  }
}

// The words on a PDF's first page(s), to recognise past papers by their cover
export async function pdfFirstText(blob, pages = 1) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), ...pdfAssets() });
  try {
    const doc = await task.promise;
    let out = '';
    for (let n = 1; n <= Math.min(pages, doc.numPages); n++) {
      const pg = await doc.getPage(n);
      const tc = await pg.getTextContent();
      out += ' ' + tc.items.map((i) => i.str).join(' ');
    }
    return out.replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  } finally {
    try {
      await task.destroy();
    } catch {}
  }
}

// "12-15, 20" -> [12, 13, 14, 15, 20]
export function parsePages(text, max = 20) {
  const out = [];
  for (const part of String(text || '').split(/[,\s]+/)) {
    const m = part.match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b) && out.length < max; i++) if (!out.includes(i)) out.push(i);
  }
  return out;
}

export default function PdfViewer({ blob, title, toolbar }) {
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState('');
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const wrap = useRef(null);

  useEffect(() => {
    let alive = true;
    let task = null;
    (async () => {
      try {
        const lib = await pdfjs();
        task = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), ...pdfAssets() });
        const d = await task.promise;
        if (alive) setDoc(d);
      } catch (e) {
        if (alive) setErr('This PDF couldn’t be opened.');
      }
    })();
    return () => {
      alive = false;
      try {
        task?.destroy?.();
      } catch {}
    };
  }, [blob]);

  // Track which page is in view
  useEffect(() => {
    const el = wrap.current;
    if (!el || !doc) return;
    const onScroll = () => {
      const kids = [...el.querySelectorAll('[data-page]')];
      const top = el.scrollTop + el.clientHeight / 3;
      let cur = 1;
      for (const k of kids) if (k.offsetTop <= top) cur = Number(k.dataset.page);
      setPage(cur);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [doc]);

  function jump(n) {
    const el = wrap.current?.querySelector(`[data-page="${n}"]`);
    if (el) wrap.current.scrollTo({ top: el.offsetTop - 12 });
  }

  return (
    <div className="viewer">
      <div className="vbar">
        {title && <span className="strong ellipsis" style={{ maxWidth: 320 }}>{title}</span>}
        <span className="grow" />
        {doc && (
          <>
            <button className="tool" onClick={() => jump(Math.max(1, page - 1))} aria-label="Previous page">
              <Icon name="up" size={18} />
            </button>
            <span className="small" style={{ minWidth: 70, textAlign: 'center' }}>
              <input
                className="input sm"
                style={{ width: 52, textAlign: 'center', padding: '2px 4px', minHeight: 28 }}
                aria-label="Page"
                value={page}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (n >= 1 && n <= doc.numPages) jump(n);
                  setPage(e.target.value);
                }}
              />{' '}
              / {doc.numPages}
            </span>
            <button className="tool" onClick={() => jump(Math.min(doc.numPages, Number(page) + 1))} aria-label="Next page">
              <Icon name="down" size={18} />
            </button>
            <button className="tool" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="Zoom out">
              <Icon name="zoomOut" size={18} />
            </button>
            <span className="small">{Math.round(zoom * 100)}%</span>
            <button className="tool" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} aria-label="Zoom in">
              <Icon name="zoomIn" size={18} />
            </button>
          </>
        )}
        {toolbar}
      </div>
      <div className="pages" ref={wrap}>
        {err && <div className="error">{err}</div>}
        {!doc && !err && <div className="spinner" />}
        {doc && Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i} doc={doc} n={i + 1} zoom={zoom} root={wrap} />)}
      </div>
    </div>
  );
}

function PdfPage({ doc, n, zoom, root }) {
  const box = useRef(null);
  const canvas = useRef(null);
  const [visible, setVisible] = useState(n <= 2);
  const [size, setSize] = useState({ w: 612, h: 792 });

  useEffect(() => {
    let alive = true;
    doc.getPage(n).then((p) => {
      const v = p.getViewport({ scale: 1 });
      if (alive) setSize({ w: v.width, h: v.height });
    });
    return () => {
      alive = false;
    };
  }, [doc, n]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setVisible(true), { root: root.current, rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    let task = null;
    let alive = true;
    (async () => {
      const p = await doc.getPage(n);
      const avail = (root.current?.clientWidth || 800) - 40;
      const base = Math.min(1.6, avail / p.getViewport({ scale: 1 }).width);
      const scale = base * zoom;
      const dpr = window.devicePixelRatio || 1;
      const vp = p.getViewport({ scale: scale * dpr });
      const c = canvas.current;
      if (!c || !alive) return;
      c.width = vp.width;
      c.height = vp.height;
      c.style.width = vp.width / dpr + 'px';
      task = p.render({ canvasContext: c.getContext('2d'), viewport: vp, canvas: c });
      try {
        await task.promise;
      } catch {}
    })();
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [visible, zoom, doc, n, root]);

  const w = Math.min(1.6 * zoom * size.w, 2000);
  return (
    <div ref={box} data-page={n} style={{ minHeight: visible ? undefined : (size.h / size.w) * Math.min(w, (root.current?.clientWidth || 800) - 40) }}>
      <canvas ref={canvas} aria-label={`Page ${n}`} />
    </div>
  );
}
