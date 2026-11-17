// Second marking (Canvas gaps part 2, 17 Nov 2026): the teacher who set the work asks another teacher at their school or
// centre to mark some hand-ins (all, or a share at random) without seeing the first marks or the learner's name. The
// first teacher sees both marks side by side and agrees them, question by question, before giving marks back.
import { useEffect, useMemo, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import MathText from '../../ui/MathText.jsx';
import { Empty, Field, Link, Loading, Markdown, Modal, Page, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { invalidate, useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, kindLabel, typeLabel } from '../../lib/format.js';
import { withVars } from '../../lib/randomq.js';
import { AnswerDisplay, QuestionPrompt } from '../shared/Answer.jsx';
import { PassageBox, passageStarts } from './QuestionExtras.jsx';

export const useSecondMarkers = (on = true) => useQuery(on ? 'second-markers' : null, api.secondMarkers);
export const useSecondQueue = () => useQuery('second-queue', api.secondMarkQueue);
// attempt id → { status, marker } for one piece of work's marking list
export function useSecondFor(assignmentId) {
  const q = useQuery(assignmentId ? `second-for:${assignmentId}` : null, () => api.secondMarksFor(assignmentId));
  return useMemo(() => Object.fromEntries((q.data || []).map((x) => [x.attempt_id, x])), [q.data]);
}
export const secondText = (s) => (!s ? null : s.status === 'asked' ? `With ${s.marker} to second-mark` : s.status === 'done' ? 'Second marked: agree the marks' : 'Second marking agreed');

// Ask for second marking (from a piece of work's marking list)
export function AskSecondMarking({ assignment, onClose }) {
  const toast = useToast();
  const markers = useSecondMarkers().data;
  const [marker, setMarker] = useState('');
  const [share, setShare] = useState(100);
  const [busy, setBusy] = useState(false);
  async function ask(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const n = await api.secondMarkAsk(assignment.id, marker, share);
      invalidate(`second-for:${assignment.id}`, 'second-queue');
      toast(n ? `${n} hand-in${n === 1 ? '' : 's'} sent for second marking` : 'Nothing new to send: those are being second-marked already');
      onClose();
    } catch (x) {
      toast({ title: 'Couldn’t ask for second marking', body: x.message, tone: 'bad' });
      setBusy(false);
    }
  }
  return (
    <Modal title="Second marking" onClose={onClose}>
      <form className="stack" onSubmit={ask}>
        <div className="small muted">Another teacher marks the same hand-ins without seeing your marks or the learners’ names. You then see both side by side and agree the marks before giving them back.</div>
        {!markers ? (
          <Loading />
        ) : markers.length === 0 ? (
          <div className="note">Second marking is for schools and centres: there’s no other teacher here to ask.</div>
        ) : (
          <>
            <Field label="Who marks them">
              <select className="select" value={marker} onChange={(e) => setMarker(e.target.value)}>
                <option value="">Choose a teacher…</option>
                {markers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Which hand-ins">
              <select className="select" value={share} onChange={(e) => setShare(Number(e.target.value))}>
                <option value={100}>All of them</option>
                <option value={50}>Half, at random</option>
                <option value={25}>A quarter, at random</option>
                <option value={10}>One in ten, at random (at least one)</option>
              </select>
            </Field>
          </>
        )}
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !marker}>
            Ask for second marking
          </button>
        </div>
      </form>
    </Modal>
  );
}

// On the first teacher's marking page: where the second marking is, and agreeing the marks
export function SecondMarkCard({ d, attemptId, qs, onAgreed }) {
  const toast = useToast();
  const confirm = useConfirm();
  const sm = d.attempt.second;
  const [take, setTake] = useState({});
  const [busy, setBusy] = useState(false);
  if (!sm || sm.status === 'agreed') return sm ? <div className="small muted">Second marking agreed with {sm.marker}.</div> : null;
  const mine = Object.fromEntries((d.responses || []).map((r) => [r.question_id, r.marks]));
  async function agree() {
    setBusy(true);
    try {
      onAgreed?.(); // (marks typed on the page give way to the agreed ones)
      await api.secondMarkAgree(sm.id, take);
      invalidate(`attempt:${attemptId}`, 'second-queue');
      toast('Marks agreed. Give them back when you’re ready.');
    } catch (e) {
      toast({ title: 'Couldn’t agree the marks', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!(await confirm({ title: 'Cancel the second marking?', body: `${sm.marker} won’t mark this one any more.`, ok: 'Cancel it', cancel: 'Keep it' }))) return;
    try {
      await api.secondMarkCancel(sm.id);
      invalidate(`attempt:${attemptId}`, 'second-queue');
    } catch (e) {
      toast({ title: 'Couldn’t cancel it', body: e.message, tone: 'bad' });
    }
  }
  return (
    <div className="card">
      <h3 className="row">
        <Icon name="users" /> Second marking
      </h3>
      {sm.status === 'asked' ? (
        <div className="small">
          {sm.marker} is second-marking this. You can mark it too, but give marks back once you’ve agreed them.{' '}
          <button className="linkbtn" onClick={cancel}>
            Cancel it
          </button>
        </div>
      ) : (
        <div className="stack sm">
          <div className="small">
            {sm.marker}: <b>{Number(sm.total)}</b> marks · you: <b>{qs.reduce((s, q) => s + Number(mine[q.id] ?? 0), 0)}</b>
            {sm.note ? ` · “${sm.note}”` : ''}
          </div>
          <table className="table small">
            <thead>
              <tr>
                <th>Question</th>
                <th>Yours</th>
                <th>{sm.marker}</th>
                <th>Keep</th>
              </tr>
            </thead>
            <tbody>
              {qs.map((q, i) => {
                const theirs = sm.marks?.[q.id];
                const differs = theirs != null && Number(theirs) !== Number(mine[q.id] ?? -1);
                return (
                  <tr key={q.id}>
                    <td>{i + 1}</td>
                    <td>{mine[q.id] ?? '—'}</td>
                    <td className={differs ? 'strong' : ''}>{theirs ?? '—'}</td>
                    <td>
                      {differs ? (
                        <select className="select" style={{ minHeight: 30 }} value={take[q.id] || 'first'} onChange={(e) => setTake({ ...take, [q.id]: e.target.value })} aria-label={`Which mark to keep for question ${i + 1}`}>
                          <option value="first">Yours</option>
                          <option value="second">{sm.marker}’s</option>
                        </select>
                      ) : (
                        <span className="muted">Same</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button className="btn primary" disabled={busy} onClick={agree}>
            Agree these marks
          </button>
        </div>
      )}
    </div>
  );
}

// The second marker's list (Marking → Second marking)
export function SecondQueue() {
  const q = useSecondQueue();
  const mine = q.data?.mine;
  if (!mine) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  if (!mine.length) return <Empty>Nothing to second-mark.</Empty>;
  return (
    <div className="card pad0">
      <table className="table responsive">
        <thead>
          <tr>
            <th>Hand-in</th>
            <th>Work</th>
            <th>Asked by</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {mine.map((x) => (
            <tr key={x.id} className="click" onClick={() => go(`/second/${x.id}`)}>
              <td data-label="Hand-in">
                <Link to={`/second/${x.id}`}>{x.label}</Link>
              </td>
              <td data-label="Work">
                <div className="strong">{x.title}</div>
                <div className={'kind ' + x.kind}>{kindLabel[x.kind]}</div>
              </td>
              <td data-label="Asked by">
                {x.asked_by} · {ago(x.created_at)}
              </td>
              <td data-label="Status">
                <span className={'pill ' + (x.status === 'done' ? 'good' : 'warn')}>{x.status === 'done' ? 'Done (you can still change it)' : 'To mark'}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Second-marking one hand-in: the answers and the mark scheme, never the first marks or a name
export function SecondMarkPage({ id }) {
  const toast = useToast();
  const q = useQuery(`second:${id}`, () => api.secondMarkDetail(id));
  const d = q.data;
  const [marks, setMarks] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (d && marks === null) {
      // what they've saved, else what marked itself (choices and numbers)
      const auto = Object.fromEntries((d.answers || []).filter((r) => r.auto_marks != null).map((r) => [r.question_id, String(Number(r.auto_marks))]));
      setMarks({ ...auto, ...Object.fromEntries(Object.entries(d.marks || {}).map(([k, v]) => [k, String(v)])) });
      setNote(d.note || '');
    }
  }, [d, marks]);
  if (!d || !marks) return <Page title="Second marking">{q.error ? <div className="error">{q.error.message}</div> : <Loading />}</Page>;
  const qs = d.questions.map((x) => withVars(x, d.vars));
  const starts = passageStarts(qs);
  const ans = Object.fromEntries(d.answers.map((r) => [r.question_id, r.answer]));
  const keys = Object.fromEntries(d.keys.map((k) => [k.question_id, k]));
  const total = qs.reduce((s, x) => s + (Number(marks[x.id]) || 0), 0);
  const max = qs.reduce((s, x) => s + Number(x.marks || 0), 0);
  async function save(done) {
    setBusy(true);
    try {
      await api.secondMarkSave(id, marks, note, done);
      invalidate(`second:${id}`, 'second-queue');
      toast(done ? 'Sent to the teacher who asked' : 'Saved');
      if (done) go('/marking?tab=second');
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page
      size="wide"
      eyebrow={
        <Link to="/marking?tab=second">
          <Icon name="left" size={14} /> Second marking
        </Link>
      }
      title={d.assignment.title}
      subtitle={`${d.label} · no names and no first marks, so your marking stands on its own`}
    >
      <div className="split side-r">
        <div className="stack lg">
          {qs.map((x, i) => (
            <div key={x.id} className="stack">
              {starts[x.id] && <PassageBox p={d.passages.find((p) => p.id === starts[x.id])} />}
              <div className="qcard">
                <div className="qhead">
                  <span className="qnum">{i + 1}</span>
                  <span className="muted small">{typeLabel[x.type]}</span>
                  <span className="grow" />
                  <label className="row small" style={{ gap: 6 }}>
                    Mark
                    <input className="input sm num" type="number" min="0" max={Number(x.marks)} step="0.5" value={marks[x.id] ?? ''} onChange={(e) => setMarks({ ...marks, [x.id]: e.target.value })} aria-label={`Second mark for question ${i + 1}`} />/ {Number(x.marks)}
                  </label>
                </div>
                <QuestionPrompt q={x} />
                <div className="label">Their answer</div>
                <AnswerDisplay q={x} answer={ans[x.id] || {}} keyAns={keys[x.id]?.answer} />
                {keys[x.id]?.mark_scheme_md && (
                  <div className="note small">
                    <div className="tiny strong">Mark scheme</div>
                    <Markdown src={keys[x.id].mark_scheme_md} />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="stack lg mark-side">
          <div className="card mark-total">
            <h3>Your total</h3>
            <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
              <span className="score-big">{total}</span>
              <span className="muted">/ {max}</span>
            </div>
            <Field label="A note for the teacher who asked (optional)">
              <MathText value={note} onChange={setNote} label="A note for the teacher who asked" minHeight={60} />
            </Field>
            <button className="btn primary big" disabled={busy} onClick={() => save(true)}>
              <Icon name="send" size={18} /> Send my marks
            </button>
            <button className="btn" disabled={busy} onClick={() => save(false)}>
              Save, finish later
            </button>
          </div>
        </div>
      </div>
    </Page>
  );
}
