// Recordings (step 6, 7 Nov 2026): voice, camera video or the screen, recorded right here and kept as a file.
// Used for answers ("Record an answer"), teachers' feedback, notes and messages, class posts and portfolio pieces.
// The desktop app already lets StudyBridge use the microphone, camera and screen (live lessons need them);
// in a browser or on a phone, the browser asks the first time.
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { Modal, useToast } from './kit.jsx';
import { dataSaver } from '../lib/device.js';
import * as api from '../lib/api.js';
import { desktop } from '../lib/config.js';

export const canRecord = () => typeof window !== 'undefined' && typeof window.MediaRecorder === 'function' && !!navigator.mediaDevices?.getUserMedia;
const canScreen = () => canRecord() && !!navigator.mediaDevices?.getDisplayMedia;
export const MODES = {
  audio: { label: 'Voice', icon: 'mic', max: 600 },
  video: { label: 'Video', icon: 'video', max: 300 },
  screen: { label: 'Screen', icon: 'screen', max: 300 },
};
export const isMedia = (f) => /^(audio|video)\//.test(String(f?.type || '')) || /\.(webm|m4a|mp3|mp4|ogg|wav)$/i.test(String(f?.path || f?.name || ''));
const isVideo = (f) => String(f?.type || '').startsWith('video/') || (/\.(mp4|webm)$/i.test(String(f?.path || '')) && !String(f?.type || '').startsWith('audio/'));

function pickMime(kind) {
  const list =
    kind === 'audio'
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
      : ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return list.find((m) => window.MediaRecorder.isTypeSupported?.(m)) || '';
}
export const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// The buttons to start a recording (one per kind allowed). onDone(blob, { kind, sec })
export function RecordButtons({ modes = ['audio'], max, onDone, disabled, small = true, label }) {
  const [open, setOpen] = useState(null);
  if (!canRecord()) return <span className="tiny muted">This browser can’t record. Try Chrome, Edge, Safari or the StudyBridge app.</span>;
  const list = modes.filter((m) => MODES[m] && (m !== 'screen' || canScreen()));
  return (
    <>
      {list.map((m) => (
        <button key={m} type="button" className={'btn' + (small ? ' sm' : '')} disabled={disabled} onClick={() => setOpen(m)}>
          <Icon name={MODES[m].icon} size={16} /> {label ? label(m) : `Record ${MODES[m].label.toLowerCase()}`}
        </button>
      ))}
      {open && (
        <RecorderModal
          kind={open}
          max={Math.min(max || MODES[open].max, MODES[open].max)}
          onClose={() => setOpen(null)}
          onDone={(blob, info) => {
            setOpen(null);
            onDone(blob, info);
          }}
        />
      )}
    </>
  );
}

