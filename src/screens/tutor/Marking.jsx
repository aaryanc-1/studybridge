import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Link, Loading, Modal, Page, Seg, Toggle, copyText, go, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import DrawingPad, { drawStrokes } from '../../ui/DrawingPad.jsx';
import { useBlob } from '../../ui/media.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ProfMarkCard } from './Prof.jsx';
import { checkSteps } from '../../lib/steps.js';
import { ago, dur, kindLabel, pct, typeLabel, when } from '../../lib/format.js';
import { useLookups } from '../shared/lookups.jsx';
import { QuestionPrompt, AnswerDisplay } from '../shared/Answer.jsx';
import { StatusPill } from './Learners.jsx';

export default function Marking() {
  const lk = useLookups();
  const route = useRoute();
  const attempts = useQuery('attempts', api.listAttempts);
  const assignments = useQuery('assignments', api.listAssignments).data || [];
  const [tab, setTab] = useState('submitted');
  const only = route.query.get('a');
  const aById = Object.fromEntries(assignments.map((a) => [a.id, a]));
  const all = (attempts.data || []).filter((t) => !only || t.assignment_id === only);
  const groups = {
    submitted: all.filter((t) => t.status === 'submitted'),
    unreleased: all.filter((t) => t.status === 'marked' && !t.released),
    in_progress: all.filter((t) => t.status === 'in_progress' || t.status === 'returned'),
    done: all.filter((t) => t.status === 'marked' && t.released),
  };
  const list = groups[tab];

  return (
    <Page
      title="Marking"
      subtitle={only && aById[only] ? `Submissions for “${aById[only].title}”` : 'Everything learners have handed in.'}
      actions={
        only ? (
          <button className="btn" onClick={() => go('/marking')}>
            Show all assignments
          </button>
        ) : null
      }
    >
      <Seg
        value={tab}
        onChange={setTab}
        options={[
          { value: 'submitted', label: `To mark (${groups.submitted.length})` },
          { value: 'unreleased', label: `Marked, not returned (${groups.unreleased.length})` },
          { value: 'in_progress', label: `In progress (${groups.in_progress.length})` },
          { value: 'done', label: `Returned (${groups.done.length})` },
        ]}
      />
      {attempts.data && list.length === 0 ? (
        <Empty>{tab === 'submitted' ? 'All caught up. New submissions appear here straight away.' : 'Nothing here.'}</Empty>
      ) : (
        <div className="card pad0">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Learner</th>
                <th>Assignment</th>
                <th>Status</th>
                <th>Score</th>
                <th>Time</th>
                <th>{tab === 'in_progress' ? 'Started' : 'Submitted'}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => {
                const a = aById[t.assignment_id];
                const late = a?.due_at && t.submitted_at && new Date(t.submitted_at) > new Date(a.due_at);
                return (
                  <tr key={t.id} className="click" onClick={() => go(t.status === 'in_progress' && a?.camera ? `/watch/${t.id}` : `/marking/${t.id}`)}>
                    <td data-label="Learner">
                      <div className="row">
                        <Avatar person={lk.learner(t.learner_id)} size="sm" />
                        {lk.learner(t.learner_id)?.display_name || 'Former learner'}
                      </div>
                    </td>
                    <td data-label="Assignment">
                      <div className="strong">{a?.title}</div>
                      <div className={'kind ' + a?.kind}>
                        {kindLabel[a?.kind]}
                        {t.number > 1 ? ` · attempt ${t.number}` : ''}
                      </div>
                    </td>
                    <td data-label="Status">
                      <div className="row wrap" style={{ gap: 6 }}>
                        <StatusPill t={t} />
                        {late && <span className="pill bad">Late</span>}
                        {(t.lockdown_events || []).length > 0 && <span className="pill warn"><Icon name="alert" size={12} /> {t.lockdown_events.length}</span>}
                      </div>
                    </td>
                    <td data-label="Score">{t.score != null ? `${Number(t.score)} / ${Number(t.max_score)}` : '—'}</td>
                    <td data-label="Time">{dur(t.time_spent_sec)}</td>
                    <td data-label="When">{ago(tab === 'in_progress' ? t.started_at : t.submitted_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

export function MarkAttempt({ id }) {
  const lk = useLookups();
  const toast = useToast();
  const confirm = useConfirm();
  const detail = useQuery(`attempt:${id}`, () => api.attemptDetail(id));
  const assignmentId = detail.data?.attempt.assignment_id;
  const assignment = useQuery(assignmentId ? `assignment:${assignmentId}` : null, () => api.getAssignment(assignmentId));
  const questions = useQuery(assignmentId ? `questions:${assignmentId}` : null, () => api.listQuestions(assignmentId));
  const comments = useQuery('comments', api.listComments).data || [];
  const attempts = useQuery('attempts', api.listAttempts).data || [];
  const [local, setLocal] = useState({}); // response id -> edits
  const [feedback, setFeedback] = useState(null);
  const [saving, setSaving] = useState(0);
  const [annotating, setAnnotating] = useState(null);
  const timers = useRef({});

  const d = detail.data;
  const a = assignment.data;
  const qs = questions.data || [];
  const learner = d ? lk.learner(d.attempt.learner_id) : null;

  useEffect(() => {
    if (d && feedback === null) setFeedback(d.attempt.feedback_md || '');
  }, [d, feedback]);

  const responses = useMemo(() => {
    const m = {};
    for (const r of d?.responses || []) m[r.question_id] = { ...r, ...(local[r.id] || {}) };
    return m;
  }, [d, local]);

  const save = useCallback(
    (rid, patch) => {
      setLocal((x) => ({ ...x, [rid]: { ...(x[rid] || {}), ...patch } }));
      clearTimeout(timers.current[rid]);
      timers.current[rid] = setTimeout(async () => {
        setSaving((n) => n + 1);
        try {
          await api.updateResponse(rid, patch.__all || patch);
        } catch (e) {
          toast({ title: 'Couldn’t save that mark', body: e.message, tone: 'bad' });
        } finally {
          setSaving((n) => n - 1);
        }
      }, 500);
    },
    [toast],
  );
  // Keep all pending edits for a response together
  const edit = (r, patch) => {
    const merged = { ...(local[r.id] || {}), ...patch };
    delete merged.__all;
    save(r.id, { ...patch, __all: merged });
  };

  async function flushSaves() {
    for (const [rid, t] of Object.entries(timers.current)) {
      clearTimeout(t);
      const patch = { ...(local[rid] || {}) };
      delete patch.__all;
      if (Object.keys(patch).length) await api.updateResponse(rid, patch);
    }
    timers.current = {};
  }

  if (detail.error) return <Page title="Marking"><div className="error">{detail.error.message}</div></Page>;
  if (!d || !a) return <Loading />;

  const total = qs.reduce((s, q) => s + Number(responses[q.id]?.marks ?? 0), 0);
  const max = qs.reduce((s, q) => s + Number(q.marks || 0), 0);
  const unmarked = qs.filter((q) => responses[q.id]?.marks == null).length;
  const redoCount = qs.filter((q) => responses[q.id]?.redo).length;
  const late = a.due_at && d.attempt.submitted_at && new Date(d.attempt.submitted_at) > new Date(a.due_at);
  const others = attempts.filter((t) => t.assignment_id === a.id && t.status === 'submitted' && t.id !== id);

  async function finish(release) {
    if (unmarked > 0 && !(await confirm({ title: `${unmarked} question${unmarked > 1 ? 's have' : ' has'} no mark yet`, body: 'They’ll count as 0. Carry on?', ok: 'Carry on' }))) return;
    try {
      await flushSaves();
      await api.finishMarking(id, release, feedback || null);
      invalidate('attempts', `attempt:${id}`);
      toast(redoCount ? 'Sent back for redo' : release ? 'Marks returned' : 'Saved. Not returned yet.');
      if (others[0]) go(`/marking/${others[0].id}`);
      else go('/marking');
    } catch (e) {
      toast({ title: 'Couldn’t finish', body: e.message, tone: 'bad' });
    }
  }

  const claudePrompt = `Using StudyBridge, mark ${learner?.display_name || 'my learner'}’s “${a.title}” (attempt ${id.slice(0, 8)}). Show what was wrong with explanations and draft marks for me to review.`;

  return (
    <Page
      size="wide"
      eyebrow={
        <>
          <Link to="/marking">Marking</Link> <Icon name="right" size={14} /> <span className={'kind ' + a.kind}>{kindLabel[a.kind]}</span>
        </>
      }
      title={a.title}
      subtitle={
        <span className="row wrap" style={{ gap: 10 }}>
          <Avatar person={learner} size="sm" />
          <span className="strong">{learner?.display_name}</span>
          {d.attempt.number > 1 && <span>Attempt {d.attempt.number}</span>}
          <span>{d.attempt.submitted_at ? `Submitted ${when(d.attempt.submitted_at)}` : `Started ${when(d.attempt.started_at)} · not submitted yet`}</span>
          {late && <span className="pill bad">Late</span>}
          <span>Time on it: {dur(d.attempt.time_spent_sec)}</span>
          <StatusPill t={{ ...d.attempt, released: d.attempt.released }} />
        </span>
      }
      actions={<span className="save-state">{saving > 0 ? 'Saving…' : 'Saved'}</span>}
    >
      {(d.attempt.lockdown_events || []).length > 0 && (
        <div className="card warn">
          <h3 className="row">
            <Icon name="alert" /> Lockdown alerts
          </h3>
          <div className="list small">
            {d.attempt.lockdown_events.map((e, i) => (
              <div key={i} className="item" style={{ padding: '6px 0' }}>
                <span className="muted" style={{ width: 90 }}>{new Date(e.at).toLocaleTimeString()}</span>
                {e.event}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="split side-r">
        <div className="stack lg">
          {qs.map((q, i) => {
            const r = responses[q.id];
            const key = (d.keys || []).find((k) => k.question_id === q.id);
            const notes = comments.filter((c) => c.question_id === q.id && c.learner_id === d.attempt.learner_id);
            return (
              <MarkQuestion
                key={q.id}
                n={i + 1}
                q={q}
                r={r}
                keyRow={key}
                notes={notes}
                learnerId={d.attempt.learner_id}
                onEdit={(patch) => r && edit(r, patch)}
                onAnnotate={(x) => setAnnotating(typeof x === 'string' ? { path: x, r, q } : { strokes: x.strokes, r, q })}
              />
            );
          })}
        </div>
        <div className="stack lg" style={{ position: 'sticky', top: 0 }}>
          <div className="card">
            <div className="row between">
              <h3>Total</h3>
              <span className="muted small">{unmarked ? `${unmarked} still to mark` : 'All marked'}</span>
            </div>
            <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
              <span className="score-big">{total}</span>
              <span className="muted">/ {max}</span>
              <span className="grow" />
              <span className="strong">{max ? pct(total, max) + '%' : ''}</span>
            </div>
            <Field label="Overall feedback">
              <textarea className="textarea" value={feedback || ''} onChange={(e) => setFeedback(e.target.value)} placeholder="What went well, and what to focus on next." />
            </Field>
            {redoCount > 0 ? (
              <button className="btn primary big" onClick={() => finish(true)}>
                <Icon name="refresh" size={18} /> Send back to redo {redoCount} question{redoCount > 1 ? 's' : ''}
              </button>
            ) : (
              <>
                <button className="btn primary big" onClick={() => finish(true)}>
                  <Icon name="send" size={18} /> Return marks
                </button>
                <button className="btn" onClick={() => finish(false)}>
                  Save, return later
                </button>
              </>
            )}
            {others.length > 0 && <div className="muted small">{others.length} more submission{others.length > 1 ? 's' : ''} of this to mark.</div>}
          </div>
          <ProfMarkCard
            attemptId={id}
            onApplied={async () => {
              setLocal({});
              const fresh = await api.attemptDetail(id).catch(() => null);
              if (fresh) setFeedback(fresh.attempt.feedback_md || '');
            }}
          />
          <details className="small">
            <summary className="linkbtn small">Or mark with Claude Desktop</summary>
            <div className="stack sm" style={{ marginTop: 8 }}>
              <div className="code-box" style={{ fontFamily: 'var(--sans)', fontSize: 13, userSelect: 'text', wordBreak: 'normal' }}>{claudePrompt}</div>
              <button className="btn sm" onClick={() => (copyText(claudePrompt), toast('Copied. Paste it into Claude.'))}>
                <Icon name="copy" size={14} /> Copy
              </button>
            </div>
          </details>
        </div>
      </div>
      {annotating && (
        <Annotate
          path={annotating.path}
          strokes={annotating.strokes}
          onClose={() => setAnnotating(null)}
          onSave={async (blob) => {
            try {
              const p = await api.uploadAnnotation(d.attempt.learner_id, id, annotating.q.id, blob);
              edit(annotating.r, { annotation_path: p });
              setAnnotating(null);
              toast('Marked copy saved');
            } catch (e) {
              toast({ title: 'Couldn’t save the marked copy', body: e.message, tone: 'bad' });
            }
          }}
        />
      )}
    </Page>
  );
}

function MarkQuestion({ n, q, r, keyRow, notes, learnerId, onEdit, onAnnotate }) {
  const [hints, setHints] = useState(null);
  const lines = useMemo(() => (r?.answer?.steps || []).filter((s) => s && s.trim()), [r?.answer?.steps]);
  useEffect(() => {
    if (q.type !== 'steps' || !lines.length) return;
    let alive = true;
    checkSteps(lines, keyRow?.answer?.final)
      .then((h) => alive && setHints(h))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [q.type, lines, keyRow?.answer?.final]);

  if (!r) return null;
  const max = Number(q.marks || 0);
  const stepMarks = r.step_marks || [];
  const mark = r.marks == null ? '' : Number(r.marks);

  return (
    <div className="qcard">
      <div className="qhead">
        <span className="qnum">{n}</span>
        <span className="muted small">{typeLabel[q.type]}</span>
        <span className="grow" />
        {r.auto_marks != null && <span className="pill">Auto-marked {Number(r.auto_marks)}/{max}</span>}
        {r.redo && <span className="pill warn">Redo</span>}
      </div>
      <QuestionPrompt q={q} />
      <div className="label">Their answer</div>
      <AnswerDisplay
        q={q}
        answer={r.answer}
        keyAns={keyRow?.answer}
        stepMarks={stepMarks}
        hints={hints}
        annotation={r.annotation_path}
        onAnnotate={onAnnotate}
        onToggleStep={(i, ok) => {
          const next = [...stepMarks];
          while (next.length <= i) next.push(null);
          next[i] = ok == null ? null : { ok };
          onEdit({ step_marks: next });
        }}
      />
      {keyRow?.mark_scheme_md && (
        <details className="small">
          <summary className="linkbtn">Your mark scheme</summary>
          <div className="note" style={{ marginTop: 6 }}>{keyRow.mark_scheme_md}</div>
        </details>
      )}
      {notes.length > 0 && (
        <div className="stack sm">
          {notes.map((c) => (
            <div key={c.id} className="feedback" style={{ background: 'var(--amber-tint)', borderColor: '#D08A12' }}>
              <div className="tiny strong">{c.author_id === learnerId ? 'Their note' : 'Your reply'} · {ago(c.created_at)}</div>
              {c.body}
            </div>
          ))}
        </div>
      )}
      <hr />
      <div className="row wrap" style={{ gap: 12 }}>
        <div className="markbox">
          <span className="label">Mark</span>
          <input
            className="input sm num"
            type="number"
            min="0"
            max={max}
            step="0.5"
            value={mark}
            aria-label={`Mark for question ${n}`}
            onChange={(e) => onEdit({ marks: e.target.value === '' ? null : Math.min(max, Math.max(0, Number(e.target.value))) })}
          />
          <span className="muted">/ {max}</span>
        </div>
        <button className="btn sm" onClick={() => onEdit({ marks: 0 })}>0</button>
        {max > 1 && <button className="btn sm" onClick={() => onEdit({ marks: Math.round(max) / 2 })}>½</button>}
        <button className="btn sm" onClick={() => onEdit({ marks: max })}>
          <Icon name="check" size={14} /> Full
        </button>
      </div>
      <Field label="Feedback on this question">
        <textarea className="textarea" style={{ minHeight: 64 }} value={r.feedback_md || ''} onChange={(e) => onEdit({ feedback_md: e.target.value })} placeholder="What was wrong, and how to fix it. Maths in $…$." />
      </Field>
      <div className="grid g2" style={{ gap: 10, alignItems: 'end' }}>
        <Field label="Mistake (collects on their progress page)">
          <input className="input" value={r.mistake || ''} onChange={(e) => onEdit({ mistake: e.target.value || null })} placeholder="e.g. Sign error when expanding brackets" />
        </Field>
        <Toggle checked={r.redo} onChange={(v) => onEdit({ redo: v })} icon="refresh" title="Ask them to redo this" />
      </div>
    </div>
  );
}

function Annotate({ path, strokes, onClose, onSave }) {
  const stored = useBlob('work', path);
  const [drawn, setDrawn] = useState(null);
  useEffect(() => {
    if (!strokes) return;
    const c = document.createElement('canvas');
    c.width = 1600;
    c.height = Math.round(1600 * 0.62);
    drawStrokes(c.getContext('2d'), strokes, c.width, c.height, { grid: true });
    setDrawn(c.toDataURL('image/png'));
  }, [strokes]);
  const url = strokes ? drawn : stored.url;
  const pad = useRef(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Mark on their work"
      wide
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              onSave(await pad.current.toBlob());
            }}
          >
            {busy ? 'Saving…' : 'Save marked copy'}
          </button>
        </>
      }
    >
      <div className="muted small">Draw ticks, crosses and corrections. The learner sees this copy when you return their marks.</div>
      {url ? <DrawingPad ref={pad} background={url} defaultColor="#D93025" label="Their work" /> : <Loading />}
    </Modal>
  );
}
