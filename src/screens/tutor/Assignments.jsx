import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Modal, Page, Seg, VisibilityPill, go } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { due, kindLabel } from '../../lib/format.js';
import { useLookups, SubjectTag } from '../shared/lookups.jsx';

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
  const [filter, setFilter] = useState('all');
  const [creating, setCreating] = useState(false);
  const list = (q.data || []).filter((a) => filter === 'all' || (filter === 'drafts' ? a.draft : a.kind === filter && !a.draft));
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
          ...(drafts ? [{ value: 'drafts', label: `Drafts (${drafts})` }] : []),
        ]}
      />
      {q.data && list.length === 0 ? (
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
          {list.map((a) => {
            const mine = attempts.filter((t) => t.assignment_id === a.id);
            const who = lk.audience(a);
            const submitted = new Set(mine.filter((t) => t.submitted_at).map((t) => t.learner_id)).size;
            const toMark = mine.filter((t) => t.status === 'submitted').length;
            const d = due(a.due_at);
            return (
              <button key={a.id} className="work-card" onClick={() => go(`/assignments/${a.id}`)}>
                <span className="bar-l" style={{ background: lk.subject(a.subject_id)?.color || 'var(--line)' }} />
                <span className="grow stack sm">
                  <span className="row wrap" style={{ gap: 8 }}>
                    <span className={'kind ' + a.kind}>{a.practice ? 'Practice' : kindLabel[a.kind]}</span>
                    {a.draft && <span className="pill claude"><Icon name="spark" size={12} /> Draft from Claude</span>}
                    {a.lockdown && <span className="pill dark"><Icon name="lock" size={12} /> Lockdown</span>}
                    {a.camera && <span className="pill dark"><Icon name="camera" size={12} /> Camera</span>}
                    {a.time_limit_min && <span className="pill"><Icon name="clock" size={12} /> {a.time_limit_min} min</span>}
                  </span>
                  <span className="strong" style={{ fontSize: 16 }}>{a.title}</span>
                  <span className="row wrap small muted" style={{ gap: 12 }}>
                    {a.subject_id && <SubjectTag id={a.subject_id} />}
                    <span className={d.tone === 'bad' ? '' : ''}>{d.text}</span>
                    <span>
                      {submitted} of {who.length} submitted
                    </span>
                    {toMark > 0 && <span className="pill warn">{toMark} to mark</span>}
                  </span>
                </span>
                <VisibilityPill item={a} />
                <Icon name="right" size={18} />
              </button>
            );
          })}
        </div>
      )}
      {creating && <NewAssignment onClose={() => setCreating(false)} />}
    </Page>
  );
}

function NewAssignment({ onClose }) {
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
            onChange={setKind}
            options={[
              { value: 'homework', label: 'Homework' },
              { value: 'quiz', label: 'Quiz' },
              { value: 'test', label: 'Test' },
              { value: 'exam', label: 'Exam' },
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
