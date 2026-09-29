import { useEffect, useRef } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Link, Loading, Page, Empty } from '../../ui/kit.jsx';
import PdfViewer from '../../ui/PdfViewer.jsx';
import { useBlob } from '../../ui/media.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { desktop } from '../../lib/config.js';
import { bytes } from '../../lib/format.js';

// Any uploaded file: PDFs and images open inside StudyBridge; anything else can be saved
export default function FileView({ id }) {
  const app = useApp();
  const files = useQuery('files', api.listFiles);
  const f = (files.data || []).find((x) => x.id === id);
  if (!f) return <Page title="File">{files.data ? <Empty>This file isn’t available.</Empty> : <Loading />}</Page>;
  return (
    <div className="page wide" style={{ height: 'calc(100vh - 90px)', gap: 12 }}>
      <div className="eyebrow">
        <Link to="/library">Library</Link> <Icon name="right" size={14} /> {f.name}
      </div>
      <FileBody file={f} tutor={app.me.role === 'tutor'} />
    </div>
  );
}

export function FileBody({ file, tutor }) {
  const { blob, url, error } = useBlob('library', file.storage_path);
  useReadingTime(tutor ? null : file.id);
  if (error) return <div className="error">{error.message}</div>;
  if (!blob) return <Loading label="Opening…" />;
  const save = (
    <button
      className="tool"
      onClick={async () => {
        if (desktop) desktop.saveFile(file.name, new Uint8Array(await blob.arrayBuffer()));
        else {
          const a = document.createElement('a');
          a.href = url;
          a.download = file.name;
          a.click();
        }
      }}
    >
      <Icon name="download" size={18} /> Save
    </button>
  );
  const type = file.mime || blob.type || '';
  if (type.includes('pdf') || /\.pdf$/i.test(file.name)) return <PdfViewer blob={blob} title={file.name} toolbar={save} />;
  if (type.startsWith('image/'))
    return (
      <div className="viewer">
        <div className="vbar">
          <span className="strong">{file.name}</span>
          <span className="grow" />
          {save}
        </div>
        <div className="pages">
          <img src={url} alt={file.name} />
        </div>
      </div>
    );
  if (type.startsWith('video/') || type.startsWith('audio/'))
    return (
      <div className="viewer">
        <div className="vbar">
          <span className="strong">{file.name}</span>
          <span className="grow" />
          {save}
        </div>
        <div className="pages">{type.startsWith('video/') ? <video src={url} controls style={{ maxWidth: '100%' }} /> : <audio src={url} controls />}</div>
      </div>
    );
  return (
    <div className="card" style={{ alignItems: 'flex-start' }}>
      <Icon name="file" size={36} />
      <div className="strong">{file.name}</div>
      <div className="muted small">
        {bytes(file.size)} · this kind of file opens in another app.
      </div>
      <div>{save}</div>
    </div>
  );
}

// Counts reading time while the learner has a file or lesson open
export function useReadingTime(ref, kind = 'file') {
  const acc = useRef(0);
  useEffect(() => {
    if (!ref) return;
    let last = Date.now();
    let lastInput = Date.now();
    const bump = () => (lastInput = Date.now());
    window.addEventListener('pointermove', bump);
    window.addEventListener('keydown', bump);
    window.addEventListener('wheel', bump, { passive: true });
    const t = setInterval(() => {
      const now = Date.now();
      if (!document.hidden && document.hasFocus() && now - lastInput < 3 * 60000) acc.current += (now - last) / 1000;
      last = now;
      if (acc.current >= 30) {
        api.logTime(kind, ref, acc.current);
        acc.current = 0;
      }
    }, 5000);
    return () => {
      clearInterval(t);
      window.removeEventListener('pointermove', bump);
      window.removeEventListener('keydown', bump);
      window.removeEventListener('wheel', bump);
      if (acc.current >= 5) api.logTime(kind, ref, acc.current);
      acc.current = 0;
    };
  }, [ref, kind]);
}
