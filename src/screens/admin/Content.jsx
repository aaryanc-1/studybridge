// Admin → Content: StudyBridge's own lessons and questions that need the Owner. Questions whose second check
// disagreed or that failed the plain checks wait here; students' reports come here too (the item stays up for
// students until the Owner sorts it, so nobody thinks it was fixed when it wasn't). "Browse everything" lists all
// of StudyBridge's own content, by subject, to search, hide, approve or remove.
import { useRef, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Loading, Markdown, Page, Seg, go, useConfirm, useDebounced, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago } from '../../lib/format.js';
import { plainMaths } from '../../lib/plain.js';

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
  const route = useRoute();
  const tab = route.parts[1] === 'browse' ? 'browse' : 'review';
  return (
    <Page
      title="Content"
      subtitle={
        tab === 'browse'
          ? 'Everything StudyBridge has made for students: practice questions, lessons, flashcards and practice papers.'
          : 'StudyBridge’s own lessons and questions that need you: what students reported, and anything that didn’t pass its checks.'
      }
    >
      <Seg
        label="Content"
        value={tab}
        onChange={(t) => go(t === 'browse' ? '/content/browse' : '/content', { replace: true })}
        options={[
          { value: 'review', label: 'Needs you', icon: 'alert' },
          { value: 'browse', label: 'Browse everything', icon: 'layers' },
        ]}
      />
      {tab === 'browse' ? <Browse /> : <Review />}
    </Page>
  );
}

// What needs the Owner: students' reports and anything that didn't pass its checks
function Review() {
  const q = useQuery('admin-content', api.adminContentReview, { poll: 60000 });
  const d = q.data;
  if (!d) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  const checks = [...(d.questions || []), ...(d.lessons || [])];
  return (
    <>
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
    </>
  );
}

