import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Modal, Page, Seg, VisibilityPill, go, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { due, kindLabel } from '../../lib/format.js';
import { useLookups, SubjectTag } from '../shared/lookups.jsx';
import { MockCards, NewMock } from './Mocks.jsx';
import { quickPost } from './AssignmentEditor.jsx';
import { useDiscardDraft } from './ClaudeInbox.jsx';

// Not posted yet: a draft, hidden, or waiting for its date
const notPosted = (a) => a.draft || a.visibility === 'hidden' || (a.visibility === 'scheduled' && a.visible_from && new Date(a.visible_from) > new Date());

export const KIND_DEFAULTS = {
  homework: { lockdown: false, camera: false, time_limit_min: null, max_attempts: 1, release_mode: 'manual', allow_notes: true },
  quiz: { lockdown: false, camera: false, time_limit_min: 15, max_attempts: 1, release_mode: 'on_submit', show_answers: true, allow_notes: true },
  test: { lockdown: true, camera: false, time_limit_min: 45, max_attempts: 1, release_mode: 'manual', allow_notes: false },
  exam: { lockdown: true, camera: true, time_limit_min: 90, max_attempts: 1, release_mode: 'manual', allow_notes: false },
};

export default function Assignments() {
  const lk = useLookups();
  const q = useQuery('assignments', api.listAssignments);
  const attempts = useQuery('attempts', api.listAttempts).data || [];
  const mocks = useQuery('mocks', api.listMocks).data || [];
  const route = useRoute();
  const [filter, setFilter] = useState(route.query.get('show') || 'all');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null); // the assignment whose options are showing
  // practice a learner started themselves (Study) isn't listed here; it shows in their progress
  const list = (q.data || [])
    .filter((a) => a.source !== 'self')
    .filter((a) => filter === 'all' || (filter === 'drafts' ? a.draft : a.kind === filter && !a.draft));
  const mockTitle = (id) => mocks.find((m) => m.id === id)?.title;
  const showMocks = filter === 'all' || filter === 'mocks';
  const drafts = (q.data || []).filter((a) => a.draft).length;

  return (
    <Page
      title="Assignments"
      subtitle="Homework, quizzes, tests and exams. Each has its own lockdown, camera and timing settings."
      actions={
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={18} /> New assignment
        </button>
      }
    >
      <Seg
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'homework', label: 'Homework' },
          { value: 'quiz', label: 'Quizzes' },
          { value: 'test', label: 'Tests' },
          { value: 'exam', label: 'Exams' },
          { value: 'mocks', label: `Mock exams${mocks.length ? ` (${mocks.length})` : ''}` },
          ...(drafts ? [{ value: 'drafts', label: `Drafts (${drafts})` }] : []),
        ]}
      />
      {filter === 'mocks' && !mocks.length ? (
        <Empty
          title="No mock exams yet"
          action={
            <button className="btn primary" onClick={() => setCreating('mock')}>
              <Icon name="plus" size={18} /> New mock exam
            </button>
          }
        >
          A mock is one or more papers whose marks add up to one total. StudyBridge works out the grade from your own grade boundaries for the exam.
        </Empty>
      ) : filter === 'mocks' ? (
        <div className="stack">
          <MockCards mocks={mocks} assignments={q.data || []} />
        </div>
      ) : q.data && list.length === 0 && !(showMocks && mocks.length) ? (
        <Empty
          title="Nothing here yet"
          action={
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={18} /> New assignment
            </button>
          }
        >
          Set work with questions of any kind: multiple choice, numbers, written answers, maths with working, photos of work or drawings.
        </Empty>
      ) : (
        <div className="stack">
          {showMocks && <MockCards mocks={mocks} assignments={q.data || []} />}
          {sections(list, stats).map(([title, items]) =>
            items.length ? (
              <section key={title} className="stack sm">
                <h2 className="list-head">
                  {title} <span className="muted">({items.length})</span>
                </h2>
                {items.map((a) => card(a))}
              </section>
            ) : null,
          )}
        </div>
      )}
      {open && <AssignmentOptions a={open} stats={stats(open)} onClose={() => setOpen(null)} />}
      {creating === 'mock' && <NewMock onClose={() => setCreating(false)} />}
      {creating === true && <NewAssignment onClose={() => setCreating(false)} onMock={() => setCreating('mock')} />}
    </Page>
  );

  // who it's for, how many have handed in, how many wait to be marked
  function stats(a) {
    const mine = attempts.filter((t) => t.assignment_id === a.id);
    const who = lk.audience(a);
    const submitted = new Set(mine.filter((t) => t.submitted_at).map((t) => t.learner_id)).size;
    const toMark = mine.filter((t) => t.status === 'submitted').length;
    return { who, submitted, toMark, started: mine.length };
  }

  function card(a) {
            const { who, submitted, toMark } = stats(a);
            const d = due(a.due_at);
            return (
              <button key={a.id} className="work-card" onClick={() => setOpen(a)} aria-haspopup="dialog">
                <span className="bar-l" style={{ background: lk.subject(a.subject_id)?.color || 'var(--line)' }} />
                <span className="grow stack sm">
                  <span className="row wrap" style={{ gap: 8 }}>
                    <span className={'kind ' + a.kind}>{a.practice ? 'Practice' : kindLabel[a.kind]}</span>
                    {a.mock_id && mockTitle(a.mock_id) && <span className="pill accent">Mock: {mockTitle(a.mock_id)}</span>}
                    {a.draft && <span className="pill claude"><Icon name={a.source === 'prof' ? 'cap' : 'spark'} size={12} /> Draft from {a.source === 'prof' ? 'Prof' : 'Claude'}</span>}
                    {a.lockdown && <span className="pill dark"><Icon name="lock" size={12} /> Lockdown</span>}
                    {a.camera && <span className="pill dark"><Icon name="camera" size={12} /> Camera</span>}
                    {a.time_limit_min && <span className="pill"><Icon name="clock" size={12} /> {a.time_limit_min} min</span>}
                  </span>
                  <span className="strong" style={{ fontSize: 16 }}>{a.title}</span>
                  <span className="row wrap small muted" style={{ gap: 12 }}>
                    {a.subject_id && <SubjectTag id={a.subject_id} />}
                    <span className={d.tone === 'bad' ? 'overdue' : ''}>{d.text}</span>
                    <span>
                      {submitted} of {who.length} submitted
                    </span>
                    {toMark > 0 && <span className="pill warn">{toMark} to mark</span>}
                  </span>
                </span>
                <VisibilityPill item={a} />
                <Icon name="more" size={18} />
              </button>
            );
  }
}

