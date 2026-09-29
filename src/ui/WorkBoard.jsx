import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import DrawingPad from './DrawingPad.jsx';

// Full-screen whiteboard for working things out (optionally on top of a photo).
// What's drawn is saved as a picture in the answer, so the tutor can mark on it like a photo.
export default function WorkBoard({ background = null, title = 'Whiteboard', onClose, onSave }) {
  const pad = useRef(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    const k = (e) => e.key === 'Escape' && !changed && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [changed, onClose]);

  return (
    <div className="workboard" role="dialog" aria-modal="true" aria-label={title}>
      <div className="wb-bar">
        <Icon name="pen" />
        <span className="strong">{title}</span>
        <span className="small muted grow">{background ? 'Draw on your photo: circle things, add steps, fix mistakes.' : 'Work it out here like on paper. Use the grid for graphs.'}</span>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy || (!changed && !background)}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(await pad.current.toBlob());
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="check" size={18} /> {busy ? 'Saving…' : 'Add to my answer'}
        </button>
      </div>
      <div className="wb-body">
        <div className="wb-sheet">
          <DrawingPad ref={pad} background={background} grid={!background} aspect={0.68} onChange={() => setChanged(true)} label="Whiteboard" />
        </div>
      </div>
    </div>
  );
}
