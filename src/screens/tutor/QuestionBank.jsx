import { useMemo, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import MathText from '../../ui/MathText.jsx';
import { Empty, Field, Loading, Markdown, Modal, Seg, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as X from '../../lib/exams.js';
import { typeLabel, kindLabel } from '../../lib/format.js';
import { useLookups } from '../shared/lookups.jsx';
import { useApp } from '../../App.jsx';

// A bank topic name ("Algebra") as one of the tutor's own topics in that subject, so progress counts it
export const topicMatcher = (lk, subjectId) => (name) => {
  if (!name || !subjectId) return null;
  const n = name.trim().toLowerCase();
  const list = lk.topicsOf(subjectId);
  return (list.find((t) => t.name.trim().toLowerCase() === n) || list.find((t) => t.name.toLowerCase().includes(n) || n.includes(t.name.toLowerCase())))?.id || null;
};

// Where a bank question belongs: an exam syllabus (0607) or one of the tutor's subjects
const groupOf = (b, lk) =>
  b.exam_code ? { key: 'x:' + b.exam_code, label: X.syllabusLabel(b.exam_board || 'cie', b.exam_code) } : b.subject_id ? { key: 's:' + b.subject_id, label: lk.subject(b.subject_id)?.name || 'Subject' } : { key: 'none', label: 'No subject' };

// ---------------------------------------------------------------------------
// The question bank: your questions, and StudyBridge's shared exam-style ones
// ---------------------------------------------------------------------------
export default function QuestionBank() {
  const bank = useQuery('bank', api.listBank);
  const app = useApp();
  const [asking, setAsking] = useState(false);
  const [practicing, setPracticing] = useState(false);
  const all = bank.data || [];
  const mine = all.filter((b) => b.owner_id === app.me.id);
  const waiting = mine.filter((b) => b.status === 'review');
  const usable = all.filter((b) => b.status === 'approved' && (b.owner_id === app.me.id || b.owner_id === null));

  if (!bank.data) return <Loading />;
  return (
    <div className="stack lg">
      <div className="row wrap between">
        <div className="small muted">
          {usable.length} question{usable.length === 1 ? '' : 's'} ready to use · yours and StudyBridge’s shared exam-style questions. Learners never see the bank, only the work you set from it.
        </div>
        <div className="row wrap">
          <button className="btn" onClick={() => setPracticing(true)} disabled={!usable.length}>
            <Icon name="target" size={18} /> Set practice for a learner
          </button>
          <button className="btn claude" onClick={() => setAsking(true)}>
            <Icon name="cap" size={18} /> Ask Prof for questions
          </button>
        </div>
      </div>
      {waiting.length > 0 && <ReviewQueue rows={waiting} title="Waiting for your approval" />}
      <BankBrowser rows={usable} />
      {asking && <AskProf onClose={() => setAsking(false)} />}
      {practicing && <PracticeBuilder rows={usable} onClose={() => setPracticing(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Practice: questions from the bank on a learner's weakest topics, approved by
// the tutor, done as often as the learner likes and marked instantly (no AI)
// ---------------------------------------------------------------------------
const AUTO = ['mcq', 'numeric'];
export function PracticeBuilder({ rows, onClose, learnerId = null }) {
  const lk = useLookups();
  const toast = useToast();
  const [learner, setLearner] = useState(learnerId || lk.learners[0]?.id || '');
  const progress = useQuery(learner ? `progress:${learner}` : null, () => api.learnerProgress(learner));
  const [onlyWeak, setOnlyWeak] = useState(true);
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const who = lk.learners.find((l) => l.id === learner);
  const weak = (progress.data?.topics || []).filter((t) => t.strength === 'weak' || t.strength === 'developing').sort((a, b) => (a.ratio ?? 0) - (b.ratio ?? 0));
  const weakNames = weak.map((t) => t.topic.toLowerCase());
  const isWeak = (b) => !!b.topic && weakNames.some((w) => w === b.topic.toLowerCase() || w.includes(b.topic.toLowerCase()) || b.topic.toLowerCase().includes(w));
  const auto = rows.filter((b) => AUTO.includes(b.type));
  const shown = onlyWeak && weak.length ? auto.filter(isWeak) : auto;
  const chosen = sel ?? shown.slice(0, 10).map((b) => b.id);
  const toggle = (id) => setSel((s) => ((s ?? chosen).includes(id) ? (s ?? chosen).filter((x) => x !== id) : [...(s ?? chosen), id]));
  const picked = auto.filter((b) => chosen.includes(b.id));
  const topics = [...new Set(picked.map((b) => b.topic).filter(Boolean))];
  const [title, setTitle] = useState('');
  const subject = (() => {
    const ids = [...new Set(weak.map((t) => t.subject_id))];
    return ids.length === 1 ? ids[0] : lk.subjects.length === 1 ? lk.subjects[0].id : null;
  })();

  async function give() {
    setBusy(true);
    try {
      await api.practiceFromBank(picked, { learnerId: learner, title: title.trim() || `Practice: ${topics.slice(0, 3).join(', ') || 'mixed topics'}`, subject_id: subject, topicIdFor: topicMatcher(lk, subject) });
      invalidate('assignments');
      invalidate('bank');
      toast({ title: `Practice set for ${who?.display_name}`, body: 'They can do it as often as they like; it’s marked straight away.' });
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t set it', body: e.message, tone: 'bad' });
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Set practice for a learner"
      wide
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !picked.length || !learner} onClick={give}>
            <Icon name="send" size={18} /> Give {picked.length} question{picked.length === 1 ? '' : 's'} to {who?.display_name || '…'}
          </button>
        </>
      }
    >
      <div className="grid g2">
        <Field label="Learner">
          <select className="select" value={learner} onChange={(e) => (setLearner(e.target.value), setSel(null))}>
            {lk.learners.map((l) => (
              <option key={l.id} value={l.id}>
                {l.display_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`Practice: ${topics.slice(0, 3).join(', ') || 'mixed topics'}`} />
        </Field>
      </div>
      <div className="small">
        {progress.data ? (
          weak.length ? (
            <>
              Topics {who?.display_name} finds hardest:{' '}
              {weak.slice(0, 6).map((t) => (
                <span key={t.topic_id} className={'pill ' + (t.strength === 'weak' ? 'bad' : 'warn')} style={{ marginRight: 4 }}>
                  {t.topic} {Math.round((t.ratio || 0) * 100)}%
                </span>
              ))}
            </>
          ) : (
            <span className="muted">No weak topics yet from marked work, so all bank questions are shown.</span>
          )
        ) : (
          <span className="muted">Looking at their progress…</span>
        )}
      </div>
      {weak.length > 0 && (
        <Seg
          value={onlyWeak ? 'weak' : 'all'}
          onChange={(v) => (setOnlyWeak(v === 'weak'), setSel(null))}
          options={[
            { value: 'weak', label: 'Their weak topics' },
            { value: 'all', label: 'All questions' },
          ]}
        />
      )}
      <div className="tiny muted">Only questions that mark themselves (multiple choice and number answers) are used for practice, so it’s marked instantly with no AI.</div>
      {shown.length === 0 ? (
        <div className="note small">No auto-marked questions in the bank {onlyWeak && weak.length ? 'on these topics yet' : 'yet'}. Ask Prof to write some for these topics first.</div>
      ) : (
        <div className="stack sm" style={{ maxHeight: 380, overflowY: 'auto' }}>
          {shown.map((b) => (
            <label key={b.id} className={'card bank-q row top' + (chosen.includes(b.id) ? ' chosen' : '')}>
              <input type="checkbox" checked={chosen.includes(b.id)} onChange={() => toggle(b.id)} style={{ marginTop: 4 }} />
              <span className="grow stack sm">
                <Markdown src={b.prompt_md} />
                <span className="row wrap tiny muted" style={{ gap: 8 }}>
                  {b.topic && <span>{b.topic}</span>}
                  {b.difficulty && <span>{X.DIFFICULTY[b.difficulty]}</span>}
                  <span>{typeLabel[b.type]}</span>
                  <span>Answer: {X.answerText(b)}</span>
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function BankBrowser({ rows, picking = null, onPick }) {
  const lk = useLookups();
  const toast = useToast();
  const confirm = useConfirm();
  const app = useApp();
  const [source, setSource] = useState('all');
  const [group, setGroup] = useState('');
  const [topic, setTopic] = useState('');
  const [diff, setDiff] = useState('');
  const [text, setText] = useState('');
  const [sel, setSel] = useState([]);
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null);
  const [making, setMaking] = useState(false);

  const groups = useMemo(() => {
    const m = new Map();
    for (const b of rows) {
      const g = groupOf(b, lk);
      m.set(g.key, g.label);
    }
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows, lk]);
  const inGroup = rows.filter((b) => !group || groupOf(b, lk).key === group);
  const topics = [...new Set(inGroup.map((b) => b.topic).filter(Boolean))].sort();
  const list = inGroup.filter(
    (b) =>
      (source === 'all' || (source === 'mine' ? b.owner_id === app.me.id : b.owner_id === null)) &&
      (!topic || b.topic === topic) &&
      (!diff || String(b.difficulty) === diff) &&
      (!text || (b.prompt_md + ' ' + (b.topic || '')).toLowerCase().includes(text.toLowerCase())),
  );
  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const chosen = rows.filter((b) => sel.includes(b.id));

  return (
    <div className="stack">
      <div className="row wrap">
        <Seg
          value={source}
          onChange={setSource}
          options={[
            { value: 'all', label: 'All' },
            { value: 'mine', label: 'Mine' },
            { value: 'shared', label: 'StudyBridge' },
          ]}
        />
        <select className="select" style={{ width: 'auto' }} value={group} onChange={(e) => (setGroup(e.target.value), setTopic(''))} aria-label="Subject">
          <option value="">All subjects</option>
          {groups.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 'auto' }} value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Topic">
          <option value="">All topics</option>
          {topics.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select className="select" style={{ width: 'auto' }} value={diff} onChange={(e) => setDiff(e.target.value)} aria-label="Difficulty">
          <option value="">Any difficulty</option>
          {Object.entries(X.DIFFICULTY).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input className="input" style={{ width: 200 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Search questions" aria-label="Search questions" />
      </div>

      {list.length === 0 ? (
        <Empty title={rows.length ? 'Nothing matches' : 'No questions yet'}>
          {rows.length ? 'Try other filters.' : 'Save questions from any assignment (“Save to bank”), or ask Prof to write some. StudyBridge’s shared questions appear here as they’re approved.'}
        </Empty>
      ) : (
        <>
          <div className="row wrap between">
            <div className="small muted">
              {list.length} question{list.length === 1 ? '' : 's'}
              {sel.length > 0 && ` · ${sel.length} chosen (${chosen.reduce((n, b) => n + Number(b.marks || 0), 0)} marks)`}
            </div>
            <div className="row">
              <button className="btn sm ghost" onClick={() => setSel((s) => [...new Set([...s, ...list.map((b) => b.id)])])}>
                Choose all {list.length}
              </button>
              {sel.length > 0 && (
                <button className="btn sm ghost" onClick={() => setSel([])}>
                  Clear
                </button>
              )}
              {picking ? (
                <button className="btn primary" disabled={!sel.length} onClick={() => onPick(chosen)}>
                  <Icon name="plus" size={18} /> {picking} {sel.length || ''}
                </button>
              ) : (
                <button className="btn primary" disabled={!sel.length} onClick={() => setMaking(true)}>
                  <Icon name="clipboard" size={18} /> Make an assignment
                </button>
              )}
            </div>
          </div>
          <div className="stack sm">
            {list.slice(0, 300).map((b) => (
              <div key={b.id} className={'card bank-q' + (sel.includes(b.id) ? ' chosen' : '')}>
                <div className="row top">
                  <input type="checkbox" checked={sel.includes(b.id)} onChange={() => toggle(b.id)} aria-label="Choose question" style={{ marginTop: 4 }} />
                  <div className="grow stack sm" onClick={() => setOpen(open === b.id ? null : b.id)} style={{ cursor: 'pointer' }}>
                    <Markdown src={b.prompt_md} />
                    <div className="row wrap tiny muted" style={{ gap: 8 }}>
                      <span className={'pill ' + (b.owner_id ? '' : 'accent')}>{b.owner_id ? 'Yours' : 'StudyBridge'}</span>
                      {b.topic && <span>{b.topic}</span>}
                      {b.difficulty && <span>{X.DIFFICULTY[b.difficulty]}</span>}
                      <span>{typeLabel[b.type]}</span>
                      <span>
                        {Number(b.marks)} mark{Number(b.marks) === 1 ? '' : 's'}
                      </span>
                      {b.uses > 0 && <span>used {b.uses}×</span>}
                    </div>
                    {open === b.id && <BankDetail b={b} />}
                  </div>
                  {b.owner_id === app.me.id && !picking && (
                    <div className="row" style={{ gap: 4 }}>
                      <button className="btn sm ghost icon" aria-label="Edit" onClick={() => setEdit(b)}>
                        <Icon name="pen" size={16} />
                      </button>
                      <button
                        className="btn sm ghost icon"
                        aria-label="Delete"
                        onClick={async () => {
                          if (!(await confirm({ title: 'Delete this question from your bank?', body: 'Assignments already using it keep their copy.', ok: 'Delete', danger: true }))) return;
                          await api.remove('bank_questions', b.id);
                          invalidate('bank');
                          toast('Deleted');
                        }}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {edit && <BankEdit b={edit} onClose={() => setEdit(null)} />}
      {making && <MakeAssignment rows={chosen} onClose={() => setMaking(false)} />}
    </div>
  );
}

function BankDetail({ b }) {
  const opts = Array.isArray(b.options) ? b.options : b.options?.items || [];
  return (
    <div className="stack sm bank-detail" onClick={(e) => e.stopPropagation()}>
      {b.type === 'mcq' && (
        <ol type="A" className="small" style={{ margin: 0 }}>
          {opts.map((o, i) => (
            <li key={i}>
              <Markdown src={String(o)} />
            </li>
          ))}
        </ol>
      )}
      <div className="small">
        <b>Answer:</b> <Markdown className="inline" src={X.answerText(b) || '—'} />
      </div>
      {b.mark_scheme_md && (
        <div className="small">
          <b>Mark scheme:</b> <Markdown className="inline" src={b.mark_scheme_md} />
        </div>
      )}
      {b.solution_md && (
        <div className="small">
          <b>Worked solution:</b>
          <Markdown src={b.solution_md} />
        </div>
      )}
      {b.check_result && (
        <div className={'small ' + (b.check_result.ok ? 'good-text' : 'bad-text')}>
          <Icon name={b.check_result.ok ? 'check' : 'alert'} size={14} /> Automatic check: {b.check_result.ok ? 'agrees with the answer' : `doesn’t agree — ${b.check_result.note || `it got ${b.check_result.my_answer}`}`}
        </div>
      )}
      {b.source_ref && <div className="tiny muted">From {b.source_ref}</div>}
    </div>
  );
}

// Approve or reject questions Prof wrote (your own, or — for the admin — the shared ones)
export function ReviewQueue({ rows, title, batch = 20 }) {
  const toast = useToast();
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const shown = rows.slice(0, batch);
  const ok = shown.filter((b) => b.check_result?.ok === true);
  const unchecked = shown.filter((b) => !b.check_result).length;
  async function setStatus(ids, status) {
    setBusy(true);
    try {
      await api.setBankStatus(ids, status);
      invalidate('bank');
      toast(status === 'approved' ? `Approved ${ids.length}` : `Rejected ${ids.length}`);
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card claude stack">
      <div className="row wrap between">
        <h3 style={{ margin: 0 }}>
          {title} <span className="pill claude">{rows.length}</span>
        </h3>
        <button className="btn primary sm" disabled={busy || !ok.length} onClick={() => setStatus(ok.map((b) => b.id), 'approved')}>
          <Icon name="check" size={16} /> Approve {ok.length} the check agreed with
        </button>
      </div>
      <div className="small muted">
        Check each answer and mark scheme. Questions the automatic check flagged are marked in red; fix or reject those.
        {unchecked > 0 && ` ${unchecked} ${unchecked === 1 ? 'is' : 'are'} still being checked.`}
        {rows.length > batch ? ` Showing ${batch} at a time.` : ''}
      </div>
      <div className="stack sm">
        {shown.map((b) => (
          <div key={b.id} className={'card bank-q' + (b.check_result?.ok === false ? ' flagged' : '')}>
            <div className="row top">
              <div className="grow stack sm">
                <Markdown src={b.prompt_md} />
                <div className="row wrap tiny muted" style={{ gap: 8 }}>
                  {b.exam_code && <span>{b.exam_code}</span>}
                  {b.topic && <span>{b.topic}</span>}
                  {b.difficulty && <span>{X.DIFFICULTY[b.difficulty]}</span>}
                  <span>{typeLabel[b.type]}</span>
                  <span>
                    {Number(b.marks)} mark{Number(b.marks) === 1 ? '' : 's'}
                  </span>
                </div>
                <BankDetail b={b} />
              </div>
              <div className="stack sm">
                <button className="btn sm primary" disabled={busy} onClick={() => setStatus([b.id], 'approved')}>
                  Approve
                </button>
                <button className="btn sm" onClick={() => setEdit(b)}>
                  Edit
                </button>
                <button className="btn sm ghost" disabled={busy} onClick={() => setStatus([b.id], 'rejected')}>
                  Reject
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {edit && <BankEdit b={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function BankEdit({ b, onClose }) {
  const toast = useToast();
  const [x, setX] = useState({ ...b, answer: { ...(b.answer || {}) }, optionsText: (Array.isArray(b.options) ? b.options : b.options?.items || []).join('\n') });
  const set = (p) => setX((v) => ({ ...v, ...p }));
  const setA = (p) => setX((v) => ({ ...v, answer: { ...v.answer, ...p } }));
  async function saveIt() {
    try {
      const opts = x.optionsText.split('\n').map((s) => s.trim()).filter(Boolean);
      await api.saveBank({
        id: b.id,
        prompt_md: x.prompt_md,
        topic: x.topic || null,
        difficulty: x.difficulty ? Number(x.difficulty) : null,
        marks: Number(x.marks) || 0,
        options: x.type === 'mcq' ? (Array.isArray(b.options) ? opts : { ...b.options, items: opts }) : [],
        answer: x.answer,
        mark_scheme_md: x.mark_scheme_md || null,
        solution_md: x.solution_md || null,
        check_result: b.check_result ? { ...b.check_result, edited: true } : null,
        updated_at: new Date().toISOString(),
      });
      invalidate('bank');
      toast('Saved');
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    }
  }
  return (
    <Modal
      title="Edit question"
      wide
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={saveIt}>
            Save
          </button>
        </>
      }
    >
      <Field label="Question">
        <textarea className="textarea" style={{ minHeight: 110 }} value={x.prompt_md} onChange={(e) => set({ prompt_md: e.target.value })} />
      </Field>
      {x.type === 'mcq' && (
        <div className="grid g2">
          <Field label="Options (one per line)">
            <textarea className="textarea" value={x.optionsText} onChange={(e) => set({ optionsText: e.target.value })} />
          </Field>
          <Field label="Correct option (A, B, C…)">
            <input className="input" value={x.answer.choice != null ? String.fromCharCode(65 + Number(x.answer.choice)) : ''} onChange={(e) => setA({ choice: String(Math.max(0, e.target.value.toUpperCase().charCodeAt(0) - 65)) })} />
          </Field>
        </div>
      )}
      {x.type === 'numeric' && (
        <div className="grid g2">
          <Field label="Answer">
            <input className="input" value={x.answer.value || ''} onChange={(e) => setA({ value: e.target.value })} />
          </Field>
          <Field label="Allow ±">
            <input className="input" value={x.answer.tolerance || '0'} onChange={(e) => setA({ tolerance: e.target.value })} />
          </Field>
        </div>
      )}
      {x.type === 'steps' && (
        <Field label="Final line (LaTeX)">
          <input className="input" value={x.answer.final || ''} onChange={(e) => setA({ final: e.target.value })} />
        </Field>
      )}
      {x.type === 'short' && (
        <Field label="Model answer">
          <textarea className="textarea" value={x.answer.text || ''} onChange={(e) => setA({ text: e.target.value })} />
        </Field>
      )}
      <div className="grid g2">
        <Field label="Topic">
          <input className="input" value={x.topic || ''} onChange={(e) => set({ topic: e.target.value })} />
        </Field>
        <div className="grid g2">
          <Field label="Marks">
            <input className="input" type="number" min="0" value={x.marks} onChange={(e) => set({ marks: e.target.value })} />
          </Field>
          <Field label="Difficulty">
            <select className="select" value={x.difficulty || ''} onChange={(e) => set({ difficulty: e.target.value })}>
              <option value="">—</option>
              {Object.entries(X.DIFFICULTY).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <Field label="Mark scheme">
        <MathText value={x.mark_scheme_md || ''} onChange={(v) => set({ mark_scheme_md: v })} label="Mark scheme" />
      </Field>
      <Field label="Worked solution">
        <MathText value={x.solution_md || ''} onChange={(v) => set({ solution_md: v })} label="Worked solution" />
      </Field>
    </Modal>
  );
}

function MakeAssignment({ rows, onClose }) {
  const lk = useLookups();
  const toast = useToast();
  const [kind, setKind] = useState('homework');
  const [title, setTitle] = useState(() => {
    const t = [...new Set(rows.map((b) => b.topic).filter(Boolean))];
    return t.length === 1 ? `${t[0]} practice` : 'Practice questions';
  });
  const [subject, setSubject] = useState(rows.find((b) => b.subject_id)?.subject_id || '');
  const [busy, setBusy] = useState(false);
  async function make() {
    setBusy(true);
    try {
      const a = await api.assignmentFromBank(rows, { title: title.trim() || 'Practice questions', kind, subject_id: subject || null, topicIdFor: topicMatcher(lk, subject) });
      invalidate('assignments');
      invalidate('bank');
      toast({ title: 'Assignment made', body: 'It’s hidden until you post it. Check it over first.' });
      go(`/assignments/${a.id}`);
    } catch (e) {
      toast({ title: 'Couldn’t make it', body: e.message, tone: 'bad' });
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Make an assignment from ${rows.length} question${rows.length === 1 ? '' : 's'}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={make}>
            Make it
          </button>
        </>
      }
    >
      <Field label="Title">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="grid g2">
        <Field label="Kind">
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {['homework', 'quiz', 'test', 'exam'].map((k) => (
              <option key={k} value={k}>
                {kindLabel[k] || k}
              </option>
            ))}
          </select>
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
      </div>
    </Modal>
  );
}

function AskProf({ onClose, shared = false }) {
  const lk = useLookups();
  const toast = useToast();
  const settings = useQuery('tutor_settings', api.getSettings);
  const exams = [...new Set([...lk.subjects.map((s) => s.exam).filter(Boolean), ...(settings.data?.exam_subjects || [])])].filter((k) => k.startsWith('cie:') || k.startsWith('ib:'));
  const [where, setWhere] = useState(shared ? 'cie:0607' : exams[0] || (lk.subjects[0] ? 's:' + lk.subjects[0].id : ''));
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState(10);
  const [diff, setDiff] = useState('');
  const [busy, setBusy] = useState(false);
  const code = where.startsWith('cie:') || where.startsWith('ib:') ? where.split(':')[1] : null;
  const suggestions = code ? X.topicsFor(code) : lk.topicsOf(where.slice(2)).map((t) => t.name);
  async function ask() {
    if (topic.trim().length < 2) return toast({ title: 'Choose a topic', tone: 'bad' });
    setBusy(true);
    try {
      await api.profBank({
        board: code ? where.split(':')[0] : null,
        code,
        subject: where.startsWith('s:') ? where.slice(2) : null,
        topic: topic.trim(),
        count: Number(count),
        difficulty: diff ? Number(diff) : null,
        shared,
      });
      toast({ title: 'Prof is writing them', body: 'They’ll wait here for your approval, each with an automatic second check.' });
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t ask Prof', body: e.message, tone: 'bad' });
      setBusy(false);
    }
  }
  return (
    <Modal
      title={shared ? 'Add shared StudyBridge questions' : 'Ask Prof for bank questions'}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn claude" disabled={busy} onClick={ask}>
            <Icon name="cap" size={18} /> Write {count} questions
          </button>
        </>
      }
    >
      <Field label="Syllabus or subject">
        <select className="select" value={where} onChange={(e) => (setWhere(e.target.value), setTopic(''))}>
          {!shared && lk.subjects.length > 0 && (
            <optgroup label="Your subjects">
              {lk.subjects.map((s) => (
                <option key={s.id} value={'s:' + s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Exam syllabuses">
            {[...new Set([...exams, 'cie:0607', 'cie:0580', 'cie:0606'])].map((k) => (
              <option key={k} value={k}>
                {X.syllabusLabel(k.split(':')[0], k.split(':')[1])}
              </option>
            ))}
          </optgroup>
        </select>
      </Field>
      <Field label="Topic">
        <input className="input" list="bank-topics" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Simultaneous equations" />
        <datalist id="bank-topics">
          {suggestions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </Field>
      {suggestions.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {suggestions.map((t) => (
            <button key={t} className={'pill click' + (topic === t ? ' accent' : '')} onClick={() => setTopic(t)}>
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="grid g2">
        <Field label="How many">
          <input className="input" type="number" min="1" max="30" value={count} onChange={(e) => setCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} />
        </Field>
        <Field label="Difficulty">
          <select className="select" value={diff} onChange={(e) => setDiff(e.target.value)}>
            <option value="">A mix</option>
            {Object.entries(X.DIFFICULTY).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="tiny muted">Prof writes original exam-style questions, then a second automatic check re-solves each one. Nothing is used until {shared ? 'you approve it for every tutor' : 'you approve it'}.</div>
    </Modal>
  );
}
export { AskProf };

// For the assignment editor: pick questions from the bank
export function BankPicker({ onClose, onPick }) {
  const bank = useQuery('bank', api.listBank);
  const app = useApp();
  const rows = (bank.data || []).filter((b) => b.status === 'approved' && (b.owner_id === app.me.id || b.owner_id === null));
  return (
    <Modal title="Add questions from the bank" wide onClose={onClose}>
      {!bank.data ? <Loading /> : <BankBrowser rows={rows} picking="Add" onPick={onPick} />}
    </Modal>
  );
}
