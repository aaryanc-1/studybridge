// Students on their own (launch 1): the guided setup, the starting check, their plan on Today, what they see when the
// free week ends, paying, hints, and reporting a problem with StudyBridge's own content
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Link, Markdown, Modal, Page, go, useToast } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import site from '../../../website/site.config.json';
import { BOARDS, upcomingSessions } from '../../lib/catalogue.js';
import { spreadEvenly, today, at, fmt } from '../../lib/plan.js';
import { studentAccess } from '../../lib/students.js';
import { useLookups } from '../shared/lookups.jsx';
import MobileMoney from '../shared/MobileMoney.jsx';

const HOURS = [2, 4, 6, 8, 10];

// Board → level → subjects → exams → hours a week. Asked once; "Change my subjects" runs it again.
export function SelfSetup({ again = false }) {
  const app = useApp();
  const lk = useLookups();
  const toast = useToast();
  const me = app.me;
  const [step, setStep] = useState(0);
  const [boardId, setBoardId] = useState(() => BOARDS.find((b) => b.name === me.study_board)?.id || '');
  const [levelId, setLevelId] = useState('');
  const [picked, setPicked] = useState(() => (again ? lk.mySubjects.map((s) => s.id) : []));
  const [exam, setExam] = useState({ date: me.exam_date || '', label: me.exam_label || '' });
  const [other, setOther] = useState(false);
  const [hours, setHours] = useState(me.study_hours || 4);
  const [busy, setBusy] = useState(false);

  // only what students can take now: subjects open to them, and the boards and levels that have one
  // (the Owner's test students also see subjects that aren't open yet, to try them first)
  const open = new Set(lk.subjects.filter((s) => (s.live || me.test_student) && s.catalogue).map((s) => s.catalogue));
  const hasOpen = (subjects) => subjects.some((c) => open.has(c.key));
  const boards = BOARDS.filter((b) => b.levels.some((l) => hasOpen(l.subjects)));
  const board = boards.find((b) => b.id === boardId);
  // IB students choose from the Diploma subjects and the core together
  const levels = board ? (board.id === 'ib' ? [{ id: 'ib:all', name: 'IB Diploma', subjects: board.levels.flatMap((l) => l.subjects) }] : board.levels).filter((l) => hasOpen(l.subjects)) : [];
  const level = levels.find((l) => l.id === levelId) || (levels.length === 1 ? levels[0] : null);
  // the catalogue entries, matched to the content account's subjects (only open ones can be chosen)
  const rows = useMemo(
    () => (level ? level.subjects.map((c) => ({ c, s: lk.subjects.find((x) => x.catalogue === c.key) })).filter((r) => r.s && (r.s.live || me.test_student)) : []),
    [level, lk.subjects, me.test_student],
  );
  const sessions = board ? upcomingSessions(board.id) : [];
  const steps = ['Exam board', 'Level', 'Subjects', 'Exams', 'Time'];

  async function save() {
    setBusy(true);
    try {
      await api.selfSetup({ board: board.name, level: level.name, subjects: picked, examDate: exam.date, examLabel: exam.label, hours });
      lk.reload(); // their subjects changed
      await app.refreshMe();
      toast({ title: 'Your plan is ready', body: again ? 'Here’s what to do this week.' : 'One more thing: a quick starting check.' });
      go(again ? '/' : '/check');
    } catch (e) {
      toast({ title: 'Couldn’t save that', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page eyebrow={again ? 'Change my plan' : 'Welcome to StudyBridge'} title={again ? 'Your subjects and exams' : 'Let’s set up your plan'} subtitle="A few quick questions. You can change them any time.">
      <ol className="setup-steps" aria-label="Steps">
        {steps.map((t, i) => (
          <li key={t} className={i === step ? 'now' : i < step ? 'done' : ''}>
            {t}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="card stack">
          <h2>Which exam board?</h2>
          <div className="pick-grid">
            {boards.map((b) => (
              <button key={b.id} className={'pick' + (b.id === boardId ? ' on' : '')} onClick={() => (setBoardId(b.id), setLevelId(''), setPicked([]), setExam({ date: '', label: '' }), setStep(b.id === 'ib' ? 2 : 1))}>
                <b>{b.name}</b>
                <span>{b.levels.filter((l) => hasOpen(l.subjects)).map((l) => l.name).join(' · ')}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 1 && board && (
        <div className="card stack">
          <h2>Which level?</h2>
          <div className="pick-grid">
            {levels.map((l) => (
              <button key={l.id} className={'pick' + (l.id === levelId ? ' on' : '')} onClick={() => (setLevelId(l.id), setPicked([]), setStep(2))}>
                <b>{l.name}</b>
                <span>
                  {l.subjects.filter((c) => open.has(c.key)).length} subject{l.subjects.filter((c) => open.has(c.key)).length === 1 ? '' : 's'}
                </span>
              </button>
            ))}
          </div>
          <button className="btn ghost" onClick={() => setStep(0)}>
            <Icon name="left" size={18} /> Back
          </button>
        </div>
      )}

      {step === 2 && level && (
        <div className="card stack">
          <h2>Your subjects</h2>
          <div className="muted small">Pick every subject you’re taking.</div>
          <div className="chips-pick">
            {rows.map(({ c, s }) => {
              const on = picked.includes(s.id);
              return (
                <button
                  key={c.key}
                  className={'chip-pick' + (on ? ' on' : '')}
                  aria-pressed={on}
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                >
                  {on && <Icon name="check" size={14} />}
                  {c.subject}
                  {c.code && <small>{c.code}</small>}
                  {!s.live && <small>not open yet</small>}
                </button>
              );
            })}
          </div>
          <div className="row between">
            <button className="btn ghost" onClick={() => setStep(board.id === 'ib' ? 0 : 1)}>
              <Icon name="left" size={18} /> Back
            </button>
            <button className="btn primary" disabled={!picked.length} onClick={() => setStep(3)}>
              Next <Icon name="right" size={18} />
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card stack">
          <h2>When are your exams?</h2>
          <div className="pick-grid">
            {sessions.map((x) => (
              <button key={x.date} className={'pick' + (exam.date === x.date && !other ? ' on' : '')} onClick={() => (setOther(false), setExam({ date: x.date, label: `${board.name} ${x.label}` }))}>
                <b>{x.label}</b>
                <span>{Math.max(1, Math.round((at(x.date) - new Date()) / (7 * 864e5)))} weeks away</span>
              </button>
            ))}
            <button className={'pick' + (other ? ' on' : '')} onClick={() => (setOther(true), setExam({ date: '', label: '' }))}>
              <b>Another date</b>
              <span>Type your first exam’s date</span>
            </button>
          </div>
          {other && (
            <label className="stack sm small">
              Your first exam
              <input className="input" type="date" min={today()} value={exam.date} onChange={(e) => setExam({ date: e.target.value, label: '' })} aria-label="Your first exam" />
            </label>
          )}
          <div className="row between">
            <button className="btn ghost" onClick={() => setStep(2)}>
              <Icon name="left" size={18} /> Back
            </button>
            <button className="btn primary" disabled={!exam.date || exam.date <= today()} onClick={() => setStep(4)}>
              Next <Icon name="right" size={18} />
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="card stack">
          <h2>How much time a week?</h2>
          <div className="muted small">Be honest: a plan you can keep beats a plan you can’t. You can change it later.</div>
          <div className="seg" role="group" aria-label="Hours a week">
            {HOURS.map((h) => (
              <button key={h} type="button" aria-pressed={hours === h} onClick={() => setHours(h)}>
                {h === 10 ? '10+ hours' : `${h} hours`}
              </button>
            ))}
          </div>
          <div className="small muted">That’s about {Math.round((hours * 60) / 7)} minutes a day.</div>
          <div className="row between">
            <button className="btn ghost" onClick={() => setStep(3)}>
              <Icon name="left" size={18} /> Back
            </button>
            <button className="btn primary" disabled={busy} onClick={save}>
              {busy ? 'Making your plan…' : 'Make my plan'}
            </button>
          </div>
        </div>
      )}
    </Page>
  );
}

// Weeks to the exams and, for each subject, what this week is for: topics spread over the weeks, with the last
// part kept for practice papers and a mock (the same plain maths as tutors' teaching plans)
export function SelfPlan() {
  const app = useApp();
  const lk = useLookups();
  const me = app.me;
  const topics = useQuery(me?.self_learner ? 'my-topics' : null, api.myTopics).data || [];
  const checks = useQuery(me?.self_learner ? 'starting-checks' : null, api.myStartingChecks).data || {};
  if (!me?.self_learner || !me.exam_date) return null;
  // after the starting check: the topics that need the most work, first
  const workOn = (sid) =>
    checks[sid]?.done ? topics.filter((x) => x.subject_id === sid && (x.strength === 'weak' || x.strength === 'developing')).sort((x, y) => (x.ratio ?? 1) - (y.ratio ?? 1)).slice(0, 4) : [];
  const t = today();
  const weeks = Math.max(0, Math.ceil((at(me.exam_date) - at(t)) / (7 * 864e5)));
  const start = me.plan_start && me.plan_start <= t ? me.plan_start : t;
  // only the subjects they chose (never the whole catalogue, even for a moment while it loads)
  const mine = lk.subjects.filter((s) => lk.learnerSubjects.some((k) => k.subject_id === s.id && k.learner_id === me.id));
  const rows = mine.map((s) => {
    const topics = lk.topicsOf(s.id);
    if (!topics.length) return { s, text: 'Your plan for this subject appears here once its topics are set.' };
    const items = spreadEvenly(topics, 'week', start, me.exam_date);
    const i = items.findIndex((x) => x.starts_on <= t && t <= x.ends_on);
    if (i >= 0) return { s, week: `Week ${i + 1} of ${items.length}`, text: items[i].topics.join(' · '), topic: items[i].topics[0], pct: ((i + 1) / items.length) * 100 };
    if (items.length && t > items[items.length - 1].ends_on) return { s, week: 'Revision', text: 'Practice papers and a full mock, then go over what went wrong.', pct: 100 };
    return { s, week: 'Starting', text: items[0]?.topics.join(' · ') || '', topic: items[0]?.topics[0], pct: 0 };
  });
  return (
    <div className="card self-plan">
      <div className="card-head">
        <div>
          <h2>Your plan</h2>
          <div className="small muted">
            {me.exam_label || `Exams from ${fmt(me.exam_date, { year: 'numeric' })}`} · about {me.study_goal_min || 30} minutes a day
          </div>
        </div>
        <div className="weeks-left">
          <b>{weeks}</b>
          <span>week{weeks === 1 ? '' : 's'} to go</span>
        </div>
      </div>
      <div className="list">
        {rows.map((r) => (
          <div key={r.s.id} className="item plan-row">
            <span className="swatch" style={{ background: r.s.color || '#0E6B6B' }} />
            <span className="grow">
              <span className="name">{r.s.name}</span>
              <span className="meta">
                {r.week && <b>{r.week}</b>} {r.text}
              </span>
              {r.pct != null && (
                <span className="plan-bar" aria-hidden="true">
                  <i style={{ width: `${r.pct}%` }} />
                </span>
              )}
              {workOn(r.s.id).length > 0 && (
                <span className="meta work-on">
                  <b>Work on first:</b>{' '}
                  {workOn(r.s.id).map((x, i) => (
                    <span key={x.id}>
                      {i > 0 && ' · '}
                      <Link to={`/study?subject=${r.s.id}&topic=${encodeURIComponent(x.name)}`}>{x.name}</Link>
                    </span>
                  ))}
                </span>
              )}
            </span>
            {r.topic && (
              <Link to={`/study?subject=${r.s.id}&topic=${encodeURIComponent(r.topic)}`} className="btn sm" aria-label={`Practise ${r.topic}`}>
                Practise
              </Link>
            )}
          </div>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <Link to="/study" className="btn sm primary">
          <Icon name="flame" size={16} /> Study now
        </Link>
        <Link to="/setup" className="btn sm ghost">
          Change subjects or exams
        </Link>
      </div>
    </div>
  );
}

// The starting check (about 12 questions per subject, auto-marked, no time limit): what they already know, so the plan
// can say what to work on first. Offered once after the setup (/check) and on Today until done or skipped.
const skipKey = (sid) => `sb.checkSkip.${sid}`;
const skipped = (sid) => {
  try {
    return localStorage.getItem(skipKey(sid)) === '1';
  } catch {
    return false;
  }
};

function useCheckable() {
  const lk = useLookups();
  const app = useApp();
  const practice = useQuery('practice-topics', api.practiceTopics).data;
  const checks = useQuery('starting-checks', api.myStartingChecks);
  const mine = lk.subjects.filter((s) => lk.learnerSubjects.some((k) => k.subject_id === s.id && k.learner_id === app.me.id));
  // only subjects with practice questions can have a check
  const ready = mine.filter((s) => (practice || []).some((p) => p.subject_id === s.id));
  return { ready, checks: checks.data || {}, loading: !practice || !checks.data };
}

async function startCheckFor(subjectId, toast) {
  try {
    const r = await api.startCheck(subjectId);
    const t = await api.startAttempt(r.assignment_id);
    go(`/attempt/${t.id}`);
  } catch (e) {
    toast({ title: 'Couldn’t start the check', body: e.message, tone: 'bad' });
  }
}

export function StartingCheck() {
  const toast = useToast();
  const { ready, checks, loading } = useCheckable();
  const [busy, setBusy] = useState('');
  // no questions for their subjects yet: nothing to check, straight to the plan
  useEffect(() => {
    if (!loading && !ready.length) go('/', { replace: true });
  }, [loading, ready.length]);
  return (
    <Page eyebrow="One more thing" title="A quick starting check" subtitle="About 12 questions for each subject, from different topics. No time limit and nothing to revise first: just do what you can.">
      <div className="card stack">
        <p className="muted">It shows what you already know, so your plan can tell you which topics to work on first. It takes about 15 minutes a subject.</p>
        {loading && <div className="muted small">One moment…</div>}
        {!loading && !ready.length && <div className="note small">There aren’t questions for your subjects yet, so there’s no check to take. Your plan is ready.</div>}
        <div className="list">
          {ready.map((s) => {
            const c = checks[s.id];
            return (
              <div key={s.id} className="item">
                <span className="swatch" style={{ background: s.color || '#0E6B6B' }} />
                <span className="grow">
                  <span className="name">{s.name}</span>
                  <span className="meta">{c?.done ? `Done: ${c.score ?? 0} out of ${c.max ?? 0}` : c ? 'Started' : 'Not taken yet'}</span>
                </span>
                {c?.done ? (
                  <Link to={`/results/${c.attempt_id}`} className="btn sm">
                    See how it went
                  </Link>
                ) : (
                  <button
                    className="btn sm primary"
                    disabled={!!busy}
                    onClick={async () => {
                      setBusy(s.id);
                      await startCheckFor(s.id, toast);
                      setBusy('');
                    }}
                  >
                    {busy === s.id ? 'Opening…' : c ? 'Carry on' : 'Start the check'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div>
          <button
            className="btn ghost"
            onClick={() => {
              for (const s of ready) if (!checks[s.id]?.done) try { localStorage.setItem(skipKey(s.id), '1'); } catch {}
              go('/');
            }}
          >
            Skip for now
          </button>
        </div>
      </div>
    </Page>
  );
}

// On Today: subjects whose starting check isn't done (and wasn't skipped)
export function CheckNudge() {
  const app = useApp();
  const toast = useToast();
  const { ready, checks } = useCheckable();
  const [, setTick] = useState(0);
  if (!app.me?.self_learner) return null;
  const todo = ready.filter((s) => !checks[s.id]?.done && !skipped(s.id));
  if (!todo.length) return null;
  return (
    <div className="card row wrap check-nudge">
      <Icon name="target" style={{ color: 'var(--accent)' }} />
      <span className="grow">
        <b>Take your starting check</b>
        <span className="small muted" style={{ display: 'block' }}>
          About 15 minutes for {todo.map((s) => s.name).join(', ')}. Your plan then shows what to work on first.
        </span>
      </span>
      <button className="btn sm primary" onClick={() => (todo.length === 1 ? startCheckFor(todo[0].id, toast) : go('/check'))}>
        Start
      </button>
      <button
        className="btn sm ghost"
        onClick={() => {
          for (const s of todo) try { localStorage.setItem(skipKey(s.id), '1'); } catch {}
          setTick((x) => x + 1);
        }}
      >
        Not now
      </button>
    </div>
  );
}

// A small line on Today during the free week
export function TrialNote() {
  const app = useApp();
  const a = studentAccess(app.me);
  if (!a.trial) return null;
  return (
    <div className="note small">
      <b>Free trial:</b> {a.daysLeft} day{a.daysLeft === 1 ? '' : 's'} left. Then it’s ${PRICE.month} a month, or an exam pass that lasts until your exams.{' '}
      <Link to="/settings?s=plan">How to pay</Link>
    </div>
  );
}

// The free week is over and nothing's paid: everything is kept; they can see Progress and Settings
export function TrialOver() {
  const app = useApp();
  return (
    <Page title="Your free week is over" subtitle="Everything you’ve done is saved: your plan, your progress and your work.">
      <div className="card stack">
        <h2>Keep going</h2>
        <p className="muted">
          It’s ${PRICE.month} a month, or an exam pass at ${PRICE.passMonth} a month paid once, which lasts until your exams{app.me.exam_label ? ` (${app.me.exam_label})` : ''}.
        </p>
        <PayOptions />
        <div>
          <button className="btn ghost" onClick={() => go('/progress')}>
            See my progress
          </button>
        </div>
      </div>
    </Page>
  );
}

const PRICE = site.selfLearner;

// Whole months from today to the exams (at least 1): what an exam pass covers
export function monthsToExams(examDate, now = new Date()) {
  if (!examDate) return PRICE.exampleMonths;
  const days = (new Date(String(examDate).slice(0, 10) + 'T12:00') - now) / 864e5;
  return Math.max(1, Math.ceil(days / 30.44));
}

// Pay by card (the Owner's Stripe links), mobile money (Flutterwave), or another way through Contact StudyBridge.
// A parent pays for their child the same way (forId: the child's account, so the payment is matched to them).
export function PayOptions({ forId = null, examDate = undefined, otherWay = null }) {
  const app = useApp();
  const links = useQuery('pay-links', api.studentPayLinks).data || {};
  const months = monthsToExams(examDate === undefined ? app.me.exam_date : examDate);
  // the account's id goes with the payment so the Owner can match it (nothing personal goes in the link);
  // the desktop app opens it in the browser
  const open = (url) => window.open(`${url}${url.includes('?') ? '&' : '?'}client_reference_id=${forId || app.me.id}`, '_blank');
  const pub = useQuery('public-settings', api.publicSettings).data || {};
  const card = links.monthly || links.pass || pub.mobile_on;
  return (
    <div className="stack sm">
      <div className="row wrap" style={{ gap: 8 }}>
        {links.monthly && (
          <button className="btn primary" onClick={() => open(links.monthly)}>
            Pay ${PRICE.month} a month by card
          </button>
        )}
        {links.pass && (
          <button className="btn" onClick={() => open(links.pass)}>
            Exam pass by card: ${PRICE.passMonth * months} for {months} month{months === 1 ? '' : 's'}
          </button>
        )}
        <MobileMoney what="monthly" label={`$${PRICE.month} a month with mobile money`} months={1} usdFor={() => PRICE.month} forId={forId} />
        <MobileMoney what="pass" label={`Exam pass with mobile money: $${PRICE.passMonth * months}`} months={months} usdFor={(m) => PRICE.passMonth * m} forId={forId} />
        <button className={'btn' + (card ? ' ghost' : ' primary')} onClick={() => (otherWay ? otherWay() : go('/settings?s=contact'))}>
          <Icon name="message" size={18} /> {card ? 'Pay another way' : 'Ask about paying'}
        </button>
      </div>
      {links.pass && <div className="small muted">For the exam pass, set the quantity to {months} on the card page: one for each month until your exams.</div>}
      {(links.monthly || links.pass) && <div className="small muted">Use the email you signed up with. Your account switches over as soon as the payment comes through.</div>}
    </div>
  );
}

// A hint written with the question (no AI): hidden until the student asks for it
export function Hint({ md }) {
  const [show, setShow] = useState(false);
  if (!md) return null;
  return show ? (
    <div className="note small hint">
      <b>Hint</b>
      <Markdown src={md} />
    </div>
  ) : (
    <div>
      <button type="button" className="linkbtn small" onClick={() => setShow(true)}>
        <Icon name="spark" size={14} /> Show a hint
      </button>
    </div>
  );
}

// "Report a problem" on StudyBridge's own questions, lessons and flashcards. It stays up; the Owner is told.
export function ReportProblem({ kind, id, label = 'Report a problem' }) {
  const app = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  if (!app.me?.self_learner || !id) return null;
  async function send() {
    setBusy(true);
    try {
      await api.reportContent(kind, id, msg.trim());
      toast({ title: 'Thanks for telling us', body: 'StudyBridge will look at it and reply in your notifications.' });
      setOpen(false);
      setMsg('');
    } catch (e) {
      toast({ title: 'Couldn’t send it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className="linkbtn small report-btn" onClick={() => setOpen(true)}>
        <Icon name="flag" size={14} /> {label}
      </button>
      {open && (
        <Modal
          title="Report a problem"
          onClose={() => setOpen(false)}
          foot={
            <>
              <button className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy || msg.trim().length < 2} onClick={send}>
                {busy ? 'Sending…' : 'Send'}
              </button>
            </>
          }
        >
          <div className="stack sm">
            <div className="muted small">What’s wrong? For example a wrong answer, a typo, or something that doesn’t make sense. StudyBridge reads every report.</div>
            <textarea className="textarea" autoFocus value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={2000} aria-label="What’s wrong" />
          </div>
        </Modal>
      )}
    </>
  );
}
