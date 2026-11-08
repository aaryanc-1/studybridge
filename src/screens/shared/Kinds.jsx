// The new question types (step 6): what learners fill in, and how an answer shows for marking and results.
// Fill in the blanks, matching, put in order and label a picture are marked by StudyBridge part by part;
// "Record an answer" and "Hand in a file" are marked by the teacher.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../../ui/Icon.jsx';
import { Markdown, useToast } from '../../ui/kit.jsx';
import { StoredImage, WorkThumb, Lightbox } from '../../ui/media.jsx';
import { FileChip, RecordButtons, Recordings, isMedia, MODES } from '../../ui/Recorder.jsx';
import { renderMarkdown } from '../../lib/markdown.js';
import { gapRight, recordMax, recordModes, wordCount } from '../../lib/qkinds.js';
import { linkTitle, linkIcon, safeUrl } from '../../lib/links.js';
import * as api from '../../lib/api.js';

const blank = (v) => v == null || v === '';

// ---------------- fill in the blanks ----------------
// The question's text with a box (or a list) in each gap. Inputs go into the rendered text through portals.
function GappedText({ prompt, renderGap }) {
  const ref = useRef(null);
  const [slots, setSlots] = useState([]);
  const html = useMemo(
    () => renderMarkdown(prompt || '').replace(/\[\[(\d+)\]\]/g, (_, d) => `<span class="gap-slot" data-gap="${Number(d) - 1}"></span>`),
    [prompt],
  );
  useLayoutEffect(() => {
    setSlots(ref.current ? [...ref.current.querySelectorAll('.gap-slot')] : []);
  }, [html]);
  return (
    <div className="qprompt cloze" ref={ref}>
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
      {slots.map((el, i) => createPortal(renderGap(Number(el.dataset.gap)), el, `g${i}`))}
    </div>
  );
}

