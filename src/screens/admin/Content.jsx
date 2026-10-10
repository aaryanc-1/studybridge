// Admin → Content: StudyBridge's own lessons and questions that need the Owner. Questions whose second check
// disagreed or that failed the plain checks wait here; students' reports come here too (the item stays up for
// students until the Owner sorts it, so nobody thinks it was fixed when it wasn't).
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Markdown, Page, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago } from '../../lib/format.js';

const LETTERS = 'ABCDEFGHIJ';
const optionList = (o) => (Array.isArray(o) ? o : Array.isArray(o?.items) ? o.items : []);

// The answer key in words: "C (7)", "12 ± 0.5 cm", "x = 4"
export function answerText(type, answer = {}, options) {
  const opts = optionList(options);
  if (type === 'mcq') {
    const picks = answer.choices || (answer.choice != null ? [answer.choice] : []);
    return picks.length ? picks.map((i) => `${LETTERS[Number(i)] || '?'} (${opts[Number(i)] ?? 'no such option'})`).join(', ') : 'none chosen';
  }
  if (type === 'numeric') return `${answer.value ?? '?'}${Number(answer.tolerance) ? ` ± ${answer.tolerance}` : ''}${answer.unit ? ` ${answer.unit}` : ''}`;
  if (type === 'steps') return answer.final || answer.text || '—';
  return answer.text || answer.final || answer.value || '—';
}

function Preview({ x }) {
  return (
    <div className="stack sm content-preview">
      {x.prompt && <Markdown src={x.prompt} />}
      {x.type === 'mcq' && (
        <ol className="small" type="A" style={{ margin: 0 }}>
          {optionList(x.options).map((o, i) => (
            <li key={i}>
              <Markdown src={o} />
            </li>
          ))}
        </ol>
      )}
      {x.answer && (
        <div className="small">
          <b>Answer:</b> {answerText(x.type, x.answer, x.options)}
        </div>
      )}
      {x.hint && (
        <div className="small">
          <b>Hint:</b> <Markdown src={x.hint} />
        </div>
      )}
      {x.solution && (
        <details className="small">
          <summary className="linkbtn small">Worked solution</summary>
          <Markdown src={x.solution} />
        </details>
      )}
      {x.mark_scheme && (
        <details className="small">
          <summary className="linkbtn small">Mark scheme</summary>
          <Markdown src={x.mark_scheme} />
        </details>
      )}
      {x.title && <div className="strong">{x.title}</div>}
      {x.body && (
        <details className="small">
          <summary className="linkbtn small">Read the lesson</summary>
          <Markdown src={x.body} />
        </details>
      )}
      {x.front && (
        <div className="small">
          <b>Front:</b> <Markdown src={x.front} />
          <b>Back:</b> <Markdown src={x.back || '—'} />
        </div>
      )}
    </div>
  );
}