// Record, listen back, then keep it or try again
export function RecorderModal({ kind = 'audio', max = 180, onClose, onDone }) {
  const [state, setState] = useState('ready'); // ready | recording | done | error
  const [err, setErr] = useState('');
  const [sec, setSec] = useState(0);
  const [result, setResult] = useState(null); // { blob, url }
  const live = useRef(null);
  const streams = useRef([]);
  const rec = useRef(null);
  const chunks = useRef([]);
  const started = useRef(0);
  const timer = useRef(null);
  const urlRef = useRef(null);
  urlRef.current = result?.url || null;

  const stopStreams = () => {
    streams.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streams.current = [];
  };
  useEffect(
    () => () => {
      clearInterval(timer.current);
      try {
        if (rec.current?.state === 'recording') rec.current.stop();
      } catch {
        /* already stopped */
      }
      stopStreams();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function start() {
    setErr('');
    try {
      await desktop?.askMedia?.();
      const md = navigator.mediaDevices;
      let stream;
      if (kind === 'audio') stream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      else if (kind === 'video') stream = await md.getUserMedia({ audio: true, video: { width: { ideal: dataSaver() ? 480 : 640 }, height: { ideal: dataSaver() ? 360 : 480 }, facingMode: 'user' } });
      else {
        const screen = await md.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
        streams.current.push(screen);
        let voice = null;
        try {
          voice = await md.getUserMedia({ audio: true });
          streams.current.push(voice);
        } catch {
          /* no microphone: the screen alone */
        }
        stream = new MediaStream([...screen.getVideoTracks(), ...(voice ? voice.getAudioTracks() : [])]);
        // Stopping the share from the browser's own bar ends the recording
        screen.getVideoTracks()[0]?.addEventListener('ended', () => stop());
      }
      streams.current.push(stream);
      if (kind !== 'audio' && live.current) {
        live.current.srcObject = stream;
        live.current.play().catch(() => {});
      }
      const mimeType = pickMime(kind === 'audio' ? 'audio' : 'video');
      const low = dataSaver();
      const r = new window.MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: low ? 32000 : 64000,
        ...(kind === 'audio' ? {} : { videoBitsPerSecond: kind === 'screen' ? (low ? 400000 : 900000) : low ? 300000 : 700000 }),
      });
      chunks.current = [];
      r.ondataavailable = (e) => e.data?.size && chunks.current.push(e.data);
      r.onstop = () => {
        clearInterval(timer.current);
        stopStreams();
        const type = (r.mimeType || mimeType || (kind === 'audio' ? 'audio/webm' : 'video/webm')).split(';')[0];
        const blob = new Blob(chunks.current, { type });
        if (!blob.size) {
          setErr('Nothing was recorded. Try again.');
          return setState('ready');
        }
        setResult({ blob, url: URL.createObjectURL(blob) });
        setState('done');
      };
      rec.current = r;
      r.start(1000);
      started.current = Date.now();
      setSec(0);
      setState('recording');
      timer.current = setInterval(() => {
        const s = Math.floor((Date.now() - started.current) / 1000);
        setSec(s);
        if (s >= max) stop();
      }, 250);
    } catch (e) {
      stopStreams();
      setErr(
        e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
          ? `StudyBridge isn’t allowed to use the ${kind === 'screen' ? 'screen' : kind === 'video' ? 'camera and microphone' : 'microphone'}. Allow it in your browser’s or computer’s settings, then try again.`
          : e?.name === 'NotFoundError'
            ? `No ${kind === 'video' ? 'camera' : 'microphone'} found on this device.`
            : 'Couldn’t start recording. Try again.',
      );
      setState('ready');
    }
  }
  function stop() {
    try {
      if (rec.current?.state === 'recording') rec.current.stop();
    } catch {
      /* already stopped */
    }
  }
  function again() {
    if (result?.url) URL.revokeObjectURL(result.url);
    setResult(null);
    setSec(0);
    setState('ready');
  }

  const name = MODES[kind]?.label || 'Recording';
  return (
    <Modal
      title={`Record ${name.toLowerCase()}`}
      onClose={() => {
        stop();
        onClose();
      }}
      foot={
        state === 'done' ? (
          <>
            <button className="btn" onClick={again}>
              <Icon name="refresh" size={16} /> Record again
            </button>
            <button className="btn primary" onClick={() => onDone(result.blob, { kind, sec: Math.max(1, sec) })}>
              <Icon name="check" size={16} /> Use this recording
            </button>
          </>
        ) : state === 'recording' ? (
          <button className="btn danger" onClick={stop}>
            <Icon name="stop" size={16} /> Stop
          </button>
        ) : (
          <button className="btn primary" onClick={start}>
            <Icon name={MODES[kind]?.icon || 'mic'} size={16} /> Start recording
          </button>
        )
      }
    >
      <div className="stack">
        {kind !== 'audio' && state !== 'done' && <video ref={live} className="rec-live" muted playsInline aria-label="What’s being recorded" />}
        {state === 'done' && result && (kind === 'audio' ? <audio controls src={result.url} className="rec-play" /> : <video controls src={result.url} className="rec-live" playsInline />)}
        <div className="row" role="status" aria-live="polite">
          {state === 'recording' && <span className="rec-dot" aria-hidden="true" />}
          <span className="strong">{state === 'recording' ? `Recording ${clock(sec)}` : state === 'done' ? `Recorded ${clock(sec)}` : `Up to ${clock(max)}`}</span>
          {state === 'recording' && <span className="muted small">stops by itself at {clock(max)}</span>}
        </div>
        {state === 'ready' && kind === 'screen' && <div className="small muted">Your whole screen is recorded, with your voice if there’s a microphone.</div>}
        {err && <div className="error">{err}</div>}
      </div>
    </Modal>
  );
}