export function ClozeInput({ q, value, onChange, disabled }) {
  const gaps = q.options?.gaps || [];
  const vals = value.gaps || [];
  const set = (i, v) => {
    const next = gaps.map((_, j) => (j === i ? v : vals[j] ?? ''));
    onChange({ gaps: next });
  };
  return (
    <GappedText
      prompt={q.prompt_md}
      renderGap={(i) =>
        gaps[i]?.choices ? (
          <select className="gap-select" value={vals[i] ?? ''} disabled={disabled} onChange={(e) => set(i, e.target.value)} aria-label={`Blank ${i + 1}`}>
            <option value="">Choose…</option>
            {gaps[i].choices.map((c, j) => (
              <option key={j} value={String(j)}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="gap-input"
            value={vals[i] ?? ''}
            disabled={disabled}
            size={Math.max(6, Math.min(24, String(vals[i] ?? '').length + 2))}
            onChange={(e) => set(i, e.target.value)}
            aria-label={`Blank ${i + 1}`}
            autoComplete="off"
            spellCheck={false}
          />
        )
      }
    />
  );
}

function ClozeShow({ q, answer, keyAns }) {
  const gaps = q.options?.gaps || [];
  const vals = answer.gaps || [];
  return (
    <GappedText
      prompt={q.prompt_md}
      renderGap={(i) => {
        const g = gaps[i] || {};
        const v = vals[i];
        const shown = g.choices ? g.choices[Number(v)] : v;
        const ok = keyAns?.gaps ? gapRight(v, keyAns.gaps[i]) : null;
        const right = keyAns?.gaps?.[i] ? (g.choices ? g.choices[Number(keyAns.gaps[i].choice)] : (keyAns.gaps[i].accept || [])[0]) : null;
        return (
          <span className={'gap-show' + (ok === true ? ' right' : ok === false ? ' wrong' : '')}>
            {blank(shown) ? <span className="muted">blank {i + 1}</span> : shown}
            {ok === false && right && <span className="gap-fix"> {right}</span>}
          </span>
        );
      }}
    />
  );
}

// ---------------- matching ----------------
export function MatchInput({ q, value, onChange, disabled }) {
  const left = q.options?.left || [];
  const right = q.options?.right || [];
  const pairs = value.pairs || [];
  return (
    <div className="match-list">
      {left.map((l, i) => (
        <div key={i} className="match-row">
          <div className="match-item">
            <Markdown src={l} />
          </div>
          <Icon name="right" size={16} className="muted" />
          <select
            className="select"
            value={pairs[i] ?? ''}
            disabled={disabled}
            aria-label={`Match for ${l}`}
            onChange={(e) => onChange({ pairs: left.map((_, j) => (j === i ? e.target.value || null : pairs[j] ?? null)) })}
          >
            <option value="">Choose…</option>
            {right.map((r, j) => (
              <option key={j} value={String(j)}>
                {r}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}
function MatchShow({ q, answer, keyAns }) {
  const left = q.options?.left || [];
  const right = q.options?.right || [];
  const pairs = answer.pairs || [];
  return (
    <div className="match-list">
      {left.map((l, i) => {
        const v = pairs[i];
        const ok = keyAns?.pairs ? !blank(v) && String(v) === String(keyAns.pairs[i]) : null;
        return (
          <div key={i} className="match-row">
            <div className="match-item">
              <Markdown src={l} />
            </div>
            <Icon name="right" size={16} className="muted" />
            <span className={'gap-show' + (ok === true ? ' right' : ok === false ? ' wrong' : '')}>
              {blank(v) ? <span className="muted">nothing chosen</span> : right[Number(v)]}
              {ok === false && <span className="gap-fix"> {right[Number(keyAns.pairs[i])]}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------- put in order ----------------
export function OrderInput({ q, value, onChange, disabled }) {
  const items = q.options?.items || [];
  const touched = Array.isArray(value.order) && value.order.length === items.length;
  const order = touched ? value.order : items.map((_, i) => String(i));
  const move = (i, d) => {
    const next = [...order];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    onChange({ order: next });
  };
  return (
    <div className="stack sm">
      <ol className="order-list">
        {order.map((idx, i) => (
          <li key={idx} className="order-row">
            <span className="order-n">{i + 1}</span>
            <span className="grow">
              <Markdown src={items[Number(idx)] ?? ''} />
            </span>
            {!disabled && (
              <span className="row" style={{ gap: 4 }}>
                <button type="button" className="btn sm ghost icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move “${items[Number(idx)]}” up`}>
                  <Icon name="up" size={16} />
                </button>
                <button type="button" className="btn sm ghost icon" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={`Move “${items[Number(idx)]}” down`}>
                  <Icon name="down" size={16} />
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {!disabled && !touched && (
        <div className="row wrap">
          <span className="small muted">Move them with the arrows, first at the top.</span>
          <button type="button" className="btn sm" onClick={() => onChange({ order })}>
            <Icon name="check" size={14} /> This order is my answer
          </button>
        </div>
      )}
    </div>
  );
}
function OrderShow({ q, answer, keyAns }) {
  const items = q.options?.items || [];
  const order = answer.order || [];
  if (!order.length) return <div className="muted">No order given.</div>;
  return (
    <div className="stack sm">
      <ol className="order-list">
        {order.map((idx, i) => {
          const ok = keyAns?.order ? String(keyAns.order[i]) === String(idx) : null;
          return (
            <li key={idx} className={'order-row' + (ok === true ? ' right' : ok === false ? ' wrong' : '')}>
              <span className="order-n">{i + 1}</span>
              <span className="grow">
                <Markdown src={items[Number(idx)] ?? ''} />
              </span>
              {ok === true && <Icon name="check" size={16} style={{ color: 'var(--good)' }} />}
            </li>
          );
        })}
      </ol>
      {keyAns?.order && order.some((x, i) => String(keyAns.order[i]) !== String(x)) && (
        <div className="small">
          <span className="muted">Right order: </span>
          {keyAns.order.map((i) => items[Number(i)]).join(' → ')}
        </div>
      )}
    </div>
  );
}

// ---------------- label a picture ----------------
export function LabelPicture({ q, children, onSpot }) {
  const spots = q.options?.spots || [];
  return (
    <div className="label-pic">
      {q.image_path && <StoredImage path={q.image_path} className="label-img" alt="The picture to label" />}
      {spots.map((s, i) => (
        <span key={i} className="label-spot" style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%` }} aria-hidden="true" onClick={onSpot ? (e) => onSpot(i, e) : undefined}>
          {i + 1}
        </span>
      ))}
      {children}
    </div>
  );
}
export function LabelInput({ q, value, onChange, disabled }) {
  const spots = q.options?.spots || [];
  const labels = q.options?.labels || [];
  const vals = value.spots || [];
  return (
    <div className="stack">
      <LabelPicture q={q} />
      <div className="match-list">
        {spots.map((_, i) => (
          <div key={i} className="match-row">
            <span className="label-spot inline">{i + 1}</span>
            <select
              className="select"
              value={vals[i] ?? ''}
              disabled={disabled}
              aria-label={`Label ${i + 1}`}
              onChange={(e) => onChange({ spots: spots.map((__, j) => (j === i ? e.target.value || null : vals[j] ?? null)) })}
            >
              <option value="">Choose…</option>
              {labels.map((l, j) => (
                <option key={j} value={String(j)}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
function LabelShow({ q, answer, keyAns }) {
  const spots = q.options?.spots || [];
  const labels = q.options?.labels || [];
  const vals = answer.spots || [];
  return (
    <div className="stack">
      <LabelPicture q={q} />
      <div className="match-list">
        {spots.map((_, i) => {
          const v = vals[i];
          const ok = keyAns?.spots ? !blank(v) && String(v) === String(keyAns.spots[i]) : null;
          return (
            <div key={i} className="match-row">
              <span className="label-spot inline">{i + 1}</span>
              <span className={'gap-show' + (ok === true ? ' right' : ok === false ? ' wrong' : '')}>
                {blank(v) ? <span className="muted">nothing chosen</span> : labels[Number(v)]}
                {ok === false && <span className="gap-fix"> {labels[Number(keyAns.spots[i])]}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------- record an answer ----------------
export function RecordInput({ q, value, onChange, attemptId, disabled, locked }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const files = value.files || [];
  async function add(blob, info) {
    setBusy(true);
    try {
      const f = await api.saveWorkFile(attemptId, q.id, blob, `${MODES[info.kind]?.label || 'Recording'} ${files.length + 1}`);
      onChange({ ...value, files: [...files, { ...f, sec: info.sec }] });
    } catch (e) {
      toast({ title: 'Couldn’t keep the recording', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack sm">
      <Recordings files={files} onRemove={disabled ? null : (f) => onChange({ ...value, files: files.filter((x) => x.path !== f.path) })} />
      {!disabled &&
        (files.length < 3 ? (
          <div className="row wrap">
            <RecordButtons modes={recordModes(q.options).filter((m) => !locked || m !== 'screen')} max={recordMax(q.options)} onDone={add} disabled={busy} label={(m) => (files.length ? `Record ${MODES[m].label.toLowerCase()} again` : `Record ${MODES[m].label.toLowerCase()}`)} />
            {busy && <span className="save-state">Keeping it…</span>}
          </div>
        ) : (
          <div className="tiny muted">Up to 3 recordings. Remove one to record again.</div>
        ))}
    </div>
  );
}

// ---------------- hand in a file (or a link) ----------------
const MAX_FILE = 20 * 1024 * 1024;
export function FileInput({ q, value, onChange, attemptId, disabled, locked }) {
  const toast = useToast();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const files = value.files || [];
  const links = value.links || [];
  async function add(list) {
    setBusy(true);
    try {
      const added = [];
      for (const f of list) {
        if (files.length + added.length >= 5) break;
        if (f.size > MAX_FILE) {
          toast({ title: `${f.name} is too big`, body: 'Files can be up to 20 MB.', tone: 'bad' });
          continue;
        }
        added.push(await api.saveWorkFile(attemptId, q.id, f, f.name));
      }
      if (added.length) onChange({ ...value, files: [...files, ...added] });
    } catch (e) {
      toast({ title: 'Couldn’t add the file', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  function addLink(e) {
    e.preventDefault();
    const url = safeUrl(link);
    if (!url) return toast({ title: 'That isn’t a web link', body: 'Paste a link that starts with https://', tone: 'bad' });
    if (links.length >= 5) return;
    onChange({ ...value, links: [...links, { url, title: linkTitle(url) }] });
    setLink('');
  }
  return (
    <div className="stack sm">
      <WorkFiles files={files} onRemove={disabled ? null : (f) => onChange({ ...value, files: files.filter((x) => x.path !== f.path) })} />
      <LinkList links={links} onRemove={disabled ? null : (l) => onChange({ ...value, links: links.filter((x) => x.url !== l.url) })} />
      {!disabled && locked && <div className="note small">Files and links can’t be added during a locked-down or watched test. Ask your teacher.</div>}
      {!disabled && !locked && (
        <>
          <div className="row wrap">
            <button type="button" className="btn sm" onClick={() => input.current.click()} disabled={busy || files.length >= 5}>
              <Icon name="upload" size={16} /> {files.length ? 'Add another file' : 'Choose a file'}
            </button>
            <RecordButtons modes={['audio', 'video', 'screen']} onDone={(blob, info) => add([Object.assign(blob, { name: `${MODES[info.kind].label} recording.${blob.type.includes('mp4') ? 'mp4' : 'webm'}` })])} disabled={busy || files.length >= 5} />
            {busy && <span className="save-state">Adding…</span>}
            <input ref={input} type="file" multiple hidden onChange={(e) => (add([...e.target.files]), (e.target.value = ''))} />
          </div>
          <form className="row" onSubmit={addLink}>
            <input className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Or paste a link (Google Docs, OneDrive, a website…)" aria-label="A link to your work" />
            <button className="btn sm" disabled={!link.trim() || links.length >= 5}>
              <Icon name="link" size={16} /> Add link
            </button>
          </form>
          {links.length > 0 && <div className="tiny muted">Make sure your teacher can open your links (in Google Docs or OneDrive: Share, then add your teacher).</div>}
        </>
      )}
    </div>
  );
}

// Files in an answer: pictures as pictures, recordings to play, anything else to open
export function WorkFiles({ files, onOpen, onAnnotate, onRemove }) {
  const [light, setLight] = useState(null);
  const list = files || [];
  if (!list.length) return null;
  const pics = list.filter((f) => String(f.type || '').startsWith('image/') || (!f.type && /\.(png|jpe?g|gif|webp)$/i.test(f.path)));
  const media = list.filter((f) => !pics.includes(f) && isMedia(f));
  const others = list.filter((f) => !pics.includes(f) && !media.includes(f));
  const open = onOpen || setLight;
  return (
    <div className="stack sm">
      {pics.length > 0 && (
        <div className="thumbs">
          {pics.map((f) => (
            <div key={f.path} className="stack sm" style={{ gap: 4 }}>
              <WorkThumb path={f.path} onOpen={open} onRemove={onRemove ? () => onRemove(f) : null} />
              {onAnnotate && (
                <button className="btn sm" onClick={() => onAnnotate(f.path)}>
                  <Icon name="pen" size={14} /> Mark on it
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <Recordings files={media} onRemove={onRemove} />
      {others.length > 0 && (
        <div className="row wrap" style={{ gap: 8 }}>
          {others.map((f) => (
            <span key={f.path} className="row" style={{ gap: 4 }}>
              <FileChip f={f} />
              {onRemove && (
                <button type="button" className="btn sm ghost icon" onClick={() => onRemove(f)} aria-label={`Remove ${f.name}`}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {light && !onOpen && <Lightbox src={light} onClose={() => setLight(null)} />}
    </div>
  );
}

// Links (Google Docs, OneDrive, websites): open in the browser
export function LinkList({ links, onRemove }) {
  if (!links?.length) return null;
  return (
    <div className="row wrap" style={{ gap: 8 }}>
      {links.map((l) => (
        <span key={l.url} className="row" style={{ gap: 4 }}>
          <a className="btn sm link-chip" href={l.url} target="_blank" rel="noreferrer noopener">
            <Icon name={linkIcon(l)} size={15} /> {l.title || linkTitle(l.url)}
          </a>
          {onRemove && (
            <button type="button" className="btn sm ghost icon" onClick={() => onRemove(l)} aria-label={`Remove ${l.title || 'link'}`}>
              <Icon name="x" size={14} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

// A written answer's word guide ("120 words · aim for 150 to 250")
export function WordGuide({ q, text }) {
  const w = q.options?.words;
  if (!w || (!w[0] && !w[1])) return null;
  const n = wordCount(text);
  const aim = w[0] && w[1] ? `aim for ${w[0]} to ${w[1]}` : w[0] ? `at least ${w[0]}` : `up to ${w[1]}`;
  const off = (w[0] && n < w[0]) || (w[1] && n > w[1]);
  return (
    <div className="tiny" style={{ color: off ? 'var(--amber-ink)' : 'var(--ink-2)' }} aria-live="polite">
      {n} word{n === 1 ? '' : 's'} · {aim}
    </div>
  );
}

// One input for a new type (null for the older types)
export function KindInput(props) {
  const t = props.q.type;
  if (t === 'cloze') return <ClozeInput {...props} />;
  if (t === 'match') return <MatchInput {...props} />;
  if (t === 'order') return <OrderInput {...props} />;
  if (t === 'label') return <LabelInput {...props} />;
  if (t === 'record') return <RecordInput {...props} />;
  if (t === 'file') return <FileInput {...props} />;
  return null;
}
// One answer, shown for marking or results (null for the older types)
export function KindShow({ q, answer = {}, keyAns }) {
  const t = q.type;
  if (t === 'cloze') return <ClozeShow q={q} answer={answer} keyAns={keyAns} />;
  if (t === 'match') return <MatchShow q={q} answer={answer} keyAns={keyAns} />;
  if (t === 'order') return <OrderShow q={q} answer={answer} keyAns={keyAns} />;
  if (t === 'label') return <LabelShow q={q} answer={answer} keyAns={keyAns} />;
  if (t === 'record' || t === 'file') {
    const none = !(answer.files || []).length && !(answer.links || []).length;
    return (
      <div className="stack sm">
        {none && <div className="muted">{t === 'record' ? 'Nothing recorded.' : 'Nothing handed in.'}</div>}
        <WorkFiles files={answer.files} />
        <LinkList links={answer.links} />
        {keyAns?.text && (
          <div className="small">
            <span className="muted">Model answer: </span>
            {keyAns.text}
          </div>
        )}
      </div>
    );
  }
  return null;
}
