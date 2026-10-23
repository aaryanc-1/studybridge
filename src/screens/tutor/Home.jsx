import { useMemo, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Link, Loading, Page, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, dur, kindLabel, myTimezone, placeOf, time, timeIn, weekRange, when, ymd } from '../../lib/format.js';
import { useLookups } from '../shared/lookups.jsx';
import { useDiscardDraft } from './ClaudeInbox.jsx';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const from = (src) => (src === 'prof' ? 'Prof' : src === 'claude' ? 'Claude Desktop' : 'you');
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const DAY = 86400000;
// the date somewhere else (to say "Sat 02:00" only when it's another day there)
const dateIn = (d, tz) => {
  try {
    return new Date(d).toLocaleDateString('en-CA', { timeZone: tz || undefined });
  } catch {
    return '';
  }
};
// "Today", "Tomorrow" or "Fri"
const dayWord = (d) => {
  const x = ymd(d);
  const now = new Date();
  if (x === ymd(now)) return 'Today';
  if (x === ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return 'Tomorrow';
  return new Date(d).toLocaleDateString(undefined, { weekday: 'short' });
};
const weekLabel = (w) => `Week of ${new Date(String(w).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;

export default function Home() {
  const app = useApp();
  const lk = useLookups();
  const toast = useToast();
  const confirm = useConfirm();
  const discard = useDiscardDraft();
  const attemptsQ = useQuery('attempts', api.listAttempts);
  const commentsQ = useQuery('comments', api.listComments);
  const draftsQ = useQuery('drafts', api.listDrafts);
  const attempts = attemptsQ.data || [];
  const comments = commentsQ.data || [];
  const drafts = draftsQ.data || [];
  const assignments = useQuery('assignments', api.listAssignments).data || [];
  const lessons = useQuery('lessons', api.listLessons).data || [];
  const sessions = useQuery('sessions', api.listSessions).data || [];
  const activity = useQuery('activity', api.listActivity).data || [];
  const profJobs = useQuery('prof-jobs', api.profJobs).data || [];
  const reportSettings = useQuery('learner-reports', api.listLearnerReports).data || [];
  const reports = useQuery('parent-reports', api.listParentReports).data || [];
  const parents = useQuery('parent-counts', api.myParentCounts).data || {};
  const liveStatus = useQuery('live-status', api.liveStatus).data;
  const home = useQuery('tutor-home', api.tutorHome).data;
  // a tuition centre's managers get a line about the whole centre
  const org = useQuery('org', api.myOrg).data;
  const manager = !!org && org.role === 'manager' && (org.kind === 'centre' || org.kind === 'school');
  const centre = useQuery(manager ? 'org-overview' : null, api.orgOverview).data;
  const [allNeeds, setAllNeeds] = useState(false);
  const [nudging, setNudging] = useState(null);

  const aById = useMemo(() => Object.fromEntries(assignments.map((a) => [a.id, a])), [assignments]);
  const firstName = (id) => (lk.learner(id)?.display_name || 'A learner').split(' ')[0];
  const myTz = myTimezone();
  const now = Date.now();

  // ---------- Needs you: everything waiting on the tutor, each with its button ----------
  const toMark = attempts.filter((t) => t.status === 'submitted');
  const markingDrafts = drafts.filter((d) => d.kind === 'marking');
  const profMarked = new Set(markingDrafts.map((d) => d.attempt_id));
  const liveNow = attempts.filter((t) => t.status === 'in_progress' && aById[t.assignment_id]?.camera);
  // unread notes, one row per learner (the newest note's text)
  const noteRows = [];
  for (const c of comments.filter((x) => x.author_id !== app.me.id && !x.read_at).reverse()) {
    const g = noteRows.find((x) => x.learner_id === c.learner_id);
    if (g) g.n++;
    else noteRows.push({ learner_id: c.learner_id, c, n: 1 });
  }
  // a finished week's parent report, for a learner with a parent or reports switched on (as on Reports)
  const monday = ymd(weekRange(0).from);
  const reportsOn = new Set([...reportSettings.filter((x) => x.enabled).map((x) => x.learner_id), ...Object.keys(parents).filter((k) => parents[k] > 0)]);
  const reportsReady = reports.filter((r) => r.status === 'draft' && String(r.week_start).slice(0, 10) < monday && reportsOn.has(r.learner_id));

  async function discardSuggestion(d) {
    if (d.kind !== 'note' && !(await confirm({ title: 'Discard this?', body: d.kind === 'message' ? 'It’s never sent.' : 'Nothing changes for your learner.', ok: 'Discard', danger: true }))) return;
    try {
      await api.discardDraft(d.id);
      invalidate('drafts');
      toast('Discarded');
    } catch (e) {
      toast({ title: 'Couldn’t discard it', body: e.message, tone: 'bad' });
    }
  }

  const needs = [
    ...liveNow.map((t) => ({
      key: 'w' + t.id,
      lead: <Avatar person={lk.learner(t.learner_id)} size="sm" />,
      name: `${firstName(t.learner_id)} is doing ${aById[t.assignment_id]?.title || 'an exam'}`,
      meta: (
        <>
          <span className="row" style={{ gap: 6 }}>
            <span className="dot live" /> Camera on
          </span>
          <span>Started {ago(t.started_at)}</span>
        </>
      ),
      acts: (
        <button className="btn sm primary" onClick={() => go(`/watch/${t.id}`)}>
          Watch
        </button>
      ),
    })),
    ...toMark.map((t) => {
      const a = aById[t.assignment_id];
      const late = a?.due_at && t.submitted_at && new Date(t.submitted_at) > new Date(a.due_at);
      const alerts = (t.lockdown_events || []).length;
      return {
        key: 'm' + t.id,
        lead: <Avatar person={lk.learner(t.learner_id)} size="sm" />,
        name: `${firstName(t.learner_id)} handed in ${a?.title || 'their work'}`,
        meta: (
          <>
            <span>
              {a?.practice ? 'Practice' : kindLabel[a?.kind] || 'Work'} · {ago(t.submitted_at)}
            </span>
            {late && <span className="pill bad">Late</span>}
            {alerts > 0 && <span className="pill warn">{plural(alerts, 'lockdown alert')}</span>}
            {profMarked.has(t.id) && <span className="pill claude">Prof’s marks ready</span>}
          </>
        ),
        acts: (
          <button className="btn sm primary" onClick={() => go(`/marking/${t.id}`)}>
            Mark
          </button>
        ),
      };
    }),
    ...noteRows.map(({ learner_id, c, n }) => {
      const on = c.assignment_id && aById[c.assignment_id];
      return {
        key: 'n' + learner_id,
        lead: <Avatar person={lk.learner(learner_id)} size="sm" />,
        name: `${firstName(learner_id)} left ${n === 1 ? 'a note' : `${n} notes`}${on ? ` on ${on.title}` : ''} · ${ago(c.created_at)}`,
        meta: <span className="home-note ellipsis">{c.body}</span>,
        acts: (
          <button className="btn sm" onClick={() => go(`/messages/${learner_id}`)}>
            Reply
          </button>
        ),
      };
    }),
    ...assignments
      .filter((a) => a.draft)
      .map((a) => {
        const who = lk.audience(a);
        const by = from(a.source);
        const kind = (kindLabel[a.kind] || 'Work').toLowerCase();
        return {
          key: 'a' + a.id,
          lead: <Icon name={a.source === 'prof' ? 'cap' : 'clipboard'} style={{ color: 'var(--claude)' }} />,
          name: by === 'you' ? `Draft ${kind}: ${a.title}` : `${by}’s ${kind}: ${a.title}`,
          meta: (
            <span>
              Ready for you to check{who.length > 0 && ` · for ${who.map((l) => l.display_name.split(' ')[0]).join(', ')}`} · {ago(a.created_at)}
            </span>
          ),
          acts: (
            <>
              <button className="btn sm ghost" onClick={() => discard('assignments', a)} aria-label={`Discard “${a.title}”`}>
                Discard
              </button>
              <button className="btn sm" onClick={() => go(`/assignments/${a.id}`)}>
                Review
              </button>
            </>
          ),
        };
      }),
    ...lessons
      .filter((l) => l.draft)
      .map((l) => {
        const by = from(l.source);
        return {
          key: 'l' + l.id,
          lead: <Icon name="book" style={{ color: 'var(--claude)' }} />,
          name: by === 'you' ? `Draft lesson notes: ${l.title}` : `${by}’s lesson notes: ${l.title}`,
          meta: <span>Ready for you to check · {ago(l.created_at)}</span>,
          acts: (
            <>
              <button className="btn sm ghost" onClick={() => discard('lessons', l)} aria-label={`Discard “${l.title}”`}>
                Discard
              </button>
              <button className="btn sm" onClick={() => go(`/lesson/${l.id}`)}>
                Review
              </button>
            </>
          ),
        };
      }),
    // Prof's suggestions (marking for work already in the list above shows there instead)
    ...drafts
      .filter((d) => !(d.kind === 'marking' && toMark.some((t) => t.id === d.attempt_id)))
      .map((d) => {
        const by = from(d.source);
        const t = d.kind === 'marking' && attempts.find((x) => x.id === d.attempt_id);
        const title = t && aById[t.assignment_id]?.title;
        const learner = d.learner_id || t?.learner_id;
        const name =
          d.kind === 'marking'
            ? `${by}’s marking${title ? `: ${title}` : ''}`
            : d.kind === 'message'
              ? `${by}’s message to ${firstName(learner)}`
              : `A note from ${by}`;
        return {
          key: 'd' + d.id,
          lead: <Icon name="spark" style={{ color: 'var(--claude)' }} />,
          name,
          meta: d.kind === 'marking' ? <span>For {firstName(learner)} · {ago(d.created_at)}</span> : <span className="home-note ellipsis">{d.payload?.body || d.summary || ''}</span>,
          acts: (
            <>
              <button className="btn sm ghost" onClick={() => discardSuggestion(d)} aria-label={`Discard ${name}`}>
                Discard
              </button>
              <button className="btn sm" onClick={() => go(d.kind === 'marking' && d.attempt_id ? `/marking/${d.attempt_id}` : '/prof')}>
                Review
              </button>
            </>
          ),
        };
      }),
    ...reportsReady.map((r) => ({
      key: 'r' + r.id,
      lead: <Icon name="send" style={{ color: 'var(--accent)' }} />,
      name: `Weekly report for ${firstName(r.learner_id)}`,
      meta: <span>{weekLabel(r.week_start)} · nothing reaches a parent until you approve it</span>,
      acts: (
        <button className="btn sm" onClick={() => go('/learners/reports')}>
          Approve
        </button>
      ),
    })),
  ];
  const needsReady = !!(attemptsQ.data && commentsQ.data && draftsQ.data);
  const shownNeeds = allNeeds ? needs : needs.slice(0, 8);

  // ---------- Today and this week: live lessons and due dates in the next 7 days ----------
  const weekEnd = now + 7 * DAY;
  // work everyone has already handed in drops off (an empty class's placeholder isn't a learner)
  const handedIn = (a, lid) => attempts.some((t) => t.assignment_id === a.id && t.learner_id === lid && t.status !== 'in_progress');
  const soon = assignments
    .filter((a) => !a.draft && a.visibility !== 'hidden' && a.source !== 'self' && a.due_at && new Date(a.due_at) > new Date(now) && new Date(a.due_at) < new Date(weekEnd))
    .map((a) => {
      const who = lk.audience(a).map((l) => l.id);
      return { ...a, who, done: who.filter((lid) => handedIn(a, lid)).length };
    })
    .filter((a) => !a.who.length || a.done < a.who.length);
  const lessonsSoon = sessions.filter((s) => new Date(s.starts_at).getTime() + s.duration_min * 60000 > now && new Date(s.starts_at).getTime() < weekEnd);
  const agenda = [...lessonsSoon.map((s) => ({ at: s.starts_at, s })), ...soon.map((a) => ({ at: a.due_at, a }))].sort((x, y) => new Date(x.at) - new Date(y.at));
  const lessonsToday = sessions.filter((s) => ymd(s.starts_at) === ymd(new Date(now))).length;

  // "Year 10 maths · Sat 02:00 in Lusaka": who it's for, and their time when their clock differs
  const lessonFor = (s) => {
    const ids = s.learner_ids || [];
    const c = s.class_id && lk.klass(s.class_id);
    const names = ids.map(firstName);
    const who = c ? c.name : names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    const zones = [...new Set(ids.map((id) => lk.learner(id)?.timezone).filter(Boolean))].filter((tz) => timeIn(s.starts_at, tz) !== timeIn(s.starts_at, myTz));
    const theirs = zones.map((tz) => `${timeIn(s.starts_at, tz, { weekday: dateIn(s.starts_at, tz) !== dateIn(s.starts_at, myTz) })} in ${placeOf(tz)}`);
    return [who, ...theirs].filter(Boolean).join(' · ');
  };
  const visibleNow = (a) => a.visibility === 'visible' || (a.visibility === 'scheduled' && (!a.visible_from || new Date(a.visible_from) <= new Date(now)));

  async function nudge(a) {
    setNudging(a.id);
    try {
      const n = await api.nudgeAssignment(a.id);
      invalidate('assignments');
      toast(n ? `Reminder sent to ${plural(n, 'learner')}` : 'Everyone has handed it in already');
    } catch (e) {
      toast({ title: 'Couldn’t send a reminder', body: e.message, tone: 'bad' });
    } finally {
      setNudging(null);
    }
  }

  // ---------- each learner's week: seconds per day, Monday to Sunday ----------
  const { from: monFrom } = weekRange(0);
  const days = Array.from({ length: 7 }, (_, i) => new Date(monFrom.getFullYear(), monFrom.getMonth(), monFrom.getDate() + i));
  const week = useMemo(() => {
    const keys = new Set(days.map(ymd));
    const out = {};
    for (const x of activity) {
      if (!keys.has(x.day)) continue;
      out[x.learner_id] = out[x.learner_id] || {};
      out[x.learner_id][x.day] = (out[x.learner_id][x.day] || 0) + x.seconds;
    }
    return out;
  }, [activity, monday]); // eslint-disable-line react-hooks/exhaustive-deps
  const facts = Object.fromEntries((home?.learners || []).map((x) => [x.id, x]));

  // ---------- getting started: each step says why it matters and goes straight to the right place ----------
  const work = assignments.filter((a) => !a.draft && a.source !== 'self');
  const setup = [
    { done: lk.subjects.length > 0, label: 'Add a subject', sub: 'e.g. Mathematics. Everything (work, papers, progress) is filed under it.', to: '/library/subjects' },
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

  // "2 lessons today · 4 things need you"
  const todayLine = needsReady
    ? `${lessonsToday ? `${plural(lessonsToday, 'lesson')} today` : 'No lessons today'} · ${needs.length ? `${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} you` : 'you’re all caught up'}`
    : undefined;
  const centreToMark = (centre?.tutors || []).reduce((s, t) => s + Number(t.to_mark || 0), 0);

  return (
    <Page eyebrow={new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} title={`${greeting()}, ${app.me.display_name.split(' ')[0]}`} subtitle={todayLine}>
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

      {manager && (
        <div className="card home-centre">
          <div className="stack sm">
            <h2>{centre?.name || org.name}</h2>
            {centre && (
              <div className="small muted">
                {plural(centre.tutors.length, 'tutor')} · {plural(centre.learners.length, 'learner')} · {centreToMark} waiting to be marked
              </div>
            )}
          </div>
          <button className="btn sm" onClick={() => go('/centre')}>
            <Icon name="chart" size={16} /> Open Centre
          </button>
        </div>
      )}

      <div className="split even">
        <section className="card">
          <h2>Needs you</h2>
          {!needsReady ? (
            <Loading />
          ) : needs.length === 0 ? (
            <div className="muted small">You’re all caught up. Work handed in, notes from learners and Prof’s drafts show up here.</div>
          ) : (
            <>
              <div className="list">
                {shownNeeds.map((n) => (
                  <div key={n.key} className="item home-row">
                    {n.lead}
                    <span className="grow">
                      <span className="name">{n.name}</span>
                      <span className="meta">{n.meta}</span>
                    </span>
                    <span className="home-acts">{n.acts}</span>
                  </div>
                ))}
              </div>
              {needs.length > shownNeeds.length && (
                <div>
                  <button className="linkbtn small" onClick={() => setAllNeeds(true)}>
                    Show all {needs.length}
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        <section className="card">
          <h2>Today and this week</h2>
          {agenda.length === 0 ? (
            <div className="muted small">No lessons or due dates in the next 7 days.</div>
          ) : (
            <div className="list">
              {agenda.map(({ at, s, a }) =>
                s ? (
                  <div key={'s' + s.id} className="item home-row">
                    <When d={at} />
                    <span className="grow">
                      <span className="name">{s.title || 'Live lesson'}</span>
                      <span className="meta">
                        {new Date(s.starts_at).getTime() <= now ? <span className="pill good">On now</span> : <span>Live lesson</span>}
                        <span>{lessonFor(s)}</span>
                      </span>
                    </span>
                    {new Date(s.starts_at).getTime() - 15 * 60000 < now && (
                      <span className="home-acts">
                        <button className="btn sm primary" disabled={liveStatus && !liveStatus.configured} onClick={() => go(`/live/${s.id}`)}>
                          Join
                        </button>
                      </span>
                    )}
                  </div>
                ) : (
                  <div key={'a' + a.id} className="item home-row">
                    <When d={at} />
                    <span className="grow">
                      <Link to={`/assignments/${a.id}`} className="name home-link">
                        {a.title}
                      </Link>
                      <span className="meta">
                        <span>{kindLabel[a.kind] || 'Work'} due</span>
                        {a.class_id && lk.klass(a.class_id) && <span>{lk.klass(a.class_id).name}</span>}
                        <span>
                          {!a.who.length
                            ? 'Nobody to hand it in yet'
                            : !visibleNow(a)
                              ? `Learners see it from ${when(a.visible_from)}`
                              : a.who.length === 1
                                ? 'Not handed in yet'
                                : `${a.done} of ${a.who.length} handed in`}
                        </span>
                        {a.nudged_at && <span>Reminded {ago(a.nudged_at)}</span>}
                      </span>
                    </span>
                    {a.who.length > 0 && visibleNow(a) && (
                      <span className="home-acts">
                        <button className="btn sm" disabled={nudging === a.id} onClick={() => nudge(a)} title="Remind everyone who hasn’t handed it in">
                          Nudge
                        </button>
                      </span>
                    )}
                  </div>
                ),
              )}
            </div>
          )}
        </section>
      </div>

      <section className="stack">
        <div className="card-head">
          <h2 className="home-h2">Your learners</h2>
          {lk.learners.length > 0 && (
            <Link to="/learners" className="small">
              All learners
            </Link>
          )}
        </div>
        {lk.learners.length === 0 ? (
          <Empty
            action={
              <button className="btn primary" onClick={() => go('/learners?invite=1')}>
                <Icon name="plus" size={18} /> Invite a learner
              </button>
            }
          >
            No learners yet.
          </Empty>
        ) : (
          <div className="home-learners">
            {lk.learners.map((l) => (
              <LearnerCard key={l.id} l={l} days={days} secs={week[l.id] || {}} f={facts[l.id]} loaded={!!home} />
            ))}
          </div>
        )}
      </section>

      <div className="home-quick" role="group" aria-label="Quick actions">
        <button className="btn" onClick={() => go('/assignments?new=1')}>
          <Icon name="clipboard" size={18} /> Set work
        </button>
        <button className="btn" onClick={() => go('/prof')}>
          <Icon name="cap" size={18} /> Ask Prof
        </button>
        <button className="btn" onClick={() => go('/live?schedule=1')}>
          <Icon name="calendar" size={18} /> Book a lesson
        </button>
        <button className="btn" onClick={() => go('/learners?invite=1')}>
          <Icon name="plus" size={18} /> Invite
        </button>
      </div>
    </Page>
  );
}

// "Today" over "16:00", "Fri" over "17:00": the tutor's own time
function When({ d }) {
  return (
    <span className="home-when" title="Your time">
      <b>{dayWord(d)}</b>
      <span>{time(d)}</span>
    </span>
  );
}

// One learner: their week, streak, last mark, mock grade, exam countdown and this week in the teaching plan
function LearnerCard({ l, days, secs, f, loaded }) {
  const lk = useLookups();
  const values = days.map((d) => secs[ymd(d)] || 0);
  const total = values.reduce((s, x) => s + x, 0);
  const top = Math.max(3600, ...values); // an hour fills a bar, more stretches the scale
  const today = ymd(new Date());
  const exam = f?.exam?.date && examIn(f.exam);
  const plan = f?.plan || [];
  const subjects = lk.subjectsOfLearner(l.id);
  const setWork = (p) => {
    const t = lk.topicsOf(p.subject_id).find((x) => x.name === (p.topics || [])[0]);
    go(`/assignments?new=1&subject=${p.subject_id}${t ? `&topic=${t.id}` : ''}`);
  };
  return (
    <article className="card home-learner">
      <Link to={`/learners/${l.id}`} className="home-learner-name">
        <Avatar person={l} />
        <h3>{l.display_name}</h3>
      </Link>
      <div className="home-week-row">
        <div className="home-week" role="img" aria-label={`${dur(total)} this week`}>
          {days.map((d, i) => (
            <span key={i} className={ymd(d) === today ? 'today' : ''} title={`${d.toLocaleDateString(undefined, { weekday: 'long' })}: ${dur(values[i])}`}>
              <i>
                <b style={{ height: `${Math.round((100 * values[i]) / top)}%` }} />
              </i>
              {d.toLocaleDateString(undefined, { weekday: 'narrow' })}
            </span>
          ))}
        </div>
        <div className="home-week-total" aria-hidden="true">
          <b>{dur(total)}</b>
          <span>this week</span>
        </div>
      </div>
      {loaded && (
        <ul className="home-facts">
          {f?.streak > 0 && (
            <li>
              <Icon name="flame" size={16} className="flame" /> {f.streak}-day streak
            </li>
          )}
          {f?.last_mark ? (
            <li title={f.last_mark.title}>
              <Icon name="check" size={16} />
              <span className="ellipsis">
                Last mark {+f.last_mark.score}/{+f.last_mark.max} <span className="muted">· {f.last_mark.title}</span>
              </span>
            </li>
          ) : (
            <li className="muted">
              <Icon name="check" size={16} /> No marks back yet
            </li>
          )}
          {f?.mock?.grade && (
            <li title={f.mock.title}>
              <Icon name="trophy" size={16} />
              <span className="ellipsis">
                Mock {f.mock.grade} <span className="muted">· {f.mock.title}</span>
              </span>
            </li>
          )}
          {exam && (
            <li>
              <Icon name="calendar" size={16} /> {exam}
            </li>
          )}
        </ul>
      )}
      {loaded && (
        <div className="home-plan">
          {plan.length ? (
            plan.map((p, i) => {
              const what = (p.topics || []).length ? p.topics.join(', ') : p.label;
              return (
                <div key={p.subject_id + i} className="home-plan-row">
                  <span className="grow small">
                    <span className="muted">{plan.length > 1 && lk.subject(p.subject_id) ? `This week in ${lk.subject(p.subject_id).name}:` : 'This week:'}</span> <span className="strong">{what}</span>
                  </span>
                  <button className="btn sm" onClick={() => setWork(p)}>
                    Set work for it
                  </button>
                </div>
              );
            })
          ) : (
            <div className="small muted">
              No teaching plan for this week.{' '}
              {subjects.length > 0 && (
                <Link to={`/library/syllabus?subject=${subjects[0]}`} className="small">
                  Plan the weeks
                </Link>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// "31 weeks to IGCSE (May/June)", "9 days to the exams"
function examIn(exam) {
  const n = new Date();
  const days = Math.round((new Date(String(exam.date).slice(0, 10) + 'T12:00:00') -new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12)) / DAY);
  const name = exam.name || 'the exams';
  if (days <= 0) return `${name}: today`;
  if (days < 14) return `${plural(days, 'day')} to ${name}`;
  return `${Math.floor(days / 7)} weeks to ${name}`;
}
