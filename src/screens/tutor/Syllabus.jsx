// Library → Syllabus: a subject's topics (with the syllabus's own numbers and subtopics),
// set up however the tutor likes (Prof, StudyBridge's list, the official document, or typed),
// and a coverage map: what each learner has been taught and how they're doing, per topic.
import { useEffect, useMemo, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as X from '../../lib/exams.js';
import { useLookups } from '../shared/lookups.jsx';

const IB_CURRICULUM = 'https://www.ibo.org/programmes/diploma-programme/curriculum/';

export function examLabel(exam) {
  if (!exam) return '';
  const [b, c] = exam.split(':');
  const s = X.findSyllabus(b, c);
  if (!s) return '';
  return b === 'cie' ? `Cambridge IGCSE ${s.name} (${s.code})` : `IB Diploma ${s.name}`;
}

// Typed list → topics. "1 Number" / "C2 Algebra" give the syllabus number; lines starting
// with "-", "•" or spaces are that topic's subtopics.
export function parseTopicText(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    const sub = /^\s+|^[-•*]\s*/.test(raw);
    const line = raw.trim().replace(/^[-•*]\s*/, '');
    if (sub && out.length) {
      out[out.length - 1].details.push(line);
      continue;
    }
    const m = line.match(/^((?:[A-Z]{1,3}\s?)?\d+(?:\.\d+)*[a-z]?|[A-Z]\d*)[.):]?\s+(.+)$/);
    out.push(m ? { code: m[1], name: m[2].trim(), details: [] } : { code: null, name: line, details: [] });
  }
  return out;
}

export default function Syllabus() {
  const lk = useLookups();
  const route = useRoute();
  const [sid, setSid] = useState(route.query.get('subject') || null);
  useEffect(() => {
    if (sid && lk.subjects.some((s) => s.id === sid)) return;
    const withExam = lk.subjects.find((s) => s.exam);
    setSid((withExam || lk.subjects[0])?.id || null);
  }, [lk.subjects.map((s) => s.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const subject = lk.subjects.find((s) => s.id === sid);
  if (!lk.subjects.length)
    return (
      <Empty title="Add a subject first">
        Make your subjects in <a href="#/structure">Subjects</a>, then set up each one’s syllabus here.
      </Empty>
    );
  const [board, code] = (subject?.exam || '').split(':');
  const official = board === 'cie' ? X.officialPage(code) : board === 'ib' ? IB_CURRICULUM : null;
  return (
    <div className="stack">
      <div className="row wrap">
        <select className="select" style={{ width: 'auto' }} value={sid || ''} onChange={(e) => setSid(e.target.value)} aria-label="Subject">
          {lk.subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.exam ? ` · ${X.syllabusLabel(...s.exam.split(':'))}` : ''}
            </option>
          ))}
        </select>
        {official && (
          <a className="btn sm ghost" href={official} target="_blank" rel="noreferrer">
            <Icon name="globe" size={16} /> {board === 'cie' ? 'Cambridge’s page (syllabus PDF)' : 'IB subject pages'}
          </a>
        )}
        {subject && !subject.exam && (
          <span className="small muted">
            Tip: set this subject’s exam in <a href="#/structure">Subjects</a>.
          </span>
        )}
      </div>
      {subject && <SubjectSyllabus key={subject.id} subject={subject} />}
    </div>
  );
}

function SubjectSyllabus({ subject }) {
  const lk = useLookups();
  const topics = useMemo(() => [...lk.topicsOf(subject.id)].sort((a, b) => (a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name)), [lk.topics, subject.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const jobs = useQuery('prof-jobs', api.profJobs);
  const mine = (jobs.data || []).filter((j) => j.kind === 'syllabus' && j.context?.subject_id === subject.id);
  const running = mine.find((j) => ['queued', 'running', 'waiting'].includes(j.status));
  const [dismissed, setDismissed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('sb.syllabusSeen') || '[]');
    } catch {
      return [];
    }
  });
  const proposal = mine.find((j) => j.status === 'done' && j.result?.syllabus && !dismissed.includes(j.id));
  const failed = mine.find((j) => j.status === 'failed' && !dismissed.includes(j.id));
  const dismiss = (id) => {
    const next = [...dismissed, id].slice(-100);
    setDismissed(next);
    try {
      localStorage.setItem('sb.syllabusSeen', JSON.stringify(next));
    } catch {
      /* fine */
    }
  };
  return (
    <>
      {running && (
        <div className="card row small">
          <div className="spinner" /> Prof is setting out the syllabus for {subject.name}… You’ll get a notification.
        </div>
      )}
      {failed && (
        <div className="card warn small row between">
          <span>Prof couldn’t do it: {failed.error}</span>
          <button className="btn sm" onClick={() => dismiss(failed.id)}>
            OK
          </button>
        </div>
      )}
      {proposal && <Proposal job={proposal} subject={subject} topics={topics} onDone={() => dismiss(proposal.id)} />}
      {!topics.length && !running && !proposal ? <SetUp subject={subject} /> : <TopicList subject={subject} topics={topics} />}
      {topics.length > 0 && <Coverage subject={subject} />}
    </>
  );
}