// Play a stored recording (on data saver: tap to load it first). words: what's said, for anyone who can't listen.
export function MediaPlay({ bucket = 'work', file }) {
  const [go, setGo] = useState(() => !dataSaver());
  if (!go)
    return (
      <button type="button" className="btn sm" onClick={() => setGo(true)}>
        <Icon name="play" size={16} /> Load the recording{file?.sec ? ` (${clock(file.sec)})` : ''}
      </button>
    );
  return <LoadedMedia bucket={bucket} file={file} />;
}
function LoadedMedia({ bucket, file }) {
  // played from a short-lived link, so videos aren't kept on the device (pictures are, for offline use)
  const [state, setState] = useState({ url: null, error: false });
  useEffect(() => {
    let alive = true;
    api.mediaUrl(bucket, file.path).then(
      (url) => alive && setState({ url, error: !url }),
      () => alive && setState({ url: null, error: true }),
    );
    return () => {
      alive = false;
    };
  }, [bucket, file.path]);
  if (state.error) return <div className="note small">Couldn’t load the recording.</div>;
  if (!state.url) return <div className="rec-wait" aria-label="Loading the recording" />;
  return (
    <div className="stack sm rec-item">
      {isVideo(file) ? <video controls preload="metadata" src={state.url} className="rec-live" playsInline aria-label={file.name || 'Recording'} /> : <audio controls preload="metadata" src={state.url} className="rec-play" aria-label={file.name || 'Recording'} />}
      {file.words && (
        <details className="small">
          <summary>What’s said</summary>
          <div className="muted">{file.words}</div>
        </details>
      )}
    </div>
  );
}

// A row of recordings, each with a remove button when onRemove is given
export function Recordings({ files, bucket = 'work', onRemove, onWords }) {
  const list = (files || []).filter(isMedia);
  if (!list.length) return null;
  return (
    <div className="stack sm">
      {list.map((f, i) => (
        <div key={f.path} className="rec-row">
          <MediaPlay bucket={bucket} file={f} />
          {(onRemove || onWords) && (
            <div className="row wrap" style={{ gap: 6 }}>
              {onWords && <WordsButton f={f} onSave={(w) => onWords(i, w)} />}
              {onRemove && (
                <button type="button" className="btn sm ghost" onClick={() => onRemove(f)} aria-label={`Remove recording ${i + 1}`}>
                  <Icon name="trash" size={14} /> Remove
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
function WordsButton({ f, onSave }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(f.words || '');
  return (
    <>
      <button type="button" className="btn sm ghost" onClick={() => setOpen(true)}>
        <Icon name="text" size={14} /> {f.words ? 'Change the words' : 'Add the words'}
      </button>
      {open && (
        <Modal
          title="What’s said in the recording"
          onClose={() => setOpen(false)}
          foot={
            <button
              className="btn primary"
              onClick={() => {
                onSave(text.trim().slice(0, 4000));
                setOpen(false);
              }}
            >
              Save
            </button>
          }
        >
          <div className="small muted">For anyone who can’t listen: they can read it under the recording.</div>
          <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} aria-label="What’s said" />
        </Modal>
      )}
    </>
  );
}

// Open or save a stored file that isn't a picture or a recording
export function FileChip({ f, bucket = 'work' }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function open() {
    setBusy(true);
    try {
      const blob = await api.getBlob(bucket, f.path);
      if (desktop?.saveFile) return void (await desktop.saveFile(f.name || 'file', new Uint8Array(await blob.arrayBuffer())));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = f.name || 'file';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      toast({ title: 'Couldn’t open it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="btn sm stream-file" onClick={open} disabled={busy} aria-label={`Download ${f.name || 'file'}`}>
      <Icon name={/pdf$/i.test(f.name || '') ? 'pdf' : 'file'} size={15} /> {f.name || 'File'}
      {f.size ? <span className="tiny muted"> · {f.size > 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB'}</span> : null}
    </button>
  );
}