// Fix it here: the question, its answer, hint, solution and mark scheme (or a lesson's text, or a card)
function FixForm({ kind, x, onDone }) {
  const toast = useToast();
  const [prompt, setPrompt] = useState(x.prompt || '');
  const [opts, setOpts] = useState(optionList(x.options));
  const [ans, setAns] = useState(x.answer || {});
  const [hint, setHint] = useState(x.hint || '');
  const [solution, setSolution] = useState(x.solution || '');
  const [scheme, setScheme] = useState(x.mark_scheme || '');
  const [title, setTitle] = useState(x.title || '');
  const [body, setBody] = useState(x.body || '');
  const [front, setFront] = useState(x.front || '');
  const [back, setBack] = useState(x.back || '');
  const [busy, setBusy] = useState(false);
  const multi = !!ans.choices;
  const picked = (i) => (multi ? (ans.choices || []).map(Number).includes(i) : Number(ans.choice) === i && ans.choice != null);
  const pick = (i) =>
    setAns(multi ? { choices: picked(i) ? ans.choices.filter((c) => Number(c) !== i) : [...(ans.choices || []), String(i)] } : { choice: String(i) });
  async function save() {
    setBusy(true);
    try {
      const fix =
        kind === 'lesson'
          ? { title, body }
          : kind === 'card'
            ? { front, back }
            : {
                prompt,
                answer: ans,
                solution,
                mark_scheme: scheme || null,
                ...(x.type === 'mcq' ? { options: Array.isArray(x.options) ? opts : { ...x.options, items: opts } } : {}),
                ...(kind === 'question' ? { hint } : {}),
              };
      await api.adminContentDecide(kind, x.id, 'fix', fix);
      invalidate('admin-content');
      toast('Fixed. It’s up for students now.');
      onDone();
    } catch (e) {
      toast({ title: 'Couldn’t save that', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  const area = (label, v, set, rows = 3) => (
    <label className="stack sm small">
      {label}
      <textarea className="textarea" rows={rows} value={v} onChange={(e) => set(e.target.value)} aria-label={label} />
    </label>
  );
  return (
    <div className="stack sm fix-form">
      {kind === 'lesson' ? (
        <>
          <label className="stack sm small">
            Title
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          </label>
          {area('Lesson', body, setBody, 12)}
        </>
      ) : kind === 'card' ? (
        <>
          {area('Front', front, setFront, 2)}
          {area('Back', back, setBack, 3)}
        </>
      ) : (
        <>
          {area('Question', prompt, setPrompt)}
          {x.type === 'mcq' && (
            <div className="stack sm small">
              Options (tick the correct {multi ? 'ones' : 'one'})
              {opts.map((o, i) => (
                <span key={i} className="row" style={{ gap: 8 }}>
                  <input type={multi ? 'checkbox' : 'radio'} name={`ok-${x.id}`} checked={picked(i)} onChange={() => pick(i)} aria-label={`Option ${LETTERS[i]} is correct`} />
                  <input className="input sm" value={o} onChange={(e) => setOpts(opts.map((y, j) => (j === i ? e.target.value : y)))} aria-label={`Option ${LETTERS[i]}`} />
                </span>
              ))}
            </div>
          )}
          {x.type === 'numeric' && (
            <span className="row wrap" style={{ gap: 8 }}>
              <label className="stack sm small">
                Answer
                <input className="input sm" value={ans.value ?? ''} onChange={(e) => setAns({ ...ans, value: e.target.value })} aria-label="Answer" />
              </label>
              <label className="stack sm small">
                Allowed margin
                <input className="input sm" value={ans.tolerance ?? '0'} onChange={(e) => setAns({ ...ans, tolerance: e.target.value })} aria-label="Allowed margin" />
              </label>
            </span>
          )}
          {x.type === 'steps' && (
            <label className="stack sm small">
              Final line
              <input className="input" value={ans.final ?? ''} onChange={(e) => setAns({ final: e.target.value })} aria-label="Final line" />
            </label>
          )}
          {['short', 'upload', 'drawing'].includes(x.type) && (
            <label className="stack sm small">
              Model answer
              <input className="input" value={ans.text ?? ''} onChange={(e) => setAns({ text: e.target.value })} aria-label="Model answer" />
            </label>
          )}
          {kind === 'question' && area('Hint', hint, setHint, 2)}
          {area('Worked solution', solution, setSolution, 4)}
          {area('Mark scheme', scheme, setScheme, 2)}
        </>
      )}
      <span className="row wrap" style={{ gap: 8 }}>
        <button className="btn sm primary" disabled={busy} onClick={save}>
          Save and put it up
        </button>
        <button className="btn sm ghost" onClick={onDone}>
          Cancel
        </button>
      </span>
    </div>
  );
}

function why(x) {
  const c = x.check || {};
  if (c.state === 'failed') return c.reason || 'The second check disagreed.';
  if (c.state === 'compare') return 'The second check’s written answer is still being compared. Finish it in Claude Desktop, or decide here.';
  if (c.problems?.length) return c.problems.join(' ');
  return 'Needs a look.';
}

function CheckRow({ x }) {
  const toast = useToast();
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState(false);
  const kind = x.kind;
  async function act(action, ok) {
    setBusy(true);
    try {
      await api.adminContentDecide(kind, x.id, action);
      invalidate('admin-content');
      toast(ok);
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  const c = x.check || {};
  return (
    <div className="item content-row">
      <span className="grow stack sm">
        <span className="meta">
          {[x.subject, x.topic, x.paper ? `${x.paper}, question ${x.number}` : null, kind === 'lesson' ? 'Lesson' : null].filter(Boolean).join(' · ')}
        </span>
        <span className="pill warn" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}>
          {why(x)}
        </span>
        {c.second && (
          <span className="small">
            <b>Second check’s answer:</b> {answerText(x.type, c.second, x.options)}
            {c.second_working ? ` (${c.second_working})` : ''}
            {c.note ? ` · ${c.note}` : ''}
          </span>
        )}
        {fixing ? <FixForm kind={kind} x={x} onDone={() => setFixing(false)} /> : <Preview x={x} />}
      </span>
      {!fixing && (
        <span className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
          <button className="btn sm" disabled={busy} onClick={() => setFixing(true)}>
            Fix
          </button>
          <button className="btn sm ghost" disabled={busy} onClick={() => act('approve', kind === 'lesson' ? 'It’s up for students' : 'Approved. It’s up for students.')}>
            {kind === 'lesson' ? 'Put it up anyway' : 'It’s right, approve'}
          </button>
          <button className="btn sm ghost" disabled={busy} onClick={() => act('remove', 'Removed')}>
            Remove
          </button>
        </span>
      )}
    </div>
  );
}

const KIND = { question: 'Practice question', paper: 'Question in a practice paper', lesson: 'Lesson', card: 'Flashcard' };

function ReportRow({ r }) {
  const toast = useToast();
  const [reply, setReply] = useState('');
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState(false);
  const item = { ...(r.item || {}), id: r.item_id };
  async function done() {
    setBusy(true);
    try {
      await api.adminReportDone(r.id, reply.trim() || null);
      invalidate('admin-content');
      toast(reply.trim() ? 'Sorted, and your reply was sent' : 'Sorted');
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="item content-row">
      <span className="grow stack sm">
        <span className="meta">
          {r.student} · {ago(r.created_at)} · {KIND[r.kind]}
          {item.subject ? ` · ${item.subject}` : ''}
          {item.paper ? ` · ${item.paper}, question ${item.number}` : ''}
        </span>
        <span className="note small">“{r.message}”</span>
        {!r.item ? <span className="small muted">That item has since been removed.</span> : fixing ? <FixForm kind={r.kind} x={item} onDone={() => setFixing(false)} /> : <Preview x={item} />}
        {!fixing && (
          <span className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
            <input className="input" style={{ flex: '1 1 260px' }} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to them (optional)" aria-label="Reply to the student" />
            {r.item && (
              <button className="btn sm" disabled={busy} onClick={() => setFixing(true)}>
                Fix it
              </button>
            )}
            <button className="btn sm primary" disabled={busy} onClick={done}>
              Mark as sorted
            </button>
          </span>
        )}
      </span>
    </div>
  );
}

export default function ContentPage() {
  const q = useQuery('admin-content', api.adminContentReview, { poll: 60000 });
  const d = q.data;
  if (!d) return <Page title="Content">{q.error ? <div className="error">{q.error.message}</div> : null}</Page>;
  const checks = [...(d.questions || []), ...(d.lessons || [])];
  return (
    <Page title="Content" subtitle="StudyBridge’s own lessons and questions that need you: what students reported, and anything that didn’t pass its checks.">
      <div className="note small row" style={{ gap: 8 }}>
        <Icon name="info" size={16} />
        {d.waiting
          ? `${d.waiting} question${d.waiting === 1 ? ' is' : 's are'} waiting for the second check. In Claude Desktop, start a new chat and use “Check waiting questions”.`
          : 'Nothing is waiting for its second check.'}
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Reported by students ({d.reports.length})</h2>
        </div>
        <div className="small muted">Reported items stay up for students until you sort them.</div>
        {d.reports.length ? (
          <div className="list">
            {d.reports.map((r) => (
              <ReportRow key={r.id} r={r} />
            ))}
          </div>
        ) : (
          <Empty>No reports waiting.</Empty>
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Didn’t pass its checks ({checks.length})</h2>
        </div>
        {checks.length ? (
          <div className="list">
            {checks.map((x) => (
              <CheckRow key={x.kind + x.id} x={x} />
            ))}
          </div>
        ) : (
          <Empty>Everything so far passed its checks.</Empty>
        )}
      </div>
      {d.done.length > 0 && (
        <details className="card">
          <summary className="strong">Sorted recently ({d.done.length})</summary>
          <div className="list small">
            {d.done.map((r) => (
              <div key={r.id} className="item">
                <span className="grow">
                  <span className="name">“{r.message}”</span>
                  <span className="meta">
                    {r.student} · sorted {ago(r.done_at)}
                    {r.reply ? ` · you replied: ${r.reply}` : ''}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </Page>
  );
}
