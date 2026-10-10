// Students on their own (launch 1): the guided setup, their plan on Today, what they see when the free week ends,
// paying, hints, and reporting a problem with StudyBridge's own content
import { useMemo, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Link, Markdown, Modal, Page, go, useToast } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import site from '../../../website/site.config.json';
import { BOARDS, upcomingSessions } from '../../lib/catalogue.js';
import { spreadEvenly, today, at, fmt } from '../../lib/plan.js';
import { studentAccess } from '../../lib/students.js';
import { useLookups } from '../shared/lookups.jsx';

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

  const board = BOARDS.find((b) => b.id === boardId);
  // IB students choose from the Diploma subjects and the core together
  const levels = board ? (board.id === 'ib' ? [{ id: 'ib:all', name: 'IB Diploma', subjects: board.levels.flatMap((l) => l.subjects) }] : board.levels) : [];
  const level = levels.find((l) => l.id === levelId) || (levels.length === 1 ? levels[0] : null);
  // the catalogue entries, matched to the content account's subjects (only open ones can be chosen)
  const rows = useMemo(
    () => (level ? level.subjects.map((c) => ({ c, s: lk.subjects.find((x) => x.catalogue === c.key) })).sort((a, b) => !!b.s?.live - !!a.s?.live) : []),
    [level, lk.subjects],
  );
  const sessions = board ? upcomingSessions(board.id) : [];
  const steps = ['Exam board', 'Level', 'Subjects', 'Exams', 'Time'];

  async function save() {
    setBusy(true);
    try {
      await api.selfSetup({ board: board.name, level: level.name, subjects: picked, examDate: exam.date, examLabel: exam.label, hours });
      lk.reload(); // their subjects changed
      await app.refreshMe();
      toast({ title: 'Your plan is ready', body: 'Here’s what to do this week.' });
      go('/');
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
            {BOARDS.map((b) => (
              <button key={b.id} className={'pick' + (b.id === boardId ? ' on' : '')} onClick={() => (setBoardId(b.id), setLevelId(''), setPicked([]), setExam({ date: '', label: '' }), setStep(b.id === 'ib' ? 2 : 1))}>
                <b>{b.name}</b>
                <span>{b.levels.map((l) => l.name).join(' · ')}</span>
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
                <span>{l.subjects.length} subjects</span>
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
          <div className="muted small">Pick every subject you’re taking. New subjects open one by one; the rest say “coming soon”.</div>
          {!rows.some((r) => r.s?.live) && <Empty>None of these are open yet. We’re adding subjects one by one, so check back soon.</Empty>}
          <div className="chips-pick">
            {rows.map(({ c, s }) => {
              const open = !!s?.live;
              const on = open && picked.includes(s.id);
              return (
                <button
                  key={c.key}
                  className={'chip-pick' + (on ? ' on' : '') + (open ? '' : ' soon')}
                  disabled={!open}
                  aria-pressed={on}
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                >
                  {on && <Icon name="check" size={14} />}
                  {c.subject}
                  {c.code && <small>{c.code}</small>}
                  {!open && <small>coming soon</small>}
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
  if (!me?.self_learner || !me.exam_date) return null;
  const t = today();
  const weeks = Math.max(0, Math.ceil((at(me.exam_date) - at(t)) / (7 * 864e5)));
  const start = me.plan_start && me.plan_start <= t ? me.plan_start : t;
  // only the subjects they chose (never the whole catalogue, even for a moment while it loads)
  const mine = lk.subjects.filter((s) => lk.learnerSubjects.some((k) => k.subject_id === s.id && k.learner_id === me.id));
  const rows = mine.map((s) => {
    const topics = lk.topicsOf(s.id);
    if (!topics.length) return { s, text: 'The syllabus for this subject is being added.', soon: true };
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

// Pay by card (the Owner's Stripe links), or another way through Contact StudyBridge. The Owner marks it paid.
export function PayOptions() {
  const app = useApp();
  const links = useQuery('pay-links', api.studentPayLinks).data || {};
  const months = monthsToExams(app.me.exam_date);
  // the account's id goes with the payment so the Owner can match it (nothing personal goes in the link);
  // the desktop app opens it in the browser
  const open = (url) => window.open(`${url}${url.includes('?') ? '&' : '?'}client_reference_id=${app.me.id}`, '_blank');
  const card = links.monthly || links.pass;
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
        <button className={'btn' + (card ? ' ghost' : ' primary')} onClick={() => go('/settings?s=contact')}>
          <Icon name="message" size={18} /> {card ? 'Pay another way' : 'Ask about paying'}
        </button>
      </div>
      {links.pass && <div className="small muted">For the exam pass, set the quantity to {months} on the card page: one for each month until your exams.</div>}
      {card && <div className="small muted">Use the email you signed up with. We switch your account over once the payment comes through, usually within a day.</div>}
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
