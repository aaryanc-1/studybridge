// Peer review (step 6, 7 Nov 2026): classmates review each other's hand-ins on work set for a class. The teacher reads
// every review before its author sees it; reviews never change marks; anonymous by default. Learners: ReviewPage
// (/review/:id), MyReviews (on My work), PeerReceived (on Results). Teachers: PeerPage (/peer/:assignment).
import { useEffect, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Link, Loading, Markdown, Modal, Page, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, due, typeLabel } from '../../lib/format.js';
import { QuestionPrompt, AnswerDisplay } from './Answer.jsx';
import { RubricGrid } from './Rubric.jsx';

const STATUS = { todo: 'To write', returned: 'Look again', done: 'With your teacher', shared: 'Passed on', removed: 'Taken away' };

// ---------------- learners ----------------
// "Review a classmate's work": the ones to write (on My work → To do, and Today)
export function MyReviews({ compact = false }) {
  const list = (useQuery('my-peer-reviews', api.myPeerReviews).data || []).filter((r) => r.status === 'todo' || r.status === 'returned');
  if (!list.length) return null;
  return (
    <div className={compact ? 'stack sm' : 'card stack sm'}>
      {!compact && <h3>Reviews to write</h3>}
      {list.map((r) => (
        <button key={r.id} type="button" className="work-card" onClick={() => go(`/review/${r.id}`)}>
          <span className="bar-l" style={{ background: 'var(--accent)' }} />
          <span className="grow stack sm">
            <span className="row wrap" style={{ gap: 8 }}>
              <span className="pill warn">{r.status === 'returned' ? 'Look again' : 'Peer review'}</span>
            </span>
            <span className="strong" style={{ fontSize: 16 }}>Review a classmate’s work: {r.title}</span>
            <span className="small muted">
              {r.due_at ? due(r.due_at).text : 'No due date'}
              {r.status === 'returned' ? ' · your teacher asked you to look again' : ''}
            </span>
          </span>
          <Icon name="right" />
        </button>
      ))}
    </div>
  );
}

export function ReviewPage({ id }) {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery(`peer-review:${id}`, () => api.peerReviewOpen(id));
  const [comments, setComments] = useState(null);
  const [answers, setAnswers] = useState(null);
  const [rubric, setRubric] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState(false);
  const r = q.data;
  useEffect(() => {
    if (r && comments === null) {
      setComments(r.comments || {});
      setAnswers((r.prompts || []).map((_, i) => r.answers?.[i] || ''));
      setRubric(r.rubric || {});
    }
  }, [r, comments]);
  if (q.error) return <Page title="Review"><div className="error">{q.error.message}</div></Page>;
  if (!r || comments === null) return <Loading />;
  const can = r.can_edit;
  async function save(submit) {
    if (submit && !(await confirm({ title: 'Send your review?', body: 'Your teacher reads it first, then passes it on. You can’t change it after this.', ok: 'Send it' }))) return;
    setBusy(true);
    try {
      await api.savePeerReview(id, { comments, answers, rubric }, submit);
      invalidate('my-peer-reviews', `peer-review:${id}`);
      toast(submit ? 'Sent to your teacher. Thank you!' : 'Saved');
      if (submit) go('/work');
    } catch (e) {
      toast({ title: 'Couldn’t save it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page
      size="narrow"
      eyebrow={<Link to="/work">My work</Link>}
      title={`Review: ${r.title}`}
      subtitle={`${r.anonymous ? 'A classmate’s work (no names)' : `${r.author}’s work`}${r.due_at ? ` · ${due(r.due_at).text}` : ''}`}
    >
      <div className="card tint small">
        Be kind and specific: say what works, and one thing that would make it better. Your teacher reads every review before it’s passed on.
      </div>
      {r.status === 'returned' && r.teacher_note && (
        <div className="card warn small">
          <b>Your teacher says:</b> {r.teacher_note}
        </div>
      )}
      {(r.questions || []).map((x) => (
        <div key={x.id} className="qcard">
          <div className="qhead">
            <span className="qnum">{x.n}</span>
            <span className="muted small">{typeLabel[x.type]}</span>
          </div>
          <QuestionPrompt q={x} />
          <div className="label">Their answer</div>
          <AnswerDisplay q={x} answer={x.answer || {}} />
          {x.rubric && (
            <div className="stack sm">
              <div className="label">Where would you put it? ({x.rubric.title})</div>
              <RubricGrid
                rubric={x.rubric}
                picked={rubric[x.id] || {}}
                onPick={
                  can
                    ? (i, j) => {
                        const next = { ...(rubric[x.id] || {}) };
                        if (j == null) delete next[i];
                        else next[i] = j;
                        setRubric({ ...rubric, [x.id]: next });
                      }
                    : undefined
                }
              />
            </div>
          )}
          <Field label="Your comment on this">
            <textarea className="textarea" value={comments[x.id] || ''} disabled={!can} onChange={(e) => setComments({ ...comments, [x.id]: e.target.value })} aria-label={`Your comment on question ${x.n}`} maxLength={2000} />
          </Field>
        </div>
      ))}
      {(r.prompts || []).length > 0 && (
        <div className="card stack">
          {(r.prompts || []).map((p, i) => (
            <Field key={i} label={p}>
              <textarea className="textarea" value={answers[i] || ''} disabled={!can} onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? e.target.value : x)))} maxLength={2000} />
            </Field>
          ))}
        </div>
      )}
      <div className="row wrap">
        {can ? (
          <>
            <button className="btn primary" disabled={busy} onClick={() => save(true)}>
              <Icon name="send" size={16} /> Send my review
            </button>
            <button className="btn" disabled={busy} onClick={() => save(false)}>
              Save for later
            </button>
          </>
        ) : (
          <span className="pill">{STATUS[r.status]}</span>
        )}
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => setReporting(true)}>
          <Icon name="flag" size={14} /> Something’s wrong with this work
        </button>
      </div>
      {reporting && <ReportPeer id={id} what="work" onClose={() => setReporting(false)} />}
    </Page>
  );
}

