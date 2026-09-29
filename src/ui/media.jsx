import { useEffect, useState } from 'react';
import * as api from '../lib/api.js';
import Icon from './Icon.jsx';

// Object URL for a stored file (cached on this device for offline use)
export function useBlob(bucket, path) {
  const [state, setState] = useState({ blob: null, url: null, error: null });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    let url = null;
    api
      .getBlob(bucket, path)
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setState({ blob, url, error: null });
      })
      .catch((e) => alive && setState({ blob: null, url: null, error: e }));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bucket, path]);
  return state;
}

export function StoredImage({ bucket = 'library', path, alt = '', className, style, onClick }) {
  const { url, error } = useBlob(bucket, path);
  if (error) return <div className="note small">{error.message}</div>;
  if (!url) return <div className={className} style={{ ...style, minHeight: 60, background: 'var(--sunk)', borderRadius: 10 }} />;
  return <img src={url} alt={alt} className={className} style={style} onClick={onClick} />;
}

export function Lightbox({ src, onClose, children }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()} style={{ padding: 30 }}>
      <div style={{ position: 'relative', maxWidth: '100%', maxHeight: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button className="btn icon" style={{ position: 'absolute', top: -14, right: -14, borderRadius: 21, zIndex: 2 }} onClick={onClose} aria-label="Close">
          <Icon name="x" />
        </button>
        {src && <img src={src} alt="" style={{ maxWidth: '90vw', maxHeight: '85vh', borderRadius: 10, background: '#fff' }} />}
        {children}
      </div>
    </div>
  );
}

export function WorkThumb({ path, onOpen, onRemove }) {
  const { url } = useBlob('work', path);
  return (
    <div className="thumb" role="button" tabIndex={0} onClick={() => url && onOpen?.(url)} onKeyDown={(e) => e.key === 'Enter' && url && onOpen?.(url)}>
      {url ? <img src={url} alt="Uploaded work" /> : <div className="spinner" style={{ margin: 60 }} />}
      {onRemove && (
        <button
          className="btn sm icon x"
          aria-label="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Icon name="trash" size={15} />
        </button>
      )}
    </div>
  );
}
