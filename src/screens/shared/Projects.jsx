// IB core and the PYP: one project's page (CAS, the Extended Essay, TOK, an MYP project, Service as Action or the PYP
// Exhibition), for the learner (and their team) and their supervisor or a coordinator. Learners keep a journal:
// experiences, reflections, journal entries, drafts and the final piece; experiences, drafts and finals go to the
// supervisor to approve or send back. Supervisors log meetings (and CAS interviews), comment and, for MYP projects, mark
// the criteria. Parents only see progress and deadlines (ParentProjects).
import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Link, Loading, Modal, Page, Toggle, useConfirm, useLeaveGuard, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, day, ymd } from '../../lib/format.js';
import { ENTRY, KINDS, OUTCOMES, PROJECT_CRITERIA, STRANDS, lateCount, leadWord, nextDeadline, progressLine } from '../../lib/core.js';

const due = (d) => (d ? new Date(d + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'no date');
const changed = () => invalidate('core', 'my-core', 'core-cohort');
const STATE = { waiting: ['Waiting to be looked at', 'warn'], approved: ['Approved', 'good'], returned: ['Sent back', 'bad'] };

export function ProjectPage({ id }) {
  const app = useApp();
  const q = useQuery(`core:${id}`, () => api.coreProject(id));
  const [adding, setAdding] = useState(null); // {kind} or an entry to change
  const d = q.data;
  const staffSide = app.me.role === 'tutor';
  if (!d)
    return (
      <Page title="Project" eyebrow={<Link to="/projects">Projects</Link>}>
        {q.error ? <Empty title="This project isn’t here">{q.error.message}</Empty> : <Loading />}
      </Page>
    );
  const k = KINDS[d.kind] || {};
  const can = d.mine && d.status === 'active' ? k.adds : d.staff ? k.staff : [];
  const experiences = d.entries.filter((e) => e.kind === 'experience');
  return (
    <Page
      eyebrow={
        <>
          <Link to="/projects">Projects</Link> <Icon name="right" size={14} /> {d.cohort}
        </>
      }
      title={staffSide ? `${d.learner}: ${k.name}` : k.long}
      subtitle={[d.title, d.subject, d.supervisor ? `${k.lead}: ${d.supervisor}` : `No ${leadWord(d.kind)} yet`, d.team && `Team ${d.team}`].filter(Boolean).join(' · ')}
    >
      {d.status !== 'active' && <div className="note good">{d.status === 'completed' ? `Finished${d.grade ? `, grade ${d.grade}` : ''}.` : 'Withdrawn.'}</div>}
      <div className="grid project-grid">
        <div className="stack">
          {can.length > 0 && (
            <div className="row wrap" style={{ gap: 8 }}>
              {can.map((kind) => (
                <button key={kind} className={'btn' + (kind === can[0] ? ' primary' : '')} onClick={() => setAdding({ kind })}>
                  <Icon name={ENTRY[kind].icon} size={16} /> {kind === 'final' && d.kind === 'exhibition' ? 'Add your exhibition work' : ENTRY[kind].add}
                </button>
              ))}
            </div>
          )}
          {d.entries.length === 0 ? (
            <Empty title="Nothing written yet">{d.mine ? 'Start with what you’re planning, and keep adding as you go. Your ' + leadWord(d.kind) + ' sees it all.' : 'What they write shows here as they go.'}</Empty>
          ) : (
            d.entries.map((e) => <EntryCard key={e.id} e={e} d={d} experiences={experiences} onChange={() => setAdding(e)} />)
          )}
        </div>
        <div className="stack">
          <ProgressCard d={d} />
          <DeadlinesCard d={d} />
          <AboutCard d={d} />
          {k.criteria && (d.staff || d.status === 'completed') && <MarkCard d={d} />}
          {d.titles && (
            <div className="card">
              <h3>This session’s titles</h3>
              <div className="small" style={{ whiteSpace: 'pre-line' }}>
                {d.titles}
              </div>
            </div>
          )}
        </div>
      </div>
      {adding && <EntryEditor d={d} entry={adding.id ? adding : null} kind={adding.kind} experiences={experiences} onClose={() => setAdding(null)} />}
    </Page>
  );
}

function EntryCard({ e, d, experiences, onChange }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const st = STATE[e.status];
  const about = e.experience_id && experiences.find((x) => x.id === e.experience_id);
  const milestone = e.milestone && (d.progress.deadlines || []).find((x) => x.key === e.milestone);
  const approvable = ['experience', 'draft', 'final'].includes(e.kind);
  async function review(status) {
    setBusy(true);
    try {
      await api.reviewCoreEntry(e.id, status, note || null);
      changed();
      setReviewing(false);
      setNote('');
      toast(status === 'approved' ? 'Approved' : status === 'returned' ? 'Sent back with your note' : 'Comment added');
    } catch (err) {
      toast({ title: 'Couldn’t do that', body: err.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!(await confirm({ title: 'Delete this?', body: 'It can’t be brought back.', ok: 'Delete', danger: true }))) return;
    try {
      await api.deleteCoreEntry(e.id);
      changed();
    } catch (err) {
      toast({ title: 'Couldn’t delete it', body: err.message, tone: 'bad' });
    }
  }
  return (
    <article className={'card core-entry kind-' + e.kind}>
      <div className="row between wrap" style={{ gap: 8 }}>
        <span className="row wrap" style={{ gap: 8 }}>
          <Icon name={ENTRY[e.kind]?.icon || 'file'} size={16} style={{ color: 'var(--accent)' }} />
          <span className="strong">{e.title || ENTRY[e.kind]?.name}</span>
          {e.title && <span className="small muted">{ENTRY[e.kind]?.name}</span>}
          {e.is_project && <span className="pill accent">CAS project</span>}
        </span>
        {st && <span className={'pill ' + st[1]}>{st[0]}</span>}
      </div>
      <div className="small muted">
        {[
          e.day && (e.ends && e.ends !== e.day ? `${day(e.day + 'T12:00')} to ${day(e.ends + 'T12:00')}` : day(e.day + 'T12:00')),
          milestone && `For: ${milestone.label}`,
          about && `About: ${about.title}`,
          e.hours != null && `${Number(e.hours)} hours`,
          e.minutes != null && `${e.minutes} minutes`,
          !e.mine && e.author,
          ago(e.created_at),
        ]
          .filter(Boolean)
          .join(' · ')}
      </div>
      {(e.strands.length > 0 || e.outcomes.length > 0) && (
        <div className="row wrap" style={{ gap: 6 }}>
          {e.strands.map((s) => (
            <span key={s} className="pill">
              {STRANDS[s]}
            </span>
          ))}
          {e.outcomes.map((o) => (
            <span key={o} className="pill accent" title={OUTCOMES[o]}>
              Outcome {o}
            </span>
          ))}
        </div>
      )}
      {e.body && <div className="core-body">{e.body}</div>}
      <ProjectFiles files={e.files} />
      {e.feedback && (
        <div className="feedback">
          <div className="tiny strong">
            {e.feedback_by}
            {e.feedback_at ? ` · ${ago(e.feedback_at)}` : ''}
          </div>
          <div style={{ whiteSpace: 'pre-line' }}>{e.feedback}</div>
        </div>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        {e.can_review && !e.mine && !reviewing && (
          <>
            {approvable && e.status !== 'approved' && (
              <button className="btn sm primary" disabled={busy} onClick={() => review('approved')}>
                <Icon name="check" size={15} /> Approve
              </button>
            )}
            <button className="btn sm" onClick={() => setReviewing(true)}>
              {approvable && e.status !== 'approved' ? 'Send back or comment' : 'Comment'}
            </button>
          </>
        )}
        {e.mine && e.status !== 'approved' && (d.status === 'active' || d.staff) && (
          <>
            <button className="btn sm" onClick={onChange}>
              <Icon name="pen" size={15} /> Change
            </button>
            <button className="btn sm ghost" onClick={remove}>
              Delete
            </button>
          </>
        )}
      </div>
      {reviewing && (
        <div className="stack sm">
          <textarea className="textarea" rows={3} maxLength={4000} aria-label="Your note to them" placeholder="What’s good, and what to change" value={note} onChange={(x) => setNote(x.target.value)} />
          <div className="row end wrap" style={{ gap: 8 }}>
            <button className="btn sm" onClick={() => setReviewing(false)}>
              Cancel
            </button>
            {approvable && e.status !== 'approved' && (
              <button className="btn sm" disabled={busy || !note.trim()} onClick={() => review('returned')}>
                Send back
              </button>
            )}
            <button className="btn sm primary" disabled={busy || !note.trim()} onClick={() => review('comment')}>
              Add comment
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// Files on an entry (from the learner's own project folder)
export function ProjectFiles({ files }) {
  const toast = useToast();
  if (!files?.length) return null;
  async function open(f) {
    try {
      const blob = await api.getBlob('work', f.path);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      toast({ title: 'Couldn’t open it', body: e.message, tone: 'bad' });
    }
  }
  return (
    <div className="row wrap" style={{ gap: 8 }}>
      {files.map((f) => (
        <button key={f.path} type="button" className="btn sm" onClick={() => open(f)} aria-label={`Download ${f.name}`}>
          <Icon name={/pdf$/i.test(f.name) ? 'pdf' : String(f.type).startsWith('image/') ? 'image' : 'file'} size={15} /> {f.name}
        </button>
      ))}
    </div>
  );
}

function EntryEditor({ d, entry, kind, experiences, onClose }) {
  const toast = useToast();
  const k = KINDS[d.kind] || {};
  const start = entry
    ? { ...entry, hours: entry.hours ?? '', minutes: entry.minutes ?? '' }
    : { kind, title: '', body: '', day: ['experience', 'meeting', 'interview'].includes(kind) ? ymd(new Date()) : '', ends: '', strands: [], outcomes: [], hours: '', minutes: '', milestone: '', is_project: false, experience_id: '', files: [] };
  const [x, setX] = useState(start);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const dirty = JSON.stringify(x) !== JSON.stringify(start);
  useLeaveGuard(dirty);
  const set = (patch) => setX({ ...x, ...patch });
  const toggle = (key, v) => set({ [key]: x[key].includes(v) ? x[key].filter((y) => y !== v) : [...x[key], v] });
  const deadlines = d.progress.deadlines || [];
  const learnerSide = d.mine;
  async function addFiles(list) {
    setUploading(true);
    try {
      const got = [];
      for (const f of list) got.push(await api.uploadCoreFile(d.id, f));
      setX((cur) => ({ ...cur, files: [...cur.files, ...got] }));
    } catch (e) {
      toast({ title: 'Couldn’t add that file', body: e.message, tone: 'bad' });
    } finally {
      setUploading(false);
    }
  }
  async function save() {
    setBusy(true);
    try {
      await api.saveCoreEntry(entry?.project_id || d.id, {
        id: entry?.id || null, kind: x.kind, title: x.title, body: x.body, day: x.day || null, ends: x.ends || null, strands: x.strands, outcomes: x.outcomes,
        hours: x.hours === '' ? null : Number(x.hours), minutes: x.minutes === '' ? null : Number(x.minutes), milestone: x.milestone || null,
        is_project: !!x.is_project, experience_id: x.experience_id || null, files: x.files,
      });
      changed();
      toast(['experience', 'draft', 'final'].includes(x.kind) && learnerSide ? `Saved. Your ${leadWord(d.kind)} can look at it now.` : 'Saved');
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  const K = x.kind;
  // what each kind needs before it can be saved
  const ready = K === 'experience' ? !!x.title?.trim() : K === 'draft' || K === 'final' ? !!x.body?.trim() || x.files.length > 0 : !!x.body?.trim();
  return (
    <Modal
      wide
      title={entry ? `Change: ${ENTRY[K].name.toLowerCase()}` : ENTRY[K].add}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || uploading || !ready} onClick={save}>
            {['experience', 'draft', 'final'].includes(K) && learnerSide ? 'Save and send' : 'Save'}
          </button>
        </>
      }
    >
      <div className="stack">
        {(K === 'experience' || K === 'draft' || K === 'final' || K === 'journal') && (
          <Field label={K === 'experience' ? 'What it is' : 'Title'} hint={K === 'experience' ? null : 'If you like'}>
            <input className="input" maxLength={200} value={x.title || ''} onChange={(e) => set({ title: e.target.value })} placeholder={K === 'experience' ? 'Coaching the under-10s football team' : ''} />
          </Field>
        )}
        {(K === 'experience' || K === 'meeting' || K === 'interview') && (
          <div className="grid g2" style={{ gap: 12 }}>
            <Field label={K === 'experience' ? 'Started' : 'When'}>
              <input className="input" type="date" value={x.day || ''} onChange={(e) => set({ day: e.target.value })} />
            </Field>
            {K === 'experience' ? (
              <Field label="Finished" hint="Leave it empty if it’s still going">
                <input className="input" type="date" value={x.ends || ''} onChange={(e) => set({ ends: e.target.value })} />
              </Field>
            ) : (
              <Field label="How long (minutes)">
                <input className="input" type="number" min="0" max="600" value={x.minutes} onChange={(e) => set({ minutes: e.target.value })} />
              </Field>
            )}
          </div>
        )}
        {K === 'experience' && d.kind === 'cas' && (
          <Field label="Strands">
            <div className="row wrap" style={{ gap: 6 }}>
              {Object.entries(STRANDS).map(([s, name]) => (
                <button key={s} className="chip" aria-pressed={x.strands.includes(s)} onClick={() => toggle('strands', s)}>
                  {name}
                </button>
              ))}
            </div>
          </Field>
        )}
        {K === 'experience' && k.outcomes && (
          <Field label="Learning outcomes it shows" hint="Pick the ones it really shows; your adviser checks.">
            <div className="row wrap" style={{ gap: 6 }}>
              {Object.entries(OUTCOMES).map(([o, name]) => (
                <button key={o} className="chip" aria-pressed={x.outcomes.includes(Number(o))} onClick={() => toggle('outcomes', Number(o))}>
                  {o}. {name}
                </button>
              ))}
            </div>
          </Field>
        )}
        {K === 'experience' && (
          <div className="grid g2" style={{ gap: 12, alignItems: 'end' }}>
            <Field label="Hours" hint="If your school counts them">
              <input className="input" type="number" min="0" max="1000" step="0.5" value={x.hours} onChange={(e) => set({ hours: e.target.value })} />
            </Field>
            {d.kind === 'cas' && <Toggle checked={!!x.is_project} onChange={(v) => set({ is_project: v })} title="This is my CAS project" />}
          </div>
        )}
        {K === 'reflection' && experiences.length > 0 && (
          <Field label="About" hint="If it’s about one of your experiences">
            <select className="select" value={x.experience_id || ''} onChange={(e) => set({ experience_id: e.target.value })}>
              <option value="">Nothing in particular</option>
              {experiences.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        {deadlines.length > 0 && K !== 'experience' && (
          <Field label="It’s for" hint="Ticks off that deadline">
            <select className="select" value={x.milestone || ''} onChange={(e) => set({ milestone: e.target.value })}>
              <option value="">No deadline in particular</option>
              {deadlines.map((dl) => (
                <option key={dl.key} value={dl.key}>
                  {dl.label}
                  {dl.due ? ` (${due(dl.due)})` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field
          label={K === 'experience' ? 'What you did and what it meant' : K === 'meeting' || K === 'interview' ? 'What you talked about' : K === 'draft' || K === 'final' ? 'Your work' : 'What you’re thinking'}
          hint={K === 'draft' || K === 'final' ? 'Write it here, or add it as a file below' : null}
        >
          <textarea className="textarea" rows={K === 'draft' || K === 'final' ? 10 : 6} maxLength={20000} value={x.body || ''} onChange={(e) => set({ body: e.target.value })} />
        </Field>
        {learnerSide && (
          <Field label="Files" hint="Photos, documents or your essay as a file (up to 10)">
            <div className="stack sm">
              <ProjectFiles files={x.files} />
              {x.files.length > 0 && (
                <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => set({ files: [] })}>
                  Take the files off
                </button>
              )}
              <label className="btn sm" style={{ alignSelf: 'flex-start' }}>
                <Icon name="upload" size={15} /> {uploading ? 'Adding…' : 'Add a file'}
                <input type="file" multiple hidden onChange={(e) => e.target.files?.length && addFiles([...e.target.files])} aria-label="Add a file" />
              </label>
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function ProgressCard({ d }) {
  const k = KINDS[d.kind] || {};
  const p = d.progress || {};
  return (
    <div className="card">
      <h3>How it’s going</h3>
      {k.outcomes && (
        <div className="stack sm">
          {Object.entries(OUTCOMES).map(([o, name]) => {
            const done = (p.outcomes || []).includes(Number(o));
            return (
              <div key={o} className={'outcome-row' + (done ? ' done' : '')}>
                <Icon name={done ? 'checkCircle' : 'circle'} size={16} />
                <span>
                  {o}. {name}
                </span>
              </div>
            );
          })}
          <div className="tiny muted">An outcome counts once an experience showing it is approved.</div>
        </div>
      )}
      <div className="row wrap" style={{ gap: 6 }}>
        {d.kind === 'cas' &&
          Object.entries(STRANDS).map(([s, name]) => (
            <span key={s} className={'pill' + ((p.strands || []).includes(s) ? ' good' : '')}>
              {name}
            </span>
          ))}
        {d.kind === 'cas' && <span className={'pill' + (p.cas_project ? ' good' : '')}>CAS project</span>}
      </div>
      <div className="small muted">{progressLine(d.kind, p)}</div>
      {p.hours != null && <div className="small muted">{Number(p.hours)} hours in approved experiences</div>}
      {p.meeting_minutes > 0 && <div className="small muted">{p.meeting_minutes} minutes of meetings</div>}
      {p.waiting > 0 && <div className="pill warn">{p.waiting} waiting to be looked at</div>}
    </div>
  );
}

function DeadlinesCard({ d }) {
  const list = d.progress.deadlines || [];
  if (!list.length) return null;
  return (
    <div className="card">
      <h3>Deadlines</h3>
      <div className="list">
        {list.map((x) => (
          <div key={x.key} className="item">
            <Icon name={x.state === 'done' ? 'checkCircle' : x.state === 'late' ? 'alert' : 'clock'} size={16}
              style={{ color: x.state === 'done' ? 'var(--good)' : x.state === 'late' ? 'var(--red)' : 'var(--muted)' }} />
            <span className="grow">
              <span className="name">{x.label}</span>
              <span className="meta">{due(x.due)}</span>
            </span>
            <span className={'pill ' + (x.state === 'done' ? 'good' : x.state === 'late' ? 'bad' : '')}>{x.state === 'done' ? 'Done' : x.state === 'late' ? 'Late' : 'To do'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The title (research question, project) and subject: the learner sets them, staff too; staff keep a private note
function AboutCard({ d }) {
  const toast = useToast();
  const now = { title: d.title || '', subject: d.subject || '', staff_note: d.staff_note || '' };
  const [x, setX] = useState(now);
  const [base, setBase] = useState(now);
  // (the page may show a saved copy first and the latest a moment later: take the latest while nothing's been typed)
  if (JSON.stringify(now) !== JSON.stringify(base) && JSON.stringify(x) === JSON.stringify(base)) {
    setBase(now);
    setX(now);
  }
  const editable = (d.mine && d.status === 'active') || d.staff;
  const patch = Object.fromEntries(['title', 'subject', ...(d.staff ? ['staff_note'] : [])].filter((k) => x[k] !== now[k]).map((k) => [k, x[k]]));
  const dirty = Object.keys(patch).length > 0;
  async function save() {
    try {
      await api.coreSet(d.id, patch);
      setBase(x);
      changed();
      toast('Saved');
    } catch (e) {
      toast({ title: 'Couldn’t save it', body: e.message, tone: 'bad' });
    }
  }
  if (!editable) return null;
  const titleLabel = d.kind === 'ee' ? 'Research question' : d.kind === 'tok' ? 'Essay title' : 'Title';
  return (
    <div className="card">
      <h3>About it</h3>
      <Field label={titleLabel}>
        <input className="input" maxLength={300} value={x.title} onChange={(e) => setX({ ...x, title: e.target.value })} />
      </Field>
      {(d.kind === 'ee' || d.kind === 'tok') && (
        <Field label={d.kind === 'ee' ? 'Subject' : 'Exhibition theme'}>
          <input className="input" maxLength={80} value={x.subject} onChange={(e) => setX({ ...x, subject: e.target.value })} />
        </Field>
      )}
      {d.staff && (
        <Field label="Note for staff" hint="The learner never sees it">
          <textarea className="textarea" rows={2} maxLength={2000} value={x.staff_note} onChange={(e) => setX({ ...x, staff_note: e.target.value })} />
        </Field>
      )}
      {dirty && (
        <div className="row end">
          <button className="btn sm primary" onClick={save}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}

// MYP projects: criteria A to C (0 to 8 each) and a grade; then finished
function MarkCard({ d }) {
  const toast = useToast();
  const [c, setC] = useState(d.criteria || {});
  const [grade, setGrade] = useState(d.grade || '');
  const [seen, setSeen] = useState(d.updated_at);
  // (a newer copy of the project arrived: show its marks)
  if (d.updated_at !== seen) {
    setSeen(d.updated_at);
    setC(d.criteria || {});
    setGrade(d.grade || '');
  }
  const total = Object.values(c).reduce((s, v) => s + (v === '' || v == null ? 0 : Number(v)), 0);
  async function save(status) {
    try {
      await api.coreMark(d.id, c, grade, status);
      changed();
      toast(status === 'completed' ? 'Marked and finished. They’ve been told.' : 'Saved');
    } catch (e) {
      toast({ title: 'Couldn’t save the marks', body: e.message, tone: 'bad' });
    }
  }
  if (!d.staff)
    return (
      <div className="card">
        <h3>Marks</h3>
        {Object.entries(PROJECT_CRITERIA).map(([key, name]) => (
          <div key={key} className="row between small">
            <span>
              {key}: {name}
            </span>
            <span className="strong">{c[key] ?? '—'} / 8</span>
          </div>
        ))}
        {d.grade && <div className="strong">Grade {d.grade}</div>}
      </div>
    );
  return (
    <div className="card">
      <h3>Marks</h3>
      {Object.entries(PROJECT_CRITERIA).map(([key, name]) => (
        <Field key={key} label={`${key}: ${name}`}>
          <select className="select" value={c[key] ?? ''} onChange={(e) => setC({ ...c, [key]: e.target.value === '' ? undefined : Number(e.target.value) })}>
            <option value="">Not given</option>
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      ))}
      <div className="small muted">Total {total} / 24</div>
      <Field label="Grade" hint="From the IB’s boundaries for this session">
        <input className="input" maxLength={10} style={{ maxWidth: 120 }} value={grade} onChange={(e) => setGrade(e.target.value)} />
      </Field>
      <div className="row end wrap" style={{ gap: 8 }}>
        <button className="btn sm" onClick={() => save(null)}>
          Save
        </button>
        {d.status === 'active' && (
          <button className="btn sm primary" onClick={() => save('completed')}>
            Save and finish
          </button>
        )}
      </div>
    </div>
  );
}

// A learner's projects (and a teacher's: the ones they supervise, on their own Projects page)
export function ProjectList({ list, staff = false }) {
  if (!list.length) return <Empty title="No projects yet">{staff ? 'Learners you supervise show here.' : 'When your school starts CAS, the Extended Essay or another project with you, it shows here.'}</Empty>;
  return (
    <div className="grid g2 project-cards">
      {list.map((p) => {
        const nd = nextDeadline(p.progress);
        const late = lateCount(p.progress);
        return (
          <Link key={p.id} to={`/projects/p/${p.id}`} className="card click">
            <div className="row between wrap" style={{ gap: 8 }}>
              <span className="strong">{staff ? p.learner : KINDS[p.kind]?.long}</span>
              <span className="pill">{KINDS[p.kind]?.name}</span>
            </div>
            <div className="small muted">{[p.title, staff ? p.cohort : p.supervisor && `${KINDS[p.kind]?.lead}: ${p.supervisor}`].filter(Boolean).join(' · ')}</div>
            <div className="small">{progressLine(p.kind, p.progress)}</div>
            <div className="row wrap" style={{ gap: 6 }}>
              {p.progress?.waiting > 0 && <span className="pill warn">{p.progress.waiting} to look at</span>}
              {late > 0 && <span className="pill bad">{late} late</span>}
              {nd && <span className="pill">Next: {nd.label}, {due(nd.due)}</span>}
              {p.status === 'completed' && <span className="pill good">Finished</span>}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

// The learner's Projects page
export function MyProjects() {
  const q = useQuery('my-core', api.myCore);
  return (
    <Page title="Projects" subtitle="CAS, the Extended Essay, TOK, your MYP projects or the Exhibition: your journal, drafts and deadlines.">
      {!q.data ? q.error ? <div className="error">{q.error.message}</div> : <Loading /> : <ProjectList list={q.data} />}
    </Page>
  );
}

// For parents: how their child's projects are going and the deadlines (never what they wrote)
export function ParentProjects({ childId, name }) {
  const q = useQuery(`core:parent:${childId}`, () => api.parentCore(childId));
  const list = q.data || [];
  if (!list.length) return null;
  return (
    <section className="card">
      <h2>{name ? `${name}’s projects` : 'Projects'}</h2>
      <div className="stack">
        {list.map((p) => {
          const nd = nextDeadline(p.progress);
          const late = lateCount(p.progress);
          return (
            <div key={p.id} className="stack sm">
              <div className="row between wrap" style={{ gap: 8 }}>
                <span className="strong">{KINDS[p.kind]?.long}</span>
                {p.status === 'completed' ? <span className="pill good">Finished{p.grade ? `, grade ${p.grade}` : ''}</span> : late > 0 ? <span className="pill bad">{late} late</span> : null}
              </div>
              <div className="small muted">{[p.title, p.supervisor && `${KINDS[p.kind]?.lead}: ${p.supervisor}`].filter(Boolean).join(' · ')}</div>
              <div className="small">{progressLine(p.kind, p.progress)}</div>
              {nd && (
                <div className="small">
                  Next: {nd.label}, {due(nd.due)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