function ReportPeer({ id, what, onClose }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  async function send(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.peerReport(id, text);
      invalidate('peer-received');
      toast(what === 'review' ? 'Thanks for telling us. It’s hidden, and your teacher has been told.' : 'Thanks. Your teacher has been told.');
      onClose();
    } catch (x) {
      toast({ title: 'Couldn’t send it', body: x.message, tone: 'bad' });
      setBusy(false);
    }
  }
  return (
    <Modal title={what === 'review' ? 'Report this review' : 'Tell your teacher about this work'} onClose={onClose}>
      <form className="stack" onSubmit={send}>
        <Field label="What’s wrong?">
          <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder={what === 'review' ? 'e.g. It’s unkind' : 'e.g. There’s something upsetting in it'} />
        </Field>
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || text.trim().length < 3}>
            Send
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Results: what classmates said (only reviews the teacher passed on)
export function PeerReceived({ attemptId, questions }) {
  const data = useQuery(`peer-received:${attemptId}`, () => api.peerReceived(attemptId)).data;
  const [reporting, setReporting] = useState(null);
  if (!data?.reviews?.length) return null;
  const n = (qid) => questions.findIndex((x) => x.id === qid) + 1;
  return (
    <div className="card stack">
      <h3 className="row">
        <Icon name="users" /> From your classmates
      </h3>
      {data.reviews.map((r, i) => (
        <div key={r.id} className="peer-review stack sm">
          <div className="tiny strong">{r.by || `Classmate ${i + 1}`}</div>
          {(data.prompts || []).map((p, j) =>
            r.answers?.[j] ? (
              <div key={j} className="small">
                <span className="muted">{p} </span>
                {r.answers[j]}
              </div>
            ) : null,
          )}
          {Object.entries(r.comments || {}).map(([qid, text]) => (
            <div key={qid} className="small">
              <span className="muted">Question {n(qid)}: </span>
              {text}
            </div>
          ))}
          {Object.entries(r.rubric || {}).map(([qid, picked]) => {
            const ru = (data.rubrics || []).find((x) => x.question_id === qid);
            return ru ? <RubricGrid key={qid} rubric={ru} picked={picked} /> : null;
          })}
          <div>
            <button className="linkbtn tiny" onClick={() => setReporting(r.id)}>
              Report this review
            </button>
          </div>
        </div>
      ))}
      {reporting && <ReportPeer id={reporting} what="review" onClose={() => setReporting(null)} />}
    </div>
  );
}