function Proposal({ job, subject, topics, onDone }) {
  const toast = useToast();
  const lk = useLookups();
  const [busy, setBusy] = useState(false);
  const p = job.result.syllabus;
  const known = new Set(topics.map((t) => api.topicKey(t.name)));
  const fresh = p.topics.filter((t) => !known.has(api.topicKey(t.name))).length;
  return (
    <div className="card claude-card">
      <h3 className="row" style={{ margin: 0 }}>
        <Icon name="cap" style={{ color: 'var(--claude)' }} /> Prof’s syllabus for {subject.name}: {p.topics.length} topics
      </h3>
      {p.note && <div className="small muted">{p.note}</div>}
      <ol className="syllabus-list">
        {p.topics.map((t, i) => (
          <li key={i}>
            <b>
              {t.code ? `${t.code} ` : ''}
              {t.name}
            </b>
            {t.details?.length > 0 && <div className="small muted">{t.details.join(' · ')}</div>}
          </li>
        ))}
      </ol>
      <div className="row wrap">
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.applyTopics(subject.id, p.topics, topics, { reorder: true });
              lk.reload();
              toast(topics.length ? `Added ${fresh} new topic${fresh === 1 ? '' : 's'}; yours kept and put in syllabus order` : `${p.topics.length} topics added`);
              onDone();
            } catch (e) {
              toast({ title: 'Couldn’t add them', body: e.message, tone: 'bad' });
            } finally {
              setBusy(false);
            }
          }}
        >
          {topics.length ? `Use these (add ${fresh} new, keep yours, in syllabus order)` : 'Use these topics'}
        </button>
        <button className="btn" onClick={onDone}>
          Don’t use
        </button>
      </div>
      <div className="tiny muted">You can rename, reorder or delete any topic afterwards.</div>
    </div>
  );
}

