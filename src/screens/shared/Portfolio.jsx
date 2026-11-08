// Portfolios (6 Nov 2026): the pieces a learner chooses to show (photos, files, a few words, or a piece of their marked
// work) and pieces their teachers add. A learner's piece goes to the places they pick ("Just me" keeps it to
// themselves); a piece of work only to the place that set it; a teacher's piece stays with their place. Parents see every
// piece except "Just me" ones. Comments belong to one place: the learner and that place's teachers see them.
import { useMemo, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Loading, Modal, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { StoredImage } from '../../ui/media.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { compressImage } from '../../lib/image.js';
import { dataSaver } from '../../lib/device.js';
import { ago, day, kindLabel } from '../../lib/format.js';
import { StreamFiles } from './Stream.jsx';
import { RecordButtons } from '../../ui/Recorder.jsx';

const MAX_FILES = 6;
const MAX_BYTES = 20 * 1024 * 1024;
const first = (name) => String(name || '').split(' ')[0];
const refresh = () => invalidate('portfolio', 'portfolio-item');
const isPic = (f) => String(f.type || '').startsWith('image/');
const workLine = (s) => (s ? [s.subject, kindLabel[s.kind] || s.kind, s.score != null && s.max ? `${s.score}/${s.max}` : null, s.from].filter(Boolean).join(' · ') : '');

// A whole portfolio: the learner's own (learnerId null), a parent's child's, or a teacher's view of a learner they teach
export default function Portfolio({ learnerId = null, compact = false, limit = 0 }) {
  const app = useApp();
  const q = useQuery(`portfolio:${learnerId || 'me'}`, () => api.myPortfolio(learnerId));
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);
  const d = q.data;
  if (!d) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  const own = !learnerId || learnerId === app.me.id;
  const staff = app.me.role === 'tutor';
  const items = limit ? d.items.slice(0, limit) : d.items;
  const name = first(d.learner.name);
  return (
    <div className="stack">
      {!compact && (
        <div className="row between wrap" style={{ gap: 8 }}>
          <span className="small muted">
            {own
              ? 'Work you’re proud of. Pick who sees each piece: your teachers, or just you. Your parents see everything except “Just me” pieces.'
              : staff
                ? `What ${name} shows your school or you, and pieces teachers here added. Comments stay between ${name} and the teachers here.`
                : `What ${name} chose to show, and pieces their teachers added.`}
          </span>
          {d.can_add && (
            <button className="btn primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} /> {own ? 'Add a piece' : `Add to ${name}’s portfolio`}
            </button>
          )}
        </div>
      )}
      {items.length === 0 ? (
        compact ? null : (
          <Empty title="Nothing in the portfolio yet">
            {own ? 'Add a photo of something you made, a file, or a piece of marked work, with a few words about it.' : staff ? `When ${name} shows you a piece, or you add one, it shows here.` : `When ${name} or their teachers add a piece, it shows here.`}
          </Empty>
        )
      ) : (
        <div className="folio-grid">
          {items.map((i) => (
            <PieceCard key={i.id} i={i} onOpen={() => setOpen(i.id)} />
          ))}
        </div>
      )}
      {adding && <PieceEditor learnerId={learnerId || app.me.id} d={d} onClose={() => setAdding(false)} />}
      {open && <PieceView id={open} d={d} onClose={() => setOpen(null)} />}
    </div>
  );
}

function PieceCard({ i, onOpen }) {
  const pic = (i.files || []).find(isPic);
  return (
    <button type="button" className="folio-card" onClick={onOpen} aria-haspopup="dialog" aria-label={`Open ${i.title}`}>
      <div className="folio-thumb">
        {pic ? (
          <StoredImage bucket="work" path={pic.path} alt="" />
        ) : (
          <span className="folio-icon">
            <Icon name={i.snapshot ? 'checkCircle' : i.files?.length ? 'file' : 'text'} size={28} />
          </span>
        )}
      </div>
      <span className="folio-title">{i.title}</span>
      <span className="tiny muted">
        {i.by_teacher ? `Added by ${i.added_by}` : i.just_me ? 'Just me' : day(i.at)}
        {i.comments > 0 ? ` · ${i.comments} comment${i.comments === 1 ? '' : 's'}` : ''}
      </span>
      {i.by_teacher && <span className="pill accent folio-badge">Teacher’s pick</span>}
    </button>
  );
}

