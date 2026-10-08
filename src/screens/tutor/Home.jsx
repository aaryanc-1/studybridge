import { useMemo, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Link, Page, go } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, dur, due, when, kindLabel, weekRange, ymd } from '../../lib/format.js';
import { useLookups } from '../shared/lookups.jsx';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const app = useApp();
  const lk = useLookups();
  const attempts = useQuery('attempts', api.listAttempts).data || [];
  const assignments = useQuery('assignments', api.listAssignments).data || [];
  const comments = useQuery('comments', api.listComments).data || [];
  const sessions = useQuery('sessions', api.listSessions).data || [];
  const activity = useQuery('activity', api.listActivity).data || [];
  const files = useQuery('files', api.listFiles).data || [];
  const profJobs = useQuery('prof-jobs', api.profJobs).data || [];

  const aById = useMemo(() => Object.fromEntries(assignments.map((a) => [a.id, a])), [assignments]);
  const toMark = attempts.filter((a) => a.status === 'submitted');
  const liveNow = attempts.filter((t) => t.status === 'in_progress' && aById[t.assignment_id]?.camera);
  const notes = comments.filter((c) => c.author_id !== app.me.id && !c.read_at).slice(-6).reverse();
  const { from } = weekRange(0);
  const weekStr = ymd(from);
  const weekSeconds = (lid) => activity.filter((x) => (!lid || x.learner_id === lid) && x.day >= weekStr).reduce((s, x) => s + x.seconds, 0);
  // Due in the next week, for the learners it's set for; work everyone has already handed in drops off
  const forWhom = (a) =>
    a.learner_ids?.length
      ? a.learner_ids
      : a.subject_id
        ? lk.learnerSubjects.filter((x) => x.subject_id === a.subject_id).map((x) => x.learner_id)
        : lk.learners.map((l) => l.id);
  const handedIn = (a, lid) => attempts.some((t) => t.assignment_id === a.id && t.learner_id === lid && t.status !== 'in_progress');
  const soon = assignments
    .filter((a) => !a.draft && a.due_at && new Date(a.due_at) > new Date() && new Date(a.due_at) < new Date(Date.now() + 8 * 86400000))
    .map((a) => {
      const who = forWhom(a);
      return { ...a, who: who.length, done: who.filter((lid) => handedIn(a, lid)).length };
    })
    .filter((a) => !a.who || a.done < a.who)
    .sort((x, y) => new Date(x.due_at) - new Date(y.due_at));
  const upcoming = sessions.filter((s) => new Date(s.starts_at).getTime() + s.duration_min * 60000 > Date.now()).slice(0, 4);

  // Getting started: each step says why it matters and goes straight to the right place
  const work = assignments.filter((a) => !a.draft && a.source !== 'self');
  const setup = [
    { done: lk.subjects.length > 0, label: 'Add a subject', sub: 'e.g. Mathematics. Everything (work, papers, progress) is filed under it.', to: '/structure' },
    {
      done: lk.subjects.length > 0 && lk.subjects.every((x) => x.exam),
      label: 'Say which exam it’s for',
      sub: 'e.g. Cambridge IGCSE 0607. Past papers and practice papers then show up for it.',
      to: '/library/papers',
    },
    { done: lk.topics.length > 0, label: 'Set out the syllabus', sub: 'Prof can do it in a minute. The topics drive progress and the coverage map.', to: '/library/syllabus' },
    { done: lk.learners.length > 0, label: 'Invite your first learner', sub: 'They get a code to join on their computer or phone.', to: '/learners' },
    { done: work.length > 0, label: 'Give them their first work', sub: 'A quiz, homework or a past paper. Quizzes mark themselves.', to: '/assignments' },
    { done: profJobs.length > 0, label: 'Ask Prof for something', sub: 'A quiz on a topic, flashcards, or marking. You approve everything first.', to: '/prof' },
    { done: sessions.length > 0, label: 'Book a live lesson', sub: 'Video and whiteboard in the app; it goes in your calendar too.', to: '/live' },
  ];
  const setupLeft = setup.filter((s) => !s.done).length;
  const [hideSetup, setHideSetup] = useState(() => {
    try {
      return localStorage.getItem('sb.setupHidden') === '1';
    } catch {
      return false;
    }
  });
  const next = setup.find((s) => !s.done);

  return (
    <Page eyebrow={new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} title={`${greeting()}, ${app.me.display_name.split(' ')[0]}`}>
      <div className="kpi">
        <Kpi n={toMark.length} l="Ready to mark" to="/marking" />
        <Kpi n={notes.length} l="New notes" to="/messages" />
        <Kpi n={soon.length} l="Due in the next week" to="/assignments" />
        <Kpi n={dur(weekSeconds())} l={lk.learners.length === 1 ? `${lk.learners[0].display_name.split(' ')[0]} studied this week` : 'Your learners studied this week'} to={lk.learners.length === 1 ? `/learners/${lk.learners[0].id}` : '/learners'} />
      </div>

      {setupLeft > 0 && !hideSetup && (
        <div className="card tint setup">
          <div className="card-head">
            <h2>Get StudyBridge ready</h2>
            <span className="row small muted" style={{ gap: 10 }}>
              {setup.length - setupLeft} of {setup.length} done
              <button
                className="linkbtn small"
                onClick={() => {
                  setHideSetup(true);
                  try {
                    localStorage.setItem('sb.setupHidden', '1');
                  } catch {
                    /* fine */
                  }
                }}
              >
                Hide
              </button>
            </span>
          </div>
          <div className="setup-bar" aria-hidden="true">
            <span style={{ width: `${(100 * (setup.length - setupLeft)) / setup.length}%` }} />
          </div>
          <div className="list">
            {setup.map((s) => (
              <Link key={s.label} to={s.to} className={'item' + (s === next ? ' next' : '')}>
                <Icon name={s.done ? 'checkCircle' : 'circle'} style={{ color: s.done ? 'var(--good)' : s === next ? 'var(--accent)' : 'var(--muted)' }} />
                <span className="grow">
                  <span className="name" style={{ textDecoration: s.done ? 'line-through' : 'none', color: s.done ? 'var(--muted)' : undefined }}>
                    {s.label}
                  </span>
                  {!s.done && <span className="meta">{s.sub}</span>}
                </span>
                {s === next ? <span className="btn sm primary">Start</span> : <Icon name="right" size={18} />}
              </Link>
            ))}
          </div>
        </div>
      )}

      {liveNow.length > 0 && (
        <div className="card warn">
          <div className="card-head">
            <h2 className="row">
              <span className="dot live" /> Working now with camera on
            </h2>
          </div>
          <div className="list">
            {liveNow.map((t) => (
              <Link key={t.id} to={`/watch/${t.id}`} className="item">
                <Avatar person={lk.learner(t.learner_id)} size="sm" />
                <span className="grow">
                  <span className="name">
                    {lk.learner(t.learner_id)?.display_name} · {aById[t.assignment_id]?.title}
                  </span>
                  <span className="meta">Started {ago(t.started_at)}</span>
                </span>
                <span className="btn sm primary">Watch</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="split">
        <div className="stack lg">
          <div className="card">
            <div className="card-head">
              <h2>Ready to mark</h2>
              <Link to="/marking" className="small">
                All marking
              </Link>
            </div>
            {toMark.length === 0 ? (
              <Empty>Nothing waiting. Submissions appear here the moment they come in.</Empty>
            ) : (
              <div className="list">
                {toMark.slice(0, 6).map((t) => {
                  const a = aById[t.assignment_id];
                  const late = a?.due_at && t.submitted_at && new Date(t.submitted_at) > new Date(a.due_at);
                  return (
                    <Link key={t.id} to={`/marking/${t.id}`} className="item">
                      <Avatar person={lk.learner(t.learner_id)} size="sm" />
                      <span className="grow">
                        <span className="name">{a?.title || 'Assignment'}</span>
                        <span className="meta">
                          {lk.learner(t.learner_id)?.display_name} · {kindLabel[a?.kind]} · submitted {ago(t.submitted_at)}
                          {late && <span className="pill bad">Late</span>}
                          {(t.lockdown_events || []).length > 0 && <span className="pill warn">{t.lockdown_events.length} lockdown alert{t.lockdown_events.length > 1 ? 's' : ''}</span>}
                        </span>
                      </span>
                      <Icon name="right" size={18} />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Learners this week</h2>
              <Link to="/learners" className="small">
                All learners
              </Link>
            </div>
            {lk.learners.length === 0 ? (
              <Empty action={<button className="btn primary" onClick={() => go('/learners')}><Icon name="plus" size={18} /> Invite a learner</button>}>
                No learners yet.
              </Empty>
            ) : (
              <div className="list">
                {lk.learners.map((l) => {
                  const open = attempts.filter((t) => t.learner_id === l.id && t.status === 'in_progress').length;
                  return (
                    <Link key={l.id} to={`/learners/${l.id}`} className="item">
                      <Avatar person={l} />
                      <span className="grow">
                        <span className="name">{l.display_name}</span>
                        <span className="meta">
                          {dur(weekSeconds(l.id))} studied this week
                          {open > 0 && <span className="pill accent">{open} in progress</span>}
                        </span>
                      </span>
                      <Icon name="right" size={18} />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="stack lg">
          <div className="card">
            <div className="card-head">
              <h2>New notes</h2>
              <Link to="/messages" className="small">
                Messages
              </Link>
            </div>
            {notes.length === 0 ? (
              <div className="muted small">No new notes from learners.</div>
            ) : (
              <div className="list">
                {notes.map((c) => (
                  <Link key={c.id} to={`/messages/${c.learner_id}`} className="item">
                    <Avatar person={lk.learner(c.learner_id)} size="sm" />
                    <span className="grow">
                      <span className="name">{lk.learner(c.learner_id)?.display_name}{c.assignment_id && aById[c.assignment_id] ? ` · ${aById[c.assignment_id].title}` : ''}</span>
                      <span className="meta ellipsis" style={{ display: 'block' }}>{c.body}</span>
                    </span>
                    <span className="tiny muted">{ago(c.created_at)}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
          <div className="card">
            <h2>Coming up</h2>
            {soon.length === 0 && upcoming.length === 0 && <div className="muted small">Nothing due in the next week.</div>}
            <div className="list">
              {upcoming.map((s) => (
                <Link key={s.id} to={`/live/${s.id}`} className="item">
                  <Icon name="video" style={{ color: 'var(--accent)' }} />
                  <span className="grow">
                    <span className="name">{s.title}</span>
                    <span className="meta">Live · {when(s.starts_at)}</span>
                  </span>
                </Link>
              ))}
              {soon.map((a) => (
                <Link key={a.id} to={`/assignments/${a.id}`} className="item">
                  <Icon name="clipboard" style={{ color: 'var(--muted)' }} />
                  <span className="grow">
                    <span className="name">{a.title}</span>
                    <span className="meta">
                      {due(a.due_at).text}
                      {a.who > 1 ? ` · ${a.done} of ${a.who} handed in` : ''}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}

function Kpi({ n, l, to }) {
  return (
    <Link to={to} className="stat" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="n">{n}</div>
      <div className="l">{l}</div>
    </Link>
  );
}
