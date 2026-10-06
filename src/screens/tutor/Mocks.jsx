// Mock exams (1.6): one or more papers whose marks add up to one total, and a grade worked out from the
// tutor's own grade boundaries for the exam. The grade is plain maths, never AI. Boundaries are set once
// per exam and session and stay private to the tutor: learners only see their grade.
import { useRef, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Link, Loading, Modal, Page, VisibilityPill, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as X from '../../lib/exams.js';
import { day, kindLabel } from '../../lib/format.js';
import { useLookups, SubjectTag } from '../shared/lookups.jsx';
import { KIND_DEFAULTS } from './Assignments.jsx';

// The exam a subject is for ('cie:0607'), or the subject itself when it doesn't say
export const examKey = (subject) => (subject ? subject.exam || `subject:${subject.id}` : null);
export function examName(key, lk) {
  if (!key) return 'No exam chosen';
  if (key.startsWith('subject:')) return lk.subject(key.slice(8))?.name || 'This subject';
  const [b, c] = key.split(':');
  return X.findSyllabus(b, c) ? `${X.BOARDS[b]?.short || ''} ${X.syllabusLabel(b, c)}`.trim() : key;
}
const boundaryLabel = (b) => [b.session, b.option_label].filter(Boolean).join(' · ') || 'Grade boundaries';
// swap two neighbours in a list of ids
const swap = (ids, i) => ids.map((x, j) => (j === i ? ids[i + 1] : j === i + 1 ? ids[i] : x));
const n = (x) => (x == null ? '' : String(Math.round(Number(x) * 10) / 10));

// ---------------------------------------------------------------------------
// On the Assignments page
// ---------------------------------------------------------------------------
export function MockCards({ mocks, assignments }) {
  if (!mocks.length) return null;
  return (
    <>
      {mocks.map((m) => {
        const papers = assignments.filter((a) => a.mock_id === m.id);
        return (
          <button key={m.id} className="work-card" onClick={() => go(`/mocks/${m.id}`)}>
            <span className="bar-l" style={{ background: 'var(--red-ink, #9B2C1F)' }} />
            <span className="grow stack sm">
              <span className="row wrap" style={{ gap: 8 }}>
                <span className="kind exam">Mock exam</span>
                <span className="pill">
                  {papers.length} paper{papers.length === 1 ? '' : 's'}
                </span>
              </span>
              <span className="strong" style={{ fontSize: 16 }}>{m.title}</span>
              <span className="row wrap small muted" style={{ gap: 12 }}>
                {m.subject_id && <SubjectTag id={m.subject_id} />}
                <span>{papers.map((p) => p.title).join(' · ') || 'No papers yet'}</span>
              </span>
            </span>
            <Icon name="right" size={18} />
          </button>
        );
      })}
    </>
  );
}

export function NewMock({ onClose }) {
  const lk = useLookups();
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState(lk.subjects[0]?.id || '');
  const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!title.trim()) return setErr('Give it a title, e.g. “October mock”.');
    try {
      const s = lk.subject(subject);
      const m = await api.saveMock({ title: title.trim(), subject_id: s?.id || null, exam: examKey(s) });
      invalidate('mocks');
      go(`/mocks/${m.id}`);
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <Modal title="New mock exam" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="note small">
          A mock is one or more papers. Their marks add up to one total, and StudyBridge works out the grade from your grade boundaries for the exam. Learners see their grade once you’ve given back the marks for every paper.
        </div>
        <Field label="Title">
          <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. October mock" />
        </Field>
        <Field label="Subject" hint="Its exam decides which grade boundaries the mock uses.">
          <select className="select" value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">None</option>
            {lk.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.exam ? ` · ${examName(s.exam, lk)}` : ''}
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

// ---------------------------------------------------------------------------
// One mock: its papers, which boundaries it uses, and everyone's results
// ---------------------------------------------------------------------------
export default function MockPage({ id }) {
  const lk = useLookups();
  const toast = useToast();
  const confirm = useConfirm();
  const mocks = useQuery('mocks', api.listMocks);
  const assignments = useQuery('assignments', api.listAssignments);
  const results = useQuery(`mock:${id}`, () => api.mockResults(id));
  const bounds = useQuery('boundaries', api.listBoundaries).data || [];
  const [adding, setAdding] = useState('');
  const [showBounds, setShowBounds] = useState(false);
  const [title, setTitle] = useState(null);
  const m = (mocks.data || []).find((x) => x.id === id);
  const all = assignments.data || [];
  const papers = all.filter((a) => a.mock_id === id).sort((a, b) => (a.mock_position || 0) - (b.mock_position || 0) || a.created_at.localeCompare(b.created_at));
  const free = all.filter((a) => !a.mock_id && !a.practice && a.source !== 'self' && (!m?.subject_id || !a.subject_id || a.subject_id === m.subject_id));
  const forExam = bounds.filter((b) => b.exam === m?.exam);
  // a mock whose subject doesn't say its exam keeps boundaries under the subject (or the mock itself)
  const examFor = m ? m.exam || examKey(lk.subject(m.subject_id)) || `mock:${m.id}` : null;
  const r = results.data;

  if (!m) return <Page title="Mock exam">{mocks.data ? <Empty>This mock exam no longer exists.</Empty> : <Loading />}</Page>;

  const refresh = () => invalidate('assignments', 'mocks', `mock:${id}`);
  async function setOrder(ids, removed = []) {
    try {
      await api.setMockPapers(id, ids, removed);
      refresh();
    } catch (e) {
      toast({ title: 'Couldn’t change the papers', body: e.message, tone: 'bad' });
    }
  }
  async function newPaper() {
    try {
      const a = await api.save('assignments', {
        kind: 'exam',
        title: `${m.title}: Paper ${papers.length + 1}`,
        subject_id: m.subject_id,
        mock_id: id,
        mock_position: papers.length + 1,
        ...KIND_DEFAULTS.exam,
      });
      refresh();
      go(`/assignments/${a.id}`);
    } catch (e) {
      toast({ title: 'Couldn’t add a paper', body: e.message, tone: 'bad' });
    }
  }
  async function saveMock(patch) {
    try {
      await api.saveMock({ id, ...patch });
      refresh();
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    }
  }

  return (
    <Page
      eyebrow={
        <Link to="/assignments?show=mocks" className="row" style={{ gap: 4 }}>
          <Icon name="left" size={14} /> Assignments
        </Link>
      }
      title={
        title != null ? (
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              await saveMock({ title });
              setTitle(null);
            }}
          >
            <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Mock title" />
            <button className="btn sm primary">Save</button>
          </form>
        ) : (
          <span className="row" style={{ gap: 8 }}>
            {m.title}
            <button className="btn ghost icon sm" aria-label="Rename" onClick={() => setTitle(m.title)}>
              <Icon name="pen" size={16} />
            </button>
          </span>
        )
      }
      subtitle={`Mock exam · ${examName(m.exam, lk)}`}
      actions={
        <button
          className="btn ghost"
          onClick={async () => {
            if (!(await confirm({ title: 'Delete this mock exam?', body: 'Its papers stay as ordinary assignments, with any work and marks.', ok: 'Delete mock', danger: true }))) return;
            await api.deleteMock(id);
            refresh();
            go('/assignments?show=mocks');
          }}
        >
          <Icon name="trash" size={16} /> Delete
        </button>
      }
    >
      <div className="card">
        <div className="card-head">
          <h2>Papers</h2>
          <span className="small muted">Each keeps its own time limit, lockdown and camera. Learners can sit them on the same day or different days.</span>
        </div>
        {papers.length === 0 ? (
          <div className="note small">No papers yet. Add an exam or test you’ve already made, or start a new paper.</div>
        ) : (
          <div className="list">
            {papers.map((a, i) => (
              <div key={a.id} className="item">
                <span className="strong" style={{ width: 22 }}>{i + 1}</span>
                <span className="grow">
                  <span className="name row" style={{ gap: 8 }}>
                    <span className={'kind ' + a.kind}>{kindLabel[a.kind]}</span> {a.title}
                  </span>
                  <span className="meta row wrap" style={{ gap: 8 }}>
                    {a.time_limit_min ? `${a.time_limit_min} min` : 'No time limit'}
                    {a.lockdown && <span className="pill dark"><Icon name="lock" size={12} /> Lockdown</span>}
                    {a.camera && <span className="pill dark"><Icon name="camera" size={12} /> Camera</span>}
                    {a.draft && <span className="pill claude">Draft</span>}
                  </span>
                </span>
                <VisibilityPill item={a} />
                <button className="btn ghost icon sm" aria-label={`Move ${a.title} up`} disabled={i === 0} onClick={() => setOrder(swap(papers.map((p) => p.id), i - 1))}>
                  <Icon name="up" size={14} />
                </button>
                <button className="btn ghost icon sm" aria-label={`Move ${a.title} down`} disabled={i === papers.length - 1} onClick={() => setOrder(swap(papers.map((p) => p.id), i))}>
                  <Icon name="down" size={14} />
                </button>
                <button className="btn sm" onClick={() => go(`/assignments/${a.id}`)}>
                  Open
                </button>
                <button className="btn ghost icon sm" aria-label={`Take ${a.title} out of the mock`} title="Take out of the mock (it stays as an assignment)" onClick={() => setOrder(papers.filter((p) => p.id !== a.id).map((p) => p.id), [a.id])}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="row wrap">
          <select className="select" style={{ width: 'auto', maxWidth: '100%' }} value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add a paper you already made">
            <option value="">Add a paper you already made…</option>
            {['exam', 'test', 'quiz', 'homework'].map((k) => {
              const list = free.filter((a) => a.kind === k);
              return list.length ? (
                <optgroup key={k} label={kindLabel[k] + (k === 'quiz' ? 'zes' : k === 'homework' ? '' : 's')}>
                  {list.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
          <button
            className="btn"
            disabled={!adding}
            onClick={async () => {
              await setOrder([...papers.map((p) => p.id), adding]);
              setAdding('');
            }}
          >
            Add
          </button>
          <span className="muted small">or</span>
          <button className="btn primary" onClick={newPaper}>
            <Icon name="plus" size={16} /> New paper
          </button>
        </div>
        <div className="tiny muted">
          To use a past paper or a StudyBridge practice paper, turn it into a test from <Link to="/library/papers">Past papers</Link> first, then add it here.
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Grade boundaries</h2>
          <span className="small muted">Private to you. Learners only ever see their grade.</span>
        </div>
        {!m.exam ? (
          <div className="note small">
            This mock isn’t linked to an exam yet. Set its subject’s exam in <Link to="/structure">Subjects</Link>, or add boundaries just for this mock below.
          </div>
        ) : forExam.length === 0 ? (
          <div className="note small">No grade boundaries for {examName(m.exam, lk)} yet. Add them once and every mock for this exam uses them.</div>
        ) : (
          <Field label="This mock uses" hint="New boundaries you add for this exam are used automatically, unless you choose a session here.">
            <select className="select" value={m.boundary_id || ''} onChange={(e) => saveMock({ boundary_id: e.target.value || null })}>
              <option value="">The newest: {boundaryLabel(forExam[0])}</option>
              {forExam.map((b) => (
                <option key={b.id} value={b.id}>
                  {boundaryLabel(b)} (out of {n(b.max_mark)})
                </option>
              ))}
            </select>
          </Field>
        )}
        {r?.boundary && <BoundaryChips b={r.boundary} />}
        <div>
          <button
            className="btn sm"
            onClick={async () => {
              if (!m.exam) await saveMock({ exam: examFor });
              setShowBounds((x) => !x);
            }}
          >
            {showBounds ? 'Hide' : forExam.length ? 'Add or change boundaries' : 'Add grade boundaries'}
          </button>
        </div>
        {showBounds && <GradeBoundaries exam={examFor} label={examName(examFor, lk)} />}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Results</h2>
          <span className="small muted">The grade shows once every paper is marked. Learners see it when you’ve given back the marks for every paper.</span>
        </div>
        {!r ? (
          results.error ? <div className="error">{results.error.message}</div> : <Loading />
        ) : !papers.length ? (
          <div className="muted small">Results show here once the mock has papers.</div>
        ) : !r.learners.length ? (
          <div className="muted small">No learners yet: the papers aren’t for anyone. Check who each paper “Goes to”.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Learner</th>
                  {papers.map((p, i) => (
                    <th key={p.id}>Paper {i + 1}</th>
                  ))}
                  <th>Total</th>
                  <th>Grade</th>
                  <th>Given back</th>
                </tr>
              </thead>
              <tbody>
                {r.learners.map((l) => (
                  <tr key={l.learner_id}>
                    <td className="strong">{l.name}</td>
                    {papers.map((p) => {
                      const x = (l.papers || []).find((y) => y.id === p.id);
                      return (
                        <td key={p.id}>
                          {!x || x.status === 'not_started' ? (
                            <span className="muted">Not started</span>
                          ) : x.status === 'doing' ? (
                            <span className="pill">Sitting it</span>
                          ) : x.status === 'submitted' ? (
                            <Link to={`/marking/${x.attempt_id}`} className="pill warn">
                              To mark
                            </Link>
                          ) : (
                            <Link to={`/marking/${x.attempt_id}`}>
                              {n(x.score)}/{n(x.max)}
                            </Link>
                          )}
                        </td>
                      );
                    })}
                    <td>
                      {l.total != null ? `${n(l.total)}/${n(l.max)}` : '—'}
                      {l.pct != null && <span className="muted"> · {l.pct}%</span>}
                    </td>
                    <td>
                      {l.grade ? (
                        <span className="stack" style={{ gap: 2 }}>
                          <span className="strong" style={{ fontSize: 18 }}>{l.grade}</span>
                          {l.next && <span className="tiny muted">{n(l.short_by)} short of {l.next}</span>}
                        </span>
                      ) : l.complete && !l.has_boundaries ? (
                        <span className="tiny muted">Add grade boundaries</span>
                      ) : (
                        <span className="muted">{l.marked}/{l.count} marked</span>
                      )}
                    </td>
                    <td>{l.released ? <span className="pill good">Yes</span> : l.complete ? <span className="pill">Not yet</span> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Page>
  );
}

function BoundaryChips({ b }) {
  return (
    <div className="row wrap small" style={{ gap: 6 }}>
      <span className="muted">
        {boundaryLabel(b)}, out of {n(b.max_mark)}:
      </span>
      {(b.grades || []).map((g) => (
        <span key={g.grade} className="pill">
          {g.grade} {n(g.min)}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grade boundaries for one exam: typed in, or read by Prof from the tutor's own grade-threshold PDF
// ---------------------------------------------------------------------------
const PRESETS = {
  'Cambridge A*–G': ['A*', 'A', 'B', 'C', 'D', 'E', 'F', 'G'],
  'Cambridge 9–1': ['9', '8', '7', '6', '5', '4', '3', '2', '1'],
  'IB 7–1': ['7', '6', '5', '4', '3', '2', '1'],
};

export function GradeBoundaries({ exam, label, sources = [] }) {
  const lk = useLookups();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery('boundaries', api.listBoundaries);
  const jobs = useQuery('prof-jobs', api.profJobs).data || [];
  const files = useQuery('files', api.listFiles).data || [];
  const usage = useQuery('prof-usage', api.profUsage).data;
  const [editing, setEditing] = useState(null);
  const [reading, setReading] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('sb.boundariesSeen') || '[]');
    } catch {
      return [];
    }
  });
  const list = (q.data || []).filter((b) => b.exam === exam);
  const mine = jobs.filter((j) => j.kind === 'boundaries' && j.context?.exam === exam);
  const running = mine.find((j) => ['queued', 'running', 'waiting'].includes(j.status));
  const proposal = mine.find((j) => j.status === 'done' && j.result?.boundaries && !dismissed.includes(j.id));
  const failed = mine.find((j) => j.status === 'failed' && !dismissed.includes(j.id));
  const dismiss = (id) => {
    const next = [...dismissed, id].slice(-100);
    setDismissed(next);
    try {
      localStorage.setItem('sb.boundariesSeen', JSON.stringify(next));
    } catch {
      /* fine */
    }
  };
  // Grade-threshold documents the tutor has for this exam (their library, and Cambridge's own on desktop)
  const [board, code] = exam.split(':');
  const gt = [
    ...files
      .filter((f) => f.exam_kind === 'gt' && f.exam_board === board && f.exam_code === code)
      .map((f) => ({ key: f.id, name: `${f.name} (your library)`, get: () => api.getBlob('library', f.storage_path) })),
    ...sources.map((s) => ({ key: s.url, name: `${s.name} (Cambridge)`, get: () => api.officialBlob(s.url) })),
  ];

  return (
    <div className="stack">
      {running && (
        <div className="note small row">
          <span className="spinner sm" /> Prof is reading the grade thresholds… You’ll get a notification.
        </div>
      )}
      {failed && (
        <div className="card warn small row between">
          <span>Prof couldn’t read them: {failed.error}</span>
          <button className="btn sm" onClick={() => dismiss(failed.id)}>
            OK
          </button>
        </div>
      )}
      {proposal && <BoundaryProposal job={proposal} exam={exam} onDone={() => dismiss(proposal.id)} />}
      {list.length === 0 ? (
        <div className="muted small">No grade boundaries for {label || examName(exam, lk)} yet.</div>
      ) : (
        <div className="list">
          {list.map((b) => (
            <div key={b.id} className="item" style={{ alignItems: 'flex-start' }}>
              <span className="grow stack sm">
                <span className="name row wrap" style={{ gap: 8 }}>
                  {boundaryLabel(b)}
                  {b.source === 'prof' && (
                    <span className="pill claude">
                      <Icon name="cap" size={12} /> Read by Prof
                    </span>
                  )}
                </span>
                <span className="row wrap small" style={{ gap: 6 }}>
                  <span className="muted">Out of {n(b.max_mark)}:</span>
                  {(b.grades || []).map((g) => (
                    <span key={g.grade} className="pill">
                      {g.grade} {n(g.min)}
                    </span>
                  ))}
                </span>
                <span className="tiny muted">Added {day(b.created_at)}</span>
              </span>
              <button className="btn ghost icon sm" aria-label="Edit boundaries" onClick={() => setEditing(b)}>
                <Icon name="pen" size={16} />
              </button>
              <button
                className="btn ghost icon sm"
                aria-label="Delete boundaries"
                onClick={async () => {
                  if (!(await confirm({ title: 'Delete these boundaries?', body: 'Mocks that used them switch to the newest boundaries left for this exam.', ok: 'Delete', danger: true }))) return;
                  await api.deleteBoundaries(b.id);
                  invalidate('boundaries', 'mock');
                }}
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row wrap">
        <button className="btn" onClick={() => setEditing({ exam, session: '', option_label: '', max_mark: '', grades: [] })}>
          <Icon name="pen" size={16} /> Type them in
        </button>
        <button className="btn claude" disabled={usage && !usage.ready} onClick={() => setReading(true)}>
          <Icon name="cap" size={16} /> Prof reads a grade-threshold PDF
        </button>
      </div>
      {usage && !usage.ready && <div className="tiny muted">{usage.why_not}</div>}
      {editing && <BoundaryForm initial={editing} onClose={() => setEditing(null)} />}
      {reading && <ReadThresholds exam={exam} label={label || examName(exam, lk)} sources={gt} onClose={() => setReading(false)} toast={toast} />}
    </div>
  );
}

function BoundaryForm({ initial, onClose }) {
  const toast = useToast();
  const [session, setSession] = useState(initial.session || '');
  const [option, setOption] = useState(initial.option_label || '');
  const [max, setMax] = useState(initial.max_mark ?? '');
  const [rows, setRows] = useState(() => (initial.grades?.length ? initial.grades.map((g) => ({ grade: g.grade, min: String(g.min) })) : PRESETS['Cambridge A*–G'].map((grade) => ({ grade, min: '' }))));
  const [err, setErr] = useState('');
  const set = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  async function submit(e) {
    e.preventDefault();
    const grades = rows.filter((r) => r.grade.trim() && String(r.min).trim() !== '').map((r) => ({ grade: r.grade.trim(), min: Number(r.min) }));
    if (!Number(max)) return setErr('Give the total marks the boundaries are out of.');
    if (!grades.length) return setErr('Fill in the lowest mark for at least one grade.');
    if (grades.some((g) => !Number.isFinite(g.min))) return setErr('Marks must be numbers.');
    try {
      await api.saveBoundaries({ ...(initial.id ? { id: initial.id } : { exam: initial.exam }), session: session.trim(), option_label: option.trim(), max_mark: Number(max), grades });
      invalidate('boundaries', 'mock');
      toast('Grade boundaries saved');
      onClose();
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <Modal title={initial.id ? 'Edit grade boundaries' : 'Add grade boundaries'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="grid g2" style={{ gap: 10 }}>
          <Field label="Session">
            <input className="input" value={session} onChange={(e) => setSession(e.target.value)} placeholder="e.g. June 2025" />
          </Field>
          <Field label="Option or tier (optional)">
            <input className="input" value={option} onChange={(e) => setOption(e.target.value)} placeholder="e.g. Extended (papers 2 and 4)" />
          </Field>
        </div>
        <Field label="Out of (total marks)" hint="The total the boundaries are for. A mock out of a different total is scaled, so the percentages stay the same.">
          <input className="input" type="number" min="1" step="any" style={{ maxWidth: 160 }} value={max} onChange={(e) => setMax(e.target.value)} />
        </Field>
        <div className="row wrap small">
          <span className="muted">Grades:</span>
          {Object.entries(PRESETS).map(([k, g]) => (
            <button key={k} type="button" className="btn sm ghost" onClick={() => setRows(g.map((grade) => ({ grade, min: rows.find((r) => r.grade === grade)?.min || '' })))}>
              {k}
            </button>
          ))}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Grade</th>
              <th>Lowest mark</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <input className="input" style={{ maxWidth: 90 }} value={r.grade} onChange={(e) => set(i, { grade: e.target.value })} aria-label={`Grade ${i + 1}`} />
                </td>
                <td>
                  <input className="input" type="number" min="0" step="any" style={{ maxWidth: 120 }} value={r.min} onChange={(e) => set(i, { min: e.target.value })} aria-label={`Lowest mark for ${r.grade || 'this grade'}`} />
                </td>
                <td>
                  <button type="button" className="btn ghost icon sm" aria-label="Remove grade" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    <Icon name="x" size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          <button type="button" className="btn sm" onClick={() => setRows([...rows, { grade: '', min: '' }])}>
            <Icon name="plus" size={14} /> Add a grade
          </button>
        </div>
        <div className="tiny muted">Leave a grade’s mark empty to leave it out. Below the lowest grade is a U.</div>
        {err && <div className="error">{err}</div>}
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function ReadThresholds({ exam, label, sources, onClose, toast }) {
  const [pick, setPick] = useState(sources[0]?.key || '');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef(null);
  async function go() {
    setErr('');
    setBusy(true);
    try {
      const blob = file || (await sources.find((s) => s.key === pick)?.get());
      if (!blob) throw new Error('Choose the grade-threshold PDF first.');
      await api.profBoundaries(exam, label, blob);
      invalidate('prof-jobs');
      toast({ title: 'Prof is reading it', body: 'You’ll check the numbers before anything is saved.' });
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Prof reads the grade thresholds" onClose={onClose}>
      <div className="stack">
        <div className="small muted">
          Prof copies the numbers out of your grade-threshold document for {label}. You check every number before it’s saved. Only the first 4 pages are sent.
        </div>
        {sources.length > 0 && (
          <Field label="From your papers">
            <select className="select" value={file ? '' : pick} onChange={(e) => (setPick(e.target.value), setFile(null))}>
              {sources.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="row wrap">
          <button type="button" className="btn sm" onClick={() => input.current?.click()}>
            <Icon name="upload" size={14} /> {sources.length ? 'Or choose a PDF on this computer' : 'Choose the PDF'}
          </button>
          {file && <span className="small">{file.name}</span>}
          <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
        {err && <div className="error">{err}</div>}
        <div className="foot row end">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn claude" disabled={busy || (!file && !pick)} onClick={go}>
            {busy ? 'Sending…' : 'Ask Prof'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function BoundaryProposal({ job, exam, onDone }) {
  const toast = useToast();
  const p = job.result.boundaries;
  const [on, setOn] = useState(() => p.options.map(() => true));
  const [busy, setBusy] = useState(false);
  return (
    <div className="card claude-card">
      <h3 className="row" style={{ margin: 0 }}>
        <Icon name="cap" style={{ color: 'var(--claude)' }} /> Prof read {p.options.length} set{p.options.length === 1 ? '' : 's'} of grade thresholds{p.session ? ` for ${p.session}` : ''}
      </h3>
      <div className="small">Check every number against the document. Tick the ones to save.</div>
      {p.note && <div className="small muted">{p.note}</div>}
      <div className="stack sm">
        {p.options.map((o, i) => (
          <label key={i} className="check" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={on[i]} onChange={(e) => setOn(on.map((x, j) => (j === i ? e.target.checked : x)))} />
            <span className="stack" style={{ gap: 4 }}>
              <span className="t">
                {o.option || 'Overall'} · out of {n(o.max_mark)}
              </span>
              <span className="row wrap" style={{ gap: 6 }}>
                {o.grades.map((g) => (
                  <span key={g.grade} className="pill">
                    {g.grade} {n(g.min)}
                  </span>
                ))}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="row wrap">
        <button
          className="btn primary"
          disabled={busy || !on.some(Boolean)}
          onClick={async () => {
            setBusy(true);
            try {
              for (const [i, o] of p.options.entries()) {
                if (on[i]) await api.saveBoundaries({ exam, session: p.session || '', option_label: o.option || '', max_mark: o.max_mark, grades: o.grades, source: 'prof' });
              }
              invalidate('boundaries', 'mock');
              toast('Grade boundaries saved');
              onDone();
            } catch (e) {
              toast({ title: 'Couldn’t save them', body: e.message, tone: 'bad' });
            } finally {
              setBusy(false);
            }
          }}
        >
          Save the ticked ones
        </button>
        <button className="btn" onClick={onDone}>
          Don’t use
        </button>
      </div>
    </div>
  );
}

// For the Prof page: a short summary of a boundaries request
export const boundaryJobLink = (r) => (r?.boundaries ? `/library/papers?exam=${encodeURIComponent(r.boundaries.exam)}` : null);