// Not posted · still open (not everyone has handed in, soonest due first) · everyone has handed in
function sections(list, stats) {
  const byDue = (x, y) => (x.due_at || '9999').localeCompare(y.due_at || '9999');
  const posted = list.filter((a) => !notPosted(a));
  const allIn = (a) => {
    const s = stats(a);
    return s.who.length > 0 && s.submitted >= s.who.length;
  };
  return [
    ['Not posted yet', list.filter(notPosted)],
    ['Waiting for hand-ins', posted.filter((a) => !allIn(a)).sort(byDue)],
    ['Everyone has handed in', posted.filter(allIn)],
  ];
}

// Tapping an assignment: edit it, post it (or hide it again), see what's handed in, copy it, or delete it
function AssignmentOptions({ a, stats, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const discard = useDiscardDraft();
  const files = useQuery('files', api.listFiles).data || [];
  const [busy, setBusy] = useState('');
  const waiting = notPosted(a);
  async function act(what, fn) {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad', ms: 7000 });
    } finally {
      setBusy('');
    }
  }
  const post = () =>
    act('post', async () => {
      const s = await quickPost(a, files);
      invalidate('assignments');
      const who = stats.who.map((l) => l.display_name);
      toast(
        s.visibility === 'scheduled'
          ? { title: `Scheduled: ${a.title}`, body: `Learners see it from ${new Date(s.visible_from).toLocaleString()}.` }
          : { title: `Posted: ${a.title}`, body: who.length ? `Sent to ${who.join(', ')}.` : 'Nobody takes this subject yet.' },
      );
      onClose();
    });
  const hide = () =>
    act('hide', async () => {
      if (!(await confirm({ title: `Hide “${a.title}”?`, body: 'Learners won’t see it until you post it again. Anything they’ve handed in is kept.', ok: 'Hide it' }))) return;
      await api.save('assignments', { id: a.id, visibility: 'hidden', updated_at: new Date().toISOString() });
      invalidate('assignments');
      toast('Hidden from learners');
      onClose();
    });
  const del = () =>
    act('delete', async () => {
      if (a.draft) {
        if (await discard('assignments', a)) onClose();
        return;
      }
      const body = stats.started ? `${stats.submitted} learner${stats.submitted === 1 ? ' has' : 's have'} handed it in. Their answers and marks are deleted too.` : 'All its questions are deleted.';
      if (!(await confirm({ title: `Delete “${a.title}”?`, body, ok: 'Delete', danger: true }))) return;
      await api.remove('assignments', a.id);
      invalidate('assignments', 'attempts');
      toast('Deleted');
      onClose();
    });
  const dup = () =>
    act('copy', async () => {
      const c = await api.duplicateAssignment(a);
      invalidate('assignments');
      go(`/assignments/${c.id}`);
    });
  return (
    <Modal title={a.title} onClose={onClose}>
      <div className="stack sm">
        <div className="small muted">
          {kindLabel[a.kind]} · {waiting ? (a.draft ? 'a draft, not posted yet' : 'not posted yet') : `${stats.submitted} of ${stats.who.length} handed in`}
          {stats.toMark ? ` · ${stats.toMark} to mark` : ''}
        </div>
        <div className="sheet-actions">
          <button className="btn" onClick={() => go(`/assignments/${a.id}`)}>
            <Icon name="pen" size={18} /> Edit
          </button>
          {waiting ? (
            <button className="btn primary" disabled={!!busy} onClick={post}>
              <Icon name="send" size={18} /> {busy === 'post' ? 'Posting…' : a.draft ? 'Approve & post' : 'Post now'}
            </button>
          ) : (
            <button className="btn" disabled={!!busy} onClick={hide}>
              <Icon name="eye" size={18} /> Hide from learners
            </button>
          )}
          {!waiting && (
            <button className="btn" onClick={() => go(`/marking?a=${a.id}`)}>
              <Icon name="checkCircle" size={18} /> Handed in ({stats.submitted}){stats.toMark ? ` · ${stats.toMark} to mark` : ''}
            </button>
          )}
          <button className="btn" disabled={!!busy} onClick={dup}>
            <Icon name="copy" size={18} /> Duplicate
          </button>
          <button className="btn danger" disabled={!!busy} onClick={del}>
            <Icon name="trash" size={18} /> {a.draft ? 'Discard' : 'Delete'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function NewAssignment({ onClose, onMock }) {
  const lk = useLookups();
  const [kind, setKind] = useState('homework');
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState(lk.subjects[0]?.id || '');
  const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!title.trim()) return setErr('Give it a title.');
    try {
      const a = await api.save('assignments', { kind, title: title.trim(), subject_id: subject || null, ...KIND_DEFAULTS[kind] });
      invalidate('assignments');
      go(`/assignments/${a.id}`);
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <Modal title="New assignment" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Kind">
          <Seg
            value={kind}
            onChange={(v) => (v === 'mock' ? onMock() : setKind(v))}
            options={[
              { value: 'homework', label: 'Homework' },
              { value: 'quiz', label: 'Quiz' },
              { value: 'test', label: 'Test' },
              { value: 'exam', label: 'Exam' },
              { value: 'mock', label: 'Mock exam' },
            ]}
          />
        </Field>
        <div className="note small">
          {kind === 'homework' && 'Open-book work. No timer or lockdown unless you turn them on.'}
          {kind === 'quiz' && 'Short, timed, marked automatically and returned as soon as it’s submitted.'}
          {kind === 'test' && 'Timed and locked down: the learner’s screen stays on StudyBridge until they submit.'}
          {kind === 'exam' && 'Timed, locked down, and you can watch their camera while they work.'}{' '}
          You can change every setting next.
        </div>
        <Field label="Title">
          <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Quadratics practice 1" />
        </Field>
        <Field label="Subject">
          <select className="select" value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">None</option>
            {lk.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        {err && <div className="error">{err}</div>}
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Create</button>
        </div>
      </form>
    </Modal>
  );
}
