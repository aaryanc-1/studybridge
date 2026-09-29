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
