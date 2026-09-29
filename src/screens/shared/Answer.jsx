import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Markdown } from '../../ui/kit.jsx';
import { StoredImage, WorkThumb, Lightbox } from '../../ui/media.jsx';
import { MathStatic } from '../../ui/MathField.jsx';
import DrawingPad from '../../ui/DrawingPad.jsx';
import { items, multi } from '../../lib/questions.js';

export function QuestionPrompt({ q }) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      {q.prompt_md ? <Markdown src={q.prompt_md} className="qprompt" /> : <div className="muted">(No question text)</div>}
      {q.image_path && <StoredImage path={q.image_path} className="qimg" alt="Question diagram" onClick={() => setZoom(true)} style={{ cursor: 'zoom-in' }} />}
      {zoom && <ZoomStored path={q.image_path} onClose={() => setZoom(false)} />}
    </>
  );
}

function ZoomStored({ path, onClose }) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <StoredImage path={path} style={{ maxWidth: '90vw', maxHeight: '85vh', borderRadius: 10, background: '#fff' }} />
    </div>
  );
}

// A learner's answer, shown for marking (tutor) or results (learner)
export function AnswerDisplay({ q, answer = {}, mine: isMine = false, keyAns, stepMarks = [], onToggleStep, hints, annotation, onAnnotate }) {
  const [light, setLight] = useState(null);
  const empty = !answer || !(answer.files || []).length;

  if (q.type === 'mcq') {
    const opts = items(q.options);
    const mine = multi(q.options) ? answer.choices || [] : answer.choice != null ? [answer.choice] : [];
    const right = keyAns ? (multi(q.options) ? keyAns.choices || [] : [keyAns.choice]) : null;
    return (
      <div className="stack sm">
        {opts.map((o, i) => {
          const picked = mine.includes(String(i));
          const isRight = right?.includes(String(i));
          const cls = picked && right ? (isRight ? 'right' : 'wrong') : picked ? 'on' : right && isRight ? 'right' : '';
          return (
            <div key={i} className={'opt ' + cls} style={{ cursor: 'default' }}>
              <span className="letter">{String.fromCharCode(65 + i)}</span>
              <span className="grow">
                <Markdown src={o} />
              </span>
              {picked && <span className="pill">{isMine ? 'Your answer' : 'Their answer'}</span>}
              {right && isRight && <Icon name="check" size={18} style={{ color: 'var(--good)' }} />}
            </div>
          );
        })}
        {mine.length === 0 && <div className="muted small">No option chosen.</div>}
      </div>
    );
  }
  if (q.type === 'numeric') {
    return (
      <div className="row wrap">
        <div className="markbox" style={{ fontSize: 18, fontWeight: 600 }}>
          {answer.value || <span className="muted">No answer</span>} {keyAns?.unit || ''}
        </div>
        {keyAns?.value != null && keyAns.value !== '' && (
          <span className="muted small">
            Correct: <b>{keyAns.value}</b>
            {Number(keyAns.tolerance) ? ` ± ${keyAns.tolerance}` : ''} {keyAns.unit || ''}
          </span>
        )}
      </div>
    );
  }
  if (q.type === 'short') {
    return (
      <div className="stack sm">
        <div className="note" style={{ background: '#fff' }}>{answer.text ? <Markdown src={answer.text} /> : <span className="muted">No answer</span>}</div>
        {keyAns?.text && (
          <div className="small">
            <span className="muted">Model answer: </span>
            {keyAns.text}
          </div>
        )}
        <Files answer={answer} onOpen={setLight} />
        {light && <Lightbox src={light} onClose={() => setLight(null)} />}
      </div>
    );
  }
  if (q.type === 'steps') {
    const lines = (answer.steps || []).filter((s) => s && s.trim());
    return (
      <div className="stack sm">
        {lines.length === 0 && <div className="muted">No working written.</div>}
        <div className="steps">
          {lines.map((l, i) => {
            const m = stepMarks[i];
            const h = hints?.steps?.[i];
            return (
              <div key={i} className={'stepline ' + (m?.ok === true ? 'ok' : m?.ok === false ? 'no' : '')}>
                <span className="n">{i + 1}</span>
                <div className="rendered">
                  <MathStatic latex={l} />
                </div>
                {h === 'ok' && <span className="hintdot ok" title="This line follows from the one before">follows</span>}
                {h === 'check' && <span className="hintdot check" title="This line doesn't seem to follow from the one before">check this</span>}
                {onToggleStep ? (
                  <span className="mark">
                    <button className="tick ok" aria-pressed={m?.ok === true} aria-label={`Step ${i + 1} correct`} onClick={() => onToggleStep(i, m?.ok === true ? null : true)}>
                      <Icon name="check" size={16} />
                    </button>
                    <button className="tick no" aria-pressed={m?.ok === false} aria-label={`Step ${i + 1} wrong`} onClick={() => onToggleStep(i, m?.ok === false ? null : false)}>
                      <Icon name="x" size={16} />
                    </button>
                  </span>
                ) : m?.ok === true ? (
                  <Icon name="check" style={{ color: 'var(--good)' }} />
                ) : m?.ok === false ? (
                  <Icon name="x" style={{ color: 'var(--red)' }} />
                ) : null}
              </div>
            );
          })}
        </div>
        {hints?.final === true && <div className="small" style={{ color: 'var(--good-ink)' }}><Icon name="check" size={14} /> Last line matches your final answer.</div>}
        {hints?.final === false && <div className="small" style={{ color: 'var(--amber-ink)' }}><Icon name="alert" size={14} /> Last line doesn’t match your final answer.</div>}
        {keyAns?.final && (
          <div className="small row">
            <span className="muted">Final answer:</span> <MathStatic latex={keyAns.final} />
          </div>
        )}
        <Files answer={answer} onOpen={setLight} />
        {light && <Lightbox src={light} onClose={() => setLight(null)} />}
      </div>
    );
  }
  // upload / drawing
  const strokes = q.type === 'drawing' ? answer?.strokes || [] : [];
  return (
    <div className="stack sm">
      {q.type === 'drawing' && strokes.length > 0 && (
        <>
          <DrawingPad initial={strokes} readOnly grid label="Their drawing" />
          {onAnnotate && (
            <div>
              <button className="btn sm" onClick={() => onAnnotate({ strokes })}>
                <Icon name="pen" size={14} /> Mark on it
              </button>
            </div>
          )}
        </>
      )}
      {empty && !strokes.length && <div className="muted">{q.type === 'drawing' ? 'Nothing drawn.' : 'Nothing uploaded.'}</div>}
      <Files answer={answer} onOpen={setLight} onAnnotate={onAnnotate} />
      {annotation && (
        <div className="stack sm">
          <div className="label">Marked copy</div>
          <div className="thumbs">
            <WorkThumb path={annotation} onOpen={setLight} />
          </div>
        </div>
      )}
      {light && <Lightbox src={light} onClose={() => setLight(null)} />}
    </div>
  );
}

function Files({ answer, onOpen, onAnnotate }) {
  const files = answer?.files || [];
  if (!files.length) return null;
  return (
    <div className="thumbs">
      {files.map((f) => (
        <div key={f.path} className="stack sm" style={{ gap: 4 }}>
          <WorkThumb path={f.path} onOpen={onOpen} />
          {onAnnotate && (
            <button className="btn sm" onClick={() => onAnnotate(f.path)}>
              <Icon name="pen" size={14} /> Mark on it
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
