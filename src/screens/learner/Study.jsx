// Study: the learner's own revision. Everything here was made or approved by their tutor
// (learners never use AI): flashcards that come back at the right time, cards from their own
// mistakes, practice from the tutor's question bank (daily quiz, a topic, worked example then
// "you try", timed drills), a revision plan up to the exam, formula sheets, and a daily goal.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Markdown, Page, go, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { useLookups } from '../shared/lookups.jsx';

const NEW_PER_DAY = 20;

export default function Study() {
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    api.syncMistakeCards().then((n) => n && invalidate('cards', 'study')).catch(() => {});
  }, []);
  if (reviewing) return <Review onDone={() => (setReviewing(false), invalidate('study', 'card-reviews'))} />;
  return (
    <Page title="Study" subtitle="Your own revision: flashcards, practice and your formula sheets. A little every day adds up.">
      <Goal />
      <Cards onReview={() => setReviewing(true)} />
      <Practice />
      <Plan />
      <FormulaSheets />
    </Page>
  );
}

function fmtMin(sec) {
  const m = Math.round((sec || 0) / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function Goal() {
  const q = useQuery('study', () => api.studySummary());
  const toast = useToast();
  const s = q.data;
  if (!s) return null;
  const pct = Math.min(100, Math.round((100 * s.today_sec) / Math.max(60, s.goal_min * 60)));
  return (
    <div className="card study-goal">
      <div className="row between wrap">
        <div className="row" style={{ gap: 14 }}>
          <div className={'streak' + (s.streak ? ' on' : '')} title="Days in a row you studied">
            <Icon name="flame" size={26} />
            <span>{s.streak}</span>
          </div>
          <div>
            <div className="strong">{s.streak ? `${s.streak}-day streak` : 'Start a streak today'}</div>
            <div className="small muted">
              Today {fmtMin(s.today_sec)} of {s.goal_min} min {pct >= 100 ? '· goal reached!' : ''}
            </div>
          </div>
        </div>
        <label className="row small" style={{ gap: 6 }}>
          Daily goal
          <select
            className="select sm"
            value={s.goal_min}
            onChange={async (e) => {
              await api.setStudyGoal(Number(e.target.value));
              invalidate('study');
              toast('Goal saved');
            }}
          >
            {[5, 10, 15, 20, 30, 45, 60].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="bar">
        <span style={{ width: pct + '%' }} />
      </div>
      <div className="study-days" aria-label="Last two weeks">
        {s.days.map((d) => (
          <span key={d.day} className={'dot-day' + (d.sec >= s.goal_min * 60 ? ' hit' : d.sec > 0 ? ' some' : '')} title={`${d.day}: ${fmtMin(d.sec)}`} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function useDeck() {
  const cards = useQuery('cards', api.listCards);
  const reviews = useQuery('card-reviews', api.myReviews);
  return useMemo(() => {
    const byCard = new Map((reviews.data || []).map((r) => [r.card_id, r]));
    const all = cards.data || [];
    const now = Date.now();
    const seen = all.filter((c) => byCard.has(c.id));
    const due = seen.filter((c) => new Date(byCard.get(c.id).due_at).getTime() <= now).sort((a, b) => new Date(byCard.get(a.id).due_at) - new Date(byCard.get(b.id).due_at));
    const todayNew = (reviews.data || []).filter((r) => r.reps <= 1 && r.last_at && new Date(r.last_at).toDateString() === new Date().toDateString()).length;
    const fresh = all.filter((c) => !byCard.has(c.id)).sort((a, b) => (a.source === 'mistake' ? -1 : 0) - (b.source === 'mistake' ? -1 : 0));
    const newToday = fresh.slice(0, Math.max(0, NEW_PER_DAY - todayNew));
    return { ready: !!(cards.data && reviews.data), all, due, fresh, newToday, queue: [...due, ...newToday], byCard };
  }, [cards.data, reviews.data]);
}

function Cards({ onReview }) {
  const d = useDeck();
  const lk = useLookups();
  const [making, setMaking] = useState(false);
  const mistakes = d.all.filter((c) => c.source === 'mistake').length;
  const own = d.all.filter((c) => c.source === 'own').length;
  return (
    <div className="card">
      <div className="row between wrap">
        <h2 className="row" style={{ margin: 0 }}>
          <Icon name="layers" style={{ color: 'var(--accent)' }} /> Flashcards
        </h2>
        <button className="btn sm" onClick={() => setMaking((x) => !x)}>
          <Icon name="plus" size={14} /> Make a card
        </button>
      </div>
      {d.ready && !d.all.length ? (
        <div className="small muted">No cards yet. Your tutor adds them, and questions you get wrong become cards here too. You can also make your own.</div>
      ) : (
        <>
          <div className="small">
            <b>{d.queue.length}</b> to do now ({d.due.length} to review{d.newToday.length ? `, ${d.newToday.length} new` : ''}) · {d.all.length} cards in all
            {mistakes ? ` · ${mistakes} from your mistakes` : ''}
            {own ? ` · ${own} you made` : ''}
          </div>
          <div className="small muted">Cards you know come back less often; ones you find hard come back sooner.</div>
          <div>
            <button className="btn primary" disabled={!d.queue.length} onClick={onReview}>
              {d.queue.length ? `Start (${d.queue.length})` : 'All done for now'}
            </button>
          </div>
        </>
      )}
      {making && <OwnCard subjects={lk.subjects} onDone={() => setMaking(false)} />}
    </div>
  );
}

function OwnCard({ subjects, onDone }) {
  const toast = useToast();
  const lk = useLookups();
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [subject, setSubject] = useState(subjects[0]?.id || '');
  const [topic, setTopic] = useState('');
  return (
    <div className="stack sm" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
      <div className="grid g2" style={{ gap: 10 }}>
        <Field label="Front (question)">
          <textarea className="textarea" value={front} onChange={(e) => setFront(e.target.value)} placeholder="e.g. Area of a circle?" />
        </Field>
        <Field label="Back (answer)">
          <textarea className="textarea" value={back} onChange={(e) => setBack(e.target.value)} placeholder="e.g. $\pi r^2$" />
        </Field>
      </div>
      <div className="row wrap">
        <select className="select" style={{ width: 'auto' }} value={subject} onChange={(e) => (setSubject(e.target.value), setTopic(''))} aria-label="Subject">
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 'auto' }} value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Topic">
          <option value="">Any topic</option>
          {lk.topicsOf(subject).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          className="btn primary"
          disabled={!front.trim() || !back.trim()}
          onClick={async () => {
            try {
              await api.addOwnCard({ front_md: front.trim(), back_md: back.trim(), subject_id: subject || null, topic_id: topic || null });
              invalidate('cards');
              setFront('');
              setBack('');
              toast('Card added');
            } catch (e) {
              toast({ title: 'Couldn’t add it', body: e.message, tone: 'bad' });
            }
          }}
        >
          Add card
        </button>
        <button className="btn ghost" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

const GRADES = [
  [0, 'Again', 'bad'],
  [1, 'Hard', ''],
  [2, 'Good', 'primary'],
  [3, 'Easy', ''],
];
function Review({ onDone }) {
  const d = useDeck();
  const lk = useLookups();
  const [queue, setQueue] = useState(null);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [done, setDone] = useState(0);
  const started = useRef(Date.now());
  const lastLog = useRef(Date.now());
  useEffect(() => {
    if (d.ready && queue === null) setQueue(d.queue.slice(0, 60));
  }, [d.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  // time spent counts towards the daily goal
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      const s = (Date.now() - lastLog.current) / 1000;
      if (s >= 30) {
        api.logStudy(Math.min(120, s), queue?.[i]?.subject_id || null);
        lastLog.current = Date.now();
      }
    }, 10000);
    return () => {
      clearInterval(t);
      const s = (Date.now() - lastLog.current) / 1000;
      if (s >= 5) api.logStudy(Math.min(120, s));
    };
  }, [queue, i]);
  useEffect(() => {
    const h = (e) => {
      if (e.key === ' ' && !flipped) (e.preventDefault(), setFlipped(true));
      else if (flipped && ['1', '2', '3', '4'].includes(e.key)) grade(Number(e.key) - 1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  if (!queue) return <Page title="Flashcards" />;
  const card = queue[i];
  async function grade(g) {
    const c = queue[i];
    setFlipped(false);
    api.reviewCard(c.id, g).catch(() => {});
    setDone((n) => n + 1);
    // "Again" comes back later in this session
    if (g === 0) setQueue((q) => [...q, c]);
    setI((x) => x + 1);
  }
  if (!card)
    return (
      <Page title="Flashcards">
        <div className="card center-card">
          <Icon name="trophy" size={36} style={{ color: 'var(--accent)' }} />
          <h2>All done!</h2>
          <div className="small muted">
            {done} card{done === 1 ? '' : 's'} in {fmtMin((Date.now() - started.current) / 1000)}. They’ll come back when it’s time.
          </div>
          <button className="btn primary" onClick={onDone}>
            Back to Study
          </button>
        </div>
      </Page>
    );
  const topic = card.topic_id ? lk.topic(card.topic_id)?.name : null;
  return (
    <Page
      title="Flashcards"
      subtitle={`${Math.min(i + 1, queue.length)} of ${queue.length}`}
      actions={
        <button className="btn" onClick={onDone}>
          Stop
        </button>
      }
    >
      <div className="flashcard" onClick={() => !flipped && setFlipped(true)} role="button" tabIndex={0} aria-label={flipped ? 'Answer' : 'Show the answer'}>
        <div className="small muted row wrap" style={{ gap: 6 }}>
          {card.source === 'mistake' && <span className="pill warn">From your mistakes</span>}
          {card.source === 'own' && <span className="pill">Your card</span>}
          {topic && <span className="pill">{topic}</span>}
        </div>
        <div className="face">
          <Markdown src={card.front_md} />
        </div>
        {flipped ? (
          <div className="face back">
            <Markdown src={card.back_md || '—'} />
          </div>
        ) : (
          <div className="small muted">Think of the answer, then tap to check (or press space).</div>
        )}
      </div>
      {flipped && (
        <div className="row wrap grade-row">
          {GRADES.map(([g, label, tone]) => (
            <button key={g} className={'btn ' + tone} onClick={() => grade(g)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------
function Practice() {
  const lk = useLookups();
  const toast = useToast();
  const q = useQuery('practice-topics', api.practiceTopics);
  const topics = q.data || [];
  const [subject, setSubject] = useState('');
  const [topic, setTopic] = useState('');
  const [minutes, setMinutes] = useState(10);
  const [busy, setBusy] = useState('');
  const subjects = lk.subjects.filter((s) => topics.some((t) => t.subject_id === s.id));
  useEffect(() => {
    if (!subject && subjects[0]) setSubject(subjects[0].id);
  }, [subjects.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const here = topics.filter((t) => t.subject_id === subject);
  const pick = here.find((t) => t.topic === topic);
  async function start(mode, opts) {
    setBusy(mode);
    try {
      const r = await api.startPractice(mode, opts);
      invalidate('assignments');
      go(`/work/${r.assignment_id}`);
    } catch (e) {
      toast({ title: 'Couldn’t start it', body: e.message, tone: 'bad' });
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="card">
      <h2 className="row" style={{ margin: 0 }}>
        <Icon name="target" style={{ color: 'var(--accent)' }} /> Practice
      </h2>
      {q.data && !topics.length ? (
        <div className="small muted">Practice questions appear here once your tutor adds some to their question bank.</div>
      ) : (
        <>
          <div className="row wrap">
            <button className="btn primary" disabled={!!busy} onClick={() => start('daily', {})}>
              <Icon name="spark" size={16} /> Daily quiz (5 questions)
            </button>
            <span className="small muted">Mixed questions, more of the topics you find hard. Marked straight away.</span>
          </div>
          <div className="row wrap" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
            {subjects.length > 1 && (
              <select className="select" style={{ width: 'auto' }} value={subject} onChange={(e) => (setSubject(e.target.value), setTopic(''))} aria-label="Subject">
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
            <select className="select" style={{ width: 'auto' }} value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Topic">
              <option value="">Choose a topic…</option>
              {here.map((t) => (
                <option key={t.topic} value={t.topic}>
                  {t.topic} ({t.questions})
                </option>
              ))}
            </select>
          </div>
          {topic && (
            <div className="row wrap">
              <button className="btn" disabled={!!busy} onClick={() => start('topic', { subject, topic, count: 6 })}>
                Practise this topic
              </button>
              <button className="btn" disabled={!!busy || !pick?.examples || pick.questions < 2} onClick={() => start('learn', { subject, topic, count: 3 })} title={pick?.examples ? '' : 'No worked example for this topic yet'}>
                Worked example → you try
              </button>
              <span className="row" style={{ gap: 6 }}>
                <button className="btn" disabled={!!busy} onClick={() => start('drill', { subject, topic, count: Math.max(3, Math.round(minutes / 2)), minutes })}>
                  <Icon name="clock" size={16} /> Timed drill
                </button>
                <select className="select sm" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Minutes">
                  {[5, 10, 15, 20, 30].map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// From now to the exam: topics that need the most work first, spread across the weeks left
function Plan() {
  const s = useQuery('study', () => api.studySummary()).data;
  const t = useQuery('my-topics', api.myTopics).data;
  const lk = useLookups();
  if (!s || !t) return null;
  const exam = s.exam;
  if (!t.length) return null;
  const rank = { weak: 0, developing: 1, none: 2, strong: 3 };
  const order = [...t].sort((a, b) => (a.taught === b.taught ? 0 : a.taught ? -1 : 1) || rank[a.strength] - rank[b.strength]);
  const days = exam?.date ? Math.ceil((new Date(exam.date) - new Date()) / 86400000) : null;
  const weeks = days != null ? Math.max(1, Math.floor(days / 7)) : null;
  const perWeek = weeks ? Math.max(1, Math.ceil(order.filter((x) => x.strength !== 'strong').length / weeks)) : 3;
  const thisWeek = order.filter((x) => x.strength !== 'strong').slice(0, perWeek);
  const label = { weak: 'Needs work', developing: 'Getting there', strong: 'Strong', none: 'Not practised yet' };
  return (
    <div className="card">
      <h2 className="row" style={{ margin: 0 }}>
        <Icon name="calendar" style={{ color: 'var(--accent)' }} /> Revision plan
      </h2>
      {exam?.date ? (
        <div className="small">
          {exam.name || 'Your exam'}: <b>{days > 0 ? `${days} day${days === 1 ? '' : 's'} to go` : days === 0 ? 'today. Good luck!' : 'done'}</b>
          {weeks ? ` · about ${perWeek} topic${perWeek === 1 ? '' : 's'} a week` : ''}
        </div>
      ) : (
        <div className="small muted">When your tutor sets your exam date, this spreads your revision over the weeks left.</div>
      )}
      <div className="small strong">This week</div>
      <div className="list">
        {thisWeek.map((x) => (
          <div key={x.id} className="item">
            <span className={'cov-cell sm ' + (x.strength === 'none' ? (x.taught ? 'taught' : '') : x.strength)}>{label[x.strength]}</span>
            <span className="grow">
              {x.code ? <span className="muted">{x.code} </span> : null}
              {x.name}
              {lk.subjects.length > 1 && <span className="meta">{lk.subject(x.subject_id)?.name}</span>}
            </span>
          </div>
        ))}
        {!thisWeek.length && <div className="small muted">Everything’s strong. Keep it fresh with flashcards and the daily quiz.</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function FormulaSheets() {
  const lk = useLookups();
  const toast = useToast();
  const notes = useQuery('study-notes', () => api.getStudyNotes());
  const [subject, setSubject] = useState('');
  const [text, setText] = useState(null);
  const [view, setView] = useState(false);
  useEffect(() => {
    if (!subject && lk.subjects[0]) setSubject(lk.subjects[0].id);
  }, [lk.subjects.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastSaved = useRef({});
  const saved = lastSaved.current[subject] ?? ((notes.data || []).find((n) => n.subject_id === subject)?.body_md || '');
  useEffect(() => setText(null), [subject]);
  const value = text ?? saved;
  if (!lk.subjects.length) return null;
  async function save() {
    const current = lastSaved.current[subject] ?? ((notes.data || []).find((n) => n.subject_id === subject)?.body_md || '');
    if (text === null || text === current) return;
    lastSaved.current[subject] = text; // so a second click/blur doesn't save it twice
    try {
      await api.saveStudyNotes(subject, text);
      invalidate('study-notes');
      toast('Formula sheet saved');
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    }
  }
  return (
    <div className="card">
      <div className="row between wrap">
        <h2 className="row" style={{ margin: 0 }}>
          <Icon name="sigma" style={{ color: 'var(--accent)' }} /> My formula sheet
        </h2>
        <div className="row" style={{ gap: 6 }}>
          {lk.subjects.length > 1 && (
            <select className="select sm" value={subject} onChange={(e) => (save(), setSubject(e.target.value))} aria-label="Subject">
              {lk.subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <button className="btn sm" onClick={() => (save(), setView((v) => !v))}>
            {view ? 'Edit' : 'Preview'}
          </button>
        </div>
      </div>
      <div className="small muted">Write the formulas, facts and methods you need, in your own words. Your tutor can see it. Maths goes between $ signs, e.g. $a^2 + b^2 = c^2$.</div>
      {view ? (
        <div className="formula-preview">{value.trim() ? <Markdown src={value} /> : <Empty>Nothing yet.</Empty>}</div>
      ) : (
        <textarea className="textarea tall" value={value} onChange={(e) => setText(e.target.value)} onBlur={save} placeholder={'## Algebra\n- Quadratic formula: $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$\n- …'} aria-label="Formula sheet" />
      )}
      {!view && text !== null && text !== saved && (
        <div>
          <button className="btn primary sm" onClick={save}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}

// Small summary for the Today page
export function StudyNudge() {
  const s = useQuery('study', () => api.studySummary()).data;
  if (!s) return null;
  return (
    <a className="card study-nudge" href="#/study">
      <div className={'streak' + (s.streak ? ' on' : '')}>
        <Icon name="flame" size={22} />
        <span>{s.streak}</span>
      </div>
      <div className="grow">
        <div className="strong">{s.cards_due ? `${s.cards_due} flashcard${s.cards_due === 1 ? '' : 's'} to do` : 'Study'}</div>
        <div className="small muted">
          Today {fmtMin(s.today_sec)} of {s.goal_min} min{s.streak ? ` · ${s.streak}-day streak` : ''}
        </div>
      </div>
      <Icon name="right" />
    </a>
  );
}

// For the tutor: how a learner is studying, and their formula sheets
export function StudyForTutor({ learnerId }) {
  const s = useQuery(`study:${learnerId}`, () => api.studySummary(learnerId)).data;
  const notes = useQuery(`study-notes:${learnerId}`, () => api.getStudyNotes(learnerId)).data || [];
  const lk = useLookups();
  if (!s) return null;
  return (
    <div className="stack">
      <div className="admin-stats">
        <div className="stat">
          <div className="n">{s.streak}</div>
          <div className="l">Days in a row (goal {s.goal_min} min a day)</div>
        </div>
        <div className="stat">
          <div className="n">{fmtMin(s.today_sec)}</div>
          <div className="l">Studied today</div>
        </div>
        <div className="stat">
          <div className="n">{s.cards_learned}</div>
          <div className="l">Flashcards learned</div>
        </div>
        <div className="stat">
          <div className="n">{s.mistakes}</div>
          <div className="l">Mistake cards</div>
        </div>
      </div>
      <div className="card">
        <h3>Last two weeks</h3>
        <div className="study-days">
          {s.days.map((d) => (
            <span key={d.day} className={'dot-day' + (d.sec >= s.goal_min * 60 ? ' hit' : d.sec > 0 ? ' some' : '')} title={`${d.day}: ${fmtMin(d.sec)}`} />
          ))}
        </div>
      </div>
      <div className="card">
        <h3>Formula sheets</h3>
        {!notes.length && <div className="small muted">Nothing written yet.</div>}
        {notes.map((n) => (
          <div key={n.subject_id} className="stack sm">
            <div className="strong">{lk.subject(n.subject_id)?.name || 'Subject'}</div>
            <div className="formula-preview">
              <Markdown src={n.body_md || '—'} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
