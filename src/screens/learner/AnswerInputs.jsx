import { useEffect, useRef, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Markdown, Modal, useToast } from '../../ui/kit.jsx';
import MathField from '../../ui/MathField.jsx';
import DrawingPad from '../../ui/DrawingPad.jsx';
import { WorkThumb, Lightbox } from '../../ui/media.jsx';
import { items, multi } from '../../lib/questions.js';
import { compressImage } from '../../lib/image.js';
import * as api from '../../lib/api.js';

// One answer box for any question type
export default function AnswerInput({ q, value = {}, onChange, attemptId, keyUnit, disabled }) {
  if (q.type === 'mcq') return <Choice q={q} value={value} onChange={onChange} disabled={disabled} />;
  if (q.type === 'numeric')
    return (
      <div className="row">
        <input
          className="input"
          style={{ maxWidth: 240, fontSize: 18 }}
          inputMode="decimal"
          value={value.value || ''}
          disabled={disabled}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder="Your answer"
          aria-label="Your answer"
        />
        {keyUnit && <span className="muted">{keyUnit}</span>}
      </div>
    );
  if (q.type === 'short')
    return (
      <div className="stack sm">
        <textarea className="textarea" value={value.text || ''} disabled={disabled} onChange={(e) => onChange({ ...value, text: e.target.value })} placeholder="Write your answer. For maths use $…$, e.g. $x^2$." aria-label="Your answer" />
        {value.text && /\$/.test(value.text) && (
          <div className="note">
            <Markdown src={value.text} />
          </div>
        )}
        <Photos value={value} onChange={onChange} attemptId={attemptId} q={q} disabled={disabled} optional />
      </div>
    );
  if (q.type === 'steps') return <Steps value={value} onChange={onChange} attemptId={attemptId} q={q} disabled={disabled} />;
  if (q.type === 'upload') return <Photos value={value} onChange={onChange} attemptId={attemptId} q={q} disabled={disabled} />;
  if (q.type === 'drawing') return <Drawing value={value} onChange={onChange} disabled={disabled} />;
  return null;
}

function Choice({ q, value, onChange, disabled }) {
  const opts = items(q.options);
  const m = multi(q.options);
  const chosen = m ? value.choices || [] : value.choice != null ? [value.choice] : [];
  return (
    <div className="stack sm" role={m ? 'group' : 'radiogroup'}>
      {m && <div className="muted small">Choose all that apply.</div>}
      {opts.map((o, i) => {
        const on = chosen.includes(String(i));
        return (
          <label key={i} className={'opt' + (on ? ' on' : '')}>
            <input
              type={m ? 'checkbox' : 'radio'}
              name={'q-' + q.id}
              checked={on}
              disabled={disabled}
              onChange={() => onChange(m ? { choices: on ? chosen.filter((c) => c !== String(i)) : [...chosen, String(i)] } : { choice: String(i) })}
            />
            <span className="letter">{String.fromCharCode(65 + i)}</span>
            <span className="grow">
              <Markdown src={o} />
            </span>
          </label>
        );
      })}
    </div>
  );
}

// Maths working, one line per step
function Steps({ value, onChange, attemptId, q, disabled }) {
  const steps = value.steps && value.steps.length ? value.steps : [''];
  const refs = useRef([]);
  const [focusIdx, setFocusIdx] = useState(null);
  useEffect(() => {
    if (focusIdx != null) {
      refs.current[focusIdx]?.focus();
      setFocusIdx(null);
    }
  }, [focusIdx, steps.length]);
  const set = (next) => onChange({ ...value, steps: next });
  return (
    <div className="stack sm">
      <div className="muted small">Write one step per line. Press Enter for a new line. Type fractions with /, powers with ^, roots with “sqrt”.</div>
      <div className="steps">
        {steps.map((s, i) => (
          <div className="stepline" key={i}>
            <span className="n">{i + 1}</span>
            <MathField
              ref={(r) => (refs.current[i] = r)}
              value={s}
              readOnly={disabled}
              label={`Step ${i + 1}`}
              placeholder={i === 0 ? 'Start here…' : ''}
              onChange={(v) => set(steps.map((x, j) => (j === i ? v : x)))}
              onEnter={() => {
                const next = [...steps];
                next.splice(i + 1, 0, '');
                set(next);
                setFocusIdx(i + 1);
              }}
              onBackspaceEmpty={() => {
                if (steps.length <= 1) return;
                set(steps.filter((_, j) => j !== i));
                setFocusIdx(Math.max(0, i - 1));
              }}
            />
            {!disabled && steps.length > 1 && (
              <button className="btn sm ghost icon" aria-label={`Remove step ${i + 1}`} onClick={() => set(steps.filter((_, j) => j !== i))}>
                <Icon name="x" size={16} />
              </button>
            )}
          </div>
        ))}
      </div>
      {!disabled && (
        <div className="row wrap">
          <button
            className="btn sm"
            onClick={() => {
              set([...steps, '']);
              setFocusIdx(steps.length);
            }}
          >
            <Icon name="plus" size={16} /> Add a line
          </button>
        </div>
      )}
      <Photos value={value} onChange={onChange} attemptId={attemptId} q={q} disabled={disabled} optional label="Or add a photo of working on paper" />
    </div>
  );
}