// ---------------- Browse everything ----------------
const STATUS = {
  live: { label: 'Live', tone: 'good' },
  waiting: { label: 'Waiting for checks', tone: 'accent' },
  problems: { label: 'Has problems', tone: 'warn' },
  hidden: { label: 'Hidden', tone: '' },
};
const KIND_ONE = { question: 'Practice question', lesson: 'Lesson', card: 'Flashcard', practice_paper: 'Practice paper' };
const KINDS = { question: 'Practice questions', lesson: 'Lessons', card: 'Flashcards', practice_paper: 'Practice papers' };
const firstLine = (s) => plainMaths(String(s || '').replace(/[#>*_`]/g, '').trim()).split('\n')[0] || '—';

function Browse() {
  const [subject, setSubject] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(100);
  const typed = useDebounced((v) => (setSearch(v.trim()), setLimit(100)), 400);
  const pick = (set) => (v) => (set(v), setLimit(100));
  const q = useQuery(`admin-content:browse:${subject}:${kind}:${status}:${search}:${limit}`, () => api.adminContentBrowse({ subject, kind, status, search, limit }));
  // keep showing the last list while a new one loads
  const last = useRef(null);
  if (q.data) last.current = q.data;
  const d = q.data || last.current;
  if (!d) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  const c = d.counts || {};
  const all = (c.live || 0) + (c.waiting || 0) + (c.problems || 0) + (c.hidden || 0);
  const subjects = d.subjects.filter((s) => s.items > 0 || s.id === subject);
  // grouped by subject, in the syllabus order of the subjects
  const groups = subject
    ? [[subject, d.subjects.find((s) => s.id === subject)?.name || 'Subject', d.items]]
    : [...d.subjects.map((s) => [s.id, s.name, d.items.filter((x) => x.subject_id === s.id)]), ['none', 'No subject', d.items.filter((x) => !x.subject_id)]].filter(([, , rows]) => rows.length);
  return (
    <>
      <div className="row wrap" style={{ gap: 8 }}>
        <select className="select" style={{ width: 'auto', minHeight: 36 }} value={subject} onChange={(e) => pick(setSubject)(e.target.value)} aria-label="Subject">
          <option value="">All subjects</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.items})
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 'auto', minHeight: 36 }} value={kind} onChange={(e) => pick(setKind)(e.target.value)} aria-label="Kind">
          <option value="">Everything</option>
          {Object.entries(KINDS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <span className="row grow" style={{ gap: 6, minWidth: 200 }}>
          <Icon name="search" size={16} style={{ color: 'var(--muted)' }} />
          <input className="input" style={{ minHeight: 36 }} value={text} onChange={(e) => (setText(e.target.value), typed(e.target.value))} placeholder="Search the words" aria-label="Search" />
        </span>
        {q.loading && <div className="spinner" aria-label="Loading" />}
      </div>
      <Seg
        label="Status"
        value={status}
        onChange={pick(setStatus)}
        options={[
          { value: '', label: `All (${all})` },
          ...Object.entries(STATUS).map(([k, s]) => ({ value: k, label: `${s.label} (${c[k] || 0})` })),
        ]}
      />
      <div className="small muted">Hidden things stay here, so you can put them back up. Removing is for good.</div>
      {d.items.length === 0 ? (
        <Empty>{search || kind || status || subject ? 'Nothing matches. Try other filters.' : 'StudyBridge hasn’t made anything yet.'}</Empty>
      ) : (
        groups.map(([id, name, rows]) => (
          <section key={id} className="stack sm">
            <h2 className="list-head">
              {name} <span className="muted">({rows.length})</span>
            </h2>
            <div className="card">
              <div className="list">
                {rows.map((x) => (
                  <BrowseRow key={x.kind + x.id} x={x} />
                ))}
              </div>
            </div>
          </section>
        ))
      )}
      {d.total > d.items.length && (
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="small muted">
            Showing {d.items.length} of {d.total}.
          </span>
          {limit < 300 ? (
            <button className="btn sm" onClick={() => setLimit(limit + 100)}>
              Show more
            </button>
          ) : (
            <span className="small muted">Choose a subject or search to see the rest.</span>
          )}
        </div>
      )}
    </>
  );
}

function BrowseRow({ x }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState(false);
  const st = STATUS[x.status] || STATUS.hidden;
  const paper = x.kind === 'practice_paper';
  async function act(action, ok, ask) {
    if (ask && !(await confirm(ask))) return;
    setBusy(true);
    try {
      await api.adminContentDecide(x.kind, x.id, action);
      invalidate('admin-content');
      toast(ok);
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  const what = x.kind === 'question' ? x.prompt : x.kind === 'card' ? x.front : x.title;
  const removeAsk = {
    title: paper ? `Remove “${x.title}”?` : x.kind === 'lesson' ? `Remove the lesson “${x.title}”?` : 'Remove this flashcard?',
    body: 'It’s deleted for good and students won’t see it again. To take it down for now, hide it instead.',
    ok: 'Remove',
    danger: true,
  };
  if (x.kind === 'card') removeAsk.body = 'It’s deleted for good and students won’t see it again.';
  const up = x.status === 'hidden' ? 'Put it back up' : x.status === 'live' ? null : paper ? 'Approve all and put it up' : 'Approve and put it up';
  // a paper with questions that haven't passed their checks: approving it approves them all, so ask first
  const unchecked = paper && x.questions.some((q) => !['passed', 'approved'].includes(q.check?.state));
  // hiding: a practice question can always be taken out (even while it waits); lessons and papers once they're up
  const canHide = x.kind === 'question' ? x.status !== 'hidden' : x.kind !== 'card' && x.status === 'live';
  const meta = [
    KIND_ONE[x.kind],
    x.topic,
    paper ? `${x.questions.length} question${x.questions.length === 1 ? '' : 's'} · ${x.marks} mark${x.marks === 1 ? '' : 's'}${x.minutes ? ` · ${x.minutes} min` : ''}` : null,
    paper && x.taken ? `taken ${x.taken} time${x.taken === 1 ? '' : 's'}` : null,
    `added ${ago(x.created_at)}`,
  ];
  return (
    <div className="item content-row">
      <span className="grow stack sm">
        <span className="meta">
          <span className={'pill ' + st.tone}>{st.label}</span>
          {meta.filter(Boolean).join(' · ')}
        </span>
        <button className="linkbtn" style={{ color: 'var(--ink)', maxWidth: '100%' }} onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="row" style={{ gap: 6, minWidth: 0 }}>
            <Icon name={open ? 'down' : 'right'} size={14} />
            <span className={open ? '' : 'ellipsis'} style={{ minWidth: 0 }}>
              {firstLine(what)}
            </span>
          </span>
        </button>
        {x.status === 'problems' && !paper && (
          <span className="pill warn" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}>
            {why(x)}
          </span>
        )}
        {fixing ? (
          <FixForm kind={x.kind} x={x} onDone={() => setFixing(false)} />
        ) : open ? (
          paper ? <PaperQuestions x={x} /> : <Preview x={x.kind === 'lesson' ? { ...x, title: null } : x} />
        ) : null}
      </span>
      {!fixing && (
        <span className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
          {up && (
            <button
              className="btn sm"
              disabled={busy}
              onClick={() =>
                act('approve', 'It’s up for students', unchecked ? { title: 'Put the whole paper up?', body: 'Every question in it is approved as it is, without waiting for its checks.', ok: 'Put it up' } : null)
              }
            >
              {up}
            </button>
          )}
          {!paper && (
            <button className="btn sm" disabled={busy} onClick={() => (setOpen(true), setFixing(true))}>
              Fix
            </button>
          )}
          {canHide && (
            <button className="btn sm ghost" disabled={busy} onClick={() => act('hide', 'Hidden from students')}>
              Hide
            </button>
          )}
          {x.kind !== 'question' && !(paper && x.taken) && (
            <button className="btn sm ghost" disabled={busy} onClick={() => act('remove', 'Removed', removeAsk)} aria-label={`Remove ${KIND_ONE[x.kind].toLowerCase()}`}>
              <Icon name="trash" size={15} /> Remove
            </button>
          )}
        </span>
      )}
    </div>
  );
}

// A practice paper's questions, each with how its check went
function PaperQuestions({ x }) {
  if (!x.questions.length) return <div className="small muted">This paper has no questions.</div>;
  return (
    <div className="stack sm">
      {x.questions.map((q) => {
        const s = q.check?.state;
        const ok = s === 'passed' || s === 'approved';
        return (
          <div key={q.id} className="stack sm">
            <span className="meta">
              <b>Question {q.number}</b>
              {q.topic && <span>{q.topic}</span>}
              <span>
                {q.marks} mark{Number(q.marks) === 1 ? '' : 's'}
              </span>
              <span className={'pill ' + (ok ? 'good' : s === 'waiting' ? 'accent' : 'warn')} style={{ whiteSpace: 'normal' }}>
                {ok ? 'Passed' : s === 'waiting' ? 'Waiting for its check' : why(q)}
              </span>
            </span>
            <Preview x={q} />
          </div>
        );
      })}
    </div>
  );
}