// One piece: its pictures and files, the work it came from, and the comments the viewer may see
function PieceView({ id, d, onClose }) {
  const app = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery(`portfolio-item:${id}`, () => api.portfolioItem(id));
  const [text, setText] = useState('');
  const [place, setPlace] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const i = q.data;
  if (editing && i) return <PieceEditor learnerId={i.learner_id} d={d} initial={i} onClose={() => setEditing(false)} />;
  const learner = i && i.side === 'learner';
  const staff = app.me.role === 'tutor';
  const places = i?.places || [];
  const commentPlace = place || (places.length === 1 ? places[0].id : '');
  async function comment(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.commentPortfolio(i.id, text.trim(), learner ? commentPlace || null : null);
      setText('');
      refresh();
    } catch (x) {
      toast({ title: 'Couldn’t comment', body: x.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!(await confirm({ title: 'Take this piece out?', body: 'It goes from the portfolio, with its pictures and files.', ok: 'Take it out', danger: true }))) return;
    try {
      await api.removePortfolioFiles((i.files || []).map((f) => f.path));
      await api.deletePortfolioItem(i.id);
      refresh();
      onClose();
    } catch (x) {
      toast({ title: 'Couldn’t take it out', body: x.message, tone: 'bad' });
    }
  }
  return (
    <Modal
      title={i?.title || 'Portfolio'}
      wide
      onClose={onClose}
      foot={
        i && (
          <>
            {i.can_delete && (
              <button className="btn ghost" onClick={remove}>
                Remove from portfolio
              </button>
            )}
            {i.can_edit && (
              <button className="btn" onClick={() => setEditing(true)}>
                <Icon name="pen" size={14} /> Change it
              </button>
            )}
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </>
        )
      }
    >
      {!i ? (
        q.error ? <div className="error">{q.error.message}</div> : <Loading />
      ) : (
        <div className="stack sm">
          <div className="tiny muted">
            {i.by_teacher ? `Added by ${i.added_by}` : 'Added by ' + (learner ? 'you' : first(d.learner.name))} · {day(i.at)}
            {i.class && ` · ${i.class.name}`}
            {i.places && (i.just_me ? ' · Just me' : i.places.length ? ` · Shown to ${i.places.map((p) => p.name).join(', ')}` : '')}
          </div>
          {i.snapshot && (
            <div className="folio-work">
              <Icon name="checkCircle" size={16} />
              <span className="grow">
                <span className="strong">{i.snapshot.title}</span>
                <span className="small muted"> · {workLine(i.snapshot)}</span>
              </span>
              {i.attempt_id && (
                <button className="btn sm" onClick={() => (onClose(), go(staff ? `/marking/${i.attempt_id}` : `/results/${i.attempt_id}`))}>
                  Open the work
                </button>
              )}
            </div>
          )}
          {i.body && <div className="folio-body">{i.body}</div>}
          <StreamFiles files={i.files} bucket="work" />
          {i.side !== 'parent' && (
            <div className="stack xs">
              <div className="strong small">Comments</div>
              {i.comments.length === 0 && <div className="small muted">{learner ? 'When a teacher comments, it shows here.' : 'No comments yet.'}</div>}
              {i.comments.map((c) => (
                <div key={c.id} className={'folio-comment' + (c.mine ? ' mine' : '')}>
                  <span className="strong small">{c.mine ? 'You' : c.author}</span>
                  {learner && places.length > 1 && <span className="tiny muted"> · {c.place}</span>}
                  <span className="tiny muted"> · {ago(c.at)}</span>
                  {c.can_delete && (
                    <button
                      type="button"
                      className="linkbtn tiny"
                      style={{ marginLeft: 6 }}
                      onClick={async () => {
                        try {
                          await api.deletePortfolioComment(c.id);
                          refresh();
                        } catch (x) {
                          toast({ title: 'Couldn’t delete it', body: x.message, tone: 'bad' });
                        }
                      }}
                    >
                      Delete
                    </button>
                  )}
                  <div className="small">{c.body}</div>
                </div>
              ))}
              {(staff || (learner && places.length > 0)) && (
                <form className="composer" onSubmit={comment}>
                  {learner && places.length > 1 && (
                    <select className="input" value={place} onChange={(e) => setPlace(e.target.value)} aria-label="Who it’s for">
                      <option value="">For…</option>
                      {places.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <textarea className="textarea" rows={1} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a comment…" aria-label="Comment" />
                  <button className="btn primary icon" disabled={busy || !text.trim() || (learner && !commentPlace)} aria-label="Send comment">
                    <Icon name="send" size={18} />
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// Add a piece, or change one: title, a few words, pictures and files, a piece of marked work, a class, and who sees it
export function PieceEditor({ learnerId, d, initial = null, attemptId = null, onClose }) {
  const app = useApp();
  const toast = useToast();
  const staff = app.me.role === 'tutor';
  const id = useMemo(() => initial?.id || api.newId(), [initial]);
  const [title, setTitle] = useState(initial?.title || '');
  const [body, setBody] = useState(initial?.body || '');
  const [files, setFiles] = useState(initial?.files || []);
  const [added, setAdded] = useState([]); // uploaded here, removed again if this is closed without saving
  const [attempt, setAttempt] = useState(initial?.attempt_id || attemptId || '');
  const [classId, setClassId] = useState(initial?.class?.id || '');
  const work = (d?.work || []).find((w) => w.id === attempt);
  const allPlaces = d?.places || [];
  const [places, setPlaces] = useState(() => (initial ? (initial.places || []).map((p) => p.id) : allPlaces.map((p) => p.id)));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  async function addFiles(list) {
    const room = MAX_FILES - files.length;
    const pick = [...list].slice(0, room);
    if (list.length > room) toast({ title: `Up to ${MAX_FILES} pictures or files a piece`, tone: 'bad' });
    setUploading(true);
    try {
      for (const raw of pick) {
        const f = isPic(raw) ? await compressImage(raw, dataSaver() ? 1280 : 2000, dataSaver() ? 0.72 : 0.85) : raw;
        if ((f.size || 0) > MAX_BYTES) {
          toast({ title: 'Files can be up to 20 MB', tone: 'bad' });
          continue;
        }
        const up = await api.uploadPortfolioFile(learnerId, id, f.name ? f : new File([f], raw.name, { type: f.type || raw.type }));
        setFiles((x) => [...x, up]);
        setAdded((x) => [...x, up.path]);
      }
    } catch (x) {
      toast({ title: 'Couldn’t add that', body: x.message, tone: 'bad' });
    } finally {
      setUploading(false);
    }
  }
  function close() {
    api.removePortfolioFiles(added);
    onClose();
  }
  async function save() {
    setBusy(true);
    try {
      await api.savePortfolioItem(id, learnerId, {
        title: title.trim() || work?.title || '',
        body,
        files,
        attempt_id: attempt || null,
        class_id: classId || null,
        places: staff ? null : places,
      });
      // pictures taken out while changing it go too
      const gone = (initial?.files || []).filter((f) => !files.some((x) => x.path === f.path)).map((f) => f.path);
      api.removePortfolioFiles(gone);
      refresh();
      toast(initial ? 'Saved' : staff ? 'Added. They and their parents are told.' : 'Added to your portfolio');
      onClose();
    } catch (x) {
      toast({ title: 'Couldn’t save', body: x.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={initial ? 'Change this piece' : staff ? `Add to ${first(d?.learner?.name)}’s portfolio` : 'Add to my portfolio'}
      wide
      onClose={close}
      foot={
        <>
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || uploading || !(title.trim() || work)} onClick={save}>
            {initial ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      {(d?.work || []).length > 0 && (
        <Field label="A piece of marked work" hint="Optional. Its title and marks come with it.">
          <select className="input" value={attempt} onChange={(e) => setAttempt(e.target.value)}>
            <option value="">None</option>
            {d.work.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title} · {w.from} · {day(w.at)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Title">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} placeholder={work?.title || 'My science poster'} />
      </Field>
      <Field label={staff ? 'Why it’s here' : 'About it'} hint={staff ? undefined : 'What it is, what you’re proud of, what you’d do differently.'}>
        <textarea className="textarea" rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <div className="stack xs">
        <div className="strong small">Pictures and files</div>
        {staff && d?.photos === false && <div className="note small">{first(d.learner.name)}’s family said no photos of them. Pictures of their work are fine; leave them out of the picture.</div>}
        {files.length > 0 && (
          <div className="row wrap" style={{ gap: 6 }}>
            {files.map((f) => (
              <span key={f.path} className="chip">
                <Icon name={isPic(f) ? 'image' : 'file'} size={14} /> {f.name}
                <button type="button" className="linkbtn tiny" onClick={() => setFiles((x) => x.filter((y) => y.path !== f.path))} aria-label={`Take ${f.name} out`}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {files.length < MAX_FILES && (
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="btn sm" style={{ alignSelf: 'flex-start' }}>
              <Icon name="upload" size={14} /> {uploading ? 'Adding…' : 'Add pictures or files'}
              <input type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} aria-label="Add pictures or files" />
            </label>
            <RecordButtons
              modes={['audio', 'video']}
              max={300}
              disabled={uploading}
              label={(m) => (m === 'audio' ? 'Record your voice' : 'Record a video')}
              onDone={(blob, info) => addFiles([new File([blob], `${info.kind === 'audio' ? 'Voice' : 'Video'} recording.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`, { type: blob.type })])}
            />
          </div>
        )}
      </div>
      {(d?.classes || []).length > 0 && (
        <Field label="Class" hint="Optional.">
          <select className="input" value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">None</option>
            {d.classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!staff && (
        <div className="stack xs">
          <div className="strong small">Who sees it</div>
          {work ? (
            <div className="small muted">
              Marked work goes only to {work.from}, who set it. Untick it to keep it to yourself.
            </div>
          ) : (
            <div className="small muted">Your parents see it unless you keep it to yourself.</div>
          )}
          <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Who sees it">
            {allPlaces
              .filter((p) => !work || p.name === work.from)
              .map((p) => (
                <button key={p.id} type="button" className="chip" aria-pressed={places.includes(p.id)} onClick={() => setPlaces((x) => (x.includes(p.id) ? x.filter((y) => y !== p.id) : [...x, p.id]))}>
                  My teachers at {p.name}
                </button>
              ))}
            <button type="button" className="chip" aria-pressed={places.length === 0} onClick={() => setPlaces([])}>
              Just me
            </button>
          </div>
        </div>
      )}
      {staff && <div className="tiny muted">It stays with your school or you. {first(d?.learner?.name)} and their parents see it, and are told.</div>}
    </Modal>
  );
}

// "Add to my portfolio" on a piece of work whose marks are back (learner's results)
export function AddWorkToPortfolio({ attemptId }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const q = useQuery(open ? 'portfolio:me' : null, () => api.myPortfolio());
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        <Icon name="star" size={16} /> Add to my portfolio
      </button>
      {open && (q.data ? <PieceEditor learnerId={app.me.id} d={q.data} attemptId={attemptId} onClose={() => setOpen(false)} /> : <Modal title="Add to my portfolio" onClose={() => setOpen(false)}><Loading /></Modal>)}
    </>
  );
}

// A parent's card: the newest pieces in their child's portfolio
export function PortfolioCard({ learnerId, name }) {
  const d = useQuery(`portfolio:${learnerId}`, () => api.myPortfolio(learnerId)).data;
  if (!d || !d.items.length) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>
          <Icon name="star" size={18} /> {first(name)}’s portfolio
        </h2>
        <button className="btn sm" onClick={() => go(`/portfolio?child=${learnerId}`)}>
          See all {d.items.length}
        </button>
      </div>
      <Portfolio learnerId={learnerId} compact limit={4} />
    </div>
  );
}