// ---------------- teachers ----------------
export function PeerPage({ id }) {
  const toast = useToast();
  const q = useQuery(`peer:${id}`, () => api.peerOverview(id));
  const [returning, setReturning] = useState(null);
  const [busy, setBusy] = useState(false);
  const d = q.data;
  if (q.error) return <Page title="Peer review"><div className="error">{q.error.message}</div></Page>;
  if (!d) return <Loading />;
  const a = d.assignment;
  const toCheck = d.reviews.filter((r) => r.status === 'done' || (r.status === 'shared' && r.reported_at));
  const reported = d.reviews.filter((r) => r.reported_at && r.status !== 'removed');
  const qn = (qid) => d.questions.find((x) => x.id === qid)?.n;
  async function act(r, action, note) {
    setBusy(true);
    try {
      await api.peerCheck(r.id, action, note);
      invalidate(`peer:${id}`);
      toast(action === 'share' ? 'Passed on' : action === 'return' ? 'Sent back with your note' : 'Taken away');
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function giveOut() {
    setBusy(true);
    try {
      const n = await api.peerGiveOut(id);
      invalidate(`peer:${id}`);
      toast(n ? `Gave out ${n} review${n === 1 ? '' : 's'}.` : 'Everyone who’s handed in has their reviews.');
    } catch (e) {
      toast({ title: 'Couldn’t give them out', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page
      eyebrow={<Link to={`/marking?a=${id}`}>Marking</Link>}
      title={`Peer review: ${a.title}`}
      subtitle={`${d.handed_in} handed in · ${a.peer?.count || 2} review${a.peer?.count === 1 ? '' : 's'} each · ${a.peer?.anonymous === false ? 'names shown' : 'no names'}`}
      actions={
        <button className="btn primary" onClick={giveOut} disabled={busy}>
          <Icon name="users" size={16} /> {a.started_at ? 'Give out reviews for new hand-ins' : 'Give out reviews now'}
        </button>
      }
    >
      {!a.started_at && (
        <div className="card tint small">
          {a.peer?.start === 'hand' ? 'Reviews go out when you press Give out reviews.' : `Reviews go out by themselves at the due date${a.due_at ? ` (${due(a.due_at).text})` : ''}, or press Give out reviews now.`} Everyone who has handed in reviews {a.peer?.count || 2} classmates; anyone who hands in later is added.
        </div>
      )}
      <div className="card">
        <h3>To check ({toCheck.length})</h3>
        {toCheck.length === 0 ? (
          <Empty>Nothing waiting. Finished reviews come here before their authors see them.</Empty>
        ) : (
          toCheck.map((r) => (
            <div key={r.id} className="peer-review stack sm">
              <div className="row wrap small">
                <b>{r.reviewer.name}</b> <Icon name="right" size={12} /> <b>{r.author.name}</b>
                <span className="muted">{r.submitted_at ? `sent ${ago(r.submitted_at)}` : ''}</span>
                {r.reported_at && <span className="pill bad">Reported by the {r.reported_by === 'reviewer' ? 'reviewer' : 'author'}: {r.report_reason}</span>}
              </div>
              {(a.peer?.prompts || []).map((p, j) =>
                r.answers?.[j] ? (
                  <div key={j} className="small">
                    <span className="muted">{p} </span>
                    {r.answers[j]}
                  </div>
                ) : null,
              )}
              {Object.entries(r.comments || {}).map(([qid, text]) => (
                <div key={qid} className="small">
                  <span className="muted">Question {qn(qid)}: </span>
                  {text}
                </div>
              ))}
              <div className="row wrap">
                <button className="btn sm primary" disabled={busy} onClick={() => act(r, 'share')}>
                  <Icon name="check" size={14} /> {r.status === 'shared' ? 'Show it to them again' : 'Pass it on'}
                </button>
                {r.status === 'done' && (
                  <button className="btn sm" disabled={busy} onClick={() => setReturning(r)}>
                    Send it back
                  </button>
                )}
                <button className="btn sm ghost" disabled={busy} onClick={() => act(r, 'remove')}>
                  <Icon name="trash" size={14} /> Take it away
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {reported.filter((r) => !toCheck.includes(r)).length > 0 && (
        <div className="card warn">
          <h3>Reported</h3>
          {reported
            .filter((r) => !toCheck.includes(r))
            .map((r) => (
              <div key={r.id} className="small row wrap">
                {r.reviewer.name} reviewing {r.author.name}: {r.report_reason}
                <button className="btn sm ghost" disabled={busy} onClick={() => act(r, 'remove')}>
                  Take it away
                </button>
              </div>
            ))}
        </div>
      )}
      <div className="card pad0">
        <table className="table responsive">
          <thead>
            <tr>
              <th>Reviewer</th>
              <th>Reviewing</th>
              <th>Status</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            {d.reviews.map((r) => (
              <tr key={r.id}>
                <td data-label="Reviewer">{r.reviewer.name}</td>
                <td data-label="Reviewing">{r.author.name}</td>
                <td data-label="Status">
                  <span className={'pill ' + (r.status === 'shared' ? 'good' : r.status === 'done' ? 'warn' : '')}>{STATUS[r.status]}</span>
                </td>
                <td data-label="Due">{r.due_at ? due(r.due_at).text : '—'}</td>
              </tr>
            ))}
            {d.reviews.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No reviews given out yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {returning && (
        <SendBack
          onClose={() => setReturning(null)}
          onSend={async (note) => {
            await act(returning, 'return', note);
            setReturning(null);
          }}
        />
      )}
    </Page>
  );
}

function SendBack({ onClose, onSend }) {
  const [note, setNote] = useState('');
  return (
    <Modal title="Send it back to the reviewer" onClose={onClose}>
      <Field label="What should they look at again?">
        <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="e.g. Say one thing that works well, and be specific." />
      </Field>
      <div className="foot row end">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!note.trim()} onClick={() => onSend(note.trim())}>
          Send it back
        </button>
      </div>
    </Modal>
  );
}