// Photos / scans of work on paper
function Photos({ value, onChange, attemptId, q, disabled, optional, label }) {
  const toast = useToast();
  const input = useRef(null);
  const [cam, setCam] = useState(false);
  const [light, setLight] = useState(null);
  const [busy, setBusy] = useState(false);
  const files = value.files || [];

  async function add(blobs) {
    setBusy(true);
    try {
      const added = [];
      for (const b of blobs) {
        const small = await compressImage(b);
        added.push(await api.saveWorkImage(attemptId, q.id, small, b.name || 'photo.jpg'));
      }
      onChange({ ...value, files: [...files, ...added] });
    } catch (e) {
      toast({ title: 'Couldn’t add the photo', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  if (optional && disabled && !files.length) return null;
  return (
    <div className="stack sm">
      {files.length > 0 && (
        <div className="thumbs">
          {files.map((f) => (
            <WorkThumb key={f.path} path={f.path} onOpen={setLight} onRemove={disabled ? null : () => onChange({ ...value, files: files.filter((x) => x.path !== f.path) })} />
          ))}
        </div>
      )}
      {!disabled && (
        <div className="row wrap">
          {optional && !files.length && <span className="small muted">{label || 'You can also add a photo.'}</span>}
          <button className="btn sm" onClick={() => input.current.click()} disabled={busy}>
            <Icon name="image" size={16} /> {files.length ? 'Add another photo' : 'Choose a photo or scan'}
          </button>
          {navigator.mediaDevices?.getUserMedia && (
            <button className="btn sm" onClick={() => setCam(true)} disabled={busy}>
              <Icon name="camera" size={16} /> Use camera
            </button>
          )}
          {busy && <span className="save-state"><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Adding…</span>}
          <input ref={input} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => (add([...e.target.files]), (e.target.value = ''))} />
        </div>
      )}
      {cam && (
        <CameraCapture
          onClose={() => setCam(false)}
          onShot={(b) => {
            setCam(false);
            add([b]);
          }}
        />
      )}
      {light && <Lightbox src={light} onClose={() => setLight(null)} />}
    </div>
  );
}

export function CameraCapture({ onClose, onShot }) {
  const video = useRef(null);
  const [err, setErr] = useState('');
  const [facing, setFacing] = useState('environment');
  useEffect(() => {
    let stream = null;
    let alive = true;
    (async () => {
      try {
        await window.studybridge?.askMedia?.();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (!alive) return stream.getTracks().forEach((t) => t.stop());
        video.current.srcObject = stream;
        await video.current.play();
      } catch {
        setErr('Couldn’t open the camera. Check that StudyBridge is allowed to use it.');
      }
    })();
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [facing]);
  function shoot() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    c.toBlob((b) => b && onShot(Object.assign(b, { name: 'photo.jpg' })), 'image/jpeg', 0.9);
  }
  return (
    <Modal
      title="Take a photo of your work"
      wide
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}>
            <Icon name="refresh" size={16} /> Switch camera
          </button>
          <button className="btn primary" onClick={shoot} disabled={!!err}>
            <Icon name="camera" size={16} /> Take photo
          </button>
        </>
      }
    >
      {err ? <div className="error">{err}</div> : <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 12, background: '#111', maxHeight: '60vh' }} />}
      <div className="muted small">Hold the page flat and fill the frame. Good light helps.</div>
    </Modal>
  );
}

function Drawing({ value, onChange, disabled }) {
  return <DrawingPad initial={value.strokes || []} readOnly={disabled} grid onChange={(strokes) => onChange({ strokes })} label="Your drawing" />;
}