function SetUp({ subject, topics = [], onDone }) {
  const toast = useToast();
  const lk = useLookups();
  const [, code] = (subject.exam || '').split(':');
  const builtIn = X.topicsFor(code);
  const [label, setLabel] = useState(examLabel(subject.exam));
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  const usage = useQuery('prof-usage', api.profUsage).data;
  async function add(list, what) {
    setBusy(what);
    try {
      await api.applyTopics(subject.id, list, topics, { reorder: topics.length > 0 });
      lk.reload();
      toast(topics.length ? 'Syllabus set out: your topics are kept and put in syllabus order' : `${list.length} topics added`);
      onDone?.();
    } catch (e) {
      toast({ title: 'Couldn’t add them', body: e.message, tone: 'bad' });
    } finally {
      setBusy('');
    }
  }
  return (
    <div className={topics.length ? 'stack syllabus-setup' : 'card'}>
      <h2>{topics.length ? `Set up the whole syllabus for ${subject.name}` : `Set up the syllabus for ${subject.name}`}</h2>
      <div className="small muted">
        {topics.length
          ? 'The topics you already have stay, with their questions, flashcards and coverage. Matching topics get the syllabus numbers and subtopics, new ones are added, and everything is put in syllabus order. Anything that isn’t in the syllabus goes at the end.'
          : 'Topics are used everywhere: the question bank, practice, reports, flashcards and the coverage map below. Choose whichever way suits you; you can change everything later.'}
      </div>
      <div className="grid g2" style={{ gap: 14 }}>
        <div className="setup-option">
          <h3 className="row">
            <Icon name="cap" style={{ color: 'var(--claude)' }} /> Ask Prof
          </h3>
          <div className="small muted">Prof sets out the official syllabus: topics in order, with their numbers and subtopics. You check it before it’s used.</div>
          <Field label="Exam or syllabus">
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Cambridge IGCSE International Mathematics 0607 (Extended)" />
          </Field>
          <Field label="Anything to add (optional)">
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Extended tier only; 2025–2027 syllabus" />
          </Field>
          <div>
            <button
              className="btn claude"
              disabled={!!busy || label.trim().length < 3 || (usage && !usage.ready)}
              onClick={async () => {
                setBusy('prof');
                try {
                  await api.profSyllabus(subject.id, label.trim(), [note.trim(), topics.length ? 'The tutor already has some topics; give the full official list in order so they can be merged.' : ''].filter(Boolean).join(' '));
                  invalidate('prof-jobs');
                  toast({ title: 'Prof is on it', body: 'You’ll get a notification when the topics are ready to check.' });
                  onDone?.();
                } catch (e) {
                  toast({ title: 'Couldn’t ask Prof', body: e.message, tone: 'bad' });
                } finally {
                  setBusy('');
                }
              }}
            >
              <Icon name="cap" size={16} /> Set it up with Prof
            </button>
          </div>
          {usage && !usage.ready && <div className="tiny muted">{usage.why_not}</div>}
        </div>
        <div className="setup-option">
          <h3 className="row">
            <Icon name="pen" /> Type or paste it
          </h3>
          <div className="small muted">One topic per line. Start a line with a number to keep the syllabus number (“1.2 Fractions”). Lines starting with “-” are that topic’s subtopics. Pasting from the syllabus PDF works.</div>
          <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder={'1 Number\n- Types of number\n- Fractions, decimals, percentages\n2 Algebra\n- Simplifying\n- Equations'} aria-label="Topics" />
          <div>
            <button className="btn" disabled={!!busy || !parseTopicText(text).length} onClick={() => add(parseTopicText(text), 'typed')}>
              Add {parseTopicText(text).length || ''} topic{parseTopicText(text).length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
      {builtIn.length > 0 && (
        <div className="row wrap small">
          <span>Or start from StudyBridge’s list for {code}:</span>
          <span className="muted">{builtIn.join(', ')}</span>
          <button className="btn sm" disabled={!!busy} onClick={() => add(builtIn.map((name) => ({ name, details: [] })), 'builtin')}>
            Use this list
          </button>
        </div>
      )}
    </div>
  );
}

// The syllabus in order: numbered topics with their subtopics underneath ("2" → "2.1", "2.2" …)
const subNumber = (t, i, d) => (t.code && !/^\s*[A-Z]{0,3}\s?\d/.test(d) ? `${t.code}.${i + 1}` : '');

function TopicList({ subject, topics }) {
  const lk = useLookups();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null);
  const [closed, setClosed] = useState(() => new Set());
  const [adding, setAdding] = useState('');
  const [setup, setSetup] = useState(false);
  const withSubs = topics.filter((t) => t.details?.length);
  async function move(i, d) {
    const a = topics[i];
    const b = topics[i + d];
    if (!a || !b) return;
    await api.save('topics', { id: a.id, position: i + d });
    await api.save('topics', { id: b.id, position: i });
    lk.reload();
  }
  const toggle = (id) =>
    setClosed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="card">
      <div className="row between wrap">
        <h2 style={{ margin: 0 }}>
          Syllabus <span className="muted small">({topics.length} topic{topics.length === 1 ? '' : 's'})</span>
        </h2>
        <div className="row wrap">
          {withSubs.length > 0 && (
            <button className="btn sm ghost" onClick={() => setClosed(closed.size ? new Set() : new Set(withSubs.map((t) => t.id)))}>
              {closed.size ? 'Open all' : 'Close all'}
            </button>
          )}
          <button className="btn sm" onClick={() => setSetup((x) => !x)} aria-expanded={setup}>
            <Icon name="target" size={14} /> Set up the whole syllabus
          </button>
        </div>
      </div>
      {setup && <SetUp subject={subject} topics={topics} onDone={() => setSetup(false)} />}
      <ol className="syllabus-topics" aria-label={`${subject.name} syllabus`}>
        {topics.map((t, i) => {
          const open = !closed.has(t.id);
          const subs = t.details || [];
          return (
            <li key={t.id} className="syllabus-topic">
              <div className="row" style={{ gap: 8 }}>
                <span className="code">{t.code || i + 1}</span>
                {subs.length > 0 ? (
                  <button className="linkbtn grow syllabus-name" onClick={() => toggle(t.id)} aria-expanded={open}>
                    <Icon name={open ? 'down' : 'right'} size={14} /> <b>{t.name}</b>
                    {!open && (
                      <span className="small muted">
                        {' '}
                        · {subs.length} subtopic{subs.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </button>
                ) : (
                  <span className="grow syllabus-name">
                    <b>{t.name}</b>
                  </span>
                )}
                <button className="btn ghost icon sm" aria-label={`Edit ${t.name}`} onClick={() => setEditing(editing === t.id ? null : t.id)}>
                  <Icon name="pen" size={14} />
                </button>
                <button className="btn ghost icon sm" aria-label={`Move ${t.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <Icon name="up" size={14} />
                </button>
                <button className="btn ghost icon sm" aria-label={`Move ${t.name} down`} disabled={i === topics.length - 1} onClick={() => move(i, 1)}>
                  <Icon name="down" size={14} />
                </button>
              </div>
              {open && subs.length > 0 && editing !== t.id && (
                <ul className="syllabus-subs">
                  {subs.map((d, j) => (
                    <li key={j}>
                      <span className="code">{subNumber(t, j, d) || '•'}</span>
                      <span>{d}</span>
                    </li>
                  ))}
                </ul>
              )}
              {editing === t.id && (
                <TopicEdit
                  t={t}
                  onClose={() => setEditing(null)}
                  onDelete={async () => {
                    if (!(await confirm({ title: `Delete ${t.name}?`, body: 'Questions and work tagged with it keep existing but lose the tag.', ok: 'Delete', danger: true }))) return;
                    await api.remove('topics', t.id);
                    lk.reload();
                    setEditing(null);
                  }}
                />
              )}
            </li>
          );
        })}
      </ol>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          const parsed = parseTopicText(adding);
          if (!parsed.length) return;
          try {
            await api.applyTopics(subject.id, parsed, topics);
            setAdding('');
            lk.reload();
          } catch (x) {
            toast({ title: 'Couldn’t add it', body: x.message, tone: 'bad' });
          }
        }}
      >
        <input className="input" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add a topic, e.g. 11 Vectors" aria-label="New topic" />
        <button className="btn">Add</button>
      </form>
    </div>
  );
}

function TopicEdit({ t, onDelete, onClose }) {
  const lk = useLookups();
  const toast = useToast();
  const [name, setName] = useState(t.name);
  const [code, setCode] = useState(t.code || '');
  const [subs, setSubs] = useState(() => [...(t.details || [])]);
  const set = (i, v) => setSubs(subs.map((x, j) => (j === i ? v : x)));
  const swap = (i) => setSubs(subs.map((x, j) => (j === i ? subs[i + 1] : j === i + 1 ? subs[i] : x)));
  return (
    <div className="stack sm syllabus-edit">
      <div className="row wrap">
        <input className="input" style={{ maxWidth: 90 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="No." aria-label="Syllabus number" />
        <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} aria-label="Topic name" />
      </div>
      <div className="small strong">Subtopics</div>
      {subs.map((d, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <span className="muted small" style={{ width: 44, flexShrink: 0 }}>
            {subNumber({ code }, i, d) || '•'}
          </span>
          <input className="input grow" value={d} onChange={(e) => set(i, e.target.value)} aria-label={`Subtopic ${i + 1}`} />
          <button type="button" className="btn ghost icon sm" aria-label="Move subtopic up" disabled={i === 0} onClick={() => swap(i - 1)}>
            <Icon name="up" size={14} />
          </button>
          <button type="button" className="btn ghost icon sm" aria-label="Move subtopic down" disabled={i === subs.length - 1} onClick={() => swap(i)}>
            <Icon name="down" size={14} />
          </button>
          <button type="button" className="btn ghost icon sm" aria-label="Remove subtopic" onClick={() => setSubs(subs.filter((_, j) => j !== i))}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn sm ghost" onClick={() => setSubs([...subs, ''])}>
          <Icon name="plus" size={14} /> Add a subtopic
        </button>
      </div>
      <div className="row">
        <button
          className="btn sm primary"
          onClick={async () => {
            try {
              await api.save('topics', { id: t.id, name: name.trim() || t.name, code: code.trim() || null, details: subs.map((x) => x.trim()).filter(Boolean) });
              lk.reload();
              toast('Saved');
              onClose();
            } catch (e) {
              toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
            }
          }}
        >
          Save
        </button>
        <button className="btn sm" onClick={onClose}>
          Cancel
        </button>
        <span className="grow" />
        <button className="btn sm danger" onClick={onDelete}>
          <Icon name="trash" size={14} /> Delete topic
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
const STRENGTH = { strong: 'Strong', developing: 'Getting there', weak: 'Needs work' };
const LABEL = { ...STRENGTH, taught: 'Taught', not_yet: 'Not yet' };
const CHOICES = ['strong', 'developing', 'weak', 'taught', 'not_yet'];
// The menu sits over the page, under its cell (or above it near the bottom of the window):
// the table scrolls sideways, which would cut off anything inside it
function menuPlace(el) {
  const r = el.getBoundingClientRect();
  const h = 260;
  return { left: Math.max(8, Math.min(r.left, window.innerWidth - 210)), top: r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4 };
}
function Coverage({ subject }) {
  const q = useQuery(`coverage:${subject.id}`, () => api.coverage(subject.id));
  const toast = useToast();
  const [menu, setMenu] = useState(null); // { id: `${learner}:${topic}`, el: the cell's button }
  const [, follow] = useState(0); // the menu follows its cell when the page scrolls
  useEffect(() => {
    if (!menu) return;
    const close = (e) => {
      if (!e.target.closest?.('.cov-pick')) setMenu(null);
    };
    const esc = (e) => e.key === 'Escape' && setMenu(null);
    const away = () => follow((n) => n + 1);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [menu]);
  const c = q.data;
  if (!c) return null;
  if (!c.learners.length)
    return (
      <div className="card small muted">
        Coverage shows here once a learner takes {subject.name}.
      </div>
    );
  async function pick(l, t, state) {
    setMenu(null);
    try {
      await api.setTopicState(l.id, t.id, state);
      invalidate(`coverage:${subject.id}`);
    } catch (e) {
      toast({ title: 'Couldn’t change it', body: e.message, tone: 'bad' });
    }
  }
  return (
    <div className="card">
      <h2>Coverage</h2>
      <div className="small muted">
        What each learner has been taught and how they’re doing, topic by topic. StudyBridge fills it in from lessons, work and their marked answers. Click any cell to set it yourself (e.g. after a live lesson).
      </div>
      <div className="row wrap small cov-key" aria-label="Key">
        {CHOICES.map((k) => (
          <span key={k} className="row" style={{ gap: 6 }}>
            <i className={'cov-dot ' + k} /> {LABEL[k]}
          </span>
        ))}
        <span className="row" style={{ gap: 6 }}>
          <i className="cov-mine" /> set by you
        </span>
      </div>
      <div className="table-wrap">
        <table className="table coverage">
          <thead>
            <tr>
              <th>Topic</th>
              {c.learners.map((l) => (
                <th key={l.id}>{l.name.split(' ')[0]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.topics.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.code ? <span className="muted">{t.code} </span> : null}
                  {t.name}
                </td>
                {c.learners.map((l) => {
                  const sc = l.scores[t.id];
                  const set = (l.set || {})[t.id] || (l.marked.includes(t.id) ? 'taught' : null);
                  const auto = sc && sc.strength !== 'none' ? sc.strength : l.taught.includes(t.id) ? 'taught' : 'not_yet';
                  // your own call wins, except a plain "taught" doesn't hide how their answers are going
                  const state = set && !(set === 'taught' && auto !== 'not_yet' && auto !== 'taught') ? set : auto;
                  const fromAnswers = state === auto && sc && sc.strength !== 'none';
                  const id = `${l.id}:${t.id}`;
                  const why = [
                    set ? `You set: ${LABEL[set]}` : null,
                    sc ? `Their answers: ${Math.round(100 * sc.ratio)}% over ${sc.answered} answer${sc.answered === 1 ? '' : 's'}` : null,
                    !set && l.taught.includes(t.id) ? 'Taught in a lesson or work' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <td key={l.id} className="cov-pick">
                      <button
                        className={'cov-cell ' + (state === 'not_yet' ? '' : state) + (set && state === set ? ' mine' : '')}
                        title={(why || 'Not taught yet') + ' · click to change'}
                        aria-haspopup="menu"
                        aria-expanded={menu?.id === id}
                        onClick={(e) => {
                          if (menu?.id === id) return setMenu(null);
                          setMenu({ id, el: e.currentTarget });
                        }}
                      >
                        {fromAnswers ? `${Math.round(100 * sc.ratio)}%` : state === 'not_yet' ? '—' : LABEL[state]}
                      </button>
                      {menu?.id === id && (
                        <div className="cov-menu" role="menu" style={menuPlace(menu.el)}>
                          <div className="tiny muted">
                            {l.name.split(' ')[0]} · {t.name}
                          </div>
                          {CHOICES.map((k) => (
                            <button key={k} role="menuitem" className={'cov-option' + (set === k ? ' on' : '')} onClick={() => pick(l, t, k)}>
                              <i className={'cov-dot ' + k} /> {LABEL[k]}
                            </button>
                          ))}
                          {set && (
                            <button role="menuitem" className="cov-option" onClick={() => pick(l, t, null)}>
                              <Icon name="refresh" size={14} /> Let StudyBridge decide
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tiny muted">Percentages are from their marked answers (last 10 per topic). Anything you set yourself has a dot.</div>
    </div>
  );
}
